import { describe, expect, it } from 'vitest';
import { facingState, ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import {
  cameraPose,
  CONVERGE_DISTANCE,
  nextViewMode,
  placeCamera,
  SELF_BOX_HALF,
  SELF_BOX_TOP,
  SELF_HIDE_CLEARANCE,
  selfModelGap,
  SHOULDER_OFFSET,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_MARGIN,
  type CameraPose,
  type CameraRay,
} from '../../src/client/camera';
import { BUTTON_PICK, InputState, isGameKey, PITCH_LIMIT } from '../../src/client/input';
import { blocksCamera, ViewBuilder } from '../../src/client/view';
import type { Simulation } from '../../src/sim/simulation';
import { raycastGrids } from '../../src/voxel/raycast';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from '../sim/helpers';

const nothing: CameraRay = () => Infinity;
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
/** The convergence point A on the player's look ray. */
function convergence(e: Vec3, yaw: number, pitch: number): Vec3 {
  const f = forward(yaw, pitch);
  return vec3(e.x + f.x * CONVERGE_DISTANCE, e.y + f.y * CONVERGE_DISTANCE, e.z + f.z * CONVERGE_DISTANCE);
}
/** Distance from `a` to the camera's centre ray (Infinity when `a` is behind the camera). */
function centreRayMiss(c: CameraPose, a: Vec3): number {
  const u = forward(c.yaw, c.pitch);
  const v = vec3(a.x - c.x, a.y - c.y, a.z - c.z);
  const t = dot(u, v);
  if (t <= 0) return Infinity;
  return Math.hypot(v.x - u.x * t, v.y - u.y * t, v.z - u.z * t);
}
/** sideEff and back of a 'back' pose: C - E = r * side - f * back. */
function shoulderParts(c: CameraPose, e: Vec3, yaw: number, pitch: number): { side: number; back: number } {
  const v = vec3(c.x - e.x, c.y - e.y, c.z - e.z);
  const f = forward(yaw, pitch);
  return { side: dot(v, right(yaw)), back: -dot(v, f) };
}

interface RayCall {
  origin: Vec3;
  dir: Vec3;
  max: number;
  hit: number;
}
/** Wraps a ray query, recording every call (copies: the arguments are scratch vectors). */
function recording(inner: CameraRay): { ray: CameraRay; calls: RayCall[] } {
  const calls: RayCall[] = [];
  return {
    calls,
    ray: (o, d, max) => {
      const hit = inner(o, d, max);
      calls.push({ origin: vec3(o.x, o.y, o.z), dir: vec3(d.x, d.y, d.z), max, hit });
      return hit;
    },
  };
}
/** The real camera ray against a simulation's grids. */
function worldRay(sim: Simulation): CameraRay {
  return (o, d, max) => raycastGrids(sim.grids(), o, d, max, blocksCamera)?.dist ?? Infinity;
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
  const dir = vec3();
  const org = vec3();

  it('first person: at the eye, with the look angles', () => {
    const out = placeCamera('first', eye, 0.3, -0.2, () => {
      throw new Error('no ray in first person');
    }, cameraPose(), dir, org);
    expect(out).toEqual({ x: 10, y: 50, z: -3, yaw: 0.3, pitch: -0.2, distance: 0 });
  });

  it('front: along the look direction, turned around to face the player', () => {
    const out = placeCamera('front', eye, Math.PI / 2, 0.4, nothing, cameraPose(), dir, org);
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
    const out = placeCamera('front', eye, 0, 0, wall, cameraPose(), dir, org);
    expect(asked).toBeGreaterThanOrEqual(THIRD_PERSON_DISTANCE);
    expect(out.distance).toBeCloseTo(2 - THIRD_PERSON_MARGIN, 12);
    expect(out.z).toBeCloseTo(-3 - (2 - THIRD_PERSON_MARGIN), 12);
    const close = placeCamera('front', eye, 0, 0, () => 0.1, cameraPose(), dir, org);
    expect(close.distance).toBe(0);
    expect(close.z).toBe(-3);
    // A hit just beyond the full distance (within the margin) still pulls the camera in.
    const edge = placeCamera('front', eye, 0, 0, () => THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN / 2, cameraPose(), dir, org);
    expect(edge.distance).toBeCloseTo(THIRD_PERSON_DISTANCE - THIRD_PERSON_MARGIN / 2, 12);
    for (const g of [Number.NaN, Infinity, -Infinity]) {
      expect(placeCamera('front', eye, 0, 0, () => g, cameraPose(), dir, org).distance).toBe(THIRD_PERSON_DISTANCE);
    }
  });
});

