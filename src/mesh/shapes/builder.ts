/**
 * Shared emission machinery for every shape: growable output arrays per draw group, the
 * per-quad scratch, smooth light + AO sampling, the generic axis-aligned box face and, for jobs
 * that carry partial cells, the octant-level quarter face (docs/SHAPES.md 8.2, 8.3).
 *
 * Shape emitters fill the quad scratch (positions, uvs, light) and call commit(); nothing
 * allocates per face. All state lives on instances — one MeshContext per Mesher.
 *
 * LAYERED JOBS. A job whose input has a holes or a second-part layer (MeshInput.holes / part2 not
 * null) is "layered": begin() then fills three per-padded-cell scratch tables (opq, partial,
 * nearPartial) that the shape emitters read. A job without those layers never touches them
 * and runs exactly the code M1 ran.
 */
import * as cellBits from '../../blocks/cell';
import * as registry from '../../blocks/registry';
import * as shapes from '../../blocks/shapes';
import { VFLAG_LIQUID_SURFACE, type GeometryData, type MeshInput } from '../types';
import * as tables from './tables';

// Hot-path imports are bound to module-local constants once, at module init. Module
// runners that implement ES live bindings as getter calls (the Vite/Vitest SSR transform)
// would otherwise pay a call per table read inside the meshing loops; bundles are unaffected.
const { ID_MASK, HOLES_SHIFT } = cellBits;
const { OPAQUE } = registry;
const { FACE_COVER } = shapes;
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
const EMPTY_BYTES = new Uint8Array(0);

/** AO byte of a fully open vertex (level 3). */
const AO_OPEN = 255;

/**
 * Octant references used by the octant sampling: padded cell index * 8 + octant (docs/SHAPES.md
 * 1.1). The largest padded box a job can have (a structure's tight box, at most 2^21 cells, plus
 * its margin) keeps this far below 2^31, so `r >> 3` and `r & 7` split it exactly.
 */
const OCT = 8;

/**
 * Corner k of the quarter face of octant h toward Dir d, index (d * 8 + h) * 4 + k, precomputed:
 * QF_POS[i * 3 + a] = cell-local coordinate on axis a (0, 0.5 or 1); QF_RU[i * 2] / [i * 2 + 1] =
 * the coordinate along the face's R / U axis; QF_SIGN[i] = bit 0: the corner lies toward +R from
 * the quarter's centre, bit 1: toward +U; bit 2: the R coordinate is whole, bit 3: the U one is.
 */
const QF_POS = new Float64Array(6 * 8 * 4 * 3);
const QF_RU = new Float64Array(6 * 8 * 4 * 2);
const QF_SIGN = new Uint8Array(6 * 8 * 4);
/**
 * QF_SLOT[i]: the corner's slot in the per-cell-face vertex cache (MeshContext.quarterFace): plane
 * (0 the cell's middle plane, 1 the cell boundary) * 9 + position on the face's 3 x 3 grid of
 * half-cell points (2 * R coordinate) * 3 + 2 * U coordinate.
 */
