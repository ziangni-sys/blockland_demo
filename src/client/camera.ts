/**
 * Camera placement for the view modes (F5 cycles them). Client only: the simulation never
 * knows where the camera is — targeting, the outline and every interaction keep using the
 * first-person eye ray.
 *
 * Third person puts the camera on the line through the player's eye along the look direction:
 * behind the head ('back', looking the same way as the player) or in front of the face
 * ('front', turned around to look at the player). It sits up to THIRD_PERSON_DISTANCE away,
 * pulled in by a ray cast from the eye so it never ends up inside a block; THIRD_PERSON_MARGIN
 * keeps it off the surface it was pulled against (the near plane would clip it otherwise).
 *
 * Pure: the ray query is passed in, every result goes into a caller-owned object.
 */
import type { Vec3 } from '../core/math';

export type ViewMode = 'first' | 'back' | 'front';

/** F5 order: first person -> third person from behind -> from the front -> first person. */
export const VIEW_MODES: readonly ViewMode[] = ['first', 'back', 'front'];

/** Farthest the third-person camera goes from the eye (blocks). */
export const THIRD_PERSON_DISTANCE = 4;
/** Gap kept between the camera and the block it was pulled in against (blocks). */
export const THIRD_PERSON_MARGIN = 0.3;
/**
 * Closer than this to the eye, the camera is inside the player's own head: the client then
 * leaves the local player's model out, so the view is not filled by the inside of the head.
 */
export const SELF_HIDE_DISTANCE = 0.6;

export function nextViewMode(mode: ViewMode): ViewMode {
  const i = VIEW_MODES.indexOf(mode);
  return VIEW_MODES[(i + 1) % VIEW_MODES.length]!;
}

/**
 * Distance along a unit ray from `origin` to the first cell that blocks the camera, or any
 * value >= maxDist (Infinity included) when nothing does within maxDist.
 */
export type CameraRay = (origin: Vec3, dir: Vec3, maxDist: number) => number;

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** Distance from the eye (0 in first person). */
  distance: number;
}

export function cameraPose(): CameraPose {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, distance: 0 };
}

/** Wrap an angle to (-PI, PI]. */
function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r > Math.PI) r -= t;
  else if (r <= -Math.PI) r += t;
  return r;
}

/**
 * Where the camera goes for `mode`, given the player's eye and look angles (game convention:
 * forward = (-sin(yaw) cos(pitch), sin(pitch), -cos(yaw) cos(pitch))). `ray` is only called
 * in third person. Non-finite ray results count as "nothing in the way".
 */
export function placeCamera(mode: ViewMode, eye: Vec3, yaw: number, pitch: number, ray: CameraRay, out: CameraPose, scratchDir: Vec3): CameraPose {
  out.x = eye.x;
  out.y = eye.y;
  out.z = eye.z;
  out.yaw = yaw;
  out.pitch = pitch;
  out.distance = 0;
  if (mode === 'first') return out;
  const cp = Math.cos(pitch);
  // 'back': from the eye against the look direction; 'front': along it.
  const s = mode === 'back' ? -1 : 1;
  const d = scratchDir;
  d.x = -Math.sin(yaw) * cp * s;
  d.y = Math.sin(pitch) * s;
  d.z = -Math.cos(yaw) * cp * s;
  const hit = ray(eye, d, THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN);
  let dist = THIRD_PERSON_DISTANCE;
  if (hit === hit && hit < THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN) dist = Math.max(0, hit - THIRD_PERSON_MARGIN);
  out.x = eye.x + d.x * dist;
  out.y = eye.y + d.y * dist;
  out.z = eye.z + d.z * dist;
  out.distance = dist;
  if (mode === 'front') {
    // Turned around: looking back along the ray at the player's face.
    out.yaw = wrapAngle(yaw + Math.PI);
    out.pitch = -pitch;
  }
  return out;
}
