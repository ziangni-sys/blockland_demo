/**
 * Headless multiplayer tests in one process (docs/NETCODE.md section 15 "无头联机测试的组装"):
 * a LoopbackNet with its virtual clock, a real ServerHost on that clock (timers are events of the
 * net's queue, chunk generation is budgeted by a number of columns, storage is a MemoryStorage),
 * and real clients on loopback transports.
 *
 * CLIENTS. addClient() gives a HeadlessClient: a real NetClient with its ClientReplica, whose
 * openTransport dials a new loopback link to the host (every reconnection dials again), whose
 * clock is the net's, and whose ChunkSource is the generator Welcome's GeneratorSpec describes,
 * synchronous or answering after `genDelayMs` (an event on the net's queue, like a worker pool). The harness gives every
 * client frames (every 16.7 ms of virtual time, each client with its own phase) and a heartbeat
 * every second (a page's timer: it goes on while the page is hidden). From its ready on, a
 * HeadlessClient moves its own player with OwnPlayer (package 6) from its held input, and acts with
 * intents (package 7: ClientIntents, its targets chosen on the replica every frame), as a person at
 * the keys and the mouse would.
 * addRawClient() gives a RawClient for the tests that must misbehave in ways NetClient never does
 * (raw bytes, messages before Hello, silence, a connection that reports late); it only sends what
 * its test tells it to and keeps what it receives, decoded.
 *
 * LINKS. Every link counts the reliable messages each end sent and received, so quiesce() knows
 * when nothing is in flight. A client's `link` conditions are the objects the loopback reads at
 * every send: changing one changes the current link at once (and every link it dials later).
 * sever(c) makes the client's current link fail on both ends (ICE failure: both see onClose),
 * crash(c) closes it from the client end without a Bye and stops the client (a killed tab),
 * inject(c, ...) sends raw bytes to the client from the server end (a misbehaving server).
 *
 * DIGESTS. track(client) records, after every server tick, the server's digest over what the
 * Replicator gave that client (Replicator.clientView), narrowed to the columns that changed in
 * the tick or entered / left the client's set; right after the client has applied the batch of
 * that tick (NetClient.onBatch), its replica is compared over the same columns, without the ones
 * still generating there, and any difference is kept in client.mismatches. Poses (entity carriers
 * included: a moving entity changes carrier in a sample) are left out of these per-tick checks:
 * NetClient applies every batch of a frame before the samples of the frame (section 5), so at a
 * batch the latest poses may be a tick old or already a tick ahead. Every frame also checks that
 * renderTick is not past the newest applied batch (section 4), into client.mismatches too.
 * compareNow(client) compares everything, poses included (call it when the client has applied
 * the server's last tick, e.g. after quiesce()). With `history` on, the harness also keeps every
 * ship pose, rotor angle and entity position of the last HISTORY_TICKS ticks, for checks of what
 * a client shows at renderTick.
 *
 * LOCKSTEP (HarnessOptions.lockstep; scenario 30, tests/acceptance/world.ts). The server's own
 * clock never fires; step() is one tick for everybody: every client's frame (its prediction runs
 * one client tick and reports), delivery, one server tick, delivery, every client applies. The
 * clients' clocks are LockstepClocks (renderTick = the newest batch, rotorTick one ahead) and their
 * view rays start at the predicted body; run(), runUntil() and ticks() step.
 *
 * Everything except the transport, the timers and the chunk source is product code.
 */
