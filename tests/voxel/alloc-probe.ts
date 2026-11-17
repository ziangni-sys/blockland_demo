/**
 * Child-process probe for tests/voxel/alloc.test.ts (not a test file itself).
 *
 * The test bundles this file with rolldown — like the production build, unlike vitest's
 * module transform, which changes how V8 optimises the code under test and hid the original
 * allocation — and runs it in a fresh node process. It prints one JSON object mapping each
 * case to the sampled heap bytes per call (best of several rounds, see below).
 *
 * Measurement: V8's sampling heap profiler, counting objects already collected by minor and
 * major GC, around a synchronous loop in which nothing else runs. Only optimised code is
 * meaningful (unoptimised tiers box every double), so each case is warmed up first and
 * measured up to ROUNDS times: a real allocation shows in every round, a round that ran
 * before the optimised code was installed is simply retried.
 */
import { Session } from 'node:inspector/promises';
import type { AABB } from '../../src/core/math';
import { boxOverlapsSolid, columnHasSolidBelow, hasSupportBelow, sweepAxis } from '../../src/voxel/shape';
import { box, emptyWorld, fill } from './helpers';

const CALLS = 100_000;
const ROUNDS = 6;

const world = emptyWorld();
fill(world, -10, 0, -10, 10, 5, 10); // ground, top at y = 5
// All boxes lie inside chunk (0,0), so World's single-entry chunk cache always hits (its
// misses allocate inside World itself: a known contract issue, not this module's).
const FREE: AABB[] = [box(0.2, 5, 0.2, 0.8, 6.8, 0.8), box(1.4, 5.3, 3.1, 2.2, 7.1, 3.7), box(7.7, 5.01, 4.7, 8.3, 6.81, 5.3)];
const SUNK: AABB[] = [box(0.2, 4.9, 0.2, 0.8, 6.7, 0.8), box(1.4, 4.3, 3.1, 2.2, 6.1, 3.7), box(7.7, 4.5, 4.7, 8.3, 6.3, 5.3)];

// One function per case so each gets its own optimised code and feedback.
const cases: Record<string, (n: number) => number> = {
  'boxOverlapsSolid free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, FREE[i % 3]!)) s++;
    return s;
  },
  'boxOverlapsSolid sunk': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (boxOverlapsSolid(world, SUNK[i % 3]!)) s++;
    return s;
  },
  'hasSupportBelow free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (hasSupportBelow(world, FREE[i % 3]!, 0.08, 0.1)) s++;
    return s;
  },
  'hasSupportBelow airborne': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (hasSupportBelow(world, FREE[i % 3]!, 0.005, 0.1)) s++;
    return s;
  },
  'columnHasSolidBelow free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (columnHasSolidBelow(world, FREE[i % 3]!, 2.5, 0.1)) s++;
    return s;
  },
  // Sweeps: only unobstructed moves, which return `delta` itself. A sweep blocked short of a
  // whole cell returns a fresh fractional double, which any non-inlined function must box.
  'sweepAxis x free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 0, 0.5) === 0.5) s++;
    return s;
  },
  'sweepAxis z free': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[i % 3]!, 2, -0.5) === -0.5) s++;
    return s;
  },
  'sweepAxis y up': (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) if (sweepAxis(world, SUNK[i % 3]!, 1, 0.5) === 0.5) s++;
    return s;
  },
  'sweepAxis y down blocked at a whole cell': (n) => {
    let s = 0;
    // Feet exactly on the ground (minY = 5): blocked at once, the result is the literal 0.
    for (let i = 0; i < n; i++) if (sweepAxis(world, FREE[0]!, 1, -0.5) === 0) s++;
    return s;
  },
};

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}
function totalBytes(n: ProfileNode): number {
  let t = n.selfSize;
  for (const c of n.children) t += totalBytes(c);
  return t;
}

const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
const out: Record<string, number> = {};
let sink = 0;
for (const [name, run] of Object.entries(cases)) {
  let best = Infinity;
  for (let r = 0; r < ROUNDS && best > 0.25; r++) {
    sink += run(CALLS * 2); // warm up; gives the optimising compiler time to install code
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    } as never);
    sink += run(CALLS);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    best = Math.min(best, totalBytes(profile.head) / CALLS);
  }
  out[name] = best;
}
session.disconnect();
process.stdout.write(JSON.stringify({ bytesPerCall: out, sink }) + '\n');
