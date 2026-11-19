/**
 * The scenes of package 2's lag tests (tests/drive), rebuilt end to end (package 6): a real
 * HeadlessClient with its OwnPlayer, its ServerClock and a lossy link against a real ServerHost.
 * Every scene returns what the tests judge (tests/net/e2e-own-*.test.ts): the corrections its
 * client applied after the scene began (`causes`), the damage the player took, the reports the
 * server refused, and the scene's own measurements.
 */
import { CRUSH_DAMAGE, PLAYER_EYE_HEIGHT } from '../../src/entities/constants';
import { headingOf } from '../../src/entities/structs';
import { B } from '../../src/blocks/defs';
import { facingState, makeCell } from '../../src/blocks/cell';
import { NY } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import { clickOn, fill } from './e2e-scenes';
import type { ClientLink } from './harness';
import {
  assemble,
  buildRaft,
  copy,
  dist,
  hdist,
  LAND,
  LAND_TOP,
  landPaddle,
  landTurntable,
  OWN_SEA,
  OWN_SEA_TOP,
  ownWorld,
  SEA_FLOOR,
  startRotor,
  type OwnRun,
} from './own-scenes';

const T = LAND_TOP;
/** The land's first air cell (the table's checks). */
export const LAND_TOP_FOR_TESTS = LAND_TOP;
const S = OWN_SEA_TOP;
/** Sea scenes are moved this far east, clear of the spawn pillar at x = 0. */
const OX = 10;

export interface SceneResult {
  causes: string[];
  damage: number;
  hurts: string[];
  rejected: number;
  /** Scene-specific measurements. */
  m: Record<string, number | boolean>;
}

function result(r: OwnRun, m: Record<string, number | boolean>): SceneResult {
  return { causes: r.causes(), damage: r.damage(), hurts: r.hurts.map((x) => x.cause), rejected: r.rejected(), m };
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** The server has the player exactly where its client's last accepted report put it (carrier frame), over the run. */
function watchReports(r: OwnRun): { worst: number; checks: number } {
  const sent = new Map<number, Vec3>();
  const prev = r.c.onReport;
  r.c.onReport = (rep, own) => {
    prev?.(rep, own);
    sent.set(rep.seq, copy(rep.pos));
  };
  const out = { worst: 0, checks: 0 };
  r.onTick(() => {
    const d = r.ctrl.player.remote!;
    const s = sent.get(d.lastSeq);
    if (s === undefined) return;
    out.checks++;
    out.worst = Math.max(out.worst, dist(s, d.pos));
  });
  return out;
}

// ====================================================================== land

/** Walk, sprint, jump and sneak on flat land (survival), 160 client ticks. */
export async function walk(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  const rep = watchReports(r);
  const start = copy(r.ctrl.player.pos);
  const yaw0 = r.c.input.yaw;
  r.mark((k) => {
    const i = r.c.input;
    if (k > 160) return r.idle();
    i.forward = 1;
    i.yaw = yaw0 + 0.02 * k;
    i.sprint = k >= 40 && k < 80;
    i.jump = k >= 80 && k < 120 && k % 12 < 2;
    i.sneak = k >= 120;
  });
  r.runSteps(170, 1000);
  const p = r.ctrl.player;
  return result(r, { moved: hdist(start, p.pos), reportWorst: rep.worst, reportChecks: rep.checks, health: p.health });
}

/** Creative: double-tap to fly, climb, cruise (sprinting), sink, double-tap to drop, land. */
export async function fly(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'creative', link);
  let flew = 0;
  let top = -Infinity;
  r.mark((k) => {
    const i = r.c.input;
    if (k === 1 || k === 3 || k === 150 || k === 152) i.jumpPresses++;
    i.jump = k >= 5 && k < 40;
    i.forward = k >= 40 && k < 120 ? 1 : 0;
    i.sprint = k >= 60 && k < 120;
    i.sneak = k >= 120 && k < 140;
    i.yaw = -0.01 * k;
  });
  r.onTick(() => {
    const p = r.ctrl.player;
    if (p.flying) flew++;
    top = Math.max(top, p.pos.y);
  });
  r.runSteps(220, 1500);
  const p = r.ctrl.player;
  return result(r, { flew, top, endY: p.pos.y, flying: p.flying });
}

