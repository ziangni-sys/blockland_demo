/**
 * Package 5: batch sequences of the real Replicator on a real Simulation, replayed into
 * ClientReplica through NetClient over a loopback link (NETCODE sections 5, 7, 8, 16):
 * digests after every applied batch, rotor angles at any tick, the ships' and entities'
 * interpolated poses against the server's history, a pivot change never drawn with the wrong
 * pivot, entities carried by a removed carrier (docking) staying where they are.
 *
 * The scene is the example windmill boat: a server-driven bot starts the windmill (a world rotor),
 * assembles the boat (the rotor rides along, re-parented), steers it in circles with another bot,
 * a drop and a rabbit standing on the deck, then docks it. Client 'a' watches from the shore.
 */
import { describe, expect, it } from 'vitest';
import { cellState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { qslerp, quat, vec3, wrapAngle, type Quat, type Vec3 } from '../../src/core/math';
import { headingOf } from '../../src/entities/structs';
import { LoopbackNet, type LinkConditions } from '../../src/net/loopback';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import type { PlayerControl } from '../../src/sim/players';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { NetClient } from '../../src/net/client/netclient';
import { compareReplica, replicaDigest } from './digest';
import { link, ReplayTransport, ShimServer, ShimWorld, syncSource, type ShimClient } from './shim';

interface Boat {
  w: ShimWorld;
  sim: Simulation;
  helm: { x: number; y: number; z: number };
  at: (u: number, v: number, y: number) => { x: number; y: number; z: number };
  bot: PlayerControl;
  rider: PlayerControl;
}

/** Run until the server has ticked `n` more times. */
function ticks(w: ShimWorld, n = 1): void {
  const target = w.server.sim.ticks + n;
  while (w.server.sim.ticks < target) w.run(10);
}

function useOn(w: ShimWorld, ctrl: PlayerControl, x: number, y: number, z: number, gridId = 0): void {
  expect(ctrl.aimAt(x, y, z, undefined, gridId), `${ctrl.key} aims at ${x},${y},${z}`).toBe(true);
  ctrl.use();
  ticks(w);
}

function boatWorld(): Boat {
  const sim = new Simulation({ seed: 1, mode: 'creative', generator: new TerrainGenerator(1), syncChunks: true, loadRadius: 4, rabbits: false });
  const w = new ShimWorld(new ShimServer(new LoopbackNet(), sim));
  const helm = placeExampleShip(sim)!;
  expect(helm).not.toBeNull();
  const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
  const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
  const bot = sim.join('bot');
  const rider = sim.join('rider');
  bot.emptyHand();
  return { w, sim, helm, at, bot, rider };
}

/** Start the windmill (world rotor), then assemble the boat from the helm (the bot steers). */
function launch(b: Boat): { ship: Ship; rotor: Rotor } {
  const { w, sim, at, bot, helm } = b;
  const stand = at(1, BEARING_V, DECK_Y);
  bot.teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
  ticks(w, 2);
  const bearing = at(0, BEARING_V, MAST_TOP_Y);
  useOn(w, bot, bearing.x, bearing.y, bearing.z);
  useOn(w, bot, bearing.x, bearing.y, bearing.z);
  const rotor = sim.structures.rotors()[0]!;
  expect(rotor).toBeDefined();
  ticks(w, 30);
  const front = at(0, 2, DECK_Y);
  bot.teleport(front.x + 0.5, DECK_Y, front.z + 0.5);
  const deck = at(-1, 4, DECK_Y);
  b.rider.teleport(deck.x + 0.5, DECK_Y, deck.z + 0.5);
  ticks(w, 2);
  useOn(w, bot, helm.x, helm.y, helm.z);
  useOn(w, bot, helm.x, helm.y, helm.z);
  const ship = sim.structures.ships()[0]!;
  expect(ship).toBeDefined();
  expect(rotor.parent).toBe(ship);
  return { ship, rotor };
}

/** The server's pose of ship `id` at a fractional tick (lerp / slerp of its history). */
function serverShipPose(w: ShimWorld, id: number, tick: number): { pos: Vec3; rot: Quat } | null {
  const a = w.server.history.get(Math.floor(tick))?.ships.get(id);
  const b = w.server.history.get(Math.floor(tick) + 1)?.ships.get(id);
  if (a === undefined) return null;
  const f = tick - Math.floor(tick);
  if (b === undefined || f === 0) return { pos: { ...a.pos }, rot: { ...a.rot } };
  return {
    pos: vec3(a.pos.x + (b.pos.x - a.pos.x) * f, a.pos.y + (b.pos.y - a.pos.y) * f, a.pos.z + (b.pos.z - a.pos.z) * f),
    rot: qslerp(a.rot, b.rot, f, quat()),
  };
}

function quatDiff(a: Quat, b: Quat): number {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  return Math.max(Math.abs(a.x - s * b.x), Math.abs(a.y - s * b.y), Math.abs(a.z - s * b.z), Math.abs(a.w - s * b.w));
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Watch rotor angles: at every frame, at integer ticks around rotorTick, the replica's equals the server's. */
function watchRotors(w: ShimWorld, a: ShimClient): { checked: number; worst: number; onShip: number } {
  const stats = { checked: 0, worst: 0, onShip: 0 };
  const prev = a.onFrame;
  a.onFrame = (now) => {
    prev?.(now);
    const r = a.replica;
    const clock = a.net.clock;
    if (r === null || clock === null || !Number.isFinite(clock.rotorTick)) return;
    for (const rs of r.state.structures.values()) {
      if (!(rs.structure instanceof Rotor)) continue;
      for (const T of [Math.floor(clock.rotorTick), Math.floor(clock.renderTick), rs.rotorTick + 1]) {
        if (T < rs.rotorTick) continue;
        const server = w.server.history.get(T)?.rotors.get(rs.structure.id);
        if (server === undefined) continue;
        const d = Math.abs(wrapAngle(r.rotorAngleAt(rs.structure.id, T) - server));
        stats.worst = Math.max(stats.worst, d);
        stats.checked++;
        if (rs.structure.parent !== null) stats.onShip++;
      }
    }
  };
  return stats;
}

describe('ClientReplica with a real Replicator (package 5)', () => {
  it('windmill boat over 150 ms / 20 ms jitter / 5% loss: digests every batch, rotor angles exact at every tick, world and ship rotor', () => {
    const b = boatWorld();
    const { w, sim, bot } = b;
    const lossy: [LinkConditions, LinkConditions] = [link(75, 20, 0.05, 11), link(75, 20, 0.05, 12)];
    const a = w.add({ key: 'a', viewRadius: 4, up: lossy[0], down: lossy[1] });
    w.runUntil(() => a.net.status === 'ready');
    const rot = watchRotors(w, a);
    const { ship, rotor } = launch(b);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    ticks(w, 200);
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    ticks(w, 60);
    expect(Math.hypot(ship.grid.position.x - b.helm.x, ship.grid.position.z - b.helm.z)).toBeGreaterThan(2);
    // A ROTOR_RESYNC_TICKS resync passed; the replica's rotor is the ship's child.
    const rr = a.replica!.state.structures.get(rotor.id)!;
    expect(rr.structure.parent?.id).toBe(ship.id);
    expect(rot.checked).toBeGreaterThan(300);
    expect(rot.onShip).toBeGreaterThan(200);
    expect(rot.worst).toBeLessThan(1e-9);
    expect(a.batchesChecked).toBeGreaterThan(250);
    a.expectClean();
    // D for 150 ms with 20 ms jitter and 5% loss (section 4: about 3 there; here the server ticks exactly every 50 ms).
    const clock = a.net.clock!;
    expect(clock.D).toBeGreaterThan(2);
    expect(clock.D).toBeLessThan(3.2);
    expect(sim.ticks).toBeGreaterThan(300);
    // The same bytes replayed into a fresh NetClient in one burst while hidden (a page coming back
    // from the background): the same replica, poses included.
    const replay = new ReplayTransport();
    const again = new NetClient({ openTransport: (ready) => ready(replay), now: () => w.net.now, chunkSource: () => syncSource(sim.generator), playerKey: 'a', name: 'a', viewRadius: 4, build: 'test' });
    again.start();
    again.setHidden(true);
    for (const m of a.received) replay.deliver(m.channel, m.bytes);
    a.net.frame(w.net.now);
    expect(again.status).toBe('ready');
    expect(again.replica!.state.tick).toBe(a.replica!.state.tick);
    expect(compareReplica(replicaDigest(a.replica!.state), replicaDigest(again.replica!.state))).toEqual([]);
  }, 120_000);

  it('lossless with jitter: ship poses at renderTick, riders in the ship frame, a pivot change, and a dock with riders aboard', () => {
    const b = boatWorld();
    const { w, sim, bot, helm } = b;
    const a = w.add({ key: 'a', viewRadius: 4, up: link(40, 25, 0, 21), down: link(40, 25, 0, 22) });
    w.runUntil(() => a.net.status === 'ready');
    const { ship } = launch(b);
    const deck = b.at(1, 6, DECK_Y);
    const item = sim.entities.spawnItem(deck.x + 0.5, DECK_Y + 0.5, deck.z + 0.5, B.STONE, 3);
    const rabbitAt = b.at(-1, 7, DECK_Y);
    const rabbit = sim.entities.spawnRabbit(rabbitAt.x + 0.5, DECK_Y, rabbitAt.z + 0.5);
    const watched = [b.rider.entityId, item.id, rabbit.id];
    // The helm cell's centre in the world, every tick (ship-local coordinates are the assembly's world cells).
    const helmLocal = vec3(helm.x + 0.5, helm.y + 0.5, helm.z + 0.5);
    const helmWorld = new Map<number, Vec3>();
    const pivots = new Map<number, Vec3>();
    w.onTick = () => {
      const s = sim.structures.get(ship.id);
      if (s === undefined) return;
      helmWorld.set(sim.ticks, s.grid.toWorld(helmLocal));
      pivots.set(sim.ticks, { ...s.grid.pivot });
    };
    const samePivot = (p: Vec3, t: number): boolean => [pivots.get(Math.floor(t)), pivots.get(Math.floor(t) + 1)].every((q) => q === undefined || dist(p, q) === 0);
    const stats = { poseFrames: 0, poseWorst: 0, rotWorst: 0, helmWorst: 0, localChecks: 0, localWorst: 0, straddled: 0 };
    let pivotTick = Infinity;
    const lastView = new Map<number, { pos: Vec3; yaw: number }>();
    const jumps = { pos: 0, yaw: 0, frames: 0, world: 0 };
    let trackJumps = false;
    a.onFrame = () => {
      const r = a.replica!;
      const rt = a.net.clock!.renderTick;
      const rs = r.state.structures.get(ship.id);
      if (rs !== undefined) {
        const g = rs.structure.grid;
        const server = serverShipPose(w, ship.id, rt);
        // Poses compare where the server used the pivot the replica now has (else see the helm cell below).
        if (server !== null && samePivot(g.pivot, rt)) {
          stats.poseFrames++;
          stats.poseWorst = Math.max(stats.poseWorst, dist(g.position, server.pos));
          stats.rotWorst = Math.max(stats.rotWorst, quatDiff(g.rotation, server.rot));
        }
        const h0 = helmWorld.get(Math.floor(rt));
        const h1 = helmWorld.get(Math.floor(rt) + 1);
        if (h0 !== undefined && h1 !== undefined) {
          const f = rt - Math.floor(rt);
          const want = vec3(h0.x + (h1.x - h0.x) * f, h0.y + (h1.y - h0.y) * f, h0.z + (h1.z - h0.z) * f);
          stats.helmWorst = Math.max(stats.helmWorst, dist(g.toWorld(helmLocal), want));
          if (rt > pivotTick - 1 && rt < pivotTick && r.state.tick >= pivotTick) stats.straddled++;
        }
        // Entities on the deck: their position in the ship's frame against the server's.
        for (const v of r.entities(rt)) {
          if (!watched.includes(v.id)) continue;
          const s0 = w.server.history.get(Math.floor(rt))?.entities.get(v.id);
          const s1 = w.server.history.get(Math.floor(rt) + 1)?.entities.get(v.id);
          if (s0 === undefined || s1 === undefined || s0.carrierId !== ship.id || s1.carrierId !== ship.id || v.carrierId !== ship.id) continue;
          const f = rt - Math.floor(rt);
          const want = vec3(s0.local.x + (s1.local.x - s0.local.x) * f, s0.local.y + (s1.local.y - s0.local.y) * f, s0.local.z + (s1.local.z - s0.local.z) * f);
          stats.localChecks++;
          stats.localWorst = Math.max(stats.localWorst, dist(g.toLocal(v.pos), want));
        }
      }
      if (trackJumps) {
        jumps.frames++;
        for (const v of r.entities(rt)) {
          if (!watched.includes(v.id)) continue;
          const last = lastView.get(v.id);
          if (last !== undefined) {
            jumps.pos = Math.max(jumps.pos, dist(last.pos, v.pos));
            jumps.yaw = Math.max(jumps.yaw, Math.abs(wrapAngle(v.yaw - last.yaw)));
          }
          lastView.set(v.id, { pos: v.pos, yaw: v.yaw });
          // Against the server's world position at renderTick (lerp of its ticks).
          const s0 = w.server.history.get(Math.floor(rt))?.entities.get(v.id);
          const s1 = w.server.history.get(Math.floor(rt) + 1)?.entities.get(v.id);
          if (s0 !== undefined && s1 !== undefined) {
            const f = rt - Math.floor(rt);
            const want = vec3(s0.pos.x + (s1.pos.x - s0.pos.x) * f, s0.pos.y + (s1.pos.y - s0.pos.y) * f, s0.pos.z + (s1.pos.z - s0.pos.z) * f);
            jumps.world = Math.max(jumps.world, dist(v.pos, want));
          }
        }
      }
    };
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.6;
    ticks(w, 120);
    // 18 planks on one side of the moving ship: its pivot moves (a delta, under the resend line).
    let added = 0;
    for (let v = 0; v <= 8; v++) {
      for (const y of [DECK_Y + 1, DECK_Y + 2]) {
        const c = b.at(2, v, y);
        if (ship.grid.getCell(c.x, c.y, c.z) === 0) {
          ship.grid.setCell(c.x, c.y, c.z, makeCell(B.PLANKS_OAK));
          added++;
        }
      }
    }
    expect(added).toBeGreaterThan(12);
    const pivotBefore = { ...ship.grid.pivot };
    ticks(w, 1);
    pivotTick = sim.ticks;
    expect(dist(ship.grid.pivot, pivotBefore)).toBeGreaterThan(0.2);
    ticks(w, 120);
    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    ticks(w, 120);
    // Dock from the wheel with everyone aboard.
    trackJumps = true;
    ticks(w, 20);
    bot.player.input.sneak = true;
    bot.use();
    ticks(w, 1);
    bot.player.input.sneak = false;
    expect(ship.removed).toBe(true);
    ticks(w, 60);
    expect(a.replica!.state.structures.has(ship.id)).toBe(false);
    a.expectClean();
    expect(stats.poseFrames).toBeGreaterThan(800);
    expect(stats.poseWorst).toBeLessThan(2 / 512);
    expect(stats.rotWorst).toBeLessThan(2e-4);
    expect(stats.helmWorst).toBeLessThan(0.02);
    expect(stats.straddled).toBeGreaterThan(0);
    expect(stats.localChecks).toBeGreaterThan(1000);
    expect(stats.localWorst).toBeLessThan(0.05);
    expect(jumps.frames).toBeGreaterThan(200);
    expect(jumps.pos).toBeLessThan(0.15);
    expect(jumps.yaw).toBeLessThan(0.15);
    expect(jumps.world).toBeLessThan(0.05);
  }, 120_000);
});
