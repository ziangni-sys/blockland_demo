/**
 * Import rules of src/net (docs/NETCODE.md section 15 "依赖方向"), checked by scanning the sources
 * (the same way tests/sim/single-player-guard.test.ts does):
 *  - each directory of src/net may import only what its entry in RULES allows; a directory without
 *    an entry fails;
 *  - the layers below net never import it, and only src/client may (package 9 narrows that);
 *  - in src/client, only workerfactory.ts imports net/host (the server Worker); other client
 *    modules may use PortTransport (net/host/port) and the types of the host control messages
 *    (net/host/control), nothing else of the host;
 *  - no module of src/net has module-level mutable state (LESSONS "临时向量被改写");
 *  - no module touches browser or timer globals, except the two host files that are the host's
 *    I/O: host/worker.ts (the Worker entry: self, postMessage, timers, clocks) and host/port.ts
 *    (MessagePort). net/webrtc (package 10) names the WebRTC, WebSocket and BroadcastChannel
 *    types but never constructs them: the page passes them in.
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

/** NO_DOM_OR_TIME for net/webrtc: the types of the page's connections may be named (and BroadcastChannel's postMessage called), never constructed. */
const NO_DOM_OR_TIME_BUT_RTC_TYPES =
  /\b(window|document|navigator|self|globalThis|performance|Date|Math\.random|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|MessagePort|MessageChannel|Worker|localStorage|indexedDB|fetch)\b|\bnew\s+(RTC\w+|WebSocket|BroadcastChannel)\b/;

