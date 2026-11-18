/**
 * The server's judgements of client-driven players under lag, in isolation (src/entities/drive.ts,
 * entities/manager.ts): the client harness (client.ts) moves the player against copies of the
 * structures that lag the server's by exactly 0, 3 and 6 ticks (0, 150 and 300 ms), and the server
 * checks its reports: the squeeze hysteresis (real squeezes, short pinches), vitals kept on the
 * server tick for tick, the epochs (stale reports ignored), cheating reports. Each scene also runs
 * with a server-driven player (the reference) where the outcome must match. The scenes of moving
 * about (land, decks, turntables, piers, falls, pushes, steering) run end to end with the real
 * client, clock and links: tests/net/e2e-own-*.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { NX, PZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { CRUSH_DAMAGE, DROWN_DAMAGE, LAVA_DAMAGE, PLAYER_MAX_HEALTH, SQUEEZE_TICKS } from '../../src/entities/constants';
import { hardDepth } from '../../src/entities/drive';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import {
  B,
  JITTER,
  LAGS,
  LAND_TOP,
  SEA_FLOOR,
  SEA_TOP,
  assemble,
  buildPaddle,
  buildRaft,
  copy,
  corrections,
  dist,
  driveStats,
  fill,
  hdist,
  hurts,
  landRun,
  makeCell,
  facingState,
  seaRun,
  startRotor,
  type Run,
  type Uplink,
} from './scenes';

const ALL: ReadonlyArray<number | null> = [null, ...LAGS];
const name = (lag: number | null): string => (lag === null ? 'server-driven' : `client-driven, lag ${lag}`);

// ====================================================================== a ship ramming a player against a wall

interface PushRun {
  run: Run;
  maxAway: number;
  minHealth: number;
  causes: string[];
}

/**
 * A ship rams a player standing on a pier: raft (deck x 0..4, z 0..6) with a mast and a bowsprit
 * reaching two blocks past the bow at the height of the player's chest, sailing north at 6
 * blocks/s into a rubble pier (top face SEA_TOP, z <= -6). The player stands on the pier just
 * past its edge in the bowsprit's path; the hull stops against the pier, the bowsprit sweeps over
 * the pier through the player. With `wall`, a stone wall stands on the pier right behind the
 * player: then the player is caught between the bowsprit and the wall (squeezed for real).
 */
function ramRun(lag: number | null, wall: boolean, mode: 'survival' | 'creative' = 'survival', speed = 6): PushRun & { crushTicks: number[]; after: Vec3; inWall: boolean } {
  const run = seaRun(mode, vec3(2.5, SEA_TOP, -5.7), lag);
  const { sim } = run;
  fill(sim.world, -2, SEA_FLOOR, -16, 8, SEA_TOP - 1, -6, B.COBBLE);
  if (wall) fill(sim.world, -2, SEA_TOP, -7, 8, SEA_TOP + 2, -7, B.STONE);
  const ship = assemble(
    sim,
    buildRaft(sim, {
      x0: 0,
      z0: 0,
      x1: 4,
      z1: 6,
      y: SEA_TOP - 1,
      helm: { x: 2, z: 5 },
      extra: [
        [2, SEA_TOP, 1],
        [2, SEA_TOP + 1, 1],
        [2, SEA_TOP + 1, 0],
        [2, SEA_TOP + 1, -1],
        [2, SEA_TOP + 1, -2],
      ],
    }),
  );
  sim.advance(30);
  const p = sim.soloPlayer.player;
  p.input.yaw = Math.PI; // facing the ship
  sim.advance(5);
  const causes0 = corrections(run).length;
  const start = copy(p.pos);
  ship.throttle = 1;
  ship.grid.linearVelocity.z = -speed;
  const out = { run, maxAway: 0, minHealth: p.health, causes: [] as string[], crushTicks: run.crushes, after: copy(p.pos), inWall: false };
  for (let t = 0; t < 120; t++) {
    sim.tick();
    out.maxAway = Math.max(out.maxAway, hdist(p.pos, start));
    out.minHealth = Math.min(out.minHealth, p.health);
    if (wall && run.crushes.length > 0 && sim.ticks > run.crushes[0]! + 20) break;
  }
  out.after = copy(p.pos);
  out.inWall = run.sim.world.getCell(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.5), Math.floor(p.pos.z)) !== 0;
  out.causes = corrections(run).slice(causes0);
  return out;
}

