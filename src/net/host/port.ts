/**
 * PortTransport: a Transport over a MessagePort (docs/NETCODE.md sections 1, 2). The page's own
 * client talks to the server Worker through one; in a room, every guest's data channel bytes are
 * forwarded by the host page through a MessagePort of their own.
 *
 * WHAT GOES THROUGH THE PORT (both directions, structured clone):
 *  - { kind: 'msg', channel, data }: one protocol message; `data` is an ArrayBuffer of exactly the
 *    message's bytes, TRANSFERRED: send() copies the caller's bytes into a fresh buffer and
 *    transfers that one, so the caller may reuse its array at once and no buffer is ever shared
 *    between the two sides. The receiver owns the Uint8Array it is handed.
 *  - { kind: 'close', reason }: the sender closed the connection; posted behind every message it
 *    sent before (a port keeps order), so the far end's onClose comes after them.
 *  - { kind: 'backlog', channel, bufferedAmount, seen } (only from a forwarder to the server
 *    side): section 2 "房间里的积压". The host page holds the guest's data channels; for each
 *    channel it reports, on 'bufferedamountlow' and at least every 100 ms, the channel's
 *    bufferedAmount and `seen` = the bytes of that channel it has received from this port so far.
 *    bufferedBytes(channel) = that bufferedAmount + (bytes posted on the channel - seen). A port
 *    that never gets a report (the local client's: postMessage has no backlog the server could
 *    act on) reports 0.
 * Both channels arrive in order and nothing is lost ("the unreliable channel is in fact reliable",
 * section 2, which the protocol allows).
 *
 * Whatever else arrives on the port is ignored. Only this module and worker.ts touch the
 * MessagePort API (section 15).
 */
import { MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from '../protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../transport';

/** The part of a MessagePort a PortTransport uses (tests pass a fake). */
export interface PortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
}

/** A protocol message through the port. */
export interface PortData {
  kind: 'msg';
  channel: Channel;
  data: ArrayBuffer;
}

/** The sender closed the connection. */
export interface PortClose {
  kind: 'close';
  reason: string;
}

/** A forwarder's report of one channel's backlog (section 2). */
export interface PortBacklog {
  kind: 'backlog';
  channel: Channel;
  /** The data channel's bufferedAmount. */
  bufferedAmount: number;
  /** Bytes of this channel received from this port so far. */
  seen: number;
}

export type PortFrame = PortData | PortClose | PortBacklog;

function isChannel(v: unknown): v is Channel {
  return v === RELIABLE || v === UNRELIABLE;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export class PortTransport implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  private isOpen = true;
  /** Bytes posted per channel. */
  private readonly posted: [number, number] = [0, 0];
  /** The last backlog report per channel, null until the first. */
  private readonly reports: [PortBacklog | null, PortBacklog | null] = [null, null];

  constructor(private readonly port: PortLike) {
    port.onmessage = (ev) => this.receive(ev.data);
  }

  get open(): boolean {
    return this.isOpen;
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (!isChannel(channel)) throw new RangeError(`unknown channel ${String(channel)}`);
    const max = channel === RELIABLE ? MAX_RELIABLE_BYTES : MAX_UNRELIABLE_BYTES;
    if (bytes.length > max) throw new RangeError(`message of ${bytes.length} bytes exceeds the ${channel === RELIABLE ? 'reliable' : 'unreliable'} limit of ${max}`);
    if (!this.isOpen) return;
    const copy = bytes.slice();
    const frame: PortData = { kind: 'msg', channel, data: copy.buffer };
    // Counted before the transfer detaches the copy.
    this.posted[channel] += copy.length;
    this.port.postMessage(frame, [copy.buffer]);
  }

  bufferedBytes(channel: Channel): number {
    const r = this.reports[channel];
    return r === null ? 0 : Math.max(0, r.bufferedAmount + this.posted[channel] - r.seen);
  }

  close(reason = 'closed'): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    const frame: PortClose = { kind: 'close', reason };
    this.port.postMessage(frame, []);
    this.port.onmessage = null;
    this.port.close();
  }

  private receive(data: unknown): void {
    if (!this.isOpen || data === null || typeof data !== 'object') return;
    const f = data as Record<string, unknown>;
    if (f.kind === 'msg') {
      if (isChannel(f.channel) && f.data instanceof ArrayBuffer) this.onMessage?.(f.channel, new Uint8Array(f.data));
    } else if (f.kind === 'backlog') {
      if (isChannel(f.channel) && isCount(f.bufferedAmount) && isCount(f.seen)) {
        this.reports[f.channel] = { kind: 'backlog', channel: f.channel, bufferedAmount: f.bufferedAmount, seen: f.seen };
      }
    } else if (f.kind === 'close') {
      this.isOpen = false;
      this.port.onmessage = null;
      this.port.close();
      this.onClose?.(typeof f.reason === 'string' ? f.reason : 'closed');
    }
  }
}
