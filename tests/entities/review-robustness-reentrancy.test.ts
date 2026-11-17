/**
 * Review (re-entrancy / API): host.explode() is called from inside update(), but AFTER the
 * manager left its `iterating` mode. The simulation's explosion naturally walks
 * `entities.all()` (the live list) and damages what is in range; damage() of an item drop or a
 * rabbit calls remove(), which then splices the very array the explosion is iterating, so the
 * entity right after each removed one is skipped: half the drops in the blast survive.
 * (compact() already runs after the blasts, so keeping `iterating` set until then is enough.)
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import type { Entity } from '../../src/entities/entity';
import { B, Bench, fill } from './harness';

describe('review: re-entrancy of host.explode', () => {
  it('an explosion that damages every entity in range through all() reaches all of them', () => {
    const b = new Bench();
    fill(b.world, -10, 59, -10, 10, 59, 10, B.STONE);
    b.entities.spawnPlayer('creative', 9.5, 60, 9.5); // far away, creative: unaffected
    const drops: Entity[] = [];
    for (let k = 0; k < 8; k++) drops.push(b.entities.spawnItem(-2 + k * 0.6, 60.2, 0.5, k % 2 === 0 ? B.COBBLE : B.DIRT, 1, vec3()));
    drops.push(b.entities.spawnRabbit(0.5, 60, 2.5));
    // What a simulation's explode() looks like: damage everything within the radius.
    b.host.explode = (x, y, z, power) => {
      for (const e of b.entities.all()) {
        if (e.removed) continue;
        if (Math.hypot(e.pos.x - x, e.pos.y - y, e.pos.z - z) <= power * 2) b.entities.damage(e, 10, 'explosion');
      }
    };
    b.tick(2);
    b.entities.spawnTnt(0, 60, 0, 1);
    b.tick(3);
    const survivors = drops.filter((d) => !d.removed).length;
    expect(survivors).toBe(0);
  });
});
