/**
 * The client's connection to a server (docs/NETCODE.md sections 3 to 5): NetClient.
 *
 * Headless: no DOM, no timers. The embedding code (the page, or tests/net/harness.ts) injects how to
 * open a transport, the clock (`now`, ms), and how to turn Welcome's GeneratorSpec into a
 * ChunkSource, and drives it:
 *  - frame(now) at the start of every rendered frame;
 *  - heartbeat(now) from a timer about once a second, also while the page is hidden (Ping,
 *    reconnect attempts, the stall hint);
 *  - setHidden(true / false) when the page is hidden or shown;
 *  - setPaused(true / false) around a single-player pause (section 4);
 *  - send(message) / sendMoveReport(report) for intents and movement reports (packages 6, 7);
 *  - leave() when the player quits.
 *
 * LIFE CYCLE (section 3). start(): open a transport, send Hello (status 'connecting'). Welcome:
 * a new ClientReplica and ServerClock ('joining'). Ready ('ready') = Welcome, the batch flag
 * `ready`, and every column of the ready zone (7x7 around the player's column, within the
 * subscription circle; the player's column from the correction) inserted into the replica.
 * Refuse ('refused') and Kick ('kicked') end it for good: no automatic reconnection (a 'replaced'
 * client would otherwise replace the other one back). A transport that closes without either, or
 * one that brings no Welcome within CONNECTION_TIMEOUT_MS ('reconnecting', until the next Welcome):
 * the replica is dropped, a new transport is opened and the client joins again from scratch with
 * the same identity. Transports are opened at most once per RECONNECT_RETRY_MS (heartbeat retries),
 * so a server that accepts and drops them does not get a Hello every round trip; a connection
 * that lived longer than that is reopened at once. A message that breaks the protocol (codec
 * ProtocolError, replica ReplicaError): the connection ends with the reason shown ('failed'), no
 * reconnection. leave(): Bye, close ('closed').
 *
 * APPLYING (section 5). Every message is decoded when it arrives, and its tick goes to the clock
 * then. While the page is shown, batches and samples wait for the next frame(), which applies all
 * waiting batches in order, then the waiting samples, then moves the clock and poses the replica at
 * renderTick / rotorTick: one server tick's changes take effect in one frame. While the page is
 * hidden (no frames), each batch and sample is applied in the message handler and the light kept up,
 * so nothing piles up; frames pick up from there.
 */
import { CHUNK_SHIFT } from '../../core/constants';
import { vec3 } from '../../core/math';
import { decodeServerMessage, encodeClientMessage, ProtocolError } from '../codec';
import {
  BUILD_ID,
  CONNECTION_TIMEOUT_MS,
  HOST_STALL_MS,
  MESSAGE_CHANNEL,
  type ClientMessage,
  type GeneratorSpec,
  type KickMsg,
  type NetMoveReport,
  type RefuseMsg,
  type SamplesMsg,
  type ServerMessage,
  type TickBatchMsg,
  type WelcomeMsg,
} from '../protocol';
import type { Channel, Transport } from '../transport';
import { ReplicaError } from './apply';
import type { ChunkSource } from './chunks';
import { ServerClock } from './clock';
import { ClientReplica } from './replica';

/** A Ping this often (heartbeat), ms (section 4). */
export const PING_INTERVAL_MS = 1000;
/** Transports are opened at most this often (reconnecting; heartbeat retries), ms. */
export const RECONNECT_RETRY_MS = 2000;
/** "Pongs still arrive" (section 4 stall hint): one within this long, ms (a lost Pong is not a dead link). */
export const PONG_FRESH_MS = 2500;
/** The host counts as throttled below this TPS (section 4). */
export const STALL_TPS = 15;

export type NetStatus =
  /** Constructed, start() not called yet. */
  | 'idle'
  /** First connection: transport opening or open, Hello sent, no Welcome yet. */
  | 'connecting'
  /** Welcome received, not ready yet. */
  | 'joining'
  | 'ready'
  /**
   * The transport closed without Refuse or Kick (or brought no Welcome in time): a new one is being
   * opened, or is open and waiting for Welcome ("connection lost, reconnecting", section 3).
   */
  | 'reconnecting'
  /** Refuse received (see refusal). */
  | 'refused'
  /** Kick received (see kick). */
  | 'kicked'
  /** A protocol error ended the connection (see failure). */
  | 'failed'
  /** leave() was called. */
  | 'closed';

/** The hint of section 4: the host's server is throttled, or this client's link is unstable. */
export type StallHint = 'host' | 'link' | null;

