/**
 * Guard: the code under src/ must not assume a single player (M2.1 package 1). The simulation has
 * no "local" player; Simulation.soloPlayer exists only for single-player tests and tools. This
 * scans the sources for the shapes the single-player code had, and checks that a world with no
 * players and a world with several players run.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/simulation';
import { flatOpts } from './helpers';

const SRC = join(__dirname, '..', '..', 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Comments do not count: strip them (line and block comments), keep strings. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Shapes that mean "the one player". */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\.soloPlayer\b/, why: 'Simulation.soloPlayer is for single-player tests and tools only' },
  { pattern: /\blocalPlayer\b/, why: 'the simulation has no local player' },
  { pattern: /\bentities\.player\b/, why: 'EntityManager has no single player' },
  { pattern: /\bcreatePlayer\b/, why: 'players are spawned by the registry (join), never replaced' },
  { pattern: /\bsim\.(player|view|mode|creative|loadRadius)\b/, why: 'per player: use a PlayerControl' },
  { pattern: /\b(host|this\.host)\.creative\b/, why: 'world effects follow the world rules (dropsEnabled / defaultMode)' },
  { pattern: /\bonline\(\)\s*(\[|\.at\()/, why: 'the first (or any fixed) joined player is not "the" player' },
  { pattern: /\[[^\]]*\]\s*=\s*[\w.]*\bonline\(\)/, why: 'destructuring the joined players picks "the" player' },
  { pattern: /\bonline\(\)\.length\s*(===|==|<=|<)\s*[12]\b/, why: 'nothing in the simulation depends on there being one player' },
];

/** Inside Simulation: the fields the single-player Simulation had. */
const FORBIDDEN_IN_SIMULATION: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bthis\.(player|mode|view|creative|loadRadius)\b/, why: 'Simulation holds no player, mode or view: per player (PlayerControl) or per world (WorldRules)' },
];

describe('no single-player assumptions under src/', () => {
  it('no source uses the single-player accessor or the shapes of the old single-player code', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      const lines = code(readFileSync(file, 'utf8')).split('\n');
      const rules = rel === 'sim/simulation.ts' ? [...FORBIDDEN, ...FORBIDDEN_IN_SIMULATION] : FORBIDDEN;
      lines.forEach((line, i) => {
        for (const f of rules) {
          if (!f.pattern.test(line)) continue;
          // The accessor's own definition (and its guard) is the one allowed mention.
          if (rel === 'sim/simulation.ts' && /get soloPlayer\(\)|online\.length !== 1/.test(line)) continue;
          hits.push(`src/${rel}:${i + 1}: ${line.trim()}  (${f.why})`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('the guard itself catches a use of the accessor', () => {
    const sample = code('const p = sim.soloPlayer.player; // fine in a comment: sim.soloPlayer');
    expect(FORBIDDEN.some((f) => f.pattern.test(sample))).toBe(true);
    expect(FORBIDDEN.some((f) => f.pattern.test(code('// sim.soloPlayer in a comment only')))).toBe(false);
  });

  it('the guard catches the other ways of picking "the" player', () => {
    const caught = (src: string, rules = FORBIDDEN): boolean => rules.some((f) => f.pattern.test(code(src)));
    for (const bad of [
      'const p = sim.players.online()[0];',
      'const p = this.players.online().at(0);',
      'const [p] = sim.players.online();',
      'const [first, ...rest] = this.players.online();',
      'if (this.players.online().length === 1) return;',
      'if (online().length < 2) solo();',
    ]) {
      expect(caught(bad), bad).toBe(true);
    }
    for (const bad of ['this.player.pos.x', 'if (this.creative) return;', 'const r = this.loadRadius;', 'this.view.target = null;']) {
      expect(caught(bad, FORBIDDEN_IN_SIMULATION), bad).toBe(true);
    }
    for (const fine of ['for (const c of this.players.online()) c.tick();', 'if (sim.players.online().length > 0) throw e;', 'const online = this.players.online();']) {
      expect(caught(fine), fine).toBe(false);
    }
  });

  it('soloPlayer throws unless exactly one player has joined', () => {
    const sim = new Simulation(flatOpts());
    expect(() => sim.soloPlayer).toThrow(/0 players/);
    sim.join('a');
    expect(sim.soloPlayer.key).toBe('a');
    sim.join('b');
    expect(() => sim.soloPlayer).toThrow(/2 players/);
    sim.leave('a');
    expect(sim.soloPlayer.key).toBe('b');
  });

  it('a world with no players ticks (nothing loads, nothing breaks), and one with three players too', () => {
    const empty = new Simulation({ ...flatOpts(), rabbits: true });
    empty.advance(100);
    expect(empty.world.chunks.size).toBe(0);
    expect(empty.entities.all().length).toBe(0);

    const sim = new Simulation({ ...flatOpts(), rabbits: true });
    for (const k of ['a', 'b', 'c']) sim.join(k);
    sim.advance(100);
    expect(sim.players.online().map((c) => c.key)).toEqual(['a', 'b', 'c']);
    for (const c of sim.players.online()) expect(c.player.onGround).toBe(true);
  });
});
