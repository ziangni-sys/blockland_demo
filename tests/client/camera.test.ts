import { describe, expect, it } from 'vitest';
import { facingState, ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import {
  cameraPose,
  nextViewMode,
  placeCamera,
  SELF_HIDE_DISTANCE,
  THIRD_PERSON_DISTANCE,
  THIRD_PERSON_MARGIN,
  type CameraRay,
} from '../../src/client/camera';
import { BUTTON_PICK, InputState, isGameKey } from '../../src/client/input';
import { blocksCamera, ViewBuilder } from '../../src/client/view';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from '../sim/helpers';

const nothing: CameraRay = () => Infinity;
const eye = { x: 10, y: 50, z: -3 };

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

describe('placeCamera', () => {
  const dir = vec3();

  it('first person: at the eye, with the look angles', () => {
    const out = placeCamera('first', eye, 0.3, -0.2, () => {
      throw new Error('no ray in first person');
    }, cameraPose(), dir);
    expect(out).toEqual({ x: 10, y: 50, z: -3, yaw: 0.3, pitch: -0.2, distance: 0 });
  });

  it('behind: on the line through the eye against the look direction, same angles', () => {
    // yaw 0 looks toward -Z: the camera goes to +Z.
    const out = placeCamera('back', eye, 0, 0, nothing, cameraPose(), dir);
    expect(out.x).toBeCloseTo(10, 12);
    expect(out.y).toBeCloseTo(50, 12);
    expect(out.z).toBeCloseTo(-3 + THIRD_PERSON_DISTANCE, 12);
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
    expect(out.distance).toBe(THIRD_PERSON_DISTANCE);
    // Looking down 45 degrees: the camera rises behind the head.
    const o2 = placeCamera('back', eye, 0, -Math.PI / 4, nothing, cameraPose(), dir);
    expect(o2.y).toBeCloseTo(50 + THIRD_PERSON_DISTANCE * Math.SQRT1_2, 12);
    expect(o2.z).toBeCloseTo(-3 + THIRD_PERSON_DISTANCE * Math.SQRT1_2, 12);
  });

  it('front: along the look direction, turned around to face the player', () => {
    const out = placeCamera('front', eye, Math.PI / 2, 0.4, nothing, cameraPose(), dir);
    // yaw PI/2 looks toward -X.
    const cp = Math.cos(0.4);
    expect(out.x).toBeCloseTo(10 - THIRD_PERSON_DISTANCE * cp, 12);
    expect(out.y).toBeCloseTo(50 + THIRD_PERSON_DISTANCE * Math.sin(0.4), 12);
    expect(out.z).toBeCloseTo(-3, 12);
    expect(out.yaw).toBeCloseTo(-Math.PI / 2, 12);
    expect(out.pitch).toBeCloseTo(-0.4, 12);
    // The camera's own forward points back at the eye.
    const f = { x: -Math.sin(out.yaw) * Math.cos(out.pitch), y: Math.sin(out.pitch), z: -Math.cos(out.yaw) * Math.cos(out.pitch) };
    expect(out.x + f.x * out.distance).toBeCloseTo(eye.x, 9);
    expect(out.y + f.y * out.distance).toBeCloseTo(eye.y, 9);
    expect(out.z + f.z * out.distance).toBeCloseTo(eye.z, 9);
  });

  it('is pulled in by the ray, keeping the margin; never behind the eye', () => {
    let asked = 0;
    const wall: CameraRay = (_o, d, max) => {
      asked = max;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
      return 2;
    };
    const out = placeCamera('back', eye, 0, 0, wall, cameraPose(), dir);
    expect(asked).toBeGreaterThanOrEqual(THIRD_PERSON_DISTANCE);
    expect(out.distance).toBeCloseTo(2 - THIRD_PERSON_MARGIN, 12);
    expect(out.z).toBeCloseTo(-3 + 2 - THIRD_PERSON_MARGIN, 12);
    const close = placeCamera('back', eye, 0, 0, () => 0.1, cameraPose(), dir);
    expect(close.distance).toBe(0);
    expect(close.z).toBe(-3);
    // A hit just beyond the full distance (within the margin) still pulls the camera in.
    const edge = placeCamera('back', eye, 0, 0, () => THIRD_PERSON_DISTANCE + THIRD_PERSON_MARGIN / 2, cameraPose(), dir);
    expect(edge.distance).toBeCloseTo(THIRD_PERSON_DISTANCE - THIRD_PERSON_MARGIN / 2, 12);
    // Garbage from the ray counts as "nothing in the way".
    expect(placeCamera('back', eye, 0, 0, () => Number.NaN, cameraPose(), dir).distance).toBe(THIRD_PERSON_DISTANCE);
  });
});

describe('ViewBuilder third person', () => {
  it('never puts the camera inside a block of the world; draws the local player only in third person', () => {
    const sim = flatSim();
    const w = sim.world;
    // A wall 2 blocks behind the player (south, +Z), the player looking north.
    fill(w, -3, FLAT_TOP, 2, 3, FLAT_TOP + 4, 2, B.STONE);
    sim.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const v = new ViewBuilder();
    const p = sim.player;

    v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'first');
    expect(v.updateEntities(sim, 1).some((e) => e.id === p.id)).toBe(false);

    const cam = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    const cell = w.getCell(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    expect(SOLID[cell & ID_MASK]).toBe(0);
    expect(cam.z).toBeLessThan(2 - THIRD_PERSON_MARGIN + 1e-9);
    expect(cam.z).toBeGreaterThan(p.pos.z + SELF_HIDE_DISTANCE);
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

    // Back against the wall: the camera would be inside the head, so the model is left out.
    sim.teleport(0.5, FLAT_TOP, 1.5);
    sim.lookAt(0.5, FLAT_TOP + 1.62, -10);
    sim.tick();
    const c2 = v.updateCamera(sim, 1, p.yaw, p.pitch, 70, 0.05, 'back');
    expect(c2.z).toBeLessThanOrEqual(2 - THIRD_PERSON_MARGIN + 1e-9);
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
    }
    // Behind the helmsman is the stern wall (a ship cell): the camera stays in front of it.
    const back = v.updateCamera(sim, 1, p.yaw, 0, 70, 0.05, 'back');
    const local = ship.grid.toLocal(vec3(back.x, back.y, back.z), vec3());
    expect(local.z).toBeLessThan(5);
  });
});
