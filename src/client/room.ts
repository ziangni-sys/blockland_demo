/**
 * Rooms from the page (docs/NETCODE.md sections 1 and 2, package 10): hosting the open world for
 * guests (RoomHost) and joining someone else's (GuestJoin), on the WebRTC transport and the
 * signallers of net/webrtc. The page passes in the browser's objects here: RTCPeerConnection with
 * the public STUN servers, WebSocket, BroadcastChannel, timers, crypto.
 *
 * HOSTING. The host page's main thread owns every guest's peer connection. For each guest that
 * connects, RoomHost asks the page's server for a connection (LocalServer.connectGuest: a
 * MessageChannel into the server Worker, host control `connect` with local false) and joins the two
 * with a PortForwarder (client/forward.ts), which forwards the bytes unchanged and reports the data
 * channels' backlog. A guest must say something (its Hello) within GUEST_HELLO_MS of connecting,
 * and at most MAX_SILENT_GUESTS connections may be silent at once (a peer that only knows the room
 * code cannot make the page hold reassembly buffers without end). open(): listen on the
 * signaller, then the server's `openRoom` (so the room is not marked open when nobody could
 * reach it). close(): stop listening and `closeRoom` (guests
 * already in stay, section 15). A signaller that loses its service while open is listened on again
 * every RELISTEN_MS. end(): the world is closing: stop listening; the forwarders end when the
 * server closes their connections (Kick(shutdown) reaches the guests first), the rest after
 * END_GRACE_MS.
 *
 * JOINING. GuestJoin opens the NetClient's transports: each one is a full join (signalling, the
 * handshake). Until the first Welcome every failure is final: a failed dial, and a connection the
 * host's side ends without Refuse or never answers (NetClient's Welcome timeout); the page shows
 * its message and goes back to the menu. When the link to the host dies later, NetClient
 * reconnects ("connection lost, reconnecting"); a room that no longer exists (the host left) is
 * final at once, other failures are retried (the heartbeat, every RECONNECT_RETRY_MS) until
 * RECONNECT_GIVE_UP_MS after the link died, however the attempts end. Refuse and Kick reach the
 * page as NetClient statuses (their own messages, below).
 *
 * The single-file build (__ARTIFACT__) runs where there is no network: it has no rooms at all
 * (onlineAvailable() false: the page says so instead of trying).
 */
import type { PortLike } from '../net/host/port';
import { CONNECTION_TIMEOUT_MS, MAX_PLAYERS, type KickReason, type RefuseReason } from '../net/protocol';
import type { Transport } from '../net/transport';
import { BroadcastSignaller } from '../net/webrtc/broadcast';
import { CloudSignaller } from '../net/webrtc/cloud';
import { DEFAULT_ICE_SERVERS, joinRoom, RoomListener, type ConnectDeps } from '../net/webrtc/connect';
import { ManualSignaller } from '../net/webrtc/manual';
import { DialError, type DialFailure, type Signaller } from '../net/webrtc/signal';
import type { Timers, WebRtcTransport } from '../net/webrtc/transport';
import { PortForwarder, type IntervalTimers } from './forward';
import type { ClientStringKey } from './strings';

declare const __ARTIFACT__: boolean;

/** The signallers, by the names of the address parameter `?signal=`. */
export type SignalKind = 'broadcast' | 'manual' | 'cloud';
export const SIGNAL_KINDS: readonly SignalKind[] = Object.freeze(['cloud', 'broadcast', 'manual'] as const);
/** Listen again this often after the signalling service was lost, ms. */
export const RELISTEN_MS = 10_000;
/** After the world closed, forwarders still open are closed this long later, ms. */
export const END_GRACE_MS = 3000;
/** A dead link to the host is given up this long after it died, ms (reconnection attempts until then). */
export const RECONNECT_GIVE_UP_MS = 30_000;
/**
 * A guest's first message must reach the host page this soon after its connection opened, ms
 * (NetClient sends Hello at once); a connection that stays silent is closed.
 */
export const GUEST_HELLO_MS = 10_000;
/**
 * Guest connections that have sent nothing yet, at most; more are closed at once. Each may hold a
 * reassembly buffer of up to MAX_RELIABLE_BYTES (a first fragment declares it), so this and
 * GUEST_HELLO_MS bound what peers who never say Hello can make the host page hold.
 */
export const MAX_SILENT_GUESTS = MAX_PLAYERS;

