/**
 * The 2D terrain model: per-column height, climate and biome, as pure functions of
 * (seed, x, z).
 *
 * Shape of the world (the game is about ships and windmills):
 *  - "Continentalness" `cont` (three noise scales, domain-warped) decides land vs sea; its
 *    zero contour is the coastline. Roughly half of all columns end up under water, as an
 *    archipelago of islands, larger landmasses, bays and straits.
 *  - Under water, depth grows with -cont (shallow shelves near coasts, deep straits).
 *  - On land, height grows with cont, plus rolling hills, terraced cliff bands, ridged
 *    mountains in a few regions, and sea-level lake basins in the lowlands.
 *  - Every term is a CONTINUOUS function of continuous noise fields, so there is no place
 *    where the height can jump at a biome border. Biomes are labels read off the same
 *    fields afterwards.
 *
 * All arithmetic is IEEE-exact (see noise.ts) so results are bit-identical across engines.
 */
import { CHUNK_SIZE, SEA_LEVEL } from '../core/constants';
import { BIOME, type BiomeId } from './biome';
import { deriveSeed, fbm2, latticeHash2, ridged2, simplex2, smoothstep } from './noise';

/** The highest surface the height function can produce (asymptote of the peak compression). */
export const MAX_TERRAIN_Y = 117;
/** Height above which peaks are compressed towards MAX_TERRAIN_Y. */
const CAP_START = 103;
/** The lowest sea floor the height function can produce. */
export const MIN_TERRAIN_Y = 12;

/** Everything the generator needs to know about one terrain column. */
export interface ColumnSample {
  /** y of the top solid terrain cell (before caves and decoration). */
  height: number;
  biome: BiomeId;
  /** Continentalness: < 0 sea, > 0 land; ~0.6 deep inland. */
  cont: number;
  /** Altitude-adjusted temperature, roughly -1.5 .. 1. */
  temp: number;
  /** Humidity, roughly -1 .. 1. */
  humid: number;
  /** 0..1: how cold (drives conifers and snow). */
  cold: number;
  /** 0..1: how dry and hot (sand surface and cactus). */
  dry: number;
  /** 0..1: probability that a tree-grid cell holds a tree. */
  forest: number;
  /** 0..1: tendency to show bare rock at the surface. */
  rock: number;
  /** 0..1: lake basin weight (inland water at sea level). */
  lake: number;
  /** y from which the surface is snow covered. */
  snowLine: number;
}

export function createColumnSample(): ColumnSample {
  return {
    height: 0,
    biome: BIOME.SEA,
    cont: 0,
    temp: 0,
    humid: 0,
    cold: 0,
    dry: 0,
    forest: 0,
    rock: 0,
    lake: 0,
    snowLine: 0,
  };
}

// Salts of the independent noise fields (any distinct integers).
const S_WARP_X = 1;
const S_WARP_Z = 2;
const S_CONT_L = 3;
const S_CONT_M = 4;
const S_CONT_S = 5;
const S_CLIFF = 6;
const S_RUG = 7;
const S_HILL = 8;
const S_MTN = 9;
const S_RIDGE = 10;
const S_TERRACE = 11;
const S_DETAIL = 12;
const S_LAKE = 13;
const S_TEMP = 14;
const S_HUMID = 15;
const S_SNOW = 16;
const S_GROVE = 17;
const S_FLOOR = 18;
const S_ROCK = 19;

const SEA = SEA_LEVEL;