// ====================================================================== really squeezed

interface CageRun {
  run: Run;
  crushedAt: number;
  /** Tick of the first squeeze candidate (client-driven), -1 = none. */
  firstCandidateAt: number;
  hurt: number;
  before: Vec3;
  after: Vec3;
  inWorld: boolean;
  inBlade: boolean;
  causes: string[];
  acceptedAfter: number;
}

/**
 * The player stands at (0.5, T, 3.5) and starts the land paddle; a 1x1 stone cage is closed
 * around it (four walls, a roof). The blade sweeps through the cage. Runs until the first
 * squeeze, then 30 more ticks.
 */
function cageRun(lag: number | null, mode: 'survival' | 'creative', releaseAfter = 0): CageRun {
  const T = LAND_TOP;
  const run = landRun(mode, vec3(0.5, T, 3.5), lag);
  const { sim } = run;
  const canvas: Array<[number, number, number]> = [
    [0, T + 1, 0],
    [0, T, 0],
  ];
  for (let x = 1; x <= 6; x++) canvas.push([x, T, 0], [x, T + 1, 0]);
  buildPaddle(sim, [0, T + 2, 0], canvas);
  sim.advance(2);
  const rotor = startRotor(sim, 0, T + 2, 0, PZ);
  for (const [x, z] of [
    [-1, 3],
    [1, 3],
    [0, 2],
    [0, 4],
  ] as const) {
    fill(sim.world, x, T, z, x, T + 1, z, B.STONE);
  }
  fill(sim.world, -1, T + 2, 2, 1, T + 2, 4, B.STONE);
  const causes0 = corrections(run).length;
  const p = sim.soloPlayer.player;
  let before = copy(p.pos);
  let firstCandidateAt = -1;
  let released = false;
  for (let i = 0; i < 300 && run.crushes.length === 0; i++) {
    before = copy(p.pos);
    sim.tick();
    const d = p.remote;
    if (d === null) continue;
    if (firstCandidateAt < 0 && d.squeezeCandidateTicks > 0) firstCandidateAt = sim.ticks;
    // A pinch that lets go: the cage breaks after `releaseAfter` candidate ticks in a row.
    if (releaseAfter > 0 && !released && d.squeezeTicks >= releaseAfter) {
      fill(sim.world, -1, T, 2, 1, T + 2, 4, 0);
      released = true;
    }
  }
  const out: CageRun = {
    run,
    crushedAt: run.crushes[0] ?? -1,
    firstCandidateAt,
    hurt: PLAYER_MAX_HEALTH - p.health,
    before,
    after: copy(p.pos),
    inWorld: boxIn(sim.world, p),
    inBlade: boxIn(rotor.grid, p),
    causes: [],
    acceptedAfter: 0,
  };
  const acc = driveStats(run).accepted;
  sim.advance(30);
  out.acceptedAfter = driveStats(run).accepted - acc;
  out.causes = corrections(run).slice(causes0);
  return out;
}

function boxIn(grid: import('../../src/voxel/grid').VoxelGrid, p: { box(): import('../../src/core/math').AABB }): boolean {
  return boxOverlapsSolid(grid, p.box());
}

/**
 * A rider on a raft (deck x 0..4, z 0..8, helm at the stern, z 7) that sails north at `speed`
 * under a stone beam at chest height (y SEA_TOP + 1, z -12, on two pillars): the beam scrapes the
 * rider back along the deck until the helm pins it against the beam, and the ship stops when its
 * helm hits the beam. Squeezed for real: between its own carrier and the world.
 */
