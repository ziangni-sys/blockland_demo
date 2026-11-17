/**
 * What wakes liquid, and the property that depends on it: a world whose tick queue is empty
 * is a fixed point. Loading it (rescheduleChunk on every chunk), streaming in an unrelated
 * neighbour chunk, or ticking every liquid cell once must not change a single cell.
 *
 * The slope search of a liquid cell reads cells up to 5 columns away, so a change there
 * (a hole dug, a hole filled, a wall removed) must wake it even when it touches no liquid.
 */
import { describe, expect, it } from 'vitest';
import { AIR } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LIQUID } from '../../src/blocks/registry';
import { Rng } from '../../src/core/rng';
import { SET_NO_NEIGHBOR_UPDATE } from '../../src/voxel/grid';
import { World } from '../../src/voxel/world';
import { Fluids, WATER_TICK_DELAY, pumpTicks } from '../../src/liquid/fluids';
import {
  FLOOR_Y,
  STONE,
  SURFACE,
  buildWorld,
  countLiquid,
  diamond,
  lava,
  liquidCells,
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

/** Run one tick on every liquid cell of the world; returns the number of cell writes. */
function tickEveryLiquidCell(fw: FluidWorld): number {
  let writes = 0;
  const off = fw.world.onCellChange(() => writes++);
  for (const c of liquidCells(fw.world)) fw.fluids.tick(c.x, c.y, c.z, c.id);
  off();
  return writes;
}

/** Floor at FLOOR_Y with the given holes ("x,z"), and a cave floor at y = 4 below. */
function floorWithHoles(...holes: Array<[number, number]>): CellFn {
  const set = new Set(holes.map(([x, z]) => `${x},${z}`));
  return (x, y, z) => (y === 4 ? STONE : y === FLOOR_Y ? (set.has(`${x},${z}`) ? AIR : STONE) : AIR);
}

describe('a quiet world is a fixed point', () => {
  it('a hole dug within slope reach but touching no liquid wakes the liquid; reloading then changes nothing', () => {
    // Source at (8, S, 8); the only hole is 4 north, so the water runs north only.
    const fw = buildWorld(floorWithHoles([8, 4]));
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(liquidCells(world).filter((c) => c.y === SURFACE).map((c) => `${c.x},${c.z}`)).toEqual([
      '8,4',
      '8,5',
      '8,6',
      '8,7',
      '8,8',
    ]);
    // A new, nearer hole 3 east of the source; no liquid touches it.
    world.setCell(11, FLOOR_Y, 8, AIR);
    expect(world.ticks.has(8, SURFACE, 8, B.WATER)).toBe(true);
    pumpUntilQuiet(fw);
    // The source now also pours east (the north run stays: it is still fed).
    expect(world.getId(11, FLOOR_Y, 8)).toBe(B.WATER);
    expect(world.getId(11, 5, 8)).toBe(B.WATER);
    const quiet = snapshotCells(world);

    // The load path: every chunk is rescheduled.
    for (const chunk of world.chunks.values()) fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(fw);
    expect(changedCells(quiet, world)).toBe(0);
    expect(tickEveryLiquidCell(fw)).toBe(0);
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
    // The new row is 12+ cells away from every wet cell: the old chunks must not change.
    expect(changedCells(quiet, world)).toBe(0);
  });

  it('filling the hole the water was pouring into lets it spread everywhere, as if the hole never was', () => {
    const fw = buildWorld(floorWithHoles([11, 8]));
    const { world } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(liquidCells(world).filter((c) => c.y === SURFACE).length).toBe(4);
    // Plug the hole (it holds the top of the waterfall). The source is 3 columns away.
    world.setCell(11, FLOOR_Y, 8, STONE);
    pumpUntilQuiet(fw);
    const cells = liquidCells(world);
    expect(cells.length).toBe(113); // the cave below drained
    const shape = diamond(8, 8, 7);
    for (const c of cells) {
      expect(c.y).toBe(SURFACE);
      expect(shape.has(`${c.x},${c.z}`)).toBe(true);
    }
  });

  it('removing a wall that kept the water from a hole re-routes it', () => {
    // Hole 2 east, a wall at x = 9 (z 4..12) in between: no path within reach, so the
    // source spreads west, north and south. Removing the wall cell east of the source wakes it.
    const walled: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return x === 10 && z === 8 ? AIR : STONE;
      if (y === SURFACE && x === 9 && z >= 4 && z <= 12) return STONE;
      return AIR;
    };
    const fw = buildWorld(walled);
    const { world } = fw;
    world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(world.getId(10, FLOOR_Y, 8)).toBe(AIR);
    world.setCell(9, SURFACE, 12, AIR); // the far end of the wall: 4 columns from the source
    pumpUntilQuiet(fw);
    const quiet = snapshotCells(world);
    for (const chunk of world.chunks.values()) fw.fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(fw);
    expect(changedCells(quiet, world)).toBe(0);
    world.setCell(9, SURFACE, 8, AIR); // right next to the source: the hole is 2 away now
    pumpUntilQuiet(fw);
    expect(world.getId(10, FLOOR_Y, 8)).toBe(B.WATER);
    expect(tickEveryLiquidCell(fw)).toBe(0);
  });

  it('random scenes with random edits during the flow settle into fixed points (water and lava)', () => {
    let scenes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new Rng(seed);
      const fw = buildWorld(floorWithHoles());
      const { world, fluids } = fw;
      const rnd = (a: number, b: number): number => rng.int(a, b);
      for (let i = 0; i < 20; i++) world.setCell(rnd(-6, 22), FLOOR_Y, rnd(-6, 22), AIR);
      for (let i = 0; i < 40; i++) world.setCell(rnd(-6, 22), rnd(SURFACE, SURFACE + 1), rnd(-6, 22), STONE);
      for (let i = 0; i < 3; i++) world.setCell(rnd(0, 16), rnd(SURFACE, SURFACE + 2), rnd(0, 16), water());
      if (seed % 2 === 0) world.setCell(rnd(0, 16), SURFACE, rnd(0, 16), lava());
      for (let step = 0; step < 30; step++) {
        pumpTicks(world, fluids, rnd(1, 12));
        const x = rnd(-4, 20);
        const z = rnd(-4, 20);
        switch (rng.int(0, 4)) {
          case 0:
            world.setCell(x, FLOOR_Y, z, AIR);
            break;
          case 1:
            world.setCell(x, FLOOR_Y, z, STONE);
            break;
          case 2:
            world.setCell(x, SURFACE, z, STONE);
            break;
          case 3:
            world.setCell(x, SURFACE, z, AIR);
            break;
          default:
            world.setCell(x, rnd(SURFACE, SURFACE + 2), z, rng.chance(0.5) ? AIR : water());
        }
      }
      pumpUntilQuiet(fw, 30_000);
      if (countLiquid(world) > 0) scenes++;
      const quiet = snapshotCells(world);
      for (const chunk of world.chunks.values()) fluids.rescheduleChunk(chunk);
      pumpUntilQuiet(fw, 30_000);
      expect(changedCells(quiet, world), `seed ${seed}: rescheduling changed cells`).toBe(0);
      expect(tickEveryLiquidCell(fw), `seed ${seed}: a liquid tick wrote`).toBe(0);
    }
    expect(scenes).toBeGreaterThan(30);
  });

  it('plain flow writes do not trigger the wide wake: the 113-cell diamond takes few liquid ticks', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, water());
    let ticks = 0;
    while (world.ticks.size > 0) {
      world.time++;
      for (const t of world.ticks.takeDue(world.time)) {
        fluids.tick(t.x, t.y, t.z, t.id);
        ticks++;
      }
    }
    expect(countLiquid(world)).toBe(113);
    // One tick per cell when it appears, one more after each neighbour change it causes.
    expect(ticks).toBeLessThanOrEqual(2 * 113);
  });
});

