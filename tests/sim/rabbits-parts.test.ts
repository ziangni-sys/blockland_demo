/**
 * Rabbits spawn only on a whole turf block alone in its cell (docs/SHAPES.md section 9.6): a turf
 * slab, a carved turf block or a turf part sharing its cell is no spawning ground.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import type { Simulation } from '../../src/sim/simulation';
import { slab } from '../shapes';
import { flatSim } from './helpers';

/** FlatGenerator's turf layer. */
const TURF_Y = 34;

function rabbitCount(sim: Simulation): number {
  return sim.entities.all().filter((e) => e.kind === 'rabbit' && !e.removed).length;
}

/**
 * A flat world whose whole turf layer in the loaded area (radius 3) is replaced by `cell` once
 * every column has loaded (rabbits wait until then), run for 600 ticks.
 */
function rabbitsOn(cell: number | null): number {
  const sim = flatSim({ rabbits: true, loadRadius: 3, seed: 31 });
  sim.rabbits.enabled = false;
  sim.advance(20);
  const loaded = sim.world.chunks.size;
  if (cell !== null) {
    for (const c of sim.world.chunks.values()) {
      for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) sim.world.setCell(c.cx * 16 + lx, TURF_Y, c.cz * 16 + lz, cell);
    }
  }
  sim.rabbits.enabled = true;
  sim.advance(600);
  expect(sim.world.chunks.size, 'no column loaded after the turf was replaced').toBe(loaded);
  return rabbitCount(sim);
}

describe('rabbits and partial turf', () => {
  it('appear on whole turf, never on turf with a carved upper or lower octant, or a two-part cell with turf in it', () => {
    expect(rabbitsOn(null)).toBeGreaterThan(0);
    expect(rabbitsOn(slab(B.TURF, 0x7f))).toBe(0);
    expect(rabbitsOn(slab(B.TURF, 0xfe))).toBe(0);
    expect(rabbitsOn(canonCell(slab(B.TURF, 0x0f), slab(B.TURF, 0xf0)))).toBe(0);
    expect(rabbitsOn(canonCell(slab(B.TURF, 0x33), slab(B.STONE, 0xcc)))).toBe(0);
  });
});
