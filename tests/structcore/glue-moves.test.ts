/**
 * Glue moving between grids (DESIGN 强力胶): a glued face travels with the moved cells when both
 * sides move, or when the side staying behind is not a glueable block; it stays in the source
 * grid when the other side is a glueable block that stays; faces turn with the cells; afterwards
 * the lifetime rule holds at the destination.
 *
 * Structure moves never create glue joints: after a blockify (rotor stop) or a dock, no face
 * joins a written cell to a block the move did not write, whether its glue came with the
 * structure or was already in the destination; the one exception is the glue the destination
 * already holds between a stopping rotor's bearing and the cell in front of it.
 * (The hub–bearing face across start and stop: also rotor.test.ts, dock.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { cellState, ID_MASK, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { ALL_DIRS, DIR_X, DIR_Y, DIR_Z, NX, NY, NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { qfromYaw, vec3 } from '../../src/core/math';
import { commitDock, planDock, rotorSnap, snapCell } from '../../src/structures/assembly';
import type { GlueStore } from '../../src/structures/glue';
import { applyRotorPose } from '../../src/structures/rotor';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import { c, facing, glueKeys, MILL_BEARING, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const [HX, HY, HZ] = SHIP_HELM;

describe('glue moving between grids', () => {
  it('assembly: an exposed glued face of a ship block travels into the ship; none of it stays in the world', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const g = s.host.worldGlue;
    g.add(1, 60, 1, PY); // the deck's top face, open
    g.add(-3, 60, 0, NY); // its bottom face, open
    const before = g.size;
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    expect(g.size).toBe(0);
    expect(ship.glue.size).toBe(before);
    expect(ship.glue.has(1, 60, 1, PY)).toBe(true);
    expect(ship.glue.has(-3, 60, 0, NY)).toBe(true);
  });

  it('a face between a moved cell and a glueable block that stays behind stays in the source, not duplicated', () => {
    const s = scene();
    // A windmill whose +X arm tip touches a stone behind the bearing's plane (z = bz): not part
    // of the rotor (rotors only take cells in front of the bearing).
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    s.world.setCell(hx + 2, hy, hz - 1, c(B.STONE));
    s.host.worldGlue.add(hx + 2, hy, hz, 5 /* -Z: tip -> stone */);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(s.world.getCell(hx + 2, hy, hz - 1)).toBe(c(B.STONE));
    expect(s.host.worldGlue.has(hx + 2, hy, hz, 5)).toBe(true); // stays on the stone
    expect(rotor.glue.size).toBe(0);
  });

  it('docking: exposed faces travel back; a face landing against a world block loses its glue, the ship\'s copy and the world\'s alike', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    ship.glue.add(1, 60, 1, PY); // exposed: deck top, open above
    ship.glue.add(2, 60, 2, PY); // exposed: deck top, will land under a world stone
    // A world stone right above the second deck cell, its bottom face glued in the world.
    s.world.setCell(2, 61, 2, c(B.STONE));
    s.host.worldGlue.add(2, 61, 2, NY);
    const shipFaces = ship.glue.size;
    const res = s.mgr.dockShip(ship); // pose identity: docks where it was assembled
    expect(res.ok).toBe(true);
    expect(s.host.worldGlue.has(1, 60, 1, PY)).toBe(true);
    expect(s.host.worldGlue.has(2, 60, 2, PY)).toBe(false); // deck and stone are not joined
    expect(s.host.worldGlue.size).toBe(shipFaces - 1);
    // Assembling again does not take the stone.
    const r2 = s.mgr.assembleShip(HX, HY, HZ);
    if (!r2.ok) throw new Error(r2.reason);
    expect(s.world.getCell(2, 61, 2)).toBe(c(B.STONE));
    expect(r2.structure.grid.getCell(2, 61, 2)).toBe(0);
  });

  it('rotor start and stop: an exposed face on a sail rides along and comes back turned with it', () => {
    const s = scene();
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    s.host.worldGlue.add(hx + 1, hy, hz, PZ); // the +X arm's south face, open
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.glue.has(hx + 1, hy, hz, PZ)).toBe(true);
    expect(s.host.worldGlue.size).toBe(0);
    rotor.angle = Math.PI / 2; // a quarter turn about +Z: the +X arm points up
    applyRotorPose(rotor);
    s.mgr.stopRotor(rotor);
    expect(s.world.getCell(hx, hy + 1, hz)).toBe(c(B.WOOL_RED));
    expect(s.host.worldGlue.has(hx, hy + 1, hz, PZ)).toBe(true);
    expect(s.host.worldGlue.size).toBe(1);
  });

  it('blockify: glue on a cell that dropped goes; the face between a placed cell and the stone that stopped its neighbour has no glue', () => {
    const s = scene();
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    const g = s.host.worldGlue;
    g.add(hx + 2, hy, hz, PZ); // the +X arm tip's open south face
    g.add(hx + 1, hy, hz, PX); // between the two cells of the +X arm
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.glue.size).toBe(2);
    // After a half turn the arm tip lands in a stone and drops; the inner arm cell is placed.
    s.world.setCell(hx - 2, hy, hz, c(B.STONE));
    rotor.angle = Math.PI;
    applyRotorPose(rotor);
    const rep = s.mgr.stopRotor(rotor);
    expect(rep.dropped).toBe(1);
    expect(s.world.getCell(hx - 1, hy, hz)).toBe(c(B.WOOL_RED));
    expect(s.world.getCell(hx - 2, hy, hz)).toBe(c(B.STONE));
    expect(g.has(hx - 2, hy, hz, 5 /* -Z */)).toBe(false); // the dropped tip's face is gone
    expect(g.has(hx - 1, hy, hz, 1 /* -X: towards the stone */)).toBe(false); // blade and stone are not joined
    expect(g.size).toBe(0);
    // Starting again leaves the stone in the world.
    const rr2 = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr2.ok) throw new Error(rr2.reason);
    expect(s.world.getCell(hx - 2, hy, hz)).toBe(c(B.STONE));
    expect(rr2.structure.grid.getCell(hx - 2, hy, hz)).toBe(0);
    expect(rr2.structure.grid.count).toBe(rotor.grid.count - 1);
  });

  it('docking onto a cell that became hard after planning: faces with no placed end are not carried into the world', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    const plan = planDock(s.world, ship.grid); // pose identity: docks where it was assembled
    expect(plan.conflicts).toEqual([]);
    ship.glue.add(3, 60, 3, PY); // deck corner's open top face
    ship.glue.add(3, 60, 3, NZ); // between two deck cells that will both drop
    ship.glue.add(1, 60, 1, PY); // a placed cell's open top face
    // Stones appear at two destinations after planning (commitDock's defensive path).
    s.world.setCell(3, 60, 3, c(B.STONE));
    s.world.setCell(3, 60, 2, c(B.STONE));
    const out = commitDock(s.host, ship, plan.t, null);
    expect(out.report.dropped).toBe(2);
    expect(s.host.worldGlue.has(3, 60, 3, PY)).toBe(false); // stone and air: never glued by the player
    expect(s.host.worldGlue.has(3, 60, 3, NZ)).toBe(false); // stone to stone
    expect(s.host.worldGlue.has(1, 60, 1, PY)).toBe(true);
  });
});

