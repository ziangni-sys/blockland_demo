/**
 * End to end (package 6): the acceptance scenarios of the own player on ships, on the links the
 * spec names (NETCODE section 16), and the player record that keeps the carrier.
 *  - 31: two players standing on a raft sailing in circles (150 ms, 20 ms jitter, 5% loss): each
 *    sees the other where the server has it in the raft's frame, nobody is corrected or hurt;
 *    then both walk the deck: no correction;
 *  - 32: one docks from the wheel after sailing at 30 degrees, the other stands on the deck corner
 *    farthest from the pivot: both stand on world blocks afterwards, the rider exactly where the
 *    dock's snap took its deck spot, nobody fell or got hurt, the replicas equal the server; and the
 *    turntable variant: a turntable on a sailing raft stops under its rider, who follows the snap;
 *  - 35: the helmsman's page dies, or it stops reporting: the wheel lets go within a tick, or
 *    within STEER_TIMEOUT_TICKS; it reconnects with the same identity: back where the record has it;
 *  - the record keeps the carrier: leave on a ship, the ship sails on, rejoin on the deck; the
 *    same after the ship was docked meanwhile: at the world position.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { headingOf } from '../../src/entities/structs';
import { STEER_TIMEOUT_TICKS } from '../../src/net/protocol';
import { planDock, rotorSnap, snapPoint } from '../../src/structures/assembly';
import type { Rotor, Ship } from '../../src/structures/structure';
import { clickOn, fill, LINKS } from './e2e-scenes';
import type { HeadlessClient, NetHarness } from './harness';
import { assemble, buildRaft, dist, OWN_SEA, OWN_SEA_TOP, ownWorld, stat, type OwnRun } from './own-scenes';

const S = OWN_SEA_TOP;
const LINK_150 = LINKS[1]!;

/** A second client (a guest) on the same link kind, ready. */
async function guest(r: OwnRun, key: string, seed: number): Promise<HeadlessClient> {
  await r.h.host.control({ type: 'openRoom' });
  const c = r.h.addClient(key, LINK_150.make(seed), { viewRadius: 3 });
  r.h.runUntil(() => c.ready && c.own !== null, 30_000);
  return c;
}

/** The server's local position of entity `id` on ship `shipId` at a fractional tick (harness history), or null. */
function serverLocalAt(h: NetHarness, id: number, shipId: number, tick: number): Vec3 | null {
  const a = h.history.get(Math.floor(tick))?.entities.get(id);
  const b = h.history.get(Math.floor(tick) + 1)?.entities.get(id);
  if (a === undefined || b === undefined || a.carrierId !== shipId || b.carrierId !== shipId) return null;
  const f = tick - Math.floor(tick);
  return vec3(a.local.x + (b.local.x - a.local.x) * f, a.local.y + (b.local.y - a.local.y) * f, a.local.z + (b.local.z - a.local.z) * f);
}

/** At every frame of `c`: the other player `otherId` at renderTick in the ship's frame, against the server's. */
function watchOther(h: NetHarness, c: HeadlessClient, otherId: number, shipId: number): { worst: number; frames: number } {
  const out = { worst: 0, frames: 0 };
  c.onFrame = () => {
    const r = c.replica;
    const clock = c.net.clock;
    if (r === null || clock === null || !c.ready) return;
    const rt = clock.renderTick;
    const rs = r.state.structures.get(shipId);
    if (rs === undefined) return;
    const v = r.entities(rt).find((e) => e.id === otherId);
    if (v === undefined || v.carrierId !== shipId) return;
    const want = serverLocalAt(h, otherId, shipId, rt);
    if (want === null) return;
    out.frames++;
    out.worst = Math.max(out.worst, dist(rs.structure.grid.toLocal(v.pos), want));
  };
  return out;
}

/** A client's own carrier-local position at every report on `shipId`: the largest drift from the first. */
function watchOwnDrift(c: HeadlessClient, shipId: number): { drift: number; reports: number } {
  const out = { drift: 0, reports: 0 };
  let first: Vec3 | null = null;
  c.onReport = (rep) => {
    if (rep.carrierId !== shipId) return;
    out.reports++;
    first ??= { ...rep.pos };
    out.drift = Math.max(out.drift, dist(first, rep.pos));
  };
  return out;
}

function badCauses(c: HeadlessClient, since: number): string[] {
  return c.correctionsSince(since, (cause) => cause.startsWith('check:') || cause === 'crush');
}

