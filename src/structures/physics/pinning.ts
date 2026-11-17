/**
 * Pinning (ACCEPTANCE 16; LESSONS 船被转子硬推进地形 / 能动的船被误判压坏).
 *
 * A rotor is infinitely strong, terrain contacts are not; when a blade keeps pressing a ship
 * that terrain holds in place, the blade must stop transferring force for those contacts and
 * the overlapping hull cells are destroyed one by one instead. The test never looks at contact
 * duration or penetration depth (a blade pushing a ship along is in contact all the time). It
 * uses the two conditions from LESSONS, both with RELATIVE thresholds so a slow windmill is
 * judged like a fast one:
 *
 *  (1) still pressing: after a solve in which terrain had the last word, the blade's velocity
 *      relative to the hull at the contact still points into the contact by more than
 *      pinPressRatio of the blade's own speed there. A ship that could get out of the way
 *      (slide along a wall, turn about a contact) has matched the blade by then.
 *  (2) opposed by terrain: that pressing direction d is almost exactly opposed by the terrain
 *      supporting the ship. With one wall: some loaded terrain normal n has n.d <= -cos.
 *      Generalised to corners (voxel terrain normals are axis-aligned): every axis along which
 *      d has a significant component (|d_i| > sin) is covered by a loaded normal opposing d on
 *      that axis. A blade driving a ship diagonally along a single wall is not pinned; the same
 *      blade driving it into a corner is. Contacts with OTHER rotors count as support too (a
 *      ship crushed between two blades).
 */
import type { Body } from './body';
import type { ContactSet } from './contacts';
import * as CR from './contacts';
import { nearestOwnerCell } from './shape';
import type { ResolvedOptions } from './options';

// Contact record offsets as module constants (hot loops; see solver.ts).
const F_A = CR.F_A;
const F_CELL = CR.F_CELL;
const F_HASCELL = CR.F_HASCELL;
const F_KIND = CR.F_KIND;
const F_LN = CR.F_LN;
const F_LOC = CR.F_LOC;
const F_NX = CR.F_NX;
const F_OBS = CR.F_OBS;
const F_PIN = CR.F_PIN;
const F_PX = CR.F_PX;
const F_SRC = CR.F_SRC;
const F_DEPTH = CR.F_DEPTH;
const F_VO = CR.F_VO;
const KIND_ROTOR = CR.KIND_ROTOR;
const STRIDE = CR.STRIDE;

/** Blade speeds below this (blocks/s) never pin: a stopped rotor is just a wall. */
const MIN_BLADE_SPEED = 1e-4;

export class PinDetector {
  private readonly cell = { x: 0, y: 0, z: 0 };

  /**
   * Mark pinned rotor contacts (F_PIN = 1) after a velocity solve. Returns how many were newly
   * pinned. Records the deepest pinned hull cell of each body for destruction after the tick.
   */
  detect(kin: ContactSet, ter: ContactSet, bodies: readonly Body[], o: ResolvedOptions): number {
    const f = kin.f;
    let pinned = 0;
    const sinTol = Math.sqrt(Math.max(0, 1 - o.pinOpposeCos * o.pinOpposeCos));
    for (let i = 0; i < kin.count; i++) {
      const c = i * STRIDE;
      if (f[c + F_KIND] !== KIND_ROTOR || f[c + F_PIN] !== 0) continue;
      const A = bodies[f[c + F_A]!]!;
      const vox = f[c + F_VO]!;
      const voy = f[c + F_VO + 1]!;
      const voz = f[c + F_VO + 2]!;
      const vb = Math.sqrt(vox * vox + voy * voy + voz * voz);
      if (vb < MIN_BLADE_SPEED) continue;
      const rx = f[c + F_PX]! - A.px;
      const ry = f[c + F_PX + 1]! - A.py;
      const rz = f[c + F_PX + 2]! - A.pz;
      const relx = vox - (A.vx + A.wy * rz - A.wz * ry);
      const rely = voy - (A.vy + A.wz * rx - A.wx * rz);
      const relz = voz - (A.vz + A.wx * ry - A.wy * rx);
      const press = relx * f[c + F_NX]! + rely * f[c + F_NX + 1]! + relz * f[c + F_NX + 2]!;
      if (press <= o.pinPressRatio * vb) continue;
      const rl = Math.sqrt(relx * relx + rely * rely + relz * relz);
      if (!this.blocked(A, kin, ter, relx / rl, rely / rl, relz / rl, f[c + F_SRC]!, o.pinOpposeCos, sinTol)) continue;
      f[c + F_PIN] = 1;
      pinned++;
      this.recordCell(A, f, c);
    }
    return pinned;
  }

