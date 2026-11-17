import { describe, expect, it } from 'vitest';
import { facingState, ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ } from '../../src/core/dirs';
import { qfromAxisAngle, qmul, quat, vec3, type Vec3 } from '../../src/core/math';
import {
  CAMERA_CLEARANCE,
  CAMERA_EASE_MAX_DT,
  CAMERA_EASE_TIME,
  cameraGridFrame,
  cameraPose,
  cameraRig,
  CONVERGE_DISTANCE,
  easeOut,
  NEAR_PLANE_REACH,
  nextViewMode,
  PIVOT_CLEARANCE,
  placeCamera,
  resetCameraRig,
  SELF_BOX_HALF,
  SELF_BOX_TOP,
  SELF_HIDE_CLEARANCE,
  selfModelGap,
  SHOULDER_OFFSET,
  SHOULDER_SLACK,
  sweepGrids,
  sweepScratch,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_MARGIN,
  type CameraGridFrame,
  type CameraPose,
  type CameraQueries,
  type CameraRay,
  type CameraRig,
  type CameraSweep,
  type ViewMode,
} from '../../src/client/camera';
import { BUTTON_PICK, InputState, isGameKey, PITCH_LIMIT } from '../../src/client/input';
import { SETTING_RANGES } from '../../src/client/settings';
import { blocksCamera, ViewBuilder } from '../../src/client/view';
import type { Simulation } from '../../src/sim/simulation';
import { StructureGrid } from '../../src/voxel/sgrid';
import { raycastGrids } from '../../src/voxel/raycast';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from '../sim/helpers';

const nothing: CameraRay = () => Infinity;
const openSweep: CameraSweep = (_o, _d, max) => max;
const open: CameraQueries = { ray: nothing, sweep: openSweep };
const eye = { x: 10, y: 50, z: -3 };
const DEG = Math.PI / 180;

/** Game-convention look direction. */
function forward(yaw: number, pitch: number): Vec3 {
  return vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}
/** The player's horizontal right. */
function right(yaw: number): Vec3 {
  return vec3(Math.cos(yaw), 0, -Math.sin(yaw));
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
/** The wanted side offset for a pitch. */
function side0(pitch: number): number {
  return SHOULDER_OFFSET * Math.min(1, Math.cos(pitch) / Math.cos(Math.PI / 3));
}
/** The convergence point A on the player's look ray. */
function convergence(e: Vec3, yaw: number, pitch: number): Vec3 {
  const f = forward(yaw, pitch);
  return vec3(e.x + f.x * CONVERGE_DISTANCE, e.y + f.y * CONVERGE_DISTANCE, e.z + f.z * CONVERGE_DISTANCE);
}
/** Distance from `a` to the camera's centre ray (Infinity when `a` is behind the camera). */
function centreRayMiss(c: { x: number; y: number; z: number; yaw: number; pitch: number }, a: Vec3): number {
  const u = forward(c.yaw, c.pitch);
  const v = vec3(a.x - c.x, a.y - c.y, a.z - c.z);
  const t = dot(u, v);
  if (t <= 0) return Infinity;
  return Math.hypot(v.x - u.x * t, v.y - u.y * t, v.z - u.z * t);
}
/** Side offset and back distance of a 'back' pose: C - E = r * side - f * back. */
function shoulderParts(c: { x: number; y: number; z: number }, e: Vec3, yaw: number, pitch: number): { side: number; back: number } {
  const v = vec3(c.x - e.x, c.y - e.y, c.z - e.z);
  const f = forward(yaw, pitch);
  return { side: dot(v, right(yaw)), back: -dot(v, f) };
}

/** One placement with a fresh rig (no easing). */
function place(mode: ViewMode, e: Vec3, yaw: number, pitch: number, q: CameraQueries): CameraPose {
  return placeCamera(mode, e, yaw, pitch, q, cameraRig(), 0, cameraPose());
}

/** The real camera ray against a simulation's grids (current poses). */
function worldRay(sim: Simulation): CameraRay {
  return (o, d, max) => raycastGrids(sim.grids(), o, d, max, blocksCamera)?.dist ?? Infinity;
}
/** Sweep frames of every grid of a simulation, at the current pose. */
function framesOf(sim: Simulation): CameraGridFrame[] {
  return sim.grids().map((g) => {
    const f = cameraGridFrame();
    f.grid = g;
    if (g instanceof StructureGrid) {
      g.renderPose(1, f.position, f.rotation);
      f.pivot.x = g.pivot.x;
      f.pivot.y = g.pivot.y;
      f.pivot.z = g.pivot.z;
    }
    return f;
  });
}
/** The real queries against a simulation's grids, counting the sweeps. */
function worldQueries(sim: Simulation): CameraQueries & { sweeps: number } {
  const frames = framesOf(sim);
  const scratch = sweepScratch();
  const q = {
    sweeps: 0,
    ray: worldRay(sim),
    sweep: ((o, d, max, half, graded) => {
      q.sweeps++;
      return sweepGrids(frames, frames.length, blocksCamera, o, d, max, half, graded, scratch);
    }) as CameraSweep,
  };
  return q;
}
/**
 * Brute force: Euclidean distance from a world point to the nearest camera-blocking cell of any
 * grid of the simulation, structures as drawn at `alpha` (Infinity when none is within 1 block).
 */
function nearestBlock(sim: Simulation, p: Vec3, alpha = 1): number {
  let best = Infinity;
  for (const g of sim.grids()) {
    let l: Vec3;
    if (g instanceof StructureGrid) {
      const rp = g.renderPose(alpha);
      const q = rp.rotation;
      l = rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, vec3(p.x - rp.position.x, p.y - rp.position.y, p.z - rp.position.z));
      l.x += g.pivot.x;
      l.y += g.pivot.y;
      l.z += g.pivot.z;
    } else l = vec3(p.x, p.y, p.z);
    const fx = Math.floor(l.x);
    const fy = Math.floor(l.y);
    const fz = Math.floor(l.z);
    for (let x = fx - 1; x <= fx + 1; x++) {
      for (let y = fy - 1; y <= fy + 1; y++) {
        for (let z = fz - 1; z <= fz + 1; z++) {
          if (!blocksCamera(g.getCell(x, y, z))) continue;
          const dx = Math.max(x - l.x, 0, l.x - x - 1);
          const dy = Math.max(y - l.y, 0, l.y - y - 1);
          const dz = Math.max(z - l.z, 0, l.z - z - 1);
          best = Math.min(best, Math.hypot(dx, dy, dz));
        }
      }
    }
  }
  return best;
}
function collapsed(c: { x: number; y: number; z: number }, e: Vec3): boolean {
  return c.x === e.x && c.y === e.y && c.z === e.z;
}

const EYE_Y = FLAT_TOP + 1.62;
interface Scene {
  name: string;
  sim: Simulation;
  eye: Vec3;
}
/** Long walls (z -12..12), six high, on the flat ground; yaw 0 looks toward -Z, the right is +X. */
function wallRight(d: number): Scene {
  const sim = flatSim();
  fill(sim.world, 1, FLAT_TOP, -12, 1, FLAT_TOP + 6, 12, B.STONE); // face at x = 1
  return { name: `wall right ${d}`, sim, eye: vec3(1 - d, EYE_Y, 0.5) };
}
function wallLeft(d: number): Scene {
  const sim = flatSim();
  fill(sim.world, -1, FLAT_TOP, -12, -1, FLAT_TOP + 6, 12, B.STONE); // face at x = 0
  return { name: `wall left ${d}`, sim, eye: vec3(d, EYE_Y, 0.5) };
}
function tunnel(): Scene {
  const sim = flatSim();
  const w = sim.world;
  fill(w, -1, FLAT_TOP, -12, -1, FLAT_TOP + 2, 12, B.STONE);
  fill(w, 1, FLAT_TOP, -12, 1, FLAT_TOP + 2, 12, B.STONE);
  fill(w, -1, FLAT_TOP + 2, -12, 1, FLAT_TOP + 2, 12, B.STONE); // ceiling face at FLAT_TOP + 2
  return { name: 'tunnel', sim, eye: vec3(0.5, EYE_Y, 0.5) };
}
function insideCorner(): Scene {
  const sim = flatSim();
  fill(sim.world, 1, FLAT_TOP, -12, 1, FLAT_TOP + 6, 1, B.STONE); // right, face x = 1
  fill(sim.world, -12, FLAT_TOP, 1, 1, FLAT_TOP + 6, 1, B.STONE); // behind, face z = 1
  return { name: 'inside corner', sim, eye: vec3(0.5, EYE_Y, 0.5) };
}
function lowCeiling(): Scene {
  const sim = flatSim();
  fill(sim.world, -6, FLAT_TOP + 2, -6, 6, FLAT_TOP + 2, 6, B.STONE); // face at FLAT_TOP + 2
  return { name: 'ceiling 0.18 above', sim, eye: vec3(0.5, FLAT_TOP + 2 - 0.18, 0.5) };
}
function wallBehind(): Scene {
  const sim = flatSim();
  fill(sim.world, -12, FLAT_TOP, 1, 12, FLAT_TOP + 6, 1, B.STONE); // face at z = 1
  return { name: 'wall 1 behind', sim, eye: vec3(0.5, EYE_Y, 0) };
}
/** The tunnel with the player 0.3 from its right wall (the body touching it). */
function tunnelOffCentre(): Scene {
  const sc = tunnel();
  return { name: 'tunnel, 0.3 from the right wall', sim: sc.sim, eye: vec3(0.7, EYE_Y, 0.5) };
}
function pillar(): Scene {
  const sim = flatSim();
  fill(sim.world, 1, FLAT_TOP, 2, 1, FLAT_TOP + 4, 2, B.STONE); // one column behind the right shoulder
  return { name: 'pillar', sim, eye: vec3(0.5, EYE_Y, 0.5) };
}
function clearanceScenes(): Scene[] {
  return [
    ...[0.3, 0.5, 0.8, 1.2].map(wallRight),
    ...[0.3, 0.5, 0.8, 1.2].map(wallLeft),
    tunnel(),
    tunnelOffCentre(),
    insideCorner(),
    lowCeiling(),
    wallBehind(),
    pillar(),
  ];
}

