/**
 * An in-process network for tests (docs/NETCODE.md section 2): pairs of Transports whose bytes
 * travel through a simulated link with latency, jitter, loss, an optional bandwidth limit and an
 * SCTP-like reliable channel, on a virtual clock.
 *
 * CLOCK. LoopbackNet owns the time (ms) and a queue of due events. Tests move it with advanceTo();
 * every delivery happens inside that call, at its own time (`now` is the event's time while its
 * handler runs, so replies are scheduled from the right moment). startRealtime() drives the same
 * queue from real timers instead, for trying latency by hand in a browser.
 *
 * LINK MODEL (each direction has its own LinkConditions and its own Rng(seed), so runs repeat
 * exactly). Per message, in send order: it waits in the link's byte queue when a bandwidth is set
 * (`bufferedBytes` is what has not left it yet; both channels share it), then is lost with
 * probability `loss`, else arrives after latencyMs + U(0, jitterMs).
 *  - UNRELIABLE: each message on its own (so they reorder); lost ones are gone.
 *  - RELIABLE: never lost, never reordered. A message the loss draw picks is retransmitted once,
 *    as SCTP would: it becomes ready at min(arrival of the 3rd later message on this direction
 *    that is not itself lost (either channel) + 2 x latencyMs  [fast retransmit],
 *    departure + rtoMs + latencyMs  [retransmission timer]). Head-of-line blocking: a reliable
 *    message is delivered at max(delivery of the previous reliable message, its own ready time),
 *    so everything behind a retransmission waits for it.
 *  - close(): travels like a reliable message that is never lost, behind every reliable message
 *    already sent; the far end's onClose fires when it arrives. Nothing is delivered to an end
 *    after it closed or saw the close.
 * LinkConditions objects are read at every send: changing one changes the link from then on.
 *
 * SHARED UPLINK (LinkConditions.shared): several links leave one sender through one SharedUplink,
 * as a room's host page sends to every guest over its own uplink. Every guest's connection is its
 * own congestion-controlled association, and such flows share a bottleneck about evenly, so the
 * uplink is modelled as processor sharing: its bandwidth is split evenly between the links that
 * have bytes waiting, each link's own messages leaving in order. Each message also costs header
 * bytes per packet (IP, UDP, DTLS, SCTP), which use bandwidth but are not in `bufferedBytes`
 * (a data channel's bufferedAmount counts payload only).
 */
