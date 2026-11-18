/**
 * Package 13: the server's limits per connection (docs/NETCODE.md section 13 "服务器对每个客户端的
 * 限制"), each against a misbehaving client: the bytes a guest may send, the movement reports the
 * server takes in per tick, Aim bursts, item drops, view radius changes, and joins per minute. A
 * client past a limit is slowed or kicked with the right reason, and the others go on unharmed:
 * every tick's batch reaches them while one floods.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { CLIENT_BURST_BYTES, CLIENT_RATE_BYTES, JOINS_PER_KEY_PER_MINUTE, MAX_REPORTED_RTT_MS, PONG_INTERVAL_MS, VIEW_RADIUS_INTERVAL_TICKS, type MoveReportMsg, type Target } from '../../src/net/protocol';
import { IntentQueue } from '../../src/net/server/intents';
import { MoveQueue, QUEUE_LIMIT } from '../../src/net/server/moves';
import { ItemEntity } from '../../src/entities/entity';
import { link, NetHarness, type HeadlessClient, type RawClient } from './harness';

async function room(): Promise<NetHarness> {
  const h = new NetHarness();
  await h.create();
  h.host.setRoomOpen(true);
  return h;
}

function report(seq: number): MoveReportMsg {
  return { type: 'moveReport', seq, epoch: 1, viewTick: 0, carrierId: 0, pos: { x: 0.5, y: 4, z: 0.5 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, sneaking: false, sprinting: false, flying: false, forward: 0, strafe: 0, sneak: false, landings: 0 };
}

/** Every `everyMs`, `n` movement reports from `c` (sequence numbers going up), until it is closed. */
function flood(h: NetHarness, c: RawClient, n: number, everyMs: number): { sent: number } {
  const out = { sent: 0 };
  let seq = 1;
  const go = (): void => {
    if (c.closed) return;
    for (let i = 0; i < n; i++) c.send(report(seq++));
    out.sent += n;
    h.net.schedule(h.net.now + everyMs, go);
  };
  go();
  return out;
}

function movesOf(h: NetHarness): MoveQueue {
  const m = h.sinks!.moves;
  if (!(m instanceof MoveQueue)) throw new Error('default sinks expected');
  return m;
}

/** The ticks of the batches a client applied, from now on. */
function batchTicks(c: HeadlessClient): number[] {
  const ticks: number[] = [];
  const prev = c.onBatch;
  c.onBatch = (b) => {
    prev?.(b);
    ticks.push(b.tick);
  };
  return ticks;
}