describe('view modes', () => {
  it('F5 cycles first -> back -> front -> first', () => {
    expect(nextViewMode('first')).toBe('back');
    expect(nextViewMode('back')).toBe('front');
    expect(nextViewMode('front')).toBe('first');
  });

  it('F5 is a game key and the cycleView command; the middle button is the pickBlock command', () => {
    const s = new InputState();
    expect(isGameKey('F5')).toBe(true);
    expect(s.keyDown('F5', false, 0)).toBe('cycleView');
    expect(s.keyDown('F5', true, 0)).toBe('none');
    expect(BUTTON_PICK).toBe(1);
    expect(s.buttonDown(1)).toBe('pickBlock');
    expect(s.click(1)).toBe('pickBlock');
    expect(s.buttonDown(0)).toBe('none');
    expect(s.click(2)).toBe('none');
  });
});

describe('placeCamera: first and front', () => {
  const noQueries: CameraQueries = {
    ray: () => {
      throw new Error('no ray in first person');
    },
    sweep: () => {
      throw new Error('no sweep in first person');
    },
  };
  const ray = (r: CameraRay): CameraQueries => ({
    ray: r,
    sweep: () => {
      throw new Error('front does not sweep');
    },
  });

  it('first person: at the eye, with the look angles', () => {
    const out = place('first', eye, 0.3, -0.2, noQueries);
    expect(out).toEqual({ x: 10, y: 50, z: -3, yaw: 0.3, pitch: -0.2, distance: 0 });
  });

  it('front: along the look direction, turned around to face the player', () => {
    const out = place('front', eye, Math.PI / 2, 0.4, ray(nothing));
    // yaw PI/2 looks toward -X.
    const cp = Math.cos(0.4);
    expect(out.x).toBeCloseTo(10 - THIRD_PERSON_DISTANCE * cp, 12);
    expect(out.y).toBeCloseTo(50 + THIRD_PERSON_DISTANCE * Math.sin(0.4), 12);
    expect(out.z).toBeCloseTo(-3, 12);
    expect(out.yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(out.pitch).toBeCloseTo(-0.4, 12);
    // The camera's own forward points back at the eye.
    const f = forward(out.yaw, out.pitch);
    expect(out.x + f.x * out.distance).toBeCloseTo(eye.x, 9);
    expect(out.y + f.y * out.distance).toBeCloseTo(eye.y, 9);
    expect(out.z + f.z * out.distance).toBeCloseTo(eye.z, 9);
  });

  it('front is pulled in by the ray, keeping the margin; never behind the eye; garbage is no hit', () => {
    let asked = 0;
    const wall: CameraRay = (_o, d, max) => {
      asked = max;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
      return 2;
    };
    const out = place('front', eye, 0, 0, ray(wall));
    expect(asked).toBeGreaterThanOrEqual(THIRD_PERSON_DISTANCE);
    expect(out.distance).toBeCloseTo(2 - THIRD_PERSON_MARGIN, 12);
    expect(out.z).toBeCloseTo(-3 - (2 - THIRD_PERSON_MARGIN), 12);
    const close = place('front', eye, 0, 0, ray(() => 0.1));
    expect(close.distance).toBe(0);
    expect(close.z).toBe(-3);
    // A hit just beyond the full distance (within the margin) still pulls the camera in.
    const edge = place('front', eye, 0, 0, ray(() => THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN / 2));
    expect(edge.distance).toBeCloseTo(THIRD_PERSON_DISTANCE - THIRD_PERSON_MARGIN / 2, 12);
    for (const g of [Number.NaN, Infinity, -Infinity]) {
      expect(place('front', eye, 0, 0, ray(() => g)).distance).toBe(THIRD_PERSON_DISTANCE);
    }
  });

  it('front does not ease and ignores the rig state', () => {
    const rig = cameraRig();
    rig.primed = true;
    rig.back = 0.5;
    const out = placeCamera('front', eye, 0, 0, ray(nothing), rig, 1 / 60, cameraPose());
    expect(out.distance).toBe(THIRD_PERSON_DISTANCE);
  });
});

describe('placeCamera: back, nothing in the way', () => {
  const yaws = [-Math.PI, -2.5, -1.3, -0.4, 0, 0.2, 0.9, Math.PI / 2, 2.1, 3];
  const pitches = [-89.5, -80, -60, -45, -20, 0, 10, 35, 60, 75, 89].map((d) => d * DEG);

  it('level, yaw 0: 0.75 right, 4 back, aimed at the point 5 ahead', () => {
    // yaw 0 looks toward -Z, the right is +X.
    const out = place('back', eye, 0, 0, open);
    expect(out.x).toBe(10 + SHOULDER_OFFSET);
    expect(out.y).toBe(50);
    expect(out.z).toBe(-3 + THIRD_PERSON_DISTANCE);
    expect(SHOULDER_OFFSET).toBe(0.75);
    expect(THIRD_PERSON_DISTANCE).toBe(4);
    expect(CONVERGE_DISTANCE).toBe(5);
    // A = (10, 50, -8); from C = (10.75, 50, 1) that is 0.75 to the left over 9 ahead.
    expect(out.yaw).toBeCloseTo(Math.atan2(0.75, 9), 12);
    expect(out.yaw).toBeCloseTo(0.0831412319, 9);
    expect(out.pitch).toBeCloseTo(0, 12);
    expect(out.distance).toBeCloseTo(Math.hypot(0.75, 4), 12);
  });

  it('every yaw and pitch: exactly s = side0 and b = 4, the centre ray through A, also with the real sweep in open air', () => {
    const sim = flatSim();
    const high = vec3(3.3, FLAT_TOP + 20, -2.7); // nothing within 5 blocks
    const real = worldQueries(sim);
    for (const yaw of yaws) {
      for (const pitch of pitches) {
        for (const [q, e] of [
          [open, eye],
          [real, high],
        ] as const) {
          const out = place('back', e, yaw, pitch, q);
          const rig = cameraRig();
          placeCamera('back', e, yaw, pitch, q, rig, 0, cameraPose());
          expect(rig.side).toBe(side0(pitch) > 0 ? Math.max(0, side0(pitch)) : 0);
          expect(rig.back).toBe(THIRD_PERSON_DISTANCE);
          const at = `yaw ${yaw} pitch ${pitch}`;
          expect(centreRayMiss(out, convergence(e, yaw, pitch)), at).toBeLessThan(1e-6);
          const { side, back } = shoulderParts(out, e, yaw, pitch);
          expect(side, at).toBeCloseTo(side0(pitch), 9);
          expect(back, at).toBeCloseTo(THIRD_PERSON_DISTANCE, 9);
          expect(out.distance).toBeCloseTo(Math.hypot(side, back), 9);
        }
      }
    }
  });

  it('one rig kept while the pitch sweeps through +-60..85 degrees (side0 changes every frame): still exactly side0 and b = 4 in every frame', () => {
    const sim = flatSim();
    const high = vec3(3.3, FLAT_TOP + 20, -2.7);
    const real = worldQueries(sim);
    const degs: number[] = [];
    for (let d = 85; d >= -85; d--) degs.push(d);
    for (let d = -85; d <= 85; d++) degs.push(d);
    for (const [q, e] of [
      [open, eye],
      [real, high],
    ] as const) {
      for (const yaw of [-48 * DEG, 0, 2.2]) {
        const rig = cameraRig();
        for (const d of degs) {
          const pitch = d * DEG;
          const out = placeCamera('back', e, yaw, pitch, q, rig, 1 / 60, cameraPose());
          expect(rig.side, `yaw ${yaw} pitch ${d}`).toBe(side0(pitch));
          expect(rig.back).toBe(THIRD_PERSON_DISTANCE);
          expect(out).toEqual(place('back', e, yaw, pitch, open));
        }
      }
    }
  });

  it('sweeps once from the eye along the right (graded, pivot clearance), once from the pivot backwards (plain clearance)', () => {
    const calls: { o: Vec3; d: Vec3; max: number; half: number; graded: boolean }[] = [];
    const rec: CameraQueries = {
      ray: () => {
        throw new Error('back does not cast rays');
      },
      sweep: (o, d, max, half, graded) => {
        calls.push({ o: vec3(o.x, o.y, o.z), d: vec3(d.x, d.y, d.z), max, half, graded });
        return calls.length === 1 ? 0.5 : max;
      },
    };
    const yaw = 0.7;
    const pitch = 0.3;
    place('back', eye, yaw, pitch, rec);
    expect(calls.length).toBe(2);
    const [s, b] = calls as [(typeof calls)[0], (typeof calls)[0]];
    expect(s.o).toEqual(eye);
    const r = right(yaw);
    expect(s.d.x).toBeCloseTo(r.x, 12);
    expect(s.d.y).toBe(0);
    expect(s.d.z).toBeCloseTo(r.z, 12);
    expect(s.max).toBe(SHOULDER_OFFSET);
    expect(s.half).toBe(PIVOT_CLEARANCE);
    expect(PIVOT_CLEARANCE).toBeCloseTo(CAMERA_CLEARANCE + SHOULDER_SLACK, 12);
    expect(s.graded).toBe(true);
    // The pivot is where the side sweep stopped (less a hair).
    expect(b.o.x).toBeCloseTo(eye.x + r.x * 0.5, 5);
    expect(b.o.z).toBeCloseTo(eye.z + r.z * 0.5, 5);
    const f = forward(yaw, pitch);
    expect(b.d.x).toBeCloseTo(-f.x, 12);
    expect(b.d.y).toBeCloseTo(-f.y, 12);
    expect(b.d.z).toBeCloseTo(-f.z, 12);
    expect(b.max).toBe(THIRD_PERSON_DISTANCE);
    expect(b.half).toBe(CAMERA_CLEARANCE);
    expect(b.graded).toBe(false);
  });

  it('a pivot without clearance falls back to the eye; an eye without clearance gives the eye itself; garbage counts as "not clear"', () => {
    // Pivot not clear (negative from any sweep that does not start at the eye), eye clear.
    let n = 0;
    const pivotBad: CameraQueries = {
      ray: nothing,
      sweep: (o, _d, max, _h, graded) => {
        n++;
        if (graded) return max;
        return o.x === eye.x && o.z === eye.z ? 2 : -1;
      },
    };
    const a = place('back', eye, 0, 0, pivotBad);
    expect(n).toBe(3);
    expect(shoulderParts(a, eye, 0, 0).side).toBeCloseTo(0, 12);
    expect(shoulderParts(a, eye, 0, 0).back).toBeCloseTo(2, 5);
    for (const g of [-1, Number.NaN, -Infinity]) {
      const out = place('back', eye, 0.4, 0.2, { ray: nothing, sweep: (_o, _d, _m, _h, graded) => (graded ? 0.3 : g) });
      expect(collapsed(out, eye)).toBe(true);
      expect(out.distance).toBe(0);
      // Collapsed onto the eye, the camera takes the player's own look.
      expect(out.yaw).toBeCloseTo(0.4, 12);
      expect(out.pitch).toBeCloseTo(0.2, 12);
    }
    // Infinity or anything beyond the wanted distance is "all of it".
    const inf = place('back', eye, 0, 0, { ray: nothing, sweep: () => Infinity });
    expect(inf.x).toBe(10 + SHOULDER_OFFSET);
    expect(inf.z).toBe(-3 + THIRD_PERSON_DISTANCE);
  });

  it('the side offset is full up to 60 degrees of pitch either way, then shrinks to zero at the poles', () => {
    const side = (pitch: number): number => shoulderParts(place('back', eye, 0.4, pitch, open), eye, 0.4, pitch).side;
    for (const d of [-60, -30, 0, 45, 60]) expect(side(d * DEG)).toBeCloseTo(SHOULDER_OFFSET, 9);
    expect(side(75 * DEG)).toBeCloseTo(SHOULDER_OFFSET * Math.cos(75 * DEG) * 2, 9);
    expect(side(-80 * DEG)).toBeCloseTo(SHOULDER_OFFSET * Math.cos(80 * DEG) * 2, 9);
    expect(side(PITCH_LIMIT)).toBeLessThan(0.002);
    expect(Math.abs(side(Math.PI / 2))).toBeLessThan(1e-12);
  });

  it('camera yaw stays within 9.5 degrees of the player yaw at every pitch, continuous through +-60, the player yaw at +-90', () => {
    for (const yaw of [0, 1.1, -2.9]) {
      let prev = Number.NaN;
      let maxOff = 0;
      // Every 0.01 degree up to the input's pitch limit.
      for (let d = -9000; d <= 9000; d++) {
        const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, (d / 100) * DEG));
        const out = place('back', eye, yaw, pitch, open);
        expect(Number.isFinite(out.yaw) && Number.isFinite(out.pitch)).toBe(true);
        const off = wrap(out.yaw - yaw);
        // Turned left, toward the look line (the camera is on the right).
        expect(off).toBeGreaterThan(0);
        maxOff = Math.max(maxOff, off);
        if (prev === prev) expect(Math.abs(off - prev)).toBeLessThan(0.05 * DEG);
        prev = off;
      }
      expect(maxOff).toBeLessThan(9.5 * DEG);
      expect(maxOff).toBeGreaterThan(9.4 * DEG);
      // Right around +-60 degrees, where the offset starts shrinking.
      for (const s of [-1, 1]) {
        const lo = place('back', eye, yaw, s * (60 * DEG - 1e-7), open);
        const hi = place('back', eye, yaw, s * (60 * DEG + 1e-7), open);
        expect(Math.abs(wrap(lo.yaw - hi.yaw))).toBeLessThan(1e-6);
        expect(Math.abs(lo.pitch - hi.pitch)).toBeLessThan(1e-6);
        expect(Math.hypot(lo.x - hi.x, lo.y - hi.y, lo.z - hi.z)).toBeLessThan(1e-6);
      }
      // Exactly straight up / down: vertical aim, the player's own yaw, finite numbers.
      for (const pitch of [Math.PI / 2, -Math.PI / 2]) {
        const out = place('back', eye, yaw, pitch, open);
        expect(out.yaw).toBe(yaw);
        expect(out.pitch).toBe(pitch);
        for (const v of [out.x, out.y, out.z, out.distance]) expect(Number.isFinite(v)).toBe(true);
        expect(out.y).toBeCloseTo(eye.y - Math.sign(pitch) * THIRD_PERSON_DISTANCE, 9);
        expect(centreRayMiss(out, convergence(eye, yaw, pitch))).toBeLessThan(1e-6);
      }
    }
  });

  it('pulled in, the yaw offset grows (16.7 degrees at most, camera beside the head at 60 degrees)', () => {
    const q: CameraQueries = { ray: nothing, sweep: (_o, _d, max, _h, graded) => (graded ? max : 0) };
    const out = place('back', eye, 0, 60 * DEG, q);
    expect(wrap(out.yaw)).toBeCloseTo(Math.atan(SHOULDER_OFFSET / (0.5 * CONVERGE_DISTANCE)), 6);
    expect(wrap(out.yaw)).toBeLessThan(16.8 * DEG);
  });
});

