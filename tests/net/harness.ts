/**
 * Headless multiplayer tests in one process (docs/NETCODE.md section 15 "无头联机测试的组装"):
 * a LoopbackNet with its virtual clock, a real ServerHost on that clock (timers are events of the
 * net's queue, chunk generation is budgeted by a number of columns, storage is a MemoryStorage),
 * and clients on loopback transports.
 *
 * CLIENTS. Until package 5's NetClient exists, a client is a RawClient: it speaks the protocol
 * through the codec (Hello, Ping, Bye, anything raw), keeps what the server sent, and at each
 * frame (every 16.7 ms of virtual time, each client with its own phase) applies the TickBatches
 * and Samples that arrived, in arrival order, to a ReplicaState (package 4's applyBatch) whose
 * pristine columns come from the Welcome's GeneratorSpec. While `hidden` it applies nothing (a
 * page without animation frames). The harness only drives clients through HarnessClient
 * (attach() connects any of them), so the real HeadlessClient can take RawClient's place.
 *
 * DIGESTS. track(client) records, after every server tick, the server's digest over what the
 * Replicator gave that client (Replicator.clientView), narrowed to the columns that changed in
 * the tick or entered / left the client's set; when the client has applied the batch of that tick
 * (and its samples), its replica is compared over the same columns (tests/net/digest.ts) and any
 * difference is kept in client.mismatches. compareNow(client) compares everything (call it when
 * the client has applied the server's last tick, e.g. after quiesce(), which holds the server
 * once the clients have caught up; section 15's "run until nothing is in flight, then 10 ticks"
 * comes first).
 *
 * Everything except the transport, the timers and the chunk source is product code.
 */
import { expect } from 'vitest';
import { applyBatch, applySamples, applyWelcome, ReplicaState } from '../../src/net/client/apply';
import { decodeServerMessage, encodeClientMessage } from '../../src/net/codec';
import type { CreateOptions, HostToPage } from '../../src/net/host/control';
import { ServerHost, type HostClock, type ServerSinks } from '../../src/net/host/host';
import { createLoopbackPair, LoopbackNet, type LinkConditions } from '../../src/net/loopback';
import {
  BUILD_ID,
  type ClientMessage,
  type KickMsg,
  type PongMsg,
  type RefuseMsg,
  type ServerMessage,
  type TickBatchMsg,
  type WelcomeMsg,
} from '../../src/net/protocol';
import type { Replicator } from '../../src/net/server/replicator';
import { RELIABLE, UNRELIABLE, type Channel, type Transport } from '../../src/net/transport';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { MemoryStorage, type SaveStorage } from '../../src/save/storage';
import type { Simulation } from '../../src/sim/simulation';
import type { PlayerKey } from '../../src/sim/view';
import { chunkKey } from '../../src/voxel/chunk';
import { generatorFromSpec, type GeneratorSpec } from '../../src/worldgen/generator';
import { compareReplica, DigestContext, replicaDigest, serverDigest, type Digest } from './digest';

/** A lossless link without delay. */
export const INSTANT: LinkConditions = Object.freeze({ latencyMs: 0, jitterMs: 0, loss: 0, seed: 1 });

/** Client frames: 60 a second. */
export const FRAME_MS = 1000 / 60;

/** Flat test ground: deeprock, stone, dirt, turf (top at y = 4). */
export const FLAT: GeneratorSpec = Object.freeze({
  kind: 'flat',
  seed: 7,
  layers: [
    { cell: 7, thickness: 1 },
    { cell: 1, thickness: 2 },
    { cell: 3, thickness: 1 },
  ],
}) as GeneratorSpec;

export function testMeta(id = 'w1', mode: WorldMeta['mode'] = 'creative'): WorldMeta {
  return { id, name: 'Test', seed: '7', seedHash: 7, mode, createdAt: 1, lastPlayed: 1, version: SAVE_VERSION, time: 0 };
}

// ====================================================================== the client side

