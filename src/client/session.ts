/**
 * One world as this page plays it (docs/NETCODE.md sections 3 to 10, 15: package 9): a NetClient
 * connected to the game server (client/server.ts: the page's own server Worker, through a
 * PortTransport), its ClientReplica, the own player predicted on it (OwnPlayer) and the player's
 * actions sent as intents (ClientIntents), plus everything that turns the replica into pictures:
 * the pristine columns built in the terrain workers (TerrainSource), section meshing, structure
 * meshes and poses, camera, environment, entities and overlays. The Game owns the screens, the
 * keyboard and the mouse, the server and the frame loop; it drives this class:
 *
 *  - update(now, dt, ...) first in every frame: the terrain columns that finished, NetClient.frame
 *    (every batch that arrived, then the samples, the clock, the light, the display poses), the
 *    client ticks that are due (OwnPlayer.frame, from the held input the Game wrote into `held`),
 *    the shown player and the camera, and the targets along the view ray (ClientIntents.update:
 *    the eye ray in first person, the camera ray in the third-person views);
 *  - the actions (pressUse, selectSlot, invClick, ...) after it: each becomes an intent;
 *  - work() (meshing within a budget) and present() (the backend's state for the frame).
 *
 * LOADING (section 3 item 4). The loading screen stays up until the NetClient is ready (Welcome,
 * the server's `ready`, the ready zone in the replica) and, on top, the sections of the middle 5x5
 * columns (those in the subscription circle) are meshed and every structure has been meshed once.
 * Only then are the OwnPlayer and the ClientIntents made: the player is predicted, takes input and
 * reports from then on (the server holds it still before). A correction farther than
 * RELOAD_DISTANCE (respawn, a far teleport) reloads: OwnPlayer.reloading, then the same wait for
 * the meshes around the new place. A new connection (a reconnection) brings a new replica: the
 * render state is rebuilt for it and loading starts over.
 *
 * Nothing here assumes the player is alone in the world: other players are entities of the
 * replica like any other, drawn at renderTick.
 */
import { CHUNK_SHIFT, SECTIONS_PER_CHUNK } from '../core/constants';
import { vec3, type Vec3 } from '../core/math';
import { headingOf } from '../entities/structs';
import type { Inventory } from '../entities/inventory';
import type { MeshResponse } from '../mesh/types';
import { ClientIntents, type ViewRay } from '../net/client/intents';
import { NetClient, type NetStatus } from '../net/client/netclient';
import { emptyHeldInput, OwnPlayer, type HeldInput, type OwnPlayerOptions } from '../net/client/predict';
import type { ClientReplica } from '../net/client/replica';
import type { HostCommand, InventoryArea, TickBatchMsg } from '../net/protocol';
import type { Channel, Transport } from '../net/transport';
import type { RenderBackend } from '../render/backend';
import { lookDir } from '../sim/rays';
import type { Message } from '../sim/view';
import { worldRulesFor } from '../sim/rules';
import { sectionKey } from '../voxel/chunk';
import type { GenErrorResponse, GenResponse } from '../worldgen/protocol';
import type { ViewMode } from './camera';
import { SectionMesher } from './meshing';
import { StructureRenderer } from './structures';
import { TerrainSource } from './terrain';
import { shownPlayer, ViewBuilder, type ShownPlayer } from './view';
import type { WorkerPool } from './workers';

/** Sections of the columns within this (square) radius of the player must be meshed before play starts. */
export const READY_MESH_RADIUS = 2;
/** The ready zone NetClient waits for (section 3: READY_CHUNK_RADIUS), counted for the progress bar. */
const READY_COLUMN_RADIUS = 3;
/** The own model flashes this long after a hit (the server's hurt time: HURT_TICKS). */
const HURT_FLASH_MS = 500;
/** Moving faster than this relative to its carrier widens the view while sprinting (blocks/s). */
const MOVING_SPEED = 1;

export interface SessionDeps {
  backend: RenderBackend;
  genPool: WorkerPool<GenResponse | GenErrorResponse> | null;
  meshPool: WorkerPool<MeshResponse> | null;
  now: () => number;
  onError: (what: string, err: unknown) => void;
  /** Open a transport to the server (LocalServer.connect): `ready` with it, or `failed`. */
  openTransport: (ready: (t: Transport) => void, failed: (reason: string) => void) => void;
  playerKey: string;
  name: string;
  /** Subscription radius (render distance + 1). */
  viewRadius: number;
  /** A toast the server addressed to this player (a refused action, a save notice ...). */
  onToast: (message: Message, kind: 'info' | 'warn' | 'error') => void;
  /** The connection's status changed (reconnecting, kicked, refused, failed ...). */
  onStatus: (status: NetStatus) => void;
  /** After each applied batch (the lobby's join and leave toasts read the player table changes). */
  onBatch?: (batch: TickBatchMsg) => void;
}