/** Creative: fly, sprint-fly, and stop flying at full flight speed (the momentum carries on); land. */
export async function flyStop(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'creative', link);
  let fastest = 0;
  let last = copy(r.ctrl.player.pos);
  r.mark((k) => {
    const i = r.c.input;
    if (k === 1 || k === 3 || k === 60 || k === 62) i.jumpPresses++;
    i.jump = k >= 5 && k < 20;
    i.forward = k >= 20 && k < 80 ? 1 : 0;
    i.sprint = k >= 20 && k < 80;
    i.yaw = 0.3;
  });
  r.onTick(() => {
    const p = r.ctrl.player.pos;
    fastest = Math.max(fastest, hdist(last, p) / 0.05);
    last = copy(p);
  });
  r.runSteps(150, 1500);
  const p = r.ctrl.player;
  return result(r, { fastest, endY: p.pos.y, flying: p.flying });
}

/**
 * A 5x5 felt platform on a bearing facing up (6, T, 0), spinning: the player boards it (teleport) two
 * blocks from the axis, stands 100 client ticks, then walks a little.
 */
export async function turntable(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link, (sim) => landTurntable(sim, T, 6));
  const rotor = startRotor(r.sim, 6, T, 0);
  r.h.run(3000); // spin up
  const w = rotor.grid.toWorld(vec3(8.5, T + 2, 0.5));
  r.teleport(w.x, w.y, w.z, 2000);
  const rep = watchReports(r);
  const p = r.ctrl.player;
  const l0 = rotor.grid.toLocal(p.pos);
  let slip = 0;
  let carried = true;
  let turned = 0;
  let ryaw = headingOf(rotor.grid.rotation);
  let lookTurn = 0;
  let lookFollow = 0;
  let walked = 0;
  let lastYaw = r.c.input.yaw;
  r.mark((k) => {
    // Toward the axis (where it stands on the platform depends on when its client took the
    // boarding teleport), then on with the platform turning under it.
    if (k === 100) r.c.lookAt(6.5, T + 2 + PLAYER_EYE_HEIGHT, 0.5);
    r.c.input.pitch = 0;
    r.c.input.forward = k >= 100 && k < 125 ? 0.3 : 0;
  });
  r.c.onFrame = () => {
    lookTurn += wrap(r.c.input.yaw - lastYaw);
    lastYaw = r.c.input.yaw;
  };
  r.onTick(() => {
    const l = rotor.grid.toLocal(p.pos);
    if (r.steps < 100) slip = Math.max(slip, hdist(l, l0));
    else walked = Math.max(walked, hdist(l, l0));
    if (p.carrierId !== rotor.id) carried = false;
    const y = headingOf(rotor.grid.rotation);
    turned += wrap(y - ryaw);
    ryaw = y;
    if (r.steps === 99) lookFollow = Math.abs(wrap(lookTurn - turned));
  });
  r.runSteps(160, 500);
  return result(r, { turned, slip, carried, walked, lookFollow, reportWorst: rep.worst });
}

/** A land paddle sweeps round; the player stands free 3.5 blocks from its axis: pushed, not hurt. */
export async function blade(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  r.teleport(0.5, T, 3.5);
  landPaddle(r.sim);
  r.h.run(100);
  startRotor(r.sim, 0, T + 2, 0);
  const p = r.ctrl.player;
  const start = copy(p.pos);
  let away = 0;
  r.mark();
  r.onTick(() => (away = Math.max(away, hdist(p.pos, start))));
  r.runSteps(200);
  return result(r, { away, candidates: p.remote!.squeezeCandidateTicks, deepRun: p.remote!.longestDeepRun });
}

