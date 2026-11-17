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
import { makeTerrainChunk } from './terrain';

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

    expect(is.mean).toBeLessThan(40);
    expect(es.median).toBeLessThan(2);
  });
});
