/**
 * Pure builders for small GeometryData boxes and quads the renderer draws itself (item
 * cubes, falling blocks, blast crates, crack shells, glue decals). They use the exact
 * vertex layout of mesher output so they render with the shared voxel materials.
 * No three.js import; tested.
 */
import type { GeometryData } from '../../mesh/types';

/** Face order [+X, -X, +Y, -Y, +Z, -Z]. For each face: 4 corners (CCW seen from outside), each as unit-cube xyz. */
const FACE_CORNERS: readonly (readonly number[])[] = [
  // +X: u -> -Z, v -> +Y
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  // -X: u -> +Z
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
  // +Y: u -> +X, v -> -Z
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0],
  // -Y: u -> +X, v -> +Z
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
  // +Z: u -> +X
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  // -Z: u -> -X
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0],
];
const FACE_NORMALS: readonly (readonly number[])[] = [
  [127, 0, 0],
  [-127, 0, 0],
  [0, 127, 0],
  [0, -127, 0],
  [0, 0, 127],
  [0, 0, -127],
];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];

export interface BoxOptions {
  /** Min corner. */
  x0: number;
  y0: number;
  z0: number;
  /** Max corner. */
  x1: number;
  y1: number;
  z1: number;
  /** Tile layer per face, Dir order. */
  tiles: ArrayLike<number>;
  /** Per-vertex flags byte (VFLAG_*). */
  flags?: number;
}

function emptyGeometry(quads: number): GeometryData {
  const v = quads * 4;
  return {
    vertexCount: v,
    indexCount: quads * 6,
    positions: new Float32Array(v * 3),
    normals: new Int8Array(v * 3),
    uvs: new Float32Array(v * 2),
    layers: new Uint16Array(v),
    light: new Uint8Array(v * 4),
    indices: new Uint32Array(quads * 6),
  };
}

function writeQuadIndices(g: GeometryData, quad: number): void {
  const b = quad * 4;
  const o = quad * 6;
  g.indices[o] = b;
  g.indices[o + 1] = b + 1;
  g.indices[o + 2] = b + 2;
  g.indices[o + 3] = b;
  g.indices[o + 4] = b + 2;
  g.indices[o + 5] = b + 3;
}

/**
 * A box with one textured quad per face. Light bytes are full sky, no block light, open
 * AO: the per-object light uniforms of the voxel materials then shade it.
 */
export function buildBox(o: BoxOptions): GeometryData {
  const g = emptyGeometry(6);
  const sx = o.x1 - o.x0;
  const sy = o.y1 - o.y0;
  const sz = o.z1 - o.z0;
  const flags = o.flags ?? 0;
  for (let f = 0; f < 6; f++) {
    const c = FACE_CORNERS[f]!;
    const n = FACE_NORMALS[f]!;
    for (let k = 0; k < 4; k++) {
      const v = f * 4 + k;
      g.positions[v * 3] = o.x0 + c[k * 3]! * sx;
      g.positions[v * 3 + 1] = o.y0 + c[k * 3 + 1]! * sy;
      g.positions[v * 3 + 2] = o.z0 + c[k * 3 + 2]! * sz;
      g.normals[v * 3] = n[0]!;
      g.normals[v * 3 + 1] = n[1]!;
      g.normals[v * 3 + 2] = n[2]!;
      g.uvs[v * 2] = QUAD_UV[k * 2]!;
      g.uvs[v * 2 + 1] = QUAD_UV[k * 2 + 1]!;
      g.layers[v] = o.tiles[f]!;
      g.light[v * 4] = 255;
      g.light[v * 4 + 1] = 0;
      g.light[v * 4 + 2] = 255;
      g.light[v * 4 + 3] = flags;
    }
    writeQuadIndices(g, f);
  }
  return g;
}

/**
 * A square quad in the XY plane centred on the origin, facing +Z, side `size`, one tile.
 * With `twoSided` a back copy facing -Z follows (reversed winding, mirrored u so the image is
 * not flipped when seen from behind): the voxel materials cull back faces in every pass, as
 * the mesh contract requires, so two-sided things carry both faces. Used for item icons.
 */
