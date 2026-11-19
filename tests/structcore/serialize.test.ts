import { describe, expect, it, vi } from 'vitest';
import { B } from '../../src/blocks/defs';
import { STRUCTURE_MAX_BOX_CELLS } from '../../src/core/constants';
import { PX } from '../../src/core/dirs';
import { qfromAxisAngle, qfromYaw, qmul, qrotate, vec3, vsub } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { STRUCTURES_FORMAT } from '../../src/structures/serialize';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import type { StructureManager } from '../../src/structures/manager';
import { StructureGrid } from '../../src/voxel/sgrid';
import { c, cellMap, facing, fill, MILL_BEARING, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

/** A plain, comparable description of every structure of a manager. */
function describeAll(mgr: StructureManager): unknown[] {
  return mgr.all().map((s: Structure) => {
    const g = s.grid;
    const cells: Array<[string, number]> = [];
    g.forEachCell((x, y, z, cell) => cells.push([`${x},${y},${z}`, cell]));
    const base = {
      kind: s.kind,
      id: s.id,
      parent: s.parent?.id ?? 0,
      gridParent: g.parent.gridId,
      children: s.children.map((r) => r.id),
      cells,
      glue: Array.from(s.glue.toArray()),
      pose: [g.pivot, g.position, g.rotation, g.prevPosition, g.prevRotation, g.linearVelocity, g.angularVelocity].map((v) => ({ ...v })),
    };
    if (s instanceof Rotor) {
      return {
        ...base,
        rotor: [s.bearingX, s.bearingY, s.bearingZ, s.axis, { ...s.baseRotation }, s.angle, s.angularSpeed, s.sails],
      };
    }
    const sh = s as Ship;
    return { ...base, ship: [sh.helmX, sh.helmY, sh.helmZ, sh.forward, sh.throttle, sh.rudder, sh.asleep, sh.restTicks] };
  });
}

/** World rotor + ship carrying a running windmill (re-gridded once by a dock / re-assemble) + glue everywhere. */
function busyScene(): Scene & { ship: Ship; shipRotor: Rotor; worldRotor: Rotor } {
  const s = scene();
  windmill(s.world, 15, 64, 15, 2);
  s.host.worldGlue.add(16, 64, 16, PX); // between two felt cells of the world windmill
  millShip(s.world, s.host.worldGlue, true); // hub glued: the stopped windmill joins the ship
  const wr = s.mgr.startRotor(s.world, 15, 64, 15);
  const sr0 = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!wr.ok || !sr0.ok) throw new Error('setup');
  const rr = s.mgr.startRotor(sr0.structure.grid, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  for (let i = 0; i < 17; i++) s.mgr.step();
  // Dock rotated (helm centre exactly on cell (5,61,5)) and re-assemble, so the ship rotor
  // gets a non-trivial base rotation.
  const ship0 = sr0.structure;
  const q = qfromYaw(Math.PI / 2);
  const off = qrotate(q, vsub(vec3(SHIP_HELM[0] + 0.5, SHIP_HELM[1] + 0.5, SHIP_HELM[2] + 0.5), ship0.grid.pivot));
  ship0.grid.setPoseImmediate(vec3(5.5 - off.x, 61.5 - off.y, 5.5 - off.z), q);
  const d = s.mgr.dockShip(ship0);
  if (!d.ok) throw new Error('dock');
  const sr = s.mgr.assembleShip(5, 61, 5);
  if (!sr.ok) throw new Error(sr.reason);
  const ship = sr.structure;
  for (let i = 0; i < 6; i++) s.mgr.step();
  // Arbitrary ship state, prev pose different from the current one.
  ship.grid.snapshotPose();
  ship.grid.position.x += 0.37;
  ship.grid.position.y -= 0.21;
  qmul(qfromAxisAngle(vec3(0, 1, 0), 0.31), ship.grid.rotation, ship.grid.rotation);
  ship.grid.linearVelocity.x = 1.25;
  ship.grid.angularVelocity.y = -0.4;
  ship.throttle = 0.6;
  ship.rudder = -0.3;
  ship.helmsmanId = 5;
  ship.asleep = true;
  ship.restTicks = 12;
  return { ...s, ship, shipRotor: rr.structure, worldRotor: wr.structure };
}

function save(mgr: StructureManager): Uint8Array {
  const w = new ByteWriter();
  mgr.serialize(w);
  return w.finish();
}

describe('serialize / deserialize (ACCEPTANCE 23)', () => {
  it('a round trip restores every structure exactly, nesting, glue and angles included', () => {
    const a = busyScene();
    expect(a.shipRotor.parent).toBe(a.ship);
    expect(a.shipRotor.baseRotation.w).not.toBeCloseTo(1, 3);
    const bytes = save(a.mgr);
    const b = scene();
    const r = new ByteReader(bytes, 'structures');
    b.mgr.deserialize(r);
    expect(r.eof()).toBe(true);
    expect(describeAll(b.mgr)).toEqual(describeAll(a.mgr));
    // helmsman is not restored
    const ship = b.mgr.ships()[0]!;
    expect(ship.helmsmanId).toBe(0);
    // parent links and indexes rebuilt
    const rotorB = b.mgr.get(a.shipRotor.id) as Rotor;
    expect(rotorB.parent).toBe(ship);
    expect(rotorB.grid.parent).toBe(ship.grid);
    expect(ship.children).toEqual([rotorB]);
    expect(b.mgr.rotorAtBearing(ship.grid, rotorB.bearingX, rotorB.bearingY, rotorB.bearingZ)).toBe(rotorB);
    const worldB = b.mgr.get(a.worldRotor.id) as Rotor;
    expect(b.mgr.rotorAtBearing(b.world, 15, 64, 15)).toBe(worldB);
    // Same future: both managers step identically (and new ids continue the counter).
    for (let i = 0; i < 20; i++) {
      a.mgr.step();
      b.mgr.step();
    }
    expect(describeAll(b.mgr)).toEqual(describeAll(a.mgr));
    windmill(a.world, -20, 64, -20, 1);
    windmill(b.world, -20, 64, -20, 1);
    const na = a.mgr.startRotor(a.world, -20, 64, -20);
    const nb = b.mgr.startRotor(b.world, -20, 64, -20);
    expect(na.ok && nb.ok && na.structure.id === nb.structure.id).toBe(true);
    expect(save(b.mgr)).toEqual(save(a.mgr));
  });

  it('hooks work after loading: mining the loaded ship bearing stops its rotor', () => {
    const a = busyScene();
    const b = scene();
    b.mgr.deserialize(new ByteReader(save(a.mgr)));
    const rotor = b.mgr.get(a.shipRotor.id) as Rotor;
    const ship = rotor.parent as Ship;
    ship.grid.setCell(rotor.bearingX, rotor.bearingY, rotor.bearingZ, 0);
    expect(rotor.removed).toBe(true);
    expect(ship.children).toEqual([]);
  });

  it('loading replaces the current structures; an empty manager round-trips too', () => {
    const a = busyScene();
    const bytes = save(a.mgr);
    const empty = save(scene().mgr);
    a.mgr.deserialize(new ByteReader(empty));
    expect(a.mgr.all()).toEqual([]);
    expect(a.ship.removed).toBe(true);
    a.mgr.deserialize(new ByteReader(bytes));
    expect(a.mgr.all().length).toBe(3);
    expect(a.ship.removed).toBe(true); // the old objects stay dead; new ones replaced them
  });

  it('malformed data throws SaveFormatError and keeps the current structures', () => {
    const a = busyScene();
    const bytes = save(a.mgr);
    const b = busyScene();
    const before = describeAll(b.mgr);
    for (let n = 0; n < bytes.length; n += 13) {
      expect(() => b.mgr.deserialize(new ByteReader(bytes.subarray(0, n)))).toThrow(SaveFormatError);
    }
    const bad = bytes.slice();
    bad[0] = 9; // format
    expect(() => b.mgr.deserialize(new ByteReader(bad))).toThrow(SaveFormatError);
    expect(describeAll(b.mgr)).toEqual(before);
    expect(b.mgr.ships()[0]).toBe(b.ship);
  });
});

/**
 * A save holding one ship (id 1) whose cell section is written by `cells`; the rest of the
 * record is a valid identity pose, no glue and default control fields.
 */
function shipSave(cells: (w: ByteWriter) => void, format = STRUCTURES_FORMAT): Uint8Array {
  const w = new ByteWriter();
  w.u8(format).varuint(2).varuint(1);
  w.u8(0).varuint(1).varuint(0); // kind ship, id 1, parent: the world
  cells(w);
  for (const v of [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]) w.f64(v);
  w.i32Array(new Int32Array(0));
  w.varint(0).varint(0).varint(0).u8(5).f64(0).f64(0).bool(false).varuint(0);
  return w.finish();
}

const P = c(B.PLANKS_OAK);

/** Cell section: box, then runs of [gap, cells]. */
function runs(box: [number, number, number, number, number, number], list: Array<[number, number[]]>): (w: ByteWriter) => void {
  return (w) => {
    w.varint(box[0]).varint(box[1]).varint(box[2]).varuint(box[3]).varuint(box[4]).varuint(box[5]);
    w.varuint(list.length);
    for (const [gap, cells] of list) w.varuint(gap).u16Array(cells);
  };
}

function loadedCells(bytes: Uint8Array): Map<string, number> {
  const s = scene();
  s.mgr.deserialize(new ByteReader(bytes));
  return cellMap(s.mgr.ships()[0]!.grid);
}

describe('structure cells on disk: proportional to the cell count, always readable', () => {
  it('a ship edited far out (a huge, sparse box) saves small and loads back exactly', () => {
    const s = scene();
    fill(s.world, -2, 60, -2, 2, 60, 2, P);
    s.world.setCell(0, 61, 0, facing(B.HELM, 5));
    const r = s.mgr.assembleShip(0, 61, 0);
    if (!r.ok) throw new Error(r.reason);
    const g = r.structure.grid;
    // Plain ship edits (allowed at any time). Tight box 128 x 68 x 240 = 2.09M cells, just under
    // STRUCTURE_MAX_BOX_CELLS (DESIGN 组装与方块化): a dense box would take 4 MB.
    g.setCell(-63, 60, -120, P);
    g.setCell(64, 127, 119, c(B.PLANKS_PINE));
    expect(g.count).toBe(28);
    const bytes = save(s.mgr);
    expect(bytes.length).toBeLessThan(2048);
    const b = scene();
    b.mgr.deserialize(new ByteReader(bytes));
    const ship = b.mgr.ships()[0]!;
    expect(cellMap(ship.grid)).toEqual(cellMap(g));
    expect(ship.grid.cellBounds()).toEqual(g.cellBounds());
    expect(save(b.mgr)).toEqual(bytes);
  });

  it('a ship whose box is exactly STRUCTURE_MAX_BOX_CELLS round-trips; one cell more is refused on both ends', () => {
    const s = scene();
    fill(s.world, -2, 60, -2, 2, 60, 2, P);
    s.world.setCell(0, 61, 0, facing(B.HELM, 5));
    const r = s.mgr.assembleShip(0, 61, 0);
    if (!r.ok) throw new Error(r.reason);
    const g = r.structure.grid;
    // Tight box 128 x 128 x 128 (direct edits: test setup).
    g.setCell(125, 60, -2, P);
    g.setCell(-2, 187, -2, P);
    g.setCell(-2, 60, 125, c(B.PLANKS_PINE));
    const b0 = g.cellBounds()!;
    expect((b0.maxX - b0.minX) * (b0.maxY - b0.minY) * (b0.maxZ - b0.minZ)).toBe(STRUCTURE_MAX_BOX_CELLS);
    const bytes = save(s.mgr);
    const b = scene();
    b.mgr.deserialize(new ByteReader(bytes));
    expect(cellMap(b.mgr.ships()[0]!.grid)).toEqual(cellMap(g));
    expect(save(b.mgr)).toEqual(bytes);
    // One cell wider: the game never builds it, and the save refuses to write it ...
    g.setCell(126, 60, -2, P);
    expect(() => save(s.mgr)).toThrow(/STRUCTURE_MAX_BOX_CELLS/);
    // ... and to read it.
    const over = shipSave(runs([0, 60, 0, 129, 128, 128], [[0, [P]], [129 * 128 * 128 - 2, [P]]]));
    const t = scene();
    expect(() => t.mgr.deserialize(new ByteReader(over))).toThrow(/STRUCTURE_MAX_BOX_CELLS/);
    expect(t.mgr.all()).toEqual([]);
    // The same hand-written section at exactly the limit loads (its first and last cells span the box).
    expect(loadedCells(shipSave(runs([0, 60, 0, 128, 128, 128], [[0, [P]], [STRUCTURE_MAX_BOX_CELLS - 2, [P]]])))).toEqual(
      new Map([['0,60,0', P], ['127,187,127', P]]),
    );
  });

  it('random structures round-trip exactly (runs across rows and layers)', () => {
    const rng = new Rng(1234);
    const ids = [B.PLANKS_OAK, B.PLANKS_PINE, B.COBBLE, B.WOOL_RED, B.CANVAS];
    for (let trial = 0; trial < 60; trial++) {
      const s = scene();
      fill(s.world, 0, 60, 0, 1, 60, 0, P);
      s.world.setCell(0, 61, 0, facing(B.HELM, 5));
      const r = s.mgr.assembleShip(0, 61, 0);
      if (!r.ok) throw new Error(r.reason);
      const g = r.structure.grid;
      const sx = rng.int(1, 7);
      const sy = rng.int(1, 5);
      const sz = rng.int(1, 7);
      const ox = rng.int(-20, 20);
      const oy = rng.int(40, 80);
      const oz = rng.int(-20, 20);
      const density = rng.next();
      for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
        if (rng.chance(density)) g.setCell(ox + x, oy + y, oz + z, c(ids[rng.int(0, ids.length - 1)]!));
      }
      const bytes = save(s.mgr);
      expect(loadedCells(bytes)).toEqual(cellMap(g));
    }
  });

  it('a hand-written section decodes runs that wrap over rows', () => {
    // Box 3 x 1 x 2 at (5,60,7): indices 2 and 3 are (x=2,z=0) and (x=0,z=1).
    const cells = loadedCells(shipSave(runs([5, 60, 7, 3, 1, 2], [[2, [P, c(B.COBBLE)]]])));
    expect(cells).toEqual(new Map([['7,60,7', P], ['5,60,8', c(B.COBBLE)]]));
  });

  it('older formats are not read (no backward compatibility)', () => {
    for (const format of [1, 2]) {
      const bytes = shipSave(runs([5, 60, 7, 1, 1, 1], [[0, [P]]]), format);
      const s = scene();
      expect(() => s.mgr.deserialize(new ByteReader(bytes))).toThrow(SaveFormatError);
      expect(s.mgr.all()).toEqual([]);
    }
  });

  it('malformed cell sections throw SaveFormatError', () => {
    const bad: Array<[string, Uint8Array]> = [
      ['box not tight', shipSave(runs([0, 60, 0, 4, 1, 1], [[0, [P, P, P]]]))],
      ['box not tight (y)', shipSave(runs([0, 60, 0, 1, 2, 1], [[0, [P]]]))],
      ['run past the box', shipSave(runs([0, 60, 0, 3, 1, 1], [[1, [P, P, P]]]))],
      ['adjacent runs', shipSave(runs([0, 60, 0, 3, 1, 1], [[0, [P]], [0, [P, P]]]))],
      ['air in a run', shipSave(runs([0, 60, 0, 3, 1, 1], [[0, [P, 0, P]]]))],
      ['empty run', shipSave(runs([0, 60, 0, 1, 1, 1], [[0, [P]], [1, []]]))],
      ['box without cells', shipSave(runs([0, 60, 0, 3, 1, 1], []))],
      ['cells without a box', shipSave(runs([0, 60, 0, 0, 0, 0], [[0, [P]]]))],
      ['unknown block id', shipSave(runs([0, 60, 0, 1, 1, 1], [[0, [1000]]]))],
      ['absurd box', shipSave(runs([0, 0, 0, 1 << 28, 1 << 28, 1], [[0, [P]]]))],
    ];
    for (const [what, bytes] of bad) {
      const s = scene();
      expect(() => s.mgr.deserialize(new ByteReader(bytes)), what).toThrow(SaveFormatError);
      expect(s.mgr.all(), what).toEqual([]);
    }
  });

  it('a box that cannot be allocated is a SaveFormatError, not a crash', () => {
    const spy = vi.spyOn(StructureGrid.prototype, 'resize').mockImplementation(() => {
      throw new RangeError('Array buffer allocation failed');
    });
    try {
      const s = scene();
      expect(() => s.mgr.deserialize(new ByteReader(shipSave(runs([0, 60, 0, 1, 1, 1], [[0, [P]]]))))).toThrow(SaveFormatError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('independent managers (ACCEPTANCE 24, LESSONS 同种子开新世界)', () => {
  it('two managers on two worlds never see each other', () => {
    const build = (s: Scene): void => {
      fill(s.world, 0, 60, 0, 3, 60, 3, c(B.PLANKS_OAK));
      s.world.setCell(1, 61, 1, facing(B.HELM, 5));
      s.host.worldGlue.add(0, 60, 0, PX);
      windmill(s.world, 10, 64, 10, 1);
    };
    const a = scene({ seed: 5 });
    const b = scene({ seed: 5 });
    build(a);
    build(b);
    expect(a.mgr.assembleShip(1, 61, 1).ok).toBe(true);
    expect(a.mgr.startRotor(a.world, 10, 64, 10).ok).toBe(true);
    expect(b.mgr.all()).toEqual([]);
    expect(b.world.getCell(0, 60, 0)).toBe(c(B.PLANKS_OAK));
    expect(b.host.worldGlue.size).toBe(1);
    // B's world changes do not reach A's hooks, and vice versa.
    b.world.setCell(10, 64, 10, 0);
    expect(a.mgr.rotors()[0]!.removed).toBe(false);
    expect(b.mgr.startRotor(b.world, 10, 64, 10)).toEqual({ ok: false, reason: 'not_a_bearing' });
    expect(b.mgr.assembleShip(1, 61, 1).ok).toBe(true);
    expect(b.mgr.ships()[0]!.id).toBe(1);
  });

  it('a new world created afterwards starts clean; a disposed manager stops listening', () => {
    const a = busyScene();
    a.mgr.dispose();
    const rotor = a.worldRotor;
    a.world.setCell(15, 64, 15, 0); // the bearing: nobody listens any more
    expect(rotor.removed).toBe(false);
    const fresh = scene({ seed: 1 });
    expect(fresh.mgr.all()).toEqual([]);
    expect(fresh.host.worldGlue.size).toBe(0);
    fill(fresh.world, 0, 60, 0, 3, 60, 3, c(B.PLANKS_OAK));
    fresh.world.setCell(1, 61, 1, facing(B.HELM, 5));
    const res = fresh.mgr.assembleShip(1, 61, 1);
    expect(res.ok && res.structure.id).toBe(1);
  });

  it('clear() forgets everything and restarts ids', () => {
    const a = busyScene();
    a.mgr.clear();
    expect(a.mgr.all()).toEqual([]);
    expect(a.worldRotor.removed).toBe(true);
    windmill(a.world, -20, 64, -20, 1);
    const r = a.mgr.startRotor(a.world, -20, 64, -20);
    expect(r.ok && r.structure.id).toBe(1);
  });
});
