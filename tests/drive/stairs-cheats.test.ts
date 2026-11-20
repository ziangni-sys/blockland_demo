/**
 * What a dishonest client gains from the three changes of docs/SHAPES.md 5.8, pinned with made-up
 * reports (a scripted client with no mover of its own, as in checks.test.ts):
 *
 *  1. sqrt(2) h on a report that ends held up (where the server's support probe finds ground,
 *     whether the report says it stands or that it is in the air), where a staircase lies between
 *     the two places (the staircase path of item 3 passes): it may end at most spanPeak +
 *     STEP_HEIGHT + sqrt(2) h above where something last held it up (plus the slack budget), h
 *     being its horizontal displacement. A wall or terraces in open air (where the vertical-first
 *     dog-leg passes the path check), also when the report ends on their rim, also on the deck of a
 *     raft under way, get only the bound without it; a report ending in the air above the probe's
 *     reach gets nothing; saying it is in the air where it would be believed standing gains
 *     nothing either: it has landed there all the same, and its fall ends there.
 *  3. the staircase path passes a climb of at most STEP_HEIGHT at a time; a wall under a ceiling
 *     (where no dog-leg passes) still fails the path check, and its last leg, straight up to the
 *     higher end, is 1.7 at most (so the rim of a wall is no staircase). Round a corner
 *     (an x riser and a z riser crossed at the same sample) it passes a step on each axis, one
 *     after the other: along the diagonal of a staircase of half steps a report gets what a line
 *     beside the diagonal already got, and stairs of whole steps or the corner of a block get
 *     nothing more than the bound without the allowance.
 *  4. a report claiming its own landing where nothing holds it up ends the fall tracked so far only
 *     where real ground lies within reach (or the rim it left is under where it came from): mid-air
 *     claims change nothing, and a fall ends at worst one report's fall early (no less damage
 *     than the honest fall here).
 */
