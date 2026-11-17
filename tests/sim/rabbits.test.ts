import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { RABBIT_CAP, RABBIT_DESPAWN_DISTANCE } from '../../src/sim/rabbits';
import type { Simulation } from '../../src/sim/simulation';
import { flatSim } from './helpers';

function rabbits(sim: Simulation): Array<{ x: number; y: number; z: number }> {
  return sim.entities
    .all()
    .filter((e) => e.kind === 'rabbit' && !e.removed)
    .map((e) => ({ x: e.pos.x, y: e.pos.y, z: e.pos.z }));
}

describe('ambient rabbits', () => {
  it('appear on turf near the player by day, capped, deterministically', () => {
    const run = (): Simulation => {
      const sim = flatSim({ rabbits: true, loadRadius: 3, seed: 31 });
      sim.advance(600);
      return sim;
    };
    const a = run();
    const b = run();
    const ra = rabbits(a);
    expect(ra.length).toBeGreaterThan(0);
    expect(ra.length).toBeLessThanOrEqual(RABBIT_CAP);
    expect(rabbits(b)).toEqual(ra);
    for (const r of ra) {
      // standing on the turf layer (FlatGenerator: turf at y 34)
      expect(r.y).toBeGreaterThanOrEqual(35 - 1e-6);
      expect(a.world.getCell(Math.floor(r.x), 34, Math.floor(r.z)) & 1023).toBe(B.TURF);
    }
  });

  it('do not appear at night, nor when disabled; vanish when the player is far away', () => {
    const night = flatSim({ rabbits: true, loadRadius: 3 });
    night.setDayTime(0.7);
    night.advance(600);
    expect(rabbits(night).length).toBe(0);

    const off = flatSim({ rabbits: false, loadRadius: 3 });
    off.advance(600);
    expect(rabbits(off).length).toBe(0);

    const sim = flatSim({ rabbits: true, loadRadius: 3 });
    sim.advance(400);
    expect(rabbits(sim).length).toBeGreaterThan(0);
    sim.rabbits.enabled = false;
    sim.player.flying = true;
    sim.teleport(RABBIT_DESPAWN_DISTANCE + 120, 40, 0.5);
    sim.advance(80);
    expect(rabbits(sim).length).toBe(0);
  });
});