describe('31. two players stand on a raft sailing in circles (150 ms, 20 ms jitter, 5% loss)', () => {
  it('each sees the other still on the deck where the server has it; no check or crush corrections, no crush damage; then both walk: no corrections', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(31));
    const a = r.c;
    const b = await guest(r, 'b', 33);
    const sim = r.sim;
    const ship = assemble(sim, buildRaft(sim, { x0: 10, z0: 0, x1: 18, z1: 8, y: S - 1, gunwale: true, helm: { x: 14, z: 1 } }));
    r.h.run(1000);
    const ca = sim.players.get('p')!;
    const cb = sim.players.get('b')!;
    ca.teleport(12.5, S, 5.5);
    cb.teleport(16.5, S, 6.5);
    r.h.run(2000);
    expect(ca.player.carrierId).toBe(ship.id);
    expect(cb.player.carrierId).toBe(ship.id);
    const crushHurts: string[] = [];
    sim.events.on((e) => {
      if (e.type === 'playerHurt' && e.cause === 'crush') crushHurts.push(e.player);
    });
    const since = sim.ticks;
    const seenByA = watchOther(r.h, a, cb.entityId, ship.id);
    const seenByB = watchOther(r.h, b, ca.entityId, ship.id);
    const driftA = watchOwnDrift(a, ship.id);
    const driftB = watchOwnDrift(b, ship.id);
    const yaw0 = headingOf(ship.grid.rotation);
    let turned = 0;
    let lastYaw = yaw0;
    r.onTick(() => {
      const y = headingOf(ship.grid.rotation);
      turned += Math.abs(Math.atan2(Math.sin(y - lastYaw), Math.cos(y - lastYaw)));
      lastYaw = y;
    });
    ship.throttle = 1;
    ship.rudder = 0.5;
    r.h.run(60_000);
    stat(`31\tturned ${turned.toFixed(2)} rad; a sees b: ${seenByA.frames} frames, worst ${seenByA.worst.toExponential(2)}; b sees a: ${seenByB.frames} frames, worst ${seenByB.worst.toExponential(2)}; own drift a ${driftA.drift.toExponential(2)} b ${driftB.drift.toExponential(2)}; corrections a ${JSON.stringify(a.correctionsSince(since))} b ${JSON.stringify(b.correctionsSince(since))}`);
    expect(turned).toBeGreaterThan(2 * Math.PI); // it went round
    for (const [w, who] of [
      [seenByA, 'a sees b'],
      [seenByB, 'b sees a'],
    ] as const) {
      expect(w.frames, who).toBeGreaterThan(2000);
      expect(w.worst, who).toBeLessThan(0.05);
    }
    expect(badCauses(a, since)).toEqual([]);
    expect(badCauses(b, since)).toEqual([]);
    expect(crushHurts).toEqual([]);
    expect(driftA.reports).toBeGreaterThan(1000);
    expect(driftA.drift).toBeLessThan(0.01);
    expect(driftB.drift).toBeLessThan(0.01);
    // Both walk back and forth on the deck: no correction at all.
    const walkSince = sim.ticks;
    for (const [c, k] of [
      [a, 0],
      [b, 7],
    ] as const) {
      let n = k;
      c.onStep = () => {
        n++;
        c.input.forward = 0.6;
        if (n % 40 === 0) c.input.yaw += Math.PI;
      };
    }
    r.h.run(20_000);
    expect(a.correctionsSince(walkSince)).toEqual([]);
    expect(b.correctionsSince(walkSince)).toEqual([]);
    expect(ca.player.carrierId).toBe(ship.id);
    expect(cb.player.carrierId).toBe(ship.id);
  }, 180_000);
});

/**
 * A guest's page draws no frame for a while (a background tab, a stall) while it rides a sailing,
 * turning raft: no client tick runs, then up to MAX_STEPS_PER_FRAME do, from poses far newer than
 * those of its last tick (older ones are gone from the replica's rings). It keeps its place on the
 * deck: the client never lets go of the raft, the server never has it off the raft, nobody corrects
 * or hurts it, and its reported deck position does not drift. `walk`: it walks the deck meanwhile.
 */
