/**
 * ServerHost (docs/NETCODE.md sections 1, 4, 12, 15): one running server = a Simulation, a
 * NetServer (connections) and a Replicator (one TickBatch per client per tick), with its own
 * clock, chunk generation between ticks, saving and loading, and the host control messages.
 * The same code runs in the page's Worker (worker.ts), on the page's main thread when no Worker
 * can be started, in tests (tests/net/harness.ts) and later in a Node dedicated server: what
 * differs is passed in (HostClock, the storage, where reports go).
 *
 * ONE TICK (tickOnce): netServer.beforeTick() (leaves, replacements, joins; reports to moves,
 * intents to intents) -> sim.tick() -> replicator.endTick() -> netServer.afterTick() (too slow
 * clients are kicked) -> autosave every AUTOSAVE_TICKS ticks. Between ticks: arriving messages are
 * only queued (Ping is answered at once, NetServer), and missing chunks are generated within a
 * budget (sim.chunks.wanted() + loadColumn), CHUNK_BUDGET_MS per tick by default.
 *
 * CLOCK (section 4). TPS ticks a second from the host's own timer, corrected against its target
 * times (no drift). A late wake-up runs the ticks that are due, at most MAX_CATCHUP_TICKS; the
 * time beyond that is dropped (not compressed), and the tick phase is kept. Each tick sends its
 * own batch. The measured TPS = ticks run in the last 2000 ms of wall time (counting the ticks of
 * the present wake-up; over the tick slots since the clock started while that is shorter), at
 * most TPS (timer lateness would otherwise show 20.5), given to the Replicator (the globals) when
 * it changed, at most once a second of wall time. The page gets `status` (TPS, players, and each
 * guest's bytes a second, backlog and round trip) when it changed and every second while guests
 * are in, at most once a second, and `tickTime` (how long the ticks took) once a second.
 * The clock of a new or loaded world starts at the first accepted Hello, so the host's own client
 * joins a loaded world before its first tick (scenario 36: still at the wheel, on the deck).
 * Pause (single player) stops it; it is refused while the room is open, and opening the room
 * resumes it.
 *
 * SAVING (section 12): to the storage the host was given (HostStorage); `ready` tells the page
 * whether it persists, so the page can warn the player before they play on memory. A save is
 * SaveBundle (exportSave) plus the 'generator' blob (the GeneratorSpec; a save without it is a
 * terrain world of meta.seedHash, which is what client/game.ts writes) and the WorldMeta (mode =
 * the world's default mode). One save runs at a time; requests made while one runs share one
 * follow-up save of the newest state (the queue of client/saves.ts). Saves happen
 * right after a world is created, every AUTOSAVE_TICKS simulated ticks, on the page's 'save' and on
 * shutdown { save: true }, which closes the server only when the save succeeded (otherwise it
 * reports and runs on: LESSONS "保存失败仍然退出"). A failed save never stops the server.
 *
 * NEW WORLDS: the example windmill boat (unless options.exampleShip is false), and the starter
 * items for every identity that joins this world for the first time (section 17 item 5).
 */
import { TPS } from '../../core/constants';
import { ByteReader, ByteWriter } from '../../save/bytes';
import { isNewerSave, isOlderSave, SAVE_VERSION, type WorldMeta } from '../../save/codec';
import { SaveStorageError, type SaveStorage } from '../../save/storage';
import { placeExampleShip } from '../../sim/exampleShip';
import { exportSave, importSave, SAVE_BLOBS, type SaveBundle } from '../../sim/persist';
import { Simulation } from '../../sim/simulation';
import { giveStarterItems } from '../../sim/starter';
import { generatorFromSpec, generatorSpecProblem, type GeneratorSpec } from '../../worldgen/generator';
import { readGeneratorSpec, writeGeneratorSpec } from '../codec';
import { AUTOSAVE_TICKS, MAX_CATCHUP_TICKS } from '../protocol';
import { IntentQueue } from '../server/intents';
import { MoveQueue } from '../server/moves';
import { probeServer } from '../server/probe';
import { Replicator } from '../server/replicator';
import { RELIABLE, UNRELIABLE, type Transport } from '../transport';
import type { CreateOptions, GuestTraffic, HostToPage, PageToHost } from './control';
import { NetServer, type IntentSink, type MoveSink } from './netserver';