export interface LoadingProgress {
  done: boolean;
  /** 0..1 */
  progress: number;
  phase: 'connecting' | 'terrain' | 'meshing' | 'finishing';
  chunksLoaded: number;
  chunksNeeded: number;
  sectionsReady: number;
  sectionsNeeded: number;
}

export interface FrameOptions {
  fov: number;
  viewMode: ViewMode;
  /** Run the client ticks and choose targets (false while the world is paused). */
  step: boolean;
}

/** A Transport that counts the bytes it carries (the debug overlay's bytes per second). */
class CountingTransport implements Transport {
  onMessage: ((channel: Channel, bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  constructor(
    private readonly inner: Transport,
    private readonly traffic: { in: number; out: number },
  ) {
    inner.onMessage = (channel, bytes) => {
      traffic.in += bytes.length;
      this.onMessage?.(channel, bytes);
    };
    inner.onClose = (reason) => this.onClose?.(reason);
  }
  get open(): boolean {
    return this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    this.traffic.out += bytes.length;
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
}

export class WorldSession {
  state: 'loading' | 'ready' = 'loading';
  readonly net: NetClient;
  /** What the player holds (keys and look): the Game writes it every frame, OwnPlayer reads it at every client tick. */
  readonly held: HeldInput = emptyHeldInput();
  /** The player this page plays, as shown this frame. */
  readonly shown: ShownPlayer = shownPlayer();
  /** Bytes received and sent on every connection so far. */
  readonly traffic = { in: 0, out: 0 };
  /** The prediction and the intents of the current connection (null until its loading finished). */
  own: OwnPlayer | null = null;
  intents: ClientIntents | null = null;
  /** The render state of the current replica (rebuilt when a new connection brings a new one). */
  mesher: SectionMesher | null = null;
  structures: StructureRenderer;
  view = new ViewBuilder();
  /** The pristine-column source of the current connection. */
  terrain: TerrainSource | null = null;

  private replicaValue: ClientReplica | null = null;
  private hurtUntil = -Infinity;
  /** A mode the player asked for that the server has not acknowledged yet (shown meanwhile). */
  private modeRequest: { mode: 'creative' | 'survival'; seq: number } | null = null;
  /** A subscription radius set before the intents existed (sent once they do). */
  private pendingRadius: number | null = null;
  /** Seq of the last Respawn sent: the player counts as alive until the server answered it. */
  private respawnSeq = 0;
  /**
   * The prediction's options, kept by reference (OwnPlayer reads them at every client tick): the
   * ready zone of a reload follows the subscription radius.
   */
  private readonly ownOpts: OwnPlayerOptions;
  /**
   * A correction since the last frame needed a reload (OwnPlayer: farther than RELOAD_DISTANCE).
   * Kept apart from OwnPlayer.reloading, which can end in the very client tick that adopted the
   * correction when the new place's columns arrived first (the server subscribes them in the same
   * batch): the meshes around the new place are still to be waited for.
   */
  private reloadSeen = false;
  private disposed = false;
  private readonly ray = { eye: vec3(), origin: vec3(), dir: vec3() };
  private readonly tmp: Vec3 = vec3();

  constructor(private readonly deps: SessionDeps) {
    this.ownOpts = {
      viewRadius: deps.viewRadius,
      onCorrection: (c) => {
        if (c.display === 'reload') this.reloadSeen = true;
      },
    };
    this.structures = new StructureRenderer(deps.backend, deps.meshPool, deps.onError);
    this.net = new NetClient({
      openTransport: (ready, failed) => deps.openTransport((t) => ready(new CountingTransport(t, this.traffic)), failed),
      now: deps.now,
      chunkSource: (spec) => {
        this.terrain?.dispose();
        this.terrain = new TerrainSource(spec, deps.genPool, deps.now, deps.onError);
        return this.terrain;
      },
      playerKey: deps.playerKey,
      name: deps.name,
      viewRadius: deps.viewRadius,
    });
    this.net.onStatus = (s) => {
      if (!this.disposed) deps.onStatus(s);
    };
    this.net.onBatch = (b, replica) => this.onBatch(b, replica);
  }

  /** Connect (Hello). */
  start(): void {
    this.net.start();
  }

  /** The replica the render state belongs to (null before the first Welcome). */
  get replica(): ClientReplica | null {
    return this.replicaValue;
  }

  // ------------------------------------------------------------------ per frame

  /**
   * First thing in a frame (see the file comment): returns false while there is nothing to show
   * yet (no replica: connecting or reconnecting).
   */
  update(now: number, dt: number, budgetMs: number, opts: FrameOptions): boolean {
    if (this.disposed) return false;
    try {
      this.terrain?.pump(now, budgetMs * 0.5);
    } catch (e) {
      this.deps.onError('terrain', e);
    }
    this.net.frame(now);
    const r = this.net.replica;
    if (r !== this.replicaValue) this.adopt(r);
    if (r === null) return false;
    const clock = this.net.clock!;
    const own = this.own;
    if (own !== null && opts.step && !this.net.paused) {
      try {
        own.frame(now, clock);
      } catch (e) {
        this.deps.onError('prediction', e);
      }
    }
    this.updateShown(r, now);
    try {
      this.view.updateCamera(r, this.shown, opts.fov, dt, opts.viewMode);
    } catch (e) {
      this.deps.onError('camera', e);
    }
    const it = this.intents;
    if (own !== null && it !== null && opts.step && !this.net.paused) {
      try {
        it.update(this.viewRay(opts.viewMode), own.tick, own.lastSeq);
      } catch (e) {
        this.deps.onError('targets', e);
      }
    }
    this.updateState(r);
    return true;
  }

  /** Meshing for one frame within `budgetMs` (from `frameStart`); `facing` = mesh in the view direction first. */
  work(frameStart: number, budgetMs: number, facing: boolean): void {
    const m = this.mesher;
    if (m === null) return;
    try {
      const cam = this.view.camera;
      const yaw = this.shown.yaw;
      m.update(frameStart, budgetMs, cam.x, cam.y, cam.z, facing ? -Math.sin(yaw) : 0, facing ? -Math.cos(yaw) : 0);
    } catch (e) {
      this.deps.onError('meshing', e);
    }
  }

  /**
   * Push this frame's state to the backend: structures, camera, environment, entities and
   * overlays. Each part is isolated so one failure cannot blank the others.
   */
  present(dt: number, renderDistance: number, envTime: number, nowMs: number): void {
    const r = this.replicaValue;
    if (r === null || this.disposed) return;
    const b = this.deps.backend;
    const v = this.view;
    try {
      this.structures.update(r, dt);
    } catch (e) {
      this.deps.onError('structures', e);
    }
    try {
      b.setCamera(v.camera);
    } catch (e) {
      this.deps.onError('camera', e);
    }
    try {
      b.setEnvironment(v.updateEnvironment(r, envTime, renderDistance));
    } catch (e) {
      this.deps.onError('environment', e);
    }
    try {
      const clock = this.net.clock;
      const renderTick = clock?.renderTick ?? -Infinity;
      b.setEntities(clock !== null && Number.isFinite(renderTick) ? v.updateEntities(r, this.shown, renderTick, clock.rotorTick) : []);
    } catch (e) {
      this.deps.onError('entities', e);
    }
    try {
      b.setOverlays(v.updateOverlays(r, this.shown, this.intents?.useTarget ?? null, nowMs));
    } catch (e) {
      this.deps.onError('overlays', e);
    }
  }

  /** How far the area around the player is from being playable (see LOADING). */
  loadingProgress(): LoadingProgress {
    const r = this.replicaValue;
    const center = r === null ? null : this.center(r);
    if (r === null || center === null || this.mesher === null) {
      return { done: false, progress: 0, phase: 'connecting', chunksLoaded: 0, chunksNeeded: 0, sectionsReady: 0, sectionsNeeded: 0 };
    }
    const pcx = Math.floor(center.x) >> CHUNK_SHIFT;
    const pcz = Math.floor(center.z) >> CHUNK_SHIFT;
    const vr = this.net.viewRadius;
    const lim = vr * vr + vr;
    const inCircle = (dx: number, dz: number): boolean => dx * dx + dz * dz <= lim;
    let loaded = 0;
    let needed = 0;
    for (let dz = -READY_COLUMN_RADIUS; dz <= READY_COLUMN_RADIUS; dz++) {
      for (let dx = -READY_COLUMN_RADIUS; dx <= READY_COLUMN_RADIUS; dx++) {
        if (!inCircle(dx, dz)) continue;
        needed++;
        if (r.chunks.present(pcx + dx, pcz + dz)) loaded++;
      }
    }
    let ready = 0;
    let sections = 0;
    const m = this.mesher;
    for (let dz = -READY_MESH_RADIUS; dz <= READY_MESH_RADIUS; dz++) {
      for (let dx = -READY_MESH_RADIUS; dx <= READY_MESH_RADIUS; dx++) {
        // A section is meshed once its column and the 8 around it are in the replica: only those
        // the subscription circle covers can ever be.
        if (!inCircle(dx, dz) || !neighboursInCircle(dx, dz, lim)) continue;
        for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
          sections++;
          if (m.isSettled(sectionKey(pcx + dx, sy, pcz + dz))) ready++;
        }
      }
    }
    const zoneReady = this.own !== null ? !this.own.reloading : this.net.status === 'ready';
    const structuresReady = this.structures.allMeshed(r);
    const done = zoneReady && loaded === needed && ready === sections && structuresReady;
    const progress = Math.min(1, 0.45 * (needed === 0 ? 1 : loaded / needed) + 0.55 * (sections === 0 ? 1 : ready / sections));
    const phase = !zoneReady || loaded < needed ? 'terrain' : ready < sections ? 'meshing' : 'finishing';
    return { done, progress: done ? 1 : Math.min(progress, 0.99), phase, chunksLoaded: loaded, chunksNeeded: needed, sectionsReady: ready, sectionsNeeded: sections };
  }

  // ------------------------------------------------------------------ the player's actions (intents)

  /** Right button down (with the sneak key). */
  pressUse(sneak: boolean): void {
    const own = this.own;
    if (own !== null) this.intents?.pressUse(sneak, own.lastSeq);
  }
  releaseUse(): void {
    if (this.intents?.useHeld) this.intents.releaseUse();
  }
  /** Left button down. */
  pressAttack(): void {
    const own = this.own;
    if (own !== null) this.intents?.pressAttack(own.lastSeq);
  }
  releaseAttack(): void {
    if (this.intents?.attackHeld) this.intents.releaseAttack();
  }
  /** The buttons as the server last heard of them (a press sent, its release not yet). */
  get useHeld(): boolean {
    return this.intents?.useHeld ?? false;
  }
  get attackHeld(): boolean {
    return this.intents?.attackHeld ?? false;
  }
  swapHands(): void {
    this.intents?.swapHands();
  }
  selectSlot(slot: number): void {
    this.intents?.selectSlot(slot);
  }
  /** Middle click; false (nothing sent) without a target. */
  pickBlock(): boolean {
    const own = this.own;
    return own !== null && this.intents !== null && this.intents.pickBlock(own.lastSeq);
  }
  invClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    this.intents?.invClick(area, index, button, shift);
  }
  creativePick(item: number, shift: boolean): void {
    if (this.mode === 'creative') this.intents?.creativePick(item, shift);
  }
  dropCursor(): void {
    this.intents?.dropCursor();
  }
  closeInventory(): void {
    this.intents?.closeInventory();
  }
  releaseHelm(): void {
    this.intents?.releaseHelm();
  }
  respawn(): void {
    const it = this.intents;
    if (it === null) return;
    it.respawn();
    this.respawnSeq = it.seq;
  }
  /** The subscription radius (and the next Hello's, and a reload's ready zone). */
  setViewRadius(radius: number): void {
    this.net.viewRadius = radius;
    this.ownOpts.viewRadius = radius;
    if (this.intents !== null) this.intents.setViewRadius(radius);
    else this.pendingRadius = radius;
  }
  /** A host command (this page's connection is the host's); false when it could not be sent yet. */
  hostCommand(command: HostCommand): boolean {
    if (this.intents === null) return false;
    this.intents.hostCommand(command);
    return true;
  }
  /**
   * The pause menu's mode switch (section 10): this player's mode, and with `withRules` the
   * world's rules too (single play; online the host sets them on the room screen, DESIGN
   * 联机时由房主另外设置). The new mode shows at once and until the server answered.
   */
  requestMode(mode: 'creative' | 'survival', withRules: boolean): void {
    const it = this.intents;
    if (it === null) return;
    it.hostCommand({ kind: 'setPlayerMode', entityId: 0, mode });
    if (withRules) it.hostCommand({ kind: 'setRules', rules: worldRulesFor(mode) });
    this.modeRequest = { mode, seq: it.seq };
  }

  // ------------------------------------------------------------------ what the HUD shows

  /** The player's mode as shown: one asked for and not acknowledged yet, else the server's. */
  get mode(): 'creative' | 'survival' {
    const r = this.replicaValue;
    const req = this.modeRequest;
    if (req !== null) {
      if ((this.intents?.inventory.ack ?? 0) < req.seq) return req.mode;
      this.modeRequest = null;
    }
    if (r === null) return 'creative';
    return r.ownState.vitals?.mode ?? r.state.rules.defaultMode;
  }

  /** The inventory as shown (the server's with the unacknowledged actions replayed). */
  get inventory(): Inventory | null {
    return this.intents?.shownInventory ?? null;
  }

  /** The selected hotbar slot as shown. */
  get selected(): number {
    return this.intents?.selected ?? 0;
  }

  /** Dead as the server says, except while a respawn is on its way (the death screen does not come back meanwhile). */
  get dead(): boolean {
    if ((this.intents?.inventory.ack ?? 0) < this.respawnSeq) return false;
    return this.replicaValue?.ownState.vitals?.dead ?? false;
  }

  /** The helm readings while the player steers (section 7: derived from the replica), else null. */
  helm(): { throttle: number; rudder: number; speed: number; sails: number } | null {
    const own = this.own;
    const r = this.replicaValue;
    if (own === null || r === null || own.player.steeringShipId === 0) return null;
    return r.helm(own.player.steeringShipId);
  }

  // ------------------------------------------------------------------ connection

  heartbeat(now: number): void {
    if (!this.disposed) this.net.heartbeat(now);
  }

  setHidden(hidden: boolean): void {
    this.net.setHidden(hidden);
  }

  /** Single-player pause (section 4): the client holds before the server pauses, and resumes after it. */
  setPaused(paused: boolean): void {
    this.net.setPaused(paused);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.net.onBatch = null;
    this.net.onStatus = null;
    if (this.net.status !== 'idle') this.net.leave();
    this.terrain?.dispose();
    this.dropRenderState();
    try {
      this.deps.backend.setEntities([]);
      this.deps.backend.setOverlays({ target: null, breakProgress: 0, preview: [], conflicts: [], glue: [] });
    } catch {
      // the backend may already be gone
    }
  }

  // ------------------------------------------------------------------ internals

  private onBatch(b: TickBatchMsg, replica: ClientReplica): void {
    if (this.disposed) return;
    if (this.own !== null && this.own.replica === replica) this.own.onBatch(b);
    if (this.intents !== null && this.intents.replica === replica) this.intents.onBatch();
    if (replica === this.replicaValue && this.mesher !== null) for (const c of b.unsubscribe) this.mesher.dropChunk(c.cx, c.cz);
    for (const ev of b.private?.events ?? []) {
      if (ev.type === 'toast') this.deps.onToast(ev.message, ev.kind);
      else if (ev.type === 'playerHurt') this.hurtUntil = this.deps.now() + HURT_FLASH_MS;
    }
    this.deps.onBatch?.(b);
  }

  /** A new replica (a new connection), or none: the render state starts over. */
  private adopt(r: ClientReplica | null): void {
    this.dropRenderState();
    this.replicaValue = r;
    this.own = null;
    this.intents = null;
    this.state = 'loading';
    this.structures = new StructureRenderer(this.deps.backend, this.deps.meshPool, this.deps.onError);
    this.view = new ViewBuilder();
    if (r !== null) this.mesher = new SectionMesher(r.world, this.deps.backend, this.deps.meshPool, this.deps.now, this.deps.onError);
  }

  private dropRenderState(): void {
    this.mesher?.dispose();
    this.mesher = null;
    this.structures.dispose();
  }

  /** Loading -> ready (the prediction and the intents start) and back (a far correction reloads). */
  private updateState(r: ClientReplica): void {
    if (this.state === 'loading') {
      if (!this.loadingProgress().done) return;
      this.state = 'ready';
      if (this.own === null) {
        this.own = new OwnPlayer(r, this.held, (rep) => this.net.sendMoveReport(rep), this.ownOpts);
        this.intents = new ClientIntents(r, (m) => this.net.send(m));
        if (this.pendingRadius !== null) {
          this.intents.setViewRadius(this.pendingRadius);
          this.pendingRadius = null;
        }
      }
    } else if (this.own?.reloading || this.reloadSeen) {
      this.state = 'loading';
    }
    this.reloadSeen = false;
  }

  /** Where the loading waits around: the predicted player, else the server's correction (world, at the display poses). */
  private center(r: ClientReplica): Vec3 | null {
    if (this.own !== null) return this.own.player.pos;
    const corr = r.ownState.correction;
    const clock = this.net.clock;
    if (corr === null || clock === null) return null;
    const t = r.ownState.correctionTick;
    return r.toWorldAt(corr.carrierId, corr.pos, t, t, this.tmp) ? this.tmp : null;
  }

  /** The shown player for this frame (view.ts ShownPlayer). */
  private updateShown(r: ClientReplica, now: number): void {
    const s = this.shown;
    s.id = r.ownEntityId;
    s.hurt = now < this.hurtUntil;
    s.inventory = this.inventory;
    s.dead = this.dead;
    const own = this.own;
    if (own !== null) {
      const p = own.player;
      own.displayPos(now, s.feet);
      s.eyeHeight = p.eyeHeight;
      s.yaw = this.held.yaw + this.carrierTurn(r, own);
      s.pitch = this.held.pitch;
      s.sprinting = p.sprinting;
      s.moving = Math.hypot(p.vel.x - p.carrierVel.x, p.vel.z - p.carrierVel.z) > MOVING_SPEED;
      s.carrierId = p.carrierId;
      s.sneaking = p.sneaking;
      s.flying = p.flying;
      s.steeringShipId = p.steeringShipId;
      return;
    }
    // Loading: where the server's correction has the player, looking where it says.
    const corr = r.ownState.correction;
    const clock = this.net.clock;
    if (corr === null || clock === null) return;
    if (!r.toWorldAt(corr.carrierId, corr.pos, clock.renderTick, clock.rotorTick, s.feet)) return;
    const heading = corr.carrierId === 0 ? 0 : this.view.displayHeading(r, corr.carrierId);
    s.yaw = corr.yaw + (Number.isFinite(heading) ? heading : 0);
    s.pitch = corr.pitch;
    s.sprinting = false;
    s.moving = false;
    s.carrierId = corr.carrierId;
    s.sneaking = false;
    s.flying = corr.flying;
    s.steeringShipId = corr.seatShipId;
  }

  /**
   * How far the player's carrier turned between the last client tick (the pose its look was
   * turned with: OwnPlayer turns the held look by its carrier's turn at every tick) and the
   * frame's display pose: the look turns smoothly with the deck instead of in tick steps.
   */
  private carrierTurn(r: ClientReplica, own: OwnPlayer): number {
    const id = own.player.carrierId;
    if (id === 0) return 0;
    const rec = own.body.record(id);
    const shown = this.view.displayHeading(r, id);
    if (rec === undefined || !Number.isFinite(shown)) return 0;
    const d = shown - headingOf(rec.q1);
    return d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
  }

  /** The ray the targets are chosen along: the eyes as shown; from the camera in the third-person views (section 10). */
  private viewRay(mode: ViewMode): ViewRay {
    const ray = this.ray;
    const s = this.shown;
    ray.eye.x = s.feet.x;
    ray.eye.y = s.feet.y + s.eyeHeight;
    ray.eye.z = s.feet.z;
    if (mode === 'first') {
      ray.origin.x = ray.eye.x;
      ray.origin.y = ray.eye.y;
      ray.origin.z = ray.eye.z;
      lookDir(s.yaw, s.pitch, ray.dir);
    } else {
      const cam = this.view.camera;
      ray.origin.x = cam.x;
      ray.origin.y = cam.y;
      ray.origin.z = cam.z;
      lookDir(cam.yaw, cam.pitch, ray.dir);
    }
    return ray;
  }
}

/** All 8 columns around (dx, dz) lie in the circle dx² + dz² <= lim. */
function neighboursInCircle(dx: number, dz: number, lim: number): boolean {
  for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) if ((dx + ex) * (dx + ex) + (dz + ez) * (dz + ez) > lim) return false;
  return true;
}
