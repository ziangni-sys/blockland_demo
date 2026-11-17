/**
 * Tuning of the ship dynamics. Every value has a default chosen for the game's scale
 * (1 block = 1 m, densities relative to water, 20 TPS); DynamicsOptions overrides any subset.
 */

export interface DynamicsOptions {
  /** Fixed sub-steps per tick (default 8 -> 160 Hz). LESSONS: 每个 tick 内必须再分子步. */
  substeps?: number;
  /**
   * Upper bound of the sub-step count (default 32). A tick takes more than `substeps` sub-steps
   * only while a rotor whose blades travel farther than maxSubstepTravel per sub-step can reach a
   * ship (a long windmill's tips): then both the blade and the hull it pushes still move at most
   * maxSubstepTravel per sub-step.
   */
  maxSubsteps?: number;
  /** Gravity, blocks/s^2 (default 9.81). */
  gravity?: number;
  /**
   * Density of water on the BlockDef.density scale (default 1). Buoyancy, the float / sink
   * verdict (mass < waterDensity * maxDisplacement), wetness and the adaptive damping all use it.
   */
  waterDensity?: number;
  /** Sequential-impulse iterations per sub-step for velocities (default 10). */
  velocityIterations?: number;
  /** Split-impulse iterations per sub-step for penetration recovery (default 4). */
  positionIterations?: number;
  /** Farthest any hull point may travel in one sub-step, blocks (default 0.2, well under half a cell). */
  maxSubstepTravel?: number;
  /** Penetration left alone by the positional correction, blocks (default 0.01). */
  slop?: number;
  /** Fraction of the excess penetration removed per sub-step (default 0.25). */
  correctionRate?: number;
  /** Cap of the positional-correction pseudo velocity, blocks/s (default 4). */
  maxCorrectionSpeed?: number;
  /** Coulomb friction ship/terrain (default 0.6). */
  terrainFriction?: number;
  /** Coulomb friction ship/rotor blade (default 0.3). */
  rotorFriction?: number;
  /** Coulomb friction ship/ship (default 0.4). */
  shipFriction?: number;

  // ---- propulsion (docs/DESIGN.md 航速随风车的帆数增加，没有风车也能慢速划)
  /** Top speed ahead without any sail, blocks/s (default 2.5). */
  baseSpeed?: number;
  /** Extra top speed per sail, blocks/s (default 0.2). */
  speedPerSail?: number;
  /** Sails beyond this count add no speed (default 40). */
  maxSpeedSails?: number;
  /** Top speed astern as a fraction of the top speed ahead (default 0.4). */
  reverseSpeedFactor?: number;
  /** Proportional gain of the speed controller, 1/s (default 0.6: ~5 s to 95% of top speed). */
  throttleResponse?: number;
  /** Thrust acceleration available beyond the drag at top speed, blocks/s^2 (default 1.5). */
  thrustReserve?: number;
  /** Yaw rate commanded by full rudder at rest, rad/s (default 0.25: a ship pivots slowly in place). */
  turnRateAtRest?: number;
  /** Additional yaw rate per block/s of forward speed, rad/s (default 0.1). */
  turnRatePerSpeed?: number;
  /** Largest commanded yaw rate, rad/s (default 0.7). */
  maxTurnRate?: number;
  /** Yaw-rate controller gain, 1/s (default 2). */
  turnResponse?: number;
  /** Largest yaw acceleration of the rudder, rad/s^2 (default 1.5). */
  maxTurnAccel?: number;

  // ---- water resistance (per unit mass; scaled by how much of the hull is wet)
  /** Linear / quadratic drag along the keel (forward). Defaults 0.25 1/s, 0.02 1/block. */
  forwardDrag?: number;
  forwardDragQuadratic?: number;
  /** Keel: linear / quadratic resistance to sideways slip. Defaults 2.5 1/s, 0.3 1/block. */
  keelDrag?: number;
  keelDragQuadratic?: number;
  /** Quadratic heave drag, 1/block (default 0.5); the linear part adapts to the hull. */
  heaveDragQuadratic?: number;
  /** Damping ratio of heave / roll-pitch used to derive the adaptive linear damping. */
  heaveDampingRatio?: number;
  rollDampingRatio?: number;
  /** Yaw damping in water, 1/s (default 1). */
  yawDrag?: number;
  /** Linear drag in air, 1/s (default 0.02) and angular drag in air, 1/s (default 0.05). */
  airDrag?: number;
  airAngularDrag?: number;