export function buildQuad(size: number, tile: number, flags = 0, twoSided = false): GeometryData {
  const g = emptyGeometry(twoSided ? 2 : 1);
  const h = size * 0.5;
  const xs = [-h, h, h, -h];
  const ys = [-h, -h, h, h];
  for (let side = 0; side < (twoSided ? 2 : 1); side++) {
    for (let k = 0; k < 4; k++) {
      // The back copy walks the corners in reverse x order: (h,-h), (-h,-h), (-h,h), (h,h).
      const v = side * 4 + k;
      g.positions[v * 3] = side === 0 ? xs[k]! : -xs[k]!;
      g.positions[v * 3 + 1] = ys[k]!;
      g.positions[v * 3 + 2] = 0;
      g.normals[v * 3 + 2] = side === 0 ? 127 : -127;
      g.uvs[v * 2] = QUAD_UV[k * 2]!;
      g.uvs[v * 2 + 1] = QUAD_UV[k * 2 + 1]!;
      g.layers[v] = tile;
      g.light[v * 4] = 255;
      g.light[v * 4 + 2] = 255;
      g.light[v * 4 + 3] = flags;
    }
    writeQuadIndices(g, side);
  }
  return g;
}


// ---------------------------------------------------------------- octant-mask overlays
//
// The overlays that follow a part's shape (docs/SHAPES.md 8.6) are built here from an octant mask
// (fill: bit o set = octant o, o = ox | oy << 1 | oz << 2, occupies [ox/2, ox/2 + 0.5) x ... of the
// cell) or from a face's quadrant mask (docs/SHAPES.md 2.3). The renderer caches the result per
// mask (256 fills, 16 quadrant masks). All coordinates below are in cell units, (0, 0, 0) the
// cell's min corner, unless a comment says "half units" (the half-cell lattice, 0..2 per axis).
//
// Inflation. An overlay sits a hair outside the shape so it does not z-fight with the block. Every
// point of the half-cell lattice gets a push direction per axis, away from the filled octants
// around it: with the 8 octants around a vertex (octants outside the cell count as empty), the
// sign along axis a of sum(filled ? -side : +side), side = +1 for the octants on the vertex's high
// side of a and -1 for those on its low side. For a cell corner of a full block that is "outwards"
// on all three axes; for a vertex in the middle of a flat face, 0 in the face plane and outwards
// along the normal; on a concave (inner) edge, towards the empty octant. Edges use the same rule
// with the 4 octants around them, faces push along their own normal. A full block's overlays are
// therefore exactly the inflated unit cube they always were.

/** Octant (i, j, k) in half units (each 0..1 inside the cell) is filled; outside the cell it is empty. */
function octantFilled(fill: number, i: number, j: number, k: number): boolean {
  if (i < 0 || i > 1 || j < 0 || j > 1 || k < 0 || k > 1) return false;
  return ((fill >> (i | (j << 1) | (k << 2))) & 1) === 1;
}

/** Push sign (-1, 0, 1) along `axis` of the lattice vertex (vx, vy, vz) (half units 0..2), see above. */
function vertexPush(fill: number, vx: number, vy: number, vz: number, axis: number): number {
  let s = 0;
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const side = (axis === 0 ? i : axis === 1 ? j : k) === 1 ? 1 : -1;
        s += octantFilled(fill, vx - 1 + i, vy - 1 + j, vz - 1 + k) ? -side : side;
      }
    }
  }
  return Math.sign(s);
}

/** Lattice point with coordinate `t` on axis `a` and `u`, `v` on the other two axes (u < v by axis number). */
function latticePoint(a: number, t: number, u: number, v: number, out: number[]): number[] {
  const ua = a === 0 ? 1 : 0;
  const va = a === 2 ? 1 : 2;
  out[a] = t;
  out[ua] = u;
  out[va] = v;
  return out;
}

/**
 * Outline of an octant mask as line segments (6 floats per segment: two endpoints), inflated by
 * `inflate` (docs/SHAPES.md 8.6). Every lattice edge of length 0.5 is looked at with the 4 octants
 * around it: drawn when 1 or 3 of them are filled, or 2 that touch only along the edge (diagonal);
 * not drawn for 0, 4, or 2 side by side (the edge lies inside a flat face). Two drawn edges in a
 * row on the same line with the same push become one segment. A full mask gives the 12 edges of
 * the unit cube grown by `inflate` on every side; an empty mask gives nothing.
 *
 * Where the line sits: a drawn edge is pushed off the shape across its line by `inflate` on both
 * other axes, into an empty quadrant around it (for 1 or 3 filled octants the push of the
 * inflation rule above, which points there). A diagonal edge has two empty quadrants and no push of
 * its own: it is drawn twice, once pushed into each, so it shows from both open sides and never
 * lies on the faces of the two octants (where it would z-fight with them). A segment end is pushed
 * along its line by the rule of its vertex only when that keeps it outside every filled octant:
 * the push across comes from the 4 octants around the edge and the push along from the 8 around
 * the vertex, and at a vertex where a filled octant lies beyond the end in the quadrant the line
 * sits in, pushing along would put the end inside it (it then stays at the vertex, on the
 * octant's face).
 */
