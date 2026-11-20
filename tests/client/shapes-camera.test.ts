/**
 * The third-person camera against partial cells and the step offset (docs/SHAPES.md 5.7, 8.6).
 *
 * The camera keeps its clearance from the octants of the parts that block it (hard or opaque
 * material), not from whole cells: checked against a brute force over octants (independent of the
 * BOXES decomposition the code uses), and in the scenes that matter: a ceiling of upper half slabs
 * (the gap under it is usable) and a wall of vertical half slabs. Stepping up onto a half slab
 * lowers the eyes by what the display has shown of the step and lets that go quickly.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { Rng } from '../../src/core/rng';
import { vec3, type Vec3 } from '../../src/core/math';
import {
  blockingOctants,
  CAMERA_CLEARANCE,
  cameraGridFrame,
  clearanceAt,
  SELF_HIDE_CLEARANCE,
  selfModelGap,
  STEP_LAG_MAX,
  STEP_LAG_TIME,
  stepLagState,
  sweepGrids,
  sweepScratch,
  THIRD_PERSON_DISTANCE,
  updateStepLag,
  type CameraGridFrame,
  type StepSample,
} from '../../src/client/camera';
import { blocksCamera, shownPlayer, ViewBuilder, type CameraScene, type ShownPlayer } from '../../src/client/view';
import type { Simulation } from '../../src/sim/simulation';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FLAT_TOP, fill, flatSim } from '../sim/helpers';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';

const T = FLAT_TOP;
const DEG = Math.PI / 180;

function frames(sim: Simulation): CameraGridFrame[] {
  const f = cameraGridFrame();
  f.grid = sim.world;
  return [f];
}

function sceneOf(sim: Simulation): CameraScene {
  return { world: sim.world, structures: () => [] as unknown as ReturnType<CameraScene['structures']> };
}

function shown(x: number, y: number, z: number, yaw: number, pitch: number): ShownPlayer {
  const s = shownPlayer();
  s.feet.x = x;
  s.feet.y = y;
  s.feet.z = z;
  s.yaw = yaw;
  s.pitch = pitch;
  return s;
}

/** The blocking octant boxes of the grid around a point (independent of BOXES: one box per octant). */
function octantBoxes(grid: VoxelGrid, p: Vec3, r: number): number[][] {
  const out: number[][] = [];
  for (let y = Math.floor(p.y - r) - 1; y <= Math.floor(p.y + r) + 1; y++) {
    for (let z = Math.floor(p.z - r) - 1; z <= Math.floor(p.z + r) + 1; z++) {
      for (let x = Math.floor(p.x - r) - 1; x <= Math.floor(p.x + r) + 1; x++) {
        const f = blockingOctants(grid, blocksCamera, x, y, z);
        for (let o = 0; o < 8; o++) {
          if (((f >> o) & 1) === 0) continue;
          const x0 = x + (o & 1) * 0.5;
          const y0 = y + ((o >> 1) & 1) * 0.5;
          const z0 = z + ((o >> 2) & 1) * 0.5;
          out.push([x0, y0, z0, x0 + 0.5, y0 + 0.5, z0 + 0.5]);
        }
      }
    }
  }
  return out;
}

/** Brute force: the largest per-axis gap from p to the nearest box (capped at range). */
function bruteClearance(boxes: number[][], p: Vec3, range: number): number {
  let best = range;
  for (const b of boxes) best = Math.min(best, Math.max(b[0]! - p.x, p.x - b[3]!, b[1]! - p.y, p.y - b[4]!, b[2]! - p.z, p.z - b[5]!, 0));
  return best;
}

/** Brute force: how far a cube of half-size h moves from o along d before overlapping a box (max when none; -1 when overlapping at o). */
function bruteSweep(boxes: number[][], o: Vec3, d: Vec3, max: number, h: number): number {
  let best = max;
  for (const b of boxes) {
    let enter = -Infinity;
    let exit = Infinity;
    let miss = false;
    for (let a = 0; a < 3; a++) {
      const oa = [o.x, o.y, o.z][a]!;
      const da = [d.x, d.y, d.z][a]!;
      const lo = b[a]! - h;
      const hi = b[a + 3]! + h;
      if (Math.abs(da) < 1e-12) {
        if (oa <= lo || oa >= hi) miss = true;
        continue;
      }
      const t1 = Math.min((lo - oa) / da, (hi - oa) / da);
      const t2 = Math.max((lo - oa) / da, (hi - oa) / da);
      enter = Math.max(enter, t1);
      exit = Math.min(exit, t2);
    }
    if (miss || enter >= exit || exit <= 0 || enter >= best) continue;
    if (enter < 0) return -1;
    best = enter;
  }
  return best;
}