describe('placeCamera: back (over the shoulder)', () => {
  const dir = vec3();
  const org = vec3();
  const yaws = [-Math.PI, -2.5, -1.3, -0.4, 0, 0.2, 0.9, Math.PI / 2, 2.1, 3];
  const pitches = [-89.5, -80, -60, -45, -20, 0, 10, 35, 60, 75, 89].map((d) => d * DEG);

  it('level, yaw 0, nothing in the way: 0.75 right, 4 back, aimed at the point 5 ahead', () => {
    // yaw 0 looks toward -Z, the right is +X.
    const out = placeCamera('back', eye, 0, 0, nothing, cameraPose(), dir, org);
    expect(out.x).toBeCloseTo(10 + SHOULDER_OFFSET, 12);
    expect(out.y).toBeCloseTo(50, 12);
    expect(out.z).toBeCloseTo(-3 + THIRD_PERSON_DISTANCE, 12);
    expect(SHOULDER_OFFSET).toBe(0.75);
    expect(THIRD_PERSON_DISTANCE).toBe(4);
    expect(CONVERGE_DISTANCE).toBe(5);
    // A = (10, 50, -8); from C = (10.75, 50, 1) that is 0.75 to the left over 9 ahead.
    expect(out.yaw).toBeCloseTo(Math.atan2(0.75, 9), 12);
    expect(out.yaw).toBeCloseTo(0.0831412319, 9);
    expect(out.pitch).toBeCloseTo(0, 12);
    expect(out.distance).toBeCloseTo(Math.hypot(0.75, 4), 12);
  });

  it('casts the shoulder ray from the eye along the right, then the back ray from the pivot', () => {
    const rec = recording(nothing);
    const yaw = 0.7;
    const pitch = 0.3;
    placeCamera('back', eye, yaw, pitch, rec.ray, cameraPose(), dir, org);
    expect(rec.calls.length).toBe(2);
    const [s, b] = rec.calls as [RayCall, RayCall];
    expect(s.origin).toEqual(eye);
    const r = right(yaw);
    expect(s.dir.x).toBeCloseTo(r.x, 12);
    expect(s.dir.y).toBe(0);
    expect(s.dir.z).toBeCloseTo(r.z, 12);
    expect(s.max).toBeCloseTo(SHOULDER_OFFSET + THIRD_PERSON_MARGIN, 12);
    expect(b.origin.x).toBeCloseTo(eye.x + r.x * SHOULDER_OFFSET, 12);
    expect(b.origin.z).toBeCloseTo(eye.z + r.z * SHOULDER_OFFSET, 12);
    const f = forward(yaw, pitch);
    expect(b.dir.x).toBeCloseTo(-f.x, 12);
    expect(b.dir.y).toBeCloseTo(-f.y, 12);
    expect(b.dir.z).toBeCloseTo(-f.z, 12);
    expect(b.max).toBeCloseTo(THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN, 12);
  });

  it('for every yaw and pitch, open or pulled in: the centre ray passes through A, the camera is on the right', () => {
    const rays: Record<string, CameraRay> = {
      open: nothing,
      // Both rays hit something: the pivot 0.6 out, the back 1.7 out.
      pulled: (o) => (o.x === eye.x && o.y === eye.y && o.z === eye.z ? 0.6 : 1.7),
    };
    for (const [name, ray] of Object.entries(rays)) {
      for (const yaw of yaws) {
        for (const pitch of pitches) {
          const out = placeCamera('back', eye, yaw, pitch, ray, cameraPose(), dir, org);
          const a = convergence(eye, yaw, pitch);
          expect(centreRayMiss(out, a), `${name} yaw ${yaw} pitch ${pitch}`).toBeLessThan(1e-6);
          const { side, back } = shoulderParts(out, eye, yaw, pitch);
          expect(side, `${name} side`).toBeGreaterThan(0);
          expect(back).toBeGreaterThan(0);
          const full = SHOULDER_OFFSET * Math.min(1, Math.cos(pitch) / Math.cos(Math.PI / 3));
          expect(side).toBeCloseTo(name === 'open' ? full : Math.min(full, 0.6 - THIRD_PERSON_MARGIN), 9);
          expect(back).toBeCloseTo(name === 'open' ? THIRD_PERSON_DISTANCE : 1.7 - THIRD_PERSON_MARGIN, 9);
          expect(out.distance).toBeCloseTo(Math.hypot(side, back), 9);
        }
      }
    }
  });

  it('the side offset is full up to 60 degrees of pitch either way, then shrinks to zero at the poles', () => {
    const side = (pitch: number): number => shoulderParts(placeCamera('back', eye, 0.4, pitch, nothing, cameraPose(), dir, org), eye, 0.4, pitch).side;
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
        const out = placeCamera('back', eye, yaw, pitch, nothing, cameraPose(), dir, org);
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
        const lo = placeCamera('back', eye, yaw, s * (60 * DEG - 1e-7), nothing, cameraPose(), dir, org);
        const hi = placeCamera('back', eye, yaw, s * (60 * DEG + 1e-7), nothing, cameraPose(), dir, org);
        expect(Math.abs(wrap(lo.yaw - hi.yaw))).toBeLessThan(1e-6);
        expect(Math.abs(lo.pitch - hi.pitch)).toBeLessThan(1e-6);
        expect(Math.hypot(lo.x - hi.x, lo.y - hi.y, lo.z - hi.z)).toBeLessThan(1e-6);
      }
      // Exactly straight up / down: vertical aim, the player's own yaw, finite numbers.
      for (const pitch of [Math.PI / 2, -Math.PI / 2]) {
        const out = placeCamera('back', eye, yaw, pitch, nothing, cameraPose(), dir, org);
        expect(out.yaw).toBe(yaw);
        expect(out.pitch).toBe(pitch);
        for (const v of [out.x, out.y, out.z, out.distance]) expect(Number.isFinite(v)).toBe(true);
        expect(out.y).toBeCloseTo(eye.y - Math.sign(pitch) * THIRD_PERSON_DISTANCE, 9);
        expect(centreRayMiss(out, convergence(eye, yaw, pitch))).toBeLessThan(1e-6);
      }
    }
  });

  it('pulled in, the yaw offset grows (16.7 degrees at most, camera beside the head at 60 degrees)', () => {
    const out = placeCamera('back', eye, 0, 60 * DEG, (_o, d) => (d.y === 0 ? Infinity : 0), cameraPose(), dir, org);
    expect(wrap(out.yaw)).toBeCloseTo(Math.atan(SHOULDER_OFFSET / (0.5 * CONVERGE_DISTANCE)), 6);
    expect(wrap(out.yaw)).toBeLessThan(16.8 * DEG);
  });

  it('a hit within the margin pulls in; a hit at or before the margin leaves nothing; garbage is no hit', () => {
    const sideHit = (h: number): CameraRay => (_o, d) => (d.y === 0 && Math.abs(d.x - 1) < 1e-12 ? h : Infinity);
    const backHit = (h: number): CameraRay => (_o, d) => (d.z > 0.5 ? h : Infinity);
    const run = (ray: CameraRay) => shoulderParts(placeCamera('back', eye, 0, 0, ray, cameraPose(), dir, org), eye, 0, 0);
    expect(run(sideHit(SHOULDER_OFFSET + THIRD_PERSON_MARGIN / 2)).side).toBeCloseTo(SHOULDER_OFFSET - THIRD_PERSON_MARGIN / 2, 12);
    expect(run(sideHit(0.2)).side).toBe(0);
    expect(run(sideHit(-1)).side).toBe(0);
    expect(run(backHit(THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN / 2)).back).toBeCloseTo(THIRD_PERSON_DISTANCE - THIRD_PERSON_MARGIN / 2, 12);
    expect(run(backHit(0.1)).back).toBeCloseTo(0, 12);
    for (const g of [Number.NaN, Infinity, -Infinity]) {
      const out = placeCamera('back', eye, 0, 0, () => g, cameraPose(), dir, org);
      expect(out.x).toBeCloseTo(10 + SHOULDER_OFFSET, 12);
      expect(out.z).toBeCloseTo(-3 + THIRD_PERSON_DISTANCE, 12);
      expect(out.yaw).toBeCloseTo(Math.atan2(0.75, 9), 12);
    }
  });

  /**
   * In a real world: for every yaw and pitch, neither ray takes the camera beyond its hit minus
   * the margin, the camera cell is open, and the centre ray still passes through A.
   */
  function checkInWorld(sim: Simulation, e: Vec3, label: string): number {
    let pulled = 0;
    for (let yi = 0; yi < 24; yi++) {
      const yaw = -Math.PI + (yi + 0.37) * (Math.PI / 12);
      for (const pd of [-85, -60, -35, -10, 0, 20, 45, 70, 88]) {
        const pitch = pd * DEG;
        const rec = recording(worldRay(sim));
        const out = placeCamera('back', e, yaw, pitch, rec.ray, cameraPose(), dir, org);
        const at = `${label} yaw ${yaw.toFixed(3)} pitch ${pd}`;
        expect(rec.calls.length, at).toBe(2);
        const { side, back } = shoulderParts(out, e, yaw, pitch);
        const [s, b] = rec.calls as [RayCall, RayCall];
        if (s.hit < s.max) {
          pulled++;
          expect(side, at).toBeLessThanOrEqual(Math.max(0, s.hit - THIRD_PERSON_MARGIN) + 1e-9);
        }
        if (b.hit < b.max) {
          pulled++;
          expect(back, at).toBeLessThanOrEqual(Math.max(0, b.hit - THIRD_PERSON_MARGIN) + 1e-9);
        }
        expect(side, at).toBeGreaterThanOrEqual(-1e-9);
        expect(back, at).toBeGreaterThanOrEqual(-1e-9);
        const cell = sim.world.getCell(Math.floor(out.x), Math.floor(out.y), Math.floor(out.z));
        expect(blocksCamera(cell), at).toBe(false);
        expect(centreRayMiss(out, convergence(e, yaw, pitch)), at).toBeLessThan(1e-6);
      }
    }
    return pulled;
  }

  it('a wall directly on the right pushes the pivot back toward the head', () => {
    const sim = flatSim();
    // Wall cells at x = 1 (face at x = 1), the eye at x = 0.5: 0.5 to the right when yaw = 0.
    fill(sim.world, 1, FLAT_TOP, -6, 1, FLAT_TOP + 4, 6, B.STONE);
    const e = vec3(0.5, FLAT_TOP + 1.62, 0.5);
    const out = placeCamera('back', e, 0, 0, worldRay(sim), cameraPose(), dir, org);
    const { side, back } = shoulderParts(out, e, 0, 0);
    expect(side).toBeCloseTo(0.5 - THIRD_PERSON_MARGIN, 9);
    expect(back).toBeCloseTo(THIRD_PERSON_DISTANCE, 9);
    expect(centreRayMiss(out, convergence(e, 0, 0))).toBeLessThan(1e-6);
    expect(checkInWorld(sim, e, 'right wall')).toBeGreaterThan(20);
  });

  it('a wall behind pulls the camera in toward the pivot', () => {
    const sim = flatSim();
    // Wall cells at z = 2 (face at z = 2), the eye at z = 0.5, looking toward -Z.
    fill(sim.world, -4, FLAT_TOP, 2, 4, FLAT_TOP + 4, 2, B.STONE);
    const e = vec3(0.5, FLAT_TOP + 1.62, 0.5);
    const out = placeCamera('back', e, 0, 0, worldRay(sim), cameraPose(), dir, org);
    const { side, back } = shoulderParts(out, e, 0, 0);
    expect(side).toBeCloseTo(SHOULDER_OFFSET, 9);
    expect(back).toBeCloseTo(1.5 - THIRD_PERSON_MARGIN, 9);
    expect(out.z).toBeLessThanOrEqual(2 - THIRD_PERSON_MARGIN + 1e-9);
    expect(checkInWorld(sim, e, 'back wall')).toBeGreaterThan(20);
  });

  it('in a one-block-wide tunnel the camera stays inside it', () => {
    const sim = flatSim();
    const w = sim.world;
    // Tunnel along Z through x = 0, two blocks high, closed at the far end behind the player.
    fill(w, -1, FLAT_TOP, -12, -1, FLAT_TOP + 2, 12, B.STONE);
    fill(w, 1, FLAT_TOP, -12, 1, FLAT_TOP + 2, 12, B.STONE);
    fill(w, -1, FLAT_TOP + 2, -12, 1, FLAT_TOP + 2, 12, B.STONE);
    const e = vec3(0.5, FLAT_TOP + 1.62, 0.5);
    const out = placeCamera('back', e, 0, 0, worldRay(sim), cameraPose(), dir, org);
    const { side, back } = shoulderParts(out, e, 0, 0);
    expect(side).toBeCloseTo(0.5 - THIRD_PERSON_MARGIN, 9);
    expect(back).toBeCloseTo(THIRD_PERSON_DISTANCE, 9);
    expect(out.x).toBeGreaterThan(0);
    expect(out.x).toBeLessThan(1);
    expect(checkInWorld(sim, e, 'tunnel')).toBeGreaterThan(200);
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

  it('shown with the pivot beside the head, hidden when the camera is pulled against the head', () => {
    const dir = vec3();
    const org = vec3();
    const shown = (ray: CameraRay, pitch = 0): boolean => {
      const c = placeCamera('back', e, 0.3, pitch, ray, cameraPose(), dir, org);
      return selfModelGap(c.x, c.y, c.z, e, 0.3, H) >= SELF_HIDE_CLEARANCE;
    };
    expect(shown(nothing)).toBe(true);
    // Wall right behind: the camera stays beside the head, the model is out of the way.
    expect(shown((_o, d) => (d.y === 0 && Math.abs(Math.hypot(d.x, d.z) - 1) < 1e-12 && dot(d, right(0.3)) > 0.99 ? Infinity : 0))).toBe(true);
    // In a corner (walls right and behind): the camera ends up at the head.
    expect(shown(() => 0.4)).toBe(false);
    // A low ceiling while looking down: the camera is pressed onto the head.
    expect(shown((_o, d) => (d.y > 0.5 ? 0.5 : Infinity), -80 * DEG)).toBe(false);
  });
});

