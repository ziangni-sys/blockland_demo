/**
 * CloudSignaller (signal.ts): the free public PeerJS server (0.peerjs.com), spoken to directly
 * over a WebSocket as a relay for our own messages, without the PeerJS library. Nothing to deploy;
 * the transport and the signalling are behind interfaces, so a relay of our own can replace it.
 *
 * THE SERVER'S PROTOCOL (checked against the running service on 2026-11-18, and against the
 * published sources of the server, npm `peer` 1.0.2, and of the client, npm `peerjs` 1.5.5):
 *  - wss://HOST:443/peerjs?key=peerjs&id=<peer id>&token=<random>&version=<client version>;
 *    the server answers {"type":"OPEN"}; an id already held under another token gets
 *    {"type":"ID-TAKEN"} and the socket closes; {"type":"ERROR","payload":{"msg"}} for anything
 *    else it refuses (key, connection limit).
 *  - {"type":"HEARTBEAT"} keeps the socket (the client library sends one every 5 s; the server
 *    drops clients silent for alive_timeout, 60 to 90 s).
 *  - {"type", "dst", "payload"} goes to the peer `dst` with "src" added by the server. The public
 *    service checks the payload against PeerJS's own shapes: OFFER, ANSWER and LEAVE with any
 *    other payload are not relayed and the sender's socket is closed about 2 s later; CANDIDATE
 *    is relayed when its payload has candidate: { candidate: <string> }, type: 'data' and a
 *    connectionId (other fields pass). So every message of ours is a CANDIDATE whose candidate
 *    string is our JSON envelope { bl: SIGNAL_VERSION, m }.
 *  - A message to an id nobody holds comes back at once as {"type":"EXPIRE","src":<that id>}
 *    (the published 1.0.2 source queues it for 5 s first; the service answers within about
 *    0.15 s). That is how a guest learns that no room has its code.
 *  - Socket messages above about 16 KB close the socket (code 1009): ours stay below
 *    CLOUD_MAX_MESSAGE (a description with every candidate is 1 to 4 KB).
 *
 * ROOMS. The host of room CODE holds the peer id `blocklands-room-CODE` (the server is shared by
 * every PeerJS application: the prefix keeps us apart); a guest takes `blocklands-guest-<random>`.
 * A guest knocks; the host answers 'here' and the guest offers (connect.ts). EXPIRE for the room's
 * id: 'unknown'; no answer within knockMs: 'unknown' too. The socket not open within connectMs,
 * an ERROR, or closing before OPEN: 'unreachable'; ID-TAKEN for the room: 'taken'. A host whose
 * socket closes later is told through onLost (listen again).
 */
import { DialError, parseRoomCode, parseSignalMessage, randomHex, RelayPath, SIGNAL_VERSION, type SignalMessage, type SignalPath, type Signaller } from './signal';
import type { Timers } from './transport';

/** The public PeerJS server. */
export const CLOUD_HOST = '0.peerjs.com';
/** Its API key (the public one every PeerJS client uses). */
export const CLOUD_KEY = 'peerjs';
/** The client version the URL names (the one our messages were checked against). */
export const CLOUD_CLIENT_VERSION = '1.5.5';
/** Peer id prefixes on the shared server. */
export const CLOUD_ROOM_PREFIX = 'blocklands-room-';
export const CLOUD_GUEST_PREFIX = 'blocklands-guest-';
/** The connectionId our CANDIDATE payloads carry (the service requires one). */
export const CLOUD_CONNECTION_ID = 'dc_blocklands';
/** The socket must be open (the server's OPEN) within this, ms. */
export const CLOUD_CONNECT_MS = 10_000;
/** A knock must be answered within this, ms (an unknown id usually comes back as EXPIRE far sooner). */
export const CLOUD_KNOCK_MS = 8000;
/** One side waits this long for the other's description, ms. */
export const CLOUD_PATIENCE_MS = 20_000;
/** Heartbeat interval, ms (as the PeerJS client). */
export const CLOUD_HEARTBEAT_MS = 5000;
/** Longest socket message we send (the service closes the socket above about 16 KB). */
export const CLOUD_MAX_MESSAGE = 15_000;

/** The part of a WebSocket this uses (tests pass a stand-in). */
export type SocketLike = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;

export interface CloudOptions {
  /** Open a WebSocket (the page: url => new WebSocket(url)). */
  openSocket(url: string): SocketLike;
  timers: Timers;
  random(bytes: Uint8Array<ArrayBuffer>): void;
  /** Default CLOUD_HOST; `secure` false and a port for a local stand-in (tests). */
  host?: string;
  port?: number;
  secure?: boolean;
  connectMs?: number;
  knockMs?: number;
}

type Wire = SignalMessage | { t: 'knock' } | { t: 'here' };

