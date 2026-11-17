import { describe, expect, it } from 'vitest';
import { NZ, PX } from '../../src/core/dirs';
import { qyaw } from '../../src/core/math';
import { topSpeedFor, DEFAULT_OPTIONS } from '../../src/structures/physics';
import type { Ship } from '../../src/structures/structure';
import { launch, makeWorld, plankBoat, run, setup, wrap } from './controlHelpers';

/** Long channel of open water: x in [-48, 47], z in [-240, 47]. */
function channel() {
  return makeWorld({ cx0: -3, cx1: 2, cz0: -15, cz1: 2 });
}

/** Signed speed along the bow's horizontal direction. */
function forwardSpeed(ship: Ship): number {
  const yaw = qyaw(ship.grid.rotation);
  // bow = local -Z rotated by yaw: (-sin yaw, 0, -cos yaw)
  const v = ship.grid.linearVelocity;
  return -Math.sin(yaw) * v.x - Math.cos(yaw) * v.z;
}

describe('control: throttle', () => {
  for (const sails of [0, 20]) {
    it(`full ahead reaches the top speed with ${sails} sails, believably fast`, () => {
      const world = channel();
      const { dyn } = setup(world);
      const boat = launch(plankBoat(world, 1, -2, 46, 30, 5, 9, NZ), dyn);
      expect(boat.forward).toBe(NZ);
      boat.sails = sails;
      boat.throttle = 1;
      const top = topSpeedFor(DEFAULT_OPTIONS, sails);
      expect(top).toBeCloseTo(2.5 + 0.2 * sails);
      const speeds: number[] = [];
      run(dyn, [boat], 400, () => speeds.push(forwardSpeed(boat)));
      // several seconds to top speed: below 80% after 2 s, above 90% after 5 s
      expect(speeds[39]!).toBeLessThan(0.8 * top);
      expect(speeds[99]!).toBeGreaterThan(0.9 * top);
      expect(Math.abs(speeds[399]! - top) / top).toBeLessThan(0.02);
      // it went north (-Z) and stayed on course
      expect(boat.grid.linearVelocity.z).toBeLessThan(0);
      expect(Math.abs(boat.grid.linearVelocity.x)).toBeLessThan(0.02 * top);
      expect(Math.abs(wrap(qyaw(boat.grid.rotation)))).toBeLessThan(0.01);
    });

    it(`full astern reaches 40% of the top speed with ${sails} sails`, () => {
      const world = channel();
      const { dyn } = setup(world);
      const boat = launch(plankBoat(world, 1, -2, 46, -200, 5, 9, NZ), dyn);
      boat.sails = sails;
      boat.throttle = -1;
      run(dyn, [boat], 400);
      const top = topSpeedFor(DEFAULT_OPTIONS, sails);
      expect(Math.abs(forwardSpeed(boat) + 0.4 * top) / (0.4 * top)).toBeLessThan(0.02);
      expect(boat.grid.linearVelocity.z).toBeGreaterThan(0); // backing south
    });
  }

  it('coasts to a stop when the throttle is released', () => {
    const world = channel();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, 30, 5, 9, NZ), dyn);
    boat.sails = 40;
    boat.throttle = 1;
    run(dyn, [boat], 200);
    boat.throttle = 0;
    run(dyn, [boat], 300);
    expect(Math.abs(forwardSpeed(boat))).toBeLessThan(0.3);
  });

  it('the bow follows the helm facing', () => {
    const world = channel();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -4, 46, 0, 9, 5, PX), dyn);
    expect(boat.forward).toBe(PX);
    boat.throttle = 1;
    run(dyn, [boat], 200);
    expect(boat.grid.linearVelocity.x).toBeGreaterThan(2.3);
  });
});

describe('control: rudder', () => {
  it('rudder +1 turns to starboard (clockwise from above, yaw decreasing), also at rest', () => {
    const world = channel();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, 0, 5, 9, NZ), dyn);
    boat.rudder = 1;
    run(dyn, [boat], 40);
    expect(boat.grid.angularVelocity.y).toBeLessThan(-0.1); // pivots in place
    const yaw0 = qyaw(boat.grid.rotation);
    boat.throttle = 1;
    run(dyn, [boat], 60);
    const yaw1 = qyaw(boat.grid.rotation);
    expect(wrap(yaw1 - yaw0)).toBeLessThan(-0.3);
    // the ship's track bends right too: heading north then east-ish -> vx > 0
    expect(boat.grid.linearVelocity.x).toBeGreaterThan(0);
  });

  it('rudder -1 turns to port', () => {
    const world = channel();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, 0, 5, 9, NZ), dyn);
    boat.rudder = -1;
    boat.throttle = 1;
    run(dyn, [boat], 60);
    expect(wrap(qyaw(boat.grid.rotation))).toBeGreaterThan(0.3);
  });

  it('turns faster at speed than at rest', () => {
    const world = channel();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -20, 46, 0, 5, 9, NZ), dyn);
    const b = launch(plankBoat(world, 2, 15, 46, 0, 5, 9, NZ), dyn);
    a.sails = b.sails = 40;
    b.throttle = 1;
    run(dyn, [a, b], 120);
    a.rudder = 1;
    b.rudder = 1;
    run(dyn, [a, b], 40);
    expect(b.grid.angularVelocity.y).toBeLessThan(a.grid.angularVelocity.y * 1.5);
  });

  it('astern, the rudder sense flips like a car in reverse (bow swings to port)', () => {
    const world = channel();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, -150, 5, 9, NZ), dyn);
    boat.sails = 20;
    boat.throttle = -1;
    run(dyn, [boat], 160);
    expect(forwardSpeed(boat)).toBeLessThan(-1);
    boat.rudder = 1;
    const yaw0 = qyaw(boat.grid.rotation);
    run(dyn, [boat], 60);
    expect(wrap(qyaw(boat.grid.rotation) - yaw0)).toBeGreaterThan(0.1);
  });

  it('no control while beached or sunk: thrust needs water under a floating hull', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 40, waterTop: 0 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 40, -4, 5, 9, NZ), dyn);
    boat.throttle = 1;
    boat.rudder = 1;
    run(dyn, [boat], 100);
    const v = boat.grid.linearVelocity;
    expect(Math.hypot(v.x, v.z)).toBeLessThan(0.01);
    expect(Math.abs(boat.grid.angularVelocity.y)).toBeLessThan(0.01);
  });
});
