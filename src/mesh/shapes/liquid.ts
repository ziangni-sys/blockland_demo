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
 *
 * Partial neighbours (docs/SHAPES.md 8.4). A cell with parts is never a liquid cell, but it can lie
 * across any liquid face, and then both copies of that face are decided per quadrant with two 4-bit
 * masks, the quadrant numbering of blocks/shapes.ts FACE_COVER, d' the neighbour's face toward the
 * liquid:
 *   outward copy   drawn where opaqueCover(neighbour, d') is 0 (its opaque octants);
 *   inside copy    drawn where sealCover(neighbour, d') is 0: the quadrants on which the neighbour
 *                  has no part at all (every cut material is a cube and draws its own face there,
 *                  so an inside copy would be coplanar with it). For a neighbour without parts the
 *                  seal mask is 15 or 0 by SEALS_LIQUID / sealsFace, exactly as before.
 * The bottom and a flat (full-height) top are cut into their four quadrants. A side face is the
 * area under the line through its two top corners. When both of its halves keep the same quadrants
 * (a lower or an upper slab beside it) it is clipped once, at y = 0.5; otherwise it is split at its
 * horizontal midpoint (the midpoint height interpolated) and each half is clipped at y = 0.5 where
 * only one of its quadrants is kept (see clipSide). No existing vertex moves; new vertices lie on
 * u = 0.5 or y = 0.5 and take linearly interpolated attributes (position, uv, light; a new vertex on
 * the top edge is wave-flagged when both top corners are). A clipped piece with three corners is
 * emitted as a quad whose last two corners coincide (one zero-area triangle), since all geometry is
 * quads.
 */
import * as cellBits from '../../blocks/cell';
import * as registry from '../../blocks/registry';
import * as blockShapes from '../../blocks/shapes';
import { DIAG_02, DIAG_13, DIAG_AUTO, type GeometryBuilder, type MeshContext } from './builder';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, STATE_MASK, STATE_SHIFT, liquidAmount, stateLayers } = cellBits;
const { LIQUID } = registry;
const { FACE_COVER } = blockShapes;
const {
  AVG_LIGHT,
  BASE_FLAGS,
  CORNER_U,
  CORNER_V,
  FACE_CORNER_HI,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_R_AXIS,
  FACE_R_SIGN,
  FACE_U_AXIS,
  FACE_U_SIGN,
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
  private clipStore: ClipScratch | null = null;

  /** Scratch for cutting faces against partial cells, made the first time one is needed. */
  clip(): ClipScratch {
    return (this.clipStore ??= new ClipScratch());
  }
}

/** Scratch of clipFlat / clipSide: a whole face's quad saved before it is cut, and one clipped piece. */
class ClipScratch {
  readonly pos = new Float64Array(12);
  readonly uv = new Float64Array(8);
  readonly sky = new Float64Array(4);
  readonly block = new Float64Array(4);
  surface = 0;
  // One clipped side piece: up to 5 vertices (frame u, height y, on the top edge), and the clipper's output.
  readonly pu = new Float64Array(6);
  readonly py = new Float64Array(6);
  readonly ptop = new Uint8Array(6);
  readonly qu = new Float64Array(6);
  readonly qy = new Float64Array(6);
  readonly qtop = new Uint8Array(6);
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

/** The cell at padded index q is opaque as a whole (an OPAQUE id; in a layered job, eight opaque octants). */
function occludes(ctx: MeshContext, q: number): boolean {
  if (ctx.layered) return ctx.opq[q] === 0xff;
  return (INFO[ctx.cells[q]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
}

/** Quadrants of face d covered by the octants `fill` of the cell behind it (blocks/shapes.ts faceCover). */
function cover(fill: number, d: number): number {
  return (FACE_COVER[fill]! >>> (d * 4)) & 15;
}

/**
 * sealCover (docs/SHAPES.md 8.4) of the cell at padded index q toward its face d: for a partial
 * cell the quadrants its parts cover; otherwise 15 when it seals that plane (sealsFace), else 0.
 */
function sealCover(ctx: MeshContext, q: number, d: number): number {
  if (ctx.layered && ctx.partial[q] !== 0) return cover(ctx.partsFill(q), d);
  return sealsFace(ctx.cells[q]!, d) ? 15 : 0;
}

/**
 * Quadrant number (blocks/shapes.ts 2.3: bit 0 the half along the lower-numbered tangent axis) of
 * the part of face d that lies in the half `hr` along the face's R axis and `hu` along its U axis
 * (halves counted in absolute coordinates: 0 low, 1 high).
 */
function quadrantOf(d: number, hr: number, hu: number): number {
  return FACE_R_AXIS[d]! < FACE_U_AXIS[d]! ? hr | (hu << 1) : hu | (hr << 1);
}

/** Save the context's scratch quad (positions, uvs, light) and its wave-flag mask into the liquid scratch. */
function saveQuad(ctx: MeshContext, ls: ClipScratch, surface: number): void {
  ls.pos.set(ctx.qpos);
  ls.uv.set(ctx.quv);
  for (let k = 0; k < 4; k++) {
    ls.sky[k] = ctx.qsky[k]!;
    ls.block[k] = ctx.qblock[k]!;
  }
  ls.surface = surface;
}

/** Saved corner of a face at frame position (u, v) in {0,1}^2 (u along R, v along U). */
function frameCorner(u: number, v: number): number {
  for (let k = 0; k < 4; k++) if (CORNER_U[k] === u && CORNER_V[k] === v) return k;
  return 0;
}
const C00 = frameCorner(0, 0);
const C10 = frameCorner(1, 0);
const C11 = frameCorner(1, 1);
const C01 = frameCorner(0, 1);

/** Bilinear interpolation of saved per-corner values at frame position (u, v). */
function bilerp(a: Float64Array, stride: number, off: number, u: number, v: number): number {
  return (
    (1 - u) * (1 - v) * a[C00 * stride + off]! +
    u * (1 - v) * a[C10 * stride + off]! +
    u * v * a[C11 * stride + off]! +
    (1 - u) * v * a[C01 * stride + off]!
  );
}

/**
 * A flat face (the bottom, or a full-height top) whose whole quad is saved in `ls`: emit the
 * quadrants of `mask` (all of it as the saved quad when mask is 15), as the front copy or as the
 * back copy (`reverse`). Quadrant corners are bilinear in the saved corners; AO stays open.
 */
function clipFlat(ctx: MeshContext, ls: ClipScratch, g: GeometryBuilder, d: number, mask: number, reverse: boolean, nx: number, ny: number, nz: number, tile: number, flags: number, diag: number): void {
  if (mask === 0) return;
  const sgn = reverse ? -1 : 1;
  if (mask === 15) {
    restoreQuad(ctx, ls, 0, 0, 1);
    ctx.commit(g, sgn * nx, sgn * ny, sgn * nz, tile, flags, diag, reverse, 0);
    return;
  }
  const rPos = FACE_R_SIGN[d]! > 0;
  const uPos = FACE_U_SIGN[d]! > 0;
  for (let fv = 0; fv < 2; fv++) {
    for (let fu = 0; fu < 2; fu++) {
      const q = quadrantOf(d, rPos ? fu : 1 - fu, uPos ? fv : 1 - fv);
      if (((mask >> q) & 1) === 0) continue;
      restoreQuad(ctx, ls, fu * 0.5, fv * 0.5, 0.5);
      ctx.commit(g, sgn * nx, sgn * ny, sgn * nz, tile, flags, diag, reverse, 0);
    }
  }
}

/** Fill the context's scratch quad with the frame square [u0, u0+s] x [v0, v0+s] of the saved quad. */
function restoreQuad(ctx: MeshContext, ls: ClipScratch, u0: number, v0: number, size: number): void {
  for (let k = 0; k < 4; k++) {
    const u = u0 + CORNER_U[k]! * size;
    const v = v0 + CORNER_V[k]! * size;
    for (let a = 0; a < 3; a++) ctx.qpos[k * 3 + a] = bilerp(ls.pos, 3, a, u, v);
    ctx.quv[k * 2] = bilerp(ls.uv, 2, 0, u, v);
    ctx.quv[k * 2 + 1] = bilerp(ls.uv, 2, 1, u, v);
    ctx.qsky[k] = Math.round(bilerp(ls.sky, 1, 0, u, v));
    ctx.qblock[k] = Math.round(bilerp(ls.block, 1, 0, u, v));
    ctx.qao[k] = 255;
  }
}

/**
 * A side face whose whole quad is saved in `ls` (frame: u along R, v up; top corner heights hl at
 * u = 0 and hr at u = 1, cell-local): emit the part of it lying in the quadrants of `mask`, as the
 * front copy or the back copy (`reverse`).
 *
 * When the two halves u in [0, 0.5] and [0.5, 1] keep the same quadrants (a lower or an upper slab
 * beside the liquid: lower quadrants only, or upper quadrants only), the whole face, the area under
 * its top line, is clipped once at y = 0.5. Its top edge then keeps exactly its two original
 * corners (plus, where the top line crosses y = 0.5, the end of the clip), as the unclipped face
 * and the top surface have: a vertex in the middle of the top edge would stay put while the
 * surface beside it waves when only one top corner is wave-flagged. Otherwise each half is the
 * trapezoid under the top line (the midpoint height interpolated), clipped at y = 0.5 when only one
 * of its two quadrants is drawn.
 */
function clipSide(ctx: MeshContext, ls: ClipScratch, g: GeometryBuilder, d: number, mask: number, reverse: boolean, hl: number, hr: number, tile: number, flags: number): void {
  if (mask === 0) return;
  const nx = reverse ? -FACE_NX[d]! : FACE_NX[d]!;
  const ny = reverse ? -FACE_NY[d]! : FACE_NY[d]!;
  const nz = reverse ? -FACE_NZ[d]! : FACE_NZ[d]!;
  if (mask === 15) {
    restoreQuad(ctx, ls, 0, 0, 1);
    ctx.commit(g, nx, ny, nz, tile, flags, DIAG_AUTO, reverse, ls.surface);
    return;
  }
  const rPos = FACE_R_SIGN[d]! > 0;
  // Lower and upper quadrant of each half (half 0 is u in [0, 0.5]; u runs along R).
  const lower0 = (mask >> quadrantOf(d, rPos ? 0 : 1, 0)) & 1;
  const upper0 = (mask >> quadrantOf(d, rPos ? 0 : 1, 1)) & 1;
  const lower1 = (mask >> quadrantOf(d, rPos ? 1 : 0, 0)) & 1;
  const upper1 = (mask >> quadrantOf(d, rPos ? 1 : 0, 1)) & 1;
  if (lower0 === lower1 && upper0 === upper1) {
    // Equal halves and a mask that is neither 0 nor 15: lower quadrants only, or upper only.
    trapezoid(ls, 0, 1, hl, hr);
    emitPolygon(ctx, ls, g, clipAtHalf(ls, 4, lower0 === 1), hl, hr, nx, ny, nz, tile, flags, reverse);
    return;
  }
  const hm = (hl + hr) / 2;
  for (let half = 0; half < 2; half++) {
    const lower = half === 0 ? lower0 : lower1;
    const upper = half === 0 ? upper0 : upper1;
    if ((lower | upper) === 0) continue;
    const u0 = half * 0.5;
    trapezoid(ls, u0, u0 + 0.5, half === 0 ? hl : hm, half === 0 ? hm : hr);
    const n = lower !== upper ? clipAtHalf(ls, 4, lower === 1) : 4;
    emitPolygon(ctx, ls, g, n, hl, hr, nx, ny, nz, tile, flags, reverse);
  }
}

/** The trapezoid u in [u0, u1] under the top line (heights ha at u0, hb at u1) into ls.pu/py/ptop, counter-clockwise seen from the front. */
function trapezoid(ls: ClipScratch, u0: number, u1: number, ha: number, hb: number): void {
  ls.pu[0] = u0;
  ls.py[0] = 0;
  ls.ptop[0] = 0;
  ls.pu[1] = u1;
  ls.py[1] = 0;
  ls.ptop[1] = 0;
  ls.pu[2] = u1;
  ls.py[2] = hb;
  ls.ptop[2] = 1;
  ls.pu[3] = u0;
  ls.py[3] = ha;
  ls.ptop[3] = 1;
}

/**
 * Sutherland-Hodgman clip of the polygon in ls.pu/py/ptop (n vertices) to y <= 0.5 (keepBelow) or
 * y >= 0.5. An intersection lies on the top edge exactly when both ends of its edge do. Repeated
 * vertices are dropped. Returns the new vertex count (the polygon is back in ls.pu/py/ptop).
 */
function clipAtHalf(ls: ClipScratch, n: number, keepBelow: boolean): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ai = keepBelow ? ls.py[i]! <= 0.5 : ls.py[i]! >= 0.5;
    const aj = keepBelow ? ls.py[j]! <= 0.5 : ls.py[j]! >= 0.5;
    if (ai) m = pushVertex(ls, m, ls.pu[i]!, ls.py[i]!, ls.ptop[i]!);
    if (ai !== aj) {
      const t = (0.5 - ls.py[i]!) / (ls.py[j]! - ls.py[i]!);
      m = pushVertex(ls, m, ls.pu[i]! + t * (ls.pu[j]! - ls.pu[i]!), 0.5, ls.ptop[i]! & ls.ptop[j]!);
    }
  }
  if (m > 1 && ls.qu[m - 1] === ls.qu[0] && ls.qy[m - 1] === ls.qy[0]) m--;
  for (let i = 0; i < m; i++) {
    ls.pu[i] = ls.qu[i]!;
    ls.py[i] = ls.qy[i]!;
    ls.ptop[i] = ls.qtop[i]!;
  }
  return m;
}

function pushVertex(ls: ClipScratch, m: number, u: number, y: number, top: number): number {
  if (m > 0 && ls.qu[m - 1] === u && ls.qy[m - 1] === y) {
    ls.qtop[m - 1] = ls.qtop[m - 1]! | top;
    return m;
  }
  ls.qu[m] = u;
  ls.qy[m] = y;
  ls.qtop[m] = top;
  return m + 1;
}

/**
 * Emit a convex side piece (3 to 5 vertices, counter-clockwise): a quad, a triangle (as a quad
 * with its last corner repeated), or a pentagon as the quad (0,1,2,3) plus the triangle (0,3,4).
 */
function emitPolygon(ctx: MeshContext, ls: ClipScratch, g: GeometryBuilder, n: number, hl: number, hr: number, nx: number, ny: number, nz: number, tile: number, flags: number, reverse: boolean): void {
  if (n < 3) return;
  if (n === 3) emitPiece(ctx, ls, g, 0, 1, 2, 2, hl, hr, nx, ny, nz, tile, flags, reverse);
  else if (n === 4) emitPiece(ctx, ls, g, 0, 1, 2, 3, hl, hr, nx, ny, nz, tile, flags, reverse);
  else {
    emitPiece(ctx, ls, g, 0, 1, 2, 3, hl, hr, nx, ny, nz, tile, flags, reverse);
    emitPiece(ctx, ls, g, 0, 3, 4, 4, hl, hr, nx, ny, nz, tile, flags, reverse);
  }
}

/** One piece from polygon vertices i0..i3: attributes linear in the saved side quad (see clipSide). */
function emitPiece(ctx: MeshContext, ls: ClipScratch, g: GeometryBuilder, i0: number, i1: number, i2: number, i3: number, hl: number, hr: number, nx: number, ny: number, nz: number, tile: number, flags: number, reverse: boolean): void {
  let surface = 0;
  for (let k = 0; k < 4; k++) {
    const i = k === 0 ? i0 : k === 1 ? i1 : k === 2 ? i2 : i3;
    const u = ls.pu[i]!;
    const y = ls.py[i]!;
    // Height of the top edge at u, and the vertex's fraction of it: attributes are linear along the
    // bottom and top edges and along each vertical line between them.
    const h = hl + (hr - hl) * u;
    const v = y / h;
    for (let a = 0; a < 3; a++) {
      // Positions: the bottom edge interpolated along u, then lifted by y (the face is vertical).
      ctx.qpos[k * 3 + a] = bilerp(ls.pos, 3, a, u, 0);
    }
    ctx.qpos[k * 3 + 1] = bilerp(ls.pos, 3, 1, u, 0) + y;
    ctx.quv[k * 2] = bilerp(ls.uv, 2, 0, u, 0);
    ctx.quv[k * 2 + 1] = y;
    ctx.qsky[k] = Math.round(bilerp(ls.sky, 1, 0, u, v));
    ctx.qblock[k] = Math.round(bilerp(ls.block, 1, 0, u, v));
    ctx.qao[k] = 255;
    if (ls.ptop[i] !== 0) {
      const lFlag = (ls.surface >> C01) & 1;
      const rFlag = (ls.surface >> C11) & 1;
      if (u === 0 ? lFlag !== 0 : u === 1 ? rFlag !== 0 : (lFlag & rFlag) !== 0) surface |= 1 << k;
    }
  }
  ctx.commit(g, nx, ny, nz, tile, flags, DIAG_AUTO, reverse, surface);
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
  const o1 = occludes(ctx, a + s1);
  const o2 = occludes(ctx, a + s2);
  let n = 0;
  let sky = 0;
  let blk = 0;
  let raw: number;
  if (!occludes(ctx, a)) {
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
  const walled = o1 && o2 && occludes(ctx, p + s1) && occludes(ctx, p + s2);
  if (!walled && !occludes(ctx, a + s1 + s2)) {
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
  const layered = ctx.layered;
  const kind = LIQUID[id]!;
  const up = ctx.axisStride[1]!;
  // Visibility first: most liquid cells (the body of a lake or ocean) show no face at all,
  // and the corner heights are only needed for the top and side faces.
  const aboveCell = cells[p + up]!;
  const aboveSame = LIQUID[aboveCell & ID_MASK] === kind;
  let sides = 0;
  for (let j = 0; j < 4; j++) {
    const d = HORIZONTAL[j]!;
    const nb = p + ctx.dirStride[d]!;
    const nid = cells[nb]! & ID_MASK;
    // Inline INFO test for jobs without layers: the body of an ocean runs this for every cell.
    if (LIQUID[nid] !== kind && (layered ? !ctx.covers(nb, d ^ 1) : (INFO[nid]! & (1 << (d ^ 1))) === 0)) sides |= 1 << j;
  }
  if (!aboveSame || sides !== 0) emitSurfaceAndSides(ctx, ls, p, x, y, z, id, kind, aboveCell, aboveSame, sides);

  // ---- bottom (on the cell floor: never a free surface, so never wave-flagged)
  const below = p - up;
  const belowCell = cells[below]!;
  const belowId = belowCell & ID_MASK;
  if (LIQUID[belowId] !== kind && (layered ? !ctx.covers(below, UP) : (INFO[belowId]! & (1 << UP)) === 0)) {
    ctx.setBox(0, 0, 0, 1, 1, 1);
    ctx.useUvRect = false;
    const g = ctx.groups[GROUP[id]!]!;
    if (ctx.layered && ctx.partial[below] !== 0) {
      ctx.boxFaceCorners(p, x, y, z, DOWN, 0, false);
      const cs = ls.clip();
      saveQuad(ctx, cs, 0);
      const tile = TILE_SLOT[id * 3]!;
      const flags = BASE_FLAGS[id]!;
      const outside = ~cover(ctx.opq[below]!, UP) & 15;
      const inside = ~sealCover(ctx, below, UP) & 15;
      // One diagonal for both copies, as commitDoubleSided does for the whole face.
      const diag = ctx.autoDiagonal();
      clipFlat(ctx, cs, g, DOWN, outside, false, FACE_NX[DOWN]!, FACE_NY[DOWN]!, FACE_NZ[DOWN]!, tile, flags, diag);
      clipFlat(ctx, cs, g, DOWN, inside, true, FACE_NX[DOWN]!, FACE_NY[DOWN]!, FACE_NZ[DOWN]!, tile, flags, diag);
    } else {
      ctx.boxFace(g, p, x, y, z, DOWN, TILE_SLOT[id * 3]!, 0, BASE_FLAGS[id]!, false, !sealsFace(belowCell, UP));
    }
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
  const above = p + up;
  const coveredAbove = allFull && ctx.covers(above, DOWN);
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
    if (allFull && ctx.layered && ctx.partial[above] !== 0) {
      // Flat, on the plane of a partial cell above: per quadrant (no wave flags at full height).
      const cs = ls.clip();
      saveQuad(ctx, cs, 0);
      clipFlat(ctx, cs, g, UP, ~cover(ctx.opq[above]!, DOWN) & 15, false, nx, ny, nz, tile, flags, diag);
      clipFlat(ctx, cs, g, UP, ~sealCover(ctx, above, DOWN) & 15, true, nx, ny, nz, tile, flags, diag);
    } else {
      ctx.commit(g, nx, ny, nz, tile, flags, diag, false, surface);
      // Only a full-height surface lies on the plane of the block above.
      if (!(allFull && sealsFace(aboveCell, DOWN))) ctx.commit(g, -nx, -ny, -nz, tile, flags, diag, true, surface);
    }
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
    if (ctx.layered && ctx.partial[nb] !== 0) {
      const outside = ~cover(ctx.opq[nb]!, d ^ 1) & 15;
      const inside = ~sealCover(ctx, nb, d ^ 1) & 15;
      if (outside === 15 && inside === 15) ctx.commitDoubleSided(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, surface);
      else {
        // Top corner heights at the face's frame u = 0 and u = 1 (u runs along R).
        const cs = ls.clip();
        saveQuad(ctx, cs, surface);
        const hl = cs.pos[C01 * 3 + 1]! - y;
        const hr = cs.pos[C11 * 3 + 1]! - y;
        clipSide(ctx, cs, g, d, outside, false, hl, hr, flow, flags);
        clipSide(ctx, cs, g, d, inside, true, hl, hr, flow, flags);
      }
    } else if (sealsFace(cells[nb]!, d ^ 1)) ctx.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, false, surface);
    else ctx.commitDoubleSided(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, flow, flags, DIAG_AUTO, surface);
  }
}
