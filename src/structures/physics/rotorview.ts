/**
 * A rotor seen by the ship dynamics: an infinitely heavy moving obstacle.
 *
 * LESSONS 卡顿的一帧叶片跳进船体: the rotor's pose is interpolated INSIDE the tick, per sub-step.
 * The manager advances every rotor before the dynamics step, so (prevPosition, prevRotation)
 * -> (position, rotation) brackets the tick. Sub-step k of n uses the pose at alpha = k/n,
 * and the rotor's surface velocity is the finite difference of the poses at k/n and (k+1)/n:
 * exactly the motion the next sub-step will show, so velocity and geometry never disagree.
 *
 * A rotor mounted on another ship moves with that ship: its own interpolated spin is composed
 * with the parent ship's CURRENT sub-step frame (the ships are integrated in lock-step), and the
 * parent's rigid-body velocity is added to the finite-difference spin velocity.
 *
 * Per tick the view also provides a conservative world box of everything the rotor's hard
 * cells sweep through during the tick (the "swept box"): the union of the boxes at the start
 * and end poses, grown by the arc's sagitta. Reach tests (which ships a rotor can touch, which
 * sleeping ships it must wake) use it instead of the rotor's bounding sphere, which for a
 * windmill is far larger than the thin disc it actually sweeps.
 */
import { qslerp, qtoMat3, quat, type Quat } from '../../core/math';
import type { Rotor } from '../structure';
import type { Body } from './body';
import { mat3Mul, type Mat3 } from './mat3';
import { GridShape } from './shape';

export class RotorView {
  readonly rotor: Rotor;
  readonly shape = new GridShape();
  /** Bounding radius of the hard cells about the pivot (hub centre), blocks. */
  radius = 0;
  /** The rotor's own pose (relative to its parent) changed during this tick. */
  spinning = false;
  /** Farthest any of its hard cells moves relative to its parent during this tick, blocks. */
  travel = 0;
  /** The rotor moves this tick: it spins, or it rides on a ship simulated this tick. */
  moving = false;
  /** Parent ship body when it is simulated this tick (else the parent is treated as fixed). */
  parentBody: Body | null = null;
  /** Used by some ship this tick (frames are only updated for used rotors). */
  used = false;
  /**
   * World box swept by the hard cells during the tick, with the parent ship at its start-of-tick
   * pose (callers add the parent's own travel when the parent is simulated).
   */
  sbMinX = 0;
  sbMinY = 0;
  sbMinZ = 0;
  sbMaxX = 0;
  sbMaxY = 0;
  sbMaxZ = 0;

  /** Local -> world at alpha_k (R0,t0) and alpha_{k+1} (R1,t1) for the current sub-step. */
  readonly R0: Mat3 = new Float64Array(9);
  readonly R1: Mat3 = new Float64Array(9);
  t0x = 0;
  t0y = 0;
  t0z = 0;
  t1x = 0;
  t1y = 0;
  t1z = 0;

  /** Parent frame at the start of the tick (identity for the world). */
  private readonly PR: Mat3 = new Float64Array(9);
  private ptx = 0;
  private pty = 0;
  private ptz = 0;
  private parentIsWorld = true;
  private readonly q: Quat = quat();
  private readonly Rl: Mat3 = new Float64Array(9);
  private readonly Rtmp: Mat3 = new Float64Array(9);

  constructor(rotor: Rotor) {
    this.rotor = rotor;
  }

  /**
   * Per-tick setup that does not depend on which ships are simulated: shape cache, radius,
   * start-of-tick parent frame, spin and travel, swept box. Clears the parent body; call
   * attachParent() once the ships are classified.
   */
  beginTick(): void {
    const r = this.rotor;
    const g = r.grid;
    if (this.shape.version !== g.version) this.shape.build(g, null, false);
    const s = this.shape;
    let r2 = 0;
    if (s.solidCount > 0) {
      for (let k = 0; k < 8; k++) {
        const dx = ((k & 1) === 0 ? s.minX : s.maxX) - g.pivot.x;
        const dy = ((k & 2) === 0 ? s.minY : s.maxY) - g.pivot.y;
        const dz = ((k & 4) === 0 ? s.minZ : s.maxZ) - g.pivot.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) r2 = d2;
      }
    }
    this.radius = Math.sqrt(r2);
    this.parentBody = null;
    this.used = false;
    const par = g.parent;
    this.parentIsWorld = par.isWorld;
    const PR = this.PR;
    PR.fill(0);
    PR[0] = PR[4] = PR[8] = 1;
    this.ptx = this.pty = this.ptz = 0;
    if (!par.isWorld && r.parent !== null) {
      const pg = r.parent.grid;
      qtoMat3(pg.rotation, PR);
      const pv = pg.pivot;
      this.ptx = pg.position.x - (PR[0]! * pv.x + PR[1]! * pv.y + PR[2]! * pv.z);
      this.pty = pg.position.y - (PR[3]! * pv.x + PR[4]! * pv.y + PR[5]! * pv.z);
      this.ptz = pg.position.z - (PR[6]! * pv.x + PR[7]! * pv.y + PR[8]! * pv.z);
    }

