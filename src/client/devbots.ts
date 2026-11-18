/**
 * Dev tooling, not part of the game (package 12): scripted extra players in the page's OWN server,
 * so the other players can be seen without a second browser. Loaded on first use through
 * window.__blocklands.game.debug.bots() (its own chunk: the game's main chunk never carries it).
 *
 * A bot is a real network client in this page, exactly what a guest's page runs (NETCODE section
 * 15): a NetClient on a PortTransport to the server Worker (a `connect` with local false, after the
 * room was opened), its ClientReplica, an OwnPlayer predicting it and reporting its moves, and
 * ClientIntents for its clicks. Its pristine columns are generated on the main thread (a small
 * subscription radius keeps that cheap). It runs on its own timer, outside the game's frame, so the
 * game's frame time does not include the bots' clients.
 *
 * Scripts (all through the held input and intents a real player would produce; the server checks
 * them like any other client's): fly to a point and land (creative), walk a path of points, look,
 * sneak / sprint, choose a hotbar slot, right-click a cell (the helm of the example boat), hold the
 * wheel's keys. The page's own player is never touched.
 */
import { MAX_VIEW_RADIUS, type GeneratorSpec } from '../net/protocol';
import type { PageToHost } from '../net/host/control';
import { PortTransport } from '../net/host/port';
import { ClientIntents, type ViewRay } from '../net/client/intents';
import { NetClient } from '../net/client/netclient';
import { emptyHeldInput, OwnPlayer, type HeldInput } from '../net/client/predict';
import type { ClientReplica } from '../net/client/replica';
import type { ChunkSource } from '../net/client/chunks';
import { lookDir } from '../sim/rays';
import { generatorFromSpec } from '../worldgen/generator';
import { vec3, type Vec3 } from '../core/math';
import { B } from '../blocks/defs';

/** What the bots need of the page's server (client/server.ts LocalServer). */
export interface BotServer {
  post(msg: PageToHost<MessagePort>, transfer?: Transferable[]): void;
}

export interface BotTimers {
  now(): number;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  setTimeout(fn: () => void, ms: number): number;
}

/** A bot's state for scripts. */
export interface BotState {
  name: string;
  status: string;
  entityId: number;
  x: number;
  y: number;
  z: number;
  carrierId: number;
  steeringShipId: number;
  flying: boolean;
  onGround: boolean;
  selected: number;
  heldItem: number;
}

type Task =
  | { kind: 'idle' }
  | { kind: 'goto'; to: Vec3; cruiseY: number; phase: 'rise' | 'cruise' | 'land'; done: (ok: boolean) => void; ticks: number; best: number; stall: number }
  | { kind: 'walk'; path: Vec3[]; next: number; loop: boolean; speed: number };

const FRAME_MS = 16;
const HEARTBEAT_MS = 1000;
/** A bot's subscription radius (its columns are generated on the main thread). */
const BOT_VIEW_RADIUS = 2;

