/**
 * The server's movement checks on half slabs and octant staircases (docs/SHAPES.md 5.8): a
 * client-driven player (the lagged client harness at lag 0, tests/drive/stairs-scenes.ts) walks
 * and sprints up and down a half slab, a straight staircase, a diagonal one and one in a
 * stairwell, in the world and on a ship; with every report delivered, and with ten of every
 * eleven lost. No report is refused and nothing is corrected, and walking down hurts the
 * client-driven player exactly as much as it hurts a server-driven one (running down the diagonal
 * staircase is a series of real falls of up to 4.5 blocks; down the others nobody is hurt).
 * The ship cases ride a raft wide enough to float level (stairs-scenes.ts LEVEL_RAFT), and again
 * an 18 by 18 raft that heels under the staircase (HEELED_RAFT, about 9 degrees under the
 * diagonal one), with every phase of the loss pattern.
 * The known limitation (item 2: a report ending in the air, above what the support probe reaches,
 * after several lost ones on a staircase) is pinned as it is.
 */
import { describe, expect, it } from 'vitest';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { assemble, B, facingState, fill, makeCell, SEA_TOP, seaRun } from './scenes';
import { buildStairs, HEELED_RAFT, shipStairs, START, walk, worldStairs, type StairKind } from './stairs-scenes';

const KINDS: readonly StairKind[] = ['slab', 'straight', 'diagonal', 'stairwell'];

/** Ticks of a walk up / down (inside the staircase: never off its top or its far side). */
function ticks(kind: StairKind, sprint: boolean, ship: boolean, up: boolean): number {
  if (kind === 'slab') return ship ? 20 : 40;
  if (ship) return kind === 'diagonal' ? 30 : kind === 'stairwell' && !up ? 60 : 40;
  if (kind === 'stairwell' && !up) return 200; // its lower ceilings stop a high body: down one step at a time
  return up ? (sprint ? 85 : 105) : kind === 'diagonal' ? 70 : 130;
}

/** At least this many blocks up (or down). */
function height(kind: StairKind, ship: boolean, up: boolean): number {
  if (kind === 'slab') return 0.49;
  if (ship) return kind === 'diagonal' ? 1.5 : kind === 'stairwell' && !up ? 4.5 : 5.5;
  if (kind === 'diagonal') return up ? 25 : 20;
  return 17.5;
}

for (const lose of [0, 10]) {
  const title = lose === 0 ? 'every report delivered (zero latency): no report refused' : 'ten of every eleven reports lost: no correction';
  describe(`5.8 ${title}`, () => {
    for (const kind of KINDS) {
      it(`world, ${kind}: walking and sprinting up, then down`, () => {
        for (const sprint of [false, true]) {
          const up = walk(worldStairs(kind), START[kind].yaw, { sprint, lose, ticks: ticks(kind, sprint, false, true) });
          const what = `up ${kind} ${sprint ? 'sprint' : 'walk'}: ${JSON.stringify(up)}`;
          expect(up.causes, what).toEqual([]);
          expect(up.rejected, what).toBe(0);
          expect(up.climbed, what).toBeGreaterThan(height(kind, false, true));
          expect(up.damage, what).toBe(0);
          const n = ticks(kind, sprint, false, false);
          const down = walk(worldStairs(kind, true), START[kind].yaw + Math.PI, { sprint, lose, ticks: n });
          const ref = walk(worldStairs(kind, true, null), START[kind].yaw + Math.PI, { sprint, lose: 0, ticks: n });
          const whatDown = `down ${kind} ${sprint ? 'sprint' : 'walk'}: ${JSON.stringify(down)} reference ${JSON.stringify(ref)}`;
          expect(down.causes, whatDown).toEqual([]);
          expect(down.rejected, whatDown).toBe(0);
          expect(down.descended, whatDown).toBeGreaterThan(height(kind, false, false));
          // The server judges the falls as they were; with reports lost it judges what it saw of them
          // (a landing nobody reported ends the fall tracked so far: never more than the real one).
          if (lose === 0) expect(down.damage, whatDown).toBe(ref.damage);
          else expect(down.damage, whatDown).toBeLessThanOrEqual(ref.damage);
          if (kind !== 'diagonal') expect(down.damage, whatDown).toBe(0);
        }
      });

      it(`ship, ${kind}: walking and sprinting up, then down, on the deck of a floating raft`, () => {
        for (const sprint of [false, true]) {
          const s = shipStairs(kind);
          const up = walk(s.run, START[kind].yaw, { sprint, lose, ticks: ticks(kind, sprint, true, true) });
          const what = `up ${kind} ${sprint ? 'sprint' : 'walk'}: ${JSON.stringify(up)}`;
          expect(up.causes, what).toEqual([]);
          expect(up.rejected, what).toBe(0);
          expect(up.climbed, what).toBeGreaterThan(height(kind, true, true));
          expect(s.run.sim.soloPlayer.player.carrierId, what).toBe(s.ship.id);
          const t = shipStairs(kind, { atTop: true });
          const down = walk(t.run, START[kind].yaw + Math.PI, { sprint, lose, ticks: ticks(kind, sprint, true, false) });
          const whatDown = `down ${kind} ${sprint ? 'sprint' : 'walk'}: ${JSON.stringify(down)}`;
          expect(down.causes, whatDown).toEqual([]);
          expect(down.rejected, whatDown).toBe(0);
          expect(down.descended, whatDown).toBeGreaterThan(height(kind, true, false));
          expect(t.run.sim.soloPlayer.player.carrierId, whatDown).toBe(t.ship.id);
        }
      });
    }
  });
}