    const pp = g.prevPosition;
    const pq = g.prevRotation;
    const rq = g.rotation;
    this.spinning =
      pp.x !== g.position.x ||
      pp.y !== g.position.y ||
      pp.z !== g.position.z ||
      pq.x !== rq.x ||
      pq.y !== rq.y ||
      pq.z !== rq.z ||
      pq.w !== rq.w;
    this.moving = this.spinning;
    // Spin angle over the tick (relative to the parent) and the farthest a hard cell travels.
    let dot = Math.abs(pq.x * rq.x + pq.y * rq.y + pq.z * rq.z + pq.w * rq.w);
    if (dot > 1) dot = 1;
    const spin = 2 * Math.acos(dot);
    const mx = g.position.x - pp.x;
    const my = g.position.y - pp.y;
    const mz = g.position.z - pp.z;
    this.travel = spin * this.radius + Math.sqrt(mx * mx + my * my + mz * mz);

    // Swept box: start and end boxes, grown by the sagitta of the arc (a point on an arc of
    // angle `spin` strays at most radius * (1 - cos(spin / 2)) from its chord).
    if (s.solidCount === 0) {
      this.sbMinX = this.sbMaxX = this.ptx;
      this.sbMinY = this.sbMaxY = this.pty;
      this.sbMinZ = this.sbMaxZ = this.ptz;
      return;
    }
    this.sbMinX = this.sbMinY = this.sbMinZ = Infinity;
    this.sbMaxX = this.sbMaxY = this.sbMaxZ = -Infinity;
    this.extendSwept(0);
    this.extendSwept(1);
    const grow = this.radius * (1 - Math.cos(spin * 0.5)) + 1e-6;
    this.sbMinX -= grow;
    this.sbMinY -= grow;
    this.sbMinZ -= grow;
    this.sbMaxX += grow;
    this.sbMaxY += grow;
    this.sbMaxZ += grow;
  }

  /** The parent ship's body when it is simulated this tick (null: the parent is fixed). */
  attachParent(parentBody: Body | null): void {
    this.parentBody = parentBody;
    this.moving = this.spinning || parentBody !== null;
  }

  /** Grow the swept box by the hard cells' box at `alpha` (start-of-tick parent frame). */
  private extendSwept(alpha: number): void {
    const s = this.shape;
    const R = this.Rtmp;
    this.frameAt(alpha, R, 2, false);
    // world AABB of the local box: centre R c + t, half extents |R| h
    const cx = (s.minX + s.maxX) * 0.5;
    const cy = (s.minY + s.maxY) * 0.5;
    const cz = (s.minZ + s.maxZ) * 0.5;
    const hx = (s.maxX - s.minX) * 0.5;
    const hy = (s.maxY - s.minY) * 0.5;
    const hz = (s.maxZ - s.minZ) * 0.5;
    const wx = R[0]! * cx + R[1]! * cy + R[2]! * cz + this.sx;
    const wy = R[3]! * cx + R[4]! * cy + R[5]! * cz + this.sy;
    const wz = R[6]! * cx + R[7]! * cy + R[8]! * cz + this.sz;
    const ex = Math.abs(R[0]!) * hx + Math.abs(R[1]!) * hy + Math.abs(R[2]!) * hz;
    const ey = Math.abs(R[3]!) * hx + Math.abs(R[4]!) * hy + Math.abs(R[5]!) * hz;
    const ez = Math.abs(R[6]!) * hx + Math.abs(R[7]!) * hy + Math.abs(R[8]!) * hz;
    if (wx - ex < this.sbMinX) this.sbMinX = wx - ex;
    if (wy - ey < this.sbMinY) this.sbMinY = wy - ey;
    if (wz - ez < this.sbMinZ) this.sbMinZ = wz - ez;
    if (wx + ex > this.sbMaxX) this.sbMaxX = wx + ex;
    if (wy + ey > this.sbMaxY) this.sbMaxY = wy + ey;
    if (wz + ez > this.sbMaxZ) this.sbMaxZ = wz + ez;
  }

  /** Frames for the sub-step [a0, a1] of the tick. Call after the parent body's frame update. */
  updateFrames(a0: number, a1: number): void {
    this.frameAt(a0, this.R0, 0, true);
    this.frameAt(a1, this.R1, 1, true);
  }

  /** Scratch translation written by frameAt(..., which = 2, ...). */
  private sx = 0;
  private sy = 0;
  private sz = 0;

  /**
   * Local -> world frame at `alpha` of the tick. `useBody`: compose with the simulated parent's
   * current sub-step frame (else the start-of-tick parent frame). The translation goes to
   * t0 (which 0), t1 (which 1) or the scratch (which 2).
   */
  private frameAt(alpha: number, out: Mat3, which: 0 | 1 | 2, useBody: boolean): void {
    const g = this.rotor.grid;
    const Rl = this.Rl;
    qslerp(g.prevRotation, g.rotation, alpha, this.q);
    qtoMat3(this.q, Rl);
    const pv = g.pivot;
    // local -> parent: R_l * (p - pivot) + pos(alpha)
    const posx = g.prevPosition.x + (g.position.x - g.prevPosition.x) * alpha;
    const posy = g.prevPosition.y + (g.position.y - g.prevPosition.y) * alpha;
    const posz = g.prevPosition.z + (g.position.z - g.prevPosition.z) * alpha;
    const lx = posx - (Rl[0]! * pv.x + Rl[1]! * pv.y + Rl[2]! * pv.z);
    const ly = posy - (Rl[3]! * pv.x + Rl[4]! * pv.y + Rl[5]! * pv.z);
    const lz = posz - (Rl[6]! * pv.x + Rl[7]! * pv.y + Rl[8]! * pv.z);
    let tx: number;
    let ty: number;
    let tz: number;
    if (this.parentIsWorld) {
      out.set(Rl);
      tx = lx;
      ty = ly;
      tz = lz;
    } else {
      const pb = useBody ? this.parentBody : null;
      const PR = pb !== null ? pb.R : this.PR;
      const ptx = pb !== null ? pb.tx : this.ptx;
      const pty = pb !== null ? pb.ty : this.pty;
      const ptz = pb !== null ? pb.tz : this.ptz;
      mat3Mul(PR, Rl, out);
      tx = PR[0]! * lx + PR[1]! * ly + PR[2]! * lz + ptx;
      ty = PR[3]! * lx + PR[4]! * ly + PR[5]! * lz + pty;
      tz = PR[6]! * lx + PR[7]! * ly + PR[8]! * lz + ptz;
    }
    if (which === 0) {
      this.t0x = tx;
      this.t0y = ty;
      this.t0z = tz;
    } else if (which === 1) {
      this.t1x = tx;
      this.t1y = ty;
      this.t1z = tz;
    } else {
      this.sx = tx;
      this.sy = ty;
      this.sz = tz;
    }
  }

  /**
   * World velocity of the rotor's material at rotor-local point (lx,ly,lz) whose world position
   * (at alpha_k) is (wx,wy,wz), over a sub-step of length dt. Written to out[0..2].
   */
  velocityAt(lx: number, ly: number, lz: number, wx: number, wy: number, wz: number, invDt: number, out: Float64Array): void {
    const R1 = this.R1;
    let vx = (R1[0]! * lx + R1[1]! * ly + R1[2]! * lz + this.t1x - wx) * invDt;
    let vy = (R1[3]! * lx + R1[4]! * ly + R1[5]! * lz + this.t1y - wy) * invDt;
    let vz = (R1[6]! * lx + R1[7]! * ly + R1[8]! * lz + this.t1z - wz) * invDt;
    const pb = this.parentBody;
    if (pb !== null) {
      const rx = wx - pb.px;
      const ry = wy - pb.py;
      const rz = wz - pb.pz;
      vx += pb.vx + pb.wy * rz - pb.wz * ry;
      vy += pb.vy + pb.wz * rx - pb.wx * rz;
      vz += pb.vz + pb.wx * ry - pb.wy * rx;
    }
    out[0] = vx;
    out[1] = vy;
    out[2] = vz;
  }

  /**
   * Can the hard cells swept this tick come within `margin` of the world box? (`margin` should
   * include the parent's travel when the parent is simulated.)
   */
  sweptNear(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, margin: number): boolean {
    return (
      this.sbMinX - margin <= maxX &&
      this.sbMaxX + margin >= minX &&
      this.sbMinY - margin <= maxY &&
      this.sbMaxY + margin >= minY &&
      this.sbMinZ - margin <= maxZ &&
      this.sbMaxZ + margin >= minZ
    );
  }
}