describe('sweepGrids', () => {
  const sim = flatSim();
  fill(sim.world, 4, FLAT_TOP + 10, 0, 4, FLAT_TOP + 10, 0, B.STONE); // one cell, [4,5] x [45,46] x [0,1]
  const frames = framesOf(sim);
  const scratch = sweepScratch();
  const sweep = (o: Vec3, d: Vec3, max: number, half: number, graded = false): number =>
    sweepGrids(frames, frames.length, blocksCamera, o, d, max, half, graded, scratch);
  const y = FLAT_TOP + 10.5;

  it('stops a cube of half-size h where it would touch the cell; touching is not overlapping', () => {
    expect(sweep(vec3(1, y, 0.5), vec3(1, 0, 0), 10, 0.25)).toBeCloseTo(4 - 0.25 - 1, 12);
    expect(sweep(vec3(1, y, 0.5), vec3(1, 0, 0), 2, 0.25)).toBe(2);
    expect(sweep(vec3(1, y, 0.5), vec3(-1, 0, 0), 10, 0.25)).toBe(10);
    // Passing beside the cell at exactly h: free; a hair nearer: stopped.
    expect(sweep(vec3(1, y, 1.25), vec3(1, 0, 0), 10, 0.25)).toBe(10);
    expect(sweep(vec3(1, y, 1.2499), vec3(1, 0, 0), 10, 0.25)).toBeCloseTo(2.75, 9);
    // Diagonally past the corner: the cube's corner meets the cell's corner.
    const s = Math.SQRT1_2;
    expect(sweep(vec3(2, y, -2), vec3(s, 0, s), 10, 0.25)).toBeCloseTo((4 - 0.25 - 2) / s, 9);
  });

  it('a cube already overlapping at the origin answers negative; graded, moving along or away is free and moving closer is not', () => {
    expect(sweep(vec3(3.9, y, 0.5), vec3(-1, 0, 0), 10, 0.25)).toBeLessThan(0);
    expect(sweep(vec3(3.9, y, 0.5), vec3(-1, 0, 0), 10, 0.25, true)).toBe(10);
    expect(sweep(vec3(3.9, y, 0.5), vec3(0, 1, 0), 0.4, 0.25, true)).toBe(0.4);
    expect(sweep(vec3(3.9, y, 0.5), vec3(1, 0, 0), 10, 0.25, true)).toBeLessThan(1e-6);
    // Cells farther than the half-size count fully.
    expect(sweep(vec3(3.5, y, 0.5), vec3(1, 0, 0), 10, 0.25, true)).toBeCloseTo(0.25, 9);
  });

  it('works in a turned and tilted structure frame like in the world (distances are kept)', () => {
    // A frame whose local space is the world turned 37 degrees about Y and tilted 20 about X,
    // with the same cell: sweeping the transformed path gives the same distances.
    const f = cameraGridFrame();
    f.grid = sim.world;
    const rot = qmul(qfromAxisAngle(vec3(0, 1, 0), 37 * DEG), qfromAxisAngle(vec3(1, 0, 0), 20 * DEG), quat());
    f.rotation.x = rot.x;
    f.rotation.y = rot.y;
    f.rotation.z = rot.z;
    f.rotation.w = rot.w;
    f.position.x = 7;
    f.position.y = -3;
    f.position.z = 2;
    f.pivot.x = 1;
    f.pivot.y = 2;
    f.pivot.z = 3;
    const toWorld = (l: Vec3): Vec3 => {
      const v = vec3(l.x - f.pivot.x, l.y - f.pivot.y, l.z - f.pivot.z);
      const r = rotate(rot, v);
      return vec3(r.x + f.position.x, r.y + f.position.y, r.z + f.position.z);
    };
    const s = Math.SQRT1_2;
    for (const [o, d] of [
      [vec3(1, y, 0.5), vec3(1, 0, 0)],
      [vec3(2, y, -2), vec3(s, 0, s)],
      [vec3(1, y, 1.2499), vec3(1, 0, 0)],
    ] as const) {
      const local = sweep(o, d, 10, 0.25);
      const wo = toWorld(o);
      const wd = rotate(rot, d);
      expect(sweepGrids([f], 1, blocksCamera, wo, wd, 10, 0.25, false, scratch)).toBeCloseTo(local, 9);
    }
  });

  it('skips structures whose cells are nowhere near and grids set to null', () => {
    const f = cameraGridFrame();
    expect(sweepGrids([f], 1, blocksCamera, vec3(1, y, 0.5), vec3(1, 0, 0), 10, 0.25, false, scratch)).toBe(10);
    expect(sweepGrids(frames, 0, blocksCamera, vec3(1, y, 0.5), vec3(1, 0, 0), 10, 0.25, false, scratch)).toBe(10);
  });
});