import { Rng } from '../core/rng';
import { DEFAULT_RTO_MS, MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from './protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from './transport';

/** One direction of a loopback link. */
export interface LinkConditions {
  /** One-way latency, ms. */
  latencyMs: number;
  /** Extra one-way delay, uniform in [0, jitterMs], drawn per message. */
  jitterMs: number;
  /** Probability 0..1 that a message is lost (unreliable) or retransmitted (reliable). */
  loss: number;
  /** Bytes per second leaving the sender; unlimited when absent. */
  bandwidthBytesPerSec?: number;
  /** Reliable retransmission timer, ms (default DEFAULT_RTO_MS). */
  rtoMs?: number;
  /**
   * The sender's uplink this direction shares with other links (a room's host sending to every
   * guest); takes the place of bandwidthBytesPerSec.
   */
  shared?: SharedUplink;
  /** Seed of this direction's random numbers. */
  seed: number;
}

/** Real timers for LoopbackNet.startRealtime (passed in so this module touches no globals). */
export interface RealtimeHooks {
  /** Current time in ms (e.g. performance.now). */
  now(): number;
  /** Run `fn` after `ms` milliseconds; returns a handle for cancel (e.g. setTimeout). */
  schedule(fn: () => void, ms: number): unknown;
  /** Cancel a scheduled call (e.g. clearTimeout). */
  cancel(handle: unknown): void;
}

interface NetEvent {
  at: number;
  seq: number;
  run: () => void;
}

function earlier(a: NetEvent, b: NetEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

interface Realtime {
  hooks: RealtimeHooks;
  /** Wall time at virtual time 0. */
  origin: number;
  handle: unknown;
  armedAt: number;
}

/** The virtual clock and event queue shared by every loopback pair of a test. */
export class LoopbackNet {
  private time = 0;
  private seq = 0;
  /** Binary min-heap by (at, seq). */
  private readonly heap: NetEvent[] = [];
  private rt: Realtime | null = null;

  /** Current time, ms. */
  get now(): number {
    const rt = this.rt;
    return rt === null ? this.time : Math.max(this.time, rt.hooks.now() - rt.origin);
  }

  /** Time of the next due event (a delivery or a retransmission), or null when nothing is in flight. */
  nextEventTime(): number | null {
    return this.heap.length > 0 ? this.heap[0]!.at : null;
  }

  /** Run every event due at or before `ms`, in time order, then set the clock to `ms`. */
  advanceTo(ms: number): void {
    if (this.rt !== null) throw new Error('LoopbackNet: advanceTo while running on real timers');
    if (!(ms >= this.time)) throw new RangeError(`LoopbackNet: cannot go back in time (${ms} < ${this.time})`);
    this.runUntil(ms);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.time + ms);
  }

  /**
   * Drive the queue from real timers from now on (manual latency testing in a browser):
   * `now` follows hooks.now(). Returns the function that stops it.
   */
  startRealtime(hooks: RealtimeHooks): () => void {
    if (this.rt !== null) throw new Error('LoopbackNet: already running on real timers');
    const rt: Realtime = { hooks, origin: hooks.now() - this.time, handle: null, armedAt: Infinity };
    this.rt = rt;
    this.arm();
    return () => {
      if (this.rt !== rt) return;
      if (rt.handle !== null) hooks.cancel(rt.handle);
      this.time = this.now;
      this.rt = null;
    };
  }

  /** Queue `run` at time `at` (internal to the loopback). */
  schedule(at: number, run: () => void): void {
    const heap = this.heap;
    const e: NetEvent = { at, seq: this.seq++, run };
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!earlier(e, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = e;
    if (this.rt !== null && at < this.rt.armedAt) this.arm();
  }

  private pop(): NetEvent {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heap.length) break;
        const r = l + 1;
        const c = r < heap.length && earlier(heap[r]!, heap[l]!) ? r : l;
        if (!earlier(heap[c]!, last)) break;
        heap[i] = heap[c]!;
        i = c;
      }
      heap[i] = last;
    }
    return top;
  }

  private runUntil(t: number): void {
    while (this.heap.length > 0 && this.heap[0]!.at <= t) {
      const e = this.pop();
      if (e.at > this.time) this.time = e.at;
      e.run();
    }
    if (t > this.time) this.time = t;
  }

  private arm(): void {
    const rt = this.rt!;
    if (rt.handle !== null) rt.hooks.cancel(rt.handle);
    rt.handle = null;
    rt.armedAt = Infinity;
    if (this.heap.length === 0) return;
    const at = this.heap[0]!.at;
    rt.armedAt = at;
    rt.handle = rt.hooks.schedule(() => {
      if (this.rt !== rt) return;
      rt.handle = null;
      rt.armedAt = Infinity;
      this.runUntil(this.now);
      if (this.rt === rt) this.arm();
    }, Math.max(0, at - this.now));
  }
}

function checkConditions(c: LinkConditions, name: string): void {
  const ok =
    c.latencyMs >= 0 &&
    Number.isFinite(c.latencyMs) &&
    c.jitterMs >= 0 &&
    Number.isFinite(c.jitterMs) &&
    c.loss >= 0 &&
    c.loss <= 1 &&
    (c.bandwidthBytesPerSec === undefined || (c.bandwidthBytesPerSec > 0 && Number.isFinite(c.bandwidthBytesPerSec))) &&
    (c.rtoMs === undefined || (c.rtoMs > 0 && Number.isFinite(c.rtoMs))) &&
    (c.shared === undefined || c.bandwidthBytesPerSec === undefined) &&
    Number.isInteger(c.seed);
  if (!ok) throw new RangeError(`invalid ${name} link conditions: ${JSON.stringify({ ...c, shared: c.shared?.bytesPerSec })}`);
}

/** A message waiting in a SharedUplink. */
interface UplinkItem {
  readonly channel: Channel;
  /** Payload bytes (bufferedBytes). */
  readonly size: number;
  /** Bytes on the wire, headers included. */
  readonly wire: number;
  /** Wire bytes not sent yet. */
  remaining: number;
  /** Called when its last byte left. */
  readonly departed: () => void;
}

/** Bytes left below this count as sent (floating point rounding of the shares). */
const UPLINK_EPSILON = 1e-6;

/** One sender's uplink shared by several links (see the file comment, SHARED UPLINK). */
export class SharedUplink {
  /** Waiting messages per link, oldest first. */
  private readonly flows = new Map<object, UplinkItem[]>();
  private lastUpdate = 0;
  /** Only the newest scheduled completion check counts. */
  private generation = 0;
  /** Wire bytes handed to the uplink so far, headers included. */
  wireBytes = 0;

  /**
   * `bytesPerSec` of the uplink; `headerBytes` per packet of at most `packetBytes` payload (a
   * reliable message longer than a packet goes in several).
   */
  constructor(
    private readonly net: LoopbackNet,
    readonly bytesPerSec: number,
    readonly headerBytes = 80,
    readonly packetBytes = MAX_UNRELIABLE_BYTES,
  ) {
    if (!(bytesPerSec > 0 && Number.isFinite(bytesPerSec)) || !(headerBytes >= 0) || !(packetBytes > 0)) {
      throw new RangeError(`invalid shared uplink: ${bytesPerSec} B/s, ${headerBytes} B per ${packetBytes} B packet`);
    }
  }

