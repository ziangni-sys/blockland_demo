/**
 * Non-cube block models: cross plants, torch, snow-like layers, cactus, helm, propeller.
 *
 * Every vertex stays inside its cell's [0,1]^3 box. Box parts use the generic box face
 * (position-derived uvs, smooth light, AO where the part touches the cell boundary);
 * thin decal parts (plant planes, helm wheel, propeller blades) are double-sided quads lit
 * flat with the cell's own light, since a paper-thin plane has no meaningful AO.
 */
import { ID_MASK, STATE_MASK, STATE_SHIFT, stateFacing, stateLayers } from '../../blocks/cell';
import { DIR_X, DIR_Y, DIR_Z } from '../../core/dirs';
import { DIAG_02, type MeshContext } from './builder';
import { BASE_FLAGS, CORNER_U, CORNER_V, G_CUTOUT, GROUP, INFO, TILE_SLOT } from './tables';

const UP = 2;
const DOWN = 3;
const SIDES: readonly number[] = [0, 1, 4, 5];

/** 127 / sqrt(2), the signed-byte component of a 45-degree horizontal normal. */
const DIAG_N = 90;

/**
 * Draw group for a decal part. A double-sided decal is only meaningful with alpha testing,
 * so it never goes to the plain opaque pass even when the block's layer says 'opaque'.
 */
function decalGroup(id: number): number {
  return Math.max(GROUP[id]!, G_CUTOUT);
}

// ------------------------------------------------------------------ cross

/**
 * Two vertical double-sided planes along the cell diagonals, corner to corner. No per-cell
 * jitter: box-local positions cannot give a stable world-space hash. All vertices carry
 * VFLAG_PLANT; uv.v is 0 at the ground and 1 at the top, which the shader can use to keep
 * the roots in place while the tips sway.
 */
export function emitCross(ctx: MeshContext, p: number, x: number, y: number, z: number, id: number): void {
  const g = ctx.groups[GROUP[id]!]!;
  const tile = TILE_SLOT[id * 3]!;
  const flags = BASE_FLAGS[id]!;
  ctx.flatLight(p);
  // (0,0) -> (1,1): front normal (-1, 0, 1) / sqrt 2
  ctx.setCorner(0, x, y, z, 0, 0);
  ctx.setCorner(1, x + 1, y, z + 1, 1, 0);
  ctx.setCorner(2, x + 1, y + 1, z + 1, 1, 1);
  ctx.setCorner(3, x, y + 1, z, 0, 1);
  ctx.commitDoubleSided(g, -DIAG_N, 0, DIAG_N, tile, flags, DIAG_02);
  // (1,0) -> (0,1): front normal (-1, 0, -1) / sqrt 2
  ctx.setCorner(0, x + 1, y, z, 0, 0);
  ctx.setCorner(1, x, y, z + 1, 1, 0);
  ctx.setCorner(2, x, y + 1, z + 1, 1, 1);
  ctx.setCorner(3, x + 1, y + 1, z, 0, 1);
  ctx.commitDoubleSided(g, -DIAG_N, 0, -DIAG_N, tile, flags, DIAG_02);
}

// ------------------------------------------------------------------ torch

const TORCH_LO = 7 / 16;
const TORCH_HI = 9 / 16;
const TORCH_TOP = 10 / 16;

/**
 * A 2/16 x 10/16 x 2/16 post in the middle of the cell floor. Sides sample the matching
 * pixels of the tile (columns 7..8, the bottom 10 rows); the top cap samples the top two
 * rows of the post (the flame / head), the bottom cap the bottom two rows.
 */
