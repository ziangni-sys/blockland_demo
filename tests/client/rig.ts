/**
 * Headless rig for the browser client's wiring (package 9): a real ServerHost on a LoopbackNet's
 * virtual clock (a MemoryStorage, chunk generation budgeted by a number of columns, no rabbits),
 * and the page's own WorldSession connected to it as the host's client over a lossless loopback
 * link, its frames (60 a second) and heartbeats (every second) events on the same clock. There is
 * no DOM, no WebGL and no Worker: every pool is null, so the main-thread paths run (the terrain
 * source generates on the main thread, meshing is synchronous), and the backend is a recording
 * fake. Everything else is product code: the session predicts its player from `held`, sends
 * intents, and draws what its replica holds.
 *
 * `sim` is the server's Simulation: tests build scenes on it and read what the server has.
 */
import type {
  BackendInfo,
  CameraState,
  DryVolume,
  EntityRenderState,
  EnvironmentState,
  OverlayState,
  RenderBackend,
  RenderStats,
  StructurePose,
  TileTextureData,
} from '../../src/render/backend';
import type { MeshData } from '../../src/mesh/types';
import type { ViewMode } from '../../src/client/camera';
import { WorldSession, type SessionDeps } from '../../src/client/session';
import type { CreateOptions, HostToPage } from '../../src/net/host/control';
import { ServerHost, type HostClock } from '../../src/net/host/host';
import { createLoopbackPair, LoopbackNet, type LinkConditions } from '../../src/net/loopback';
import type { GeneratorSpec } from '../../src/net/protocol';
import type { NetStatus } from '../../src/net/client/netclient';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { MemoryStorage, type SaveStorage } from '../../src/save/storage';
import type { Simulation } from '../../src/sim/simulation';
import type { Message } from '../../src/sim/view';
import { B } from '../../src/blocks/defs';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import { FlatGenerator } from '../../src/worldgen/generator';
import { LightEngine } from '../../src/light/engine';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';

/** A recording fake of the render backend. */
export class RecordingBackend implements RenderBackend {
  readonly sections = new Map<number, { ox: number; oy: number; oz: number }>();
  readonly structures = new Map<number, { ox: number; oy: number; oz: number }>();
  readonly poses = new Map<number, StructurePose>();
  readonly dry = new Map<number, DryVolume | null>();
  entities: readonly EntityRenderState[] = [];
  camera: CameraState | null = null;
  env: EnvironmentState | null = null;
  overlays: OverlayState | null = null;
  async init(): Promise<BackendInfo> {
    return { api: 'webgl2', detail: 'fake' };
  }
  setTiles(_t: TileTextureData): void {}
  setSectionMesh(key: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (mesh) this.sections.set(key, { ox, oy, oz });
    else this.sections.delete(key);
  }
  setStructureMesh(id: number, ox: number, oy: number, oz: number, mesh: MeshData | null): void {
    if (mesh) this.structures.set(id, { ox, oy, oz });
    else {
      this.structures.delete(id);
      this.poses.delete(id);
    }
  }
  setStructurePose(id: number, pose: StructurePose): void {
    this.poses.set(id, { ...pose });
  }
  setStructureDryVolume(id: number, dry: DryVolume | null): void {
    this.dry.set(id, dry);
  }
  setEntities(list: readonly EntityRenderState[]): void {
    this.entities = list.map((e) => ({ ...e }));
  }
  setCamera(cam: CameraState): void {
    this.camera = { ...cam };
  }
  setEnvironment(env: EnvironmentState): void {
    this.env = { ...env };
  }
  setOverlays(o: OverlayState): void {
    this.overlays = o;
  }
  resize(): void {}
  render(): void {}
  stats(): RenderStats {
    return { drawCalls: 0, triangles: 0, sections: this.sections.size, structures: this.structures.size };
  }
  dispose(): void {}
}

/** The default flat world of the simulation tests (tests/sim/helpers.ts flatSim): first air at y = FLAT_TOP, spawn (0.5, FLAT_TOP, 0.5). */
export const FLAT: GeneratorSpec = new FlatGenerator().spec();
export const FLAT_TOP = 35;
/** The sea world of the simulation tests (seaSim): water surface cells at y = 29, first air at y = SEA_TOP. */
export const SEA: GeneratorSpec = new FlatGenerator([
  { id: B.DEEPROCK, thickness: 1 },
  { id: B.STONE, thickness: 19 },
  { id: B.WATER, thickness: 10 },
]).spec();
export const SEA_TOP = 30;

export const FRAME_MS = 1000 / 60;

