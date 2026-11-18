/**
 * WebRtcTransport: the Transport between two browsers (docs/NETCODE.md section 2, package 10).
 *
 * One RTCPeerConnection, two data channels negotiated out of band (both ends create them, no
 * 'datachannel' event): 'r' (id 0, ordered, reliable) carries RELIABLE, 'u' (id 1, unordered,
 * maxRetransmits 0) carries UNRELIABLE; binaryType 'arraybuffer'. The page makes the connection
 * (connect.ts) and hands the open channels to this class, which only moves bytes.
 *
 * FRAGMENTS (reliable channel only; the format never changes, section 3): every data channel
 * message starts with one byte. 0: a whole message follows (1 to FRAGMENT_BYTES bytes). 1: the
 * first fragment of a longer one: a u32 (little endian, as save/bytes.ts) with the message's total
 * length, then FRAGMENT_BYTES bytes. 2: a middle fragment, 3: the last one, each 1 to
 * FRAGMENT_BYTES bytes. The sender cuts at FRAGMENT_BYTES: a message of FRAGMENT_BYTES bytes or
 * less goes whole. Unreliable messages are never fragmented and carry no header (section 2: at
 * most MAX_UNRELIABLE_BYTES; losing one fragment would lose them all).
 *
 * WHAT A PEER MAY SEND. Anything that breaks the format ends the connection as a failure (onClose
 * 'transport_error'): a declared total above MAX_RELIABLE_BYTES, a fragment above FRAGMENT_BYTES
 * or empty, fragments beyond the declared total or a last fragment short of it, a middle or last
 * fragment without a first one, a new message inside an unfinished one, an unknown kind, text
 * instead of bytes, an unreliable message above MAX_UNRELIABLE_BYTES or empty. Memory is bounded:
 * one message under assembly, at most MAX_RELIABLE_BYTES, allocated when its first fragment
 * declares its length; every fragment adds at least one byte, so no stream goes on for ever
 * without reaching its declared end.
 *
 * BACKLOG. bufferedBytes(channel) is the channel's bufferedAmount. onBufferedLow fires when a
 * channel's bufferedAmount falls to BUFFERED_LOW_BYTES (the 'bufferedamountlow' event; the room's
 * forwarder reports the backlog then, section 2). Nothing is queued here: a send the browser
 * refuses (its own buffer is full, about 16 MiB in Chrome, far above MAX_BACKLOG where the server
 * gives up on a client) ends the connection.
 *
 * CLOSING (section 2). close(): nothing more is sent or delivered; the reliable channel is closed
 * first, which the browser does only after the messages already queued on it went out (the
 * stream reset comes after them), then the unreliable channel and the peer connection, once the
 * reliable channel has closed or CLOSE_LINGER_MS passed. This end's onClose is not called. The
 * other end sees the reliable channel close after every reliable message sent before it and
 * reports onClose('closed'): a close reason cannot cross (the format has no room for one; the
 * protocol's reasons travel in Kick and Bye). onClose also fires, at most once, when either
 * channel closes, when the connection's state becomes 'failed' (ICE failed, or the consent
 * checks found the other end gone: 'ice_failed') or 'closed', and on a format violation.
 *
 * No globals: the peer connection and its channels come from the page, the linger timer too.
 */
import { MAX_RELIABLE_BYTES, MAX_UNRELIABLE_BYTES } from '../protocol';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../transport';

/** Payload bytes of one reliable fragment (section 2: 16 KiB). */
export const FRAGMENT_BYTES = 16 * 1024;
/** Fragment kinds (the first byte of every reliable data channel message). */
export const FRAGMENT_WHOLE = 0;
export const FRAGMENT_FIRST = 1;
export const FRAGMENT_MIDDLE = 2;
export const FRAGMENT_LAST = 3;
/** onBufferedLow fires when a channel's backlog falls to this (the floor of the server's deferral threshold, section 2). */
export const BUFFERED_LOW_BYTES = 8 * 1024;
/** After close(), the peer connection is closed this long at the latest, ms. */
export const CLOSE_LINGER_MS = 5000;
/** The labels and ids of the two channels. */
export const RELIABLE_LABEL = 'r';
export const UNRELIABLE_LABEL = 'u';
export const RELIABLE_ID = 0;
export const UNRELIABLE_ID = 1;

/** The part of an RTCDataChannel this transport uses (tests pass a fake). */
export type RtcChannel = Pick<
  RTCDataChannel,
  'label' | 'readyState' | 'bufferedAmount' | 'bufferedAmountLowThreshold' | 'binaryType' | 'send' | 'close' | 'onmessage' | 'onclose' | 'onerror' | 'onbufferedamountlow'
