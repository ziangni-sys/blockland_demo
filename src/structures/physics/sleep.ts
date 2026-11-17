/**
 * Sleep: a ship that stays (nearly) motionless while supported — resting on terrain, or floating
 * at equilibrium — for sleepTicks ticks is skipped by the dynamics until something disturbs it
 * (wake(), applyImpulse(), throttle / rudder, a cell change, a moving rotor or an awake ship
 * nearby; the structure manager also wakes ships when world cells near them change). A sleeping
 * ship does not move at all, so resting ships show exactly zero drift.
 */
import type { Ship } from '../structure';
import type { Body } from './body';
import type { ResolvedOptions } from './options';

/** Relative tolerance of "floating at equilibrium": |submerged - mass| <= this * mass + 0.1. */
const FLOAT_EQUILIBRIUM = 0.05;

export function wakeShip(ship: Ship): void {
  ship.asleep = false;
  ship.restTicks = 0;
}

/** End-of-tick sleep bookkeeping for a simulated body. */
export function updateSleep(body: Body, o: ResolvedOptions): void {
  const ship = body.ship;
  const v2 = body.vx * body.vx + body.vy * body.vy + body.vz * body.vz;
  const w2 = body.wx * body.wx + body.wy * body.wy + body.wz * body.wz;
  const floating = body.floats && Math.abs(body.submerged - body.mass) <= FLOAT_EQUILIBRIUM * body.mass + 0.1;
  const quiet =
    v2 < o.sleepLinearSpeed * o.sleepLinearSpeed &&
    w2 < o.sleepAngularSpeed * o.sleepAngularSpeed &&
    ship.throttle === 0 &&
    ship.rudder === 0 &&
    !body.rotorTouchThisTick &&
    (body.supportedThisTick || floating);
  if (!quiet) {
    ship.restTicks = 0;
    return;
  }
  ship.restTicks++;
  if (ship.restTicks >= o.sleepTicks) {
    ship.asleep = true;
    const g = ship.grid;
    g.linearVelocity.x = g.linearVelocity.y = g.linearVelocity.z = 0;
    g.angularVelocity.x = g.angularVelocity.y = g.angularVelocity.z = 0;
    body.vx = body.vy = body.vz = 0;
    body.wx = body.wy = body.wz = 0;
  }
}