export function emitTorch(ctx: MeshContext, p: number, x: number, y: number, z: number, id: number): void {
  const g = ctx.groups[GROUP[id]!]!;
  const tile = TILE_SLOT[id * 3]!;
  const flags = BASE_FLAGS[id]!;
  ctx.setBox(TORCH_LO, 0, TORCH_LO, TORCH_HI, TORCH_TOP, TORCH_HI);
  ctx.useUvRect = false;
  for (let j = 0; j < 4; j++) ctx.boxFace(g, p, x, y, z, SIDES[j]!, tile, 0, flags, false);
  ctx.setUvRect(TORCH_LO, TORCH_TOP - 2 / 16, TORCH_HI, TORCH_TOP);
  ctx.boxFace(g, p, x, y, z, UP, tile, 0, flags, false);
  const below = ctx.cells[p - ctx.axisStride[1]!]! & ID_MASK;
  if ((INFO[below]! & (1 << UP)) === 0) {
    ctx.setUvRect(TORCH_LO, 0, TORCH_HI, 2 / 16);
    ctx.boxFace(g, p, x, y, z, DOWN, tile, 0, flags, false);
  }
  ctx.useUvRect = false;
}

// ------------------------------------------------------------------ layers

/** A full-footprint slab of height layers / 8 (snow cover). */
export function emitLayers(ctx: MeshContext, p: number, x: number, y: number, z: number, cell: number, id: number): void {
  const cells = ctx.cells;
  const g = ctx.groups[GROUP[id]!]!;
  const tile = TILE_SLOT[id * 3]!;
  const flags = BASE_FLAGS[id]!;
  const h = stateLayers((cell >>> STATE_SHIFT) & STATE_MASK) / 8;
  ctx.setBox(0, 0, 0, 1, h, 1);
  ctx.useUvRect = false;
  for (let d = 0; d < 6; d++) {
    const nc = cells[p + ctx.dirStride[d]!]!;
    const nid = nc & ID_MASK;
    // The top face is on the cell boundary only for a full stack.
    if ((d !== UP || h === 1) && (INFO[nid]! & (1 << (d ^ 1))) !== 0) continue;
    // A side is hidden by a same-kind neighbour stacked at least as high.
    if (d !== UP && d !== DOWN && nid === id && stateLayers((nc >>> STATE_SHIFT) & STATE_MASK) / 8 >= h) continue;
    ctx.boxFace(g, p, x, y, z, d, tile, 0, flags, true);
  }
}

// ------------------------------------------------------------------ cactus

const CACTUS_INSET = 1 / 16;

/**
 * Top and bottom at the cell faces (hidden against covering blocks and against cactus
 * stacked on / under it); the four sides sit 1/16 inside the cell but span its full width,
 * which gives the ribbed silhouette and leaves a visible gap to walls.
 */
export function emitCactus(ctx: MeshContext, p: number, x: number, y: number, z: number, id: number): void {
  const cells = ctx.cells;
  const g = ctx.groups[GROUP[id]!]!;
  const flags = BASE_FLAGS[id]!;
  const side = TILE_SLOT[id * 3]!;
  const up = ctx.axisStride[1]!;
  ctx.useUvRect = false;
  ctx.setBox(0, 0, 0, 1, 1, 1);
  const aboveId = cells[p + up]! & ID_MASK;
  if (aboveId !== id && (INFO[aboveId]! & (1 << DOWN)) === 0) {
    ctx.boxFace(g, p, x, y, z, UP, TILE_SLOT[id * 3 + 1]!, 0, flags, true);
  }
  const belowId = cells[p - up]! & ID_MASK;
  if (belowId !== id && (INFO[belowId]! & (1 << UP)) === 0) {
    ctx.boxFace(g, p, x, y, z, DOWN, TILE_SLOT[id * 3 + 2]!, 0, flags, true);
  }
  const lo = CACTUS_INSET;
  const hi = 1 - CACTUS_INSET;
  ctx.setBox(0, 0, 0, hi, 1, 1);
  ctx.boxFace(g, p, x, y, z, 0, side, 0, flags, true);
  ctx.setBox(lo, 0, 0, 1, 1, 1);
  ctx.boxFace(g, p, x, y, z, 1, side, 0, flags, true);
  ctx.setBox(0, 0, 0, 1, 1, hi);
  ctx.boxFace(g, p, x, y, z, 4, side, 0, flags, true);
  ctx.setBox(0, 0, lo, 1, 1, 1);
  ctx.boxFace(g, p, x, y, z, 5, side, 0, flags, true);
}

