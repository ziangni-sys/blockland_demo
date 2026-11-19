/**
 * Explosions in a world of full blocks are exactly those of the code before Milestone 2.3
 * (docs/SHAPES.md section 9.4): per-octant costs and marks, per-part removal and the volume share
 * of the push must not change a single cell, item, structure pose or random number when every
 * cell holds one full block. The numbers below were produced by the same fingerprint function
 * (explosion-fullblock-fingerprint.ts) on the M1 baseline, commit c20ea8e.
 */
import { describe, expect, it } from 'vitest';
import { fullBlockExplosions } from './explosion-fullblock-fingerprint';

const M1 = {
  craterNow: { cells: 2683925307, ships: 2166136261, entities: 676917303, entityCount: 21, rng: 1054315651 },
  craterLater: { cells: 2319224463, ships: 2166136261, entities: 3416056381, entityCount: 16, rng: 1687365734 },
  raftNow: { cells: 2218993234, ships: 2019479559, entities: 234837730, entityCount: 2, rng: 1067061478 },
  raftLater: { cells: 2218993234, ships: 3136729996, entities: 3779295902, entityCount: 2, rng: 840137520 },
};

describe('explosions in a world of full blocks', () => {
  it('a crater with a chained blast crate, torches, sand and obsidian, and a blasted raft on the sea, match the M1 baseline exactly', () => {
    expect(fullBlockExplosions()).toEqual(M1);
  });
});
