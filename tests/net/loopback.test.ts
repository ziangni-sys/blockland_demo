/**
 * The loopback network (NETCODE section 2, tests of package 3 in section 16): order and loss per
 * channel, the SCTP retransmission model with head-of-line blocking, the bandwidth queue and
 * backpressure, the shared uplink (package 13), close, determinism and the real-timer mode.
 */
import { describe, expect, it } from 'vitest';
import { LoopbackNet, SharedUplink, createLoopbackPair, type LinkConditions } from '../../src/net/loopback';
import { DEFAULT_RTO_MS, MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';

const PERFECT: LinkConditions = { latencyMs: 0, jitterMs: 0, loss: 0, seed: 1 };

function link(over: Partial<LinkConditions> = {}): LinkConditions {
  return { latencyMs: 50, jitterMs: 0, loss: 0, seed: 1, ...over };
}

interface Arrival {
  t: number;
  channel: Channel;
  n: number;
}

/** Messages carry their number in the first 4 bytes. */
function msg(n: number, size = 8): Uint8Array {
  const b = new Uint8Array(Math.max(4, size));
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function record(net: LoopbackNet, t: Transport): Arrival[] {
  const out: Arrival[] = [];
  t.onMessage = (channel, bytes) => out.push({ t: net.now, channel, n: new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) });
  return out;
}

describe('channels', () => {
  it('reliable: everything arrives, in order, under loss and jitter', () => {
    const net = new LoopbackNet();
    const down = link({ latencyMs: 40, jitterMs: 30, loss: 0.2, seed: 7 });
    const { client, server } = createLoopbackPair(net, PERFECT, down);
    const got = record(net, client);
    for (let i = 0; i < 2000; i++) {
      server.send(i % 3 === 0 ? UNRELIABLE : RELIABLE, msg(i));
      net.advanceBy(5);
    }
    net.advanceBy(5000);
    const reliable = got.filter((a) => a.channel === RELIABLE).map((a) => a.n);
    const expected = Array.from({ length: 2000 }, (_, i) => i).filter((i) => i % 3 !== 0);
    expect(reliable).toEqual(expected);
  });

  it('unreliable: loses about `loss` of the messages and reorders them under jitter', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, PERFECT, link({ latencyMs: 40, jitterMs: 30, loss: 0.1, seed: 3 }));
    const got = record(net, client);
    const n = 5000;
    for (let i = 0; i < n; i++) {
      server.send(UNRELIABLE, msg(i));
      net.advanceBy(2);
    }
    net.advanceBy(1000);
    const lossRate = 1 - got.length / n;
    // 3 sigma of a binomial(5000, 0.1) is about 1.3 %.
    expect(lossRate).toBeGreaterThan(0.087);
    expect(lossRate).toBeLessThan(0.113);
    let inversions = 0;
    for (let i = 1; i < got.length; i++) if (got[i]!.n < got[i - 1]!.n) inversions++;
    expect(inversions).toBeGreaterThan(100);
    for (const a of got) {
      const sent = a.n * 2;
      expect(a.t - sent).toBeGreaterThanOrEqual(40);
      expect(a.t - sent).toBeLessThanOrEqual(70);
    }
  });

  it('is deterministic: the same seeds give the same arrivals; each direction has its own conditions', () => {
    const run = (): Arrival[][] => {
      const net = new LoopbackNet();
      const { client, server } = createLoopbackPair(net, link({ latencyMs: 10, jitterMs: 20, loss: 0.3, seed: 11 }), link({ latencyMs: 70, jitterMs: 5, loss: 0.05, seed: 12 }));
      const atServer = record(net, server);
      const atClient = record(net, client);
      for (let i = 0; i < 300; i++) {
        client.send(i % 2 ? RELIABLE : UNRELIABLE, msg(i));
        server.send(i % 2 ? UNRELIABLE : RELIABLE, msg(i));
        net.advanceBy(3);
      }
      net.advanceBy(3000);
      return [atServer, atClient];
    };
    const a = run();
    expect(run()).toEqual(a);
    const upLatency = Math.min(...a[0]!.map((x) => x.t - x.n * 3));
    const downLatency = Math.min(...a[1]!.map((x) => x.t - x.n * 3));
    expect(upLatency).toBeGreaterThanOrEqual(10);
    expect(upLatency).toBeLessThan(15);
    expect(downLatency).toBeGreaterThanOrEqual(70);
  });

  it('copies the bytes at send: the sender may reuse its buffer', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, PERFECT, link());
    const got = record(net, client);
    const buf = msg(1);
    server.send(RELIABLE, buf);
    buf[0] = 99;
    net.advanceBy(100);
    expect(got.map((a) => a.n)).toEqual([1]);
  });

  it('refuses unreliable messages above MAX_UNRELIABLE_BYTES and reliable ones above MAX_RELIABLE_BYTES', () => {
    const net = new LoopbackNet();
    const { client } = createLoopbackPair(net, PERFECT, PERFECT);
    expect(() => client.send(UNRELIABLE, new Uint8Array(MAX_UNRELIABLE_BYTES))).not.toThrow();
    expect(() => client.send(UNRELIABLE, new Uint8Array(MAX_UNRELIABLE_BYTES + 1))).toThrow(RangeError);
    expect(() => client.send(RELIABLE, new Uint8Array(MAX_RELIABLE_BYTES))).not.toThrow();
    expect(() => client.send(RELIABLE, new Uint8Array(MAX_RELIABLE_BYTES + 1))).toThrow(RangeError);
  });
});