/** What the harness needs of a client (RawClient now, package 5's HeadlessClient later). */
export interface HarnessClient {
  readonly key: PlayerKey;
  /** One client frame at virtual time `now`. */
  frame(now: number): void;
  /** Stop the client's input: held keys released, scripted actions dropped (quiesce()). */
  stopInput(): void;
  /** Apply everything received so far, unless the page is hidden (quiesce() calls it). */
  flush(): void;
  /** The replica, once Welcome arrived. */
  readonly replica: ReplicaState | null;
  /** The transport ended (Kick, Refuse, or closed by either end). */
  readonly closed: boolean;
  /** Set by track(): called once the batch of `tick` (and its samples) is applied. */
  onApplied: ((tick: number) => void) | null;
  /** Differences the per-tick checks found, and the number of ticks they compared. */
  readonly mismatches: string[];
  checked: number;
}

interface Received {
  channel: Channel;
  msg: ServerMessage;
}

/** A client that speaks the protocol through the codec (see the file comment). */
export class RawClient implements HarnessClient {
  replica: ReplicaState | null = null;
  welcome: WelcomeMsg | null = null;
  refuse: RefuseMsg | null = null;
  kick: KickMsg | null = null;
  /** The reason the server end closed with (onClose), or null. */
  closeReason: string | null = null;
  readonly pongs: PongMsg[] = [];
  /** Ticks of the batches applied, in order. */
  readonly applied: number[] = [];
  /** Ticks of the batches received (applied or not). */
  readonly received: number[] = [];
  /** Tick of the batch whose global section said `ready`, or null. */
  readyTick: number | null = null;
  /** Differences found by the per-tick checks (track()). */
  readonly mismatches: string[] = [];
  /** Ticks compared by the per-tick checks. */
  checked = 0;
  /** Apply nothing at frames (a hidden page). */
  hidden = false;
  /** Called after each applied batch (with its samples applied; before the next batch). */
  onApplied: ((tick: number) => void) | null = null;
  /** Every message, in arrival order (Welcome, Refuse, Kick, Pong are kept here too). */
  readonly log: ServerMessage[] = [];
  private readonly inbox: Received[] = [];
  private pendingCheck: number | null = null;
  private ended = false;

  constructor(
    readonly key: PlayerKey,
    readonly transport: Transport,
  ) {
    transport.onMessage = (channel, bytes) => this.receive(channel, bytes);
    transport.onClose = (reason) => {
      this.closeReason = reason;
      this.ended = true;
    };
  }

  get closed(): boolean {
    return this.ended || !this.transport.open;
  }

  /** Messages received and not yet applied. */
  get backlog(): number {
    return this.inbox.length;
  }

  send(m: ClientMessage): void {
    this.transport.send(m.type === 'ping' || m.type === 'moveReport' ? UNRELIABLE : RELIABLE, encodeClientMessage(m));
  }

  hello(o: { name?: string; viewRadius?: number; build?: string } = {}): void {
    this.send({ type: 'hello', build: o.build ?? BUILD_ID, playerKey: this.key, name: o.name ?? this.key, viewRadius: o.viewRadius ?? 2 });
  }

  /** Leave properly: Bye, then close. */
  bye(): void {
    this.send({ type: 'bye' });
    this.transport.close('bye');
    this.ended = true;
  }

  /** Drop the transport without a Bye. */
  drop(): void {
    this.transport.close('dropped');
    this.ended = true;
  }

  private receive(channel: Channel, bytes: Uint8Array): void {
    const msg = decodeServerMessage(bytes, channel);
    this.log.push(msg);
    switch (msg.type) {
      case 'welcome': {
        expect(this.welcome, `${this.key}: a second Welcome`).toBeNull();
        this.welcome = msg;
        const gen = generatorFromSpec(msg.generator);
        this.replica = new ReplicaState({ generate: (cx, cz) => gen.generate(cx, cz) });
        applyWelcome(this.replica, msg);
        return;
      }
      case 'refuse':
        this.refuse = msg;
        return;
      case 'kick':
        this.kick = msg;
        return;
      case 'pong':
        this.pongs.push(msg);
        return;
      case 'tickBatch':
        this.received.push(msg.tick);
        this.inbox.push({ channel, msg });
        return;
      case 'samples':
        this.inbox.push({ channel, msg });
        return;
    }
  }

  frame(_now: number): void {
    this.flush();
  }

  /** A raw client sends only what its test tells it to: there is no input to stop. */
  stopInput(): void {}

