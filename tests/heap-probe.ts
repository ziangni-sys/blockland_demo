/**
 * Child-process side of the allocation probes that run in both inlining conditions
 * (tests/heap-probe-run.ts starts them). Not a test file.
 *
 * Measurement as in tests/voxel/alloc-probe.ts: V8's sampling heap profiler, counting objects
 * already collected by minor and major GC, around a synchronous loop. Only optimised code is
 * meaningful (unoptimised tiers box every double), so each case is warmed up first and measured
 * up to ROUNDS times: a real allocation shows in every round, a round that ran before the
 * optimised code was installed is retried. Prints one JSON line {bytesPerCall, sampledCalls,
 * sink}; sampledCalls is how many calls of each case ran under the profiler (all rounds).
 *
 * Every round first samples a short run (SCREEN_CALLS). A case that allocates heavily (a
 * regression: a query building a 1 KB box per call) shows it there; the round keeps that number
 * and skips the long run, because a long run of such a case keeps millions of samples (one per
 * 64 bytes, collected objects included) and takes minutes, long enough for the parent's child
 * timeout to kill the probe before it can say how many bytes it saw. The round after such a
 * screen also warms up for a quarter of the usual calls: the code has run CALLS * 2 times by
 * then, and a probe of two dozen such cases still has to finish well inside that timeout on a
 * busy machine. A case that is clean, or nearly, gets the long run, which is what tells 0.05 B
 * from 1 B per call.
 */
import { Session } from 'node:inspector/promises';

/** Calls of a long sampled run; a warm-up runs twice as many. */
export const CALLS = 200_000;
export const ROUNDS = 6;
/** Stop retrying once a round is this clean (the profiler's own plumbing costs a few KB). */
const CLEAN = 0.05;
/** Calls of the short run every round samples first. */
export const SCREEN_CALLS = 2_000;
/**
 * A short run above this many bytes per call is a real allocation: the profiler's plumbing adds
 * at most a few bytes per call over SCREEN_CALLS, and the budgets are 1 byte per call.
 */
const DIRTY = 16;

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
  const sampledCalls: Record<string, number> = {};
  let sink = 0;
  /** Bytes per call of `calls` calls of `run`, sampled. */
  const sample = async (run: (n: number) => number, calls: number): Promise<number> => {
    await session.post('HeapProfiler.startSampling', sampling as never);
    sink += run(calls);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    return totalBytes(profile.head) / calls;
  };
  for (const [name, run] of Object.entries(cases)) {
    let best = Infinity;
    let dirty = false;
    let sampled = 0;
    for (let r = 0; r < ROUNDS && best > CLEAN; r++) {
      sink += run(dirty ? CALLS / 2 : CALLS * 2);
      const screen = await sample(run, SCREEN_CALLS);
      dirty = screen > DIRTY;
      sampled += dirty ? SCREEN_CALLS : SCREEN_CALLS + CALLS;
      best = Math.min(best, dirty ? screen : await sample(run, CALLS));
    }
    out[name] = best;
    sampledCalls[name] = sampled;
  }
  session.disconnect();
  process.stdout.write(JSON.stringify({ bytesPerCall: out, sampledCalls, sink }) + '\n');
}
