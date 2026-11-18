/**
 * Package 8: PortTransport (NETCODE section 2, "房间里的积压", section 16 package 8): bytes are
 * transferred or copied, never shared; the close travels behind the messages; the backlog comes
 * from the forwarder's reports. The forwarder itself, and the Replicator's back-pressure on a slow
 * guest link through it, are package 10's (tests/net/forward.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { PortTransport, type PortBacklog, type PortLike } from '../../src/net/host/port';
import type { LoopbackNet } from '../../src/net/loopback';
import { MAX_UNRELIABLE_BYTES } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { NetHarness } from './harness';

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
});
