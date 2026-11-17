/**
 * Camera placement for the view modes (F5 cycles them). Client only: the simulation never
 * knows where the camera is — targeting, the outline and every interaction keep using the
 * first-person eye ray.
 *
 * 'back' is an over-the-shoulder view (placeBack): the camera sits behind the player and
 * SHOULDER_OFFSET to the right, and aims at the point CONVERGE_DISTANCE along the player's
 * own look ray, so the crosshair lies on that ray at that distance and the head stays off
 * the screen centre. Targeting still uses the eye ray, so for nearer targets the crosshair is
 * off by up to about 0.3 block; the target outline shows the truth.
 *
 * 'front' puts the camera on the look line in front of the face, turned around to look at
 * the player.
 *
 * Every third-person offset is cast as a ray first and pulled in so the camera never ends up
 * inside a block; THIRD_PERSON_MARGIN keeps it off the surface it was pulled against (the
 * near plane would clip it otherwise).
 *
 * Pure: the ray query is passed in, every result goes into a caller-owned object.
 */
import type { Vec3 } from '../core/math';

export type ViewMode = 'first' | 'back' | 'front';

/** F5 order: first person -> third person from behind -> from the front -> first person. */
export const VIEW_MODES: readonly ViewMode[] = ['first', 'back', 'front'];

/**
 * Farthest the third-person camera goes: 'back' this far behind the shoulder pivot, 'front'
 * this far in front of the eye (blocks).
 */
export const THIRD_PERSON_DISTANCE = 4;
/** Gap kept between the camera and the block it was pulled in against (blocks). */
export const THIRD_PERSON_MARGIN = 0.3;
/** How far 'back' moves the camera to the player's right, at level and moderate pitch (blocks). */
export const SHOULDER_OFFSET = 0.75;
/**
 * Up to this pitch either way the shoulder offset is full; beyond, it shrinks with cos(pitch)
 * to zero at straight up / down. The camera has yaw and pitch only (no roll): aimed from a
 * fixed sideways offset, its yaw would swing by up to 90 degrees near the poles. With the
 * shrinking offset the camera yaw stays within about 9.5 degrees of the player's (at the full
 * back distance; see placeBack).
 */
export const SHOULDER_FULL_PITCH = Math.PI / 3;
const COS_SHOULDER_FULL = Math.cos(SHOULDER_FULL_PITCH);
/**
 * 'back' aims at the point this far along the player's own look ray (the reach), so the
 * crosshair lies exactly on the targeting ray at that distance (blocks).
 */
export const CONVERGE_DISTANCE = 5;
/**
 * Every part of the local player's model (head, torso, swinging arms) lies inside a box
 * aligned with the body yaw: SELF_BOX_HALF to each side, front and back of the body axis,
 * from the feet up to SELF_BOX_TOP above the eye (the top of the head).
 */
export const SELF_BOX_HALF = 0.45;
export const SELF_BOX_TOP = 0.2;
/**
 * The local player's model is drawn only when the camera is at least this far outside that
 * box; nearer, the model would cut the near plane or fill the view, so it is left out.
 */
export const SELF_HIDE_CLEARANCE = 0.25;

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
 * How far the camera may go along a ray it wants to travel `want` along, given the ray
 * query's answer `hit` (cast up to want + margin): the hit minus the margin, clamped to
 * [0, want]. A non-finite hit counts as nothing in the way.
 */
function pullIn(hit: number, want: number): number {
  if (!Number.isFinite(hit) || hit >= want + THIRD_PERSON_MARGIN) return want;
  return Math.min(want, Math.max(0, hit - THIRD_PERSON_MARGIN));
}

/**
 * Where the camera goes for `mode`, given the player's eye and look angles (game convention:
 * forward = (-sin(yaw) cos(pitch), sin(pitch), -cos(yaw) cos(pitch))). `ray` is only called
 * in third person. Non-finite ray results count as "nothing in the way". `scratchDir` and
 * `scratchOrigin` are caller-owned scratch vectors (the ray arguments).
 */