import { expect } from 'vitest';
import { vec3, type Quat, type Vec3 } from '../../src/core/math';
import type { ReplicaState } from '../../src/net/client/apply';
import type { ChunkSource } from '../../src/net/client/chunks';
import { ServerClock } from '../../src/net/client/clock';
import { NetClient, type NetStatus } from '../../src/net/client/netclient';
import { emptyHeldInput, OwnPlayer, type AdoptedCorrection, type HeldInput } from '../../src/net/client/predict';
import { ClientIntents, type ViewRay } from '../../src/net/client/intents';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import { lookDir } from '../../src/sim/rays';
import type { Inventory } from '../../src/entities/inventory';
import type { ClientReplica } from '../../src/net/client/replica';
import { decodeServerMessage, encodeClientMessage } from '../../src/net/codec';
import type { CreateOptions, HostToPage } from '../../src/net/host/control';
import { defaultSinks, ServerHost, TICK_MS, type HostClock, type ServerSinks } from '../../src/net/host/host';
import { IntentQueue, type IntentStats } from '../../src/net/server/intents';
import { createLoopbackPair, LoopbackNet, type LinkConditions } from '../../src/net/loopback';
import {
  BUILD_ID,
  MESSAGE_CHANNEL,
  type ClientMessage,
  type HostCommand,
  type InventoryArea,
  type KickMsg,
  type Target,
  type NetCorrection,
  type NetMoveReport,
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
import { Rotor } from '../../src/structures/structure';
import { chunkKey, chunkKeyX, chunkKeyZ } from '../../src/voxel/chunk';
import { generatorFromSpec, type ChunkGenerator, type GeneratorSpec } from '../../src/worldgen/generator';
import { compareReplica, DigestContext, replicaDigest, serverDigest, type Digest } from './digest';

/** A lossless link without delay. */
export const INSTANT: LinkConditions = Object.freeze({ latencyMs: 0, jitterMs: 0, loss: 0, seed: 1 });

/** One direction of a link (a fresh object: tests may change it while the link runs). */
export function link(latencyMs: number, jitterMs = 0, loss = 0, seed = 1, extra: Partial<LinkConditions> = {}): LinkConditions {
  return { latencyMs, jitterMs, loss, seed, ...extra };
}

/** Client frames: 60 a second. */
export const FRAME_MS = 1000 / 60;

/** A page's heartbeat timer (NetClient.heartbeat), ms. */
export const HEARTBEAT_MS = 1000;

/** Ticks of server history kept (history option). */
export const HISTORY_TICKS = 2400;

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

// ====================================================================== chunk sources

/** The generator's columns, generated on the spot. */
export function syncSource(gen: ChunkGenerator): ChunkSource {
  return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
}

/** The generator's columns, at once or `delayMs` later on the net's clock (a worker pool). */
function generatorSource(gen: ChunkGenerator, net: LoopbackNet, delayMs: number, counts: { requests: number }): ChunkSource {
  return {
    generate: (cx, cz, done) => {
      counts.requests++;
      if (delayMs <= 0) done(gen.generate(cx, cz));
      else net.schedule(net.now + delayMs, () => done(gen.generate(cx, cz)));
    },
  };
}

// ====================================================================== lockstep

/**
 * The clock of a client stepped in lockstep with the server (NetHarness.step, docs/NETCODE.md
 * section 16, scenario 30): when the client has applied the batch of tick T, the server is at T
 * and the next report is applied at T + 1. So arrivalTick = T + 1 with D = 1: renderTick = T (the
 * newest applied batch), and rotorTick = T + 1 (rotorLead 0): client tick k runs right before
 * server tick k, with the ships where the server had them at k - 1 and the rotors where tick k
 * puts them. One step, one client tick, one report, one server tick.
 */
export class LockstepClock extends ServerClock {
  private newest = -1;
  override reset(): void {
    super.reset();
    this.newest = -1;
  }
  override frame(_now: number, newestApplied: number): void {
    this.newest = newestApplied;
  }
  override get D(): number {
    return 1;
  }
  override get rotorLead(): number {
    return 0;
  }
  override get renderTick(): number {
    return this.newest >= 0 ? this.newest : -Infinity;
  }
  override get rotorTick(): number {
    return this.newest + 1;
  }
}

// ====================================================================== the clients

/** How a HeadlessClient runs the harness while it waits for the server (NetHarness.runUntil). */
export interface ClientDriver {
  runUntil(cond: () => boolean, maxMs?: number, stepMs?: number): void;
}

/**
 * A real client (section 15): NetClient and its ClientReplica on a loopback link (see the file
 * comment). The harness calls frame() and heartbeat(); a test reads the replica and drives the
 * connection (leave, hidden) and the player.
 *
 * frame(now) applies what arrived (NetClient.frame), then, from the connection's ready on, runs
 * the prediction (package 6): an OwnPlayer per connection on the replica, moving the player from
 * the held `input` (forward, strafe, jump, sneak, sprint, look; jumpPresses for a double tap),
 * its reports through NetClient.sendMoveReport; corrections reach it through onBatch, which this
 * class owns (it calls onApplied for track()). Then the intents (package 7): a ClientIntents per
 * connection chooses the targets on the replica along the view ray (the eyes as shown and the held
 * look; `camera` gives a third-person camera), sends Aim when they change, and predicts the
 * inventory. `silent` stops the prediction, the reports and the aims (a page that froze),
 * stopInput() lets go of the keys and the buttons.
 *
 * SCRIPTED CONTROL, named like PlayerControl's: lookAt / lookAtCell / aimAt (the held look),
 * use / attack (a click: press and release), pressUse / releaseUse / pressAttack / releaseAttack
 * (held buttons), swapHands, selectSlot, hold / emptyHand (selecting, or the creative palette),
 * pickBlock, invClick, creativePick, dropCursor, closeInventory, releaseHelm, respawn,
 * setViewRadius, host commands (teleport, setMode, give, setDayTime, setRules); useOn and mine run
 * the harness until the server answered (the client applied the batch acknowledging the intent;
 * mine: until the client sees the block gone), as a person waits to see the result.
 */
export class HeadlessClient {
  readonly net: NetClient;
  /** Statuses in order (NetClient.onStatus). */
  readonly statuses: NetStatus[] = [];
  /** Ticks of the batches applied on the current connection, in order. */
  readonly applied: number[] = [];
  /** Tick of the replica when the current connection became ready, or null. */
  readyTick: number | null = null;
  /** Frames run (not counting those a hidden page skipped). */
  frames = 0;
  /** Pristine columns asked of the ChunkSource, over every connection. */
  readonly generation = { requests: 0 };
  /** Called after every frame. */
  onFrame: ((now: number) => void) | null = null;
  /** Set by track(): called right after the batch of `tick` is applied. */
  onApplied: ((tick: number) => void) | null = null;
  /** Called after every applied batch, after onApplied (the batch as decoded). */
  onBatch: ((batch: TickBatchMsg) => void) | null = null;
  /** Differences the per-tick checks found, and the number of ticks they compared. */
  readonly mismatches: string[] = [];
  checked = 0;
  /** Stopped by crash(): no frames, no heartbeats. */
  crashed = false;
  /** What the player holds (kept across connections; OwnPlayer turns the look with the carrier). */
  readonly input: HeldInput = emptyHeldInput();
  /** The prediction of the current connection (null before its ready). */
  own: OwnPlayer | null = null;
  /** No prediction and no reports while true (a page that froze, or a client that stopped reporting). */
  silent = false;
  /** Every correction applied, with its batch's tick, over every connection. */
  readonly corrections: Array<{ tick: number; c: NetCorrection }> = [];
  /** Every correction the prediction adopted, with how it was shown. */
  readonly adopted: AdoptedCorrection[] = [];
  /** Called at every client tick before the held input is read (scripted input per tick); `seq` = the tick's report. */
  onStep: ((seq: number) => void) | null = null;
  /** Called with every report as it is sent (the prediction's state is own.player). */
  onReport: ((r: NetMoveReport, own: OwnPlayer) => void) | null = null;
  /** The intents of the current connection (null before its ready). */
  intents: ClientIntents | null = null;
  /** A third-person camera: its position and direction for the eyes and the look (null = first person, the eye ray). */
  camera: ((eye: Vec3, dir: Vec3) => { origin: Vec3; dir: Vec3 }) | null = null;
  /**
   * Where the eyes of the view ray are: 'shown', the picture (OwnPlayer.displayPos, as a page has
   * it), or 'body', the predicted body as it is now (a lockstep client: between two steps that is
   * where the server has the player when it carries out the next tick's actions).
   */
  eyes: 'shown' | 'body' = 'shown';
  /** Every intent sent, over every connection. */
  readonly sentIntents: ClientMessage[] = [];
  /** Set by the harness: runs it while useOn, mine and the like wait for the server. */
  driver: ClientDriver | null = null;
  /** Called at every frame before the targets are chosen (a scripted aim kept on a cell). */
  private aimHold: (() => void) | null = null;
  private lastFrameAt = 0;

  constructor(
    readonly key: PlayerKey,
    makeNet: (c: HeadlessClient) => NetClient,
  ) {
    this.net = makeNet(this);
    this.net.onStatus = (s) => {
      this.statuses.push(s);
      if (s === 'joining') {
        this.applied.length = 0;
        this.readyTick = null;
      } else if (s === 'ready') this.readyTick = this.net.replica!.state.tick;
    };
    this.net.onBatch = (b) => {
      this.applied.push(b.tick);
      if (b.private?.correction !== undefined) this.corrections.push({ tick: b.tick, c: b.private.correction });
      if (this.own !== null && this.own.replica === this.net.replica) this.own.onBatch(b);
      if (this.intents !== null && this.intents.replica === this.net.replica) this.intents.onBatch();
      this.onApplied?.(b.tick);
      this.onBatch?.(b);
    };
  }

  get status(): NetStatus {
    return this.net.status;
  }
  get replica(): ClientReplica | null {
    return this.net.replica;
  }
  /** The replica's data (the digests read it). */
  get state(): ReplicaState | null {
    return this.net.replica?.state ?? null;
  }
  get welcome(): WelcomeMsg | null {
    return this.net.welcome;
  }
  get kick(): KickMsg | null {
    return this.net.kick;
  }
  get refusal(): RefuseMsg | null {
    return this.net.refusal;
  }
  get ready(): boolean {
    return this.net.status === 'ready';
  }
  /** The connection is over for good (refused, kicked, failed, left) or the client crashed. */
  get closed(): boolean {
    const s = this.net.status;
    return this.crashed || s === 'refused' || s === 'kicked' || s === 'failed' || s === 'closed';
  }

  /** A hidden page: no frames; NetClient applies batches as they arrive. */
  get hidden(): boolean {
    return this.net.hidden;
  }
  set hidden(v: boolean) {
    this.net.setHidden(v);
  }

  /** One rendered frame (a hidden page has none). */
  frame(now: number): void {
    if (this.crashed || this.net.hidden) return;
    this.net.frame(now);
    this.frames++;
    // Section 4: renderTick = min(arrivalTick - D, newest applied batch), at every frame.
    const clock = this.net.clock;
    const r = this.net.replica;
    if (clock !== null && r !== null && clock.renderTick > r.state.tick) {
      this.mismatches.push(`frame at ${now}: renderTick ${clock.renderTick} beyond the newest applied batch ${r.state.tick}`);
    }
    // The prediction (package 6) and the intents (package 7): from the connection's ready on, unless paused or silent.
    if (this.own !== null && this.own.replica !== r) this.own = null;
    if (this.intents !== null && this.intents.replica !== r) this.intents = null;
    this.lastFrameAt = now;
    if (this.net.status === 'ready' && r !== null && clock !== null && !this.net.paused && !this.silent) {
      this.own ??= new OwnPlayer(r, this.input, (rep) => this.report(rep), {
        viewRadius: this.net.viewRadius,
        beforeStep: (seq) => this.onStep?.(seq),
        onCorrection: (c) => this.adopted.push(c),
      });
      this.own.frame(now, clock);
      this.intents ??= new ClientIntents(r, (m) => {
        this.sentIntents.push(m);
        this.net.send(m);
      });
      this.aimHold?.();
      this.intents.update(this.view(), this.own.tick, this.own.lastSeq);
    }
    this.onFrame?.(now);
  }

  /**
   * Apply what arrived (NetClient.frame: batches, samples, the clock, the poses) without a client
   * tick or an Aim: the end of a lockstep step (NetHarness.step).
   */
  applyNow(now: number): void {
    if (this.crashed || this.net.hidden) return;
    this.net.frame(now);
  }

  /** The view ray now: the eyes (see `eyes`), the held look; from the camera when one is set. */
  view(): ViewRay {
    const own = this.requireOwn();
    const eye = this.eyes === 'body' ? vec3(own.player.pos.x, own.player.pos.y, own.player.pos.z) : own.displayPos(this.lastFrameAt);
    eye.y += own.player.eyeHeight;
    const dir = lookDir(this.input.yaw, this.input.pitch);
    if (this.camera === null) return { eye, origin: eye, dir };
    const cam = this.camera(eye, dir);
    return { eye, origin: cam.origin, dir: cam.dir };
  }

  private requireOwn(): OwnPlayer {
    if (this.own === null) throw new Error(`${this.key}: no prediction yet`);
    return this.own;
  }

  private requireIntents(): ClientIntents {
    if (this.intents === null) throw new Error(`${this.key}: no intents yet (not ready)`);
    return this.intents;
  }

  private runUntil(cond: () => boolean, maxMs = 30_000): void {
    if (this.driver === null) throw new Error(`${this.key}: no driver`);
    this.driver.runUntil(cond, maxMs, 1);
  }

  private report(r: NetMoveReport): void {
    this.onReport?.(r, this.own!);
    this.net.sendMoveReport(r);
  }

  /** Point the held look at a world point (from the eyes as shown). */
  lookAt(x: number, y: number, z: number): void {
    const e = this.view().eye;
    const dx = x - e.x;
    const dy = y - e.y;
    const dz = z - e.z;
    const h = Math.hypot(dx, dz);
    if (h > 1e-12) this.input.yaw = Math.atan2(-dx, -dz);
    this.input.pitch = Math.atan2(dy, h);
  }

  // ------------------------------------------------------------------ scripted control (package 7; see the class comment)

  /** The inventory as shown (the server's with the unacknowledged actions replayed). */
  get inventory(): Inventory {
    const inv = this.requireIntents().shownInventory;
    if (inv === null) throw new Error(`${this.key}: no inventory yet`);
    return inv;
  }

  /** The use target (what the outline shows) and the mining target, as of the last frame. */
  get target(): Target | null {
    return this.requireIntents().useTarget;
  }
  get mineTarget(): Target | null {
    return this.requireIntents().mineTarget;
  }

  /**
   * Point the held look at a cell of a grid of the replica (0 = the world), as shown: at the centre
   * of `face` when given (slightly inside it), else at the cell centre. False when the replica has no such grid.
   */
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    const r = this.replica;
    const g = r === null ? undefined : gridId === 0 ? r.world : r.state.structures.get(gridId)?.structure.grid;
    if (g === undefined) return false;
    const p = vec3(x + 0.5, y + 0.5, z + 0.5);
    if (face !== undefined) {
      p.x += DIR_X[face]! * 0.45;
      p.y += DIR_Y[face]! * 0.45;
      p.z += DIR_Z[face]! * 0.45;
    }
    g.toWorld(p, p);
    this.lookAt(p.x, p.y, p.z);
    return true;
  }

  /** lookAtCell, then the targets now: true when the use target (`mining`: the mining target) is exactly that cell (and face). */
  aimAt(x: number, y: number, z: number, face?: Dir, gridId = 0, mining = false): boolean {
    if (!this.lookAtCell(x, y, z, face, gridId)) return false;
    const own = this.requireOwn();
    const it = this.requireIntents();
    it.update(this.view(), own.tick, own.lastSeq);
    const t = mining ? it.mineTarget : it.useTarget;
    return t !== null && t.gridId === gridId && t.x === x && t.y === y && t.z === z && (face === undefined || t.face === face);
  }

  /** Keep aiming at a cell at every frame (a carrier may turn the player); null stops. */
  holdAim(cell: { x: number; y: number; z: number; face?: Dir; gridId?: number } | null): void {
    this.aimHold = cell === null ? null : () => void this.lookAtCell(cell.x, cell.y, cell.z, cell.face, cell.gridId ?? 0);
  }

  /** A right-click: press and release (sneak: the held sneak key unless given). */
  use(sneak = this.input.sneak): void {
    this.pressUse(sneak);
    this.releaseUse();
  }
  pressUse(sneak = this.input.sneak): void {
    this.requireIntents().pressUse(sneak, this.requireOwn().lastSeq);
  }
  releaseUse(): void {
    this.requireIntents().releaseUse();
  }
  /** A left-click: press and release. */
  attack(): void {
    this.pressAttack();
    this.releaseAttack();
  }
  pressAttack(): void {
    this.requireIntents().pressAttack(this.requireOwn().lastSeq);
  }
  releaseAttack(): void {
    this.requireIntents().releaseAttack();
  }
  swapHands(): void {
    this.requireIntents().swapHands();
  }
  selectSlot(slot: number): void {
    this.requireIntents().selectSlot(slot);
  }
  /** Pick block on the use target; false (nothing sent) without one. */
  pickBlock(): boolean {
    return this.requireIntents().pickBlock(this.requireOwn().lastSeq);
  }
  invClick(area: InventoryArea, index: number, button: 0 | 2 = 0, shift = false): void {
    this.requireIntents().invClick(area, index, button, shift);
  }
  creativePick(item: number, shift = false): void {
    this.requireIntents().creativePick(item, shift);
  }
  dropCursor(): void {
    this.requireIntents().dropCursor();
  }
  closeInventory(): void {
    this.requireIntents().closeInventory();
  }
  releaseHelm(): void {
    this.requireIntents().releaseHelm();
  }
  respawn(): void {
    this.requireIntents().respawn();
  }
  /** The subscription radius (and NetClient's, for the next Hello and the ready zone of a reload). */
  setViewRadius(r: number): void {
    this.requireIntents().setViewRadius(r);
    this.net.viewRadius = r;
  }
  hostCommand(c: HostCommand): void {
    this.requireIntents().hostCommand(c);
  }

  /** Hold `item`: select a hotbar slot that has it (as shown); in creative, take a stack from the palette first. Throws when it cannot. */
  hold(item: number): void {
    let slot = this.inventory.hotbar.findIndex((s) => s !== null && s.item === item && s.count > 0);
    if (slot < 0 && this.mode === 'creative') {
      this.creativePick(item, true);
      slot = this.inventory.hotbar.findIndex((s) => s !== null && s.item === item && s.count > 0);
    }
    if (slot < 0) throw new Error(`${this.key}: no ${item} in the hotbar`);
    if (slot !== this.inventory.selected) this.selectSlot(slot);
  }

  /** Hold nothing: select the first empty hotbar slot (as shown); with a full hotbar, shift-click the selected stack into the backpack. */
  emptyHand(): void {
    const slot = this.inventory.hotbar.findIndex((s) => s === null || s.count <= 0);
    if (slot < 0) {
      this.invClick('hotbar', this.inventory.selected, 0, true);
      if (this.inventory.selectedStack() !== null) throw new Error(`${this.key}: no room to empty the hand`);
      return;
    }
    if (slot !== this.inventory.selected) this.selectSlot(slot);
  }

  /** The player's mode as the server last said. */
  get mode(): 'creative' | 'survival' {
    const st = this.state!;
    return st.private.vitals?.mode ?? st.rules.defaultMode;
  }

  /** Run the harness until the client has applied the batch of the server's present tick (it sees what the server has now). */
  catchUp(tick: number, maxMs = 30_000): void {
    this.runUntil(() => (this.state?.tick ?? -1) >= tick, maxMs);
  }

  /** Run the harness until the server processed every intent sent and the client applied that batch. */
  waitAck(maxMs = 30_000): void {
    const it = this.requireIntents();
    this.runUntil(() => it.settled, maxMs);
  }

  /**
   * Run until the server has the look the player has now (a movement report sent after it was
   * accepted: moveAck). What a click does can depend on the look (a helm faces where the player
   * looks), and the look reaches the server with the movement reports, not with the click: a person
   * turns, then clicks. Nothing to wait for while the body is frozen (no reports).
   */
  waitLook(): void {
    const own = this.requireOwn();
    const seq = own.lastSeq + 1;
    const r = this.replica!;
    this.runUntil(() => this.own !== own || own.player.dead || (r.state.private.moveAck ?? 0) >= seq);
  }

  /**
   * Aim at a cell, let the server learn the look (waitLook), and right-click it; then wait for the
   * server's answer. False (nothing clicked) when the cell cannot be aimed at.
   */
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    if (!this.aimAt(x, y, z, face, gridId)) return false;
    this.waitLook();
    if (!this.aimAt(x, y, z, face, gridId)) return false;
    this.use();
    this.waitAck();
    return true;
  }

  /**
   * Aim at a cell and hold the left button (keeping the aim at every frame) until the client sees
   * the cell change, at most `maxMs`; then let go. False when it cannot be aimed at or did not break.
   */
  mine(x: number, y: number, z: number, face?: Dir, gridId = 0, maxMs = 30_000): boolean {
    if (!this.aimAt(x, y, z, face, gridId, true)) return false;
    const grid = (): VoxelGridLike | undefined => (gridId === 0 ? this.replica?.world : this.replica?.state.structures.get(gridId)?.structure.grid);
    const before = grid()?.getCell(x, y, z);
    this.holdAim({ x, y, z, face, gridId });
    this.pressAttack();
    try {
      this.runUntil(() => grid()?.getCell(x, y, z) !== before, maxMs);
      return true;
    } catch {
      return false;
    } finally {
      this.holdAim(null);
      if (this.intents?.attackHeld) this.releaseAttack();
    }
  }

  /** Host command (the host's connection only): teleport to a world point; waits until the client adopted the correction. */
  teleport(x: number, y: number, z: number): void {
    const own = this.requireOwn();
    const epoch = own.epoch;
    this.hostCommand({ kind: 'teleport', x, y, z });
    this.runUntil(() => this.own !== null && this.own.epoch > epoch && !this.own.reloading);
  }

  /** Host command: this player's mode; waits for the server's answer. */
  setMode(mode: 'creative' | 'survival'): void {
    this.hostCommand({ kind: 'setPlayerMode', entityId: 0, mode });
    this.waitAck();
  }

  /** Host command: items into this player's inventory; waits for the server's answer. */
  give(item: number, count: number): void {
    this.hostCommand({ kind: 'give', item, count });
    this.waitAck();
  }
  /** Causes of the corrections applied in batches after server tick `tick` that pass `pick`. */
  correctionsSince(tick: number, pick: (cause: string) => boolean = () => true): string[] {
    return this.corrections.filter((x) => x.tick > tick && pick(x.c.cause)).map((x) => x.c.cause);
  }

  /** The page's timer, about once a second, hidden or not. */
  heartbeat(now: number): void {
    if (!this.crashed) this.net.heartbeat(now);
  }

  /** Let go of the held keys and buttons (the look stays) and drop a kept aim (quiesce()). */
  stopInput(): void {
    const i = this.input;
    i.forward = 0;
    i.strafe = 0;
    i.jump = false;
    i.sneak = false;
    i.sprint = false;
    i.jumpPresses = 0;
    this.aimHold = null;
    const it = this.intents;
    if (it !== null && this.net.status === 'ready') {
      if (it.useHeld) it.releaseUse();
      if (it.attackHeld) it.releaseAttack();
    }
  }

  /** Quit properly: Bye, then close. */
  leave(): void {
    this.net.leave();
  }
}

