/**
 * BroadcastSignaller (signal.ts): signalling between pages of one browser on one origin, over a
 * BroadcastChannel. The automated two-page tests use it, and so can a quick trial with two tabs
 * (the second with ?slot=, docs/NETCODE.md section 3).
 *
 * Every message is an envelope { bl: SIGNAL_VERSION, to, from, m } on the channel BROADCAST_NAME;
 * pages read only what is addressed to them. The host of room CODE is `room:CODE`; a guest is
 * `guest:<random>`. A guest knocks ({t:'knock'}); the host answers {t:'here'} at once and gives
 * the guest a path (the guest offers); no answer within knockMs: 'unknown'. A page without
 * BroadcastChannel: 'unreachable'.
 */
import { DialError, parseRoomCode, parseSignalMessage, randomHex, RelayPath, SIGNAL_VERSION, type SignalMessage, type SignalPath, type Signaller } from './signal';
import type { Timers } from './transport';

/** The BroadcastChannel all pages of this game signal on. */
export const BROADCAST_NAME = 'blocklands-signal';
/** A guest's knock gets no answer this long: no such room, ms. */
export const BROADCAST_KNOCK_MS = 3000;
/** One side waits this long for the other's description, ms. */
export const BROADCAST_PATIENCE_MS = 20_000;

/** The part of a BroadcastChannel this uses (tests pass a fake). */
export type BroadcastLike = Pick<BroadcastChannel, 'postMessage' | 'onmessage' | 'close'>;

export interface BroadcastOptions {
  /** Open the channel (the page: name => new BroadcastChannel(name)). */
  open(name: string): BroadcastLike;
  timers: Timers;
  random(bytes: Uint8Array<ArrayBuffer>): void;
  knockMs?: number;
}

type Wire = SignalMessage | { t: 'knock' } | { t: 'here' };

interface Envelope {
  to: string;
  from: string;
  m: Wire;
}

function parseEnvelope(v: unknown): Envelope | null {
  if (v === null || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.bl !== SIGNAL_VERSION || typeof e.to !== 'string' || typeof e.from !== 'string') return null;
  const raw = e.m as Record<string, unknown> | null;
  if (raw !== null && typeof raw === 'object' && (raw.t === 'knock' || raw.t === 'here')) return { to: e.to, from: e.from, m: { t: raw.t } };
  const m = parseSignalMessage(raw);
  return m === null ? null : { to: e.to, from: e.from, m };
}

/** One page's address on the channel: the channel, open while the address or one of its paths is in use. */
class Station {
  readonly paths = new Map<string, RelayPath>();
  onEnvelope: ((e: Envelope) => void) | null = null;
  private users = 1;

  constructor(
    readonly address: string,
    private readonly channel: BroadcastLike,
  ) {
    channel.onmessage = (ev) => {
      const e = parseEnvelope(ev.data);
      if (e === null || e.to !== this.address) return;
      const path = this.paths.get(e.from);
      if (path !== undefined && e.m.t !== 'knock' && e.m.t !== 'here') path.deliver(e.m);
      else this.onEnvelope?.(e);
    };
  }

  post(to: string, m: Wire): void {
    try {
      this.channel.postMessage({ bl: SIGNAL_VERSION, to, from: this.address, m });
    } catch {
      // closed
    }
  }

  /** A path to `peer` (keeps the channel open until it is closed). */
  path(peer: string, offerer: 'host' | 'guest'): RelayPath {
    this.users++;
    const path = new RelayPath(
      offerer,
      (m) => this.post(peer, m),
      () => {
        if (this.paths.get(peer) === path) this.paths.delete(peer);
        this.release();
      },
    );
    this.paths.set(peer, path);
    return path;
  }

  release(): void {
    if (--this.users > 0) return;
    this.channel.onmessage = null;
    try {
      this.channel.close();
    } catch {
      // closed
    }
  }
}

export class BroadcastSignaller implements Signaller {
  readonly kind = 'broadcast';
  readonly patienceMs = BROADCAST_PATIENCE_MS;
  onLost: (() => void) | null = null;
  private host: Station | null = null;

  constructor(private readonly o: BroadcastOptions) {}

  listen(code: string, onGuest: (path: SignalPath) => void): Promise<void> {
    const room = parseRoomCode(code);
    if (room === null) return Promise.reject(new DialError('bad_code', `not a room code: ${code}`));
    this.close();
    const channel = this.openChannel();
    if (channel === null) return Promise.reject(new DialError('unreachable', 'this page has no BroadcastChannel'));
    const station = new Station(`room:${room}`, channel);
    station.onEnvelope = (e) => {
      if (e.m.t !== 'knock' || station.paths.has(e.from) || this.host !== station) return;
      const path = station.path(e.from, 'guest');
      station.post(e.from, { t: 'here' });
      onGuest(path);
    };
    this.host = station;
    return Promise.resolve();
  }

  dial(code: string): Promise<SignalPath> {
    const room = parseRoomCode(code);
    if (room === null) return Promise.reject(new DialError('bad_code', `not a room code: ${code}`));
    const channel = this.openChannel();
    if (channel === null) return Promise.reject(new DialError('unreachable', 'this page has no BroadcastChannel'));
    const station = new Station(`guest:${randomHex(this.o.random, 8)}`, channel);
    const hostAddress = `room:${room}`;
    return new Promise((resolve, reject) => {
      const timer = this.o.timers.set(() => {
        station.onEnvelope = null;
        station.release();
        reject(new DialError('unknown', `no room ${room} answered`));
      }, this.o.knockMs ?? BROADCAST_KNOCK_MS);
      station.onEnvelope = (e) => {
        if (e.from !== hostAddress || e.m.t !== 'here') return;
        this.o.timers.clear(timer);
        station.onEnvelope = null;
        const path = station.path(hostAddress, 'guest');
        // The guest's own use of the station ends with its path.
        station.release();
        resolve(path);
      };
      station.post(hostAddress, { t: 'knock' });
    });
  }

  close(): void {
    const s = this.host;
    this.host = null;
    if (s === null) return;
    s.onEnvelope = null;
    s.release();
  }

  private openChannel(): BroadcastLike | null {
    try {
      return this.o.open(BROADCAST_NAME);
    } catch {
      return null;
    }
  }
}
