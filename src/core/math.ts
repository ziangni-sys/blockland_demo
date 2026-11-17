/**
 * Simulation math. Plain objects, no dependency on any render library.
 *
 * RULE (see docs/LESSONS.md "临时向量被改写"): there are NO module-level shared temporaries
 * exported from here. Every function either returns a fresh object or writes into an
 * `out` object that the CALLER owns. `out` may alias an input unless a function says otherwise.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Axis-aligned box. */
export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export const EPS = 1e-9;

// ---------------------------------------------------------------- Vec3

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}
export function vclone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}
export function vset(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
export function vcopy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}
export function vadd(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}
export function vsub(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}
export function vscale(a: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}
/** a + b * s */
export function vaddScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}
export function vneg(a: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  return out;
}
export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function vcross(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
export function vlenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}
export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}
export function vdist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function vdistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
/** Normalizes; returns the zero vector when the input is (near) zero. */
export function vnormalize(a: Vec3, out: Vec3 = vec3()): Vec3 {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (l < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  } else {
    const s = 1 / l;
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
  }
  return out;
}
export function vlerp(a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}
export function vequals(a: Vec3, b: Vec3, eps = 0): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}
/** Component by axis index (0 = x, 1 = y, 2 = z). */
export function vget(a: Vec3, axis: number): number {
  return axis === 0 ? a.x : axis === 1 ? a.y : a.z;
}
export function vsetAxis(out: Vec3, axis: number, value: number): Vec3 {
  if (axis === 0) out.x = value;
  else if (axis === 1) out.y = value;
  else out.z = value;
  return out;
}

// ---------------------------------------------------------------- Quat
// Unit quaternions; q rotates a vector v as q * v * q^-1.

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}
export function qclone(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
export function qcopy(out: Quat, q: Quat): Quat {
  out.x = q.x;
  out.y = q.y;
  out.z = q.z;
  out.w = q.w;
  return out;
}
export function qidentity(out: Quat = quat()): Quat {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.w = 1;
  return out;
}
/** Hamilton product a*b: the rotation "b first, then a". */
export function qmul(a: Quat, b: Quat, out: Quat = quat()): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}
export function qconj(q: Quat, out: Quat = quat()): Quat {
  out.x = -q.x;
  out.y = -q.y;
  out.z = -q.z;
  out.w = q.w;
  return out;
}
export function qnormalize(q: Quat, out: Quat = quat()): Quat {
  const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l < 1e-12) return qidentity(out);
  const s = 1 / l;
  out.x = q.x * s;
  out.y = q.y * s;
  out.z = q.z * s;
  out.w = q.w * s;
  return out;
}
/** `axis` must be unit length. Angle in radians, right-handed. */
export function qfromAxisAngle(axis: Vec3, angle: number, out: Quat = quat()): Quat {
  const h = angle * 0.5;
  const s = Math.sin(h);
  out.x = axis.x * s;
  out.y = axis.y * s;
  out.z = axis.z * s;
  out.w = Math.cos(h);
  return out;
}
/** Rotate vector v by unit quaternion q. `out` may alias `v`. */
export function qrotate(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  const { x, y, z } = v;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  // v + qw * t + cross(q.xyz, t)
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}
/** Rotate v by the inverse of unit quaternion q. `out` may alias `v`. */
export function qrotateInv(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  const { x, y, z } = v;
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}
export function qdot(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}
/** Shortest-arc spherical interpolation. */
export function qslerp(a: Quat, b: Quat, t: number, out: Quat = quat()): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  out.x = a.x * s0 + bx * s1;
  out.y = a.y * s0 + by * s1;
  out.z = a.z * s0 + bz * s1;
  out.w = a.w * s0 + bw * s1;
  return qnormalize(out, out);
}
/**
 * Integrate orientation by world-space angular velocity `w` (rad/s) over `dt`.
 * Exact for constant angular velocity (axis-angle exponential), result normalized.
 */
export function qintegrate(q: Quat, w: Vec3, dt: number, out: Quat = quat()): Quat {
  const wl = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
  const angle = wl * dt;
  if (angle < 1e-12) return qcopy(out, q);
  const s = Math.sin(angle * 0.5) / wl;
  const dq: Quat = { x: w.x * s, y: w.y * s, z: w.z * s, w: Math.cos(angle * 0.5) };
  return qnormalize(qmul(dq, q, out), out);
}
/** Rotation angle (0..PI) between two orientations. */
export function qangleBetween(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(qdot(a, b)));
  return 2 * Math.acos(d);
}
/**
 * Heading of a rotation about world +Y: the angle (radians, CCW seen from above) by which
 * the rotation turns the horizontal projection of local -Z. Used to turn carried entities.
 */
export function qyaw(q: Quat): number {
  // rotate (0,0,-1)
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.atan2(-fx, -fz);
}
/** Quaternion for yaw about +Y (CCW from above). */
export function qfromYaw(yaw: number, out: Quat = quat()): Quat {
  out.x = 0;
  out.y = Math.sin(yaw * 0.5);
  out.z = 0;
  out.w = Math.cos(yaw * 0.5);
  return out;
}
/** Row-major 3x3 rotation matrix of unit quaternion q (m[row*3+col]). */
export function qtoMat3(q: Quat, out: Float64Array = new Float64Array(9)): Float64Array {
  const { x, y, z, w } = q;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  out[0] = 1 - 2 * (yy + zz);
  out[1] = 2 * (xy - wz);
  out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz);
  out[4] = 1 - 2 * (xx + zz);
  out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy);
  out[7] = 2 * (yz + wx);
  out[8] = 1 - 2 * (xx + yy);
  return out;
}

// ---------------------------------------------------------------- AABB

export function aabb(minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0): AABB {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
export function aabbClone(b: AABB): AABB {
  return { minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ };
}
export function aabbOverlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
  );
}
export function aabbTranslate(b: AABB, dx: number, dy: number, dz: number, out: AABB = aabb()): AABB {
  out.minX = b.minX + dx;
  out.minY = b.minY + dy;
  out.minZ = b.minZ + dz;
  out.maxX = b.maxX + dx;
  out.maxY = b.maxY + dy;
  out.maxZ = b.maxZ + dz;
  return out;
}
/** Grow (positive) or shrink (negative) on every side. */
export function aabbExpand(b: AABB, dx: number, dy: number, dz: number, out: AABB = aabb()): AABB {
  out.minX = b.minX - dx;
  out.minY = b.minY - dy;
  out.minZ = b.minZ - dz;
  out.maxX = b.maxX + dx;
  out.maxY = b.maxY + dy;
  out.maxZ = b.maxZ + dz;
  return out;
}

// ---------------------------------------------------------------- scalars

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = a % twoPi;
  if (a > Math.PI) a -= twoPi;
  else if (a <= -Math.PI) a += twoPi;
  return a;
}
/** Floor division that works for negatives (JS `%` and `/` do not). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
