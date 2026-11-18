/**
 * Package 8: PortTransport (NETCODE section 2, "房间里的积压", section 16 package 8): bytes are
 * transferred or copied, never shared; the close travels behind the messages; the backlog comes
 * from the forwarder's reports. The forwarder itself, and the Replicator's back-pressure on a slow
 * guest link through it, are package 10's (tests/net/forward.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { PortTransport, type PortBacklog, type PortLike } from '../../src/net/host/port';
import { MAX_UNRELIABLE_BYTES } from '../../src/net/protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { fakePorts } from './fakeport';
import { NetHarness } from './harness';

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

  it('with a clock, what the channel goes on sending after a report is counted: its drain between reports (package 13)', () => {
    const h = new NetHarness();
    const [ps, pf] = fakePorts(h.net);
    const t = new PortTransport(ps, () => h.net.now);
    const report = (r: Omit<PortBacklog, 'kind'>): void => pf.postMessage({ kind: 'backlog', ...r }, []);
    report({ channel: RELIABLE, bufferedAmount: 0, seen: 0 });
    h.run(0);
    t.send(RELIABLE, new Uint8Array(1000));
    h.run(100);
    // It kept up: 1000 bytes in 100 ms, so it sends at least 10 a ms.
    report({ channel: RELIABLE, bufferedAmount: 0, seen: 1000 });
    h.run(0);
    t.send(RELIABLE, new Uint8Array(3000));
    expect(t.bufferedBytes(RELIABLE)).toBe(3000);
    h.run(50);
    expect(t.bufferedBytes(RELIABLE)).toBe(2500);
    h.run(300);
    expect(t.bufferedBytes(RELIABLE)).toBe(0);
    // Still 500 queued after 350 ms: it was busy, at 2500 / 350 bytes a ms (smoothed with the 10 before).
    report({ channel: RELIABLE, bufferedAmount: 500, seen: 4000 });
    h.run(0);
    expect(t.bufferedBytes(RELIABLE)).toBe(500);
    h.run(20);
    expect(t.bufferedBytes(RELIABLE)).toBe(Math.round(500 - 20 * (10 + 0.5 * (2500 / 350 - 10))));
  });

  it('reports a busy Worker gets bunched together are not read as a fast channel (package 13)', () => {
    // The page reports every 100 ms; in each 100 ms the channel sends 1000 bytes and the server
    // posts 1000, so the backlog stays at 10 000. The Worker is busy for 200 ms once: the two
    // reports the page made meanwhile, 100 ms apart, arrive 0.02 ms apart.
    let now = 0;
    const port: PortLike & { deliver(data: unknown): void } = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
      deliver(data) {
        this.onmessage?.({ data } as MessageEvent);
      },
    };
    const t = new PortTransport(port, () => now);
    let seen = 10_000;
    t.send(RELIABLE, new Uint8Array(10_000));
    const report = (): void => port.deliver({ kind: 'backlog', channel: RELIABLE, bufferedAmount: 10_000, seen } satisfies PortBacklog);
    report();
    const read: number[] = [];
    let arrived = 0;
    for (let k = 1; k <= 20; k++) {
      t.send(RELIABLE, new Uint8Array(1000));
      seen += 1000;
      arrived += k === 6 ? 0.02 : k === 7 ? 99.98 : 100;
      now = arrived;
      report();
      // What the server's next tick reads, 20 ms after the report (after the fifth it is busy).
      if (k === 5) continue;
      now = arrived + 20;
      read.push(t.bufferedBytes(RELIABLE));
    }
    // With the drain measured between the bunched pair: 0 for five reports, then slowly back.
    expect(Math.min(...read)).toBeGreaterThan(9000);
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