describe('wakeAround (bulk writes made with SET_NO_NEIGHBOR_UPDATE)', () => {
  /** Settled source at (8, S, 8) boxed by a stone ring of radius 2 on the SURFACE layer. */
  function boxedSource(): FluidWorld {
    const ring: CellFn = (x, y, z) => {
      if (y === 4) return STONE;
      if (y === FLOOR_Y) return x === 13 && z === 8 ? AIR : STONE;
      if (y === SURFACE && Math.max(Math.abs(x - 8), Math.abs(z - 8)) === 2) return STONE;
      return AIR;
    };
    const fw = buildWorld(ring);
    fw.world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    expect(countLiquid(fw.world)).toBe(9);
    return fw;
  }
  const RING: Array<[number, number]> = [];
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) RING.push([8 + dx, 8 + dz]);
  }

  it('flagged writes leave the liquid alone; wakeAround on each changed cell resumes it exactly like plain writes', () => {
    const reference = boxedSource();
    for (const [x, z] of RING) reference.world.setCell(x, SURFACE, z, AIR);
    pumpUntilQuiet(reference);

    const bulk = boxedSource();
    for (const [x, z] of RING) bulk.world.setCell(x, SURFACE, z, AIR, SET_NO_NEIGHBOR_UPDATE);
    expect(bulk.world.ticks.size).toBe(0);
    pumpTicks(bulk.world, bulk.fluids, 3 * WATER_TICK_DELAY);
    expect(countLiquid(bulk.world)).toBe(9); // frozen: nobody told the water
    for (const [x, z] of RING) bulk.fluids.wakeAround(x, SURFACE, z);
    expect(bulk.world.ticks.size).toBeGreaterThan(0);
    pumpUntilQuiet(bulk);
    expect(liquidCells(bulk.world)).toEqual(liquidCells(reference.world));
    // The hole 5 east of the source drew the flow, so the result is not the open diamond.
    expect(bulk.world.getId(13, FLOOR_Y, 8)).toBe(B.WATER);
  });

  it('wakeAround schedules a flagged liquid write and the lava next to new water reacts at once', () => {
    const fw = buildWorld();
    const { world, fluids } = fw;
    world.setCell(8, SURFACE, 8, lava(), SET_NO_NEIGHBOR_UPDATE);
    world.ticks.clear();
    world.setCell(9, SURFACE, 8, water(), SET_NO_NEIGHBOR_UPDATE);
    world.ticks.clear(); // the flagged water write scheduled only itself
    fluids.wakeAround(9, SURFACE, 8);
    expect(world.ticks.has(9, SURFACE, 8, B.WATER)).toBe(true);
    expect(world.ticks.has(8, SURFACE, 8, B.LAVA)).toBe(true);
    pumpTicks(world, fluids, 1);
    expect(world.getId(8, SURFACE, 8)).toBe(B.OBSIDIAN);
  });

  it('on a settled world wakeAround changes nothing', () => {
    const fw = boxedSource();
    const quiet = snapshotCells(fw.world);
    for (let x = 4; x <= 12; x++) for (let z = 4; z <= 12; z++) fw.fluids.wakeAround(x, SURFACE, z);
    pumpUntilQuiet(fw);
    expect(changedCells(quiet, fw.world)).toBe(0);
    expect(LIQUID[fw.world.getId(8, SURFACE, 8)]).not.toBe(0);
  });
});
