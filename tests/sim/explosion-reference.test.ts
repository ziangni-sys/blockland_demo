/**
 * explode() against a small reference blast written straight from the text of docs/SHAPES.md
 * section 9.4 and the rules of 19.8 (getPacked + partAt for what a sample point is in, one map of
 * marked octants per cell in first-mark order, per-part removal in one write, first part before
 * second, one drop roll per removed part at its DROP_POINT). The reference has no fast paths, so
 * it pins the rules the fast paths of src/sim/explosion.ts must keep: the octant of a point on a
 * half-cell plane (p - floor(p) >= 0.5 per axis) and the order of the two parts of a cell.
 * World only: no structures and no entities in reach of the blasts.
 */
import { describe, expect, it } from 'vitest';
import { AIR, ID_MASK, PART_MASK, cellPrimary, cellSecond, facingState, makeCell, partHoles } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, CUTTABLE, LIQUID } from '../../src/blocks/registry';
import { DROP_POINT, canonCell, partAt } from '../../src/blocks/shapes';
import { NZ } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import type { ItemEntity } from '../../src/entities/entity';
import { ATTENUATION, CHAIN_FUSE_MAX, CHAIN_FUSE_MIN, STEP, explode } from '../../src/sim/explosion';
import type { Simulation } from '../../src/sim/simulation';
import { SET_EXPLOSION } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, UPPER, slab } from '../shapes';
import { FLAT_TOP, flatSim } from './helpers';

const T = FLAT_TOP;

/** Every cuttable, registered material. */
const CUT: number[] = [];
for (let id = 1; id < 1023; id++) if (CUTTABLE[id] === 1 && BLOCKS[id] !== undefined) CUT.push(id);

/** A random cell with parts: one part with holes, or two disjoint parts. */
function randomPartial(rng: Rng): number {
  const f1 = rng.int(1, 254);
  const p1 = slab(CUT[rng.int(0, CUT.length - 1)]!, f1);
  if (rng.next() >= 0.45) return p1;
  const rest = ~f1 & 0xff;
  let f2 = rng.int(1, 255) & rest;
  if (f2 === 0) f2 = rest & -rest;
  return canonCell(p1, slab(CUT[rng.int(0, CUT.length - 1)]!, f2));
}

// ------------------------------------------------------------------- the reference blast

/** The ray directions of section 9.4's blast: toward the surface points of a 16^3 lattice cube. */
const DIRS: number[] = [];
for (let i = 0; i < 16; i++) {
  for (let j = 0; j < 16; j++) {
    for (let k = 0; k < 16; k++) {
      if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue;
      const x = (i / 15) * 2 - 1;
      const y = (j / 15) * 2 - 1;
      const z = (k / 15) * 2 - 1;
      const l = Math.sqrt(x * x + y * y + z * z);
      DIRS.push(x / l, y / l, z / l);
    }
  }
}

function canBlast(part: number): boolean {
  const id = part & ID_MASK;
  if (id === AIR || LIQUID[id] !== 0) return false;
  const def = BLOCKS[id];
  return def !== undefined && !def.unbreakable && def.blastResistance < Infinity;
}