describe('reliable retransmission (SCTP model) and head-of-line blocking', () => {
  /** Send at the given times; the messages in `lost` are picked by the loss draw. */
  function scenario(sends: Array<{ t: number; channel: Channel; lost?: boolean }>, over: Partial<LinkConditions> = {}): Arrival[] {
    const net = new LoopbackNet();
    const down = link(over);
    const { client, server } = createLoopbackPair(net, PERFECT, down);
    const got = record(net, client);
    sends.forEach((s, i) => {
      net.advanceTo(s.t);
      down.loss = s.lost ? 1 : 0; // conditions are read at every send
      server.send(s.channel, msg(i));
    });
    net.advanceTo(10_000);
    return got;
  }

  it('fast retransmit: ready at the 3rd later arrival + 2 x latency; the messages behind it wait', () => {
    const got = scenario([
      { t: 0, channel: RELIABLE, lost: true },
      { t: 10, channel: RELIABLE },
      { t: 15, channel: UNRELIABLE },
      { t: 20, channel: RELIABLE },
      { t: 100, channel: RELIABLE },
    ]);
    // Arrivals of the later ones: 60, 65 (unreliable), 70: the third is at 70, so ready at 70 + 100.
    expect(got).toEqual([
      { t: 65, channel: UNRELIABLE, n: 2 },
      { t: 170, channel: RELIABLE, n: 0 },
      { t: 170, channel: RELIABLE, n: 1 },
      { t: 170, channel: RELIABLE, n: 3 },
      { t: 170, channel: RELIABLE, n: 4 },
    ]);
  });

  it('retransmission timer: without 3 later arrivals, ready at departure + rto + latency', () => {
    const got = scenario([
      { t: 0, channel: RELIABLE, lost: true },
      { t: 10, channel: RELIABLE },
      { t: 20, channel: UNRELIABLE, lost: true }, // lost messages do not count
      { t: 30, channel: RELIABLE },
    ]);
    const timer = DEFAULT_RTO_MS + 50;
    expect(got).toEqual([
      { t: timer, channel: RELIABLE, n: 0 },
      { t: timer, channel: RELIABLE, n: 1 },
      { t: timer, channel: RELIABLE, n: 3 },
    ]);
    const custom = scenario([{ t: 0, channel: RELIABLE, lost: true }], { rtoMs: 1000 });
    expect(custom).toEqual([{ t: 1050, channel: RELIABLE, n: 0 }]);
  });

  it('the earlier of the two: a late third arrival does not delay past the timer', () => {
    const got = scenario([
      { t: 0, channel: RELIABLE, lost: true },
      { t: 100, channel: UNRELIABLE },
      { t: 200, channel: UNRELIABLE },
      { t: 300, channel: UNRELIABLE }, // arrives at 350: 350 + 100 > 450
    ]);
    expect(got.find((a) => a.n === 0)!.t).toBe(450);
  });

  it('two retransmissions in a row count the same later arrivals', () => {
    const got = scenario([
      { t: 0, channel: RELIABLE, lost: true },
      { t: 1, channel: RELIABLE, lost: true },
      { t: 2, channel: UNRELIABLE },
      { t: 3, channel: UNRELIABLE },
      { t: 4, channel: UNRELIABLE },
    ]);
    // For both, the third later arrival is message 4 (at 54): ready at 154, in order.
    expect(got.filter((a) => a.channel === RELIABLE)).toEqual([
      { t: 154, channel: RELIABLE, n: 0 },
      { t: 154, channel: RELIABLE, n: 1 },
    ]);
  });

  it('a retransmission ready earlier still waits for the one before it', () => {
    const net = new LoopbackNet();
    const down = link({ loss: 1, rtoMs: 1000 });
    const { client, server } = createLoopbackPair(net, PERFECT, down);
    const got = record(net, client);
    server.send(RELIABLE, msg(0)); // ready at 0 + 1000 + 50
    down.rtoMs = 100;
    net.advanceTo(10);
    server.send(RELIABLE, msg(1)); // ready at 10 + 100 + 50 = 160, blocked until 1050
    net.advanceTo(5000);
    expect(got).toEqual([
      { t: 1050, channel: RELIABLE, n: 0 },
      { t: 1050, channel: RELIABLE, n: 1 },
    ]);
  });
});

