/**
 * The 24 axis-aligned rotations ("grid rotations"), used when a structure is snapped back
 * onto a grid (blockify / dock) or re-parented: cell coordinates, glue faces and block
 * states (log axis, facing) and shapes (holes, both parts) all rotate with the same GridRot.
 */
import { dirAxis, dirOf, dirSign, nearestDir, DIR_X, DIR_Y, DIR_Z, type Axis, type Dir } from '../core/dirs';
import { qnormalize, qrotate, quat, vec3, type Quat, type Vec3 } from '../core/math';
import { rotatePacked } from '../blocks/shapes';

/** Images of the local +X, +Y, +Z axes. Always a proper rotation (right-handed). */
export interface GridRot {
  readonly ax: Dir;
  readonly ay: Dir;
  readonly az: Dir;
}

export const ROT_IDENTITY: GridRot = { ax: 0, ay: 2, az: 4 };

function cross(a: Dir, b: Dir): Dir {
  const x = DIR_Y[a]! * DIR_Z[b]! - DIR_Z[a]! * DIR_Y[b]!;
  const y = DIR_Z[a]! * DIR_X[b]! - DIR_X[a]! * DIR_Z[b]!;
  const z = DIR_X[a]! * DIR_Y[b]! - DIR_Y[a]! * DIR_X[b]!;
  return nearestDir(x, y, z);
}

/** Rotate a direction. */
export function rotDir(r: GridRot, d: Dir): Dir {
  const img = d >> 1 === 0 ? r.ax : d >> 1 === 1 ? r.ay : r.az;
  return ((d & 1) === 0 ? img : img ^ 1) as Dir;
}

/** Rotate an integer (or any) vector about the origin. `out` may alias the input object. */
export function rotVec(r: GridRot, x: number, y: number, z: number, out: Vec3 = vec3()): Vec3 {
  const ox = x * DIR_X[r.ax]! + y * DIR_X[r.ay]! + z * DIR_X[r.az]!;
  const oy = x * DIR_Y[r.ax]! + y * DIR_Y[r.ay]! + z * DIR_Y[r.az]!;
  const oz = x * DIR_Z[r.ax]! + y * DIR_Z[r.ay]! + z * DIR_Z[r.az]!;
  out.x = ox;
  out.y = oy;
  out.z = oz;
  return out;
}

/** a ∘ b: apply b first, then a. */
export function rotCompose(a: GridRot, b: GridRot): GridRot {
  return { ax: rotDir(a, b.ax), ay: rotDir(a, b.ay), az: rotDir(a, b.az) };
}

export function rotInverse(r: GridRot): GridRot {
  // The inverse maps each image axis back to its source axis.
  const inv: Dir[] = [0, 2, 4];
  const set = (img: Dir, src: Dir): void => {
    const axis = dirAxis(img);
    inv[axis] = (dirSign(img) > 0 ? src : src ^ 1) as Dir;
  };
  set(r.ax, 0);
  set(r.ay, 2);
  set(r.az, 4);
  return { ax: inv[0]!, ay: inv[1]!, az: inv[2]! };
}

export function rotEquals(a: GridRot, b: GridRot): boolean {
  return a.ax === b.ax && a.ay === b.ay && a.az === b.az;
}

/** The grid rotation closest to an arbitrary rotation (snap to the nearest of the 24). */
export function nearestRot(q: Quat): GridRot {
  const ex = qrotate(q, vec3(1, 0, 0));
  const ey = qrotate(q, vec3(0, 1, 0));
  const ez = qrotate(q, vec3(0, 0, 1));
  const cols = [ex, ey, ez];
  // Greedy: fix the basis vector that is best aligned with a world axis first, then the
  // best of the remaining two (restricted to the remaining world axes); the third follows
  // from right-handedness.
  let best = -1;
  let bestCol = 0;
  for (let c = 0; c < 3; c++) {
    const v = cols[c]!;
    const m = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
    if (m > best) {
      best = m;
      bestCol = c;
    }
  }
  const img: Array<Dir | null> = [null, null, null];
  const first = cols[bestCol]!;
  img[bestCol] = nearestDir(first.x, first.y, first.z);
  const usedAxis = dirAxis(img[bestCol]!);
  let second = -1;
  let secondCol = 0;
  let secondDir: Dir = 0;
  for (let c = 0; c < 3; c++) {
    if (c === bestCol) continue;
    const v = cols[c]!;
    const comps = [v.x, v.y, v.z];
    for (let a = 0; a < 3; a++) {
      if (a === usedAxis) continue;
      const m = Math.abs(comps[a]!);
      if (m > second) {
        second = m;
        secondCol = c;
        secondDir = dirOf(a as Axis, comps[a]! >= 0);
      }
    }
  }
  img[secondCol] = secondDir;
  const thirdCol = 3 - bestCol - secondCol;
  // Right-handed: x × y = z, y × z = x, z × x = y.
  const a = img[(thirdCol + 1) % 3]!;
  const b = img[(thirdCol + 2) % 3]!;
  img[thirdCol] = cross(a, b);
  return { ax: img[0]!, ay: img[1]!, az: img[2]! };
}

/** Unit quaternion of a grid rotation. */
export function rotToQuat(r: GridRot, out: Quat = quat()): Quat {
  // Rotation matrix columns are the images of the axes.
  const m00 = DIR_X[r.ax]!;
  const m10 = DIR_Y[r.ax]!;
  const m20 = DIR_Z[r.ax]!;
  const m01 = DIR_X[r.ay]!;
  const m11 = DIR_Y[r.ay]!;
  const m21 = DIR_Z[r.ay]!;
  const m02 = DIR_X[r.az]!;
  const m12 = DIR_Y[r.az]!;
  const m22 = DIR_Z[r.az]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = 0.25 * s;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  return qnormalize(out, out);
}

/**
 * Rotate a packed cell (blocks/cell.ts, both parts) by `r`: each part's state ('axis' blocks the
 * rotated axis, 'facing' blocks the rotated facing, other state kinds unchanged) and its holes
 * rotate, then the parts are put back in canonical order (blocks/shapes.ts rotatePacked). A full
 * block keeps its value except for the state.
 */
export function rotCell(r: GridRot, packed: number): number {
  return rotatePacked(packed, r.ax, r.ay, r.az);
}

/**
 * Where a cell lands when its grid is rotated by `r` about `pivot` and the pivot is put
 * at `target`: returns the integer cell containing the rotated cell centre.
 */
export function rotCellPos(
  r: GridRot,
  x: number,
  y: number,
  z: number,
  pivot: Vec3,
  target: Vec3,
  out: Vec3 = vec3(),
): Vec3 {
  rotVec(r, x + 0.5 - pivot.x, y + 0.5 - pivot.y, z + 0.5 - pivot.z, out);
  out.x = Math.floor(out.x + target.x + 1e-6);
  out.y = Math.floor(out.y + target.y + 1e-6);
  out.z = Math.floor(out.z + target.z + 1e-6);
  return out;
}
