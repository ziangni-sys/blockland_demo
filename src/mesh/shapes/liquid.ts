/**
 * Liquids (water, lava): a cell whose top surface is a quad with four corner heights.
 *
 * Cell height h(c) of a cell of the same liquid:
 *   1.0                          when the same liquid is directly above it,
 *   amount / 8 * 14/16           otherwise (source / falling column = 14/16; amount 1..8).
 * Corner height = the average h of the up-to-4 same-liquid cells around the corner, forced
 * to 1.0 when any of them has the same liquid directly above. Neighbouring cells therefore
 * share their corner heights exactly: the surface is watertight across cells and boxes.
 *
 * Wave flag (VFLAG_LIQUID_SURFACE, per vertex): the renderer displaces flagged vertices
 * vertically by a function of world xz only. A vertex is flagged exactly when it lies on a
 * FREE surface: a corner whose height is below 1.0. That covers the top surface's corners
 * and the matching top corners of the side faces, so walls stretch with the surface instead
 * of tearing away from it. Corners forced to 1.0 (where a falling column feeds the layer)
 * and everything on a cell floor stay pinned: those positions are shared with column walls
 * and the faces of the layer below, which must not move. Every pair of coincident liquid
 * vertices therefore carries the same flag, and the liquid stays watertight while it waves.
 *
 * Inside view: every liquid boundary face is double-sided, so it is also visible from inside
 * the liquid (a swimmer looking up into a waterfall, out through a pool's open edge). The
 * inside copy is left out only where the neighbour itself draws a face over that whole
 * plane (tables.SEALS_LIQUID): that face is then what the swimmer sees, and a second,
 * coplanar face would z-fight with it.
 */
import * as cellBits from '../../blocks/cell';
import * as registry from '../../blocks/registry';
import { DIAG_02, DIAG_13, DIAG_AUTO, type MeshContext } from './builder';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, STATE_MASK, STATE_SHIFT, liquidAmount, stateLayers } = cellBits;
const { LIQUID } = registry;
const {
  AVG_LIGHT,
  BASE_FLAGS,
  FACE_CORNER_HI,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_R_AXIS,
  FACE_R_SIGN,
  GROUP,
  INFO,
  INFO_OCCLUDER,
  SEALS_LIQUID,
  SHAPE,
  SH_LAYERS,
  TILE_SLOT,
} = tables;

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
 * True when `cell`, lying across a liquid face, draws its own face d (the one pointing back
 * at the liquid) over that whole shared plane: the liquid then needs no inside copy there.
 */
function sealsFace(cell: number, d: number): boolean {
  const id = cell & ID_MASK;
  if ((SEALS_LIQUID[id]! & (1 << d)) !== 0) return true;
  // A full snow-like stack puts every face on the cell boundary.
  return SHAPE[id] === SH_LAYERS && stateLayers((cell >>> STATE_SHIFT) & STATE_MASK) === 8;
}

