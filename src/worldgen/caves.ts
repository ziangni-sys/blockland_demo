/**
 * Caves: winding tunnels ("two noise isosurfaces intersect" — where two independent 3D
 * noise fields are both near zero, the intersection is a tube) plus a few large chambers
 * (where a low-frequency 3D fBm exceeds a threshold).
 *
 * Coarse lattice, fine shapes. The six smooth component fields (tunnel pairs a/b and c/d,
 * tunnel width w, chamber fBm) are evaluated on a lattice every LATTICE cells, aligned to
 * WORLD coordinates so neighbouring chunks evaluate the very same lattice points, and
 * interpolated per cell. The tube / chamber fold (squares and a min) is then evaluated PER
 * CELL from the interpolated components. The fold must not be interpolated itself: the
 * tubes are only 2-5 cells thick, thinner than the lattice, and the fold has kinks, so
 * interpolating the folded value loses most of the tunnel volume and leaves cracks, slits
 * and 1x1 shafts aligned to the lattice planes. The components vary over 17-90 cells,
 * which a 4-cell lattice samples well.
 *
 * Constraints enforced here:
 *  - never carve below MIN_CAVE_Y;
 *  - each column has a carve ceiling supplied by the generator (uncarved margin under
 *    water, around tree roots and under loose sand / gravel);
 *  - caves thin out towards the surface except where an "entrance" field lets a few
 *    tunnels break out on dry hillsides;
 *  - carved cells at y <= LAVA_MAX_Y in lava zones fill with lava sources; a column next
 *    to a lava zone keeps its cells at y <= LAVA_MAX_Y uncarved, a stone rim, so no lava
 *    source ever has open cave air beside it (generated lava is at rest).
 */
import { CHUNK_SIZE } from '../core/constants';
import { makeCell } from '../blocks/cell';
import { B } from '../blocks/defs';
import { SOLID } from '../blocks/registry';
import { deriveSeed, fbm3, simplex2, simplex3, smoothstep } from './noise';

/** Lowest y a cave may carve. */
export const MIN_CAVE_Y = 5;
/** Highest y that can hold generated lava. */
export const LAVA_MAX_Y = 10;
/** Lattice spacing of the cave component fields. */
const LATTICE = 4;
const LATTICE_SHIFT = 2;
const NX = CHUNK_SIZE / LATTICE + 1; // lattice points across a chunk (inclusive borders)
/** First lattice row (a multiple of LATTICE, at or below MIN_CAVE_Y). */
const Y_BASE = MIN_CAVE_Y & ~(LATTICE - 1);
const MAX_LAYERS = 34; // covers y = Y_BASE .. Y_BASE + 4*33 >= WORLD_HEIGHT
/** Component fields per lattice point. */
const F_A = 0;
const F_B = 1;
const F_C = 2;
const F_D = 3;
const F_W = 4;
const F_CH = 5;
const FIELDS = 6;
/** Depth (cells below the surface) over which caves pinch shut outside entrance zones. */
const TAPER_DEPTH = 12;
/** Side of the lava-flag grid: the chunk plus one column on each side. */
const LAVA_GRID = CHUNK_SIZE + 2;

const LAVA = makeCell(B.LAVA, 0);

const S_TUNNEL_A = 201;
const S_TUNNEL_B = 202;
const S_TUNNEL_C = 207;
const S_TUNNEL_D = 208;
const S_CHAMBER = 203;
const S_WIDTH = 204;
const S_ENTRANCE = 205;
const S_LAVA = 206;

/** Chamber bias by height: chambers favour the middle depths. */
function depthBias(y: number): number {
  return smoothstep(14, 8, y) * 0.25 + smoothstep(40, 58, y) * 0.35;
}
/** depthBias for every integer y (immutable lookup table). */
const DEPTH_BIAS: Float64Array = (() => {
  const t = new Float64Array(MAX_LAYERS * LATTICE + Y_BASE + 1);
  for (let y = 0; y < t.length; y++) t[y] = depthBias(y);
  return t;
})();

/** The tube / chamber fold of the component fields: < 0 inside a cave. */
function fold(a: number, b: number, c: number, d: number, w: number, ch: number, bias: number): number {
  // Two tunnel systems at different scales (fine winding passages + long galleries).
  let tunnel = a * a + b * b - w * w;
  const t2 = c * c + d * d - w * w * 0.8;
  if (t2 < tunnel) tunnel = t2;
  // Chambers: rare, wide and flat.
  const chamber = (0.5 + bias - ch) * 0.12;
  return tunnel < chamber ? tunnel : chamber;
}