export function placeCamera(
  mode: ViewMode,
  eye: Vec3,
  yaw: number,
  pitch: number,
  ray: CameraRay,
  out: CameraPose,
  scratchDir: Vec3,
  scratchOrigin: Vec3,
): CameraPose {
  out.x = eye.x;
  out.y = eye.y;
  out.z = eye.z;
  out.yaw = yaw;
  out.pitch = pitch;
  out.distance = 0;
  if (mode === 'first') return out;
  if (mode === 'back') return placeBack(eye, yaw, pitch, ray, out, scratchDir, scratchOrigin);
  // 'front': from the eye along the look direction, turned around to look at the face.
  const cp = Math.cos(pitch);
  const d = scratchDir;
  d.x = -Math.sin(yaw) * cp;
  d.y = Math.sin(pitch);
  d.z = -Math.cos(yaw) * cp;
  const dist = pullIn(ray(eye, d, THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN), THIRD_PERSON_DISTANCE);
  out.x = eye.x + d.x * dist;
  out.y = eye.y + d.y * dist;
  out.z = eye.z + d.z * dist;
  out.distance = dist;
  out.yaw = wrapAngle(yaw + Math.PI);
  out.pitch = -pitch;
  return out;
}

/**
 * Over the shoulder. With the player's horizontal right r = (cos yaw, 0, -sin yaw) and look
 * direction f:
 *  1. side = SHOULDER_OFFSET * min(1, cos(pitch) / cos(SHOULDER_FULL_PITCH));
 *  2. shoulder pivot P = eye + r * sideEff, sideEff pulled in by a ray from the eye along r
 *     (a wall on the right pushes the pivot back toward the head);
 *  3. camera C = P - f * back, back pulled in by a ray from P along -f;
 *  4. the camera looks at A = eye + f * CONVERGE_DISTANCE.
 * In the player's frame (right, horizontal forward, up) A - C = (-sideEff, cos(pitch) k,
 * sin(pitch) k) with k = CONVERGE_DISTANCE + back, so the camera yaw is the player's yaw plus
 * atan2(sideEff, cos(pitch) k) (positive = turned left, toward the player's look line). That
 * offset is at most atan(SHOULDER_OFFSET / (cos(SHOULDER_FULL_PITCH) * k)): 9.46 degrees at
 * the full back distance, more when the camera is pulled in (16.7 degrees with back = 0).
 * Straight up or down (cos(pitch) below 1e-9; the input never gets there) the direction is
 * vertical and the camera takes the player's yaw and pitch.
 */
function placeBack(eye: Vec3, yaw: number, pitch: number, ray: CameraRay, out: CameraPose, d: Vec3, pivot: Vec3): CameraPose {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // 1-2. Shoulder pivot, to the right of the eye.
  const side = SHOULDER_OFFSET * Math.max(0, Math.min(1, cp / COS_SHOULDER_FULL));
  d.x = cy;
  d.y = 0;
  d.z = -sy;
  const sideEff = pullIn(ray(eye, d, side + THIRD_PERSON_MARGIN), side);
  pivot.x = eye.x + cy * sideEff;
  pivot.y = eye.y;
  pivot.z = eye.z - sy * sideEff;
  // 3. Back from the pivot, against the look direction.
  d.x = sy * cp;
  d.y = -sp;
  d.z = cy * cp;
  const back = pullIn(ray(pivot, d, THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN), THIRD_PERSON_DISTANCE);
  out.x = pivot.x + d.x * back;
  out.y = pivot.y + d.y * back;
  out.z = pivot.z + d.z * back;
  out.distance = Math.sqrt(sideEff * sideEff + back * back);
  // 4. Aim at the convergence point (computed in the player's frame, see above).
  const k = CONVERGE_DISTANCE + back;
  if (cp < 1e-9) {
    out.yaw = yaw;
    out.pitch = pitch;
    return out;
  }
  const h = cp * k;
  out.yaw = wrapAngle(yaw + Math.atan2(sideEff, h));
  out.pitch = Math.atan2(sp * k, Math.sqrt(sideEff * sideEff + h * h));
  return out;
}

/**
 * Distance from the camera at (x, y, z) to the box that holds the local player's model
 * (SELF_BOX_HALF, SELF_BOX_TOP), for a player whose eye is at `eye`, `eyeHeight` above the
 * feet, facing `yaw`. 0 inside the box. The client draws the model only when this is at
 * least SELF_HIDE_CLEARANCE.
 */
export function selfModelGap(x: number, y: number, z: number, eye: Vec3, yaw: number, eyeHeight: number): number {
  const dx = x - eye.x;
  const dz = z - eye.z;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // Along the body's right (cos yaw, 0, -sin yaw) and forward (-sin yaw, 0, -cos yaw).
  const across = Math.max(0, Math.abs(dx * cy - dz * sy) - SELF_BOX_HALF);
  const along = Math.max(0, Math.abs(-dx * sy - dz * cy) - SELF_BOX_HALF);
  const dy = y - eye.y;
  const vertical = dy > SELF_BOX_TOP ? dy - SELF_BOX_TOP : dy < -eyeHeight ? -eyeHeight - dy : 0;
  return Math.sqrt(across * across + along * along + vertical * vertical);
}
