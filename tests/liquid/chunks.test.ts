/**
 * Liquids across chunk loading: unloaded neighbours, save / load mid-flow (ACCEPTANCE 23),
 * rescheduling after load, and independence from chunk load order.
 */
import { describe, expect, it } from 'vitest';
import { AIR, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { World } from '../../src/voxel/world';
import { Fluids, WATER_TICK_DELAY, pumpTicks } from '../../src/liquid/fluids';
import {
  AROUND_ORIGIN,
  FLOOR_Y,
  STONE,
  SURFACE,
  chunkCoords,
  cloneWorld,
  countLiquid,
  diamond,
  lava,
  liquidCells,
  makeChunk,
  platform,
  pumpUntilQuiet,
  snapshotCells,
  water,
  type CellFn,
  type FluidWorld,
} from './helpers';

function diamondKeys(world: World): string[] {
  return liquidCells(world).map((c) => `${c.x},${c.y},${c.z}:${c.state}`);
}

/** One water source at (sx, SURFACE, sz) on the fully loaded 3 x 3 platform, settled. */
function settledDiamond(sx = 8, sz = 8): FluidWorld {
  const world = new World(1);
  for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) world.addChunk(makeChunk(cx, cz, platform));
  const fluids = new Fluids(world);
  fluids.attach();
  world.setCell(sx, SURFACE, sz, water());
  pumpUntilQuiet({ world, fluids });
  return { world, fluids };
}

/** The settled reference shape, as comparable keys. */
function referenceDiamond(sx = 8, sz = 8): string[] {
  return diamondKeys(settledDiamond(sx, sz).world);
}

/** Wrap world.setCell to count writes aimed at unloaded chunks. */
function countUnloadedWrites(world: World): { readonly count: number } {
  const probe = { count: 0 };
  const original = world.setCell.bind(world);
  world.setCell = (x, y, z, cell, flags) => {
    if (!world.isLoaded(x, z)) probe.count++;
    return original(x, y, z, cell, flags);
  };
  return probe;
}

describe('unloaded chunks', () => {
  it('liquid never writes into an unloaded chunk, waits at the border, and finishes correctly once it loads', () => {
    // Source 6 cells from the border with the (missing) chunk column cx = 1.
    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) if (cx !== 1) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    const fw: FluidWorld = { world, fluids };
    const probe = countUnloadedWrites(world);

    world.setCell(10, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    const stalled = countLiquid(world);
    expect(probe.count).toBe(0);
    expect(stalled).toBeGreaterThan(1);
    expect(stalled).toBeLessThan(113);
    expect(world.ticks.size).toBe(0);
    expect(fluids.deferredCount).toBeGreaterThan(0);
    // Nothing that exists is wrong: every wet cell is part of the final diamond.
    const shape = diamond(10, 8, 7);
    for (const c of liquidCells(world)) expect(shape.has(`${c.x},${c.z}`)).toBe(true);

    for (const cz of [-1, 0, 1]) {
      const chunk = makeChunk(1, cz, platform);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
    }
    pumpUntilQuiet(fw);
    expect(probe.count).toBe(0);
    expect(countLiquid(world)).toBe(113);
    expect(diamondKeys(world)).toEqual(referenceDiamond(10, 8));
    expect(fluids.deferredCount).toBe(0);
  });

  it('also works with the simulation protocol (reschedule the new chunk and its loaded neighbours)', () => {
    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) if (cx !== 1) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    const fw: FluidWorld = { world, fluids };
    world.setCell(10, SURFACE, 8, water());
    pumpTicks(world, fluids, 40);
    for (const cz of [1, -1, 0]) {
      const chunk = makeChunk(1, cz, platform);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = world.getChunk(1 + dx, cz + dz);
        if (n) fluids.rescheduleChunk(n);
      }
      pumpTicks(world, fluids, 3);
    }
    pumpUntilQuiet(fw);
    expect(diamondKeys(world)).toEqual(referenceDiamond(10, 8));
  });

  it('flowing liquid next to an unloaded chunk does not drain toward it', () => {
    // A settled diamond, then the chunk holding its east tip is unloaded and a neighbour of
    // a border cell changes: the border cell must not recompute from "solid" unknown space.
    const { world, fluids } = settledDiamond(12, 8);
    const before = diamondKeys(world);
    const east = world.removeChunk(1, 0)!;
    world.setCell(15, SURFACE + 1, 8, makeCell(B.STONE)); // wakes (15, SURFACE, 8), at the border
    world.setCell(15, SURFACE + 1, 8, AIR);
    pumpUntilQuiet({ world, fluids });
    expect(fluids.deferredCount).toBeGreaterThan(0);
    world.addChunk(east);
    fluids.rescheduleChunk(east);
    pumpUntilQuiet({ world, fluids });
    expect(diamondKeys(world)).toEqual(before);
    expect(fluids.deferredCount).toBe(0);
  });

  it('rescheduleChunk ignores a chunk that is not in the world', () => {
    const world = new World(1);
    const fluids = new Fluids(world);
    fluids.attach();
    const chunk = makeChunk(0, 0, (x, y, z) => (y === SURFACE && x === 3 && z === 3 ? water() : platform(x, y, z)));
    fluids.rescheduleChunk(chunk);
    expect(world.ticks.size).toBe(0);
  });
});

