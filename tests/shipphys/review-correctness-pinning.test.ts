/**
 * Regression tests from the adversarial review (correctness lens) of the pinning rules —
 * ACCEPTANCE 15/16, LESSONS 能动的船被误判压坏 / 船被转子硬推进地形, brief: "A ship that can still
 * slide away along the wall is not pinned" and "every rotor ... is an infinitely heavy moving
 * obstacle". Each block failed before the fix it is named after:
 *  - oblique blades destroyed cells of a boat sliding away along a wall (the pin test took its
 *    direction from the post-solve relative velocity; now the blade's own motion, see pinning.ts);
 *  - a blade passed through a boat wedged against another ship (ship supports were ignored);
 *  - a tip grazing a boat flung it (sweep-biased exit faces; now the graze rule in contacts.ts);
 *  - a ship resting on a stopped rotor never slept.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3, type Vec3 } from '../../src/core/math';
import type { Rotor } from '../../src/structures/structure';
import {
  fillWorld,
  launch,
  makeSea,
  makeWorld,
  newRotor,
  newShip,
  plankBoat,
  pointsIntoHull,
  setup,
  shipBox,
  spinRotor,
  terrainPenetration,
  tick,
} from './helpers';

/** Vertical-axis blade like rotor.test.ts: hub (hx,47,hz), 7-long 4-tall plate pointing east at angle 0. */
function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startDeg: number, id = 100): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + 7; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, id, hx, 47, hz, PY, cells);
  r.angle = (startDeg * Math.PI) / 180;
  qfromAxisAngle(vec3(0, 1, 0), r.angle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

function rotorCorners(r: Rotor): Vec3[] {
  const out: Vec3[] = [];
  r.grid.forEachCell((x, y, z) => {
    for (let k = 0; k < 8; k++) out.push(r.grid.toWorld(vec3(x + (k & 1), y + ((k >> 1) & 1), z + (k >> 2))));
  });
  return out;
}

describe('review: pinning must not destroy a ship that slides away along a wall', () => {
  // Long west wall (face x = -3), boat against it. The hub is east / south-east of the boat, so the
  // blade reaches the boat moving mostly SOUTH, along the wall: at first contact its velocity is
  // 50..62 degrees away from the wall normal, far outside the 25-degree "almost exactly opposed"
  // cone. The boat does slide away along the wall (13+ blocks) — yet cells are destroyed.
  for (const [hx, hz] of [
    [6, -3],
    [3, -4],
    [4, -4],
  ] as const) {
    it(`hub (${hx}, ${hz}): no cell is destroyed, the boat glides along the wall`, () => {
      const world = makeSea();
      fillWorld(world, -6, 36, -30, -4, 52, 30, B.STONE);
      const { dyn, host } = setup(world);
      const boat = launch(plankBoat(world, 1, -3, 46, -6, 3, 3), dyn);
      const cells = boat.grid.count;
      const rotor = blade(world, hx, hz, 100);
      const z0 = boat.grid.position.z;
      let contacts = 0;
      let maxWallPen = 0;
      for (let t = 0; t < 70; t++) {
        tick(dyn, [boat], [rotor], 1);
        contacts += dyn.getStats(boat)!.rotorContacts;
        if (boat.grid.count > 0) maxWallPen = Math.max(maxWallPen, terrainPenetration(world, boat));
      }
      expect(contacts).toBeGreaterThan(0);
      // the scenario really is a glide: the boat ends up far down the wall ...
      expect(boat.grid.position.z - z0).toBeGreaterThan(5);
      expect(maxWallPen).toBeLessThan(0.1);
      // ... so it was never pinned and must be intact (currently 1-2 cells are destroyed)
      expect(host.drops).toHaveLength(0);
      expect(boat.grid.count).toBe(cells);
    });
  }
});

describe('review: a blade must not pass through a ship wedged against another ship', () => {
  // Boat A sits between the blade and boat B; B is held (frozen, or pressed against a quay wall).
  // A cannot move away, the solver gives ship/ship contacts priority over the rotor, and pinning
  // only accepts TERRAIN (or other rotors) as support — so A is neither pushed nor pinned and the
  // blade sweeps straight through its hull (overlap ~0.95-0.98 block, no cell destroyed).
  for (const variant of ['B frozen', 'B against a quay wall'] as const) {
    it(`${variant}: the blade either pushes A or breaks A's overlapping cells`, () => {
      const world = makeSea();
      if (variant === 'B against a quay wall') fillWorld(world, -16, 36, -20, -13, 52, 10, B.STONE); // face x = -12
      const { dyn } = setup(world);
      const b =
        variant === 'B frozen'
          ? launch(plankBoat(world, 2, -9, 46, -8, 6, 6), dyn) // x in [-9, -3)
          : launch(plankBoat(world, 2, -12, 46, -9, 9, 9), dyn); // x in [-12, -3), against the wall
      const a = launch(plankBoat(world, 1, -3, 46, -6, 3, 3), dyn); // x in [-3, 0), touching B
      const aCells = a.grid.count;
      if (variant === 'B frozen') b.frozen = true;
      const rotor = blade(world, 0, 0, 80);
      let maxOverlap = 0;
      for (let t = 0; t < 60; t++) {
        a.grid.snapshotPose();
        b.grid.snapshotPose();
        spinRotor(rotor, 1);
        dyn.step([a, b], [rotor]);
        if (a.grid.count === aCells) maxOverlap = Math.max(maxOverlap, pointsIntoHull(a, rotorCorners(rotor)));
      }
      const aDestroyed = aCells - a.grid.count;
      // An infinitely heavy blade cannot be inside a ship's hull by most of a block unless that ship is
      // being broken (pinning). Currently: overlap ~0.95+ while A loses nothing.
      expect(maxOverlap < 0.5 || aDestroyed > 0).toBe(true);
    });
  }
});

describe('review: a blade tip brushing a boat must not kick it (LESSONS 叶片侧面擦过船时船被猛踢)', () => {
  // The blade (radius 7.5 to its end face) points north at 90 deg and sweeps west at ~7.4 blocks/s.
  // A free floating boat is placed so that the tip's end face overlaps its south face by only 0.1
  // block. The sweep-biased exit face (the hull's east face, 0.19 away) is chosen instead of the
  // 0.1-deep radial one, and the velocity constraint along it hands the boat most of the tip speed:
  // 5.7 blocks/s from a 0.1-block graze (0.6 blocks/s from a 0.02 graze).
  it('a 0.1-block graze by the tip gives the boat only a small push', () => {
    const graze = 0.1;
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -1, 46, -11, 3, 3), dyn); // x in [-1, 2), south face z = -8
    for (let t = 0; t < 60; t++) tick(dyn, [boat]);
    boat.grid.position.z += -7 + graze - -8; // south face at z = -7 + graze
    boat.grid.snapshotPose();
    dyn.wake(boat);
    const rotor = blade(world, 0, 0, 45);
    let contacts = 0;
    let maxSpeed = 0;
    for (let t = 0; t < 60; t++) {
      tick(dyn, [boat], [rotor], 1);
      contacts += dyn.getStats(boat)!.rotorContacts;
      const v = boat.grid.linearVelocity;
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));
    }
    expect(contacts).toBeGreaterThan(0);
    // tip speed ~7.5 blocks/s; a graze this shallow must not hand over a third of it
    expect(maxSpeed).toBeLessThan(2.5);
  });
});

describe('review: sleep next to a stopped rotor', () => {
  it('a ship resting on a STOPPED rotor blade comes to rest and falls asleep', () => {
    // Spec: sleep after ~2 s below the thresholds while supported; only a rotor that moves should
    // keep it awake. Currently any rotor contact (even a stopped blade) resets restTicks forever.
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 50, waterTop: 0 });
    const { dyn } = setup(world);
    const cells: Array<[number, number, number]> = [[0, 55, 0]];
    for (let x = -4; x <= 4; x++) for (let z = -1; z <= 1; z++) cells.push([x, 55, z]);
    const rotor = newRotor(world, 50, 0, 55, 0, PY, cells); // a stopped horizontal plate, top at y = 56
    const s = newShip(world, 1);
    shipBox(s, -2, 58, -1, 2, 58, 1, B.PLANKS_OAK);
    launch(s, dyn);
    for (let t = 0; t < 400; t++) tick(dyn, [s], [rotor], 0);
    const v = s.grid.linearVelocity;
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.01); // it IS at rest on the blade ...
    expect(s.asleep).toBe(true); // ... but never sleeps
  });
});