  /** Queue `size` payload bytes of `flow` on `channel`; `departed` runs when they have left (size 0: when every earlier message of the flow has). */
  enqueue(flow: object, channel: Channel, size: number, departed: () => void): void {
    this.advance();
    const wire = size === 0 ? 0 : size + this.headerBytes * Math.ceil(size / this.packetBytes);
    let q = this.flows.get(flow);
    if (q === undefined) {
      q = [];
      this.flows.set(flow, q);
    }
    q.push({ channel, size, wire, remaining: wire, departed });
    this.wireBytes += wire;
    this.complete();
    this.schedule();
  }

  /** Payload bytes of `flow` on `channel` that have not left yet. */
  buffered(flow: object, channel: Channel): number {
    this.advance();
    const q = this.flows.get(flow);
    if (q === undefined) return 0;
    let total = 0;
    for (const it of q) if (it.channel === channel && it.wire > 0) total += Math.ceil((it.size * it.remaining) / it.wire);
    return total;
  }

  /** Serve every flow with bytes waiting its share of the time since the last update. */
  private advance(): void {
    const now = this.net.now;
    const dt = now - this.lastUpdate;
    this.lastUpdate = now;
    if (dt <= 0 || this.flows.size === 0) return;
    const share = (dt * this.bytesPerSec) / 1000 / this.flows.size;
    for (const q of this.flows.values()) q[0]!.remaining -= share;
  }

  /** Every message at the head of its flow whose bytes have all left departs. */
  private complete(): void {
    for (const [flow, q] of this.flows) {
      while (q.length > 0 && q[0]!.remaining <= UPLINK_EPSILON) q.shift()!.departed();
      if (q.length === 0) this.flows.delete(flow);
    }
  }

  /** Check again when the next head message will have left (at the present shares). */
  private schedule(): void {
    const gen = ++this.generation;
    if (this.flows.size === 0) return;
    let least = Infinity;
    for (const q of this.flows.values()) least = Math.min(least, q[0]!.remaining);
    const at = this.net.now + (Math.max(0, least) * this.flows.size * 1000) / this.bytesPerSec;
    this.net.schedule(at, () => {
      if (gen !== this.generation) return;
      this.advance();
      this.complete();
      this.schedule();
    });
  }
}

/** A reliable message (or the close marker) waiting for its turn on a link. */
interface ReliableItem {
  bytes: Uint8Array | null;
  /** Close marker only. */
  reason: string;
  /** When it is ready at the far end; NaN while a retransmission is pending. */
  ready: number;
}

/** A reliable message whose first transmission was lost, waiting for its retransmission time. */
interface PendingLoss {
  item: ReliableItem;
  /** Later messages on this direction that arrived (not lost) so far. */
  later: number;
  /** departure + rto + latency. */
  deadline: number;
}

/** Bytes waiting in the link's bandwidth queue. */
interface Queued {
  channel: Channel;
  size: number;
  start: number;
  finish: number;
}

/** One direction: from one end to the other. */
class Link {
  private readonly net: LoopbackNet;
  private readonly cond: LinkConditions;
  private readonly rng: Rng;
  private readonly to: LoopbackEnd;
  /** When the bandwidth queue empties. */
  private queueEnd = 0;
  private readonly queued: Queued[] = [];
  /** Reliable messages in send order, not yet scheduled for delivery. */
  private readonly reliable: ReliableItem[] = [];
  private lastReliable = 0;
  private readonly losses: PendingLoss[] = [];

  constructor(net: LoopbackNet, cond: LinkConditions, to: LoopbackEnd) {
    this.net = net;
    this.cond = cond;
    this.rng = new Rng(cond.seed);
    this.to = to;
  }

  /** Departure time (left the byte queue) of `size` bytes handed over now. */
  private depart(channel: Channel, size: number): number {
    const now = this.net.now;
    const bw = this.cond.bandwidthBytesPerSec;
    if (bw === undefined) return now;
    const start = Math.max(now, this.queueEnd);
    const finish = start + (size * 1000) / bw;
    this.queueEnd = finish;
    if (size > 0) this.queued.push({ channel, size, start, finish });
    return finish;
  }