/** Whether this build can go online (the single-file build cannot: it runs without network). */
export function onlineAvailable(): boolean {
  return !__ARTIFACT__ && typeof RTCPeerConnection === 'function';
}

/** The page's one-shot timers. */
export function pageTimers(win: Window): Timers & IntervalTimers {
  return {
    set: (fn, ms) => win.setTimeout(fn, ms),
    clear: (h) => win.clearTimeout(h as number),
    every: (fn, ms) => win.setInterval(fn, ms),
    stop: (h) => win.clearInterval(h as number),
  };
}

/** A signaller of `kind` on the page's objects. */
export function pageSignaller(kind: SignalKind, win: Window, random: (bytes: Uint8Array<ArrayBuffer>) => void): Signaller {
  const timers = pageTimers(win);
  switch (kind) {
    case 'broadcast':
      return new BroadcastSignaller({ open: (name) => new BroadcastChannel(name), timers, random });
    case 'manual':
      return new ManualSignaller({ random });
    case 'cloud':
      return new CloudSignaller({ openSocket: (url) => new WebSocket(url), timers, random });
  }
}

/** The handshake's dependencies on the page: peer connections with `iceServers` (default: the public STUN servers). */
export function pageConnectDeps(win: Window, iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS): ConnectDeps {
  return { createPeer: () => new RTCPeerConnection({ iceServers: iceServers.map((s) => ({ ...s })) }), timers: pageTimers(win) };
}

/** `?join=<code>&signal=<kind>` of the page address (default signal: cloud), or null. */
export function joinFromSearch(search: string | null | undefined): { code: string; signal: SignalKind } | null {
  if (!search) return null;
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return null;
  }
  const code = q.get('join');
  if (code === null || code.trim() === '') return null;
  return { code: code.trim(), signal: signalFromSearch(search) ?? 'cloud' };
}

/** `?signal=<kind>` of the page address, or null. */
export function signalFromSearch(search: string | null | undefined): SignalKind | null {
  if (!search) return null;
  try {
    const s = new URLSearchParams(search).get('signal');
    return (SIGNAL_KINDS as readonly string[]).includes(s ?? '') ? (s as SignalKind) : null;
  } catch {
    return null;
  }
}

/** The message for a failed join (client/strings.ts keys). */
export function dialFailureKey(code: DialFailure): ClientStringKey {
  switch (code) {
    case 'unreachable':
      return 'join.unreachable';
    case 'unknown':
      return 'join.unknown';
    case 'taken':
      return 'join.taken';
    case 'bad_code':
      return 'join.badCode';
    case 'no_answer':
      return 'join.noAnswer';
    case 'left':
      return 'join.left';
    case 'ice':
      return 'join.ice';
  }
}

/** The message for a Refuse reason (section 3). */
export function refuseKey(reason: RefuseReason): ClientStringKey {
  switch (reason) {
    case 'build':
      return 'refuse.build';
    case 'bad_hello':
      return 'refuse.badHello';
    case 'full':
      return 'refuse.full';
    case 'closed':
      return 'refuse.closed';
    case 'shutting_down':
      return 'refuse.shuttingDown';
    case 'same_key':
      return 'refuse.sameKey';
  }
}

/** The message for a Kick reason (section 3). */
export function kickKey(reason: KickReason): ClientStringKey {
  switch (reason) {
    case 'replaced':
      return 'kick.replaced';
    case 'too_slow':
      return 'kick.tooSlow';
    case 'protocol_error':
      return 'kick.protocolError';
    case 'shutdown':
      return 'kick.shutdown';
    case 'kicked':
      return 'kick.kicked';
    case 'timeout':
      return 'kick.timeout';
  }
}

/** What a RoomHost needs of the page's server (client/server.ts LocalServer). */
export interface RoomServer {
  /** A new guest connection into the server: the page's end of its MessagePort. */
  connectGuest(): PortLike;
  openRoom(): void;
  closeRoom(): void;
}

export type RoomState = 'closed' | 'opening' | 'open' | 'lost';

export interface RoomHostOptions {
  server: RoomServer;
  signaller: Signaller;
  /** The room code guests dial (the manual signaller has none: its invitations are the codes). */
  code: string;
  deps: ConnectDeps;
  intervals: IntervalTimers;
  /** The room's state changed. */
  onState?: (state: RoomState) => void;
  /** A guest's handshake failed (the page logs it). */
  onGuestFailed?: (e: DialError) => void;
}