describe('camera clearance and sweep over partial cells (docs/SHAPES.md 8.6)', () => {
  it('blockingOctants: the octants of the parts that block the camera; whole blocks 0xff; soft blocks and liquids 0', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(1, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)));
    w.setCell(2, T, 1, slab(B.PLANKS_OAK, WEST));
    w.setCell(3, T, 1, makeCell(B.TORCH));
    w.setCell(4, T, 1, makeCell(B.WATER));
    expect(blockingOctants(w, blocksCamera, 1, T, 1)).toBe(0xff); // glass is hard: it blocks too
    expect(blockingOctants(w, blocksCamera, 2, T, 1)).toBe(WEST);
    expect(blockingOctants(w, blocksCamera, 3, T, 1)).toBe(0);
    expect(blockingOctants(w, blocksCamera, 4, T, 1)).toBe(0);
    expect(blockingOctants(w, blocksCamera, 1, T - 1, 1)).toBe(0xff);
  });

  it('random partial cells: clearanceAt and sweepGrids equal a brute force over octants', () => {
    const sim = flatSim();
    const w = sim.world;
    const rng = new Rng(23);
    const ids = [B.STONE, B.PLANKS_OAK, B.GLASS];
    for (let y = T; y < T + 5; y++) {
      for (let z = -3; z < 4; z++) {
        for (let x = -3; x < 4; x++) {
          const r = rng.next();
          if (r < 0.55) continue;
          if (r < 0.62) w.setCell(x, y, z, makeCell(B.STONE));
          else if (r < 0.66) w.setCell(x, y, z, makeCell(B.TORCH));
          else {
            const f = rng.int(1, 254);
            const a = slab(ids[rng.int(0, ids.length - 1)]!, f);
            const rest = ~f & 0xff;
            // Now and then a second part in some of the free octants.
            const g = rest & rng.int(1, 255);
            w.setCell(x, y, z, g !== 0 && rng.next() < 0.5 ? canonCell(a, slab(ids[rng.int(0, ids.length - 1)]!, g)) : a);
          }
        }
      }
    }
    const fr = frames(sim);
    const scratch = sweepScratch();
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const p = vec3(-2 + rng.next() * 5, T + 0.5 + rng.next() * 3.5, -2 + rng.next() * 5);
      const boxes = octantBoxes(w, p, 1);
      expect(clearanceAt(fr, 1, blocksCamera, p, 1, scratch)).toBeCloseTo(bruteClearance(boxes, p, 1), 9);
      const th = rng.next() * Math.PI * 2;
      const ph = (rng.next() - 0.5) * Math.PI;
      const d = vec3(Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph));
      const boxesPath = octantBoxes(w, p, 2.5);
      const got = sweepGrids(fr, 1, blocksCamera, p, d, 2, 0.25, false, scratch);
      const want = bruteSweep(boxesPath, p, d, 2, 0.25);
      if (want < 0) expect(got).toBeLessThan(0);
      else expect(got).toBeCloseTo(want, 9);
      if (want >= 0 && want < 2) hits++;
    }
    expect(hits).toBeGreaterThan(50); // the cases exercise contacts, not open space only
  });

  it('under a ceiling of upper half slabs the camera uses the gap: it keeps the clearance from the slabs, not from the cells', () => {
    const sim = flatSim();
    const ceil = T + 3;
    fill(sim.world, -8, ceil, -8, 8, ceil, 8, slab(B.STONE, UPPER)); // the underside is at ceil + 0.5
    const v = new ViewBuilder();
    // Looking down steeply: 'back' pulls the camera up behind the head into the ceiling.
    const cam = v.updateCamera(sceneOf(sim), shown(0.5, T, 0.5, 0, -70 * DEG), 70, 0.05, 'back');
    expect(cam.y).toBeLessThanOrEqual(ceil + 0.5 - CAMERA_CLEARANCE + 1e-6);
    // The whole cell would have stopped it 0.5 lower.
    expect(cam.y).toBeGreaterThan(ceil - CAMERA_CLEARANCE + 0.4);
    // Whole blocks at the same height: stopped at the cell boundary, as always.
    const full = flatSim();
    fill(full.world, -8, ceil, -8, 8, ceil, 8, B.STONE);
    const cam2 = new ViewBuilder().updateCamera(sceneOf(full), shown(0.5, T, 0.5, 0, -70 * DEG), 70, 0.05, 'back');
    expect(cam2.y).toBeLessThanOrEqual(ceil - CAMERA_CLEARANCE + 1e-6);
  });

  it('beside a wall of vertical half slabs the camera keeps the clearance from the slab face (half a block further in)', () => {
    const sim = flatSim();
    // Cells x = 1, their east half filled: the wall face is at x = 1.5.
    fill(sim.world, 1, T, -12, 1, T + 6, 12, slab(B.STONE, EAST));
    const v = new ViewBuilder();
    // The player 0.6 from the slab face, looking north (-Z): the right shoulder is toward +X.
    const cam = v.updateCamera(sceneOf(sim), shown(0.9, T, 0.5, 0, 0), 70, 0.05, 'back');
    expect(cam.x).toBeLessThanOrEqual(1.5 - CAMERA_CLEARANCE + 1e-6);
    expect(cam.x).toBeGreaterThan(1 - CAMERA_CLEARANCE + 1e-6); // the cell boundary would allow less
    // The back distance is the full one: nothing behind.
    expect(Math.hypot(cam.z - 0.5, cam.y - (T + 1.62))).toBeGreaterThan(THIRD_PERSON_DISTANCE - 0.5);
  });

  it("'front' looks through the open half of a slab cell (the ray walks octants)", () => {
    const sim = flatSim();
    // A lower slab right in front of the face, at eye height: the ray at eye height passes above it.
    sim.world.setCell(0, T + 1, -1, slab(B.STONE, LOWER)); // occupies T+1 .. T+1.5; eye at T + 1.62
    const v = new ViewBuilder();
    const cam = v.updateCamera(sceneOf(sim), shown(0.5, T, 0.5, 0, 0), 70, 0.05, 'front');
    expect(cam.z).toBeLessThan(-3); // not stopped by the slab cell at z = -1
    sim.world.setCell(0, T + 1, -1, slab(B.STONE, UPPER)); // now in the way
    const cam2 = new ViewBuilder().updateCamera(sceneOf(sim), shown(0.5, T, 0.5, 0, 0), 70, 0.05, 'front');
    expect(cam2.z).toBeGreaterThan(-0.5);
  });
});