function wrap(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

class Bot {
  readonly net: NetClient;
  readonly input: HeldInput = emptyHeldInput();
  own: OwnPlayer | null = null;
  intents: ClientIntents | null = null;
  private task: Task = { kind: 'idle' };
  private use: { cell: Vec3; gridId: number; face: number; frames: number; done: (ok: boolean) => void } | null = null;
  private readonly timer: number;
  private lastBeat = 0;
  private readonly ray: ViewRay = { eye: vec3(), origin: vec3(), dir: vec3() };

  constructor(
    readonly name: string,
    key: string,
    open: () => PortTransport,
    private readonly t: BotTimers,
  ) {
    this.net = new NetClient({
      openTransport: (ready) => ready(open()),
      now: () => t.now(),
      chunkSource: (spec) => this.source(spec),
      playerKey: key,
      name,
      viewRadius: Math.min(MAX_VIEW_RADIUS, BOT_VIEW_RADIUS),
    });
    this.net.onBatch = (b, replica) => {
      if (this.own !== null && this.own.replica === replica) this.own.onBatch(b);
      if (this.intents !== null && this.intents.replica === replica) this.intents.onBatch();
    };
    this.net.start();
    this.timer = t.setInterval(() => this.frame(), FRAME_MS);
  }

  /** Pristine columns from the generator, one per timer turn (the main thread stays responsive). */
  private source(spec: GeneratorSpec): ChunkSource {
    const gen = generatorFromSpec(spec);
    return { generate: (cx, cz, done) => void this.t.setTimeout(() => done(gen.generate(cx, cz)), 0) };
  }

  get ready(): boolean {
    return this.own !== null && this.intents !== null;
  }

  private frame(): void {
    const now = this.t.now();
    if (now - this.lastBeat >= HEARTBEAT_MS) {
      this.lastBeat = now;
      this.net.heartbeat(now);
    }
    this.net.frame(now);
    const r = this.net.replica;
    const clock = this.net.clock;
    if (this.own !== null && this.own.replica !== r) this.own = null;
    if (this.intents !== null && this.intents.replica !== r) this.intents = null;
    if (this.net.status !== 'ready' || r === null || clock === null) return;
    this.own ??= new OwnPlayer(r, this.input, (rep) => this.net.sendMoveReport(rep), { viewRadius: this.net.viewRadius, beforeStep: () => this.step() });
    this.own.frame(now, clock);
    this.intents ??= new ClientIntents(r, (m) => this.net.send(m));
    if (this.use !== null) this.aimForUse(r);
    this.intents.update(this.view(), this.own.tick, this.own.lastSeq);
    if (this.use !== null) this.tryUse();
  }

  private view(): ViewRay {
    const own = this.own!;
    const ray = this.ray;
    ray.eye.x = own.player.pos.x;
    ray.eye.y = own.player.pos.y + own.player.eyeHeight;
    ray.eye.z = own.player.pos.z;
    ray.origin.x = ray.eye.x;
    ray.origin.y = ray.eye.y;
    ray.origin.z = ray.eye.z;
    lookDir(this.input.yaw, this.input.pitch, ray.dir);
    return ray;
  }

  /** Point the held look at a world point from the eyes. */
  lookAt(x: number, y: number, z: number): void {
    const own = this.own;
    if (own === null) return;
    const dx = x - own.player.pos.x;
    const dy = y - (own.player.pos.y + own.player.eyeHeight);
    const dz = z - own.player.pos.z;
    const h = Math.hypot(dx, dz);
    if (h > 1e-9) this.input.yaw = Math.atan2(-dx, -dz);
    this.input.pitch = Math.atan2(dy, h);
  }

  /** The script's input for one client tick (OwnPlayer beforeStep). */
  private step(): void {
    const own = this.own;
    const task = this.task;
    if (own === null || task.kind === 'idle') return;
    const p = own.player;
    if (task.kind === 'walk') {
      const target = task.path[task.next]!;
      const dx = target.x - p.pos.x;
      const dz = target.z - p.pos.z;
      if (Math.hypot(dx, dz) < 0.4) {
        task.next++;
        if (task.next >= task.path.length) {
          if (!task.loop) {
            this.stop();
            return;
          }
          task.next = 0;
        }
        return;
      }
      this.input.yaw = Math.atan2(-dx, -dz);
      this.input.pitch = 0;
      this.input.forward = task.speed;
      return;
    }
    // goto: take off, rise above the higher end, cruise, land on the point.
    task.ticks++;
    const to = task.to;
    const dx = to.x - p.pos.x;
    const dz = to.z - p.pos.z;
    const h = Math.hypot(dx, dz);
    this.input.jump = false;
    this.input.sneak = false;
    this.input.forward = 0;
    if (task.ticks > 1200) {
      this.stop();
      task.done(false);
      return;
    }
    if (task.phase !== 'land' && !p.flying) {
      this.input.jumpPresses += 2;
      return;
    }
    if (task.phase === 'rise') {
      if (p.pos.y < task.cruiseY - 0.5 && h > 1) this.input.jump = true;
      else task.phase = 'cruise';
      return;
    }
    if (task.phase === 'cruise') {
      // No progress for a second and a half: something is in the way; fly higher (far) or land here (near).
      const d = h + Math.abs(p.pos.y - (to.y + 0.6));
      if (d < task.best - 0.05) {
        task.best = d;
        task.stall = 0;
      } else if (++task.stall > 30) {
        task.stall = 0;
        task.best = d;
        if (h > 2) task.cruiseY += 3;
        else {
          task.phase = 'land';
          this.input.jumpPresses += 2;
          return;
        }
      }
      if (h > 0.25) {
        this.input.yaw = Math.atan2(-dx, -dz);
        this.input.forward = Math.min(1, h / 3);
      }
      // Far from the point: at the cruising height (over trees and hills); near it: down to it.
      const want = h > 2 ? task.cruiseY : to.y + 0.6;
      if (p.pos.y > want + 0.5) this.input.sneak = true;
      else if (p.pos.y < want - 0.3) this.input.jump = true;
      if (h < 0.25 && Math.abs(p.pos.y - (to.y + 0.6)) < 0.8) {
        task.phase = 'land';
        this.input.jumpPresses += 2; // flight off: drop onto the point
      }
      return;
    }
    // land
    if (p.flying) {
      this.input.jumpPresses += 2;
      return;
    }
    if (p.onGround || p.carrierId !== 0) {
      this.stop();
      task.done(true);
    }
  }

  stop(): void {
    this.task = { kind: 'idle' };
    this.input.forward = 0;
    this.input.strafe = 0;
    this.input.jump = false;
  }

  goto(x: number, y: number, z: number): Promise<boolean> {
    this.stop();
    return new Promise((done) => {
      const from = this.own?.player.pos ?? vec3(x, y, z);
      this.task = { kind: 'goto', to: vec3(x, y, z), cruiseY: this.cruiseHeight(from, x, y, z), phase: 'rise', done, ticks: 0, best: Infinity, stall: 0 };
    });
  }

  /** A height to fly over everything between `from` and (x, z): 2 above the highest block near the straight line (water does not count). */
  private cruiseHeight(from: Vec3, x: number, y: number, z: number): number {
    const world = this.net.replica?.world;
    let top = Math.max(y, from.y);
    if (world === undefined) return top + 4;
    const n = Math.ceil(Math.hypot(x - from.x, z - from.z) * 2) + 1;
    for (let i = 0; i <= n; i++) {
      const px = from.x + ((x - from.x) * i) / n;
      const pz = from.z + ((z - from.z) * i) / n;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let cy = 127; cy > top; cy--) {
            const id = world.getCell(Math.floor(px) + dx, cy, Math.floor(pz) + dz) & 1023;
            if (id !== 0 && id !== B.WATER && id !== B.UNLOADED) {
              top = cy + 1;
              break;
            }
          }
        }
      }
    }
    return top + 2;
  }

  walk(path: Vec3[], loop: boolean, speed: number): void {
    this.stop();
    if (path.length > 0) this.task = { kind: 'walk', path: path.map((p) => vec3(p.x, p.y, p.z)), next: 0, loop, speed };
  }

  /** Right-click a cell of a grid (0 = the world; a ship's cells are local): resolves true once clicked on it. */
  useOn(x: number, y: number, z: number, gridId: number): Promise<boolean> {
    if (this.use !== null) this.use.done(false);
    return new Promise((done) => {
      this.use = { cell: vec3(x, y, z), gridId, face: -1, frames: 0, done };
    });
  }

  /** Aim at the cell (centre, then each face's centre in turn: a model block such as the helm is not a full cube). */
  private aimForUse(r: ClientReplica): void {
    const u = this.use!;
    const g = u.gridId === 0 ? r.world : r.state.structures.get(u.gridId)?.structure.grid;
    if (g === undefined) return;
    const D = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const off = u.face >= 0 ? D[u.face]! : [0, 0, 0];
    const w = g.toWorld(vec3(u.cell.x + 0.5 + off[0]! * 0.45, u.cell.y + 0.5 + off[1]! * 0.45, u.cell.z + 0.5 + off[2]! * 0.45), vec3());
    this.lookAt(w.x, w.y, w.z);
  }

  private tryUse(): void {
    const u = this.use!;
    const it = this.intents!;
    const t = it.useTarget;
    u.frames++;
    if (t !== null && t.gridId === u.gridId && t.x === u.cell.x && t.y === u.cell.y && t.z === u.cell.z) {
      it.pressUse(false, this.own!.lastSeq);
      it.releaseUse();
      this.use = null;
      u.done(true);
      return;
    }
    if (u.frames % 3 === 0) u.face = u.face >= 5 ? -1 : u.face + 1;
    if (u.frames > 240) {
      this.use = null;
      u.done(false);
    }
  }

  state(): BotState {
    const own = this.own;
    const p = own?.player;
    return {
      name: this.name,
      status: this.net.status,
      entityId: this.net.replica?.ownEntityId ?? 0,
      x: p?.pos.x ?? NaN,
      y: p?.pos.y ?? NaN,
      z: p?.pos.z ?? NaN,
      carrierId: p?.carrierId ?? 0,
      steeringShipId: p?.steeringShipId ?? 0,
      flying: p?.flying ?? false,
      onGround: p?.onGround ?? false,
      selected: this.intents?.selected ?? 0,
      heldItem: this.intents?.heldItem ?? 0,
    };
  }

  dispose(): void {
    this.t.clearInterval(this.timer);
    this.use?.done(false);
    this.use = null;
    if (this.net.status !== 'idle') this.net.leave();
  }
}

