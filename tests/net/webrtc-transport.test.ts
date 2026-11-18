/**
 * Package 10: WebRtcTransport on fake data channels (NETCODE section 2): the frozen fragment format
 * and the reassembly, the limits on what a peer may send, the backlog, and the close rules.
 * The real channels are exercised in a browser by scripts/e2e-room.mjs.
 */
import { describe, expect, it } from 'vitest';
import { LoopbackNet } from '../../src/net/loopback';
import { MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel } from '../../src/net/transport';
import { BUFFERED_LOW_BYTES, CLOSE_LINGER_MS, FRAGMENT_BYTES, fragments, WebRtcTransport } from '../../src/net/webrtc/transport';
import { FakeChannel, FakePeer, FakeRtcNet, netTimers } from './fakertc';

interface End {
  peer: FakePeer;
  r: FakeChannel;
  u: FakeChannel;
  t: WebRtcTransport;
  got: Array<{ channel: Channel; bytes: Uint8Array }>;
  closed: string[];
}

/** Two connected ends on fake channels. */
function pair(setup: (rtc: FakeRtcNet) => void = () => undefined): { loop: LoopbackNet; rtc: FakeRtcNet; a: End; b: End } {
  const loop = new LoopbackNet();
  const rtc = new FakeRtcNet(loop);
  setup(rtc);
  const timers = netTimers(loop);
  const make = (): { peer: FakePeer; r: FakeChannel; u: FakeChannel } => {
    const peer = rtc.createPeer();
    const r = peer.createDataChannel('r', { negotiated: true, id: 0, ordered: true }) as unknown as FakeChannel;
    const u = peer.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 }) as unknown as FakeChannel;
    return { peer, r, u };
  };
  const pa = make();
  const pb = make();
  void pa.peer.setLocalDescription({ type: 'offer', sdp: `fake:${pa.peer.id}` });
  void pb.peer.setRemoteDescription({ type: 'offer', sdp: `fake:${pa.peer.id}` });
  void pb.peer.setLocalDescription({ type: 'answer', sdp: `fake:${pb.peer.id}` });
  void pa.peer.setRemoteDescription({ type: 'answer', sdp: `fake:${pb.peer.id}` });
  loop.advanceBy(200);
  const end = (p: { peer: FakePeer; r: FakeChannel; u: FakeChannel }): End => {
    const t = new WebRtcTransport(p.peer, p.r as unknown as RTCDataChannel, p.u as unknown as RTCDataChannel, timers);
    const e: End = { ...p, t, got: [], closed: [] };
    t.onMessage = (channel, bytes) => e.got.push({ channel, bytes });
    t.onClose = (reason) => e.closed.push(reason);
    return e;
  };
  return { loop, rtc, a: end(pa), b: end(pb) };
}

