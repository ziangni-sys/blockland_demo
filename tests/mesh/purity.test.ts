/**
 * The mesher is simulation-layer code (it runs in a Worker and in Node): no DOM, no render
 * library, no clocks, no unseeded randomness, no module-level `let`. A static scan keeps it so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../src/mesh');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Source without comments and string literals, so prose cannot trip the scan. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

describe('mesh module purity', () => {
  const files = sources(ROOT).filter((f) => !f.endsWith('types.ts'));

  it('finds the module sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const f of files) {
    it(`${f.slice(ROOT.length + 1)} uses no forbidden globals`, () => {
      const raw = readFileSync(f, 'utf8');
      const src = code(raw);
      expect(raw).not.toMatch(/from\s+['"]three/);
      for (const banned of [/\bMath\.random\b/, /\bperformance\b/, /\bDate\b/, /\bwindow\b/, /\bdocument\b/, /\bsetTimeout\b/, /\bsetInterval\b/]) {
        expect(src, String(banned)).not.toMatch(banned);
      }
      // no module-level mutable bindings
      expect(src).not.toMatch(/^(export\s+)?let\s/m);
      expect(src).not.toMatch(/^(export\s+)?var\s/m);
      // `self` is only touched by the worker entry
      if (!f.endsWith('worker.ts')) expect(src).not.toMatch(/\bself\b/);
    });
  }
});
