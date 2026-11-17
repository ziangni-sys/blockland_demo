/**
 * Liquids across chunk loading: unloaded neighbours, save / load mid-flow (ACCEPTANCE 23),
 * rescheduling after load, and independence from chunk load order.
 */
import { describe, expect, it } from 'vitest';
import { AIR, ID_MASK, cellState, liquidFalling, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { World } from '../../src/voxel/world';
import { Fluids, WATER_TICK_DELAY, pumpTicks } from '../../src/liquid/fluids';
import {
  AROUND_ORIGIN,
  FLOOR_Y,
  STONE,
  SURFACE,
  amountAt,
  buildWorld,
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

  it('a mid-air source on a border column (neighbour chunk unloaded) still falls down its own column', () => {
    // Chunks (0,0) and (1,0) loaded; the row cz = 1 (z >= 16) is not.
    const world = new World(1);
    for (const cx of [0, 1]) world.addChunk(makeChunk(cx, 0, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    const probe = countUnloadedWrites(world);
    world.setCell(16, 30, 15, water()); // z = 15: its +Z neighbour lies in the unloaded chunk (1, 1)
    pumpUntilQuiet({ world, fluids });
    // Falling is decided by the column alone, so the column fills with falling water although
    // spreading sideways at the bottom has to wait for the neighbour.
    for (let y = SURFACE; y < 30; y++) {
      const c = world.getCell(16, y, 15);
      expect(c & ID_MASK, `y = ${y}`).toBe(B.WATER);
      expect(liquidFalling(cellState(c)), `y = ${y}`).toBe(true);
    }
    expect(world.getCell(16, FLOOR_Y, 15)).toBe(STONE);
    expect(probe.count).toBe(0);
  });

  it('a waterfall at the edge of the loaded area falls, waits at the bottom, and ends as in the fully loaded world', () => {
    const reference = buildWorld();
    reference.world.setCell(8, 30, 15, water());
    pumpUntilQuiet(reference);

    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) if (cz !== 1) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    const probe = countUnloadedWrites(world);
    world.setCell(8, 30, 15, water());
    pumpUntilQuiet({ world, fluids });
    expect(amountAt(world, 8, SURFACE, 15)).toBe(8);
    expect(fluids.deferredCount).toBeGreaterThan(0);
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = makeChunk(cx, 1, platform);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
    }
    pumpUntilQuiet({ world, fluids });
    expect(probe.count).toBe(0);
    expect(diamondKeys(world)).toEqual(diamondKeys(reference.world));
    expect(fluids.deferredCount).toBe(0);
  });

  it('a slope search that meets unloaded cells still decides when a known hole at that distance covers them', () => {
    // Column cx = 1 (x >= 16) unloaded. Hole under (15, ., 9); source at (14, S, 8). The cell
    // (16, S, 8) is unloaded and as far away as the hole, but reachable only through (15, S, 8),
    // which leads to the hole anyway: the answer {east, south} cannot change.
    const scene: CellFn = (x, y, z) =>
      y === 4 ? STONE : y === FLOOR_Y ? (x === 15 && z === 9 ? AIR : STONE) : AIR;
    const partial = buildWorld(scene, { minCx: -1, maxCx: 0, minCz: -1, maxCz: 1 });
    const full = buildWorld(scene);
    for (const fw of [partial, full]) {
      fw.world.setCell(14, SURFACE, 8, water());
      pumpTicks(fw.world, fw.fluids, WATER_TICK_DELAY);
    }
    expect(partial.fluids.deferredCount).toBe(0);
    expect(liquidCells(partial.world).map((c) => `${c.x},${c.z}`)).toEqual(['14,8', '15,8', '14,9']);
    expect(diamondKeys(partial.world)).toEqual(diamondKeys(full.world));
  });

  it('lava with water directly above hardens although a horizontal neighbour chunk is missing', () => {
    const world = new World(1);
    world.addChunk(makeChunk(0, 0, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    world.setCell(8, SURFACE, 15, lava());
    world.setCell(8, SURFACE + 1, 15, water());
    pumpTicks(world, fluids, 1);
    expect(world.getCell(8, SURFACE, 15)).toBe(makeCell(B.OBSIDIAN));
  });

  it('lava on a border column waits (rubble or lava would depend on the missing chunk), then resumes exactly', () => {
    const reference = buildWorld();
    reference.world.setCell(8, SURFACE + 3, 15, lava());
    pumpUntilQuiet(reference);

    const world = new World(1);
    for (const [cx, cz] of chunkCoords(AROUND_ORIGIN)) if (cz !== 1) world.addChunk(makeChunk(cx, cz, platform));
    const fluids = new Fluids(world);
    fluids.attach();
    world.setCell(8, SURFACE + 3, 15, lava());
    pumpUntilQuiet({ world, fluids });
    expect(countLiquid(world)).toBe(1); // an unloaded neighbour might hold water: not even falling
    expect(fluids.deferredCount).toBe(1);
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = makeChunk(cx, 1, platform);
      world.addChunk(chunk);
      fluids.rescheduleChunk(chunk);
    }
    pumpUntilQuiet({ world, fluids });
    expect(diamondKeys(world)).toEqual(diamondKeys(reference.world));
  });

  it('a single-chunk world: water out of slope reach of unloaded space settles, the rest waits (documented limit)', () => {
    const fw = buildWorld(platform, { minCx: 0, maxCx: 0, minCz: 0, maxCz: 0 });
    fw.world.setCell(8, SURFACE, 8, water());
    pumpUntilQuiet(fw);
    // On open ground any unloaded cell within reach could be a nearer hole, so every cell
    // within 5 columns of the chunk border that would spread waits for its neighbours.
    expect(countLiquid(fw.world)).toBe(60);
    expect(fw.fluids.deferredCount).toBeGreaterThan(0);
    for (const c of liquidCells(fw.world)) expect(diamond(8, 8, 7).has(`${c.x},${c.z}`)).toBe(true);
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
  /**
   * Water and lava meeting across chunk borders: water sources in chunk (0,0) and lava sources
   * in (1,0), (0,1) and (1,1) whose flows touch (lava flowing next to a water pit, a lava source
   * reached by water while still a source).
   */
  const contactScene: CellFn = (x, y, z) => {
    if (y === 4) return STONE;
    if (y === FLOOR_Y) {
      if (x === 20 && z === 20) return water(); // a water pit (stone under the floor below)
      return (x === 7 && z === 4) || (x === 16 && z === 12) ? AIR : STONE;
    }
    if (y === FLOOR_Y - 1 && x === 20 && z === 20) return STONE;
    if (y === SURFACE) {
      if ((x === 12 && z === 8) || (x === 15 && z === 2)) return water();
      if ((x === 18 && z === 8) || (x === 12 && z === 18)) return lava();
      if ((x === 22 && z === 20) || (x === 17 && z === 2)) return lava(); // (17, 2): reached by water as a source
    }
    return AIR;
  };
  const coords = chunkCoords(AROUND_ORIGIN);

  function run(
    order: Array<[number, number]>,
    between: number,
    protocol: 'self' | 'neighbours',
    fn: CellFn = scene,
    minLiquid = 300,
  ): Map<number, Uint16Array> {
    const world = new World(1);
    const fluids = new Fluids(world);
    fluids.attach();
    for (const [cx, cz] of order) {
      const chunk = makeChunk(cx, cz, fn);
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
    expect(countLiquid(world)).toBeGreaterThan(minLiquid);
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

  function shuffledCoords(seed: number): Array<[number, number]> {
    const shuffled = [...coords];
    const rng = new Rng(seed);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    return shuffled;
  }

  it('without liquid contact, the final state depends neither on chunk order nor on load pace', () => {
    // (The lava in this scene never meets the water.)
    const reference = run(coords, 0, 'self');
    const reversed = [...coords].reverse();
    const shuffled = shuffledCoords(1234);
    expectSame(reference, run(coords, 7, 'neighbours'));
    expectSame(reference, run(reversed, 13, 'self'));
    expectSame(reference, run(shuffled, 3, 'self'));
    expectSame(reference, run(shuffled, 40, 'neighbours'));
  });

  it('with lava meeting water, the final state does not depend on chunk order (all chunks added before ticking)', () => {
    // Pace is a different matter once lava and water meet: which side's chunk arrives first
    // decides where they meet, so only the order is pinned here.
    const reference = run(coords, 0, 'self', contactScene, 100);
    expect(snapshotHas(reference, B.OBSIDIAN)).toBe(true);
    expect(snapshotHas(reference, B.COBBLE)).toBe(true);
    expectSame(reference, run([...coords].reverse(), 0, 'neighbours', contactScene, 100));
    expectSame(reference, run(shuffledCoords(99), 0, 'self', contactScene, 100));
    expectSame(reference, run(shuffledCoords(7), 0, 'neighbours', contactScene, 100));
  });

  function snapshotHas(snap: Map<number, Uint16Array>, id: number): boolean {
    for (const cells of snap.values()) for (let i = 0; i < cells.length; i++) if ((cells[i]! & ID_MASK) === id) return true;
    return false;
  }
});
