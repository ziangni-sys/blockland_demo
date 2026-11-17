/**
 * Contact generation between a ship hull and terrain, rotors and other ships.
 *
 * Contacts are point constraints: a point P (world), a unit normal n (the direction body A must
 * move to separate), a penetration depth, the obstacle's velocity at P (rotors) and the hull
 * cell involved (for pinning). They are generated in BOTH directions so that neither a thin
 * wall nor a single protruding block is missed:
 *   - surface sample points of A inside hard cells of the obstacle;
 *   - sample points / edge corners of the obstacle inside hard cells of A.
 *
 * Normals come from EXPOSED faces only (the neighbour across the face is not hard), never
 * from geometry inside a wall. Among the exposed faces of the penetrated cell we only accept
 * those that oppose the intruding point's own surface normals: a hull point on the bow face
 * that entered a wall can only be pushed back out of the wall's near face, however deep it
 * went — never out through the far side of a 1-thick wall (LESSONS 船被推穿薄墙). Among the
 * accepted faces the shallowest wins; for rotor contacts the choice may be biased toward the
 * blade's sweep direction, but the depth stored is always the true distance to the chosen
 * face (LESSONS 叶片侧面擦过船时船被猛踢).
 */
import { DIR_X, DIR_Y, DIR_Z } from '../../core/dirs';
import type { Body } from './body';
import { mat3MulTransA, type Mat3 } from './mat3';
import { PF_SOLID } from './patch';
import type { RotorView } from './rotorview';
import { OCC_SOLID, type GridShape, type ProbeTarget } from './shape';

export const KIND_TERRAIN = 0;
export const KIND_ROTOR = 1;
export const KIND_SHIP = 2;

// ---- contact record layout (one Float64Array, STRIDE doubles per contact)
export const F_A = 0; // body index
export const F_B = 1; // body index or -1
export const F_KIND = 2;
export const F_SRC = 3; // rotor view index (rotor contacts)
export const F_PIN = 4; // 1 = pinned: transfers nothing
export const F_PX = 5;
export const F_NX = 8;
export const F_DEPTH = 11;
export const F_VO = 12; // obstacle velocity at P
export const F_RA = 15;
export const F_RB = 18;
export const F_T1 = 21;
export const F_T2 = 24;
export const F_JAN = 27; // ra x n
export const F_KAN = 30; // invIa (ra x n)
export const F_JAT1 = 33;
export const F_KAT1 = 36;
export const F_JAT2 = 39;
export const F_KAT2 = 42;
export const F_JBN = 45;
export const F_KBN = 48;
export const F_JBT1 = 51;
export const F_KBT1 = 54;
export const F_JBT2 = 57;
export const F_KBT2 = 60;
export const F_MN = 63;
export const F_MT1 = 64;
export const F_MT2 = 65;
export const F_LN = 66;
export const F_LT1 = 67;
export const F_LT2 = 68;
export const F_LP = 69;
export const F_BIAS = 70;
export const F_MU = 71;
export const F_CELL = 72; // hull cell (A-local) known exactly
export const F_HASCELL = 75; // 1 = F_CELL valid, 2 = owner must be resolved from F_LOC / F_OBS
export const F_LOC = 76; // hull-local sample point (owner resolution)
export const F_OBS = 79; // obstacle cell centre in hull-local coordinates
export const STRIDE = 82;

export class ContactSet {
  count = 0;
  f: Float64Array = new Float64Array(128 * STRIDE);

  clear(): void {
    this.count = 0;
  }

  /** Append a zeroed record and return its base offset. */
  push(): number {
    const n = this.count;
    if ((n + 1) * STRIDE > this.f.length) {
      const g = new Float64Array(this.f.length * 2);
      g.set(this.f);
      this.f = g;
    }
    const base = n * STRIDE;
    this.f.fill(0, base, base + STRIDE);
    this.count = n + 1;
    return base;
  }

  /** Copy record `from` over record `to` (indices). */
  move(from: number, to: number): void {
    if (from !== to) this.f.copyWithin(to * STRIDE, from * STRIDE, from * STRIDE + STRIDE);
  }
}

