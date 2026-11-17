/**
 * Allocation regression check for the World fast paths of shape.ts (the brief requires zero
 * heap allocation per call in boxOverlapsSolid / sweepAxis on the World; hasSupportBelow and
 * columnHasSolidBelow share the same scan).
 *
 * Measured with V8's sampling heap profiler, counting objects already collected by minor GC,
 * over a synchronous loop in which nothing else runs on this thread. Only optimised code is
 * meaningful (unoptimised tiers box every double), so each query is warmed up first and the
 * measurement is repeated a few times: a real regression allocates in every round, while a
 * round that ran before the optimised code was installed is simply retried.
 *
 * Both the FREE case (the scan runs to completion: the common case, and the one that used to
 * allocate ~30 B per call) and the HIT case (early exit) are covered.
 */
import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import type { AABB } from '../../src/core/math';
import { boxOverlapsSolid, columnHasSolidBelow, hasSupportBelow, sweepAxis } from '../../src/voxel/shape';
import { box, emptyWorld, fill } from './helpers';

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}

function totalBytes(n: ProfileNode): number {
  let t = n.selfSize;
  for (const c of n.children) t += totalBytes(c);
  return t;
}

/** Sampled bytes per call of `run(calls)`, the best of `rounds` measurements. */
async function bytesPerCall(session: Session, run: (calls: number) => number, calls: number, rounds: number): Promise<number> {
  let best = Infinity;
  let sink = 0;
  for (let r = 0; r < rounds && best > 0.5; r++) {
    sink += run(calls * 2); // warm-up / give the optimising compiler time to install code
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    } as never);
    sink += run(calls);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    best = Math.min(best, totalBytes(profile.head) / calls);
  }
  expect(sink).toBeGreaterThanOrEqual(0); // keep the loops observable
  return best;
}

describe('World fast paths do not allocate', () => {
  it('boxOverlapsSolid / hasSupportBelow / columnHasSolidBelow / sweepAxis, free and blocked boxes', async () => {
    const w = emptyWorld();
    fill(w, -10, 0, -10, 10, 5, 10); // ground, top at y = 5
    // Free boxes (standing on or hovering over the ground) and boxes sunk into it; all inside
    // chunk (0,0) so World's chunk cache always hits (its misses allocate inside World).
    const free: AABB[] = [box(0.2, 5, 0.2, 0.8, 6.8, 0.8), box(1.4, 5.3, 3.1, 2.2, 7.1, 3.7), box(7.7, 5.01, 4.7, 8.3, 6.81, 5.3)];
    const sunk: AABB[] = [box(0.2, 4.9, 0.2, 0.8, 6.7, 0.8), box(1.4, 4.3, 3.1, 2.2, 6.1, 3.7), box(7.7, 4.5, 4.7, 8.3, 6.3, 5.3)];
    const session = new Session();
    session.connect();
    await session.post('HeapProfiler.enable');
    try {
      const cases: Array<[string, (calls: number) => number]> = [];
      for (const [label, set] of [
        ['free', free],
        ['sunk', sunk],
      ] as const) {
        cases.push([
          `boxOverlapsSolid ${label}`,
          (calls) => {
            let s = 0;
            for (let i = 0; i < calls; i++) if (boxOverlapsSolid(w, set[i % 3]!)) s++;
            return s;
          },
        ]);
        cases.push([
          `hasSupportBelow ${label}`,
          (calls) => {
            let s = 0;
            for (let i = 0; i < calls; i++) if (hasSupportBelow(w, set[i % 3]!, 0.08, 0.1)) s++;
            return s;
          },
        ]);
        cases.push([
          `columnHasSolidBelow ${label}`,
          (calls) => {
            let s = 0;
            for (let i = 0; i < calls; i++) if (columnHasSolidBelow(w, set[i % 3]!, 2.5, 0.1)) s++;
            return s;
          },
        ]);
        // Only unobstructed sweeps: they return `delta` itself. A blocked sweep returns a fresh
        // fractional double, which any non-inlined JS function has to box.
        const sunkSet = label === 'sunk';
        cases.push([
          `sweepAxis ${label}`,
          (calls) => {
            let s = 0;
            for (let i = 0; i < calls; i++) {
              const k = i % 3;
              const axis = sunkSet || k === 2 ? 1 : k === 0 ? 0 : 2;
              if (sweepAxis(w, set[k]!, axis, 0.5) === 0.5) s++;
            }
            return s;
          },
        ]);
      }
      const results: string[] = [];
      for (const [name, run] of cases) {
        const b = await bytesPerCall(session, run, 100_000, 6);
        results.push(`${name}: ${b.toFixed(2)} B/call`);
        expect(b, results.join('\n')).toBeLessThan(0.5);
      }
    } finally {
      await session.post('HeapProfiler.disable');
      session.disconnect();
    }
  }, 30_000);
});