export function outlineSegments(fill: number, inflate: number): Float32Array {
  const out: number[] = [];
  const p = [0, 0, 0];
  // Pushes (pu, pv, each -1 or 1) of the two half edges of one line (t = 0, 1): up to two each.
  const pushes: number[][] = [[], []];
  for (let a = 0; a < 3; a++) {
    for (let v = 0; v <= 2; v++) {
      for (let u = 0; u <= 2; u++) {
        // The half edges along axis a on the line (u, v).
        for (let t = 0; t < 2; t++) {
          const list = pushes[t]!;
          list.length = 0;
          let n = 0;
          let su = 0;
          let sv = 0;
          let diag = 0;
          let empty = 0; // bit ju | jv << 1 set = that quadrant is empty
          for (let jv = 0; jv < 2; jv++) {
            for (let ju = 0; ju < 2; ju++) {
              latticePoint(a, t, u - 1 + ju, v - 1 + jv, p);
              const f = octantFilled(fill, p[0]!, p[1]!, p[2]!);
              if (f) {
                n++;
                diag += ju === jv ? 1 : -1;
              } else {
                empty |= 1 << (ju | (jv << 1));
              }
              su += f ? (ju === 1 ? -1 : 1) : ju === 1 ? 1 : -1;
              sv += f ? (jv === 1 ? -1 : 1) : jv === 1 ? 1 : -1;
            }
          }
          if (n === 1 || n === 3) {
            list.push(Math.sign(su), Math.sign(sv));
          } else if (n === 2 && Math.abs(diag) === 2) {
            for (let q = 0; q < 4; q++) if (((empty >> q) & 1) === 1) list.push((q & 1) === 1 ? 1 : -1, (q & 2) !== 0 ? 1 : -1);
          }
        }
        // A push drawn on both halves is one segment over the whole line, else one per half.
        const p0 = pushes[0]!;
        const p1 = pushes[1]!;
        for (let i = 0; i < p0.length; i += 2) {
          const both = hasPush(p1, p0[i]!, p0[i + 1]!);
          emitSegment(fill, a, 0, both ? 2 : 1, u, v, p0[i]!, p0[i + 1]!, inflate, out);
        }
        for (let i = 0; i < p1.length; i += 2) {
          if (!hasPush(p0, p1[i]!, p1[i + 1]!)) emitSegment(fill, a, 1, 2, u, v, p1[i]!, p1[i + 1]!, inflate, out);
        }
      }
    }
  }
  return new Float32Array(out);
}

function hasPush(list: readonly number[], pu: number, pv: number): boolean {
  for (let i = 0; i < list.length; i += 2) if (list[i] === pu && list[i + 1] === pv) return true;
  return false;
}

function emitSegment(fill: number, a: number, t0: number, t1: number, u: number, v: number, pu: number, pv: number, e: number, out: number[]): void {
  const p = [0, 0, 0];
  for (const t of [t0, t1]) {
    latticePoint(a, t, u, v, p);
    let along = vertexPush(fill, p[0]!, p[1]!, p[2]!, a);
    if (along !== 0) {
      // The octant the pushed end would lie strictly inside (pu and pv are never 0 here).
      latticePoint(a, along > 0 ? t : t - 1, pu > 0 ? u : u - 1, pv > 0 ? v : v - 1, p);
      if (octantFilled(fill, p[0]!, p[1]!, p[2]!)) along = 0;
    }
    const q = latticePoint(a, t * 0.5 + along * e, u * 0.5 + pu * e, v * 0.5 + pv * e, [0, 0, 0]);
    out.push(q[0]!, q[1]!, q[2]!);
  }
}