describe('ViewBuilder third person', () => {
  it('never puts the camera inside a block of the world; draws the local player only when the camera is clear of it', () => {
    const sim = flatSim();
    const w = sim.world;
    // A wall 2 blocks behind the player (south, +Z), the player looking north.
    fill(w, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.STONE);
    sim.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const v = new ViewBuilder();
    const p = sim.player;
    const eyeOf = (): Vec3 => vec3(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);

    v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'first');
    expect(v.updateEntities(sim, 1).some((e) => e.id === p.id)).toBe(false);

    const cam = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    const cell = w.getCell(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    expect(SOLID[cell & ID_MASK]).toBe(0);
    expect(cam.z).toBeLessThan(2 - THIRD_PERSON_MARGIN + 1e-9);
    // Over the right shoulder (yaw 0: the right is +X), aimed at the point 5 ahead of the eye.
    expect(cam.x).toBeCloseTo(p.pos.x + SHOULDER_OFFSET, 9);
    expect(centreRayMiss({ ...cam, distance: 0 }, convergence(eyeOf(), p.yaw, p.pitch))).toBeLessThan(1e-6);
    const self = v.updateEntities(sim, 1).find((e) => e.id === p.id);
    expect(self).toBeDefined();
    expect(self!.kind).toBe('player');
    expect(self!.yaw).toBe(p.yaw);
    expect(self!.x).toBeCloseTo(p.pos.x, 12);
    expect(self!.z).toBeCloseTo(p.pos.z, 12);

    // Front: open air in front, the full distance; the camera looks back (yaw + PI).
    const front = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'front');
    expect(front.z).toBeCloseTo(p.pos.z - THIRD_PERSON_DISTANCE * Math.cos(p.pitch), 9);
    expect(Math.cos(front.yaw - p.yaw)).toBeCloseTo(-1, 9);
    expect(v.updateEntities(sim, 1).some((e) => e.id === p.id)).toBe(true);

    // Back against the wall: the camera stays beside the head, out of the model's way.
    sim.teleport(0.5, FLAT_TOP, 1.5);
    sim.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const c2 = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    expect(c2.z).toBeLessThanOrEqual(2 - THIRD_PERSON_MARGIN + 1e-9);
    expect(selfModelGap(c2.x, c2.y, c2.z, eyeOf(), p.yaw, p.eyeHeight)).toBeGreaterThanOrEqual(SELF_HIDE_CLEARANCE);
    expect(v.updateEntities(sim, 1).some((e) => e.id === p.id)).toBe(true);

    // In a corner (a wall on the right too): the camera would be at the head, the model is left out.
    fill(w, 1, FLAT_TOP, -3, 1, FLAT_TOP + 4, 1, B.STONE);
    const c3 = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    expect(c3.x).toBeLessThanOrEqual(1 - THIRD_PERSON_MARGIN + 1e-9);
    expect(selfModelGap(c3.x, c3.y, c3.z, eyeOf(), p.yaw, p.eyeHeight)).toBeLessThan(SELF_HIDE_CLEARANCE);
    expect(v.updateEntities(sim, 1).some((e) => e.id === p.id)).toBe(false);
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

  it('a helmsman on a moving ship is drawn where the camera eye is (same interpolation), and ship cells stop the camera', () => {
    const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    fill(w, 0, SEA_TOP, 5, 4, SEA_TOP + 3, 5, B.PLANKS_OAK); // a tall stern wall behind the helm
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    sim.advance(2);
    sim.teleport(2.5, SEA_TOP, 3.5);
    expect(sim.useOn(2, SEA_TOP, 4)).toBe(true);
    expect(sim.useOn(2, SEA_TOP, 4)).toBe(true);
    const ship = sim.structures.ships()[0]!;
    expect(sim.player.steeringShipId).toBe(ship.id);
    sim.player.input.forward = 1;
    sim.player.input.strafe = 1;
    sim.advance(60);
    const p = sim.player;
    const v = new ViewBuilder();
    for (const alpha of [0, 0.3, 0.75, 1]) {
      const cam = v.updateCamera(sim, alpha, p.yaw, 0, 70, 0.05, 'front');
      const self = v.updateEntities(sim, alpha).find((e) => e.id === p.id)!;
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
      // from its right.
      const e = vec3(pos.x, pos.y + p.eyeHeight, pos.z);
      for (const pitch of [0, -0.5, 0.4]) {
        const back = v.updateCamera(sim, alpha, p.yaw, pitch, 70, 0.05, 'back');
        expect(centreRayMiss({ ...back, distance: 0 }, convergence(e, p.yaw, pitch))).toBeLessThan(1e-6);
        expect(shoulderParts({ ...back, distance: 0 }, e, p.yaw, pitch).side).toBeGreaterThanOrEqual(0);
      }
    }
    // Behind the helmsman is the stern wall (a ship cell): the camera stays in front of it.
    const back = v.updateCamera(sim, 1, p.yaw, 0, 70, 0.05, 'back');
    const local = ship.grid.toLocal(vec3(back.x, back.y, back.z), vec3());
    expect(local.z).toBeLessThan(5);
  });
});