  // ---- sleep
  /** Speed below which a ship counts as resting, blocks/s (default 0.05). */
  sleepLinearSpeed?: number;
  /** Angular speed below which a ship counts as resting, rad/s (default 0.03). */
  sleepAngularSpeed?: number;
  /** Consecutive resting ticks before falling asleep (default 40 = 2 s). */
  sleepTicks?: number;

  // ---- pinning (ACCEPTANCE 16, LESSONS 能动的船被误判压坏) — relative thresholds only
  /**
   * A blade still "presses" when its velocity into the contact — by itself, and relative to the
   * hull after the solve — exceeds this fraction of its own speed (default 0.25).
   */
  pinPressRatio?: number;
  /**
   * A support normal "opposes" the blade when cos(angle between it and the reversed direction
   * of the blade's motion) exceeds this (default 0.9, ~25 deg). Outside this cone a ship pushed
   * against terrain slides away along it: terrain contacts that oppose a pressing blade are
   * frictionless, so friction cannot jam it there (see dynamics.ts).
   */
  pinOpposeCos?: number;

  /** Terrain contacts kept per body and normal direction after manifold reduction (default 12). */
  maxContactsPerNormal?: number;
}

export type ResolvedOptions = Readonly<Required<DynamicsOptions>>;

export const DEFAULT_OPTIONS: ResolvedOptions = Object.freeze({
  substeps: 8,
  maxSubsteps: 32,
  gravity: 9.81,
  waterDensity: 1,
  velocityIterations: 10,
  positionIterations: 4,
  maxSubstepTravel: 0.2,
  slop: 0.01,
  correctionRate: 0.25,
  maxCorrectionSpeed: 4,
  terrainFriction: 0.6,
  rotorFriction: 0.3,
  shipFriction: 0.4,
  baseSpeed: 2.5,
  speedPerSail: 0.2,
  maxSpeedSails: 40,
  reverseSpeedFactor: 0.4,
  throttleResponse: 0.6,
  thrustReserve: 1.5,
  turnRateAtRest: 0.25,
  turnRatePerSpeed: 0.1,
  maxTurnRate: 0.7,
  turnResponse: 2,
  maxTurnAccel: 1.5,
  forwardDrag: 0.25,
  forwardDragQuadratic: 0.02,
  keelDrag: 2.5,
  keelDragQuadratic: 0.3,
  heaveDragQuadratic: 0.5,
  heaveDampingRatio: 0.6,
  rollDampingRatio: 0.5,
  yawDrag: 1,
  airDrag: 0.02,
  airAngularDrag: 0.05,
  sleepLinearSpeed: 0.05,
  sleepAngularSpeed: 0.03,
  sleepTicks: 40,
  pinPressRatio: 0.25,
  pinOpposeCos: 0.9,
  maxContactsPerNormal: 12,
});

/** Merge user options over the defaults, validating the few that could break the solver. */
export function resolveOptions(opts: DynamicsOptions | undefined): ResolvedOptions {
  const o: Required<DynamicsOptions> = { ...DEFAULT_OPTIONS };
  if (opts) {
    for (const k of Object.keys(opts) as Array<keyof DynamicsOptions>) {
      const v = opts[k];
      if (v !== undefined) o[k] = v;
    }
  }
  o.substeps = Math.max(1, Math.floor(o.substeps));
  o.maxSubsteps = Math.max(o.substeps, Math.floor(o.maxSubsteps) || 0);
  if (!(o.waterDensity > 0)) o.waterDensity = DEFAULT_OPTIONS.waterDensity;
  o.velocityIterations = Math.max(1, Math.floor(o.velocityIterations));
  o.positionIterations = Math.max(0, Math.floor(o.positionIterations));
  o.sleepTicks = Math.max(1, Math.floor(o.sleepTicks));
  o.maxContactsPerNormal = Math.max(5, Math.floor(o.maxContactsPerNormal));
  if (!(o.maxSubstepTravel > 0)) o.maxSubstepTravel = DEFAULT_OPTIONS.maxSubstepTravel;
  return Object.freeze(o);
}

/** Top speed ahead (blocks/s) for a sail count. */
export function topSpeedFor(o: ResolvedOptions, sails: number): number {
  const s = sails > 0 ? Math.min(sails, o.maxSpeedSails) : 0;
  return o.baseSpeed + o.speedPerSail * s;
}