export class TerrainSampler {
  readonly seed: number;
  private readonly sWarpX: number;
  private readonly sWarpZ: number;
  private readonly sContL: number;
  private readonly sContM: number;
  private readonly sContS: number;
  private readonly sCliff: number;
  private readonly sRug: number;
  private readonly sHill: number;
  private readonly sMtn: number;
  private readonly sRidge: number;
  private readonly sTerrace: number;
  private readonly sDetail: number;
  private readonly sLake: number;
  private readonly sTemp: number;
  private readonly sHumid: number;
  private readonly sSnow: number;
  private readonly sGrove: number;
  private readonly sFloor: number;
  private readonly sRock: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.sWarpX = deriveSeed(s, S_WARP_X);
    this.sWarpZ = deriveSeed(s, S_WARP_Z);
    this.sContL = deriveSeed(s, S_CONT_L);
    this.sContM = deriveSeed(s, S_CONT_M);
    this.sContS = deriveSeed(s, S_CONT_S);
    this.sCliff = deriveSeed(s, S_CLIFF);
    this.sRug = deriveSeed(s, S_RUG);
    this.sHill = deriveSeed(s, S_HILL);
    this.sMtn = deriveSeed(s, S_MTN);
    this.sRidge = deriveSeed(s, S_RIDGE);
    this.sTerrace = deriveSeed(s, S_TERRACE);
    this.sDetail = deriveSeed(s, S_DETAIL);
    this.sLake = deriveSeed(s, S_LAKE);
    this.sTemp = deriveSeed(s, S_TEMP);
    this.sHumid = deriveSeed(s, S_HUMID);
    this.sSnow = deriveSeed(s, S_SNOW);
    this.sGrove = deriveSeed(s, S_GROVE);
    this.sFloor = deriveSeed(s, S_FLOOR);
    this.sRock = deriveSeed(s, S_ROCK);
  }

  /** Continentalness at a column (the land/sea field; also used by the spawn search). */
  continentalness(x: number, z: number): number {
    const wx = x + 70 * fbm2(this.sWarpX, x / 320, z / 320, 3);
    const wz = z + 70 * fbm2(this.sWarpZ, x / 320, z / 320, 3);
    return this.contWarped(wx, wz, x, z);
  }

  /** Continentalness from already-warped coordinates (wx, wz) of column (x, z). */
  private contWarped(wx: number, wz: number, x: number, z: number): number {
    // Large scale = landmass vs open-sea regions; mid = individual islands; small = coast detail.
    // The large weight is kept modest so any ~500-block window stays roughly half sea.
    return (
      0.3 * fbm2(this.sContL, wx / 1100, wz / 1100, 2) +
      0.55 * fbm2(this.sContM, wx / 300, wz / 300, 3) +
      0.17 * fbm2(this.sContS, x / 80, z / 80, 2) +
      0.012
    );
  }

  /** Fill `out` with the column at integer world coordinates (x, z). */
  sample(x: number, z: number, out: ColumnSample): ColumnSample {
    // Domain warp bends coastlines into bays, spits and straits; lakes and ridges share it.
    const wx = x + 70 * fbm2(this.sWarpX, x / 320, z / 320, 3);
    const wz = z + 70 * fbm2(this.sWarpZ, x / 320, z / 320, 3);
    const e = this.contWarped(wx, wz, x, z);

    // Coastal cliffs: where this is high the land jumps up right at the waterline.
    const cliff = smoothstep(0.12, 0.42, fbm2(this.sCliff, x / 260, z / 260, 2));
    // Inland weight: hills, mountains and detail fade out towards the coast so beaches stay flat.
    const inland = smoothstep(0.02, 0.16, e);

    let h: number;
    let mtn = 0;
    let rug = 0;
    if (e < 0) {
      // Sea floor. Continuous with the land branch at e = 0 (both give SEA - 0.5 there).
      const shelf = smoothstep(0, -0.035 + 0.02 * cliff, e);
      const deep = smoothstep(0, -0.3, e);
      const floorNoise = fbm2(this.sFloor, x / 45, z / 45, 2);
      h = SEA - 0.5 - (3.5 + 3 * cliff) * shelf - 25 * deep + 4 * floorNoise * deep;
    } else {
      const gentle = 2.5 * smoothstep(0, 0.05, e) + 30 * (e > 0.03 ? e - 0.03 : 0);
      const steep = 10 * smoothstep(0.002, 0.03, e) + 30 * (e > 0.03 ? e - 0.03 : 0);
      h = SEA - 0.5 + gentle + (steep - gentle) * cliff;

      if (inland > 0) {
        rug = smoothstep(-0.25, 0.45, fbm2(this.sRug, x / 450, z / 450, 2));
        // Rolling hills; valleys are shallower than crests so the land stays above the sea.
        const hn = fbm2(this.sHill, x / 120, z / 120, 3);
        const hillAmp = 6 + 24 * rug;
        h += (hn > 0 ? hn : 0.55 * hn) * hillAmp * inland + 0.25 * hillAmp * inland;

        // Mountain regions: a low-frequency mask, favouring the interiors of landmasses.
        // Weakly tied to continentalness so islands get peaks too, not only deep interiors.
        const mn = fbm2(this.sMtn, x / 520, z / 520, 2) + 0.35 * (e - 0.1);
        mtn = smoothstep(0.04, 0.3, mn) * smoothstep(0.03, 0.15, e);
        if (mtn > 0) {
          // Cubing the ridge field keeps valleys between the ridges (the field averages ~0.6,
          // so a softer curve would lift whole regions into flat-topped massifs).
          const r = ridged2(this.sRidge, wx / 230, wz / 230, 5);
          h += mtn * (6 + 64 * r * r * r);
        }

        // Terrace bands: hillsides broken into flat steps and short cliff walls.
        const tm = smoothstep(0.3, 0.55, fbm2(this.sTerrace, x / 380, z / 380, 2)) * inland * (1 - mtn);
        if (tm > 0 && h > SEA + 3) {
          const step = 7;
          const hs = (h - (SEA + 2)) / step;
          const k = Math.floor(hs);
          const ht = SEA + 2 + (k + smoothstep(0.5, 0.82, hs - k)) * step;
          h += (ht - h) * tm;
        }

        h += fbm2(this.sDetail, x / 26, z / 26, 2) * (1 + 2.2 * rug) * inland;
      }
    }

    // Lake basins: only in lowlands away from mountains; they fill with water up to sea level.
    let lake = 0;
    if (e > 0.05 && h < 70 && mtn < 1) {
      const ln = fbm2(this.sLake, wx / 150, wz / 150, 3);
      lake = smoothstep(0.3, 0.46, ln) * smoothstep(0.05, 0.15, e) * (1 - smoothstep(56, 70, h)) * (1 - mtn);
      if (lake > 0) {
        const floor = SEA - 3 - 7 * smoothstep(0.32, 0.6, ln);
        h += (floor - h) * lake;
      }
    }

    // Soft cap: the rare tallest peaks approach MAX_TERRAIN_Y asymptotically, leaving room
    // for trees and snow. It starts high so ordinary summits keep their shape (no plateaus).
    if (h > CAP_START) {
      const over = h - CAP_START;
      h = CAP_START + (MAX_TERRAIN_Y - CAP_START) * (over / (over + (MAX_TERRAIN_Y - CAP_START)));
    }
    let top = Math.floor(h);
    if (top < MIN_TERRAIN_Y) top = MIN_TERRAIN_Y;

    // ---- climate
    const tempBase = 1.3 * fbm2(this.sTemp, x / 1000, z / 1000, 2) + 0.12;
    // Altitude lapse: conifers take over the upper slopes.
    const temp = tempBase - (top > 62 ? (top - 62) / 55 : 0);
    const humid = 1.3 * fbm2(this.sHumid, x / 700, z / 700, 2);
    const cold = smoothstep(-0.05, -0.38, temp);
    const dry = smoothstep(0.18, 0.42, tempBase) * smoothstep(0.02, -0.25, humid);
    // Snow line from the regional (sea-level) climate: high in warm regions, lower in cold
    // ones. A per-column dither of +-1.5 blocks frays the snow edge.
    const snowLine =
      105 +
      7 * simplex2(this.sSnow, x / 70, z / 70) -
      32 * smoothstep(0.0, -0.45, tempBase) +
      (latticeHash2(this.sSnow, x, z) / 4294967296 - 0.5) * 3;
    const rock =
      smoothstep(84, 100, top) * 0.8 + smoothstep(0.5, 0.8, fbm2(this.sRock, x / 40, z / 40, 2)) * rug * 0.9;

    // ---- biome label
    let biome: BiomeId;
    const water = top < SEA - 1;
    if (water) {
      biome = lake > 0.2 ? BIOME.LAKE : BIOME.SEA;
    } else if (top <= SEA + 2 && (e < 0.08 || lake > 0.15) && dry < 0.5) {
      biome = BIOME.SHORE;
    } else if (top >= 88 && mtn > 0.3) {
      biome = BIOME.PEAKS;
    } else if (cold >= 0.5) {
      biome = BIOME.CONIFER;
    } else if (dry >= 0.5) {
      biome = BIOME.SCRUB;
    } else if (rug > 0.6 && top > SEA + 14) {
      biome = BIOME.HIGHLAND;
    } else if (humid > 0.15) {
      biome = BIOME.BROADLEAF;
    } else {
      biome = BIOME.MEADOW;
    }

    // ---- tree density (probability per tree-grid cell); continuous so forests thin out at edges
    let forest = 0;
    if (!water && top >= SEA) {
      const broad = 0.03 + 0.8 * smoothstep(0.05, 0.38, humid);
      const conif = 0.3 + 0.5 * smoothstep(-0.3, 0.15, humid);
      // Meadows get the occasional grove.
      const grove = smoothstep(0.35, 0.7, simplex2(this.sGrove, x / 70, z / 70)) * 0.45;
      forest = broad + (conif - broad) * cold;
      if (forest < grove) forest = grove;
      forest *= 1 - dry; // no trees in dry scrub
      forest *= 1 - smoothstep(90, 97, top); // tree line
      forest *= 1 - 0.6 * rock;
      // Highlands: open grassy hills with scattered trees.
      forest *= 1 - 0.65 * (1 - 0.6 * cold) * smoothstep(0.5, 0.75, rug) * smoothstep(SEA + 8, SEA + 18, top);
      forest *= smoothstep(SEA + 1, SEA + 4, top); // keep beaches and lake shores open
    }

    out.height = top;
    out.biome = biome;
    out.cont = e;
    out.temp = temp;
    out.humid = humid;
    out.cold = cold;
    out.dry = dry;
    out.forest = forest;
    out.rock = rock;
    out.lake = lake;
    out.snowLine = snowLine;
    return out;
  }
}