/** Indexed triangle geometry without a tile layer (the overlays sample their own tile). */
export interface OverlayGeometry {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit normal per vertex. */
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

class QuadWriter {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  /** One quad: corners counter-clockwise seen from the front, each xyz + uv, all with normal n. */
  quad(c: readonly number[], uvs: readonly number[], n: readonly number[]): void {
    const b = this.pos.length / 3;
    for (let k = 0; k < 4; k++) {
      this.pos.push(c[k * 3]!, c[k * 3 + 1]!, c[k * 3 + 2]!);
      this.nrm.push(n[0]!, n[1]!, n[2]!);
      this.uv.push(uvs[k * 2]!, uvs[k * 2 + 1]!);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  done(): OverlayGeometry {
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), uvs: new Float32Array(this.uv), indices: new Uint16Array(this.idx) };
  }
}

const UNIT_NORMALS: readonly (readonly number[])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Position (cell units, before inflation) of the point with tile coordinates (tu, tv) on face
 * `d` lying in the plane `plane` (cell units on the face's axis). The tile coordinates are the
 * block face's own: seen from outside, u grows to the right and v upwards (+X: u = 1 - z, v = y;
 * -X: u = z, v = y; +Y: u = x, v = 1 - z; -Y: u = x, v = z; +Z: u = x, v = y; -Z: u = 1 - x,
 * v = y), as three's BoxGeometry lays them out, so a crack tile lies on a part's face the way it
 * lay on a whole block's face.
 */
function facePoint(d: number, plane: number, tu: number, tv: number, out: number[]): number[] {
  switch (d) {
    case 0:
      out[0] = plane;
      out[1] = tv;
      out[2] = 1 - tu;
      break;
    case 1:
      out[0] = plane;
      out[1] = tv;
      out[2] = tu;
      break;
    case 2:
      out[0] = tu;
      out[1] = plane;
      out[2] = 1 - tv;
      break;
    case 3:
      out[0] = tu;
      out[1] = plane;
      out[2] = tv;
      break;
    case 4:
      out[0] = tu;
      out[1] = tv;
      out[2] = plane;
      break;
    default:
      out[0] = 1 - tu;
      out[1] = tv;
      out[2] = plane;
  }
  return out;
}

/**
 * The crack shell of an octant mask (docs/SHAPES.md 8.6): every quarter face of a filled octant
 * whose neighbour across it is not in the mask (the cell's outside counts as not in it), pushed
 * `offset` out along its normal and, in its plane, `offset` outwards at the shape's convex edges
 * (see the inflation note above). The four quarters of a face plane that are all present become
 * one quad. uv = the face's tile coordinates of the point (facePoint), so the crack tile is cut
 * the way the block's own face is. A full mask gives the six faces of the unit cube grown by
 * `offset` on every side (the crack box of a whole block); an empty mask gives nothing.
 */
export function crackShell(fill: number, offset: number): OverlayGeometry {
  const w = new QuadWriter();
  const c = new Array<number>(12);
  const uvs = new Array<number>(8);
  const p = [0, 0, 0];
  const lat = [0, 0, 0];
  for (let d = 0; d < 6; d++) {
    const a = d >> 1;
    const pos = (d & 1) === 0;
    for (let plane = 0; plane <= 2; plane++) {
      // The quadrants of this plane that carry a face of direction d, as tile-space squares.
      let quads = 0;
      for (let hv = 0; hv < 2; hv++) {
        for (let hu = 0; hu < 2; hu++) {
          // The square [hu, hu + 1] x [hv, hv + 1] of tile space (half units); its centre in the cell:
          facePoint(d, plane * 0.5, (hu + 0.5) * 0.5, (hv + 0.5) * 0.5, p);
          const inner = pos ? plane - 1 : plane;
          const outer = pos ? plane : plane - 1;
          const ci = [Math.floor(p[0]! * 2), Math.floor(p[1]! * 2), Math.floor(p[2]! * 2)];
          ci[a] = inner;
          const filled = octantFilled(fill, ci[0]!, ci[1]!, ci[2]!);
          ci[a] = outer;
          const covered = octantFilled(fill, ci[0]!, ci[1]!, ci[2]!);
          if (filled && !covered) quads |= 1 << (hu | (hv << 1));
        }
      }
      if (quads === 0) continue;
      const emit = (u0: number, v0: number, u1: number, v1: number): void => {
        const corners = [u0, v0, u1, v0, u1, v1, u0, v1];
        for (let k = 0; k < 4; k++) {
          const tu = corners[k * 2]! * 0.5;
          const tv = corners[k * 2 + 1]! * 0.5;
          facePoint(d, plane * 0.5, tu, tv, p);
          lat[0] = Math.round(p[0]! * 2);
          lat[1] = Math.round(p[1]! * 2);
          lat[2] = Math.round(p[2]! * 2);
          for (let ax = 0; ax < 3; ax++) {
            const push = ax === a ? (pos ? 1 : -1) : vertexPush(fill, lat[0]!, lat[1]!, lat[2]!, ax);
            c[k * 3 + ax] = p[ax]! + push * offset;
          }
          uvs[k * 2] = tu;
          uvs[k * 2 + 1] = tv;
        }
        w.quad(c, uvs, UNIT_NORMALS[d]!);
      };
      if (quads === 15) {
        emit(0, 0, 2, 2);
        continue;
      }
      for (let q = 0; q < 4; q++) if ((quads >> q) & 1) emit(q & 1, q >> 1, (q & 1) + 1, (q >> 1) + 1);
    }
  }
  return w.done();
}

/**
 * Rotations taking an overlay's own frame (a face lying in its z = 0 plane, normal +Z) onto each
 * face Dir, column-major 3x3: columns are the images of local +X, +Y, +Z.
 */
export const FACE_ROT: readonly (readonly number[])[] = [
  [0, 0, -1, 0, 1, 0, 1, 0, 0], // +X: Ry(+90)
  [0, 0, 1, 0, 1, 0, -1, 0, 0], // -X: Ry(-90)
  [1, 0, 0, 0, 0, -1, 0, 1, 0], // +Y: Rx(-90)
  [1, 0, 0, 0, 0, 1, 0, -1, 0], // -Y: Rx(+90)
  [1, 0, 0, 0, 1, 0, 0, 0, 1], // +Z
  [-1, 0, 0, 0, 1, 0, 0, 0, -1], // -Z: Ry(180)
];

/**
 * A face's quadrant mask (docs/SHAPES.md 2.3: q = hu | hv << 1 on the face's axes u < v, bit q set
 * = quadrant q) as the 2 x 2 squares of the overlay's own frame (FACE_ROT[dir]): bit (i | j << 1)
 * set = the square [i/2 - 1/2, i/2] x [j/2 - 1/2, j/2] of local x, y. The same quadrant mask means
 * the same squares of space from both sides of a face (2.3), so the frame of face d and of d ^ 1
 * see the same squares.
 */
export function localQuadrants(dir: number, quads: number): number {
  return LOCAL_QUADRANTS[dir * 16 + (quads & 15)]!;
}

/** localQuadrants for every (dir, quads), dir * 16 + quads: a list of faces is sorted by it whenever a new list arrives. */
const LOCAL_QUADRANTS: Uint8Array = (() => {
  const t = new Uint8Array(6 * 16);
  for (let dir = 0; dir < 6; dir++) {
    const r = FACE_ROT[dir]!;
    const a = dir >> 1;
    const ua = a === 0 ? 1 : 0;
    const va = a === 2 ? 1 : 2;
    for (let quads = 0; quads < 16; quads++) {
      let out = 0;
      for (let q = 0; q < 4; q++) {
        if (((quads >> q) & 1) === 0) continue;
        // Centre of quadrant q relative to the face centre, world axes.
        const wv = [0, 0, 0];
        wv[ua] = (q & 1) === 1 ? 0.25 : -0.25;
        wv[va] = (q & 2) === 2 ? 0.25 : -0.25;
        const lx = wv[0]! * r[0]! + wv[1]! * r[1]! + wv[2]! * r[2]!;
        const ly = wv[0]! * r[3]! + wv[1]! * r[4]! + wv[2]! * r[5]!;
        out |= 1 << ((lx > 0 ? 1 : 0) | ((ly > 0 ? 1 : 0) << 1));
      }
      t[dir * 16 + quads] = out;
    }
  }
  return t;
})();

/**
 * Glue decal / x-ray ghost of a face in the overlay's own frame (z = 0 plane, normal +Z): the
 * squares of a local quadrant mask (localQuadrants), uv = (x + 1/2, y + 1/2) so each square shows
 * its part of the full-face tile. All four squares give the single 1 x 1 quad of a whole face.
 */
export function faceQuads(local: number): OverlayGeometry {
  const w = new QuadWriter();
  const n = [0, 0, 1];
  const quad = (x0: number, y0: number, x1: number, y1: number): void => {
    w.quad([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], [x0 + 0.5, y0 + 0.5, x1 + 0.5, y0 + 0.5, x1 + 0.5, y1 + 0.5, x0 + 0.5, y1 + 0.5], n);
  };
  if ((local & 15) === 15) {
    quad(-0.5, -0.5, 0.5, 0.5);
  } else {
    for (let s = 0; s < 4; s++) {
      if (((local >> s) & 1) === 0) continue;
      const x0 = (s & 1) * 0.5 - 0.5;
      const y0 = (s >> 1) * 0.5 - 0.5;
      quad(x0, y0, x0 + 0.5, y0 + 0.5);
    }
  }
  return w.done();
}

/** Square (i, j) of a local quadrant mask is set; outside the face (i or j not 0..1) it is not. */
function squareSet(local: number, i: number, j: number): boolean {
  if (i < 0 || i > 1 || j < 0 || j > 1) return false;
  return ((local >> (i | (j << 1))) & 1) === 1;
}

/** Push sign along local axis `axis` (0 x, 1 y) of the face lattice point (vi, vj) (0..2), as vertexPush in 2D. */
function squarePush(local: number, vi: number, vj: number, axis: number): number {
  let s = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const side = (axis === 0 ? i : j) === 1 ? 1 : -1;
      s += squareSet(local, vi - 1 + i, vj - 1 + j) ? -side : side;
    }
  }
  return Math.sign(s);
}

