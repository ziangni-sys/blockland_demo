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
import { deriveSeed, latticeHash2, simplex2, smoothstep } from './noise';
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
import { findTrees, stampTrees, TREE_REACH, TreeList } from './trees';

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

/**
 * Carve ceiling of region column `ri` (highest y caves may carve, inclusive): caves may
 * break the surface of dry ground, but never under loose material or clay (it would hang
 * over air) and never within WATER_CAVE_RADIUS columns of water, keeping WATER_CAVE_MARGIN
 * cells under its floor (which also covers horizontal adjacency). Tree roots are handled
 * by the caller. The region must hold WATER_CAVE_RADIUS columns around `ri`.
 */
function caveCeiling(r: ColumnRegion, ri: number, kind: SurfaceKind, depth: number): number {
  const top = r.height[ri]!;
  let ceil = top;
  if (isLooseSurface(kind) || kind === SURF_CLAY) ceil = top - depth - 2;
  for (let dz = -WATER_CAVE_RADIUS; dz <= WATER_CAVE_RADIUS; dz++) {
    for (let dx = -WATER_CAVE_RADIUS; dx <= WATER_CAVE_RADIUS; dx++) {
      const h = r.height[ri + dx + dz * r.size]!;
      if (h < SEA_LEVEL - 1 && h - WATER_CAVE_MARGIN < ceil) ceil = h - WATER_CAVE_MARGIN;
    }
  }
  return ceil;
}

/**
 * Snow cover fades in from SNOW_FADE_BELOW under the snow line to SNOW_FADE_ABOVE over it
 * (blocks): switching it on at one contour drew hard-edged white caps on hills. Tree
 * crowns use the same band lifted by CROWN_SNOW_LIFT.
 */
const SNOW_FADE_BELOW = 4;
const SNOW_FADE_ABOVE = 8;
const CROWN_SNOW_LIFT = 6;
/** Amplitude (blocks) of the patch field that clusters the fade band into drifts. */
const SNOW_PATCH = 3;

/** Chance (0..1) that a column with surface `top` is snow covered. */
function snowChance(top: number, snowLine: number): number {
  return smoothstep(snowLine - SNOW_FADE_BELOW, snowLine + SNOW_FADE_ABOVE, top);
}

