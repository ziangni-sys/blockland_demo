/**
 * Pinning (ACCEPTANCE 16; LESSONS 船被转子硬推进地形 / 能动的船被误判压坏).
 *
 * A rotor is infinitely strong, terrain contacts are not; when a blade keeps pressing a ship
 * that terrain holds in place, the blade must stop transferring force and the overlapping hull
 * cells are destroyed one by one instead. The test never looks at contact duration or
 * penetration depth (a blade pushing a ship along is in contact all the time). It uses the two
 * conditions from LESSONS, both with RELATIVE thresholds so a slow windmill is judged like a
 * fast one. For a contact with blade velocity vo (speed |vo|) and push normal n:
 *
 *  (1) the blade still presses into the contact:
 *      (a) by its own motion — vo . n > pinPressRatio |vo|. The end face of a blade tip, whose
 *          material slides across its own normal, never presses: whatever the hull does there,
 *          the blade is not driving it.
 *      (b) relative to the hull — after a solve in which terrain had the last word,
 *          (vo - v_hull(P)) . n > pinPressRatio |vo|. A ship that could get out of the way
 *          (turn about a contact, slide along a wall) has matched the blade by then.
 *  (2) the blade's direction of motion d = vo / |vo| is almost exactly opposed by what holds the
 *      ship: some support normal m has m . d <= -pinOpposeCos (one wall), or — voxel normals are
 *      axis-aligned, so corners need this — every axis on which d has a significant component
 *      (|d_i| > sin) is covered by a support normal opposing d on that axis.
 *      d is the blade's own motion, not the relative velocity: once a ship slides along a wall at
 *      the blade's tangential speed the relative velocity points straight into the wall, which
 *      would make every oblique blade "opposed" (the bug the reviewers found). The normal is not
 *      used either: a blade corner inside a hull takes the HULL's face normal, which can point
 *      into the wall while the blade itself moves at 60 degrees to it.
 *
 * Supports are the ship's contacts of this sub-step: terrain; OTHER rotors (a ship crushed
 * between two blades); other ships that cannot give way along d — a frozen ship, or a simulated
 * ship that is itself blocked along d by its own supports (a boat squeezed against a boat moored
 * at a quay). Sleeping ships taking part as obstacles do not count: they would wake and move.
 *
 * The same support rule (SupportQuery) is used by the dynamics before each solve, to find the
 * rotor contacts that drive a ship straight into its supports and the ships a driven ship is
 * pressed against that cannot give way (dynamics.ts prepareDriven).
 *
 * Pinning is decided per (ship, rotor) pair: when any contact of the pair passes, ALL of that
 * rotor's contacts with that ship stop transferring force for the sub-step (velocity and
 * position). A blade cutting through a wedged hull then passes through cleanly instead of
 * shoving it around with its remaining side and edge contacts. The hull cell the blade has
 * advanced deepest into (among the contacts it presses, stale ones included — contacts.ts
 * ROTOR_STALE_DEPTH) is recorded for destruction; at most one cell per ship and tick is destroyed.
 */
import type { Body } from './body';
import { MODE_ACTIVE, MODE_STATIC } from './body';
import type { ContactSet } from './contacts';
import * as CR from './contacts';
import { nearestOwnerCell } from './shape';
import type { ResolvedOptions } from './options';

// Contact record offsets as module constants (hot loops; see solver.ts).
const F_A = CR.F_A;
const F_B = CR.F_B;
const F_CELL = CR.F_CELL;
const F_HASCELL = CR.F_HASCELL;
const F_KIND = CR.F_KIND;
const F_LOC = CR.F_LOC;
const F_NX = CR.F_NX;
const F_OBS = CR.F_OBS;
const F_PIN = CR.F_PIN;
const F_PX = CR.F_PX;
const F_SRC = CR.F_SRC;
const F_DEPTH = CR.F_DEPTH;
const F_VO = CR.F_VO;
const KIND_ROTOR = CR.KIND_ROTOR;
const PIN_PINNED = CR.PIN_PINNED;
const PIN_BLOCKED = CR.PIN_BLOCKED;
const PIN_REDIRECTED = CR.PIN_REDIRECTED;
const PIN_CUTTING = CR.PIN_CUTTING;
const STRIDE = CR.STRIDE;