/** Milliseconds per tick. */
export const TICK_MS = 1000 / TPS;
/** Chunk generation between two ticks, ms (section 13: about 2.6 columns, enough for flying). */
export const CHUNK_BUDGET_MS = 6;
/** The window of the measured TPS, ms of wall time (section 4). */
export const TPS_WINDOW_MS = 2000;
/** Status reports to the page at most this often, ms. */
const STATUS_INTERVAL_MS = 1000;
/** A new measured TPS goes to the Replicator (the clients' globals) at most this often, ms of wall time (section 4). */
const TPS_REPORT_MS = 1000;
/** Save blob holding the world's GeneratorSpec. */
export const GENERATOR_BLOB = 'generator';
const GENERATOR_BLOB_VERSION = 1;

/** Time and timers, passed in (the Worker's, the page's or a test's virtual clock). */
export interface HostClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Milliseconds since the epoch (WorldMeta.lastPlayed). */
  epochMs(): number;
  /** Call `fn` once after `ms` milliseconds; returns a handle for clearTimer. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * A connection as a connect control message carries it inside the host: called once, when the
 * connect is carried out, it returns the connection's Transport (worker.ts wraps the MessagePort
 * only then; a port that is not started yet keeps what arrives).
 */
export type TransportOpener = () => Transport;

/** The calls a host makes on its storage (save/storage.ts SaveStorage): reading a world, writing a save. */
export type WorldStore = Pick<SaveStorage, 'getMeta' | 'listChunkKeys' | 'getChunks' | 'getBlob' | 'putAll'>;

/**
 * Where a host saves. `persistent` = it outlives the page (IndexedDB); a memory storage loses the
 * world when the page closes, `reason` says why it is one (save/idb.ts openBestStorage's code:
 * 'unavailable', 'timeout', 'blocked', 'newer-version' ...). The page warns the player (ready).
 * The page's server Worker saves into its own IndexedDB, else into the page's storage
 * (pagestorage.ts).
 */
export type HostStorage = { storage: WorldStore; persistent: true } | { storage: WorldStore; persistent: false; reason: string };

/** How much chunk generation happens after each tick: milliseconds of the clock, or a number of columns (tests). */
export type ChunkBudget = { ms: number } | { columns: number };

/** The packages behind NetServer.beforeTick (6: moves, 7: intents). */
export interface ServerSinks {
  moves: MoveSink;
  intents: IntentSink;
}

export interface ServerHostOptions {
  clock: HostClock;
  /** Opens the storage (once, at the first create or load; never rejects: the worst is a memory storage). */
  openStorage(): Promise<HostStorage>;
  /** Reports to the page (control.ts HostToPage). */
  report(msg: HostToPage): void;
  /** Default { ms: CHUNK_BUDGET_MS }. */
  chunkBudget?: ChunkBudget;
  /** The movement and intent packages of a world; default: defaultSinks. */
  sinks?: (sim: Simulation, replicator: Replicator) => ServerSinks;
  /** Ambient rabbits (default true; tests that count entities turn them off). */
  rabbits?: boolean;
  /** Starter items for identities joining a world for the first time (default true; tests that compare inventories turn them off). */
  starterItems?: boolean;
}

/** The packages behind NetServer of a world: the movement reports (package 6, net/server/moves.ts) and the intents (package 7, net/server/intents.ts). */
export function defaultSinks(sim: Simulation, replicator: Replicator): ServerSinks {
  const moves = new MoveQueue(sim);
  return { moves, intents: new IntentQueue(sim, moves, replicator) };
}

/** A world that is open on this host. */
interface OpenWorld {
  readonly sim: Simulation;
  readonly replicator: Replicator;
  readonly net: NetServer;
  readonly generator: GeneratorSpec;
  meta: WorldMeta;
}

interface QueuedSave {
  promise: Promise<boolean>;
}

export type HostState = 'idle' | 'running' | 'closed';

export class ServerHost {
  private readonly o: ServerHostOptions;
  private readonly clock: HostClock;
  private storage: Promise<HostStorage> | null = null;
  private world: OpenWorld | null = null;
  private closed = false;
  /** Control messages are carried out one after the other. */
  private chain: Promise<void> = Promise.resolve();

