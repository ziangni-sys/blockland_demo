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
 * Obstacle avoidance in 'back' keeps a real clearance around the camera, not just a gap along
 * a ray: the camera is a cube of half-size CAMERA_CLEARANCE swept along its path (sweepGrids),
 * so no blocking cell is ever nearer to it than CAMERA_CLEARANCE in any direction, which keeps
 * the whole near plane out of every block. Pulling in is immediate; moving out again is eased
 * (CAMERA_EASE_TIME), and the eased pose is always inside the allowed one.
 *
 * 'front' puts the camera on the look line in front of the face, turned around to look at
 * the player; it is pulled in by a single ray and keeps THIRD_PERSON_MARGIN along it.
 *
 * Pure: the world queries are passed in, every result and all scratch go into caller-owned
 * objects (the CameraRig also holds the easing state of 'back').
 */
import { qrotateInv, quat, vec3, type Quat, type Vec3 } from '../core/math';
import type { VoxelGrid } from '../voxel/grid';
import type { CellPredicate } from '../voxel/raycast';

export type ViewMode = 'first' | 'back' | 'front';

/** F5 order: first person -> third person from behind -> from the front -> first person. */
export const VIEW_MODES: readonly ViewMode[] = ['first', 'back', 'front'];

/**
 * Farthest the third-person camera goes: 'back' this far behind the shoulder pivot, 'front'
 * this far in front of the eye (blocks).
 */
export const THIRD_PERSON_DISTANCE = 4;
/** 'front' only: gap kept along its ray between the camera and the block it was pulled in against. */
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
 * Farthest a corner of the near plane gets from the camera position, over every view the game
 * allows: renderer near plane 0.05 (render/three/backend.ts), field of view up to 110 degrees
 * (settings) widened by 10 % while sprinting (view.ts) = 121 degrees vertical, and a 21:9
 * window: sqrt(near^2 + h^2 + (h * 21/9)^2) with h = near * tan(60.5 deg) gives 0.2299.
 */
export const NEAR_PLANE_REACH = 0.23;
/**
 * 'back': no camera-blocking cell of any grid comes nearer to the camera than this, in any
 * direction (blocks). It exceeds NEAR_PLANE_REACH, so the near plane never reaches into a block.
 * Measured in each grid's own axes (a cube of this half-size), which is stricter than a sphere.
 */
export const CAMERA_CLEARANCE = 0.25;
/**
 * The shoulder pivot keeps this much more than CAMERA_CLEARANCE from the cells it moves
 * toward. Without it, a pivot parked exactly at the clearance against a wall on the right
 * would leave no room at all once the player turns a little toward that wall (the back path
 * then closes in on the wall at once); with it the back distance shrinks gradually, as
 * SHOULDER_SLACK / sin(turn). When the eye itself is nearer than PIVOT_CLEARANCE to cells on
 * the right (the body against a wall there), the pivot steps up to this far LEFT of the eye
 * to get that room back, so hugging a wall on the right keeps the same gradual pull-in.
 */
export const SHOULDER_SLACK = 0.15;
/** Clearance the shoulder pivot needs: CAMERA_CLEARANCE + SHOULDER_SLACK. */
export const PIVOT_CLEARANCE = CAMERA_CLEARANCE + SHOULDER_SLACK;
/**
 * 'back' moves out again (after an obstacle is gone) exponentially with this time constant
 * (seconds); pulling in is immediate.
 */
export const CAMERA_EASE_TIME = 0.15;
/** Longest frame time the easing accounts for (seconds); a longer hitch eases as if it were this long. */
export const CAMERA_EASE_MAX_DT = 0.1;
/** Taken off every contact distance, so the clearance holds strictly despite rounding (blocks). */
const CONTACT_EPS = 1e-6;
/** An eased value this close below its target takes the target exactly (so open space ends exact). */
const EASE_SNAP = 1e-9;
/** A graded sweep keeps a hair less than the clearance the origin had (blocks). */
const GRADE_EPS = 1e-9;
/**
 * Every part of the local player's model (head, torso, swinging arms) lies inside a box
 * aligned with the body yaw: SELF_BOX_HALF to each side, front and back of the body axis,
 * from the feet up to SELF_BOX_TOP above the eye (the top of the head).
 */
