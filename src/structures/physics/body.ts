/**
 * Per-ship solver state. One Body lives as long as its Ship (WeakMap in dynamics.ts). Its
 * mass properties and shape persist between ticks; pose and velocities are re-read from the
 * ship's grid at the start of every tick (the grid stays authoritative: the manager may
 * teleport a ship or change its velocity between ticks) and written back at the end.
 *
 * Frame: world = R * local + t, with R = rotation matrix and t = position - R * pivot.
 * The pivot is the centre of mass, so (px,py,pz) = grid.position is the COM in world space.
 */
import { qintegrate, qnormalize, qtoMat3, quat, vec3, type Quat, type Vec3 } from '../../core/math';
import type { Ship } from '../structure';
import { mat3Congruence, type Mat3 } from './mat3';
import { WorldPatch } from './patch';
import { GridShape } from './shape';

export const MODE_NONE = 0; // not simulated this tick (removed, empty, asleep and undisturbed)
export const MODE_ACTIVE = 1; // integrated this tick
export const MODE_STATIC = 2; // frozen / unloaded: an immovable obstacle for other ships

/** What happened to a ship during the last step (debug overlays, tests). */
export interface ShipPhysicsStats {
  /** Integrated during the last step. */
  simulated: boolean;
  /** Skipped because ship.frozen or its surroundings are not loaded. */
  frozen: boolean;
  /** Contacts in the last sub-step, by kind. */
  terrainContacts: number;
  rotorContacts: number;
  shipContacts: number;
  /** Deepest generated terrain / rotor / ship penetration during the last step, blocks. */
  maxDepth: number;
  /** Rotor contacts found pinned during the last step (summed over sub-steps). */
  pinned: number;
  /** Hull cells destroyed by pinning during the last step. */
  destroyed: number;
  /** Submerged volume (cells) at the last sub-step. */
  submerged: number;
}

export class Body {
  readonly ship: Ship;
  readonly shape = new GridShape();
  readonly patch = new WorldPatch();
  readonly stats: ShipPhysicsStats = {
    simulated: false,
    frozen: false,
    terrainContacts: 0,
    rotorContacts: 0,
    shipContacts: 0,
    maxDepth: 0,
    pinned: 0,
    destroyed: 0,
    submerged: 0,
  };

  // ---- persistent mass data (massprops.ts)
  /** grid.version the hull / mass were derived from (-1 = never). */
  hullVersion = -1;
  massValid = false;
  /** Child-rotor signature the mass was derived from: [id, version, count] per child. */
  childSig: number[] = [];
  mass = 0;
  invMass = 0;
  /** Inverse inertia about the COM, local axes. */
  readonly invIl: Mat3 = new Float64Array(9);
  /** Local centre of mass (== grid.pivot after refresh). */
  readonly pivot: Vec3 = vec3();
  /** The ship can float (mass below the largest displacement): bilge cells are dry. */
  floats = false;
  /** Adaptive linear damping (1/s): heave, and rotation about local X and Z. */
  heaveDamping = 3;
  rollDampingX = 2;
  rollDampingZ = 2;

  // ---- per tick
  mode = MODE_NONE;
  index = -1;
  readonly R: Mat3 = new Float64Array(9);
  readonly invIw: Mat3 = new Float64Array(9);
  readonly q: Quat = quat();
  px = 0;
  py = 0;
  pz = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  wx = 0;
  wy = 0;
  wz = 0;
  /** Split-impulse pseudo velocities (position correction only, never kept). */
  vpx = 0;
  vpy = 0;
  vpz = 0;
  wpx = 0;
  wpy = 0;
  wpz = 0;
  /** Velocity snapshot taken before the contact solve (pinning re-solve restores it). */
  svx = 0;
  svy = 0;
  svz = 0;
  swx = 0;
  swy = 0;
  swz = 0;
  /** Largest distance from the COM to a hard-cell corner (bounding radius), blocks. */
  rMax = 0;
  /** World box of the hard cells at the start of the tick. */
  minX = 0;
  minY = 0;
  minZ = 0;
  maxX = 0;
  maxY = 0;
  maxZ = 0;
  /** Submerged volume, wetness (0..1) and thrust effectiveness (0..1) of the current sub-step. */
  submerged = 0;
  wet = 0;
  thrustWet = 0;
  /** Contact ranges of this body in the terrain / kinematic sets for the current sub-step. */
  terStart = 0;
  terEnd = 0;
  kinStart = 0;
  kinEnd = 0;
  /** Rotors (indices into the step's rotor views) that may reach this ship this tick. */
  readonly rotorCandidates: number[] = [];
  /** Terrain pushed back during this tick (a supporting contact carried load). */
  supportedThisTick = false;
  /** A rotor touched the ship this tick. */
  rotorTouchThisTick = false;
  /** Best pinned hull cell found this tick (deepest overlap); destroyed after the tick. */
  pinHas = false;
  pinDepth = 0;
  pinX = 0;
  pinY = 0;
  pinZ = 0;