/** A lit world of FLAT columns within `radius` chunks of the origin (what a replica holds, without a server). */
export function flatWorld(radius = 2): World {
  const gen = new FlatGenerator();
  const world = new World();
  const light = new LightEngine(world);
  light.attach();
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      const c = new Chunk(cx, cz, gen.generate(cx, cz));
      world.addChunk(c);
      light.initChunk(c);
    }
  }
  light.update(1e9);
  return world;
}
const INSTANT: LinkConditions = { latencyMs: 0, jitterMs: 0, loss: 0, seed: 1 };

export function testMeta(id = 'w1', mode: WorldMeta['mode'] = 'creative', seedHash = 7): WorldMeta {
  return { id, name: 'Test', seed: String(seedHash), seedHash, mode, createdAt: 1, lastPlayed: 1, version: SAVE_VERSION, time: 0 };
}

/** The host's timers as events of the net's queue. */
class NetClock implements HostClock {
  constructor(private readonly net: LoopbackNet) {}
  now(): number {
    return this.net.now;
  }
  epochMs(): number {
    return 1_700_000_000_000 + this.net.now;
  }
  setTimer(fn: () => void, ms: number): unknown {
    const h = { cancelled: false };
    this.net.schedule(this.net.now + Math.max(0, ms), () => {
      if (!h.cancelled) fn();
    });
    return h;
  }
  clearTimer(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }
}

export interface RigOptions {
  generator?: GeneratorSpec;
  mode?: WorldMeta['mode'];
  /** Stamp the example windmill boat (default false). */
  exampleShip?: boolean;
  /** Subscription radius (default 4). */
  viewRadius?: number;
  storage?: SaveStorage;
  /** Build the scene on the server's Simulation before the client connects. */
  setup?: (sim: Simulation) => void;
  /** Load this world instead of creating one. */
  load?: string;
  /** Pools and other deps (default: none, everything on the main thread). */
  deps?: Partial<SessionDeps>;
  playerKey?: string;
}

export class SessionRig {
  readonly net = new LoopbackNet();
  readonly storage: SaveStorage;
  readonly host: ServerHost;
  readonly backend = new RecordingBackend();
  readonly reports: HostToPage[] = [];
  readonly toasts: Array<{ message: Message; kind: string }> = [];
  readonly statuses: NetStatus[] = [];
  readonly errors: string[] = [];
  session!: WorldSession;
  viewMode: ViewMode = 'first';
  /** The world is paused (no client ticks, see WorldSession.update). */
  paused = false;
  frames = 0;
  private lastFrame = 0;

  private constructor(opts: RigOptions) {
    this.storage = opts.storage ?? new MemoryStorage();
    const storage = this.storage;
    this.host = new ServerHost({
      clock: new NetClock(this.net),
      openStorage: () => Promise.resolve({ storage, persistent: true }),
      report: (m) => this.reports.push(m),
      chunkBudget: { columns: 16 },
      rabbits: false,
    });
  }

  static async create(opts: RigOptions = {}): Promise<SessionRig> {
    const rig = new SessionRig(opts);
    if (opts.load !== undefined) await rig.host.control({ type: 'load', worldId: opts.load });
    else {
      const options: CreateOptions = { generator: opts.generator ?? FLAT, exampleShip: opts.exampleShip ?? false };
      await rig.host.control({ type: 'create', meta: testMeta('w1', opts.mode ?? 'creative'), options });
    }
    for (let i = 0; i < 50; i++) await Promise.resolve();
    if (opts.setup) {
      // A scene needs its ground loaded (World.setCell does nothing in an unloaded column).
      const sim = rig.host.sim;
      sim.chunks.loadAround(sim.generator, sim.spawnPoint.x, sim.spawnPoint.z, 2);
      opts.setup(sim);
    }
    rig.connect(opts);
    return rig;
  }

  get sim(): Simulation {
    return this.host.sim;
  }