/** A client that speaks the protocol through the codec and does only what its test says (see the file comment). */
export class RawClient {
  welcome: WelcomeMsg | null = null;
  refuse: RefuseMsg | null = null;
  kick: KickMsg | null = null;
  /** The reason the server end closed with (onClose), or null. */
  closeReason: string | null = null;
  readonly pongs: PongMsg[] = [];
  /** Every message, in arrival order. */
  readonly log: ServerMessage[] = [];
  private ended = false;

  constructor(
    readonly key: PlayerKey,
    readonly transport: Transport,
  ) {
    transport.onMessage = (channel, bytes) => {
      const msg = decodeServerMessage(bytes, channel);
      this.log.push(msg);
      if (msg.type === 'welcome') {
        expect(this.welcome, `${key}: a second Welcome`).toBeNull();
        this.welcome = msg;
      } else if (msg.type === 'refuse') this.refuse = msg;
      else if (msg.type === 'kick') this.kick = msg;
      else if (msg.type === 'pong') this.pongs.push(msg);
    };
    transport.onClose = (reason) => {
      this.closeReason = reason;
      this.ended = true;
    };
  }

  get closed(): boolean {
    return this.ended || !this.transport.open;
  }

  send(m: ClientMessage): void {
    this.transport.send(MESSAGE_CHANNEL[m.type], encodeClientMessage(m));
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
}

/** What mine() reads of a grid of the replica. */
interface VoxelGridLike {
  getCell(x: number, y: number, z: number): number;
}

// ====================================================================== the harness

export interface HarnessOptions {
  /** Columns generated after each tick (default 8). */
  chunkColumns?: number;
  sinks?: (sim: Simulation, replicator: Replicator) => ServerSinks;
  /** Ambient rabbits (default false). */
  rabbits?: boolean;
  storage?: SaveStorage;
  /** Keep the server's poses of the last HISTORY_TICKS ticks (history). */
  history?: boolean;
  /** Starter items for first joins (default true). */
  starterItems?: boolean;
  /**
   * Lockstep (scenario 30, section 16): the server's own clock never fires; step() runs one client
   * frame for every client, delivers, runs one server tick, delivers, and lets the clients apply.
   * Clients get no timed frames or heartbeats, a LockstepClock and the eyes of the body (give them
   * the default INSTANT links). run(), runUntil() and ticks() step.
   */
  lockstep?: boolean;
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
  /** Hello's viewRadius (default 2). */
  viewRadius?: number;
  /** Hello's build (default BUILD_ID). */
  build?: string;
  /** Pristine columns are generated this long after they are asked for (default 0: at once). */
  genDelayMs?: number;
  /** Call NetClient.start() at once (default true). */
  start?: boolean;
  /**
   * Open the client's transports this way instead of dialling a loopback link to the host (the
   * test connects the server end itself; quiesce() does not see such a link).
   */
  transport?: () => Transport;
  /** Keep a copy of every message this client receives, over all its connections (to replay it). */
  record?: Array<{ channel: Channel; bytes: Uint8Array }>;
}

export interface AddRawClientOptions {
  local?: boolean;
  name?: string;
  viewRadius?: number;
  /** Send the Hello at once (default true). */
  hello?: boolean;
}

/** What the server looked like at the end of a tick (history). */
export interface TickRecord {
  ships: Map<number, { pos: Vec3; rot: Quat; pivot: Vec3 }>;
  rotors: Map<number, number>;
  /** World position and yaw; carrier and the position local to it. */
  entities: Map<number, { pos: Vec3; yaw: number; carrierId: number; local: Vec3 }>;
}

/**
 * One end of a loopback link, counting the reliable messages it sent and received, so the harness
 * knows when nothing is in flight (quiesce()). Reliable messages are never lost. fail() ends it
 * as a failed connection does: the end's own onClose fires (unlike close()).
 */
class CountedEnd implements Transport {
  onMessage: Transport['onMessage'] = null;
  onClose: Transport['onClose'] = null;
  sent = 0;
  received = 0;
  private failed = false;
  /** `record`: a copy of every message received is pushed there. */
  constructor(
    private readonly inner: Transport,
    record: Array<{ channel: Channel; bytes: Uint8Array }> | null = null,
  ) {
    inner.onMessage = (channel, bytes) => {
      if (channel === RELIABLE) this.received++;
      record?.push({ channel, bytes: bytes.slice() });
      this.onMessage?.(channel, bytes);
    };
    inner.onClose = (reason) => this.onClose?.(reason);
  }
  get open(): boolean {
    return !this.failed && this.inner.open;
  }
  send(channel: Channel, bytes: Uint8Array): void {
    if (this.failed) return;
    if (channel === RELIABLE && this.inner.open) this.sent++;
    this.inner.send(channel, bytes);
  }
  bufferedBytes(channel: Channel): number {
    return this.inner.bufferedBytes(channel);
  }
  close(reason?: string): void {
    this.inner.close(reason);
  }
  /** Stop delivering (first half of a failure on both ends). */
  cut(): void {
    this.failed = true;
    this.inner.onMessage = null;
    this.inner.onClose = null;
  }
  /** Second half: report the failure to this end's owner and close. */
  reportFailure(reason: string): void {
    const f = this.onClose;
    this.onClose = null;
    this.onMessage = null;
    f?.(reason);
    this.inner.close(reason);
  }
}

interface Link {
  client: CountedEnd;
  server: CountedEnd;
  /** The longest an unreliable message takes on the network, either direction (at dial time). */
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
  client: HeadlessClient;
  digests: Map<number, { digest: Digest; cols: Set<number> }>;
  lastColumns: Set<number>;
}

export class NetHarness {
  readonly net = new LoopbackNet();
  readonly clock: VirtualClock;
  readonly storage: SaveStorage;
  readonly host: ServerHost;
  readonly reports: HostToPage[] = [];
  /** Clients that get frames and heartbeats. */
  readonly clients: HeadlessClient[] = [];
  /** The server's poses by tick (history option). */
  readonly history = new Map<number, TickRecord>();
  /** Called after every server tick (after the harness's own records). */
  onTick: (() => void) | null = null;
  /** The movement and intent packages of the open world (the default ones unless HarnessOptions.sinks). */
  sinks: ServerSinks | null = null;
  private readonly keepHistory: boolean;
  /** Every link not yet closed on either end. */
  private readonly links: Link[] = [];
  /** The link each client dialled last. */
  private readonly current = new Map<HeadlessClient | RawClient, Link>();
  private ctx: DigestContext | null = null;
  private changed = new Set<number>();
  private readonly tracked = new Map<HeadlessClient, Tracked>();
  private hooked: Simulation | null = null;
  private clientSeq = 0;
  /** See HarnessOptions.lockstep. */
  readonly lockstep: boolean;

