/**
 * What the entities module needs from the simulation. Keeping it this small is what lets the
 * module run against a hand-built world and hand-built structures in tests.
 */
import type { Rng } from '../core/rng';
import type { Structure } from '../structures/structure';
import type { World } from '../voxel/world';
import type { Entity } from './entity';

export type EntityEventType = 'hurt' | 'death' | 'crush' | 'land' | 'splash' | 'pickup' | 'helmReleased' | 'despawn';

/**
 * Something happened to an entity (sounds, HUD, statistics).
 *  - hurt         amount = damage taken, cause = 'fall' | 'drown' | 'lava' | 'crush' | ... (caller's string)
 *  - death        cause
 *  - crush        squeezed by a structure (and moved to a free spot); cause = 'structure'
 *  - land         amount = height fallen
 *  - splash       amount = downward speed when hitting the water
 *  - pickup       the player picked up `amount` items of entity.stack (entity = the item drop)
 *  - helmReleased entity = the player who let go of the wheel; cause = why
 *  - despawn      an entity vanished without dying (item timeout, merged away, burnt ...); cause
 */
export type EntityEvent = {
  type: EntityEventType;
  entity: Entity;
  amount?: number;
  cause?: string;
};

export interface EntityHost {
  readonly world: World;
  /** The only source of randomness (determinism). */
  readonly rng: Rng;
  /** Every live structure, including nested ones. */
  structures(): readonly Structure[];
  structure(id: number): Structure | undefined;
  /** A blast centred at a world point (the simulation does the damage, pushes and block removal). */
  explode(x: number, y: number, z: number, power: number, source: Entity | null): void;
  emit(ev: EntityEvent): void;
}