/** Rotate v by unit quaternion q (test-side copy, independent of the code under test). */
function rotate(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return vec3(v.x + w * tx + (y * tz - z * ty), v.y + w * ty + (z * tx - x * tz), v.z + w * tz + (x * ty - y * tx));
}

describe('placeCamera: back keeps its clearance (T1, T2)', () => {
  it('the near plane fits inside the clearance for every view the game allows', () => {
    const near = 0.05; // render/three/backend.ts: new PerspectiveCamera(70, 1, 0.05, 512)
    const fov = SETTING_RANGES.fov.max * 1.1; // view.ts: SPRINT_FOV_SCALE widens it while sprinting
    expect(SETTING_RANGES.fov.max).toBe(110);
    const h = near * Math.tan((fov * DEG) / 2);
    const reach = Math.hypot(near, h, h * (21 / 9));
    expect(reach).toBeLessThanOrEqual(NEAR_PLANE_REACH);
    expect(NEAR_PLANE_REACH).toBeLessThan(reach + 0.001);
    expect(CAMERA_CLEARANCE).toBeGreaterThan(NEAR_PLANE_REACH);
    expect(SELF_HIDE_CLEARANCE).toBeGreaterThan(NEAR_PLANE_REACH);
  });

  it('brute force: no blocking cell within CAMERA_CLEARANCE of the camera, the centre ray through A, in every scene', () => {
    for (const sc of clearanceScenes()) {
      const q = worldQueries(sc.sim);
      let n = 0;
      let eyes = 0;
      for (let yd = -40; yd <= 40; yd++) {
        for (let pd = -80; pd <= 80; pd += 5) {
          const yaw = yd * DEG;
          const pitch = pd * DEG;
          q.sweeps = 0;
          const out = place('back', sc.eye, yaw, pitch, q);
          expect(q.sweeps).toBeLessThanOrEqual(5);
          const at = `${sc.name} yaw ${yd} pitch ${pd}`;
          expect(centreRayMiss(out, convergence(sc.eye, yaw, pitch)), at).toBeLessThan(1e-6);
          const { side, back } = shoulderParts(out, sc.eye, yaw, pitch);
          expect(side, at).toBeGreaterThanOrEqual(-SHOULDER_SLACK - 1e-12);
          expect(side, at).toBeLessThanOrEqual(side0(pitch) + 1e-12);
          expect(back, at).toBeGreaterThanOrEqual(-1e-12);
          expect(back, at).toBeLessThanOrEqual(THIRD_PERSON_DISTANCE + 1e-12);
          n++;
          if (collapsed(out, sc.eye)) {
            eyes++;
            continue;
          }
          expect(nearestBlock(sc.sim, out), at).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
        }
      }
      // Only under the low ceiling (eye 0.18 from it) does the camera stay at the eye.
      if (sc.name.startsWith('ceiling')) expect(eyes, sc.name).toBe(n);
      else expect(eyes, sc.name).toBeLessThan(n / 20);
    }
  });

  it('parallel to a long wall on the right, even touching it: the full back distance, the camera toward the centre line (T3)', () => {
    for (const d of [0.3, 0.35, 0.4, 0.5, 1.0]) {
      const sc = wallRight(d);
      const q = worldQueries(sc.sim);
      for (const pd of [-60, -30, -10, 0, 10]) {
        const rig = cameraRig();
        placeCamera('back', sc.eye, 0, pd * DEG, q, rig, 0, cameraPose());
        expect(rig.back, `${d} pitch ${pd}`).toBe(THIRD_PERSON_DISTANCE);
        // The pivot keeps PIVOT_CLEARANCE from the wall: right of the eye, or (touching) a little left of it.
        expect(rig.side, `${d} pitch ${pd}`).toBeCloseTo(Math.min(side0(pd * DEG), d - PIVOT_CLEARANCE), 5);
        expect(rig.side).toBeGreaterThanOrEqual(-SHOULDER_SLACK);
      }
    }
    // With the wall farther than side0 + PIVOT_CLEARANCE the side offset is full.
    const far = wallRight(SHOULDER_OFFSET + PIVOT_CLEARANCE + 0.01);
    const rig = cameraRig();
    placeCamera('back', far.eye, 0, 0, worldQueries(far.sim), rig, 0, cameraPose());
    expect(rig.side).toBe(SHOULDER_OFFSET);
    expect(rig.back).toBe(THIRD_PERSON_DISTANCE);
  });

  it('turning left a little with a wall on the right (the back path closes in on it) shrinks the back distance gradually (the slack), not at once', () => {
    const sc = wallRight(0.8);
    const q = worldQueries(sc.sim);
    const backAt = (yd: number): number => {
      const rig = cameraRig();
      placeCamera('back', sc.eye, yd * DEG, 0, q, rig, 0, cameraPose());
      return rig.back;
    };
    expect(backAt(0)).toBe(4);
    expect(backAt(1)).toBe(4);
    // The pivot is SHOULDER_SLACK beyond the clearance: b = slack / sin(turn), less a little for the pivot's own shift.
    expect(backAt(4)).toBeGreaterThan(1.5);
    expect(backAt(8)).toBeGreaterThan(0.7);
    expect(backAt(8)).toBeLessThan(backAt(4));
  });

  it('with no room on the right the pivot steps left: a clearance cube left first, then a pivot cube back right, never past the eye', () => {
    const calls: { o: Vec3; d: Vec3; max: number; half: number; graded: boolean }[] = [];
    const slot = (leftRoom: number, backRight: number): CameraQueries => ({
      ray: nothing,
      sweep: (o, d, max, half, graded) => {
        calls.push({ o: vec3(o.x, o.y, o.z), d: vec3(d.x, d.y, d.z), max, half, graded });
        if (!graded) return max;
        if (calls.length === 1) return 0; // right: blocked at once
        if (calls.length === 2) return Math.min(max, leftRoom);
        return Math.min(max, backRight);
      },
    });
    const yaw = 0.4;
    const r = right(yaw);
    // Room to step the whole slack left; from there the pivot cube gets 0.05 back to the right.
    calls.length = 0;
    const rig = cameraRig();
    placeCamera('back', eye, yaw, 0, slot(1, 0.05), rig, 0, cameraPose());
    expect(calls.length).toBe(4);
    const [, left, back] = calls as [(typeof calls)[0], (typeof calls)[0], (typeof calls)[0]];
    expect(left.o).toEqual(eye);
    expect(left.d.x).toBeCloseTo(-r.x, 12);
    expect(left.d.z).toBeCloseTo(-r.z, 12);
    expect(left.max).toBe(SHOULDER_SLACK);
    expect(left.half).toBe(CAMERA_CLEARANCE);
    expect(left.graded).toBe(true);
    expect(back.o.x).toBeCloseTo(eye.x - r.x * SHOULDER_SLACK, 12);
    expect(back.o.z).toBeCloseTo(eye.z - r.z * SHOULDER_SLACK, 12);
    expect(back.d.x).toBeCloseTo(r.x, 12);
    expect(back.max).toBe(SHOULDER_SLACK);
    expect(back.half).toBe(PIVOT_CLEARANCE);
    expect(back.graded).toBe(true);
    expect(rig.side).toBeCloseTo(0.05 - SHOULDER_SLACK, 5);
    // Only 0.04 of room on the left: the pivot goes no farther left than that.
    calls.length = 0;
    const r2 = cameraRig();
    placeCamera('back', eye, yaw, 0, slot(0.04, 0.01), r2, 0, cameraPose());
    expect(r2.side).toBeCloseTo(0.01 - 0.04, 5);
    // The pivot cube gets all the way back to the eye: s = 0, not to the right.
    calls.length = 0;
    const r3 = cameraRig();
    placeCamera('back', eye, yaw, 0, slot(1, 5), r3, 0, cameraPose());
    expect(r3.side).toBe(0);
    // No room on the left either: s = 0.
    calls.length = 0;
    const r4 = cameraRig();
    placeCamera('back', eye, yaw, 0, slot(0, 0), r4, 0, cameraPose());
    expect(r4.side).toBe(0);
  });

  it('a wall behind with the back touching it: the camera stays beside the head', () => {
    const sim = flatSim();
    fill(sim.world, -12, FLAT_TOP, 1, 12, FLAT_TOP + 6, 1, B.STONE);
    const e = vec3(0.5, EYE_Y, 0.7); // 0.3 from the wall behind
    const rig = cameraRig();
    const out = placeCamera('back', e, 0, 0, worldQueries(sim), rig, 0, cameraPose());
    expect(rig.side).toBe(SHOULDER_OFFSET);
    expect(rig.back).toBeCloseTo(0.3 - CAMERA_CLEARANCE, 5);
    expect(selfModelGap(out.x, out.y, out.z, e, 0, 1.62)).toBeGreaterThanOrEqual(SELF_HIDE_CLEARANCE);
  });
});

