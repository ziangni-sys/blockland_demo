/**
 * An honest client-driven player that jumps at random while it walks or sprints down a staircase
 * (docs/SHAPES.md 5.8; bunny-hopping down stairs is ordinary play): zero latency, every report
 * delivered, so the server must refuse nothing.
 *
 * What this pins: a body lands on the last hundredth of a tread (the server sees it stand), walks
 * off it in the next tick while its report still claims to stand (the mover sets its ground flag
 * before the horizontal move), and jumps in the tick after. The server, finding nothing under that
 * report, must keep the latest take-off open for that one report (entities/drive.ts, the window
 * after a report that truly stood or an edge landing); else the jump starts a tick later than
 * the envelope allows and a report of the following descent is refused for rising.
 *
 * Octant staircases put such an edge every half block. The full-block staircase (one block deep
 * treads) is the same case, rarer, and was already refused now and then before Milestone 2.3.
 */
import { describe, expect, it } from 'vitest';
import { B, corrections, driveStats, fill, LAND_TOP, landRun, type Run } from './scenes';
import { worldStairs } from './stairs-scenes';

/** A full-block staircase rising toward +X (treads one block deep, risers one block), the body at its top. */
function fullStairsTop(): Run {
  const steps = 14;
  const at = { x: 5 + steps + 2.5, y: LAND_TOP + steps, z: 1.5 };
  const run = landRun('survival', { x: at.x, y: LAND_TOP, z: at.z }, 0);
  for (let k = 0; k < steps; k++) fill(run.sim.world, 5 + k, LAND_TOP, 0, 5 + steps + 8, LAND_TOP + k, 2, B.STONE);
  run.sim.soloPlayer.teleport(at.x, at.y, at.z);
  for (let t = 0; t < 10; t++) run.sim.tick();
  return run;
}

type Case = 'straight' | 'diagonal' | 'full';

/** One descent with forward held and jump pressed at random (seeded); the corrections it caused. */
function descent(kind: Case, sprint: boolean, seed: number): string[] {
  const run = kind === 'full' ? fullStairsTop() : worldStairs(kind, true);
  const sim = run.sim;
  for (let t = 0; t < 5; t++) sim.tick();
  const c0 = corrections(run).length;
  const r0 = driveStats(run).rejected;
  const inp = sim.soloPlayer.player.input;
  inp.forward = 1;
  inp.sprint = sprint;
  // Down: the staircases rise toward +X (the diagonal one toward +X +Z).
  inp.yaw = kind === 'diagonal' ? Math.PI / 4 : Math.PI / 2;
  let a = seed * 2654435761;
  const rnd = (): number => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0), a / 4294967296);
  const pJump = [0.1, 0.3, 1][seed % 3]!;
  for (let t = 0; t < 40; t++) {
    inp.jump = rnd() < pJump;
    sim.tick();
  }
  inp.jump = false;
  const cs = corrections(run).slice(c0);
  if (driveStats(run).rejected - r0 > 0 && cs.length === 0) cs.push('refused');
  return cs;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('5.8: jumping at random while going down a staircase, every report delivered: nothing refused', () => {
  const cases: Array<[Case, boolean]> = [
    ['straight', false],
    ['straight', true],
    ['diagonal', true],
    ['full', true],
  ];
  for (const [kind, sprint] of cases) {
    it(`${kind} staircase, ${sprint ? 'sprinting' : 'walking'} down, ${SEEDS.length} random jump scripts`, () => {
      const bad: string[] = [];
      for (const seed of SEEDS) {
        const cs = descent(kind, sprint, seed);
        if (cs.length > 0) bad.push(`seed ${seed}: [${cs.join(',')}]`);
      }
      expect(bad).toEqual([]);
    }, 120_000);
  }
});
