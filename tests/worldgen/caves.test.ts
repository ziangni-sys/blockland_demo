import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { cellId } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { LAVA_MAX_Y, MIN_CAVE_Y } from '../../src/worldgen/caves';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { createColumnSample } from '../../src/worldgen/terrain';
import { ChunkArea } from './helpers';

/** Blocks that sit on top of the terrain or fill caves (not part of heightAt). */
const NOT_TERRAIN = new Set<number>([
  B.AIR,
  B.WATER,
  B.LAVA,
  B.LEAVES_OAK,
  B.LEAVES_PINE,
  B.LOG_OAK,
  B.LOG_PINE,
  B.TALL_GRASS,
  B.FLOWER_RED,
  B.FLOWER_YELLOW,
  B.CACTUS,
  B.SNOW_LAYER,
]);

describe('caves', () => {
  it('heightAt is the top solid terrain cell of the generated chunk, cave mouths included', () => {
    let columns = 0;
    let mouths = 0;
    const s = createColumnSample();
    for (const seed of [42, 123]) {
      const gen = new TerrainGenerator(seed);
      const sp = gen.spawnPoint();
      const area = new ChunkArea(gen, Math.floor(sp.x / CHUNK_SIZE) - 2, Math.floor(sp.z / CHUNK_SIZE) - 2, 4);
      for (let z = area.z0; z < area.z0 + area.size; z++) {
        for (let x = area.x0; x < area.x0 + area.size; x++) {
          let top = WORLD_HEIGHT - 1;
          while (top > 0 && NOT_TERRAIN.has(cellId(area.get(x, top, z)))) top--;
          const h = gen.heightAt(x, z);
          if (h !== top) throw new Error(`seed ${seed}: heightAt(${x}, ${z}) = ${h}, generated top ${top}`);
          expect(SOLID[cellId(area.get(x, h, z))]).toBe(1);
          // Fractional coordinates address the same column.
          expect(gen.heightAt(x + 0.75, z + 0.25)).toBe(h);
          columns++;
          if (h !== gen.sampler.sample(x, z, s).height) mouths++;
        }
      }
    }
    // Not vacuous: the sample holds cave mouths (where the 2D model and the chunk differ).
    expect(mouths).toBeGreaterThan(20);
    expect(columns).toBe(2 * 64 * 64);
  });

  it('generated lava is at rest and caves stay above MIN_CAVE_Y (sweep)', () => {
    // Lava zones are a per-column 2D field; where a cave crosses a zone border the
    // neighbouring column keeps a stone rim at y <= LAVA_MAX_Y. Before the rim, ~17 % of
    // chunks had lava sources standing next to cave air (they spill on the first update).
    const rng = new Rng(99);
    let lava = 0;
    let lavaChunks = 0;
    let chunks = 0;
    for (const seed of [1, 9, 123, 2024]) {
      const gen = new TerrainGenerator(seed);
      for (let k = 0; k < 25; k++) {
        const cx = rng.int(-400, 400);
        const cz = rng.int(-400, 400);
        const area = new ChunkArea(gen, cx - 1, cz - 1, 3);
        chunks++;
        let here = 0;
        const x0 = cx * CHUNK_SIZE;
        const z0 = cz * CHUNK_SIZE;
        for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
          for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
            for (let y = 1; y < MIN_CAVE_Y; y++) expect(SOLID[cellId(area.get(x, y, z))]).toBe(1);
            for (let y = MIN_CAVE_Y; y <= LAVA_MAX_Y + 1; y++) {
              if (cellId(area.get(x, y, z)) !== B.LAVA) continue;
              if (y > LAVA_MAX_Y) throw new Error(`lava above ${LAVA_MAX_Y} at ${x},${y},${z}`);
              here++;
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const n = cellId(area.get(x + dx, y, z + dz));
                if (n !== B.LAVA && SOLID[n] !== 1) throw new Error(`seed ${seed}: lava beside block ${n} at ${x},${y},${z}`);
              }
              const below = cellId(area.get(x, y - 1, z));
              if (below !== B.LAVA && SOLID[below] !== 1) throw new Error(`floating lava at ${x},${y},${z}`);
            }
          }
        }
        lava += here;
        if (here > 0) lavaChunks++;
      }
    }
    expect(chunks).toBe(100);
    expect(lavaChunks).toBeGreaterThan(30);
    expect(lava).toBeGreaterThan(2000);
  });

  it('keeps water and caves apart, and opens a few caves on dry land', () => {
    const gen = new TerrainGenerator(42);
    const sp = gen.spawnPoint();
    const area = new ChunkArea(gen, Math.floor(sp.x / CHUNK_SIZE) - 2, Math.floor(sp.z / CHUNK_SIZE) - 2, 4);
    let openToSky = 0;
    for (let z = area.z0 + 1; z < area.z0 + area.size - 1; z++) {
      for (let x = area.x0 + 1; x < area.x0 + area.size - 1; x++) {
        const h = gen.heightAt(x, z);
        if (h < gen.sampler.sample(x, z, createColumnSample()).height) openToSky++;
        for (let y = 1; y < SEA_LEVEL; y++) {
          if (cellId(area.get(x, y, z)) !== B.WATER) continue;
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]] as const) {
            const n = cellId(area.get(x + dx, y + dy, z + dz));
            if (n === B.AIR || n === B.LAVA) throw new Error(`water opens into a cave at ${x},${y},${z}`);
          }
        }
      }
    }
    expect(openToSky).toBeGreaterThan(0);
  });
});
