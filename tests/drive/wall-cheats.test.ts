/**
 * A wall beside the body is not ground (entities/drive.ts ReportJudge.standsOn). The server's
 * probe for "something holds the feet up" is a little wider than the footprint (a deck that rolls
 * differently on the server; a body that walked a tick past a ledge still claims to stand), and a
 * report may dip into hard cells by REPORT_HARD_TOLERANCE: both reach into a wall the body touches.
 * Counting that wall as ground let a made-up client climb it at a block per tick claiming to stand,
 * and fall beside it unharmed (already so before Milestone 2.3), or zigzag next to it through the
 * edge-landing rim rule of docs/SHAPES.md 5.8 item 4. A scripted lying client (tests/drive/liar.ts)
 * on full-block scenes; an honest body standing on a floor against (or a little into) a wall still
 * stands. A report that says it is in the air gets the widening only while it says it rises no
 * faster than a jump: an honest body a blast throws up past the top of a wall it stands beside, or
 * that falls past it, does not land on that top. On tilted structures (heeled decks, a rotor
 * stopped at any angle) walls lean along the grid axis nearest the vertical, toward one side, and a
 * wall's foot reaches under the feet from that side.
 */
import { describe, expect, it } from 'vitest';
import { NZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { GRAVITY } from '../../src/entities/constants';
import { TICK_DT } from '../../src/core/constants';
import { attachClient } from './client';
import { drum } from './drum';
import { Liar, liar } from './liar';
import { assemble, B, corrections, facingState, fill, hurts, LAND_TOP, landRun, makeCell, SEA_TOP, seaRun, type Run } from './scenes';
import { addOctant } from './stairs-scenes';

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

describe('a blast throws an honest body up past the top of a wall it stands beside: nothing corrected but the knock, hurt as a server-driven body', () => {
  /**
   * The body (lagged harness at lag 0, every report delivered) stands 0.01 to 0.08 short of a wall
   * (x = 3) and is knocked up. Its feet pass the wall's top within the support probe's widening on
   * the way up and on the way down, in the air by its own flag. Held up there, the envelope would
   * start again with a jump slower than the blast's arc (the next report refused: check:rise, the
   * body taken over), and the fall would be cut in two at the top (less damage).
   */
  const walls: Record<string, (run: Run) => void> = {
    'one block': (run) => fill(run.sim.world, 3, T, -3, 3, T, 3, B.STONE),
    'two blocks': (run) => fill(run.sim.world, 3, T, -3, 3, T + 1, 3, B.STONE),
    'three blocks': (run) => fill(run.sim.world, 3, T, -3, 3, T + 2, 3, B.STONE),
    'a block and a half slab': (run) => {
      fill(run.sim.world, 3, T, -3, 3, T, 3, B.STONE);
      for (let hx = 6; hx < 8; hx++) for (let hz = -6; hz < 8; hz++) addOctant(run.sim.world, hx, 2 * T + 2, hz, B.STONE);
    },
  };
  /** Knocked up by `dvy` (and toward the wall by `dvx`) from feet x `x`; 80 ticks later: the corrections after the knock's own, and the damage. */
  function knocked(wall: string, x: number, dvx: number, dvy: number, lag: number | null): { causes: string[]; damage: number } {
    const run = landRun('survival', { x, y: T, z: 0.5 }, lag);
    walls[wall]!(run);
    const sim = run.sim;
    for (let t = 0; t < 10; t++) sim.tick();
    const c0 = corrections(run).length;
    sim.entities.knock(sim.soloPlayer.player, dvx, dvy, 0);
    for (let t = 0; t < 80; t++) sim.tick();
    return { causes: corrections(run).slice(c0), damage: hurts(run).reduce((a, e) => a + e.amount, 0) };
  }

  it('walls one, two and three blocks high and one and a half: knocks of 17 to 22.5 blocks per second', () => {
    const bad: string[] = [];
    for (const [wall, speeds] of [
      ['one block', [19, 21]],
      ['two blocks', [22]],
      ['three blocks', [18.5, 22.5]],
      ['a block and a half slab', [17]],
    ] as const)
      for (const dvy of speeds)
        for (const dvx of [0, 2])
          for (const x of [2.62, 2.69]) {
            const ref = knocked(wall, x, dvx, dvy, null);
            const c = knocked(wall, x, dvx, dvy, 0);
            if (c.causes.join() !== 'knock' || c.damage !== ref.damage) bad.push(`${wall}, up ${dvy}, toward it ${dvx}, feet x ${x}: ${JSON.stringify(c)}, server-driven damage ${ref.damage}`);
          }
    expect(bad).toEqual([]);
  });
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

describe('on a heeled deck: its mast is not ground either, however the mast leans', () => {
  /**
   * A raft at sea (planks deck at SEA_TOP - 1, x -3..6, z -3..6) with a mast at x 2, z 2 up 20
   * blocks and planks stacked on its -x edge (`load`: x -3..-1, 4 high, or x -3..-2, 2 high),
   * which heel it toward that edge, or on its -x -z corner (x and z -3..0, 4 high), which heels it
   * toward that corner (the mast then leans along both axes);
   * the liar on the deck beside the mast's `side` face, `gap` from it. A wall of a tilted structure
   * leans, and its foot reaches under the feet of a body that stays clear of it above them
   * (drive.ts clearOfLeaningWalls): on the side it leans over the body and on the side it leans
   * away, the mast holds up nothing.
   */
  function raft(load: 'heavy' | 'light' | 'corner', side: string, gap: number): { l: Liar; heel: number; x: number; z: number } {
    const at: Record<string, [number, number]> = {
      '-x': [1.7 - gap, 2.5],
      '+x': [3.3 + gap, 2.5],
      '-z': [2.5, 1.7 - gap],
      '+z': [2.5, 3.3 + gap],
      // At a corner of the mast (diagonally beside it): only the footprint's corner square is in reach.
      '-x-z': [1.7 - gap, 1.7 - gap],
      '+x+z': [3.3 + gap, 3.3 + gap],
      '-x+z': [1.7 - gap, 3.3 + gap],
      '+x-z': [3.3 + gap, 1.7 - gap],
    };
    const [x, z] = at[side]!;
    const run = seaRun('survival', vec3(0.5, SEA_TOP, 2.5), null);
    const sim = run.sim;
    fill(sim.world, -3, SEA_TOP - 1, -3, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    fill(sim.world, 2, SEA_TOP, 2, 2, SEA_TOP + 19, 2, B.PLANKS_OAK);
    if (load === 'heavy') fill(sim.world, -3, SEA_TOP, -3, -1, SEA_TOP + 3, 6, B.PLANKS_OAK);
    else if (load === 'light') fill(sim.world, -3, SEA_TOP, -3, -2, SEA_TOP + 1, 6, B.PLANKS_OAK);
    else fill(sim.world, -3, SEA_TOP, -3, 0, SEA_TOP + 3, 0, B.PLANKS_OAK);
    sim.world.setCell(5, SEA_TOP, 5, makeCell(B.HELM, facingState(NZ)));
    const ship = assemble(sim, vec3(5, SEA_TOP, 5));
    for (let t = 0; t < 200; t++) sim.tick();
    const q = ship.grid.rotation;
    const heel = (Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))) * 180) / Math.PI;
    const w = ship.grid.toWorld(vec3(x, SEA_TOP, z));
    sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
    for (let t = 0; t < 20; t++) sim.tick();
    const l = new Liar(run);
    expect(l.carrierId).toBe(ship.id);
    l.send(x, SEA_TOP, z);
    return { l, heel, x, z };
  }

  for (const [load, least, toward] of [
    ['heavy', 15, 'an edge'],
    ['light', 4, 'an edge'],
    ['corner', 10, 'a corner'],
  ] as const) {
    for (const stand of [true, false]) {
      it(`heeling ${least} degrees or more toward ${toward}: climbing the mast at 0.6 per tick on each side and at each corner, ${stand ? 'claiming to stand' : 'claiming to be in the air'}: refused once above a jump`, () => {
        for (const side of ['-x', '+x', '-z', '+z', '-x-z', '+x+z', '-x+z', '+x-z'])
          for (const gap of [0, 0.05, 0.1, 0.12, -0.05, -0.15]) {
            const { l, heel, x, z } = raft(load, side, gap);
            expect(heel).toBeGreaterThan(least);
            let y = SEA_TOP;
            let best = 0;
            for (let t = 0; t < 30; t++) {
              if (l.send(x, y + 0.6, z, stand)) y += 0.6;
              else y = SEA_TOP;
              best = Math.max(best, y - SEA_TOP);
            }
            const what = `${side} side, ${gap} from the mast: ${best.toFixed(1)} up, causes ${JSON.stringify(l.causes)}`;
            expect(best, what).toBeLessThan(1.8);
            // (Dipping into a mast that leans over the body is the hull check's.)
            for (const c of l.causes) expect(['check:rise', 'check:hull'], what).toContain(c);
          }
      });
    }
  }

  it('an honest body on the deck beside the mast, heeling 4 degrees or more, on each side: still stands', () => {
    // (On the -x side the mast leans over the body: a quarter block short of its foot the body
    // clears it up to its head.)
    for (const [side, gaps] of [
      ['-x', [0.25, 0.4]],
      ['+x', [0, 0.05, 0.1]],
      ['-z', [0, 0.05, 0.1]],
      ['+z', [0, 0.05, 0.1]],
    ] as const)
      for (const gap of gaps) {
        const { l, heel } = raft('light', side, gap);
        expect(heel).toBeGreaterThan(4);
        expect(l.causes, `${side} ${gap}`).toEqual([]);
        expect(l.player.remote!.onGround, `${side} ${gap}`).toBe(true);
      }
  });

  it('an honest body on the deck standing on the edge of a step, a wall touching its other side: still stands', () => {
    // A step (x 4, z 0..1, one block) and beside it a wall (x 4..5, z 2, three blocks); the body's
    // footprint reaches 0.02 over the step's -x edge and touches the wall's face z = 2. The heel
    // tilts x, not z: the deck's walls lean toward -x (its low side), so the wall's face z = 2 does
    // not lean toward the body, and the strip of step lies along the +x side, away from the lean.
    const run = seaRun('survival', vec3(0.5, SEA_TOP, 2.5), null);
    const sim = run.sim;
    fill(sim.world, -3, SEA_TOP - 1, -3, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    fill(sim.world, -3, SEA_TOP, -3, -2, SEA_TOP + 1, 6, B.PLANKS_OAK);
    fill(sim.world, 4, SEA_TOP, 0, 4, SEA_TOP, 1, B.PLANKS_OAK);
    fill(sim.world, 4, SEA_TOP, 2, 5, SEA_TOP + 2, 2, B.PLANKS_OAK);
    sim.world.setCell(5, SEA_TOP, 5, makeCell(B.HELM, facingState(NZ)));
    const ship = assemble(sim, vec3(5, SEA_TOP, 5));
    for (let t = 0; t < 200; t++) sim.tick();
    const q = ship.grid.rotation;
    expect((Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))) * 180) / Math.PI).toBeGreaterThan(4);
    const w = ship.grid.toWorld(vec3(3, SEA_TOP, 1.5));
    sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
    for (let t = 0; t < 20; t++) sim.tick();
    const l = new Liar(run);
    expect(l.carrierId).toBe(ship.id);
    l.send(3, SEA_TOP, 1.5, true);
    // Up onto the step's edge (feet x 3.72: 0.02 of the footprint over the step), ten ticks later.
    l.wait(10);
    l.send(3.72, SEA_TOP + 1, 1.7, true, 10);
    expect(l.causes).toEqual([]);
    expect(l.player.remote!.onGround).toBe(true);
  });

  it('heeling toward a corner: an honest body that has just stepped up onto a step on its -x side, a wall touching its -z side: still stands', () => {
    // The walls lean toward -x and -z (the corner the load sinks), so beyond both those sides a
    // wall's foot may reach under the feet. Beyond -z there is one (x 2..3, z 3, three blocks); its
    // strip is left out. Beyond -x there is none, so that side's strip stays, and it holds the
    // step (x 1, z 4..5): about a hundredth of the footprint over the step's top (feet x 2.29), as
    // when the body has just stepped up; within the probe's depth the step lies wholly within that
    // strip. (Leaving out the strip on -x as well would leave nothing.)
    const run = seaRun('survival', vec3(0.5, SEA_TOP, 2.5), null);
    const sim = run.sim;
    fill(sim.world, -3, SEA_TOP - 1, -3, 6, SEA_TOP - 1, 6, B.PLANKS_OAK);
    fill(sim.world, -3, SEA_TOP, -3, 0, SEA_TOP + 3, 0, B.PLANKS_OAK);
    fill(sim.world, 1, SEA_TOP, 4, 1, SEA_TOP, 5, B.PLANKS_OAK);
    fill(sim.world, 2, SEA_TOP, 3, 3, SEA_TOP + 2, 3, B.PLANKS_OAK);
    sim.world.setCell(5, SEA_TOP, 5, makeCell(B.HELM, facingState(NZ)));
    const ship = assemble(sim, vec3(5, SEA_TOP, 5));
    for (let t = 0; t < 200; t++) sim.tick();
    const up = ship.grid.toWorld(vec3(0, 1, 0));
    const o = ship.grid.toWorld(vec3(0, 0, 0));
    expect(o.x - up.x, 'leaning toward -x').toBeGreaterThan(0.1);
    expect(o.z - up.z, 'leaning toward -z').toBeGreaterThan(0.1);
    const w = ship.grid.toWorld(vec3(3.5, SEA_TOP, 5));
    sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
    for (let t = 0; t < 20; t++) sim.tick();
    const l = new Liar(run);
    expect(l.carrierId).toBe(ship.id);
    l.send(3.5, SEA_TOP, 5, true);
    l.wait(10);
    l.send(2.29, SEA_TOP + 1, 4.31, true, 10);
    expect(l.causes).toEqual([]);
    expect(l.player.remote!.onGround).toBe(true);
  });
});