/** The paddle sweeps through a 1x1 stone cage around the player: squeezed for real, hurt once, moved out. */
export async function cage(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  r.teleport(0.5, T, 3.5);
  landPaddle(r.sim);
  for (const [x, z] of [
    [-1, 3],
    [1, 3],
    [0, 2],
    [0, 4],
  ] as const) {
    fill(r.sim, x, T, z, x, T + 1, z, B.STONE);
  }
  fill(r.sim, -1, T + 2, 2, 1, T + 2, 4, B.STONE);
  r.h.run(300);
  const rotor = startRotor(r.sim, 0, T + 2, 0);
  r.mark();
  r.h.runUntil(() => r.causes().includes('crush') || r.steps > 400, 60_000, 1);
  r.runSteps(r.steps + 40);
  const p = r.ctrl.player;
  const d = p.remote!;
  return result(r, {
    crushed: r.causes().includes('crush'),
    inWorld: boxOverlapsSolid(r.sim.world, p.box()),
    inBlade: boxOverlapsSolid(rotor.grid, p.box()),
    outOfCage: hdist(p.pos, vec3(0.5, T, 3.5)) > 0.5,
    acceptedAfter: d.accepted,
    expectedDamage: CRUSH_DAMAGE,
  });
}

/** A 3x3 lava pit, two deep: the player is put into it and burns to death. */
export async function lava(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) for (let y = T - 2; y <= T - 1; y++) r.sim.world.setCell(x, y, z, makeCell(B.LAVA));
  r.h.run(300);
  r.mark();
  r.teleport(5.5, T - 2, 5.5, 0);
  r.h.runUntil(() => r.ctrl.player.dead, 30_000, 5);
  r.h.runUntil(() => r.c.own!.player.dead, 30_000, 5); // the death reached the client
  r.h.run(500);
  return result(r, { dead: r.ctrl.player.dead });
}

/** Walking; the server teleports the player at client tick 20; it walks on from there. */
export async function teleportWalk(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  const p = r.ctrl.player;
  const to = vec3(10.5, T, -6.5);
  let done = false;
  r.mark((k) => {
    r.c.input.forward = k <= 80 ? 1 : 0;
    r.c.input.yaw = 0.7;
    if (k === 20 && !done) {
      done = true;
      r.ctrl.teleport(to.x, to.y, to.z);
    }
  });
  r.runSteps(100, 500);
  return result(r, { fromTeleport: hdist(p.pos, to) });
}

/** Walking; killed by the server, held dead, respawned; walks on from the spawn point. */
export async function deathRespawn(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link);
  const p = r.ctrl.player;
  r.c.input.forward = 1;
  r.h.run(500);
  r.mark();
  r.sim.entities.damage(p, 1000, 'test');
  const body = copy(p.pos);
  r.h.run(1000);
  const heldDead = dist(p.pos, body);
  r.c.respawn();
  r.c.waitAck();
  const spawn = copy(p.pos);
  r.h.run(1500);
  r.c.input.forward = 0;
  r.h.run(300);
  return result(r, { heldDead, fromSpawn: hdist(p.pos, spawn), dead: p.dead });
}

/** The spinning turntable under the rider stops: it stays on the blocks it stood on (the snap), released. */
export async function blockifyUnder(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(LAND, 'survival', link, (sim) => landTurntable(sim, T, 6));
  const rotor = startRotor(r.sim, 6, T, 0);
  r.h.run(2000);
  const w = rotor.grid.toWorld(vec3(8.5, T + 2, 0.5));
  r.teleport(w.x, w.y, w.z, 1500);
  const p = r.ctrl.player;
  const carriedBefore = p.carrierId === rotor.id;
  r.mark();
  r.sim.structures.stopRotor(rotor);
  const at = copy(p.pos);
  r.h.run(1500);
  return result(r, { carriedBefore, released: p.carrierId === 0, onWorld: p.onWorldGround, drift: dist(p.pos, at) });
}

