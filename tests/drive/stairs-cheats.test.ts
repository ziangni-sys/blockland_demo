/**
 * What a dishonest client gains from the three changes of docs/SHAPES.md 5.8, pinned with made-up
 * reports (a scripted client with no mover of its own, as in checks.test.ts):
 *
 *  1. sqrt(2) h on a report that ends standing, where a staircase lies between the two places (the
 *     staircase path of item 3 passes): it may end at most spanPeak + STEP_HEIGHT + sqrt(2) h above
 *     where something last held it up (plus the slack budget), h being its horizontal
 *     displacement. A wall or terraces in open air (where the vertical-first dog-leg passes the
 *     path check) get only the bound without it; a report ending in the air gets nothing.
 *  3. the staircase path passes a climb of at most STEP_HEIGHT at a time; a wall under a ceiling
 *     (where no dog-leg passes) still fails the path check.
 *  4. a report claiming its own landing where nothing holds it up ends the fall tracked so far only
 *     where real ground lies within reach (or the rim it left is under where it came from): mid-air
 *     claims change nothing, and a fall ends at worst one report's fall early (no less damage
 *     than the honest fall here).
 */
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../../src/core/constants';
import { GRAVITY, JUMP_SPEED, STEP_HEIGHT } from '../../src/entities/constants';
import { liar } from './liar';
import { B, fill, hurts, LAND_TOP, type Run } from './scenes';
import { addOctant } from './stairs-scenes';

const T = LAND_TOP;

/** The highest point of a jump from the ground (the motion model's gravity step, as drive.ts arcPeak). */
function jumpPeak(): number {
  let vy = JUMP_SPEED;
  let top = 0;
  for (;;) {
    const v1 = vy - GRAVITY * TICK_DT;
    if (!(vy + v1 > 0)) return top;
    top += (vy + v1) * 0.5 * TICK_DT;
    vy = v1;
  }
}

/** A wall one block thick at x = 3 (z -2..2) of height `h` (multiples of 0.5) on flat land. */
function wall(h: number): (run: Run) => void {
  return (run) => {
    for (let hy = 2 * T; hy < 2 * T + 2 * h; hy++) for (let hx = 6; hx < 8; hx++) for (let hz = -4; hz < 6; hz++) addOctant(run.sim.world, hx, hy, hz, B.STONE);
  };
}

describe('5.8 item 1: sqrt(2) h only where a staircase lies between the two places', () => {
  const ticks = 16;
  /** What a report ending standing may climb without the staircase allowance: a jump, a step and the slack (0.5). */
  const plain = jumpPeak() + STEP_HEIGHT + 0.5;
  const withStairs = (h: number): number => jumpPeak() + STEP_HEIGHT + Math.SQRT2 * h;

  it(`onto a wall three blocks over after ${ticks} silent ticks: no higher than a jump and a step (${plain.toFixed(2)} with the slack), as without the allowance`, () => {
    const ok = Math.floor(plain * 2) / 2; // the highest wall (half blocks) within the plain bound
    const l = liar(0.5, 0.5, wall(ok));
    l.wait(ticks);
    l.send(3.5, T + ok, 0.5, true, ticks);
    expect(l.causes).toEqual([]);
    for (const H of [ok + 0.5, Math.floor(withStairs(3) * 2) / 2]) {
      // (The second is the highest wall sqrt(2) h would have allowed, had it counted here.)
      const r = liar(0.5, 0.5, wall(H));
      r.wait(ticks);
      r.send(3.5, T + H, 0.5, true, ticks);
      expect(r.causes, `a wall ${H} high`).toEqual(['check:rise']);
    }
  });

  it(`terraces 3 blocks high and 3 deep, one hop per ${ticks} ticks: the first hop is refused`, () => {
    const l = liar(1.5, 0.5, (run) => {
      for (let k = 1; k <= 5; k++) fill(run.sim.world, 3 * k, T, -3, 3 * k + 20, T + 3 * k - 1, 3, B.STONE);
    });
    l.wait(ticks);
    l.send(4.5, T + 3, 0.5, true, ticks);
    expect(l.causes).toEqual(['check:rise']);
  });

  it(`up a real staircase of half steps, four blocks up and four over in one report: accepted (higher than ${plain.toFixed(2)})`, () => {
    // Columns of octants rising toward +X: half-cell column hx (from 2) is (hx - 1) half blocks
    // high, up to 4 blocks; z -2..2.
    const l = liar(0.5, 0.5, (run) => {
      for (let hx = 2; hx < 24; hx++) for (let hy = 2 * T; hy < 2 * T + Math.min(hx - 1, 8); hy++) for (let hz = -4; hz < 6; hz++) addOctant(run.sim.world, hx, hy, hz, B.STONE);
    });
    expect(4).toBeGreaterThan(plain);
    expect(4).toBeLessThan(withStairs(4));
    l.wait(ticks);
    l.send(4.5, T + 4, 0.5, true, ticks);
    expect(l.causes).toEqual([]);
    expect(l.rejected).toBe(0);
  });

  it('a report ending in the air gains nothing: three blocks up and three over, airborne, refused', () => {
    const l = liar(0.5, 0.5, () => undefined);
    l.wait(ticks);
    l.send(3.5, T + 3, 0.5, false, ticks, -1);
    expect(l.causes).toEqual(['check:rise']);
  });
});

