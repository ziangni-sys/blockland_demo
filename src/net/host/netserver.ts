/**
 * NetServer (docs/NETCODE.md sections 3, 13, 15): the server's connections. It owns the
 * connection table, the handshake, replacement, Refuse and Kick, queues what arrives between two
 * ticks, and at the start of every tick (beforeTick) carries out everything a connection asked
 * of the simulation: leaving, replacement, joining, then hands the queued movement reports and
 * intents to their packages.
 *
 * CONNECTIONS. connect(transport, local) adds one. `local` is decided by the host (the page's own
 * client, or a console): it makes the connection the host's (Welcome.isHost, host commands), never
 * the PlayerKey, so a guest cannot pose as the host.
 *
 * HANDSHAKE (on arrival). The first message must be a Hello on the reliable channel. In order:
 *  - its frozen prefix (message id + build, codec readHelloBuild) names another build: Refuse(build);
 *  - not a Hello, malformed, a Hello on the wrong channel, a bad name or key: Refuse(bad_hello);
 *  - the server is shutting down: Refuse(shutting_down); a guest while the room is closed:
 *    Refuse(closed); a guest with the key of the host's connection: Refuse(same_key);
 *  - MAX_PLAYERS identities already have a player or a connection: Refuse(full).
 * A refused connection gets the Refuse and is closed. An accepted one waits for the next tick.
 * Names: control characters removed, then 1..MAX_NAME_LENGTH characters (code points). Keys:
 * 1..MAX_PLAYER_KEY_LENGTH printable ASCII characters without spaces.
 *
 * REPLACEMENT. A Hello with a key that already has a connection (accepted or joined) replaces it:
 * the old one gets Kick(replaced) and is closed at once, and has nothing to do with that identity
 * any more (its later close or silence is ignored). At the next tick the player leaves and joins
 * again for the new connection, which syncs from scratch.
 *
 * LEAVING. Bye, the transport's onClose, a Kick (protocol_error, too_slow, timeout) and
 * CONNECTION_TIMEOUT_MS without any message (not for local connections: the host's own client
 * lives in the same page) all end a connection at once; its player leaves at the next tick
 * (sim.leave keeps the record). Only an identity's CURRENT connection makes it leave. A
 * connection still in its handshake after CONNECTION_TIMEOUT_MS gets Refuse(bad_hello). Timeouts
 * are checked at the start of each tick (a paused server times nobody out).
 *
 * AFTER THE HANDSHAKE (on arrival): Ping is answered at once with Pong(tick); a second Hello, a
 * message that does not decode, an unknown id or one on the wrong channel: Kick(protocol_error).
 * Everything else is queued in arrival order.
 *
 * beforeTick(), in this order:
 *  1. connections silent for CONNECTION_TIMEOUT_MS are kicked (timeout);
 *  2. players whose connection ended, or was replaced, leave (moves, intents, Replicator, sim);
 *  3. accepted connections join, in the order they were accepted: sim.join(key), client-driven
 *     (setDrive raises the 'drive' correction, epoch 1), the first-join hook for an identity this
 *     world has never seen (ServerHost: starter items), simulation radius min(viewRadius,
 *     SIM_RADIUS_CAP), Replicator.addClient, Welcome, then moves and intents learn of the player;
 *  4. the queued movement reports go to MoveSink.receive, the queued intents to
 *     IntentSink.receive (players in entity id order, messages in arrival order); then
 *     MoveSink.beforeTick() and IntentSink.beforeTick(): reports reach the simulation before
 *     intents (section 10). IntentSink.receive returning false (its queue went past
 *     INTENT_QUEUE_LIMIT) kicks the connection (protocol_error).
 * afterTick() (after Replicator.endTick) kicks the clients the Replicator found too slow.
 */
import type { PlayerControl } from '../../sim/players';
import type { Simulation } from '../../sim/simulation';
import type { PlayerKey } from '../../sim/view';
import { decodeClientMessage, encodeServerMessage, ProtocolError, readHelloBuild } from '../codec';
import {
  BUILD_ID,
  CONNECTION_TIMEOUT_MS,
  INTENT_QUEUE_LIMIT,
  MAX_NAME_LENGTH,
  MAX_PLAYER_KEY_LENGTH,
  MAX_PLAYERS,
  SIM_RADIUS_CAP,
  type ClientMessage,
  type GeneratorSpec,
  type HelloMsg,
  type IntentMessage,
  type KickReason,
  type MoveReportMsg,
  type NetMoveReport,
  type RefuseReason,
  type ServerMessage,
} from '../protocol';
import type { Replicator } from '../server/replicator';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../transport';

