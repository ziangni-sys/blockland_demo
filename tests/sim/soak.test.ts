import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { Rng } from '../../src/core/rng';
import { Simulation } from '../../src/sim/simulation';
import { TerrainGenerator } from '../../src/worldgen/generator';

/**
 * 2000 ticks on generated terrain with random-walk input: walking, jumping, sneaking, looking
 * around, clicking with blocks, glue, buckets, blast crates and an empty hand. Must never throw;
 * reports the average tick time (chunk generation is synchronous here and included).
 */
describe('soak', () => {
  it('2000 ticks of random play on generated terrain', () => {
    const seed = 424242;
    const sim = new Simulation({ seed, mode: 'survival', generator: new TerrainGenerator(seed), syncChunks: true, loadRadius: 3 });
    const rng = new Rng(99);
    const p = sim.player;
    const kit: Array<number | null> = [B.PLANKS_OAK, B.STONE, B.TORCH, B.SAND, I.GLUE, I.BUCKET_WATER, B.TNT, null, B.CANVAS];
    for (let i = 0; i < kit.length; i++) {
      const it = kit[i];
      p.inventory.hotbar[i] = it === null || it === undefined ? null : { item: it, count: 64 };
    }
    const kinds = new Map<string, number>();
    sim.events.on((e) => kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1));
    let worst = 0;
    const t0 = performance.now();
    for (let tick = 0; tick < 2000; tick++) {
      const inp = sim.player.input;
      if (tick % 10 === 0) {
        inp.forward = rng.int(-1, 1);
        inp.strafe = rng.int(-1, 1);
        inp.sneak = rng.chance(0.15);
        inp.sprint = rng.chance(0.3);
        inp.slot = rng.int(0, 8);
      }
      inp.jump = rng.chance(0.05);
      // Part of every 100 ticks the view holds still, so survival mining and gluing can finish.
      if (tick % 100 >= 40) {
        inp.yaw += rng.range(-0.15, 0.15);
        inp.pitch = Math.max(-1.4, Math.min(1.2, inp.pitch + rng.range(-0.1, 0.1)));
      }
      inp.attack = rng.chance(0.3);
      inp.use = rng.chance(0.2);
      if (rng.chance(0.08)) inp.usePresses++;
      if (rng.chance(0.08)) inp.attackPresses++;
      if (tick % 500 === 499) sim.setMode(sim.mode === 'survival' ? 'creative' : 'survival');
      if (sim.player.dead) sim.respawn();
      // keep the kit stocked
      for (let i = 0; i < kit.length; i++) {
        const k = kit[i];
        if (k === null || k === undefined) continue;
        const s = sim.player.inventory.hotbar[i];
        if (s === null || s === undefined) sim.player.inventory.hotbar[i] = { item: k === I.BUCKET_WATER ? I.BUCKET_WATER : k, count: k === I.BUCKET_WATER ? 1 : 64 };
      }
      const a = performance.now();
      sim.tick();
      const dt = performance.now() - a;
      if (tick > 50 && dt > worst) worst = dt;
      expect(Number.isFinite(sim.player.pos.x + sim.player.pos.y + sim.player.pos.z)).toBe(true);
    }
    const avg = (performance.now() - t0) / 2000;
    console.log(
      `soak: avg tick ${avg.toFixed(2)} ms, worst ${worst.toFixed(1)} ms, chunks ${sim.world.chunks.size}, entities ${sim.entities.all().length}, ` +
        `structures ${sim.structures.all().length}, events ${JSON.stringify(Object.fromEntries(kinds))}, player (${sim.player.pos.x.toFixed(1)}, ${sim.player.pos.y.toFixed(1)}, ${sim.player.pos.z.toFixed(1)})`,
    );
    expect(avg).toBeLessThan(25);
  }, 60_000);
});
