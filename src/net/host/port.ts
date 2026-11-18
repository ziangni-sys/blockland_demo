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
 *    A port that never gets a report (the local client's: postMessage has no backlog the server
 *    could act on) reports 0.
 *
 * THE BACKLOG between reports (package 13). At a report the channel holds its bufferedAmount plus
 * what was posted since the forwarder's `seen`; after it, the channel keeps sending while the
 * server keeps posting, and the next report may be 100 ms away, as long as the server's whole
 * window for deferring (0.1 s). Counting none of that sending would read the bytes of the last
 * 100 ms as backlog even on a link that carried them at once: the server would hold back new
 * interest and samples for nothing. So bufferedBytes(channel) = bufferedAmount + (posted - seen)
 * - drain x (ms since the report), at least 0, where drain is what the channel sent per ms between
 * two reports: its capacity when it still had a backlog at the later one (smoothed), else at least
 * that much (the channel kept up). Without a clock (`now`) nothing is subtracted.
 *
 * The clock is the server's: it times when a report ARRIVES, not when the page made it. A Worker
 * busy for longer than a report interval (a long tick, a GC) receives the reports queued meanwhile
 * microseconds apart; bytes the channel sent over 100 ms of page time divided by such a gap would
 * read as a drain thousands of times too large, and the backlog as 0 right after every report
 * (the server would then pour its whole budget into a full channel). So a report that arrives
 * less than DRAIN_MIN_GAP_MS after the one before is not used to measure the drain; the next
 * measurement starts from it (the last of a bunch, whose arrival is closest to when it was made).
 *
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

/** A backlog report as kept: the channel's bufferedAmount and `seen`, and when it came (ms). */
interface Report {
  bufferedAmount: number;
  seen: number;
  at: number;
}

/** Weight of the newest busy interval in a channel's drain estimate. */
const DRAIN_SMOOTHING = 0.5;
/**
 * Two reports of a channel that arrive closer than this (ms) do not measure its drain: half the
 * forwarder's report interval (BACKLOG_REPORT_MS, 100), so reports a busy Worker gets bunched
 * never do (see THE BACKLOG).
 */
const DRAIN_MIN_GAP_MS = 50;

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
  /** The last backlog report per channel and when it came, null until the first. */
  private readonly reports: [Report | null, Report | null] = [null, null];
  /** Bytes per ms each channel sends (see THE BACKLOG). */
  private readonly drain: [number, number] = [0, 0];

  /** `now`: milliseconds of a monotonic clock (the server's), for the backlog between reports. */
  constructor(
    private readonly port: PortLike,
    private readonly now: (() => number) | null = null,
  ) {
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
    if (r === null) return 0;
    const sent = this.now === null ? 0 : this.drain[channel] * Math.max(0, this.now() - r.at);
    return Math.max(0, Math.round(r.bufferedAmount + this.posted[channel] - r.seen - sent));
  }

  close(reason = 'closed'): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    const frame: PortClose = { kind: 'close', reason };
    this.port.postMessage(frame, []);
    this.port.onmessage = null;
    this.port.close();
  }

  private report(channel: Channel, bufferedAmount: number, seen: number): void {
    const at = this.now?.() ?? 0;
    const prev = this.reports[channel];
    if (prev !== null && at - prev.at >= DRAIN_MIN_GAP_MS) {
      const rate = Math.max(0, prev.bufferedAmount + (seen - prev.seen) - bufferedAmount) / (at - prev.at);
      const d = this.drain[channel];
      this.drain[channel] = bufferedAmount > 0 ? d + DRAIN_SMOOTHING * (rate - d) : Math.max(d, rate);
    }
    this.reports[channel] = { bufferedAmount, seen, at };
  }

  private receive(data: unknown): void {
    if (!this.isOpen || data === null || typeof data !== 'object') return;
    const f = data as Record<string, unknown>;
    if (f.kind === 'msg') {
      if (isChannel(f.channel) && f.data instanceof ArrayBuffer) this.onMessage?.(f.channel, new Uint8Array(f.data));
    } else if (f.kind === 'backlog') {
      if (isChannel(f.channel) && isCount(f.bufferedAmount) && isCount(f.seen)) this.report(f.channel, f.bufferedAmount, f.seen);
    } else if (f.kind === 'close') {
      this.isOpen = false;
      this.port.onmessage = null;
      this.port.close();
      this.onClose?.(typeof f.reason === 'string' ? f.reason : 'closed');
    }
  }
}