/** Added to the density near the surface so tunnels close up unless `entrance` is 1. */
function taper(depth: number, entrance: number): number {
  return depth < TAPER_DEPTH ? (1 - entrance) * 0.003 * (TAPER_DEPTH - depth) : 0;
}

/**
 * Bilinear interpolation of all component fields of one lattice layer.
 * `lat[base]` is the (-x, -z) corner; `dx` / `dz` are the offsets to the +x / +z corners.
 * Shared by the chunk path and the point path so both produce bit-identical values.
 */
function bilerpLayer(
  lat: Float64Array,
  base: number,
  dx: number,
  dz: number,
  fx: number,
  fz: number,
  out: Float64Array,
  o: number,
): void {
  for (let f = 0; f < FIELDS; f++) {
    const v00 = lat[base + f]!;
    const v10 = lat[base + dx + f]!;
    const v01 = lat[base + dz + f]!;
    const v11 = lat[base + dx + dz + f]!;
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    out[o + f] = a + (b - a) * fz;
  }
}

/** Interpolate one column's layer values in y and fold: the raw carve density of cell y. */
function columnDensity(col: Float64Array, y: number): number {
  const yy = y - Y_BASE;
  const i0 = (yy >> LATTICE_SHIFT) * FIELDS;
  const i1 = i0 + FIELDS;
  const fy = (yy & (LATTICE - 1)) / LATTICE;
  const a = col[i0 + F_A]! + (col[i1 + F_A]! - col[i0 + F_A]!) * fy;
  const b = col[i0 + F_B]! + (col[i1 + F_B]! - col[i0 + F_B]!) * fy;
  const c = col[i0 + F_C]! + (col[i1 + F_C]! - col[i0 + F_C]!) * fy;
  const d = col[i0 + F_D]! + (col[i1 + F_D]! - col[i0 + F_D]!) * fy;
  const w = col[i0 + F_W]! + (col[i1 + F_W]! - col[i0 + F_W]!) * fy;
  const ch = col[i0 + F_CH]! + (col[i1 + F_CH]! - col[i0 + F_CH]!) * fy;
  return fold(a, b, c, d, w, ch, DEPTH_BIAS[y]!);
}

export class CaveCarver {
  private readonly sA: number;
  private readonly sB: number;
  private readonly sC: number;
  private readonly sD: number;
  private readonly sChamber: number;
  private readonly sWidth: number;
  private readonly sEntrance: number;
  private readonly sLava: number;
  /** Chunk lattice, index ((iy * NX + iz) * NX + ix) * FIELDS + field. */
  private readonly lattice = new Float64Array(NX * NX * MAX_LAYERS * FIELDS);
  /** One column's layer values after the horizontal pass, index iy * FIELDS + field. */
  private readonly column = new Float64Array(MAX_LAYERS * FIELDS);
  /** Lava-zone flag of the chunk's columns plus a 1-column ring, index (lx+1) + (lz+1)*LAVA_GRID. */
  private readonly lavaFlags = new Uint8Array(LAVA_GRID * LAVA_GRID);
  // ---- point-query scratch: 4 lattice corners per layer, and the column built from them
  private readonly pointLattice = new Float64Array(MAX_LAYERS * 4 * FIELDS);
  private readonly pointColumn = new Float64Array(MAX_LAYERS * FIELDS);
  private readonly pointLayerReady = new Uint8Array(MAX_LAYERS);
  private readonly pointFields = new Float64Array(FIELDS);

  constructor(seed: number) {
    this.sA = deriveSeed(seed, S_TUNNEL_A);
    this.sB = deriveSeed(seed, S_TUNNEL_B);
    this.sC = deriveSeed(seed, S_TUNNEL_C);
    this.sD = deriveSeed(seed, S_TUNNEL_D);
    this.sChamber = deriveSeed(seed, S_CHAMBER);
    this.sWidth = deriveSeed(seed, S_WIDTH);
    this.sEntrance = deriveSeed(seed, S_ENTRANCE);
    this.sLava = deriveSeed(seed, S_LAVA);
  }

