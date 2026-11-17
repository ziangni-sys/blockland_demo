/**
 * Sleep: a ship that stays (nearly) motionless while supported — resting on terrain or on
 * another ship, or floating at equilibrium — for sleepTicks ticks is skipped by the dynamics
 * until something disturbs it (wake(), applyImpulse(), throttle / rudder, a cell change, game
 * code moving it, a moving rotor or a MOVING ship in reach, or a noticeable push from a ship
 * touching it; the structure manager also wakes ships when world cells near them change).
 * A sleeping ship does not move at all, so resting ships show exactly zero drift.
 *
 * Ships touching each other sleep as one island: an island falls asleep only when every member
 * has been quiet long enough, so two moored boats (or one resting on the other) can never keep
 * re-waking each other. A sleeper next to a quiet awake ship takes part in that ship's solve as an
 * immovable obstacle instead of being woken, and wakes when the contacts push it noticeably.
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

/** Below the sleep thresholds with no helm input (judged on the body's current velocities). */
export function isQuiet(body: Body, o: ResolvedOptions): boolean {
  const ship = body.ship;
  const v2 = body.vx * body.vx + body.vy * body.vy + body.vz * body.vz;
  const w2 = body.wx * body.wx + body.wy * body.wy + body.wz * body.wz;
  return (
    v2 < o.sleepLinearSpeed * o.sleepLinearSpeed &&
    w2 < o.sleepAngularSpeed * o.sleepAngularSpeed &&
    ship.throttle === 0 &&
    ship.rudder === 0
  );
}

/** End-of-tick rest bookkeeping for a simulated body: counts quiet, supported ticks. */
export function updateRest(body: Body, o: ResolvedOptions): void {
  const ship = body.ship;
  const floating = body.floats && Math.abs(body.submerged - body.mass) <= FLOAT_EQUILIBRIUM * body.mass + 0.1;
  const rest = isQuiet(body, o) && !body.rotorTouchThisTick && (body.supportedThisTick || floating);
  ship.restTicks = rest ? ship.restTicks + 1 : 0;
}

/** Put a body's ship to sleep: velocities to exactly zero. */
export function putToSleep(body: Body): void {
  const ship = body.ship;
  ship.asleep = true;
  const g = ship.grid;
  g.linearVelocity.x = g.linearVelocity.y = g.linearVelocity.z = 0;
  g.angularVelocity.x = g.angularVelocity.y = g.angularVelocity.z = 0;
  body.vx = body.vy = body.vz = 0;
  body.wx = body.wy = body.wz = 0;
}

/**
 * Islands of simulated bodies joined by load-carrying ship contacts (union-find over body
 * indices). Owned by the dynamics; buffers are reused.
 */
export class Islands {
  private parent = new Int32Array(16);

  reset(n: number): void {
    if (this.parent.length < n) this.parent = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(i: number): number {
    const p = this.parent;
    while (p[i] !== i) {
      p[i] = p[p[i]!]!; // path halving
      i = p[i]!;
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    // deterministic: the smaller index becomes the root
    if (ra < rb) this.parent[rb] = ra;
    else if (rb < ra) this.parent[ra] = rb;
  }
}
