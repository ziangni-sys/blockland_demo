/**
 * Scenes for the movement checks on half slabs and octant staircases (docs/SHAPES.md 5.8): a
 * client-driven player played by the lagged client harness (client.ts, lag 0: it sees exactly
 * what the server sees) walks or sprints up and down a staircase, in the world or on a ship, while
 * a pattern of its move reports is lost on the way; the server's corrections and refused reports
 * are counted.
 *
 * Staircases are built octant by octant on the half-cell lattice (half-cell coordinates: cell =
 * h >> 1, octant bit = h & 1 per axis):
 *  - 'slab': a platform of lower half slabs, walked onto and off again (half a block up and down);
 *  - 'straight': steps along +X, each half a block high and half a block deep (45 degrees), and a
 *    landing at the top;
 *  - 'diagonal': a staircase rising toward +X and +Z at once (height = 0.5 (i + j)), walked
 *    diagonally: the steepest climb a body can make, 1.4 times its horizontal displacement;
 *  - 'stairwell': the straight staircase under a ceiling 3.0 above each tread and the landing (the
 *    lowest headroom a 45 degree octant staircase can be climbed in), so no path through the air
 *    above the treads.
 */
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import type { MoveReport } from '../../src/entities/drive';
import type { Ship } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { solidFillAt } from '../../src/voxel/parts';
import { slab } from '../shapes';
import { assemble, corrections, driveStats, facingState, fill, hurts, LAND_TOP, landRun, makeCell, SEA_TOP, seaRun, type Run } from './scenes';

export type StairKind = 'slab' | 'straight' | 'diagonal' | 'stairwell';

/** Add the octant at half-cell coordinates (hx, hy, hz) to `g`, of block `id`. */
export function addOctant(g: VoxelGrid, hx: number, hy: number, hz: number, id: number): void {
  const x = hx >> 1;
  const y = hy >> 1;
  const z = hz >> 1;
  const f = solidFillAt(g, x, y, z) | (1 << ((hx & 1) | ((hy & 1) << 1) | ((hz & 1) << 2)));
  g.setCell(x, y, z, f === 0xff ? makeCell(id) : slab(id, f));
}

/**
 * Build a staircase of `kind` with its foot at half-cell height h0, starting at half-cell x hx0,
 * across half-cell z hz0..hz0+5 (3 blocks wide; the diagonal one from hz0 on): `steps` half-block
 * steps, then (straight, stairwell) a landing `landing` half cells long.
 */
export function buildStairs(g: VoxelGrid, kind: StairKind, hx0: number, h0: number, hz0: number, steps: number, id: number, landing = 20): void {
  if (kind === 'slab') {
    for (let hx = hx0; hx < hx0 + 8; hx++) for (let hz = hz0; hz < hz0 + 6; hz++) addOctant(g, hx, h0, hz, id);
    return;
  }
  if (kind === 'diagonal') {
    for (let i = -2; i <= steps; i++)
      for (let j = -2; j <= steps; j++) {
        const st = i + j;
        for (let hy = h0; hy < h0 + st; hy++) addOctant(g, hx0 + i, hy, hz0 + j, id);
      }
    return;
  }
  for (let k = 0; k < steps + landing; k++) {
    const top = h0 + (k < steps ? k + 1 : steps);
    for (let hz = hz0; hz < hz0 + 6; hz++) {
      for (let hy = h0; hy < top; hy++) addOctant(g, hx0 + k, hy, hz, id);
      if (kind === 'stairwell') for (let hy = top + 6; hy < top + 8; hy++) addOctant(g, hx0 + k, hy, hz, id);
    }
  }
  if (kind === 'stairwell') for (let hx = hx0 - 10; hx < hx0; hx++) for (let hz = hz0; hz < hz0 + 6; hz++) for (let hy = h0 + 6; hy < h0 + 8; hy++) addOctant(g, hx, hy, hz, id);
}

export interface WalkResult {
  /** Corrections the client received during the walk (causes; none for a server-driven player). */
  causes: string[];
  /** Reports the server refused during it. */
  rejected: number;
  /** Highest and lowest the moving body got relative to its start, and where it ended. */
  climbed: number;
  descended: number;
  endDy: number;
  /** Reports handed to the server. */
  delivered: number;
  /** Damage the player took during the walk. */
  damage: number;
}

export interface WalkOpts {
  sprint: boolean;
  /** Of every lose + 1 reports, the first `lose` are lost on the way (0: none). */
  lose: number;
  ticks: number;
  /** Jump in the tick of each delivered report and the one before it (the known limitation, 5.8 item 2). */
  jumpBeforeDelivered?: boolean;
}

/**
 * Walk the run's player (held forward at `yaw`) for o.ticks ticks, its reports lost per o.lose.
 * Measured on the body that moves: the client's (client-driven) or the server's (the reference).
 */