// ====================================================================== seams for packages 6 and 7

/**
 * Movement reports (package 6, net/server/moves.ts). NetServer calls, at the start of a tick:
 * join / leave as players come and go, receive for every report that arrived since the last
 * tick (in arrival order, unfiltered), then beforeTick once. moveAck feeds the Replicator.
 */
export interface MoveSink {
  /** `key` joined the simulation (client-driven) for a new connection. */
  join(key: PlayerKey): void;
  /** `key` is about to leave the simulation (its queue goes). */
  leave(key: PlayerKey): void;
  /** A movement report that arrived on key's current connection. */
  receive(key: PlayerKey, report: NetMoveReport): void;
  /** Start of the tick, after every receive: hand the reports to the simulation. */
  beforeTick(): void;
  /** Seq of the last report package 2 accepted in this tick for `key`, or null (ClientFeed.moveAck). */
  moveAck(key: PlayerKey): number | null;
}

/**
 * Intents (package 7, net/server/intents.ts), called like MoveSink and after it. `host` marks the
 * host's connection (host commands are accepted from it only).
 */
export interface IntentSink {
  join(key: PlayerKey, host: boolean): void;
  leave(key: PlayerKey): void;
  /** An intent that arrived on key's current connection. False: the queue went past INTENT_QUEUE_LIMIT (the connection is kicked). */
  receive(key: PlayerKey, intent: IntentMessage): boolean;
  /** Start of the tick, after MoveSink.beforeTick(): apply what may be applied in this tick. */
  beforeTick(): void;
  /** Highest intent seq processed for `key`, or null before the first (ClientFeed.intentAck). */
  intentAck(key: PlayerKey): number | null;
}

// ====================================================================== the server

export interface NetServerOptions {
  sim: Simulation;
  replicator: Replicator;
  /** What clients build pristine chunks from (Welcome). */
  generator: GeneratorSpec;
  moves: MoveSink;
  intents: IntentSink;
  /** Monotonic milliseconds (timeouts). */
  now(): number;
  /** An identity this world has never seen joined (before Welcome; ServerHost gives the starter items). */
  onFirstJoin(control: PlayerControl): void;
  /** A Hello was accepted (ServerHost starts its clock at the first one). */
  onAccept(): void;
}

/** Where a connection is in its life (a connection never goes back). */
export type ConnectionState = 'hello' | 'accepted' | 'joined' | 'gone';

/** One connection, as tests and the debug panel see it. */
export interface ConnectionInfo {
  readonly key: PlayerKey | null;
  readonly name: string;
  readonly local: boolean;
  readonly state: ConnectionState;
}

interface Connection {
  readonly transport: Transport;
  readonly local: boolean;
  state: ConnectionState;
  key: PlayerKey | null;
  name: string;
  viewRadius: number;
  /** When the last message arrived (or the connection was made). */
  lastHeard: number;
  /** Movement reports and intents received since the last tick, in arrival order. */
  inbox: Array<MoveReportMsg | IntentMessage>;
  /** Intents in the inbox (a flood past INTENT_QUEUE_LIMIT is kicked before the tick). */
  inboxIntents: number;
}

/** Name of a Hello with its control characters removed, or null when not 1..MAX_NAME_LENGTH characters remain. */
export function cleanName(name: string): string | null {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const n = [...clean].length;
  return n >= 1 && n <= MAX_NAME_LENGTH ? clean : null;
}

/** A PlayerKey: 1..MAX_PLAYER_KEY_LENGTH printable ASCII characters, no spaces. */
export function validKey(key: string): boolean {
  return key.length >= 1 && key.length <= MAX_PLAYER_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key);
}

export class NetServer {
  private readonly sim: Simulation;
  private readonly replicator: Replicator;
  private readonly o: NetServerOptions;
  /** Every connection that has not ended. */
  private readonly live = new Set<Connection>();
  /** The current connection of each identity (accepted or joined). */
  private readonly byKey = new Map<PlayerKey, Connection>();
  /** Identities whose player is in the simulation through this server. */
  private readonly inSim = new Set<PlayerKey>();
  /** Accepted connections waiting for the next tick, in order. */
  private accepted: Connection[] = [];
  private roomOpenValue = false;
  /** Hellos are refused (shutting_down) while true. */
  shuttingDown = false;

  constructor(o: NetServerOptions) {
    this.o = o;
    this.sim = o.sim;
    this.replicator = o.replicator;
  }

