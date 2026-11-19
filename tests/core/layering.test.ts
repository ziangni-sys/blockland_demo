/**
 * Layering of src outside src/net (docs/SHAPES.md 16.2 P1; docs/ARCHITECTURE.md "分层与依赖方向"),
 * checked by scanning the sources the way tests/net/layering.test.ts does. src/net is covered by
 * that test and src/client by tests/client/no-simulation.test.ts, so neither is checked here.
 *
 *  1. Import direction: each top-level directory of src imports only the directories its RULES
 *     entry lists (anything inside itself is free; "types" = `import type` only). A directory
 *     without an entry fails.
 *  2. Module-level caches in the simulation directories: no top-level let / var, and no top-level
 *     const bound to an EMPTY container (new Map / Set / WeakMap / WeakSet, [] or {}), except the
 *     block registry's own tables, which registerBlock fills while the module loads. Typed-array
 *     constant tables and literals with contents are allowed: a scan cannot tell a table filled
 *     at load from a cache filled on use, so that part is left to review.
 *  3. Forbidden globals in the simulation directories (in save: only the pure codec files):
 *     no DOM, clock, timer, randomness or browser storage (ARCHITECTURE hard rule 1).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

interface Rule {
  /** Directories (top-level names) or single module paths this directory may import at run time. */
  runtime: readonly string[];
  /** Additional directories or module paths it may import types from. */
  types: readonly string[];
  /** Package names (and their subpaths) it may import. */
  packages?: readonly string[];
}

/** The table of docs/SHAPES.md 16.2 P1 (built from the imports at c20ea8e and the layer diagram). */
const RULES: Record<string, Rule> = {
  core: { runtime: [], types: [] },
  blocks: { runtime: ['core'], types: [] },
  voxel: { runtime: ['core', 'blocks'], types: [] },
  worldgen: { runtime: ['core', 'blocks', 'voxel'], types: [] },
  light: { runtime: ['core', 'blocks', 'voxel'], types: [] },
  liquid: { runtime: ['core', 'blocks', 'voxel'], types: [] },
  save: { runtime: ['core', 'blocks'], types: ['voxel'] },
  // save/cells only: structures/serialize.ts calls its writeCell / readCell.
  structures: { runtime: ['core', 'blocks', 'voxel', 'save/cells'], types: ['save'] },
  entities: { runtime: ['core', 'blocks', 'voxel', 'structures'], types: ['save'] },
  sim: { runtime: ['core', 'blocks', 'voxel', 'worldgen', 'liquid', 'structures', 'entities', 'save'], types: [] },
  mesh: { runtime: ['core', 'blocks'], types: ['voxel'] },
  art: { runtime: ['core', 'blocks'], types: ['render'] },
  render: { runtime: ['core', 'blocks', 'mesh'], types: [], packages: ['three'] },
  ui: { runtime: ['core', 'blocks'], types: [] },
};
/** Checked by other tests (see the header). */
const ELSEWHERE = ['net', 'client'];

