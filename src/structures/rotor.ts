/**
 * Rotor kinematics (docs/DESIGN.md "对象模型": mechanical structures move only as their
 * mechanism dictates). A rotor spins about the axis of the bearing it was started on; it
 * never collides, never breaks blocks and is never pushed, so its motion is a pure function
 * of its own state:
 *
 *     grid.rotation        = baseRotation * axisAngle(axis, angle)
 *     grid.angularVelocity = rotate(baseRotation, axis) * angularSpeed   (parent frame)
 *     grid.linearVelocity  = 0
 *     grid.position        = where the pivot (hub centre) sits in the parent frame — fixed
 *
 * The angular speed eases toward a target that grows mildly with the number of sails, so a
 * bigger windmill turns a little faster but never wildly so.
 *
 * Everything here is allocation-free: it runs for every rotor on every tick.
 */
import { ROTOR_MIN_SAILS } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../core/dirs';
import { vec3, wrapAngle, type Vec3 } from '../core/math';
import type { Rotor } from './structure';

/** Target angular speed (rad/s) of a rotor with exactly ROTOR_MIN_SAILS sails. */
export const ROTOR_SPEED_MIN = 0.5;
/** Target angular speed (rad/s) of a rotor with ROTOR_FULL_SAILS sails or more. */
export const ROTOR_SPEED_MAX = 1.0;
/** Sail count at which the target speed stops growing. */
export const ROTOR_FULL_SAILS = 40;
/** Time (s) a rotor needs to spin up from rest to its target speed (or to coast down to it). */
export const ROTOR_SPINUP_SECONDS = 2;

/**
 * Target angular speed (rad/s, always >= 0) for a sail count.
 *
 * ROTOR_SPEED_MIN at ROTOR_MIN_SAILS rising to ROTOR_SPEED_MAX at ROTOR_FULL_SAILS along an
 * ease-out curve (the first extra sails help most). Below the assembly minimum — a windmill
 * that lost sails to an explosion — the target falls linearly to 0, so a rotor with no sail
 * left coasts to a standstill instead of turning forever.
 */
export function rotorTargetSpeed(sails: number): number {
  if (!(sails > 0)) return 0;
  if (sails < ROTOR_MIN_SAILS) return (ROTOR_SPEED_MIN * sails) / ROTOR_MIN_SAILS;
  const t = Math.min(1, (sails - ROTOR_MIN_SAILS) / (ROTOR_FULL_SAILS - ROTOR_MIN_SAILS));
  return ROTOR_SPEED_MIN + (ROTOR_SPEED_MAX - ROTOR_SPEED_MIN) * t * (2 - t);
}

/**
 * Angular acceleration (rad/s^2) used while approaching `target`. Constant per target, so a
 * rotor reaches any target in ROTOR_SPINUP_SECONDS and arrives exactly (no asymptotic tail,
 * which also makes "stopped" an exact 0). Coasting down to a zero target uses the
 * acceleration of the smallest real windmill.
 */
export function rotorAcceleration(target: number): number {
  return Math.max(Math.abs(target), ROTOR_SPEED_MIN) / ROTOR_SPINUP_SECONDS;
}

/** Unit vector of an axis direction. */
export function axisVector(axis: Dir, out: Vec3 = vec3()): Vec3 {
  out.x = DIR_X[axis]!;
  out.y = DIR_Y[axis]!;
  out.z = DIR_Z[axis]!;
  return out;
}

/**
 * Write the rotor's grid rotation and velocities from its state (angle, angularSpeed,
 * baseRotation, axis). `moving` false reports zero velocity (a frozen rotor holds still even
 * though it keeps its angularSpeed for when it thaws). grid.position is never touched.
 */
export function applyRotorPose(rotor: Rotor, moving = true): void {
  const g = rotor.grid;
  const ux = DIR_X[rotor.axis]!;
  const uy = DIR_Y[rotor.axis]!;
  const uz = DIR_Z[rotor.axis]!;
  // spin = axisAngle(u, angle); rotation = base * spin, expanded because spin has a single
  // non-zero vector component — no temporary quaternion needed.
  const h = rotor.angle * 0.5;
  const s = Math.sin(h);
  const bx = ux * s;
  const by = uy * s;
  const bz = uz * s;
  const bw = Math.cos(h);
  const a = rotor.baseRotation;
  const r = g.rotation;
  const x = a.w * bx + a.x * bw + a.y * bz - a.z * by;
  const y = a.w * by - a.x * bz + a.y * bw + a.z * bx;
  const z = a.w * bz + a.x * by - a.y * bx + a.z * bw;
  const w = a.w * bw - a.x * bx - a.y * by - a.z * bz;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  r.x = x * inv;
  r.y = y * inv;
  r.z = z * inv;
  r.w = w * inv;

  const lv = g.linearVelocity;
  lv.x = 0;
  lv.y = 0;
  lv.z = 0;
  const av = g.angularVelocity;
  const speed = moving ? rotor.angularSpeed : 0;
  if (speed === 0) {
    av.x = 0;
    av.y = 0;
    av.z = 0;
    return;
  }
  // The spin axis is invariant under the spin itself, so in the parent frame it is simply
  // the axis rotated by the base orientation: v' = v + 2w(q×v) + 2q×(q×v) with q = base.
  const qx = a.x;
  const qy = a.y;
  const qz = a.z;
  const qw = a.w;
  const tx = 2 * (qy * uz - qz * uy);
  const ty = 2 * (qz * ux - qx * uz);
  const tz = 2 * (qx * uy - qy * ux);
  av.x = (ux + qw * tx + (qy * tz - qz * ty)) * speed;
  av.y = (uy + qw * ty + (qz * tx - qx * tz)) * speed;
  av.z = (uz + qw * tz + (qx * ty - qy * tx)) * speed;
}

/**
 * Advance a rotor by `dt` seconds: ease angularSpeed toward rotorTargetSpeed(sails), then
 * integrate the angle with the NEW speed (semi-implicit), so the angle change over the tick
 * is exactly angularSpeed * dt — the velocity the grid reports is the one that produced the
 * prev -> current pose bracket the ship physics interpolates across.
 * The caller snapshots the pose first (StructureManager.step does).
 */
export function advanceRotor(rotor: Rotor, dt: number): void {
  const target = rotorTargetSpeed(rotor.sails);
  const maxDelta = rotorAcceleration(target) * dt;
  const diff = target - rotor.angularSpeed;
  rotor.angularSpeed = Math.abs(diff) <= maxDelta ? target : rotor.angularSpeed + (diff > 0 ? maxDelta : -maxDelta);
  if (rotor.angularSpeed !== 0) {
    // Wrapped to (-PI, PI] so precision does not decay on a windmill that turns for hours.
    rotor.angle = wrapAngle(rotor.angle + rotor.angularSpeed * dt);
  }
  applyRotorPose(rotor, true);
}

/** A frozen rotor (unloaded surroundings) keeps its pose and reports no motion. */
export function holdRotor(rotor: Rotor): void {
  applyRotorPose(rotor, false);
}