function bridgeRun(lag: number | null, speed: number, mode: 'survival' | 'creative' = 'survival', uplink: Uplink = null) {
  const run = seaRun(mode, vec3(2.5, SEA_TOP + 0.5, 4.5), lag, 7001, uplink);
  const { sim } = run;
  fill(sim.world, -3, SEA_TOP + 1, -12, 8, SEA_TOP + 1, -12, B.STONE);
  fill(sim.world, -3, SEA_FLOOR, -12, -3, SEA_TOP + 1, -12, B.STONE);
  fill(sim.world, 8, SEA_FLOOR, -12, 8, SEA_TOP + 1, -12, B.STONE);
  const ship = assemble(sim, buildRaft(sim, { x0: 0, z0: 0, x1: 4, z1: 8, y: SEA_TOP - 1, helm: { x: 2, z: 7 } }));
  sim.advance(40);
  const causes0 = corrections(run).length;
  const p = sim.soloPlayer.player;
  ship.throttle = 1;
  ship.grid.linearVelocity.z = -speed;
  for (let t = 0; t < 200; t++) {
    if (t < 60) ship.grid.linearVelocity.z = Math.min(ship.grid.linearVelocity.z, -speed);
    sim.tick();
  }
  return {
    run,
    /** Damage taken (events: health regenerates within the run). */
    hurt: hurts(run).reduce((a, h) => a + h.amount, 0),
    causes: corrections(run).slice(causes0),
    /** Penetration into the world / the ship at the end (standing on the ship touches it). */
    inWorld: hardDepth(sim.world, p.box()),
    inShip: hardDepth(ship.grid, p.box()),
  };
}

describe('really squeezed: caged between a rotor blade and stone, or between a ramming hull and a wall', () => {
  const cages = new Map(ALL.flatMap((lag) => (['survival', 'creative'] as const).map((m) => [`${lag}:${m}`, cageRun(lag, m)] as const)));
  const walls = new Map(ALL.map((lag) => [lag, ramRun(lag, true)]));
  const wallsCreative = new Map(ALL.map((lag) => [lag, ramRun(lag, true, 'creative')]));
  it('the reference: squeezed by the blade at once, hurt (survival) and moved out of the cage', () => {
    const r = cages.get('null:survival')!;
    expect(r.crushedAt).toBeGreaterThan(0);
    expect(r.hurt).toBe(CRUSH_DAMAGE);
    expect(cages.get('null:creative')!.hurt).toBe(0);
  });
  for (const lag of LAGS) {
    it(`${name(lag)}: blade cage — squeezed after the hysteresis, survival hurt once, moved out with a correction; creative only moved`, () => {
      const ref = cages.get('null:survival')!;
      for (const mode of ['survival', 'creative'] as const) {
        const r = cages.get(`${lag}:${mode}`)!;
        expect(r.crushedAt, mode).toBeGreaterThan(0);
        // Judged within a few ticks of the server-driven squeeze (the hysteresis; the server sees the blade `lag` ticks before the client).
        expect(Math.abs(r.crushedAt - ref.crushedAt), mode).toBeLessThanOrEqual(6);
        expect(r.hurt, mode).toBe(mode === 'survival' ? CRUSH_DAMAGE : 0);
        expect(hurts(r.run).map((h) => h.cause), mode).toEqual(mode === 'survival' ? ['crush'] : []);
        expect(dist(r.after, r.before), mode).toBeGreaterThan(0.5);
        expect(r.inWorld, mode).toBe(false);
        expect(r.inBlade, mode).toBe(false);
        expect(r.causes, mode).toContain('crush');
        expect(r.causes.filter((c) => c.startsWith('check:')), mode).toEqual([]);
        // The client took the correction and reports again.
        expect(r.acceptedAfter, mode).toBeGreaterThan(20);
      }
    });
    it(`${name(lag)}: blade cage — the squeeze is judged SQUEEZE_TICKS candidate ticks after the first`, () => {
      for (const mode of ['survival', 'creative'] as const) {
        const r = cages.get(`${lag}:${mode}`)!;
        expect(r.firstCandidateAt, mode).toBeGreaterThan(0);
        expect(r.crushedAt - r.firstCandidateAt, mode).toBe(SQUEEZE_TICKS - 1);
      }
    });
    it(`${name(lag)}: blade cage that breaks after one or two candidate ticks — a short pinch, nobody hurt`, () => {
      for (const after of [1, 2]) {
        const r = cageRun(lag, 'survival', after);
        expect(r.firstCandidateAt, `after ${after}`).toBeGreaterThan(0);
        expect(r.run.crushes, `after ${after}`).toEqual([]);
        expect(hurts(r.run), `after ${after}`).toEqual([]);
        expect(r.causes.filter((c) => c.startsWith('check:')), `after ${after}`).toEqual([]);
      }
    });
    it(`${name(lag)}: bowsprit against a wall — squeezed, survival hurt, moved, with a correction; creative only moved`, () => {
      for (const r of [walls.get(lag)!, wallsCreative.get(lag)!]) {
        const survival = r === walls.get(lag);
        expect(r.run.crushes.length).toBeGreaterThan(0);
        expect(r.causes).toContain('crush');
        expect(r.inWall).toBe(false);
        expect(PLAYER_MAX_HEALTH - r.minHealth).toBe(survival ? CRUSH_DAMAGE * new Set(hurts(r.run).map((h) => h.cause)).size : 0);
        expect(hurts(r.run).every((h) => h.cause === 'crush')).toBe(true);
      }
    });
  }
  it('the reference: the bowsprit squeezes it against the wall too', () => {
    expect(walls.get(null)!.run.crushes.length).toBeGreaterThan(0);
  });
  // Pinned by its own carrier against the world: the client cannot get out (its copy pins it
  // just the same), its reports go deeper into the helm, and the server judges the squeeze.
  for (const speed of [3, 6]) {
    const bridges = new Map(ALL.map((lag) => [lag, bridgeRun(lag, speed)]));
    const ref = bridges.get(null)!;
    it(`bridge at ${speed} blocks/s, the reference: the helm pins the rider against the beam — squeezed`, () => {
      expect(ref.run.crushes.length).toBe(1);
      expect(ref.hurt).toBe(CRUSH_DAMAGE);
    });
    for (const lag of LAGS) {
      it(`bridge at ${speed} blocks/s, ${name(lag)}: squeezed after the hysteresis, hurt once, moved out with a correction`, () => {
        const r = bridges.get(lag)!;
        expect(r.run.crushes.length).toBe(1);
        expect(r.run.crushes[0]! - ref.run.crushes[0]!).toBeLessThanOrEqual(lag + SQUEEZE_TICKS + 2);
        expect(r.hurt).toBe(CRUSH_DAMAGE);
        expect(hurts(r.run).map((h) => h.cause)).toEqual(['crush']);
        expect(r.causes).toEqual(['crush']);
        expect(r.inWorld).toBeLessThan(0.05);
        expect(r.inShip).toBeLessThan(0.05);
      });
    }
  }
  it('bridge, client-driven, creative: only moved', () => {
    const r = bridgeRun(3, 3, 'creative');
    expect(r.run.crushes.length).toBe(1);
    expect(r.hurt).toBe(0);
    expect(r.causes).toEqual(['crush']);
  });
  it('bridge, client-driven, lag 2, reports bunched by a jittery uplink: squeezed all the same', () => {
    const r = bridgeRun(2, 3, 'survival', JITTER);
    expect(r.run.crushes.length).toBe(1);
    expect(r.hurt).toBe(CRUSH_DAMAGE);
    expect(r.causes).toEqual(['crush']);
  });
});