// ------------------------------------------------------------------ structure moves never create glue joints

type V3 = [number, number, number];

const vadd = (a: V3, b: V3, k = 1): V3 => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vecOf = (d: Dir): V3 => [DIR_X[d]!, DIR_Y[d]!, DIR_Z[d]!];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The direction from cell a to its neighbour b. */
function dirTo(a: V3, b: V3): Dir {
  const d = vsub(b, a);
  const found = ALL_DIRS.find((k) => DIR_X[k] === d[0] && DIR_Y[k] === d[1] && DIR_Z[k] === d[2]);
  if (found === undefined) throw new Error(`${a} and ${b} are not neighbours`);
  return found;
}

/** Is the face between neighbours a and b glued? */
function glued(g: GlueStore, a: V3, b: V3): boolean {
  return g.has(a[0], a[1], a[2], dirTo(a, b));
}

function glue(g: GlueStore, a: V3, b: V3): void {
  g.add(a[0], a[1], a[2], dirTo(a, b));
}

/** Keeps a set of faces from the store's change events only (the mirror property). */
function mirrorOf(g: GlueStore): () => string[] {
  const m = new Set(glueKeys(g));
  g.onChange((added, x, y, z, axis) => {
    const k = `${x},${y},${z},${axis}`;
    if (added) m.add(k);
    else m.delete(k);
  });
  return () => [...m].sort();
}

/**
 * A windmill on a bearing at B facing `f` (any of the six directions) in the world of `s`: a
 * planks support behind the bearing, a canvas hub H = B + f, an arm of three felt along u (a
 * direction in the plane: A1, A2, A3) and one felt along -u (B1). Sails: 5.
 */
