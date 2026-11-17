/**
 * Adversarial review (correctness lens). Each test reproduces a verified defect; they are
 * expected to FAIL until the generator is fixed. Coordinates were found by sweeping random
 * chunks; each test only generates the few chunks it needs.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, SEA_LEVEL } from '../../src/core/constants';
import { AXIS_Y } from '../../src/core/dirs';
import { cellId, cellState, stateAxis } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { TerrainGenerator } from '../../src/worldgen/generator';

const LOGS = new Set<number>([B.LOG_OAK, B.LOG_PINE]);

function chunkOf(x: number, z: number): { cx: number; cz: number; lx: number; lz: number } {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  return { cx, cz, lx: x - cx * CHUNK_SIZE, lz: z - cz * CHUNK_SIZE };
}

describe('review: ore blobs respect the specified y ranges', () => {
  // Brief: "coal common y 10-90, iron y 5-60, copper y 20-70". Blob CENTRES are drawn in
  // those ranges, but a blob reaches up to 3 cells further, so ore cells leak outside
  // (iron down to y = 2..4, just above deeprock).
  const RANGE = new Map<number, [number, number]>([
    [B.COAL_ORE, [10, 90]],
    [B.IRON_ORE, [5, 60]],
    [B.COPPER_ORE, [20, 70]],
  ]);
  for (const [x, z, what] of [
    [150, -943, 'iron at y=4'],
    [-1793, 128, 'coal at y=9'],
    [1864, -2940, 'copper at y=19'],
  ] as const) {
    it(`seed 1, chunk of (${x}, ${z}): ${what}`, () => {
      const gen = new TerrainGenerator(1);
      const { cx, cz } = chunkOf(x, z);
      const cells = gen.generate(cx, cz);
      const bad: string[] = [];
      for (let i = 0; i < cells.length; i++) {
        const r = RANGE.get(cellId(cells[i]!));
        if (!r) continue;
        const y = i >> 8;
        if (y < r[0] || y > r[1]) bad.push(`${cellId(cells[i]!)}@(${cx * 16 + (i & 15)},${y},${cz * 16 + ((i >> 4) & 15)})`);
      }
      expect(bad, 'ore cells outside their y range').toEqual([]);
    });
  }
});

describe('review: lava pockets are contained', () => {
  // The lava flag is a per-column 2D field, so where it switches off, carved cells of the
  // non-lava column are air right beside lava sources of the lava column: the lava spills
  // sideways on its first update instead of staying a pocket (about 2 such cells per chunk).
  it('no lava source has cave air beside it (seed 1, chunk of (137, -3101))', () => {
    const gen = new TerrainGenerator(1);
    const { cx, cz } = chunkOf(137, -3101);
    const c = gen.generate(cx, cz);
    const bad: string[] = [];
    for (let i = 0; i < c.length; i++) {
      if (cellId(c[i]!) !== B.LAVA) continue;
      const lx = i & 15;
      const lz = (i >> 4) & 15;
      const y = i >> 8;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = lx + dx;
        const nz = lz + dz;
        if (nx < 0 || nz < 0 || nx > 15 || nz > 15) continue;
        if (c[nx | (nz << 4) | (y << 8)] === B.AIR) bad.push(`(${cx * 16 + lx},${y},${cz * 16 + lz})`);
      }
    }
    expect(bad, 'lava sources next to air').toEqual([]);
  });
});

describe('review: tree trunks are not cut by a neighbouring tree', () => {
  // Trunks may stand 2 cells apart; a large broadleaf's side branch reaches 2 cells along
  // an axis, and logs are stamped in list order with "only into air or leaves", so the
  // first tree's horizontal branch log can take a cell of the second tree's trunk.
  it('every trunk run is vertical logs of one species (seed 6, trunk at x=73 z=130)', () => {
    const gen = new TerrainGenerator(6);
    const { cx, cz, lx, lz } = chunkOf(73, 130);
    const c = gen.generate(cx, cz);
    const ground = gen.heightAt(73, 130);
    const base = c[lx | (lz << 4) | ((ground + 1) << 8)]!;
    expect(LOGS.has(cellId(base)), 'a trunk stands here').toBe(true);
    const bad: string[] = [];
    for (let y = ground + 1; ; y++) {
      const cell = c[lx | (lz << 4) | (y << 8)]!;
      if (!LOGS.has(cellId(cell))) break;
      if (cellId(cell) !== cellId(base) || stateAxis(cellState(cell)) !== AXIS_Y) {
        bad.push(`y=${y}: id ${cellId(cell)} axis ${stateAxis(cellState(cell))}`);
      }
    }
    expect(bad, 'foreign cells inside the trunk').toEqual([]);
  });
});

describe('review: sea fraction of a 32x32-chunk window', () => {
  // Brief: sea fraction between 35% and 65% over a 32x32-chunk sample. The shipped test only
  // samples windows at the origin; about 2% of random windows fall outside (30.5%..70% seen
  // over 400 windows). This chunk-aligned window is ~70% sea.
  it('seed 2348084964, chunks (12354..12385, -4072..-4041)', () => {
    const gen = new TerrainGenerator(2348084964);
    const x0 = 12354 * CHUNK_SIZE;
    const z0 = -4072 * CHUNK_SIZE;
    let sea = 0;
    let n = 0;
    for (let z = z0; z < z0 + 512; z += 4) {
      for (let x = x0; x < x0 + 512; x += 4) {
        if (gen.heightAt(x, z) < SEA_LEVEL - 1) sea++;
        n++;
      }
    }
    expect(sea / n).toBeLessThanOrEqual(0.65);
  });
});

describe('review: heightAt is the top solid terrain cell', () => {
  // Contract: heightAt(x, z) = y of the top solid terrain cell, before trees. Where a cave
  // breaks the surface (~0.2% of land columns) it reports the pre-cave height, i.e. a cell
  // that is air in the generated chunk.
  it('seed 1, column (3559, -1984)', () => {
    const gen = new TerrainGenerator(1);
    const { cx, cz, lx, lz } = chunkOf(3559, -1984);
    const c = gen.generate(cx, cz);
    const h = gen.heightAt(3559, -1984);
    expect(SOLID[cellId(c[lx | (lz << 4) | (h << 8)]!)], `cell at heightAt (${h})`).toBe(1);
  });
});