/** Blade speeds below this (blocks/s) never pin: a stopped rotor is just a wall. */
const MIN_BLADE_SPEED = 1e-4;
/**
 * A contact is jammed when the solve left more than this fraction of the blade's speed pressing
 * into it (relative, like the pin thresholds). A solve that can meet its contacts converges to a
 * small remainder even for a steep wedge (frictionless, the Gauss-Seidel remainder shrinks by
 * sin^2 of the wedge angle per pass); contacts that cannot all be met keep nearly all of it.
 */
const JAM_RATIO = 0.5;
/** How many ships deep a chain of ship/ship supports is followed. */
const MAX_SUPPORT_CHAIN = 4;

/** Does the blade material move into the contact by itself (condition 1a)? */
export function bladePresses(f: Float64Array, c: number, ratio: number): boolean {
  const vox = f[c + F_VO]!;
  const voy = f[c + F_VO + 1]!;
  const voz = f[c + F_VO + 2]!;
  const vb = Math.sqrt(vox * vox + voy * voy + voz * voz);
  if (vb < MIN_BLADE_SPEED) return false;
  return vox * f[c + F_NX]! + voy * f[c + F_NX + 1]! + voz * f[c + F_NX + 2]! > ratio * vb;
}

/**
 * "Is body A held along direction d?" — the support rule of condition (2), shared with the
 * dynamics (which asks it before the solve, about ships and contacts a blade presses into
 * supports). A support is a contact present in this sub-step (the hull touches or overlaps it),
 * not one that carried load in a solve: contacts the dynamics blocks take no part in the solve,
 * so whatever they press against carries no load.
 */
export class SupportQuery {
  private cosTol = 0.9;
  private sinTol = 0.43;

  configure(cosTol: number): void {
    this.cosTol = cosTol;
    this.sinTol = Math.sqrt(Math.max(0, 1 - cosTol * cosTol));
  }

  /**
   * Is direction d blocked for body A by its supports? `src` is the pressing rotor (its own
   * contacts are not support; -1 = none); `depth` bounds ship/ship chains.
   */
  blocked(
    A: Body,
    kin: ContactSet,
    ter: ContactSet,
    shipStart: number,
    bodies: readonly Body[],
    dx: number,
    dy: number,
    dz: number,
    src: number,
    depth: number,
  ): boolean {
    if (A.mode !== MODE_ACTIVE) return false;
    const cosTol = this.cosTol;
    const sinTol = this.sinTol;
    const needX = Math.abs(dx) > sinTol;
    const needY = Math.abs(dy) > sinTol;
    const needZ = Math.abs(dz) > sinTol;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const sz = Math.sign(dz);
    let covX = false;
    let covY = false;
    let covZ = false;
    // One normal opposing d settles it (the LESSONS rule); otherwise collect which significant
    // axes of d are covered, for corners.
    const tf = ter.f;
    for (let i = A.terStart; i < A.terEnd; i++) {
      const c = i * STRIDE;
      const nx = tf[c + F_NX]!;
      const ny = tf[c + F_NX + 1]!;
      const nz = tf[c + F_NX + 2]!;
      if (nx * dx + ny * dy + nz * dz <= -cosTol) return true;
      if (needX && nx * sx <= -cosTol) covX = true;
      if (needY && ny * sy <= -cosTol) covY = true;
      if (needZ && nz * sz <= -cosTol) covZ = true;
    }
    const kf = kin.f;
    for (let i = A.kinStart; i < A.kinEnd; i++) {
      const c = i * STRIDE;
      if (kf[c + F_KIND] !== KIND_ROTOR || kf[c + F_SRC] === src || kf[c + F_PIN] !== 0) continue;
      const nx = kf[c + F_NX]!;
      const ny = kf[c + F_NX + 1]!;
      const nz = kf[c + F_NX + 2]!;
      if (nx * dx + ny * dy + nz * dz <= -cosTol) return true;
      if (needX && nx * sx <= -cosTol) covX = true;
      if (needY && ny * sy <= -cosTol) covY = true;
      if (needZ && nz * sz <= -cosTol) covZ = true;
    }
    // Ship/ship contacts: A's normal is +n when A is the contact's body A, -n when it is body B.
    for (let i = shipStart; i < kin.count; i++) {
      const c = i * STRIDE;
      let sgn: number;
      let other: number;
      if (kf[c + F_A] === A.index) {
        sgn = 1;
        other = kf[c + F_B]!;
      } else if (kf[c + F_B] === A.index) {
        sgn = -1;
        other = kf[c + F_A]!;
      } else {
        continue;
      }
      const nx = kf[c + F_NX]! * sgn;
      const ny = kf[c + F_NX + 1]! * sgn;
      const nz = kf[c + F_NX + 2]! * sgn;
      const opposes = nx * dx + ny * dy + nz * dz <= -cosTol;
      const cx = needX && !covX && nx * sx <= -cosTol;
      const cy = needY && !covY && ny * sy <= -cosTol;
      const cz = needZ && !covZ && nz * sz <= -cosTol;
      if (!opposes && !cx && !cy && !cz) continue;
      if (!this.immovable(bodies[other]!, kin, ter, shipStart, bodies, dx, dy, dz, src, depth)) continue;
      if (opposes) return true;
      if (cx) covX = true;
      if (cy) covY = true;
      if (cz) covZ = true;
    }
    const any = needX || needY || needZ;
    return any && (!needX || covX) && (!needY || covY) && (!needZ || covZ);
  }