describe('5.8 on a heeled raft (stairs-scenes.ts HEELED_RAFT), every phase of the loss pattern', () => {
  /**
   * The 18 by 18 raft heels toward the staircase under its weight (about 9 degrees under the
   * diagonal one): every tread slopes down the way the body climbs, the climbing body leaves it
   * for a tick now and then, a hair above it and in the air by its own flag (held up all the
   * same: drive.ts heldEnd), and lands on it unseen; it stands on a few thousandths of a tread
   * after a step up, the next riser leaning in at its corner (drive.ts clearOfLeaningWalls); and
   * on the diagonal staircase its path follows the diagonal, crossing an x riser and a z riser at
   * the same sample (the staircase path's corner, drive.ts stairClear). Each delivered report of
   * every phase of the pattern is one of those states somewhere.
   */
  /** At least this many blocks up (or down) on the heeled raft. */
  const moved = (kind: StairKind): number => (kind === 'slab' ? 0.49 : 3);

  function run(kind: StairKind, sprint: boolean, up: boolean, lose: number, phase: number, settle: number, sail?: readonly [number, number]): string | null {
    const s = shipStairs(kind, { atTop: !up, deck: HEELED_RAFT, settle, sail });
    // Held forward as in the matrix above (the scene of 05db395), or, under way, up (or down) the
    // staircase in the ship's frame: the raft has turned.
    const f = s.ship.grid.dirToWorld(vec3(up ? 1 : -1, 0, kind === 'diagonal' ? (up ? 1 : -1) : 0));
    const yaw = sail === undefined ? START[kind].yaw + (up ? 0 : Math.PI) : Math.atan2(-f.x, -f.z);
    const r = walk(s.run, yaw, { sprint, lose, phase, ticks: ticks(kind, sprint, true, up) });
    const ok = r.causes.length === 0 && r.rejected === 0 && (up ? r.climbed : r.descended) > moved(kind) && s.run.sim.soloPlayer.player.carrierId === s.ship.id;
    return ok ? null : `${kind} ${up ? 'up' : 'down'} ${sprint ? 'sprint' : 'walk'}, ${lose} of ${lose + 1} lost, phase ${phase}, settled ${settle} ticks${sail ? `, under way ${sail}` : ''}: ${JSON.stringify(r)}`;
  }

  for (const kind of KINDS) {
    it(`${kind}: walking and sprinting up and down, every report delivered and ten of every eleven lost (each phase): nothing refused or corrected`, () => {
      const bad: string[] = [];
      for (const sprint of [false, true])
        for (const up of [true, false])
          for (const lose of [0, 10])
            for (let phase = 0; phase <= lose; phase++) {
              const b = run(kind, sprint, up, lose, phase, 60);
              if (b !== null) bad.push(b);
            }
      expect(bad).toEqual([]);
    });
  }

  it('diagonal, a 22 by 22 raft heeling 2 degrees, walking up along the ship, seven of every eight lost (each phase): nothing refused', () => {
    // A report of phase 7 ends right after a step up: the body stands on 0.005 of the tread, and the
    // next higher column, leaning in a little, touches its corner (the wall's lean was cut off all
    // four sides of the footprint, and the strip of tread with it).
    const bad: string[] = [];
    for (let phase = 0; phase <= 7; phase++) {
      const s = START.diagonal;
      const run = seaRun('creative', vec3(s.x, SEA_TOP, s.z), 0);
      const sim = run.sim;
      fill(sim.world, -5, SEA_TOP - 1, -5, 16, SEA_TOP - 1, 16, B.PLANKS_OAK);
      buildStairs(sim.world, 'diagonal', 10, 2 * SEA_TOP, s.hz0, 12, B.PLANKS_OAK, 8);
      sim.world.setCell(-4, SEA_TOP, 14, makeCell(B.HELM, facingState(NZ)));
      const ship = assemble(sim, vec3(-4, SEA_TOP, 14));
      for (let t = 0; t < 60; t++) sim.tick();
      const w = ship.grid.toWorld(vec3(s.x, SEA_TOP, s.z));
      sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
      for (let t = 0; t < 20; t++) sim.tick();
      // Held forward along the staircase's diagonal in the ship's frame.
      const f = ship.grid.dirToWorld(vec3(1, 0, 1));
      const r = walk(run, Math.atan2(-f.x, -f.z), { sprint: false, lose: 7, phase, ticks: 30 });
      if (r.causes.length > 0 || r.rejected > 0 || r.climbed < 3) bad.push(`phase ${phase}: ${JSON.stringify(r)}`);
    }
    expect(bad).toEqual([]);
  });

  for (const kind of ['diagonal', 'stairwell'] as const) {
    it(`${kind}, the raft under way and turning: walking and sprinting up and down, ten of every eleven lost (each phase): nothing refused or corrected`, () => {
      // (Walking up the stairwell, phase 10: a report ends a hair above a tread, in the air by the
      // body's own flag, with no landing since the last delivered one: held up all the same.)
      const bad: string[] = [];
      for (const sprint of [false, true])
        for (const up of [true, false])
          for (let phase = 0; phase <= 10; phase++) {
            const b = run(kind, sprint, up, 10, phase, 60, [1, 1]);
            if (b !== null) bad.push(b);
          }
      expect(bad).toEqual([]);
    });
  }

  it('diagonal, the raft settled (its heel steady at about 9.7 degrees): seven and ten of every eight and eleven lost, each phase: nothing refused or corrected', () => {
    const bad: string[] = [];
    for (const sprint of [false, true])
      for (const up of [true, false])
        for (const lose of [7, 10])
          for (let phase = 0; phase <= lose; phase++) {
            const b = run('diagonal', sprint, up, lose, phase, 360);
            if (b !== null) bad.push(b);
          }
    expect(bad).toEqual([]);
  });
});

describe('5.8 item 2, the known limitation (pinned as it is: update docs/NETCODE.md when it changes)', () => {
  it('sprinting up a staircase, three of every four reports lost, jumping right before each delivered one: corrected, for check:rise', () => {
    const r = walk(worldStairs('straight'), START.straight.yaw, { sprint: true, lose: 3, ticks: 85, jumpBeforeDelivered: true });
    // Refused for rising above the envelope; the server then lets the body fall itself until
    // something holds it up (corrections 'fall', drive.ts takeover).
    expect(r.causes, JSON.stringify(r)).toContain('check:rise');
    for (const c of r.causes) expect(['check:rise', 'fall']).toContain(c);
  });
});
