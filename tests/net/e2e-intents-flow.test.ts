/**
 * Package 7 end to end: the order and pace of intents (NETCODE section 10 应用顺序) and two clients
 * acting on the same thing in the same tick.
 *  - A burst that arrives together after a server stall: every click is carried out, one press a
 *    tick, the releases take effect, nothing is dropped.
 *  - More than INTENT_QUEUE_LIMIT waiting: the client is kicked (protocol_error).
 *  - Two clients on the same face, the same block, the same helm, the same drop in one tick: one
 *    wins, the other sees the ordinary refusal; the replicas stay equal to the server every tick.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, NZ, PY } from '../../src/core/dirs';
import { INTENT_QUEUE_LIMIT } from '../../src/net/protocol';
import { LINKS } from './e2e-scenes';
import type { HeadlessClient, NetHarness } from './harness';
import { assemble, buildRaft, LAND, LAND_TOP, OWN_SEA, OWN_SEA_TOP, ownWorld, type OwnRun } from './own-scenes';

const T = LAND_TOP;

describe('package 7: a burst of intents after a stall', () => {
  for (const [i, l] of LINKS.slice(0, 2).entries()) {
    it(`every click is carried out, one press a tick, the releases take effect (${l.name})`, async () => {
      const r = await ownWorld(LAND, 'creative', l.make(600 + i));
      const { c, sim, h, ctrl } = r;
      // Ten bricks within reach, five on each side.
      const bricks = Array.from({ length: 10 }, (_, k) => ({ x: -2 + (k % 5), z: k < 5 ? -2 : 3 }));
      for (const p of bricks) sim.world.setCell(p.x, T, p.z, makeCell(B.BRICKS));
      h.run(50);
      c.catchUp(sim.ticks);
      c.emptyHand();
      c.waitAck();
      const breaksByTick = new Map<number, number>();
      sim.events.on((e) => {
        if (e.type === 'blockBroken') breaksByTick.set(sim.ticks, (breaksByTick.get(sim.ticks) ?? 0) + 1);
      });
      // The server stalls (a Worker blocked by a long task); meanwhile the player clicks ten bricks.
      h.clock.freeze();
      for (const p of bricks) {
        expect(c.aimAt(p.x, T, p.z, PY, 0, true)).toBe(true);
        c.attack();
        h.net.advanceBy(20);
      }
      const sent = c.intents!.seq;
      h.net.advanceBy(1500);
      expect(h.sinks!.intents.intentAck('p')).toBeLessThan(sent);
      h.run(1500);
      c.waitAck();
      for (const p of bricks) expect(sim.world.getCell(p.x, T, p.z) & ID_MASK, `brick ${p.x} ${p.z}`).toBe(B.AIR);
      expect([...breaksByTick.values()].every((n) => n === 1)).toBe(true);
      expect(breaksByTick.size).toBe(10);
      expect(h.sinks!.intents.intentAck('p')).toBe(c.intents!.seq); // nothing dropped (aims sent since included)
      expect(ctrl.player.input.attack).toBe(false);
      expect(h.intentStats('p')!.deferredTicks).toBeGreaterThan(0);
    }, 60_000);
  }

  it('a press held through a stall and released during it: the server presses, then lets go', async () => {
    const r = await ownWorld(LAND, 'creative', LINKS[1]!.make(610));
    const { c, sim, h, ctrl } = r;
    sim.world.setCell(2, T, 0, makeCell(B.BRICKS));
    sim.world.setCell(2, T + 1, 0, makeCell(B.BRICKS));
    h.run(50);
    c.catchUp(sim.ticks);
    c.emptyHand();
    c.waitAck();
    expect(c.aimAt(2, T, 0, NX, 0, true)).toBe(true);
    h.clock.freeze();
    c.pressAttack();
    h.net.advanceBy(400);
    c.releaseAttack();
    h.net.advanceBy(400);
    h.run(10);
    c.waitAck();
    expect(sim.world.getCell(2, T, 0) & ID_MASK).toBe(B.AIR); // the press broke it
    expect(ctrl.player.input.attack).toBe(false); // and the button is up: nothing more breaks
    h.run(1000);
    expect(sim.world.getCell(2, T + 1, 0) & ID_MASK).toBe(B.BRICKS);
  }, 60_000);
});

describe('package 7: the queue limit', () => {
  it(`more than INTENT_QUEUE_LIMIT (${INTENT_QUEUE_LIMIT}) intents waiting: Kick(protocol_error)`, async () => {
    const r = await ownWorld(LAND, 'creative', {});
    const { c, h } = r;
    // A thousand presses in one go: one is applied a tick, the rest wait.
    for (let k = 0; k < 1000; k++) c.swapHands();
    h.run(120);
    expect(c.ready).toBe(true);
    expect(h.host.netServer.connections().length).toBe(1);
    for (let k = 0; k < 40; k++) c.swapHands();
    h.run(200);
    expect(c.kick?.reason).toBe('protocol_error');
  }, 60_000);
});

// ====================================================================== the same thing in one tick

/** The host 'p' and a guest 'b', both on instant links, both ready and tracked (digests every tick). */
async function pair(spec: typeof LAND | typeof OWN_SEA, mode: 'creative' | 'survival'): Promise<{ r: OwnRun; a: HeadlessClient; b: HeadlessClient; h: NetHarness }> {
  const r = await ownWorld(spec, mode, {});
  await r.h.host.control({ type: 'openRoom' });
  const b = r.h.addClient('b', {}, { viewRadius: 3 });
  r.h.runUntil(() => b.ready && b.intents !== null, 30_000);
  r.h.track(r.c);
  r.h.track(b);
  return { r, a: r.c, b, h: r.h };
}