  /** Whether guests (non-local connections) may join (package 11; globals roomOpen). */
  get roomOpen(): boolean {
    return this.roomOpenValue;
  }
  set roomOpen(v: boolean) {
    this.roomOpenValue = v;
    this.replicator.roomOpen = v;
  }

  /** Identities with a player in the world or an accepted connection. */
  get playerCount(): number {
    let n = this.inSim.size;
    for (const key of this.byKey.keys()) if (!this.inSim.has(key)) n++;
    return n;
  }

  /** Every connection that has not ended. */
  connections(): ConnectionInfo[] {
    return [...this.live].map((c) => ({ key: c.key, name: c.name, local: c.local, state: c.state }));
  }

  /** A new connection; `local` = the host's own (decided by the host, never by the key). */
  connect(transport: Transport, local: boolean): void {
    const c: Connection = { transport, local, state: 'hello', key: null, name: '', viewRadius: 0, lastHeard: this.o.now(), inbox: [], inboxIntents: 0 };
    this.live.add(c);
    transport.onMessage = (channel, bytes) => this.onMessage(c, channel, bytes);
    transport.onClose = () => this.end(c);
  }

  // ------------------------------------------------------------------ the tick

  beforeTick(): void {
    const now = this.o.now();
    for (const c of [...this.live]) {
      if (c.local || now - c.lastHeard < CONNECTION_TIMEOUT_MS) continue;
      if (c.state === 'hello') this.refuse(c, 'bad_hello', 'no Hello for 75 s');
      else this.kick(c, 'timeout', 'no message for 75 s');
    }
    // Leave: the identity's connection ended (no current one), or a new one replaced it.
    for (const key of [...this.inSim]) {
      const c = this.byKey.get(key);
      if (c === undefined || c.state === 'accepted') this.leave(key);
    }
    const joining = this.accepted;
    this.accepted = [];
    for (const c of joining) if (c.state === 'accepted') this.join(c);
    // Dispatch: reports first, then intents (section 10).
    const moves = this.o.moves;
    const intents = this.o.intents;
    const order: Connection[] = [];
    for (const ctrl of this.sim.players.online()) {
      const c = this.byKey.get(ctrl.key);
      if (c !== undefined && c.state === 'joined' && c.inbox.length > 0) order.push(c);
    }
    for (const c of order) {
      for (const m of c.inbox) if (m.type === 'moveReport') moves.receive(c.key!, m);
    }
    for (const c of order) {
      const inbox = c.inbox;
      c.inbox = [];
      c.inboxIntents = 0;
      for (const m of inbox) {
        if (m.type === 'moveReport') continue;
        if (!intents.receive(c.key!, m)) {
          this.kick(c, 'protocol_error', `more than ${INTENT_QUEUE_LIMIT} intents queued`);
          break;
        }
      }
    }
    moves.beforeTick();
    intents.beforeTick();
  }

  /** After Replicator.endTick(): kick the clients it found too slow. */
  afterTick(): void {
    for (const key of this.replicator.tooSlow()) {
      const c = this.byKey.get(key);
      if (c !== undefined && c.state === 'joined') this.kick(c, 'too_slow', 'the connection cannot keep up');
    }
  }

  /** End every connection (shutdown): Kick(reason) to the handshaken ones, Refuse(shutting_down) to those still in the handshake. */
  closeAll(reason: KickReason, detail: string): void {
    for (const c of [...this.live]) {
      if (c.state === 'hello') this.refuse(c, 'shutting_down', detail);
      else this.kick(c, reason, detail);
    }
  }

  // ------------------------------------------------------------------ arrival

  private onMessage(c: Connection, channel: Channel, bytes: Uint8Array): void {
    if (c.state === 'gone') return;
    c.lastHeard = this.o.now();
    if (c.state === 'hello') {
      this.handshake(c, channel, bytes);
      return;
    }
    let m: ClientMessage;
    try {
      m = decodeClientMessage(bytes, channel);
    } catch (e) {
      this.kick(c, 'protocol_error', e instanceof ProtocolError ? e.message : 'undecodable message');
      return;
    }
    switch (m.type) {
      case 'hello':
        this.kick(c, 'protocol_error', 'a second Hello');
        return;
      case 'ping':
        this.send(c, { type: 'pong', clientMs: m.clientMs, tick: this.sim.ticks });
        return;
      case 'bye':
        this.end(c);
        return;
      case 'moveReport':
        c.inbox.push(m);
        return;
      default:
        c.inbox.push(m);
        if (++c.inboxIntents > INTENT_QUEUE_LIMIT) this.kick(c, 'protocol_error', `more than ${INTENT_QUEUE_LIMIT} intents queued`);
    }
  }