  /** Can ship body B not give way along d? Frozen ships never can; simulated ones if blocked. */
  private immovable(
    B: Body,
    kin: ContactSet,
    ter: ContactSet,
    shipStart: number,
    bodies: readonly Body[],
    dx: number,
    dy: number,
    dz: number,
    src: number,
    depth: number,
  ): boolean {
    if (B.mode === MODE_STATIC) return B.stats.frozen; // sleepers in the solve would wake instead
    if (B.mode !== MODE_ACTIVE || depth >= MAX_SUPPORT_CHAIN) return false;
    return this.blocked(B, kin, ter, shipStart, bodies, dx, dy, dz, src, depth + 1);
  }
}

/** Does the body have any contact this sub-step with terrain, another ship or another rotor? */
function touchesSupport(A: Body, kin: ContactSet, ter: ContactSet, shipStart: number): boolean {
  if (A.terEnd > A.terStart) return true;
  const kf = kin.f;
  for (let i = shipStart; i < kin.count; i++) {
    const c = i * STRIDE;
    if (kf[c + F_A] === A.index || kf[c + F_B] === A.index) return true;
  }
  // a second rotor touching the ship
  if (A.kinEnd > A.kinStart) {
    const first = kf[A.kinStart * STRIDE + F_SRC];
    for (let i = A.kinStart + 1; i < A.kinEnd; i++) if (kf[i * STRIDE + F_SRC] !== first) return true;
  }
  return false;
}

export class PinDetector {
  private readonly cell = { x: 0, y: 0, z: 0 };
  private readonly supports = new SupportQuery();

  /**
   * After the first velocity solve of a sub-step: mark the rotor contacts of pinned (ship, rotor)
   * pairs (F_PIN = PIN_PINNED; stale contacts keep PIN_STALE and never decide the test; blocked
   * and cutting ones, which took no part in the solve, still do).
   * `kin` holds rotor contacts in [0, shipStart), grouped by (ship, rotor), then ship/ship
   * contacts. Returns the number of pinned pairs and records the hull cell to destroy on each
   * pinned ship.
   */
  detect(kin: ContactSet, ter: ContactSet, shipStart: number, bodies: readonly Body[], o: ResolvedOptions): number {
    const f = kin.f;
    const ratio = o.pinPressRatio;
    const sup = this.supports;
    sup.configure(o.pinOpposeCos);
    let pairs = 0;
    let i = 0;
    while (i < shipStart) {
      const ai = f[i * STRIDE + F_A]!;
      const src = f[i * STRIDE + F_SRC]!;
      let j = i + 1;
      while (j < shipStart && f[j * STRIDE + F_A] === ai && f[j * STRIDE + F_SRC] === src) j++;
      const A = bodies[ai]!;
      let pin = false;
      for (let k = i; k < j && !pin; k++) {
        const c = k * STRIDE;
        const pinState = f[c + F_PIN];
        if (f[c + F_KIND] !== KIND_ROTOR || !(pinState === 0 || pinState === PIN_BLOCKED || pinState === PIN_REDIRECTED || pinState === PIN_CUTTING)) continue;
        if (!bladePresses(f, c, ratio)) continue; // (1a)
        const vox = f[c + F_VO]!;
        const voy = f[c + F_VO + 1]!;
        const voz = f[c + F_VO + 2]!;
        const vb = Math.sqrt(vox * vox + voy * voy + voz * voz);
        // a redirected contact acts through the centre of mass (solver.ts)
        const lin = pinState === PIN_REDIRECTED;
        const rx = lin ? 0 : f[c + F_PX]! - A.px;
        const ry = lin ? 0 : f[c + F_PX + 1]! - A.py;
        const rz = lin ? 0 : f[c + F_PX + 2]! - A.pz;
        const relx = vox - (A.vx + A.wy * rz - A.wz * ry);
        const rely = voy - (A.vy + A.wz * rx - A.wx * rz);
        const relz = voz - (A.vz + A.wx * ry - A.wy * rx);
        const press = relx * f[c + F_NX]! + rely * f[c + F_NX + 1]! + relz * f[c + F_NX + 2]!;
        if (press <= ratio * vb) continue; // (1b)
        if (sup.blocked(A, kin, ter, shipStart, bodies, vox / vb, voy / vb, voz / vb, src, 0)) pin = true; // (2)
      }
      if (pin) {
        pairs++;
        let best = -1;
        let bestDepth = -1;
        for (let k = i; k < j; k++) {
          const c = k * STRIDE;
          const ps = f[c + F_PIN];
          if (ps === 0 || ps === PIN_BLOCKED || ps === PIN_REDIRECTED || ps === PIN_CUTTING) f[c + F_PIN] = PIN_PINNED;
          // destroy where the blade is driving in deepest, stale contacts included (first found
          // on ties: deterministic)
          if (bladePresses(f, c, ratio) && f[c + F_DEPTH]! > bestDepth) {
            bestDepth = f[c + F_DEPTH]!;
            best = c;
          }
        }
        if (best >= 0) this.recordCell(A, f, best);
      }
      i = j;
    }
    return pairs;
  }

