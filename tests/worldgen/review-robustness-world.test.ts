/**
 * Review (robustness lens): world-level requirements checked on inputs the original tests
 * did not cover (other seeds, other places).
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, SEA_LEVEL } from '../../src/core/constants';
import { AXIS_Y } from '../../src/core/dirs';
import { cellId, cellState, stateAxis } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { ChunkArea } from './helpers';

const LOGS = new Set<number>([B.LOG_OAK, B.LOG_PINE]);

describe('review: world requirements on more seeds', () => {
  it('sea fraction stays within 35-65 % over the 32x32-chunk origin sample (more seeds)', () => {
    // Same sample as the brief / generator.test.ts. Over 120 seeds, 3 origin windows fall
    // outside the band (66.4 %, 65.5 %, 65.3 %), and 3 of 120 far windows fall below it
    // (31.4 %, 34.1 %, 34.7 %).
    for (const seed of [1371845937, 231959527, 3164790981]) {
      const gen = new TerrainGenerator(seed);
      let sea = 0;
      let n = 0;
      for (let z = -256; z < 256; z += 2) {
        for (let x = -256; x < 256; x += 2) {
          if (gen.heightAt(x, z) < SEA_LEVEL - 1) sea++;
          n++;
        }
      }
      const f = sea / n;
      expect(f, `sea fraction of seed ${seed}`).toBeGreaterThanOrEqual(0.35);
      expect(f, `sea fraction of seed ${seed}`).toBeLessThanOrEqual(0.65);
    }
  });

  it('generated lava is at rest: no lava source next to cave air (seed 123)', () => {
    // The lava zone is a 2D flag per column (simplex2 > 0.05). Where a cave crosses the
    // zone border, carved cells at y <= 10 are lava on one side and AIR on the other, so a
    // vertical wall of lava sources stands next to open air. It flows as soon as the chunk
    // is loaded and the fluid engine ticks it; the first World.setCell marks the pristine
    // chunk `modified`, so it is saved / stashed instead of re-generated. Measured: 16.8 %
    // of all chunks (40 % of the chunks that contain lava) around 4 spawns.
    const gen = new TerrainGenerator(123);
    const area = new ChunkArea(gen, -3, -6, 4); // contains e.g. (-28, 8, -75) and (-9, 7, -77)
    const bad: string[] = [];
    for (let z = area.z0 + 1; z < area.z0 + area.size - 1; z++) {
      for (let x = area.x0 + 1; x < area.x0 + area.size - 1; x++) {
        for (let y = 1; y <= 10; y++) {
          if (cellId(area.get(x, y, z)) !== B.LAVA) continue;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            if (area.get(x + dx, y, z + dz) === B.AIR) bad.push(`${x},${y},${z}`);
          }
        }
      }
    }
    expect(bad.slice(0, 8)).toEqual([]);
  });

  it("a branch never replaces a cell inside another tree's trunk (seed 9)", () => {
    // Tree (113, 57, 3)'s +x branch lands in tree (115, *, 3)'s trunk column at y = 62:
    // stampLogs of the first tree in list order places an X-axis log there, and the second
    // trunk's putLog then refuses to overwrite it, so the trunk shows a sideways log.
    const gen = new TerrainGenerator(9);
    const area = new ChunkArea(gen, Math.floor(115 / CHUNK_SIZE) - 1, Math.floor(3 / CHUNK_SIZE) - 1, 3);
    const bad: string[] = [];
    for (let z = area.z0 + 1; z < area.z0 + area.size - 1; z++) {
      for (let x = area.x0 + 1; x < area.x0 + area.size - 1; x++) {
        for (let y = SEA_LEVEL; y < 126; y++) {
          const c = area.get(x, y, z);
          if (!LOGS.has(cellId(c)) || stateAxis(cellState(c)) === AXIS_Y) continue;
          const up = area.get(x, y + 1, z);
          const down = area.get(x, y - 1, z);
          const vertical = (v: number): boolean => LOGS.has(cellId(v)) && stateAxis(cellState(v)) === AXIS_Y;
          if (vertical(up) && vertical(down)) bad.push(`${x},${y},${z}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