export class RoomHost {
  readonly code: string;
  readonly signaller: Signaller;
  private readonly listener: RoomListener;
  private readonly forwarders = new Map<PortForwarder, WebRtcTransport>();
  private stateValue: RoomState = 'closed';
  private relisten: unknown = null;
  /** Guests that connected so far. */
  connections = 0;

  constructor(private readonly o: RoomHostOptions) {
    this.code = o.code;
    this.signaller = o.signaller;
    this.listener = new RoomListener(o.signaller, o.deps);
    this.listener.onGuest = (t) => this.admit(t);
    this.listener.onGuestFailed = (e) => o.onGuestFailed?.(e);
    o.signaller.onLost = () => this.lost();
  }

  get state(): RoomState {
    return this.stateValue;
  }

  /** Guests connected now. */
  get guests(): number {
    return this.forwarders.size;
  }

  /** The guests' links now (the page's connection diagnostics read their statistics). */
  links(): WebRtcTransport[] {
    return [...this.forwarders.values()];
  }

  /** Listen, then mark the server's room open. Rejects with the signaller's DialError. */
  async open(): Promise<void> {
    if (this.stateValue !== 'closed') return;
    this.setState('opening');
    try {
      await this.listener.open(this.code);
    } catch (e) {
      this.setState('closed');
      throw e;
    }
    // close() or end() may have come while listening.
    if ((this.stateValue as RoomState) !== 'opening') return;
    this.o.server.openRoom();
    this.setState('open');
  }

  /** No new guests (the ones in stay); the server's room is closed. */
  close(): void {
    if (this.stateValue === 'closed') return;
    this.stopRelisten();
    this.listener.close();
    this.o.server.closeRoom();
    this.setState('closed');
  }

  /** The world is closing (see the file comment). */
  end(): void {
    this.stopRelisten();
    this.listener.close();
    this.setState('closed');
    if (this.forwarders.size === 0) return;
    this.o.deps.timers.set(() => {
      for (const f of [...this.forwarders.keys()]) f.close('shutdown');
    }, END_GRACE_MS);
  }

  private admit(t: WebRtcTransport): void {
    if (this.stateValue === 'closed') {
      t.close('room closed');
      return;
    }
    let silent = 0;
    for (const f of this.forwarders.keys()) if (!f.heard) silent++;
    if (silent >= MAX_SILENT_GUESTS) {
      t.close('too many silent guests');
      return;
    }
    let port: PortLike;
    try {
      port = this.o.server.connectGuest();
    } catch {
      t.close('no server');
      return;
    }
    const f = new PortForwarder(port, t, this.o.intervals);
    this.forwarders.set(f, t);
    this.connections++;
    const hello = this.o.deps.timers.set(() => {
      if (!f.heard) f.close('no_hello');
    }, GUEST_HELLO_MS);
    f.onEnd = () => {
      this.forwarders.delete(f);
      this.o.deps.timers.clear(hello);
    };
  }

  private lost(): void {
    if (this.stateValue !== 'open' && this.stateValue !== 'lost') return;
    this.setState('lost');
    this.stopRelisten();
    this.relisten = this.o.deps.timers.set(() => {
      this.relisten = null;
      if (this.stateValue !== 'lost') return;
      this.listener.open(this.code).then(
        () => {
          if (this.stateValue === 'lost') this.setState('open');
        },
        () => this.lost(),
      );
    }, RELISTEN_MS);
  }

  private stopRelisten(): void {
    if (this.relisten !== null) this.o.deps.timers.clear(this.relisten);
    this.relisten = null;
  }

  private setState(s: RoomState): void {
    if (this.stateValue === s) return;
    this.stateValue = s;
    this.o.onState?.(s);
  }
}

/**
 * Where a guest's way to the host is: reaching the signalling service and finding the room
 * ('service'), the WebRTC handshake with the host ('host'), the transport handed to NetClient
 * ('world': the game's own handshake and loading follow).
 */
export type JoinStage = 'service' | 'host' | 'world';

export interface GuestJoinOptions {
  signaller: Signaller;
  code: string;
  /** The handshake's dependencies; its timers also run the give-up deadline. */
  deps: ConnectDeps;
  now(): number;
  /** The join failed for good: the page shows `key` (with `params`) and leaves the world. */
  onFinal(key: ClientStringKey, detail: string): void;
  /** The stage changed (the loading screen says which). */
  onStage?(stage: JoinStage): void;
}

