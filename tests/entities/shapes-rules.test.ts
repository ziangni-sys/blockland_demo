/**
 * The places of src/entities/ that read cells themselves (docs/SHAPES.md 5.9), with half slabs:
 * the sneak guard's point probes (world and structure; at a half-slab edge and beside a vertical
 * half slab), the helm seat (full floor, half-slab floors, no floor, mirrored ship), falling blocks
 * landing on half slabs, and a buried body rising to a half-cell height (riseOut).
 */
import { describe, expect, it } from 'vitest';
import { facingState } from '../../src/blocks/cell';
import { NZ, PZ, type Dir } from '../../src/core/dirs';
import { analyzeHull } from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import { EAST as EAST_HALF, LOWER, slab, UPPER, WEST as WEST_HALF } from '../shapes';
import { B, Bench, fill, inWorld, makeCell, quat, vec3 } from './harness';

const STONE = makeCell(B.STONE);
const PLANKS = makeCell(B.PLANKS_OAK);

/** Yaw that walks toward +X. */
const EAST = -Math.PI / 2;

/** A ship made of packed cells, at rest where it was built. */
function shipOf(b: Bench, id: number, cells: Array<[number, number, number, number]>): Ship {
  const s = new Ship(id, b.world);
  for (const [x, y, z, c] of cells) s.grid.setCell(x, y, z, c);
  s.hull = analyzeHull(s.grid);
  const c = s.hull!.com;
  s.grid.pivot.x = c.x;
  s.grid.pivot.y = c.y;
  s.grid.pivot.z = c.z;
  s.grid.setPoseImmediate(vec3(c.x, c.y, c.z), quat());
  s.mass = s.hull!.mass;
  b.host.list.push(s);
  return s;
}

describe('5.9 sneaking at the edge of half slabs', () => {
  it('world: sneaking off a lower half slab onto the floor half a block below walks down it (the guard probes 0.6 deep)', () => {
    const b = new Bench();
    fill(b.world, -10, 60, -10, 10, 60, 10, STONE); // floor top 61
    for (let x = -3; x <= 0; x++) for (let z = -3; z <= 3; z++) b.world.setCell(x, 61, z, slab(B.STONE, LOWER));
    const p = b.entities.spawnPlayer('survival', -1.5, 61.5, 0.5);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = EAST;
    b.tick(60);
    expect(p.pos.x).toBeGreaterThan(2);
    expect(p.pos.y).toBe(61);
  });

  it('world: sneaking toward the edge of half slabs over a deep drop stops at the edge, standing on the slab', () => {
    const b = new Bench();
    for (let x = -3; x <= 0; x++) for (let z = -3; z <= 3; z++) b.world.setCell(x, 61, z, slab(B.STONE, LOWER));
    const p = b.entities.spawnPlayer('survival', -1.5, 61.5, 0.5);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = EAST;
    b.tick(60);
    expect(p.pos.y).toBe(61.5);
    expect(p.pos.x).toBeGreaterThan(0.8);
    expect(p.pos.x).toBeLessThan(1.2); // the edge is at x = 1; the guard disk (radius 0.2) keeps a point over it
  });

  it('world: beside a vertical half slab (the west half of the edge cells), sneaking stops over the slab, not over the empty east half', () => {
    const b = new Bench();
    for (let z = -3; z <= 3; z++) {
      for (let x = -3; x <= -1; x++) b.world.setCell(x, 60, z, STONE);
      b.world.setCell(0, 60, z, slab(B.STONE, WEST_HALF)); // its top (61) only over x in [0, 0.5)
    }
    const p = b.entities.spawnPlayer('survival', -1.5, 61, 0.5);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = EAST;
    b.tick(60);
    expect(p.pos.y).toBe(61);
    expect(p.pos.x).toBeGreaterThan(0.3);
    expect(p.pos.x).toBeLessThan(0.7); // the support ends at x = 0.5 (whole cells: x = 1, the body would reach 1.2)
  });

  it('structure: the same on a deck whose edge is a row of vertical half slabs (a layered structure grid)', () => {
    const b = new Bench();
    const cells: Array<[number, number, number, number]> = [];
    for (let z = -3; z <= 3; z++) {
      for (let x = -3; x <= -1; x++) cells.push([x, 60, z, PLANKS]);
      cells.push([0, 60, z, slab(B.PLANKS_OAK, WEST_HALF)]);
    }
    const s = shipOf(b, 1, cells);
    expect(s.grid.layered).toBe(true);
    const p = b.entities.spawnPlayer('survival', -1.5, 61, 0.5);
    b.tick(3);
    expect(p.carrierId).toBe(s.id);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = EAST;
    b.tick(60);
    expect(p.carrierId).toBe(s.id);
    expect(p.pos.y).toBeGreaterThan(60.99);
    expect(p.pos.x).toBeGreaterThan(0.3);
    expect(p.pos.x).toBeLessThan(0.7);
  });
});

