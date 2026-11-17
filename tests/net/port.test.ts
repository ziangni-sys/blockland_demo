/**
 * Package 8: PortTransport (NETCODE section 2, "房间里的积压", section 16 package 8): bytes are
 * transferred or copied, never shared; the close travels behind the messages; the backlog comes
 * from the forwarder's reports; and on a slow guest link the Replicator, reading that backlog,
 * defers the new interest without making must-send content wait more than about 0.1 s.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PortTransport, type PortBacklog, type PortLike } from '../../src/net/host/port';
import type { LoopbackNet } from '../../src/net/loopback';
import { MAX_UNRELIABLE_BYTES } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { Rng } from '../../src/core/rng';
import { NetHarness, RawClient } from './harness';

/** A MessagePort pair on the loopback's virtual clock; postMessage structured-clones and transfers like the real one. */
class FakePort implements PortLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  peer: FakePort | null = null;
  closed = false;
  constructor(private readonly net: LoopbackNet) {}
  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.closed) return;
    const data = structuredClone(message, { transfer });
    const peer = this.peer!;
    this.net.schedule(this.net.now, () => {
      if (!peer.closed) peer.onmessage?.({ data } as MessageEvent);
    });
  }
  close(): void {
    this.closed = true;
  }
}

function fakePorts(net: LoopbackNet): [FakePort, FakePort] {
  const a = new FakePort(net);
  const b = new FakePort(net);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function nextMessage(t: Transport): Promise<{ channel: Channel; bytes: Uint8Array }> {
  return new Promise((resolve) => {
    t.onMessage = (channel, bytes) => resolve({ channel, bytes });
  });
}

describe('PortTransport (package 8)', () => {
  it('over a real MessageChannel: the bytes arrive as a copy the receiver owns; the sender may reuse its array at once', async () => {
    const { port1, port2 } = new MessageChannel();
    const a = new PortTransport(port1);
    const b = new PortTransport(port2);
    const backing = new Uint8Array(64).fill(9);
    const view = backing.subarray(10, 20);
    view.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const got = nextMessage(b);
    a.send(UNRELIABLE, view);
    view.fill(0); // reused at once
    const m = await got;
    expect(m.channel).toBe(UNRELIABLE);
    expect([...m.bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(m.bytes.buffer.byteLength).toBe(10); // exactly the message, not the sender's buffer
    expect(backing.byteLength).toBe(64); // not detached
    // The receiver owns its array: writing to it changes nothing on the other side.
    m.bytes[0] = 99;
    const got2 = nextMessage(a);
    b.send(RELIABLE, m.bytes);
    expect((await got2).bytes[0]).toBe(99);
    // The close comes after the messages sent before it.
    const order: string[] = [];
    b.onMessage = (_c, bytes) => order.push(`m${bytes[0]}`);
    const closed = new Promise<string>((resolve) => {
      b.onClose = (reason) => resolve(reason);
    });
    a.send(RELIABLE, new Uint8Array([1]));
    a.send(UNRELIABLE, new Uint8Array([2]));
    a.close('bye now');
    a.send(RELIABLE, new Uint8Array([3])); // after close: nothing
    expect(await closed).toBe('bye now');
    expect(order).toEqual(['m1', 'm2']);
    expect(a.open).toBe(false);
    expect(b.open).toBe(false);
    expect(() => a.send(UNRELIABLE, new Uint8Array(MAX_UNRELIABLE_BYTES + 1))).toThrow(RangeError);
  });

  it('the backlog is the last report plus what was posted since the forwarder saw it; 0 without reports', () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const t = new PortTransport(ps);
    t.send(RELIABLE, new Uint8Array(1000));
    t.send(UNRELIABLE, new Uint8Array(100));
    expect(t.bufferedBytes(RELIABLE)).toBe(0);
    const report = (r: Omit<PortBacklog, 'kind'>): void => pf.postMessage({ kind: 'backlog', ...r }, []);
    report({ channel: RELIABLE, bufferedAmount: 600, seen: 1000 });
    h.run(1);
    expect(t.bufferedBytes(RELIABLE)).toBe(600);
    expect(t.bufferedBytes(UNRELIABLE)).toBe(0);
    t.send(RELIABLE, new Uint8Array(500));
    expect(t.bufferedBytes(RELIABLE)).toBe(1100);
    report({ channel: RELIABLE, bufferedAmount: 0, seen: 1500 });
    report({ channel: UNRELIABLE, bufferedAmount: 40, seen: 50 });
    h.run(1);
    expect(t.bufferedBytes(RELIABLE)).toBe(0);
    expect(t.bufferedBytes(UNRELIABLE)).toBe(90);
    // Malformed reports and unknown frames are ignored.
    pf.postMessage({ kind: 'backlog', channel: 7, bufferedAmount: 5, seen: 0 }, []);
    pf.postMessage({ kind: 'backlog', channel: RELIABLE, bufferedAmount: -1, seen: 0 }, []);
    pf.postMessage({ kind: 'what' }, []);
    pf.postMessage('hello', []);
    h.run(1);
    expect(t.bufferedBytes(RELIABLE)).toBe(0);
    expect(t.open).toBe(true);
  });

  it('a slow guest link: snapshots are deferred, the batches (must-send content) never wait more than about 0.1 s', async () => {
    const withReports = await slowJoin(true);
    const blind = await slowJoin(false);
    // With the reports: every batch starts going out within ~0.1 s.
    expect(withReports.maxWaitMs).toBeLessThan(100);
    // All the snapshots arrived, paced by the link (about 260 KB at 256 KB/s), not dropped.
    expect(withReports.readyMs).toBeGreaterThan(1000);
    expect(withReports.columns).toBe(blind.columns);
    // Without them (bufferedBytes is 0) the same join puts 0.3 s of snapshots in front of the batches.
    expect(blind.maxWaitMs).toBeGreaterThan(250);
  });
});

interface Queued {
  channel: Channel;
  bytes: Uint8Array;
  enqueued: number;
  start: number;
  finish: number;
}

/**
 * The host page's forwarder of one guest (package 10's side, simulated): it takes the server's
 * frames from the port, sends them over a data channel of `bandwidth` bytes per second (one queue
 * for both channels), delivers them to the guest's transport, and reports the backlog on
 * 'bufferedamountlow' (queue empty) and every 100 ms.
 */
class Forwarder {
  readonly seen: [number, number] = [0, 0];
  private queue: Queued[] = [];
  private lastFinish = 0;
  maxWait = 0;
  waits: number[] = [];
  readonly client: Transport;

  constructor(
    private readonly net: LoopbackNet,
    private readonly port: FakePort,
    private readonly bandwidth: number,
    private readonly reports: boolean,
  ) {
    const self = this;
    this.client = {
      open: true,
      onMessage: null,
      onClose: null,
      send(channel: Channel, bytes: Uint8Array): void {
        const copy = bytes.slice();
        self.port.postMessage({ kind: 'msg', channel, data: copy.buffer }, [copy.buffer]);
      },
      bufferedBytes: () => 0,
      close(): void {},
    };
    port.onmessage = (ev) => {
      const f = ev.data as { kind: string; channel: Channel; data: ArrayBuffer };
      if (f.kind === 'msg') this.enqueue(f.channel, new Uint8Array(f.data));
    };
    if (reports) {
      // A first report as soon as the port is connected: the server then knows from its first
      // batch on that this connection's backlog is reported (see the report on section 2).
      this.report();
      this.tick();
    }
  }

  private enqueue(channel: Channel, bytes: Uint8Array): void {
    this.seen[channel] += bytes.length;
    const now = this.net.now;
    const start = Math.max(now, this.lastFinish);
    const finish = start + (bytes.length * 1000) / this.bandwidth;
    this.lastFinish = finish;
    const q: Queued = { channel, bytes, enqueued: now, start, finish };
    this.queue.push(q);
    if (channel === RELIABLE) {
      this.waits.push(start - now);
      this.maxWait = Math.max(this.maxWait, start - now);
    }
    this.net.schedule(finish, () => {
      this.queue.splice(this.queue.indexOf(q), 1);
      this.client.onMessage?.(channel, bytes);
      if (this.queue.length === 0 && this.reports) this.report();
    });
  }

  private buffered(channel: Channel): number {
    const now = this.net.now;
    let n = 0;
    for (const q of this.queue) {
      if (q.channel !== channel) continue;
      n += q.start >= now ? q.bytes.length : Math.ceil((q.bytes.length * (q.finish - now)) / (q.finish - q.start));
    }
    return n;
  }

  private report(): void {
    for (const ch of [RELIABLE, UNRELIABLE] as const) {
      this.port.postMessage({ kind: 'backlog', channel: ch, bufferedAmount: this.buffered(ch), seen: this.seen[ch] } satisfies PortBacklog, []);
    }
  }

  private tick(): void {
    this.net.schedule(this.net.now + 100, () => {
      this.report();
      this.tick();
    });
  }
}

/** A guest joins a world of 121 modified columns over a 256 KB/s link while a block changes next to it every tick. */
async function slowJoin(reports: boolean): Promise<{ maxWaitMs: number; readyMs: number; columns: number }> {
  const h = new NetHarness({ chunkColumns: 200 });
  await h.create();
  h.addClient('host', {}, { local: true, viewRadius: 6 });
  h.run(3000);
  const sim = h.sim;
  const rng = new Rng(5);
  const ids = [B.STONE, B.DIRT, B.COBBLE, B.PLANKS_OAK, B.GLASS, B.LOG_OAK];
  for (let cx = -5; cx <= 5; cx++) {
    for (let cz = -5; cz <= 5; cz++) {
      for (let i = 0; i < 1500; i++) sim.world.setCell(cx * 16 + rng.int(0, 15), 5 + rng.int(0, 39), cz * 16 + rng.int(0, 15), makeCell(ids[rng.int(0, ids.length - 1)]!));
    }
  }
  h.run(200);
  await h.host.control({ type: 'openRoom' });
  const [ps, pf] = fakePorts(h.net);
  const fwd = new Forwarder(h.net, pf, 256 * 1024, reports);
  h.host.connect(new PortTransport(ps), false);
  const guest = new RawClient('guest', fwd.client);
  h.clients.push(guest);
  guest.hello({ viewRadius: 5 });
  const start = h.net.now;
  let readyAt = -1;
  for (let i = 0; i < 600 && readyAt < 0; i++) {
    sim.world.setCell(1, 6, 1, makeCell(i % 2 === 0 ? B.GLASS : B.STONE));
    h.run(50);
    guest.applyAll();
    if (guest.replica !== null && h.host.replicator.clientView('guest')!.pendingColumns === 0 && guest.backlog === 0) readyAt = h.net.now;
  }
  expect(readyAt).toBeGreaterThan(0);
  h.run(2000);
  guest.applyAll();
  expect(h.compareNow(guest, false)).toEqual([]);
  return { maxWaitMs: fwd.maxWait, readyMs: readyAt - start, columns: guest.replica!.world.chunks.size };
}