/** Section 9.4 on the world alone (no structure in reach). */
function referenceExplode(sim: Simulation, x: number, y: number, z: number, power: number): void {
  const w = sim.world;
  const marks = new Map<string, { x: number; y: number; z: number; mask: number }>();
  for (let r = 0; r < DIRS.length; r += 3) {
    let f = power * (0.7 + 0.6 * sim.rng.next());
    let px = x;
    let py = y;
    let pz = z;
    while (f > 0) {
      const cx = Math.floor(px);
      const cy = Math.floor(py);
      const cz = Math.floor(pz);
      // The octant of the half-cell grid point floor(2p) (section 1.1).
      const o = (Math.floor(px * 2) & 1) | ((Math.floor(py * 2) & 1) << 1) | ((Math.floor(pz * 2) & 1) << 2);
      const part = partAt(getPacked(w, cx, cy, cz), o);
      const def = BLOCKS[part & ID_MASK];
      f -= ((part === AIR ? 0 : def === undefined ? Infinity : def.blastResistance) + 0.3) * 0.3;
      if (f > 0 && canBlast(part)) {
        const key = `${cx},${cy},${cz}`;
        let m = marks.get(key);
        if (m === undefined) marks.set(key, (m = { x: cx, y: cy, z: cz, mask: 0 }));
        m.mask |= 1 << o;
      }
      px += DIRS[r]! * STEP;
      py += DIRS[r + 1]! * STEP;
      pz += DIRS[r + 2]! * STEP;
      f -= ATTENUATION;
    }
  }
  const chance = Math.min(1, 1 / power);
  for (const m of marks.values()) {
    const packed = getPacked(w, m.x, m.y, m.z);
    const parts = [cellPrimary(packed) & PART_MASK, cellSecond(packed)];
    const gone = parts.map((p) => p !== AIR && (~partHoles(p) & 0xff & m.mask) !== 0 && canBlast(p));
    if (!gone[0] && !gone[1]) continue;
    if (!w.setCell(m.x, m.y, m.z, canonCell(gone[0] ? AIR : parts[0]!, gone[1] ? AIR : parts[1]!), SET_EXPLOSION)) continue;
    for (let i = 0; i < 2; i++) {
      if (!gone[i]) continue;
      const p = parts[i]!;
      const def = BLOCKS[p & ID_MASK]!;
      if (def.explosive) {
        const fuse = sim.rng.int(CHAIN_FUSE_MIN, CHAIN_FUSE_MAX);
        const tnt = sim.entities.spawnTnt(m.x + 0.5, m.y + 0.5, m.z + 0.5, fuse);
        tnt.setPosition(m.x + 0.5, m.y + 0.5 - tnt.height * 0.5, m.z + 0.5);
        continue;
      }
      if (!sim.rules.dropsEnabled || !(sim.rng.next() < chance) || def.drop === null) continue;
      const item = def.drop === undefined ? def.id : def.drop.item;
      const count = def.drop === undefined ? 1 : def.drop.count;
      const f = (~partHoles(p) & 0xff) * 3;
      sim.entities.spawnItem(m.x + DROP_POINT[f]!, m.y + DROP_POINT[f + 1]!, m.z + DROP_POINT[f + 2]!, item, count);
    }
  }
  sim.blocks.flush();
}

/** Flat ground with random partial cells, crates, obsidian, water and holes around the origin. */
function scene(seed: number, mode: 'survival' | 'creative'): Simulation {
  const sim = flatSim({ seed: 100 + seed, mode });
  sim.soloPlayer.teleport(40.5, T, 40.5); // out of reach of every blast
  sim.advance(3);
  const rng = new Rng(seed);
  const w = sim.world;
  for (let i = 0; i < 500; i++) {
    const x = rng.int(-7, 7);
    const y = rng.int(T - 4, T + 4);
    const z = rng.int(-7, 7);
    const k = rng.next();
    if (k < 0.7) w.setCell(x, y, z, randomPartial(rng));
    else if (k < 0.78) w.setCell(x, y, z, makeCell(B.TNT));
    else if (k < 0.84) w.setCell(x, y, z, makeCell(B.OBSIDIAN));
    else if (k < 0.9) w.setCell(x, y, z, makeCell(B.WATER));
    else w.setCell(x, y, z, AIR);
  }
  return sim;
}

/** World cells, items (in spawn order) and primed crates around the origin. */
function snapshot(sim: Simulation): { cells: string[]; items: string[]; tnt: string[] } {
  const cells: string[] = [];
  for (let y = T - 14; y <= T + 12; y++) {
    for (let z = -16; z <= 16; z++) {
      for (let x = -16; x <= 16; x++) {
        const p = getPacked(sim.world, x, y, z);
        if (p !== AIR) cells.push(`${x},${y},${z}:${p}`);
      }
    }
  }
  const items: string[] = [];
  const tnt: string[] = [];
  for (const e of sim.entities.all()) {
    if (e.removed) continue;
    if (e.kind === 'item') {
      const st = (e as ItemEntity).stack;
      items.push(`${st.item}x${st.count}@${e.pos.x},${e.pos.y},${e.pos.z}`);
    } else if (e.kind === 'tnt') tnt.push(`${e.pos.x},${e.pos.y},${e.pos.z}:${(e as unknown as { fuse: number }).fuse}`);
  }
  return { cells, items, tnt };
}

