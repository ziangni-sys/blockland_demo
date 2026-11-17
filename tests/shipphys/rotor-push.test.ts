/**
 * A blade driving ships against walls and against other ships, over a spread of geometries
 * rather than single cases (several of these variants failed while the pinning and rotor
 * contact rules were being reworked):
 *  - a boat swept obliquely along a quay slides away: nothing pinned, nothing lost, the blade
 *    neither cuts into the hull nor pushes it into the wall;
 *  - a boat squeezed against a boat moored at a quay never sinks into it;
 *  - a boat driven obliquely along a frozen or a free barge slides along it, never through it.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { NZ, PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3, type Vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  fillWorld,
  finite,
  hullSamplePoints,
  launch,
  makeSea,
  newRotor,
  newShip,
  plankBoat,
  pointsIntoHull,
  setup,
  shipBox,
  terrainPenetration,
  tick,
} from './helpers';

/** Vertical-axis blade: hub (hx,47,hz), `len` long, 4 tall, pointing east at angle 0. */
function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startDeg: number, len: number): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + len; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
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

/** Deepest sample point of `a` inside a hard cell of `b`, to the nearest open cell along the axes. */
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

describe('a blade sweeping a boat obliquely along a quay', () => {
  // quay face x = -6, boat against it; the blade's motion at the boat is 28-60 degrees off the
  // wall's normal (outside the pin cone) during the whole sweep
  for (const [startDeg, speed] of [
    [100, 0.3],
    [100, 1],
    [110, 0.3],
    [110, 0.6],
  ] as const) {
    it(`start ${startDeg} deg, ${speed} rad/s: slides away, intact, never pushed into the quay or cut`, () => {
      const world = makeSea();
      fillWorld(world, -9, 36, -40, -7, 52, 40, B.STONE);
      const { dyn, host } = setup(world);
      const boat = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn);
      const cells = boat.grid.count;
      const rotor = blade(world, 0, 0, startDeg, 8);
      const z0 = boat.grid.position.z;
      let pinned = 0;
      let contacts = 0;
      let wall = 0;
      let cut = 0;
      for (let t = 0; t < Math.ceil(80 / speed); t++) {
        tick(dyn, [boat], [rotor], speed);
        const st = dyn.getStats(boat)!;
        pinned += st.pinned;
        contacts += st.rotorContacts;
        wall = Math.max(wall, terrainPenetration(world, boat));
        cut = Math.max(cut, pointsIntoHull(boat, rotorCorners(rotor)));
        expect(finite(boat)).toBe(true);
      }
      expect(contacts).toBeGreaterThan(0);
      expect(boat.grid.position.z - z0).toBeGreaterThan(5);
      expect(pinned).toBe(0);
      expect(boat.grid.count).toBe(cells);
      expect(host.drops).toHaveLength(0);
      expect(wall).toBeLessThan(0.1);
      expect(cut).toBeLessThan(0.3);
    });
  }
});

describe('a blade squeezing a boat against a boat moored at a quay', () => {
  // quay face x = -9, inner boat moored against it, outer boat against the inner one
  for (const [startDeg, speed, hz] of [
    [50, 1, 6],
    [60, 1, 6],
    [65, 1, 6],
    [65, 0.5, 8],
    [70, 0.5, 8],
  ] as const) {
    it(`start ${startDeg} deg, ${speed} rad/s, hub z ${hz}: the hulls never sink into each other`, () => {
      const world = makeSea();
      fillWorld(world, -12, 36, -20, -10, 52, 20, B.STONE);
      const { dyn } = setup(world);
      const inner = launch(plankBoat(world, 1, -9, 46, -4, 3, 4, NZ), dyn);
      const outer = launch(plankBoat(world, 2, -6, 46, -4, 3, 4, NZ), dyn);
      const rotor = blade(world, 0, hz, startDeg, 10);
      let worst = 0;
      let contacts = 0;
      for (let t = 0; t < Math.ceil(60 / speed); t++) {
        tick(dyn, [inner, outer], [rotor], speed);
        contacts += dyn.getStats(outer)!.rotorContacts;
        worst = Math.max(worst, shipOverlap(outer, inner), shipOverlap(inner, outer));
        expect(finite(inner) && finite(outer)).toBe(true);
      }
      expect(contacts).toBeGreaterThan(0);
      expect(worst).toBeLessThan(0.3);
    });
  }
});

describe('a blade driving a boat obliquely along another ship', () => {
  // the quay geometry with the quay replaced by a long barge: the blade's motion is outside the
  // pin cone, so the driven boat must slide along the barge — frozen (immovable) or free
  for (const frozen of [true, false]) {
    it(`${frozen ? 'a frozen' : 'a free'} barge: the boat slides along it and never passes through`, () => {
      const world = makeSea();
      const { dyn, host } = setup(world);
      const barge = newShip(world, 2);
      shipBox(barge, -9, 45, -20, -7, 47, 12, B.PLANKS_OAK); // x in [-9, -6), a solid block of planks
      launch(barge, dyn);
      const driven = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn); // x in [-6, -3)
      barge.frozen = frozen;
      const bargeAt = { ...barge.grid.position };
      const cells = driven.grid.count;
      const rotor = blade(world, 0, 0, 110, 8);
      const z0 = driven.grid.position.z;
      let worst = 0;
      let contacts = 0;
      for (let t = 0; t < 60; t++) {
        tick(dyn, [driven, barge], [rotor], 1);
        contacts += dyn.getStats(driven)!.rotorContacts;
        worst = Math.max(worst, shipOverlap(driven, barge), shipOverlap(barge, driven));
        expect(finite(driven) && finite(barge)).toBe(true);
      }
      expect(contacts).toBeGreaterThan(0);
      expect(worst).toBeLessThan(0.3);
      expect(driven.grid.count).toBe(cells);
      expect(host.drops).toHaveLength(0);
      if (frozen) {
        expect(barge.grid.position).toEqual(bargeAt); // never moved
        expect(driven.grid.position.z - z0).toBeGreaterThan(3); // slid along it
      }
    });
  }
});