import { describe, expect, it } from 'vitest';
import { TICK_DT } from '../../src/core/constants';
import { GRAVITY, JUMP_SPEED, STEP_HEIGHT } from '../../src/entities/constants';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { Liar, liar } from './liar';
import { assemble, B, facingState, fill, hurts, LAND_TOP, makeCell, SEA_TOP, seaRun, type Run } from './scenes';
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

  /** A stone wall from x = 3 (z -3..3, 4 blocks thick) `h` blocks high. */
  const block = (h: number) => (run: Run) => fill(run.sim.world, 3, T, -3, 6, T + h - 1, 3, B.STONE);

  for (const endX of [2.61, 2.89]) {
    // Feet x 2.61: the body 0.09 short of the wall's face (inside the support probe's widening);
    // 2.89: 0.19 into it (inside the checks' depth tolerance). Nothing to climb on the way, then
    // the staircase path's last leg straight up the face (drive.ts stairClear, STAIR_LAST_RISERS).
    it(`onto the rim of a wall from 4.4 blocks away, ending at feet x ${endX}, after ${ticks} silent ticks: no higher than without the allowance`, () => {
      const ok = Math.floor(plain);
      const l = liar(-1.5, 0.5, block(ok));
      l.wait(ticks);
      l.send(endX, T + ok, 0.5, true, ticks);
      expect(l.causes).toEqual([]);
      for (const H of [ok + 1, 8]) {
        // (8: what the allowance gave before its last leg was bounded.)
        const r = liar(-1.5, 0.5, block(H));
        r.wait(ticks);
        r.send(endX, T + H, 0.5, true, ticks);
        expect(r.causes, `a wall ${H} high`).toEqual(['check:rise']);
      }
    });
  }

  it(`onto the rim of a wall two and a half blocks high (a lower slab on two blocks): refused, the last leg (2.5) being more than the path may climb straight up (1.7)`, () => {
    // Higher than the bound without the allowance (a jump, a step and the slack: 2.35), lower than
    // what a last leg of 2.3 risers and the depth limit would let through.
    const wall = (run: Run) => {
      fill(run.sim.world, 3, T, -3, 6, T + 1, 3, B.STONE);
      for (let hx = 6; hx < 14; hx++) for (let hz = -6; hz < 8; hz++) addOctant(run.sim.world, hx, 2 * T + 4, hz, B.STONE);
    };
    expect(2.5).toBeGreaterThan(plain);
    for (const endX of [2.61, 2.89]) {
      const l = liar(-1.5, 0.5, wall);
      l.wait(ticks);
      l.send(endX, T + 2.5, 0.5, true, ticks);
      expect(l.causes, `feet x ${endX}`).toEqual(['check:rise']);
    }
  });

  it(`onto the rim of a wall on the deck of a raft under way, claiming two seconds of lag: no higher than at rest`, () => {
    // The path's depth limit on a moving carrier holds the world's allowance (the raft's speed
    // times the lag); a last leg bounded by it let this client hop onto a wall six blocks high.
    const hop = (h: number): string[] => {
      const run = seaRun('creative', vec3(5.5, SEA_TOP, 5.5), null);
      const sim = run.sim;
      fill(sim.world, -12, SEA_TOP - 1, -12, 23, SEA_TOP - 1, 23, B.PLANKS_OAK);
      fill(sim.world, 3, SEA_TOP, -3, 6, SEA_TOP + h - 1, 3, B.PLANKS_OAK);
      sim.world.setCell(-2, SEA_TOP, 12, makeCell(B.HELM, facingState(NZ)));
      const ship = assemble(sim, vec3(-2, SEA_TOP, 12));
      for (let t = 0; t < 60; t++) sim.tick();
      ship.throttle = 1;
      for (let t = 0; t < 120; t++) sim.tick();
      const v = ship.grid.linearVelocity;
      expect(Math.hypot(v.x, v.z), 'the raft is under way').toBeGreaterThan(2);
      const w = ship.grid.toWorld(vec3(-1.5, SEA_TOP, 0.5));
      sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
      for (let t = 0; t < 20; t++) sim.tick();
      const l = new Liar(run);
      expect(l.carrierId).toBe(ship.id);
      l.send(-1.5, SEA_TOP, 0.5, true);
      l.viewLag = 40;
      l.wait(ticks);
      l.send(2.61, SEA_TOP + h, 0.5, true, ticks);
      return l.causes;
    };
    expect(hop(Math.floor(plain))).toEqual([]);
    for (const h of [3, 6]) expect(hop(h), `a wall ${h} high`).toEqual(['check:rise']);
  });

  it(`terraces 3 blocks high and 4 deep, one hop per ${ticks} ticks onto the rim of each: the first hop is refused`, () => {
    const l = liar(0.4, 0.5, (run) => {
      for (let k = 1; k <= 3; k++) fill(run.sim.world, 4 * k, T, -3, 4 * k + 12, T + 3 * k - 1, 3, B.STONE);
    });
    l.wait(ticks);
    l.send(4 - 0.11, T + 3, 0.5, true, ticks);
    expect(l.causes).toEqual(['check:rise']);
  });
});