describe('placeCamera: back is continuous (T4)', () => {
  /** Largest camera move between neighbouring poses of a yaw sweep (0.1 degree steps) at each pitch. */
  function maxYawStep(sc: Scene, stepDeg: number, from = -40, to = 40): number {
    const q = worldQueries(sc.sim);
    let worst = 0;
    for (let pd = -80; pd <= 80; pd += 10) {
      let prev: CameraPose | null = null;
      for (let i = 0; i <= Math.round((to - from) / stepDeg); i++) {
        const out = place('back', sc.eye, (from + i * stepDeg) * DEG, pd * DEG, q);
        if (prev) worst = Math.max(worst, Math.hypot(out.x - prev.x, out.y - prev.y, out.z - prev.z));
        prev = out;
      }
    }
    return worst;
  }

  it('sweeping yaw in 0.1 degree steps moves the camera at most a quarter block per step, in the wall and tunnel scenes', () => {
    const scenes = [wallRight(0.3), wallRight(0.35), wallRight(0.5), wallRight(0.8), wallRight(1.2), wallLeft(0.3), wallLeft(0.5), wallLeft(0.8), tunnel(), tunnelOffCentre()];
    for (const sc of scenes) {
      expect(maxYawStep(sc, 0.1), sc.name).toBeLessThan(0.25);
    }
    // Ten times finer steps give (about) ten times smaller moves: no jump hides between the steps.
    for (const sc of [wallRight(0.3), tunnelOffCentre()]) {
      expect(maxYawStep(sc, 0.01, -5, 5), sc.name).toBeLessThan(0.025);
    }
  });

  it('touching a wall on the right, mouse wobble of 1.5 degrees does not pump the camera (eased, 144 fps)', () => {
    for (const sc of [wallRight(0.3), tunnelOffCentre()]) {
      const q = worldQueries(sc.sim);
      const rig = cameraRig();
      let nearest = Infinity;
      // Two seconds of yaw wobbling at 2 Hz, 1.5 degrees either way.
      for (let i = 0; i <= 288; i++) {
        const yaw = 1.5 * DEG * Math.sin(2 * Math.PI * 2 * (i / 144));
        const out = placeCamera('back', sc.eye, yaw, 0, q, rig, 1 / 144, cameraPose());
        nearest = Math.min(nearest, Math.hypot(out.x - sc.eye.x, out.y - sc.eye.y, out.z - sc.eye.z));
        expect(nearestBlock(sc.sim, out)).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
      }
      expect(nearest, sc.name).toBeGreaterThan(3.9);
    }
  });

  it('moving the player toward or along a wall moves the camera continuously', () => {
    for (const make of [wallRight, wallLeft]) {
      const sc = make(1.5);
      const q = worldQueries(sc.sim);
      for (const yd of [-10, 0, 6]) {
        let prev: CameraPose | null = null;
        // From 1.5 to 0.3 from the wall in 0.005 steps.
        for (let i = 0; i <= 240; i++) {
          const d = 1.5 - i * 0.005;
          const e = make === wallRight ? vec3(1 - d, EYE_Y, 0.5) : vec3(d, EYE_Y, 0.5);
          const out = place('back', e, yd * DEG, 0, q);
          if (prev) expect(Math.hypot(out.x - prev.x, out.y - prev.y, out.z - prev.z), `${sc.name} yaw ${yd} d ${d}`).toBeLessThan(0.25);
          prev = out;
        }
      }
    }
  });
});