function orientedMill(s: Scene, f: Dir) {
  const B0: V3 = [0, 64, 0];
  const F = vecOf(f);
  const u: V3 = f >> 1 === 0 ? [0, 1, 0] : [1, 0, 0];
  const w = cross(F, u);
  const H = vadd(B0, F);
  const A1 = vadd(H, u);
  const A2 = vadd(H, u, 2);
  const A3 = vadd(H, u, 3);
  const B1 = vadd(H, u, -1);
  const set = (p: V3, cell: number): void => void s.world.setCell(p[0], p[1], p[2], cell);
  set(vsub(B0, F), c(B.PLANKS_OAK));
  set(B0, facing(B.BEARING, f));
  set(H, c(B.CANVAS));
  for (const p of [A1, A2, A3, B1]) set(p, c(B.WOOL_RED));
  return { B0, F, u, w, H, A1, A2, A3, B1, set };
}

describe('structure moves never create glue joints: rotor stop', () => {
  const cases: Array<[Dir, number]> = [];
  for (const f of ALL_DIRS) for (let q = 0; q < 4; q++) cases.push([f, q]);

  it.each(cases)('bearing facing %i, stopped after %i quarter turns', (f, q) => {
    const s = scene();
    const g = s.host.worldGlue;
    const m = orientedMill(s, f);
    const { B0, F, H, A1, A2, A3, set } = m;
    // A stone beside the bearing, in the bearing's plane (never part of the rotor), glued to A1.
    const S0 = vsub(A1, F);
    set(S0, c(B.STONE));
    glue(g, B0, H); // bearing <-> hub: stays on the bearing while the rotor runs
    glue(g, A1, A2); // two blade cells
    glue(g, A2, A3); // A3 will drop
    glue(g, A1, vadd(A1, F)); // A1's open front face: will land against a stone
    glue(g, A2, vadd(A2, F)); // A2's open front face: stays open
    glue(g, A1, S0); // to the stone beside the bearing: stays in the world
    const rr = s.mgr.startRotor(s.world, B0[0], B0[1], B0[2]);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.grid.count).toBe(5);
    expect(glueKeys(g).length).toBe(2); // bearing face and S0 face stayed behind
    rotor.angle = (q * Math.PI) / 2;
    applyRotorPose(rotor);
    const t = rotorSnap(rotor.grid);
    const to = (p: V3): V3 => {
      const d = snapCell(t, p[0], p[1], p[2]);
      return [d.x, d.y, d.z];
    };
    const a1 = to(A1);
    const a2 = to(A2);
    const a3 = to(A3);
    const ru = vsub(a2, a1);
    const rw = vsub(to(vadd(H, m.w)), to(H));
    expect(to(H)).toEqual(H);
    // Terrain where the move lands: a stone where A3 lands (it drops), one in front of A1, and a
    // pier stone beside A2 whose face towards A2 the world already glues.
    const pier = vadd(a2, rw);
    set(a3, c(B.STONE));
    set(vadd(a1, F), c(B.STONE));
    set(pier, c(B.COBBLE));
    glue(g, pier, a2);
    const mirror = mirrorOf(g);
    const rep = s.mgr.stopRotor(rotor);
    expect(rep.dropped).toBe(1);
    expect(s.world.getCell(a1[0], a1[1], a1[2])).toBe(c(B.WOOL_RED));
    expect(s.world.getCell(a3[0], a3[1], a3[2])).toBe(c(B.STONE));
    expect(glued(g, a1, a2)).toBe(true); // both ends travelled together
    expect(glued(g, a2, a3)).toBe(false); // placed cell <-> the stone that stopped its neighbour
    expect(glued(g, a1, vadd(a1, F))).toBe(false); // arrived glue against a stone
    expect(glued(g, a2, vadd(a2, F))).toBe(true); // arrived glue against air: an exposed face
    expect(glued(g, pier, a2)).toBe(false); // the world's own exposed face, now against a placed cell
    expect(glued(g, B0, H)).toBe(true); // the bearing exception
    // The face to S0 was already in the world too: removed when a cell landed beside S0 (A1 at
    // q = 0, B1 at q = 2), kept as S0's exposed face otherwise.
    const besideS0 = q % 2 === 0;
    expect(s.world.getCell(A1[0], A1[1], A1[2])).toBe(besideS0 ? c(B.WOOL_RED) : 0);
    expect(glued(g, S0, A1)).toBe(!besideS0);
    expect(g.size).toBe(besideS0 ? 3 : 4);
    expect(mirror()).toEqual(glueKeys(g));
    expect(ru).not.toEqual([0, 0, 0]);
    // Started again: none of the stones comes along.
    const rr2 = s.mgr.startRotor(s.world, B0[0], B0[1], B0[2]);
    if (!rr2.ok) throw new Error(rr2.reason);
    expect(rr2.structure.grid.count).toBe(4);
    for (const p of [a3, vadd(a1, F), pier, S0]) {
      expect(s.world.getCell(p[0], p[1], p[2]) & ID_MASK).not.toBe(0);
      expect(rr2.structure.grid.getCell(p[0], p[1], p[2])).toBe(0);
    }
  });

  it('glue arriving with the rotor on the bearing face is not exempt: only glue the parent already holds there is kept', () => {
    const s = scene();
    const g = s.host.worldGlue;
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2); // bearing (0,64,0) facing +Z, hub (0,64,1)
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    // Rotor-local coordinates equal the world's at the start: the hub's back face, towards the
    // bearing's place (empty in the rotor grid), glued in the rotor's own store.
    rotor.glue.add(hx, hy, hz, NZ);
    rotor.angle = Math.PI;
    applyRotorPose(rotor);
    const mirror = mirrorOf(g);
    s.mgr.stopRotor(rotor);
    expect(s.world.getCell(hx, hy, hz)).toBe(c(B.CANVAS));
    expect(g.has(0, 64, 0, PZ)).toBe(false);
    expect(g.size).toBe(0);
    expect(mirror()).toEqual(glueKeys(g));
  });

  it('a bearing that is gone when the rotor stops keeps nothing: the hub lands with no glue on that face', () => {
    const s = scene();
    const g = s.host.worldGlue;
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    g.add(0, 64, 0, PZ);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    // The bearing is replaced by a stone: the rotor stops by itself; the stone is not the bearing.
    s.world.setCell(0, 64, 0, c(B.STONE));
    expect(rr.structure.removed).toBe(true);
    expect(s.world.getCell(hx, hy, hz)).toBe(c(B.CANVAS));
    expect(g.has(0, 64, 0, PZ)).toBe(false);
  });

  // An unloaded cell counts as glueable (it may be rock), so glue arriving on a face towards it is
  // removed too: kept, it would join the blade to rock once the chunk loads (the chunk prune keeps
  // a face with a glueable side), and the next start would take that rock along.
  it.each(['stone', 'air'] as const)('an exposed face arriving towards an unloaded chunk is removed; the chunk later loads as %s and nothing is joined', (loadAs) => {
    const s = scene(); // chunks loaded for x in -32..31
    const g = s.host.worldGlue;
    const [hx, hy, hz] = windmill(s.world, 29, 64, 0, 2); // the +X arm tip at x = 31
    g.add(hx + 2, hy, hz, PX); // the tip's open +X face, towards x = 32
    s.world.addChunk(new Chunk(2, 0)); // loaded while the rotor starts (a start needs it)
    const rr = s.mgr.startRotor(s.world, 29, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.glue.has(hx + 2, hy, hz, PX)).toBe(true);
    s.world.removeChunk(2, 0);
    rotor.angle = 2 * Math.PI; // a full turn: the tip lands where it was, beside the unloaded chunk
    applyRotorPose(rotor);
    const mirror = mirrorOf(g);
    s.mgr.stopRotor(rotor);
    expect(s.world.getCell(hx + 2, hy, hz)).toBe(c(B.WOOL_RED));
    expect(g.has(hx + 2, hy, hz, PX)).toBe(false);
    expect(g.size).toBe(0);
    expect(mirror()).toEqual(glueKeys(g));
    const cells = new Uint16Array(16 * 16 * 128);
    if (loadAs === 'stone') cells[cellIndex(0, hy, hz)] = c(B.STONE);
    s.world.addChunk(new Chunk(2, 0, cells));
    expect(g.has(hx + 2, hy, hz, PX)).toBe(false);
    const rr2 = s.mgr.startRotor(s.world, 29, 64, 0);
    if (!rr2.ok) throw new Error(rr2.reason);
    expect(s.world.getCell(32, hy, hz)).toBe(loadAs === 'stone' ? c(B.STONE) : 0);
    expect(rr2.structure.grid.getCell(32, hy, hz)).toBe(0);
  });

  it.each([0, 1, 2, 3])('on a ship turned %i quarter turns: the hub-bearing glue in the ship survives start and stop; the blade cell beside a ship block is not joined to it', (k) => {
    const s = scene();
    millShip(s.world, s.host.worldGlue, true);
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    const p = ship.grid.position;
    ship.grid.setPoseImmediate(vec3(p.x + 5, p.y, p.z - 4), qfromYaw((k * Math.PI) / 2));
    const [bx, by, bz] = MILL_BEARING;
    expect(ship.glue.has(bx, by, bz, PZ)).toBe(true);
    const rr = s.mgr.startRotor(ship.grid, bx, by, bz);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(ship.glue.has(bx, by, bz, PZ)).toBe(true); // stayed on the bearing
    // A ship plank where the +X arm tip (1 cell from the hub, then 2) lands after a quarter turn
    // about +Z (+X -> +Y): (0, by + 2, bz + 1) drops, (0, by + 1, bz + 1) lands beside it.
    rotor.glue.add(bx + 1, by, bz + 1, PX); // the two cells of the +X arm
    ship.grid.setCell(bx, by + 2, bz + 1, c(B.PLANKS_OAK));
    rotor.angle = Math.PI / 2;
    applyRotorPose(rotor);
    const mirror = mirrorOf(ship.glue);
    const rep = s.mgr.stopRotor(rotor);
    expect(rep.dropped).toBe(1);
    expect(ship.grid.getCell(bx, by, bz + 1)).toBe(c(B.CANVAS));
    expect(ship.glue.has(bx, by, bz, PZ)).toBe(true); // the bearing exception, in the ship's store
    expect(ship.grid.getCell(bx, by + 1, bz + 1)).toBe(c(B.WOOL_RED));
    expect(ship.glue.has(bx, by + 1, bz + 1, PY)).toBe(false); // not joined to the ship plank
    expect(mirror()).toEqual(glueKeys(ship.glue));
    expect(stateFacing(cellState(ship.grid.getCell(bx, by, bz)))).toBe(PZ);
  });
});