/** Accept a face only if it is within ~60 degrees of opposing one of the intruder's normals. */
export const ALIGN_MIN = 0.5;
/** Fallback: cells walked through hard material along the best-aligned axis. */
const WALK_MAX = 2;
/** Depth credit (blocks) for an exit face that points along a blade's relative sweep. */
const SWEEP_BIAS = 0.35;

/**
 * Picks the exit face of a penetrated cell. Works in the TARGET's local frame (the grid whose
 * hard cell the point is in). setFrame() takes the rotation from the intruder's frame (where
 * its normal mask is expressed) to the target's frame.
 */
export class Prober {
  dir = 0;
  depth = 0;
  cellX = 0;
  cellY = 0;
  cellZ = 0;
  /** align[g*6 + d] = (target face normal g) . (-intruder normal d). */
  private readonly align = new Float64Array(36);

  setFrame(C: Mat3): void {
    const a = this.align;
    for (let g = 0; g < 6; g++) {
      const ag = g >> 1;
      const sg = (g & 1) === 0 ? 1 : -1;
      for (let d = 0; d < 6; d++) {
        const ad = d >> 1;
        const sd = (d & 1) === 0 ? 1 : -1;
        a[g * 6 + d] = -sd * sg * C[ag * 3 + ad]!;
      }
    }
  }

  private alignment(g: number, mask: number): number {
    if (mask === 0) return 1;
    const a = this.align;
    let best = -2;
    for (let d = 0; d < 6; d++) {
      if ((mask & (1 << d)) === 0) continue;
      const v = a[g * 6 + d]!;
      if (v > best) best = v;
    }
    return best;
  }

  /**
   * Point (x,y,z) in target-local coordinates, intruder normal mask `mask`. (sx,sy,sz) is an
   * optional preferred direction for the exit normal (target-local; zero = none). Returns false
   * when the point is not in a hard cell or no exit could be found.
   */
  probe(t: ProbeTarget, x: number, y: number, z: number, mask: number, sx: number, sy: number, sz: number): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cz = Math.floor(z);
    if (!t.isSolid(cx, cy, cz)) return false;
    const sweep = sx !== 0 || sy !== 0 || sz !== 0;
    let best = -1;
    let bestScore = Infinity;
    let bestDepth = 0;
    let fallback = 0;
    let fallbackAlign = -Infinity;
    for (let g = 0; g < 6; g++) {
      const al = this.alignment(g, mask);
      if (al > fallbackAlign) {
        fallbackAlign = al;
        fallback = g;
      }
      if (al < ALIGN_MIN) continue;
      if (!t.isOpen(cx + DIR_X[g]!, cy + DIR_Y[g]!, cz + DIR_Z[g]!)) continue;
      const depth = faceDepth(g, x, y, z, cx, cy, cz);
      let score = depth;
      if (sweep) {
        const s = g === 0 ? sx : g === 1 ? -sx : g === 2 ? sy : g === 3 ? -sy : g === 4 ? sz : -sz;
        if (s > 0) score -= SWEEP_BIAS * s;
      }
      if (score < bestScore) {
        bestScore = score;
        best = g;
        bestDepth = depth;
      }
    }
    this.cellX = cx;
    this.cellY = cy;
    this.cellZ = cz;
    if (best >= 0) {
      this.dir = best;
      this.depth = bestDepth;
      return true;
    }
    // No acceptable exposed face on this cell: the point is deeper than one cell (or the
    // surface opposite its normal is buried). Walk back the way the intruder came.
    const g = fallback;
    for (let k = 1; k <= WALK_MAX; k++) {
      const nx = cx + DIR_X[g]! * k;
      const ny = cy + DIR_Y[g]! * k;
      const nz = cz + DIR_Z[g]! * k;
      if (t.isOpen(nx, ny, nz)) {
        this.dir = g;
        this.depth = faceDepth(g, x, y, z, cx, cy, cz) + (k - 1);
        return true;
      }
      if (!t.isSolid(nx, ny, nz)) break; // sealed cavity: no way out along this axis
    }
    return false;
  }
}

