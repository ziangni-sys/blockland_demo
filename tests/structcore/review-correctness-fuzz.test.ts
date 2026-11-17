import { describe, expect, it } from 'vitest';
import { cellState, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import { qfromYaw, qrotate, vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { canGlue, isSailCell } from '../../src/structures/stick';
import { Rotor, Ship } from '../../src/structures/structure';
import type { StructureManager } from '../../src/structures/manager';
import { SET_EXPLOSION } from '../../src/voxel/grid';
import type { VoxelGrid } from '../../src/voxel/grid';
import { c, facing, fill, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const STATS: Record<string, number> = { assembled: 0, startedWorld: 0, startedShip: 0, docked: 0, remounts: 0 };
function check(s: Scene, tag: string): void {
  const mgr: StructureManager = s.mgr;
  const errs: string[] = [];
  for (const st of mgr.all()) {
    if (st.removed) errs.push(`${tag}: listed structure ${st.id} is removed`);
    if (st instanceof Rotor) {
      const pg: VoxelGrid = st.parent ? st.parent.grid : s.world;
      if (st.grid.parent !== pg) errs.push(`${tag}: rotor ${st.id} grid parent mismatch`);
      if (st.parent && !st.parent.children.includes(st)) errs.push(`${tag}: rotor ${st.id} not in parent children`);
      if (st.parent && st.parent.removed) errs.push(`${tag}: rotor ${st.id} parent removed`);
      if (mgr.rotorAtBearing(pg, st.bearingX, st.bearingY, st.bearingZ) !== st) errs.push(`${tag}: rotorAtBearing mismatch ${st.id}`);
      const b = pg.getCell(st.bearingX, st.bearingY, st.bearingZ);
      if ((b & 0x3ff) !== B.BEARING) errs.push(`${tag}: rotor ${st.id} has no bearing (cell ${b})`);
      else {
        const f = stateFacing(cellState(b));
        const ax = qrotate(st.baseRotation, vec3(DIR_X[st.axis]!, DIR_Y[st.axis]!, DIR_Z[st.axis]!));
        if (Math.abs(ax.x - DIR_X[f]!) + Math.abs(ax.y - DIR_Y[f]!) + Math.abs(ax.z - DIR_Z[f]!) > 1e-6) {
          errs.push(`${tag}: rotor ${st.id} axis does not match bearing facing`);
        }
      }
      let sails = 0;
      st.grid.forEachCell((_x, _y, _z, cell) => {
        if (isSailCell(cell)) sails++;
      });
      if (sails !== st.sails) errs.push(`${tag}: rotor ${st.id} sails ${st.sails} != ${sails}`);
    }
    // glue faces join two glueable cells
    st.glue.forEach((x, y, z, axis) => {
      const a = st.grid.getCell(x, y, z);
      const bb = st.grid.getCell(x + (axis === 0 ? 1 : 0), y + (axis === 1 ? 1 : 0), z + (axis === 2 ? 1 : 0));
      if (!canGlue(a) || !canGlue(bb)) errs.push(`${tag}: stale glue in structure ${st.id} at ${x},${y},${z},${axis}`);
    });
  }
  s.host.worldGlue.forEach((x, y, z, axis) => {
    const a = s.world.getCell(x, y, z);
    const bb = s.world.getCell(x + (axis === 0 ? 1 : 0), y + (axis === 1 ? 1 : 0), z + (axis === 2 ? 1 : 0));
    if (!canGlue(a) || !canGlue(bb)) errs.push(`${tag}: stale world glue at ${x},${y},${z},${axis}`);
  });
  expect(errs).toEqual([]);
}

function bearingsOf(g: VoxelGrid, cells: Array<[number, number, number]>): Array<[number, number, number]> {
  return cells.filter(([x, y, z]) => (g.getCell(x, y, z) & 0x3ff) === B.BEARING);
}

function gridCells(g: { forEachCell(fn: (x: number, y: number, z: number, c: number) => void): void }): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  g.forEachCell((x, y, z) => out.push([x, y, z]));
  return out;
}

function runFuzz(seed: number, steps: number): void {
  const rng = new Rng(seed);
  const s = scene();
  fill(s.world, -30, 50, -30, 30, 50, 30, c(B.STONE));
  millShip(s.world, s.host.worldGlue, rng.next() < 0.5);
  windmill(s.world, 12, 64, 12, 2);
  windmill(s.world, -12, 60, 10, 2);
  s.host.worldGlue.add(-12, 60, 10, 4);
  const worldBearings: Array<[number, number, number]> = [
    [0, 65, -2],
    [12, 64, 12],
    [-12, 60, 10],
  ];
  let depth = 0;
  for (let i = 0; i < steps; i++) {
    const op = rng.int(0, 11);
    const tag = `seed ${seed} op#${i} kind ${op}`;
    try {
      if (op === 0) {
        { const r0 = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]); if (r0.ok) STATS.assembled++; }
        // helm may have moved by docking: try all world helms near
        for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) for (let y = 55; y <= 70; y++) {
          if ((s.world.getCell(x, y, z) & 0x3ff) === B.HELM && rng.next() < 0.5) s.mgr.assembleShip(x, y, z);
        }
      } else if (op === 1) {
        // start a rotor on a world or ship bearing
        const grids: VoxelGrid[] = [s.world, ...s.mgr.ships().map((sh) => sh.grid)];
        const g = grids.length > 1 && rng.next() < 0.7 ? grids[rng.int(1, grids.length - 1)]! : grids[0]!;
        const cells = g === s.world ? worldBearings.concat(scanWorldBearings(s)) : gridCells(g as never);
        const bs = bearingsOf(g, cells);
        if (bs.length > 0) {
          const [x, y, z] = bs[rng.int(0, bs.length - 1)]!;
          { const r1 = s.mgr.startRotor(g, x, y, z); if (r1.ok) STATS[g === s.world ? 'startedWorld' : 'startedShip']++; }
        }
      } else if (op === 2) {
        const rs = s.mgr.rotors();
        if (rs.length > 0) s.mgr.stopRotor(rs[rng.int(0, rs.length - 1)]!);
      } else if (op === 3) {
        const ships = s.mgr.ships();
        if (ships.length > 0) {
          const sh = ships[rng.int(0, ships.length - 1)]!;
          const k = rng.int(0, 3);
          const q = qfromYaw((k * Math.PI) / 2 + rng.range(-0.02, 0.02));
          sh.grid.setPoseImmediate(vec3(rng.range(-8, 8), rng.range(60, 64), rng.range(-8, 8)), q);
          { const d = s.mgr.dockShip(sh); if (d.ok) { STATS.docked++; if (s.mgr.rotors().some((r) => r.parent === null)) STATS.remounts++; } }
        }
      } else if (op === 4 || op === 5) {
        const n = rng.int(1, 5);
        for (let k = 0; k < n; k++) s.mgr.step();
      } else if (op === 6 || op === 7) {
        // random destructive edit on a random grid
        const all = s.mgr.all();
        const pick = rng.int(0, all.length);
        if (pick === all.length) {
          const bs = bearingsOf(s.world, worldBearings.concat(scanWorldBearings(s)));
          if (bs.length > 0 && rng.next() < 0.5) {
            const [x, y, z] = bs[rng.int(0, bs.length - 1)]!;
            s.world.setCell(x, y, z, rng.next() < 0.5 ? 0 : c(B.STONE), rng.next() < 0.5 ? SET_EXPLOSION : 0);
          }
        } else {
          const st = all[pick]!;
          const cells = gridCells(st.grid);
          if (cells.length > 0) {
            const [x, y, z] = cells[rng.int(0, cells.length - 1)]!;
            const r = rng.next();
            st.grid.setCell(x, y, z, r < 0.6 ? 0 : r < 0.8 ? c(B.PLANKS_PINE) : c(B.WOOL_GREEN), rng.next() < 0.5 ? SET_EXPLOSION : 0);
          }
        }
      } else if (op === 8) {
        if (depth < 2) {
          s.mgr.beginBatch();
          depth++;
        }
      } else if (op === 9) {
        if (depth > 0) {
          s.mgr.endBatch();
          depth--;
        }
      } else if (op === 10) {
        if (depth === 0) {
          const w = new ByteWriter();
          s.mgr.serialize(w);
          const bytes = w.finish();
          s.mgr.deserialize(new ByteReader(bytes));
          const w2 = new ByteWriter();
          s.mgr.serialize(w2);
          expect(Array.from(w2.finish())).toEqual(Array.from(bytes));
        }
      } else if (op === 11) {
        // ship bearings mined
        const ships = s.mgr.ships();
        if (ships.length > 0) {
          const sh = ships[rng.int(0, ships.length - 1)]!;
          const bs = bearingsOf(sh.grid, gridCells(sh.grid));
          if (bs.length > 0) {
            const [x, y, z] = bs[rng.int(0, bs.length - 1)]!;
            sh.grid.setCell(x, y, z, 0, SET_EXPLOSION);
          }
        }
      }
    } catch (e) {
      throw new Error(`${tag}: threw ${(e as Error).stack}`);
    }
    if (depth === 0) check(s, tag);
  }
  while (depth > 0) {
    s.mgr.endBatch();
    depth--;
  }
  check(s, `seed ${seed} end`);
}

function scanWorldBearings(s: Scene): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) for (let y = 55; y <= 72; y++) {
    if ((s.world.getCell(x, y, z) & 0x3ff) === B.BEARING) out.push([x, y, z]);
  }
  return out;
}

describe('fuzz: structure life cycle invariants', () => {
  it.sequential = it;

  for (let seed = 1; seed <= 250; seed++) {
    it(`seed ${seed}`, () => runFuzz(seed, 80));
  }
  it('stats', () => { console.log(JSON.stringify(STATS)); });
});

void facing;
void Ship;
type _D = Dir;
