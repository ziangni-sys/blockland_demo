/**
 * Parent side of the allocation probes (see tests/heap-probe.ts): bundle a probe with rolldown
 * (the production bundler; vitest's module transform changes how V8 optimises the code under
 * test) and run it in fresh node processes, once with default inlining and once with
 * --max-inlined-bytecode-size=40. docs/SHAPES.md 4.4: an allocation-free query must not depend
 * on being inlined, so both conditions are checked.
 */
import { spawnSync } from 'node:child_process';

export const INLINING_CONDITIONS: readonly (readonly string[])[] = [[], ['--max-inlined-bytecode-size=40']];

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

/** Bytes per call of every case of the probe, per inlining condition (keyed by the flags joined, '' for default). */
export async function runHeapProbe(probePath: string): Promise<Record<string, Record<string, number>>> {
  const code = await bundle(probePath);
  const result: Record<string, Record<string, number>> = {};
  for (const flags of INLINING_CONDITIONS) {
    const run = spawnSync(process.execPath, [...flags, '--input-type=module', '-'], { input: code, encoding: 'utf8', timeout: 120_000 });
    if (run.status !== 0) throw new Error(`probe ${probePath} ${flags.join(' ')} failed: ${run.stderr}`);
    result[flags.join(' ')] = (JSON.parse(run.stdout.trim().split('\n').pop()!) as { bytesPerCall: Record<string, number> }).bytesPerCall;
  }
  return result;
}

/** Human-readable report of runHeapProbe's result, for assertion messages. */
export function heapReport(result: Record<string, Record<string, number>>): string {
  return Object.entries(result)
    .map(([flags, cases]) => `${flags || '(default inlining)'}\n${Object.entries(cases).map(([k, v]) => `  ${k}: ${v.toFixed(2)} B/call`).join('\n')}`)
    .join('\n');
}
