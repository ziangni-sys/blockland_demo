/**
 * Adversarial review (robustness): a world whose tick queue has gone quiet must be a fixed
 * point — loading it again (rescheduleChunk on every chunk) or streaming in an unrelated
 * neighbouring chunk (the simulation's insert protocol) must not change any cell.
 *
 * Failure mechanism: a liquid cell is only re-ticked when one of its 6 neighbours changes,
 * but its spreading decision (slope search) reads cells up to 5 columns away. Digging a
 * hole within slope reach but not next to any liquid leaves the old decision in force with
 * an empty queue; rescheduleChunk's conservative isRestless() then re-ticks the cell on the
 * next load / neighbour load and the "settled" water suddenly flows somewhere else.
 */
import { describe, expect, it } from 'vitest';
import { AIR } from '../../src/blocks/cell';
import { World } from '../../src/voxel/world';
import { Fluids } from '../../src/liquid/fluids';
import {
  FLOOR_Y,
  STONE,
  SURFACE,
  buildWorld,
  makeChunk,
  pumpUntilQuiet,
  snapshotCells,
  water,
  type CellFn,
  type FluidWorld,
} from './helpers';

function changedCells(before: Map<number, Uint16Array>, world: World): number {
  let diff = 0;
  for (const [k, cells] of before) {
    const now = world.chunks.get(k)!.cells;
    for (let i = 0; i < cells.length; i++) if (cells[i] !== now[i]) diff++;
  }
  return diff;
}

describe('review: a quiet world is a fixed point', () => {
  it('rescheduling every chunk of a quiet world (save / load) changes nothing', () => {
    // Source at (8, SURFACE, 8); the only hole is 4 north, so the water runs north only.
    const holeNorth: CellFn = (x, y, z) => (y === 4 ? STONE : y === FLOOR_Y ? (x === 8 && z === 4 ? AIR : STONE) : AIR);
    const fw = buildWorld(holeNorth);
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    // A new, nearer hole 3 east of the source. No liquid touches it, so nothing is woken.
    world.setCell(11, FLOOR_Y, 8, AIR);
    pumpUntilQuiet(fw);
    expect(world.ticks.size).toBe(0);
    const quiet = snapshotCells(world);

    // The load path: every chunk is rescheduled.
    for (const chunk of world.chunks.values()) fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(fw);
    // Observed: the source now flows east into the new hole (93 cells change).
    expect(changedCells(quiet, world)).toBe(0);
  });

  it('streaming in an unrelated neighbouring chunk (simulation insert protocol) changes nothing', () => {
    const scene: CellFn = (x, y, z) => (y === 4 ? STONE : y === FLOOR_Y ? (x === 8 && z === 0 ? AIR : STONE) : AIR);
    // Chunks cz = -1, 0 only; the row cz = 1 arrives later.
    const world = new World(1);
    for (let cz = -1; cz <= 0; cz++) for (let cx = -1; cx <= 1; cx++) world.addChunk(makeChunk(cx, cz, scene));
    const fluids = new Fluids(world);
    fluids.attach();
    const fw: FluidWorld = { world, fluids };
    world.setCell(8, SURFACE, 4, water()); // hole 4 north at (8, FLOOR_Y, 0)
    pumpUntilQuiet(fw);
    world.setCell(11, FLOOR_Y, 4, AIR); // nearer hole 3 east, touching no liquid
    pumpUntilQuiet(fw);
    const quiet = snapshotCells(world);

    // ChunkManager.insert(): rescheduleChunk(new chunk) + rescheduleChunk(each loaded neighbour).
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = makeChunk(cx, 1, scene);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = world.getChunk(cx + dx, 1 + dz);
        if (n) fluids.rescheduleChunk(n);
      }
    }
    pumpUntilQuiet(fw);
    // The new row is 12+ cells away from every wet cell; still the old chunks change.
    expect(changedCells(quiet, world)).toBe(0);
  });
});