describe('on a structure turned steeply (drum.ts: a rotor stopped at an angle): its walls lean along the grid axis nearest the vertical, toward one side', () => {
  /**
   * A structure's walls rise along its grid axis nearest the world's vertical (drive.ts leanOf):
   * turned 80 degrees about a horizontal axis, its face on top slopes 10 degrees and the mast on
   * that face leans 10 degrees. Measured by its local up instead, the lean was 5.7 there and the
   * reach of a leaning wall (clearOfLeaningWalls) 1.6 blocks, so nothing of the footprint was left
   * and an honest player was corrected for check:rise every few ticks; from 90 degrees on the lean
   * was infinite, the probe for leaning walls invalid, and nothing was left out at all: a lying
   * client climbed the mast claiming to stand.
   *
   * Turned 40 to 50 degrees, the face on top slopes as steeply as the mast leans. A wall's foot
   * reaches under the feet only from the side the walls lean toward (down the slope); leaving out
   * a strip on every side, the rule also left out the floor rising up the slope behind the body,
   * and a body in the crease between that floor and the mast stood on nothing: corrected for
   * check:rise. (Turned exactly 45 degrees, the two faces of the ridge are equally steep and the
   * rule cannot tell floor from wall: not tested.)
   */
  const SPOTS: ReadonlyArray<readonly [string, number, number]> = [
    ['in the open', 2.8, 1.6],
    ['beside the mast, 0.3 from it', 3.4, 0],
    ['beside the mast, touching it', 3.69, 0],
    ['beside the mast up the slope or down it, 0.3 from it', 4.5, 1.1],
    ['beside the mast down the slope or up it, 0.3 from it', 4.5, -1.1],
  ];

  it('an honest body standing and walking on the face on top, in the open and beside the mast, every report delivered and three of every four lost: nothing refused or corrected', () => {
    const bad: string[] = [];
    for (const deg of [40, 44, 50, 60, 80, 100, 160, -80])
      for (const [where, x, across] of SPOTS)
        for (const lose of [0, 3]) {
          const d = drum(deg);
          const sim = d.run.sim;
          const w = d.rotor.grid.toWorld(d.onFace(x, across, 0.02));
          sim.soloPlayer.teleport(w.x, w.y + 0.3, w.z);
          for (let i = 0; i < 40; i++) sim.tick();
          const client = attachClient(sim, 0);
          const ctl = sim.soloPlayer;
          const submit = ctl.submitReport.bind(ctl);
          let n = 0;
          ctl.submitReport = (rep) => {
            if (++n % (lose + 1) === 0) submit(rep);
          };
          for (let i = 0; i < 100; i++) {
            // Standing 40 ticks, then a few steps one way and back.
            ctl.player.input.forward = i >= 40 && i < 55 ? 0.5 : i >= 70 && i < 85 ? -0.5 : 0;
            sim.tick();
          }
          const st = ctl.player.remote!;
          if (client.causes().length > 0 || st.rejected > 0) bad.push(`${deg} degrees, ${where}, ${lose} of ${lose + 1} lost: ${JSON.stringify(client.causes())}`);
        }
    expect(bad).toEqual([]);
  });

  it('an honest body walking up or down the face into the mast, from the side the mast leans away from (the crease between the floor and the mast): nothing refused or corrected', () => {
    const bad: string[] = [];
    // Turned 40 and 44 degrees the mast leans down the slope (away from a body above it); turned
    // 46 and 50 the face on top is the next one, and it leans up the slope.
    for (const [deg, across] of [
      [40, 1.6],
      [44, 1.6],
      [46, -1.6],
      [50, -1.6],
    ] as const) {
      const d = drum(deg);
      const sim = d.run.sim;
      const g = d.rotor.grid;
      const w = g.toWorld(d.onFace(4.5, across, 0.02));
      sim.soloPlayer.teleport(w.x, w.y + 0.3, w.z);
      for (let i = 0; i < 40; i++) sim.tick();
      const client = attachClient(sim, 0);
      const ctl = sim.soloPlayer;
      const target = g.toWorld(d.onFace(4.5, 0, 1.5));
      for (let i = 0; i < 120; i++) {
        ctl.lookAt(target.x, client.player.pos.y + 1.6, target.z);
        ctl.player.input.forward = 1;
        sim.tick();
      }
      if (client.causes().length > 0 || ctl.player.remote!.rejected > 0) bad.push(`${deg} degrees: ${JSON.stringify(client.causes())}`);
    }
    expect(bad).toEqual([]);
  });

  it('climbing the mast on that face at 0.6 per report, on each side and at each corner, claiming to stand or to be in the air: no higher than a jump', () => {
    const bad: string[] = [];
    for (const deg of [40, 100, 120, 160])
      for (const stand of [true, false])
        for (const gap of [-0.15, -0.05, 0, 0.05, 0.14]) {
          const near = 0.3 + gap;
          const spots: ReadonlyArray<readonly [string, number, number]> = [
            ['-x side', 4 - near, 0],
            ['+x side', 5 + near, 0],
            ['+across side', 4.5, 0.5 + near],
            ['-across side', 4.5, -(0.5 + near)],
            ['corner -+', 4 - near, 0.5 + near],
            ['corner ++', 5 + near, 0.5 + near],
            ['corner --', 4 - near, -(0.5 + near)],
            ['corner +-', 5 + near, -(0.5 + near)],
          ];
          for (const [side, x, across] of spots) {
            const d = drum(deg);
            const sim = d.run.sim;
            const g = d.rotor.grid;
            const w = g.toWorld(d.onFace(x, across, 0.02));
            sim.soloPlayer.teleport(w.x, w.y + 0.25, w.z);
            for (let i = 0; i < 25; i++) sim.tick();
            const sp = sim.soloPlayer.player;
            // On a face steeper than about 38 degrees the server's mover does not make the drum the
            // body's carrier: the reports then go in the world frame.
            expect(sp.onGround && (sp.carrierId === d.rotor.id || sp.carrierId === 0), `${deg} ${side}: standing on the drum`).toBe(true);
            const frame = (q: Vec3): Vec3 => (sp.carrierId === d.rotor.id ? q : g.toWorld(q));
            const l = new Liar(d.run);
            // From where the server's mover settled the body, along the face's normal (up the mast).
            const s = d.onFace(x, across, 0);
            const p0 = g.toLocal(sp.pos);
            const lift = (p0.y - s.y) * d.n.y + (p0.z - s.z) * d.n.z;
            const at = vec3(s.x, s.y + d.n.y * lift, s.z + d.n.z * lift);
            const y0 = sp.pos.y;
            const a0 = frame(at);
            l.send(a0.x, a0.y, a0.z, true);
            let cur = at;
            let best = 0;
            for (let t = 0; t < 30; t++) {
              const next = vec3(cur.x, cur.y + d.n.y * 0.6, cur.z + d.n.z * 0.6);
              const nw = frame(next);
              cur = l.send(nw.x, nw.y, nw.z, stand) ? next : at;
              best = Math.max(best, l.player.pos.y - y0);
            }
            if (best >= 1.8) bad.push(`${deg} degrees, ${side}, ${gap} from the mast, ${stand ? 'standing' : 'in the air'}: ${best.toFixed(1)} up`);
          }
        }
    expect(bad).toEqual([]);
  });
});
