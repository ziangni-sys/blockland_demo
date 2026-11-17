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
 */
import { qslerp, qtoMat3, quat, type Quat } from '../../core/math';
import type { Rotor } from '../structure';
import type { Body } from './body';
import { mat3Mul, type Mat3 } from './mat3';
import { GridShape } from './shape';

export class RotorView {
  readonly rotor: Rotor;
  readonly shape = new GridShape();
  /** Bounding radius about the pivot (hub centre), blocks. */
  radius = 0;
  /** Hub centre in world space at the start of the tick. */
  cx = 0;
  cy = 0;
  cz = 0;
  /** The rotor's pose changed during this tick (or it rides on a moving ship). */
  moving = false;
  /** Parent ship body when it is simulated this tick (else the parent is treated as fixed). */
  parentBody: Body | null = null;
  /** Used by some ship this tick (frames are only updated for used rotors). */
  used = false;

  /** Local -> world at alpha_k (R0,t0) and alpha_{k+1} (R1,t1) for the current sub-step. */
  readonly R0: Mat3 = new Float64Array(9);
  readonly R1: Mat3 = new Float64Array(9);
  t0x = 0;
  t0y = 0;
  t0z = 0;
  t1x = 0;
  t1y = 0;
  t1z = 0;

  /** Static parent frame (parent ship not simulated) for the tick. */
  private readonly PR: Mat3 = new Float64Array(9);
  private ptx = 0;
  private pty = 0;
  private ptz = 0;
  private parentIsWorld = true;
  private readonly q: Quat = quat();
  private readonly Rl: Mat3 = new Float64Array(9);

  constructor(rotor: Rotor) {
    this.rotor = rotor;
  }

  /** Per-tick setup: shape cache, radius, world hub position, parent frame. */
  beginTick(parentBody: Body | null): void {
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
    this.parentBody = parentBody;
    this.used = false;
    const par = g.parent;
    this.parentIsWorld = par.isWorld;
    if (par.isWorld) {
      this.cx = g.position.x;
      this.cy = g.position.y;
      this.cz = g.position.z;
    } else {
      // Parent is a ship grid: its current pose (start of the tick for a simulated parent).
      const pg = r.parent !== null ? r.parent.grid : null;
      if (pg !== null) {
        qtoMat3(pg.rotation, this.PR);
        const PR = this.PR;
        const pv = pg.pivot;
        this.ptx = pg.position.x - (PR[0]! * pv.x + PR[1]! * pv.y + PR[2]! * pv.z);
        this.pty = pg.position.y - (PR[3]! * pv.x + PR[4]! * pv.y + PR[5]! * pv.z);
        this.ptz = pg.position.z - (PR[6]! * pv.x + PR[7]! * pv.y + PR[8]! * pv.z);
      } else {
        this.PR.fill(0);
        this.PR[0] = this.PR[4] = this.PR[8] = 1;
        this.ptx = this.pty = this.ptz = 0;
      }
      const p = g.position;
      const PR = this.PR;
      this.cx = PR[0]! * p.x + PR[1]! * p.y + PR[2]! * p.z + this.ptx;
      this.cy = PR[3]! * p.x + PR[4]! * p.y + PR[5]! * p.z + this.pty;
      this.cz = PR[6]! * p.x + PR[7]! * p.y + PR[8]! * p.z + this.ptz;
    }
    const pp = g.prevPosition;
    const pr = g.prevRotation;
    const rr = g.rotation;
    this.moving =
      parentBody !== null ||
      pp.x !== g.position.x ||
      pp.y !== g.position.y ||
      pp.z !== g.position.z ||
      pr.x !== rr.x ||
      pr.y !== rr.y ||
      pr.z !== rr.z ||
      pr.w !== rr.w;
  }

  /** Frames for the sub-step [a0, a1] of the tick. Call after the parent body's frame update. */
  updateFrames(a0: number, a1: number): void {
    this.frameAt(a0, this.R0, 0);
    this.frameAt(a1, this.R1, 1);
  }

  private frameAt(alpha: number, out: Mat3, which: 0 | 1): void {
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
      const pb = this.parentBody;
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
    } else {
      this.t1x = tx;
      this.t1y = ty;
      this.t1z = tz;
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
}
