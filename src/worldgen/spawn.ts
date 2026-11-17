/**
 * Spawn search: the first pleasant shore spot found on an outward spiral from the origin.
 *
 * "Pleasant" = dry, flat-ish meadow / forest / beach a few blocks above the sea, open SEA
 * (not a pond) within 12 blocks, and a few trees within 18 blocks. Cheap 2D column samples
 * reject most candidates. The 2D model knows nothing about caves, so a survivor is then
 * rejected if a cave breaks the surface anywhere in its 5x5 patch (exact heightAt), and
 * finally confirmed against the real generated chunk (solid ground under the feet, two air
 * cells for the body), so caves or trees can never put the player in a wall or by a pit.
 */
import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from '../core/constants';
import { AIR } from '../blocks/cell';
import { SOLID } from '../blocks/registry';
import { BIOME } from './biome';
import { classifySurface, SURF_SAND, SURF_TURF, type SurfaceSeeds } from './surface';
import { ColumnRegion, createColumnSample, type ColumnSample, type TerrainSampler } from './terrain';
import { findTrees, TreeList } from './trees';

/** What the spawn search needs from the generator. */
export interface SpawnHost {
  readonly sampler: TerrainSampler;
  readonly surfaceSeeds: SurfaceSeeds;
  readonly treeSeed: number;
  generate(cx: number, cz: number): Uint16Array;
  /** Exact top solid terrain cell of a column (caves included). */
  heightAt(x: number, z: number): number;
}

/** Candidate grid spacing (blocks) and how many rings of it to try. */
const STEP = 7;
const MAX_RINGS = 450;
/** Max distance (blocks) from the spawn to the nearest sea column. */
const WATER_RADIUS = 12;
const TREE_RADIUS = 18;
const MIN_TREES = 3;

/** 16 (nearly) unit directions for the water probe, written out so no trig is needed. */
const DIRS_X: readonly number[] = [1, 0.92, 0.71, 0.38, 0, -0.38, -0.71, -0.92, -1, -0.92, -0.71, -0.38, 0, 0.38, 0.71, 0.92];
const DIRS_Z: readonly number[] = [0, 0.38, 0.71, 0.92, 1, 0.92, 0.71, 0.38, 0, -0.38, -0.71, -0.92, -1, -0.92, -0.71, -0.38];

class SpawnSearch {
  private readonly host: SpawnHost;
  private readonly s = createColumnSample();
  private readonly region = new ColumnRegion(2 * (TREE_RADIUS + 1) + 3);
  private readonly trees = new TreeList();
  private chunkKey = '';
  private chunk: Uint16Array | null = null;

  constructor(host: SpawnHost) {
    this.host = host;
  }

  private sample(x: number, z: number): ColumnSample {
    return this.host.sampler.sample(x, z, this.s);
  }

  private isSea(x: number, z: number): boolean {
    const s = this.sample(x, z);
    return s.height < SEA_LEVEL - 1 && s.biome === BIOME.SEA;
  }

  /** Stage 1: the column itself. */
  private columnOk(x: number, z: number): boolean {
    const s = this.sample(x, z);
    if (s.height < SEA_LEVEL + 1 || s.height > SEA_LEVEL + 6) return false;
    if (s.biome !== BIOME.MEADOW && s.biome !== BIOME.BROADLEAF && s.biome !== BIOME.SHORE) return false;
    return s.dry < 0.3 && s.cold < 0.5 && s.rock < 0.4;
  }

  /** Stage 2: open sea within WATER_RADIUS, with some depth and extent beyond it. */
  private seaNearby(x: number, z: number): boolean {
    for (let r = 2; r <= WATER_RADIUS; r += 2) {
      for (let d = 0; d < 16; d++) {
        const wx = Math.round(x + DIRS_X[d]! * r);
        const wz = Math.round(z + DIRS_Z[d]! * r);
        if (!this.isSea(wx, wz)) continue;
        // Follow the ray: real open water continues and gets deep enough for a ship.
        let wet = 0;
        let deep = false;
        for (let k = 4; k <= 32; k += 4) {
          const s = this.sample(Math.round(x + DIRS_X[d]! * (r + k)), Math.round(z + DIRS_Z[d]! * (r + k)));
          if (s.height < SEA_LEVEL - 1) {
            wet++;
            if (s.height <= SEA_LEVEL - 5) deep = true;
          }
        }
        if (wet >= 6 && deep) return true;
      }
    }
    return false;
  }

