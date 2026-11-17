/**
 * Surface material of a terrain column (what the top few cells are made of).
 *
 * This is a pure function of the column samples around the column, so the base terrain
 * fill and the tree placement (which needs to know whether a NEIGHBOURING chunk's column
 * is turf) always agree. Biome borders blend because every threshold is dithered by a
 * per-column hash.
 */
import { SEA_LEVEL } from '../core/constants';
import { BIOME } from './biome';
import { deriveSeed, latticeHash2, simplex2 } from './noise';
import type { ColumnRegion } from './terrain';

/** Surface kinds. */
export const SURF_TURF = 0; // turf over 3-4 dirt
export const SURF_SAND = 1; // sand over stone
export const SURF_GRAVEL = 2; // gravel over stone
export const SURF_STONE = 3; // bare rock
export const SURF_SNOW = 4; // packed snow cap over stone
export const SURF_CLAY = 5; // clay (lake and shallow sea floors)
export type SurfaceKind = 0 | 1 | 2 | 3 | 4 | 5;

/** Lowest y that can carry a packed-snow cap. */
const SNOW_CAP_MIN_Y = 90;

const S_DITHER = 101;
const S_GRAVEL = 102;
const S_CLAY = 103;
const S_DEPTH = 104;

/** Seeds of the surface fields, derived once per generator. */
export interface SurfaceSeeds {
  readonly dither: number;
  readonly gravel: number;
  readonly clay: number;
  readonly depth: number;
}

export function surfaceSeeds(seed: number): SurfaceSeeds {
  return {
    dither: deriveSeed(seed, S_DITHER),
    gravel: deriveSeed(seed, S_GRAVEL),
    clay: deriveSeed(seed, S_CLAY),
    depth: deriveSeed(seed, S_DEPTH),
  };
}

/** Uniform [0,1) per column. */
function dither(seed: number, x: number, z: number): number {
  return latticeHash2(seed, x, z) / 4294967296;
}

/**
 * Largest height difference between a column and its 4 neighbours. The column must not
 * lie on the outermost ring of the region.
 */
export function columnSlope(r: ColumnRegion, i: number): number {
  const h = r.height[i]!;
  const n = r.size;
  let s = Math.abs(h - r.height[i - 1]!);
  let d = Math.abs(h - r.height[i + 1]!);
  if (d > s) s = d;
  d = Math.abs(h - r.height[i - n]!);
  if (d > s) s = d;
  d = Math.abs(h - r.height[i + n]!);
  if (d > s) s = d;
  return s;
}

/** Surface kind of region column `i` at world (x, z). Not valid on the region's outer ring. */
export function classifySurface(r: ColumnRegion, i: number, x: number, z: number, ss: SurfaceSeeds): SurfaceKind {
  const top = r.height[i]!;
  const jit = dither(ss.dither, x, z);

  if (top < SEA_LEVEL - 1) {
    // Water floor: sand, with gravel patches (common in deep water) and clay in the shallows.
    const g = simplex2(ss.gravel, x / 22, z / 22);
    if (top >= 37 && simplex2(ss.clay, x / 15, z / 15) > 0.45 + 0.15 * jit) return SURF_CLAY;
    if (g > (top < 36 ? -0.15 : 0.42) + 0.12 * jit) return SURF_GRAVEL;
    return SURF_SAND;
  }

  const slope = columnSlope(r, i);
  const biome = r.biome[i]!;
  if (slope >= 4 + (jit < 0.5 ? 0 : 1)) return SURF_STONE; // cliff faces
  // Packed snow caps only on high, bare summits; snowy lowlands keep turf (with snow cover
  // and conifers) so cold regions read as snowy forest rather than flat white sheets.
  if (top >= r.snowLine[i]! + 3 && top >= SNOW_CAP_MIN_Y && slope <= 2) return SURF_SNOW;
  if (r.rock[i]! > 0.42 + 0.4 * jit) return SURF_STONE;
  if (r.dry[i]! > 0.3 + 0.35 * jit) return SURF_SAND;
  if (biome === BIOME.SHORE) {
    if (top <= SEA_LEVEL && simplex2(ss.gravel, x / 22, z / 22) > 0.5) return SURF_GRAVEL;
    // The sand fades into turf a block or two above the waterline.
    return top <= SEA_LEVEL + (jit < 0.6 ? 1 : 0) ? SURF_SAND : SURF_TURF;
  }
  return SURF_TURF;
}

/** Thickness of the surface material layer (cells, including the top cell). */
export function surfaceDepth(kind: SurfaceKind, x: number, z: number, ss: SurfaceSeeds): number {
  const h = latticeHash2(ss.depth, x, z);
  switch (kind) {
    case SURF_TURF:
      return 4 + (h & 1); // turf + 3..4 dirt
    case SURF_SAND:
      return 3 + (h & 1) + ((h >>> 1) & 1);
    case SURF_GRAVEL:
      return 2 + (h & 1);
    case SURF_CLAY:
      return 1 + (h & 1);
    case SURF_SNOW:
      return 1 + (h & 1);
    default:
      return 0;
  }
}

/** True for surfaces that would fall into a cave opened below them. */
export function isLooseSurface(kind: SurfaceKind): boolean {
  return kind === SURF_SAND || kind === SURF_GRAVEL;
}
