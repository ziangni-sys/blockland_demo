/**
 * Walking on half slabs (docs/SHAPES.md 5.7, ACCEPTANCE 38), in the world and on a structure:
 * walking up onto a half slab without jumping (a whole block still needs a jump), standing on one
 * without sinking, not being caught on the seams of a row of them (along the row on top of it,
 * beside it, diagonally across its cells; on a deck where full blocks meet half slabs), walking
 * down a half slab (a short fall, no damage), and a fast fall onto a half-slab floor or deck that
 * does not tunnel through it (MAX_SUBSTEP < 0.5).
 */
import { describe, expect, it } from 'vitest';
import { BodyMover, type BodyStructure } from '../../src/entities/body';
import { Player } from '../../src/entities/entity';
import { analyzeHull } from '../../src/structures/hull';
import { Ship } from '../../src/structures/structure';
import { LOWER, slab, UPPER } from '../shapes';
import { B, Bench, fill, inStructure, inWorld, makeCell, qfromYaw, quat, vec3 } from './harness';

const STONE = makeCell(B.STONE);
const lower = slab(B.STONE, LOWER);
const upper = slab(B.STONE, UPPER);

/** Yaw that walks toward +X (forward = (-sin yaw, 0, -cos yaw)). */
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;
const NORTH = 0;

/** A flat stone floor whose top is at y = 61. */
function flat(): Bench {
  const b = new Bench();
  fill(b.world, -30, 60, -30, 29, 60, 29, STONE);
  return b;
}

/** A ship made of packed cells (half slabs included), at rest where it was built (local == world at build time). */
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

function cellsOf(x0: number, z0: number, x1: number, z1: number, y: number, cell: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, y, z, cell]);
  return out;
}

describe('5.7 walking up onto a half slab', () => {
  it('world: a player walks up onto a lower half slab without jumping, and onto the next one (a staircase of half steps)', () => {
    const b = flat();
    // A two-step staircase across the path (north of z = 10): lower slabs (top 61.5), then full blocks (top 62).
    for (let x = -4; x <= 4; x++) {
      for (let z = 4; z <= 9; z++) b.world.setCell(x, 61, z, lower);
      for (let z = -4; z <= 3; z++) b.world.setCell(x, 61, z, STONE);
    }
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 15.5);
    p.input.yaw = NORTH;
    p.input.forward = 1;
    let maxY = 61;
    let onSlab = false;
    for (let i = 0; i < 80; i++) {
      b.tick();
      maxY = Math.max(maxY, p.pos.y);
      if (p.pos.z < 8.5 && p.pos.z > 5 && p.onGround) {
        expect(p.pos.y).toBe(61.5); // standing exactly on the slab top
        onSlab = true;
      }
    }
    expect(onSlab).toBe(true);
    expect(p.pos.z).toBeLessThan(2); // up the second half step too, onto the full blocks
    expect(p.pos.y).toBe(62);
    expect(maxY).toBe(62); // never higher: it stepped, it did not jump
    expect(inWorld(b.world, p)).toBe(false);
  });

  it('world: a whole block (1.0) is still not walked up', () => {
    const b = flat();
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 9; z++) b.world.setCell(x, 61, z, STONE);
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 15.5);
    p.input.forward = 1;
    b.tick(60);
    expect(p.pos.y).toBe(61);
    expect(p.pos.z).toBeCloseTo(10.3, 6);
  });

  it('structure: a player walks from a full-block deck up onto a step of half slabs on the same ship', () => {
    const b = new Bench();
    const cells = cellsOf(-3, -3, 3, 8, 50, makeCell(B.PLANKS_OAK));
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 2; z++) cells.push([x, 51, z, slab(B.PLANKS_OAK, LOWER)]);
    const s = shipOf(b, 1, cells);
    const p = b.entities.spawnPlayer('survival', 0.5, 51, 6.5);
    b.tick(5);
    expect(p.carrierId).toBe(s.id);
    p.input.yaw = NORTH;
    p.input.forward = 1;
    let maxY = 0;
    for (let i = 0; i < 30; i++) {
      b.tick();
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(p.pos.z).toBeLessThan(1);
    expect(p.pos.z).toBeGreaterThan(-2.5); // still on the ship
    expect(p.pos.y).toBeCloseTo(51.5, 4);
    expect(maxY).toBeLessThan(51.51);
    expect(p.carrierId).toBe(s.id);
    expect(inStructure(s, p)).toBe(false);
  });
});

describe('5.7 standing on a half slab does not sink', () => {
  it('world: 100 ticks on a lower slab, feet exactly at y + 0.5 every tick', () => {
    const b = flat();
    b.world.setCell(0, 61, 0, lower);
    const p = b.entities.spawnPlayer('survival', 0.5, 61.5, 0.5);
    for (let i = 0; i < 100; i++) {
      b.tick();
      expect(p.pos.y).toBe(61.5);
      expect(p.onGround).toBe(true);
    }
  });

  it('structure: 100 ticks on a deck of lower slabs, feet on the slab top every tick, carried', () => {
    const b = new Bench();
    const s = shipOf(b, 1, cellsOf(-3, -3, 3, 3, 50, slab(B.PLANKS_OAK, LOWER)));
    const p = b.entities.spawnPlayer('survival', 0.5, 50.5, 0.5);
    for (let i = 0; i < 100; i++) {
      b.tick();
      expect(p.pos.y).toBeGreaterThanOrEqual(50.5);
      expect(p.pos.y).toBeLessThan(50.5 + 1e-4);
      expect(p.carrierId).toBe(s.id);
    }
  });
});