const S_TREES = 301;
const S_PLANTS = 302;
const S_FLOWERS = 303;
const S_FLOWER_KIND = 304;
const S_DEEPROCK = 305;
const S_SNOW = 306;
const S_SNOW_PATCH = 307;

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
  private readonly snowSeed: number;
  private readonly snowPatchSeed: number;
  private readonly caves: CaveCarver;
  private readonly ores: OreStamper;

  // ---- scratch (overwritten by every generate() call before being read)
  private readonly region = new ColumnRegion(REGION_SIZE);
  private readonly trees = new TreeList();
  private readonly surfKind = new Uint8Array(256);
  private readonly ceiling = new Int16Array(256);
  private readonly surfaceY = new Int16Array(256);
  private readonly point = createColumnSample();
  /** heightAt scratch: the 5x5 columns around a queried column, and its tree (if any). */
  private readonly pointRegion = new ColumnRegion(2 * WATER_CAVE_RADIUS + 1);
  private readonly pointTrees = new TreeList();

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
    this.snowSeed = deriveSeed(this.seed, S_SNOW);
    this.snowPatchSeed = deriveSeed(this.seed, S_SNOW_PATCH);
    this.caves = new CaveCarver(this.seed);
    this.ores = new OreStamper(this.seed);
  }

  /**
   * y of the top solid terrain cell of column (x, z) as generate() produces it, before
   * trees and plants: where a cave breaks the surface this is the floor below the mouth.
   * About 4 us (one 2D column sample plus the cave fields at the surface cell); columns
   * where a cave reaches the surface (under 1 % of land) cost ~25 column samples more.
   */
  heightAt(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const top = this.sampler.sample(ix, iz, this.point).height;
    // Water floors are never carved (the ceiling keeps WATER_CAVE_MARGIN cells under them).
    if (top < SEA_LEVEL - 1) return top;
    if (!this.caves.carvesIgnoringCeiling(ix, top, iz, top)) return top;
    // A cave reaches the surface cell: work out this column's ceiling exactly as generate()
    // does (it depends on the surface kind, nearby water and a tree rooted here).
    const r = this.pointRegion;
    r.fill(this.sampler, ix - WATER_CAVE_RADIUS, iz - WATER_CAVE_RADIUS);
    const ri = r.index(ix, iz);
    const ss = this.surfaceSeeds;
    const kind = classifySurface(r, ri, ix, iz, ss);
    let ceil = caveCeiling(r, ri, kind, surfaceDepth(kind, ix, iz, ss));
    findTrees(r, this.treeSeed, ss, ix, iz, ix, iz, this.pointTrees);
    if (this.pointTrees.count > 0 && top - TREE_ROOT_MARGIN < ceil) ceil = top - TREE_ROOT_MARGIN;
    return this.caves.topUncarved(ix, iz, top, top, ceil);
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
        ceiling[ci] = caveCeiling(r, ri, kind, depth);
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

    const snowLine = r.snowLine[ri]!;
    const snowTop = this.snowTop(wx, wz, top, snowLine);
    const snowRoll = latticeHash2(this.snowSeed, wx, wz) / 4294967296;
    if (snowRoll < snowChance(snowTop, snowLine)) {
      // Snow settles on the highest solid cell of the column: ground, rock or a tree crown
      // (possibly the crown of a tree rooted on higher ground next door). Crowns take snow
      // only higher up, so the fringe of the snow zone reads as green trees on white ground
      // rather than a white sheet over the forest.
      for (let y = WORLD_HEIGHT - 2; y >= top - 1 && y >= 1; y--) {
        const c = cells[ci | (y << 8)]!;
        if (c === AIR) continue;
        const id = c & ID_MASK;
        if (SOLID[id] === 1 && LIQUID[id] === 0 && cells[ci | ((y + 1) << 8)] === AIR) {
          const crown = id === B.LEAVES_OAK || id === B.LEAVES_PINE;
          if (!crown || snowRoll < snowChance(snowTop, snowLine + CROWN_SNOW_LIFT)) {
            const deep = top >= snowLine + 8 || r.cold[ri]! > 0.9;
            cells[ci | ((y + 1) << 8)] = deep && (latticeHash2(this.plantSeed, wx, wz) & 1) === 0 ? C_SNOW_2 : C_SNOW_1;
          }
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
      // Cacti grow only on even-even columns, so two cacti are never side by side (also
      // across chunk borders, with no neighbour access); 4x the per-column chance keeps
      // the overall density at ~1.2 %.
      if ((wx & 1) === 0 && (wz & 1) === 0 && roll < 0.048 && this.cactusFits(ri, top)) {
        const height = 1 + (hash3(wx, top, wz, this.plantSeed) % 3);
        for (let k = 1; k <= height && top + k < WORLD_HEIGHT; k++) cells[ci | ((top + k) << 8)] = C_CACTUS;
      } else if (roll > 0.975) {
        // Sparse dry tufts break up the sand.
        cells[ci | ((top + 1) << 8)] = C_TALL_GRASS;
      }
    }
  }

  /**
   * Surface height as the snow sees it: shifted by up to SNOW_PATCH blocks by a patch field,
   * so the snowy columns of the fade band cluster into drifts rather than salt-and-pepper
   * speckle (the per-column roll stays uniform, which keeps the band its full width).
   * Columns far from the band skip the noise: the result cannot matter there.
   */
  private snowTop(wx: number, wz: number, top: number, snowLine: number): number {
    if (top < snowLine - SNOW_FADE_BELOW - SNOW_PATCH) return top;
    if (top > snowLine + CROWN_SNOW_LIFT + SNOW_FADE_ABOVE + SNOW_PATCH) return top;
    return top + SNOW_PATCH * simplex2(this.snowPatchSeed, wx / 11, wz / 11);
  }

  /** Cactus needs open air on all four sides: neighbour terrain no higher than its base. */
  private cactusFits(ri: number, top: number): boolean {
    const r = this.region;
    const n = r.size;
    if (r.height[ri - 1]! > top || r.height[ri + 1]! > top) return false;
    return r.height[ri - n]! <= top && r.height[ri + n]! <= top;
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