describe('explode() against a reference written from section 9.4', () => {
  it('leaves the same cells, items (in the same order), primed crates and random state; centres on cell and half-cell coordinates, drops on and off', () => {
    let removed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const mode = seed % 3 === 0 ? 'creative' : 'survival';
      const power = [1, 2.5, 4, 6][seed % 4]!;
      const rng = new Rng(seed * 7);
      // Centres on cell corners (0), half-cell planes (0.5) and in between.
      const cx = [0, 0.5, 0.25, 1.75][seed % 4]! + rng.int(-2, 2);
      const cy = T + [0, 0.5, -1.25, 1][(seed >> 1) % 4]!;
      const cz = [0.5, 0, -0.5, 0.3][(seed >> 2) % 4]! + rng.int(-2, 2);
      const a = scene(seed, mode);
      const b = scene(seed, mode);
      const before = snapshot(a).cells.length;
      explode(a, cx, cy, cz, power, null);
      referenceExplode(b, cx, cy, cz, power);
      const sa = snapshot(a);
      const sb = snapshot(b);
      expect(sa.cells, `cells, seed ${seed}`).toEqual(sb.cells);
      expect(sa.items, `items, seed ${seed}`).toEqual(sb.items);
      expect(sa.tnt, `crates, seed ${seed}`).toEqual(sb.tnt);
      expect(a.rng.state, `random state, seed ${seed}`).toBe(b.rng.state);
      if (mode === 'creative') expect(sa.items).toHaveLength(0);
      removed += before - sa.cells.length;
    }
    expect(removed, 'the blasts emptied cells').toBeGreaterThan(300);
  }, 120_000);
});

describe('rules of section 19.8 the fast paths must keep', () => {
  /** Dirt in octant 7 (the +x +y +z corner), `rest` in the other seven octants. */
  const corner = (rest: number): number => canonCell(slab(B.DIRT, 0x80), slab(rest, 0x7f));

  it('a point exactly on the half-cell planes is in the upper octant (p - floor(p) >= 0.5): a weak blast at the centre of a cell takes octant 7', () => {
    // Power 0.5: a ray starts with 0.35..0.65 and pays 0.39 for dirt, 0.99 for planks, 1.89 for
    // stone; so only the very first sample point (the centre itself) can mark anything.
    const sim = flatSim({ seed: 21 });
    sim.soloPlayer.teleport(20.5, T, 20.5);
    const c = corner(B.STONE);
    sim.world.setCell(0, T + 3, 0, c);
    explode(sim, 0.5, T + 3.5, 0.5, 0.5, null);
    expect(getPacked(sim.world, 0, T + 3, 0), 'the dirt corner goes, the stone stays').toBe(slab(B.STONE, 0x7f));
  });

  it('the same in a ship cell (the octant of a structure point is worked out by its own code)', () => {
    const sim = flatSim({ seed: 22, spawn: { x: 5.5, y: T, z: 8.5 } });
    const w = sim.world;
    for (let x = 1; x <= 4; x++) w.setCell(x, T + 3, 0, makeCell(B.PLANKS_OAK));
    w.setCell(1, T + 3, 0, corner(B.PLANKS_OAK));
    w.setCell(4, T + 4, 0, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(4, T + 4, 0);
    if (!res.ok) throw new Error(`assembly failed: ${JSON.stringify(res)}`);
    const g = res.structure.grid;
    const l = { x: 0, y: 0, z: 0 };
    g.toLocal({ x: 1.5, y: T + 3.5, z: 0.5 }, l);
    expect(l, 'right after assembly the ship is grid-aligned: the centre maps exactly').toEqual({ x: 1.5, y: T + 3.5, z: 0.5 });
    explode(sim, 1.5, T + 3.5, 0.5, 0.5, null);
    expect(getPacked(g, 1, T + 3, 0)).toBe(slab(B.PLANKS_OAK, 0x7f));
  });

  it('of the two parts a blast removes, the first part is primed or rolled before the second: drops spawn first part first', () => {
    const items = (cell: number): number[] => {
      const sim = flatSim({ seed: 61, mode: 'survival' });
      sim.soloPlayer.teleport(30.5, T, 30.5);
      sim.advance(2);
      sim.world.setCell(0, T + 6, 0, cell);
      explode(sim, 0.5, T + 6.5, 0.5, 1, null); // power 1: every removed part drops
      expect(sim.world.getCell(0, T + 6, 0)).toBe(AIR);
      return sim.entities
        .all()
        .filter((e): e is ItemEntity => e.kind === 'item' && !e.removed)
        .map((e) => e.stack.item);
    };
    // The first part is the one holding the lowest octant (I6), whatever was placed first.
    expect(items(canonCell(slab(B.DIRT, LOWER), slab(B.WOOL_RED, UPPER)))).toEqual([B.DIRT, B.WOOL_RED]);
    expect(items(canonCell(slab(B.WOOL_RED, LOWER), slab(B.DIRT, UPPER)))).toEqual([B.WOOL_RED, B.DIRT]);
  });
});
