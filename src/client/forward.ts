/**
 * The host page's forwarder of one guest (docs/NETCODE.md section 1 "房间", section 2 "房间里的积压",
 * package 10). The guest's data channels live on the host page's main thread (Chrome cannot hand an
 * RTCDataChannel to a Worker); the server Worker sees the guest as a connection on a MessagePort
 * (host control `connect` with local false: a PortTransport there). The forwarder joins the two:
 *
 *  - guest -> server: every message of the guest's transport goes on the port unchanged, as
 *    { kind: 'msg', channel, data } with `data` transferred (exactly the message's bytes);
 *  - server -> guest: every 'msg' frame from the port goes out on the transport's channel unchanged;
 *  - the guest's link closed or failed: { kind: 'close', reason } on the port (behind every message
 *    forwarded before it), and the forwarder ends;
 *  - the server closed the connection (Refuse, Kick, Bye; the 'close' frame comes behind the last
 *    message): the transport is closed, which still delivers what is queued on the reliable channel
 *    (the Refuse or Kick reaches the guest), and the forwarder ends;
 *  - BACKLOG: for each channel { kind: 'backlog', channel, bufferedAmount, seen } at once when the
 *    port is connected (section 18: the server knows from its first batch on that this connection
 *    reports), when the transport says a channel's backlog fell (bufferedamountlow) and every
 *    BACKLOG_REPORT_MS; `seen` = the bytes of that channel received from the port so far. The
 *    server's PortTransport.bufferedBytes = bufferedAmount + (bytes it posted - seen), so the
 *    Replicator's back-pressure works for guests as for any link.
 *
 * Frames from the port are checked (channel, an ArrayBuffer); anything else is ignored, like
 * PortTransport does.
 */
import type { PortBacklog, PortClose, PortData, PortFrame, PortLike } from '../net/host/port';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../net/transport';

/** The backlog goes to the server at least this often, ms (section 2). */
export const BACKLOG_REPORT_MS = 100;

/** The guest's link as the forwarder needs it: a Transport that also says when a channel's backlog fell (WebRtcTransport). */
export interface ForwardedLink extends Transport {
  onBufferedLow: ((channel: Channel) => void) | null;
}

/** A repeating timer (the page's setInterval). */
export interface IntervalTimers {
  every(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

export class PortForwarder {
  /** Called once when the forwarder ended (either side closed): the page drops it. */
  onEnd: ((reason: string) => void) | null = null;
  /** Bytes per channel received from the port. */
  private readonly seen: [number, number] = [0, 0];
  private fromGuestCount = 0;
  private ended = false;
  private readonly timer: unknown;

  constructor(
    private readonly port: PortLike,
    private readonly link: ForwardedLink,
    private readonly timers: IntervalTimers,
  ) {
    port.onmessage = (ev) => this.fromServer(ev.data);
    link.onMessage = (channel, bytes) => this.fromGuest(channel, bytes);
    link.onClose = (reason) => this.guestClosed(reason);
    link.onBufferedLow = (channel) => this.report(channel);
    this.report(RELIABLE);
    this.report(UNRELIABLE);
    this.timer = timers.every(() => {
      this.report(RELIABLE);
      this.report(UNRELIABLE);
    }, BACKLOG_REPORT_MS);
  }

  get open(): boolean {
    return !this.ended;
  }

  /** Whether the guest sent a whole message yet (its Hello comes first, as soon as its link opens). */
  get heard(): boolean {
    return this.fromGuestCount > 0;
  }

  /** Bytes of `channel` forwarded from the server so far. */
  forwarded(channel: Channel): number {
    return this.seen[channel];
  }

  /** Close both sides (the page closes the room): the server sees the guest leave. */
  close(reason = 'closed'): void {
    if (this.ended) return;
    this.post({ kind: 'close', reason } satisfies PortClose);
    this.link.close(reason);
    this.end(reason);
  }

  private fromGuest(channel: Channel, bytes: Uint8Array): void {
    if (this.ended) return;
    this.fromGuestCount++;
    // Exactly the message's bytes, transferred: the transport's array may be a view on a fragment.
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
    const data = whole ? (bytes.buffer as ArrayBuffer) : bytes.slice().buffer;
    this.port.postMessage({ kind: 'msg', channel, data } satisfies PortData, [data]);
  }

  private fromServer(raw: unknown): void {
    if (this.ended || raw === null || typeof raw !== 'object') return;
    const f = raw as Partial<PortFrame> & Record<string, unknown>;
    if (f.kind === 'msg') {
      if ((f.channel !== RELIABLE && f.channel !== UNRELIABLE) || !(f.data instanceof ArrayBuffer)) return;
      this.seen[f.channel] += f.data.byteLength;
      try {
        this.link.send(f.channel, new Uint8Array(f.data));
      } catch {
        // A message the link cannot carry (a server bug): the guest's connection is over.
        this.close('forward_error');
      }
    } else if (f.kind === 'close') {
      const reason = typeof f.reason === 'string' ? f.reason : 'closed';
      this.link.close(reason);
      this.end(reason);
    }
  }

  private guestClosed(reason: string): void {
    if (this.ended) return;
    this.post({ kind: 'close', reason } satisfies PortClose);
    this.end(reason);
  }

  private report(channel: Channel): void {
    if (this.ended) return;
    this.post({ kind: 'backlog', channel, bufferedAmount: this.link.bufferedBytes(channel), seen: this.seen[channel] } satisfies PortBacklog);
  }

  private post(frame: PortClose | PortBacklog): void {
    try {
      this.port.postMessage(frame, []);
    } catch {
      // the port is gone
    }
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.timers.stop(this.timer);
    this.port.onmessage = null;
    this.link.onMessage = null;
    this.link.onClose = null;
    this.link.onBufferedLow = null;
    try {
      this.port.close();
    } catch {
      // closed
    }
    this.onEnd?.(reason);
  }
}
