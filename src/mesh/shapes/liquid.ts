/**
 * Liquids (water, lava): a cell whose top surface is a quad with four corner heights.
 *
 * Cell height h(c) of a cell of the same liquid:
 *   1.0                          when the same liquid is directly above it,
 *   amount / 8 * 14/16           otherwise (source / falling column = 14/16; amount 1..8).
 * Corner height = the average h of the up-to-4 same-liquid cells around the corner, forced
 * to 1.0 when any of them has the same liquid directly above. Neighbouring cells therefore
 * share their corner heights exactly: the surface is watertight across cells and boxes.
 */
import * as cellBits from '../../blocks/cell';
import * as registry from '../../blocks/registry';
import { VFLAG_LIQUID_SURFACE } from '../types';
import { DIAG_02, DIAG_13, DIAG_AUTO, type MeshContext } from './builder';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, STATE_MASK, STATE_SHIFT, liquidAmount } = cellBits;
const { LIQUID } = registry;
const { BASE_FLAGS, FACE_CORNER_HI, FACE_NX, FACE_NY, FACE_NZ, FACE_R_AXIS, FACE_R_SIGN, GROUP, INFO, TILE_SLOT } = tables;

/** Surface height of a full (source or falling) cell with open sky above it. */
export const LIQUID_FULL_HEIGHT = 14 / 16;

/** Neighbourhood marker: the cell is not this liquid. */
const NOT_LIQUID = -1;
/** Neighbourhood marker: this liquid with the same liquid above (forces corners to 1). */
const FED_FROM_ABOVE = 2;

const UP = 2;
const DOWN = 3;
const HORIZONTAL: readonly number[] = [0, 1, 4, 5];

/**
 * Per-context scratch for the liquid emitter (3x3 neighbourhood heights + 4 corner
 * heights). Kept off the module so emitLiquid stays free of shared mutable state.
 */
export class LiquidScratch {
  readonly near = new Float64Array(9);
  /** Corner heights, index a + 2b for the corner at (x + a, z + b). */
  readonly corner = new Float64Array(4);
}

/** Height of the cell at padded index q for the neighbourhood table (see file comment), or a marker. */
function cellHeight(cells: Uint16Array, q: number, kind: number, up: number): number {
  const c = cells[q]!;
  if (LIQUID[c & ID_MASK] !== kind) return NOT_LIQUID;
  if (LIQUID[cells[q + up]! & ID_MASK] === kind) return FED_FROM_ABOVE;
  return (liquidAmount((c >>> STATE_SHIFT) & STATE_MASK) / 8) * LIQUID_FULL_HEIGHT;
}

/**
 * Emit a liquid cell: the top surface (double-sided, VFLAG_LIQUID_SURFACE) unless the same
 * liquid is above; side faces toward cells that are neither the same liquid nor covering,
 * from the floor up to the edge's corner heights (flow tile); the bottom face likewise.
 * No AO: a liquid surface has no contact shadows worth the anisotropy they would add.
 */
export function emitLiquid(ctx: MeshContext, ls: LiquidScratch, p: number, x: number, y: number, z: number, id: number): void {
  const cells = ctx.cells;
  const kind = LIQUID[id]!;
  const up = ctx.axisStride[1]!;
  // Visibility first: most liquid cells (the body of a lake or ocean) show no face at all,
  // and the corner heights are only needed for the top and side faces.
  const aboveId = cells[p + up]! & ID_MASK;
  const aboveSame = LIQUID[aboveId] === kind;
  let sides = 0;
  for (let j = 0; j < 4; j++) {
    const d = HORIZONTAL[j]!;
    const nid = cells[p + ctx.dirStride[d]!]! & ID_MASK;
    if (LIQUID[nid] !== kind && (INFO[nid]! & (1 << (d ^ 1))) === 0) sides |= 1 << j;
  }
  if (!aboveSame || sides !== 0) emitSurfaceAndSides(ctx, ls, p, x, y, z, id, kind, aboveId, aboveSame, sides);

  // ---- bottom
  const belowId = cells[p - up]! & ID_MASK;
  if (LIQUID[belowId] !== kind && (INFO[belowId]! & (1 << UP)) === 0) {
    ctx.setBox(0, 0, 0, 1, 1, 1);
    ctx.useUvRect = false;
    ctx.boxFace(ctx.groups[GROUP[id]!]!, p, x, y, z, DOWN, TILE_SLOT[id * 3]!, 0, BASE_FLAGS[id]!, false);
  }
}