describe('placeCamera: back easing (T5)', () => {
  function frame(rig: CameraRig, q: CameraQueries, e: Vec3, yaw: number, pitch: number, dt: number): CameraPose {
    return placeCamera('back', e, yaw, pitch, q, rig, dt, cameraPose());
  }
  /** A sweep with a wall `wall` blocks behind the pivot (the side is free). */
  const behind = (wall: number): CameraQueries => ({
    ray: nothing,
    sweep: (_o, _d, max, _h, graded) => (graded ? max : Math.min(max, wall)),
  });

  it('the ease step: down at once, up exponentially, never above the allowed value, frame-rate independent, huge dt capped', () => {
    expect(easeOut(3, 1, 1 / 60)).toBe(1);
    expect(easeOut(1, 1, 1 / 60)).toBe(1);
    expect(easeOut(1, 4, CAMERA_EASE_TIME / 2)).toBeCloseTo(4 - 3 * Math.exp(-0.5), 12);
    let a = 1;
    for (let i = 0; i < 10; i++) a = easeOut(a, 4, CAMERA_EASE_TIME / 20);
    expect(a).toBeCloseTo(4 - 3 * Math.exp(-0.5), 12);
    expect(easeOut(1, 4, 1000)).toBeCloseTo(4 - 3 * Math.exp(-CAMERA_EASE_MAX_DT / CAMERA_EASE_TIME), 12);
    expect(easeOut(1, 4, Infinity)).toBeCloseTo(4 - 3 * Math.exp(-CAMERA_EASE_MAX_DT / CAMERA_EASE_TIME), 12);
    for (const bad of [0, -1, Number.NaN]) expect(easeOut(1, 4, bad)).toBe(1);
    expect(CAMERA_EASE_TIME).toBe(0.15);
  });

  it('pulls in within the frame the obstacle appears; moves out about 63 % of the way in one time constant', () => {
    const rig = cameraRig();
    frame(rig, open, eye, 0, 0, 1 / 60);
    expect(rig.back).toBe(4);
    frame(rig, behind(1), eye, 0, 0, 1 / 60);
    expect(rig.back).toBeCloseTo(1 - 1e-6, 9);
    // The wall is gone: ease out at 60 frames per second for one time constant.
    const steps = Math.round(CAMERA_EASE_TIME * 60);
    for (let i = 0; i < steps; i++) frame(rig, open, eye, 0, 0, 1 / 60);
    const covered = (rig.back - 1) / 3;
    expect(covered).toBeGreaterThan(0.6);
    expect(covered).toBeLessThan(0.66);
    // Side: pulled in at once, eased out the same way.
    const sideWall: CameraQueries = { ray: nothing, sweep: (_o, _d, max, _h, graded) => (graded ? 0.2 : max) };
    frame(rig, sideWall, eye, 0, 0, 1 / 60);
    expect(rig.side).toBeCloseTo(0.2, 5);
    for (let i = 0; i < steps; i++) frame(rig, open, eye, 0, 0, 1 / 60);
    expect((rig.side - 0.2) / (SHOULDER_OFFSET - 0.2)).toBeGreaterThan(0.6);
    expect((rig.side - 0.2) / (SHOULDER_OFFSET - 0.2)).toBeLessThan(0.66);
    // From a step left of the eye (body against a wall on the right that then goes away): the
    // whole way from -0.1 to side0 is eased alike, 63 % in one time constant; a few seconds later
    // the pose is exactly the open one again.
    const sc = wallRight(0.3);
    const q = worldQueries(sc.sim);
    const r2 = cameraRig();
    frame(r2, q, sc.eye, 0, 0, 1 / 60);
    expect(r2.side).toBeCloseTo(0.3 - PIVOT_CLEARANCE, 5);
    fill(sc.sim.world, 1, FLAT_TOP, -12, 1, FLAT_TOP + 6, 12, B.AIR);
    for (let i = 0; i < steps; i++) frame(r2, q, sc.eye, 0, 0, 1 / 60);
    const part = (r2.side - (0.3 - PIVOT_CLEARANCE)) / (SHOULDER_OFFSET - (0.3 - PIVOT_CLEARANCE));
    expect(part).toBeGreaterThan(0.6);
    expect(part).toBeLessThan(0.66);
    for (let i = 0; i < 5 * 60; i++) frame(r2, q, sc.eye, 0, 0, 1 / 60);
    expect(r2.side).toBe(SHOULDER_OFFSET);
    expect(r2.back).toBe(THIRD_PERSON_DISTANCE);
    expect(frame(r2, q, sc.eye, 0.3, -0.2, 1 / 60)).toEqual(place('back', sc.eye, 0.3, -0.2, open));
  });

  it('the same motion at 30 and at 144 frames per second ends at the same place', () => {
    // The player walks away from a wall behind for 0.6 s (from 0.5 to 2.9 blocks), then stands for 0.2 s.
    const sim = flatSim();
    fill(sim.world, -12, FLAT_TOP, 1, 12, FLAT_TOP + 6, 1, B.STONE);
    const q = worldQueries(sim);
    const run = (fps: number): { side: number; back: number } => {
      const rig = cameraRig();
      const frames = Math.round(0.8 * fps);
      for (let i = 0; i <= frames; i++) {
        const t = Math.min(0.6, i / fps);
        const e = vec3(0.5, EYE_Y, 0.5 - 4 * t);
        frame(rig, q, e, 0, 0, 1 / fps);
      }
      return { side: rig.side, back: rig.back };
    };
    const a = run(30);
    const b = run(144);
    expect(Math.abs(a.back - b.back)).toBeLessThan(0.05);
    expect(Math.abs(a.side - b.side)).toBeLessThan(1e-9);
    // Still catching up with the allowed 2.9 - CAMERA_CLEARANCE (it lags while the wall recedes).
    expect(a.back).toBeGreaterThan(2.3);
    expect(a.back).toBeLessThan(2.9 - CAMERA_CLEARANCE);
  });

  it('walking past a pillar, every eased frame keeps the clearance', () => {
    const sc = pillar();
    const q = worldQueries(sc.sim);
    for (const fps of [30, 60, 144]) {
      for (const yd of [0, 8, -8]) {
        const rig = cameraRig();
        let pulled = 0;
        // Walk along -X, past the pillar behind the right shoulder, 4 blocks/s for 1.5 s.
        for (let i = 0; i <= 1.5 * fps; i++) {
          const e = vec3(3.5 - (4 * i) / fps, EYE_Y, 0.5);
          const out = frame(rig, q, e, yd * DEG, -10 * DEG, 1 / fps);
          if (rig.back < 3.9) pulled++;
          if (!collapsed(out, e)) expect(nearestBlock(sc.sim, out), `fps ${fps} yaw ${yd} frame ${i}`).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
          expect(centreRayMiss(out, convergence(e, yd * DEG, -10 * DEG))).toBeLessThan(1e-6);
        }
        expect(pulled).toBeGreaterThan(0);
      }
    }
  });

  it('the back distance is the one allowed for the EASED side offset (R5 order): a wall on the right vanishes with a pillar straight behind', () => {
    for (const fps of [30, 60, 144]) {
      const sim = flatSim();
      fill(sim.world, 1, FLAT_TOP, -12, 1, FLAT_TOP + 6, 0, B.STONE); // on the right, face x = 1
      fill(sim.world, 0, FLAT_TOP, 3, 0, FLAT_TOP + 4, 3, B.STONE); // pillar behind the eye, cells x 0..1, z 3..4
      const e = vec3(0.5, EYE_Y, 0.5);
      const q = worldQueries(sim);
      const rig = cameraRig();
      frame(rig, q, e, 0, 0, 1 / fps);
      expect(rig.side).toBeCloseTo(0.5 - PIVOT_CLEARANCE, 5);
      expect(rig.back).toBeCloseTo(3 - CAMERA_CLEARANCE - 0.5, 5);
      fill(sim.world, 1, FLAT_TOP, -12, 1, FLAT_TOP + 6, 0, B.AIR);
      // Allowed now: the full side offset, and from that pivot the pillar is just out of the way.
      const fresh = cameraRig();
      frame(fresh, q, e, 0, 0, 1 / fps);
      expect(fresh.side).toBe(SHOULDER_OFFSET);
      expect(fresh.back).toBe(THIRD_PERSON_DISTANCE);
      // The eased pivot is still in line with the pillar: the camera must stay in front of it.
      let lagging = 0;
      for (let i = 0; i < fps; i++) {
        const out = frame(rig, q, e, 0, 0, 1 / fps);
        expect(nearestBlock(sim, out), `fps ${fps} frame ${i}`).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
        expect(centreRayMiss(out, convergence(e, 0, 0))).toBeLessThan(1e-6);
        if (rig.side < SHOULDER_OFFSET - 0.05 && rig.back < 2.3) lagging++;
      }
      expect(lagging).toBeGreaterThan(0);
    }
  });

  it('walking backwards past the end of a wall on the right, a pillar behind: every eased frame keeps the clearance (real ViewBuilder)', () => {
    const sim = flatSim();
    fill(sim.world, 0, FLAT_TOP, 4, 0, FLAT_TOP + 4, 4, B.STONE); // pillar on the centre line behind
    fill(sim.world, 1, FLAT_TOP, -6, 3, FLAT_TOP + 4, 0, B.STONE); // on the right (face x = 1), ends at z = 1
    const p = sim.soloPlayer.player;
    for (const fps of [30, 60, 144]) {
      const v = new ViewBuilder();
      let lagging = 0;
      for (let i = 0; i <= 2.5 * fps; i++) {
        const z = -1 + (1.2 * i) / fps;
        p.pos.x = p.prevPos.x = 0.5;
        p.pos.y = p.prevPos.y = FLAT_TOP;
        p.pos.z = p.prevPos.z = z;
        const cam = v.updateCamera(sim, sim.soloPlayer, 1, 0, 0, 70, 1 / fps, 'back');
        const e = vec3(0.5, FLAT_TOP + p.eyeHeight, z);
        if (collapsed(cam, e)) continue;
        expect(nearestBlock(sim, cam), `fps ${fps} z ${z}`).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
        const { side } = shoulderParts(cam, e, 0, 0);
        if (z > 1 && side < SHOULDER_OFFSET - 0.05 && cam.z - z < 3) lagging++;
      }
      expect(lagging, `fps ${fps}`).toBeGreaterThan(0);
    }
  });

  it('a reset rig takes the allowed pose at once', () => {
    const rig = cameraRig();
    frame(rig, behind(1), eye, 0, 0, 1 / 60);
    resetCameraRig(rig);
    frame(rig, open, eye, 0, 0, 1 / 60);
    expect(rig.back).toBe(4);
    expect(rig.side).toBe(SHOULDER_OFFSET);
  });
});

describe('self-hide rule', () => {
  const e = vec3(3, 40, -7);
  const H = 1.62;

  it('the gap is measured to the yaw-aligned box around the model', () => {
    expect(SELF_BOX_HALF).toBeGreaterThanOrEqual(0.41); // arms reach 0.41 to each side
    expect(SELF_BOX_TOP).toBeCloseTo(1.82 - H, 9); // top of the head
    for (const yaw of [0, 0.6, -2]) {
      const r = right(yaw);
      const f = forward(yaw, 0);
      const at = (side: number, fwd: number, up: number) =>
        selfModelGap(e.x + r.x * side + f.x * fwd, e.y + up, e.z + r.z * side + f.z * fwd, e, yaw, H);
      expect(at(0, 0, 0)).toBe(0);
      expect(at(0.3, -0.3, -1)).toBe(0);
      expect(at(SHOULDER_OFFSET, 0, 0)).toBeCloseTo(SHOULDER_OFFSET - SELF_BOX_HALF, 9);
      expect(at(0, -1, 0)).toBeCloseTo(1 - SELF_BOX_HALF, 9);
      expect(at(0, 0, 0.5)).toBeCloseTo(0.5 - SELF_BOX_TOP, 9);
      expect(at(0, 0, -H - 0.4)).toBeCloseTo(0.4, 9);
      expect(at(SELF_BOX_HALF + 0.3, -SELF_BOX_HALF - 0.4, 0)).toBeCloseTo(0.5, 9);
    }
  });

  it('in every clearance scene: shown only with the whole near plane outside the model box, hidden when collapsed', () => {
    for (const sc of clearanceScenes()) {
      const q = worldQueries(sc.sim);
      let shown = 0;
      let hidden = 0;
      for (let yd = -40; yd <= 40; yd += 4) {
        for (let pd = -80; pd <= 80; pd += 10) {
          const out = place('back', sc.eye, yd * DEG, pd * DEG, q);
          const gap = selfModelGap(out.x, out.y, out.z, sc.eye, yd * DEG, H);
          if (gap >= SELF_HIDE_CLEARANCE) {
            shown++;
            // Every near-plane corner is within NEAR_PLANE_REACH of the camera, so outside the box.
            expect(gap).toBeGreaterThan(NEAR_PLANE_REACH);
            expect(collapsed(out, sc.eye)).toBe(false);
          } else hidden++;
        }
      }
      expect(shown + hidden).toBeGreaterThan(0);
      if (sc.name.startsWith('ceiling')) expect(shown).toBe(0);
    }
    // Open ground: shown.
    const out = place('back', e, 0.3, 0, open);
    expect(selfModelGap(out.x, out.y, out.z, e, 0.3, H)).toBeGreaterThanOrEqual(SELF_HIDE_CLEARANCE);
  });
});

