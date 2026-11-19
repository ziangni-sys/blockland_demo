/**
 * Child-process side of the allocation probes that run in both inlining conditions
 * (tests/heap-probe-run.ts starts them). Not a test file.
 *
 * Measurement as in tests/voxel/alloc-probe.ts: V8's sampling heap profiler, counting objects
 * already collected by minor and major GC, around a synchronous loop. Only optimised code is
 * meaningful (unoptimised tiers box every double), so each case is warmed up first and measured
 * up to ROUNDS times: a real allocation shows in every round, a round that ran before the
 * optimised code was installed is retried. Prints one JSON line {bytesPerCall, sink}.
 */
import { Session } from 'node:inspector/promises';

const CALLS = 200_000;
const ROUNDS = 6;
/** Stop retrying once a round is this clean (the profiler's own plumbing costs a few KB). */
const CLEAN = 0.05;

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}
function totalBytes(n: ProfileNode): number {
  let t = n.selfSize;
  for (const c of n.children) t += totalBytes(c);
  return t;
}

/** Each case runs its operation n times and returns a checksum (kept so nothing is dead code). */
export async function measureCases(cases: Record<string, (n: number) => number>): Promise<void> {
  const sampling = { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true };
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  // A throwaway session first: the profiler's first start allocates internal structures.
  await session.post('HeapProfiler.startSampling', sampling as never);
  await session.post('HeapProfiler.stopSampling');
  const out: Record<string, number> = {};
  let sink = 0;
  for (const [name, run] of Object.entries(cases)) {
    let best = Infinity;
    for (let r = 0; r < ROUNDS && best > CLEAN; r++) {
      sink += run(CALLS * 2);
      await session.post('HeapProfiler.startSampling', sampling as never);
      sink += run(CALLS);
      const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
      best = Math.min(best, totalBytes(profile.head) / CALLS);
    }
    out[name] = best;
  }
  session.disconnect();
  process.stdout.write(JSON.stringify({ bytesPerCall: out, sink }) + '\n');
}