export const SELF_BOX_HALF = 0.45;
export const SELF_BOX_TOP = 0.2;
/**
 * The local player's model is drawn only when the camera is at least this far outside that
 * box; nearer, the model would cut the near plane (NEAR_PLANE_REACH) or fill the view, so it
 * is left out.
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

/**
 * Clearance sweep: a cube of half-size `half` (axis-aligned in each grid's own axes) moves
 * from `origin` along the unit `dir`. Returns how far it gets before it would overlap a cell
 * that blocks the camera: `maxDist` when nothing is in the way, the contact distance in
 * [0, maxDist) otherwise, and a negative number when the cube already overlaps a cell at
 * `origin`. Touching is not overlapping.
 *
 * `graded`: the cube is first shrunk to min(half, the clearance `origin` already has), so the
 * clearance never drops below what it was at the start, up to `half`: moving along or away from
 * a cell nearer than `half` is free, moving toward it is not. The result is then never negative.
 */
export type CameraSweep = (origin: Vec3, dir: Vec3, maxDist: number, half: number, graded: boolean) => number;

/** The world queries placeCamera uses: a ray ('front') and a clearance sweep ('back'). */
export interface CameraQueries {
  ray: CameraRay;
  sweep: CameraSweep;
}

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

/**
 * Caller-owned state of the 'back' placement: the eased side offset and back distance of the
 * last frame, and scratch vectors. Reset it (resetCameraRig) when the view mode changes or a
 * world is opened; the first placement after a reset takes the allowed pose at once.
 */
export interface CameraRig {
  /** Side offset s of the last 'back' frame (blocks, to the player's right; negative = left). */
  side: number;
  /** Back distance b of the last 'back' frame (blocks, from the shoulder pivot). */
  back: number;
  /**
   * Eased state of the side offset, s = sideFrac * side0 + sideLeft: the fraction of the wanted
   * offset side0 in [0, 1], and the step left of the eye in [-SHOULDER_SLACK, 0]. Only what
   * obstacles take away is eased, so with nothing in the way s is exactly side0 at every pitch,
   * even while side0 itself changes with the pitch.
   */
  sideFrac: number;
  sideLeft: number;
  /** False until the first 'back' frame after a reset: nothing to ease from yet. */
  primed: boolean;
  readonly dir: Vec3;
  readonly pivot: Vec3;
}

export function cameraRig(): CameraRig {
  return { side: 0, back: 0, sideFrac: 1, sideLeft: 0, primed: false, dir: vec3(), pivot: vec3() };
}