function faceDepth(g: number, x: number, y: number, z: number, cx: number, cy: number, cz: number): number {
  switch (g) {
    case 0:
      return cx + 1 - x;
    case 1:
      return x - cx;
    case 2:
      return cy + 1 - y;
    case 3:
      return y - cy;
    case 4:
      return cz + 1 - z;
    default:
      return z - cz;
  }
}

/** Column `axis` of R, signed by the direction (world image of local Dir g), written to out. */
function dirToWorld(R: Mat3, g: number, out: Float64Array, o: number): void {
  const a = g >> 1;
  const s = (g & 1) === 0 ? 1 : -1;
  out[o] = R[a]! * s;
  out[o + 1] = R[3 + a]! * s;
  out[o + 2] = R[6 + a]! * s;
}

/**
 * Builds the contacts of one sub-step. Holds only scratch state; all inputs come per call.
 */
export class ContactGenerator {
  readonly prober = new Prober();
  private readonly C: Mat3 = new Float64Array(9);
  private readonly RT: Mat3 = new Float64Array(9);
  private readonly vel = new Float64Array(3);
  private readonly idx: Int32Array[] = [];
  private keep = new Uint8Array(256);
  private order = new Int32Array(256);
  private keys = new Float64Array(256);

  constructor() {
    for (let i = 0; i < 6; i++) this.idx.push(new Int32Array(64));
  }

  // ------------------------------------------------------------------ terrain

  /** Contacts of `b` against the world terrain (through its patch). */
  terrain(b: Body, set: ContactSet, mu: number): void {
    const patch = b.patch;
    if (!patch.hasSolid) return;
    const s = b.shape;
    const R = b.R;
    const pr = this.prober;
    const f = set;
    const r0 = R[0]!;
    const r1 = R[1]!;
    const r2 = R[2]!;
    const r3 = R[3]!;
    const r4 = R[4]!;
    const r5 = R[5]!;
    const r6 = R[6]!;
    const r7 = R[7]!;
    const r8 = R[8]!;
    const tx = b.tx;
    const ty = b.ty;
    const tz = b.tz;
    const flags = patch.flags;
    const pox = patch.ox;
    const poy = patch.oy;
    const poz = patch.oz;
    const psx = patch.sx;
    const psy = patch.sy;
    const psz = patch.sz;

    // (1) hull points inside terrain: the intruder normals are hull-local, the target is the world.
    pr.setFrame(R);
    const n = s.pointCount;
    const px = s.px;
    const py = s.py;
    const pz = s.pz;
    const pm = s.pmask;
    for (let i = 0; i < n; i++) {
      const lx = px[i]!;
      const ly = py[i]!;
      const lz = pz[i]!;
      const wx = r0 * lx + r1 * ly + r2 * lz + tx;
      const wy = r3 * lx + r4 * ly + r5 * lz + ty;
      const wz = r6 * lx + r7 * ly + r8 * lz + tz;
      const ix = Math.floor(wx) - pox;
      const iy = Math.floor(wy) - poy;
      const iz = Math.floor(wz) - poz;
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < psx && iy < psy && iz < psz) {
        if ((flags[(iz * psx + ix) * psy + iy]! & PF_SOLID) === 0) continue;
      } else if (!patch.isSolid(ix + pox, iy + poy, iz + poz)) {
        continue;
      }
      if (!pr.probe(patch, wx, wy, wz, pm[i]!, 0, 0, 0)) continue;
      const base = f.push();
      const a = f.f;
      a[base + F_A] = b.index;
      a[base + F_B] = -1;
      a[base + F_KIND] = KIND_TERRAIN;
      a[base + F_PX] = wx;
      a[base + F_PX + 1] = wy;
      a[base + F_PX + 2] = wz;
      const g = pr.dir;
      a[base + F_NX + (g >> 1)] = (g & 1) === 0 ? 1 : -1;
      a[base + F_DEPTH] = pr.depth;
      a[base + F_MU] = mu;
    }

