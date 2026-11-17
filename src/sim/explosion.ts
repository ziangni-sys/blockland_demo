/**
 * Explosions. PLACEHOLDER — the full implementation arrives with the simulation module.
 */
import type { Entity } from '../entities/entity';
import type { Simulation } from './simulation';

export function explode(sim: Simulation, x: number, y: number, z: number, power: number, _source: Entity | null): void {
  sim.events.emit({ type: 'explosion', x, y, z, power });
}