/**
 * Column samples for a square of columns: a chunk plus a margin. Struct-of-arrays so the
 * per-cell passes read plain typed arrays. Float64 storage keeps every derived decision
 * bit-identical to a point query through TerrainSampler.sample().
 */
export class ColumnRegion {
  /** Side length in columns. */
  readonly size: number;
  /** World x / z of column index 0. */
  x0 = 0;
  z0 = 0;
  readonly height: Int16Array;
  readonly biome: Uint8Array;
  readonly cont: Float64Array;
  readonly temp: Float64Array;
  readonly humid: Float64Array;
  readonly cold: Float64Array;
  readonly dry: Float64Array;
  readonly forest: Float64Array;
  readonly rock: Float64Array;
  readonly lake: Float64Array;
  readonly snowLine: Float64Array;
  private readonly tmp = createColumnSample();

  constructor(size: number) {
    this.size = size;
    const n = size * size;
    this.height = new Int16Array(n);
    this.biome = new Uint8Array(n);
    this.cont = new Float64Array(n);
    this.temp = new Float64Array(n);
    this.humid = new Float64Array(n);
    this.cold = new Float64Array(n);
    this.dry = new Float64Array(n);
    this.forest = new Float64Array(n);
    this.rock = new Float64Array(n);
    this.lake = new Float64Array(n);
    this.snowLine = new Float64Array(n);
  }

