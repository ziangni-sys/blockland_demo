/**
 * Global setup of the test run (vitest.config.ts): the two acceptance projects must run the same
 * ticks (docs/NETCODE.md section 16, scenario 30; tests/acceptance/world.ts, THE SAME TICKS IN
 * BOTH MODES). Each project logs the tick count of every world of every passed test
 * (world.ts finishWorlds) into a directory made here; at the end of the run, every world logged by
 * both projects must have the same count. A run of one project alone (or of tests only one of them
 * ran, such as the direct-only ones) compares nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

interface Entry {
  file: string;
  test: string;
  world: number;
  ticks: number;
}

function read(path: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue;
    const e = JSON.parse(line) as Entry;
    out.set(`${e.file} > ${e.test} > world ${e.world}`, e.ticks);
  }
  return out;
}

/** The worlds both projects logged with different tick counts. */
export function tickMismatches(direct: Map<string, number>, network: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, d] of direct) {
    const n = network.get(k);
    if (n !== undefined && n !== d) out.push(`${k}: direct ${d} ticks, network ${n}`);
  }
  return out;
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'blocklands-ticks-'));
  project.provide('tickParityDir', dir);
  return () => {
    try {
      const direct = read(join(dir, 'direct.jsonl'));
      const network = read(join(dir, 'network.jsonl'));
      const bad = tickMismatches(direct, network);
      if (bad.length > 0) {
        throw new Error(`the acceptance tests ran different ticks in the two modes (tests/acceptance/world.ts):\n  ${bad.join('\n  ')}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