export interface NetClientOptions {
  /**
   * Open a transport to the server: call `ready` with it once it is open (synchronously is fine),
   * or `failed` (heartbeat tries again). Called by start() and by every reconnection.
   */
  openTransport(ready: (t: Transport) => void, failed: (reason: string) => void): void;
  /** The page's clock in ms (performance.now; the LoopbackNet's virtual time in tests). */
  now(): number;
  /** A ChunkSource generating the world Welcome describes (one per connection). */
  chunkSource(spec: GeneratorSpec): ChunkSource;
  playerKey: string;
  name: string;
  /** Subscription radius sent in Hello (0..MAX_VIEW_RADIUS). */
  viewRadius: number;
  /** Defaults to BUILD_ID. */
  build?: string;
}

interface Connection {
  readonly transport: Transport;
  readonly clock: ServerClock;
  replica: ClientReplica | null;
  welcome: WelcomeMsg | null;
  readonly batches: TickBatchMsg[];
  readonly samples: SamplesMsg[];
  /** When the transport was attached (Welcome timeout). */
  readonly openedAt: number;
  lastBatchAt: number;
  lastPongAt: number;
  lastPingAt: number;
}

export class NetClient {
  /** Subscription radius for the next Hello and the ready zone (SetViewRadius is package 7's intent). */
  viewRadius: number;
  /** Called whenever status changes. */
  onStatus: ((status: NetStatus) => void) | null = null;
  /** Called after each applied batch (corrections, inventory, events: packages 6, 7, 9). */
  onBatch: ((batch: TickBatchMsg, replica: ClientReplica) => void) | null = null;

  private statusValue: NetStatus = 'idle';
  private conn: Connection | null = null;
  private hiddenValue = false;
  private pausedValue = false;
  /** An openTransport call is under way. */
  private opening = false;
  private lastOpenAttempt = -Infinity;
  private refusalValue: RefuseMsg | null = null;
  private kickValue: KickMsg | null = null;
  private failureValue: string | null = null;
  private connections = 0;

  constructor(private readonly opts: NetClientOptions) {
    this.viewRadius = opts.viewRadius;
  }

  // ------------------------------------------------------------------ state

  get status(): NetStatus {
    return this.statusValue;
  }

  /** The replica of the current connection (null before Welcome and after it ended). */
  get replica(): ClientReplica | null {
    return this.conn?.replica ?? null;
  }

  /** The clock of the current connection (null before a transport opened). */
  get clock(): ServerClock | null {
    return this.conn?.clock ?? null;
  }

  get welcome(): WelcomeMsg | null {
    return this.conn?.welcome ?? null;
  }

  get refusal(): RefuseMsg | null {
    return this.refusalValue;
  }

  get kick(): KickMsg | null {
    return this.kickValue;
  }

  /** Why the connection failed (status 'failed'). */
  get failure(): string | null {
    return this.failureValue;
  }