    // (2) terrain edge corners inside the hull: normals are world axes, the target is the hull.
    const nc = patch.cornerCount;
    if (nc > 0) {
      const RT = this.RT;
      RT[0] = r0;
      RT[1] = r3;
      RT[2] = r6;
      RT[3] = r1;
      RT[4] = r4;
      RT[5] = r7;
      RT[6] = r2;
      RT[7] = r5;
      RT[8] = r8;
      pr.setFrame(RT);
      const cxs = patch.cornerX;
      const cys = patch.cornerY;
      const czs = patch.cornerZ;
      const cms = patch.cornerMask;
      const occ = s.occ;
      const sox = s.ox;
      const soy = s.oy;
      const soz = s.oz;
      const ssx = s.sx;
      const ssy = s.sy;
      const ssz = s.sz;
      for (let j = 0; j < nc; j++) {
        const X = cxs[j]!;
        const Y = cys[j]!;
        const Z = czs[j]!;
        const dx = X - tx;
        const dy = Y - ty;
        const dz = Z - tz;
        const qx = r0 * dx + r3 * dy + r6 * dz;
        const qy = r1 * dx + r4 * dy + r7 * dz;
        const qz = r2 * dx + r5 * dy + r8 * dz;
        const hx = Math.floor(qx) - sox;
        const hy = Math.floor(qy) - soy;
        const hz = Math.floor(qz) - soz;
        if (hx < 0 || hy < 0 || hz < 0 || hx >= ssx || hy >= ssy || hz >= ssz) continue;
        if (occ[hx + hz * ssx + hy * ssx * ssz] !== OCC_SOLID) continue;
        if (!pr.probe(s, qx, qy, qz, cms[j]!, 0, 0, 0)) continue;
        const base = f.push();
        const a = f.f;
        a[base + F_A] = b.index;
        a[base + F_B] = -1;
        a[base + F_KIND] = KIND_TERRAIN;
        a[base + F_PX] = X;
        a[base + F_PX + 1] = Y;
        a[base + F_PX + 2] = Z;
        // The hull moves so that its face passes the corner: push = -R e_g.
        dirToWorld(R, pr.dir, a, base + F_NX);
        a[base + F_NX] = -a[base + F_NX]!;
        a[base + F_NX + 1] = -a[base + F_NX + 1]!;
        a[base + F_NX + 2] = -a[base + F_NX + 2]!;
        a[base + F_DEPTH] = pr.depth;
        a[base + F_MU] = mu;
      }
    }
  }

  /**
   * Manifold reduction of body `b`'s terrain contacts in [start, set.count): per dominant normal
   * direction keep the extreme points along the two tangent axes (they carry the support
   * polygon) and then the deepest ones, up to `cap`. Keeps the solver cost bounded when a big
   * hull lies on flat ground, without dropping the penetrations that matter. Returns the new count.
   */
  reduce(set: ContactSet, start: number, cap: number): number {
    const total = set.count - start;
    if (total <= cap) return set.count;
    const a = set.f;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) if (this.idx[i]!.length < total) this.idx[i] = new Int32Array(total * 2);
    for (let i = start; i < set.count; i++) {
      const base = i * STRIDE;
      const nx = a[base + F_NX]!;
      const ny = a[base + F_NX + 1]!;
      const nz = a[base + F_NX + 2]!;
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const az = Math.abs(nz);
      const bucket = ax >= ay && ax >= az ? (nx >= 0 ? 0 : 1) : ay >= az ? (ny >= 0 ? 2 : 3) : nz >= 0 ? 4 : 5;
      this.idx[bucket]![counts[bucket]!++] = i;
    }
    if (this.keep.length < total) {
      this.keep = new Uint8Array(total * 2);
      this.order = new Int32Array(total * 2);
      this.keys = new Float64Array(total * 2);
    }
    const keep = this.keep;
    keep.fill(1, 0, total);
    for (let bk = 0; bk < 6; bk++) {
      const cnt = counts[bk]!;
      if (cnt <= cap) continue;
      const list = this.idx[bk]!;
      const axis = bk >> 1;
      const u = F_PX + ((axis + 1) % 3);
      const v = F_PX + ((axis + 2) % 3);
      for (let k = 0; k < cnt; k++) keep[list[k]! - start] = 0;
      // extremes along u and v (ties: first in generation order -> deterministic)
      let iu0 = list[0]!;
      let iu1 = iu0;
      let iv0 = iu0;
      let iv1 = iu0;
      for (let k = 1; k < cnt; k++) {
        const i = list[k]!;
        if (a[i * STRIDE + u]! < a[iu0 * STRIDE + u]!) iu0 = i;
        if (a[i * STRIDE + u]! > a[iu1 * STRIDE + u]!) iu1 = i;
        if (a[i * STRIDE + v]! < a[iv0 * STRIDE + v]!) iv0 = i;
        if (a[i * STRIDE + v]! > a[iv1 * STRIDE + v]!) iv1 = i;
      }
      let kept = 0;
      const mark = (i: number): void => {
        if (keep[i - start] === 0) {
          keep[i - start] = 1;
          kept++;
        }
      };
      mark(iu0);
      mark(iu1);
      mark(iv0);
      mark(iv1);
      // then the deepest of the rest: stable sort of the remaining by depth (descending)
      const order = this.order;
      const keys = this.keys;
      let m = 0;
      for (let k = 0; k < cnt; k++) {
        const i = list[k]!;
        if (keep[i - start] === 1) continue;
        order[m] = i;
        keys[m] = a[i * STRIDE + F_DEPTH]!;
        m++;
      }
      // partial selection: pick the (cap - kept) largest, ties by generation order
      const want = Math.min(cap - kept, m);
      for (let p = 0; p < want; p++) {
        let bi = p;
        for (let q = p + 1; q < m; q++) {
          if (keys[q]! > keys[bi]! || (keys[q] === keys[bi] && order[q]! < order[bi]!)) bi = q;
        }
        if (bi !== p) {
          const to = order[p]!;
          order[p] = order[bi]!;
          order[bi] = to;
          const tk = keys[p]!;
          keys[p] = keys[bi]!;
          keys[bi] = tk;
        }
        keep[order[p]! - start] = 1;
      }
    }
    let w = start;
    for (let i = start; i < set.count; i++) {
      if (keep[i - start] === 1) {
        set.move(i, w);
        w++;
      }
    }
    set.count = w;
    return w;
  }

  // ------------------------------------------------------------------ rotors

  /**
   * Contacts of ship `b` against rotor view `rv` (index `ri`) for the current sub-step.
   * The rotor is kinematic: its velocity at each contact is stored, impulses act on `b` only.
   */
  rotor(b: Body, rv: RotorView, ri: number, set: ContactSet, mu: number, invDt: number): void {
    const rs = rv.shape;
    const s = b.shape;
    if (rs.solidCount === 0 || s.solidCount === 0) return;
    const R = b.R;
    const R0 = rv.R0;
    // quick reject on bounding spheres at this sub-step
    const pv = rv.rotor.grid.pivot;
    const hx = R0[0]! * pv.x + R0[1]! * pv.y + R0[2]! * pv.z + rv.t0x;
    const hy = R0[3]! * pv.x + R0[4]! * pv.y + R0[5]! * pv.z + rv.t0y;
    const hz = R0[6]! * pv.x + R0[7]! * pv.y + R0[8]! * pv.z + rv.t0z;
    const dhx = hx - b.px;
    const dhy = hy - b.py;
    const dhz = hz - b.pz;
    const reach = rv.radius + b.rMax + 0.5;
    if (dhx * dhx + dhy * dhy + dhz * dhz > reach * reach) return;

    const pr = this.prober;
    const C = this.C;
    const vel = this.vel;
    const tsx = b.tx;
    const tsy = b.ty;
    const tsz = b.tz;
    const t0x = rv.t0x;
    const t0y = rv.t0y;
    const t0z = rv.t0z;

    // (1) hull points inside rotor cells. hull-local -> rotor-local: C = R0^T R, c = R0^T (ts - t0)
    mat3MulTransA(R0, R, C);
    pr.setFrame(C);
    const ddx = tsx - t0x;
    const ddy = tsy - t0y;
    const ddz = tsz - t0z;
    const cx = R0[0]! * ddx + R0[3]! * ddy + R0[6]! * ddz;
    const cy = R0[1]! * ddx + R0[4]! * ddy + R0[7]! * ddz;
    const cz = R0[2]! * ddx + R0[5]! * ddy + R0[8]! * ddz;
    const rocc = rs.occ;
    const rox = rs.ox;
    const roy = rs.oy;
    const roz = rs.oz;
    const rsx = rs.sx;
    const rsy = rs.sy;
    const rsz = rs.sz;
    const n = s.pointCount;
    for (let i = 0; i < n; i++) {
      const plx = s.px[i]!;
      const ply = s.py[i]!;
      const plz = s.pz[i]!;
      const lx = C[0]! * plx + C[1]! * ply + C[2]! * plz + cx;
      const ly = C[3]! * plx + C[4]! * ply + C[5]! * plz + cy;
      const lz = C[6]! * plx + C[7]! * ply + C[8]! * plz + cz;
      const ix = Math.floor(lx) - rox;
      const iy = Math.floor(ly) - roy;
      const iz = Math.floor(lz) - roz;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= rsx || iy >= rsy || iz >= rsz) continue;
      if (rocc[ix + iz * rsx + iy * rsx * rsz] !== OCC_SOLID) continue;
      const wx = R[0]! * plx + R[1]! * ply + R[2]! * plz + tsx;
      const wy = R[3]! * plx + R[4]! * ply + R[5]! * plz + tsy;
      const wz = R[6]! * plx + R[7]! * ply + R[8]! * plz + tsz;
      rv.velocityAt(lx, ly, lz, wx, wy, wz, invDt, vel);
      // sweep preference in rotor-local frame: exit normal along the blade's relative motion
      const rx = wx - b.px;
      const ry = wy - b.py;
      const rz = wz - b.pz;
      const relx = vel[0]! - (b.vx + b.wy * rz - b.wz * ry);
      const rely = vel[1]! - (b.vy + b.wz * rx - b.wx * rz);
      const relz = vel[2]! - (b.vz + b.wx * ry - b.wy * rx);
      const rl = Math.sqrt(relx * relx + rely * rely + relz * relz);
      let sx = 0;
      let sy = 0;
      let sz = 0;
      if (rl > 1e-6) {
        sx = (R0[0]! * relx + R0[3]! * rely + R0[6]! * relz) / rl;
        sy = (R0[1]! * relx + R0[4]! * rely + R0[7]! * relz) / rl;
        sz = (R0[2]! * relx + R0[5]! * rely + R0[8]! * relz) / rl;
      }
      if (!pr.probe(rs, lx, ly, lz, s.pmask[i]!, sx, sy, sz)) continue;
      const base = set.push();
      const a = set.f;
      a[base + F_A] = b.index;
      a[base + F_B] = -1;
      a[base + F_KIND] = KIND_ROTOR;
      a[base + F_SRC] = ri;
      a[base + F_PX] = wx;
      a[base + F_PX + 1] = wy;
      a[base + F_PX + 2] = wz;
      dirToWorld(R0, pr.dir, a, base + F_NX); // ship pushed out through the rotor's face
      a[base + F_DEPTH] = pr.depth;
      a[base + F_VO] = vel[0]!;
      a[base + F_VO + 1] = vel[1]!;
      a[base + F_VO + 2] = vel[2]!;
      a[base + F_MU] = mu;
      a[base + F_HASCELL] = 2;
      a[base + F_LOC] = plx;
      a[base + F_LOC + 1] = ply;
      a[base + F_LOC + 2] = plz;
      // rotor cell centre -> world -> hull-local
      const ocx = pr.cellX + 0.5;
      const ocy = pr.cellY + 0.5;
      const ocz = pr.cellZ + 0.5;
      const owx = R0[0]! * ocx + R0[1]! * ocy + R0[2]! * ocz + t0x - tsx;
      const owy = R0[3]! * ocx + R0[4]! * ocy + R0[5]! * ocz + t0y - tsy;
      const owz = R0[6]! * ocx + R0[7]! * ocy + R0[8]! * ocz + t0z - tsz;
      a[base + F_OBS] = R[0]! * owx + R[3]! * owy + R[6]! * owz;
      a[base + F_OBS + 1] = R[1]! * owx + R[4]! * owy + R[7]! * owz;
      a[base + F_OBS + 2] = R[2]! * owx + R[5]! * owy + R[8]! * owz;
    }

    // (2) rotor points inside hull cells. rotor-local -> hull-local: C = R^T R0, c = R^T (t0 - ts)
    mat3MulTransA(R, R0, C);
    pr.setFrame(C);
    const ex = -ddx;
    const ey = -ddy;
    const ez = -ddz;
    const kx = R[0]! * ex + R[3]! * ey + R[6]! * ez;
    const ky = R[1]! * ex + R[4]! * ey + R[7]! * ez;
    const kz = R[2]! * ex + R[5]! * ey + R[8]! * ez;
    const occ = s.occ;
    const sox = s.ox;
    const soy = s.oy;
    const soz = s.oz;
    const ssx = s.sx;
    const ssy = s.sy;
    const ssz = s.sz;
    const m = rs.pointCount;
    for (let j = 0; j < m; j++) {
      const plx = rs.px[j]!;
      const ply = rs.py[j]!;
      const plz = rs.pz[j]!;
      const qx = C[0]! * plx + C[1]! * ply + C[2]! * plz + kx;
      const qy = C[3]! * plx + C[4]! * ply + C[5]! * plz + ky;
      const qz = C[6]! * plx + C[7]! * ply + C[8]! * plz + kz;
      const ix = Math.floor(qx) - sox;
      const iy = Math.floor(qy) - soy;
      const iz = Math.floor(qz) - soz;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= ssx || iy >= ssy || iz >= ssz) continue;
      if (occ[ix + iz * ssx + iy * ssx * ssz] !== OCC_SOLID) continue;
      const wx = R0[0]! * plx + R0[1]! * ply + R0[2]! * plz + t0x;
      const wy = R0[3]! * plx + R0[4]! * ply + R0[5]! * plz + t0y;
      const wz = R0[6]! * plx + R0[7]! * ply + R0[8]! * plz + t0z;
      rv.velocityAt(plx, ply, plz, wx, wy, wz, invDt, vel);
      const rx = wx - b.px;
      const ry = wy - b.py;
      const rz = wz - b.pz;
      const relx = vel[0]! - (b.vx + b.wy * rz - b.wz * ry);
      const rely = vel[1]! - (b.vy + b.wz * rx - b.wx * rz);
      const relz = vel[2]! - (b.vz + b.wx * ry - b.wy * rx);
      const rl = Math.sqrt(relx * relx + rely * rely + relz * relz);
      // The ship is pushed along -R e_g, so the preferred exit face points AGAINST the sweep.
      let sx = 0;
      let sy = 0;
      let sz = 0;
      if (rl > 1e-6) {
        sx = -(R[0]! * relx + R[3]! * rely + R[6]! * relz) / rl;
        sy = -(R[1]! * relx + R[4]! * rely + R[7]! * relz) / rl;
        sz = -(R[2]! * relx + R[5]! * rely + R[8]! * relz) / rl;
      }
      if (!pr.probe(s, qx, qy, qz, rs.pmask[j]!, sx, sy, sz)) continue;
      const base = set.push();
      const a = set.f;
      a[base + F_A] = b.index;
      a[base + F_B] = -1;
      a[base + F_KIND] = KIND_ROTOR;
      a[base + F_SRC] = ri;
      a[base + F_PX] = wx;
      a[base + F_PX + 1] = wy;
      a[base + F_PX + 2] = wz;
      dirToWorld(R, pr.dir, a, base + F_NX);
      a[base + F_NX] = -a[base + F_NX]!;
      a[base + F_NX + 1] = -a[base + F_NX + 1]!;
      a[base + F_NX + 2] = -a[base + F_NX + 2]!;
      a[base + F_DEPTH] = pr.depth;
      a[base + F_VO] = vel[0]!;
      a[base + F_VO + 1] = vel[1]!;
      a[base + F_VO + 2] = vel[2]!;
      a[base + F_MU] = mu;
      a[base + F_HASCELL] = 1;
      a[base + F_CELL] = pr.cellX;
      a[base + F_CELL + 1] = pr.cellY;
      a[base + F_CELL + 2] = pr.cellZ;
    }
  }

  // ------------------------------------------------------------------ ship / ship

  /** Symmetric contacts between ships `a` and `b` (either may be static). */
  ships(a: Body, b: Body, set: ContactSet, mu: number): void {
    if (a.shape.solidCount === 0 || b.shape.solidCount === 0) return;
    const dx = b.px - a.px;
    const dy = b.py - a.py;
    const dz = b.pz - a.pz;
    const reach = a.rMax + b.rMax + 0.5;
    if (dx * dx + dy * dy + dz * dz > reach * reach) return;
    this.pointsInto(a, b, set, mu, 1);
    this.pointsInto(b, a, set, mu, -1);
  }

  /**
   * Sample points of `src` inside hard cells of `dst`. sign = +1: src is body A of the contact
   * (pushed along dst's exit normal); -1: dst is body A (pushed against it).
   */
  private pointsInto(src: Body, dst: Body, set: ContactSet, mu: number, sign: 1 | -1): void {
    const C = this.C;
    const Ra = src.R;
    const Rb = dst.R;
    mat3MulTransA(Rb, Ra, C);
    const pr = this.prober;
    pr.setFrame(C);
    const ddx = src.tx - dst.tx;
    const ddy = src.ty - dst.ty;
    const ddz = src.tz - dst.tz;
    const cx = Rb[0]! * ddx + Rb[3]! * ddy + Rb[6]! * ddz;
    const cy = Rb[1]! * ddx + Rb[4]! * ddy + Rb[7]! * ddz;
    const cz = Rb[2]! * ddx + Rb[5]! * ddy + Rb[8]! * ddz;
    const s = src.shape;
    const t: GridShape = dst.shape;
    const occ = t.occ;
    const tox = t.ox;
    const toy = t.oy;
    const toz = t.oz;
    const tsx = t.sx;
    const tsy = t.sy;
    const tsz = t.sz;
    const n = s.pointCount;
    for (let i = 0; i < n; i++) {
      const plx = s.px[i]!;
      const ply = s.py[i]!;
      const plz = s.pz[i]!;
      const lx = C[0]! * plx + C[1]! * ply + C[2]! * plz + cx;
      const ly = C[3]! * plx + C[4]! * ply + C[5]! * plz + cy;
      const lz = C[6]! * plx + C[7]! * ply + C[8]! * plz + cz;
      const ix = Math.floor(lx) - tox;
      const iy = Math.floor(ly) - toy;
      const iz = Math.floor(lz) - toz;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= tsx || iy >= tsy || iz >= tsz) continue;
      if (occ[ix + iz * tsx + iy * tsx * tsz] !== OCC_SOLID) continue;
      if (!pr.probe(t, lx, ly, lz, s.pmask[i]!, 0, 0, 0)) continue;
      const base = set.push();
      const f = set.f;
      const A = sign > 0 ? src : dst;
      const B = sign > 0 ? dst : src;
      f[base + F_A] = A.index;
      f[base + F_B] = B.index;
      f[base + F_KIND] = KIND_SHIP;
      f[base + F_PX] = Ra[0]! * plx + Ra[1]! * ply + Ra[2]! * plz + src.tx;
      f[base + F_PX + 1] = Ra[3]! * plx + Ra[4]! * ply + Ra[5]! * plz + src.ty;
      f[base + F_PX + 2] = Ra[6]! * plx + Ra[7]! * ply + Ra[8]! * plz + src.tz;
      // exit normal of dst's face pushes src; body A is src (sign +1) or dst (sign -1)
      dirToWorld(Rb, pr.dir, f, base + F_NX);
      if (sign < 0) {
        f[base + F_NX] = -f[base + F_NX]!;
        f[base + F_NX + 1] = -f[base + F_NX + 1]!;
        f[base + F_NX + 2] = -f[base + F_NX + 2]!;
      }
      f[base + F_DEPTH] = pr.depth;
      f[base + F_MU] = mu;
    }
  }
}