/** A body for updateStepLag: at its last client tick, and its shown feet (world, no carrier). */
function body(tick: number, carrierId: number, tickY: number, onGround: boolean, shownY: number): StepSample {
  return { tick, carrierId, tickY, onGround, feet: vec3(0, shownY, 0) };
}

describe('the step offset (docs/SHAPES.md 5.7)', () => {
  /**
   * A body walking onto a half slab at tick 10 (rising 0.5 within that tick), shown as the client
   * shows it: between its last two ticks, at 60 frames a second (20 ticks a second). Returns the
   * eye height per frame (feet as shown + the offset) and the offsets.
   */
  function walkUp(rise: number, groundAfter: boolean, groundBefore = true, frames = 60): { eye: number[]; lag: number[] } {
    const s = stepLagState();
    const eye: number[] = [];
    const lag: number[] = [];
    const yAt = (tick: number): number => (tick >= 10 ? rise : 0);
    for (let f = 0; f < frames; f++) {
      const t = f / 3; // ticks
      const tick = Math.floor(t);
      const alpha = t - tick;
      const shownY = yAt(tick - 1) + (yAt(tick) - yAt(tick - 1)) * alpha;
      const onGround = tick < 10 ? groundBefore : groundAfter;
      updateStepLag(s, body(tick, 0, yAt(tick), onGround, shownY), null, 1 / 60);
      const v = s.value;
      lag.push(v);
      eye.push(shownY + v);
    }
    return { eye, lag };
  }

  it('stepping up half a block: the eyes never drop, rise more gently than the body, and reach the new height', () => {
    const { eye, lag } = walkUp(0.5, true);
    let maxStep = 0;
    for (let i = 1; i < eye.length; i++) {
      expect(eye[i]!).toBeGreaterThanOrEqual(eye[i - 1]! - 1e-12);
      maxStep = Math.max(maxStep, eye[i]! - eye[i - 1]!);
    }
    // Without the offset the shown body rises 0.5 / 3 per frame during the step's tick.
    expect(maxStep).toBeLessThan(0.5 / 3 * 0.75);
    expect(Math.min(...lag)).toBeLessThan(-0.1);
    expect(eye[eye.length - 1]!).toBeCloseTo(0.5, 3);
    for (const l of lag) {
      expect(l).toBeLessThanOrEqual(0);
      expect(l).toBeGreaterThanOrEqual(-STEP_LAG_MAX);
    }
  });

  it('a jump (not on the ground after), a rise too big for a step, or too small: no offset', () => {
    expect(Math.min(...walkUp(0.5, false).lag)).toBe(0);
    expect(Math.min(...walkUp(0.5, true, false).lag)).toBe(0);
    expect(Math.min(...walkUp(0.62, true).lag)).toBe(0);
    expect(Math.min(...walkUp(0.04, true).lag)).toBe(0);
    expect(Math.min(...walkUp(0.6, true).lag)).toBeLessThan(0); // STEP_HEIGHT itself is a step
  });

  it('decays by exp(-dt / STEP_LAG_TIME) per frame, measured relative to the carrier (a new carrier forgets the step)', () => {
    const s = stepLagState();
    updateStepLag(s, body(1, 0, 0, true, 0), null, 0.01);
    updateStepLag(s, body(2, 0, 0.5, true, 0), null, 0.01); // a step at tick 2, nothing shown yet
    expect(s.value).toBe(0);
    updateStepLag(s, body(2, 0, 0.5, true, 0.5), null, 0.01); // shown at once
    expect(s.value).toBeCloseTo(-0.5, 12);
    updateStepLag(s, body(2, 0, 0.5, true, 0.5), null, 0.03);
    expect(s.value).toBeCloseTo(-0.5 * Math.exp(-0.03 / STEP_LAG_TIME), 12);
    // Boarding a ship: the rise across the carrier change is not a step.
    const b = stepLagState();
    updateStepLag(b, body(1, 0, 0, true, 0), null, 0.01);
    updateStepLag(b, body(2, 7, 0.5, true, 0.5), null, 0.01);
    expect(b.value).toBe(0);
    // No prediction (loading): nothing.
    const c = stepLagState();
    updateStepLag(c, body(Number.NEGATIVE_INFINITY, 0, 0, true, 0), null, 0.01);
    expect(c.value).toBe(0);
  });

  it('the view builder lowers the first-person eyes by the offset, by what the display has shown of the step', () => {
    const sim = flatSim();
    const v = new ViewBuilder();
    const me = shown(0.5, T, 0.5, 0, 0);
    me.onGround = true;
    me.tick = 1;
    me.tickY = T;
    v.updateCamera(sceneOf(sim), me, 70, 1 / 60, 'first');
    me.tick = 2;
    me.tickY = T + 0.5;
    me.feet.y = T + 0.25; // half of the step shown
    const cam = v.updateCamera(sceneOf(sim), me, 70, 1 / 60, 'first');
    expect(cam.y).toBeCloseTo(T + 1.62, 9); // the eyes have not moved yet
    expect(v.eyePos.y).toBeCloseTo(T + 1.62, 9);
    me.feet.y = T + 0.5;
    const later = v.updateCamera(sceneOf(sim), me, 70, 1 / 60, 'first');
    expect(later.y).toBeGreaterThan(T + 1.62);
    expect(later.y).toBeLessThan(T + 0.5 + 1.62);
  });

  it('two steps on consecutive ticks: the offset is clamped at -STEP_LAG_MAX', () => {
    const s = stepLagState();
    updateStepLag(s, body(1, 0, 0, true, 0), null, 0.001);
    updateStepLag(s, body(2, 0, 0.5, true, 0.5), null, 0.001);
    expect(s.value).toBeCloseTo(-0.5, 12);
    updateStepLag(s, body(3, 0, 1, true, 1), null, 0.001);
    // Unclamped it would be -0.5 * exp(-0.001 / 0.06) - 0.5, about -0.99.
    expect(-0.5 * Math.exp(-0.001 / STEP_LAG_TIME) - 0.5).toBeLessThan(-STEP_LAG_MAX - 0.3);
    expect(s.value).toBe(-STEP_LAG_MAX);
  });

  it('rise of a step the display has not shown within two ticks is dropped (a later rise of the display is not taken as the step)', () => {
    const s = stepLagState();
    updateStepLag(s, body(1, 0, 0, true, 0), null, 0.001);
    updateStepLag(s, body(2, 0, 0.5, true, 0), null, 0.001); // the step, nothing shown
    updateStepLag(s, body(3, 0, 0.5, true, 0), null, 0.001); // still nothing shown
    expect(s.value).toBe(0);
    updateStepLag(s, body(4, 0, 0.5, true, 0.5), null, 0.001); // the display jumps two ticks later (a correction)
    expect(s.value).toBe(0);
    // Within the two ticks it is taken.
    const t = stepLagState();
    updateStepLag(t, body(1, 0, 0, true, 0), null, 0.001);
    updateStepLag(t, body(2, 0, 0.5, true, 0), null, 0.001);
    updateStepLag(t, body(3, 0, 0.5, true, 0.5), null, 0.001);
    expect(t.value).toBeCloseTo(-0.5, 12);
  });

  /** A shown player at (0.5, y, 0.5) whose last tick (2) ended a step of `rise` from tick 1 (0 = no step), the step shown in full. */
  function steppedCamera(v: ViewBuilder, sim: Simulation, y: number, rise: number, yaw: number, pitch: number, mode: 'back' | 'front'): { cam: { x: number; y: number; z: number }; me: ShownPlayer } {
    const me = shown(0.5, y - rise, 0.5, yaw, pitch);
    me.onGround = true;
    me.tick = 1;
    me.tickY = y - rise;
    v.updateCamera(sceneOf(sim), me, 70, 0.001, mode);
    me.tick = 2;
    me.tickY = y;
    me.feet.y = y;
    const c = v.updateCamera(sceneOf(sim), me, 70, 0.001, mode);
    return { cam: { x: c.x, y: c.y, z: c.z }, me };
  }

  it("the third-person anchor gets the offset too, in 'back' and in 'front' (docs/SHAPES.md 5.7)", () => {
    const sim = flatSim();
    for (const mode of ['back', 'front'] as const) {
      const lagged = new ViewBuilder();
      const plain = new ViewBuilder();
      const a = steppedCamera(lagged, sim, T, 0.5, 0.4, -10 * DEG, mode).cam;
      const b = steppedCamera(plain, sim, T, 0, 0.4, -10 * DEG, mode).cam;
      const lag = lagged.eyePos.y - (T + 1.62);
      expect(lag, mode).toBeCloseTo(-0.5, 9); // taken as shown, after this frame's decay
      expect(plain.eyePos.y, mode).toBeCloseTo(T + 1.62, 12);
      // Open air: the whole placement moves with the anchor.
      expect(a.y, mode).toBeCloseTo(b.y + lag, 9);
      expect(a.x, mode).toBeCloseTo(b.x, 9);
      expect(a.z, mode).toBeCloseTo(b.z, 9);
    }
  });

  it('the self model is shown or hidden by the gap from the eyes without the offset (the model stands at the shown feet)', () => {
    // A stone ceiling with its underside at T + 3; looking down, the 'back' camera presses against
    // it above the head. The feet rise through a block in small steps.
    const sim = flatSim();
    fill(sim.world, -6, T + 3, -6, 6, T + 3, 6, B.STONE);
    const scene = { ...sceneOf(sim), entities: () => [], state: { structures: new Map() } } as unknown as Parameters<ViewBuilder['updateEntities']>[0];
    let differs = 0;
    let shownCount = 0;
    for (let k = 0; k < 50; k++) {
      const y = T + k * 0.02;
      const v = new ViewBuilder();
      const { cam, me } = steppedCamera(v, sim, y, 0.5, 0.3, -70 * DEG, 'back');
      const lag = v.eyePos.y - (y + 1.62);
      expect(lag).toBeLessThan(-0.4);
      const eye = vec3(me.feet.x, me.feet.y + me.eyeHeight, me.feet.z);
      const laggedEye = vec3(eye.x, eye.y + lag, eye.z);
      const expected = selfModelGap(cam.x, cam.y, cam.z, eye, me.yaw, me.eyeHeight) >= SELF_HIDE_CLEARANCE;
      const fromLagged = selfModelGap(cam.x, cam.y, cam.z, laggedEye, me.yaw, me.eyeHeight) >= SELF_HIDE_CLEARANCE;
      if (expected !== fromLagged) differs++;
      if (expected) shownCount++;
      const self = v.updateEntities(scene, me, 0, 0).some((e) => e.id === me.id);
      expect(self, `feet ${y.toFixed(2)}`).toBe(expected);
    }
    // The scan has heights where the offset decides it, and both outcomes.
    expect(differs).toBeGreaterThan(0);
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThan(50);
  });
});