export function resetCameraRig(rig: CameraRig): void {
  rig.side = 0;
  rig.back = 0;
  rig.sideFrac = 1;
  rig.sideLeft = 0;
  rig.primed = false;
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
 * How far the camera may go along a sweep it wanted to travel `want` along, given the sweep's
 * answer: all of it when nothing is in the way, else the contact distance (less a hair),
 * and 0 when the start is not clear. Anything that is not a number counts as "not clear".
 */
function allowedBy(hit: number, want: number): number {
  if (!(hit >= 0)) return 0;
  if (hit >= want) return want;
  return Math.max(0, hit - CONTACT_EPS);
}

/**
 * One easing step of a 'back' distance toward the value `allowed` this frame: down at once,
 * up exponentially (CAMERA_EASE_TIME), never above `allowed`. Frame-rate independent.
 */
export function easeOut(current: number, allowed: number, dt: number): number {
  if (!(current < allowed)) return allowed;
  const t = dt > 0 ? Math.min(dt, CAMERA_EASE_MAX_DT) : 0;
  const gap = (allowed - current) * Math.exp(-t / CAMERA_EASE_TIME);
  return gap < EASE_SNAP ? allowed : allowed - gap;
}

/**
 * Where the camera goes for `mode`, given the player's eye and look angles (game convention:
 * forward = (-sin(yaw) cos(pitch), sin(pitch), -cos(yaw) cos(pitch))). The queries are only
 * used in third person ('front' casts `ray`, 'back' sweeps `sweep`). `rig` carries the easing
 * of 'back' from frame to frame (dt = seconds since the last frame) and the scratch vectors.
 */
export function placeCamera(
  mode: ViewMode,
  eye: Vec3,
  yaw: number,
  pitch: number,
  q: CameraQueries,
  rig: CameraRig,
  dt: number,
  out: CameraPose,
): CameraPose {
  out.x = eye.x;
  out.y = eye.y;
  out.z = eye.z;
  out.yaw = yaw;
  out.pitch = pitch;
  out.distance = 0;
  if (mode === 'first') return out;
  if (mode === 'back') return placeBack(eye, yaw, pitch, q.sweep, rig, dt, out);
  // 'front': from the eye along the look direction, turned around to look at the face.
  const cp = Math.cos(pitch);
  const d = rig.dir;
  d.x = -Math.sin(yaw) * cp;
  d.y = Math.sin(pitch);
  d.z = -Math.cos(yaw) * cp;
  const dist = pullIn(q.ray(eye, d, THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN), THIRD_PERSON_DISTANCE);
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
 *  1. wanted side offset side0 = SHOULDER_OFFSET * min(1, cos(pitch) / cos(SHOULDER_FULL_PITCH));
 *  2. allowed side offset (allowedSide): how far a cube of half-size PIVOT_CLEARANCE gets from
 *     the eye along r, up to side0 (graded: when the eye itself is nearer than that to some cell,
 *     e.g. with its back against a wall, the cube is shrunk to the eye's own clearance, so the
 *     pivot can still slide along that wall instead of staying in the head). With no room at all
 *     on the right, the pivot steps left instead, up to SHOULDER_SLACK, until a PIVOT_CLEARANCE
 *     cube fits beside the cells on the right again;
 *  3. side s: the allowed value, eased (down at once, up over CAMERA_EASE_TIME); only what the
 *     obstacles take away is eased (the fraction of side0 and the step left, see CameraRig), so
 *     open space gives exactly side0. Pivot P = eye + r * s;
 *  4. allowed back distance: how far a cube of half-size CAMERA_CLEARANCE gets from P along -f,
 *     up to THIRD_PERSON_DISTANCE (0 when P itself is not clear; with s != 0 the side then drops
 *     to 0 and the eye is tried instead, so a camera without clearance is always the eye);
 *  5. back b = that, eased the same way; camera C = P - f * b;
 *  6. the camera looks at A = eye + f * CONVERGE_DISTANCE.
 * Every point of the way from P to C keeps CAMERA_CLEARANCE, so C does, and the eased s and b
 * never exceed what is allowed for them (b is allowed for the eased s, not for the allowed one).
 * Two sweeps per frame; up to two more with no room on the right, one more in the rare fallback.
 *
 * In the player's frame (right, horizontal forward, up) A - C = (-s, cos(pitch) k,
 * sin(pitch) k) with k = CONVERGE_DISTANCE + b, so the camera yaw is the player's yaw plus
 * atan2(s, cos(pitch) k) (positive = turned left, toward the player's look line). That offset
 * is at most atan(SHOULDER_OFFSET / (cos(SHOULDER_FULL_PITCH) * k)): 9.46 degrees at the full
 * back distance, more when the camera is pulled in (16.7 degrees with b = 0). Straight up or
 * down (cos(pitch) below 1e-9; the input never gets there) the direction is vertical and the
 * camera takes the player's yaw and pitch.
 */
function placeBack(eye: Vec3, yaw: number, pitch: number, sweep: CameraSweep, rig: CameraRig, dt: number, out: CameraPose): CameraPose {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const d = rig.dir;
  const pivot = rig.pivot;
  // 1-3. Shoulder pivot, to the right of the eye (or a little to its left, see allowedSide).
  const side0 = SHOULDER_OFFSET * Math.max(0, Math.min(1, cp / COS_SHOULDER_FULL));
  const sideAllowed = side0 > 0 ? allowedSide(eye, cy, sy, side0, sweep, d, pivot) : 0;
  const fracAllowed = side0 > 0 ? Math.max(0, sideAllowed) / side0 : 1;
  const leftAllowed = Math.min(0, sideAllowed);
  const frac = rig.primed ? easeOut(rig.sideFrac, fracAllowed, dt) : fracAllowed;
  const left = rig.primed ? easeOut(rig.sideLeft, leftAllowed, dt) : leftAllowed;
  // frac <= fracAllowed and left <= leftAllowed, so this is at most sideAllowed; the min only
  // guards against rounding.
  let side = Math.min(frac * side0 + left, sideAllowed);
  rig.sideFrac = frac;
  rig.sideLeft = left;
  pivot.x = eye.x + cy * side;
  pivot.y = eye.y;
  pivot.z = eye.z - sy * side;
  // 4-5. Back from the (eased) pivot, against the look direction.
  d.x = sy * cp;
  d.y = -sp;
  d.z = cy * cp;
  let hit = sweep(pivot, d, THIRD_PERSON_DISTANCE, CAMERA_CLEARANCE, false);
  if (!(hit >= 0) && side !== 0) {
    // The pivot has no clearance (only when the eye itself is that close to a cell): fall back
    // to the eye, which is never inside a block.
    side = 0;
    rig.sideFrac = 0;
    rig.sideLeft = 0;
    pivot.x = eye.x;
    pivot.z = eye.z;
    hit = sweep(pivot, d, THIRD_PERSON_DISTANCE, CAMERA_CLEARANCE, false);
  }
  const backAllowed = allowedBy(hit, THIRD_PERSON_DISTANCE);
  const back = rig.primed ? easeOut(rig.back, backAllowed, dt) : backAllowed;
  rig.side = side;
  rig.back = back;
  rig.primed = true;
  out.x = pivot.x + d.x * back;
  out.y = pivot.y + d.y * back;
  out.z = pivot.z + d.z * back;
  out.distance = Math.sqrt(side * side + back * back);
  // 6. Aim at the convergence point (computed in the player's frame, see above).
  if (cp < 1e-9) return out;
  const k = CONVERGE_DISTANCE + back;
  const h = cp * k;
  out.yaw = wrapAngle(yaw + Math.atan2(side, h));
  out.pitch = Math.atan2(sp * k, Math.sqrt(side * side + h * h));
  return out;
}

/**
 * The allowed side offset of 'back' (blocks along the player's right r = (cy, 0, -sy)), in
 * [-SHOULDER_SLACK, side0]: the largest s for which the pivot eye + r * s keeps PIVOT_CLEARANCE
 * (graded, see placeBack) on the way out from the eye.
 *
 * With no room on the right (the eye is already nearer than PIVOT_CLEARANCE to cells there, e.g.
 * the body touching a wall on the right) the pivot steps left: first as far as a graded
 * CAMERA_CLEARANCE cube gets from the eye along -r, up to SHOULDER_SLACK (a point l left of the
 * eye), then from there back to the right as a PIVOT_CLEARANCE cube does, up to the eye. So
 * next to a wall on the right at distance w the side offset is w - PIVOT_CLEARANCE on both sides
 * of w = PIVOT_CLEARANCE (continuous), and the pivot keeps the slack even when the body touches
 * the wall. `d` and `o` are scratch.
 */
function allowedSide(eye: Vec3, cy: number, sy: number, side0: number, sweep: CameraSweep, d: Vec3, o: Vec3): number {
  d.x = cy;
  d.y = 0;
  d.z = -sy;
  const room = sweep(eye, d, side0, PIVOT_CLEARANCE, true);
  if (room >= side0) return side0;
  if (room - CONTACT_EPS > 0) return room - CONTACT_EPS;
  // No room on the right: step left.
  d.x = -cy;
  d.z = sy;
  const l = allowedBy(sweep(eye, d, SHOULDER_SLACK, CAMERA_CLEARANCE, true), SHOULDER_SLACK);
  if (!(l > 0)) return 0;
  o.x = eye.x - cy * l;
  o.y = eye.y;
  o.z = eye.z + sy * l;
  d.x = cy;
  d.z = -sy;
  const hit = sweep(o, d, l, PIVOT_CLEARANCE, true);
  if (hit >= l) return 0;
  return allowedBy(hit, l) - l;
}

/**
 * One grid as the camera sees it this frame: its cells, and the transform they are drawn
 * with (world = position + rotate(rotation, local - pivot), the StructureGrid.renderPose
 * convention). The world grid uses the identity (all zero, rotation (0, 0, 0, 1)).
 */
export interface CameraGridFrame {
  grid: VoxelGrid | null;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly pivot: Vec3;
}

export function cameraGridFrame(): CameraGridFrame {
  return { grid: null, position: vec3(), rotation: quat(), pivot: vec3() };
}

/** Scratch vectors of sweepGrids (caller-owned). */
export interface SweepScratch {
  readonly o: Vec3;
  readonly d: Vec3;
}

export function sweepScratch(): SweepScratch {
  return { o: vec3(), d: vec3() };
}

/** Where `p` is in a grid frame's local space (into `out`). */
function frameLocal(f: CameraGridFrame, p: Vec3, out: Vec3): Vec3 {
  out.x = p.x - f.position.x;
  out.y = p.y - f.position.y;
  out.z = p.z - f.position.z;
  qrotateInv(f.rotation, out, out);
  out.x += f.pivot.x;
  out.y += f.pivot.y;
  out.z += f.pivot.z;
  return out;
}

/**
 * The CameraSweep (see there) over the first `count` grid frames, against the cells for which
 * `blocks` is true. Exact: every candidate cell's cube, grown by the half-size, is intersected
 * with the path in the grid's own axes (rotation keeps distances, so a structure turned any way
 * is handled like the world). Visits only the cells in the path's local bounding box (clipped
 * to a structure's cell bounds); allocation-free.
 */
export function sweepGrids(
  frames: readonly CameraGridFrame[],
  count: number,
  blocks: CellPredicate,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  half: number,
  graded: boolean,
  scratch: SweepScratch,
): number {
  if (!graded) return sweepCube(frames, count, blocks, origin, dir, maxDist, half, scratch);
  const c = clearanceAt(frames, count, blocks, origin, half, scratch);
  const h = c >= half ? half : Math.max(0, c - GRADE_EPS);
  return Math.max(0, sweepCube(frames, count, blocks, origin, dir, maxDist, h, scratch));
}

/**
 * Clearance of the point `p`: the distance to the nearest cell for which `blocks` is true,
 * measured along each grid's own axes (the largest per-axis gap, so a cube of that half-size
 * around `p` just touches it), or `range` when no such cell is nearer than `range`.
 */
export function clearanceAt(
  frames: readonly CameraGridFrame[],
  count: number,
  blocks: CellPredicate,
  p: Vec3,
  range: number,
  scratch: SweepScratch,
): number {
  let best = range;
  for (let i = 0; i < count; i++) {
    const f = frames[i]!;
    const grid = f.grid;
    if (grid === null) continue;
    const o = frameLocal(f, p, scratch.o);
    let x0 = Math.floor(o.x - range);
    let x1 = Math.floor(o.x + range);
    let y0 = Math.floor(o.y - range);
    let y1 = Math.floor(o.y + range);
    let z0 = Math.floor(o.z - range);
    let z1 = Math.floor(o.z + range);
    if (!grid.isWorld) {
      const b = grid.cellBounds();
      if (b === null) continue;
      x0 = Math.max(x0, b.minX);
      x1 = Math.min(x1, b.maxX - 1);
      y0 = Math.max(y0, b.minY);
      y1 = Math.min(y1, b.maxY - 1);
      z0 = Math.max(z0, b.minZ);
      z1 = Math.min(z1, b.maxZ - 1);
    }
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (!blocks(grid.getCell(x, y, z))) continue;
          const gap = Math.max(x - o.x, o.x - x - 1, y - o.y, o.y - y - 1, z - o.z, o.z - z - 1, 0);
          if (gap < best) best = gap;
        }
      }
    }
  }
  return best;
}