/**
 * The glue bead of a covered face in the overlay's own frame (the glued face in z = 0, the cell on
 * the -Z side and its neighbour on the +Z side): a band `width` thick across the face plane
 * (z from -width/2 to width/2) running along the outline of the local quadrant mask's squares,
 * facing outwards and standing `lift` proud of it; at the outline's convex corners the bands reach
 * `lift` past the corner, so they meet. Each band is a strip of one or more collinear half edges.
 * uv: u along the band (0..1), v across the seam (0 on the -Z side, 1 on the +Z side). All four
 * squares give the four sides of the box [-h, h]^2 x [-width/2, width/2], h = 1/2 + lift: the bead of
 * a whole face.
 */
export function beadStrips(local: number, width: number, lift: number): OverlayGeometry {
  const w = new QuadWriter();
  const z0 = -width / 2;
  const z1 = width / 2;
  for (let axis = 0; axis < 2; axis++) {
    // Edges along `axis` (0: along x, at lattice line j; 1: along y, at lattice line i).
    for (let line = 0; line <= 2; line++) {
      let start = -1;
      let startDir = 0;
      for (let t = 0; t <= 2; t++) {
        let dir = 0;
        if (t < 2) {
          const below = axis === 0 ? squareSet(local, t, line - 1) : squareSet(local, line - 1, t);
          const above = axis === 0 ? squareSet(local, t, line) : squareSet(local, line, t);
          dir = below === above ? 0 : below ? 1 : -1; // outward normal, along the other axis
        }
        if (start >= 0 && dir !== startDir) {
          strip(local, axis, line, start, t, startDir, z0, z1, lift, w);
          start = -1;
        }
        if (dir !== 0 && start < 0) {
          start = t;
          startDir = dir;
        }
      }
    }
  }
  return w.done();
}