const RULES: Record<string, Rule> = {
  // net/{protocol, codec, transport, loopback}: core, blocks, save/bytes; types from sim/view.ts,
  // from package 2's movement report and correction (entities/drive.ts) and the GeneratorSpec
  // (worldgen/generator.ts). No DOM.
  'net': {
    runtime: (t) => t.startsWith('core/') || t.startsWith('blocks/') || t === 'save/bytes' || t === 'save/cells' || isNetBase(t),
    types: (t) => t === 'sim/view' || t === 'entities/drive' || t === 'worldgen/generator',
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
  // net/webrtc (package 10): the WebRTC transport and the signallers, on the base modules only.
  // The page passes in the peer connections, sockets, BroadcastChannel, timers and randomness.
  'net/webrtc': {
    runtime: (t) => isNetBase(t) || t.startsWith('net/webrtc/'),
    types: () => false,
    forbiddenGlobals: NO_DOM_OR_TIME_BUT_RTC_TYPES,
  },
  // net/host (package 8): net/server, sim, save, worldgen and the base modules (plus core).
  'net/host': {
    runtime: (t) => ['core/', 'sim/', 'save/', 'worldgen/', 'net/server/', 'net/host/'].some((d) => t.startsWith(d)) || isNetBase(t),
    types: () => false,
    forbiddenGlobals: NO_DOM_OR_TIME,
  },
};

/** Files whose globals rule differs from their directory's: the host's I/O (section 15). */
const GLOBALS_BY_FILE: Record<string, RegExp | null> = {
  // The Worker entry owns self, postMessage, the timers and the clocks; never a page's globals.
  'net/host/worker.ts': /\b(window|document|localStorage|requestAnimationFrame|WebSocket|RTC\w+)\b/,
  // PortTransport is the one module on the MessagePort API.
  'net/host/port.ts':
    /\b(window|document|navigator|self|globalThis|performance|Date|Math\.random|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|Worker|WebSocket|RTC\w+|localStorage|indexedDB|fetch)\b/,
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
  const forbidden = file in GLOBALS_BY_FILE ? GLOBALS_BY_FILE[file]! : rule.forbiddenGlobals;
  if (forbidden !== null) {
    codeWithoutStrings(text)
      .split('\n')
      .forEach((line, i) => {
        const m = forbidden.exec(line);
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

/** Violations of the client's narrow access to net/host for one file of src/client (path relative to src, posix). */
function clientHostViolations(file: string, text: string): string[] {
  if (file === 'client/workerfactory.ts') return [];
  const out: string[] = [];
  for (const imp of imports(text)) {
    const t = target(file, imp.spec);
    if (!t.startsWith('net/host/') || t === 'net/host/port' || (t === 'net/host/control' && imp.typeOnly)) continue;
    out.push(`${file}: may not import ${imp.typeOnly ? 'types from ' : ''}'${imp.spec}' (only workerfactory.ts starts the server)`);
  }
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

  it('in src/client only workerfactory.ts imports net/host; others may use PortTransport and the control message types', () => {
    const hits = sources(join(SRC, 'client')).flatMap((f) => clientHostViolations(rel(f), readFileSync(f, 'utf8')));
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
    // Package 5's client modules: light, hull, rotor kinematics, the body movement and worldgen pass;
    // the simulation's chunk manager, persistence, the host and timers do not.
    expect(
      netViolations(
        'net/client/x.ts',
        "import { LightEngine } from '../../light/engine';\nimport { analyzeHull } from '../../structures/hull';\nimport { advanceRotor } from '../../structures/rotor';\nimport { headingOf } from '../../entities/structs';\nimport type { ChunkGenerator } from '../../worldgen/generator';\nimport { ServerClock } from './clock';",
      ),
    ).toHaveLength(0);
    expect(netViolations('net/client/x.ts', "import { ChunkManager } from '../../sim/chunks';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { exportSave } from '../../sim/persist';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { NetServer } from '../host/netserver';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', "import { StructureManager } from '../../structures/assembly';")).toHaveLength(1);
    expect(netViolations('net/client/x.ts', 'setTimeout(() => {}, 1000);')).toHaveLength(1);
    expect(netViolations('net/client/x.ts', 'requestAnimationFrame(frame);')).toHaveLength(1);
    // net/host may use the server, the simulation, saves and generators; never the client.
    expect(netViolations('net/host/x.ts', "import { Replicator } from '../server/replicator';\nimport { exportSave } from '../../sim/persist';\nimport { MemoryStorage } from '../../save/storage';")).toHaveLength(0);
    expect(netViolations('net/host/x.ts', "import { ReplicaState } from '../client/apply';")).toHaveLength(1);
    expect(netViolations('net/host/x.ts', "import { Game } from '../../client/game';")).toHaveLength(1);
    expect(netViolations('net/host/x.ts', 'const t = performance.now();\nself.postMessage(1);')).toHaveLength(2);
    expect(netViolations('net/host/worker.ts', 'const t = performance.now();\nself.postMessage(1);')).toHaveLength(0);
    expect(netViolations('net/host/worker.ts', 'document.title = "x";')).toHaveLength(1);
    expect(netViolations('net/host/port.ts', 'port.postMessage(m);\nconst p: MessagePort = q;')).toHaveLength(0);
    expect(netViolations('net/host/port.ts', 'setTimeout(f, 1);')).toHaveLength(1);
    // net/webrtc names the browser's connection types but never makes them; base modules only.
    expect(netViolations('net/webrtc/x.ts', "import { MAX_RELIABLE_BYTES } from '../protocol';\nimport { DialError } from './signal';\nlet c: RTCDataChannel | null = null;\nch.postMessage(m);")).toHaveLength(0);
    expect(netViolations('net/webrtc/x.ts', 'const pc = new RTCPeerConnection();\nconst ws = new WebSocket(u);\nsetTimeout(f, 1);')).toHaveLength(3);
    expect(netViolations('net/webrtc/x.ts', "import { NetClient } from '../client/netclient';")).toHaveLength(1);
    expect(clientHostViolations('client/x.ts', "import { PortTransport } from '../net/host/port';\nimport type { HostToPage } from '../net/host/control';")).toHaveLength(0);
    expect(clientHostViolations('client/x.ts', "import { parsePageMessage } from '../net/host/control';")).toHaveLength(1);
    expect(clientHostViolations('client/x.ts', "import { ServerHost } from '../net/host/host';\nconst w = import('../net/host/worker?worker&inline');")).toHaveLength(2);
    expect(clientHostViolations('client/workerfactory.ts', "const w = import('../net/host/worker?worker&inline');")).toHaveLength(0);
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