  /** Write the component fields at world point (x, y, z) into out[o .. o + FIELDS). */
  private fields(x: number, y: number, z: number, out: Float64Array, o: number): void {
    // Each tunnel pair is squashed vertically so tunnels run mostly horizontally; the
    // tunnel width breathes slowly along the tunnel.
    out[o + F_A] = simplex3(this.sA, x / 46, y / 24, z / 46);
    out[o + F_B] = simplex3(this.sB, x / 46, y / 24, z / 46);
    out[o + F_C] = simplex3(this.sC, x / 80, y / 34, z / 80);
    out[o + F_D] = simplex3(this.sD, x / 80, y / 34, z / 80);
    out[o + F_W] = 0.088 + 0.035 * simplex3(this.sWidth, x / 90, y / 60, z / 90);
    out[o + F_CH] = fbm3(this.sChamber, x / 80, y / 34, z / 80, 2);
  }

  /**
   * Exact carve density at a world point (< 0 inside a cave), before the surface taper and
   * the column ceilings. Generation evaluates the same fold on lattice-interpolated
   * components, which follows this closely (a reference for tests and tools).
   */
  density(x: number, y: number, z: number): number {
    const f = this.pointFields;
    this.fields(x, y, z, f, 0);
    return fold(f[F_A]!, f[F_B]!, f[F_C]!, f[F_D]!, f[F_W]!, f[F_CH]!, depthBias(y));
  }

  /** 0..1: how freely tunnels may break the surface at column (x, z). */
  private entrance(x: number, z: number): number {
    return smoothstep(0.4, 0.65, simplex2(this.sEntrance, x / 70, z / 70));
  }

  /** Is column (x, z) inside a lava zone? */
  private lavaZone(x: number, z: number): boolean {
    return simplex2(this.sLava, x / 56, z / 56) > 0.05;
  }