const STALLS: { name: string; link: number; hiddenMs?: number; stallMs?: number; everyMs?: number; walk?: boolean }[] = [
  { name: 'one 5 s hidden period (a background tab)', link: 1, hiddenMs: 5000 },
  { name: 'one 5 s stall', link: 0, stallMs: 5000 },
  { name: '2 s stalls every 3 s', link: 0, stallMs: 2000, everyMs: 3000 },
  { name: '4 s stalls every 5 s', link: 1, stallMs: 4000, everyMs: 5000 },
  { name: '2.5 s stalls every 4 s while walking the deck', link: 1, stallMs: 2500, everyMs: 4000, walk: true },
];

/** The first stall begins this long after the raft sets off (ms): it is at speed by then. */
const STALL_FROM_MS = 6000;

describe('31. a rider whose page skips frames stays on the sailing raft', () => {
  for (const s of STALLS) {
    it(`${s.name}, ${LINKS[s.link]!.name}`, async () => {
      const link = LINKS[s.link]!;
      const r = await ownWorld(OWN_SEA, 'survival', link.make(61));
      await r.h.host.control({ type: 'openRoom' });
      const b = r.h.addClient('b', link.make(62), { viewRadius: 3 });
      r.h.runUntil(() => b.ready && b.own !== null, 30_000);
      const sim = r.sim;
      const ship = assemble(sim, buildRaft(sim, { x0: 10, z0: 0, x1: 18, z1: 8, y: S - 1, gunwale: true, helm: { x: 14, z: 1 } }));
      r.h.run(1000);
      const cb = sim.players.get('b')!;
      cb.teleport(13.5, S, 4.5);
      r.h.run(3000);
      expect(cb.player.carrierId).toBe(ship.id);
      const hurts: string[] = [];
      sim.events.on((e) => {
        if (e.type === 'playerHurt' && e.player === 'b') hurts.push(e.cause);
      });
      const t0 = r.h.net.now;
      const frame = b.frame.bind(b);
      b.frame = (now: number) => {
        const t = now - t0;
        if (s.stallMs !== undefined && t > STALL_FROM_MS) {
          if (s.everyMs === undefined ? t < STALL_FROM_MS + s.stallMs : (t - STALL_FROM_MS) % s.everyMs < s.stallMs) return;
        }
        frame(now);
      };
      if (s.hiddenMs !== undefined) {
        r.h.net.schedule(t0 + STALL_FROM_MS, () => {
          b.hidden = true;
        });
        r.h.net.schedule(t0 + STALL_FROM_MS + s.hiddenMs, () => {
          b.hidden = false;
        });
      }
      const lost: string[] = [];
      b.onFrame = () => {
        const c = b.own?.player.carrierId;
        if (c !== ship.id && lost.length < 5) lost.push(`${((r.h.net.now - t0) / 1000).toFixed(2)} s: client carrier ${c}, server ${cb.player.carrierId}`);
      };
      const drift = watchOwnDrift(b, ship.id);
      let n = 0;
      if (s.walk === true) {
        b.onStep = () => {
          n++;
          b.input.forward = 0.6;
          if (n % 40 === 0) b.input.yaw += Math.PI;
        };
      }
      const since = sim.ticks;
      ship.throttle = 1;
      ship.rudder = 0.3;
      r.h.run(25_000);
      stat(`31 stalls\t${s.name}, ${link.name}: ${drift.reports} reports on the raft, drift ${drift.drift.toExponential(2)}; corrections ${JSON.stringify(b.correctionsSince(since))}`);
      expect(lost).toEqual([]);
      expect(cb.player.carrierId).toBe(ship.id);
      expect(b.correctionsSince(since)).toEqual([]);
      expect(hurts).toEqual([]);
      expect(drift.reports).toBeGreaterThan(100);
      if (s.walk !== true) expect(drift.drift).toBeLessThan(0.01);
    }, 120_000);
  }
});

