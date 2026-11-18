/**
 * Package 10: the host page's forwarder (client/forward.ts) between a guest's link and the server's
 * PortTransport (NETCODE sections 1 and 2 "房间里的积压"): bytes unchanged both ways, the close
 * either way, the backlog reports; and on a slow guest link (the harness's bandwidth-limited
 * loopback link standing in for a data channel the test cannot throttle) the Replicator, reading
 * the forwarded backlog, defers the new interest while the must-send batches go out within about
 * 0.1 s.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { BACKLOG_REPORT_MS, PortForwarder, type ForwardedLink } from '../../src/client/forward';
import { PortTransport, type PortBacklog } from '../../src/net/host/port';
import { createLoopbackPair, type LoopbackNet } from '../../src/net/loopback';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { BUFFERED_LOW_BYTES } from '../../src/net/webrtc/transport';
import { fakePorts } from './fakeport';
import { netTimers } from './fakertc';
import { INSTANT, NetHarness } from './harness';


/** A scripted guest link: records what the forwarder sends, reports the backlog the test sets. */
class ScriptedLink implements ForwardedLink {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  onBufferedLow: ((channel: Channel) => void) | null = null;
  readonly sent: Array<{ channel: Channel; bytes: Uint8Array }> = [];
  readonly backlog: [number, number] = [0, 0];
  open = true;
  closedWith: string | null = null;
  send(channel: Channel, bytes: Uint8Array): void {
    if (this.open) this.sent.push({ channel, bytes: bytes.slice() });
  }
  bufferedBytes(channel: Channel): number {
    return this.backlog[channel];
  }
  close(reason = 'closed'): void {
    this.open = false;
    this.closedWith = reason;
  }
}

/**
 * The server end of a harness loopback link as a guest's data channel at the host: the backlog is
 * the link's byte queue, and 'bufferedamountlow' is emulated (checked every millisecond of virtual
 * time). Records how long each reliable message waits behind the queue before it starts going out.
 */