describe('bandwidth', () => {
  it('queues bytes at the link rate; bufferedBytes reports the backlog per channel', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, PERFECT, link({ latencyMs: 20, bandwidthBytesPerSec: 10_000 }));
    const got = record(net, client);
    for (let i = 0; i < 5; i++) server.send(RELIABLE, msg(i, 1000));
    server.send(UNRELIABLE, msg(5, 500));
    expect(server.bufferedBytes(RELIABLE)).toBe(5000);
    expect(server.bufferedBytes(UNRELIABLE)).toBe(500);
    net.advanceTo(150);
    expect(server.bufferedBytes(RELIABLE)).toBe(3500);
    net.advanceTo(500);
    expect(server.bufferedBytes(RELIABLE)).toBe(0);
    expect(server.bufferedBytes(UNRELIABLE)).toBe(500);
    net.advanceTo(1000);
    expect(server.bufferedBytes(UNRELIABLE)).toBe(0);
    // Each 1000-byte message leaves 100 ms after the previous one, then takes the latency.
    expect(got.map((a) => a.t)).toEqual([120, 220, 320, 420, 520, 570]);
  });

  it('without a bandwidth there is no backlog', () => {
    const net = new LoopbackNet();
    const { server } = createLoopbackPair(net, PERFECT, link());
    server.send(RELIABLE, new Uint8Array(100_000));
    expect(server.bufferedBytes(RELIABLE)).toBe(0);
  });
});

