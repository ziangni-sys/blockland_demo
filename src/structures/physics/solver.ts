/**
 * Sequential impulses (projected Gauss-Seidel) on point contacts: non-penetration with zero
 * restitution and Coulomb friction (two tangent directions, box-clamped to mu * lambda_n),
 * plus split-impulse penetration recovery: the positional correction runs on separate pseudo
 * velocities that move the body during the sub-step and are then discarded, so correcting an
 * overlap never adds kinetic energy (the prototype's penalty springs did, LESSONS 船被推穿薄墙).
 *
 * Ordering matters for "the ship is never pushed into terrain" (LESSONS 船被转子硬推进地形):
 * every pass solves rotor / ship contacts first and terrain contacts LAST, so whatever a blade
 * demands, the velocity that leaves the solver respects the terrain.
 */
import type { Body } from './body';
import {
  F_A,
  F_B,
  F_BIAS,
  F_DEPTH,
  F_JAN,
  F_JAT1,
  F_JAT2,
  F_JBN,
  F_JBT1,
  F_JBT2,
  F_KAN,
  F_KAT1,
  F_KAT2,
  F_KBN,
  F_KBT1,
  F_KBT2,
  F_LN,
  F_LP,
  F_LT1,
  F_LT2,
  F_MN,
  F_MT1,
  F_MT2,
  F_MU,
  F_NX,
  F_PIN,
  F_PX,
  F_RA,
  F_RB,
  F_T1,
  F_T2,
  F_VO,
  STRIDE,
  type ContactSet,
} from './contacts';

/**
 * Per-contact constants: lever arms, tangent basis, Jacobian rows, effective masses and the
 * positional bias. `bodies` is indexed by the contact's body indices.
 */
export function prepareContacts(
  set: ContactSet,
  bodies: readonly Body[],
  invDt: number,
  slop: number,
  rate: number,
  maxCorr: number,
): void {
  const f = set.f;
  for (let i = 0; i < set.count; i++) {
    const c = i * STRIDE;
    const A = bodies[f[c + F_A]!]!;
    const bi = f[c + F_B]!;
    const B = bi >= 0 ? bodies[bi]! : null;
    const px = f[c + F_PX]!;
    const py = f[c + F_PX + 1]!;
    const pz = f[c + F_PX + 2]!;
    const nx = f[c + F_NX]!;
    const ny = f[c + F_NX + 1]!;
    const nz = f[c + F_NX + 2]!;
    // tangent basis
    let t1x: number;
    let t1y: number;
    let t1z: number;
    if (Math.abs(nx) > 0.57) {
      const l = 1 / Math.sqrt(nx * nx + ny * ny);
      t1x = ny * l;
      t1y = -nx * l;
      t1z = 0;
    } else {
      const l = 1 / Math.sqrt(ny * ny + nz * nz);
      t1x = 0;
      t1y = nz * l;
      t1z = -ny * l;
    }
    const t2x = ny * t1z - nz * t1y;
    const t2y = nz * t1x - nx * t1z;
    const t2z = nx * t1y - ny * t1x;
    f[c + F_T1] = t1x;
    f[c + F_T1 + 1] = t1y;
    f[c + F_T1 + 2] = t1z;
    f[c + F_T2] = t2x;
    f[c + F_T2 + 1] = t2y;
    f[c + F_T2 + 2] = t2z;

    const rax = px - A.px;
    const ray = py - A.py;
    const raz = pz - A.pz;
    f[c + F_RA] = rax;
    f[c + F_RA + 1] = ray;
    f[c + F_RA + 2] = raz;
    const ima = A.solverInvMass;
    let kN = ima + angular(f, c + F_JAN, c + F_KAN, A.invIw, rax, ray, raz, nx, ny, nz);
    let kT1 = ima + angular(f, c + F_JAT1, c + F_KAT1, A.invIw, rax, ray, raz, t1x, t1y, t1z);
    let kT2 = ima + angular(f, c + F_JAT2, c + F_KAT2, A.invIw, rax, ray, raz, t2x, t2y, t2z);
    if (B !== null) {
      const rbx = px - B.px;
      const rby = py - B.py;
      const rbz = pz - B.pz;
      f[c + F_RB] = rbx;
      f[c + F_RB + 1] = rby;
      f[c + F_RB + 2] = rbz;
      const imb = B.solverInvMass;
      kN += imb + angular(f, c + F_JBN, c + F_KBN, B.invIw, rbx, rby, rbz, nx, ny, nz);
      kT1 += imb + angular(f, c + F_JBT1, c + F_KBT1, B.invIw, rbx, rby, rbz, t1x, t1y, t1z);
      kT2 += imb + angular(f, c + F_JBT2, c + F_KBT2, B.invIw, rbx, rby, rbz, t2x, t2y, t2z);
    }
    const pinned = f[c + F_PIN] !== 0;
    f[c + F_MN] = !pinned && kN > 1e-12 ? 1 / kN : 0;
    f[c + F_MT1] = !pinned && kT1 > 1e-12 ? 1 / kT1 : 0;
    f[c + F_MT2] = !pinned && kT2 > 1e-12 ? 1 / kT2 : 0;
    f[c + F_LN] = 0;
    f[c + F_LT1] = 0;
    f[c + F_LT2] = 0;
    f[c + F_LP] = 0;
    const excess = f[c + F_DEPTH]! - slop;
    let bias = excess > 0 ? rate * invDt * excess : 0;
    if (bias > maxCorr) bias = maxCorr;
    f[c + F_BIAS] = bias;
  }
}