class LoopbackLink implements ForwardedLink {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  onBufferedLow: ((channel: Channel) => void) | null = null;
  readonly waits: number[] = [];
  /** Bytes sent down the link. */
  bytes = 0;
  private wasHigh: [boolean, boolean] = [false, false];
  constructor(
    private readonly net: LoopbackNet,
    private readonly inner: Transport,
    private readonly bandwidth: number,
    /** false: report a backlog of 0 (a forwarder that cannot see the data channel). */
    private readonly seesBacklog: boolean,
  ) {
    inner.onMessage = (ch, b) => this.onMessage?.(ch, b);
    inner.onClose = (r) => this.onClose?.(r);
    const poll = (): void => {
      if (!inner.open) return;
      for (const ch of [RELIABLE, UNRELIABLE] as const) {
        const high = inner.bufferedBytes(ch) > BUFFERED_LOW_BYTES;
        if (this.wasHigh[ch] && !high) this.onBufferedLow?.(ch);
        this.wasHigh[ch] = high;
      }
      net.schedule(net.now + 1, poll);
    };
    poll();
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    if (channel === RELIABLE) this.waits.push(((this.inner.bufferedBytes(RELIABLE) + this.inner.bufferedBytes(UNRELIABLE)) * 1000) / this.bandwidth);
    this.bytes += bytes.length;
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.seesBacklog ? this.inner.bufferedBytes(channel) : 0;
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

describe('PortForwarder (package 10)', () => {
  it("a guest's bytes reach the server unchanged, and the server's reach the guest; exactly each message's bytes are transferred", () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const server = new PortTransport(ps);
    const fromGuest: Array<{ channel: Channel; bytes: Uint8Array }> = [];
    server.onMessage = (channel, bytes) => fromGuest.push({ channel, bytes });
    const link = new ScriptedLink();
    const fwd = new PortForwarder(pf, link, netTimers(h.net));
    // A reliable message that is a view in the middle of a fragment buffer, an unreliable whole buffer.
    const fragment = new Uint8Array([0, 11, 12, 13, 99]);
    link.onMessage!(RELIABLE, fragment.subarray(1, 4));
    link.onMessage!(UNRELIABLE, new Uint8Array([21, 22]));
    h.net.advanceBy(1);
    expect(fromGuest.map((m) => [m.channel, [...m.bytes], m.bytes.buffer.byteLength])).toEqual([
      [RELIABLE, [11, 12, 13], 3],
      [UNRELIABLE, [21, 22], 2],
    ]);
    server.send(RELIABLE, new Uint8Array([1, 2, 3]));
    server.send(UNRELIABLE, new Uint8Array([4]));
    h.net.advanceBy(1);
    expect(link.sent.map((m) => [m.channel, [...m.bytes]])).toEqual([
      [RELIABLE, [1, 2, 3]],
      [UNRELIABLE, [4]],
    ]);
    expect([fwd.forwarded(RELIABLE), fwd.forwarded(UNRELIABLE)]).toEqual([3, 1]);
  });

  it(`reports the backlog at once, every ${BACKLOG_REPORT_MS} ms and when a channel drains; the server's backlog follows`, () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const server = new PortTransport(ps);
    const link = new ScriptedLink();
    new PortForwarder(pf, link, netTimers(h.net));
    const reports = (): PortBacklog[] => pf.posted.filter((f): f is PortBacklog => (f as PortBacklog).kind === 'backlog');
    // At once, for both channels, before anything was sent (section 18).
    expect(reports().map((r) => [r.channel, r.bufferedAmount, r.seen])).toEqual([
      [RELIABLE, 0, 0],
      [UNRELIABLE, 0, 0],
    ]);
    h.net.advanceBy(1);
    server.send(RELIABLE, new Uint8Array(5000));
    // Not seen yet by the forwarder: all of it counts.
    expect(server.bufferedBytes(RELIABLE)).toBe(5000);
    h.net.advanceBy(1);
    link.backlog[RELIABLE] = 4000;
    h.net.advanceBy(BACKLOG_REPORT_MS);
    expect(reports().length).toBe(4);
    expect(server.bufferedBytes(RELIABLE)).toBe(4000);
    // A drained channel is reported at once, not at the next tick of the timer.
    link.backlog[RELIABLE] = 0;
    link.onBufferedLow!(RELIABLE);
    h.net.advanceBy(1);
    expect(reports().length).toBe(5);
    expect(server.bufferedBytes(RELIABLE)).toBe(0);
    h.net.advanceBy(10 * BACKLOG_REPORT_MS);
    expect(reports().length).toBe(5 + 20);
  });

  it('the guest closing: the server gets the close behind the messages forwarded before it; the forwarder stops reporting', () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const server = new PortTransport(ps);
    const order: string[] = [];
    server.onMessage = (_c, b) => order.push(`m${b[0]}`);
    server.onClose = (r) => order.push(`close:${r}`);
    const link = new ScriptedLink();
    const fwd = new PortForwarder(pf, link, netTimers(h.net));
    let ended: string | null = null;
    fwd.onEnd = (r) => (ended = r);
    link.onMessage!(RELIABLE, new Uint8Array([7]));
    link.onClose!('ice_failed');
    h.net.advanceBy(1);
    expect(order).toEqual(['m7', 'close:ice_failed']);
    expect(ended).toBe('ice_failed');
    expect(fwd.open).toBe(false);
    const n = pf.posted.length;
    h.net.advanceBy(1000);
    expect(pf.posted.length).toBe(n);
  });

