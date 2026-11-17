/** Test helpers for the mesher: building inputs and decoding MeshData into quads. */
import { expect } from 'vitest';
import type { GeometryData, MeshData, MeshInput } from '../../src/mesh/types';

export type GroupName = 'opaque' | 'cutout' | 'translucent';
export const GROUPS: readonly GroupName[] = ['opaque', 'cutout', 'translucent'];

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Quad {
  group: GroupName;
  /** Corner positions in vertex order. */
  p: V3[];
  /** Normal of corner 0 as a float vector (bytes / 127). */
  n: V3;
  /** Raw normal bytes of corner 0. */
  nb: [number, number, number];
  uv: Array<[number, number]>;
  tile: number;
  sky: number[];
  block: number[];
  ao: number[];
  flags: number[];
  /** The 6 indices, relative to the quad's first vertex. */
  idx: number[];
}

/** A box input with dims sx*sy*sz, AIR everywhere, optional light (default sky 15). */
export function makeInput(sx: number, sy: number, sz: number, light: boolean | number = false): MeshInput {
  const n = (sx + 2) * (sy + 2) * (sz + 2);
  const l = light === false ? null : new Uint8Array(n).fill(light === true ? 0xf0 : light);
  return { sx, sy, sz, cells: new Uint16Array(n), light: l };
}

/** Padded index of cell (x,y,z) given in INTERIOR coordinates (margin = -1 and s). */
export function idx(input: MeshInput, x: number, y: number, z: number): number {
  const px = input.sx + 2;
  const pz = input.sz + 2;
  return x + 1 + (z + 1) * px + (y + 1) * px * pz;
}

export function put(input: MeshInput, x: number, y: number, z: number, cell: number): void {
  input.cells[idx(input, x, y, z)] = cell;
}

export function putLight(input: MeshInput, x: number, y: number, z: number, sky: number, block = 0): void {
  input.light![idx(input, x, y, z)] = (sky << 4) | block;
}

export function quadsOf(g: GeometryData | null, group: GroupName): Quad[] {
  if (!g) return [];
  const out: Quad[] = [];
  const q = g.vertexCount / 4;
  for (let i = 0; i < q; i++) {
    const p: V3[] = [];
    const uv: Array<[number, number]> = [];
    const sky: number[] = [];
    const block: number[] = [];
    const ao: number[] = [];
    const flags: number[] = [];
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      p.push({ x: g.positions[v * 3]!, y: g.positions[v * 3 + 1]!, z: g.positions[v * 3 + 2]! });
      uv.push([g.uvs[v * 2]!, g.uvs[v * 2 + 1]!]);
      sky.push(g.light[v * 4]!);
      block.push(g.light[v * 4 + 1]!);
      ao.push(g.light[v * 4 + 2]!);
      flags.push(g.light[v * 4 + 3]!);
    }
    const v0 = i * 4;
    const nb: [number, number, number] = [g.normals[v0 * 3]!, g.normals[v0 * 3 + 1]!, g.normals[v0 * 3 + 2]!];
    const idxs: number[] = [];
    for (let j = 0; j < 6; j++) idxs.push(g.indices[i * 6 + j]! - v0);
    out.push({ group, p, n: { x: nb[0] / 127, y: nb[1] / 127, z: nb[2] / 127 }, nb, uv, tile: g.layers[v0]!, sky, block, ao, flags, idx: idxs });
  }
  return out;
}

export function allQuads(m: MeshData): Quad[] {
  return [...quadsOf(m.opaque, 'opaque'), ...quadsOf(m.cutout, 'cutout'), ...quadsOf(m.translucent, 'translucent')];
}

export function quadCount(m: MeshData): number {
  let n = 0;
  for (const g of [m.opaque, m.cutout, m.translucent]) if (g) n += g.vertexCount / 4;
  return n;
}