/** J = r x u stored at j, K = invI J stored at k; returns J . K. */
function angular(
  f: Float64Array,
  j: number,
  k: number,
  I: Float64Array,
  rx: number,
  ry: number,
  rz: number,
  ux: number,
  uy: number,
  uz: number,
): number {
  const jx = ry * uz - rz * uy;
  const jy = rz * ux - rx * uz;
  const jz = rx * uy - ry * ux;
  const kx = I[0]! * jx + I[1]! * jy + I[2]! * jz;
  const ky = I[3]! * jx + I[4]! * jy + I[5]! * jz;
  const kz = I[6]! * jx + I[7]! * jy + I[8]! * jz;
  f[j] = jx;
  f[j + 1] = jy;
  f[j + 2] = jz;
  f[k] = kx;
  f[k + 1] = ky;
  f[k + 2] = kz;
  return jx * kx + jy * ky + jz * kz;
}

/** Re-arm a prepared set for a fresh solve (pinning re-solve): accumulated impulses to zero, pinned rows disabled. */
export function resetImpulses(set: ContactSet): void {
  const f = set.f;
  for (let i = 0; i < set.count; i++) {
    const c = i * STRIDE;
    f[c + F_LN] = 0;
    f[c + F_LT1] = 0;
    f[c + F_LT2] = 0;
    f[c + F_LP] = 0;
    if (f[c + F_PIN] !== 0) {
      f[c + F_MN] = 0;
      f[c + F_MT1] = 0;
      f[c + F_MT2] = 0;
    }
  }
}

/** One velocity pass over the set. */
export function solveVelocityPass(set: ContactSet, bodies: readonly Body[]): void {
  const f = set.f;
  for (let i = 0; i < set.count; i++) {
    const c = i * STRIDE;
    const mN = f[c + F_MN]!;
    if (mN === 0) continue;
    const A = bodies[f[c + F_A]!]!;
    const bi = f[c + F_B]!;
    const B = bi >= 0 ? bodies[bi]! : null;
    const ima = A.solverInvMass;
    const imb = B !== null ? B.solverInvMass : 0;
    // relative linear velocity (A - B - obstacle)
    let dvx = A.vx - f[c + F_VO]!;
    let dvy = A.vy - f[c + F_VO + 1]!;
    let dvz = A.vz - f[c + F_VO + 2]!;
    if (B !== null) {
      dvx -= B.vx;
      dvy -= B.vy;
      dvz -= B.vz;
    }

    // ---- normal
    const nx = f[c + F_NX]!;
    const ny = f[c + F_NX + 1]!;
    const nz = f[c + F_NX + 2]!;
    let vn = dvx * nx + dvy * ny + dvz * nz + f[c + F_JAN]! * A.wx + f[c + F_JAN + 1]! * A.wy + f[c + F_JAN + 2]! * A.wz;
    if (B !== null) vn -= f[c + F_JBN]! * B.wx + f[c + F_JBN + 1]! * B.wy + f[c + F_JBN + 2]! * B.wz;
    const old = f[c + F_LN]!;
    let ln = old - vn * mN;
    if (ln < 0) ln = 0;
    const dl = ln - old;
    f[c + F_LN] = ln;
    if (dl !== 0) {
      applyImpulse(A, B, ima, imb, f, c + F_KAN, c + F_KBN, nx, ny, nz, dl);
      dvx += (ima + imb) * dl * nx;
      dvy += (ima + imb) * dl * ny;
      dvz += (ima + imb) * dl * nz;
    }

    // ---- friction (box clamp per tangent)
    const lim = f[c + F_MU]! * ln;
    const mT1 = f[c + F_MT1]!;
    if (mT1 !== 0) {
      const tx = f[c + F_T1]!;
      const ty = f[c + F_T1 + 1]!;
      const tz = f[c + F_T1 + 2]!;
      let vt = dvx * tx + dvy * ty + dvz * tz + f[c + F_JAT1]! * A.wx + f[c + F_JAT1 + 1]! * A.wy + f[c + F_JAT1 + 2]! * A.wz;
      if (B !== null) vt -= f[c + F_JBT1]! * B.wx + f[c + F_JBT1 + 1]! * B.wy + f[c + F_JBT1 + 2]! * B.wz;
      const o1 = f[c + F_LT1]!;
      let l1 = o1 - vt * mT1;
      if (l1 > lim) l1 = lim;
      else if (l1 < -lim) l1 = -lim;
      const d1 = l1 - o1;
      f[c + F_LT1] = l1;
      if (d1 !== 0) {
        applyImpulse(A, B, ima, imb, f, c + F_KAT1, c + F_KBT1, tx, ty, tz, d1);
        dvx += (ima + imb) * d1 * tx;
        dvy += (ima + imb) * d1 * ty;
        dvz += (ima + imb) * d1 * tz;
      }
    }
    const mT2 = f[c + F_MT2]!;
    if (mT2 !== 0) {
      const tx = f[c + F_T2]!;
      const ty = f[c + F_T2 + 1]!;
      const tz = f[c + F_T2 + 2]!;
      let vt = dvx * tx + dvy * ty + dvz * tz + f[c + F_JAT2]! * A.wx + f[c + F_JAT2 + 1]! * A.wy + f[c + F_JAT2 + 2]! * A.wz;
      if (B !== null) vt -= f[c + F_JBT2]! * B.wx + f[c + F_JBT2 + 1]! * B.wy + f[c + F_JBT2 + 2]! * B.wz;
      const o2 = f[c + F_LT2]!;
      let l2 = o2 - vt * mT2;
      if (l2 > lim) l2 = lim;
      else if (l2 < -lim) l2 = -lim;
      const d2 = l2 - o2;
      f[c + F_LT2] = l2;
      if (d2 !== 0) applyImpulse(A, B, ima, imb, f, c + F_KAT2, c + F_KBT2, tx, ty, tz, d2);
    }
  }
}

