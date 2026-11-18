/**
 * Pure pose math for structures and dry volumes. Matrices are 4x4 COLUMN-MAJOR arrays,
 * the layout of three.js Matrix4.elements, so the backend can copy them straight in.
 * No three.js import: unit-tested in Node.
 */
import type { DryVolume, StructurePose } from '../backend';

/** Any writable 16-element array (Float32Array, Float64Array, number[]). */
export type Mat4Out = { [index: number]: number; length: number };

/**
 * Local -> world matrix of a structure: world = p + q * (local - pivot).
 * Column-major: element (row r, col c) is out[c * 4 + r].
 */
export function poseToMatrix(pose: StructurePose, out: Mat4Out): Mat4Out {
  const { qx: x, qy: y, qz: z, qw: w } = pose;
  // Normalize defensively: interpolated quaternions from the client are close to unit but a
  // non-unit quaternion would scale the structure.
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  const s = n > 1e-12 ? 2 / (n * n) : 0;
  const xs = x * s;
  const ys = y * s;
  const zs = z * s;
  const wx = w * xs;
  const wy = w * ys;
  const wz = w * zs;
  const xx = x * xs;
  const xy = x * ys;
  const xz = x * zs;
  const yy = y * ys;
  const yz = y * zs;
  const zz = z * zs;
  const m00 = n > 1e-12 ? 1 - (yy + zz) : 1;
  const m01 = xy - wz;
  const m02 = xz + wy;
  const m10 = xy + wz;
  const m11 = n > 1e-12 ? 1 - (xx + zz) : 1;
  const m12 = yz - wx;
  const m20 = xz - wy;
  const m21 = yz + wx;
  const m22 = n > 1e-12 ? 1 - (xx + yy) : 1;
  const px = pose.pivotX;
  const py = pose.pivotY;
  const pz = pose.pivotZ;
  out[0] = m00;
  out[1] = m10;
  out[2] = m20;
  out[3] = 0;
  out[4] = m01;
  out[5] = m11;
  out[6] = m21;
  out[7] = 0;
  out[8] = m02;
  out[9] = m12;
  out[10] = m22;
  out[11] = 0;
  out[12] = pose.px - (m00 * px + m01 * py + m02 * pz);
  out[13] = pose.py - (m10 * px + m11 * py + m12 * pz);
  out[14] = pose.pz - (m20 * px + m21 * py + m22 * pz);
  out[15] = 1;
  return out;
}

/**
 * World -> dry-mask texture coordinate matrix.
 *
 * With an origin (ox0, oy0, oz0) the matrix takes positions RELATIVE to that origin
 * (world - origin): the backend passes the camera position, so the shader can feed it
 * camera-relative positions, which stay precise in float32 far from the world origin (the
 * large translations cancel here, in float64).
 *
 * local = pivot + q^-1 * (world - p); the mask is a 3D texture whose WIDTH runs along local
 * x, HEIGHT along local z and DEPTH along local y — exactly the DryVolume index order
 * (x fastest, then z, then y), so the mask bytes upload without re-layout. Output:
 *   u = (lx - ox) / sx,  v = (lz - oz) / sz,  w = (ly - oy) / sy
 * A world point is inside the volume box iff u, v, w are all in [0, 1).
 */
export function dryVolumeMatrix(pose: StructurePose, dry: DryVolume, out: Mat4Out, ox0 = 0, oy0 = 0, oz0 = 0): Mat4Out {
  const { qx: x, qy: y, qz: z, qw: w } = pose;
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  const s = n > 1e-12 ? 2 / (n * n) : 0;
  const xs = x * s;
  const ys = y * s;
  const zs = z * s;
  const wx = w * xs;
  const wy = w * ys;
  const wz = w * zs;
  const xx = x * xs;
  const xy = x * ys;
  const xz = x * zs;
  const yy = y * ys;
  const yz = y * zs;
  const zz = z * zs;
  // Inverse rotation = transpose of R.
  const r00 = n > 1e-12 ? 1 - (yy + zz) : 1;
  const r01 = xy + wz;
  const r02 = xz - wy;
  const r10 = xy - wz;
  const r11 = n > 1e-12 ? 1 - (xx + zz) : 1;
  const r12 = yz + wx;
  const r20 = xz + wy;
  const r21 = yz - wx;
  const r22 = n > 1e-12 ? 1 - (xx + yy) : 1;
  // local = Rinv * rel + tl, with rel = world - origin and tl = pivot - Rinv * (p - origin)
  const px = pose.px - ox0;
  const py = pose.py - oy0;
  const pz = pose.pz - oz0;
  const tlx = pose.pivotX - (r00 * px + r01 * py + r02 * pz);
  const tly = pose.pivotY - (r10 * px + r11 * py + r12 * pz);
  const tlz = pose.pivotZ - (r20 * px + r21 * py + r22 * pz);
  const isx = 1 / Math.max(1, dry.sx);
  const isy = 1 / Math.max(1, dry.sy);
  const isz = 1 / Math.max(1, dry.sz);
  // Row 0 (u) from local x, row 1 (v) from local z, row 2 (w) from local y.
  const a0 = r00 * isx;
  const a1 = r01 * isx;
  const a2 = r02 * isx;
  const a3 = (tlx - dry.ox) * isx;
  const b0 = r20 * isz;
  const b1 = r21 * isz;
  const b2 = r22 * isz;
  const b3 = (tlz - dry.oz) * isz;
  const c0 = r10 * isy;
  const c1 = r11 * isy;
  const c2 = r12 * isy;
  const c3 = (tly - dry.oy) * isy;
  out[0] = a0;
  out[1] = b0;
  out[2] = c0;
  out[3] = 0;
  out[4] = a1;
  out[5] = b1;
  out[6] = c1;
  out[7] = 0;
  out[8] = a2;
  out[9] = b2;
  out[10] = c2;
  out[11] = 0;
  out[12] = a3;
  out[13] = b3;
  out[14] = c3;
  out[15] = 1;
  return out;
}

/**
 * World position of the centre of a dry volume box (used to rank volumes by distance to the
 * camera when more structures have dry volumes than the shader has slots).
 */
export function dryVolumeCenter(pose: StructurePose, dry: DryVolume, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const lx = dry.ox + dry.sx * 0.5 - pose.pivotX;
  const ly = dry.oy + dry.sy * 0.5 - pose.pivotY;
  const lz = dry.oz + dry.sz * 0.5 - pose.pivotZ;
  const { qx, qy, qz, qw } = pose;
  // v + 2w(q x v) + 2 q x (q x v)
  const tx = 2 * (qy * lz - qz * ly);
  const ty = 2 * (qz * lx - qx * lz);
  const tz = 2 * (qx * ly - qy * lx);
  out.x = pose.px + lx + qw * tx + (qy * tz - qz * ty);
  out.y = pose.py + ly + qw * ty + (qz * tx - qx * tz);
  out.z = pose.pz + lz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Radius of the sphere around dryVolumeCenter that contains the whole box. */
export function dryVolumeRadius(dry: DryVolume): number {
  return 0.5 * Math.sqrt(dry.sx * dry.sx + dry.sy * dry.sy + dry.sz * dry.sz);
}
