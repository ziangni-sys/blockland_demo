/**
 * Adversarial review (robustness lens): rotor pinning and rotor-driven ship/ship contacts.
 *
 * These tests FAIL against the current implementation; they are left in place for the fixer.
 *
 *  1. A blade sweeping a boat DIAGONALLY along a long quay wall (blade velocity 35-55 degrees
 *     away from the wall normal, far outside the 25-degree "almost exactly opposed" cone) must
 *     not count as pinned: the boat slides freely along the wall (it travels 10-20 blocks), yet
 *     the current code destroys a hull cell every tick (9-12 of the boat's 18 cells). This is
 *     exactly LESSONS "能动的船被误判压坏". Root cause (traced): the sequential-impulse solve has
 *     not converged in this wedge configuration (terrain gets the last word, the boat ends with a
 *     tangential speed well below what the 38-degree blade face demands), so condition (1) sees a
 *     large residual press; condition (2) then uses the direction of the RELATIVE velocity, which
 *     points almost straight into the wall once the boat slides along it, and so is "opposed" by
 *     the wall normal. The push direction (the contact normal, about 38 degrees from the wall
 *     normal) is never compared with the terrain normal.
 *     Checked in a patched scratch copy of the module: feeding condition (2) the blade's OWN
 *     velocity direction at the contact (F_VO / |F_VO|) instead of the relative velocity removes
 *     every false pin here (0 cells lost for starts 110/120/130 deg) while the corner-pinning
 *     cases of rotor.test.ts still break cells (14 at 1 rad/s, 18 at 0.1 rad/s). Using the contact
 *     normal instead only reduces the damage (9 -> 6..9 cells), because rotor-corner-in-hull
 *     contacts carry the hull's face normal, which points straight into the wall.
 *
 *  2. A blade pushing an outer boat against an inner boat that is moored at a wall drives the
 *     outer hull ~0.9 block into the inner one (the module's own ship/ship test bounds overlap at
 *     0.3). Pinning only counts terrain and other rotors as support, never a ship that terrain
 *     holds, and rotor contacts are solved before ship contacts, so the infinitely strong blade
 *     squeezes the two hulls into each other.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ, PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import { fillWorld, finite, hullSamplePoints, launch, makeSea, newRotor, plankBoat, setup, terrainPenetration, tick } from './helpers';

/** Vertical-axis rotor (axis +Y), hub cell (hx,47,hz), a `len`-long 4-tall blade plate pointing east at angle 0. */
function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startDeg: number, len: number): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + len; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = (startDeg * Math.PI) / 180;
  qfromAxisAngle(vec3(0, 1, 0), r.angle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

/** Deepest sample point of `a` inside a hard cell of `b`, measured to the nearest open face along the 6 axes. */
function shipOverlap(a: Ship, b: Ship): number {
  let worst = 0;
  const w = vec3();
  const l = vec3();
  const solid = (x: number, y: number, z: number) => SOLID[b.grid.getCell(x, y, z) & ID_MASK] === 1;
  const axes = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const;
  for (const p of hullSamplePoints(a)) {
    a.grid.toWorld(p, w);
    b.grid.toLocal(w, l);
    const cx = Math.floor(l.x);
    const cy = Math.floor(l.y);
    const cz = Math.floor(l.z);
    if (!solid(cx, cy, cz)) continue;
    let best = 3;
    for (const [dx, dy, dz] of axes) {
      for (let k = 1; k <= 3; k++) {
        if (!solid(cx + dx * k, cy + dy * k, cz + dz * k)) {
          const f = dx > 0 ? cx + 1 - l.x : dx < 0 ? l.x - cx : dy > 0 ? cy + 1 - l.y : dy < 0 ? l.y - cy : dz > 0 ? cz + 1 - l.z : l.z - cz;
          best = Math.min(best, f + (k - 1));
          break;
        }
      }
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('review: a boat swept diagonally along a quay wall is not pinned (LESSONS 能动的船被误判压坏)', () => {
  for (const [startDeg, speed] of [
    [110, 1],
    [120, 1],
    [120, 0.4],
  ] as const) {
    it(`blade starting at ${startDeg} deg, ${speed} rad/s: the boat slides along the wall and loses no cell`, () => {
      const world = makeSea();
      fillWorld(world, -9, 36, -40, -7, 52, 40, B.STONE); // long quay wall, face x = -6
      const { dyn, host } = setup(world);
      const boat = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn); // x in [-6,-3): touching the wall
      const cells = boat.grid.count;
      // Hub south-east of the boat; the blade turns counter-clockwise (seen from above) from
      // north-north-west toward west, so at the boat it moves south-west: 35-55 degrees off the
      // wall normal. The boat can (and does) escape by sliding south along the wall.
      const rotor = blade(world, 0, 0, startDeg, 8);
      const z0 = boat.grid.position.z;
      let pinned = 0;
      let contacts = 0;
      let wallPen = 0;
      const ticks = Math.ceil(80 / speed);
      for (let t = 0; t < ticks; t++) {
        tick(dyn, [boat], [rotor], speed);
        const st = dyn.getStats(boat)!;
        pinned += st.pinned;
        contacts += st.rotorContacts;
        wallPen = Math.max(wallPen, terrainPenetration(world, boat, hullSamplePoints(boat)));
      }
      expect(finite(boat)).toBe(true);
      expect(contacts).toBeGreaterThan(0); // the blade did push the boat
      expect(boat.grid.position.z - z0).toBeGreaterThan(3); // ... and the boat escaped along the wall
      expect(wallPen).toBeLessThan(0.1);
      // A ship that can slide away along the wall is not pinned: nothing may break.
      expect(pinned).toBe(0);
      expect(cells - boat.grid.count).toBe(0);
      expect(host.drops).toHaveLength(0);
    });
  }
});

describe('review: a blade cannot squeeze one ship through another that terrain holds', () => {
  it('outer boat pushed toward an inner boat moored at a wall: hull overlap stays small', () => {
    const world = makeSea();
    fillWorld(world, -12, 36, -20, -10, 52, 20, B.STONE); // quay wall, face x = -9
    const { dyn } = setup(world);
    const inner = launch(plankBoat(world, 1, -9, 46, -4, 3, 4, NZ), dyn); // x in [-9,-6): against the wall
    const outer = launch(plankBoat(world, 2, -6, 46, -4, 3, 4, NZ), dyn); // x in [-6,-3): against the inner boat
    // hub south of the boats; the blade (pointing north) sweeps west, pressing the outer boat onto the inner one
    const rotor = blade(world, 0, 7, 60, 10);
    let worst = 0;
    let contacts = 0;
    for (let t = 0; t < 60; t++) {
      tick(dyn, [inner, outer], [rotor], 1);
      contacts += dyn.getStats(outer)!.rotorContacts;
      worst = Math.max(worst, shipOverlap(outer, inner), shipOverlap(inner, outer));
      expect(finite(inner) && finite(outer)).toBe(true);
    }
    expect(contacts).toBeGreaterThan(0);
    // ship/ship head-on test in collision.test.ts uses the same 0.3 bound; here it reaches ~0.9
    expect(worst).toBeLessThan(0.3);
  });
});