  private connect(opts: RigOptions): void {
    const noErrors = (what: string, err: unknown): void => {
      this.errors.push(`${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    };
    this.session = new WorldSession({
      backend: this.backend,
      genPool: null,
      meshPool: null,
      now: () => this.net.now,
      onError: noErrors,
      openTransport: (ready) => {
        const pair = createLoopbackPair(this.net, { ...INSTANT }, { ...INSTANT });
        this.host.connect(pair.server, true);
        ready(pair.client);
      },
      playerKey: opts.playerKey ?? 'p'.repeat(32),
      name: 'Tester',
      viewRadius: opts.viewRadius ?? 4,
      onToast: (message, kind) => this.toasts.push({ message, kind }),
      onStatus: (s) => this.statuses.push(s),
      ...opts.deps,
    });
    this.session.start();
    const frame = (at: number): void => {
      this.net.schedule(at, () => {
        this.frame();
        frame(at + FRAME_MS);
      });
    };
    const beat = (at: number): void => {
      this.net.schedule(at, () => {
        this.session.heartbeat(this.net.now);
        beat(at + 1000);
      });
    };
    this.lastFrame = this.net.now;
    frame(this.net.now + 1);
    beat(this.net.now + 500);
  }

  /** One page frame: update, meshing, present (what Game.sessionFrame does around its screens). */
  frame(): void {
    const now = this.net.now;
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const s = this.session;
    s.update(now, dt, 1e9, { fov: 70, viewMode: this.viewMode, step: !this.paused });
    s.work(now, 1e9, s.state === 'ready');
    s.present(dt, 4, now / 1000, now);
    this.frames++;
  }

  run(ms: number): void {
    this.net.advanceBy(ms);
  }

  runUntil(cond: () => boolean, maxMs = 20_000, stepMs = 5): void {
    const end = this.net.now + maxMs;
    while (!cond()) {
      if (this.net.now >= end) throw new Error(`condition not reached within ${maxMs} ms`);
      this.net.advanceBy(stepMs);
    }
  }

  /**
   * Run until the loading finished and the prediction ran its first client tick (it adopted the
   * join's correction, which tells where the player looks: set the look after this).
   */
  playUntilReady(maxMs = 20_000): void {
    this.runUntil(() => this.session.state === 'ready' && (this.session.own?.lastSeq ?? 0) > 0, maxMs);
  }

  /** Run until the server has run `n` more ticks and the client has applied their batches. */
  ticks(n: number): void {
    const t = this.sim.ticks + n;
    this.runUntil(() => this.sim.ticks >= t && (this.session.replica?.state.tick ?? -1) >= t, Math.max(5000, n * 200), 1);
  }

  /** Point the held look at a world point from the eyes as shown. */
  lookAt(x: number, y: number, z: number): void {
    const s = this.session.shown;
    const ex = s.feet.x;
    const ey = s.feet.y + s.eyeHeight;
    const ez = s.feet.z;
    const dx = x - ex;
    const dy = y - ey;
    const dz = z - ez;
    const h = Math.hypot(dx, dz);
    if (h > 1e-12) this.session.held.yaw = Math.atan2(-dx, -dz);
    this.session.held.pitch = Math.atan2(dy, h);
  }

  /** Select the hotbar slot holding `item` (as shown; a predicted inventory action). Throws when there is none. */
  hold(item: number): void {
    const inv = this.session.inventory!;
    const slot = inv.hotbar.findIndex((st) => st !== null && st.item === item && st.count > 0);
    if (slot < 0) throw new Error(`no ${item} in the hotbar`);
    if (slot !== inv.selected) this.session.selectSlot(slot);
  }

  /** Point the held look at a cell of a grid of the replica (0 = the world): at `face`'s centre when given, else the cell's. */
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId = 0): void {
    const r = this.session.replica!;
    const g = gridId === 0 ? r.world : r.state.structures.get(gridId)!.structure.grid;
    const p = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    if (face !== undefined) {
      p.x += DIR_X[face]! * 0.45;
      p.y += DIR_Y[face]! * 0.45;
      p.z += DIR_Z[face]! * 0.45;
    }
    const w = g.toWorld(p, { x: 0, y: 0, z: 0 });
    this.lookAt(w.x, w.y, w.z);
  }

  /**
   * Aim at a cell (and face) and right-click it (`sneak`: with the sneak key), then wait for the
   * server's answer. False (nothing clicked) when the use target is not that cell.
   */
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0, sneak = false): boolean {
    this.lookAtCell(x, y, z, face, gridId);
    this.run(50);
    const t = this.session.intents!.useTarget;
    if (t === null || t.gridId !== gridId || t.x !== x || t.y !== y || t.z !== z || (face !== undefined && t.face !== face)) return false;
    this.session.pressUse(sneak);
    this.session.releaseUse();
    this.waitAck();
    return true;
  }

  /** Host command: move the player; waits until the prediction adopted the correction. */
  teleport(x: number, y: number, z: number): void {
    const own = this.session.own!;
    const epoch = own.epoch;
    this.session.hostCommand({ kind: 'teleport', x, y, z });
    this.runUntil(() => own.epoch > epoch && !own.reloading && this.session.state === 'ready');
  }

  /** Run until every intent sent has been processed by the server and the client applied that batch. */
  waitAck(maxMs = 5000): void {
    this.runUntil(() => this.session.intents?.settled ?? false, maxMs, 1);
  }
}