>;

/** The part of an RTCPeerConnection this transport uses (getStats: the page's connection diagnostics; fakes may leave it out). */
export type RtcPeerState = Pick<RTCPeerConnection, 'connectionState' | 'onconnectionstatechange' | 'close'> & { getStats?: () => Promise<RTCStatsReport> };

/** A one-shot timer (the page's setTimeout). */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export class WebRtcTransport implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  /** A channel's backlog fell to BUFFERED_LOW_BYTES. */
  onBufferedLow: ((channel: Channel) => void) | null = null;

  private isOpen = true;
  /** The message under assembly and how much of it has arrived. */
  private assembling: Uint8Array | null = null;
  private filled = 0;
  private linger: unknown = null;

  constructor(
    private readonly peer: RtcPeerState,
    private readonly reliable: RtcChannel,
    private readonly unreliable: RtcChannel,
    private readonly timers: Timers,
  ) {
    for (const [ch, channel] of [
      [RELIABLE, reliable],
      [UNRELIABLE, unreliable],
    ] as const) {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = BUFFERED_LOW_BYTES;
      channel.onmessage = (ev) => this.receive(ch, ev.data);
      channel.onclose = () => this.fail('closed');
      channel.onerror = () => this.fail('channel_error');
      channel.onbufferedamountlow = () => {
        if (this.isOpen) this.onBufferedLow?.(ch);
      };
    }
    peer.onconnectionstatechange = () => {
      const s = peer.connectionState;
      if (s === 'failed') this.fail('ice_failed');
      else if (s === 'closed') this.fail('closed');
    };
    if (reliable.readyState !== 'open' || unreliable.readyState !== 'open') {
      // Built on channels that are not (or no longer) open: closed from the start, reported later.
      this.isOpen = false;
      this.shutDown();
      this.timers.set(() => this.report('closed'), 0);
    }
  }

  get open(): boolean {
    return this.isOpen;
  }

  send(channel: Channel, bytes: Uint8Array): void {
    if (channel !== RELIABLE && channel !== UNRELIABLE) throw new RangeError(`unknown channel ${String(channel)}`);
    const max = channel === RELIABLE ? MAX_RELIABLE_BYTES : MAX_UNRELIABLE_BYTES;
    if (bytes.length > max) throw new RangeError(`message of ${bytes.length} bytes exceeds the ${channel === RELIABLE ? 'reliable' : 'unreliable'} limit of ${max}`);
    if (!this.isOpen) return;
    try {
      if (channel === UNRELIABLE) {
        // The codec's messages are views on ArrayBuffers (never shared memory).
        this.unreliable.send(bytes as Uint8Array<ArrayBuffer>);
        return;
      }
      for (const fragment of fragments(bytes)) this.reliable.send(fragment);
    } catch {
      // The browser refused (its buffer is full, or the channel closed under us): the connection
      // is over. Reported from a timer, never from inside the caller's send().
      this.isOpen = false;
      this.shutDown();
      this.timers.set(() => this.report('send_failed'), 0);
    }
  }

  /**
   * The peer connection's statistics (the page's connection diagnostics read the candidate pair in
   * use), or null when the connection is closed or cannot report them.
   */
  stats(): Promise<RTCStatsReport> | null {
    if (!this.isOpen || this.peer.getStats === undefined) return null;
    return this.peer.getStats();
  }

  bufferedBytes(channel: Channel): number {
    if (!this.isOpen) return 0;
    return channel === RELIABLE ? this.reliable.bufferedAmount : this.unreliable.bufferedAmount;
  }

  close(_reason?: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onMessage = null;
    this.assembling = null;
    this.shutDown();
  }

  // ------------------------------------------------------------------ inside

  /** Close the reliable channel (it flushes), then the rest once it closed or the linger ran out. */
  private shutDown(): void {
    const finish = (): void => {
      if (this.linger !== null) this.timers.clear(this.linger);
      this.linger = null;
      this.reliable.onclose = null;
      this.unreliable.onclose = null;
      this.reliable.onmessage = null;
      this.unreliable.onmessage = null;
      this.reliable.onerror = null;
      this.unreliable.onerror = null;
      this.reliable.onbufferedamountlow = null;
      this.unreliable.onbufferedamountlow = null;
      this.peer.onconnectionstatechange = null;
      safely(() => this.unreliable.close());
      safely(() => this.peer.close());
    };
    this.reliable.onmessage = null;
    this.unreliable.onmessage = null;
    this.reliable.onerror = null;
    this.unreliable.onerror = null;
    this.reliable.onclose = finish;
    this.unreliable.onclose = null;
    this.peer.onconnectionstatechange = () => {
      if (this.peer.connectionState === 'failed' || this.peer.connectionState === 'closed') finish();
    };
    this.linger = this.timers.set(finish, CLOSE_LINGER_MS);
    const s = this.peer.connectionState;
    // Nothing left to flush on a channel that is closed or a connection that failed.
    if (this.reliable.readyState === 'closed' || s === 'failed' || s === 'closed') finish();
    else safely(() => this.reliable.close());
  }

  /** The connection ended without close() here: report once, and let the browser objects go. */
  private fail(reason: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.assembling = null;
    this.shutDown();
    this.report(reason);
  }

  private report(reason: string): void {
    const f = this.onClose;
    this.onClose = null;
    this.onMessage = null;
    f?.(reason);
  }

  private receive(channel: Channel, data: unknown): void {
    if (!this.isOpen) return;
    if (!(data instanceof ArrayBuffer)) return this.fail('transport_error');
    if (channel === UNRELIABLE) {
      if (data.byteLength === 0 || data.byteLength > MAX_UNRELIABLE_BYTES) return this.fail('transport_error');
      this.onMessage?.(UNRELIABLE, new Uint8Array(data));
      return;
    }
    const whole = this.reassemble(new Uint8Array(data));
    if (whole === 'bad') return this.fail('transport_error');
    if (whole !== null) this.onMessage?.(RELIABLE, whole);
  }

  /** One reliable fragment: the finished message, null while one is being assembled, 'bad' for a violation. */
  private reassemble(f: Uint8Array): Uint8Array | null | 'bad' {
    if (f.length < 2) return 'bad';
    const kind = f[0]!;
    switch (kind) {
      case FRAGMENT_WHOLE:
        if (this.assembling !== null || f.length - 1 > FRAGMENT_BYTES) return 'bad';
        return f.subarray(1);
      case FRAGMENT_FIRST: {
        if (this.assembling !== null || f.length < 6) return 'bad';
        const total = (f[1]! | (f[2]! << 8) | (f[3]! << 16) | (f[4]! << 24)) >>> 0;
        const n = f.length - 5;
        if (total > MAX_RELIABLE_BYTES || n > FRAGMENT_BYTES || n >= total) return 'bad';
        this.assembling = new Uint8Array(total);
        this.assembling.set(f.subarray(5), 0);
        this.filled = n;
        return null;
      }
      case FRAGMENT_MIDDLE:
      case FRAGMENT_LAST: {
        const msg = this.assembling;
        const n = f.length - 1;
        if (msg === null || n > FRAGMENT_BYTES) return 'bad';
        const end = this.filled + n;
        if (kind === FRAGMENT_MIDDLE ? end >= msg.length : end !== msg.length) return 'bad';
        msg.set(f.subarray(1), this.filled);
        this.filled = end;
        if (kind === FRAGMENT_MIDDLE) return null;
        this.assembling = null;
        return msg;
      }
      default:
        return 'bad';
    }
  }
}

/** The data channel messages of one reliable message (section 2's fragment format). */
export function fragments(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const n = bytes.length;
  if (n <= FRAGMENT_BYTES) {
    const f = new Uint8Array(n + 1);
    f[0] = FRAGMENT_WHOLE;
    f.set(bytes, 1);
    return [f];
  }
  const out: Uint8Array<ArrayBuffer>[] = [];
  const first = new Uint8Array(5 + FRAGMENT_BYTES);
  first[0] = FRAGMENT_FIRST;
  first[1] = n & 0xff;
  first[2] = (n >>> 8) & 0xff;
  first[3] = (n >>> 16) & 0xff;
  first[4] = (n >>> 24) & 0xff;
  first.set(bytes.subarray(0, FRAGMENT_BYTES), 5);
  out.push(first);
  for (let at = FRAGMENT_BYTES; at < n; at += FRAGMENT_BYTES) {
    const end = Math.min(n, at + FRAGMENT_BYTES);
    const f = new Uint8Array(1 + end - at);
    f[0] = end === n ? FRAGMENT_LAST : FRAGMENT_MIDDLE;
    f.set(bytes.subarray(at, end), 1);
    out.push(f);
  }
  return out;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // already closed
  }
}
