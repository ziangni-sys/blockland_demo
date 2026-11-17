/**
 * Ship rigid-body dynamics (PHYSICAL structures). See dynamics.ts for the tick pipeline and the
 * individual files for each piece:
 *
 *   massprops.ts  refresh: hull analysis, mass (incl. mounted rotors), inertia, COM pivot, bow
 *   body.ts       per-ship solver state, sub-step integration, velocity clamp
 *   buoyancy.ts   per-cell buoyancy against the world's water
 *   hydro.ts      drag, keel, thrust, rudder, rotational damping
 *   patch.ts      per-tick copy of the world's collision / water flags around a ship
 *   shape.ts      per-version collision shape: occupancy, surface sample points, displacing cells
 *   contacts.ts   contact generation (terrain, rotors, ships), manifold reduction, rotor
 *                 contact states (F_PIN)
 *   rotorview.ts  rotors as kinematic obstacles, interpolated per sub-step, swept boxes
 *   solver.ts     sequential impulses + split-impulse penetration recovery, one-sided contacts
 *   pinning.ts    rotor pinning test, jams, the shared support rule, the hull cell to destroy
 *   sleep.ts      sleep / wake
 */
import type { StructureHost } from '../structure';
import { ShipDynamicsImpl } from './dynamics';
import type { DynamicsOptions } from './options';

export type { DynamicsOptions, ResolvedOptions } from './options';
export { DEFAULT_OPTIONS, topSpeedFor } from './options';
export type { ShipPhysicsStats } from './body';
export { ShipDynamicsImpl } from './dynamics';
export { WATER_SURFACE_DROP } from './patch';

/**
 * Create the ship dynamics for a simulation. The returned object implements ShipDynamics
 * (refresh, step, applyImpulse, wake) plus getStats() and lastSubsteps for debug overlays and
 * tests.
 */
export function createShipDynamics(host: StructureHost, opts?: DynamicsOptions): ShipDynamicsImpl {
  return new ShipDynamicsImpl(host, opts);
}