/** The plain (not graded) sweep of a cube of half-size `half`; see CameraSweep. */
function sweepCube(
  frames: readonly CameraGridFrame[],
  count: number,
  blocks: CellPredicate,
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  half: number,
  scratch: SweepScratch,
): number {
  let best = maxDist;
  for (let i = 0; i < count; i++) {
    const f = frames[i]!;
    const grid = f.grid;
    if (grid === null) continue;
    const o = frameLocal(f, origin, scratch.o);
    const d = qrotateInv(f.rotation, dir, scratch.d);
    const ex = o.x + d.x * maxDist;
    const ey = o.y + d.y * maxDist;
    const ez = o.z + d.z * maxDist;
    let x0 = Math.floor(Math.min(o.x, ex) - half);
    let x1 = Math.floor(Math.max(o.x, ex) + half);
    let y0 = Math.floor(Math.min(o.y, ey) - half);
    let y1 = Math.floor(Math.max(o.y, ey) + half);
    let z0 = Math.floor(Math.min(o.z, ez) - half);
    let z1 = Math.floor(Math.max(o.z, ez) + half);
    if (!grid.isWorld) {
      const b = grid.cellBounds();
      if (b === null) continue;
      x0 = Math.max(x0, b.minX);
      x1 = Math.min(x1, b.maxX - 1);
      y0 = Math.max(y0, b.minY);
      y1 = Math.min(y1, b.maxY - 1);
      z0 = Math.max(z0, b.minZ);
      z1 = Math.min(z1, b.maxZ - 1);
    }
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (!blocks(grid.getCell(x, y, z))) continue;
          // Slab test of the path against the cell's cube grown by `half` (open box: touching is free).
          let enter = -Infinity;
          let exit = Infinity;
          let miss = false;
          for (let a = 0; a < 3 && !miss; a++) {
            const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
            const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
            const lo = (a === 0 ? x : a === 1 ? y : z) - half;
            const hi = lo + 1 + 2 * half;
            if (Math.abs(da) < 1e-12) {
              if (oa <= lo || oa >= hi) miss = true;
              continue;
            }
            let t1 = (lo - oa) / da;
            let t2 = (hi - oa) / da;
            if (t1 > t2) {
              const t = t1;
              t1 = t2;
              t2 = t;
            }
            if (t1 > enter) enter = t1;
            if (t2 < exit) exit = t2;
            if (enter >= exit) miss = true;
          }
          if (miss || exit <= 0 || enter >= best) continue;
          // Already overlapping at the origin.
          if (enter < 0) return -1;
          best = enter;
        }
      }
    }
  }
  return best;
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