/** Directories where module-level caches and the forbidden globals are checked. */
const SIMULATION = ['core', 'blocks', 'voxel', 'worldgen', 'light', 'liquid', 'structures', 'entities', 'sim', 'mesh', 'save'];
/** In save, only the pure codec files are checked for globals (the storage adapters are browser I/O). */
const SAVE_PURE = ['save/bytes.ts', 'save/cells.ts', 'save/codec.ts', 'save/crc32.ts'];
/** Module-level containers that registerBlock fills while the module loads. */
const REGISTRY_TABLES: Record<string, readonly string[]> = {
  'blocks/registry.ts': ['BLOCK_BY_KEY', 'TILE_NAMES', 'tileIndex'],
  'blocks/items.ts': ['ITEMS'],
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip comments, keeping their line breaks so line numbers stay right (keep strings: module specifiers are strings). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Also strip single-line string literals (for the globals check). */
function codeWithoutStrings(text: string): string {
  return code(text).replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
}

interface Import {
  spec: string;
  typeOnly: boolean;
}

function imports(text: string): Import[] {
  const out: Import[] = [];
  const src = code(text);
  for (const m of src.matchAll(/\b(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[2]!.trim();
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    const allTypes =
      braces !== null &&
      braces[1]!
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .every((s) => s.startsWith('type '));
    out.push({ spec: m[3]!, typeOnly: m[1] !== undefined || allTypes });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push({ spec: (m[1] ?? m[2])!, typeOnly: false });
  }
  return out;
}

/** Target of an import from `file` (relative to src, posix): a path under src without extension, or null for a package. */
function target(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.ts$/, '');
}

/** True when target (a path under src) is named by an entry: a top-level directory or a module path. */
const named = (entries: readonly string[], t: string): boolean => entries.some((e) => (e.includes('/') ? t === e : t.split('/')[0] === e));

/** Rule 1 for one file (path relative to src, posix). */
function importViolations(file: string, text: string): string[] {
  const top = file.split('/')[0]!;
  if (ELSEWHERE.includes(top)) return [];
  const rule = RULES[top];
  if (rule === undefined || !file.includes('/')) return [`${file}: directory ${file.includes('/') ? top : '(src)'} has no import rule (add it to RULES in tests/core/layering.test.ts)`];
  const out: string[] = [];
  for (const imp of imports(text)) {
    const t = target(file, imp.spec);
    if (t === null) {
      const pkg = imp.spec.split('/')[0]!;
      if (!(rule.packages ?? []).includes(pkg)) out.push(`${file}: may not import the package '${imp.spec}'`);
      continue;
    }
    if (t.split('/')[0] === top || named(rule.runtime, t) || (imp.typeOnly && named(rule.types, t))) continue;
    out.push(`${file}: may not import ${imp.typeOnly ? 'types from ' : ''}'${imp.spec}'`);
  }
  return out;
}

const TOP_LET = /^(export\s+)?(let|var)\s/;
const TOP_EMPTY_CONTAINER =
  /^(export\s+)?const\s+([\w$]+)\s*(:[^=]+)?=\s*(new\s+(Map|Set|WeakMap|WeakSet)\s*(<.*>)?\s*\(\s*\)|\[\s*\]|\{\s*\})\s*(as\s+[^;]+)?;?\s*$/;

/** Rule 2 for one file. */
function cacheViolations(file: string, text: string): string[] {
  const out: string[] = [];
  const allowed = REGISTRY_TABLES[file] ?? [];
  code(text)
    .split('\n')
    .forEach((line, i) => {
      if (TOP_LET.test(line)) out.push(`${file}:${i + 1}: top-level let / var: ${line.trim()}`);
      const m = TOP_EMPTY_CONTAINER.exec(line);
      if (m !== null && !allowed.includes(m[2]!)) out.push(`${file}:${i + 1}: module-level empty container (a cache filled on use?): ${line.trim()}`);
    });
  return out;
}

const FORBIDDEN_GLOBALS = /\b(window|document|navigator|performance|Date|Math\.random|setTimeout|setInterval|requestAnimationFrame|localStorage|indexedDB)\b/;

/** Rule 3 for one file. */
function globalViolations(file: string, text: string): string[] {
  const out: string[] = [];
  codeWithoutStrings(text)
    .split('\n')
    .forEach((line, i) => {
      const m = FORBIDDEN_GLOBALS.exec(line);
      if (m !== null) out.push(`${file}:${i + 1}: uses the global ${m[0]}`);
    });
  return out;
}

const rel = (p: string): string => relative(SRC, p).replace(/\\/g, '/');
const inSimulation = (file: string): boolean => SIMULATION.includes(file.split('/')[0]!);
const globalsChecked = (file: string): boolean => inSimulation(file) && (!file.startsWith('save/') || SAVE_PURE.includes(file));

describe('src layering outside net (SHAPES 16.2 P1)', () => {
  it('every top-level directory of src has an import rule (or is checked elsewhere)', () => {
    const dirs = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory());
    expect(dirs.filter((d) => RULES[d] === undefined && !ELSEWHERE.includes(d))).toEqual([]);
    expect(readdirSync(SRC).filter((n) => n.endsWith('.ts'))).toEqual([]);
  });

  it('every module imports only what its directory may', () => {
    const hits = sources(SRC).flatMap((f) => importViolations(rel(f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no module of the simulation keeps a module-level cache', () => {
    const hits = sources(SRC)
      .filter((f) => inSimulation(rel(f)))
      .flatMap((f) => cacheViolations(rel(f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no module of the simulation touches DOM, clock, timer, randomness or browser storage globals', () => {
    const hits = sources(SRC)
      .filter((f) => globalsChecked(rel(f)))
      .flatMap((f) => globalViolations(rel(f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the checks catch what they should', () => {
    // Rule 1: direction, type-only imports, single-file exceptions, packages, unknown directories.
    expect(importViolations('blocks/x.ts', "import { World } from '../voxel/world';")).toHaveLength(1);
    expect(importViolations('blocks/x.ts', "import { Rng } from '../core/rng';\nimport { SOLID } from './registry';")).toHaveLength(0);
    expect(importViolations('core/x.ts', "import { B } from '../blocks/defs';")).toHaveLength(1);
    expect(importViolations('voxel/x.ts', "import { solidFill } from '../blocks/shapes';")).toHaveLength(0);
    expect(importViolations('voxel/x.ts', "import { Simulation } from '../sim/simulation';")).toHaveLength(1);
    expect(importViolations('mesh/x.ts', "import type { VoxelGrid } from '../voxel/grid';")).toHaveLength(0);
    expect(importViolations('mesh/x.ts', "import { type VoxelGrid } from '../voxel/grid';")).toHaveLength(0);
    expect(importViolations('mesh/x.ts', "import { World } from '../voxel/world';")).toHaveLength(1);
    expect(importViolations('mesh/shapes/x.ts', "import { World } from '../../voxel/world';")).toHaveLength(1);
    expect(importViolations('structures/x.ts', "import { writeCell } from '../save/cells';")).toHaveLength(0);
    expect(importViolations('structures/physics/x.ts', "import { writeCell } from '../../save/cells';")).toHaveLength(0);
    expect(importViolations('structures/x.ts', "import { encodeChunk } from '../save/codec';")).toHaveLength(1);
    expect(importViolations('structures/x.ts', "import type { ByteReader } from '../save/bytes';")).toHaveLength(0);
    expect(importViolations('structures/x.ts', "import { ChunkManager } from '../sim/chunks';")).toHaveLength(1);
    expect(importViolations('entities/x.ts', "import { StructureManager } from '../structures/manager';")).toHaveLength(0);
    expect(importViolations('sim/x.ts', "import { encodeChunk } from '../save/codec';\nimport { Fluids } from '../liquid/fluids';")).toHaveLength(0);
    expect(importViolations('sim/x.ts', "import { LightEngine } from '../light/engine';")).toHaveLength(1);
    expect(importViolations('sim/x.ts', "import { Replicator } from '../net/server/replicator';")).toHaveLength(1);
    expect(importViolations('art/x.ts', "import type { TileSet } from '../render/backend';")).toHaveLength(0);
    expect(importViolations('art/x.ts', "import { makeBackend } from '../render/backend';")).toHaveLength(1);
    expect(importViolations('render/three/x.ts', "import * as THREE from 'three/webgpu';\nimport { buildMesh } from '../../mesh/mesher';")).toHaveLength(0);
    expect(importViolations('mesh/x.ts', "import * as THREE from 'three';")).toHaveLength(1);
    expect(importViolations('ui/x.ts', "import { Game } from '../client/game';")).toHaveLength(1);
    expect(importViolations('blocks/x.ts', "export { x } from '../voxel/world';")).toHaveLength(1);
    expect(importViolations('blocks/x.ts', "const m = import('../sim/players');")).toHaveLength(1);
    expect(importViolations('newdir/x.ts', '')).toHaveLength(1);
    expect(importViolations('net/x.ts', "import { World } from '../voxel/world';")).toHaveLength(0); // checked by tests/net
    // Rule 2: top-level let / var and empty containers; registry tables and filled tables pass.
    const caches = [
      'let cache: number[] | null = null;',
      'var n = 0;',
      'export let last = 0;',
      'const seen = new Map();',
      'const byKey = new Map<string, Array<number>>();',
      'export const pool: number[] = [];',
      'const memo = {} as Record<string, number>;',
      'const s = new WeakSet<object>();',
      'const BLOCK_BY_KEY = new Map();',
    ].join('\n');
    expect(cacheViolations('voxel/x.ts', caches)).toHaveLength(9);
    const fine = [
      'export const SOLID = new Uint8Array(1024);',
      'const T: readonly number[] = Object.freeze([1, 2]);',
      'const DIRS = [0, 1, 2];',
      'const O = { a: 1 };',
      'const N = 4;',
      'function f(): void {\n  let x = 0;\n  const m = new Map();\n}',
    ].join('\n');
    expect(cacheViolations('voxel/x.ts', fine)).toEqual([]);
    expect(cacheViolations('blocks/registry.ts', 'export const BLOCK_BY_KEY: Map<string, BlockDef> = new Map();\nexport const TILE_NAMES: string[] = [];\nconst tileIndex = new Map<string, number>();')).toEqual([]);
    expect(cacheViolations('blocks/items.ts', 'const ITEMS = new Map<number, ItemDef>();\nconst OTHER = new Map();')).toHaveLength(1);
    expect(cacheViolations('voxel/x.ts', '/**\n * let a = 1;\n */\nlet b = 2;')).toEqual(['voxel/x.ts:4: top-level let / var: let b = 2;']);
    // Rule 3: globals, not in comments or strings; save only in its pure files.
    expect(globalViolations('sim/x.ts', 'const t = performance.now();')).toHaveLength(1);
    expect(globalViolations('sim/x.ts', 'const r = Math.random();\nconst d = new Date();\nsetTimeout(f, 1);\nwindow.x = 1;')).toHaveLength(4);
    expect(globalViolations('sim/x.ts', "// performance.now()\nconst s = 'window';\nconst updateDate = 1;")).toHaveLength(0);
    expect(globalsChecked('save/codec.ts')).toBe(true);
    expect(globalsChecked('save/idb.ts')).toBe(false);
    expect(globalsChecked('render/three/backend.ts')).toBe(false);
    expect(globalsChecked('mesh/mesher.ts')).toBe(true);
  });
});
