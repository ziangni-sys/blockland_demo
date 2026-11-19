/**
 * Light engine performance. Prints measured numbers; the assertions are deliberately loose
 * (roughly 10x the targets: initChunk < 4 ms average, a single edit typically < 0.2 ms) so
 * they only catch gross regressions and never flake on a loaded machine.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { LightEngine } from '../../src/light/engine';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';
import { randomPartial, writeLayers } from './shape-helpers';
import { makeFlatChunk, makeTerrainChunk } from './terrain';

/** Chunk coordinates in rings around the origin, the order a streaming client loads them. */
function spiral(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let r = 0; r <= radius; r++) {
    for (let cx = -r; cx <= r; cx++) {
      for (let cz = -r; cz <= r; cz++) if (Math.max(Math.abs(cx), Math.abs(cz)) === r) out.push([cx, cz]);
    }
  }
  return out;
}

function stats(samples: number[]): { mean: number; median: number; p95: number; max: number } {
  const s = samples.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, median: s[s.length >> 1]!, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]! };
}

const fmt = (ms: number) => `${ms.toFixed(3)} ms`;

describe('light engine performance', () => {
  it('initChunk on streamed natural terrain and single-block edits', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    const coords = spiral(5); // 11 x 11 = 121 chunks
    const chunks = new Map<string, Chunk>();
    for (const [cx, cz] of coords) chunks.set(`${cx},${cz}`, makeTerrainChunk(cx, cz, 1));

    const initTimes: number[] = [];
    for (const [cx, cz] of coords) {
      const c = chunks.get(`${cx},${cz}`)!;
      world.addChunk(c);
      const t0 = performance.now();
      engine.initChunk(c);
      initTimes.push(performance.now() - t0);
    }
    world.takeDirtySections();
    const warm = initTimes.slice(9); // after the first 3x3 (JIT warm-up)
    const is = stats(warm);
    console.log(
      `[light perf] initChunk x${warm.length} (after warm-up): mean ${fmt(is.mean)}, median ${fmt(is.median)}, p95 ${fmt(is.p95)}, max ${fmt(is.max)}; first chunk ${fmt(initTimes[0]!)}`,
    );

    // Single edits within the inner 7x7 chunks: what a player does, weighted toward the surface.
    const rng = new Rng(42);
    const kinds = [makeCell(B.STONE), 0, makeCell(B.PLANKS_OAK), makeCell(B.TORCH), makeCell(B.LAMP), makeCell(B.WATER), makeCell(B.LEAVES_OAK), makeCell(B.GLASS)];
    const editTimes: number[] = [];
    for (let k = 0; k < 3000; k++) {
      const x = rng.int(-48, 63);
      const z = rng.int(-48, 63);
      const c = world.chunkAt(x, z)!;
      const h = c.heightmap[(x & 15) | ((z & 15) << 4)]!;
      const r = rng.next();
      // Dig the top block, build on it, or place / mine a little higher or lower.
      const y = r < 0.35 ? h - 1 : r < 0.7 ? h : r < 0.85 ? h + rng.int(1, 4) : Math.max(1, h - rng.int(2, 6));
      const cell = r < 0.35 ? 0 : kinds[rng.int(0, kinds.length - 1)]!;
      const t0 = performance.now();
      world.setCell(x, y, z, cell);
      engine.update();
      editTimes.push(performance.now() - t0);
    }
    const es = stats(editTimes.slice(200));
    console.log(
      `[light perf] single edit (setCell + update) x${editTimes.length - 200}: mean ${fmt(es.mean)}, median ${fmt(es.median)}, p95 ${fmt(es.p95)}, max ${fmt(es.max)}`,
    );

    // A heavy edit: punch through the roof of a large sealed cavern (sky floods in).
    const cave = new World(2);
    const caveEngine = new LightEngine(cave);
    caveEngine.attach();
    const stone = makeCell(B.STONE);
    for (let cx = 40; cx < 43; cx++) {
      for (let cz = 40; cz < 43; cz++) {
        const ch = new Chunk(cx, cz);
        for (let i = 0; i < ch.cells.length; i++) ch.cells[i] = i >> 8 <= 70 ? stone : 0; // solid up to y = 70
        cave.addChunk(ch);
        caveEngine.initChunk(ch);
      }
    }
    for (let x = 644; x < 684; x++) for (let z = 644; z < 684; z++) for (let y = 40; y < 48; y++) cave.setCell(x, y, z, 0);
    caveEngine.update();
    const holeTimes: number[] = [];
    for (let k = 0; k < 5; k++) {
      const hx = 660 + k * 3;
      const t1 = performance.now();
      for (let y = 48; y <= 70; y++) cave.setCell(hx, y, 664, 0); // a shaft from the surface
      caveEngine.update();
      holeTimes.push(performance.now() - t1);
      const t2 = performance.now();
      cave.setCell(hx, 70, 664, makeCell(B.STONE)); // and plug it again
      caveEngine.update();
      holeTimes.push(performance.now() - t2);
    }
    console.log(`[light perf] open/close a shaft into a 40x40x8 cavern: ${holeTimes.map(fmt).join(', ')}`);

    // update() with nothing queued still checks the lit-chunk registry for unloaded chunks.
    const idle: number[] = [];
    for (let k = 0; k < 200; k++) {
      const t0 = performance.now();
      engine.update();
      idle.push(performance.now() - t0);
    }
    const ids = stats(idle.slice(20));
    console.log(`[light perf] idle update() with ${world.chunks.size} lit chunks: median ${fmt(ids.median)}, max ${fmt(ids.max)}`);

    // Unloading: the next update() relights the departed chunks' neighbours without them.
    const unloadTimes: number[] = [];
    for (const cx of [-5, 5]) {
      for (let cz = -5; cz <= 5; cz += 2) world.removeChunk(cx, cz);
      const t0 = performance.now();
      engine.update();
      unloadTimes.push(performance.now() - t0);
    }
    console.log(`[light perf] update() after unloading 6 edge chunks: ${unloadTimes.map(fmt).join(', ')}`);

    expect(is.mean).toBeLessThan(40);
    expect(es.median).toBeLessThan(2);
    expect(ids.median).toBeLessThan(1);
  });

  it('building and opening a high roof (deep lossless sky columns)', () => {
    // The worst common case for sky light: every roof block at y = 120 shades a 115-cell column.
    const world = new World(3);
    const engine = new LightEngine(world);
    engine.attach();
    for (let cz = -1; cz <= 2; cz++) {
      for (let cx = -1; cx <= 2; cx++) {
        const c = makeFlatChunk(cx, cz, 4);
        world.addChunk(c);
        engine.initChunk(c);
      }
    }
    const stone = makeCell(B.STONE);
    const build: number[] = [];
    for (let x = 4; x < 28; x++) {
      for (let z = 4; z < 28; z++) {
        const t0 = performance.now();
        world.setCell(x, 120, z, stone);
        engine.update();
        build.push(performance.now() - t0);
      }
    }
    const bs = stats(build.slice(50));
    const holes: number[] = [];
    for (let k = 0; k < 4; k++) {
      let t0 = performance.now();
      world.setCell(16, 120, 16, 0);
      engine.update();
      holes.push(performance.now() - t0);
      t0 = performance.now();
      world.setCell(16, 120, 16, stone);
      engine.update();
      holes.push(performance.now() - t0);
    }
    console.log(
      `[light perf] roof block at y=120 over ground at y=4 x${build.length - 50}: ` +
        `median ${fmt(bs.median)}, p95 ${fmt(bs.p95)}, max ${fmt(bs.max)}`,
    );
    console.log(`[light perf] open/close a skylight in the 24x24 roof: ${holes.map(fmt).join(', ')}`);
    expect(bs.median).toBeLessThan(2);
  });

  it('partial cells (docs/SHAPES.md section 15): a gap in a half-slab roof, initChunk with 10% partial cells', () => {
    // A 24 x 24 roof of alternating lower and upper stone slabs over flat ground at y = 4; one
    // slab after another is taken out and put back. Asserted: a hall roof at y = 30. Printed for
    // comparison: the same at y = 120 (every gap relights a 115-deep shaft and the room under it,
    // like the skylight above), next to a roof of full stone blocks in the same place, which
    // runs the M1 code.
    const gapTimes = (roofY: number, roofCell: (x: number, z: number) => number): { open: number[]; close: number[] } => {
      const world = new World(3);
      const engine = new LightEngine(world);
      engine.attach();
      for (let cz = -1; cz <= 2; cz++) {
        for (let cx = -1; cx <= 2; cx++) {
          const c = makeFlatChunk(cx, cz, 4);
          world.addChunk(c);
          engine.initChunk(c);
        }
      }
      for (let x = 4; x < 28; x++) for (let z = 4; z < 28; z++) world.setCell(x, roofY, z, roofCell(x, z));
      engine.update();
      const open: number[] = [];
      const close: number[] = [];
      for (let k = 0; k < 50; k++) {
        const x = 10 + (k % 8);
        const z = 10 + ((k >> 3) % 8);
        let t0 = performance.now();
        world.setCell(x, roofY, z, 0);
        engine.update();
        open.push(performance.now() - t0);
        t0 = performance.now();
        world.setCell(x, roofY, z, roofCell(x, z));
        engine.update();
        close.push(performance.now() - t0);
      }
      return { open: open.slice(10), close: close.slice(10) };
    };
    const halfSlab = (x: number, z: number) => slab(B.STONE, (x + z) & 1 ? LOWER : UPPER);
    const hall = gapTimes(30, halfSlab);
    const gs = stats([...hall.open, ...hall.close]);
    console.log(`[light perf] open/close a gap in a half-slab roof at y=30 x${hall.open.length * 2}: median ${fmt(gs.median)}, p95 ${fmt(gs.p95)}, max ${fmt(gs.max)}`);
    const high = gapTimes(120, halfSlab);
    const full = gapTimes(120, () => makeCell(B.STONE));
    console.log(
      `[light perf] gap at y=120: half-slab roof open median ${fmt(stats(high.open).median)}, close median ${fmt(stats(high.close).median)}; ` +
        `full stone roof (M1 path) open median ${fmt(stats(full.open).median)}, close median ${fmt(stats(full.close).median)}`,
    );

    // Terrain chunks in which 10% of all cells are partial cells, streamed in like the chunks above.
    const shaped = new World(1);
    const shapedEngine = new LightEngine(shaped);
    shapedEngine.attach();
    const rng = new Rng(7);
    const initTimes: number[] = [];
    for (const [cx, cz] of spiral(3)) {
      const plain = makeTerrainChunk(cx, cz, 1);
      const holes = new Uint8Array(plain.cells.length);
      const part2 = new Uint32Array(plain.cells.length);
      for (let i = 0; i < plain.cells.length; i++) if (rng.chance(0.1)) writeLayers(plain.cells, holes, part2, i, randomPartial(rng));
      const c = new Chunk(cx, cz, plain.cells, undefined, holes, part2);
      shaped.addChunk(c);
      const t0 = performance.now();
      shapedEngine.initChunk(c);
      initTimes.push(performance.now() - t0);
    }
    const ps = stats(initTimes.slice(9));
    console.log(`[light perf] initChunk with 10% partial cells x${initTimes.length - 9}: mean ${fmt(ps.mean)}, median ${fmt(ps.median)}, max ${fmt(ps.max)}`);
    expect(gs.median).toBeLessThan(2);
    expect(ps.mean).toBeLessThan(40);
  });
});
