/**
 * Package 8: leaving (NETCODE section 3 "离开", "掉线", the replacement rule) and the seams of
 * packages 6 and 7: Bye, a dropped transport, the 75 s timeout (not for the host's own
 * connection), replacement (Kick(replaced); the old connection's late close, messages and
 * silence change nothing), too slow, and what NetServer hands to MoveSink and IntentSink.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PZ } from '../../src/core/dirs';
import { droppingSinks, type ServerSinks } from '../../src/net/host/host';
import { createLoopbackPair } from '../../src/net/loopback';
import { CONNECTION_TIMEOUT_MS, MAX_BACKLOG, type IntentMessage, type NetMoveReport } from '../../src/net/protocol';
import type { Channel, Transport } from '../../src/net/transport';
import type { PlayerKey } from '../../src/sim/view';
import { Ship } from '../../src/structures/structure';
import { INSTANT, NetHarness, RawClient } from './harness';

async function room(sinks?: () => ServerSinks): Promise<NetHarness> {
  const h = new NetHarness(sinks !== undefined ? { sinks } : {});
  await h.create();
  h.host.setRoomOpen(true);
  return h;
}

/** A server-side transport that keeps calling the callbacks it was first given (a transport that reports late). */
class StickyTransport implements Transport {
  private msg: Transport['onMessage'] = null;
  private closeFn: Transport['onClose'] = null;
  backlog = 0;
  constructor(private readonly inner: Transport) {
    inner.onMessage = (ch, b) => this.msg?.(ch, b);
    inner.onClose = (r) => this.closeFn?.(r);
  }
  get open(): boolean {
    return this.inner.open;
  }
  get onMessage(): Transport['onMessage'] {
    return this.msg;
  }
  set onMessage(f: Transport['onMessage']) {
    if (f !== null) this.msg = f;
  }
  get onClose(): Transport['onClose'] {
    return this.closeFn;
  }
  set onClose(f: Transport['onClose']) {
    if (f !== null) this.closeFn = f;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.backlog + this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
  /** What a late transport would do: report a close (and a message) after the server closed it. */
  lateClose(): void {
    this.closeFn?.('late');
  }
  lateMessage(ch: Channel, b: Uint8Array): void {
    this.msg?.(ch, b);
  }
}

function addSticky(h: NetHarness, key: PlayerKey, local = false): { c: RawClient; t: StickyTransport } {
  const pair = createLoopbackPair(h.net, INSTANT, INSTANT);
  const t = new StickyTransport(pair.server);
  const c = new RawClient(key, pair.client);
  h.host.connect(t, local);
  c.hello();
  return { c, t };
}

describe('leaving (package 8)', () => {
  it('Bye: the player leaves at the next tick; the others see it go from the table and the entity stream', async () => {
    const h = await room();
    const a = h.addClient('a', {}, { local: true });
    const b = h.addClient('b');
    h.run(200);
    const idB = h.sim.players.get('b')!.entityId;
    expect(a.replica!.players.has(idB)).toBe(true);
    expect(a.replica!.entities.has(idB)).toBe(true);
    b.bye();
    h.run(100);
    expect(h.sim.players.get('b')).toBeUndefined();
    expect(h.sim.players.keys()).toContain('b'); // the record stays
    expect(a.replica!.players.has(idB)).toBe(false);
    expect(a.replica!.entities.has(idB)).toBe(false);
    expect(h.host.netServer.playerCount).toBe(1);
  });

  it('a dropped transport (no Bye) is a leave; a helmsman lets go within one tick', async () => {
    const h = await room();
    h.addClient('a', {}, { local: true });
    const g = h.addClient('g');
    h.run(200);
    const sim = h.sim;
    const ctrl = sim.players.get('g')!;
    for (let x = 0; x <= 2; x++) for (let z = 0; z <= 3; z++) sim.world.setCell(x, 4, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(1, 5, 1, makeCell(B.HELM, facingState(NZ)));
    ctrl.teleport(1.5, 5, 3.5);
    h.run(200);
    ctrl.emptyHand();
    for (let i = 0; i < 2; i++) {
      expect(ctrl.aimAt(1, 5, 1, PZ, 0)).toBe(true);
      ctrl.use();
      const t = sim.ticks;
      h.runUntil(() => sim.ticks > t, 1000, 1);
    }
    const ship = sim.structures.ships()[0] as Ship;
    expect(ship.helmsmanId).toBe(ctrl.entityId);
    ship.throttle = 1;
    g.drop();
    const t = sim.ticks;
    h.runUntil(() => sim.ticks > t, 1000, 1);
    expect(sim.players.get('g')).toBeUndefined();
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
  });

  it('75 s without a message is a leave (Kick(timeout)); a pinging guest and the host\'s own connection stay', async () => {
    const h = await room();
    const host = h.addClient('host', {}, { local: true });
    const quiet = h.addClient('quiet');
    const pinger = h.addClient('pinger');
    h.run(200);
    for (let s = 0; s < 80; s++) {
      pinger.send({ type: 'ping', clientMs: s });
      h.run(1000);
      if (s === 70) expect(quiet.kick).toBeNull();
    }
    expect(quiet.kick?.reason).toBe('timeout');
    expect(h.sim.players.get('quiet')).toBeUndefined();
    expect(pinger.kick).toBeNull();
    expect(host.kick).toBeNull();
    expect(h.sim.players.get('host')).toBeDefined();
    expect(pinger.pongs.length).toBe(80);
    // A connection that never says Hello goes the same way.
    const mute = h.addClient('mute', {}, { hello: false });
    h.run(CONNECTION_TIMEOUT_MS + 100);
    expect(mute.refuse?.reason).toBe('bad_hello');
    expect(mute.closed).toBe(true);
  });

  it('replacement: the old connection gets Kick(replaced); the player rejoins for the new one; the old one\'s late close, messages and silence change nothing', async () => {
    const h = await room();
    h.addClient('host', {}, { local: true });
    const { c: old, t: oldT } = addSticky(h, 'a');
    h.run(200);
    const ctrl = h.sim.players.get('a')!;
    const id = ctrl.entityId;
    ctrl.teleport(5.5, 4, 9.5);
    h.run(100);
    const fresh = h.addClient('a');
    h.run(1);
    expect(old.kick?.reason).toBe('replaced');
    expect(old.closed).toBe(true);
    expect(h.sim.players.get('a')).toBe(ctrl); // until the next tick
    h.run(100);
    const now = h.sim.players.get('a')!;
    expect(now).not.toBe(ctrl);
    expect(now.entityId).toBe(id);
    expect(now.player.pos.x).toBeCloseTo(5.5, 6);
    expect(now.player.pos.z).toBeCloseTo(9.5, 6);
    expect(fresh.welcome?.entityId).toBe(id);
    expect(fresh.readyTick).not.toBeNull();
    // The old transport reports a close and a Bye late: ignored.
    oldT.lateMessage(0, new Uint8Array([0x02]));
    oldT.lateClose();
    h.run(100);
    expect(h.sim.players.get('a')).toBe(now);
    expect(fresh.kick).toBeNull();
    // Long after: the old connection's silence is no timeout of the new one.
    for (let s = 0; s < 80; s++) {
      fresh.send({ type: 'ping', clientMs: s });
      h.run(1000);
    }
    expect(h.sim.players.get('a')).toBe(now);
  });

  it('a replaced connection that had not joined yet is simply dropped', async () => {
    const h = await room();
    const a1 = h.addClient('a');
    const a2 = h.addClient('a');
    h.run(100);
    expect(a1.kick?.reason).toBe('replaced');
    expect(a1.welcome).toBeNull();
    expect(a2.welcome).not.toBeNull();
    expect(h.sim.players.online()).toHaveLength(1);
  });

  it('too slow: a reliable backlog above MAX_BACKLOG for 10 s kicks the client', async () => {
    const h = await room();
    h.addClient('host', {}, { local: true });
    const { c, t } = addSticky(h, 'slow');
    h.run(200);
    t.backlog = MAX_BACKLOG + 1;
    h.run(9000);
    expect(c.kick).toBeNull();
    h.run(1200);
    expect(c.kick?.reason).toBe('too_slow');
    expect(h.sim.players.get('slow')).toBeUndefined();
  });

  it('the seams: reports then intents, in arrival order, after joins; acks reach the private section; leave before sim.leave', async () => {
    const calls: string[] = [];
    let moveAck: number | null = null;
    let intentAck: number | null = null;
    const h = await room(() => {
      const s = droppingSinks();
      s.moves = {
        join: (k) => calls.push(`moves.join ${k}`),
        leave: (k) => calls.push(`moves.leave ${k}`),
        receive: (k, r: NetMoveReport) => calls.push(`moves.receive ${k} ${r.seq}`),
        beforeTick: () => calls.push('moves.beforeTick'),
        moveAck: () => moveAck,
      };
      s.intents = {
        join: (k, host) => calls.push(`intents.join ${k} ${host}`),
        leave: (k) => calls.push(`intents.leave ${k}`),
        receive: (k, m: IntentMessage) => calls.push(`intents.receive ${k} ${m.type} ${'seq' in m ? m.seq : ''}`) > 0,
        beforeTick: () => calls.push('intents.beforeTick'),
        intentAck: () => intentAck,
      };
      return s;
    });
    const a = h.addClient('a', {}, { local: true });
    const report = (seq: number): void =>
      a.send({ type: 'moveReport', seq, epoch: 1, viewTick: 0, carrierId: 0, pos: { x: 0.5, y: 4, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false, flying: false, forward: 0, strafe: 0, sneak: false, landings: 0 });
    // Sent before the first tick (before the join): queued and handed over after it.
    a.send({ type: 'selectSlot', seq: 1, slot: 2 });
    report(1);
    a.send({ type: 'swapHands', seq: 2 });
    report(2);
    const t = h.sim.ticks;
    h.runUntil(() => h.sim.ticks > t, 1000, 1);
    expect(calls).toEqual([
      'moves.join a',
      'intents.join a true',
      'moves.receive a 1',
      'moves.receive a 2',
      'intents.receive a selectSlot 1',
      'intents.receive a swapHands 2',
      'moves.beforeTick',
      'intents.beforeTick',
    ]);
    moveAck = 7;
    intentAck = 2;
    h.run(60);
    expect(a.replica!.private.moveAck).toBe(7);
    expect(a.replica!.private.ack).toBe(2);
    calls.length = 0;
    a.bye();
    const t2 = h.sim.ticks;
    h.runUntil(() => h.sim.ticks > t2, 1000, 1);
    expect(calls).toEqual(['moves.leave a', 'intents.leave a', 'moves.beforeTick', 'intents.beforeTick']);
  });
});