// ====================================================================== drowning and lava

interface VitalsRun {
  run: Run;
  health: number[];
  air: number[];
  diedAt: number;
  causes: string[];
}

function drownRun(lag: number | null): VitalsRun {
  const run = seaRun('survival', vec3(-3.5, SEA_TOP, 0.5), lag);
  const { sim } = run;
  fill(sim.world, -5, SEA_FLOOR, -1, -3, SEA_TOP - 1, 1, B.COBBLE);
  sim.advance(5);
  sim.soloPlayer.teleport(6.5, SEA_FLOOR, 6.5);
  return vitals(run, 520);
}

function lavaRun(lag: number | null): VitalsRun {
  const T = LAND_TOP;
  const run = landRun('survival', vec3(0.5, T, 0.5), lag);
  const { sim } = run;
  fill(sim.world, 4, T - 2, 4, 6, T - 1, 6, 0);
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) for (let y = T - 2; y <= T - 1; y++) sim.world.setCell(x, y, z, makeCell(B.LAVA));
  sim.advance(5);
  sim.soloPlayer.teleport(5.5, T - 2, 5.5);
  return vitals(run, 80);
}

function vitals(run: Run, ticks: number): VitalsRun {
  const { sim } = run;
  const p = sim.soloPlayer.player;
  const causes0 = corrections(run).length;
  const out: VitalsRun = { run, health: [], air: [], diedAt: -1, causes: [] };
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    out.health.push(p.health);
    out.air.push(p.air);
    if (p.dead && out.diedAt < 0) out.diedAt = t;
  }
  out.causes = corrections(run).slice(causes0);
  return out;
}

