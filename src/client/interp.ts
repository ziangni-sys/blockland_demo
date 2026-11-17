/**
 * Interpolation helpers for rendering between two simulation ticks. Pure; every function
 * writes into a caller-owned `out` (docs/ARCHITECTURE.md: no shared temporaries).
 */
import { qrotate, qrotateInv, type Quat, type Vec3 } from '../core/math';

/** A rigid frame in world space: world = position + rotation * (local - pivot). */
export interface FramePose {
  position: Vec3;
  rotation: Quat;
}

/** World point -> local point of a frame with the given pivot. `out` may alias `p`. */
export function frameToLocal(frame: FramePose, pivot: Vec3, p: Vec3, out: Vec3): Vec3 {
  out.x = p.x - frame.position.x;
  out.y = p.y - frame.position.y;
  out.z = p.z - frame.position.z;
  qrotateInv(frame.rotation, out, out);
  out.x += pivot.x;
  out.y += pivot.y;
  out.z += pivot.z;
  return out;
}

/** Local point of a frame -> world point. `out` may alias `local`. */
export function frameToWorld(frame: FramePose, pivot: Vec3, local: Vec3, out: Vec3): Vec3 {
  out.x = local.x - pivot.x;
  out.y = local.y - pivot.y;
  out.z = local.z - pivot.z;
  qrotate(frame.rotation, out, out);
  out.x += frame.position.x;
  out.y += frame.position.y;
  out.z += frame.position.z;
  return out;
}

export function lerpVec(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Shortest-arc interpolation between two angles (radians). */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * t;
}

/**
 * Render position of a point carried by a moving frame (a player on a ship deck).
 *
 * Interpolating the world positions linearly would cut the chord of the arc the frame swings
 * the point along, and its error would beat against the frame's own (slerped) render pose:
 * the deck would wobble under the camera. Instead the point is expressed in the frame's local
 * space at both ticks (prev world point with the frame's prev pose, current with the current
 * pose), the LOCAL positions are blended (that is the rider's own walking), and the result is
 * placed with the frame's interpolated render pose — exactly the transform its mesh uses.
 *
 * `scratch` must not alias `out`.
 */
export function interpolateCarried(
  prevWorld: Vec3,
  curWorld: Vec3,
  framePrev: FramePose,
  frameCur: FramePose,
  frameRender: FramePose,
  pivot: Vec3,
  t: number,
  out: Vec3,
  scratch: Vec3,
): Vec3 {
  frameToLocal(framePrev, pivot, prevWorld, scratch);
  frameToLocal(frameCur, pivot, curWorld, out);
  lerpVec(scratch, out, t, out);
  return frameToWorld(frameRender, pivot, out, out);
}

/**
 * Frame-rate independent exponential approach of `current` toward `target`: after `dt`
 * seconds the remaining gap shrinks by exp(-rate * dt).
 */
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (!(dt > 0)) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}
