/**
 * Shared emission machinery for every shape: growable output arrays per draw group, the
 * per-quad scratch, smooth light + AO sampling and the generic axis-aligned box face.
 *
 * Shape emitters fill the quad scratch (positions, uvs, light) and call commit(); nothing
 * allocates per face. All state lives on instances — one MeshContext per Mesher.
 */
import * as cellBits from '../../blocks/cell';
import { VFLAG_LIQUID_SURFACE, type GeometryData, type MeshInput } from '../types';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK } = cellBits;
const {
  AO_BYTE,
  AVG_LIGHT,
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
  INFO,
  INFO_OCCLUDER,
} = tables;

/** Pick the triangulation diagonal from AO, then light (see MeshContext.autoDiagonal). */
export const DIAG_AUTO = 0;
/** Triangles (0,1,2) (0,2,3). */
export const DIAG_02 = 1;
/** Triangles (1,2,3) (1,3,0). */
export const DIAG_13 = 2;

/** Quads reserved the first time a group receives geometry; doubles from there. */
const INITIAL_QUADS = 512;

/** Sky / block bytes used when the input carries no voxel light (structures). */
const NO_LIGHT_SKY = 255;
const NO_LIGHT_BLOCK = 0;

/**
 * One draw group under construction. Arrays are allocated lazily (an empty or buried
 * section allocates nothing) and grow geometrically; finish() returns exact-size copies,
 * so the builder can be reused by the next job without aliasing anything it returned.
 */
export class GeometryBuilder {
  positions = new Float32Array(0);
  normals = new Int8Array(0);
  uvs = new Float32Array(0);
  layers = new Uint16Array(0);
  light = new Uint8Array(0);
  indices = new Uint32Array(0);
  /** Quads written since the last reset. */
  quads = 0;
  private capacity = 0;

  reset(): void {
    this.quads = 0;
  }

  /** Make sure one more quad fits. May replace every array: re-read them afterwards. */
  reserveQuad(): void {
    if (this.quads < this.capacity) return;
    const cap = this.capacity === 0 ? INITIAL_QUADS : this.capacity * 2;
    const v = cap * 4;
    const positions = new Float32Array(v * 3);
    const normals = new Int8Array(v * 3);
    const uvs = new Float32Array(v * 2);
    const layers = new Uint16Array(v);
    const light = new Uint8Array(v * 4);
    const indices = new Uint32Array(cap * 6);
    positions.set(this.positions);
    normals.set(this.normals);
    uvs.set(this.uvs);
    layers.set(this.layers);
    light.set(this.light);
    indices.set(this.indices);
    this.positions = positions;
    this.normals = normals;
    this.uvs = uvs;
    this.layers = layers;
    this.light = light;
    this.indices = indices;
    this.capacity = cap;
  }

  /** Exact-size copy of what was written, or null when the group is empty. */
  finish(): GeometryData | null {
    const q = this.quads;
    if (q === 0) return null;
    const v = q * 4;
    return {
      vertexCount: v,
      indexCount: q * 6,
      positions: this.positions.slice(0, v * 3),
      normals: this.normals.slice(0, v * 3),
      uvs: this.uvs.slice(0, v * 2),
      layers: this.layers.slice(0, v),
      light: this.light.slice(0, v * 4),
      indices: this.indices.slice(0, q * 6),
    };
  }
}

/** Rotate a uv by r quarter turns about the tile centre: tile "up" ends up along U, R, -U, -R. */
function rotU(r: number, u: number, v: number): number {
  return r === 0 ? u : r === 1 ? 1 - v : r === 2 ? 1 - u : v;
}
function rotV(r: number, u: number, v: number): number {
  return r === 0 ? v : r === 1 ? u : r === 2 ? 1 - v : 1 - u;
}

const EMPTY_CELLS = new Uint16Array(0);

export class MeshContext {
  // ---- current job
  cells: Uint16Array = EMPTY_CELLS;
  light: Uint8Array | null = null;
  /** Padded dims. */
  px = 0;
  py = 0;
  pz = 0;
  /** Padded-index offset to the neighbour in each Dir. */
  readonly dirStride = new Int32Array(6);
  /** Padded-index offset per +axis (x, y, z). */
  readonly axisStride = new Int32Array(3);