describe('5.8 item 1: a report that ends held up but says it is in the air is judged as one that says it stands', () => {
  // On a heeled deck an honest body leaves a tread that slopes away from it for a tick now and then,
  // a hair above it and in the air by its own flag (drive.ts heldEnd). Whatever a client claims,
  // a report that ends where the server's support probe finds ground gets what it would get
  // claiming to stand there, and no more; only standing proper ends a fall.
  const ticks = 16;
  /** Half steps rising toward +X from x = 1, up to 4 blocks; z -2..2 (as in item 1's staircase). */
  const stairs = (run: Run) => {
    for (let hx = 2; hx < 24; hx++) for (let hy = 2 * T; hy < 2 * T + Math.min(hx - 1, 8); hy++) for (let hz = -4; hz < 6; hz++) addOctant(run.sim.world, hx, hy, hz, B.STONE);
  };
  /** One report after `ticks` silent ticks to (x, y) claiming `stand`; its corrections. */
  function hop(build: (run: Run) => void, x: number, y: number, stand: boolean): string[] {
    const l = liar(0.5, 0.5, build);
    l.wait(ticks);
    l.send(x, y, 0.5, stand, ticks, stand ? 0 : -1);
    return l.causes;
  }

  it('four blocks up the staircase, ending 0.05 above its tread: accepted, as when it says it stands there', () => {
    expect(hop(stairs, 4.5, T + 4.05, false)).toEqual([]);
    expect(hop(stairs, 4.5, T + 4.05, true)).toEqual([]);
  });

  it('the same ending 0.3 above the tread (beyond what the support probe reaches): refused, as before (item 2)', () => {
    expect(hop(stairs, 4.5, T + 4.3, false)).toEqual(['check:rise']);
  });

  it(`onto a wall: the same verdicts either way (no higher than a jump and a step)`, () => {
    const wallOf = (h: number) => (run: Run) => fill(run.sim.world, 3, T, -3, 6, T + h - 1, 3, B.STONE);
    const ok = Math.floor(jumpPeak() + STEP_HEIGHT + 0.5);
    for (const stand of [false, true]) {
      expect(hop(wallOf(ok), 3.5, T + ok + 0.05, stand), `${ok} high, stand ${stand}`).toEqual([]);
      expect(hop(wallOf(ok + 1), 3.5, T + ok + 1.05, stand), `${ok + 1} high, stand ${stand}`).toEqual(['check:rise']);
    }
  });

  it('rising past the rim of a step, 0.05 short of its face, saying it is in the air and rises no faster than a jump: the envelope starts again there', () => {
    // A body hopping up steps with the jump key held touches a tread in a tick whose report is
    // lost and jumps again at once (its client counts no landing): a delivered report finds it
    // rising past the next step's rim, within the support probe's widening of it. The next report,
    // a jump's height above that one, must pass (judged from the old ground, it would not).
    const step = (run: Run) => fill(run.sim.world, 3, T, -3, 6, T, 3, B.STONE);
    const l = liar(1.5, 0.5, step);
    l.wait(8);
    expect(l.send(2.65, T + 1.05, 0.5, false, 8, 7)).toBe(true);
    l.wait(8);
    l.send(2.65, T + 2.25, 0.5, false, 8, -1);
    expect(l.causes).toEqual([]);
  });

  it('a landing nobody saw, on a staircase: its ground may be a tread the staircase climbs to, the end a jump above it; on a wall no higher than without the staircase', () => {
    // (The report counts one landing more than it shows, as after lost reports: drive.ts LANDINGS.)
    const unseen = (build: (run: Run) => void, y: number): string[] => {
      const l = liar(0.5, 0.5, build);
      l.wait(ticks);
      l.landings = (l.landings + 1) & 255;
      l.send(4.5, y, 0.5, false, ticks, -1);
      return l.causes;
    };
    expect(unseen(stairs, T + 4 + 1)).toEqual([]);
    expect(unseen(stairs, T + 4 + 2)).toEqual(['check:rise']);
    const wallOf = (h: number) => (run: Run) => fill(run.sim.world, 3, T, -3, 6, T + h - 1, 3, B.STONE);
    expect(unseen(wallOf(4), T + 4 + 1)).toEqual(['check:rise']);
  });

  /** A fall from T + 12 reported tick by tick down to `end` above the ground at feet (x, z), the last report claiming `stand`; then `after` more reports. */
  function fallTo(build: (run: Run) => void, x: number, z: number, end: number, stand: boolean, after: (l: ReturnType<typeof liar>) => void): ReturnType<typeof liar> {
    const l = liar(x, z, build);
    l.run.sim.soloPlayer.teleport(x, T + 12, z);
    l.tick();
    let y = T + 12;
    let v = 0;
    while (y > T + end) {
      const v1 = v - GRAVITY * TICK_DT;
      y = Math.max(T + end, y + (v + v1) * 0.5 * TICK_DT);
      v = v1;
      const last = y === T + end;
      l.send(x, y, z, last && stand, 1, last && stand ? 0 : v);
    }
    after(l);
    return l;
  }

  it('a 12-block fall that ends a hair above the ground, in the air by its own flag: the whole fall is judged at that report, as when it says it stands there', () => {
    // (A client that never claims to stand must pay for its falls too: before, it walked on a hair
    // above the ground with the fall pending for ever and washed it off in a puddle.)
    for (const stand of [false, true]) {
      let atLanding = -1;
      const l = fallTo(
        () => undefined,
        0.5,
        0.5,
        0.05,
        stand,
        (r) => {
          atLanding = r.damage;
          // Walking on a hair above the ground, in the air by its own flag, then standing: nothing more.
          for (let i = 1; i <= 20; i++) r.send(0.5 + 0.2 * i, T + 0.05, 0.5, false, 1, -1);
          r.send(4.5, T, 0.5, true);
          r.wait(3);
        },
      );
      expect(atLanding, `stand ${stand}`).toBe(Math.ceil(12 - 3.5));
      expect(l.damage, `stand ${stand}`).toBe(Math.ceil(12 - 3.5));
      expect(l.causes, `stand ${stand}`).toEqual(['teleport']); // (the scene's own, to the top of the fall)
    }
  });

  it('a fall whose last report but one ends 0.15 above the ground, in the air: the drop to the ground belongs to it (3.6 blocks hurt, 3.45 do not)', () => {
    // More than FALL_SAFE_HEIGHT (3.5) hurts. Judged where the report ends, 3.6 blocks would be 3.45.
    for (const [height, hurt] of [
      [3.6, 1],
      [3.45, 0],
    ] as const) {
      const l = liar(0.5, 0.5, () => undefined);
      l.run.sim.soloPlayer.teleport(0.5, T + height, 0.5);
      l.tick();
      let y = T + height;
      let v = 0;
      while (y > T + 0.15) {
        const v1 = v - GRAVITY * TICK_DT;
        y = Math.max(T + 0.15, y + (v + v1) * 0.5 * TICK_DT);
        v = v1;
        l.send(0.5, y, 0.5, false, 1, v);
      }
      l.send(0.5, T, 0.5, true, 1, 0);
      l.wait(3);
      expect(l.causes, `${height} blocks`).toEqual(['teleport']);
      expect(l.damage, `${height} blocks`).toBe(hurt);
    }
  });

  it('a 12-block fall past the rim of a ledge, one report ending a hair above the rim and 0.05 beside it, in the air: the whole fall is judged on the ground, not cut at the rim', () => {
    // The support probe is wider than the body for a report that says it stands (the rim rule),
    // not for one that says it is in the air: the body falls past the ledge (one block high, its
    // face at x = 1; feet x 0.65 put the body 0.05 short of it). Report 17 of the fall ends 0.16
    // above the ledge's top. Cut there, the fall would hurt 8 + 0 instead of 9.
    const l = fallTo((run) => fill(run.sim.world, 1, T, -3, 4, T, 3, B.STONE), 0.65, 0.5, 0, true, (r) => r.wait(3));
    expect(l.causes).toEqual(['teleport']);
    expect(l.damage).toBe(Math.ceil(12 - 3.5));
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

  it('up a staircase with holes, 2.5 blocks up and 2 over in one report, a line a body can walk along: accepted (its path ends 1.5 below the higher end)', () => {
    // Half-block columns of a fuzzed staircase (heights in half blocks; columns from x 3.5, rows from z 2.5).
    // The line grazes the rims of holes it cannot step out of within a step, so its samples stay
    // low and the last leg straight up to the end is 1.5 (drive.ts stairClear, STAIR_LAST_LEG).
    const rows = [
      [0, 1, 0, 0, 4],
      [0, 1, 2, 3, 1],
      [0, 1, 2, 3, 3],
      [1, 2, 3, 2, 5],
      [2, 3, 4, 5, 6],
      [3, 4, 2, 6, 7],
      [4, 5, 6, 7, 7],
      [5, 6, 6, 8, 9],
    ];
    const terrain = (run: Run) => {
      for (let j = 0; j < rows.length; j++)
        for (let i = 0; i < 5; i++) for (let hy = 0; hy < rows[j]![i]!; hy++) addOctant(run.sim.world, 7 + i, 2 * T + hy, 5 + j, B.STONE);
    };
    const l = liar(0.5, 0.5, terrain);
    l.run.sim.soloPlayer.teleport(4.4308, T + 1, 3.4407);
    l.tick();
    l.send(4.4308, T + 1, 3.4407, true);
    l.wait(16);
    l.send(4.8553, T + 3.5, 5.3831, true, 16);
    expect(2.5).toBeGreaterThan(jumpPeak() + STEP_HEIGHT + 0.5);
    expect(l.causes).toEqual(['teleport']);
  });
});

describe('5.8 item 3, round the corner: exactly along the diagonal of a diagonal staircase', () => {
  /**
   * A line along the diagonal crosses an x riser and a z riser at the same sample, and the tread
   * beyond both is two steps higher than the one before them: the staircase path reaches it round
   * the corner, one axis and one step at a time (drive.ts stairClear). That is all the corner adds:
   * a riser along one axis is still crossed by one leg, so steeper stairs and the corners of
   * blocks get no staircase allowance and are judged by the plain bound.
   */
  const ticks = 16;
  const plain = jumpPeak() + STEP_HEIGHT + 0.5;
  /** Diagonal stairs from half cell (10, 10) on flat land, columns `rise` x (i + j) half blocks high. */
  function diagonal(rise: number): (run: Run) => void {
    return (run) => {
      for (let i = -2; i <= 12; i++)
        for (let j = -2; j <= 12; j++) for (let hy = 2 * T; hy < 2 * T + rise * (i + j); hy++) addOctant(run.sim.world, 10 + i, hy, 10 + j, B.STONE);
    };
  }

  it(`up a staircase of half steps, four blocks up along its diagonal in one report: accepted (higher than ${plain.toFixed(2)})`, () => {
    // From the foot at (4.25, 4.25) to (6.75, 6.75): the footprint reaches half cell 14 on both axes,
    // the tread there is (4 + 4) half blocks high.
    const l = liar(4.25, 4.25, diagonal(1));
    expect(4).toBeGreaterThan(plain);
    l.wait(ticks);
    l.send(6.75, T + 4, 6.75, true, ticks);
    expect(l.causes).toEqual([]);
    expect(l.rejected).toBe(0);
  });

  it('the same along the diagonal of stairs of whole steps (each riser a block): refused, check:rise', () => {
    // To (5.95, 5.95): the footprint reaches half cell 12, the tread there is (2 + 2) blocks high.
    // The sqrt(2) h allowance would have let it up there (more than 5 blocks for h = 2.4).
    const l = liar(4.25, 4.25, diagonal(2));
    l.wait(ticks);
    l.send(5.95, T + 4, 5.95, true, ticks);
    expect(l.causes).toEqual(['check:rise']);
  });

  it('stairs of whole blocks along one axis, 3.5 over and 3 up in one report, straight and slanting across them: refused, check:rise', () => {
    // A riser of a block lies along one axis: the corner's legs never climb it a step at a time, so
    // the corner's two steps must each be clear on the way (stairs rising toward +X from x = 3).
    const blockStairs = (run: Run) => {
      for (let k = 0; k < 8; k++) fill(run.sim.world, 3 + k, T, -6, 3 + k, T + k, 10, B.STONE);
    };
    for (const across of [0, 0.3, 0.8, 1.5, 2.5]) {
      const l = liar(2, 0.5, blockStairs);
      l.wait(ticks);
      l.send(5.5, T + 3, 0.5 + across, true, ticks);
      expect(l.causes, `${across} across`).toEqual(['check:rise']);
    }
  });

  it('a diagonal staircase of half steps with one side of its diagonal half a block higher: accepted either way (only x first, or only z first, climbs a step at a time)', () => {
    // Along the diagonal the leg toward the higher side meets a riser of a whole block; the other
    // leg climbs half a block, then the sample half a block more.
    const oneSided = (zSideHigh: boolean) => (run: Run) => {
      for (let i = -2; i <= 12; i++)
        for (let j = -2; j <= 12; j++) {
          const high = i + j >= 1 && (zSideHigh ? j > i : i > j);
          for (let hy = 2 * T; hy < 2 * T + Math.max(0, i + j) + (high ? 1 : 0); hy++) addOctant(run.sim.world, 10 + i, hy, 10 + j, B.STONE);
        }
    };
    for (const zSideHigh of [true, false]) {
      const l = liar(4.25, 4.25, oneSided(zSideHigh));
      l.wait(ticks);
      l.send(6.95, T + 4, 6.95, true, ticks);
      expect(l.causes, `${zSideHigh ? '+z' : '+x'} side higher`).toEqual([]);
    }
  });

  it(`onto the corner of a block along the diagonal: no higher than without the allowance (${plain.toFixed(2)} with the slack)`, () => {
    const block = (h: number) => (run: Run) => fill(run.sim.world, 6, T, 6, 10, T + h - 1, 10, B.STONE);
    const ok = Math.floor(plain);
    const l = liar(4.25, 4.25, block(ok));
    l.wait(ticks);
    l.send(6.75, T + ok, 6.75, true, ticks);
    expect(l.causes).toEqual([]);
    const r = liar(4.25, 4.25, block(ok + 1));
    r.wait(ticks);
    r.send(6.75, T + ok + 1, 6.75, true, ticks);
    expect(r.causes).toEqual(['check:rise']);
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