describe('5.7 not caught on the seams of a row of half slabs', () => {
  it('world: walking along the top of a row, beside it, and diagonally across its cells, at walking speed, never stopped', () => {
    const b = flat();
    for (let x = -20; x <= 20; x++) {
      b.world.setCell(x, 61, 0, lower);
      b.world.setCell(x, 61, 1, lower);
    }
    // On top, along +X.
    const top = b.entities.spawnPlayer('survival', -15.5, 61.5, 1.0);
    top.input.yaw = EAST;
    top.input.forward = 1;
    // Beside the row, its side exactly on the row's north face (z = 0) ... the body is 0.6 wide.
    const beside = b.entities.spawnPlayer('survival', -15.5, 61, -0.3);
    beside.input.yaw = EAST;
    beside.input.forward = 1;
    b.tick(10);
    const x0 = top.pos.x;
    const x1 = beside.pos.x;
    for (let i = 0; i < 40; i++) {
      b.tick();
      expect(top.pos.y).toBe(61.5);
      expect(top.contactNx).toBe(0);
      expect(beside.pos.y).toBe(61);
      expect(beside.contactNx).toBe(0);
      expect(beside.contactNz).toBe(0);
    }
    expect(top.pos.x - x0).toBeGreaterThan(4.3 * 2 - 0.2);
    expect(beside.pos.x - x1).toBeGreaterThan(4.3 * 2 - 0.2);
    expect(top.pos.z).toBe(1.0);
    expect(beside.pos.z).toBe(-0.3);
    // Diagonally across the slab cells (on top): never stopped either.
    const diag = b.entities.spawnPlayer('survival', -5.2, 61.5, 0.9);
    diag.input.yaw = EAST + 0.15;
    diag.input.forward = 1;
    for (let i = 0; i < 30; i++) {
      b.tick();
      expect(diag.pos.y).toBe(61.5);
      expect(diag.contactNx).toBe(0);
    }
  });

  it('structure: on a deck where full blocks meet upper half slabs (a flush floor), walking across and along the seam, even while the deck bobs, never pushed sideways', () => {
    const b = new Bench();
    const cells = cellsOf(-6, -3, -1, 3, 50, makeCell(B.PLANKS_OAK));
    for (const c of cellsOf(0, -3, 5, 3, 50, slab(B.PLANKS_OAK, UPPER))) cells.push(c);
    const s = shipOf(b, 1, cells);
    const base = vec3(s.grid.position.x, s.grid.position.y, s.grid.position.z);
    b.drive(s, (t) => ({ p: vec3(base.x, base.y + 0.06 * Math.sin(t * 0.3), base.z), q: quat() }));
    // Across the seam (x = 0) from the full blocks to the slabs and back.
    const p = b.entities.spawnPlayer('survival', -3.5, 51, 0.5);
    b.tick(5);
    p.input.yaw = EAST;
    p.input.forward = 1;
    for (let i = 0; i < 40; i++) {
      b.tick();
      expect(Math.abs(p.pos.z - 0.5)).toBeLessThan(1e-9); // never pushed along z
      expect(p.carrierId).toBe(s.id);
      const deckTop = s.grid.position.y - s.grid.pivot.y + 51;
      expect(Math.abs(p.pos.y - deckTop)).toBeLessThan(0.08);
    }
    expect(p.pos.x).toBeGreaterThan(3);
    // Along the seam: the body straddles it the whole way.
    const q = b.entities.spawnPlayer('survival', 0.0, 51.1, -2.5);
    b.tick(5);
    q.input.yaw = Math.PI; // +Z
    q.input.forward = 1;
    for (let i = 0; i < 20; i++) {
      b.tick();
      expect(Math.abs(q.pos.x - 0.0)).toBeLessThan(1e-9);
      expect(q.carrierId).toBe(s.id);
    }
    expect(q.pos.z).toBeGreaterThan(1.5);
  });
});