/** Our envelope out of a server message's payload, or null. */
function parseWire(payload: unknown): Wire | null {
  if (payload === null || typeof payload !== 'object') return null;
  const c = (payload as { candidate?: unknown }).candidate;
  if (c === null || typeof c !== 'object') return null;
  const text = (c as { candidate?: unknown }).candidate;
  if (typeof text !== 'string' || text.length > CLOUD_MAX_MESSAGE) return null;
  let e: unknown;
  try {
    e = JSON.parse(text);
  } catch {
    return null;
  }
  if (e === null || typeof e !== 'object' || (e as { bl?: unknown }).bl !== SIGNAL_VERSION) return null;
  const raw = (e as { m?: unknown }).m as Record<string, unknown> | null;
  if (raw !== null && typeof raw === 'object' && (raw.t === 'knock' || raw.t === 'here')) return { t: raw.t };
  return parseSignalMessage(raw);
}

/** One peer id on the server: the socket, open while the id or one of its paths is in use. */
class Endpoint {
  readonly paths = new Map<string, RelayPath>();
  /** A message for nobody's path (knocks, 'here'). */
  onWire: ((from: string, m: Wire) => void) | null = null;
  /** A message to `peer` could not be delivered (EXPIRE, LEAVE). */
  onGone: ((peer: string) => void) | null = null;
  /** The socket closed after it opened. */
  onLost: (() => void) | null = null;
  private users = 1;
  private heartbeat: unknown = null;
  private isOpen = false;
  private dead = false;

  constructor(
    readonly id: string,
    private readonly socket: SocketLike,
    private readonly timers: Timers,
    /** Settles the connection attempt: null when the server said OPEN, else the failure. */
    private readonly settle: (failure: DialError | null) => void,
  ) {
    socket.onmessage = (ev) => this.receive(ev.data);
    socket.onclose = () => this.closed();
    socket.onerror = () => this.closed();
  }

  get open(): boolean {
    return this.isOpen && !this.dead;
  }

