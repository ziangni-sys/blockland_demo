/**
 * Chunk generators.
 *
 *  - TerrainGenerator: the real world (archipelago terrain, caves, ores, trees, plants).
 *  - FlatGenerator:    horizontal layers, for tests.
 *  - VoidGenerator:    all air, for tests.
 *
 * generate(cx, cz) is a pure function of (seed, cx, cz): chunks are generated alone, with no
 * access to neighbours, in any order, by any instance, and come out identical. Instances
 * keep only scratch buffers (never read before being overwritten) and a memoised spawn.
 *
 * Generation order inside TerrainGenerator.generate():
 *   1. column samples for the chunk + margin   (terrain.ts)
 *   2. surface kinds + tree list               (surface.ts, trees.ts)
 *   3. base fill: deeprock, stone, surface layers, sea / lake water
 *   4. caves                                    (caves.ts)  — under per-column ceilings
 *   5. ores                                     (ores.ts)   — replace stone only
 *   6. trees                                    (trees.ts)  — including neighbours' trees
 *   7. ground plants, cactus, snow cover
 *   8. safety pass: nothing loose above air / liquid
 */
import { CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL, WORLD_HEIGHT } from '../core/constants';
import { hash3 } from '../core/rng';
import { AIR, ID_MASK, layersState, makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { GRAVITY_BLOCK, LIQUID, SOLID } from '../blocks/registry';
import { biomeName, BIOME, type Biome } from './biome';
import { CaveCarver } from './caves';
import { deriveSeed, latticeHash2, simplex2 } from './noise';
import { OreStamper } from './ores';
import { findSpawn } from './spawn';
import {
  classifySurface,
  isLooseSurface,
  surfaceDepth,
  surfaceSeeds,
  SURF_CLAY,
  type SurfaceKind,
  type SurfaceSeeds,
} from './surface';
import { ColumnRegion, createColumnSample, REGION_MARGIN, REGION_SIZE, TerrainSampler } from './terrain';
import { findTrees, stampTrees, TREE_MAX_HEIGHT, TREE_REACH, TreeList } from './trees';

/** A source of chunk columns. */
export interface ChunkGenerator {
  readonly seed: number;
  /** CHUNK_VOLUME cells, index lx | lz << 4 | y << 8 (see voxel/chunk.ts). A fresh array. */
  generate(cx: number, cz: number): Uint16Array;
  /** Feet position for a new player (x, z at a cell centre). */
  spawnPoint(): { x: number; y: number; z: number };
}

/** A spawn position (feet). */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

const C_STONE = makeCell(B.STONE);
const C_DIRT = makeCell(B.DIRT);
const C_TURF = makeCell(B.TURF);
const C_SAND = makeCell(B.SAND);
const C_GRAVEL = makeCell(B.GRAVEL);
const C_CLAY = makeCell(B.CLAY);
const C_SNOW_BLOCK = makeCell(B.SNOW_BLOCK);
const C_DEEPROCK = makeCell(B.DEEPROCK);
const C_WATER = makeCell(B.WATER, 0);
const C_TALL_GRASS = makeCell(B.TALL_GRASS);
const C_FLOWER_RED = makeCell(B.FLOWER_RED);
const C_FLOWER_YELLOW = makeCell(B.FLOWER_YELLOW);
const C_CACTUS = makeCell(B.CACTUS);
const C_SNOW_1 = makeCell(B.SNOW_LAYER, layersState(1));
const C_SNOW_2 = makeCell(B.SNOW_LAYER, layersState(2));

/** Top cell of each surface kind. */
const SURFACE_TOP: readonly number[] = [C_TURF, C_SAND, C_GRAVEL, C_STONE, C_SNOW_BLOCK, C_CLAY];
/** Cells under the top cell, down to the surface depth. */
const SURFACE_FILL: readonly number[] = [C_DIRT, C_SAND, C_GRAVEL, C_STONE, C_SNOW_BLOCK, C_CLAY];

/** Uncarved cells kept between any water and a cave. */
const WATER_CAVE_MARGIN = 4;
/** Columns (Chebyshev radius) around a water column that inherit its cave ceiling. */
const WATER_CAVE_RADIUS = 2;
/** Uncarved cells under a tree's ground cell. */
const TREE_ROOT_MARGIN = 6;

const S_TREES = 301;
const S_PLANTS = 302;
const S_FLOWERS = 303;
const S_FLOWER_KIND = 304;
const S_DEEPROCK = 305;

export class TerrainGenerator implements ChunkGenerator {
  readonly seed: number;
  /** The 2D terrain model (heights, climate, biomes). */
  readonly sampler: TerrainSampler;
  readonly surfaceSeeds: SurfaceSeeds;
  readonly treeSeed: number;
  private readonly plantSeed: number;
  private readonly flowerSeed: number;
  private readonly flowerKindSeed: number;
  private readonly deeprockSeed: number;
  private readonly caves: CaveCarver;
  private readonly ores: OreStamper;

  // ---- scratch (overwritten by every generate() call before being read)
  private readonly region = new ColumnRegion(REGION_SIZE);
  private readonly trees = new TreeList();
  private readonly surfKind = new Uint8Array(256);
  private readonly ceiling = new Int16Array(256);
  private readonly surfaceY = new Int16Array(256);
  private readonly point = createColumnSample();

  private spawn: SpawnPoint | null = null;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.sampler = new TerrainSampler(this.seed);
    this.surfaceSeeds = surfaceSeeds(this.seed);
    this.treeSeed = deriveSeed(this.seed, S_TREES);
    this.plantSeed = deriveSeed(this.seed, S_PLANTS);
    this.flowerSeed = deriveSeed(this.seed, S_FLOWERS);
    this.flowerKindSeed = deriveSeed(this.seed, S_FLOWER_KIND);
    this.deeprockSeed = deriveSeed(this.seed, S_DEEPROCK);
    this.caves = new CaveCarver(this.seed);
    this.ores = new OreStamper(this.seed);
  }

  /** y of the top solid terrain cell at (x, z), before trees (and ignoring cave mouths). */
  heightAt(x: number, z: number): number {
    return this.sampler.sample(Math.floor(x), Math.floor(z), this.point).height;
  }

  /** Biome label of the column at (x, z). */
  biomeAt(x: number, z: number): Biome {
    return biomeName(this.sampler.sample(Math.floor(x), Math.floor(z), this.point).biome);
  }

  spawnPoint(): SpawnPoint {
    if (!this.spawn) this.spawn = findSpawn(this);
    return { x: this.spawn.x, y: this.spawn.y, z: this.spawn.z };
  }

  generate(cx: number, cz: number): Uint16Array {
    const cells = new Uint16Array(CHUNK_VOLUME);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const r = this.region;
    r.fill(this.sampler, x0 - REGION_MARGIN, z0 - REGION_MARGIN);
    const ss = this.surfaceSeeds;

    // ---- 2. surfaces and trees
    const kinds = this.surfKind;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const i = r.index(x0 + lx, z0 + lz);
        kinds[lx | (lz << 4)] = classifySurface(r, i, x0 + lx, z0 + lz, ss);
      }
    }
    const trees = this.trees;
    findTrees(
      r,
      this.treeSeed,
      ss,
      x0 - TREE_REACH,
      z0 - TREE_REACH,
      x0 + CHUNK_SIZE - 1 + TREE_REACH,
      z0 + CHUNK_SIZE - 1 + TREE_REACH,
      trees,
    );

    // ---- 3. base fill + cave ceilings
    const ceiling = this.ceiling;
    const surfaceY = this.surfaceY;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lx | (lz << 4);
        const wx = x0 + lx;
        const wz = z0 + lz;
        const ri = r.index(wx, wz);
        const top = r.height[ri]!;
        const kind = kinds[ci]! as SurfaceKind;
        const depth = surfaceDepth(kind, wx, wz, ss);
        this.fillColumn(cells, ci, wx, wz, top, kind, depth);
        surfaceY[ci] = top;

        // Cave ceiling: caves may break the surface of dry ground, but never under loose
        // material (it would hang over air) and never near water.
        let ceil = top;
        if (isLooseSurface(kind) || kind === SURF_CLAY) ceil = top - depth - 2;
        for (let dz = -WATER_CAVE_RADIUS; dz <= WATER_CAVE_RADIUS; dz++) {
          for (let dx = -WATER_CAVE_RADIUS; dx <= WATER_CAVE_RADIUS; dx++) {
            const h = r.height[ri + dx + dz * r.size]!;
            if (h < SEA_LEVEL - 1 && h - WATER_CAVE_MARGIN < ceil) ceil = h - WATER_CAVE_MARGIN;
          }
        }
        ceiling[ci] = ceil;
      }
    }
    // Trees must keep their footing.
    for (let k = 0; k < trees.count; k++) {
      const t = trees.items[k]!;
      const lx = t.x - x0;
      const lz = t.z - z0;
      if (lx < 0 || lz < 0 || lx >= CHUNK_SIZE || lz >= CHUNK_SIZE) continue;
      const ci = lx | (lz << 4);
      const c = t.ground - TREE_ROOT_MARGIN;
      if (c < ceiling[ci]!) ceiling[ci] = c;
    }

    // ---- 4. caves, 5. ores
    this.caves.carve(cells, x0, z0, ceiling, surfaceY);
    this.ores.stamp(cells, cx, cz);

    // ---- 6. trees (leaves only grow into air, so they are stamped before plants)
    stampTrees(cells, x0, z0, trees);

    // ---- 7. plants and snow
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        this.decorateColumn(cells, lx, lz, x0 + lx, z0 + lz);
      }
    }

    // ---- 8. safety: nothing that falls may rest on air or liquid
    for (let ci = 0; ci < 256; ci++) {
      for (let y = 1; y < WORLD_HEIGHT; y++) {
        const i = ci | (y << 8);
        if (GRAVITY_BLOCK[cells[i]! & ID_MASK] === 1 && SOLID[cells[i - 256]! & ID_MASK] === 0) cells[i] = C_STONE;
      }
    }
    return cells;
  }

  /** Deeprock floor, stone body, surface layers and water for one column. */
  private fillColumn(
    cells: Uint16Array,
    ci: number,
    wx: number,
    wz: number,
    top: number,
    kind: SurfaceKind,
    depth: number,
  ): void {
    // Deeprock: always at y = 0, ragged at y = 1..2.
    const h = latticeHash2(this.deeprockSeed, wx, wz);
    cells[ci] = C_DEEPROCK;
    const rag = (h & 3) === 0 ? 2 : (h & 1) === 0 ? 1 : 0;
    for (let y = 1; y <= rag; y++) cells[ci | (y << 8)] = C_DEEPROCK;
    const fillTop = SURFACE_FILL[kind]!;
    const surfaceBottom = top - depth + 1;
    for (let y = rag + 1; y <= top; y++) {
      cells[ci | (y << 8)] = y < surfaceBottom ? C_STONE : y === top ? SURFACE_TOP[kind]! : fillTop;
    }
    // Sea and lakes: every water cell is a source, up to y = SEA_LEVEL - 1.
    for (let y = top + 1; y < SEA_LEVEL; y++) cells[ci | (y << 8)] = C_WATER;
  }

  /** Ground plants, cactus and snow cover for one column of the chunk being generated. */
  private decorateColumn(cells: Uint16Array, lx: number, lz: number, wx: number, wz: number): void {
    const r = this.region;
    const ri = r.index(wx, wz);
    const top = r.height[ri]!;
    if (top < SEA_LEVEL - 1) return; // under water: nothing grows
    const ci = lx | (lz << 4);
    const surface = cells[ci | (top << 8)]!;
    const above = top + 1 < WORLD_HEIGHT ? cells[ci | ((top + 1) << 8)]! : 1;
    const snowy = top >= r.snowLine[ri]!;

    if (snowy) {
      // Snow settles on the highest solid cell of the column: ground, rock or a tree crown.
      const yStart = Math.min(WORLD_HEIGHT - 2, top + TREE_MAX_HEIGHT + 1);
      for (let y = yStart; y >= top - 1 && y >= 1; y--) {
        const c = cells[ci | (y << 8)]!;
        if (c === AIR) continue;
        if (SOLID[c & ID_MASK] === 1 && LIQUID[c & ID_MASK] === 0 && cells[ci | ((y + 1) << 8)] === AIR) {
          const deep = top >= r.snowLine[ri]! + 8 || r.cold[ri]! > 0.9;
          cells[ci | ((y + 1) << 8)] = deep && (latticeHash2(this.plantSeed, wx, wz) & 1) === 0 ? C_SNOW_2 : C_SNOW_1;
        }
        break;
      }
      return;
    }
    if (above !== AIR) return;

    const roll = latticeHash2(this.plantSeed, wx, wz) / 4294967296;
    const biome = r.biome[ri]!;
    if (surface === C_TURF) {
      let grass: number;
      let flowers: number;
      switch (biome) {
        case BIOME.MEADOW:
          grass = 0.3;
          flowers = 0.3;
          break;
        case BIOME.BROADLEAF:
          grass = 0.16;
          flowers = 0.1;
          break;
        case BIOME.HIGHLAND:
          grass = 0.22;
          flowers = 0.12;
          break;
        case BIOME.CONIFER:
          grass = 0.08;
          flowers = 0.02;
          break;
        default:
          grass = 0.12;
          flowers = 0.06;
      }
      // Flowers grow in drifts: a patch field gates them so they cluster.
      const patch = simplex2(this.flowerSeed, wx / 13, wz / 13);
      if (patch > 0.4 && roll < flowers) {
        const red = simplex2(this.flowerKindSeed, wx / 40, wz / 40) + (roll - flowers * 0.5) * 2 > 0;
        cells[ci | ((top + 1) << 8)] = red ? C_FLOWER_RED : C_FLOWER_YELLOW;
      } else if (roll > 1 - grass) {
        cells[ci | ((top + 1) << 8)] = C_TALL_GRASS;
      }
      return;
    }

    if (surface === C_SAND && biome === BIOME.SCRUB) {
      if (roll < 0.012 && this.cactusFits(cells, ri, top, lx, lz)) {
        const height = 1 + (hash3(wx, top, wz, this.plantSeed) % 3);
        for (let k = 1; k <= height && top + k < WORLD_HEIGHT; k++) cells[ci | ((top + k) << 8)] = C_CACTUS;
      } else if (roll > 0.975) {
        // Sparse dry tufts break up the sand.
        cells[ci | ((top + 1) << 8)] = C_TALL_GRASS;
      }
    }
  }

  /** Cactus needs open air on all four sides (neighbour terrain no higher than its base). */
  private cactusFits(cells: Uint16Array, ri: number, top: number, lx: number, lz: number): boolean {
    const r = this.region;
    const n = r.size;
    if (r.height[ri - 1]! > top || r.height[ri + 1]! > top) return false;
    if (r.height[ri - n]! > top || r.height[ri + n]! > top) return false;
    // Also keep clear of things already placed in this chunk at the base height.
    if (lx > 0 && cells[(lx - 1) | (lz << 4) | ((top + 1) << 8)] !== AIR) return false;
    if (lz > 0 && cells[lx | ((lz - 1) << 4) | ((top + 1) << 8)] !== AIR) return false;
    return true;
  }
}