function pattern(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function frame(kind: number, payload: Uint8Array, total?: number): ArrayBuffer {
  const head = total === undefined ? 1 : 5;
  const f = new Uint8Array(head + payload.length);
  f[0] = kind;
  if (total !== undefined) new DataView(f.buffer).setUint32(1, total, true);
  f.set(payload, head);
  return f.buffer;
}

describe('WebRtcTransport (package 10)', () => {
  it('reliable messages of 1 byte, 16 KiB - 1, 16 KiB, 16 KiB + 1, 1 MiB and 4 MiB arrive whole, in order, as sent', () => {
    const { loop, a, b } = pair();
    const sizes = [1, FRAGMENT_BYTES - 1, FRAGMENT_BYTES, FRAGMENT_BYTES + 1, 2 * FRAGMENT_BYTES, 1 << 20, MAX_RELIABLE_BYTES];
    const msgs = sizes.map((n, i) => pattern(n, i + 1));
    for (const m of msgs) a.t.send(RELIABLE, m);
    loop.advanceBy(2000);
    expect(b.got.map((g) => g.channel)).toEqual(sizes.map(() => RELIABLE));
    expect(b.got.map((g) => g.bytes.length)).toEqual(sizes);
    for (let i = 0; i < msgs.length; i++) expect(Buffer.compare(Buffer.from(b.got[i]!.bytes), Buffer.from(msgs[i]!))).toBe(0);
    // And back the other way.
    b.t.send(RELIABLE, msgs[5]!);
    loop.advanceBy(500);
    expect(a.got).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(a.got[0]!.bytes), Buffer.from(msgs[5]!))).toBe(0);
    expect(a.closed).toEqual([]);
    expect(b.closed).toEqual([]);
  });

  it('the fragment format: 0 whole up to 16 KiB; 1 + u32 total (little endian) + 16 KiB, 2 middles, 3 the last', () => {
    expect([...fragments(new Uint8Array([9, 8]))[0]!]).toEqual([0, 9, 8]);
    expect(fragments(new Uint8Array(FRAGMENT_BYTES)).map((f) => [f[0], f.length])).toEqual([[0, FRAGMENT_BYTES + 1]]);
    const n = 2 * FRAGMENT_BYTES + 3;
    const fs = fragments(pattern(n));
    expect(fs.map((f) => [f[0], f.length])).toEqual([
      [1, 5 + FRAGMENT_BYTES],
      [2, 1 + FRAGMENT_BYTES],
      [3, 1 + 3],
    ]);
    expect(new DataView(fs[0]!.buffer).getUint32(1, true)).toBe(n);
    const { loop, a } = pair();
    a.t.send(RELIABLE, pattern(FRAGMENT_BYTES + 1));
    loop.advanceBy(100);
    expect(a.r.sent.map((f) => [f[0], f.length])).toEqual([
      [1, 5 + FRAGMENT_BYTES],
      [3, 2],
    ]);
    // Unreliable messages carry no header.
    a.t.send(UNRELIABLE, new Uint8Array([5, 6, 7]));
    expect([...a.u.sent[0]!]).toEqual([5, 6, 7]);
  });

  it('the caller may reuse its array at once; the receiver owns what it gets', () => {
    const { loop, a, b } = pair();
    const buf = new Uint8Array(100).fill(3);
    a.t.send(RELIABLE, buf.subarray(10, 20));
    a.t.send(UNRELIABLE, buf.subarray(0, 5));
    buf.fill(0);
    loop.advanceBy(100);
    expect([...b.got[0]!.bytes]).toEqual(new Array(10).fill(3));
    expect([...b.got[1]!.bytes]).toEqual(new Array(5).fill(3));
  });

  it('send throws for a message above the channel limit (a caller bug), and does nothing once closed', () => {
    const { a } = pair();
    expect(() => a.t.send(UNRELIABLE, new Uint8Array(MAX_UNRELIABLE_BYTES + 1))).toThrow(RangeError);
    expect(() => a.t.send(RELIABLE, new Uint8Array(MAX_RELIABLE_BYTES + 1))).toThrow(RangeError);
    expect(() => a.t.send(2 as Channel, new Uint8Array(1))).toThrow(RangeError);
    a.t.close();
    const before = a.r.sent.length;
    a.t.send(RELIABLE, new Uint8Array(1));
    expect(a.r.sent.length).toBe(before);
    expect(a.t.open).toBe(false);
  });

  describe('what a peer may send: a violation ends the connection (onClose transport_error), nothing is delivered', () => {
    const cases: Array<[string, (b: End) => void]> = [
      ['a declared total above 4 MiB', (b) => b.r.inject(frame(1, pattern(FRAGMENT_BYTES), MAX_RELIABLE_BYTES + 1))],
      [
        'a stream of middle fragments past the declared total (never ends)',
        (b) => {
          b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 3 * FRAGMENT_BYTES));
          for (let i = 0; i < 5; i++) b.r.inject(frame(2, pattern(FRAGMENT_BYTES)));
        },
      ],
      ['a last fragment short of the total', (b) => (b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 3 * FRAGMENT_BYTES)), b.r.inject(frame(3, pattern(10))))],
      ['a middle fragment without a first one', (b) => b.r.inject(frame(2, pattern(10)))],
      ['a last fragment without a first one', (b) => b.r.inject(frame(3, pattern(10)))],
      ['a whole message inside an unfinished one', (b) => (b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 2 * FRAGMENT_BYTES)), b.r.inject(frame(0, pattern(10))))],
      ['a second first fragment inside an unfinished one', (b) => (b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 3 * FRAGMENT_BYTES)), b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 2 * FRAGMENT_BYTES)))],
      ['a whole fragment above 16 KiB', (b) => b.r.inject(frame(0, pattern(FRAGMENT_BYTES + 1)))],
      ['a first fragment carrying the whole message', (b) => b.r.inject(frame(1, pattern(100), 100))],
      ['an empty fragment', (b) => b.r.inject(frame(0, new Uint8Array(0)))],
      ['an empty middle fragment (no progress)', (b) => (b.r.inject(frame(1, pattern(FRAGMENT_BYTES), 3 * FRAGMENT_BYTES)), b.r.inject(frame(2, new Uint8Array(0))))],
      ['an unknown kind', (b) => b.r.inject(frame(4, pattern(10)))],
      ['text instead of bytes', (b) => b.r.inject('hello')],
      ['an unreliable message above 1150 bytes', (b) => b.u.inject(pattern(MAX_UNRELIABLE_BYTES + 1).buffer as ArrayBuffer)],
      ['an empty unreliable message', (b) => b.u.inject(new ArrayBuffer(0))],
    ];
    for (const [name, act] of cases) {
      it(name, () => {
        const { loop, a, b } = pair();
        act(b);
        loop.advanceBy(200);
        expect(b.closed).toEqual(['transport_error']);
        expect(b.got).toEqual([]);
        expect(b.t.open).toBe(false);
        // The far end sees its connection close.
        loop.advanceBy(CLOSE_LINGER_MS + 100);
        expect(a.closed).toHaveLength(1);
      });
    }
    it('the largest stream that follows the format is accepted (4 MiB in 256 fragments)', () => {
      const { loop, b } = pair();
      const total = MAX_RELIABLE_BYTES;
      b.r.inject(frame(1, pattern(FRAGMENT_BYTES), total));
      for (let at = FRAGMENT_BYTES; at < total; at += FRAGMENT_BYTES) b.r.inject(frame(at + FRAGMENT_BYTES >= total ? 3 : 2, pattern(FRAGMENT_BYTES)));
      loop.advanceBy(100);
      expect(b.closed).toEqual([]);
      expect(b.got.map((g) => g.bytes.length)).toEqual([total]);
    });
  });

  it('bufferedBytes is the channel bufferedAmount; onBufferedLow fires when a channel drains to BUFFERED_LOW_BYTES', () => {
    const { loop, a } = pair((rtc) => (rtc.bandwidth = 100_000));
    const lows: Channel[] = [];
    a.t.onBufferedLow = (ch) => lows.push(ch);
    expect(a.t.bufferedBytes(RELIABLE)).toBe(0);
    a.t.send(RELIABLE, pattern(50_000));
    expect(a.t.bufferedBytes(RELIABLE)).toBe(a.r.bufferedAmount);
    expect(a.t.bufferedBytes(RELIABLE)).toBeGreaterThan(50_000);
    loop.advanceBy(200);
    expect(a.t.bufferedBytes(RELIABLE)).toBeGreaterThan(BUFFERED_LOW_BYTES);
    expect(lows).toEqual([]);
    loop.advanceBy(600);
    expect(a.t.bufferedBytes(RELIABLE)).toBe(0);
    expect(lows).toEqual([RELIABLE]);
    for (let i = 0; i < 20; i++) a.t.send(UNRELIABLE, pattern(1000));
    expect(a.t.bufferedBytes(UNRELIABLE)).toBe(20_000);
    loop.advanceBy(1000);
    expect(lows).toEqual([RELIABLE, UNRELIABLE]);
  });

  it('close(): the far end gets every reliable message sent before it, then onClose; this end has no onClose', () => {
    const { loop, a, b } = pair((rtc) => (rtc.bandwidth = 1_000_000));
    for (let i = 0; i < 5; i++) a.t.send(RELIABLE, pattern(100_000, i));
    a.t.close('bye now');
    a.t.send(RELIABLE, new Uint8Array([1]));
    loop.advanceBy(3000);
    expect(b.got.map((g) => g.bytes.length)).toEqual([100_000, 100_000, 100_000, 100_000, 100_000]);
    expect(b.closed).toEqual(['closed']);
    expect(a.closed).toEqual([]);
    expect(b.t.open).toBe(false);
    // Both peer connections are let go.
    expect(a.peer.closed).toBe(true);
    expect(b.peer.closed).toBe(true);
  });

  it('either channel closing ends the connection, reported once', () => {
    for (const which of ['r', 'u'] as const) {
      const { loop, a, b } = pair();
      b[which].abort();
      loop.advanceBy(100);
      expect(b.closed).toEqual(['closed']);
      b.peer.setState('failed');
      expect(b.closed).toEqual(['closed']);
      loop.advanceBy(CLOSE_LINGER_MS);
      expect(a.closed).toHaveLength(1);
    }
  });

  it('ICE failing (connectionState failed) ends it with ice_failed', () => {
    const { loop, b } = pair();
    b.peer.setState('disconnected');
    loop.advanceBy(100);
    expect(b.closed).toEqual([]);
    b.peer.setState('failed');
    expect(b.closed).toEqual(['ice_failed']);
    expect(b.peer.closed).toBe(true);
  });

  it('a send the browser refuses (full buffer) ends the connection, reported from a timer, not inside send()', () => {
    const { loop, a } = pair();
    a.r.refuseSends = true;
    a.t.send(RELIABLE, new Uint8Array([1]));
    expect(a.closed).toEqual([]);
    expect(a.t.open).toBe(false);
    loop.advanceBy(10);
    expect(a.closed).toEqual(['send_failed']);
  });
});