describe('drowning and lava', () => {
  const drown = new Map(ALL.map((lag) => [lag, drownRun(lag)]));
  const lava = new Map(ALL.map((lag) => [lag, lavaRun(lag)]));
  it('the reference drowns (air runs out, then 2 points a second) and burns in lava (4 points every half second) to death', () => {
    const d = drown.get(null)!;
    expect(Math.min(...d.air)).toBe(0);
    expect(hurts(d.run).every((h) => h.cause === 'drown' && h.amount === DROWN_DAMAGE)).toBe(true);
    expect(d.diedAt).toBeGreaterThan(300);
    const l = lava.get(null)!;
    expect(hurts(l.run).every((h) => h.cause === 'lava' && h.amount === LAVA_DAMAGE)).toBe(true);
    expect(l.diedAt).toBeGreaterThan(0);
  });
  for (const lag of LAGS) {
    it(`${name(lag)}: air, drowning and lava damage tick for tick as for the server-driven player (vitals stay on the server)`, () => {
      for (const [r, ref] of [
        [drown.get(lag)!, drown.get(null)!],
        [lava.get(lag)!, lava.get(null)!],
      ] as const) {
        // The server holds the teleported player where it put it until the client reports from
        // there, and samples the fluids where the player is: the same vitals, tick for tick.
        expect(r.health).toEqual(ref.health);
        expect(r.air).toEqual(ref.air);
        expect(r.diedAt).toBe(ref.diedAt);
        expect(r.causes).toEqual(['teleport', 'death']);
        expect(driveStats(r.run).rejected).toBe(0);
      }
    });
  }
});

// ====================================================================== epochs

interface EpochRun {
  run: Run;
  /** Server feet each tick of the window after the event. */
  held: Vec3[];
  droppedInWindow: number;
  acceptedAfter: number;
  causes: string[];
  expected: Vec3 | null;
}

/** Walk on land; at tick 20 `event` happens (between ticks); measure the next lag + 1 ticks, then 20 more. */
function epochRun(lag: number, event: (run: Run) => Vec3 | null): EpochRun {
  const run = landRun('survival', vec3(0.5, LAND_TOP, 0.5), lag);
  const { sim } = run;
  sim.advance(5);
  const p = sim.soloPlayer.player;
  p.input.forward = 1;
  p.input.yaw = 0.7;
  sim.advance(20);
  const causes0 = corrections(run).length;
  const d0 = driveStats(run);
  const expected = event(run);
  const held: Vec3[] = [];
  for (let t = 0; t <= lag; t++) {
    sim.tick();
    held.push(copy(p.pos));
  }
  const d1 = driveStats(run);
  sim.advance(20);
  return {
    run,
    held,
    droppedInWindow: d1.dropped - d0.dropped,
    acceptedAfter: driveStats(run).accepted - d1.accepted,
    causes: corrections(run).slice(causes0),
    expected,
  };
}

