/**
 * Parent side of the allocation probes (see tests/heap-probe.ts): bundle a probe with rolldown
 * (the production bundler; vitest's module transform changes how V8 optimises the code under
 * test) and run it in fresh node processes, once with default inlining and once with
 * --max-inlined-bytecode-size=40. docs/SHAPES.md 4.4: an allocation-free query must not depend
 * on being inlined, so both conditions are checked.
 */
import { spawnSync } from 'node:child_process';

export const INLINING_CONDITIONS: readonly (readonly string[])[] = [[], ['--max-inlined-bytecode-size=40']];
/**
 * How long one probe process may run. Alone on an idle machine a clean probe takes 1 to 6 s, and
 * tests/voxel/struct-alloc-probe.ts with all 24 cases allocating 1 KB per call about 15 s.
 */
const CHILD_TIMEOUT_MS = 120_000;

async function bundle(probePath: string): Promise<string> {
  // rolldown is vite 8's bundler; imported lazily so a broken toolchain fails these tests only.
  const { rolldown } = await import('rolldown');
  const b = await rolldown({ input: probePath, platform: 'node', logLevel: 'silent' });
  try {
    const { output } = await b.generate({ format: 'esm' });
    return output[0].code;
  } finally {
    await b.close();
  }
}

/** What one probe process printed (tests/heap-probe.ts): per case, bytes per call and how many calls were sampled. */
export interface HeapProbeOutput {
  readonly bytesPerCall: Record<string, number>;
  readonly sampledCalls: Record<string, number>;
}

/** Bytes per call of every case of the probe, per inlining condition (keyed by the flags joined, '' for default). */
export async function runHeapProbe(probePath: string): Promise<Record<string, Record<string, number>>> {
  const out = await runHeapProbeOutputs(probePath);
  return Object.fromEntries(Object.entries(out).map(([flags, o]) => [flags, o.bytesPerCall]));
}

/** runHeapProbe with everything the probe printed. */
export async function runHeapProbeOutputs(probePath: string): Promise<Record<string, HeapProbeOutput>> {
  const code = await bundle(probePath);
  const result: Record<string, HeapProbeOutput> = {};
  for (const flags of INLINING_CONDITIONS) {
    const run = spawnSync(process.execPath, [...flags, '--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
    if (run.error !== undefined || run.signal !== null) {
      // Killed by the timeout (or not started): stderr is empty then, so say what happened.
      const why = run.signal !== null ? `was killed (${run.signal}) after ${CHILD_TIMEOUT_MS / 1000} s` : `did not run: ${run.error!.message}`;
      throw new Error(`probe ${probePath} ${flags.join(' ')} ${why} (usually a case that allocates so much that its heap profile grows huge)\n${run.stderr}`);
    }
    if (run.status !== 0) throw new Error(`probe ${probePath} ${flags.join(' ')} failed (exit ${run.status}): ${run.stderr}`);
    const { bytesPerCall, sampledCalls } = JSON.parse(run.stdout.trim().split('\n').pop()!) as HeapProbeOutput;
    result[flags.join(' ')] = { bytesPerCall, sampledCalls };
  }
  return result;
}

/** Human-readable report of runHeapProbe's result, for assertion messages. */
export function heapReport(result: Record<string, Record<string, number>>): string {
  return Object.entries(result)
    .map(([flags, cases]) => `${flags || '(default inlining)'}\n${Object.entries(cases).map(([k, v]) => `  ${k}: ${v.toFixed(2)} B/call`).join('\n')}`)
    .join('\n');
}