/** Top surface (unless the same liquid is above) and the side faces flagged in `sides` (bit j = HORIZONTAL[j]). */
function emitSurfaceAndSides(
  ctx: MeshContext,
  ls: LiquidScratch,
  p: number,
  x: number,
  y: number,
  z: number,
  id: number,
  kind: number,
  aboveId: number,
  aboveSame: boolean,
  sides: number,
): void {
  const cells = ctx.cells;
  const up = ctx.axisStride[1]!;
  const rowZ = ctx.axisStride[2]!;
  const g = ctx.groups[GROUP[id]!]!;
  const flags = BASE_FLAGS[id]!;
  const near = ls.near;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      near[dx + 1 + (dz + 1) * 3] = cellHeight(cells, p + dx + dz * rowZ, kind, up);
    }
  }
  const corner = ls.corner;
  let allFull = true;
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 2; a++) {
      // Cells around corner (x + a, z + b): dx in {a-1, a}, dz in {b-1, b}.
      let sum = 0;
      let n = 0;
      let forced = false;
      for (let j = 0; j < 4; j++) {
        const h = near[a + (j & 1) + (b + (j >> 1)) * 3]!;
        if (h === NOT_LIQUID) continue;
        if (h === FED_FROM_ABOVE) {
          forced = true;
          break;
        }
        sum += h;
        n++;
      }
      // n >= 1 unless forced: the cell itself is always one of the four.
      const h = forced ? 1 : sum / n;
      corner[a + 2 * b] = h;
      if (h !== 1) allFull = false;
    }
  }

  // ---- top surface
  const coveredAbove = allFull && (INFO[aboveId]! & (1 << DOWN)) !== 0;
  if (!aboveSame && !coveredAbove) {
    const qsky = ctx.qsky;
    const qblock = ctx.qblock;
    for (let k = 0; k < 4; k++) {
      const hi = FACE_CORNER_HI[UP * 4 + k]!;
      const a = hi & 1;
      const b = (hi >> 2) & 1;
      const h = corner[a + 2 * b]!;
      ctx.setCorner(k, x + a, y + h, z + b, a, 1 - b);
      // The surface sits inside the cell but faces the open space above it: take the
      // brighter of the cell's own layer and the layer above, per channel, so a surface
      // is not darkened by the liquid's own light opacity.
      const s1 = a === 1 ? 1 : -1;
      const s2 = b === 1 ? rowZ : -rowZ;
      ctx.sampleVertex(k, p, s1, s2, false);
      const sky0 = qsky[k]!;
      const blk0 = qblock[k]!;
      ctx.sampleVertex(k, p + up, s1, s2, false);
      if (sky0 > qsky[k]!) qsky[k] = sky0;
      if (blk0 > qblock[k]!) qblock[k] = blk0;
    }
    // Normal of the (possibly non-planar) quad: cross product of its diagonals.
    const q = ctx.qpos;
    const ax = q[6]! - q[0]!;
    const ay = q[7]! - q[1]!;
    const az = q[8]! - q[2]!;
    const bx = q[9]! - q[3]!;
    const by = q[10]! - q[4]!;
    const bz = q[11]! - q[5]!;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const s = 127 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx = Math.round(nx * s);
    ny = Math.round(ny * s);
    nz = Math.round(nz * s);
    // Fold along the flatter diagonal, so a lone low or high corner stays confined to one
    // triangle instead of creasing the whole quad.
    const h0 = q[1]!;
    const h1 = q[4]!;
    const h2 = q[7]!;
    const h3 = q[10]!;
    const diag = Math.abs(h0 - h2) <= Math.abs(h1 - h3) ? DIAG_02 : DIAG_13;
    ctx.commitDoubleSided(g, nx, ny, nz, TILE_SLOT[id * 3]!, flags | VFLAG_LIQUID_SURFACE, diag);
  }

  // ---- sides: down to the cell floor, up to the two corner heights of that edge
  const flow = TILE_SLOT[id * 3 + 1]!;
  for (let j = 0; j < 4; j++) {
    if ((sides & (1 << j)) === 0) continue;
    const d = HORIZONTAL[j]!;
    const nb = p + ctx.dirStride[d]!;
    const ra = FACE_R_AXIS[d]!;
    const rStride = ctx.axisStride[ra]!;
    const rPos = FACE_R_SIGN[d]! > 0;
    for (let k = 0; k < 4; k++) {
      const hi = FACE_CORNER_HI[d * 4 + k]!;
      const a = hi & 1;
      const b = (hi >> 2) & 1;
      const top = (hi & 2) !== 0;
      const h = top ? corner[a + 2 * b]! : 0;
      const cr = ra === 0 ? a : b;
      ctx.setCorner(k, x + a, y + h, z + b, rPos ? cr : 1 - cr, h);
      ctx.sampleVertex(k, nb, cr === 1 ? rStride : -rStride, h === 0 ? -up : h === 1 ? up : 0, false);
    }
    ctx.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, false);
  }
}