export function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function cross(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function len(a: V3): number {
  return Math.sqrt(dot(a, a));
}

/** Normal byte vector of an axis direction. */
export const AXIS_NORMALS: ReadonlyArray<[number, number, number]> = [
  [127, 0, 0],
  [-127, 0, 0],
  [0, 127, 0],
  [0, -127, 0],
  [0, 0, 127],
  [0, 0, -127],
];

/** Dir index of an axis-aligned quad's normal, or -1. */
export function dirOfQuad(q: Quad): number {
  return AXIS_NORMALS.findIndex((a) => a[0] === q.nb[0] && a[1] === q.nb[1] && a[2] === q.nb[2]);
}

/**
 * Structural invariants every MeshData must satisfy: sizes consistent, each quad's 6
 * indices address its own 4 vertices, every triangle counter-clockwise around the normal,
 * normals unit-length, finite positions, uv in [0,1].
 */
export function checkInvariants(m: MeshData): void {
  for (const name of GROUPS) {
    const g = m[name];
    if (!g) continue;
    expect(g.vertexCount % 4).toBe(0);
    expect(g.vertexCount).toBeGreaterThan(0);
    expect(g.indexCount).toBe((g.vertexCount / 4) * 6);
    expect(g.positions.length).toBe(g.vertexCount * 3);
    expect(g.normals.length).toBe(g.vertexCount * 3);
    expect(g.uvs.length).toBe(g.vertexCount * 2);
    expect(g.layers.length).toBe(g.vertexCount);
    expect(g.light.length).toBe(g.vertexCount * 4);
    expect(g.indices.length).toBe(g.indexCount);
    // Raw-array loops with plain throws: this runs on thousands of meshes per test file.
    const P = g.positions;
    const N = g.normals;
    for (let i = 0; i < g.indexCount; i++) {
      const v = g.indices[i]!;
      if (v >= g.vertexCount) throw new Error(`${name}: index ${v} >= vertexCount ${g.vertexCount}`);
      if (v >> 2 !== Math.floor(i / 6)) throw new Error(`${name}: quad ${Math.floor(i / 6)} uses vertex ${v} of another quad`);
    }
    for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i]!)) throw new Error(`${name}: non-finite position`);
    for (let i = 0; i < g.uvs.length; i++) {
      const u = g.uvs[i]!;
      if (!(u >= -1e-6 && u <= 1 + 1e-6)) throw new Error(`${name}: uv out of range: ${u}`);
    }
    for (let v = 0; v < g.vertexCount; v++) {
      const nx = N[v * 3]! / 127;
      const ny = N[v * 3 + 1]! / 127;
      const nz = N[v * 3 + 2]! / 127;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (Math.abs(nl - 1) > 0.02) throw new Error(`${name}: normal not unit: ${nl}`);
      if (N[v * 3] !== N[(v & ~3) * 3] || N[v * 3 + 1] !== N[(v & ~3) * 3 + 1] || N[v * 3 + 2] !== N[(v & ~3) * 3 + 2]) {
        throw new Error(`${name}: corners of one quad disagree on the normal`);
      }
      if (g.layers[v] !== g.layers[v & ~3]) throw new Error(`${name}: corners of one quad disagree on the tile`);
    }
    for (let t = 0; t < g.indexCount; t += 3) {
      const a = g.indices[t]! * 3;
      const b = g.indices[t + 1]! * 3;
      const c = g.indices[t + 2]! * 3;
      const e1x = P[b]! - P[a]!;
      const e1y = P[b + 1]! - P[a + 1]!;
      const e1z = P[b + 2]! - P[a + 2]!;
      const e2x = P[c]! - P[a]!;
      const e2y = P[c + 1]! - P[a + 1]!;
      const e2z = P[c + 2]! - P[a + 2]!;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const area = cx * N[a]! + cy * N[a + 1]! + cz * N[a + 2]!;
      if (!(area > 0)) throw new Error(`${name}: triangle ${t / 3} not CCW around its normal (area ${area})`);
    }
  }
}

/** Throw unless every vertex lies inside [lo, hi]^3. */
export function checkInsideBox(m: MeshData, lo: number, hi: number): void {
  for (const name of GROUPS) {
    const g = m[name];
    if (!g) continue;
    for (let i = 0; i < g.positions.length; i++) {
      const c = g.positions[i]!;
      if (!(c >= lo && c <= hi)) throw new Error(`${name}: vertex coordinate ${c} outside [${lo}, ${hi}]`);
    }
  }
}

/**
 * Texture frame of a quad: dP/du and dP/dv solved from corners 0, 1, 3. The tile is
 * unmirrored when (dP/du x dP/dv) points along the normal.
 */
export function uvFrame(q: Quad): { du: V3; dv: V3 } {
  const e1 = sub(q.p[1]!, q.p[0]!);
  const e2 = sub(q.p[3]!, q.p[0]!);
  const a = q.uv[1]![0] - q.uv[0]![0];
  const b = q.uv[3]![0] - q.uv[0]![0];
  const c = q.uv[1]![1] - q.uv[0]![1];
  const d = q.uv[3]![1] - q.uv[0]![1];
  // [e1 e2] = [du dv] * [[a b],[c d]]  ->  [du dv] = [e1 e2] * inv
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const du = { x: e1.x * ia + e2.x * ic, y: e1.y * ia + e2.y * ic, z: e1.z * ia + e2.z * ic };
  const dv = { x: e1.x * ib + e2.x * id, y: e1.y * ib + e2.y * id, z: e1.z * ib + e2.z * id };
  return { du, dv };
}

/** Bounding box of all vertices of a mesh. */
export function bounds(m: MeshData): { min: V3; max: V3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const q of allQuads(m)) {
    for (const p of q.p) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }
  }
  return { min, max };
}

/** The vertex of quad q at a position (within eps), or -1. */
export function cornerAt(q: Quad, x: number, y: number, z: number, eps = 1e-5): number {
  return q.p.findIndex((p) => Math.abs(p.x - x) < eps && Math.abs(p.y - y) < eps && Math.abs(p.z - z) < eps);
}

/** Which diagonal the quad's triangles share: '02' or '13'. */
export function diagonalOf(q: Quad): '02' | '13' {
  const t1 = new Set(q.idx.slice(0, 3));
  const t2 = new Set(q.idx.slice(3, 6));
  const shared = [...t1].filter((v) => t2.has(v)).sort();
  return shared[0] === 0 && shared[1] === 2 ? '02' : '13';
}