describe('save / load mid-flow (ACCEPTANCE 23)', () => {
  /** Place the source and run 8 ticks (0.4 s): the flow is caught mid-way. */
  function midFlow(): FluidWorld {
    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    world.setCell(8, SURFACE, 8, water());
    pumpTicks(world, fluids, 8);
    expect(countLiquid(world)).toBe(5);
    expect(world.ticks.size).toBeGreaterThan(0);
    return { world, fluids };
  }

  function restoreTicks(saved: FluidWorld, loaded: FluidWorld): void {
    for (const t of saved.world.ticks.all()) {
      loaded.world.scheduleTick(t.x, t.y, t.z, t.id, t.at - saved.world.time);
    }
  }

  it('restoring cells and pending ticks (remaining delays) continues to exactly 113', () => {
    const saved = midFlow();
    const loaded = cloneWorld(saved.world, 0);
    restoreTicks(saved, loaded);
    pumpUntilQuiet(loaded);
    expect(countLiquid(loaded.world)).toBe(113);
    expect(diamondKeys(loaded.world)).toEqual(referenceDiamond());
  });

  it('restoring ticks AND rescheduling every chunk (the recommended load path) gives the same result', () => {
    const saved = midFlow();
    const loaded = cloneWorld(saved.world, 0);
    restoreTicks(saved, loaded);
    for (const chunk of loaded.world.chunks.values()) loaded.fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(loaded);
    expect(diamondKeys(loaded.world)).toEqual(referenceDiamond());
  });

  it('a lava flow saved mid-way also resumes after load', () => {
    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    world.setCell(8, SURFACE, 8, lava());
    pumpTicks(world, fluids, 45); // ring 1 out, ring 2 pending
    const loaded = cloneWorld(world, 0);
    for (const chunk of loaded.world.chunks.values()) loaded.fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(loaded);
    expect(countLiquid(loaded.world, B.LAVA)).toBe(25);
  });

  it('restoring cells only and calling rescheduleChunk on every chunk also continues to 113', () => {
    const saved = midFlow();
    const loaded = cloneWorld(saved.world, 0);
    expect(loaded.world.ticks.size).toBe(0);
    for (const chunk of loaded.world.chunks.values()) loaded.fluids.rescheduleChunk(chunk);
    expect(loaded.world.ticks.size).toBeGreaterThan(0);
    pumpUntilQuiet(loaded);
    expect(countLiquid(loaded.world)).toBe(113);
    expect(diamondKeys(loaded.world)).toEqual(referenceDiamond());
  });

  it('a save of draining water resumes draining after load', () => {
    const { world, fluids } = settledDiamond();
    world.setCell(8, SURFACE, 8, AIR);
    pumpTicks(world, fluids, 2 * WATER_TICK_DELAY + 1);
    expect(countLiquid(world)).toBeGreaterThan(0);
    const loaded = cloneWorld(world, 0);
    for (const chunk of loaded.world.chunks.values()) loaded.fluids.rescheduleChunk(chunk);
    pumpUntilQuiet(loaded);
    expect(countLiquid(loaded.world)).toBe(0);
  });

  it('a settled world reschedules nothing on load', () => {
    const fw = settledDiamond();
    fw.world.setCell(-6, SURFACE, 20, lava());
    pumpUntilQuiet(fw);
    const loaded = cloneWorld(fw.world, 0);
    for (const chunk of loaded.world.chunks.values()) loaded.fluids.rescheduleChunk(chunk);
    expect(loaded.world.ticks.size).toBe(0);
  });
});