// ====================================================================== sea

/** Raft 7x7 with gunwale (helm near the bow) at OX: sails straight 100 client ticks, then turns; the player stands 150, then walks a square. */
export async function deck(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  const helm = buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 6, z1: 6, y: S - 1, gunwale: true, helm: { x: OX + 3, z: 2 } });
  const ship = assemble(r.sim, helm);
  r.h.run(1000);
  r.teleport(OX + 3.5, S, 4.5, 1500);
  const rep = watchReports(r);
  const p = r.ctrl.player;
  const l0 = ship.grid.toLocal(p.pos);
  const start = copy(ship.grid.position);
  let slip = 0;
  let maxDy = 0;
  let carried = true;
  let turned = 0;
  let yaw0 = headingOf(ship.grid.rotation);
  let walked = 0;
  ship.throttle = 1;
  r.mark((k) => {
    if (k === 100) ship.rudder = 0.6;
    if (k >= 150) {
      r.c.input.forward = 0.5;
      if ((k - 150) % 25 === 0) r.c.input.yaw += Math.PI / 2;
    }
  });
  r.onTick(() => {
    const l = ship.grid.toLocal(p.pos);
    if (r.steps < 150) slip = Math.max(slip, hdist(l, l0));
    else walked = Math.max(walked, hdist(l, l0));
    maxDy = Math.max(maxDy, Math.abs(l.y - l0.y));
    if (p.carrierId !== ship.id) carried = false;
    const y = headingOf(ship.grid.rotation);
    turned += wrap(y - yaw0);
    yaw0 = y;
  });
  r.runSteps(300);
  return result(r, { sailed: hdist(ship.grid.position, start), turned, slip, maxDy, carried, walked, reportWorst: rep.worst, reportChecks: rep.checks });
}

/** Raft B (5x9, no gunwale) passes a pier one block of water away: the player jumps aboard, rides, jumps back. */
export async function pierJump(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  fill(r.sim, OX - 5, SEA_FLOOR, -40, OX - 2, S - 1, 14, B.COBBLE);
  const ship = assemble(r.sim, buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 4, z1: 8, y: S - 1, helm: { x: OX + 2, z: 1 } }));
  r.h.run(2000);
  r.teleport(OX - 2.6, S, 6.5, 1000);
  const p = r.ctrl.player;
  let boarded = -1;
  let back = -1;
  ship.throttle = 1;
  r.mark((k) => {
    const i = r.c.input;
    if (k >= 20 && k < 32) {
      i.yaw = -Math.PI / 2;
      i.forward = 1;
      i.sprint = true;
      i.jump = k < 23;
    } else if (k >= 80 && k < 92) {
      i.yaw = Math.PI / 2;
      i.forward = 1;
      i.sprint = true;
      i.jump = k < 83;
    } else r.c.stopInput();
  });
  r.onTick(() => {
    if (boarded < 0 && p.carrierId === ship.id && p.onGround) boarded = r.steps;
    if (boarded >= 0 && back < 0 && p.carrierId === 0 && p.onWorldGround) back = r.steps;
  });
  r.runSteps(150);
  return result(r, { boarded, back });
}