/** Horizontal layers from y = 0 upward, air above. */
export class FlatGenerator implements ChunkGenerator {
  readonly seed: number;
  /** Cell value of each y (length = total thickness, capped at WORLD_HEIGHT). */
  private readonly column: Uint16Array;

  /**
   * @param layers bottom-up; `id` is a block id (or a full cell value including state bits).
   *   Default: deeprock 1, stone 30, dirt 3, turf 1.
   */
  constructor(
    layers: Array<{ id: number; thickness: number }> = [
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: 30 },
      { id: B.DIRT, thickness: 3 },
      { id: B.TURF, thickness: 1 },
    ],
    seed = 0,
  ) {
    this.seed = seed >>> 0;
    const col: number[] = [];
    for (const layer of layers) {
      const n = Math.max(0, Math.floor(layer.thickness));
      for (let k = 0; k < n && col.length < WORLD_HEIGHT; k++) col.push(layer.id & 0xffff);
    }
    this.column = Uint16Array.from(col);
  }

  /** Number of filled cells per column (= y of the first air cell). */
  get top(): number {
    return this.column.length;
  }

  generate(_cx: number, _cz: number): Uint16Array {
    const cells = new Uint16Array(CHUNK_VOLUME);
    const col = this.column;
    for (let y = 0; y < col.length; y++) cells.fill(col[y]!, y << 8, (y + 1) << 8);
    return cells;
  }

  spawnPoint(): SpawnPoint {
    return { x: 0.5, y: this.column.length, z: 0.5 };
  }
}

/** All air. */
export class VoidGenerator implements ChunkGenerator {
  readonly seed: number;
  constructor(seed = 0) {
    this.seed = seed >>> 0;
  }
  generate(_cx: number, _cz: number): Uint16Array {
    return new Uint16Array(CHUNK_VOLUME);
  }
  spawnPoint(): SpawnPoint {
    return { x: 0.5, y: SEA_LEVEL + 16, z: 0.5 };
  }
}