describe('structure moves never create glue joints: docking', () => {
  it.each([0, 1, 2, 3])('ship turned %i quarter turns: no face joins a docked cell to a world block; exposed faces against air stay; reassembly takes the same cells', (k) => {
    const s = scene();
    const g = s.host.worldGlue;
    millShip(s.world, g);
    g.add(3, 60, 0, PX); // the deck's east edge: exposed, will dock against a pier block
    g.add(-3, 60, 1, NX); // the deck's west edge: exposed, will dock against air
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    const n0 = ship.grid.count;
    expect(ship.glue.size).toBe(4);
    const p = ship.grid.position;
    ship.grid.setPoseImmediate(vec3(p.x + 12, p.y, p.z + 10), qfromYaw((k * Math.PI) / 2));
    const plan = planDock(s.world, ship.grid);
    expect(plan.conflicts).toEqual([]);
    const to = (x: number, y: number, z: number): V3 => {
      const d = snapCell(plan.t, x, y, z);
      return [d.x, d.y, d.z];
    };
    const east = to(3, 60, 0);
    const pier1 = to(4, 60, 0);
    const south = to(0, 60, 3);
    const pier2 = to(0, 60, 4);
    const west = to(-3, 60, 1);
    const helm = to(HX, HY, HZ);
    s.world.setCell(pier1[0], pier1[1], pier1[2], c(B.COBBLE));
    s.world.setCell(pier2[0], pier2[1], pier2[2], c(B.STONE_BRICKS)); // does not stick to planks by itself
    glue(g, pier2, south); // the pier's own exposed face, where the deck will land
    const mirror = mirrorOf(g);
    const res = s.mgr.dockShip(ship);
    expect(res.ok).toBe(true);
    expect(glued(g, east, pier1)).toBe(false); // arrived with the ship
    expect(glued(g, south, pier2)).toBe(false); // was in the world
    expect(glued(g, west, to(-4, 60, 1))).toBe(true); // exposed, against air
    expect(glued(g, to(2, 61, 0), to(2, 60, 0))).toBe(true); // log <-> deck: travelled together
    expect(glued(g, to(-3, 60, -3), to(-3, 60, -2))).toBe(true);
    expect(g.size).toBe(3);
    expect(mirror()).toEqual(glueKeys(g));
    const r2 = s.mgr.assembleShip(helm[0], helm[1], helm[2]);
    if (!r2.ok) throw new Error(r2.reason);
    expect(r2.structure.grid.count).toBe(n0);
    expect(s.world.getCell(pier1[0], pier1[1], pier1[2])).toBe(c(B.COBBLE));
    expect(s.world.getCell(pier2[0], pier2[1], pier2[2])).toBe(c(B.STONE_BRICKS));
  });
});