describe('5.3 at a deck seam: a body sunk into the deck is pushed straight up, never sideways', () => {
  // The server pushes a client-driven player out of the structures at their present poses
  // (BodyMover.pushOut, the squeeze and hull judgement): a rider reported at a lagging copy of a
  // deck that rises sits that much inside the server's deck. Inside one tick the collider seldom
  // shows the seam rule (a body's own motion into a structure is taken back, and a moving
  // structure biases the push its way), so the rule is pinned here: where full blocks meet upper
  // half slabs, the full cell's face toward the slab is exposed only on its lower half, and the
  // slab's octant faces toward the full cell's octants are not exposed at all; a body sunk up to
  // 0.45 anywhere across the seam comes out on top of the deck where it was.
  it('across a seam along x and one along z, sunk 0.1 to 0.45, at every offset from the seam', () => {
    const b = new Bench();
    const bad: string[] = [];
    for (const axis of ['x', 'z'] as const) {
      const cells: Array<[number, number, number, number]> = [];
      for (let x = -6; x <= 5; x++) for (let z = -6; z <= 5; z++) cells.push([x, 50, z, (axis === 'x' ? x : z) < 0 ? makeCell(B.PLANKS_OAK) : slab(B.PLANKS_OAK, UPPER)]);
      const s = shipOf(b, axis === 'x' ? 1 : 2, cells);
      const list: readonly BodyStructure[] = [s];
      const mover = new BodyMover({ world: b.world, structures: () => list });
      mover.beginCarry();
      for (const d of [0.1, 0.2, 0.3, 0.4, 0.45])
        for (let k = 0; k <= 30; k++) {
          const off = -0.45 + k * 0.03;
          const p = new Player(1, 'survival');
          p.setPosition(axis === 'x' ? off : 0.5, 51 - d, axis === 'z' ? off : 0.5);
          mover.pushOut(p);
          const side = axis === 'x' ? p.pos.x - off : p.pos.z - off;
          if (Math.abs(side) > 1e-6 || Math.abs(p.pos.y - 51) > 1e-6) bad.push(`seam along ${axis}, sunk ${d}, ${off.toFixed(2)} from it: moved ${side.toFixed(3)} sideways, feet at ${p.pos.y.toFixed(3)}`);
        }
      b.host.list.length = 0;
    }
    expect(bad).toEqual([]);
  });
});

describe('5.7 walking down a half slab', () => {
  it('a short fall of about 4 ticks: no damage, no land event below 1 block', () => {
    const b = flat();
    for (let x = -4; x <= 4; x++) for (let z = 0; z <= 9; z++) b.world.setCell(x, 61, z, lower);
    const p = b.entities.spawnPlayer('survival', 0.5, 61.5, 5.5);
    p.input.yaw = Math.PI; // +Z, off the slab platform's south edge
    p.input.forward = 1;
    let air = 0;
    for (let i = 0; i < 40; i++) {
      b.tick();
      if (!p.onGround) air++;
    }
    expect(p.pos.z).toBeGreaterThan(11);
    expect(p.pos.y).toBe(61);
    expect(air).toBeGreaterThan(0);
    expect(air).toBeLessThan(8);
    expect(p.health).toBe(20);
    expect(b.host.count('land', p)).toBe(0);
  });
});

describe('5.7 a fast fall onto a half-slab floor does not tunnel (MAX_SUBSTEP 0.4 < 0.5)', () => {
  it('world: falling from 60 blocks up lands exactly on the slab top', () => {
    const b = flat();
    b.world.setCell(0, 61, 0, lower);
    const p = b.entities.spawnPlayer('creative', 0.5, 121.5, 0.5);
    b.tickUntil(() => p.onGround, 400);
    // (The sweep stops the box exactly at 61.5; the feet add the swept distance to their height.)
    expect(p.pos.y).toBeCloseTo(61.5, 9);
    expect(inWorld(b.world, p)).toBe(false);
  });

  it('structure: items and a player falling fast onto a deck one half slab thick land on it, not under it', () => {
    const b = new Bench();
    const s = shipOf(b, 1, cellsOf(-3, -3, 3, 3, 50, slab(B.PLANKS_OAK, UPPER)));
    const p = b.entities.spawnPlayer('creative', 0.5, 90, 0.5);
    // Items (the thinnest bodies, 0.25 high) at terminal speed from twelve heights a little apart, so
    // the sub-steps meet the deck at every phase: a body passes through a floor 0.5 thick only with
    // sub-steps longer than 0.5 + its height.
    const items = Array.from({ length: 12 }, (_, k) => b.entities.spawnItem(-2.5 + (k % 6), 95 + k * 0.173, k < 6 ? -1.5 : 1.5, k % 2 === 0 ? B.COBBLE : B.DIRT, 1, vec3(0, -40, 0)));
    b.tick(120);
    expect(p.pos.y).toBeGreaterThan(50.99);
    expect(p.pos.y).toBeLessThan(51.01);
    expect(p.carrierId).toBe(s.id);
    for (const item of items) {
      expect(item.pos.y).toBeGreaterThan(50.99);
      expect(item.pos.y).toBeLessThan(51.01);
    }
    // A deck one half slab thick yawed 30 degrees: the same.
    const b2 = new Bench();
    const s2 = shipOf(b2, 1, cellsOf(-3, -3, 3, 3, 50, slab(B.PLANKS_OAK, LOWER)));
    s2.grid.setPoseImmediate(vec3(s2.grid.position.x, s2.grid.position.y, s2.grid.position.z), qfromYaw(Math.PI / 6));
    const p2 = b2.entities.spawnPlayer('creative', s2.grid.position.x, 90, s2.grid.position.z);
    b2.tick(120);
    expect(p2.pos.y).toBeGreaterThan(50.49);
    expect(p2.pos.y).toBeLessThan(50.51);
    expect(p2.carrierId).toBe(s2.id);
  });
});