export function walk(run: Run, yaw: number, o: WalkOpts): WalkResult {
  const sim = run.sim;
  const ctl = sim.soloPlayer;
  for (let t = 0; t < 5; t++) sim.tick();
  const submit = ctl.submitReport.bind(ctl);
  let n = 0;
  let delivered = 0;
  ctl.submitReport = (rep: MoveReport) => {
    n++;
    if (o.lose > 0 && n % (o.lose + 1) !== 0) return;
    delivered++;
    submit(rep);
  };
  const c0 = corrections(run).length;
  const r0 = driveStats(run).rejected;
  const h0 = hurts(run).reduce((a, e) => a + e.amount, 0);
  const body = run.client !== null ? run.client.player : ctl.player;
  const y0 = body.pos.y;
  const inp = ctl.player.input;
  inp.forward = 1;
  inp.sprint = o.sprint;
  inp.yaw = yaw;
  let top = y0;
  let low = y0;
  for (let t = 0; t < o.ticks; t++) {
    if (o.jumpBeforeDelivered === true) {
      const phase = (n + 1) % (o.lose + 1);
      inp.jump = phase === 0 || phase === o.lose;
    }
    sim.tick();
    top = Math.max(top, body.pos.y);
    low = Math.min(low, body.pos.y);
  }
  ctl.submitReport = submit;
  inp.forward = 0;
  inp.jump = false;
  return {
    causes: corrections(run).slice(c0),
    rejected: driveStats(run).rejected - r0,
    climbed: top - y0,
    descended: y0 - low,
    endDy: body.pos.y - y0,
    delivered,
    damage: hurts(run).reduce((a, e) => a + e.amount, 0) - h0,
  };
}

/**
 * Where the walks start and which way they go, per kind: up toward +X (the diagonal one toward +X
 * and +Z), from the foot; down the other way, from `top` (blocks above the foot level and its x/z;
 * the world's 36-step staircases and the ship's 12-step ones). The straight staircases start at
 * half-cell (10, 2), the diagonal one at (10, 10).
 */
export const START: Record<StairKind, { x: number; z: number; yaw: number; hz0: number; top: { x: number; z: number; dy: number }; shipTop: { x: number; z: number; dy: number } }> = {
  slab: { x: 2.5, z: 2.25, yaw: -Math.PI / 2, hz0: 2, top: { x: 7, z: 2.25, dy: 0.5 }, shipTop: { x: 7, z: 2.25, dy: 0.5 } },
  straight: { x: 2.5, z: 2.25, yaw: -Math.PI / 2, hz0: 2, top: { x: 25, z: 2.25, dy: 18 }, shipTop: { x: 12.5, z: 2.25, dy: 6 } },
  stairwell: { x: 2.5, z: 2.25, yaw: -Math.PI / 2, hz0: 2, top: { x: 25, z: 2.25, dy: 18 }, shipTop: { x: 12.5, z: 2.25, dy: 6 } },
  diagonal: { x: 4.25, z: 4.25, yaw: (-3 * Math.PI) / 4, hz0: 10, top: { x: 17.25, z: 17.25, dy: 24 }, shipTop: { x: 8.25, z: 8.25, dy: 6 } },
};

/**
 * A flat-land run with a staircase of `kind` in the world (36 steps: 18 blocks high, inside the
 * loaded columns), the player at its foot (`atTop`: on the staircase high up). lag 0: the
 * client-driven player of the lagged client harness, which sees what the server sees; null: a
 * server-driven player (the reference).
 */
export function worldStairs(kind: StairKind, atTop = false, lag: number | null = 0, steps = 36): Run {
  const s = START[kind];
  const at = atTop ? vec3(s.top.x, LAND_TOP + s.top.dy, s.top.z) : vec3(s.x, LAND_TOP, s.z);
  const run = landRun('survival', at, lag);
  buildStairs(run.sim.world, kind, 10, 2 * LAND_TOP, s.hz0, steps, B.STONE, 16);
  if (atTop) {
    run.sim.soloPlayer.teleport(at.x, at.y, at.z);
    for (let t = 0; t < 10; t++) run.sim.tick();
  }
  return run;
}

/**
 * A sea run with a raft (planks deck at SEA_TOP - 1, x -3..14, z -3..14) carrying a staircase of
 * `kind` (planks, 12 steps: six blocks high), assembled at its helm; the client-driven player on
 * the deck at the stairs' foot.
 */
export function shipStairs(kind: StairKind, atTop = false, steps = 12): { run: Run; ship: Ship } {
  const s = START[kind];
  const at = atTop ? s.shipTop : { x: s.x, z: s.z, dy: 0 };
  const run = seaRun('creative', vec3(s.x, SEA_TOP, s.z), 0);
  const sim = run.sim;
  fill(sim.world, -3, SEA_TOP - 1, -3, 14, SEA_TOP - 1, 14, B.PLANKS_OAK);
  buildStairs(sim.world, kind, 10, 2 * SEA_TOP, s.hz0, steps, B.PLANKS_OAK, 8);
  sim.world.setCell(-2, SEA_TOP, 12, makeCell(B.HELM, facingState(NZ)));
  const ship = assemble(sim, vec3(-2, SEA_TOP, 12));
  for (let t = 0; t < 60; t++) sim.tick(); // let it settle on the water
  const w = ship.grid.toWorld(vec3(at.x, SEA_TOP + at.dy, at.z));
  sim.soloPlayer.teleport(w.x, w.y + 0.02, w.z);
  for (let t = 0; t < 20; t++) sim.tick();
  return { run, ship };
}