describe('epochs: stale reports are ignored, the next valid one is accepted', () => {
  for (const lag of LAGS) {
    it(`${name(lag)}: teleport`, () => {
      const r = epochRun(lag, (run) => {
        run.sim.soloPlayer.teleport(10.5, LAND_TOP, -6.5);
        return vec3(10.5, LAND_TOP, -6.5);
      });
      expect(r.causes).toEqual(['teleport']);
      // While the client still walks with the old epoch, nothing it reports moves the player.
      expect(r.droppedInWindow).toBe(lag + 1);
      for (const q of r.held) expect(dist(q, r.expected!)).toBe(0);
      // Then it walks on from the teleport spot.
      expect(r.acceptedAfter).toBe(20);
      const p = r.run.sim.soloPlayer.player;
      expect(hdist(p.pos, r.expected!)).toBeGreaterThan(2);
      expect(hdist(p.pos, r.expected!)).toBeLessThan(6);
      expect(driveStats(r.run).rejected).toBe(0);
    });
    it(`${name(lag)}: death and respawn`, () => {
      const run = landRun('survival', vec3(0.5, LAND_TOP, 0.5), lag);
      const { sim } = run;
      sim.advance(5);
      const p = sim.soloPlayer.player;
      p.input.forward = 1;
      sim.advance(20);
      const causes0 = corrections(run).length;
      sim.entities.damage(p, 1000, 'test');
      expect(p.dead).toBe(true);
      const body = copy(p.pos);
      const d0 = driveStats(run);
      sim.advance(10);
      // Dead: nothing the client reports moves the body.
      expect(dist(p.pos, body)).toBe(0);
      expect(driveStats(run).accepted).toBe(d0.accepted);
      sim.soloPlayer.respawn();
      const spawn = vec3(0.5, LAND_TOP, 0.5);
      expect(dist(p.pos, spawn)).toBe(0);
      const d1 = driveStats(run);
      for (let t = 0; t <= lag; t++) {
        sim.tick();
        expect(dist(p.pos, spawn)).toBe(0);
      }
      expect(driveStats(run).accepted).toBe(d1.accepted);
      sim.advance(20);
      expect(driveStats(run).accepted - d1.accepted).toBe(20);
      expect(hdist(p.pos, spawn)).toBeGreaterThan(2);
      expect(corrections(run).slice(causes0)).toEqual(['death', 'respawn']);
      expect(driveStats(run).rejected).toBe(0);
    });
    it(`${name(lag)}: the turntable under the rider blockifies`, () => {
      const T = LAND_TOP;
      const run = landRun('survival', vec3(-3.5, T, 0.5), lag);
      const { sim } = run;
      sim.world.setCell(0, T, 0, makeCell(B.BEARING, facingState(2)));
      fill(sim.world, 0, T + 1, -2, 4, T + 1, 2, B.WOOL_WHITE);
      sim.advance(2);
      const rotor = startRotor(sim, 0, T, 0, NX);
      sim.advance(40);
      const w = rotor.grid.toWorld(vec3(2.5, T + 2, 0.5));
      sim.soloPlayer.teleport(w.x, w.y, w.z);
      sim.advance(20);
      const p = sim.soloPlayer.player;
      expect(p.carrierId).toBe(rotor.id);
      const causes0 = corrections(run).length;
      const d0 = driveStats(run);
      sim.structures.stopRotor(rotor);
      expect(p.carrierId).toBe(0);
      const at = copy(p.pos);
      for (let t = 0; t <= lag; t++) {
        sim.tick();
        // Reports that still claim the vanished turntable are stale: the player stays put.
        expect(dist(p.pos, at)).toBe(0);
        expect(p.carrierId).toBe(0);
      }
      expect(driveStats(run).dropped - d0.dropped).toBe(lag + 1);
      const d1 = driveStats(run);
      sim.advance(20);
      expect(driveStats(run).accepted - d1.accepted).toBe(20);
      expect(p.carrierId).toBe(0);
      expect(p.onWorldGround).toBe(true);
      expect(corrections(run).slice(causes0)).toEqual(['release']);
      expect(hurts(run)).toEqual([]);
      expect(driveStats(run).rejected).toBe(0);
    });
    it(`${name(lag)}: seated at the helm and released`, () => {
      const run = seaRun('survival', vec3(3.5, SEA_TOP + 0.5, 4.5), lag);
      const { sim } = run;
      const helm = buildRaft(sim, { x0: 0, z0: 0, x1: 6, z1: 6, y: SEA_TOP - 1, gunwale: true, helm: { x: 3, z: 2 } });
      sim.advance(3);
      const c = sim.soloPlayer;
      const causes0 = corrections(run).length;
      expect(c.useOn(helm.x, helm.y, helm.z, PZ)).toBe(true);
      const d0 = driveStats(run);
      expect(c.useOn(helm.x, helm.y, helm.z, PZ)).toBe(true);
      expect(c.player.steeringShipId).not.toBe(0);
      const ship = sim.structures.ships()[0]!;
      sim.advance(lag + 1);
      // The reports sent before the client knew it was seated were dropped ...
      expect(driveStats(run).dropped - d0.dropped).toBe(lag + 1);
      const d1 = driveStats(run);
      // ... and the seated ones are taken (for the stick and the look).
      c.player.input.forward = 1;
      sim.advance(20);
      expect(driveStats(run).accepted - d1.accepted).toBe(20);
      expect(ship.throttle).toBe(1);
      c.player.input.forward = 0;
      const d2 = driveStats(run);
      c.use();
      sim.tick();
      expect(c.player.steeringShipId).toBe(0);
      expect(ship.throttle).toBe(0);
      sim.advance(lag);
      expect(driveStats(run).dropped - d2.dropped).toBe(lag + 1);
      const d3 = driveStats(run);
      sim.advance(20);
      expect(driveStats(run).accepted - d3.accepted).toBe(20);
      expect(c.player.carrierId).toBe(ship.id);
      expect(corrections(run).slice(causes0)).toEqual(['seat', 'unseat:stopped']);
      expect(driveStats(run).rejected).toBe(0);
      expect(hurts(run)).toEqual([]);
    });
  }
});