describe('resting ocean', () => {
  const ocean: CellFn = (_x, y) => (y < 3 ? STONE : y < 48 ? water() : AIR);

  it('rescheduleChunk schedules nothing for chunks full of resting sources, and is cheap', () => {
    const world = new World(1);
    const chunks = chunkCoords(AROUND_ORIGIN).map(([cx, cz]) => makeChunk(cx, cz, ocean));
    for (const c of chunks) world.addChunk(c);
    const fluids = new Fluids(world);
    fluids.attach();
    for (const c of chunks) fluids.rescheduleChunk(c);
    expect(world.ticks.size).toBe(0);
    const centre = world.getChunk(0, 0)!;
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      fluids.rescheduleChunk(centre);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[samples.length >> 1]!;
    console.info(`[liquid] rescheduleChunk, resting ocean chunk (+4 rims): median ${median.toFixed(3)} ms`);
    expect(median).toBeLessThan(10);
    expect(world.ticks.size).toBe(0);
  });

  it('an ocean next to a freshly dug hole is woken by rescheduleChunk', () => {
    const world = new World(1);
    const shore: CellFn = (x, y, z) => (x >= 16 && y >= 40 && y < 48 ? AIR : ocean(x, y, z));
    const chunks = chunkCoords(AROUND_ORIGIN).map(([cx, cz]) => makeChunk(cx, cz, shore));
    for (const c of chunks) world.addChunk(c);
    const fluids = new Fluids(world);
    fluids.attach();
    for (const c of chunks) fluids.rescheduleChunk(c);
    // Exactly the sources on the cliff face can go anywhere: x = 15, y 40..47, all 48 z rows.
    for (const t of world.ticks.all()) {
      expect(t.x).toBe(15);
      expect(t.y).toBeGreaterThanOrEqual(40);
    }
    expect(world.ticks.size).toBe(48 * 8);
  });
});

describe('determinism across chunk load orders', () => {
  /** Platform over a cave, a few holes (one on a chunk border), three water sources and a lava source. */
  const scene: CellFn = (x, y, z) => {
    if (y === 4) return STONE;
    if (y === FLOOR_Y) {
      if ((x === 7 && z === 4) || (x === 16 && z === 12) || (x === -3 && z === 15)) return AIR;
      return STONE;
    }
    if (y === SURFACE) {
      if ((x === 4 && z === 4) || (x === 15 && z === 15) || (x === -1 && z === 18)) return water();
      if (x === 17 && z === 0) return lava();
      if (x === 2 && z === 9) return makeCell(B.FLOWER_RED);
      if (x >= 10 && x <= 12 && z === 6) return STONE; // a little wall
    }
    return AIR;
  };
  const coords = chunkCoords(AROUND_ORIGIN);

  function run(order: Array<[number, number]>, between: number, protocol: 'self' | 'neighbours'): Map<number, Uint16Array> {
    const world = new World(1);
    const fluids = new Fluids(world);
    fluids.attach();
    for (const [cx, cz] of order) {
      const chunk = makeChunk(cx, cz, scene);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
      if (protocol === 'neighbours') {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = world.getChunk(cx + dx, cz + dz);
          if (n) fluids.rescheduleChunk(n);
        }
      }
      pumpTicks(world, fluids, between);
    }
    pumpUntilQuiet({ world, fluids }, 20_000);
    expect(countLiquid(world)).toBeGreaterThan(300);
    return snapshotCells(world);
  }

  function expectSame(a: Map<number, Uint16Array>, b: Map<number, Uint16Array>): void {
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, cells] of a) {
      const other = b.get(k)!;
      let diff = -1;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== other[i]) {
          diff = i;
          break;
        }
      }
      expect(diff, `chunk ${k} differs at index ${diff}`).toBe(-1);
    }
  }

  it('the final state does not depend on the order (or pace) in which chunks are added', () => {
    const reference = run(coords, 0, 'self');
    const reversed = [...coords].reverse();
    const shuffled = [...coords];
    const rng = new Rng(1234);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expectSame(reference, run(coords, 7, 'neighbours'));
    expectSame(reference, run(reversed, 13, 'self'));
    expectSame(reference, run(shuffled, 3, 'self'));
    expectSame(reference, run(shuffled, 40, 'neighbours'));
  });
});
