/**
 * Deterministic test terrain for the light engine (tests must not depend on src/worldgen).
 *
 * Every cell is a pure function of its world coordinates and the seed, so a world built from
 * these chunks is identical whatever order the chunks are added in. Features chosen to stress
 * lighting: rolling stone hills with dirt/turf, a sea with sand and some ice, trees whose
 * canopies cross chunk borders, floating stone slabs (overhangs), glass, caves that sometimes
 * breach the surface, lava pockets deep in caves, and the odd torch / lamp.
 */
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { rand2, rand3 } from '../../src/core/rng';
import { cellIndex, Chunk } from '../../src/voxel/chunk';

export const TEST_SEA = 44;

export function terrainHeight(x: number, z: number, seed: number): number {
  const h =
    46 +
    11 * Math.sin(x * 0.13 + seed) * Math.cos(z * 0.11 - seed * 0.5) +
    5 * Math.sin((x - z) * 0.07 + seed * 0.3) +
    3 * (rand2(x, z, seed) - 0.5);
  return Math.max(8, Math.min(100, Math.floor(h)));
}

function isTree(x: number, z: number, seed: number): boolean {
  return rand2(x, z, seed + 7) < 0.025 && terrainHeight(x, z, seed) >= TEST_SEA + 1;
}

function isCave(x: number, y: number, z: number, seed: number): boolean {
  const v =
    Math.sin(x * 0.21 + y * 0.05 + seed) * Math.sin(z * 0.19 - y * 0.07) * Math.cos(y * 0.23 + x * 0.03 - seed);
  return v > 0.22;
}

export function makeTerrainChunk(cx: number, cz: number, seed = 1): Chunk {
  const chunk = new Chunk(cx, cz);
  const cells = chunk.cells;
  const STONE = makeCell(B.STONE);
  const DIRT = makeCell(B.DIRT);
  const TURF = makeCell(B.TURF);
  const SAND = makeCell(B.SAND);
  const WATER = makeCell(B.WATER);
  const ICE = makeCell(B.ICE);
  const LAVA = makeCell(B.LAVA);
  const LOG = makeCell(B.LOG_OAK, 1);
  const LEAVES = makeCell(B.LEAVES_OAK);
  const GLASS = makeCell(B.GLASS);
  const TORCH = makeCell(B.TORCH);
  const LAMP = makeCell(B.LAMP);

  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = cx * 16 + lx;
      const z = cz * 16 + lz;
      const h = terrainHeight(x, z, seed);
      const beach = h < TEST_SEA + 2;
      // Caves breach the surface only in some regions.
      const caveTop = rand2(x >> 3, z >> 3, seed + 11) < 0.3 ? h + 1 : h - 3;
      for (let y = 0; y <= h; y++) {
        let cell = y === h ? (beach ? SAND : TURF) : y >= h - 3 ? (beach ? SAND : DIRT) : STONE;
        if (y >= 3 && y < caveTop && isCave(x, y, z, seed)) cell = y < 9 ? LAVA : 0;
        cells[cellIndex(lx, y, lz)] = cell;
      }
      for (let y = h + 1; y < TEST_SEA; y++) cells[cellIndex(lx, y, lz)] = WATER;
      if (h < TEST_SEA - 1 && rand2(x >> 2, z >> 2, seed + 5) < 0.12) cells[cellIndex(lx, TEST_SEA - 1, lz)] = ICE;

      if (h >= TEST_SEA) {
        // Floating slabs: shade below them only reaches in sideways.
        if (rand2(x >> 2, z >> 2, seed + 3) < 0.1) {
          cells[cellIndex(lx, h + 5, lz)] = STONE;
          cells[cellIndex(lx, h + 6, lz)] = STONE;
        }
        if (rand2(x >> 3, z >> 3, seed + 4) < 0.08) cells[cellIndex(lx, h + 3, lz)] = GLASS;
        const r = rand2(x, z, seed + 9);
        if (r < 0.004) cells[cellIndex(lx, h + 1, lz)] = TORCH;
        else if (r < 0.006) cells[cellIndex(lx, h + 1, lz)] = LAMP;
      }

      // Trees: trunk on the tree column, a leaf blob around (tx, top, tz) with radius 2.
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const tx = x + dx;
          const tz = z + dz;
          if (!isTree(tx, tz, seed)) continue;
          const th = terrainHeight(tx, tz, seed);
          const top = th + 5;
          for (let y = top - 2; y <= top + 2; y++) {
            const dy = y - top;
            if (dx * dx + dz * dz + dy * dy > 5) continue;
            if (rand3(x, y, z, seed + 13) < 0.15) continue; // ragged canopies
            const i = cellIndex(lx, y, lz);
            if (cells[i] === 0) cells[i] = LEAVES;
          }
          if (dx === 0 && dz === 0) for (let y = th + 1; y <= th + 4; y++) cells[cellIndex(lx, y, lz)] = LOG;
        }
      }
    }
  }
  return chunk;
}

/** Flat test chunk: deeprock at y=0, stone up to `ground` (inclusive), air above. */
export function makeFlatChunk(cx: number, cz: number, ground: number): Chunk {
  const chunk = new Chunk(cx, cz);
  for (let y = 0; y <= ground; y++) {
    const cell = makeCell(y === 0 ? B.DEEPROCK : B.STONE);
    for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) chunk.cells[cellIndex(lx, y, lz)] = cell;
  }
  return chunk;
}