function strip(local: number, axis: number, line: number, t0: number, t1: number, dir: number, z0: number, z1: number, lift: number, w: QuadWriter): void {
  // Along-axis ends, pushed at convex corners; the band's plane is the line pushed by `dir`.
  const e0 = (axis === 0 ? squarePush(local, t0, line, 0) : squarePush(local, line, t0, 1)) * lift + t0 * 0.5 - 0.5;
  const e1 = (axis === 0 ? squarePush(local, t1, line, 0) : squarePush(local, line, t1, 1)) * lift + t1 * 0.5 - 0.5;
  const c = line * 0.5 - 0.5 + dir * lift;
  // Corners (a, z0) (b, z0) (b, z1) (a, z1) with a -> b counter-clockwise around +Z seen from
  // outside the band: for an outward normal +y along x that is from high x to low x.
  const n = axis === 0 ? [0, dir, 0] : [dir, 0, 0];
  let a: [number, number];
  let b: [number, number];
  if (axis === 0) {
    a = dir > 0 ? [e1, c] : [e0, c];
    b = dir > 0 ? [e0, c] : [e1, c];
  } else {
    a = dir > 0 ? [c, e0] : [c, e1];
    b = dir > 0 ? [c, e1] : [c, e0];
  }
  w.quad([a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z1], [0, 0, 1, 0, 1, 1, 0, 1], n);
}