describe('32. docking while another player stands on the deck (150 ms, 20 ms jitter, 5% loss)', () => {
  it('after sailing at 30 degrees: both stand on world blocks, the rider exactly where the snap took its deck spot; nobody fell or got hurt; the replicas equal the server', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(32));
    const a = r.c;
    const b = await guest(r, 'b', 34);
    const sim = r.sim;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 16, z1: 8, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } });
    const ca = sim.players.get('p')!;
    const cb = sim.players.get('b')!;
    ca.teleport(13.5, S, 3.5);
    r.h.run(1000);
    a.emptyHand();
    clickOn(a, helm.x, helm.y, helm.z);
    clickOn(a, helm.x, helm.y, helm.z);
    const ship = sim.structures.ships()[0]!;
    expect(ca.player.steeringShipId).toBe(ship.id);
    // The rider on the deck corner farthest from the pivot.
    cb.teleport(15.5, S, 8.4);
    r.h.run(1500);
    expect(cb.player.carrierId).toBe(ship.id);
    r.h.track(a);
    r.h.track(b);
    const hurts: string[] = [];
    sim.events.on((e) => {
      if (e.type === 'playerHurt') hurts.push(`${e.player} ${e.cause}`);
    });
    // Sail and turn until the raft heads about 30 degrees off (it turns on a while after the
    // rudder is centred), sail on straight, slow down.
    const yaw0 = headingOf(ship.grid.rotation);
    const turned = (): number => Math.abs(Math.atan2(Math.sin(headingOf(ship.grid.rotation) - yaw0), Math.cos(headingOf(ship.grid.rotation) - yaw0)));
    a.input.forward = 1;
    a.input.strafe = 1;
    r.h.runUntil(() => turned() >= 0.2, 60_000);
    a.input.strafe = 0;
    r.h.run(1500);
    a.input.forward = 0;
    r.h.run(3000);
    const heading0 = turned();
    expect(heading0).toBeGreaterThan((20 * Math.PI) / 180);
    expect(heading0).toBeLessThan((40 * Math.PI) / 180);
    // Dock from the wheel: sneak (the reports carry the key) and right-click.
    a.input.sneak = true;
    r.h.run(600);
    let expectB: Vec3 | null = null;
    const dock = sim.structures.dockShip.bind(sim.structures);
    sim.structures.dockShip = (s: Ship) => {
      const t = planDock(sim.world, s.grid).t;
      expectB = snapPoint(t, s.grid.toLocal(cb.player.pos));
      return dock(s);
    };
    const since = sim.ticks;
    a.use(true);
    a.waitAck();
    a.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(expectB).not.toBeNull();
    const y0 = { a: ca.player.pos.y, b: cb.player.pos.y };
    let drop = 0;
    r.onTick(() => (drop = Math.max(drop, y0.a - ca.player.pos.y, y0.b - cb.player.pos.y)));
    r.h.run(2000);
    for (const c of [ca, cb]) {
      expect(c.player.carrierId, c.key).toBe(0);
      expect(c.player.onWorldGround, c.key).toBe(true);
    }
    stat(`32\theading ${(heading0 * 180 / Math.PI).toFixed(1)} deg; rider off the snapped spot ${dist(cb.player.pos, expectB!).toExponential(2)}; largest drop ${drop.toFixed(3)}; corrections a ${JSON.stringify(a.correctionsSince(since))} b ${JSON.stringify(b.correctionsSince(since))}`);
    expect(dist(cb.player.pos, expectB!)).toBeLessThan(0.05);
    expect(drop).toBeLessThan(0.6);
    expect(hurts).toEqual([]);
    // (The helmsman let go of the wheel and was released in the same tick: one correction, the last cause.)
    expect(a.correctionsSince(since)).toEqual(['release']);
    expect(b.correctionsSince(since)).toEqual(['release']);
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    r.h.quiesce();
    expect(r.h.compareNow(a)).toEqual([]);
    expect(r.h.compareNow(b)).toEqual([]);
  }, 180_000);

  it('the turntable variant: a turntable on a sailing raft stops under its rider, who follows the snap and stays aboard', async () => {
    const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(35));
    const a = r.c;
    const sim = r.sim;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 18, z1: 8, y: S - 1, gunwale: true, helm: { x: 14, z: 1 } });
    sim.world.setCell(14, S, 5, makeCell(B.BEARING, facingState(PY)));
    fill(sim, 13, S + 1, 4, 15, S + 1, 6, B.WOOL_WHITE);
    sim.worldGlue.add(14, S, 5, PY); // the platform comes along with the raft
    const ship = assemble(sim, helm);
    const started = sim.structures.startRotor(ship.grid, 14, S, 5);
    if (!started.ok) throw new Error(started.reason);
    const rotor: Rotor = started.structure;
    r.h.run(2500); // spin up
    const w = rotor.grid.toWorld(vec3(15.4, S + 2, 5.6));
    sim.players.get('p')!.teleport(w.x, w.y, w.z);
    r.h.run(2000);
    const p = sim.players.get('p')!.player;
    expect(p.carrierId).toBe(rotor.id);
    ship.throttle = 1;
    r.h.run(2000);
    const hurts: string[] = [];
    sim.events.on((e) => {
      if (e.type === 'playerHurt') hurts.push(e.cause);
    });
    const t = rotorSnap(rotor.grid);
    const want = snapPoint(t, rotor.grid.toLocal(p.pos));
    const since = sim.ticks;
    sim.structures.stopRotor(rotor);
    expect(p.carrierId).toBe(ship.id);
    expect(dist(ship.grid.toLocal(p.pos), want)).toBeLessThan(1e-9);
    const y0 = ship.grid.toLocal(p.pos).y;
    let drop = 0;
    let worst = 0;
    r.onTick(() => {
      const l = ship.grid.toLocal(p.pos);
      drop = Math.max(drop, y0 - l.y);
      worst = Math.max(worst, dist(l, want));
    });
    r.h.run(2000);
    stat(`32t\trider off the snapped turntable spot (ship frame) ${worst.toExponential(2)}; largest drop ${drop.toFixed(3)}; corrections ${JSON.stringify(a.correctionsSince(since))}`);
    expect(p.carrierId).toBe(ship.id);
    expect(p.onGround).toBe(true);
    expect(worst).toBeLessThan(0.05);
    expect(drop).toBeLessThan(0.6);
    expect(hurts).toEqual([]);
    expect(a.correctionsSince(since)).toEqual(['release']);
  }, 120_000);
});