  // ---- clock
  /** The first accepted Hello started the clock. */
  private started = false;
  private pausedValue = false;
  /** Stopped by a shutdown in progress or a failure. */
  private halted = false;
  private timer: unknown = null;
  /** Target time of the next tick. */
  private nextAt = 0;
  /** When the clock (re)started: the TPS window is shorter before TPS_WINDOW_MS has passed. */
  private runningSince = 0;
  /** Wall time of every tick in the TPS window, oldest first. */
  private tickTimes: number[] = [];
  private tpsValue = TPS;
  /** The TPS last given to the Replicator, and when. */
  private tpsReported = { at: -Infinity, tps: TPS };
  private lastStatus = { at: -Infinity, tps: -1, players: -1 };
  /** Bytes sent to each guest by the last status, for its bytes a second. */
  private guestBytes = new Map<string, number>();
  /** Tick durations since the last tickTime report: count, total and longest ms, and when it went. */
  private tickCost = { at: -Infinity, n: 0, totalMs: 0, maxMs: 0 };
  private sinceSave = 0;

  // ---- saving
  private saveChain: Promise<unknown> = Promise.resolve();
  private queuedSave: QueuedSave | null = null;

  /** Called after every tick (tests record the server's state; a debug panel could read stats). */
  onTick: (() => void) | null = null;

  constructor(o: ServerHostOptions) {
    this.o = o;
    this.clock = o.clock;
  }

  // ------------------------------------------------------------------ queries

  get state(): HostState {
    return this.closed ? 'closed' : this.world === null ? 'idle' : 'running';
  }
  /** The open world's simulation. Throws when no world is open. */
  get sim(): Simulation {
    return this.open().sim;
  }
  get netServer(): NetServer {
    return this.open().net;
  }
  get replicator(): Replicator {
    return this.open().replicator;
  }
  get meta(): WorldMeta {
    return this.open().meta;
  }
  get paused(): boolean {
    return this.pausedValue;
  }
  /** Ticks per second over the last 2 s of wall time (section 4). */
  get tps(): number {
    return this.tpsValue;
  }

  private open(): OpenWorld {
    if (this.world === null) throw new Error('ServerHost: no world is open');
    return this.world;
  }

  // ------------------------------------------------------------------ control (control.ts)

  /**
   * Carry out a page's control message, after the ones before it. Never rejects: failures are
   * reported as `error`. A connect's TransportOpener is called only when the connect is carried
   * out, so a page may post connect right behind any command (a load or save still running):
   * the connection's first messages wait in its port until then (worker.ts).
   */
  control(msg: PageToHost<TransportOpener>): Promise<void> {
    const run = this.chain.then(() => this.carryOut(msg));
    this.chain = run.catch(() => undefined);
    return this.chain;
  }

