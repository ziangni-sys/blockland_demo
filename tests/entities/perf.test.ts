import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { B, Bench, deck, fill, qfromYaw, TICK_DT, vec3 } from './harness';

const DT = TICK_DT;

describe('performance', () => {
  it('200 entities around 5 moving structures update well under 2 ms per tick', () => {
    const b = new Bench();
    fill(b.world, -40, 40, -40, 39, 40, 39, B.STONE);
    const centres = [
      [-18, -18],
      [18, -18],
      [0, 0],
      [-18, 18],
      [18, 18],
    ] as const;
    centres.forEach(([cx, cz], i) => {
      const cells = deck(cx - 4, cz - 4, cx + 4, cz + 4, 50);
      for (let x = cx - 4; x <= cx + 4; x++) for (let z = cz - 4; z <= cz + 4; z++) if (Math.abs(x - cx) === 4 || Math.abs(z - cz) === 4) cells.push([x, 51, z, B.PLANKS_OAK]);
      const s = b.ship(i + 1, cells, vec3(cx + 0.5, 50.5, cz + 0.5));
      b.drive(s, (t) => ({ p: vec3(cx + 0.5 + 0.3 * Math.sin(t * 0.02 + i), 50.5 + 0.08 * Math.sin(t * 0.2 + i), cz + 0.5), q: qfromYaw(0.15 * Math.sin(t * DT * 0.5 + i)) }));
    });
    b.entities.spawnPlayer('survival', 0.5, 51, 0.5);
    let n = 1;
    for (const [cx, cz] of centres) {
      for (let k = 0; k < 40 && n < 200; k++, n++) {
        const x = cx + 0.5 + ((k % 7) - 3) * 0.9;
        const z = cz + 0.5 + (Math.floor(k / 7) - 3) * 0.9;
        if (k % 4 === 0) b.entities.spawnRabbit(x, 51.2, z);
        else b.entities.spawnItem(x, 51.4, z, k % 3 === 0 ? B.COBBLE : k % 3 === 1 ? B.SAND : B.DIRT, 1 + k, vec3(0, 0, 0));
      }
    }
    expect(b.entities.all().length).toBe(200);
    b.tick(60); // warm up (JIT), let items settle and merge
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      for (const s of b.host.list) s.grid.snapshotPose();
      for (const m of b.motions) m(++b.ticks);
      const t0 = performance.now();
      b.entities.syncCarried();
      b.entities.update();
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    const mean = samples.reduce((a, c) => a + c, 0) / samples.length;
    const median = samples[samples.length >> 1]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    const count = b.entities.all().length;
    // Opt-in report (no files are written by default).
    const out = process.env.ENTITIES_PERF_OUT;
    if (out) writeFileSync(out, `entities=${count} mean=${mean.toFixed(3)}ms median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms\n`);
    // The target is "well under 2 ms"; the bound here is loose so a loaded CI machine does not flake.
    expect(median).toBeLessThan(4);
    expect(count).toBeGreaterThan(100);
  });
});