  get hidden(): boolean {
    return this.hiddenValue;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  /** Transports opened so far (1 + reconnections). */
  get connectionCount(): number {
    return this.connections;
  }

  /** Batches and samples received and not applied yet (they wait for the next frame). */
  get waiting(): number {
    return this.conn === null ? 0 : this.conn.batches.length + this.conn.samples.length;
  }

  /** The stall hint of section 4 at `now`. */
  stall(now: number): StallHint {
    const c = this.conn;
    if (c === null || c.welcome === null || (this.statusValue !== 'joining' && this.statusValue !== 'ready')) return null;
    const batchesLate = now - c.lastBatchAt > HOST_STALL_MS;
    const pongs = now - c.lastPongAt <= PONG_FRESH_MS;
    if (batchesLate && !pongs) return 'link';
    const tps = c.replica?.state.tps ?? null;
    if ((tps !== null && tps < STALL_TPS) || batchesLate) return 'host';
    return null;
  }

  // ------------------------------------------------------------------ driving

  /** Open the first connection. */
  start(): void {
    if (this.statusValue !== 'idle') throw new Error(`NetClient.start: already ${this.statusValue}`);
    this.setStatus('connecting');
    this.open();
  }

  /**
   * One frame (section 5): apply every waiting batch in order, then the waiting samples; move the
   * clock; refresh hulls and light; pose the structures at renderTick / rotorTick.
   */
  frame(now: number): void {
    const c = this.conn;
    if (c === null || c.replica === null) return;
    this.applyWaiting(c);
    if (this.conn !== c || c.replica === null) return;
    const r = c.replica;
    if (this.pausedValue) {
      // The clock holds and nothing is re-posed: what is shown stays still.
      r.refreshHulls();
      r.updateLight();
      return;
    }
    c.clock.frame(now, r.state.tick);
    r.refreshHulls();
    r.updateLight();
    // Nothing is posed before the first batch is applied (renderTick is -Infinity until then).
    if (r.state.tick >= 0) r.setPoses(c.clock.renderTick, c.clock.rotorTick);
    this.checkReady(c);
  }

  /** About once a second from a timer, frames or not: Ping, the Welcome timeout, reconnection attempts. */
  heartbeat(now: number): void {
    const c = this.conn;
    if (c !== null && c.welcome === null && now - c.openedAt >= CONNECTION_TIMEOUT_MS) {
      this.lost(c, 'welcome_timeout');
      return;
    }
    if (c !== null && c.welcome !== null && c.transport.open && now - c.lastPingAt >= PING_INTERVAL_MS) {
      c.lastPingAt = now;
      this.sendOn(c, { type: 'ping', clientMs: Math.floor(now) >>> 0 });
    }
    this.reopen(now);
  }

  /** The page was hidden (no frames: batches are applied as they arrive) or shown again. */
  setHidden(hidden: boolean): void {
    this.hiddenValue = hidden;
    const c = this.conn;
    if (hidden && c !== null && c.replica !== null) this.applyHidden(c);
  }

  /** Send a message on its channel (after Welcome; dropped otherwise). */
  send(m: ClientMessage): void {
    const c = this.conn;
    if (c === null || c.welcome === null) return;
    this.sendOn(c, m);
  }

  /** Send a movement report (unreliable) and remember when, for rotorLead (section 4). */
  sendMoveReport(r: NetMoveReport): void {
    const c = this.conn;
    if (c === null || c.welcome === null) return;
    c.clock.moveSent(r.seq, this.opts.now());
    this.sendOn(c, { type: 'moveReport', ...r });
  }

  /**
   * Single-player pause (section 4): the page pauses the client before it pauses the server, and
   * resumes it after the server. While paused, frames still apply what arrives (the batches of the
   * server's last ticks) but the clock holds and nothing is re-posed, so nothing moves on screen
   * (rotors would otherwise go on spinning to rotorTick). Resuming starts the clock over: the
   * server's ticks resume after a gap of wall time the clock must not take for lag.
   */
  setPaused(paused: boolean): void {
    if (paused === this.pausedValue) return;
    this.pausedValue = paused;
    if (!paused) this.conn?.clock.reset();
  }

  /** Quit: Bye, then close (section 3). */
  leave(): void {
    const c = this.conn;
    if (c !== null) {
      if (c.welcome !== null) this.sendOn(c, { type: 'bye' });
      this.drop(c, 'bye');
    }
    this.setStatus('closed');
  }

  // ------------------------------------------------------------------ connection

  private open(): void {
    this.opening = true;
    this.lastOpenAttempt = this.opts.now();
    let settled = false;
    this.opts.openTransport(
      (t) => {
        if (settled) return;
        settled = true;
        this.opening = false;
        this.attach(t);
      },
      () => {
        if (settled) return;
        settled = true;
        this.opening = false;
        if (this.statusValue === 'connecting') this.setStatus('reconnecting');
      },
    );
  }

  private attach(t: Transport): void {
    if (this.statusValue !== 'connecting' && this.statusValue !== 'reconnecting') {
      t.close('unused');
      return;
    }
    const c: Connection = {
      transport: t,
      clock: new ServerClock(),
      replica: null,
      welcome: null,
      batches: [],
      samples: [],
      openedAt: this.opts.now(),
      lastBatchAt: -Infinity,
      lastPongAt: -Infinity,
      lastPingAt: -Infinity,
    };
    this.conn = c;
    this.connections++;
    t.onMessage = (channel, bytes) => {
      if (this.conn === c) this.receive(c, channel, bytes);
    };
    t.onClose = () => {
      if (this.conn === c) this.lost(c, null);
    };
    this.sendOn(c, { type: 'hello', build: this.opts.build ?? BUILD_ID, playerKey: this.opts.playerKey, name: this.opts.name, viewRadius: this.viewRadius });
  }

  /**
   * The transport closed without Refuse or Kick (`close` null), or is closed here with `close` as
   * the reason (no Welcome in time): join again from scratch (section 3).
   */
  private lost(c: Connection, close: string | null): void {
    this.drop(c, close);
    this.setStatus('reconnecting');
    this.reopen(this.opts.now());
  }

  /** Reconnecting: open a transport unless one is open or opening, at most once per RECONNECT_RETRY_MS. */
  private reopen(now: number): void {
    if (this.statusValue === 'reconnecting' && this.conn === null && !this.opening && now - this.lastOpenAttempt >= RECONNECT_RETRY_MS) this.open();
  }

  /** End a connection: forget its replica and messages; close the transport when `reason` is given. */
  private drop(c: Connection, reason: string | null): void {
    if (this.conn === c) this.conn = null;
    c.transport.onMessage = null;
    c.transport.onClose = null;
    if (reason !== null) c.transport.close(reason);
    c.replica = null;
    c.batches.length = 0;
    c.samples.length = 0;
  }

  private fail(c: Connection, reason: string): void {
    this.failureValue = reason;
    this.drop(c, 'protocol_error');
    this.setStatus('failed');
  }

  private sendOn(c: Connection, m: ClientMessage): void {
    c.transport.send(MESSAGE_CHANNEL[m.type], encodeClientMessage(m));
  }

  // ------------------------------------------------------------------ messages

  private receive(c: Connection, channel: Channel, bytes: Uint8Array): void {
    let m: ServerMessage;
    try {
      m = decodeServerMessage(bytes, channel);
    } catch (e) {
      if (e instanceof ProtocolError) {
        this.fail(c, `protocol error: ${e.message}`);
        return;
      }
      throw e;
    }
    const now = this.opts.now();
    switch (m.type) {
      case 'welcome':
        if (c.welcome !== null) return this.fail(c, 'protocol error: a second Welcome');
        c.welcome = m;
        c.replica = new ClientReplica(this.opts.chunkSource(m.generator));
        c.replica.applyWelcome(m);
        this.setStatus('joining');
        return;
      case 'refuse':
        this.refusalValue = m;
        this.drop(c, 'refused');
        this.setStatus('refused');
        return;
      case 'kick':
        this.kickValue = m;
        this.drop(c, 'kicked');
        this.setStatus('kicked');
        return;
      case 'pong':
        if (c.welcome === null) return;
        c.lastPongAt = now;
        c.clock.pong(m.clientMs, now);
        return;
      case 'tickBatch':
        if (c.welcome === null) return this.fail(c, 'protocol error: a TickBatch before Welcome');
        c.lastBatchAt = now;
        c.clock.arrival(m.tick, now, null);
        c.batches.push(m);
        break;
      case 'samples':
        // Samples can overtake a Welcome that was retransmitted; they describe nothing yet.
        if (c.welcome === null) return;
        c.clock.arrival(m.tick, now, m.seq);
        c.samples.push(m);
        break;
    }
    if (this.hiddenValue) this.applyHidden(c);
  }

  /** Apply the waiting batches in order, then the waiting samples. */
  private applyWaiting(c: Connection): void {
    const r = c.replica!;
    try {
      for (let i = 0; i < c.batches.length; i++) {
        const b = c.batches[i]!;
        r.applyBatch(b);
        if (b.private?.moveAck !== undefined) c.clock.moveAck(b.private.moveAck, b.tick);
        this.onBatch?.(b, r);
        if (this.conn !== c) return;
      }
      c.batches.length = 0;
      for (const s of c.samples) r.applySamples(s);
      c.samples.length = 0;
    } catch (e) {
      if (e instanceof ReplicaError) {
        this.fail(c, `protocol error: ${e.message}`);
        return;
      }
      throw e;
    }
  }

  /** Hidden page: apply in the message handler, keep the light and the clock up. */
  private applyHidden(c: Connection): void {
    this.applyWaiting(c);
    if (this.conn !== c || c.replica === null) return;
    c.clock.advance(this.opts.now());
    c.replica.updateLight();
    this.checkReady(c);
  }

  // ------------------------------------------------------------------ ready

  private checkReady(c: Connection): void {
    if (this.statusValue !== 'joining') return;
    const r = c.replica!;
    if (!r.state.ready) return;
    const corr = r.state.private.correction;
    if (corr === null) return;
    const p = vec3();
    const t = r.state.private.correctionTick;
    if (!r.toWorldAt(corr.carrierId, corr.pos, t, t, p)) return;
    if (!r.readyZoneLoaded(Math.floor(p.x) >> CHUNK_SHIFT, Math.floor(p.z) >> CHUNK_SHIFT, this.viewRadius)) return;
    this.setStatus('ready');
  }

  private setStatus(s: NetStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.onStatus?.(s);
  }
}
