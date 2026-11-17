/**
 * Test-only server shim for package 5 (the real host is package 8's): a Simulation and a
 * Replicator behind loopback transports, with just enough of section 3 to drive NetClient through
 * its life cycle: Hello, then Welcome or Refuse (build, full), the join at the start of the next
 * tick (sim.join + setDrive('client'), Welcome, Replicator.addClient), Ping answered at once with
 * Pong, Bye and closes as leaving, a second connection with the same key replacing the first
 * (Kick(replaced)), and kick() / drop() from the test. Every tick it records, for each joined key,
 * the server's digest over what the Replicator says that client has (columns changed or added in
 * the tick, every structure and entity), and the poses of every ship, rotor angle and entity, so
 * the client side can compare at any tick.
 *
 * Also here: the scheduler that runs the server (a tick every 50 ms) and the clients (frames at
 * their own rate and phase, a heartbeat every second) on the LoopbackNet's virtual clock,
 * ChunkSources (synchronous, or answering after a delay), and transports that record what a client
 * received and replay it into another NetClient.
 */
import { expect } from 'vitest';
import type { Quat, Vec3 } from '../../src/core/math';
import type { ChunkSource } from '../../src/net/client/chunks';
import { NetClient, type NetClientOptions } from '../../src/net/client/netclient';
import { decodeClientMessage, encodeServerMessage, ProtocolError } from '../../src/net/codec';
import { createLoopbackPair, type LinkConditions, type LoopbackNet } from '../../src/net/loopback';
import { MAX_PLAYERS, MESSAGE_CHANNEL, type GeneratorSpec, type KickReason, type ServerMessage } from '../../src/net/protocol';
import { Replicator } from '../../src/net/server/replicator';
import type { Channel, Transport } from '../../src/net/transport';
import type { Simulation } from '../../src/sim/simulation';
import { Rotor } from '../../src/structures/structure';
import { chunkKey } from '../../src/voxel/chunk';
import type { ChunkGenerator } from '../../src/worldgen/generator';
import { compareReplica, DigestContext, replicaDigest, serverDigest, type Digest } from './digest';

export const PERFECT: LinkConditions = Object.freeze({ latencyMs: 0, jitterMs: 0, loss: 0, seed: 1 });

export function link(latencyMs: number, jitterMs = 0, loss = 0, seed = 1, extra: Partial<LinkConditions> = {}): LinkConditions {
  return { latencyMs, jitterMs, loss, seed, ...extra };
}

interface ShimConn {
  readonly transport: Transport;
  phase: 'hello' | 'accepted' | 'joined' | 'gone';
  key: string;
  name: string;
  viewRadius: number;
  /** Another connection of the same key was live: leave + join at the join. */
  replaces: boolean;
  /** Highest movement report seq received, and the one taken at the start of the current tick (moveAck). */
  moveSeq: number;
  accepted: number | null;
  /** Ticks at which each report seq was taken. */
  readonly acceptedAt: Map<number, number>;
}

/** What the server looked like at the end of a tick. */
export interface TickRecord {
  ships: Map<number, { pos: Vec3; rot: Quat }>;
  rotors: Map<number, number>;
  /** World position and yaw; carrier and position local to it. */
  entities: Map<number, { pos: Vec3; yaw: number; carrierId: number; local: Vec3 }>;
}

export class ShimServer {
  readonly rep: Replicator;
  readonly ctx: DigestContext;
  readonly conns: ShimConn[] = [];
  readonly history = new Map<number, TickRecord>();
  /** Server digests by key, then tick (recordDigests). */
  readonly digests = new Map<string, Map<number, Digest>>();
  recordDigests = true;
  build = 'test';
  generatorSpec: GeneratorSpec = { kind: 'void', seed: 0 };
  /** Keys whose Hello comes from the host's own page. */
  hostKeys = new Set<string>();
  private changed = new Set<number>();
  private known = new Map<string, Set<number>>();
  private leaving: string[] = [];