  /** Sample every column of the square whose corner column is (x0, z0). */
  fill(sampler: TerrainSampler, x0: number, z0: number): void {
    this.x0 = x0;
    this.z0 = z0;
    const n = this.size;
    const s = this.tmp;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        sampler.sample(x0 + ix, z0 + iz, s);
        const i = ix + iz * n;
        this.height[i] = s.height;
        this.biome[i] = s.biome;
        this.cont[i] = s.cont;
        this.temp[i] = s.temp;
        this.humid[i] = s.humid;
        this.cold[i] = s.cold;
        this.dry[i] = s.dry;
        this.forest[i] = s.forest;
        this.rock[i] = s.rock;
        this.lake[i] = s.lake;
        this.snowLine[i] = s.snowLine;
      }
    }
  }

  /** Index of world column (x, z); the caller guarantees it lies inside the region. */
  index(x: number, z: number): number {
    return x - this.x0 + (z - this.z0) * this.size;
  }

  contains(x: number, z: number): boolean {
    const ix = x - this.x0;
    const iz = z - this.z0;
    return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size;
  }
}

/** Margin (columns) sampled around a chunk: tree reach (4) + 1 for slope at tree roots. */
export const REGION_MARGIN = 5;
export const REGION_SIZE = CHUNK_SIZE + 2 * REGION_MARGIN;