/** Both clients act (`act` sends), and the server gets both before its next tick: they apply in the same tick. */
function sameTick(h: NetHarness, act: () => void): void {
  h.clock.freeze();
  act();
  h.net.advanceBy(5);
  h.run(60);
}

function toasts(c: HeadlessClient): string[] {
  const out: string[] = [];
  const prev = c.onBatch;
  c.onBatch = (batch) => {
    prev?.(batch);
    for (const e of batch.private?.events ?? []) if (e.type === 'toast') out.push(e.message.key);
  };
  return out;
}

describe('package 7: two clients on the same thing in one tick', () => {
  it('the same face: the first block stands, the second is refused with the ordinary toast', async () => {
    const { r, a, b, h } = await pair(LAND, 'creative');
    const sim = r.sim;
    sim.players.get('b')!.teleport(3.5, T, 0.5);
    sim.world.setCell(2, T, -2, makeCell(B.STONE));
    h.run(800);
    a.hold(B.PLANKS_OAK);
    b.hold(B.GLASS);
    a.waitAck();
    b.waitAck();
    expect(a.aimAt(2, T, -2, PY)).toBe(true);
    expect(b.aimAt(2, T, -2, PY)).toBe(true);
    a.waitLook();
    b.waitLook();
    const ta = toasts(a);
    const tb = toasts(b);
    sameTick(h, () => {
      expect(a.aimAt(2, T, -2, PY)).toBe(true);
      expect(b.aimAt(2, T, -2, PY)).toBe(true);
      a.use();
      b.use();
    });
    a.waitAck();
    b.waitAck();
    expect(sim.world.getCell(2, T + 1, -2) & ID_MASK).toBe(B.PLANKS_OAK);
    expect(sim.world.getCell(2, T + 2, -2) & ID_MASK).toBe(B.AIR);
    expect(ta).toEqual([]);
    expect(tb).toEqual(['toast.place.occupied']);
    h.quiesce();
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
  }, 60_000);

  it('the same block: it breaks once, the second click finds nothing (not the block behind it)', async () => {
    const { r, a, b, h } = await pair(LAND, 'creative');
    const sim = r.sim;
    sim.players.get('b')!.teleport(3.5, T, 0.5);
    sim.world.setCell(2, T, -2, makeCell(B.BRICKS));
    sim.world.setCell(2, T, -3, makeCell(B.BRICKS));
    h.run(800);
    a.emptyHand();
    b.emptyHand();
    a.waitAck();
    b.waitAck();
    let broken = 0;
    sim.events.on((e) => {
      if (e.type === 'blockBroken') broken++;
    });
    sameTick(h, () => {
      expect(a.aimAt(2, T, -2, PY, 0, true)).toBe(true);
      expect(b.aimAt(2, T, -2, PY, 0, true)).toBe(true);
      a.attack();
      b.attack();
    });
    a.waitAck();
    b.waitAck();
    expect(broken).toBe(1);
    expect(sim.world.getCell(2, T, -3) & ID_MASK).toBe(B.BRICKS);
    h.quiesce();
    expect([...a.mismatches, ...b.mismatches]).toEqual([]);
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
  }, 60_000);

  it('the same helm: one takes the wheel, the other is told someone else is at it', async () => {
    const { r, a, b, h } = await pair(OWN_SEA, 'creative');
    const sim = r.sim;
    const S = OWN_SEA_TOP;
    const helm = buildRaft(sim, { x0: 10, z0: 0, x1: 14, z1: 4, y: S - 1, helm: { x: 12, z: 2, facing: NZ } });
    const ship = assemble(sim, helm);
    sim.players.get('p')!.teleport(11.5, S, 3.5);
    sim.players.get('b')!.teleport(13.5, S, 3.5);
    h.run(1500);
    a.emptyHand();
    b.emptyHand();
    a.waitAck();
    b.waitAck();
    const tb = toasts(b);
    sameTick(h, () => {
      expect(a.aimAt(helm.x, helm.y, helm.z, undefined, ship.id)).toBe(true);
      expect(b.aimAt(helm.x, helm.y, helm.z, undefined, ship.id)).toBe(true);
      a.use();
      b.use();
    });
    a.waitAck();
    b.waitAck();
    expect(ship.helmsmanId).toBe(sim.players.get('p')!.entityId);
    expect(sim.players.get('b')!.player.steeringShipId).toBe(0);
    expect(tb).toEqual(['toast.helm.taken']);
    expect([...a.mismatches, ...b.mismatches]).toEqual([]);
  }, 60_000);

  it('the same drop: the nearer player, at equal distance the first to join, takes it; the inventories show it', async () => {
    const { r, a, b, h } = await pair(LAND, 'survival');
    const sim = r.sim;
    const pa = sim.players.get('p')!;
    const pb = sim.players.get('b')!;
    pa.teleport(0.5, T, 0.5);
    pb.teleport(2.1, T, 0.5);
    h.run(1000);
    const lamps = (c: HeadlessClient): number => c.inventory.count(B.LAMP);
    expect(lamps(a) + lamps(b)).toBe(0);
    const d = sim.entities.spawnItem(1.3, T + 0.3, 0.5, B.LAMP, 3, { x: 0, y: 0, z: 0 });
    d.pickupDelay = 0;
    h.run(500);
    expect(d.removed).toBe(true);
    expect(pa.player.inventory.count(B.LAMP)).toBe(3);
    expect(pb.player.inventory.count(B.LAMP)).toBe(0);
    h.runUntil(() => lamps(a) === 3, 2000, 1);
    expect(lamps(b)).toBe(0);
    expect([...a.mismatches, ...b.mismatches]).toEqual([]);
  }, 60_000);
});