const QF_SLOT = new Uint8Array(6 * 8 * 4);
for (let d = 0; d < 6; d++) {
  const ra = FACE_R_AXIS[d]!;
  const ua = FACE_U_AXIS[d]!;
  const na = d >> 1;
  for (let h = 0; h < 8; h++) {
    const boundary = ((h >> na) & 1) === ((d & 1) === 0 ? 1 : 0);
    for (let k = 0; k < 4; k++) {
      const i = (d * 8 + h) * 4 + k;
      const hi = FACE_CORNER_HI[d * 4 + k]!;
      for (let a = 0; a < 3; a++) QF_POS[i * 3 + a] = ((h >> a) & 1) * 0.5 + (((hi >> a) & 1) !== 0 ? 0.5 : 0);
      const cr = QF_POS[i * 3 + ra]!;
      const cu = QF_POS[i * 3 + ua]!;
      QF_RU[i * 2] = cr;
      QF_RU[i * 2 + 1] = cu;
      QF_SIGN[i] = ((hi >> ra) & 1) | (((hi >> ua) & 1) << 1) | (cr !== 0.5 ? 4 : 0) | (cu !== 0.5 ? 8 : 0);
      QF_SLOT[i] = (boundary ? 9 : 0) + cr * 2 * 3 + cu * 2;
    }
  }
}
/** Slots of the per-cell-face vertex cache: two planes of 3 x 3 points. */
const VSLOTS = 18;

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
  /** AO byte per corner: linear openness 0..255 (AO_BYTE[level] for a sampled level, or an average of such bytes). */
  readonly qao = new Uint8Array(4);

  // ---- box-face parameters (cell-local, set by shapes before boxFace)
  /** lo xyz, hi xyz, each within [0,1]. */
  readonly box = new Float64Array(6);
  /** Explicit uv rectangle (u0, v0, u1, v1) used instead of position-derived uvs when useUvRect. */
  readonly uvRect = new Float64Array(4);
  useUvRect = false;

  // ---- layered jobs (docs/SHAPES.md 8.2): valid between begin() and end() when `layered`
  /** The job has a holes or a second-part layer; the tables below describe it. */
  layered = false;
  holes: Uint8Array | null = null;
  part2: Uint32Array | null = null;
  /** Per padded cell: octants held by opaque material (blocks/shapes.ts opaqueFill). */
  opq: Uint8Array = EMPTY_BYTES;
  /** Per padded cell: 1 when the cell has holes or a second part (cell value >= FULL_LIMIT). */
  partial: Uint8Array = EMPTY_BYTES;
  /** Per padded cell: 1 when the cell or one of its 26 neighbours is partial. */
  nearPartial: Uint8Array = EMPTY_BYTES;
  /** Capacity-sized backing stores of the three tables, kept across jobs. */
  private opqStore = EMPTY_BYTES;
  private partialStore = EMPTY_BYTES;
  private nearStore = EMPTY_BYTES;

  /** Result of sampleOctants(): AO byte, sky byte, block byte, and whether a sampled cell is partial. */
  private sAo = 0;
  private sSky = 0;
  private sBlock = 0;
  private sPartial = false;
  /**
   * Cache of the vertex values (AO, sky, block) quarterFace has computed for the faces toward Dir
   * `vertD` of padded cell `vertP`, by QF_SLOT: bit s of vertValid = slot s known. Values at [s],
   * [VSLOTS + s], [2 * VSLOTS + s]. The four cell-corner slots of the boundary plane also serve as
   * the corner values the averaging of 8.3 reads (cornerValue). Allocated with the layer tables.
   */
  private vertP = -1;
  private vertD = -1;
  private vertValid = 0;
  private verts = EMPTY_BYTES;

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
    this.holes = input.holes;
    this.part2 = input.part2;
    this.layered = input.holes !== null || input.part2 !== null;
    this.vertP = -1;
    if (this.layered) this.buildLayerTables();
  }

  /** Drop references to the job's input so a long-lived context does not pin it. */
  end(): void {
    this.cells = EMPTY_CELLS;
    this.light = null;
    this.holes = null;
    this.part2 = null;
    this.layered = false;
  }

  /**
   * Fill opq, partial and nearPartial for the current (layered) job. opq follows
   * blocks/shapes.ts opaqueFill bit for bit: the union of the occupied octants of every part whose
   * material is OPAQUE (a cell without layers: 0xff or 0 by its id).
   */
  private buildLayerTables(): void {
    const cells = this.cells;
    const holes = this.holes;
    const part2 = this.part2;
    const n = cells.length;
    if (this.verts.length === 0) this.verts = new Uint8Array(3 * VSLOTS);
    if (this.opqStore.length < n) {
      this.opqStore = new Uint8Array(n);
      this.partialStore = new Uint8Array(n);
      this.nearStore = new Uint8Array(n);
    }
    const opq = (this.opq = this.opqStore);
    const partial = (this.partial = this.partialStore);
    const near = (this.nearPartial = this.nearStore);
    near.fill(0, 0, n);
    for (let i = 0; i < n; i++) {
      const h = holes !== null ? holes[i]! : 0;
      const q = part2 !== null ? part2[i]! : 0;
      let o = OPAQUE[cells[i]! & ID_MASK] !== 0 ? ~h & 0xff : 0;
      if (q !== 0 && OPAQUE[q & ID_MASK] !== 0) o |= ~(q >>> HOLES_SHIFT) & 0xff;
      opq[i] = o;
      partial[i] = (h | q) !== 0 ? 1 : 0;
    }
    // nearPartial: mark the 3x3x3 block around every partial cell (clamped to the padded box).
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const layer = px * pz;
    for (let y = 0; y < py; y++) {
      for (let z = 0; z < pz; z++) {
        let i = z * px + y * layer;
        for (let x = 0; x < px; x++, i++) {
          if (partial[i] === 0) continue;
          for (let dy = y > 0 ? -1 : 0; dy <= (y < py - 1 ? 1 : 0); dy++) {
            for (let dz = z > 0 ? -1 : 0; dz <= (z < pz - 1 ? 1 : 0); dz++) {
              const row = i + dy * layer + dz * px;
              for (let dx = x > 0 ? -1 : 0; dx <= (x < px - 1 ? 1 : 0); dx++) near[row + dx] = 1;
            }
          }
        }
      }
    }
  }

  /**
   * True when the cell at padded index q completely and opaquely covers its own face `face`:
   * for a partial cell, opaqueCover(cell, face) === 15 (docs/SHAPES.md 3.2); otherwise the id's
   * INFO cover bit (every opaque cube; a snow-like slab its bottom). For jobs without layers this
   * is exactly M1's INFO test.
   */
  covers(q: number, face: number): boolean {
    if (this.layered && this.partial[q] !== 0) return ((FACE_COVER[this.opq[q]!]! >>> (face * 4)) & 15) === 15;
    return (INFO[this.cells[q]! & ID_MASK]! & (1 << face)) !== 0;
  }

  /**
   * Occupied octants of the cell at padded index q, both parts together (fills only: a part's
   * occupancy is ~holes whatever its material, as in blocks/shapes.ts). Layered jobs only.
   */
  partsFill(q: number): number {
    const h = this.holes !== null ? this.holes[q]! : 0;
    let f = (this.cells[q]! & ID_MASK) !== 0 ? ~h & 0xff : 0;
    const p2 = this.part2 !== null ? this.part2[q]! : 0;
    if (p2 !== 0) f |= ~(p2 >>> HOLES_SHIFT) & 0xff;
    return f;
  }

  /**
   * Block id of the part that holds octant o of the cell at padded index q, or 0 when that octant
   * is empty (blocks/shapes.ts partAt, reduced to the id). A cell without layers answers its id for
   * every octant, like partAt does for a whole block or a model. Layered jobs only.
   */
  idAt(q: number, o: number): number {
    const c = this.cells[q]!;
    const id1 = c & ID_MASK;
    const h = this.holes !== null ? this.holes[q]! : 0;
    if (id1 !== 0 && ((h >> o) & 1) === 0) return id1;
    const p2 = this.part2 !== null ? this.part2[q]! : 0;
    if (p2 !== 0 && (((p2 >>> HOLES_SHIFT) >> o) & 1) === 0) return p2 & ID_MASK;
    return 0;
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
   *
   * An occluder is a cell that is opaque as a whole: an OPAQUE id (INFO_OCCLUDER), or in a
   * layered job a cell whose eight octants are all opaque (opq === 0xff, the same thing for a
   * cell without parts). A partial cell is never a whole-cell occluder (docs/SHAPES.md 8.3, 8.4).
   */
  sampleVertex(k: number, base: number, s1: number, s2: number, ao: boolean): void {
    const cells = this.cells;
    const opq = this.layered ? this.opq : null;
    let o1: boolean;
    let o2: boolean;
    let oc: boolean;
    let ob: boolean;
    if (opq === null) {
      o1 = s1 !== 0 && (INFO[cells[base + s1]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
      o2 = s2 !== 0 && (INFO[cells[base + s2]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
      oc = s1 !== 0 && s2 !== 0 && (INFO[cells[base + s1 + s2]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
      ob = (INFO[cells[base]! & ID_MASK]! & INFO_OCCLUDER) !== 0;
    } else {
      o1 = s1 !== 0 && opq[base + s1] === 0xff;
      o2 = s2 !== 0 && opq[base + s2] === 0xff;
      oc = s1 !== 0 && s2 !== 0 && opq[base + s1 + s2] === 0xff;
      ob = opq[base] === 0xff;
    }
    this.qao[k] = ao ? AO_BYTE[o1 && o2 ? 0 : 3 - ((o1 ? 1 : 0) + (o2 ? 1 : 0) + (oc ? 1 : 0))]! : AO_OPEN;

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
    if (!ob) {
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
      this.qao[k] = AO_OPEN;
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
    this.boxFaceCorners(p, x, y, z, d, rot, ao);
    if (twoSided) this.commitDoubleSided(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, tile, flags, DIAG_AUTO);
    else this.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, tile, flags, DIAG_AUTO, false);
  }

  /** The scratch quad of boxFace (positions, uvs, light, AO) without committing it. */
  boxFaceCorners(p: number, x: number, y: number, z: number, d: number, rot: number, ao: boolean): void {
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
  }

  // ------------------------------------------------------------------ octant path (layered jobs)

  /**
   * The octant one half-cell step from octant reference r (padded cell * 8 + octant) along axis a,
   * toward + (s > 0) or - (s < 0): inside the same cell, or into the neighbour cell.
   */
  private step(r: number, a: number, s: number): number {
    const bit = 1 << a;
    if (s > 0) return (r & bit) !== 0 ? r + this.axisStride[a]! * OCT - bit : r + bit;
    return (r & bit) !== 0 ? r - bit : r - this.axisStride[a]! * OCT + bit;
  }

  /** The octant of reference r is held by opaque material. */
  private opaqueAt(r: number): boolean {
    return ((this.opq[r >> 3]! >> (r & 7)) & 1) !== 0;
  }

  /**
   * The octant formula O(V) of docs/SHAPES.md 8.3 for a vertex whose quarter face looks into the
   * front octant f, the vertex lying toward sign su along axis ua0 and sv along axis va0. Samples
   * side1 = f + su, side2 = f + sv, corner = f + su + sv (half-cell steps). An octant is an
   * occluder when opaque material holds it. AO: both sides = 0, else 3 - (side1 + side2 + corner).
   * Light: average of the cells of the four octants, occluders skipped, the corner skipped when
   * both sides are occluders, F's cell when nothing is left; octants in the same cell each count.
   * Results in sAo / sSky / sBlock; sPartial = one of the four octants lies in a partial cell. With
   * `onlyIfPartial`, AO and light are left alone when sPartial is false (the caller then averages).
   */
  private sampleOctants(f: number, ua0: number, su: number, va0: number, sv: number, onlyIfPartial: boolean): void {
    const s1 = this.step(f, ua0, su);
    const s2 = this.step(f, va0, sv);
    const c = this.step(s1, va0, sv);
    const fc = f >> 3;
    const c1 = s1 >> 3;
    const c2 = s2 >> 3;
    const cc = c >> 3;
    const of = this.opaqueAt(f);
    const o1 = this.opaqueAt(s1);
    const o2 = this.opaqueAt(s2);
    const oc = this.opaqueAt(c);
    const partial = this.partial;
    this.sPartial = (partial[fc]! | partial[c1]! | partial[c2]! | partial[cc]!) !== 0;
    if (onlyIfPartial && !this.sPartial) return;
    this.sAo = AO_BYTE[o1 && o2 ? 0 : 3 - ((o1 ? 1 : 0) + (o2 ? 1 : 0) + (oc ? 1 : 0))]!;
    const light = this.light;
    if (light === null) {
      this.sSky = NO_LIGHT_SKY;
      this.sBlock = NO_LIGHT_BLOCK;
      return;
    }
    let n = 0;
    let sky = 0;
    let blk = 0;
    let raw: number;
    if (!of) {
      raw = light[fc]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (!o1) {
      raw = light[c1]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (!o2) {
      raw = light[c2]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (!oc && !(o1 && o2)) {
      raw = light[cc]!;
      sky += raw >> 4;
      blk += raw & 15;
      n++;
    }
    if (n === 0) {
      raw = light[fc]!;
      sky = raw >> 4;
      blk = raw & 15;
      n = 1;
    }
    this.sSky = AVG_LIGHT[n * 61 + sky]!;
    this.sBlock = AVG_LIGHT[n * 61 + blk]!;
  }

  /**
   * O(V) at cell corner (cr, cu) (each 0 or 1, along the face's R and U axes) of face d of the
   * cell at padded index p: the vertex of the quadrant touching that corner. Returns its slot in the
   * vertex cache (which quarterFace has keyed to this cell face), computing it when not yet known:
   * the quarter face of that quadrant, if drawn, takes O(V) at that corner, so the slot holds the
   * same value either way.
   */
  private cornerValue(p: number, d: number, cr: number, cu: number): number {
    const slot = 9 + cr * 6 + cu * 2;
    if (((this.vertValid >> slot) & 1) === 0) {
      const na = d >> 1;
      const ra = FACE_R_AXIS[d]!;
      const ua = FACE_U_AXIS[d]!;
      const positive = (d & 1) === 0;
      const h = (positive ? 1 << na : 0) | (cr << ra) | (cu << ua);
      const f = this.step(p * OCT + h, na, positive ? 1 : -1);
      this.sampleOctants(f, ra, cr === 1 ? 1 : -1, ua, cu === 1 ? 1 : -1, false);
      const v = this.verts;
      v[slot] = this.sAo;
      v[VSLOTS + slot] = this.sSky;
      v[2 * VSLOTS + slot] = this.sBlock;
      this.vertValid |= 1 << slot;
    }
    return slot;
  }

  /**
   * Emit the quarter face of octant h (0..7) of the cell at padded index p, toward Dir d: a
   * 0.5 x 0.5 quad on the octant's face (on the cell boundary or on the cell's middle plane).
   * Positions and uvs follow boxFace (uv from the cell-local position, then `rot` quarter
   * turns). Light and AO per vertex follow docs/SHAPES.md 8.3: the octant formula O(V), except
   * that a vertex on a cell face that is an edge midpoint or the face centre takes the average of
   * the cell-corner values ((a + b + 1) >> 1, (a + b + c + e + 2) >> 2 per byte) when none of the
   * cells its O(V) would sample is partial. Culling is the caller's job; it must not call this for a
   * quarter face whose front octant is opaque (8.2 rule 1 never draws one).
   *
   * Vertex values are cached per cell face (padded cell p, Dir d): a vertex shared by several drawn
   * quarter faces of the same cell and direction on the same plane gets the same value from each of
   * them, so it is computed once. Why they agree: two such quarter faces' front octants F1, F2 are
   * both open (rule 1), and from either one O(V) samples the same four octants, the two front octants
   * and the two beyond them along the face (for faces meeting only at the face centre, the four
   * octants around the centre, whose cells are the same). An open octant in the side1 / side2 /
   * corner roles adds no AO, and the "corner skipped when both sides occlude" rule cannot apply
   * when a side is an open front octant; where it does apply (diagonal faces with both sides opaque)
   * F1 and F4 lie in the same cell, so the remaining light is the same. The corner averages and the
   * "a sampled cell is partial" test depend only on the vertex position.
   */
  quarterFace(g: GeometryBuilder, p: number, x: number, y: number, z: number, h: number, d: number, tile: number, rot: number, flags: number): void {
    const na = d >> 1;
    const positive = (d & 1) === 0;
    const f = this.step(p * OCT + h, na, positive ? 1 : -1);
    const ra = FACE_R_AXIS[d]!;
    const ua = FACE_U_AXIS[d]!;
    const rPos = FACE_R_SIGN[d]! > 0;
    const uPos = FACE_U_SIGN[d]! > 0;
    const qpos = this.qpos;
    const quv = this.quv;
    if (this.vertP !== p || this.vertD !== d) {
      this.vertP = p;
      this.vertD = d;
      this.vertValid = 0;
    }
    const verts = this.verts;
    for (let k = 0; k < 4; k++) {
      const i = (d * 8 + h) * 4 + k;
      qpos[k * 3] = x + QF_POS[i * 3]!;
      qpos[k * 3 + 1] = y + QF_POS[i * 3 + 1]!;
      qpos[k * 3 + 2] = z + QF_POS[i * 3 + 2]!;
      const cr = QF_RU[i * 2]!;
      const cu = QF_RU[i * 2 + 1]!;
      const u = rPos ? cr : 1 - cr;
      const v = uPos ? cu : 1 - cu;
      quv[k * 2] = rotU(rot, u, v);
      quv[k * 2 + 1] = rotV(rot, u, v);
      const slot = QF_SLOT[i]!;
      if (((this.vertValid >> slot) & 1) !== 0) {
        this.qao[k] = verts[slot]!;
        this.qsky[k] = verts[VSLOTS + slot]!;
        this.qblock[k] = verts[2 * VSLOTS + slot]!;
        continue;
      }
      const sign = QF_SIGN[i]!;
      const su = (sign & 1) !== 0 ? 1 : -1;
      const sv = (sign & 2) !== 0 ? 1 : -1;
      const rInt = (sign & 4) !== 0;
      const uInt = (sign & 8) !== 0;
      this.sampleOctants(f, ra, su, ua, sv, !(rInt && uInt));
      // A quarter face on the cell's middle plane looks into its own (partial) cell, so sPartial
      // always holds there: inner faces use O(V) at every vertex (8.3).
      if ((rInt && uInt) || this.sPartial) {
        this.qao[k] = this.sAo;
        this.qsky[k] = this.sSky;
        this.qblock[k] = this.sBlock;
      } else if (rInt) {
        // Midpoint of the cell edge at R = cr: average of its two cell corners.
        const a = this.cornerValue(p, d, cr, 0);
        const b = this.cornerValue(p, d, cr, 1);
        this.average2(k, a, b);
      } else if (uInt) {
        const a = this.cornerValue(p, d, 0, cu);
        const b = this.cornerValue(p, d, 1, cu);
        this.average2(k, a, b);
      } else {
        const a = this.cornerValue(p, d, 0, 0);
        const b = this.cornerValue(p, d, 1, 0);
        const c = this.cornerValue(p, d, 0, 1);
        const e = this.cornerValue(p, d, 1, 1);
        this.qao[k] = (verts[a]! + verts[b]! + verts[c]! + verts[e]! + 2) >> 2;
        this.qsky[k] = (verts[VSLOTS + a]! + verts[VSLOTS + b]! + verts[VSLOTS + c]! + verts[VSLOTS + e]! + 2) >> 2;
        this.qblock[k] = (verts[2 * VSLOTS + a]! + verts[2 * VSLOTS + b]! + verts[2 * VSLOTS + c]! + verts[2 * VSLOTS + e]! + 2) >> 2;
      }
      verts[slot] = this.qao[k]!;
      verts[VSLOTS + slot] = this.qsky[k]!;
      verts[2 * VSLOTS + slot] = this.qblock[k]!;
      this.vertValid |= 1 << slot;
    }
    this.commit(g, FACE_NX[d]!, FACE_NY[d]!, FACE_NZ[d]!, tile, flags, DIAG_AUTO, false);
  }

  /** Corner k of the scratch quad = the rounded average of the vertex-cache slots a and b. */
  private average2(k: number, a: number, b: number): void {
    const v = this.verts;
    this.qao[k] = (v[a]! + v[b]! + 1) >> 1;
    this.qsky[k] = (v[VSLOTS + a]! + v[VSLOTS + b]! + 1) >> 1;
    this.qblock[k] = (v[2 * VSLOTS + a]! + v[2 * VSLOTS + b]! + 1) >> 1;
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
      li[v * 4 + 2] = qao[k]!;
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