/** A 9 x 9 deck at y 60 (`floor` under the seat column), a helm at local (hx, 61, -2) facing `facing`; returns the ship and the seat column. */
function helmShip(b: Bench, opts: { seatFloor?: number; seatCell?: number; mirror?: boolean; facing?: Dir } = {}): { ship: Ship; helm: [number, number, number] } {
  const m = opts.mirror === true ? -1 : 1;
  const hx = 1 * m;
  const facing = opts.facing ?? NZ;
  const cells: Array<[number, number, number, number]> = [];
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) cells.push([x, 60, z, PLANKS]);
  const ship = shipOf(b, 1, cells);
  // The seat column is the cell behind the helm: helm z - DIR_Z(facing).
  const sz = facing === NZ ? -1 : -3;
  if (opts.seatFloor !== undefined) ship.grid.setCell(hx, 60, sz, opts.seatFloor);
  if (opts.seatCell !== undefined) ship.grid.setCell(hx, 61, sz, opts.seatCell);
  ship.grid.setCell(hx, 61, -2, makeCell(B.HELM, facingState(facing)));
  ship.forward = facing;
  return { ship, helm: [hx, 61, -2] };
}

describe('5.9 the helm seat', () => {
  function seatOf(opts: Parameters<typeof helmShip>[1]): { x: number; y: number; z: number } {
    const b = new Bench();
    const { ship, helm } = helmShip(b, opts);
    const p = b.entities.spawnPlayer('survival', 2.5, 61, 2.5);
    b.tick(2);
    expect(b.entities.startSteering(p, ship, helm[0], helm[1], helm[2])).toBe(true);
    return { x: p.seat.x, y: p.seat.y, z: p.seat.z };
  }

  it('on a full floor: the cell behind the helm, feet on its floor (M1)', () => {
    expect(seatOf({})).toEqual({ x: 1.5, y: 61, z: -0.5 });
  });

  it('on a lower half slab in the seat cell: on the slab (y + 0.5)', () => {
    expect(seatOf({ seatCell: slab(B.PLANKS_OAK, LOWER) })).toEqual({ x: 1.5, y: 61.5, z: -0.5 });
  });

  it('on an upper half slab as the floor cell (flush with the deck): on its top', () => {
    expect(seatOf({ seatFloor: slab(B.PLANKS_OAK, UPPER) })).toEqual({ x: 1.5, y: 61, z: -0.5 });
  });

  it('on a lower half slab as the floor cell: on the slab, half a block down', () => {
    expect(seatOf({ seatFloor: slab(B.PLANKS_OAK, LOWER) })).toEqual({ x: 1.5, y: 60.5, z: -0.5 });
  });

  it('with no floor under the seat cell (a full-block ship): the M1 position, at the seat cell', () => {
    expect(seatOf({ seatFloor: 0 })).toEqual({ x: 1.5, y: 61, z: -0.5 });
  });

  it('a blocked seat column keeps the player where it stands (M1)', () => {
    const b = new Bench();
    const { ship, helm } = helmShip(b, { seatCell: PLANKS });
    ship.grid.setCell(helm[0], 62, -1, PLANKS);
    const p = b.entities.spawnPlayer('survival', 2.5, 61, 2.5);
    b.tick(2);
    b.entities.startSteering(p, ship, helm[0], helm[1], helm[2]);
    const at = ship.grid.toWorld(p.seat, vec3());
    expect(Math.hypot(at.x - p.pos.x, at.y - p.pos.y, at.z - p.pos.z)).toBeLessThan(1e-9);
    expect(p.seat.x).not.toBe(1.5);
  });

  it('mirrored ships seat mirrored helmsmen; the helm facing the other way changes only the column', () => {
    for (const floor of [undefined, slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER), slab(B.PLANKS_OAK, WEST_HALF), slab(B.PLANKS_OAK, EAST_HALF)]) {
      const a = seatOf({ seatFloor: floor });
      const mirrorFloor = floor === slab(B.PLANKS_OAK, WEST_HALF) ? slab(B.PLANKS_OAK, EAST_HALF) : floor === slab(B.PLANKS_OAK, EAST_HALF) ? slab(B.PLANKS_OAK, WEST_HALF) : floor;
      const m = seatOf({ seatFloor: mirrorFloor, mirror: true });
      expect(m).toEqual({ x: -a.x + 1, y: a.y, z: a.z }); // cell -1 is the mirror of cell 1: x -> 1 - x... centred: 1.5 -> -0.5
      const f = seatOf({ seatFloor: floor, facing: PZ });
      expect(f.y).toBe(a.y);
    }
  });
});