// ====================================================================== cheating reports

type Cheat = 'speed' | 'wall' | 'carrier' | 'flying';

interface CheatRun {
  run: Run;
  before: Vec3;
  window: Vec3[];
  causes: string[];
  acceptedAfter: number;
  rejected: number;
}

/**
 * The player walks east on land toward a stone wall (cells x = 4); a turntable spins 20 blocks
 * away. At one tick the client sends a doctored report: 5 blocks further than it walked ('speed'),
 * 0.4 into the wall it stands against ('wall'), on the far turntable ('carrier'), flying in
 * survival ('flying').
 */
function cheatRun(lag: number, cheat: Cheat): CheatRun {
  const T = LAND_TOP;
  const run = landRun('survival', vec3(0.5, T, 0.5), lag);
  const { sim } = run;
  fill(sim.world, 4, T, -3, 4, T + 2, 3, B.STONE);
  sim.world.setCell(20, T, 0, makeCell(B.BEARING, facingState(2)));
  fill(sim.world, 20, T + 1, -2, 24, T + 1, 2, B.WOOL_WHITE);
  sim.advance(2);
  const rotor = sim.structures.startRotor(sim.world, 20, T, 0);
  if (!rotor.ok) throw new Error(rotor.reason);
  const p = sim.soloPlayer.player;
  p.input.yaw = -Math.PI / 2; // east
  p.input.forward = 1;
  sim.advance(40); // at the wall
  const client = run.client!;
  const causes0 = corrections(run).length;
  const before = copy(p.pos);
  client.tamper = (rep) => {
    client.tamper = null;
    if (cheat === 'speed') rep.pos.x -= 5;
    else if (cheat === 'wall') rep.pos.x += 0.4;
    else if (cheat === 'flying') rep.flying = true;
    else {
      rep.carrierId = rotor.structure.id;
      rotor.structure.grid.toLocal(rep.pos, rep.pos);
    }
  };
  const window: Vec3[] = [];
  for (let t = 0; t <= lag + 1; t++) {
    sim.tick();
    window.push(copy(p.pos));
  }
  const acc = driveStats(run).accepted;
  p.input.forward = 0;
  sim.advance(20);
  return { run, before, window, causes: corrections(run).slice(causes0), acceptedAfter: driveStats(run).accepted - acc, rejected: driveStats(run).rejected };
}

describe('cheating reports: too fast, into a wall, on a carrier far away, flying in survival', () => {
  for (const lag of LAGS) {
    for (const cheat of ['speed', 'wall', 'carrier', 'flying'] as const) {
      it(`${name(lag)}, ${cheat}: a correction, and the report has no effect`, () => {
        const r = cheatRun(lag, cheat);
        expect(r.rejected).toBe(1);
        expect(r.causes).toEqual([`check:${cheat === 'wall' ? 'world' : cheat}`]);
        // The player stays where the last good report put it until the client adopts the correction.
        for (const q of r.window.slice(0, lag + 1)) expect(dist(q, r.before)).toBe(0);
        // Then its reports are accepted again.
        expect(r.acceptedAfter).toBe(20);
        expect(hurts(r.run)).toEqual([]);
      });
    }
  }
});
