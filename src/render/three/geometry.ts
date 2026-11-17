/**
 * GeometryData (mesher output) -> THREE.BufferGeometry, zero-copy wherever the backend
 * allows it, with bounds supplied by the caller instead of scanning vertices.
 *
 * Ownership: the attributes wrap the caller's typed arrays, and three reads them when the
 * geometry is first drawn (possibly frames later). The backend therefore owns MeshData arrays
 * once they are handed over: callers must not modify, recycle or transfer them. After the
 * first draw the backend drops its references (backend.ts releaseGeometryArrays).
 */
import * as THREE from 'three/webgpu';
import type { GeometryData } from '../../mesh/types';

export interface GeometryOptions {
  /**
   * WebGPU vertex buffers need a 4-byte stride and have no 3 x int8 format. three pads such
   * attributes itself but allocates a subarray per vertex to do it; padding here is a single
   * tight loop. WebGL2 takes the 3-byte normals as they are.
   */
  padNormals: boolean;
}

function view<T extends Float32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array>(a: T, n: number): T {
  return (a.length === n ? a : a.subarray(0, n)) as T;
}

/** Builds the geometry. Bounds must be set by the caller (setSectionBounds / computeBoundsFromPositions). */
export function toBufferGeometry(g: GeometryData, opts: GeometryOptions): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const vc = g.vertexCount;
  geo.setAttribute('position', new THREE.BufferAttribute(view(g.positions, vc * 3), 3));
  if (opts.padNormals) {
    const src = g.normals;
    const dst = new Int8Array(vc * 4);
    for (let i = 0, j = 0, k = 0; i < vc; i++, j += 3, k += 4) {
      dst[k] = src[j]!;
      dst[k + 1] = src[j + 1]!;
      dst[k + 2] = src[j + 2]!;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(dst, 4, true));
  } else {
    geo.setAttribute('normal', new THREE.BufferAttribute(view(g.normals, vc * 3), 3, true));
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(view(g.uvs, vc * 2), 2));
  // Integer attribute: WebGL must bind it with vertexAttribIPointer (gpuType = IntType) to
  // match the `uint` shader input; WebGPU widens it to uint32 itself.
  const layer = new THREE.BufferAttribute(view(g.layers, vc), 1);
  layer.gpuType = THREE.IntType;
  geo.setAttribute('layer', layer);
  geo.setAttribute('vlight', new THREE.BufferAttribute(view(g.light, vc * 4), 4, true));
  geo.setIndex(new THREE.BufferAttribute(view(g.indices, g.indexCount), 1));
  return geo;
}

/** Bounds of a mesh box of `size` cells (positions within [0,size]^3) plus a margin for vertex animation. */
export function setBoxBounds(geo: THREE.BufferGeometry, sx: number, sy: number, sz: number, margin: number): void {
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-margin, -margin, -margin), new THREE.Vector3(sx + margin, sy + margin, sz + margin));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx / 2, sy / 2, sz / 2), 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz) + margin);
}

/** Bounds from the positions (structures: their size is not known up front; one pass at upload). */
export function computeBoundsFromPositions(geo: THREE.BufferGeometry, positions: Float32Array, vertexCount: number, margin: number): void {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0, n = vertexCount * 3; i < n; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (z < z0) z0 = z;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
    if (z > z1) z1 = z;
  }
  if (vertexCount === 0) {
    x0 = y0 = z0 = x1 = y1 = z1 = 0;
  }
  const min = new THREE.Vector3(x0 - margin, y0 - margin, z0 - margin);
  const max = new THREE.Vector3(x1 + margin, y1 + margin, z1 + margin);
  geo.boundingBox = new THREE.Box3(min, max);
  const c = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  geo.boundingSphere = new THREE.Sphere(c, c.distanceTo(max));
}
