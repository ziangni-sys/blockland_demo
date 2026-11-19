/**
 * The server's movement checks on half slabs and octant staircases (docs/SHAPES.md 5.8): a
 * client-driven player (the lagged client harness at lag 0, tests/drive/stairs-scenes.ts) walks
 * and sprints up and down a half slab, a straight staircase, a diagonal one and one in a
 * stairwell, in the world and on a ship; with every report delivered, and with ten of every
 * eleven lost. No report is refused and nothing is corrected, and walking down hurts the
 * client-driven player exactly as much as it hurts a server-driven one (running down the diagonal
 * staircase is a series of real falls of up to 4.5 blocks; down the others nobody is hurt).
 * The known limitation (item 2: a report ending in the air after several lost ones on a
 * staircase) is pinned as it is.
 */
import { describe, expect, it } from 'vitest';
import { shipStairs, START, walk, worldStairs, type StairKind } from './stairs-scenes';

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
          const t = shipStairs(kind, true);
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

describe('5.8 item 2, the known limitation (pinned as it is: update docs/NETCODE.md when it changes)', () => {
  it('sprinting up a staircase, three of every four reports lost, jumping right before each delivered one: corrected, for check:rise', () => {
    const r = walk(worldStairs('straight'), START.straight.yaw, { sprint: true, lose: 3, ticks: 85, jumpBeforeDelivered: true });
    // Refused for rising above the envelope; the server then lets the body fall itself until
    // something holds it up (corrections 'fall', drive.ts takeover).
    expect(r.causes, JSON.stringify(r)).toContain('check:rise');
    for (const c of r.causes) expect(['check:rise', 'fall']).toContain(c);
  });
});