  flush(): void {
    if (!this.hidden) this.applyAll();
  }

  /** Apply everything received so far (the page's frame, or its message callback while hidden). */
  applyAll(): void {
    const q = this.inbox.splice(0);
    for (const { msg } of q) {
      if (msg.type === 'tickBatch') {
        this.finishBatch();
        expect(this.replica, `${this.key}: a batch before Welcome`).not.toBeNull();
        applyBatch(this.replica!, msg as TickBatchMsg);
        this.applied.push(msg.tick);
        if (msg.globals?.ready === true && this.readyTick === null) this.readyTick = msg.tick;
        this.pendingCheck = msg.tick;
      } else if (msg.type === 'samples' && this.replica !== null) {
        applySamples(this.replica, msg);
      }
    }
    this.finishBatch();
  }

  private finishBatch(): void {
    if (this.pendingCheck === null) return;
    const t = this.pendingCheck;
    this.pendingCheck = null;
    this.onApplied?.(t);
  }
}

// ====================================================================== the harness

export interface HarnessOptions {
  /** Columns generated after each tick (default 8). */
  chunkColumns?: number;
  sinks?: (sim: Simulation, replicator: Replicator) => ServerSinks;
  /** Ambient rabbits (default false). */
  rabbits?: boolean;
  storage?: SaveStorage;
}

/** A client's link: the conditions of each direction (default INSTANT). */
export interface ClientLink {
  up?: LinkConditions;
  down?: LinkConditions;
}

export interface AddClientOptions {
  /** The host's own connection (marked by the host, section 1). */
  local?: boolean;
  name?: string;
  viewRadius?: number;
  /** Send the Hello at once (default true). */
  hello?: boolean;
}

/**
 * One end of a loopback link, counting the reliable messages it sent and received, so the harness
 * knows when nothing is in flight (quiesce()). Reliable messages are never lost.
 */
