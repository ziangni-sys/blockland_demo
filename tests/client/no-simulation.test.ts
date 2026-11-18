/**
 * The browser game runs through the server (docs/NETCODE.md section 15, package 9): src/client
 * never creates or reads a Simulation. It may use the network client (net/client), the protocol,
 * the pure modules below them (voxel, blocks, structures' data classes, entities' movement and
 * inventory, sim/view, sim/messages, sim/rays, sim/rules) and the render layer; the game server's
 * code is loaded only by client/workerfactory.ts (the server Worker and its main-thread fallback),
 * which tests/net/layering.test.ts checks. This test scans the imports of src/client.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT = join(__dirname, '..', '..', 'src', 'client');

/** Modules of the simulation and the server that the client must not import (paths under src, no extension). */
const FORBIDDEN: readonly RegExp[] = [
  /^sim\/(simulation|players|interact|chunks|persist|exampleShip|starter|blockupdates|explosion|rabbits)$/,
  /^structures\/(manager|assembly|collect|physics(\/.*)?)$/,
  /^entities\/manager$/,
  /^liquid\//,
  /^net\/server\//,
];

function specs(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^'";]*?\s*from\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  return out;
}

function violations(file: string, text: string): string[] {
  const out: string[] = [];
  for (const spec of specs(text)) {
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join('client', spec)).replace(/\.ts$/, '').replace(/\?.*$/, '');
    if (FORBIDDEN.some((re) => re.test(target))) out.push(`client/${file}: imports '${spec}'`);
  }
  return out;
}

describe('src/client reads the replica, never a Simulation', () => {
  it('no module of src/client imports the simulation, its rules or the server', () => {
    const hits = readdirSync(CLIENT)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => violations(f, readFileSync(join(CLIENT, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the check catches what it should', () => {
    expect(violations('x.ts', "import { Simulation } from '../sim/simulation';")).toHaveLength(1);
    expect(violations('x.ts', "import type { PlayerControl } from '../sim/players';")).toHaveLength(1);
    expect(violations('x.ts', "const m = import('../sim/persist');")).toHaveLength(1);
    expect(violations('x.ts', "import { StructureManager } from '../structures/manager';")).toHaveLength(1);
    expect(violations('x.ts', "import { Replicator } from '../net/server/replicator';")).toHaveLength(1);
    expect(violations('x.ts', "import { formatMessage } from '../sim/messages';\nimport { lookDir } from '../sim/rays';\nimport { Ship } from '../structures/structure';")).toHaveLength(0);
    expect(violations('x.ts', "// import { Simulation } from '../sim/simulation';")).toHaveLength(0);
  });
});
