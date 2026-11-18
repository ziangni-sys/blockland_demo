/**
 * Signalling (docs/NETCODE.md section 2, package 10): how two pages that share only a room code
 * exchange the WebRTC offer and answer. Kept behind an interface (section 2: not part of the
 * Transport), so a relay server can come later. Three implementations:
 *  - BroadcastSignaller (broadcast.ts): two pages of one browser, same origin (BroadcastChannel);
 *    the automated two-page tests and a quick local trial;
 *  - ManualSignaller (manual.ts): no service; the host shows an invitation code, the guest pastes
 *    it and gets an answer code, the host pastes that back;
 *  - CloudSignaller (cloud.ts): the free public PeerJS server, spoken to directly over a
 *    WebSocket as a relay of our own messages; the room code maps to a peer id.
 *
 * A SignalPath is the signalling between the host and one guest. Over it the two pages exchange
 * exactly one description each (connect.ts): the side named by `offerer` sends its offer once its
 * ICE gathering is complete (every candidate inside, so a code copied by hand works too), the
 * other answers the same way. After that the path is closed: the connection needs no signalling.
 *
 * Failures are DialErrors with a code (DialFailure): each one ends in its own message for the
 * player (client/strings.ts), never in a silent wait; every stage has a timeout.
 */

/** One description crossing a SignalPath, or the end of the path. */
export type SignalMessage = { t: 'offer'; sdp: string } | { t: 'answer'; sdp: string } | { t: 'bye' };

/** Why making a connection failed. */
export type DialFailure =
  /** The signalling service could not be reached (or this page has no way to signal). */
  | 'unreachable'
  /** No host answered for this room code. */
  | 'unknown'
  /** Another host already holds this room code. */
  | 'taken'
  /** The code (a manual invitation or answer, a room code) is malformed or does not fit. */
  | 'bad_code'
  /** The other page stopped answering in the middle of the handshake. */
  | 'no_answer'
  /** The other page left in the middle of the handshake. */
  | 'left'
  /** The direct connection could not be made (ICE failed, or found no way through in time). */
  | 'ice';

export class DialError extends Error {
  constructor(
    readonly code: DialFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DialError';
  }
}

/** The signalling between the host and one guest. */
export interface SignalPath {
  /** Which side makes the WebRTC offer on this path. */
  readonly offerer: 'host' | 'guest';
  send(m: SignalMessage): void;
  /** A message from the other side (messages that arrive before this is set wait for it). */
  onMessage: ((m: SignalMessage) => void) | null;
  /** The path broke: the service went away ('unreachable') or the other side is gone ('left'). */
  onEnd: ((reason: 'unreachable' | 'left') => void) | null;
  /** Done with it (tells the other side 'bye' when the path still works). */
  close(): void;
}

export interface Signaller {
  /** Which signalling this is (the page's ?signal= names). */
  readonly kind: 'broadcast' | 'manual' | 'cloud';
  /**
   * How long one side waits for the other's description (ms): seconds for a service, minutes
   * when a person copies the codes.
   */
  readonly patienceMs: number;
  /**
   * Host: take guests for room `code`, each as a path. Resolves once guests can reach it; rejects
   * with a DialError ('unreachable', 'taken', 'bad_code'). Called again after onLost. A listen that
   * close() cancels while it is under way resolves without listening (the caller closed it).
   */
  listen(code: string, onGuest: (path: SignalPath) => void): Promise<void>;
  /**
   * Host: the service stopped working while listening (guests cannot reach the room until
   * listen() succeeds again; connected guests are not affected).
   */
  onLost: (() => void) | null;
  /** Guest: a path to the host of room `code`. Rejects with a DialError ('unreachable', 'unknown', 'bad_code'). */
  dial(code: string): Promise<SignalPath>;
  /** Stop listening, or cancel a listen under way (paths handed out stay usable until they are closed). */
  close(): void;
}

/** Version of our signalling messages (in every envelope, so a later format is told apart). */
export const SIGNAL_VERSION = 1;