/** A helmsman (the local client) at the wheel of a raft, throttle 1 from its held key. */
async function helmsman(seed: number): Promise<{ r: OwnRun; ship: Ship }> {
  const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(seed));
  // Scenario 35 is about a room: with the room closed (single player) the host's own page is
  // exempt from the steering timeout (net/server/moves.ts).
  await r.h.host.control({ type: 'openRoom' });
  const sim = r.sim;
  const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 16, z1: 8, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } });
  const c = sim.players.get('p')!;
  c.teleport(13.5, S, 3.5);
  r.h.run(1000);
  c.giveItem(B.GLASS, 5);
  r.h.run(200);
  r.c.emptyHand();
  clickOn(r.c, helm.x, helm.y, helm.z);
  clickOn(r.c, helm.x, helm.y, helm.z);
  const ship = sim.structures.ships()[0]!;
  r.c.input.forward = 1;
  r.h.run(1500);
  expect(ship.throttle).toBe(1);
  return { r, ship };
}

/** The server's record of the player as it was at the end of each tick while it was online. */
function recordWatch(r: OwnRun): { local: Vec3 | null; carrierId: number; glass: number } {
  const rec = { local: null as Vec3 | null, carrierId: 0, glass: 0 };
  r.onTick(() => {
    const c = r.sim.players.get('p');
    if (c === undefined) return;
    const p = c.player;
    const s = p.carrierId !== 0 ? r.sim.structures.get(p.carrierId) : undefined;
    rec.carrierId = p.carrierId;
    rec.local = s !== undefined ? s.grid.toLocal(p.pos) : { ...p.pos };
    rec.glass = p.inventory.count(B.GLASS);
  });
  return rec;
}

/** Reconnect 'p' as a new page; it is back where its record has it (on the raft), with its inventory. */
function rejoinAsRecorded(r: OwnRun, ship: Ship, rec: { local: Vec3 | null; carrierId: number; glass: number }, seed: number): void {
  const local = rec.local!;
  const glass = rec.glass;
  const again = r.h.addClient('p', LINK_150.make(seed), { local: true });
  r.h.runUntil(() => again.ready && again.own !== null, 30_000);
  const p = r.sim.players.get('p')!.player;
  expect(p.carrierId).toBe(ship.id);
  expect(dist(ship.grid.toLocal(p.pos), local)).toBeLessThan(1e-6);
  expect(p.inventory.count(B.GLASS)).toBe(glass);
  expect(p.steeringShipId).toBe(0);
}