// ------------------------------------------------------------------ helm

const PEDESTAL_LO = 4 / 16;
const PEDESTAL_HI = 12 / 16;
const PEDESTAL_TOP = 10 / 16;
/** Wheel plane: 3/16 behind the pedestal's back face, measured from the back of the cell. */
const WHEEL_S = PEDESTAL_LO - 3 / 16;
const WHEEL_HALF = 7 / 16;
const WHEEL_CY = 1 - WHEEL_HALF;

/**
 * A pedestal box plus a double-sided wheel. Facing = the direction the helmsman looks
 * (the bow), so he stands on the opposite side and the wheel sits on that side of the
 * pedestal, in the plane perpendicular to facing, 14/16 across, its top at the cell top.
 * The wheel's front face (normal -facing) is the one the helmsman sees, with the tile
 * upright and unmirrored.
 */
export function emitHelm(ctx: MeshContext, p: number, x: number, y: number, z: number, cell: number, id: number): void {
  const g = ctx.groups[GROUP[id]!]!;
  const flags = BASE_FLAGS[id]!;
  let f = stateFacing((cell >>> STATE_SHIFT) & STATE_MASK);
  if (f === UP || f === DOWN) f = 0; // a helm always faces horizontally; repair bad state
  ctx.useUvRect = false;
  ctx.setBox(PEDESTAL_LO, 0, PEDESTAL_LO, PEDESTAL_HI, PEDESTAL_TOP, PEDESTAL_HI);
  const below = ctx.cells[p - ctx.axisStride[1]!]! & ID_MASK;
  const baseTile = TILE_SLOT[id * 3]!;
  for (let d = 0; d < 6; d++) {
    if (d === DOWN && (INFO[below]! & (1 << UP)) !== 0) continue;
    ctx.boxFace(g, p, x, y, z, d, baseTile, 0, flags, true);
  }

  const fx = DIR_X[f]!;
  const fz = DIR_Z[f]!;
  // Viewer looking along +facing: right = facing x up = (-fz, 0, fx).
  const rx = -fz;
  const rz = fx;
  const cx = fx > 0 ? WHEEL_S : fx < 0 ? 1 - WHEEL_S : 0.5;
  const cz = fz > 0 ? WHEEL_S : fz < 0 ? 1 - WHEEL_S : 0.5;
  ctx.flatLight(p);
  for (let k = 0; k < 4; k++) {
    const su = (2 * CORNER_U[k]! - 1) * WHEEL_HALF;
    const sv = (2 * CORNER_V[k]! - 1) * WHEEL_HALF;
    ctx.setCorner(k, x + cx + su * rx, y + WHEEL_CY + sv, z + cz + su * rz, CORNER_U[k]!, CORNER_V[k]!);
  }
  ctx.commitDoubleSided(ctx.groups[decalGroup(id)]!, -fx * 127, 0, -fz * 127, TILE_SLOT[id * 3 + 1]!, flags, DIAG_02);
}

// ------------------------------------------------------------------ propeller

// Along the facing axis, s = 0 is the mounting (back) face and s = 1 the thrust face.
const PLATE_S1 = 2 / 16;
const PLATE_LO = 2 / 16;
const PLATE_HI = 14 / 16;
const HUB_S1 = 15 / 16;
const HUB_LO = 5 / 16;
const HUB_HI = 11 / 16;
const BLADE_S = 12 / 16;
/** Blade root radius (hub surface) and tip radius (cell edge). */
const BLADE_R0 = 3 / 16;
const BLADE_R1 = 8 / 16;
const BLADE_HALF_W = 2 / 16;
/** Blade pitch: rotation of the blade about its own radial axis, out of the disc plane. */
const BLADE_COS = Math.cos(Math.PI / 6);
const BLADE_SIN = Math.sin(Math.PI / 6);

