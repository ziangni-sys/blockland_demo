/**
 * The table of the end-to-end own-player scenes (tests/net/e2e-own-*.test.ts): for each scene of
 * package 2's lag tests, what it must cause (the corrections its client applies, the damage) and
 * what else it must show, on each link of e2e-scenes.ts. On the first two links (0 ms; 150 ms with
 * 20 ms jitter and 5% loss) a scene causes exactly its corrections and its damage, no more. On the
 * third (400 ms, 20% loss) the tests require the scene's damage and no refused report, and record
 * the corrections (OWN_STATS_OUT, when set, gets one line per scene and link).
 */
import { appendFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CRUSH_DAMAGE } from '../../src/entities/constants';
import { LINKS } from './e2e-scenes';
import type { ClientLink } from './harness';
import * as R from './own-runs';

export interface SceneSpec {
  run: (link: ClientLink) => Promise<R.SceneResult>;
  causes: string[];
  damage: number;
  /** The scene's own measurements, judged on every link. */
  check: (m: R.SceneResult['m'], link: string) => void;
}

export const SCENES: Record<string, SceneSpec> = {
  walk: {
    run: R.walk,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.moved).toBeGreaterThan(20);
      expect(m.reportWorst).toBe(0); // the server has the player exactly where the reports say
    },
  },
  fly: {
    run: R.fly,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.flew).toBeGreaterThan(100);
      expect(m.top).toBeGreaterThan(R.LAND_TOP_FOR_TESTS + 3);
      expect(m.endY).toBeCloseTo(R.LAND_TOP_FOR_TESTS, 6);
      expect(m.flying).toBe(false);
    },
  },
  flyStop: {
    run: R.flyStop,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.fastest).toBeGreaterThan(10); // faster than walking: it flew, and kept the momentum
      expect(m.endY).toBeCloseTo(R.LAND_TOP_FOR_TESTS, 6);
      expect(m.flying).toBe(false);
    },
  },
  turntable: {
    run: R.turntable,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(Math.abs(m.turned as number)).toBeGreaterThan(3);
      expect(m.carried).toBe(true);
      expect(m.slip).toBeLessThan(0.02);
      expect(m.walked).toBeGreaterThan(0.5);
      expect(m.lookFollow).toBeLessThan(0.1); // the view turned with the platform
      expect(m.reportWorst).toBe(0);
    },
  },
  blade: {
    run: R.blade,
    causes: [],
    damage: 0,
    check: (m, link) => {
      expect(m.away).toBeGreaterThan(1); // pushed
      expect(m.candidates).toBe(0);
      // The client posed the blade where the server's tick that applies its report has it (rotorTick,
      // section 4): the server sees the blade deeper than SQUEEZE_DEPTH in the reported body for two
      // ticks in a row at most (posed at renderTick, a round trip behind, it saw it for some 40).
      if (link !== LINKS[2]!.name) expect(m.deepRun).toBeLessThanOrEqual(2);
    },
  },
  cage: {
    run: R.cage,
    causes: ['crush'],
    damage: CRUSH_DAMAGE,
    check: (m) => {
      expect(m.crushed).toBe(true);
      expect(m.inWorld).toBe(false);
      expect(m.outOfCage).toBe(true);
      expect(m.acceptedAfter).toBeGreaterThan(20); // reports taken again after the correction
    },
  },
  bridge: {
    run: (l) => R.bridge(l, 3),
    causes: ['crush'],
    damage: CRUSH_DAMAGE,
    check: (m) => {
      expect(m.carriedBefore).toBe(true);
      expect(m.inWorld).toBe(false);
    },
  },
  lava: {
    run: R.lava,
    causes: ['teleport', 'death'],
    damage: 20,
    check: (m) => expect(m.dead).toBe(true),
  },
  drown: {
    run: R.drown,
    causes: ['teleport', 'death'],
    damage: 20,
    check: (m) => {
      expect(m.dead).toBe(true);
      expect(m.minAir).toBe(0);
    },
  },
  teleportWalk: {
    run: R.teleportWalk,
    causes: ['teleport'],
    damage: 0,
    check: (m) => expect(m.fromTeleport).toBeGreaterThan(2), // walked on from the teleport spot
  },
  deathRespawn: {
    run: R.deathRespawn,
    causes: ['death', 'respawn'],
    damage: 1000,
    check: (m) => {
      expect(m.heldDead).toBe(0);
      expect(m.fromSpawn).toBeGreaterThan(2);
      expect(m.dead).toBe(false);
    },
  },
  blockifyUnder: {
    run: R.blockifyUnder,
    causes: ['release'],
    damage: 0,
    check: (m) => {
      expect(m.carriedBefore).toBe(true);
      expect(m.released).toBe(true);
      expect(m.onWorld).toBe(true);
      expect(m.drift).toBeLessThan(0.05);
    },
  },
  deck: {
    run: R.deck,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.sailed).toBeGreaterThan(10);
      expect(Math.abs(m.turned as number)).toBeGreaterThan(0.5);
      expect(m.carried).toBe(true);
      expect(m.slip).toBeLessThan(0.02);
      expect(m.maxDy).toBeLessThan(0.05);
      expect(m.walked).toBeGreaterThan(2);
      expect(m.reportWorst).toBe(0);
    },
  },
  pierJump: {
    run: R.pierJump,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.boarded).toBeGreaterThan(20);
      expect(m.back).toBeGreaterThan(80);
    },
  },
  deckToWater: {
    run: R.deckToWater,
    causes: [],
    damage: 0,
    check: (m) => {
      expect(m.carriedBefore).toBe(true);
      expect(m.inWater).toBe(true);
    },
  },
  fallLand: { run: (l) => R.fall('land', l), causes: ['teleport'], damage: 7, check: () => {} },
  fallWater: { run: (l) => R.fall('water', l), causes: ['teleport'], damage: 0, check: () => {} },
  fallDeck: { run: (l) => R.fall('deck', l), causes: ['teleport'], damage: 5, check: (m) => expect(m.onDeck).toBe(true) },
  ram6: {
    run: (l) => R.ram(l, 6),
    causes: [],
    damage: 0,
    check: (m) => expect(m.away).toBeGreaterThan(1),
  },
  ram14: {
    run: (l) => R.ram(l, 14),
    causes: [],
    damage: 0,
    check: (m) => expect(m.away).toBeGreaterThan(1),
  },
  steer: {
    run: R.steer,
    causes: ['seat', 'unseat:stopped'],
    damage: 0,
    check: (m) => {
      expect(m.seated).toBe(true);
      expect(m.throttle).toBe(1);
      expect(m.rudder).toBe(1);
      expect(m.sailed).toBeGreaterThan(5);
      expect(m.turned).toBeGreaterThan(0.5);
      expect(m.aboard).toBe(true);
    },
  },
  pushedOff: {
    run: R.pushedOff,
    causes: ['seat', 'unseat:pushed'],
    damage: 0,
    check: (m) => {
      expect(m.seated).toBe(true);
      expect(m.released).toBe(true);
    },
  },
};

/** One test per scene and link (see the file comment). */
export function sceneTests(names: string[], seed = 77): void {
  for (const name of names) {
    const s = SCENES[name]!;
    LINKS.forEach((l, i) => {
      it(`${name}, ${l.name}`, async () => {
        const res = await s.run(l.make(seed));
        const out = process.env.OWN_STATS_OUT;
        if (out) appendFileSync(out, `${name}\t${l.name}\t${JSON.stringify(res.causes)}\t${res.damage}\t${res.rejected}\t${JSON.stringify(res.m)}\n`);
        s.check(res.m, l.name);
        expect(res.damage, 'damage').toBe(s.damage);
        expect(res.rejected, 'refused reports').toBe(0);
        if (i < 2) expect(res.causes, 'corrections').toEqual(s.causes);
        else for (const c of s.causes) expect(res.causes, 'corrections').toContain(c);
      }, 120_000);
    });
  }
}
