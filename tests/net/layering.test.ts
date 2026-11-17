/**
 * Import rules of src/net (docs/NETCODE.md section 15 "依赖方向"), checked by scanning the sources
 * (the same way tests/sim/single-player-guard.test.ts does):
 *  - each directory of src/net may import only what its entry in RULES allows (a later package
 *    adds the entry of its directory: host); a directory without an entry fails;
 *  - the layers below net never import it, and only src/client may (package 9 narrows that);
 *  - no module of src/net has module-level mutable state (LESSONS "临时向量被改写");
 *  - the base modules touch no browser or timer globals.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

interface Rule {
  /** Targets (paths under src without extension, or package names) this directory may import at run time. */
  runtime: (target: string) => boolean;
  /** Targets it may import types from (in addition to the runtime ones). */
  types: (target: string) => boolean;
  /** Globals it must not mention. */
  forbiddenGlobals: RegExp | null;
}

/** The base modules: net/protocol, codec, transport, loopback (files directly in src/net). */
const isNetBase = (t: string): boolean => /^net\/[^/]+$/.test(t);

/** Browser, timer and clock globals: none of these modules may mention them (the host and the client's page own time and I/O). */
const NO_DOM_OR_TIME =
  /\b(window|document|navigator|self|globalThis|postMessage|performance|Date|Math\.random|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|MessagePort|MessageChannel|Worker|WebSocket|RTC\w+|localStorage|indexedDB|fetch)\b/;

const RULES: Record<string, Rule> = {
  // net/{protocol, codec, transport, loopback}: core, blocks, save/bytes; types from sim/view.ts
  // and from package 2's movement report and correction (entities/drive.ts). No DOM.
  'net': {
    runtime: (t) => t.startsWith('core/') || t.startsWith('blocks/') || t === 'save/bytes' || isNetBase(t),
    types: (t) => t === 'sim/view' || t === 'entities/drive',
    forbiddenGlobals: NO_DOM_OR_TIME,
  },
  // net/server (package 4 on): sim, structures, entities, voxel and the base modules.
  'net/server': {
    runtime: (t) =>
      ['core/', 'blocks/', 'voxel/', 'structures/', 'entities/', 'sim/', 'net/server/'].some((d) => t.startsWith(d)) || isNetBase(t),
    types: () => false,
    forbiddenGlobals: NO_DOM_OR_TIME,
  },
  // net/client: voxel, blocks, light, the structure data classes, entities, worldgen, sim/view,
  // messages and rays, and the base modules; never the simulation, the server or the host. No DOM.
  'net/client': {
    runtime: (t) =>
      ['core/', 'blocks/', 'voxel/', 'light/', 'entities/', 'worldgen/', 'net/client/'].some((d) => t.startsWith(d)) ||
      ['structures/structure', 'structures/glue', 'structures/hull', 'structures/rotor'].includes(t) ||
      ['sim/view', 'sim/messages', 'sim/rays'].includes(t) ||
      isNetBase(t),
    types: () => false,
    forbiddenGlobals: NO_DOM_OR_TIME,
  },
};

/** Directories below net in the dependency order: none of them may import net. */
const BELOW_NET = ['core', 'blocks', 'voxel', 'worldgen', 'light', 'liquid', 'structures', 'entities', 'sim', 'mesh', 'art', 'save', 'render'];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function directories(dir: string, out: string[] = []): string[] {
  out.push(dir);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) directories(p, out);
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

/** Target of an import from `file` (relative to src, posix): a path under src without extension, or the package name. */
function target(file: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.ts$/, '');
}

/** Violations of RULES for one file of src/net (path relative to src, posix). */
function netViolations(file: string, text: string): string[] {
  const dir = posix.dirname(file);
  const rule = RULES[dir];
  if (rule === undefined) return [`${file}: directory ${dir} has no import rule (add it to RULES in tests/net/layering.test.ts)`];
  const out: string[] = [];
  for (const imp of imports(text)) {
    const t = target(file, imp.spec);
    if (rule.runtime(t) || (imp.typeOnly && rule.types(t))) continue;
    out.push(`${file}: may not import ${imp.typeOnly ? 'types from ' : ''}'${imp.spec}'`);
  }
  if (rule.forbiddenGlobals !== null) {
    codeWithoutStrings(text)
      .split('\n')
      .forEach((line, i) => {
        const m = rule.forbiddenGlobals!.exec(line);
        if (m !== null) out.push(`${file}:${i + 1}: uses the global ${m[0]}`);
      });
  }
  return out;
}

/**
 * Module-level mutable state, line by line:
 *  - a top-level let / var;
 *  - a top-level const bound to a fresh object, array, Map ... (`new`, `[`, `{`), or to what a call
 *    returns (a factory, Array.from ...), unless the call is Object.freeze or a Math function;
 *  - a static class field that is not readonly, or a readonly one bound to a fresh object.
 */
