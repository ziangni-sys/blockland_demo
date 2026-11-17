/**
 * Block updates: what happens to blocks when their surroundings change (gravity blocks
 * fall, unsupported soft blocks pop off) and non-liquid scheduled ticks.
 *
 * PLACEHOLDER — the full implementation arrives with the simulation module.
 */
import type { Simulation } from './simulation';

export class BlockUpdates {
  constructor(protected readonly sim: Simulation) {}

  /** Re-evaluate a world cell and its 6 neighbours. */
  updateAround(_x: number, _y: number, _z: number): void {}

  /** A scheduled tick for a non-liquid block fired. */
  scheduledTick(_x: number, _y: number, _z: number, _blockId: number): void {}
}