  /** Stage 3: flat 5x5 patch. */
  private flat(x: number, z: number): boolean {
    let lo = WORLD_HEIGHT;
    let hi = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const h = this.sample(x + dx, z + dz).height;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return hi - lo <= 2 && lo >= SEA_LEVEL - 1;
  }

  /** Stage 5: no cave mouth in the 5x5 patch (so no pit or hole right by the feet). */
  private noCaveMouth(x: number, z: number): boolean {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (this.host.heightAt(x + dx, z + dz) !== this.sample(x + dx, z + dz).height) return false;
      }
    }
    return true;
  }

  /** Stage 4: turf or sand underfoot and enough trees around. */
  private treesAndSurface(x: number, z: number): boolean {
    const r = this.region;
    const half = (r.size - 1) >> 1;
    r.fill(this.host.sampler, x - half, z - half);
    const kind = classifySurface(r, r.index(x, z), x, z, this.host.surfaceSeeds);
    if (kind !== SURF_TURF && kind !== SURF_SAND) return false;
    findTrees(
      r,
      this.host.treeSeed,
      this.host.surfaceSeeds,
      x - TREE_RADIUS,
      z - TREE_RADIUS,
      x + TREE_RADIUS,
      z + TREE_RADIUS,
      this.trees,
    );
    let n = 0;
    for (let k = 0; k < this.trees.count; k++) {
      const t = this.trees.items[k]!;
      const dx = t.x - x;
      const dz = t.z - z;
      if (dx * dx + dz * dz <= TREE_RADIUS * TREE_RADIUS) n++;
    }
    return n >= MIN_TREES;
  }

  /** Final check on real cells: returns the feet y, or -1. */
  private standable(x: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    if (key !== this.chunkKey || !this.chunk) {
      this.chunk = this.host.generate(cx, cz);
      this.chunkKey = key;
    }
    const cells = this.chunk;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    // Topmost solid cell of the column, then two air cells above it.
    for (let y = WORLD_HEIGHT - 3; y >= SEA_LEVEL; y--) {
      const c = cells[lx | (lz << 4) | (y << 8)]!;
      if (c === AIR) continue;
      if (SOLID[c & 0x3ff] !== 1) return -1;
      const a1 = cells[lx | (lz << 4) | ((y + 1) << 8)]!;
      const a2 = cells[lx | (lz << 4) | ((y + 2) << 8)]!;
      return a1 === AIR && a2 === AIR ? y + 1 : -1;
    }
    return -1;
  }

  find(): { x: number; y: number; z: number } {
    for (let ring = 0; ring <= MAX_RINGS; ring++) {
      const n = ring === 0 ? 1 : 8 * ring;
      for (let k = 0; k < n; k++) {
        const [i, j] = ringPoint(ring, k);
        const x = i * STEP;
        const z = j * STEP;
        if (!this.columnOk(x, z) || !this.flat(x, z) || !this.seaNearby(x, z) || !this.treesAndSurface(x, z)) continue;
        if (!this.noCaveMouth(x, z)) continue;
        const h = this.sample(x, z).height;
        const feet = this.standable(x, z);
        // The feet must be on the terrain surface itself (not on a tree crown).
        if (feet === h + 1) return { x: x + 0.5, y: feet, z: z + 0.5 };
      }
    }
    return this.fallback();
  }

  /** No pleasant shore in range (pathological seed): any dry, standable column near the origin. */
  private fallback(): { x: number; y: number; z: number } {
    for (let ring = 0; ring <= 200; ring++) {
      const n = ring === 0 ? 1 : 8 * ring;
      for (let k = 0; k < n; k++) {
        const [i, j] = ringPoint(ring, k);
        const x = i * 4;
        const z = j * 4;
        if (this.sample(x, z).height < SEA_LEVEL || !this.noCaveMouth(x, z)) continue;
        const feet = this.standable(x, z);
        if (feet > 0) return { x: x + 0.5, y: feet, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: this.sample(0, 0).height + 1, z: 0.5 };
  }
}

/** k-th grid point (0 <= k < 8*ring) on the square ring at Chebyshev distance `ring`. */
function ringPoint(ring: number, k: number): [number, number] {
  if (ring === 0) return [0, 0];
  const side = 2 * ring;
  const s = Math.floor(k / side);
  const t = k - s * side;
  switch (s) {
    case 0:
      return [-ring + t, -ring];
    case 1:
      return [ring, -ring + t];
    case 2:
      return [ring - t, ring];
    default:
      return [-ring, ring - t];
  }
}

/** Deterministic spawn point of a terrain generator (feet position, x/z at a cell centre). */
export function findSpawn(host: SpawnHost): { x: number; y: number; z: number } {
  return new SpawnSearch(host).find();
}