  private async carryOut(msg: PageToHost<TransportOpener>): Promise<void> {
    try {
      switch (msg.type) {
        case 'create':
          return await this.create(msg.meta, msg.options);
        case 'load':
          return await this.load(msg.worldId);
        case 'connect':
          return this.connect(msg.port(), msg.local);
        case 'pause':
          return this.pause(msg.paused);
        case 'save':
          await this.save();
          return;
        case 'openRoom':
          return this.setRoomOpen(true);
        case 'closeRoom':
          return this.setRoomOpen(false);
        case 'shutdown':
          await this.shutdown(msg.save);
          return;
        case 'probe':
          this.o.report({ type: 'probe', id: msg.id, probe: this.world === null ? null : probeServer(this.world.sim, msg.radius) });
          return;
      }
    } catch (e) {
      this.o.report({ type: 'error', what: msg.type, message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Make a new world, report ready, save it once. */
  async create(meta: WorldMeta, options: CreateOptions = {}): Promise<void> {
    this.mayOpen();
    const opened = await this.openStorage();
    this.mayOpen();
    const spec = options.generator ?? { kind: 'terrain', seed: meta.seedHash >>> 0 };
    const sim = this.newSimulation(meta, spec);
    if (options.exampleShip ?? true) placeExampleShip(sim);
    this.serve(sim, spec, meta);
    this.reportReady(opened);
    void this.save();
  }

  /** Open a saved world, report ready (or an error, and stay idle). */
  async load(worldId: string): Promise<void> {
    this.mayOpen();
    const opened = await this.openStorage();
    const { meta, bundle, generator } = await readSave(opened.storage, worldId);
    this.mayOpen();
    const sim = this.newSimulation(meta, generator);
    importSave(sim, bundle);
    this.serve(sim, generator, meta);
    this.reportReady(opened);
  }

  private reportReady(opened: HostStorage): void {
    this.o.report({ type: 'ready', meta: this.open().meta, persistent: opened.persistent, reason: opened.persistent ? null : opened.reason });
  }

  /** A client connection (local = the host's own). Refused at once when no world is open. */
  connect(transport: Transport, local: boolean): void {
    if (this.world === null || this.closed) {
      transport.close('no world is open');
      throw new Error('connect: no world is open');
    }
    this.world.net.connect(transport, local);
  }

  /** Single-player pause: stop or resume the clock. Refused while the room is open. */
  pause(paused: boolean): void {
    const w = this.open();
    if (paused && w.net.roomOpen) throw new Error('cannot pause while the room is open');
    if (paused === this.pausedValue) return;
    this.pausedValue = paused;
    if (paused) this.stopTimer();
    else this.restartClock();
  }

  /** Open or close the room to guests (package 11). Opening resumes a paused server. */
  setRoomOpen(open: boolean): void {
    const w = this.open();
    w.net.roomOpen = open;
    if (open && this.pausedValue) this.pause(false);
  }

  /**
   * Save now (queued behind a running save; requests while one waits share it). Resolves true on
   * success; reports `saved` either way.
   */
  save(): Promise<boolean> {
    if (this.world === null) return Promise.resolve(false);
    const waiting = this.queuedSave;
    if (waiting !== null) return waiting.promise;
    const entry: QueuedSave = { promise: Promise.resolve(false) };
    entry.promise = this.saveChain.then(() => {
      if (this.queuedSave === entry) this.queuedSave = null;
      return this.writeSave();
    });
    this.queuedSave = entry;
    this.saveChain = entry.promise;
    return entry.promise;
  }

  /**
   * Shut the server down: with `save`, only once the save succeeded (else it reports and runs on);
   * every client gets Kick(shutdown); the page gets `closed`. Resolves true when it closed.
   */
  async shutdown(save: boolean): Promise<boolean> {
    const w = this.world;
    if (w === null || this.closed) {
      this.finishClose();
      return true;
    }
    w.net.shuttingDown = true;
    this.halted = true;
    this.stopTimer();
    if (save && !(await this.save())) {
      w.net.shuttingDown = false;
      this.halted = false;
      this.restartClock();
      this.o.report({ type: 'error', what: 'shutdown', message: 'the save failed; the server keeps running' });
      return false;
    }
    w.net.closeAll('shutdown', 'the host closed the world');
    w.replicator.dispose();
    w.sim.dispose();
    this.finishClose();
    return true;
  }

  private finishClose(): void {
    this.closed = true;
    this.stopTimer();
    this.o.report({ type: 'closed' });
  }

  // ------------------------------------------------------------------ the world

  private mayOpen(): void {
    if (this.closed) throw new Error('the server has shut down');
    if (this.world !== null) throw new Error('a world is already open');
  }

  private openStorage(): Promise<HostStorage> {
    this.storage ??= this.o.openStorage();
    return this.storage;
  }

  private newSimulation(meta: WorldMeta, spec: GeneratorSpec): Simulation {
    return new Simulation({ seed: meta.seedHash >>> 0, mode: meta.mode, generator: generatorFromSpec(spec), rabbits: this.o.rabbits ?? true });
  }

  /**
   * Open `sim` as this host's world: create and load end here. Called directly by code that built
   * the simulation itself (tests/acceptance/world.ts sets a world up exactly like its direct runs:
   * spawn, load radius, chunks generated inside the tick); then nothing else happens: no example
   * ship, no `ready` report, no first save. `generator` must describe sim.generator (clients
   * generate pristine columns from it).
   */
  serve(sim: Simulation, generator: GeneratorSpec, meta: WorldMeta): void {
    this.mayOpen();
    const replicator = new Replicator(sim);
    const sinks = (this.o.sinks ?? defaultSinks)(sim, replicator);
    const net = new NetServer({
      sim,
      replicator,
      generator,
      moves: sinks.moves,
      intents: sinks.intents,
      now: () => this.clock.now(),
      onFirstJoin: (ctrl) => {
        if (this.o.starterItems ?? true) giveStarterItems(ctrl);
      },
      onAccept: () => this.firstAccept(),
    });
    replicator.tps = TPS;
    this.world = { sim, replicator, net, generator, meta };
  }

  // ------------------------------------------------------------------ the tick

  /** One server tick (section 15). */
  tickOnce(): void {
    const w = this.open();
    w.net.beforeTick();
    w.sim.tick();
    w.replicator.endTick();
    w.net.afterTick();
    if (++this.sinceSave >= AUTOSAVE_TICKS) void this.save();
    this.onTick?.();
  }

  /** Generate missing chunks within the budget (between ticks). */
  generateChunks(): void {
    const sim = this.open().sim;
    const budget = this.o.chunkBudget ?? { ms: CHUNK_BUDGET_MS };
    if ('columns' in budget) {
      for (const c of sim.chunks.wanted(budget.columns)) sim.chunks.loadColumn(sim.generator, c.cx, c.cz);
      return;
    }
    const start = this.clock.now();
    while (this.clock.now() - start < budget.ms) {
      const next = sim.chunks.wanted(1);
      if (next.length === 0) return;
      sim.chunks.loadColumn(sim.generator, next[0]!.cx, next[0]!.cz);
    }
  }

  private firstAccept(): void {
    if (this.started) return;
    this.started = true;
    if (!this.pausedValue) this.restartClock();
  }

  private restartClock(): void {
    if (!this.started || this.pausedValue || this.halted || this.closed) return;
    const now = this.clock.now();
    this.nextAt = now;
    this.runningSince = now;
    this.tickTimes = [];
    this.arm();
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.stopTimer();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.wake();
    }, Math.max(0, this.nextAt - this.clock.now()));
  }

  private wake(): void {
    if (this.world === null || this.pausedValue || this.halted || this.closed) return;
    const now = this.clock.now();
    let n = 0;
    while (this.nextAt <= now && n < MAX_CATCHUP_TICKS) {
      n++;
      this.nextAt += TICK_MS;
    }
    // Time beyond the catch-up limit is dropped; the phase of the ticks is kept.
    if (this.nextAt <= now) this.nextAt += (Math.floor((now - this.nextAt) / TICK_MS) + 1) * TICK_MS;
    this.measure(now, n);
    try {
      for (let i = 0; i < n; i++) {
        const t0 = this.clock.now();
        this.tickOnce();
        this.noteTickCost(this.clock.now() - t0);
        if (this.halted || this.pausedValue || this.closed) break;
        this.generateChunks();
      }
    } catch (e) {
      this.halted = true;
      this.o.report({ type: 'error', what: 'tick', message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      return;
    }
    this.reportStatus(now);
    if (!this.halted && !this.pausedValue && !this.closed) this.arm();
  }

  /**
   * Section 4: ticks run in the last TPS_WINDOW_MS of wall time, these `n` included, at most TPS.
   * Each tick counts at the wake-up that ran it, which is a little after its target time, so a
   * window may hold one tick more than its length allows (41 in 2 s): without the cap the value
   * would flip between 20 and 20.5 and reach every client's globals and the page's status.
   */
  private measure(now: number, n: number): void {
    const times = this.tickTimes;
    for (let i = 0; i < n; i++) times.push(now);
    let k = 0;
    while (k < times.length && times[k]! <= now - TPS_WINDOW_MS) k++;
    if (k > 0) times.splice(0, k);
    // Before the window is full: over the tick slots since the clock (re)started.
    const span = Math.min(TPS_WINDOW_MS, (Math.floor((now - this.runningSince) / TICK_MS) + 1) * TICK_MS);
    this.tpsValue = Math.min(TPS, Math.round((times.length * 1000 * 10) / span) / 10);
    // Into the globals when it changed, at most once a second of wall time: counting in ticks
    // instead would wait 4 s at 5 TPS, and a small first drop (19) would hold back the real one.
    const r = this.tpsReported;
    if (this.tpsValue !== r.tps && now - r.at >= TPS_REPORT_MS) {
      this.tpsReported = { at: now, tps: this.tpsValue };
      this.open().replicator.tps = this.tpsValue;
    }
  }

  private noteTickCost(ms: number): void {
    const t = this.tickCost;
    t.n++;
    t.totalMs += ms;
    if (ms > t.maxMs) t.maxMs = ms;
  }

  private reportStatus(now: number): void {
    const t = this.tickCost;
    if (t.n > 0 && now - t.at >= STATUS_INTERVAL_MS) {
      this.o.report({ type: 'tickTime', meanMs: t.totalMs / t.n, maxMs: t.maxMs });
      this.tickCost = { at: now, n: 0, totalMs: 0, maxMs: 0 };
    }
    const s = this.lastStatus;
    const w = this.open();
    const players = w.net.playerCount;
    const traffic = w.net.traffic().filter((t) => !t.local);
    if (now - s.at < STATUS_INTERVAL_MS || (s.tps === this.tpsValue && s.players === players && traffic.length === 0)) return;
    const seconds = (now - s.at) / 1000;
    const bytes = new Map<string, number>();
    const guests: GuestTraffic[] = [];
    for (const t of traffic) {
      const st = w.replicator.stats(t.key);
      const ctrl = w.sim.players.get(t.key);
      if (st === undefined || ctrl === undefined) continue;
      const total = st.reliableBytes + st.sampleBytes;
      bytes.set(t.key, total);
      const before = this.guestBytes.get(t.key);
      guests.push({
        entityId: ctrl.entityId,
        name: t.name,
        bytesPerSec: before === undefined || !Number.isFinite(seconds) ? 0 : Math.round((total - before) / seconds),
        backlogBytes: t.transport.bufferedBytes(RELIABLE) + t.transport.bufferedBytes(UNRELIABLE),
        rttMs: t.rttMs,
      });
    }
    this.guestBytes = bytes;
    this.lastStatus = { at: now, tps: this.tpsValue, players };
    this.o.report({ type: 'status', tps: this.tpsValue, players, guests });
  }

  // ------------------------------------------------------------------ saving

  private async writeSave(): Promise<boolean> {
    const w = this.world;
    if (w === null) return false;
    this.sinceSave = 0;
    try {
      const { storage } = await this.openStorage();
      const sim = w.sim;
      const meta: WorldMeta = { ...w.meta, mode: sim.rules.defaultMode, lastPlayed: Math.floor(this.clock.epochMs()), time: sim.world.time, version: SAVE_VERSION };
      const bundle = saveBundle(sim, w.generator);
      await storage.putAll(meta.id, meta, bundle.chunks, bundle.blobs);
      w.meta = meta;
      this.o.report({ type: 'saved', ok: true, code: null });
      return true;
    } catch (e) {
      this.o.report({ type: 'saved', ok: false, code: e instanceof SaveStorageError ? e.code : 'failed' });
      return false;
    }
  }
}

/** What a save of `sim` writes (section 12): exportSave's bundle plus the 'generator' blob. */
export function saveBundle(sim: Simulation, generator: GeneratorSpec): SaveBundle {
  const bundle = exportSave(sim);
  bundle.blobs.push([GENERATOR_BLOB, encodeGeneratorBlob(generator)]);
  return bundle;
}

/**
 * A saved world read back from `storage`: its meta, the bundle importSave takes (the chunks and
 * the SAVE_BLOBS) and its generator (the 'generator' blob; without one, the terrain of
 * meta.seedHash). Throws when the world does not exist or was saved by another version.
 */
export async function readSave(storage: WorldStore, worldId: string): Promise<{ meta: WorldMeta; bundle: SaveBundle; generator: GeneratorSpec }> {
  const meta = await storage.getMeta(worldId);
  if (meta === null) throw new Error(`world "${worldId}" does not exist`);
  if (isNewerSave(meta)) throw new Error(`world "${worldId}" was saved by a newer version`);
  if (isOlderSave(meta)) throw new Error(`world "${worldId}" was saved by an older version`);
  const keys = await storage.listChunkKeys(worldId);
  const data = keys.length > 0 ? await storage.getChunks(worldId, keys) : [];
  const bundle: SaveBundle = { chunks: [], blobs: [] };
  keys.forEach((k, i) => {
    const bytes = data[i];
    if (bytes) bundle.chunks.push([k, bytes]);
  });
  for (const name of SAVE_BLOBS) {
    const b = await storage.getBlob(worldId, name);
    if (b) bundle.blobs.push([name, b]);
  }
  const gen = await storage.getBlob(worldId, GENERATOR_BLOB);
  const generator: GeneratorSpec = gen === null ? { kind: 'terrain', seed: meta.seedHash >>> 0 } : decodeGeneratorBlob(gen);
  return { meta, bundle, generator };
}

function encodeGeneratorBlob(spec: GeneratorSpec): Uint8Array {
  const w = new ByteWriter(16);
  w.varuint(GENERATOR_BLOB_VERSION);
  writeGeneratorSpec(w, spec);
  return w.finish();
}

function decodeGeneratorBlob(bytes: Uint8Array): GeneratorSpec {
  const r = new ByteReader(bytes, GENERATOR_BLOB);
  const v = r.varuint();
  if (v !== GENERATOR_BLOB_VERSION) r.fail(`unsupported generator blob version ${v}`);
  const spec = readGeneratorSpec(r);
  r.expectEnd();
  const problem = generatorSpecProblem(spec);
  if (problem !== null) r.fail(problem);
  return spec;
}