/**
 * A guest's way to the host: NetClient's openTransport (see the file comment for the policy). The
 * page tells it when a Welcome came (connected(), NetClient status 'joining' or 'ready') and when
 * NetClient's status became 'reconnecting' (linkLost()).
 *
 * Every way of not getting in ends: a dial that fails is judged at once; a transport that opens
 * but is lost before the first Welcome (the host's side dropped it, or NetClient's Welcome timeout
 * closed it) is final ('join.dropped', 'join.noWelcome'); once the link to the host died, a timer
 * gives up RECONNECT_GIVE_UP_MS later unless a Welcome came again, however the attempts in between
 * end (NetClient reports 'reconnecting' only once for all of them).
 */
export class GuestJoin {
  /** The last failure, and how many joins were attempted. */
  failure: DialError | null = null;
  attempts = 0;
  /** The stage of the current attempt. */
  stage: JoinStage = 'service';
  /** The last transport handed to NetClient (the page's connection diagnostics read its statistics). */
  transport: WebRtcTransport | null = null;
  private everConnected = false;
  /** The last transport handed to NetClient (null when the last attempt has not given one), and when. */
  private handedAt: number | null = null;
  private giveUp: unknown = null;
  private ended = false;

  constructor(private readonly o: GuestJoinOptions) {}

  get signaller(): Signaller {
    return this.o.signaller;
  }

  get code(): string {
    return this.o.code;
  }

  /** NetClientOptions.openTransport. */
  readonly openTransport = (ready: (t: Transport) => void, failed: (reason: string) => void): void => {
    if (this.ended) return failed('ended');
    this.attempts++;
    this.handedAt = null;
    this.setStage('service');
    joinRoom(this.o.signaller, this.o.code, this.o.deps, () => {
      if (!this.ended) this.setStage('host');
    }).then(
      (t) => {
        if (this.ended) {
          t.close('left');
          failed('ended');
          return;
        }
        this.failure = null;
        this.handedAt = this.o.now();
        this.transport = t;
        this.setStage('world');
        ready(t);
      },
      (e: unknown) => {
        const err = e instanceof DialError ? e : new DialError('ice', e instanceof Error ? e.message : String(e));
        this.failure = err;
        failed(err.code);
        if (!this.ended) this.judge(err);
      },
    );
  };

  /** A Welcome came (NetClient status 'joining', then 'ready'): the host let this guest in; later failures are a lost link, not a failed join. */
  connected(): void {
    this.everConnected = true;
    this.stopGiveUp();
  }

  /** NetClient's status became 'reconnecting': its transport was lost, or its last dial failed. */
  linkLost(): void {
    if (this.ended) return;
    if (!this.everConnected) {
      // A dial failure is judged where it is caught; a transport handed out and lost before the
      // first Welcome means the host's side let it go without Refuse.
      if (this.handedAt === null) return;
      const held = this.o.now() - this.handedAt;
      return this.final(held >= CONNECTION_TIMEOUT_MS ? 'join.noWelcome' : 'join.dropped', `the connection ended after ${Math.round(held)} ms without a Welcome`);
    }
    if (this.giveUp !== null) return;
    this.giveUp = this.o.deps.timers.set(() => {
      this.giveUp = null;
      this.final('join.lost', `not back within ${RECONNECT_GIVE_UP_MS} ms${this.failure !== null ? ` (last: ${this.failure.code})` : ''}`);
    }, RECONNECT_GIVE_UP_MS);
  }

  /** Stop: no more joins (the page left the world). */
  end(): void {
    this.ended = true;
    this.stopGiveUp();
  }

  private setStage(stage: JoinStage): void {
    if (stage === this.stage) return;
    this.stage = stage;
    this.o.onStage?.(stage);
  }

  private judge(err: DialError): void {
    if (!this.everConnected) return this.final(dialFailureKey(err.code), err.message);
    if (err.code === 'unknown' || err.code === 'bad_code') this.final('join.gone', err.message);
  }

  private stopGiveUp(): void {
    if (this.giveUp !== null) this.o.deps.timers.clear(this.giveUp);
    this.giveUp = null;
  }

  private final(key: ClientStringKey, detail: string): void {
    if (this.ended) return;
    this.end();
    this.o.onFinal(key, detail);
  }
}