  send(to: string, m: Wire): boolean {
    if (!this.open) return false;
    const text = JSON.stringify({
      type: 'CANDIDATE',
      dst: to,
      payload: { type: 'data', connectionId: CLOUD_CONNECTION_ID, candidate: { candidate: JSON.stringify({ bl: SIGNAL_VERSION, m }) } },
    });
    if (text.length > CLOUD_MAX_MESSAGE) return false;
    try {
      this.socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  path(peer: string, offerer: 'host' | 'guest'): RelayPath {
    this.users++;
    const path: RelayPath = new RelayPath(
      offerer,
      (m) => {
        if (!this.send(peer, m)) path.end('unreachable');
      },
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
    this.shut();
  }

  /** Close the socket now. */
  shut(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.heartbeat !== null) this.timers.clear(this.heartbeat);
    this.heartbeat = null;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.onerror = null;
    try {
      this.socket.close();
    } catch {
      // closed
    }
  }

  private beat(): void {
    this.heartbeat = this.timers.set(() => {
      if (!this.open) return;
      try {
        this.socket.send('{"type":"HEARTBEAT"}');
      } catch {
        // the close event follows
      }
      this.beat();
    }, CLOUD_HEARTBEAT_MS);
  }

  private receive(data: unknown): void {
    if (this.dead || typeof data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(data);
      if (v === null || typeof v !== 'object') return;
      msg = v as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'OPEN':
        if (this.isOpen) return;
        this.isOpen = true;
        this.beat();
        this.settle(null);
        return;
      case 'ID-TAKEN':
        this.settle(new DialError('taken', 'the room code is in use'));
        this.shut();
        return;
      case 'ERROR':
        this.settle(new DialError('unreachable', `the signalling server refused: ${describePayload(msg.payload)}`));
        this.shut();
        return;
      case 'EXPIRE':
      case 'LEAVE': {
        if (typeof msg.src !== 'string') return;
        this.paths.get(msg.src)?.end('left');
        this.onGone?.(msg.src);
        return;
      }
      case 'CANDIDATE': {
        if (typeof msg.src !== 'string') return;
        const m = parseWire(msg.payload);
        if (m === null) return;
        const path = this.paths.get(msg.src);
        if (path !== undefined && m.t !== 'knock' && m.t !== 'here') path.deliver(m);
        else this.onWire?.(msg.src, m);
        return;
      }
      default:
        return;
    }
  }

  private closed(): void {
    if (this.dead) return;
    const wasOpen = this.isOpen;
    this.shut();
    this.settle(new DialError('unreachable', 'the signalling server closed the connection'));
    for (const p of [...this.paths.values()]) p.end('unreachable');
    if (wasOpen) this.onLost?.();
  }
}

export class CloudSignaller implements Signaller {
  readonly kind = 'cloud';
  readonly patienceMs = CLOUD_PATIENCE_MS;
  onLost: (() => void) | null = null;
  private host: Endpoint | null = null;
  /** The room's socket while it connects (close() aborts it, so the id is never left registered). */
  private pending: Connecting | null = null;
  /** The token of this page's room id (the same id reconnects with it). */
  private readonly token: string;

  constructor(private readonly o: CloudOptions) {
    this.token = randomHex(o.random, 16);
  }

  /** As Signaller.listen; a listen that close() (or another listen) cancels resolves without listening. */
  listen(code: string, onGuest: (path: SignalPath) => void): Promise<void> {
    const room = parseRoomCode(code);
    if (room === null) return Promise.reject(new DialError('bad_code', `not a room code: ${code}`));
    this.close();
    const attempt = this.connect(CLOUD_ROOM_PREFIX + room, this.token);
    this.pending = attempt;
    return attempt.ready.then(
      (ep) => {
        if (this.pending !== attempt) {
          ep.shut();
          return;
        }
        this.pending = null;
        this.host = ep;
        ep.onWire = (from, m) => {
          if (m.t !== 'knock' || ep.paths.has(from) || this.host !== ep) return;
          const path = ep.path(from, 'guest');
          ep.send(from, { t: 'here' });
          onGuest(path);
        };
        ep.onLost = () => {
          if (this.host !== ep) return;
          this.host = null;
          this.onLost?.();
        };
      },
      (e: unknown) => {
        if (this.pending !== attempt) return;
        this.pending = null;
        throw e;
      },
    );
  }

  dial(code: string): Promise<SignalPath> {
    const room = parseRoomCode(code);
    if (room === null) return Promise.reject(new DialError('bad_code', `not a room code: ${code}`));
    const hostId = CLOUD_ROOM_PREFIX + room;
    return this.connect(CLOUD_GUEST_PREFIX + randomHex(this.o.random, 8), randomHex(this.o.random, 16)).ready.then(
      (ep) =>
        new Promise<SignalPath>((resolve, reject) => {
          const fail = (e: DialError): void => {
            this.o.timers.clear(timer);
            ep.onWire = null;
            ep.onGone = null;
            ep.onLost = null;
            ep.release();
            reject(e);
          };
          const timer = this.o.timers.set(() => fail(new DialError('unknown', `no room ${room} answered`)), this.o.knockMs ?? CLOUD_KNOCK_MS);
          ep.onGone = (peer) => {
            if (peer === hostId) fail(new DialError('unknown', `there is no room ${room}`));
          };
          ep.onLost = () => fail(new DialError('unreachable', 'the signalling server closed the connection'));
          ep.onWire = (from, m) => {
            if (from !== hostId || m.t !== 'here') return;
            this.o.timers.clear(timer);
            ep.onWire = null;
            ep.onGone = null;
            ep.onLost = null;
            const path = ep.path(hostId, 'guest');
            ep.release();
            resolve(path);
          };
          if (!ep.send(hostId, { t: 'knock' })) fail(new DialError('unreachable', 'the signalling server is not reachable'));
        }),
    );
  }

  close(): void {
    const attempt = this.pending;
    this.pending = null;
    attempt?.abort();
    const ep = this.host;
    this.host = null;
    if (ep === null) return;
    ep.onWire = null;
    ep.onLost = null;
    ep.release();
  }

  /** Open a socket for peer `id`: `ready` resolves once the server said OPEN; abort() closes the socket and rejects it. */
  private connect(id: string, token: string): Connecting {
    const scheme = (this.o.secure ?? true) ? 'wss' : 'ws';
    const url = `${scheme}://${this.o.host ?? CLOUD_HOST}:${this.o.port ?? 443}/peerjs?key=${CLOUD_KEY}&id=${encodeURIComponent(id)}&token=${token}&version=${CLOUD_CLIENT_VERSION}`;
    let settle: (failure: DialError | null) => void = () => undefined;
    const ready = new Promise<Endpoint>((resolve, reject) => {
      let settled = false;
      let ep: Endpoint | null = null;
      settle = (failure) => {
        if (settled) return;
        settled = true;
        this.o.timers.clear(timer);
        if (failure === null && ep !== null) resolve(ep);
        else {
          ep?.shut();
          reject(failure ?? new DialError('unreachable', 'the signalling server is not reachable'));
        }
      };
      const timer = this.o.timers.set(() => settle(new DialError('unreachable', 'the signalling server did not answer in time')), this.o.connectMs ?? CLOUD_CONNECT_MS);
      let socket: SocketLike;
      try {
        socket = this.o.openSocket(url);
      } catch (e) {
        settle(new DialError('unreachable', `cannot open a WebSocket: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      ep = new Endpoint(id, socket, this.o.timers, settle);
    });
    return { ready, abort: () => settle(new DialError('unreachable', 'closed while connecting')) };
  }
}

/** A socket on its way to the server's OPEN (CloudSignaller.connect). */
interface Connecting {
  readonly ready: Promise<Endpoint>;
  abort(): void;
}

function describePayload(p: unknown): string {
  if (p !== null && typeof p === 'object' && typeof (p as { msg?: unknown }).msg === 'string') return (p as { msg: string }).msg;
  return 'unknown error';
}
