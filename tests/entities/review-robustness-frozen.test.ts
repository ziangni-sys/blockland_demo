/**
 * Review (performance / spec): item drops in UNLOADED chunks.
 *
 * Entities are kept in one global list whatever the chunk state, and frozen ones never age
 * (no despawn while unloaded), so every drop the player leaves behind while exploring stays in
 * the list for the rest of the session. EntityManager.merges() decides "due" from
 * (age + id) % MERGE_INTERVAL_TICKS: a frozen item whose phase is 0 is due on EVERY tick, and
 * each due item scans every other item. Cost therefore grows quadratically with the number of
 * frozen drops (measured: 300 -> 0.10 ms, 1000 -> 0.75 ms, 3000 -> 8.8 ms per tick for entities
 * that are supposed to do nothing), and frozen drops still merge with each other, although the
 * brief says entities whose chunk is not loaded "do nothing this tick".
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import type { ItemEntity } from '../../src/entities/entity';
import { B, Bench, fill, makeWorld } from './harness';

function loadedBench(): Bench {
  const b = new Bench(makeWorld(-16, -16, 15, 15)); // chunks (-1..0, -1..0) only
  fill(b.world, -16, 40, -16, 15, 40, 15, B.STONE);
  b.entities.spawnPlayer('survival', 0.5, 41, 0.5);
  return b;
}

describe('review: item drops in unloaded chunks', () => {
  it('do nothing: two identical frozen drops side by side do not merge', () => {
    const b = loadedBench();
    const pairs: Array<[ItemEntity, ItemEntity]> = [];
    // Ten pairs, so whatever the id phase some item would be "due" for merging.
    for (let k = 0; k < 10; k++) {
      const x = 200.5 + k * 4;
      pairs.push([b.entities.spawnItem(x, 41.2, 0.5, B.COBBLE, 1, vec3()), b.entities.spawnItem(x + 0.3, 41.2, 0.5, B.COBBLE, 1, vec3())]);
    }
    b.tick(30);
    for (const [a, c] of pairs) {
      expect(a.removed).toBe(false);
      expect(c.removed).toBe(false);
      expect(a.stack.count).toBe(1);
      expect(c.stack.count).toBe(1);
    }
  });

  it('cost (almost) nothing: 2000 frozen drops add well under 1 ms per tick', () => {
    const b = loadedBench();
    const ids = [B.COBBLE, B.DIRT, B.SAND, B.STONE, B.PLANKS_OAK, B.GRAVEL, B.GLASS];
    for (let k = 0; k < 2000; k++) b.entities.spawnItem(100 + (k % 50) * 3, 41.2, Math.floor(k / 50) * 3, ids[k % 7]!, 1, vec3());
    b.tick(20);
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      b.tick();
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    expect(samples[samples.length >> 1]!).toBeLessThan(1);
  });
});