/** The bots of one server (one world). */
export class DevBots {
  private readonly bots = new Map<string, Bot>();
  private roomOpen = false;
  private count = 0;

  constructor(
    private readonly server: BotServer,
    private readonly timers: BotTimers,
  ) {}

  /**
   * Join a bot (opens the room first): resolves once it is in the world and predicting. A bot the
   * server refuses (a bad name, a full room) or that never gets ready is disposed and forgotten.
   */
  add(name = `Bot ${this.count + 1}`): Promise<BotState> {
    if (this.bots.has(name)) return Promise.reject(new Error(`a bot named ${name} exists`));
    if (!this.roomOpen) {
      this.server.post({ type: 'openRoom' });
      this.roomOpen = true;
    }
    this.count++;
    const key = `devbot-${this.count}-${Math.floor(this.timers.now()).toString(36)}`;
    const open = (): PortTransport => {
      const ch = new MessageChannel();
      this.server.post({ type: 'connect', port: ch.port2, local: false }, [ch.port2]);
      return new PortTransport(ch.port1);
    };
    const bot = new Bot(name, key, open, this.timers);
    this.bots.set(name, bot);
    return new Promise((resolve, reject) => {
      const t0 = this.timers.now();
      const fail = (why: string): void => {
        if (this.bots.get(name) === bot) this.remove(name);
        reject(new Error(`bot ${name}: ${why}`));
      };
      const poll = (): void => {
        if (bot.ready) resolve(bot.state());
        else if (bot.net.status === 'failed' || bot.net.status === 'kicked' || bot.net.status === 'refused') fail(bot.net.status);
        else if (this.timers.now() - t0 > 60_000) fail('not ready after 60 s');
        else this.timers.setTimeout(poll, 50);
      };
      poll();
    });
  }