/** The characters of a room code: no 0/O, 1/I/L (read aloud, typed by hand). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Characters in a room code (31^8, about 40 bits: not guessable by strangers, short to type). */
export const ROOM_CODE_LENGTH = 8;

/** A new random room code. `random` fills a byte array (the page's crypto). */
export function newRoomCode(random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH * 2);
  random(bytes);
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    // Two bytes per character keep the bias below 0.05 %.
    const v = (bytes[2 * i]! << 8) | bytes[2 * i + 1]!;
    s += ROOM_CODE_ALPHABET[v % ROOM_CODE_ALPHABET.length];
  }
  return s;
}

/** A room code as typed (any case, spaces and dashes ignored), or null when it is not one. */
export function parseRoomCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of s) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** Random lowercase hex of `n` bytes. */
export function randomHex(random: (bytes: Uint8Array<ArrayBuffer>) => void, n: number): string {
  const bytes = new Uint8Array(n);
  random(bytes);
  let s = '';
  for (let i = 0; i < n; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** A SignalMessage, or null when `v` is not one (it came from another page: never trusted). */
export function parseSignalMessage(v: unknown): SignalMessage | null {
  if (v === null || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if ((m.t === 'offer' || m.t === 'answer') && typeof m.sdp === 'string' && m.sdp.length > 0 && m.sdp.length <= MAX_SDP_LENGTH) return { t: m.t, sdp: m.sdp };
  if (m.t === 'bye') return { t: 'bye' };
  return null;
}

/** Longest description accepted (a data-channel-only description with every candidate is 1 to 4 KB). */
export const MAX_SDP_LENGTH = 12_000;

/**
 * A path over a relay (BroadcastChannel, the cloud server): messages to the other side go through
 * `post`, messages from it come in through deliver(). Messages delivered before onMessage is set
 * wait for it.
 */
export class RelayPath implements SignalPath {
  private handler: ((m: SignalMessage) => void) | null = null;
  private endHandler: ((reason: 'unreachable' | 'left') => void) | null = null;
  private readonly waiting: SignalMessage[] = [];
  private ended = false;
  /** Why the relay lost the path before anyone listened (told to onEnd when it is set). */
  private lostFor: 'unreachable' | 'left' | null = null;

  constructor(
    readonly offerer: 'host' | 'guest',
    private readonly post: (m: SignalMessage) => void,
    private readonly release: () => void,
  ) {}

  get onMessage(): ((m: SignalMessage) => void) | null {
    return this.handler;
  }
  set onMessage(fn: ((m: SignalMessage) => void) | null) {
    this.handler = fn;
    while (fn !== null && this.handler === fn && this.waiting.length > 0 && !this.ended) fn(this.waiting.shift()!);
  }

  get onEnd(): ((reason: 'unreachable' | 'left') => void) | null {
    return this.endHandler;
  }
  set onEnd(fn: ((reason: 'unreachable' | 'left') => void) | null) {
    this.endHandler = fn;
    const lost = this.lostFor;
    if (fn !== null && lost !== null) {
      this.lostFor = null;
      this.endHandler = null;
      fn(lost);
    }
  }

  get closed(): boolean {
    return this.ended;
  }

  send(m: SignalMessage): void {
    if (!this.ended) this.post(m);
  }

  /** A message from the other side. */
  deliver(m: SignalMessage): void {
    if (this.ended) return;
    if (m.t === 'bye') {
      this.end('left');
      return;
    }
    if (this.handler !== null) this.handler(m);
    else this.waiting.push(m);
  }

  /** The relay lost the path. */
  end(reason: 'unreachable' | 'left'): void {
    if (this.ended) return;
    this.ended = true;
    this.waiting.length = 0;
    const f = this.endHandler;
    this.endHandler = null;
    this.handler = null;
    this.release();
    if (f !== null) f(reason);
    else this.lostFor = reason;
  }

  close(): void {
    if (this.ended) return;
    this.post({ t: 'bye' });
    this.ended = true;
    this.waiting.length = 0;
    this.endHandler = null;
    this.lostFor = null;
    this.handler = null;
    this.release();
  }
}