  /** Grid pose as last written by the dynamics (external-change detection for sleepers). */
  private written = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private lastQx = 0;
  private lastQy = 0;
  private lastQz = 0;
  private lastQw = 1;

  private readonly tmpM: Mat3 = new Float64Array(9);
  private readonly tmpW: Vec3 = vec3();

  constructor(ship: Ship) {
    this.ship = ship;
  }

  /** Read pose and velocities from the grid and derive the frame, radius and world box. */
  loadPose(): void {
    const g = this.ship.grid;
    qnormalize(g.rotation, this.q);
    this.px = g.position.x;
    this.py = g.position.y;
    this.pz = g.position.z;
    this.vx = g.linearVelocity.x;
    this.vy = g.linearVelocity.y;
    this.vz = g.linearVelocity.z;
    this.wx = g.angularVelocity.x;
    this.wy = g.angularVelocity.y;
    this.wz = g.angularVelocity.z;
    this.updateFrame();
    this.computeExtent();
  }

  /** Rotation matrix, translation and world inverse inertia from the current q / position. */
  updateFrame(): void {
    const R = this.R;
    qtoMat3(this.q, R);
    const c = this.pivot;
    this.tx = this.px - (R[0]! * c.x + R[1]! * c.y + R[2]! * c.z);
    this.ty = this.py - (R[3]! * c.x + R[4]! * c.y + R[5]! * c.z);
    this.tz = this.pz - (R[6]! * c.x + R[7]! * c.y + R[8]! * c.z);
    mat3Congruence(R, this.invIl, this.tmpM, this.invIw);
  }