  /**
   * Carve the chunk with corner column (x0, z0).
   * @param ceiling per chunk column (lx | lz << 4): highest y that may be carved
   *   (inclusive). A value below MIN_CAVE_Y protects the whole column.
   * @param surface per chunk column: y of the terrain surface (for the surface taper).
   */
  carve(cells: Uint16Array, x0: number, z0: number, ceiling: Int16Array, surface: Int16Array): void {
    let maxCeil = -1;
    for (let i = 0; i < 256; i++) if (ceiling[i]! > maxCeil) maxCeil = ceiling[i]!;
    if (maxCeil < MIN_CAVE_Y) return;
    const layers = ((maxCeil - Y_BASE) >> LATTICE_SHIFT) + 2;

    // 1. Lattice: NX x NX x layers points at world-aligned positions.
    const lat = this.lattice;
    for (let iy = 0; iy < layers; iy++) {
      const y = Y_BASE + iy * LATTICE;
      for (let iz = 0; iz < NX; iz++) {
        for (let ix = 0; ix < NX; ix++) {
          this.fields(x0 + ix * LATTICE, y, z0 + iz * LATTICE, lat, ((iy * NX + iz) * NX + ix) * FIELDS);
        }
      }
    }

    // 2. Lava zones of the chunk and the ring around it (for the rims).
    const lavaFlags = this.lavaFlags;
    for (let gz = 0; gz < LAVA_GRID; gz++) {
      for (let gx = 0; gx < LAVA_GRID; gx++) {
        lavaFlags[gx + gz * LAVA_GRID] = this.lavaZone(x0 + gx - 1, z0 + gz - 1) ? 1 : 0;
      }
    }

    const col = this.column;
    const dX = FIELDS;
    const dZ = NX * FIELDS;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lx | (lz << 4);
        const top = ceiling[ci]!;
        if (top < MIN_CAVE_Y) continue;
        const surf = surface[ci]!;

        // 3. Horizontal pass for every lattice layer this column needs.
        const ix = lx >> LATTICE_SHIFT;
        const iz = lz >> LATTICE_SHIFT;
        const fx = (lx & (LATTICE - 1)) / LATTICE;
        const fz = (lz & (LATTICE - 1)) / LATTICE;
        const colLayers = ((top - Y_BASE) >> LATTICE_SHIFT) + 2;
        for (let iy = 0; iy < colLayers; iy++) {
          bilerpLayer(lat, ((iy * NX + iz) * NX + ix) * FIELDS, dX, dZ, fx, fz, col, iy * FIELDS);
        }

        const entrance = this.entrance(x0 + lx, z0 + lz);
        const g = lx + 1 + (lz + 1) * LAVA_GRID;
        const lava = lavaFlags[g] === 1;
        const rim =
          !lava &&
          (lavaFlags[g - 1] === 1 ||
            lavaFlags[g + 1] === 1 ||
            lavaFlags[g - LAVA_GRID] === 1 ||
            lavaFlags[g + LAVA_GRID] === 1);

        // 4. Per cell: vertical interpolation, fold, taper, carve.
        for (let y = rim ? LAVA_MAX_Y + 1 : MIN_CAVE_Y; y <= top; y++) {
          if (columnDensity(col, y) + taper(surf - y, entrance) >= 0) continue;
          const i = lx | (lz << 4) | (y << 8);
          if (y <= LAVA_MAX_Y && lava) {
            // Fill from the floor up: lava only rests on solid ground or on lava. (The first
            // carved cell sits on an uncarved one, so in practice this is always lava.)
            const below = cells[i - 256]!;
            cells[i] = SOLID[below & 0x3ff] === 1 || below === LAVA ? LAVA : 0;
          } else {
            cells[i] = 0;
          }
        }
      }
    }
  }

  /**
   * Would generation carve cell (x, y, z) if the column's ceiling allowed it? `surface` is
   * the column's terrain surface y (for the taper). Bit-identical to the chunk path.
   * Ignores the lava rim (see topUncarved).
   */
  carvesIgnoringCeiling(x: number, y: number, z: number, surface: number): boolean {
    if (y < MIN_CAVE_Y) return false;
    this.beginPoint();
    return this.pointDensity(x, y, z) + taper(surface - y, this.entrance(x, z)) < 0;
  }

  /**
   * The highest y <= `from` of column (x, z) that generation leaves uncarved (any cell
   * above it down to `from` is cave air or lava). Mirrors carve() exactly.
   * @param surface terrain surface y of the column (taper)
   * @param ceiling the column's carve ceiling (as passed to carve())
   */
  topUncarved(x: number, z: number, from: number, surface: number, ceiling: number): number {
    this.beginPoint();
    const entrance = this.entrance(x, z);
    let rimKnown = false;
    let rim = false;
    for (let y = from; ; y--) {
      if (y > ceiling || y < MIN_CAVE_Y) return y;
      if (y <= LAVA_MAX_Y) {
        if (!rimKnown) {
          rimKnown = true;
          rim =
            !this.lavaZone(x, z) &&
            (this.lavaZone(x - 1, z) || this.lavaZone(x + 1, z) || this.lavaZone(x, z - 1) || this.lavaZone(x, z + 1));
        }
        if (rim) return y;
      }
      if (this.pointDensity(x, y, z) + taper(surface - y, entrance) >= 0) return y;
    }
  }

  private beginPoint(): void {
    this.pointLayerReady.fill(0);
  }

  /** Lattice-interpolated raw density of one cell, as carve() computes it. */
  private pointDensity(x: number, y: number, z: number): number {
    const iy = (y - Y_BASE) >> LATTICE_SHIFT;
    this.pointLayer(x, z, iy);
    this.pointLayer(x, z, iy + 1);
    return columnDensity(this.pointColumn, y);
  }

  /** Build lattice layer iy of the point column at (x, z) if not done for this query. */
  private pointLayer(x: number, z: number, iy: number): void {
    if (this.pointLayerReady[iy] === 1) return;
    this.pointLayerReady[iy] = 1;
    // Same world-aligned lattice points and the same fractions as the chunk path (chunk
    // corners are multiples of 16, so x & 3 equals the chunk-local lx & 3).
    const gx = x - (x & (LATTICE - 1));
    const gz = z - (z & (LATTICE - 1));
    const y = Y_BASE + iy * LATTICE;
    const pl = this.pointLattice;
    const base = iy * 4 * FIELDS;
    this.fields(gx, y, gz, pl, base);
    this.fields(gx + LATTICE, y, gz, pl, base + FIELDS);
    this.fields(gx, y, gz + LATTICE, pl, base + 2 * FIELDS);
    this.fields(gx + LATTICE, y, gz + LATTICE, pl, base + 3 * FIELDS);
    const fx = (x & (LATTICE - 1)) / LATTICE;
    const fz = (z & (LATTICE - 1)) / LATTICE;
    bilerpLayer(pl, base, FIELDS, 2 * FIELDS, fx, fz, this.pointColumn, iy * FIELDS);
  }
}
