/**
 * A wall beside the body is not ground (entities/drive.ts ReportJudge.standsOn). The server's
 * probe for "something holds the feet up" is a little wider than the footprint (a deck that rolls
 * differently on the server; a body that walked a tick past a ledge still claims to stand), and a
 * report may dip into hard cells by REPORT_HARD_TOLERANCE: both reach into a wall the body touches.
 * Counting that wall as ground let a made-up client climb it at a block per tick claiming to stand,
 * and fall beside it unharmed (already so before Milestone 2.3), or zigzag next to it through the
 * edge-landing rim rule of docs/SHAPES.md 5.8 item 4. A scripted lying client (tests/drive/liar.ts)
 * on full-block scenes; an honest body standing on a floor against (or a little into) a wall still
 * stands.
 */
import { describe, expect, it } from 'vitest';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { GRAVITY } from '../../src/entities/constants';
import { TICK_DT } from '../../src/core/constants';
import { Liar, liar } from './liar';
import { assemble, B, facingState, fill, LAND_TOP, makeCell, SEA_TOP, seaRun, type Run } from './scenes';

const T = LAND_TOP;

/** A stone wall x 3..4, z -3..3, from the ground up 40 blocks. The body's +X side touches it at feet x = 2.7. */
function tallWall(run: Run): void {
  fill(run.sim.world, 3, T, -3, 4, T + 40, 3, B.STONE);
}

/** Feet x where the body (half width 0.3) is `gap` from the wall's face (negative: dipping into it). */
const by = (gap: number): number => 2.7 - gap;

/**
 * Positions along the wall the body may be at: touching, inside the probe's widening, dipping into
 * it (within the checks' tolerance). An uncarried body that dips into the world is moved out of it
 * by the server ('unstick': the world does not move, so a block was put into it); that relocation
 * does not end its fall.
 */
const GAPS = [0, 0.05, -0.1, -0.15];
const ALLOWED = new Set(['check:rise', 'unstick']);

describe('climbing a wall, claiming to stand: refused once above a jump', () => {
  for (const gap of GAPS)
    for (const dy of [0.3, 1]) {
      it(`${gap >= 0 ? `${gap} from` : `${-gap} into`} the wall, ${dy} up per tick`, () => {
        const l = liar(by(gap), 0.5, tallWall);
        let y = T;
        for (let t = 0; t < 40; t++) {
          if (l.send(by(gap), y + dy, 0.5, true)) y += dy;
          else y = l.player.pos.y;
        }
        // No higher than a jump (1.25) and the slack (0.5) above the ground at any time.
        expect(l.player.pos.y - T).toBeLessThan(1.8);
        expect(l.causes).toContain('check:rise');
        expect(l.causes.filter((c) => !ALLOWED.has(c))).toEqual([]);
      });
    }
});

/** A fall from `height` above the ground reported tick by tick; `at(i)` the feet x and whether report i claims to stand. */
function fall(height: number, at: (i: number) => { x: number; stand: boolean }): Liar {
  const l = liar(1.5, 0.5, tallWall);
  l.run.sim.soloPlayer.teleport(at(0).x, T + height, 0.5);
  l.tick();
  let y = T + height;
  let v = 0;
  for (let i = 0; y > T && i < 400; i++) {
    const v1 = v - GRAVITY * TICK_DT;
    y = Math.max(T, y + (v + v1) * 0.5 * TICK_DT);
    v = v1;
    const landed = y === T;
    const a = at(i);
    if (!l.send(a.x, y, 0.5, landed || a.stand, 1, landed ? 0 : v)) {
      y = l.player.pos.y;
      v = l.player.vel.y;
    }
  }
  l.wait(5);
  return l;
}

describe('falling beside a wall, claiming to stand: the fall is judged as an honest one', () => {
  const honest = Math.ceil(12 - 3.5);

  it('the honest 12-block fall, away from the wall', () => {
    expect(fall(12, () => ({ x: 1.5, stand: false })).damage).toBe(honest);
  });

  for (const gap of GAPS) {
    it(`${gap >= 0 ? `${gap} from` : `${-gap} into`} the wall, claiming to stand every report`, () => {
      expect(fall(12, () => ({ x: by(gap), stand: true })).damage).toBe(honest);
    });
  }

  it('zigzag: in the air within the probe of the wall, then standing a quarter block away from it (the rim rule of an edge landing)', () => {
    const l = fall(12, (i) => (i % 2 === 1 ? { x: by(0.25), stand: true } : { x: by(0.05), stand: false }));
    expect(l.damage).toBe(honest);
  });
});

describe('an honest body on a floor against a wall still stands', () => {
  for (const gap of [0, 0.05]) {
    it(`${gap} from the wall`, () => {
      const l = liar(1.5, 0.5, tallWall);
      // Over a few reports (the speed check), to the wall.
      for (let x = 1.5; x < by(gap); x = Math.min(by(gap), x + 0.25)) l.send(Math.min(by(gap), x + 0.25), T, 0.5, true);
      l.send(by(gap), T, 0.5, true);
      expect(l.causes).toEqual([]);
      expect(l.player.remote!.onGround).toBe(true);
    });
  }
});

describe('on a deck: its mast is not ground either', () => {
  /** A raft at sea (planks deck at SEA_TOP - 1, x -3..6, z -3..6) with a mast at x 2, z 2 up 20 blocks; the liar on the deck beside it (feet x 1.7: touching). */
  function raft(): Liar {
    const run = seaRun('survival', vec3(0.5, SEA_TOP, 2.5), null);
    const sim = run.sim;
    fill(sim.world, -3, SEA_TOP - 1, -3, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    fill(sim.world, 2, SEA_TOP, 2, 2, SEA_TOP + 19, 2, B.PLANKS_OAK);
    sim.world.setCell(-2, SEA_TOP, 5, makeCell(B.HELM, facingState(NZ)));
    const ship = assemble(sim, vec3(-2, SEA_TOP, 5));
    for (let t = 0; t < 60; t++) sim.tick();
    const w = ship.grid.toWorld(vec3(1.7, SEA_TOP, 2.5));
    sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
    for (let t = 0; t < 20; t++) sim.tick();
    const l = new Liar(run);
    expect(l.carrierId).toBe(ship.id);
    l.send(1.7, SEA_TOP, 2.5);
    expect(l.causes).toEqual([]);
    return l;
  }

  for (const gap of [0, 0.05, -0.05, -0.15]) {
    const where = gap >= 0 ? `${gap} from` : `${-gap} into`;
    it(`${where} the mast, climbing it at 0.6 per tick claiming to stand on the deck: refused once above a jump`, () => {
      const l = raft();
      const x = 1.7 - gap;
      let y = SEA_TOP;
      let best = 0;
      for (let t = 0; t < 30; t++) {
        if (l.send(x, y + 0.6, 2.5, true)) y += 0.6;
        else y = SEA_TOP; // (the server's correction: back on the deck or falling to it)
        best = Math.max(best, y - SEA_TOP);
      }
      expect(best).toBeLessThan(1.8);
      expect([...new Set(l.causes)]).toEqual(['check:rise']);
    });

    it(`an honest body on the deck ${where} the mast (the deck heels a little) still stands`, () => {
      const l = raft();
      l.send(1.7 - gap, SEA_TOP, 2.5, true);
      expect(l.causes).toEqual([]);
      expect(l.player.remote!.onGround).toBe(true);
    });
  }
});