class CountedEnd implements Transport {
  onMessage: Transport['onMessage'] = null;
  onClose: Transport['onClose'] = null;
  sent = 0;
  received = 0;
  constructor(private readonly inner: Transport) {
    inner.onMessage = (channel, bytes) => {
      if (channel === RELIABLE) this.received++;
      this.onMessage?.(channel, bytes);
    };
    inner.onClose = (reason) => this.onClose?.(reason);
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    if (channel === RELIABLE && this.inner.open) this.sent++;
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

interface Link {
  client: CountedEnd;
  server: CountedEnd;
  /** The longest an unreliable message takes on the network, either direction. */
  maxDelayMs: number;
}

/** Reliable messages in flight upwards (client -> server); none once either end has closed. */
function upInFlight(l: Link): number {
  return l.client.open && l.server.open ? l.client.sent - l.server.received : 0;
}

/** Everything in flight either way: reliable messages, and unreliable bytes still queued for bandwidth. */
function inFlight(l: Link): number {
  if (!l.client.open || !l.server.open) return 0;
  return upInFlight(l) + l.server.sent - l.client.received + l.client.bufferedBytes(UNRELIABLE) + l.server.bufferedBytes(UNRELIABLE);
}

/**
 * The host's timers on the net's queue; `lateMs` > 0 makes each timer fire between 0 and that many
 * ms after it is due, varying from timer to timer (setTimeout is always a little late);
 * `wakeEveryMs` > 0 then lets them fire only at multiples of it (a throttled background page).
 */
class VirtualClock implements HostClock {
  lateMs = 0;
  wakeEveryMs = 0;
  private timers = 0;
  /** Timers due while frozen wait until thaw(). */
  private frozen: Array<() => void> | null = null;
  constructor(private readonly net: LoopbackNet) {}
  freeze(): void {
    this.frozen ??= [];
  }
  thaw(): void {
    const due = this.frozen ?? [];
    this.frozen = null;
    for (const fn of due) this.net.schedule(this.net.now, fn);
  }
  now(): number {
    return this.net.now;
  }
  epochMs(): number {
    return 1_700_000_000_000 + this.net.now;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const h = { cancelled: false };
    const late = ((this.timers++ * 0.37) % 1) * this.lateMs;
    let at = this.net.now + Math.max(0, ms) + late;
    if (this.wakeEveryMs > 0) at = Math.ceil(at / this.wakeEveryMs) * this.wakeEveryMs;
    const run = (): void => {
      if (h.cancelled) return;
      if (this.frozen !== null) this.frozen.push(run);
      else fn();
    };
    this.net.schedule(at, run);
    return h;
  }
  clearTimer(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }
}

interface Tracked {
  client: HarnessClient;
  digests: Map<number, { digest: Digest; cols: Set<number> }>;
  lastColumns: Set<number>;
}

export class NetHarness {
  readonly net = new LoopbackNet();
  readonly clock: VirtualClock;
  readonly storage: SaveStorage;
  readonly host: ServerHost;
  readonly reports: HostToPage[] = [];
  readonly clients: HarnessClient[] = [];
  private readonly links: Link[] = [];
  private ctx: DigestContext | null = null;
  private changed = new Set<number>();
  private readonly tracked = new Map<HarnessClient, Tracked>();
  private hooked: Simulation | null = null;
  private clientSeq = 0;

  constructor(opts: HarnessOptions = {}) {
    this.clock = new VirtualClock(this.net);
    const storage = opts.storage ?? new MemoryStorage();
    this.storage = storage;
    this.host = new ServerHost({
      clock: this.clock,
      openStorage: () => Promise.resolve({ storage, persistent: true }),
      report: (m) => this.reports.push(m),
      chunkBudget: { columns: opts.chunkColumns ?? 8 },
      rabbits: opts.rabbits ?? false,
      ...(opts.sinks !== undefined ? { sinks: opts.sinks } : {}),
    });
    this.host.onTick = () => this.afterTick();
  }

  get sim(): Simulation {
    return this.host.sim;
  }

  /** Let a throttled page's timers fire only every `ms` (0 = normally). */
  set wakeEveryMs(ms: number) {
    this.clock.wakeEveryMs = ms;
  }

  /** Every host timer fires up to `ms` after it is due, by a varying amount (0 = on time). */
  set timerLateMs(ms: number) {
    this.clock.lateMs = ms;
  }

  async create(meta: WorldMeta = testMeta(), options: CreateOptions = { generator: FLAT, exampleShip: false }): Promise<void> {
    await this.host.control({ type: 'create', meta, options });
    this.hook();
  }

  async load(worldId: string): Promise<void> {
    await this.host.control({ type: 'load', worldId });
    this.hook();
  }

  /** Let pending promises (saves, control messages) settle. */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  private hook(): void {
    if (this.host.state !== 'running' || this.hooked === this.host.sim) return;
    const sim = this.host.sim;
    this.hooked = sim;
    this.ctx = new DigestContext(sim.generator);
    sim.world.onCellChange((x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
    sim.worldGlue.onChange((_a, x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
  }

  /**
   * A RawClient on a loopback link with these conditions (section 15: addClient(key, conditions,
   * opts)); it says Hello at once unless opts.hello is false.
   */
  addClient(key: PlayerKey, conditions: ClientLink = {}, opts: AddClientOptions = {}): RawClient {
    const c = this.attach(conditions, opts.local ?? false, (t) => new RawClient(key, t));
    if (opts.hello ?? true) c.hello({ ...(opts.name !== undefined ? { name: opts.name } : {}), viewRadius: opts.viewRadius ?? 2 });
    return c;
  }

  /** Connect any client on a loopback link (`make` gets the client end) and frame it. */
  attach<C extends HarnessClient>(conditions: ClientLink, local: boolean, make: (transport: Transport) => C): C {
    const up = conditions.up ?? INSTANT;
    const down = conditions.down ?? INSTANT;
    const pair = createLoopbackPair(this.net, up, down);
    const link: Link = {
      client: new CountedEnd(pair.client),
      server: new CountedEnd(pair.server),
      maxDelayMs: Math.max(up.latencyMs + up.jitterMs, down.latencyMs + down.jitterMs),
    };
    this.links.push(link);
    const c = make(link.client);
    this.host.connect(link.server, local);
    this.clients.push(c);
    // Frames with a phase of their own.
    const phase = ((this.clientSeq++ * 7.3) % FRAME_MS) + 0.1;
    const frame = (at: number): void => {
      this.net.schedule(at, () => {
        if (!this.clients.includes(c)) return;
        c.frame(this.net.now);
        frame(at + FRAME_MS);
      });
    };
    frame(this.net.now + phase);
    return c;
  }

  /** Stop framing a client (it stays connected unless it closes). */
  removeClient(c: HarnessClient): void {
    const i = this.clients.indexOf(c);
    if (i >= 0) this.clients.splice(i, 1);
    this.tracked.delete(c);
  }

  /** Advance virtual time by `ms` (a server held by quiesce() runs on). */
  run(ms: number): void {
    this.clock.thaw();
    this.net.advanceBy(ms);
  }

  /** Advance until `cond` holds (checked every `stepMs`), at most `maxMs` (a server held by quiesce() runs on). */
  runUntil(cond: () => boolean, maxMs = 10_000, stepMs = 10): void {
    this.clock.thaw();
    this.advanceUntil(cond, maxMs, stepMs);
  }

  private advanceUntil(cond: () => boolean, maxMs: number, stepMs: number): void {
    const end = this.net.now + maxMs;
    while (!cond()) {
      if (this.net.now >= end) throw new Error(`condition not reached within ${maxMs} ms`);
      this.net.advanceBy(stepMs);
    }
  }

  /**
   * Section 15: stop every client's input, run until no client message is in flight, then 10
   * more server ticks. Then (so that a full comparison is exact even while things move) hold the
   * server's clock, let everything in flight arrive and every visible client apply it: each
   * client's replica is then at the server's last tick. The next run() or runUntil() lets the
   * server's clock go on. Needs a ticking server (a paused one throws).
   */
  quiesce(): void {
    for (const c of this.clients) c.stopInput();
    this.runUntil(() => this.links.every((l) => upInFlight(l) === 0), 60_000, 1);
    const t0 = this.sim.ticks;
    this.runUntil(() => this.sim.ticks >= t0 + 10, 60_000, 1);
    this.clock.freeze();
    this.advanceUntil(() => this.links.every((l) => inFlight(l) === 0), 60_000, 1);
    this.net.advanceBy(Math.max(0, ...this.links.map((l) => l.maxDelayMs)) + 1);
    for (const c of this.clients) c.flush();
  }

  /** The server's timers fire nowhere for `ms` (a Worker blocked by a long task), then all that are due fire at once. */
  stallServer(ms: number): void {
    this.clock.freeze();
    this.net.advanceBy(ms);
    this.clock.thaw();
  }

  // ------------------------------------------------------------------ digests

  /** Compare `c` with the server after every tick (see the file comment). */
  track(c: HarnessClient): void {
    const t: Tracked = { client: c, digests: new Map(), lastColumns: new Set() };
    this.tracked.set(c, t);
    c.onApplied = (tick) => {
      const rec = t.digests.get(tick);
      if (rec === undefined) return;
      t.digests.delete(tick);
      for (const k of t.digests.keys()) if (k < tick) t.digests.delete(k);
      const r = replicaDigest(c.replica!, rec.cols);
      c.checked++;
      for (const d of compareReplica(rec.digest, r)) c.mismatches.push(`tick ${tick}: ${d}`);
    };
  }

  /** Compare everything the client has been given with the server now. */
  compareNow(c: HarnessClient, poses = true): string[] {
    const view = this.host.replicator.clientView(c.key);
    if (view === undefined) return ['not a client of the replicator'];
    const s = serverDigest(this.ctx!, this.sim, { columns: view.columns, structures: view.structures, entities: view.entities });
    return compareReplica(s, replicaDigest(c.replica!), { poses });
  }

  private afterTick(): void {
    const rep = this.host.replicator;
    for (const t of this.tracked.values()) {
      const view = rep.clientView(t.client.key);
      if (view === undefined) continue;
      const cols = new Set(this.changed);
      for (const k of view.columns) if (!t.lastColumns.has(k)) cols.add(k);
      for (const k of t.lastColumns) if (!view.columns.has(k)) cols.add(k);
      t.lastColumns = new Set(view.columns);
      const digest = serverDigest(this.ctx!, this.sim, { columns: view.columns, structures: view.structures, entities: view.entities }, cols);
      t.digests.set(this.sim.ticks, { digest, cols });
    }
    this.changed = new Set();
  }
}
