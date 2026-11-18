/**
 * Guard for scenario 30 (docs/NETCODE.md section 16): the acceptance tests run in two modes
 * (tests/acceptance/world.ts), and they are fair in both only if they act through the test world's
 * player. This scans tests/acceptance for the ways around it: the solo-player accessors, a
 * PlayerControl, writes into a player's input (the held keys are `me.input`), ticks that bypass the
 * test world (in network mode a sim.tick() would skip the client and the server's NetServer and
 * Replicator), and the drive internals the client owns in network mode. world.ts (which implements
 * both modes) and setup.ts are the exceptions.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'acceptance');
const EXEMPT = new Set(['world.ts', 'setup.ts']);

/** Comments do not count: strip them (line and block comments), keep strings. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bsoloPlayer\b|\bsoloSim\b|\bloadSolo\b|\bSOLO_KEY\b|from '\.\.\/solo'/, why: 'solo-player accessor: act through w.me' },
  { pattern: /\.players\b/, why: "a PlayerControl drives a server-driven player: act through w.me" },
  { pattern: /\bplayer\.input\b/, why: "the player's input is the server's: hold keys with w.me.input" },
  { pattern: /(?<!\bme)\.input\.\w+\s*(?:[-+*/]?=(?!=)|\+\+|--)/, why: 'a write into an input other than w.me.input' },
  { pattern: /\bsim\.tick\(|\.advance\(/, why: 'a tick that bypasses the test world: use w.tick(n)' },
  { pattern: /\b(setDrive|submitReport|takeCorrection)\(/, why: "the drive is the client's in network mode" },
];

describe('acceptance tests act only through the test world (scenario 30)', () => {
  it('no solo accessors, PlayerControls, direct input writes or direct ticks in tests/acceptance', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !EXEMPT.has(f));
    expect(files.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const f of files) {
      code(readFileSync(join(DIR, f), 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          for (const r of FORBIDDEN) if (r.pattern.test(line)) hits.push(`tests/acceptance/${f}:${i + 1}: ${line.trim()}  (${r.why})`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the guard catches what it is for', () => {
    const samples = [
      'sim.soloPlayer.useOn(1, 2, 3);',
      "import { soloSim } from '../solo';",
      'const c = sim.players.get(ME)!;',
      'p.input.forward = 1;',
      'me.player.input.sneak = true;',
      'sim.tick();',
      'sim.advance(10);',
      'a.sim.tick();',
      'ctrl.setDrive("client");',
    ];
    for (const s of samples) expect(FORBIDDEN.some((r) => r.pattern.test(s)), s).toBe(true);
    for (const s of ['me.input.forward = 1;', 'w.me.input.sneak = true;', 'b.me.input.strafe = a.me.input.strafe;', 'w.tick(10);', 'expect(me.input.yaw).toBe(0);']) {
      expect(FORBIDDEN.some((r) => r.pattern.test(s)), s).toBe(false);
    }
  });
});