describe('35. the helmsman drops (150 ms, 20 ms jitter, 5% loss)', () => {
  it('its page dies (no Bye): the wheel lets go within a tick of the close, the throttle is 0; reconnected, it is where the record has it', async () => {
    const { r, ship } = await helmsman(41);
    const rec = recordWatch(r);
    r.h.crash(r.c);
    // The close reaches the server a one-way delay later (its onClose ends the connection).
    r.h.runUntil(() => !r.h.host.netServer.connections().some((c) => c.key === 'p'), 2000, 1);
    const at = r.sim.ticks;
    r.h.runUntil(() => ship.helmsmanId === 0, 2000, 1);
    stat(`35a\treleased ${r.sim.ticks - at} tick(s) after the server saw the close`);
    expect(r.sim.ticks - at).toBeLessThanOrEqual(1);
    expect(ship.throttle).toBe(0);
    expect(rec.carrierId).toBe(ship.id);
    r.h.run(2000);
    rejoinAsRecorded(r, ship, rec, 42);
  }, 120_000);

  it('its client stops reporting: the wheel lets go within STEER_TIMEOUT_TICKS, the throttle is 0; reconnected, it is where the record has it', async () => {
    const { r, ship } = await helmsman(43);
    r.c.silent = true;
    // The last report arrives about a one-way delay later.
    const at = r.sim.ticks;
    r.h.runUntil(() => ship.helmsmanId === 0, 10_000, 1);
    stat(`35b\treleased ${r.sim.ticks - at} ticks after the client fell silent`);
    expect(r.sim.ticks - at).toBeLessThanOrEqual(STEER_TIMEOUT_TICKS + 4);
    expect(r.sim.ticks - at).toBeGreaterThanOrEqual(STEER_TIMEOUT_TICKS);
    expect(ship.throttle).toBe(0);
    expect(r.c.correctionsSince(at)).toEqual([]); // silent: it never applied the unseat
    const rec = recordWatch(r);
    r.h.run(500);
    r.h.crash(r.c);
    r.h.run(2000);
    rejoinAsRecorded(r, ship, rec, 44);
  }, 120_000);
});

describe('the player record keeps the carrier (NETCODE "场景 36 和玩家记录")', () => {
  async function rider(seed: number): Promise<{ r: OwnRun; b: HeadlessClient; ship: Ship }> {
    const r = await ownWorld(OWN_SEA, 'survival', LINK_150.make(seed));
    const sim = r.sim;
    const ship = assemble(sim, buildRaft(sim, { x0: 10, z0: 0, x1: 16, z1: 8, y: S - 1, gunwale: true, helm: { x: 13, z: 1 } }));
    const b = await guest(r, 'b', seed + 1);
    sim.players.get('b')!.teleport(12.5, S, 5.5);
    r.h.run(1500);
    expect(sim.players.get('b')!.player.carrierId).toBe(ship.id);
    ship.throttle = 1;
    r.h.run(1000);
    return { r, b, ship };
  }

  it('leave while standing on a sailing raft, the raft sails on, rejoin: on the deck where it stood, predicting without corrections', async () => {
    const { r, b, ship } = await rider(51);
    const p0 = r.sim.players.get('b')!.player;
    const local = ship.grid.toLocal(p0.pos);
    b.leave();
    r.h.run(200);
    expect(r.sim.players.get('b')).toBeUndefined();
    const from = { ...ship.grid.position };
    r.h.run(3000);
    expect(dist(ship.grid.position, from)).toBeGreaterThan(3);
    const b2 = r.h.addClient('b', LINK_150.make(53), { viewRadius: 3 });
    r.h.runUntil(() => b2.ready && b2.own !== null, 30_000);
    const p = r.sim.players.get('b')!.player;
    expect(p.carrierId).toBe(ship.id);
    expect(dist(ship.grid.toLocal(p.pos), local)).toBeLessThan(0.05);
    const since = r.sim.ticks;
    r.h.run(3000);
    expect(b2.correctionsSince(since)).toEqual([]);
    expect(p.carrierId).toBe(ship.id);
    expect(b2.own!.player.carrierId).toBe(ship.id);
  }, 120_000);

  it('the same, but the raft was docked meanwhile: back at the world position it left from', async () => {
    const { r, b, ship } = await rider(61);
    ship.throttle = 0;
    r.h.run(4000); // slow down
    const p0 = r.sim.players.get('b')!.player;
    const at = { ...p0.pos };
    b.leave();
    r.h.run(200);
    ship.throttle = 1;
    r.h.run(3000);
    const docked = r.sim.structures.dockShip(ship);
    expect(docked.ok).toBe(true);
    r.h.run(500);
    const b2 = r.h.addClient('b', LINK_150.make(63), { viewRadius: 3 });
    r.h.runUntil(() => b2.ready && b2.own !== null, 30_000);
    const p = r.sim.players.get('b')!.player;
    expect(p.carrierId).toBe(0);
    expect(dist(p.pos, at)).toBeLessThan(0.05);
  }, 120_000);
});