  it("the server closing (a Refuse, a Kick): what it sent goes out first, then the guest's link is closed", () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const server = new PortTransport(ps);
    const link = new ScriptedLink();
    const fwd = new PortForwarder(pf, link, netTimers(h.net));
    server.send(RELIABLE, new Uint8Array([0x82, 3, 0]));
    server.close('refused');
    h.net.advanceBy(1);
    expect(link.sent.map((m) => [...m.bytes])).toEqual([[0x82, 3, 0]]);
    expect(link.closedWith).toBe('refused');
    expect(fwd.open).toBe(false);
    expect(pf.closed).toBe(true);
  });

  it('frames that are not frames are ignored; a message the link refuses closes both sides', () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const server = new PortTransport(ps);
    let serverClosed: string | null = null;
    server.onClose = (r) => (serverClosed = r);
    const link = new ScriptedLink();
    link.send = () => {
      throw new RangeError('too long');
    };
    new PortForwarder(pf, link, netTimers(h.net));
    ps.postMessage({ kind: 'msg', channel: 5, data: new ArrayBuffer(1) }, []);
    ps.postMessage({ kind: 'msg', channel: RELIABLE, data: 'text' }, []);
    ps.postMessage('hello', []);
    h.net.advanceBy(1);
    expect(link.closedWith).toBeNull();
    server.send(UNRELIABLE, new Uint8Array([1]));
    h.net.advanceBy(1);
    expect(link.closedWith).toBe('forward_error');
    expect(serverClosed).toBe('forward_error');
  });

  it('a slow guest link: snapshots are deferred, the batches (must-send content) never wait more than about 0.1 s', async () => {
    const withReports = await slowJoin(true);
    const blind = await slowJoin(false);
    // With the forwarded backlog: every batch starts going out within ~0.1 s (measured 46 ms).
    expect(withReports.maxWaitMs).toBeLessThan(100);
    // All the snapshots arrived, paced by the link (what went through it at 256 KB/s), none dropped.
    expect(withReports.readyMs).toBeGreaterThanOrEqual(0.9 * withReports.linkMs);
    // ... and not much slower than the link (measured 1.35 s for 1.0 s of link bytes): between two
    // reports the server counts what the channel goes on sending (package 13; without that, 9.8 s).
    expect(withReports.readyMs).toBeLessThan(2 * withReports.linkMs);
    expect(withReports.columns).toBe(blind.columns);
    // A forwarder that reports a backlog of 0 lets the same join put more than twice as much in front of the batches (measured 102 ms).
    expect(blind.maxWaitMs).toBeGreaterThan(2 * withReports.maxWaitMs);
  }, 60_000);
});

/** A guest joins a world of 121 modified columns over a 256 KB/s link while a block changes next to it every tick. */
async function slowJoin(seesBacklog: boolean): Promise<{ maxWaitMs: number; readyMs: number; linkMs: number; columns: number }> {
  const bandwidth = 256 * 1024;
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
  let link: LoopbackLink | null = null;
  const guest = h.addClient(
    'guest',
    {},
    {
      viewRadius: 5,
      transport: () => {
        // The guest's data channels: a loopback link of `bandwidth` downwards; the host page's end
        // goes through the real forwarder into the server's PortTransport.
        const pair = createLoopbackPair(h.net, { ...INSTANT }, { ...INSTANT, bandwidthBytesPerSec: bandwidth });
        const [ps, pf] = fakePorts(h.net);
        link = new LoopbackLink(h.net, pair.server, bandwidth, seesBacklog);
        new PortForwarder(pf, link, netTimers(h.net));
        h.host.connect(new PortTransport(ps, () => h.net.now), false);
        return pair.client;
      },
    },
  );
  const start = h.net.now;
  let readyAt = -1;
  let linkBytes = 0;
  for (let i = 0; i < 600 && readyAt < 0; i++) {
    sim.world.setCell(1, 6, 1, makeCell(i % 2 === 0 ? B.GLASS : B.STONE));
    h.run(50);
    if (guest.state !== null && h.host.replicator.clientView('guest')?.pendingColumns === 0 && guest.net.waiting === 0) {
      readyAt = h.net.now;
      linkBytes = link!.bytes;
    }
  }
  expect(readyAt).toBeGreaterThan(0);
  h.run(2000);
  h.quiesce();
  expect(h.compareNow(guest, false)).toEqual([]);
  expect(guest.net.connectionCount).toBe(1);
  return { maxWaitMs: Math.max(...link!.waits), readyMs: readyAt - start, linkMs: (linkBytes * 1000) / bandwidth, columns: guest.state!.world.chunks.size };
}
