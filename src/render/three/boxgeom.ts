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
 * Used for flat item icons (drawn double-sided) and glue decals (instanced, oriented per face).
 */
export function buildQuad(size: number, tile: number, flags = 0): GeometryData {
  const g = emptyGeometry(1);
  const h = size * 0.5;
  const xs = [-h, h, h, -h];
  const ys = [-h, -h, h, h];
  for (let k = 0; k < 4; k++) {
    g.positions[k * 3] = xs[k]!;
    g.positions[k * 3 + 1] = ys[k]!;
    g.positions[k * 3 + 2] = 0;
    g.normals[k * 3 + 2] = 127;
    g.uvs[k * 2] = QUAD_UV[k * 2]!;
    g.uvs[k * 2 + 1] = QUAD_UV[k * 2 + 1]!;
    g.layers[k] = tile;
    g.light[k * 4] = 255;
    g.light[k * 4 + 2] = 255;
    g.light[k * 4 + 3] = flags;
  }
  writeQuadIndices(g, 0);
  return g;
}

/** The 12 edges of a box as 24 line-segment endpoints (xyz each). */
export function boxEdges(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const out = new Float32Array(e.length * 3);
  for (let i = 0; i < e.length; i++) {
    const c = p[e[i]!]!;
    out[i * 3] = c[0]!;
    out[i * 3 + 1] = c[1]!;
    out[i * 3 + 2] = c[2]!;
  }
  return out;
}