const MUTABLE_STATE: readonly RegExp[] = [
  /^(export\s+)?(let|var)\s/,
  /^(export\s+)?const\s+\w+[^=]*=\s*(new\s|\[|\{)/,
  /^(export\s+)?const\s+\w+[^=]*=\s*(?!Object\.freeze\(|Math\.\w+\()[A-Za-z_$][\w$.]*(<[^=]*>)?\(/,
  /^\s+((public|private|protected|declare|override)\s+)*static\s+(?!readonly\b|async\b|get\b|set\b|\{|\*)[\w$]+\s*[?!]?\s*[:=;]/,
  /^\s+((public|private|protected|declare|override)\s+)*static\s+readonly\s+[\w$]+[^=(]*=\s*(new\s|\[|\{)/,
];
function mutableState(file: string, text: string): string[] {
  const out: string[] = [];
  code(text)
    .split('\n')
    .forEach((line, i) => {
      if (MUTABLE_STATE.some((re) => re.test(line))) out.push(`${file}:${i + 1}: module-level mutable state: ${line.trim()}`);
    });
  return out;
}

const rel = (p: string): string => relative(SRC, p).replace(/\\/g, '/');

describe('src/net import rules (NETCODE section 15)', () => {
  it('every directory of src/net has an import rule', () => {
    const missing = directories(join(SRC, 'net'))
      .map(rel)
      .filter((d) => RULES[d] === undefined);
    expect(missing).toEqual([]);
  });

  it('every module of src/net imports only what its directory may', () => {
    const hits = sources(join(SRC, 'net')).flatMap((f) => netViolations(rel(f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no module of src/net has module-level mutable state', () => {
    const hits = sources(join(SRC, 'net')).flatMap((f) => mutableState(rel(f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the layers below net never import it; outside net only src/client may', () => {
    const hits: string[] = [];
    for (const f of sources(SRC)) {
      const file = rel(f);
      const top = file.split('/')[0]!;
      if (top === 'net' || top === 'client') continue;
      for (const imp of imports(readFileSync(f, 'utf8'))) {
        if (target(file, imp.spec).startsWith('net/')) hits.push(`${file}: imports '${imp.spec}'${BELOW_NET.includes(top) ? ' (a layer below net)' : ''}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the checks catch what they should', () => {
    const base = 'net/codec.ts';
    const bad = (src: string): string[] => netViolations(base, src);
    expect(bad("import { Simulation } from '../sim/simulation';")).toHaveLength(1);
    expect(bad("import type { Simulation } from '../sim/simulation';")).toHaveLength(1);
    expect(bad("import { emptyView } from '../sim/view';")).toHaveLength(1); // runtime: types only
    expect(bad("import { type Message } from '../sim/view';")).toHaveLength(0);
    expect(bad("import type { MoveReport } from '../entities/drive';")).toHaveLength(0);
    expect(bad("import { World } from '../voxel/world';")).toHaveLength(1);
    expect(bad("import { decodeChunk } from '../save/codec';")).toHaveLength(1);
    expect(bad("import { ByteReader } from '../save/bytes';\nimport { Rng } from '../core/rng';\nimport { RELIABLE } from './transport';")).toHaveLength(0);
    expect(bad("import * as THREE from 'three';")).toHaveLength(1);
    expect(bad("export { x } from '../client/game';")).toHaveLength(1);
    expect(bad("const m = import('../sim/players');")).toHaveLength(1);
    expect(bad('const t = performance.now();')).toHaveLength(1);
    expect(bad("// performance.now() in a comment\nconst s = 'window';")).toHaveLength(0);
    expect(netViolations('net/elsewhere/x.ts', '')).toHaveLength(1);
    // net/server may use the simulation; net/client may not, nor the server or the host.
    expect(netViolations('net/server/x.ts', "import type { Simulation } from '../../sim/simulation';\nimport { World } from '../../voxel/world';")).toHaveLength(0);
    expect(netViolations('net/server/x.ts', "import { encodeTickBatch } from '../codec';\nimport { ChangeCapture } from './capture';")).toHaveLength(0);
    expect(netViolations('net/server/x.ts', "import { NetServer } from '../host/netserver';")).toHaveLength(1);
    expect(netViolations('net/server/x.ts', "import { decodeChunk } from '../../save/codec';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { GlueStore } from '../../structures/glue';\nimport { World } from '../../voxel/world';\nimport type { Message } from '../../sim/view';")).toHaveLength(0);
    expect(netViolations('net/client/x.ts', "import type { Simulation } from '../../sim/simulation';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { StructureManager } from '../../structures/manager';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { Replicator } from '../server/replicator';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', 'const t = performance.now();')).toHaveLength(1);
    expect(mutableState(base, 'let scratch = 0;\nexport const cache = new Map();\nconst tmp = [];\nconst T = Object.freeze({ a: 1 });\nconst N = 4;')).toHaveLength(3);
    // Factories and static fields; frozen values, Math, arrow functions and static methods pass.
    const state = [
      'const cache = makeCache();',
      'export const ids: number[] = Array.from({ length: 4 }, (_, i) => i);',
      'class A {\n  static count = 0;\n  private static pool: number[];\n  static readonly seen = new Set<number>();\n}',
    ].join('\n');
    expect(mutableState(base, state)).toHaveLength(5);
    const fine = [
      'const T = Object.freeze(Array.from({ length: 4 }, (_, i) => i));',
      'export const M = Math.max(1, 2);',
      'const f = (x: number): number => x + 1;',
      'const g = async (x: number): Promise<number> => x;',
      'class B {\n  static readonly LIMIT = 4;\n  static of(x: number): B {\n    return new B();\n  }\n  static async load(): Promise<void> {}\n  static get zero(): number {\n    return 0;\n  }\n}',
    ].join('\n');
    expect(mutableState(base, fine)).toEqual([]);
    // Line numbers count the lines of block comments.
    expect(mutableState(base, '/**\n * two\n * lines\n */\nconst a = 1; /* one\n more */\nlet b = 2;')).toEqual(['net/codec.ts:7: module-level mutable state: let b = 2;']);
    expect(bad('/*\n\n*/\nconst t = performance.now();')).toEqual(['net/codec.ts:4: uses the global performance']);
  });
});