describe('ViewBuilder third person', () => {
  it('keeps the clearance in the world; draws the local player only when the camera is clear of it', () => {
    const sim = flatSim();
    const w = sim.world;
    // A wall 2 blocks behind the player (south, +Z), the player looking north.
    fill(w, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.STONE);
    sim.soloPlayer.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const v = new ViewBuilder();
    const p = sim.soloPlayer.player;
    const eyeOf = (): Vec3 => vec3(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);

    v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 0.05, 'first');
    expect(v.updateEntities(sim, sim.soloPlayer, 1).some((e) => e.id === p.id)).toBe(false);

    const cam = v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    const cell = w.getCell(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    expect(SOLID[cell & ID_MASK]).toBe(0);
    expect(cam.z).toBeLessThan(2 - CAMERA_CLEARANCE);
    expect(nearestBlock(sim, cam)).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
    // Over the right shoulder (yaw 0: the right is +X), aimed at the point 5 ahead of the eye.
    expect(cam.x).toBeCloseTo(p.pos.x + SHOULDER_OFFSET, 9);
    expect(centreRayMiss(cam, convergence(eyeOf(), p.yaw, p.pitch))).toBeLessThan(1e-6);
    const self = v.updateEntities(sim, sim.soloPlayer, 1).find((e) => e.id === p.id);
    expect(self).toBeDefined();
    expect(self!.kind).toBe('player');
    expect(self!.yaw).toBe(p.yaw);
    expect(self!.x).toBeCloseTo(p.pos.x, 12);
    expect(self!.z).toBeCloseTo(p.pos.z, 12);

    // Front: open air in front, the full distance; the camera looks back (yaw + PI).
    const front = v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 0.05, 'front');
    expect(front.z).toBeCloseTo(p.pos.z - THIRD_PERSON_DISTANCE * Math.cos(p.pitch), 9);
    expect(Math.cos(front.yaw - p.yaw)).toBeCloseTo(-1, 9);
    expect(v.updateEntities(sim, sim.soloPlayer, 1).some((e) => e.id === p.id)).toBe(true);

    // Back against the wall: the camera stays beside the head, out of the model's way.
    sim.soloPlayer.teleport(0.5, FLAT_TOP, 1.5);
    sim.soloPlayer.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const c2 = v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    expect(c2.z).toBeLessThanOrEqual(2 - CAMERA_CLEARANCE);
    expect(nearestBlock(sim, c2)).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
    expect(selfModelGap(c2.x, c2.y, c2.z, eyeOf(), p.yaw, p.eyeHeight)).toBeGreaterThanOrEqual(SELF_HIDE_CLEARANCE);
    expect(v.updateEntities(sim, sim.soloPlayer, 1).some((e) => e.id === p.id)).toBe(true);

    // In a corner (a wall on the right too): the camera is pulled in to the head (same
    // frame), the model is left out.
    fill(w, 1, FLAT_TOP, -3, 1, FLAT_TOP + 4, 1, B.STONE);
    const c3 = v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    expect(c3.x).toBeLessThanOrEqual(1 - CAMERA_CLEARANCE);
    expect(nearestBlock(sim, c3)).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
    expect(selfModelGap(c3.x, c3.y, c3.z, eyeOf(), p.yaw, p.eyeHeight)).toBeLessThan(SELF_HIDE_CLEARANCE);
    expect(v.updateEntities(sim, sim.soloPlayer, 1).some((e) => e.id === p.id)).toBe(false);
  });

  it('the local player is hidden exactly when the camera is nearer than SELF_HIDE_CLEARANCE to its model box', () => {
    // Back to a wall (face z = 2, the eye 0.5 from it: b = 0.25) and a wall on the right (face
    // x = 2) at d from the eye: s = d - PIVOT_CLEARANCE, so the camera is s - SELF_BOX_HALF from the box.
    const sim = flatSim();
    const w = sim.world;
    fill(w, -6, FLAT_TOP, 2, 2, FLAT_TOP + 4, 2, B.STONE);
    fill(w, 2, FLAT_TOP, -6, 2, FLAT_TOP + 4, 1, B.STONE);
    const p = sim.soloPlayer.player;
    const v = new ViewBuilder();
    for (const [d, shown] of [
      [0.95, false], // gap 0.10 (above the near plane's own 0.05, below the near-plane reach)
      [1.09, false], // gap 0.24
      [1.12, true], // gap 0.27
      [1.4, true], // full side offset, gap 0.30
    ] as const) {
      sim.soloPlayer.teleport(2 - d, FLAT_TOP, 1.5);
      p.prevPos.x = p.pos.x;
      p.prevPos.y = p.pos.y;
      p.prevPos.z = p.pos.z;
      const cam = v.updateCamera(sim, sim.soloPlayer, 1, 0, 0, 70, 1 / 60, 'back');
      const e = vec3(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
      const gap = selfModelGap(cam.x, cam.y, cam.z, e, 0, p.eyeHeight);
      expect(gap, `d ${d}`).toBeCloseTo(Math.min(SHOULDER_OFFSET, d - PIVOT_CLEARANCE) - SELF_BOX_HALF, 5);
      expect(cam.z - e.z).toBeCloseTo(0.5 - CAMERA_CLEARANCE, 5);
      expect(Math.hypot(cam.x - e.x, cam.z - e.z), `d ${d}`).toBeGreaterThan(0.6);
      expect(v.updateEntities(sim, sim.soloPlayer, 1).some((x) => x.id === p.id), `d ${d}`).toBe(shown);
      v.updateCamera(sim, sim.soloPlayer, 1, 0, 0, 70, 1 / 60, 'first'); // fresh easing for the next case
    }
  });

  it('eases out after an obstacle is gone; a view mode change resets the easing', () => {
    const sim = flatSim();
    fill(sim.world, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.STONE);
    sim.soloPlayer.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const p = sim.soloPlayer.player;
    const v = new ViewBuilder();
    const backOf = (c: { x: number; y: number; z: number }): number => c.z - p.pos.z;
    const pulled = backOf(v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'back'));
    expect(pulled).toBeCloseTo(1.5 - CAMERA_CLEARANCE, 5);
    fill(sim.world, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.AIR);
    // Same mode: eased out, one frame is not enough.
    const eased = backOf(v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'back'));
    expect(eased).toBeGreaterThan(pulled);
    expect(eased).toBeLessThan(THIRD_PERSON_DISTANCE - 1);
    // A mode change (back -> front -> back) starts from the allowed pose.
    v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'front');
    expect(backOf(v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'back'))).toBeCloseTo(THIRD_PERSON_DISTANCE, 9);
    // So does a new ViewBuilder (one per opened world).
    fill(sim.world, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.STONE);
    v.updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'back');
    fill(sim.world, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.AIR);
    expect(backOf(new ViewBuilder().updateCamera(sim, sim.soloPlayer, 1, p.yaw, p.pitch, 70, 1 / 60, 'back'))).toBeCloseTo(THIRD_PERSON_DISTANCE, 9);
  });

  it('ray stops at hard or opaque blocks, not at liquids, plants or the unloaded sentinel', () => {
    expect(blocksCamera(makeCell(B.STONE))).toBe(true);
    expect(blocksCamera(makeCell(B.PLANKS_OAK))).toBe(true);
    expect(blocksCamera(makeCell(B.GLASS))).toBe(true);
    expect(blocksCamera(makeCell(B.AIR))).toBe(false);
    expect(blocksCamera(makeCell(B.WATER))).toBe(false);
    expect(blocksCamera(makeCell(B.TORCH))).toBe(false);
    expect(blocksCamera(makeCell(B.UNLOADED))).toBe(false);
  });

  /** Raft with a helm facing north at (2, SEA_TOP, 4), the player at the helm, steering. */
  function helmScene(build: (sim: Simulation) => void): Simulation {
    const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    build(sim);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    sim.advance(2);
    sim.soloPlayer.teleport(2.5, SEA_TOP, 3.5);
    expect(sim.soloPlayer.useOn(2, SEA_TOP, 4)).toBe(true);
    expect(sim.soloPlayer.useOn(2, SEA_TOP, 4)).toBe(true);
    expect(sim.soloPlayer.player.steeringShipId).toBe(sim.structures.ships()[0]!.id);
    return sim;
  }

  it('a helmsman on a moving ship is drawn where the camera eye is (same interpolation), and ship cells stop the camera', () => {
    const sim = helmScene((s) => fill(s.world, 0, SEA_TOP, 5, 4, SEA_TOP + 3, 5, B.PLANKS_OAK)); // a tall stern wall behind the helm
    const ship = sim.structures.ships()[0]!;
    sim.soloPlayer.player.input.forward = 1;
    sim.soloPlayer.player.input.strafe = 1;
    sim.advance(60);
    const p = sim.soloPlayer.player;
    const v = new ViewBuilder();
    for (const alpha of [0, 0.3, 0.75, 1]) {
      const cam = v.updateCamera(sim, sim.soloPlayer, alpha, p.yaw, 0, 70, 0.05, 'front');
      const self = v.updateEntities(sim, sim.soloPlayer, alpha).find((e) => e.id === p.id)!;
      const pos = v.renderPosition(sim, p, alpha, vec3());
      expect(self.x).toBeCloseTo(pos.x, 12);
      expect(self.y).toBeCloseTo(pos.y, 12);
      expect(self.z).toBeCloseTo(pos.z, 12);
      // The camera is on the look line through that same eye.
      const f = { x: -Math.sin(cam.yaw), z: -Math.cos(cam.yaw) };
      const d = Math.hypot(cam.x - pos.x, cam.z - pos.z);
      expect(cam.x + f.x * d).toBeCloseTo(pos.x, 6);
      expect(cam.z + f.z * d).toBeCloseTo(pos.z, 6);
      expect(cam.y).toBeCloseTo(pos.y + p.eyeHeight, 9);
      // Over the shoulder, the camera aims at the point 5 ahead of that same interpolated eye,
      // from its right, and keeps its clearance from the ship as drawn at this alpha.
      const e = vec3(pos.x, pos.y + p.eyeHeight, pos.z);
      for (const pitch of [0, -0.5, 0.4]) {
        const back = v.updateCamera(sim, sim.soloPlayer, alpha, p.yaw, pitch, 70, 0.05, 'back');
        expect(centreRayMiss(back, convergence(e, p.yaw, pitch))).toBeLessThan(1e-6);
        expect(shoulderParts(back, e, p.yaw, pitch).side).toBeGreaterThanOrEqual(0);
        const rp = ship.grid.renderPose(alpha);
        const l = rotate({ x: -rp.rotation.x, y: -rp.rotation.y, z: -rp.rotation.z, w: rp.rotation.w }, vec3(back.x - rp.position.x, back.y - rp.position.y, back.z - rp.position.z));
        const lx = l.x + ship.grid.pivot.x;
        const ly = l.y + ship.grid.pivot.y;
        const lz = l.z + ship.grid.pivot.z;
        // The stern wall (local z = 5, x 0..4, y SEA_TOP..SEA_TOP+3) stays CAMERA_CLEARANCE away.
        if (lx > -CAMERA_CLEARANCE && lx < 5 + CAMERA_CLEARANCE && ly > SEA_TOP - CAMERA_CLEARANCE && ly < SEA_TOP + 4 + CAMERA_CLEARANCE) {
          expect(lz, `alpha ${alpha} pitch ${pitch}`).toBeLessThanOrEqual(5 - CAMERA_CLEARANCE + 1e-6);
        }
      }
    }
  });

  it('the back 0.3 from a wall of a turned ship: the pivot still slides to the full side offset (the eye clearance sees structures)', () => {
    const sim = helmScene((s) => fill(s.world, 5, SEA_TOP - 1, 0, 5, SEA_TOP + 4, 5, B.PLANKS_OAK));
    const ship = sim.structures.ships()[0]!;
    sim.soloPlayer.releaseHelm();
    sim.structures.dynamics = null;
    const rot = qmul(qfromAxisAngle(vec3(0, 1, 0), 33 * DEG), qfromAxisAngle(vec3(1, 0, 0), 12 * DEG), quat());
    ship.grid.setPoseImmediate(vec3(40.3, 70.1, -20.6), rot);
    const g = ship.grid;
    const n = g.dirToWorld(vec3(-1, 0, 0)); // the wall face's normal (horizontal: the tilt is about local X)
    const onFace = g.toWorld(vec3(5, SEA_TOP + 2.2, 3));
    const e = vec3(onFace.x + n.x * 0.3, onFace.y + n.y * 0.3, onFace.z + n.z * 0.3);
    expect(nearestBlock(sim, e)).toBeCloseTo(0.3, 3);
    // Facing away from the wall: forward = n.
    const yaw = Math.atan2(-n.x, -n.z);
    const q = worldQueries(sim);
    for (const pd of [0, -30, 20]) {
      const rig = cameraRig();
      const out = placeCamera('back', e, yaw, pd * DEG, q, rig, 0, cameraPose());
      expect(rig.side, `pitch ${pd}`).toBe(side0(pd * DEG));
      expect(nearestBlock(sim, out)).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
    }
  });

  it('a wall of a turned and tilted ship on the right: the clearance holds for every yaw and pitch (T6)', () => {
    // A ship with a wall along the raft's east edge (local x = 5, z 0..5, six high).
    const sim = helmScene((s) => fill(s.world, 5, SEA_TOP - 1, 0, 5, SEA_TOP + 4, 5, B.PLANKS_OAK));
    const ship = sim.structures.ships()[0]!;
    sim.soloPlayer.releaseHelm();
    sim.structures.dynamics = null;
    const rot = qmul(qfromAxisAngle(vec3(0, 1, 0), 33 * DEG), qfromAxisAngle(vec3(1, 0, 0), 12 * DEG), quat());
    ship.grid.setPoseImmediate(vec3(40.3, 70.1, -20.6), rot);
    const g = ship.grid;
    expect(g.getCell(5, SEA_TOP + 2, 2)).not.toBe(0);
    // Wall face (local x = 5, facing -X) and a point on it at mid height.
    const n = g.dirToWorld(vec3(-1, 0, 0));
    const onFace = g.toWorld(vec3(5, SEA_TOP + 2.2, 3));
    const v = new ViewBuilder();
    const p = sim.soloPlayer.player;
    let checked = 0;
    for (const d of [0.35, 0.6, 1.0]) {
      // The eye `d` from the face; the player's feet below it, the body clear of the ship.
      const e = vec3(onFace.x + n.x * d, onFace.y + n.y * d, onFace.z + n.z * d);
      sim.soloPlayer.teleport(e.x, e.y - p.eyeHeight, e.z);
      p.prevPos.x = p.pos.x;
      p.prevPos.y = p.pos.y;
      p.prevPos.z = p.pos.z;
      // Facing along the wall with the wall on the right: right = -n (horizontal part).
      const yaw0 = Math.atan2(n.z, -n.x);
      expect(nearestBlock(sim, e)).toBeGreaterThan(d - 0.01);
      for (let yd = -40; yd <= 40; yd += 2) {
        for (let pd = -80; pd <= 80; pd += 10) {
          const yaw = yaw0 + yd * DEG;
          v.updateCamera(sim, sim.soloPlayer, 1, yaw, pd * DEG, 70, 1 / 60, 'first');
          const cam = v.updateCamera(sim, sim.soloPlayer, 1, yaw, pd * DEG, 70, 1 / 60, 'back');
          const at = `d ${d} yaw ${yd} pitch ${pd}`;
          expect(centreRayMiss(cam, convergence(e, yaw, pd * DEG)), at).toBeLessThan(1e-6);
          if (collapsed(cam, e)) continue;
          expect(nearestBlock(sim, cam), at).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
          checked++;
        }
      }
      // Parallel to the tilted wall the camera still gets most of the way back.
      v.updateCamera(sim, sim.soloPlayer, 1, yaw0, 0, 70, 1 / 60, 'first');
      const par = v.updateCamera(sim, sim.soloPlayer, 1, yaw0, 0, 70, 1 / 60, 'back');
      expect(Math.hypot(par.x - e.x, par.y - e.y, par.z - e.z), `parallel ${d}`).toBeGreaterThan(2);
    }
    expect(checked).toBeGreaterThan(2000);

    // The ship moving: last tick it was 0.7 nearer to the player than now. Between ticks it is
    // drawn in between, and the camera keeps its clearance from the ship as drawn.
    const now = vec3(g.position.x, g.position.y, g.position.z);
    ship.grid.setPoseImmediate(vec3(now.x + n.x * 0.7, now.y + n.y * 0.7, now.z + n.z * 0.7), rot);
    g.position.x = now.x;
    g.position.y = now.y;
    g.position.z = now.z;
    const e = vec3(onFace.x + n.x * 1.0, onFace.y + n.y * 1.0, onFace.z + n.z * 1.0);
    sim.soloPlayer.teleport(e.x, e.y - p.eyeHeight, e.z);
    p.prevPos.x = p.pos.x;
    p.prevPos.y = p.pos.y;
    p.prevPos.z = p.pos.z;
    const yaw0 = Math.atan2(n.z, -n.x);
    let near = 0;
    for (const alpha of [0, 0.4, 1]) {
      for (let yd = -40; yd <= 40; yd += 4) {
        for (let pd = -60; pd <= 60; pd += 20) {
          v.updateCamera(sim, sim.soloPlayer, alpha, yaw0 + yd * DEG, pd * DEG, 70, 1 / 60, 'first');
          const cam = v.updateCamera(sim, sim.soloPlayer, alpha, yaw0 + yd * DEG, pd * DEG, 70, 1 / 60, 'back');
          if (collapsed(cam, e)) continue;
          const drawn = nearestBlock(sim, cam, alpha);
          expect(drawn, `alpha ${alpha} yaw ${yd} pitch ${pd}`).toBeGreaterThanOrEqual(CAMERA_CLEARANCE);
          if (drawn < CAMERA_CLEARANCE + 0.05) near++;
        }
      }
    }
    expect(near).toBeGreaterThan(10);
  });
});