  /** Is the press direction d blocked by loaded support contacts of body A? (condition 2) */
  private blocked(
    A: Body,
    kin: ContactSet,
    ter: ContactSet,
    dx: number,
    dy: number,
    dz: number,
    src: number,
    cosTol: number,
    sinTol: number,
  ): boolean {
    const needX = Math.abs(dx) > sinTol;
    const needY = Math.abs(dy) > sinTol;
    const needZ = Math.abs(dz) > sinTol;
    let covX = false;
    let covY = false;
    let covZ = false;
    // A single loaded normal opposing d settles it (the LESSONS rule); otherwise collect which
    // significant axes of d are covered, for the corner case.
    const tf = ter.f;
    for (let i = A.terStart; i < A.terEnd; i++) {
      const c = i * STRIDE;
      if (!(tf[c + F_LN]! > 0)) continue;
      const nx = tf[c + F_NX]!;
      const ny = tf[c + F_NX + 1]!;
      const nz = tf[c + F_NX + 2]!;
      if (nx * dx + ny * dy + nz * dz <= -cosTol) return true;
      if (needX && nx * Math.sign(dx) <= -cosTol) covX = true;
      if (needY && ny * Math.sign(dy) <= -cosTol) covY = true;
      if (needZ && nz * Math.sign(dz) <= -cosTol) covZ = true;
    }
    const kf = kin.f;
    for (let i = A.kinStart; i < A.kinEnd; i++) {
      const c = i * STRIDE;
      if (kf[c + F_KIND] !== KIND_ROTOR || kf[c + F_SRC] === src || kf[c + F_PIN] !== 0) continue;
      if (!(kf[c + F_LN]! > 0)) continue;
      const nx = kf[c + F_NX]!;
      const ny = kf[c + F_NX + 1]!;
      const nz = kf[c + F_NX + 2]!;
      if (nx * dx + ny * dy + nz * dz <= -cosTol) return true;
      if (needX && nx * Math.sign(dx) <= -cosTol) covX = true;
      if (needY && ny * Math.sign(dy) <= -cosTol) covY = true;
      if (needZ && nz * Math.sign(dz) <= -cosTol) covZ = true;
    }
    const any = needX || needY || needZ;
    return any && (!needX || covX) && (!needY || covY) && (!needZ || covZ);
  }

  private recordCell(A: Body, f: Float64Array, c: number): void {
    let x: number;
    let y: number;
    let z: number;
    if (f[c + F_HASCELL] === 1) {
      x = f[c + F_CELL]!;
      y = f[c + F_CELL + 1]!;
      z = f[c + F_CELL + 2]!;
    } else {
      const out = this.cell;
      if (
        !nearestOwnerCell(
          A.shape,
          f[c + F_LOC]!,
          f[c + F_LOC + 1]!,
          f[c + F_LOC + 2]!,
          f[c + F_OBS]!,
          f[c + F_OBS + 1]!,
          f[c + F_OBS + 2]!,
          out,
        )
      ) {
        return;
      }
      x = out.x;
      y = out.y;
      z = out.z;
    }
    const depth = f[c + F_DEPTH]!;
    // Deepest overlap wins; ties keep the first found (deterministic generation order).
    if (!A.pinHas || depth > A.pinDepth) {
      A.pinHas = true;
      A.pinDepth = depth;
      A.pinX = x;
      A.pinY = y;
      A.pinZ = z;
    }
  }
}