describe('shared uplink', () => {
  /** Two links (two guests) leaving through one 10 000 B/s uplink without headers, 10 ms latency. */
  function twoGuests(headerBytes = 0): { net: LoopbackNet; up: SharedUplink; a: { client: Transport; server: Transport }; b: { client: Transport; server: Transport } } {
    const net = new LoopbackNet();
    const up = new SharedUplink(net, 10_000, headerBytes);
    const a = createLoopbackPair(net, PERFECT, link({ latencyMs: 10, shared: up }));
    const b = createLoopbackPair(net, PERFECT, link({ latencyMs: 10, shared: up, seed: 2 }));
    return { net, up, a, b };
  }

  it('one busy link gets the whole uplink; two busy links get half each, each in its own order', () => {
    const { net, a, b } = twoGuests();
    const ga = record(net, a.client);
    const gb = record(net, b.client);
    a.server.send(RELIABLE, msg(1, 1000)); // alone: leaves at 100 ms
    net.advanceTo(50);
    b.server.send(RELIABLE, msg(2, 1000)); // from 50 ms both share: a's last 500 B take 100 ms
    b.server.send(UNRELIABLE, msg(3, 500));
    net.advanceTo(1000);
    expect(ga).toEqual([{ t: 160, channel: RELIABLE, n: 1 }]);
    // b: 500 B by 150 ms at half the rate, the other 500 alone by 200; then its 500 B unreliable alone by 250.
    expect(gb).toEqual([
      { t: 210, channel: RELIABLE, n: 2 },
      { t: 260, channel: UNRELIABLE, n: 3 },
    ]);
  });

  it("bufferedBytes is each link's own payload not yet sent, per channel; headers use bandwidth only", () => {
    const { net, up, a, b } = twoGuests(80);
    a.server.send(RELIABLE, msg(1, 1150)); // one packet: 1230 wire bytes
    b.server.send(RELIABLE, msg(2, 1151)); // two packets: 1311
    expect(a.server.bufferedBytes(RELIABLE)).toBe(1150);
    expect(a.server.bufferedBytes(UNRELIABLE)).toBe(0);
    expect(b.server.bufferedBytes(RELIABLE)).toBe(1151);
    expect(up.wireBytes).toBe(1230 + 1311);
    net.advanceTo(123); // a: 615 of 1230 wire bytes sent at half the rate
    expect(a.server.bufferedBytes(RELIABLE)).toBe(Math.ceil(1150 * 615 / 1230));
    net.advanceTo(246); // a has left
    expect(a.server.bufferedBytes(RELIABLE)).toBe(0);
    expect(b.server.bufferedBytes(RELIABLE)).toBeGreaterThan(0);
    net.advanceTo(10_000);
    expect(b.server.bufferedBytes(RELIABLE)).toBe(0);
  });

  it('a close leaves behind the link\'s messages, not behind the other links\'', () => {
    const { net, a, b } = twoGuests();
    let closedAt = -1;
    a.client.onClose = () => (closedAt = net.now);
    const gb = record(net, b.client);
    b.server.send(RELIABLE, msg(1, 2000));
    a.server.send(RELIABLE, msg(2, 500));
    a.server.close('bye');
    net.advanceTo(1000);
    // a's 500 B at half the rate leave at 100 ms; the close goes then, b alone afterwards.
    expect(closedAt).toBe(110);
    expect(gb).toEqual([{ t: 260, channel: RELIABLE, n: 1 }]);
  });

  it('rejects a shared uplink together with a bandwidth of its own, and invalid uplinks', () => {
    const net = new LoopbackNet();
    const up = new SharedUplink(net, 1000);
    expect(() => createLoopbackPair(net, PERFECT, { ...PERFECT, shared: up, bandwidthBytesPerSec: 100 })).toThrow(RangeError);
    expect(() => new SharedUplink(net, 0)).toThrow(RangeError);
  });
});

