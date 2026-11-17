/**
 * Biomes. A biome here is a LABEL derived from continuous climate and terrain fields; it
 * never drives the terrain height directly (heights come from continuous noise, so biome
 * borders can never produce height seams). Surface materials and decoration read the same
 * continuous fields with dithered thresholds, so borders blend over a few blocks.
 */

/** Numeric biome ids (stored per column in typed arrays). */
export const BIOME = {
  SEA: 0,
  LAKE: 1,
  SHORE: 2,
  MEADOW: 3,
  BROADLEAF: 4,
  CONIFER: 5,
  HIGHLAND: 6,
  PEAKS: 7,
  SCRUB: 8,
} as const;

export type BiomeId = (typeof BIOME)[keyof typeof BIOME];

/** Biome names returned by TerrainGenerator.biomeAt(). */
export type Biome = 'sea' | 'lake' | 'shore' | 'meadow' | 'broadleaf' | 'conifer' | 'highland' | 'peaks' | 'scrub';

/** Name of each biome id (index = BiomeId). */
export const BIOME_NAMES: readonly Biome[] = [
  'sea',
  'lake',
  'shore',
  'meadow',
  'broadleaf',
  'conifer',
  'highland',
  'peaks',
  'scrub',
];

export function biomeName(id: number): Biome {
  return BIOME_NAMES[id] ?? 'sea';
}