  /**
   * After the first solve, in pairs that are not pinned: rotor contacts that the blade presses
   * (1a) and that the solve left pressing by more than JAM_RATIO of the blade's speed, on a ship
   * touching any support, are jammed (F_PIN = PIN_BLOCKED): they transfer nothing in the
   * re-solve and destroy nothing. With the
   * terrain the blade drives into made frictionless, a solve leaves a pressing contact behind
   * only when the contacts cannot all be met together — a blade's tip corner wedged into a hull
   * at a wall: its end face and its leading face each look escapable, together they push the
   * hull into the wall. The blade's own motion is not opposed (condition 2), so LESSONS calls it
   * not pinned; but handed to the solver again such a set only trades huge impulses and throws
   * the hull about. Returns the number of contacts jammed.
   */
  jam(kin: ContactSet, ter: ContactSet, shipStart: number, bodies: readonly Body[], o: ResolvedOptions): number {
    const f = kin.f;
    const ratio = o.pinPressRatio;
    let jammed = 0;
    for (let i = 0; i < shipStart; i++) {
      const c = i * STRIDE;
      const ps = f[c + F_PIN];
      if (f[c + F_KIND] !== KIND_ROTOR || (ps !== 0 && ps !== PIN_REDIRECTED)) continue;
      if (!bladePresses(f, c, ratio)) continue;
      const A = bodies[f[c + F_A]!]!;
      if (!touchesSupport(A, kin, ter, shipStart)) continue;
      const vox = f[c + F_VO]!;
      const voy = f[c + F_VO + 1]!;
      const voz = f[c + F_VO + 2]!;
      const vb = Math.sqrt(vox * vox + voy * voy + voz * voz);
      // redirected contacts act through the centre of mass
      const lin = ps === PIN_REDIRECTED;
      const rx = lin ? 0 : f[c + F_PX]! - A.px;
      const ry = lin ? 0 : f[c + F_PX + 1]! - A.py;
      const rz = lin ? 0 : f[c + F_PX + 2]! - A.pz;
      const relx = vox - (A.vx + A.wy * rz - A.wz * ry);
      const rely = voy - (A.vy + A.wz * rx - A.wx * rz);
      const relz = voz - (A.vz + A.wx * ry - A.wy * rx);
      const press = relx * f[c + F_NX]! + rely * f[c + F_NX + 1]! + relz * f[c + F_NX + 2]!;
      if (press <= JAM_RATIO * vb) continue;
      f[c + F_PIN] = PIN_BLOCKED;
      jammed++;
    }
    return jammed;
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
    // Deepest overlap of the tick wins; ties keep the first found (deterministic order).
    if (!A.pinHas || depth > A.pinDepth) {
      A.pinHas = true;
      A.pinDepth = depth;
      A.pinX = x;
      A.pinY = y;
      A.pinZ = z;
    }
  }
}