describe('5.9 falling blocks landing on half slabs', () => {
  function drop(below: number): { b: Bench; landed: number } {
    const b = new Bench();
    fill(b.world, -3, 60, -3, 3, 60, 3, STONE);
    b.world.setCell(0, 61, 0, below);
    const e = b.entities.spawnFalling(0, 70, 0, makeCell(B.SAND));
    b.tickUntil(() => e.removed, 200);
    return { b, landed: b.world.getCell(0, 62, 0) };
  }

  it('on a lower half slab: it becomes a block in the cell above the slab (half a block gap), the slab unchanged', () => {
    const { b, landed } = drop(slab(B.STONE, LOWER));
    expect(landed).toBe(makeCell(B.SAND));
    expect(b.world.getCell(0, 61, 0)).toBe(slab(B.STONE, LOWER));
    expect(b.host.count('land')).toBe(1);
  });

  it('on an upper half slab and on a single octant: the cell above too; on a vertical half slab: above it', () => {
    for (const below of [slab(B.STONE, UPPER), slab(B.STONE, 0x01), slab(B.STONE, WEST_HALF)]) {
      const { b, landed } = drop(below);
      expect(landed).toBe(makeCell(B.SAND));
      expect(b.world.getCell(0, 61, 0)).toBe(below);
    }
  });

  it('a falling block must carry a full block: spawning one with a partial cell throws', () => {
    const b = new Bench();
    expect(() => b.entities.spawnFalling(0, 70, 0, slab(B.STONE, LOWER))).toThrow(RangeError);
  });
});

describe('5.9 a buried body rises to the first free half-cell height (riseOut)', () => {
  it('an item buried in rock under a layer of lower half slabs pops out on the slabs (y + 0.5), not half a block above them', () => {
    const b = new Bench();
    fill(b.world, -5, 50, -5, 5, 60, 5, STONE);
    for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) b.world.setCell(x, 61, z, slab(B.STONE, LOWER));
    const item = b.entities.spawnItem(0.5, 55.3, 0.5, B.COBBLE, 1, vec3(0, 0, 0));
    b.tick(1);
    expect(item.pos.y).toBe(61.5);
    expect(inWorld(b.world, item)).toBe(false);
  });
});