describe('limits per connection (package 13)', () => {
  it('a guest flooding movement reports is kicked (protocol_error) once its byte budget is spent; the server takes in at most QUEUE_LIMIT a tick from it; the other guests get every batch', async () => {
    const h = await room();
    const host = h.addClient('host', {}, { local: true });
    const g1 = h.addClient('g1', { up: link(30), down: link(30) });
    const g2 = h.addClient('g2', { up: link(30), down: link(30) });
    h.runUntil(() => host.ready && g1.ready && g2.ready);
    const f = h.addRawClient('f');
    h.run(200);
    expect(f.welcome).not.toBeNull();
    const t1 = batchTicks(g1);
    const t2 = batchTicks(g2);
    const from = h.sim.ticks;
    const moves = movesOf(h);
    let taken = moves.stats('f')!.received;
    let most = 0;
    h.onTick = () => {
      const st = moves.stats('f');
      if (st === null) return;
      most = Math.max(most, st.received - taken);
      taken = st.received;
    };
    // 20 reports every 5 ms: 4000 a second, about 290 KB/s of cost against a budget of 16 KB/s.
    const sent = flood(h, f, 20, 5);
    h.runUntil(() => f.closed, 5000);
    const kickedAt = h.sim.ticks;
    expect(f.kick?.reason).toBe('protocol_error');
    // It got about CLIENT_BURST_BYTES through before the budget ran out (73 bytes of cost a report).
    expect(sent.sent * 73).toBeGreaterThan(CLIENT_BURST_BYTES);
    expect(sent.sent * 73).toBeLessThan(2 * CLIENT_BURST_BYTES);
    h.run(1000);
    // What reached the movement queue: the newest QUEUE_LIMIT of each tick, never the flood.
    expect(most).toBe(QUEUE_LIMIT);
    expect(kickedAt - from).toBeLessThan(20);
    // The others: a batch for every tick, none missing, both still in.
    const to = h.sim.ticks - 2;
    for (const ticks of [t1, t2]) {
      const seen = new Set(ticks);
      for (let t = from + 2; t <= to; t++) expect(seen.has(t), `batch of tick ${t}`).toBe(true);
    }
    expect(g1.kick).toBeNull();
    expect(g2.kick).toBeNull();
    expect(h.sim.players.get('f')).toBeUndefined();
  });

  it('a burst within the budget (a link back after a stall) is taken; only the newest QUEUE_LIMIT reports of a tick reach the movement queue', async () => {
    const h = await room();
    const f = h.addRawClient('f');
    h.run(200);
    const moves = movesOf(h);
    const before = moves.stats('f')!.received;
    // 1200 reports at once: about 88 KB of cost, below CLIENT_BURST_BYTES.
    for (let i = 1; i <= 1200; i++) f.send(report(i));
    h.ticks(2);
    expect(f.kick).toBeNull();
    expect(moves.stats('f')!.received - before).toBe(QUEUE_LIMIT);
    // Sending steadily just below the rate is never kicked.
    const steady = flood(h, f, 10, Math.ceil((10 * 73 * 1000) / (0.9 * CLIENT_RATE_BYTES)));
    h.run(20_000);
    expect(f.kick).toBeNull();
    expect(steady.sent).toBeGreaterThan(2000);
  });

  it('a burst of Aims is checked once: only the last of consecutive Aims is checked', async () => {
    const h = await room();
    const f = h.addRawClient('f');
    h.run(200);
    const intents = h.sinks!.intents as IntentQueue;
    // Out of reach: every check would fail and count.
    const far: Target = { gridId: 0, x: 400, y: 3, z: 400, face: 2, sub: 0, cell: 0 };
    for (let i = 1; i <= 300; i++) f.send({ type: 'aim', seq: i, moveSeq: 0, use: far, mine: far });
    h.ticks(2);
    const st = intents.stats('f')!;
    expect(st.applied).toBe(300);
    expect(st.failed.grid + st.failed.cell + st.failed.ray + st.failed.reach).toBeLessThanOrEqual(2);
    expect(f.kick).toBeNull();
  });

  it('item drops are paced like presses: one a tick, however many a client sends at once', async () => {
    const h = await room();
    const f = h.addRawClient('f');
    h.run(200);
    let seq = 1;
    for (let i = 0; i < 8; i++) {
      f.send({ type: 'creativePick', seq: seq++, item: B.COBBLE, shift: false });
      f.send({ type: 'dropCursor', seq: seq++ });
    }
    const items = (): number => h.sim.entities.all().filter((e) => e instanceof ItemEntity).length;
    const dropped = (): number => h.sim.entities.all().reduce((n, e) => n + (e instanceof ItemEntity ? e.stack.count : 0), 0) / 64;
    const counts: number[] = [];
    for (let t = 0; t < 10; t++) {
      h.ticks(1);
      counts.push(items());
    }
    // One new drop a tick (merged stacks could only lower the count), eight in all.
    expect(counts[0]).toBe(1);
    for (let i = 1; i < counts.length; i++) expect(counts[i]! - counts[i - 1]!).toBeLessThanOrEqual(1);
    expect(dropped()).toBe(8);
    expect(intents(h).stats('f')!.applied).toBe(16);
  });

  it(`a client changing its view radius every tick: it takes effect at most once in ${VIEW_RADIUS_INTERVAL_TICKS} ticks, the newest value last`, async () => {
    const h = await room();
    const f = h.addRawClient('f');
    h.run(200);
    const ctrl = h.sim.players.get('f')!;
    let seq = 1;
    const radii: number[] = [];
    for (let t = 0; t < 60; t++) {
      f.send({ type: 'setViewRadius', seq: seq++, radius: t % 2 === 0 ? 6 : 1 });
      h.ticks(1);
      radii.push(ctrl.viewRadius);
    }
    let changes = 0;
    for (let i = 1; i < radii.length; i++) if (radii[i] !== radii[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(Math.ceil(60 / VIEW_RADIUS_INTERVAL_TICKS));
    f.send({ type: 'setViewRadius', seq: seq++, radius: 4 });
    h.ticks(VIEW_RADIUS_INTERVAL_TICKS + 1);
    expect(ctrl.viewRadius).toBe(4);
  });

  it(`a Ping flood within the byte budget gets one Pong in ${PONG_INTERVAL_MS} ms; a round trip past ${MAX_REPORTED_RTT_MS} ms is clamped`, async () => {
    const h = await room();
    const c = h.addRawClient('p');
    h.run(500);
    expect(c.welcome).not.toBeNull();
    const t0 = h.sim.ticks;
    const before = c.pongs.length;
    // 35 Pings every 50 ms: 700 a second, about 10 KB/s of budget (within CLIENT_RATE_BYTES).
    let n = 0;
    const go = (): void => {
      if (c.closed || n >= 200) return;
      for (let i = 0; i < 35; i++) c.send({ type: 'ping', clientMs: n, rttMs: 2 ** 40 });
      n++;
      h.net.schedule(h.net.now + 50, go);
    };
    go();
    h.run(10_000);
    expect(c.closed).toBe(false);
    expect(c.pongs.length - before).toBeLessThanOrEqual(h.sim.ticks - t0 + 1);
    expect(c.pongs.length - before).toBeGreaterThan(150);
    expect(h.host.netServer.traffic().find((t) => t.key === 'p')!.rttMs).toBe(MAX_REPORTED_RTT_MS);
  }, 60_000);

  it(`an identity reconnecting in a loop joins at most ${JOINS_PER_KEY_PER_MINUTE} times a minute; the next connection waits, unjoined, then joins`, async () => {
    const h = await room();
    const conns: RawClient[] = [];
    for (let i = 0; i < JOINS_PER_KEY_PER_MINUTE + 1; i++) {
      conns.push(h.addRawClient('k'));
      h.run(200);
    }
    for (let i = 0; i < JOINS_PER_KEY_PER_MINUTE; i++) expect(conns[i]!.welcome, `connection ${i}`).not.toBeNull();
    for (let i = 0; i < JOINS_PER_KEY_PER_MINUTE; i++) expect(conns[i]!.kick?.reason, `connection ${i}`).toBe('replaced');
    const last = conns.at(-1)!;
    expect(last.welcome).toBeNull();
    expect(last.closed).toBe(false);
    h.run(55_000);
    expect(last.welcome).toBeNull(); // the minute since the first join is not over
    h.run(6000);
    expect(last.welcome).not.toBeNull();
    expect(h.sim.players.get('k')?.online).toBe(true);
  }, 60_000);

  it('a client cycling identities holds nobody else: an honest guest whose link blipped is back at once; the host is never held', async () => {
    // With a count across all guests (20 a minute), 20 identities joined and left in 40 s kept an
    // honest guest's reconnect out of the world for 19 s.
    const h = await room();
    const honest = h.addRawClient('honest');
    h.run(500);
    expect(honest.welcome).not.toBeNull();
    for (let i = 0; i < 30; i++) {
      const x = h.addRawClient(`x${i}`);
      h.run(300);
      expect(x.welcome, `identity ${i}`).not.toBeNull();
      x.bye();
      h.run(300);
    }
    honest.drop();
    h.run(200);
    const back = h.addRawClient('honest');
    const own = h.addRawClient('own', {}, { local: true });
    h.run(500);
    expect(back.welcome).not.toBeNull();
    expect(h.sim.players.get('honest')?.online).toBe(true);
    expect(own.welcome).not.toBeNull();
  }, 60_000);
});

function intents(h: NetHarness): IntentQueue {
  return h.sinks!.intents as IntentQueue;
}