  /** Bounding radius about the COM and the world box of the hard cells (from the local box corners). */
  private computeExtent(): void {
    const s = this.shape;
    if (s.solidCount === 0) {
      this.rMax = 0;
      this.minX = this.maxX = this.px;
      this.minY = this.maxY = this.py;
      this.minZ = this.maxZ = this.pz;
      return;
    }
    const R = this.R;
    let r2 = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < 8; k++) {
      const lx = (k & 1) === 0 ? s.minX : s.maxX;
      const ly = (k & 2) === 0 ? s.minY : s.maxY;
      const lz = (k & 4) === 0 ? s.minZ : s.maxZ;
      const dx = lx - this.pivot.x;
      const dy = ly - this.pivot.y;
      const dz = lz - this.pivot.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) r2 = d2;
      const wx = R[0]! * lx + R[1]! * ly + R[2]! * lz + this.tx;
      const wy = R[3]! * lx + R[4]! * ly + R[5]! * lz + this.ty;
      const wz = R[6]! * lx + R[7]! * ly + R[8]! * lz + this.tz;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wz < minZ) minZ = wz;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
      if (wz > maxZ) maxZ = wz;
    }
    this.rMax = Math.sqrt(r2);
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
  }

  /** Make this body an immovable obstacle for the tick (frozen ships). */
  makeStatic(): void {
    this.mode = MODE_STATIC;
    this.vx = this.vy = this.vz = 0;
    this.wx = this.wy = this.wz = 0;
    this.vpx = this.vpy = this.vpz = 0;
    this.wpx = this.wpy = this.wpz = 0;
    this.invIw.fill(0);
  }

  /** Effective inverse mass for the solver (0 when static). */
  get solverInvMass(): number {
    return this.mode === MODE_ACTIVE ? this.invMass : 0;
  }

  /**
   * Scale velocities down so that no hull point travels farther than `maxStep` in `dt`
   * (|v| + |w| rMax) dt <= maxStep. Only ever removes energy.
   */
  clampVelocity(maxStep: number, dt: number): void {
    const vl = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
    const wl = Math.sqrt(this.wx * this.wx + this.wy * this.wy + this.wz * this.wz);
    const travel = (vl + wl * this.rMax) * dt;
    if (travel > maxStep) {
      const s = maxStep / travel;
      this.vx *= s;
      this.vy *= s;
      this.vz *= s;
      this.wx *= s;
      this.wy *= s;
      this.wz *= s;
    }
  }

  /**
   * Advance the pose by one sub-step with the real + pseudo velocities (semi-implicit Euler,
   * orientation by the exact exponential map). The pseudo part is trimmed so the total travel
   * stays within `maxStep` (the real part already is), then cleared.
   */
  integrate(maxStep: number, dt: number): void {
    let vpx = this.vpx;
    let vpy = this.vpy;
    let vpz = this.vpz;
    let wpx = this.wpx;
    let wpy = this.wpy;
    let wpz = this.wpz;
    const r = this.rMax;
    const real =
      (Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz) +
        Math.sqrt(this.wx * this.wx + this.wy * this.wy + this.wz * this.wz) * r) *
      dt;
    const pseudo = (Math.sqrt(vpx * vpx + vpy * vpy + vpz * vpz) + Math.sqrt(wpx * wpx + wpy * wpy + wpz * wpz) * r) * dt;
    if (pseudo > 0 && real + pseudo > maxStep) {
      const s = Math.max(0, maxStep - real) / pseudo;
      vpx *= s;
      vpy *= s;
      vpz *= s;
      wpx *= s;
      wpy *= s;
      wpz *= s;
    }
    this.px += (this.vx + vpx) * dt;
    this.py += (this.vy + vpy) * dt;
    this.pz += (this.vz + vpz) * dt;
    const w = this.tmpW;
    w.x = this.wx + wpx;
    w.y = this.wy + wpy;
    w.z = this.wz + wpz;
    qintegrate(this.q, w, dt, this.q);
    this.vpx = this.vpy = this.vpz = 0;
    this.wpx = this.wpy = this.wpz = 0;
  }

  /**
   * Did something outside the dynamics move this ship since we last wrote its pose (a teleport,
   * a velocity set by game code)? Used to wake sleeping ships.
   */
  disturbedSinceWrite(): boolean {
    const g = this.ship.grid;
    const p = g.position;
    const r = g.rotation;
    const v = g.linearVelocity;
    const w = g.angularVelocity;
    return (
      !this.written ||
      p.x !== this.lastX ||
      p.y !== this.lastY ||
      p.z !== this.lastZ ||
      r.x !== this.lastQx ||
      r.y !== this.lastQy ||
      r.z !== this.lastQz ||
      r.w !== this.lastQw ||
      v.x !== 0 ||
      v.y !== 0 ||
      v.z !== 0 ||
      w.x !== 0 ||
      w.y !== 0 ||
      w.z !== 0
    );
  }

  /** Remember the grid pose as ours (after a write-back or a refresh that moved the pivot). */
  rememberPose(): void {
    const g = this.ship.grid;
    this.written = true;
    this.lastX = g.position.x;
    this.lastY = g.position.y;
    this.lastZ = g.position.z;
    this.lastQx = g.rotation.x;
    this.lastQy = g.rotation.y;
    this.lastQz = g.rotation.z;
    this.lastQw = g.rotation.w;
  }

  /** Write pose and velocities back to the grid (pivot stays the COM). */
  writeBack(): void {
    const g = this.ship.grid;
    g.position.x = this.px;
    g.position.y = this.py;
    g.position.z = this.pz;
    g.rotation.x = this.q.x;
    g.rotation.y = this.q.y;
    g.rotation.z = this.q.z;
    g.rotation.w = this.q.w;
    g.linearVelocity.x = this.vx;
    g.linearVelocity.y = this.vy;
    g.linearVelocity.z = this.vz;
    g.angularVelocity.x = this.wx;
    g.angularVelocity.y = this.wy;
    g.angularVelocity.z = this.wz;
  }

  snapshotVelocity(): void {
    this.svx = this.vx;
    this.svy = this.vy;
    this.svz = this.vz;
    this.swx = this.wx;
    this.swy = this.wy;
    this.swz = this.wz;
  }
  restoreVelocity(): void {
    this.vx = this.svx;
    this.vy = this.svy;
    this.vz = this.svz;
    this.wx = this.swx;
    this.wy = this.swy;
    this.wz = this.swz;
  }

  resetTickStats(): void {
    const s = this.stats;
    s.simulated = false;
    s.frozen = false;
    s.terrainContacts = 0;
    s.rotorContacts = 0;
    s.shipContacts = 0;
    s.maxDepth = 0;
    s.pinned = 0;
    s.destroyed = 0;
    s.submerged = 0;
    this.supportedThisTick = false;
    this.rotorTouchThisTick = false;
    this.pinHas = false;
    this.pinDepth = 0;
  }
}