  buffered(channel: Channel): number {
    const shared = this.cond.shared;
    if (shared !== undefined) return shared.buffered(this, channel);
    const now = this.net.now;
    const q = this.queued;
    let k = 0;
    while (k < q.length && q[k]!.finish <= now) k++;
    if (k > 0) q.splice(0, k);
    let total = 0;
    for (const e of q) {
      if (e.channel !== channel) continue;
      total += e.start >= now ? e.size : Math.ceil((e.size * (e.finish - now)) / (e.finish - e.start));
    }
    return total;
  }

  send(channel: Channel, bytes: Uint8Array): void {
    const copy = bytes.slice();
    const shared = this.cond.shared;
    if (shared !== undefined) shared.enqueue(this, channel, copy.length, () => this.transmit(channel, copy, this.net.now));
    else this.transmit(channel, copy, this.depart(channel, copy.length));
  }

  /** A message that left the sender at `departure`: lost, or on its way. */
  private transmit(channel: Channel, copy: Uint8Array, departure: number): void {
    const latency = this.cond.latencyMs;
    const lost = this.rng.next() < this.cond.loss;
    const arrival = departure + latency + this.rng.next() * this.cond.jitterMs;
    if (!lost) {
      // A later message got through: count it for every earlier lost reliable message.
      for (let i = 0; i < this.losses.length; i++) {
        const p = this.losses[i]!;
        if (++p.later === 3) {
          this.resolve(p, Math.min(p.deadline, arrival + 2 * latency));
          i--;
        }
      }
    }
    if (channel === UNRELIABLE) {
      if (!lost) this.net.schedule(arrival, () => this.to.receive(UNRELIABLE, copy));
      return;
    }
    const item: ReliableItem = { bytes: copy, reason: '', ready: lost ? NaN : arrival };
    this.reliable.push(item);
    if (lost) {
      const p: PendingLoss = { item, later: 0, deadline: departure + (this.cond.rtoMs ?? DEFAULT_RTO_MS) + latency };
      this.losses.push(p);
      this.net.schedule(p.deadline, () => {
        if (Number.isNaN(item.ready)) this.resolve(p, p.deadline);
      });
    }
    this.flush();
  }

  close(reason: string): void {
    const shared = this.cond.shared;
    if (shared !== undefined) shared.enqueue(this, RELIABLE, 0, () => this.transmitClose(reason, this.net.now));
    else this.transmitClose(reason, this.depart(RELIABLE, 0));
  }

  private transmitClose(reason: string, departure: number): void {
    this.reliable.push({ bytes: null, reason, ready: departure + this.cond.latencyMs });
    this.flush();
  }

  private resolve(p: PendingLoss, ready: number): void {
    p.item.ready = ready;
    this.losses.splice(this.losses.indexOf(p), 1);
    this.flush();
  }

  /** Schedule every reliable message at the head whose ready time is known, in order. */
  private flush(): void {
    const q = this.reliable;
    while (q.length > 0 && !Number.isNaN(q[0]!.ready)) {
      const item = q.shift()!;
      const at = Math.max(this.lastReliable, item.ready);
      this.lastReliable = at;
      const to = this.to;
      if (item.bytes === null) this.net.schedule(at, () => to.closedByPeer(item.reason));
      else {
        const bytes = item.bytes;
        this.net.schedule(at, () => to.receive(RELIABLE, bytes));
      }
    }
  }
}

class LoopbackEnd implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private isOpen = true;
  private out: Link | null = null;

  get open(): boolean {
    return this.isOpen;
  }

  connect(out: Link): void {
    this.out = out;
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (channel !== RELIABLE && channel !== UNRELIABLE) throw new RangeError(`unknown channel ${String(channel)}`);
    const max = channel === RELIABLE ? MAX_RELIABLE_BYTES : MAX_UNRELIABLE_BYTES;
    if (bytes.length > max) throw new RangeError(`message of ${bytes.length} bytes exceeds the ${channel === RELIABLE ? 'reliable' : 'unreliable'} limit of ${max}`);
    if (!this.isOpen) return;
    this.out!.send(channel, bytes);
  }

  bufferedBytes(channel: Channel): number {
    return this.out!.buffered(channel);
  }

  close(reason = 'closed'): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.out!.close(reason);
  }

  receive(channel: Channel, bytes: Uint8Array): void {
    if (this.isOpen) this.onMessage?.(channel, bytes);
  }

  closedByPeer(reason: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose?.(reason);
  }
}

/**
 * Two connected Transports on `net`: `up` describes the client -> server direction, `down` the
 * server -> client one.
 */
export function createLoopbackPair(net: LoopbackNet, up: LinkConditions, down: LinkConditions): { client: Transport; server: Transport } {
  checkConditions(up, 'up');
  checkConditions(down, 'down');
  const client = new LoopbackEnd();
  const server = new LoopbackEnd();
  client.connect(new Link(net, up, server));
  server.connect(new Link(net, down, client));
  return { client, server };
}
