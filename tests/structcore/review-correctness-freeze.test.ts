/**
 * REVIEW (correctness): world rotors freeze far too eagerly.
 *
 * Brief: "update frozen flags (ship: !world.isAreaLoaded over its world bounding box grown by
 * 2; world rotor: likewise ...)". StructureManager.rotorBox() instead uses the AABB of a
 * sphere whose radius is the distance from the pivot to the far CORNER of the local cell
 * bounds. For a windmill (arms along two axes) that radius is ~sqrt(2) x the arm length, and
 * the sphere's AABB is square in XZ although a windmill (horizontal axis) only ever covers a
 * thin strip of columns. Under the game's real chunk loading (sim/chunks.ts: a disc of
 * radius 8 chunks around the player, d^2 <= r^2 + r) legal windmills never turn.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { StructureManager } from '../../src/structures/manager';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost } from './helpers';

/** Chunk loading as sim/chunks.ts does it: every column with dx^2 + dz^2 <= r^2 + r of the anchor chunk. */
function discWorld(pcx: number, pcz: number, r = 8): World {
  const world = new World(1);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz <= r * r + r) world.addChunk(new Chunk(pcx + dx, pcz + dz));
    }
  }
  return world;
}

/** Bearing at (0,64,0) facing +Z on a planks support; felt arms in the plane z = 1. */
function bigWindmill(world: World, px: number, nx: number, py: number, ny: number): void {
  world.setCell(0, 64, -1, c(B.PLANKS_OAK));
  world.setCell(0, 64, 0, facing(B.BEARING, 4));
  world.setCell(0, 64, 1, c(B.CANVAS));
  for (let i = 1; i <= px; i++) world.setCell(i, 64, 1, c(B.WOOL_RED));
  for (let i = 1; i <= nx; i++) world.setCell(-i, 64, 1, c(B.WOOL_BLUE));
  for (let i = 1; i <= py; i++) world.setCell(0, 64 + i, 1, c(B.WOOL_WHITE));
  for (let i = 1; i <= ny; i++) world.setCell(0, 64 - i, 1, c(B.WOOL_YELLOW));
}

/** World AABB of the rotor's cells in their current pose, grown by 2 — the brief's box. */
function briefBoxLoaded(world: World, mgr: StructureManager): boolean {
  const r = mgr.rotors()[0]!;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  r.grid.forEachCell((x, y, z) => {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as const) {
      const p = r.grid.toWorld({ x: x + dx, y: y + dy, z: z + dz });
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
  });
  return world.isAreaLoaded(minX - 2, minZ - 2, maxX + 2, maxZ + 2);
}

describe('REVIEW: world rotor frozen flag vs the brief ("world rotor: likewise")', () => {
  it('a legal 322-cell windmill never turns although the player stands at its bearing', () => {
    const world = discWorld(0, 0); // the player stands at the bearing
    const host = new FakeHost(world);
    const mgr = new StructureManager(host, null);
    bigWindmill(world, 99, 99, 63, 60); // 1 + 99 + 99 + 63 + 60 = 322 cells <= ROTOR_MAX_CELLS
    const res = mgr.startRotor(world, 0, 64, 0);
    if (!res.ok) throw new Error(res.reason);
    const rotor = res.structure;
    expect(rotor.grid.count).toBe(322);
    // Every column the windmill touches (+2) is loaded:
    expect(briefBoxLoaded(world, mgr)).toBe(true);
    for (let i = 0; i < 40; i++) mgr.step();
    expect(rotor.frozen).toBe(false); // FAILS: frozen forever
    expect(rotor.angle).not.toBe(0);
  });

  it('a 161-cell windmill stops turning as soon as the player is ~5 chunks away', () => {
    const world = discWorld(5, 0); // player ~80 blocks east of the windmill
    const host = new FakeHost(world);
    const mgr = new StructureManager(host, null);
    bigWindmill(world, 40, 40, 40, 40);
    const res = mgr.startRotor(world, 0, 64, 0);
    if (!res.ok) throw new Error(res.reason);
    const rotor = res.structure;
    expect(briefBoxLoaded(world, mgr)).toBe(true);
    for (let i = 0; i < 40; i++) {
      mgr.step();
      expect(briefBoxLoaded(world, mgr)).toBe(true); // still true at every angle it reaches
    }
    expect(rotor.frozen).toBe(false); // FAILS
    expect(rotor.angle).not.toBe(0);
  });
});