  /** Output per draw group (G_OPAQUE, G_CUTOUT, G_TRANSLUCENT). */
  readonly groups: readonly GeometryBuilder[] = [new GeometryBuilder(), new GeometryBuilder(), new GeometryBuilder()];

  // ---- quad scratch (corner k in counter-clockwise order seen from the front)
  /** Absolute box-space positions, xyz per corner. */
  readonly qpos = new Float64Array(12);
  /** uv per corner. */
  readonly quv = new Float64Array(8);
  /** Smooth light bytes per corner. */
  readonly qsky = new Uint8Array(4);
  readonly qblock = new Uint8Array(4);
  /** AO level 0..3 per corner (3 = open). */
  readonly qao = new Uint8Array(4);

  // ---- box-face parameters (cell-local, set by shapes before boxFace)
  /** lo xyz, hi xyz, each within [0,1]. */
  readonly box = new Float64Array(6);
  /** Explicit uv rectangle (u0, v0, u1, v1) used instead of position-derived uvs when useUvRect. */
  readonly uvRect = new Float64Array(4);
  useUvRect = false;

  begin(input: MeshInput): void {
    const px = input.sx + 2;
    const py = input.sy + 2;
    const pz = input.sz + 2;
    this.cells = input.cells;
    this.light = input.light;
    this.px = px;
    this.py = py;
    this.pz = pz;
    const sy = px * pz;
    const ds = this.dirStride;
    ds[0] = 1;
    ds[1] = -1;
    ds[2] = sy;
    ds[3] = -sy;
    ds[4] = px;
    ds[5] = -px;
    this.axisStride[0] = 1;
    this.axisStride[1] = sy;
    this.axisStride[2] = px;
    for (const g of this.groups) g.reset();
    this.useUvRect = false;
  }

  /** Drop references to the job's input so a long-lived context does not pin it. */
  end(): void {
    this.cells = EMPTY_CELLS;
    this.light = null;
  }

  setBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const b = this.box;
    b[0] = x0;
    b[1] = y0;
    b[2] = z0;
    b[3] = x1;
    b[4] = y1;
    b[5] = z1;
  }

  setUvRect(u0: number, v0: number, u1: number, v1: number): void {
    const r = this.uvRect;
    r[0] = u0;
    r[1] = v0;
    r[2] = u1;
    r[3] = v1;
    this.useUvRect = true;
  }

  /**
   * Smooth light and AO of quad corner k.
   *
   * `base` is the cell of the layer the face looks into (the neighbour for a face on the
   * cell boundary, the cell itself for an inset face); s1 / s2 are the padded offsets from
   * `base` toward the corner along the face's two tangents, or 0 when the corner lies
   * strictly inside the cell along that tangent (only one cell column touches it then).
   *
   * AO: classic three-neighbour rule — both sides blocked = fully occluded, otherwise
   * 3 - (side1 + side2 + corner). Light: average of the touching cells that are not
   * occluders; the diagonal corner is ignored when both sides are blocked, because no light
   * can reach the vertex through it (prevents leaks through diagonal walls).
   */
  sampleVertex(k: number, base: number, s1: number, s2: number, ao: boolean): void {
    const cells = this.cells;
    const o1 = s1 !== 0 && (INFO[cells[base + s1]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
    const o2 = s2 !== 0 && (INFO[cells[base + s2]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
    const oc = s1 !== 0 && s2 !== 0 && (INFO[cells[base + s1 + s2]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
    if (ao) this.qao[k] = o1 && o2 ? 0 : 3 - ((o1 ? 1 : 0) + (o2 ? 1 : 0) + (oc ? 1 : 0));
    else this.qao[k] = 3;

    const light = this.light;
    if (light === null) {
      this.qsky[k] = NO_LIGHT_SKY;
      this.qblock[k] = NO_LIGHT_BLOCK;
      return;
    }
    let n = 0;
    let sky = 0;
    let blk = 0;
    let raw: number;
    if ((INFO[cells[base]! & ID_MASK]! & INFO_OCCLUDER) === 0) {
      raw = light[base]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (s1 !== 0 && !o1) {
      raw = light[base + s1]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (s2 !== 0 && !o2) {
      raw = light[base + s2]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (s1 !== 0 && s2 !== 0 && !oc && !(o1 && o2)) {
      raw = light[base + s1 + s2]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (n === 0) {
      // Every touching cell is opaque (an inset face buried in a wall): fall back to the
      // stored value rather than inventing darkness or brightness.
      raw = light[base]!;
      sky = raw >> 4;
      blk = raw & 15;
      n = 1;
    }
    this.qsky[k] = AVG_LIGHT[n * 61 + sky]!;
    this.qblock[k] = AVG_LIGHT[n * 61 + blk]!;
  }

  /** Light every corner flat with the cell's own light and no AO (thin decals, plants). */
  flatLight(p: number): void {
    const light = this.light;
    let sky = NO_LIGHT_SKY;
    let blk = NO_LIGHT_BLOCK;
    if (light !== null) {
      const raw = light[p]!;
      sky = (raw >> 4) * 17;
      blk = (raw & 15) * 17;
    }
    for (let k = 0; k < 4; k++) {
      this.qsky[k] = sky;
      this.qblock[k] = blk;
      this.qao[k] = 3;
    }
  }

  /**
   * Emit face d of the current box (this.box, cell-local) of the cell at padded index p,
   * whose box-space origin is (x, y, z). Positions, uvs (from position unless useUvRect,
   * then rotated by `rot` quarter turns), smooth light and optionally AO are derived here;
   * culling is the caller's job because its rules differ per shape. `twoSided` also emits
   * the back copy (same corners, light and diagonal; reversed winding, negated normal).
   */
  boxFace(
    g: GeometryBuilder,
    p: number,
    x: number,
    y: number,
    z: number,
    d: number,
    tile: number,
    rot: number,
    flags: number,
    ao: boolean,
    twoSided = false,
  ): void {
    const box = this.box;
    const na = d >> 1;
    const boundary = (d & 1) === 0 ? box[3 + na] === 1 : box[na] === 0;
    const base = boundary ? p + this.dirStride[d]! : p;
    const ra = FACE_R_AXIS[d]!;
    const ua = FACE_U_AXIS[d]!;
    const rStride = this.axisStride[ra]!;
    const uStride = this.axisStride[ua]!;
    const rPos = FACE_R_SIGN[d]! > 0;
    const uPos = FACE_U_SIGN[d]! > 0;
    const qpos = this.qpos;
    const quv = this.quv;
    const rect = this.uvRect;
    const useRect = this.useUvRect;
    for (let k = 0; k < 4; k++) {
      const hi = FACE_CORNER_HI[d * 4 + k]!;
      const cx = (hi & 1) !== 0 ? box[3]! : box[0]!;
      const cy = (hi & 2) !== 0 ? box[4]! : box[1]!;
      const cz = (hi & 4) !== 0 ? box[5]! : box[2]!;
      qpos[k * 3] = x + cx;
      qpos[k * 3 + 1] = y + cy;
      qpos[k * 3 + 2] = z + cz;
      const cr = ra === 0 ? cx : ra === 1 ? cy : cz;
      const cu = ua === 0 ? cx : ua === 1 ? cy : cz;
      this.sampleVertex(k, base, cr === 0 ? -rStride : cr === 1 ? rStride : 0, cu === 0 ? -uStride : cu === 1 ? uStride : 0, ao);
      let u: number;
      let v: number;
      if (useRect) {
        u = CORNER_U[k] === 1 ? rect[2]! : rect[0]!;
        v = CORNER_V[k] === 1 ? rect[3]! : rect[1]!;
      } else {
        u = rPos ? cr : 1 - cr;
        v = uPos ? cu : 1 - cu;
      }
      quv[k * 2] = rotU(rot, u, v);
      quv[k * 2 + 1] = rotV(rot, u, v);
    }
    if (twoSided) this.commitDoubleSided(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, tile, flags, DIAG_AUTO);
    else this.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, tile, flags, DIAG_AUTO, false);
  }

  /** Write corner k of a free quad (absolute box-space position, uv). */
  setCorner(k: number, x: number, y: number, z: number, u: number, v: number): void {
    const qpos = this.qpos;
    qpos[k * 3] = x;
    qpos[k * 3 + 1] = y;
    qpos[k * 3 + 2] = z;
    this.quv[k * 2] = u;
    this.quv[k * 2 + 1] = v;
  }

  /**
   * Emit the scratch quad as both a front face (normal n) and a back face (reversed
   * winding, normal -n). The back face reuses positions and uvs, so a decal seen from
   * behind shows the same pixel at the same spot, and both sides use the same diagonal so
   * non-planar quads (liquid surfaces) stay exactly coincident.
   */
  commitDoubleSided(
    g: GeometryBuilder,
    nx: number,
    ny: number,
    nz: number,
    tile: number,
    flags: number,
    diag: number,
    surfaceCorners = 0,
  ): void {
    const d = diag === DIAG_AUTO ? this.autoDiagonal() : diag;
    this.commit(g, nx, ny, nz, tile, flags, d, false, surfaceCorners);
    this.commit(g, -nx, -ny, -nz, tile, flags, d, true, surfaceCorners);
  }

  /**
   * Diagonal that reduces interpolation anisotropy: split along the brighter diagonal by
   * AO (a lone dark corner then stays confined to one triangle instead of smearing a streak
   * across the quad); ties are broken the same way by smooth light.
   */
  autoDiagonal(): number {
    const ao = this.qao;
    const a02 = ao[0]! + ao[2]!;
    const a13 = ao[1]! + ao[3]!;
    if (a02 !== a13) return a02 > a13 ? DIAG_02 : DIAG_13;
    const s = this.qsky;
    const b = this.qblock;
    const l02 = s[0]! + b[0]! + s[2]! + b[2]!;
    const l13 = s[1]! + b[1]! + s[3]! + b[3]!;
    return l02 >= l13 ? DIAG_02 : DIAG_13;
  }

  /**
   * Append the scratch quad to group g. `reverse` writes the corners in the order
   * 0,3,2,1 (the back side of the same quad); the diagonal code keeps addressing the same
   * two original corners, so front and back triangulate identically. `surfaceCorners`:
   * bit k set = scratch corner k lies on a free liquid surface and also carries
   * VFLAG_LIQUID_SURFACE (the wave flag is per vertex: see liquid.ts).
   */
  commit(
    g: GeometryBuilder,
    nx: number,
    ny: number,
    nz: number,
    tile: number,
    flags: number,
    diag: number,
    reverse: boolean,
    surfaceCorners = 0,
  ): void {
    const dg = diag === DIAG_AUTO ? this.autoDiagonal() : diag;
    g.reserveQuad();
    const q = g.quads++;
    const vb = q * 4;
    const pos = g.positions;
    const nrm = g.normals;
    const uv = g.uvs;
    const lay = g.layers;
    const li = g.light;
    const qpos = this.qpos;
    const quv = this.quv;
    const qsky = this.qsky;
    const qblock = this.qblock;
    const qao = this.qao;
    for (let j = 0; j < 4; j++) {
      const k = reverse ? (4 - j) & 3 : j;
      const v = vb + j;
      pos[v * 3] = qpos[k * 3]!;
      pos[v * 3 + 1] = qpos[k * 3 + 1]!;
      pos[v * 3 + 2] = qpos[k * 3 + 2]!;
      nrm[v * 3] = nx;
      nrm[v * 3 + 1] = ny;
      nrm[v * 3 + 2] = nz;
      uv[v * 2] = quv[k * 2]!;
      uv[v * 2 + 1] = quv[k * 2 + 1]!;
      lay[v] = tile;
      li[v * 4] = qsky[k]!;
      li[v * 4 + 1] = qblock[k]!;
      li[v * 4 + 2] = AO_BYTE[qao[k]!]!;
      li[v * 4 + 3] = ((surfaceCorners >> k) & 1) !== 0 ? flags | VFLAG_LIQUID_SURFACE : flags;
    }
    const idx = g.indices;
    const ib = q * 6;
    if (dg === DIAG_02) {
      idx[ib] = vb;
      idx[ib + 1] = vb + 1;
      idx[ib + 2] = vb + 2;
      idx[ib + 3] = vb;
      idx[ib + 4] = vb + 2;
      idx[ib + 5] = vb + 3;
    } else {
      idx[ib] = vb + 1;
      idx[ib + 1] = vb + 2;
      idx[ib + 2] = vb + 3;
      idx[ib + 3] = vb + 1;
      idx[ib + 4] = vb + 3;
      idx[ib + 5] = vb;
    }
  }
}