  constructor(
    readonly net: LoopbackNet,
    readonly sim: Simulation,
  ) {
    this.rep = new Replicator(sim);
    this.ctx = new DigestContext(sim.generator);
    sim.world.onCellChange((x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
    sim.worldGlue.onChange((_a, x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
  }

  /** A new connection; returns the client's end. */
  connect(up: LinkConditions = PERFECT, down: LinkConditions = PERFECT): Transport {
    const { client, server } = createLoopbackPair(this.net, up, down);
    const c: ShimConn = { transport: server, phase: 'hello', key: '', name: '', viewRadius: 0, replaces: false, moveSeq: -1, accepted: null, acceptedAt: new Map() };
    this.conns.push(c);
    server.onMessage = (channel, bytes) => this.receive(c, channel, bytes);
    server.onClose = () => this.closed(c);
    return client;
  }

  /** The live (accepted or joined) connection of a key. */
  live(key: string): ShimConn | undefined {
    return this.conns.find((c) => c.key === key && (c.phase === 'accepted' || c.phase === 'joined'));
  }

  kick(key: string, reason: KickReason): void {
    const c = this.live(key);
    if (c === undefined) throw new Error(`no connection for ${key}`);
    this.send(c, { type: 'kick', reason, detail: '' });
    this.end(c, true);
  }

  /** Close a key's connection from the server end without a word (the client sees onClose). */
  drop(key: string): void {
    const c = this.live(key)!;
    this.end(c, true);
  }

  /** One server tick: joins and leaves, sim.tick, endTick, records. */
  tick(): void {
    for (const key of this.leaving.splice(0)) {
      if (this.sim.players.get(key) !== undefined && this.live(key) === undefined) {
        this.rep.removeClient(key);
        this.sim.leave(key);
      }
    }
    for (const c of this.conns) {
      if (c.phase !== 'accepted') continue;
      if (c.replaces || this.sim.players.get(c.key) !== undefined) {
        this.rep.removeClient(c.key);
        if (this.sim.players.get(c.key) !== undefined) this.sim.leave(c.key);
      }
      const ctrl = this.sim.join(c.key);
      ctrl.setDrive('client');
      c.phase = 'joined';
      this.send(c, {
        type: 'welcome',
        entityId: ctrl.entityId,
        generator: this.generatorSpec,
        worldTime: this.sim.ticks,
        dayOffset: this.sim.dayOffset,
        rules: { ...this.sim.rules },
        isHost: this.hostKeys.has(c.key),
        roomOpen: false,
        players: [...this.rep.playerTable(), { entityId: ctrl.entityId, name: c.name, host: this.hostKeys.has(c.key) }].sort((a, b) => a.entityId - b.entityId),
      });
      this.rep.addClient({
        key: c.key,
        name: c.name,
        host: this.hostKeys.has(c.key),
        viewRadius: c.viewRadius,
        sink: c.transport,
        feed: { intentAck: () => null, moveAck: () => c.accepted },
      });
      this.known.set(c.key, new Set());
    }
    // Movement reports are taken at the start of the tick that follows their arrival (package 6's queue).
    for (const c of this.conns) {
      if (c.phase !== 'joined') continue;
      const last = c.acceptedAt.size > 0 ? Math.max(...c.acceptedAt.keys()) : -1;
      c.accepted = c.moveSeq > last ? c.moveSeq : null;
      if (c.accepted !== null) c.acceptedAt.set(c.accepted, this.sim.ticks + 1);
    }
    this.sim.tick();
    this.rep.endTick();
    this.record();
    this.changed = new Set();
  }

  private record(): void {
    const sim = this.sim;
    const rec: TickRecord = { ships: new Map(), rotors: new Map(), entities: new Map() };
    for (const s of sim.structures.all()) {
      if (s instanceof Rotor) rec.rotors.set(s.id, s.angle);
      else rec.ships.set(s.id, { pos: { ...s.grid.position }, rot: { ...s.grid.rotation } });
    }
    for (const e of sim.entities.all()) {
      if (e.removed) continue;
      const carrier = e.carrierId !== 0 ? sim.structures.get(e.carrierId) : undefined;
      const local = carrier !== undefined ? carrier.grid.toLocal(e.pos) : { ...e.pos };
      rec.entities.set(e.id, { pos: { ...e.pos }, yaw: e.yaw, carrierId: carrier?.id ?? 0, local });
    }
    this.history.set(sim.ticks, rec);
    if (!this.recordDigests) return;
    for (const c of this.conns) {
      if (c.phase !== 'joined') continue;
      const view = this.rep.clientView(c.key);
      if (view === undefined) continue;
      const known = this.known.get(c.key)!;
      const cols = new Set<number>();
      for (const k of view.columns) if (this.changed.has(k) || !known.has(k)) cols.add(k);
      this.known.set(c.key, new Set(view.columns));
      const d = serverDigest(this.ctx, sim, { columns: view.columns, structures: view.structures, entities: view.entities }, cols);
      let m = this.digests.get(c.key);
      if (m === undefined) {
        m = new Map();
        this.digests.set(c.key, m);
      }
      m.set(sim.ticks, d);
      m.delete(sim.ticks - 400);
    }
  }

  private send(c: ShimConn, m: ServerMessage): void {
    c.transport.send(MESSAGE_CHANNEL[m.type], encodeServerMessage(m));
  }

  private receive(c: ShimConn, channel: 0 | 1, bytes: Uint8Array): void {
    if (c.phase === 'gone') return;
    let m;
    try {
      m = decodeClientMessage(bytes, channel);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      if (c.phase === 'hello') this.refuse(c, 'bad_hello');
      else this.kick(c.key, 'protocol_error');
      return;
    }
    if (c.phase === 'hello') {
      if (m.type !== 'hello') return this.refuse(c, 'bad_hello');
      if (m.build !== this.build) return this.refuse(c, 'build');
      const old = this.live(m.playerKey);
      const players = this.conns.filter((x) => x.phase === 'accepted' || x.phase === 'joined').length;
      if (old === undefined && players >= MAX_PLAYERS) return this.refuse(c, 'full');
      c.key = m.playerKey;
      c.name = m.name;
      c.viewRadius = m.viewRadius;
      if (old !== undefined) {
        this.send(old, { type: 'kick', reason: 'replaced', detail: '' });
        this.end(old, false);
        c.replaces = true;
      }
      c.phase = 'accepted';
      return;
    }
    switch (m.type) {
      case 'ping':
        this.send(c, { type: 'pong', clientMs: m.clientMs, tick: this.sim.ticks });
        return;
      case 'moveReport':
        if (m.seq > c.moveSeq) c.moveSeq = m.seq;
        return;
      case 'bye':
        this.end(c, true);
        this.leaving.push(c.key);
        return;
      default:
        return;
    }
  }

  private refuse(c: ShimConn, reason: 'bad_hello' | 'build' | 'full'): void {
    this.send(c, { type: 'refuse', reason, detail: '' });
    this.end(c, true);
  }

  /** The connection is over; `leave`: the player leaves at the next tick (not when replaced). */
  private end(c: ShimConn, leave: boolean): void {
    const was = c.phase;
    c.phase = 'gone';
    c.transport.onMessage = null;
    c.transport.onClose = null;
    c.transport.close('closed');
    if (leave && was === 'joined') {
      this.rep.removeClient(c.key);
      this.leaving.push(c.key);
    }
  }

  private closed(c: ShimConn): void {
    if (c.phase === 'gone') return;
    this.end(c, true);
  }
}

// ====================================================================== recording

/** A Transport that records every message it receives before passing it on (to replay later). */
export class RecordingTransport implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  constructor(
    readonly inner: Transport,
    readonly log: Array<{ channel: Channel; bytes: Uint8Array }>,
  ) {
    inner.onMessage = (channel, bytes) => {
      log.push({ channel, bytes: bytes.slice() });
      this.onMessage?.(channel, bytes);
    };
    inner.onClose = (reason) => this.onClose?.(reason);
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

/** An open Transport that sends nowhere; the test delivers messages with deliver(). */
export class ReplayTransport implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  open = true;
  send(_channel: Channel, bytes: Uint8Array): void {
    this.sent.push(bytes.slice());
  }
  bufferedBytes(): number {
    return 0;
  }
  close(): void {
    this.open = false;
  }
  deliver(channel: Channel, bytes: Uint8Array): void {
    this.onMessage?.(channel, bytes.slice());
  }
}

// ====================================================================== chunk sources

/** Generates on the spot. */
export function syncSource(gen: ChunkGenerator): ChunkSource {
  return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
}

/** Answers `delayMs` after the request (pump(now) delivers what is due), like a worker pool. */
export class DelayedSource implements ChunkSource {
  readonly pending: Array<{ due: number; cx: number; cz: number; done: (cells: Uint16Array) => void }> = [];
  requests = 0;
  constructor(
    readonly gen: ChunkGenerator,
    readonly now: () => number,
    public delayMs: number,
  ) {}
  generate(cx: number, cz: number, done: (cells: Uint16Array) => void): void {
    this.requests++;
    this.pending.push({ due: this.now() + this.delayMs, cx, cz, done });
  }
  pump(now: number): void {
    for (;;) {
      const i = this.pending.findIndex((p) => p.due <= now);
      if (i < 0) return;
      const p = this.pending.splice(i, 1)[0]!;
      p.done(this.gen.generate(p.cx, p.cz));
    }
  }
}

// ====================================================================== clients and the scheduler

export interface ClientSetup {
  key: string;
  up?: LinkConditions;
  down?: LinkConditions;
  viewRadius?: number;
  /** Frame period, ms (default 1000 / 60). */
  frameMs?: number;
  /** First frame at this offset, ms. */
  phase?: number;
  /** Delay of pristine generation (default: synchronous). */
  genDelayMs?: number;
  build?: string;
  name?: string;
}

/** A NetClient on the shim, with its frame cadence. */
export class ShimClient {
  readonly net: NetClient;
  framesOn = true;
  frameMs: number;
  nextFrame: number;
  nextBeat: number;
  source: ChunkSource | null = null;
  /** Called after every frame. */
  onFrame: ((now: number) => void) | null = null;
  /** Compare the digests after every applied batch (server.recordDigests). */
  checkEveryBatch = true;
  readonly diffs: string[] = [];
  batchesChecked = 0;
  frames = 0;
  links: { up: LinkConditions; down: LinkConditions };
  /** Every message received, in order (all connections). */
  readonly received: Array<{ channel: Channel; bytes: Uint8Array }> = [];

  constructor(
    readonly server: ShimServer,
    readonly setup: ClientSetup,
  ) {
    const net = server.net;
    this.frameMs = setup.frameMs ?? 1000 / 60;
    this.nextFrame = net.now + (setup.phase ?? 0);
    this.nextBeat = net.now + (setup.phase ?? 0);
    this.links = { up: setup.up ?? PERFECT, down: setup.down ?? PERFECT };
    const opts: NetClientOptions = {
      openTransport: (ready) => ready(new RecordingTransport(server.connect(this.links.up, this.links.down), this.received)),
      now: () => net.now,
      chunkSource: () => {
        const src = setup.genDelayMs !== undefined ? new DelayedSource(server.sim.generator, () => net.now, setup.genDelayMs) : syncSource(server.sim.generator);
        this.source = src;
        return src;
      },
      playerKey: setup.key,
      name: setup.name ?? setup.key,
      viewRadius: setup.viewRadius ?? 3,
      build: setup.build ?? 'test',
    };
    this.net = new NetClient(opts);
    this.net.onBatch = (b, r) => {
      if (!this.checkEveryBatch || !server.recordDigests) return;
      const d = server.digests.get(setup.key)?.get(b.tick);
      if (d === undefined) return;
      const cols = new Set(d.columns.keys());
      const diff = compareReplica(d, replicaDigest(r.state, cols), { poses: false });
      for (const x of diff) this.diffs.push(`tick ${b.tick}: ${x}`);
      this.batchesChecked++;
    };
  }

  get replica() {
    return this.net.replica;
  }

  step(now: number): void {
    if (this.source instanceof DelayedSource) this.source.pump(now);
    if (now >= this.nextBeat) {
      this.net.heartbeat(now);
      this.nextBeat += 1000;
    }
    if (now >= this.nextFrame) {
      this.nextFrame += this.frameMs;
      if (this.framesOn) {
        this.net.frame(now);
        this.frames++;
        this.onFrame?.(now);
      }
    }
  }

  expectClean(): void {
    expect(this.diffs.slice(0, 10), `${this.setup.key}: per-batch digest differences`).toEqual([]);
  }
}

/** Server, clients and the clock. */
export class ShimWorld {
  readonly clients: ShimClient[] = [];
  /** Server ticks run (time of the next one). */
  private nextTick: number;
  /** Ticks on (false: the server sleeps, e.g. a throttled host). */
  ticking = true;
  /** Ticks per wake-up (catch-up bursts) and the wake-up period (ms). */
  burst = 1;
  wakeMs = 50;
  /** Called after every server tick. */
  onTick: (() => void) | null = null;

  constructor(readonly server: ShimServer) {
    this.nextTick = server.net.now + 50;
  }

  get net(): LoopbackNet {
    return this.server.net;
  }

  add(setup: ClientSetup, start = true): ShimClient {
    const c = new ShimClient(this.server, setup);
    this.clients.push(c);
    if (start) c.net.start();
    return c;
  }

  /** Run `ms` of virtual time: server ticks, client frames and heartbeats in time order. */
  run(ms: number): void {
    const end = this.net.now + ms;
    for (;;) {
      let t = this.nextTick;
      for (const c of this.clients) t = Math.min(t, c.nextFrame, c.nextBeat);
      if (t > end) break;
      this.net.advanceTo(Math.max(t, this.net.now));
      if (t === this.nextTick) {
        this.nextTick += this.wakeMs;
        if (this.ticking) {
          for (let i = 0; i < this.burst; i++) {
            this.server.tick();
            this.onTick?.();
          }
        }
      }
      for (const c of this.clients) if (t === c.nextFrame || t === c.nextBeat) c.step(t);
    }
    this.net.advanceTo(end);
  }

  /** Run until `cond` holds (checked every 10 ms), at most `maxMs`. */
  runUntil(cond: () => boolean, maxMs = 20_000): void {
    let left = maxMs;
    while (!cond()) {
      if (left <= 0) throw new Error('runUntil: condition not met in time');
      this.run(10);
      left -= 10;
    }
  }
}