describe('5.8 item 3: the staircase path passes stairs, not walls', () => {
  /** A corridor (z 0..1) with a ceiling 3.0 above its floor and above whatever stands in it from x = 3 on. */
  function corridor(stairs: boolean): (run: Run) => void {
    return (run) => {
      const w = run.sim.world;
      // From x = 3: four half steps up to T + 2 and a landing (stairs), or a solid wall 2 high.
      for (let hx = 6; hx < 20; hx++) {
        const top = stairs ? Math.min(hx - 5, 4) : 4; // half cells above the floor
        for (let hz = -2; hz < 4; hz++) {
          for (let hy = 2 * T; hy < 2 * T + top; hy++) addOctant(w, hx, hy, hz, B.STONE);
          for (let hy = 2 * T + top + 6; hy < 2 * T + top + 8; hy++) addOctant(w, hx, hy, hz, B.STONE);
        }
      }
      // Ceiling over the start, 3.0 above the floor: no vertical-first dog-leg up to T + 2.
      fill(w, -4, T + 3, -1, 2, T + 3, 1, B.STONE);
    };
  }

  it('up four half steps under the stairwell ceiling in one report (all four reports between lost): accepted', () => {
    const l = liar(1.5, 0.5, corridor(true));
    l.wait(16);
    l.send(5.5, T + 2, 0.5, true, 16);
    expect(l.causes).toEqual([]);
  });

  it('the same report where a wall two blocks high stands instead of the stairs: refused, path', () => {
    const l = liar(1.5, 0.5, corridor(false));
    l.wait(16);
    l.send(5.5, T + 2, 0.5, true, 16);
    expect(l.causes).toEqual(['check:path']);
  });
});

describe('5.8 item 4: claiming a landing in mid-air', () => {
  /** A 12-block fall reported tick by tick; `claim(i)`: report i claims to stand (where nothing holds it). */
  function fall(claim: (i: number, y: number) => boolean): { damage: number; causes: string[] } {
    const l = liar(0.5, 0.5, () => undefined);
    l.run.sim.soloPlayer.teleport(0.5, T + 12, 0.5);
    l.tick();
    let y = T + 12;
    let v = 0;
    let i = 0;
    while (y > T) {
      const v1 = v - GRAVITY * TICK_DT;
      y = Math.max(T, y + (v + v1) * 0.5 * TICK_DT);
      v = v1;
      const landed = y === T;
      l.send(0.5, y, 0.5, landed || claim(i++, y), 1, landed ? 0 : v);
    }
    l.wait(3);
    return { damage: hurts(l.run).reduce((a, e) => a + e.amount, 0), causes: l.causes };
  }

  it('claims to stand every third report on the way down change nothing: the full fall is judged', () => {
    const honest = fall(() => false);
    expect(honest.damage).toBe(Math.ceil(12 - 3.5));
    const liar3 = fall((i, y) => i % 3 === 2 && y > T + 1.5);
    expect(liar3.damage).toBe(honest.damage);
  });

  it('a claim just above the ground ends the fall at most one report early: no less damage here', () => {
    const honest = fall(() => false);
    const late = fall((_i, y) => y < T + 1.5);
    expect(late.damage).toBe(honest.damage);
  });
});
