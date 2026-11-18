/**
 * A MessagePort pair on the loopback's virtual clock (tests of the host page's forwarder, package 10,
 * and the room measurements, package 13): postMessage structured-clones and transfers like the real
 * one, and delivers as an event of the net's queue.
 */
import type { PortLike } from '../../src/net/host/port';
import type { LoopbackNet } from '../../src/net/loopback';

/** One end. */
export class FakePort implements PortLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  peer: FakePort | null = null;
  closed = false;
  /** Every frame posted, as received by the peer. */
  readonly posted: unknown[] = [];
  /** Frames for this end while it is held (its thread busy), in order; null when not held. */
  private held: unknown[] | null = null;
  constructor(private readonly net: LoopbackNet) {}
  postMessage(message: unknown, transfer: Transferable[]): void {
    if (this.closed) return;
    const data = structuredClone(message, { transfer });
    this.posted.push(data);
    const peer = this.peer!;
    this.net.schedule(this.net.now, () => peer.deliver(data));
  }
  close(): void {
    this.closed = true;
  }
  /** This end's thread is busy (a long Worker task): what arrives waits for release(). */
  hold(): void {
    this.held ??= [];
  }
  /** The thread is free again: what waited is delivered as a busy thread gets it, 0.02 ms apart. */
  release(): void {
    const waiting = this.held ?? [];
    this.held = null;
    waiting.forEach((data, i) => this.net.schedule(this.net.now + 0.02 * (i + 1), () => this.deliver(data)));
  }
  private deliver(data: unknown): void {
    if (this.closed) return;
    if (this.held !== null) this.held.push(data);
    else this.onmessage?.({ data } as MessageEvent);
  }
}

export function fakePorts(net: LoopbackNet): [FakePort, FakePort] {
  const a = new FakePort(net);
  const b = new FakePort(net);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
