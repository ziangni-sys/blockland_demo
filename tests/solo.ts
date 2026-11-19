/**
 * Single-player test worlds: a Simulation with one player joined under SOLO_KEY, which the tests
 * then drive through `sim.soloPlayer` (the test-only accessor that throws unless exactly one
 * player has joined). Multi-player tests join their own keys instead.
 */
import { importSave, type SaveBundle } from '../src/sim/persist';
import { Simulation, type SimOptions } from '../src/sim/simulation';

/** The key of the one player of a single-player test world. */
export const SOLO_KEY = 'solo';

/** A new Simulation with one joined player (SOLO_KEY). */
export function soloSim(opts: SimOptions): Simulation {
  const sim = new Simulation(opts);
  sim.join(SOLO_KEY);
  return sim;
}

/** A new Simulation that loads `bundle` (importSave) and then has SOLO_KEY join: the saved player comes back. */
export function loadSolo(opts: SimOptions, bundle: SaveBundle): Simulation {
  const sim = new Simulation(opts);
  importSave(sim, bundle);
  sim.join(SOLO_KEY);
  return sim;
}
