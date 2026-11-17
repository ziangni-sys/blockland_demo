/**
 * Water resistance and helm control, as velocity changes per sub-step. Everything is per unit
 * mass (and per unit inertia for the rudder) so that ships of every size share the same handling:
 * a 4000-cell galleon reaches the same top speed and turn rate as a raft with the same sails.
 * Size shows in how a hull floats, rolls and collides, not in how it answers the helm.
 *
 * LESSONS 船纵倾、横倾过大: translational drag acts at the centre of mass (no pitching moment
 * from forward drag or thrust); rotation has its own damping; a keel term strongly resists
 * sideways slip relative to the bow so the ship goes where it points.
 *
 * Wetness: wet = submerged / min(mass, displacing cells) — 1 for a ship floating at its
 * Archimedes draught and for a fully submerged one; the water terms scale with it. Thrust and
 * rudder only work while a floating hull is at least half as deep as it would float
 * (thrustWet): a beached or sunken ship cannot be steered.
 *
 * Steering convention: rudder +1 turns to starboard = clockwise from above = NEGATIVE yaw rate
 * about world +Y. The commanded yaw rate grows with forward speed and is non-zero at rest (a
 * ship pivots slowly in place). Going astern the speed-dependent sense flips like a car in
 * reverse ("classic rudder feel"): holding right while backing swings the bow to port. The flip
 * blends over 0 .. -0.6 blocks/s of forward speed so it never snaps.
 */
import type { Body } from './body';
import { topSpeedFor, type ResolvedOptions } from './options';

/** Remove `dv` (same sign as v) from v without overshooting zero. */
function decay(v: number, dv: number): number {
  if (v > 0) return dv >= v ? 0 : v - dv;
  if (v < 0) return dv <= v ? 0 : v - dv;
  return 0;
}

export function applyHydrodynamics(body: Body, o: ResolvedOptions, dt: number): void {
  const ship = body.ship;
  const m = body.mass;
  const S = body.submerged;
  const cap = Math.min(m, body.shape.dispCount);
  const wet = cap > 0 ? Math.min(1, S / cap) : 0;
  const thrustWet = body.floats && m > 0 ? Math.min(1, (2 * S) / m) : 0;
  body.wet = wet;
  body.thrustWet = thrustWet;

  const R = body.R;
  // Bow direction in world space: column `axis` of R, signed.
  const fd = ship.forward;
  const ax = fd >> 1;
  const sg = (fd & 1) === 0 ? 1 : -1;
  const fwx = R[ax]! * sg;
  const fwz = R[6 + ax]! * sg;
  const hl = Math.sqrt(fwx * fwx + fwz * fwz);

  let vx = body.vx;
  let vy = body.vy;
  let vz = body.vz;
  const cAir = o.airDrag * dt;

  let vf = 0; // forward speed (used by the rudder)
  if (hl > 0.3) {
    const fx = fwx / hl;
    const fz = fwz / hl;
    // starboard = forward x up
    const sx = -fz;
    const sz = fx;
    vf = vx * fx + vz * fz;
    let vs = vx * sx + vz * sz;

    const throttle = ship.throttle > 1 ? 1 : ship.throttle < -1 ? -1 : ship.throttle;
    if (throttle !== 0 && thrustWet > 0) {
      const top = topSpeedFor(o, ship.sails);
      const target = throttle > 0 ? throttle * top : throttle * top * o.reverseSpeedFactor;
      // Feed-forward of the drag at the current speed + proportional control: steady state is
      // exactly the target speed; the force limit keeps acceleration believable.
      const drag = (o.forwardDrag * vf + o.forwardDragQuadratic * Math.abs(vf) * vf) * wet + o.airDrag * vf;
      const aMax = o.forwardDrag * top + o.forwardDragQuadratic * top * top + o.thrustReserve;
      let a = drag + o.throttleResponse * (target - vf);
      if (a > aMax) a = aMax;
      else if (a < -aMax) a = -aMax;
      vf += a * thrustWet * dt;
    }
    vf = decay(vf, ((o.forwardDrag + o.forwardDragQuadratic * Math.abs(vf)) * wet * dt + cAir) * vf);
    vs = decay(vs, ((o.keelDrag + o.keelDragQuadratic * Math.abs(vs)) * wet * dt + cAir) * vs);
    vx = fx * vf + sx * vs;
    vz = fz * vf + sz * vs;
  } else {
    // Bow pointing (nearly) straight up or down: no keel, isotropic horizontal drag.
    const h = Math.sqrt(vx * vx + vz * vz);
    if (h > 0) {
      const nh = decay(h, ((o.forwardDrag + o.forwardDragQuadratic * h) * wet * dt + cAir) * h);
      vx *= nh / h;
      vz *= nh / h;
    }
  }
  vy = decay(vy, ((body.heaveDamping + o.heaveDragQuadratic * Math.abs(vy)) * wet * dt + cAir) * vy);
  body.vx = vx;
  body.vy = vy;
  body.vz = vz;

  // ---- rudder: drive the yaw rate (world +Y) toward the commanded rate
  const rudder = ship.rudder > 1 ? 1 : ship.rudder < -1 ? -1 : ship.rudder;
  if (rudder !== 0 && thrustWet > 0) {
    let sense = (vf + 0.3) / 0.3;
    if (sense > 1) sense = 1;
    else if (sense < -1) sense = -1;
    let rate = o.turnRateAtRest + o.turnRatePerSpeed * Math.abs(vf);
    if (rate > o.maxTurnRate) rate = o.maxTurnRate;
    const target = -rudder * sense * rate;
    let a = o.yawDrag * wet * target + o.turnResponse * (target - body.wy);
    if (a > o.maxTurnAccel) a = o.maxTurnAccel;
    else if (a < -o.maxTurnAccel) a = -o.maxTurnAccel;
    body.wy += a * thrustWet * dt;
  }

  // ---- rotational damping in the ship's own axes: X / Z adaptive (roll and pitch), Y = yaw.
  const wx = body.wx;
  const wy = body.wy;
  const wz = body.wz;
  // local = R^T w
  let lx = R[0]! * wx + R[3]! * wy + R[6]! * wz;
  let ly = R[1]! * wx + R[4]! * wy + R[7]! * wz;
  let lz = R[2]! * wx + R[5]! * wy + R[8]! * wz;
  const air = o.airAngularDrag * dt;
  const kx = Math.min(1, body.rollDampingX * wet * dt + air);
  const ky = Math.min(1, o.yawDrag * wet * dt + air);
  const kz = Math.min(1, body.rollDampingZ * wet * dt + air);
  lx -= lx * kx;
  ly -= ly * ky;
  lz -= lz * kz;
  body.wx = R[0]! * lx + R[1]! * ly + R[2]! * lz;
  body.wy = R[3]! * lx + R[4]! * ly + R[5]! * lz;
  body.wz = R[6]! * lx + R[7]! * ly + R[8]! * lz;
}