/** Box for a propeller part: [s0,s1] along the facing axis, [l0,l1] on both lateral axes. */
function setPropellerBox(ctx: MeshContext, f: number, s0: number, s1: number, l0: number, l1: number): void {
  const fa = f >> 1;
  const positive = (f & 1) === 0;
  const b = ctx.box;
  for (let a = 0; a < 3; a++) {
    if (a === fa) {
      b[a] = positive ? s0 : 1 - s1;
      b[3 + a] = positive ? s1 : 1 - s0;
    } else {
      b[a] = l0;
      b[3 + a] = l1;
    }
  }
}

/**
 * Back plate against the mounting face, a 6/16-square hub running out to the thrust side,
 * and four pitched double-sided blades in the plane perpendicular to facing, from the hub
 * surface out to the cell edge. Each blade maps the whole blade tile: v runs root -> tip,
 * u across the blade.
 */
export function emitPropeller(ctx: MeshContext, p: number, x: number, y: number, z: number, cell: number, id: number): void {
  const cells = ctx.cells;
  const g = ctx.groups[GROUP[id]!]!;
  const flags = BASE_FLAGS[id]!;
  const f = stateFacing((cell >>> STATE_SHIFT) & STATE_MASK);
  const back = f ^ 1;
  ctx.useUvRect = false;

  setPropellerBox(ctx, f, 0, PLATE_S1, PLATE_LO, PLATE_HI);
  const plateTile = TILE_SLOT[id * 3 + 2]!;
  const mountId = cells[p + ctx.dirStride[back]!]! & ID_MASK;
  for (let d = 0; d < 6; d++) {
    if (d === back && (INFO[mountId]! & (1 << f)) !== 0) continue;
    ctx.boxFace(g, p, x, y, z, d, plateTile, 0, flags, true);
  }
  setPropellerBox(ctx, f, PLATE_S1, HUB_S1, HUB_LO, HUB_HI);
  const hubTile = TILE_SLOT[id * 3]!;
  for (let d = 0; d < 6; d++) {
    if (d === back) continue; // flush against the back plate
    ctx.boxFace(g, p, x, y, z, d, hubTile, 0, flags, true);
  }

  const fx = DIR_X[f]!;
  const fy = DIR_Y[f]!;
  const fz = DIR_Z[f]!;
  const ox = x + 0.5 + fx * (BLADE_S - 0.5);
  const oy = y + 0.5 + fy * (BLADE_S - 0.5);
  const oz = z + 0.5 + fz * (BLADE_S - 0.5);
  const gb = ctx.groups[decalGroup(id)]!;
  const bladeTile = TILE_SLOT[id * 3 + 1]!;
  const mid = (BLADE_R0 + BLADE_R1) / 2;
  const halfLen = (BLADE_R1 - BLADE_R0) / 2;
  ctx.flatLight(p);
  for (let e = 0; e < 6; e++) {
    if (e >> 1 === f >> 1) continue;
    // Radial direction (unit axis vector), blade width direction w = facing x radial,
    // pitched toward the facing axis.
    const ex = DIR_X[e]!;
    const ey = DIR_Y[e]!;
    const ez = DIR_Z[e]!;
    const wx = fy * ez - fz * ey;
    const wy = fz * ex - fx * ez;
    const wz = fx * ey - fy * ex;
    const rx = BLADE_COS * wx + BLADE_SIN * fx;
    const ry = BLADE_COS * wy + BLADE_SIN * fy;
    const rz = BLADE_COS * wz + BLADE_SIN * fz;
    const cx = ox + ex * mid;
    const cy = oy + ey * mid;
    const cz = oz + ez * mid;
    for (let k = 0; k < 4; k++) {
      const su = (2 * CORNER_U[k]! - 1) * BLADE_HALF_W;
      const sv = (2 * CORNER_V[k]! - 1) * halfLen;
      ctx.setCorner(k, cx + su * rx + sv * ex, cy + su * ry + sv * ey, cz + su * rz + sv * ez, CORNER_U[k]!, CORNER_V[k]!);
    }
    // Front normal = R x radial (unit already: R is perpendicular to the radial axis).
    const nx = ry * ez - rz * ey;
    const ny = rz * ex - rx * ez;
    const nz = rx * ey - ry * ex;
    ctx.commitDoubleSided(gb, Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127), bladeTile, flags, DIAG_02);
  }
}