function applyImpulse(
  A: Body,
  B: Body | null,
  ima: number,
  imb: number,
  f: Float64Array,
  ka: number,
  kb: number,
  ux: number,
  uy: number,
  uz: number,
  dl: number,
): void {
  A.vx += ima * dl * ux;
  A.vy += ima * dl * uy;
  A.vz += ima * dl * uz;
  A.wx += f[ka]! * dl;
  A.wy += f[ka + 1]! * dl;
  A.wz += f[ka + 2]! * dl;
  if (B !== null) {
    B.vx -= imb * dl * ux;
    B.vy -= imb * dl * uy;
    B.vz -= imb * dl * uz;
    B.wx -= f[kb]! * dl;
    B.wy -= f[kb + 1]! * dl;
    B.wz -= f[kb + 2]! * dl;
  }
}

/** One split-impulse pass: drives the pseudo velocities toward each contact's positional bias. */
export function solvePositionPass(set: ContactSet, bodies: readonly Body[]): void {
  const f = set.f;
  for (let i = 0; i < set.count; i++) {
    const c = i * STRIDE;
    const mN = f[c + F_MN]!;
    const bias = f[c + F_BIAS]!;
    if (mN === 0 || (bias === 0 && f[c + F_LP] === 0)) continue;
    const A = bodies[f[c + F_A]!]!;
    const bi = f[c + F_B]!;
    const B = bi >= 0 ? bodies[bi]! : null;
    const nx = f[c + F_NX]!;
    const ny = f[c + F_NX + 1]!;
    const nz = f[c + F_NX + 2]!;
    let vn =
      A.vpx * nx + A.vpy * ny + A.vpz * nz + f[c + F_JAN]! * A.wpx + f[c + F_JAN + 1]! * A.wpy + f[c + F_JAN + 2]! * A.wpz;
    if (B !== null) {
      vn -= B.vpx * nx + B.vpy * ny + B.vpz * nz + f[c + F_JBN]! * B.wpx + f[c + F_JBN + 1]! * B.wpy + f[c + F_JBN + 2]! * B.wpz;
    }
    const old = f[c + F_LP]!;
    let lp = old + (bias - vn) * mN;
    if (lp < 0) lp = 0;
    const dl = lp - old;
    f[c + F_LP] = lp;
    if (dl === 0) continue;
    const ima = A.solverInvMass;
    A.vpx += ima * dl * nx;
    A.vpy += ima * dl * ny;
    A.vpz += ima * dl * nz;
    A.wpx += f[c + F_KAN]! * dl;
    A.wpy += f[c + F_KAN + 1]! * dl;
    A.wpz += f[c + F_KAN + 2]! * dl;
    if (B !== null) {
      const imb = B.solverInvMass;
      B.vpx -= imb * dl * nx;
      B.vpy -= imb * dl * ny;
      B.vpz -= imb * dl * nz;
      B.wpx -= f[c + F_KBN]! * dl;
      B.wpy -= f[c + F_KBN + 1]! * dl;
      B.wpz -= f[c + F_KBN + 2]! * dl;
    }
  }
}