  private handshake(c: Connection, channel: Channel, bytes: Uint8Array): void {
    let build: string;
    try {
      build = readHelloBuild(bytes);
    } catch {
      this.refuse(c, 'bad_hello', 'the first message must be a Hello');
      return;
    }
    if (build !== BUILD_ID) {
      this.refuse(c, 'build', `this server runs build ${BUILD_ID}`);
      return;
    }
    let hello: HelloMsg;
    try {
      const m = decodeClientMessage(bytes, channel);
      if (m.type !== 'hello') throw new ProtocolError('not a Hello');
      hello = m;
    } catch (e) {
      this.refuse(c, 'bad_hello', e instanceof Error ? e.message : 'malformed Hello');
      return;
    }
    const name = cleanName(hello.name);
    if (name === null) return this.refuse(c, 'bad_hello', `the name must have 1 to ${MAX_NAME_LENGTH} characters`);
    const key = hello.playerKey;
    if (!validKey(key)) return this.refuse(c, 'bad_hello', 'malformed player key');
    if (this.shuttingDown) return this.refuse(c, 'shutting_down', 'the server is shutting down');
    if (!c.local && !this.roomOpenValue) return this.refuse(c, 'closed', 'the room is not open');
    const old = this.byKey.get(key);
    if (!c.local && old !== undefined && old.local) return this.refuse(c, 'same_key', 'this is the host\'s own identity');
    if (old === undefined && !this.inSim.has(key) && this.playerCount >= MAX_PLAYERS) return this.refuse(c, 'full', `${MAX_PLAYERS} players are in the world`);
    // Accepted.
    if (old !== undefined) this.kick(old, 'replaced', 'the same identity connected again');
    c.state = 'accepted';
    c.key = key;
    c.name = name;
    c.viewRadius = hello.viewRadius;
    this.byKey.set(key, c);
    this.accepted.push(c);
    this.o.onAccept();
  }

  // ------------------------------------------------------------------ joining and leaving

  private join(c: Connection): void {
    const key = c.key!;
    const sim = this.sim;
    const first = !sim.players.keys().includes(key);
    const ctrl = sim.join(key);
    ctrl.setDrive('client');
    if (first) this.o.onFirstJoin(ctrl);
    ctrl.viewRadius = Math.min(c.viewRadius, SIM_RADIUS_CAP);
    this.replicator.addClient({
      key,
      name: c.name,
      host: c.local,
      viewRadius: c.viewRadius,
      sink: c.transport,
      feed: { intentAck: () => this.o.intents.intentAck(key), moveAck: () => this.o.moves.moveAck(key) },
    });
    this.send(c, {
      type: 'welcome',
      entityId: ctrl.entityId,
      generator: this.o.generator,
      worldTime: sim.ticks,
      dayOffset: sim.dayOffset,
      rules: { defaultMode: sim.rules.defaultMode, dropsEnabled: sim.rules.dropsEnabled },
      isHost: c.local,
      roomOpen: this.roomOpenValue,
      players: this.replicator.playerTable(),
    });
    c.state = 'joined';
    this.inSim.add(key);
    this.o.moves.join(key);
    this.o.intents.join(key, c.local);
  }

  private leave(key: PlayerKey): void {
    this.o.moves.leave(key);
    this.o.intents.leave(key);
    this.replicator.removeClient(key);
    this.sim.leave(key);
    this.inSim.delete(key);
  }

  // ------------------------------------------------------------------ ending connections

  private refuse(c: Connection, reason: RefuseReason, detail: string): void {
    this.send(c, { type: 'refuse', reason, detail });
    this.end(c);
  }

  private kick(c: Connection, reason: KickReason, detail: string): void {
    if (c.state === 'gone') return;
    this.send(c, { type: 'kick', reason, detail });
    this.end(c);
  }

  /** End a connection (idempotent). Its player, if this was the identity's current connection, leaves at the next tick. */
  private end(c: Connection): void {
    if (c.state === 'gone') return;
    c.state = 'gone';
    c.inbox = [];
    this.live.delete(c);
    c.transport.onMessage = null;
    c.transport.onClose = null;
    c.transport.close();
    if (c.key !== null && this.byKey.get(c.key) === c) this.byKey.delete(c.key);
  }

  private send(c: Connection, m: ServerMessage): void {
    c.transport.send(m.type === 'pong' ? UNRELIABLE : RELIABLE, encodeServerMessage(m));
  }
}