describe('close', () => {
  it('the far end gets the reliable messages sent before close, then onClose(reason); the closing end gets no onClose', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, link(), link({ jitterMs: 40, seed: 4 }));
    const got = record(net, client);
    const closes: Array<{ who: string; reason: string; t: number }> = [];
    client.onClose = (reason) => closes.push({ who: 'client', reason, t: net.now });
    server.onClose = (reason) => closes.push({ who: 'server', reason, t: net.now });
    for (let i = 0; i < 5; i++) server.send(RELIABLE, msg(i));
    server.close('kicked');
    expect(server.open).toBe(false);
    expect(client.open).toBe(true);
    server.send(RELIABLE, msg(99)); // ignored
    client.send(RELIABLE, msg(100)); // the server end is closed: never delivered
    net.advanceTo(1000);
    expect(got.map((a) => a.n)).toEqual([0, 1, 2, 3, 4]);
    expect(closes).toEqual([{ who: 'client', reason: 'kicked', t: expect.any(Number) }]);
    expect(closes[0]!.t).toBeGreaterThanOrEqual(got[4]!.t);
    expect(client.open).toBe(false);
  });

  it('close waits behind a pending retransmission, and later unreliable messages are not delivered', () => {
    const net = new LoopbackNet();
    const down = link({ loss: 1 });
    const { client, server } = createLoopbackPair(net, PERFECT, down);
    const got = record(net, client);
    let closedAt = -1;
    client.onClose = () => (closedAt = net.now);
    server.send(RELIABLE, msg(0)); // lost: ready at 450
    server.close();
    net.advanceTo(2000);
    expect(got.map((a) => [a.n, a.t])).toEqual([[0, 450]]);
    expect(closedAt).toBe(450);
  });

  it('both ends closing at once: nobody gets onClose', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, link(), link());
    let calls = 0;
    client.onClose = server.onClose = () => calls++;
    client.close();
    server.close();
    net.advanceTo(1000);
    expect(calls).toBe(0);
  });
});

describe('the clock', () => {
  it('runs handlers at their own time, never goes back, and reports the next event', () => {
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, link({ latencyMs: 30 }), link({ latencyMs: 30 }));
    // An echo: the reply leaves at the time the request arrives.
    server.onMessage = (ch, b) => server.send(ch, b);
    const got = record(net, client);
    client.send(RELIABLE, msg(1));
    expect(net.nextEventTime()).toBe(30);
    net.advanceTo(1000);
    expect(got).toEqual([{ t: 60, channel: RELIABLE, n: 1 }]);
    expect(net.now).toBe(1000);
    expect(net.nextEventTime()).toBe(null);
    expect(() => net.advanceTo(999)).toThrow(RangeError);
  });

  it('can run on real timers (injected), and stop', () => {
    let wall = 5000;
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let nextId = 0;
    const hooks = {
      now: () => wall,
      schedule: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ at: wall + ms, fn, id });
        return id;
      },
      cancel: (id: unknown) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const tick = (to: number): void => {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (t === undefined || t.at > to) break;
        timers.shift();
        wall = t.at;
        t.fn();
      }
      wall = to;
    };
    const net = new LoopbackNet();
    const { client, server } = createLoopbackPair(net, link({ latencyMs: 40 }), link({ latencyMs: 40 }));
    const got = record(net, server);
    const stop = net.startRealtime(hooks);
    expect(() => net.advanceTo(10)).toThrow();
    client.send(RELIABLE, msg(1));
    tick(5020);
    client.send(UNRELIABLE, msg(2)); // sent at virtual time 20
    tick(5100);
    expect(got).toEqual([
      { t: 40, channel: RELIABLE, n: 1 },
      { t: 60, channel: UNRELIABLE, n: 2 },
    ]);
    stop();
    expect(net.now).toBe(100);
    client.send(RELIABLE, msg(3));
    expect(timers.length).toBe(0);
    net.advanceTo(200);
    expect(got.at(-1)).toEqual({ t: 140, channel: RELIABLE, n: 3 });
  });

  it('rejects invalid link conditions', () => {
    const net = new LoopbackNet();
    expect(() => createLoopbackPair(net, { ...PERFECT, loss: 1.5 }, PERFECT)).toThrow(RangeError);
    expect(() => createLoopbackPair(net, PERFECT, { ...PERFECT, latencyMs: -1 })).toThrow(RangeError);
    expect(() => createLoopbackPair(net, PERFECT, { ...PERFECT, bandwidthBytesPerSec: 0 })).toThrow(RangeError);
  });
});