  constructor(opts: HarnessOptions = {}) {
    this.clock = new VirtualClock(this.net);
    const storage = opts.storage ?? new MemoryStorage();
    this.storage = storage;
    this.keepHistory = opts.history ?? false;
    this.lockstep = opts.lockstep ?? false;
    if (this.lockstep) this.clock.freeze();
    this.host = new ServerHost({
      clock: this.clock,
      openStorage: () => Promise.resolve({ storage, persistent: true }),
      report: (m) => this.reports.push(m),
      chunkBudget: { columns: opts.chunkColumns ?? 8 },
      rabbits: opts.rabbits ?? false,
      starterItems: opts.starterItems ?? true,
      sinks: (sim, replicator) => {
        const s = (opts.sinks ?? defaultSinks)(sim, replicator);
        this.sinks = s;
        return s;
      },
    });
    this.host.onTick = () => this.afterTick();
  }

  get sim(): Simulation {
    return this.host.sim;
  }

  /** What the server's intents did for `key` (default sinks only), or null. */
  intentStats(key: PlayerKey): Readonly<IntentStats> | null {
    const i = this.sinks?.intents;
    return i instanceof IntentQueue ? i.stats(key) : null;
  }

  /** The digest context of the open world (pristine hashes from its generator). */
  get digestContext(): DigestContext {
    return this.ctx!;
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

  /** Open a simulation built by the test (ServerHost.serve): `generator` describes sim.generator. */
  serve(sim: Simulation, generator: GeneratorSpec = sim.generator.spec(), meta: WorldMeta = testMeta()): void {
    this.host.serve(sim, generator, meta);
    this.hook();
  }

  /**
   * Let pending promise chains (saves, control messages) run to the end: microtasks only, no timer
   * and no virtual time passes.
   */
  async settle(): Promise<void> {
    for (let i = 0; i < 100; i++) await Promise.resolve();
  }

  private hook(): void {
    if (this.host.state !== 'running' || this.hooked === this.host.sim) return;
    const sim = this.host.sim;
    this.hooked = sim;
    this.ctx = new DigestContext(sim.generator);
    sim.world.onCellChange((x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
    sim.worldGlue.onChange((_a, x, _y, z) => this.changed.add(chunkKey(x >> 4, z >> 4)));
  }

  // ------------------------------------------------------------------ clients

  /**
   * A HeadlessClient on loopback links with these conditions (section 15: addClient(key,
   * conditions, opts)); it starts at once unless opts.start is false.
   */
  addClient(key: PlayerKey, conditions: ClientLink = {}, opts: AddClientOptions = {}): HeadlessClient {
    const local = opts.local ?? false;
    const linkConds = { up: conditions.up ?? { ...INSTANT }, down: conditions.down ?? { ...INSTANT } };
    const c = new HeadlessClient(key, (self) => {
      return new NetClient({
        openTransport: (ready, failed) => {
          if (this.host.state !== 'running') return failed('no server');
          ready(opts.transport !== undefined ? opts.transport() : this.dial(self, linkConds, local, opts.record ?? null));
        },
        now: () => this.net.now,
        chunkSource: (spec) => generatorSource(generatorFromSpec(spec), this.net, opts.genDelayMs ?? 0, self.generation),
        playerKey: key,
        name: opts.name ?? key,
        viewRadius: opts.viewRadius ?? 2,
        ...(opts.build !== undefined ? { build: opts.build } : {}),
        ...(this.lockstep ? { clock: () => new LockstepClock() } : {}),
      });
    });
    this.clients.push(c);
    c.driver = this;
    if (this.lockstep) {
      // Frames come from step(); a lockstep client sends no Ping (nothing measures the round trip).
      c.eyes = 'body';
      if (opts.start ?? true) c.net.start();
      return c;
    }
    // Frames and heartbeats with a phase of their own.
    const phase = ((this.clientSeq++ * 7.3) % FRAME_MS) + 0.1;
    const frame = (at: number): void => {
      this.net.schedule(at, () => {
        if (!this.clients.includes(c)) return;
        c.frame(this.net.now);
        frame(at + FRAME_MS);
      });
    };
    const beat = (at: number): void => {
      this.net.schedule(at, () => {
        if (!this.clients.includes(c)) return;
        c.heartbeat(this.net.now);
        beat(at + HEARTBEAT_MS);
      });
    };
    frame(this.net.now + phase);
    beat(this.net.now + phase * 13);
    if (opts.start ?? true) c.net.start();
    return c;
  }

  /** A RawClient on a loopback link; it says Hello at once unless opts.hello is false. */
  addRawClient(key: PlayerKey, conditions: ClientLink = {}, opts: AddRawClientOptions = {}): RawClient {
    const l = this.newLink({ up: conditions.up ?? INSTANT, down: conditions.down ?? INSTANT });
    const c = new RawClient(key, l.client);
    this.current.set(c, l);
    this.host.connect(l.server, opts.local ?? false);
    if (opts.hello ?? true) c.hello({ ...(opts.name !== undefined ? { name: opts.name } : {}), viewRadius: opts.viewRadius ?? 2 });
    return c;
  }

  private newLink(conds: { up: LinkConditions; down: LinkConditions }, record: Array<{ channel: Channel; bytes: Uint8Array }> | null = null): Link {
    const pair = createLoopbackPair(this.net, conds.up, conds.down);
    const l: Link = {
      client: new CountedEnd(pair.client, record),
      server: new CountedEnd(pair.server),
      maxDelayMs: Math.max(conds.up.latencyMs + conds.up.jitterMs, conds.down.latencyMs + conds.down.jitterMs),
    };
    // Links that closed carry nothing any more (inFlight() reads 0): drop them.
    for (let i = this.links.length - 1; i >= 0; i--) if (!this.links[i]!.client.open || !this.links[i]!.server.open) this.links.splice(i, 1);
    this.links.push(l);
    return l;
  }

  /** A new link for a client's NetClient; the server end goes to the host. */
  private dial(c: HeadlessClient, conds: { up: LinkConditions; down: LinkConditions }, local: boolean, record: Array<{ channel: Channel; bytes: Uint8Array }> | null): Transport {
    const l = this.newLink(conds, record);
    this.current.set(c, l);
    this.host.connect(l.server, local);
    return l.client;
  }

  /** Stop framing a client (it stays connected unless it closes). */
  removeClient(c: HeadlessClient): void {
    const i = this.clients.indexOf(c);
    if (i >= 0) this.clients.splice(i, 1);
    this.tracked.delete(c);
  }

  /** The client's current link fails on both ends (both onClose fire, as when ICE fails). */
  sever(c: HeadlessClient | RawClient): void {
    const l = this.current.get(c)!;
    l.client.cut();
    l.server.cut();
    l.client.reportFailure('link failed');
    l.server.reportFailure('link failed');
  }

  /** The page dies: its transport closes from the client end without a Bye; no more frames or heartbeats. */
  crash(c: HeadlessClient): void {
    c.crashed = true;
    this.current.get(c)?.client.close('crashed');
    this.removeClient(c);
  }

  /** Send raw bytes to the client from the server end of its current link (not through NetServer). */
  inject(c: HeadlessClient, channel: Channel, bytes: Uint8Array): void {
    this.current.get(c)!.server.send(channel, bytes);
  }

  // ------------------------------------------------------------------ time

  /** Advance virtual time by `ms` (a server held by quiesce() runs on). Lockstep: the steps of `ms`. */
  run(ms: number): void {
    if (this.lockstep) {
      for (let i = Math.round(ms / TICK_MS); i > 0; i--) this.step();
      return;
    }
    this.clock.thaw();
    this.net.advanceBy(ms);
  }

  /**
   * Advance until `cond` holds (checked every `stepMs`), at most `maxMs` (a server held by quiesce()
   * runs on). Lockstep: step until it holds, at most the steps of `maxMs`.
   */
  runUntil(cond: () => boolean, maxMs = 10_000, stepMs = 10): void {
    if (this.lockstep) {
      for (let i = Math.ceil(maxMs / TICK_MS); !cond(); i--) {
        if (i <= 0) throw new Error(`condition not reached within ${maxMs} ms`);
        this.step();
      }
      return;
    }
    this.clock.thaw();
    this.advanceUntil(cond, maxMs, stepMs);
  }

  /** Run until the server has run `n` more ticks (1 ms steps; lockstep: n steps). */
  ticks(n = 1): void {
    if (this.lockstep) {
      for (let i = 0; i < n; i++) this.step();
      return;
    }
    const t = this.sim.ticks + n;
    this.runUntil(() => this.sim.ticks >= t, Math.max(5000, n * 200), 1);
  }

  /**
   * One lockstep step (HarnessOptions.lockstep): TICK_MS of virtual time pass; every client runs a
   * frame (what it holds, its prediction, its reports and intents); what they sent arrives; the
   * server runs one tick; its batches and samples arrive; every client applies them.
   */
  step(): void {
    if (!this.lockstep) throw new Error('step() needs a lockstep harness');
    const now = this.net.now + TICK_MS;
    this.net.advanceTo(now);
    for (const c of this.clients) c.frame(now);
    this.net.advanceTo(now);
    this.host.tickOnce();
    this.net.advanceTo(now);
    for (const c of this.clients) c.applyNow(now);
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
    for (const c of this.clients) c.frame(this.net.now);
  }

  /** The server's timers fire nowhere for `ms` (a Worker blocked by a long task), then all that are due fire at once. */
  stallServer(ms: number): void {
    this.clock.freeze();
    this.net.advanceBy(ms);
    this.clock.thaw();
  }

  // ------------------------------------------------------------------ digests

  /** Compare `c` with the server after every tick (see the file comment). */
  track(c: HeadlessClient): void {
    const t: Tracked = { client: c, digests: new Map(), lastColumns: new Set() };
    this.tracked.set(c, t);
    c.onApplied = (tick) => {
      const rec = t.digests.get(tick);
      if (rec === undefined) return;
      t.digests.delete(tick);
      for (const k of t.digests.keys()) if (k < tick) t.digests.delete(k);
      const r = c.replica!;
      // Columns still generating on the client are not there yet (section 5): left out on both sides.
      const cols = new Set([...rec.cols].filter((k) => !r.chunks.has(chunkKeyX(k), chunkKeyZ(k)) || r.chunks.present(chunkKeyX(k), chunkKeyZ(k))));
      const server: Digest = { ...rec.digest, columns: new Map([...rec.digest.columns].filter(([k]) => cols.has(k))) };
      c.checked++;
      for (const d of compareReplica(server, replicaDigest(r.state, cols), { poses: false })) c.mismatches.push(`tick ${tick}: ${d}`);
    };
  }

  /** Compare everything the client has been given with the server now. */
  compareNow(c: HeadlessClient, poses = true): string[] {
    const view = this.host.replicator.clientView(c.key);
    if (view === undefined) return ['not a client of the replicator'];
    const s = serverDigest(this.ctx!, this.sim, { columns: view.columns, structures: view.structures, entities: view.entities });
    return compareReplica(s, replicaDigest(c.state!), { poses });
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
    if (this.keepHistory) this.record();
    this.onTick?.();
  }

  private record(): void {
    const sim = this.sim;
    const rec: TickRecord = { ships: new Map(), rotors: new Map(), entities: new Map() };
    for (const s of sim.structures.all()) {
      if (s instanceof Rotor) rec.rotors.set(s.id, s.angle);
      else rec.ships.set(s.id, { pos: { ...s.grid.position }, rot: { ...s.grid.rotation }, pivot: { ...s.grid.pivot } });
    }
    for (const e of sim.entities.all()) {
      if (e.removed) continue;
      const carrier = e.carrierId !== 0 ? sim.structures.get(e.carrierId) : undefined;
      const local = carrier !== undefined ? carrier.grid.toLocal(e.pos) : { ...e.pos };
      rec.entities.set(e.id, { pos: { ...e.pos }, yaw: e.yaw, carrierId: carrier?.id ?? 0, local });
    }
    this.history.set(sim.ticks, rec);
    this.history.delete(sim.ticks - HISTORY_TICKS);
  }
}
