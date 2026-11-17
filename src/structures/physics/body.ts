/**
 * Per-ship solver state. One Body lives as long as its Ship (WeakMap in dynamics.ts). Its
 * mass properties and shape persist between ticks; pose and velocities are re-read from the
 * ship's grid at the start of every tick (the grid stays authoritative: the manager may
 * teleport a ship or change its velocity between ticks) and written back at the end.
 *
 * Frame: world = R * local + t, with R = rotation matrix and t = position - R * pivot.
 * The pivot is the centre of mass, so (px,py,pz) = grid.position is the COM in world space.
 */
import { qnormalize, qtoMat3, quat, vec3, type Quat, type Vec3 } from '../../core/math';
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
  /**
   * Not simulated because the ship has no hard cell left (only soft cells such as torches, or
   * no cell at all): nothing can collide or float, so it is held motionless with zero velocity
   * and asleep until cells are added. The structure manager should remove such ships.
   */
  inert: boolean;
  /** Contacts in the last sub-step, by kind (after manifold reduction). */
  terrainContacts: number;
  rotorContacts: number;
  shipContacts: number;
  /**
   * Deepest generated terrain / rotor / ship penetration during the last step, blocks. Includes
   * stale rotor contacts (a blade that has cut into the hull while it was pinned).
   */
  maxDepth: number;
  /**
   * Rotor contacts that transferred nothing because their (ship, rotor) pair was pinned, summed
   * over the sub-steps of the last step. 0 = the ship was never pinned.
   */
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
    inert: false,
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
  /** Step stamp of the last classification (mode / index are stale when it differs). */
  stamp = -1;
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
  /** Surface sample points that may reach a hard world cell during this tick. */
  terrainCand: Int32Array = new Int32Array(0);
  terrainCandCount = 0;
  /** Terrain pushed back during this tick (a supporting contact carried load). */
  supportedThisTick = false;
  /** A rotor touched the ship this tick. */
  rotorTouchThisTick = false;
  /** Sum of normal impulses of ship/ship contacts this tick (wakes a sleeper that gets pushed). */
  shipImpulseThisTick = 0;
  /** A moving rotor can reach the ship this tick (its sleeping neighbours must not stay asleep). */
  rotorNear = false;
  /**
   * Cells or mounted rotors changed since the previous step (refresh recomputed the mass data):
   * sleeping ships within reach are woken, e.g. a boat resting on a deck that was just mined.
   */
  changed = false;
  /** World box covering this ship before and after its last change (valid when changed). */
  private cMinX = Infinity;
  private cMinY = Infinity;
  private cMinZ = Infinity;
  private cMaxX = -Infinity;
  private cMaxY = -Infinity;
  private cMaxZ = -Infinity;
  /** minX..maxZ hold a real box (computed at least once with hard cells). */
  private hasBox = false;
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
    this.hasBox = true;
    this.minX = minX;
    this.minY = minY;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxY = maxY;
    this.maxZ = maxZ;
  }

  /**
   * After the patch is filled: list the sample points that can come within reach of the patch's
   * hard cells this tick. The hard cells' world box, grown by the farthest a hull point can
   * travel in a tick, is mapped into the hull's frame (as of the start of the tick); only points
   * inside its local bounds are tested in the sub-steps. A ship touching a wall with its bow
   * tests its bow, not its whole surface.
   */
  selectTerrainCandidates(travel: number): void {
    this.terrainCandCount = 0;
    const p = this.patch;
    if (!p.hasSolid) return;
    const s = this.shape;
    const n = s.pointCount;
    if (this.terrainCand.length < n) this.terrainCand = new Int32Array(n);
    const m = travel + 0.5;
    const x0 = p.solidMinX - m;
    const y0 = p.solidMinY - m;
    const z0 = p.solidMinZ - m;
    const x1 = p.solidMaxX + 1 + m;
    const y1 = p.solidMaxY + 1 + m;
    const z1 = p.solidMaxZ + 1 + m;
    const R = this.R;
    let lx0 = Infinity;
    let ly0 = Infinity;
    let lz0 = Infinity;
    let lx1 = -Infinity;
    let ly1 = -Infinity;
    let lz1 = -Infinity;
    for (let k = 0; k < 8; k++) {
      const dx = ((k & 1) === 0 ? x0 : x1) - this.tx;
      const dy = ((k & 2) === 0 ? y0 : y1) - this.ty;
      const dz = ((k & 4) === 0 ? z0 : z1) - this.tz;
      const lx = R[0]! * dx + R[3]! * dy + R[6]! * dz;
      const ly = R[1]! * dx + R[4]! * dy + R[7]! * dz;
      const lz = R[2]! * dx + R[5]! * dy + R[8]! * dz;
      if (lx < lx0) lx0 = lx;
      if (ly < ly0) ly0 = ly;
      if (lz < lz0) lz0 = lz;
      if (lx > lx1) lx1 = lx;
      if (ly > ly1) ly1 = ly;
      if (lz > lz1) lz1 = lz;
    }
    const px = s.px;
    const py = s.py;
    const pz = s.pz;
    const out = this.terrainCand;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const x = px[i]!;
      const y = py[i]!;
      const z = pz[i]!;
      if (x >= lx0 && x <= lx1 && y >= ly0 && y <= ly1 && z >= lz0 && z <= lz1) out[c++] = i;
    }
    this.terrainCandCount = c;
  }

  /** Start the changed-ship box with the box of the previous tick (before loadPose). */
  beginChangedBox(): void {
    if (this.hasBox) {
      this.cMinX = this.minX;
      this.cMinY = this.minY;
      this.cMinZ = this.minZ;
      this.cMaxX = this.maxX;
      this.cMaxY = this.maxY;
      this.cMaxZ = this.maxZ;
    } else {
      this.cMinX = this.cMinY = this.cMinZ = Infinity;
      this.cMaxX = this.cMaxY = this.cMaxZ = -Infinity;
    }
  }

  /** Grow the changed-ship box by the current box (after loadPose). */
  extendChangedBox(): void {
    if (this.minX < this.cMinX) this.cMinX = this.minX;
    if (this.minY < this.cMinY) this.cMinY = this.minY;
    if (this.minZ < this.cMinZ) this.cMinZ = this.minZ;
    if (this.maxX > this.cMaxX) this.cMaxX = this.maxX;
    if (this.maxY > this.cMaxY) this.cMaxY = this.maxY;
    if (this.maxZ > this.cMaxZ) this.cMaxZ = this.maxZ;
  }

  /** Does the changed-ship box come within `margin` of the other body's box? */
  changedBoxNear(o: Body, margin: number): boolean {
    return (
      this.cMinX - margin < o.maxX &&
      this.cMaxX + margin > o.minX &&
      this.cMinY - margin < o.maxY &&
      this.cMaxY + margin > o.minY &&
      this.cMinZ - margin < o.maxZ &&
      this.cMaxZ + margin > o.minZ
    );
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
    integrateOrientation(this.q, this.wx + wpx, this.wy + wpy, this.wz + wpz, dt);
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
    s.inert = false;
    s.terrainContacts = 0;
    s.rotorContacts = 0;
    s.shipContacts = 0;
    s.maxDepth = 0;
    s.pinned = 0;
    s.destroyed = 0;
    s.submerged = 0;
    this.supportedThisTick = false;
    this.rotorTouchThisTick = false;
    this.shipImpulseThisTick = 0;
    this.rotorNear = false;
    this.pinHas = false;
    this.pinDepth = 0;
  }
}

/**
 * q <- exp(w dt / 2) * q, normalised: the exact rotation for a constant world angular velocity
 * over dt (the same as core qintegrate, without its temporary quaternion — this runs on every
 * sub-step of every ship).
 */
function integrateOrientation(q: Quat, wx: number, wy: number, wz: number, dt: number): void {
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  const angle = wl * dt;
  if (angle < 1e-12) return;
  const s = Math.sin(angle * 0.5) / wl;
  const ax = wx * s;
  const ay = wy * s;
  const az = wz * s;
  const aw = Math.cos(angle * 0.5);
  const bx = q.x;
  const by = q.y;
  const bz = q.z;
  const bw = q.w;
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  const l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l > 0) {
    x /= l;
    y /= l;
    z /= l;
    w /= l;
  }
  q.x = x;
  q.y = y;
  q.z = z;
  q.w = w;
}