/** Falls from height: onto land (10.25 blocks), into water, onto a moving deck (about 8.25 blocks). */
export async function fall(kind: 'land' | 'water' | 'deck', link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(kind === 'land' ? LAND : OWN_SEA, 'survival', link);
  const p = r.ctrl.player;
  let shipId = 0;
  let to: Vec3;
  if (kind === 'land') to = vec3(0.5, T + 10.25, 0.5);
  else if (kind === 'water') to = vec3(OX + 6.5, S + 10.25, 6.5);
  else {
    const ship = assemble(r.sim, buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 4, z1: 8, y: S - 1, helm: { x: OX + 2, z: 1 } }));
    shipId = ship.id;
    r.h.run(2000);
    ship.throttle = 1;
    r.h.run(2000);
    const w = ship.grid.toWorld(vec3(OX + 2.5, S, 5.5));
    to = vec3(w.x, w.y + 8.25, w.z);
  }
  r.mark();
  r.teleport(to.x, to.y, to.z, 0);
  let airborne = false;
  let landedOn = -1;
  r.onTick(() => {
    if (!p.onGround) airborne = true;
    else if (airborne && landedOn < 0) landedOn = p.carrierId;
  });
  r.h.run(4000);
  return result(r, { onDeck: shipId !== 0 && landedOn === shipId });
}

/**
 * A ship rams a player standing on a pier: a raft with a bowsprit at chest height sails north at
 * `speed` into the pier; the hull stops against it, the bowsprit sweeps over the pier through the
 * player: pushed, not hurt.
 */
export async function ram(link: ClientLink, speed: number): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  fill(r.sim, OX - 2, SEA_FLOOR, -16, OX + 8, S - 1, -6, B.COBBLE);
  const x = OX + 2;
  const ship = assemble(
    r.sim,
    buildRaft(r.sim, {
      x0: OX,
      z0: 0,
      x1: OX + 4,
      z1: 6,
      y: S - 1,
      helm: { x, z: 5 },
      extra: [
        [x, S, 1],
        [x, S + 1, 1],
        [x, S + 1, 0],
        [x, S + 1, -1],
        [x, S + 1, -2],
      ],
    }),
  );
  r.h.run(1500);
  r.c.input.yaw = Math.PI; // facing the ship
  r.teleport(OX + 2.5, S, -5.7, 1000);
  const p = r.ctrl.player;
  const start = copy(p.pos);
  let away = 0;
  r.mark();
  ship.throttle = 1;
  ship.grid.linearVelocity.z = -speed;
  r.onTick(() => (away = Math.max(away, hdist(p.pos, start))));
  r.runSteps(120);
  return result(r, { away, candidates: p.remote!.squeezeCandidateTicks });
}

/** Put on the sea floor: air runs out, then 2 points a second, to death. */
export async function drown(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  r.mark();
  r.teleport(OX + 6.5, SEA_FLOOR, 6.5, 0);
  let minAir = Infinity;
  r.onTick(() => (minAir = Math.min(minAir, r.ctrl.player.air)));
  r.h.runUntil(() => r.ctrl.player.dead, 60_000, 10);
  r.h.runUntil(() => r.c.own!.player.dead, 30_000, 5); // the death reached the client
  r.h.run(500);
  return result(r, { dead: r.ctrl.player.dead, minAir });
}

/** Seated at the helm (scripted clicks on the server), the client's stick drives the ship; then the server lets go of the wheel. */
export async function steer(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  const helm = buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 6, z1: 6, y: S - 1, gunwale: true, helm: { x: OX + 3, z: 2 } });
  r.teleport(OX + 3.5, S, 4.5, 1000);
  r.mark();
  r.c.emptyHand();
  clickOn(r.c, helm.x, helm.y, helm.z);
  clickOn(r.c, helm.x, helm.y, helm.z);
  const p = r.ctrl.player;
  const ship = r.sim.structures.ships()[0]!;
  const seated = p.steeringShipId === ship.id;
  r.h.run(500);
  const start = copy(ship.grid.position);
  const yaw0 = headingOf(ship.grid.rotation);
  r.c.input.forward = 1;
  r.h.run(3000);
  r.c.input.strafe = 1;
  r.h.run(3000);
  const throttle = ship.throttle;
  const rudder = ship.rudder;
  r.c.input.forward = 0;
  r.c.input.strafe = 0;
  r.c.releaseHelm();
  r.h.run(1000);
  return result(r, { seated, throttle, rudder, sailed: hdist(ship.grid.position, start), turned: Math.abs(wrap(headingOf(ship.grid.rotation) - yaw0)), aboard: p.carrierId === ship.id });
}

