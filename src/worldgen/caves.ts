/**
 * Caves: winding tunnels ("two noise isosurfaces intersect" — where two independent 3D
 * noise fields are both near zero, the intersection is a tube) plus a few large chambers
 * (where a low-frequency 3D fBm exceeds a threshold).
 *
 * The 3D noise is evaluated on a coarse lattice (every LATTICE cells, aligned to WORLD
 * coordinates so neighbouring chunks evaluate the very same lattice points) and
 * interpolated trilinearly. Both fields are folded into one signed "carve density"
 * (negative = carve) before interpolation, so each cell costs one lerp.
 *
 * Constraints enforced here:
 *  - never carve below MIN_CAVE_Y;
 *  - each column has a carve ceiling supplied by the generator (uncarved margin under
 *    water, around tree roots and under loose sand / gravel);
 *  - caves thin out towards the surface except where an "entrance" field lets a few
 *    tunnels break out on dry hillsides;
 *  - cave cells at y <= LAVA_MAX_Y in lava zones fill with lava sources from the floor up.
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
/** Lattice spacing of the cave field. */
const LATTICE = 4;
const LATTICE_SHIFT = 2;
const NX = CHUNK_SIZE / LATTICE + 1; // lattice points across a chunk (inclusive borders)
/** First lattice row (a multiple of LATTICE, at or below MIN_CAVE_Y). */
const Y_BASE = MIN_CAVE_Y & ~(LATTICE - 1);
const MAX_LAYERS = 34; // covers y = Y_BASE .. Y_BASE + 4*33 >= WORLD_HEIGHT

const LAVA = makeCell(B.LAVA, 0);

const S_TUNNEL_A = 201;
const S_TUNNEL_B = 202;
const S_TUNNEL_C = 207;
const S_TUNNEL_D = 208;
const S_CHAMBER = 203;
const S_WIDTH = 204;
const S_ENTRANCE = 205;
const S_LAVA = 206;

export class CaveCarver {
  private readonly sA: number;
  private readonly sB: number;
  private readonly sC: number;
  private readonly sD: number;
  private readonly sChamber: number;
  private readonly sWidth: number;
  private readonly sEntrance: number;
  private readonly sLava: number;
  /** Lattice values, index = ix + iz * NX + iy * NX * NX. */
  private readonly lattice = new Float64Array(NX * NX * MAX_LAYERS);
  /** One column's lattice values after the horizontal (bilinear) pass. */
  private readonly column = new Float64Array(MAX_LAYERS);

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

  /**
   * Carve density at a world point: < 0 inside a cave. Pure function of (seed, x, y, z);
   * exposed for tests. Evaluated only at lattice points during generation.
   */
  density(x: number, y: number, z: number): number {
    // Two tunnel systems at different scales (fine winding passages + long galleries), each
    // from a pair of fields squashed vertically so tunnels run mostly horizontally.
    // Tunnel width breathes slowly along the tunnel.
    const w = 0.1 + 0.04 * simplex3(this.sWidth, x / 90, y / 60, z / 90);
    const a = simplex3(this.sA, x / 46, y / 24, z / 46);
    const b = simplex3(this.sB, x / 46, y / 24, z / 46);
    let tunnel = a * a + b * b - w * w;
    const c = simplex3(this.sC, x / 80, y / 34, z / 80);
    const d = simplex3(this.sD, x / 80, y / 34, z / 80);
    const t2 = c * c + d * d - w * w * 0.8;
    if (t2 < tunnel) tunnel = t2;
    // Chambers: rare, wide and flat, mostly in the middle depths.
    const ch = fbm3(this.sChamber, x / 80, y / 34, z / 80, 2);
    const depthBias = smoothstep(14, 8, y) * 0.25 + smoothstep(40, 58, y) * 0.35;
    const chamber = (0.5 + depthBias - ch) * 0.12;
    return tunnel < chamber ? tunnel : chamber;
  }

  /**
   * Carve the chunk with corner column (x0, z0).
   * @param ceiling per chunk column (lx | lz << 4): highest y that may be carved (exclusive
   *   of nothing: cells with y <= ceiling may go). Use a value < MIN_CAVE_Y to protect a column.
   * @param surface per chunk column: y of the terrain surface (for the surface taper).
   */
  carve(cells: Uint16Array, x0: number, z0: number, ceiling: Int16Array, surface: Int16Array): void {
    let maxCeil = -1;
    for (let i = 0; i < 256; i++) if (ceiling[i]! > maxCeil) maxCeil = ceiling[i]!;
    if (maxCeil < MIN_CAVE_Y) return;
    const layers = ((maxCeil - Y_BASE) >> LATTICE_SHIFT) + 2;

    // 1. Lattice: (NX x NX x layers) density samples at world-aligned points.
    const lat = this.lattice;
    for (let iy = 0; iy < layers; iy++) {
      const y = Y_BASE + iy * LATTICE;
      for (let iz = 0; iz < NX; iz++) {
        for (let ix = 0; ix < NX; ix++) {
          lat[ix + iz * NX + iy * NX * NX] = this.density(x0 + ix * LATTICE, y, z0 + iz * LATTICE);
        }
      }
    }

    const col = this.column;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const ci = lx | (lz << 4);
        const top = ceiling[ci]!;
        if (top < MIN_CAVE_Y) continue;
        const wx = x0 + lx;
        const wz = z0 + lz;
        const surf = surface[ci]!;

        // 2. Bilinear in x/z for every lattice layer this column needs.
        const ix = lx >> LATTICE_SHIFT;
        const iz = lz >> LATTICE_SHIFT;
        const fx = (lx & (LATTICE - 1)) / LATTICE;
        const fz = (lz & (LATTICE - 1)) / LATTICE;
        const colLayers = ((top - Y_BASE) >> LATTICE_SHIFT) + 2;
        for (let iy = 0; iy < colLayers; iy++) {
          const base = ix + iz * NX + iy * NX * NX;
          const v00 = lat[base]!;
          const v10 = lat[base + 1]!;
          const v01 = lat[base + NX]!;
          const v11 = lat[base + NX + 1]!;
          const a = v00 + (v10 - v00) * fx;
          const b = v01 + (v11 - v01) * fx;
          col[iy] = a + (b - a) * fz;
        }

        // Near the surface caves pinch shut unless this is an entrance zone.
        const entrance = smoothstep(0.35, 0.6, simplex2(this.sEntrance, wx / 70, wz / 70));
        const lava = simplex2(this.sLava, wx / 56, wz / 56) > 0.05;

        // 3. Linear in y, carve.
        for (let y = MIN_CAVE_Y; y <= top; y++) {
          const yy = y - Y_BASE;
          const iy = yy >> LATTICE_SHIFT;
          const fy = (yy & (LATTICE - 1)) / LATTICE;
          let d = col[iy]! + (col[iy + 1]! - col[iy]!) * fy;
          const depth = surf - y;
          if (depth < 12) d += (1 - entrance) * 0.012 * (12 - depth) * 0.25;
          if (d >= 0) continue;
          const i = lx | (lz << 4) | (y << 8);
          if (y <= LAVA_MAX_Y && lava) {
            // Fill from the floor up: lava only rests on solid ground or on lava.
            const below = cells[i - 256]!;
            cells[i] = SOLID[below & 0x3ff] === 1 || below === LAVA ? LAVA : 0;
          } else {
            cells[i] = 0;
          }
        }
      }
    }
  }
}