  private get(name: string): Bot {
    const b = this.bots.get(name);
    if (b === undefined) throw new Error(`no bot named ${name}`);
    return b;
  }

  names(): string[] {
    return [...this.bots.keys()];
  }

  state(name: string): BotState {
    return this.get(name).state();
  }

  /** Fly to (x, y, z) (feet) and land there (creative worlds: the bot can fly). */
  goto(name: string, x: number, y: number, z: number): Promise<boolean> {
    return this.get(name).goto(x, y, z);
  }

  /** Walk through the points on the ground (forward = speed 0..1), around again when `loop`. */
  walk(name: string, path: Vec3[], loop = true, speed = 1): void {
    this.get(name).walk(path, loop, speed);
  }

  /** Stop the script and let go of every movement key. */
  stop(name: string): void {
    this.get(name).stop();
  }

  look(name: string, yaw: number, pitch: number): void {
    const b = this.get(name);
    b.input.yaw = yaw;
    b.input.pitch = pitch;
  }

  lookAt(name: string, x: number, y: number, z: number): void {
    this.get(name).lookAt(x, y, z);
  }

  /** Hold keys: sneak, sprint (with the walk), and the movement axes (the wheel's throttle and rudder at a helm). */
  keys(name: string, k: { sneak?: boolean; sprint?: boolean; forward?: number; strafe?: number }): void {
    const i = this.get(name).input;
    if (k.sneak !== undefined) i.sneak = k.sneak;
    if (k.sprint !== undefined) i.sprint = k.sprint;
    if (k.forward !== undefined) i.forward = k.forward;
    if (k.strafe !== undefined) i.strafe = k.strafe;
  }

  /** Choose a hotbar slot (0..8): its item goes into the bot's main hand. */
  select(name: string, slot: number): void {
    this.get(name).intents?.selectSlot(slot);
  }

  useOn(name: string, x: number, y: number, z: number, gridId = 0): Promise<boolean> {
    return this.get(name).useOn(x, y, z, gridId);
  }

  /** Let go of the wheel. */
  releaseHelm(name: string): void {
    this.get(name).intents?.releaseHelm();
  }

  remove(name: string): void {
    const b = this.bots.get(name);
    if (b === undefined) return;
    b.dispose();
    this.bots.delete(name);
  }

  dispose(): void {
    for (const b of this.bots.values()) b.dispose();
    this.bots.clear();
  }
}