/**
 * A rider on a raft (deck OX..OX+4 x 0..8, helm at the stern) that sails north at `speed` under a
 * stone beam at chest height: the beam scrapes the rider back along the deck until the helm pins it
 * against the beam. Squeezed for real, between its own carrier and the world.
 */
export async function bridge(link: ClientLink, speed = 3): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  fill(r.sim, OX - 3, S + 1, -12, OX + 8, S + 1, -12, B.STONE);
  fill(r.sim, OX - 3, SEA_FLOOR, -12, OX - 3, S + 1, -12, B.STONE);
  fill(r.sim, OX + 8, SEA_FLOOR, -12, OX + 8, S + 1, -12, B.STONE);
  const ship = assemble(r.sim, buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 4, z1: 8, y: S - 1, helm: { x: OX + 2, z: 7 } }));
  r.h.run(2000);
  r.teleport(OX + 2.5, S, 4.5, 1500);
  const p = r.ctrl.player;
  const carriedBefore = p.carrierId === ship.id;
  let t = 0;
  r.mark();
  ship.throttle = 1;
  ship.grid.linearVelocity.z = -speed;
  r.onTick(() => {
    if (t++ < 60) ship.grid.linearVelocity.z = Math.min(ship.grid.linearVelocity.z, -speed);
  });
  r.runSteps(200);
  return result(r, { carriedBefore, expectedDamage: CRUSH_DAMAGE, inWorld: boxOverlapsSolid(r.sim.world, p.box()), inShip: boxOverlapsSolid(ship.grid, p.box()) });
}

/** Seated at the helm of a raft that a world paddle sweeps over: the blade pushes the helmsman off the seat (a server decision). */
export async function pushedOff(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  const helm = buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 6, z1: 6, y: S - 1, helm: { x: OX + 3, z: 1 } });
  r.sim.world.setCell(OX + 3, S + 3, 4, makeCell(B.BEARING, facingState(NY)));
  for (let z = 4; z <= 6; z++) for (let y = S + 1; y <= S + 2; y++) r.sim.world.setCell(OX + 3, y, z, makeCell(B.CANVAS));
  r.teleport(OX + 3.5, S, 3.5, 1000);
  startRotor(r.sim, OX + 3, S + 3, 4);
  r.mark();
  r.c.emptyHand();
  clickOn(r.c, helm.x, helm.y, helm.z);
  clickOn(r.c, helm.x, helm.y, helm.z);
  const p = r.ctrl.player;
  const seated = p.steeringShipId !== 0;
  r.h.runUntil(() => p.steeringShipId === 0, 20_000, 5);
  r.h.run(1500);
  return result(r, { seated, released: p.steeringShipId === 0 });
}

/** On the deck of a sailing raft, the player jumps off the side into the sea, and swims. */
export async function deckToWater(link: ClientLink): Promise<SceneResult> {
  const r = await ownWorld(OWN_SEA, 'survival', link);
  const ship = assemble(r.sim, buildRaft(r.sim, { x0: OX, z0: 0, x1: OX + 4, z1: 8, y: S - 1, helm: { x: OX + 2, z: 1 } }));
  r.h.run(2000);
  r.teleport(OX + 2.5, S, 4.5, 1500);
  const p = r.ctrl.player;
  const carriedBefore = p.carrierId === ship.id;
  ship.throttle = 1;
  r.h.run(1500);
  r.mark((k) => {
    const i = r.c.input;
    if (k >= 5 && k < 30) {
      i.yaw = -Math.PI / 2;
      i.forward = 1;
      i.sprint = true;
      i.jump = k >= 12 && k < 15; // at the edge
    } else r.c.stopInput();
  });
  r.runSteps(80);
  return result(r, { carriedBefore, inWater: p.wet > 0 && p.carrierId === 0 });
}