function occludes(cells: Uint16Array, q: number): boolean {
  return (INFO[cells[q]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
}

/**
 * Raise top-surface corner k's light (already sampled from the liquid's own layer), per
 * channel, to the average of the layer above around that corner: the surface lies inside
 * its cell but faces the open space above, and must not be darkened by the liquid's own
 * light opacity. `p` is the liquid cell, s1 / s2 the in-layer offsets toward the corner.
 *
 * Neighbouring coplanar quads must compute the same light at a shared corner, or the
 * surface shows a crease. A quad's own above-cell can be opaque while its face is drawn, so
 * sampleVertex's base-relative rules (diagonal exclusion judged from the base, fallback to
 * an opaque base) would light neighbours differently. Here occluders are simply skipped,
 * with no fallback, and the diagonal cell is skipped only when both side cells are walls in
 * BOTH layers — a column sealed off by two diagonal pillars, whose light cannot reach the
 * vertex. That condition never holds between two quads sharing an edge (each is the other's
 * non-opaque own-layer side), so edge-adjacent quads always average exactly the same cells.
 */
function raiseFromLayerAbove(ctx: MeshContext, k: number, p: number, up: number, s1: number, s2: number): void {
  const cells = ctx.cells;
  const light = ctx.light!;
  const a = p + up;
  const o1 = occludes(cells, a + s1);
  const o2 = occludes(cells, a + s2);
  let n = 0;
  let sky = 0;
  let blk = 0;
  let raw: number;
  if (!occludes(cells, a)) {
    raw = light[a]!;
    sky += raw >> 4;
    blk += raw & 15;
    n++;
  }
  if (!o1) {
    raw = light[a + s1]!;
    sky += raw >> 4;
    blk += raw & 15;
    n++;
  }
  if (!o2) {
    raw = light[a + s2]!;
    sky += raw >> 4;
    blk += raw & 15;
    n++;
  }
  const walled = o1 && o2 && occludes(cells, p + s1) && occludes(cells, p + s2);
  if (!walled && !occludes(cells, a + s1 + s2)) {
    raw = light[a + s1 + s2]!;
    sky += raw >> 4;
    blk += raw & 15;
    n++;
  }
  if (n === 0) return;
  const qs = AVG_LIGHT[n * 61 + sky]!;
  const qb = AVG_LIGHT[n * 61 + blk]!;
  if (qs > ctx.qsky[k]!) ctx.qsky[k] = qs;
  if (qb > ctx.qblock[k]!) ctx.qblock[k] = qb;
}

/**
 * Emit a liquid cell: the top surface unless the same liquid is above; side faces toward
 * cells that are neither the same liquid nor covering, from the floor up to the edge's
 * corner heights (flow tile); the bottom face likewise. Every face is double-sided unless
 * the neighbour seals that plane (see the file comment). No AO: a liquid surface has no
 * contact shadows worth the anisotropy they would add.
 */
export function emitLiquid(ctx: MeshContext, ls: LiquidScratch, p: number, x: number, y: number, z: number, id: number): void {
  const cells = ctx.cells;
  const kind = LIQUID[id]!;
  const up = ctx.axisStride[1]!;
  // Visibility first: most liquid cells (the body of a lake or ocean) show no face at all,
  // and the corner heights are only needed for the top and side faces.
  const aboveCell = cells[p + up]!;
  const aboveSame = LIQUID[aboveCell & ID_MASK] === kind;
  let sides = 0;
  for (let j = 0; j < 4; j++) {
    const d = HORIZONTAL[j]!;
    const nid = cells[p + ctx.dirStride[d]!]! & ID_MASK;
    if (LIQUID[nid] !== kind && (INFO[nid]! & (1 << (d ^ 1))) === 0) sides |= 1 << j;
  }
  if (!aboveSame || sides !== 0) emitSurfaceAndSides(ctx, ls, p, x, y, z, id, kind, aboveCell, aboveSame, sides);

  // ---- bottom (on the cell floor: never a free surface, so never wave-flagged)
  const belowCell = cells[p - up]!;
  const belowId = belowCell & ID_MASK;
  if (LIQUID[belowId] !== kind && (INFO[belowId]! & (1 << UP)) === 0) {
    ctx.setBox(0, 0, 0, 1, 1, 1);
    ctx.useUvRect = false;
    ctx.boxFace(ctx.groups[GROUP[id]!]!, p, x, y, z, DOWN, TILE_SLOT[id * 3]!, 0, BASE_FLAGS[id]!, false, !sealsFace(belowCell, UP));
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
  aboveCell: number,
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
      // n >= 1 unless forced: the cell itself is always one of the four. Unforced
      // heights are at most 14/16, so "h < 1" below means exactly "not forced".
      const h = forced ? 1 : sum / n;
      corner[a + 2 * b] = h;
      if (h !== 1) allFull = false;
    }
  }

  // ---- top surface
  const aboveId = aboveCell & ID_MASK;
  const coveredAbove = allFull && (INFO[aboveId]! & (1 << DOWN)) !== 0;
  if (!aboveSame && !coveredAbove) {
    const light = ctx.light;
    let surface = 0;
    for (let k = 0; k < 4; k++) {
      const hi = FACE_CORNER_HI[UP * 4 + k]!;
      const a = hi & 1;
      const b = (hi >> 2) & 1;
      const h = corner[a + 2 * b]!;
      if (h < 1) surface |= 1 << k;
      ctx.setCorner(k, x + a, y + h, z + b, a, 1 - b);
      // Brighter of the own layer and the layer above, per channel. The own-layer sample
      // agrees between quads sharing an edge because its base (the quad's own liquid cell)
      // is never opaque and each such quad is the other's side cell; the layer above is
      // made quad-independent the same way (see raiseFromLayerAbove).
      const s1 = a === 1 ? 1 : -1;
      const s2 = b === 1 ? rowZ : -rowZ;
      ctx.sampleVertex(k, p, s1, s2, false);
      if (light !== null) raiseFromLayerAbove(ctx, k, p, up, s1, s2);
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
    // triangle instead of creasing the whole quad. The back copy uses the same diagonal,
    // so both sides stay exactly coincident.
    const diag = Math.abs(q[1]! - q[7]!) <= Math.abs(q[4]! - q[10]!) ? DIAG_02 : DIAG_13;
    const tile = TILE_SLOT[id * 3]!;
    ctx.commit(g, nx, ny, nz, tile, flags, diag, false, surface);
    // Only a full-height surface lies on the plane of the block above.
    if (!(allFull && sealsFace(aboveCell, DOWN))) ctx.commit(g, -nx, -ny, -nz, tile, flags, diag, true, surface);
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
    let surface = 0;
    for (let k = 0; k < 4; k++) {
      const hi = FACE_CORNER_HI[d * 4 + k]!;
      const a = hi & 1;
      const b = (hi >> 2) & 1;
      const top = (hi & 2) !== 0;
      const h = top ? corner[a + 2 * b]! : 0;
      if (top && h < 1) surface |= 1 << k;
      const cr = ra === 0 ? a : b;
      ctx.setCorner(k, x + a, y + h, z + b, rPos ? cr : 1 - cr, h);
      ctx.sampleVertex(k, nb, cr === 1 ? rStride : -rStride, h === 0 ? -up : h === 1 ? up : 0, false);
    }
    if (sealsFace(cells[nb]!, d ^ 1)) ctx.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, false, surface);
    else ctx.commitDoubleSided(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, surface);
  }
}
