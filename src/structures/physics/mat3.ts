/**
 * Row-major 3x3 matrix helpers on Float64Array(9) (m[row * 3 + col]), matching qtoMat3.
 * Outputs are owned by the caller; nothing here allocates. `out` must not alias an input
 * unless the function says so.
 */

export type Mat3 = Float64Array;

export function mat3Identity(out: Mat3): Mat3 {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

/** out = a * b. */
export function mat3Mul(a: Mat3, b: Mat3, out: Mat3): Mat3 {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 3]!;
    const a1 = a[r * 3 + 1]!;
    const a2 = a[r * 3 + 2]!;
    out[r * 3] = a0 * b[0]! + a1 * b[3]! + a2 * b[6]!;
    out[r * 3 + 1] = a0 * b[1]! + a1 * b[4]! + a2 * b[7]!;
    out[r * 3 + 2] = a0 * b[2]! + a1 * b[5]! + a2 * b[8]!;
  }
  return out;
}

/** out = a^T * b. */
export function mat3MulTransA(a: Mat3, b: Mat3, out: Mat3): Mat3 {
  for (let r = 0; r < 3; r++) {
    const a0 = a[r]!;
    const a1 = a[3 + r]!;
    const a2 = a[6 + r]!;
    out[r * 3] = a0 * b[0]! + a1 * b[3]! + a2 * b[6]!;
    out[r * 3 + 1] = a0 * b[1]! + a1 * b[4]! + a2 * b[7]!;
    out[r * 3 + 2] = a0 * b[2]! + a1 * b[5]! + a2 * b[8]!;
  }
  return out;
}

/** out = R * M * R^T (inertia tensor rotated into another frame). `tmp` is scratch. */
export function mat3Congruence(R: Mat3, M: Mat3, tmp: Mat3, out: Mat3): Mat3 {
  mat3Mul(R, M, tmp);
  for (let r = 0; r < 3; r++) {
    const t0 = tmp[r * 3]!;
    const t1 = tmp[r * 3 + 1]!;
    const t2 = tmp[r * 3 + 2]!;
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = t0 * R[c * 3]! + t1 * R[c * 3 + 1]! + t2 * R[c * 3 + 2]!;
    }
  }
  return out;
}

/** Inverse of a 3x3 matrix by cofactors. Returns false (out = zero) when it is singular. */
export function mat3Invert(m: Mat3, out: Mat3): boolean {
  const a = m[0]!;
  const b = m[1]!;
  const c = m[2]!;
  const d = m[3]!;
  const e = m[4]!;
  const f = m[5]!;
  const g = m[6]!;
  const h = m[7]!;
  const i = m[8]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) {
    out.fill(0);
    return false;
  }
  const s = 1 / det;
  out[0] = A * s;
  out[1] = -(b * i - c * h) * s;
  out[2] = (b * f - c * e) * s;
  out[3] = B * s;
  out[4] = (a * i - c * g) * s;
  out[5] = -(a * f - c * d) * s;
  out[6] = C * s;
  out[7] = -(a * h - b * g) * s;
  out[8] = (a * e - b * d) * s;
  return true;
}
