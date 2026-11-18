/**
 * The world of an acceptance test, in one of two modes (docs/NETCODE.md section 16, scenario 30
 * "单机走同一套协议"). The mode of the running Vitest project is BLOCKLANDS_WORLD ('direct' or
 * 'network'; vitest.config.ts runs every acceptance test in both).
 *
 *  - direct: the Simulation with one joined player, server-driven: `me` acts through its
 *    PlayerControl and its input, as the tests always did.
 *  - network: the same Simulation served by a real ServerHost (ServerHost.serve: built with the
 *    same options, so the same spawn, load radius and chunks generated inside the tick), and `me`
 *    is a HeadlessClient (tests/net/harness.ts) on a zero-delay loopback link, the host's own
 *    connection: its prediction moves the player from the held keys and reports, its intents
 *    click, the host commands teleport, give and set the mode. tick() runs in lockstep
 *    (NetHarness.step): one client frame (input, prediction, reports and intents sent), delivery,
 *    one server tick, delivery, the client applies; the client's clock is a LockstepClock
 *    (renderTick = the newest batch, D = 1, rotors at the tick that applies the report), so there
 *    is exactly one report a tick.
 *
 * A test builds its scene and reads its results on `sim` (the server's Simulation in both modes)
 * and acts only through `me`: the held keys (`me.input`), the look, the scripted actions, and the
 * host commands behind teleport, give and the mode. tests/net/acceptance-guard.test.ts keeps the
 * solo accessors, direct input writes and direct ticks out of tests/acceptance.
 *
 * THE SAME TICKS IN BOTH MODES. Every tick is one the test asks for (tick(n), useOn, mine) or one
 * of the waits below, and every wait runs the same fixed number of ticks in both modes: the
 * network mode needs it (the server learns things from the client, the client learns the scene
 * from the next batch) and checks after it that it was enough; the direct mode runs it too, so
 * a test sees the same ticks whatever the mode. tests/acceptance/tick-parity.ts compares the
 * tick count of every world between the two projects at the end of the run.
 *  - READY (READY_TICKS = 2): the player joins when the world is made, before its first tick (in
 *    network mode the client's Hello arrives and the start of the first tick, NetServer.beforeTick:
 *    the join and the Welcome, is carried out at once, as the host's own client joins a loaded
 *    world before its first tick, scenario 36). So a world just made (or loaded) can be read with
 *    the player in it before anything moves. The client predicts after the first batch: the first
 *    use of `me` that acts (anything but player, view and helmView) runs the world to READY_TICKS
 *    ticks after the join, unless `warmup` or the test's own ticks did (`w.ready()` does it at
 *    once). In those ticks nobody holds a key, but the player does not move the same: in direct
 *    mode the server moves it both ticks, in network mode the server holds it where it joined in
 *    the first (no report yet) and the client predicts the second. A player at rest at the join
 *    (on the ground, carried) ends where it was in both; a test whose player spawns in the air
 *    puts it where it wants after READY (take off, a tick, teleport: scenario 11's blast test).
 *  - SYNC (1): aiming at anything (lookAtCell, aimAt, use, pressUse, useOn, mine) right after the
 *    test changed the scene between two ticks (cells, glue, which structures or entities exist):
 *    the client sees the change with the next batch.
 *  - TELEPORT (2): the host's Teleport is carried out at the start of the next tick and its
 *    correction adopted at the client's next frame. A teleport so far that the client reloads
 *    (RELOAD_DISTANCE) needs more and is not supported here.
 *  - COMMANDS (1): respawn, releaseHelm, dropCursorStack, setMode and giveItem act at once in
 *    direct mode; in network mode they are intents carried out at the start of the next tick. That
 *    tick runs in both modes, so what they did can be read when they return.
 *  - HOLD (1): hold() of an item the hotbar does not have, unless it is a full stack in creative
 *    (the palette, predicted): the host's Give (see COMMANDS).
 *  - HELM (1): useOn() with a helm in hand, before the click: the helm faces the look the server
 *    has (NETCODE section 18, package 7 "视角和点击").
 * The network checks: READY, the client predicts and has its intents; TELEPORT, the client adopted
 * the server's latest correction and does not reload; COMMANDS and HOLD, the server acknowledged
 * every intent sent.
 *
 * AFTER EACH TEST (tests/acceptance/setup.ts, finishWorlds; after the file for worlds its beforeAll
 * hooks made): the world's tick count goes to the parity log; then, in network mode, the client
 * must be connected and ready, its replica must equal the server over everything the Replicator
 * gave it (compareReplica, poses included; one more step first when the test changed the scene
 * after its last tick), and no correction may have refused one of its reports (cause 'check:...':
 * with no delay the client sees what the server judges).
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, inject } from 'vitest';
import { B } from '../../src/blocks/defs';
import type { Dir } from '../../src/core/dirs';
import { qrotate, vec3, type AABB } from '../../src/core/math';
import type { Player } from '../../src/entities/entity';
import { maxStackOf, type Inventory, type InventoryArea } from '../../src/entities/inventory';
import type { HeldInput } from '../../src/net/client/predict';
import { importSave, type SaveBundle } from '../../src/sim/persist';
import type { PlayerControl } from '../../src/sim/players';
import { Simulation, type GameMode, type SimOptions } from '../../src/sim/simulation';
import type { GridCell, HelmView, InteractionView, PlayerKey } from '../../src/sim/view';
import type { Ship } from '../../src/structures/structure';
import { testMeta, NetHarness, type HeadlessClient } from '../net/harness';

export type WorldMode = 'direct' | 'network';

/** The mode of the running project (vitest.config.ts). */
export const WORLD_MODE: WorldMode = process.env.BLOCKLANDS_WORLD === 'network' ? 'network' : 'direct';

/** The key the player of a test world joins with. */
export const ME: PlayerKey = 'me';

export interface WorldOptions extends SimOptions {
  /** The load radius is the client's view radius in network mode: always given. */
  loadRadius: number;
  /** Ticks run once the player joined (e.g. the rest of the load radius arrives); default 0. */
  warmup?: number;
  /** A save loaded into the new simulation (importSave) before the player joins. */
  load?: SaveBundle;
}

/** The keys and the look the player holds (both modes; the look is the world's, turned by carriers). */
export type HeldKeys = Pick<HeldInput, 'forward' | 'strafe' | 'jump' | 'sneak' | 'sprint' | 'yaw' | 'pitch'>;

/** The player of a test world: what it holds, what it does, and its server-side state (read only). */
export interface Me {
  /** The held keys and look, read every tick. */
  readonly input: HeldKeys;
  /** The player's entity on the server (read it; act through the methods). */
  readonly player: Player;
  /**
   * The body where the authority on the player's movement put it, against the world it moved in:
   * direct mode, the server's entity; network mode, the client's predicted body. They differ for a
   * carried body: the client placed it against the carrier as it showed it (a tick behind the
   * server's pose), and the server places the same carrier-local feet with its present pose, so
   * against the world the server's copy may overlap by the carrier's motion of that tick
   * (NETCODE section 9: the overlap allowance of a carried body). A check of the body against the
   * world checks both: this one without overlap, `player` within carriedOverlap().
   */
  readonly body: Player;
  /** The server's interaction view of the player (preview, hint, conflicts, gluing ...). */
  readonly view: InteractionView;
  /** The steering read-out on the server, or null. */
  helmView(): HelmView | null;
  /** Point the look at a world point (from the eyes). */
  lookAt(x: number, y: number, z: number): void;
  /** Point the look at a cell of a grid (see PlayerControl.lookAtCell); false when the grid does not exist. */
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId?: number): boolean;
  /** lookAtCell, then true when the use ray (or the mining ray) hits exactly that cell (and face). */
  aimAt(x: number, y: number, z: number, face?: Dir, gridId?: number, mining?: boolean): boolean;
  /** The cell the use ray hits now, or null. */
  targetCell(): (GridCell & { face: Dir }) | null;
  /** Queue one right-click for the next tick. */
  use(): void;
  /** Press the right button and keep it held (from the next tick; a click with the button held). */
  pressUse(): void;
  /** Let go of the right button. */
  releaseUse(): void;
  /** Aim at a cell, right-click it and run the tick; false (nothing clicked) when the cell cannot be aimed at. */
  useOn(x: number, y: number, z: number, face?: Dir, gridId?: number): boolean;
  /** Aim at a cell and hold the left button until it is gone, at most maxTicks ticks; false when it could not be aimed at or did not break. */
  mine(x: number, y: number, z: number, face?: Dir, gridId?: number, maxTicks?: number): boolean;
  /** Queue an off-hand swap for the next tick. */
  swapHands(): void;
  /** Hold `item` (see PlayerControl.hold; network: see WHAT TAKES TICKS). */
  hold(item: number, count?: number): void;
  /** Hold nothing (select an empty hotbar slot). */
  emptyHand(): void;
  /** Items into the inventory, as a pickup puts them. */
  giveItem(item: number, count: number): void;
  /** A click in the inventory screen (Inventory.slotClick; network: predicted, sent as InvClick). */
  invClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void;
  /** Move the feet to a world point (no helm, no carrier, no velocity). */
  teleport(x: number, y: number, z: number): void;
  /** Start or stop flying (creative; the double tap of the jump key). */
  setFlying(flying: boolean): void;
  setMode(mode: GameMode): void;
  respawn(): void;
  releaseHelm(): void;
  /** Throw the inventory cursor's stack. */
  dropCursorStack(): void;
  /** The chunk radius kept around the player (network: its view radius). */
  viewRadius: number;
}

/** A test world (see the file comment). */
export interface TestWorld {
  readonly mode: WorldMode;
  /** The server's Simulation: build scenes and read results here. */
  readonly sim: Simulation;
  readonly me: Me;
  /** Run `n` ticks (network: lockstep steps). */
  tick(n?: number): void;
  /**
   * READY now (see the file comment): the world runs to READY_TICKS ticks after the join unless
   * it has already; the first use of `me` that acts does the same.
   */
  ready(): void;
  /**
   * One tick of a loop that ticks while something has not happened in the simulation yet (the
   * ship reaches a heading, the first crush, the water settles ...). How many such ticks there are
   * is an outcome of the simulation, which differs between the modes where the product does by
   * design: the helm takes the keys one tick later from a client's move report (NETCODE section 8
   * 掌舵: steering reads the input in the interaction step, the report is applied in the entities
   * step after it), and a client-driven player is crushed only after the squeeze hysteresis. The
   * tick parity check (tests/acceptance/tick-parity.ts) leaves these ticks out; every other tick
   * is one the test asked for by number, or a wait, and must be the same in both modes.
   */
  tickWhile(): void;
  /**
   * How deep the server's copy of a body carried by `carrier` may overlap the world (NETCODE
   * section 9: the overlap allowance of a carried body; see Me.body). Direct mode: 0, the server's
   * body is the one that moved. Network mode: the client placed the carrier-local feet against the
   * carrier's pose as its replica shows it, the server places them with its present pose, so the
   * two differ by the carrier's motion at the body over the last tick plus the precision of the
   * pose in the replica (section 14: Pos32 is 1/512 block, Rot64 1/32767 a component).
   */
  carriedOverlap(carrier: Ship, box: AABB): number;
  /** Network mode: the harness and the client (null in direct mode). */
  readonly harness: NetHarness | null;
  readonly client: HeadlessClient | null;
}

/** Worlds made by the running test, and by the file's beforeAll hooks (shared by its tests). */
const open = { test: [] as TestWorld[], file: [] as TestWorld[] };

/** A new test world in the running project's mode (or `mode`). */
export function testWorld(o: WorldOptions, mode: WorldMode = WORLD_MODE): TestWorld {
  const { warmup = 0, load, ...simOpts } = o;
  const sim = new Simulation(simOpts);
  if (load !== undefined) importSave(sim, load);
  const w = mode === 'network' ? new NetWorld(sim, simOpts.loadRadius) : new DirectWorld(sim);
  (expect.getState().currentTestName === undefined ? open.file : open.test).push(w);
  w.tick(warmup);
  return w;
}

/**
 * The end of the worlds of a test (`which` = 'test', after each test) or of a file's beforeAll
 * hooks ('file', after the file; their tests share them), then they are forgotten (see AFTER EACH
 * TEST). `passed`: the test passed (a failed one logs no tick counts).
 */
export function finishWorlds(which: 'test' | 'file', passed: boolean): void {
  const worlds = open[which].splice(0);
  if (passed) logTicks(which, worlds);
  for (const w of worlds) if (w instanceof NetWorld) w.finish();
}

/** The tick count of every world of the test, to the parity log of this mode (tests/acceptance/tick-parity.ts). */
function logTicks(which: 'test' | 'file', worlds: readonly TestWorld[]): void {
  if (worlds.length === 0) return;
  const dir = inject('tickParityDir');
  if (dir === undefined || dir === '') return;
  const st = expect.getState();
  const test = which === 'test' ? (st.currentTestName ?? '?') : '(beforeAll)';
  const file = relative(process.cwd(), st.testPath ?? '?');
  const lines = worlds.map((w, i) => JSON.stringify({ file, test, world: i, ticks: (w as BaseWorld).fixedTicks }) + '\n');
  appendFileSync(`${dir}/${WORLD_MODE}.jsonl`, lines.join(''));
}

declare module 'vitest' {
  interface ProvidedContext {
    /** The directory of the tick parity logs (tests/acceptance/tick-parity.ts); '' when there is none. */
    tickParityDir: string;
  }
}

// ====================================================================== the waits (both modes)

/** See THE SAME TICKS IN BOTH MODES. */
export const READY_TICKS = 2;
const SYNC_TICKS = 1;
const TELEPORT_TICKS = 2;
const COMMAND_TICKS = 1;
const HELM_TICKS = 1;

/** What both modes share: the ticks, the scene watch behind SYNC, and the waits. */
abstract class BaseWorld implements TestWorld {
  abstract readonly mode: WorldMode;
  abstract readonly me: Me;
  abstract readonly harness: NetHarness | null;
  abstract readonly client: HeadlessClient | null;
  /** sim.ticks when the player joined (start()). */
  private joinedAt = 0;
  /** The scene was edited on the server since the last tick (see sync()). */
  private edited = false;
  private stepping = false;
  private readonly hooked = new WeakSet<object>();
  private shape = '';
  private readonly watch = (): void => {
    if (!this.stepping) this.edited = true;
  };
  /** The ticks run by tickWhile(). */
  private openTicks = 0;

  constructor(readonly sim: Simulation) {}

  /** The ticks the test asked for by number or as waits (see tickWhile); the parity check compares them. */
  get fixedTicks(): number {
    return this.sim.ticks - this.openTicks;
  }

  tickWhile(): void {
    this.tick();
    this.openTicks++;
  }

  /** The end of a subclass's constructor: the player joins, before the first tick. */
  protected start(): void {
    const sim = this.sim;
    this.join();
    if (sim.players.get(ME) === undefined) throw new Error('test world: the player did not join');
    this.joinedAt = sim.ticks;
    sim.world.onCellChange(this.watch);
    sim.worldGlue.onChange(this.watch);
    this.settled();
  }

  /** The player joins, before the first tick. */
  protected abstract join(): void;
  /** One tick (network: a lockstep step). */
  protected abstract step(): void;
  /** Network mode: what the client must have after READY. */
  protected abstract checkReady(): void;

  abstract carriedOverlap(carrier: Ship, box: AABB): number;

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.stepping = true;
      try {
        this.step();
      } finally {
        this.stepping = false;
      }
      this.settled();
    }
  }

  /** The PlayerControl of the player on the server. */
  get ctrl(): PlayerControl {
    const c = this.sim.players.get(ME);
    if (c === undefined) throw new Error('the player is not in the world');
    return c;
  }

  /** After a tick (or the join): the scene now is what the client has been sent. */
  private settled(): void {
    this.edited = false;
    this.shape = this.shapeNow();
    for (const s of this.sim.structures.all()) {
      if (this.hooked.has(s)) continue;
      this.hooked.add(s);
      s.grid.onCellChange(this.watch);
      s.glue.onChange(this.watch);
    }
  }

  /** Which structures and entities exist (their ids). */
  private shapeNow(): string {
    const ids = (list: readonly { id: number }[]): string => list.map((x) => x.id).join(',');
    return `${ids(this.sim.structures.all())}|${ids(this.sim.entities.all())}`;
  }

  /** The scene was changed between ticks since the last one. */
  protected get changed(): boolean {
    return this.edited || this.shapeNow() !== this.shape;
  }

  /** READY: the world runs to READY_TICKS after the join. */
  ready(): void {
    const left = this.joinedAt + READY_TICKS - this.sim.ticks;
    if (left > 0) this.tick(left);
    this.checkReady();
  }

  /** SYNC: one tick when the scene was changed between ticks since the last one. */
  sync(): void {
    this.ready();
    if (this.changed) this.tick(SYNC_TICKS);
  }

  /** A wait of `n` ticks; in network mode `enough` must hold after it (`what` names the wait). */
  wait(n: number, enough: () => boolean, what: string): void {
    this.tick(n);
    if (this.mode === 'network' && !enough()) throw new Error(`network world: ${n} ticks were not enough for ${what}`);
  }
}

/**
 * The player of a test world, both modes: every wait is here; the subclasses carry out the
 * actions (direct: the PlayerControl; network: the client).
 */
abstract class BaseMe<W extends BaseWorld> implements Me {
  constructor(protected readonly w: W) {}

  protected abstract heldKeys(): HeldKeys;
  protected abstract movedBody(): Player;
  protected abstract doLookAt(x: number, y: number, z: number): void;
  protected abstract doLookAtCell(x: number, y: number, z: number, face: Dir | undefined, gridId: number): boolean;
  protected abstract doAimAt(x: number, y: number, z: number, face: Dir | undefined, gridId: number, mining: boolean): boolean;
  protected abstract doTargetCell(): (GridCell & { face: Dir }) | null;
  protected abstract doUse(): void;
  protected abstract doPressUse(): void;
  protected abstract doReleaseUse(): void;
  /** Hold the left button, aiming at `cell` at every tick (network: holdAim). */
  protected abstract doPressAttack(cell: { x: number; y: number; z: number; face?: Dir; gridId: number }): void;
  protected abstract doReleaseAttack(): void;
  protected abstract doSwapHands(): void;
  /** The inventory as this mode's authority on clicks has it (network: as the client shows it). */
  protected abstract inventory(): Inventory;
  protected abstract modeNow(): GameMode;
  /** Select (or, see PlayerControl.hold, put and select) `item`; `give`: HOLD's tick is the subclass's to run. */
  protected abstract doHold(item: number, count: number, give: boolean): void;
  protected abstract doEmptyHand(): void;
  protected abstract doGive(item: number, count: number): void;
  protected abstract doInvClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void;
  protected abstract doTeleport(x: number, y: number, z: number): void;
  protected abstract doSetFlying(flying: boolean): void;
  protected abstract doSetMode(mode: GameMode): void;
  protected abstract doRespawn(): void;
  protected abstract doReleaseHelm(): void;
  protected abstract doDropCursorStack(): void;
  protected abstract setViewRadius(r: number): void;
  /** Network mode: the client adopted the server's latest correction and does not reload. */
  protected abstract teleported(): boolean;
  /** Network mode: the server acknowledged every intent sent. */
  protected abstract acknowledged(): boolean;

  get input(): HeldKeys {
    this.w.ready();
    return this.heldKeys();
  }
  get player(): Player {
    return this.w.ctrl.player;
  }
  get body(): Player {
    this.w.ready();
    return this.movedBody();
  }
  get view(): InteractionView {
    return this.w.ctrl.view;
  }
  helmView(): HelmView | null {
    return this.w.ctrl.helmView();
  }
  lookAt(x: number, y: number, z: number): void {
    this.w.ready();
    this.doLookAt(x, y, z);
  }
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    this.w.sync();
    return this.doLookAtCell(x, y, z, face, gridId);
  }
  aimAt(x: number, y: number, z: number, face?: Dir, gridId = 0, mining = false): boolean {
    this.w.sync();
    return this.doAimAt(x, y, z, face, gridId, mining);
  }
  targetCell(): (GridCell & { face: Dir }) | null {
    this.w.ready();
    return this.doTargetCell();
  }
  use(): void {
    this.w.sync();
    this.doUse();
  }
  pressUse(): void {
    this.w.sync();
    this.doPressUse();
  }
  releaseUse(): void {
    this.w.ready();
    this.doReleaseUse();
  }
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    this.w.sync();
    if (!this.doAimAt(x, y, z, face, gridId, false)) return false;
    if (this.heldItem() === B.HELM) {
      // HELM: the helm faces the look the server has; let a tick bring it there first.
      this.w.tick(HELM_TICKS);
      if (!this.doAimAt(x, y, z, face, gridId, false)) return false;
    }
    this.doUse();
    this.w.tick();
    return true;
  }
  mine(x: number, y: number, z: number, face?: Dir, gridId = 0, maxTicks = 400): boolean {
    this.w.sync();
    if (!this.doAimAt(x, y, z, face, gridId, true)) return false;
    const grid = (): { getCell(x: number, y: number, z: number): number } | undefined => this.w.sim.structures.gridById(gridId);
    const before = grid()!.getCell(x, y, z);
    this.doPressAttack(face === undefined ? { x, y, z, gridId } : { x, y, z, face, gridId });
    try {
      for (let i = 0; i < maxTicks; i++) {
        this.w.tick();
        const g = grid();
        if (g === undefined || g.getCell(x, y, z) !== before) return true;
        // Keep aiming at the cell: a carrier may have turned the player.
        if (!this.doAimAt(x, y, z, face, gridId, true)) return false;
      }
      return false;
    } finally {
      this.doReleaseAttack();
    }
  }
  swapHands(): void {
    this.w.ready();
    this.doSwapHands();
  }
  hold(item: number, count: number = maxStackOf(item)): void {
    this.w.ready();
    const has = this.inventory().hotbar.some((s) => s !== null && s.item === item && s.count > 0);
    const give = !has && !(this.modeNow() === 'creative' && count === maxStackOf(item));
    this.doHold(item, count, give);
  }
  emptyHand(): void {
    this.w.ready();
    this.doEmptyHand();
  }
  giveItem(item: number, count: number): void {
    this.w.ready();
    this.doGive(item, count);
    this.w.wait(COMMAND_TICKS, () => this.acknowledged(), 'Give');
  }
  invClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    this.w.ready();
    this.doInvClick(area, index, button, shift);
  }
  teleport(x: number, y: number, z: number): void {
    this.w.ready();
    this.doTeleport(x, y, z);
    this.w.wait(TELEPORT_TICKS, () => this.teleported(), 'the teleport');
  }
  setFlying(flying: boolean): void {
    this.w.ready();
    this.doSetFlying(flying);
  }
  setMode(mode: GameMode): void {
    this.w.ready();
    this.doSetMode(mode);
    this.w.wait(COMMAND_TICKS, () => this.acknowledged() && this.player.mode === mode, 'SetPlayerMode');
  }
  respawn(): void {
    this.w.ready();
    this.doRespawn();
    this.w.wait(COMMAND_TICKS, () => this.acknowledged(), 'Respawn');
  }
  releaseHelm(): void {
    this.w.ready();
    this.doReleaseHelm();
    this.w.wait(COMMAND_TICKS, () => this.acknowledged(), 'ReleaseHelm');
  }
  dropCursorStack(): void {
    this.w.ready();
    this.doDropCursorStack();
    this.w.wait(COMMAND_TICKS, () => this.acknowledged(), 'DropCursor');
  }
  get viewRadius(): number {
    return this.w.ctrl.viewRadius;
  }
  set viewRadius(r: number) {
    this.w.ready();
    this.setViewRadius(r);
  }

  /** The item in hand as the inventory() has it, -1 for none. */
  private heldItem(): number {
    const s = this.inventory().selectedStack();
    return s !== null && s.count > 0 ? s.item : -1;
  }
}

// ====================================================================== direct

class DirectWorld extends BaseWorld {
  readonly mode = 'direct';
  readonly me: DirectMe;
  readonly harness = null;
  readonly client = null;

  constructor(sim: Simulation) {
    super(sim);
    this.me = new DirectMe(this);
    this.start();
  }

  protected join(): void {
    this.sim.join(ME);
  }
  protected step(): void {
    this.sim.tick();
  }
  protected checkReady(): void {}
  carriedOverlap(_carrier: Ship, _box: AABB): number {
    return 0;
  }
}

/** The held keys of a server-driven player: its input. */
class DirectKeys implements HeldKeys {
  constructor(private readonly p: () => Player) {}
  get forward(): number {
    return this.p().input.forward;
  }
  set forward(v: number) {
    this.p().input.forward = v;
  }
  get strafe(): number {
    return this.p().input.strafe;
  }
  set strafe(v: number) {
    this.p().input.strafe = v;
  }
  get jump(): boolean {
    return this.p().input.jump;
  }
  set jump(v: boolean) {
    this.p().input.jump = v;
  }
  get sneak(): boolean {
    return this.p().input.sneak;
  }
  set sneak(v: boolean) {
    this.p().input.sneak = v;
  }
  get sprint(): boolean {
    return this.p().input.sprint;
  }
  set sprint(v: boolean) {
    this.p().input.sprint = v;
  }
  get yaw(): number {
    return this.p().input.yaw;
  }
  set yaw(v: number) {
    this.p().input.yaw = v;
  }
  get pitch(): number {
    return this.p().input.pitch;
  }
  set pitch(v: number) {
    this.p().input.pitch = v;
  }
}

class DirectMe extends BaseMe<DirectWorld> {
  private readonly keys = new DirectKeys(() => this.player);

  private get ctrl(): PlayerControl {
    return this.w.ctrl;
  }
  protected heldKeys(): HeldKeys {
    return this.keys;
  }
  protected movedBody(): Player {
    return this.player;
  }
  protected doLookAt(x: number, y: number, z: number): void {
    this.ctrl.lookAt(x, y, z);
  }
  protected doLookAtCell(x: number, y: number, z: number, face: Dir | undefined, gridId: number): boolean {
    return this.ctrl.lookAtCell(x, y, z, face, gridId);
  }
  protected doAimAt(x: number, y: number, z: number, face: Dir | undefined, gridId: number, mining: boolean): boolean {
    return this.ctrl.aimAt(x, y, z, face, gridId, mining);
  }
  protected doTargetCell(): (GridCell & { face: Dir }) | null {
    return this.ctrl.targetCell();
  }
  protected doUse(): void {
    this.ctrl.use();
  }
  protected doPressUse(): void {
    this.ctrl.use();
    this.player.input.use = true;
  }
  protected doReleaseUse(): void {
    this.player.input.use = false;
  }
  protected doPressAttack(): void {
    this.ctrl.attack();
    this.player.input.attack = true;
  }
  protected doReleaseAttack(): void {
    this.player.input.attack = false;
  }
  protected doSwapHands(): void {
    this.ctrl.swapHands();
  }
  protected inventory(): Inventory {
    return this.player.inventory;
  }
  protected modeNow(): GameMode {
    return this.player.mode;
  }
  protected doHold(item: number, count: number, give: boolean): void {
    this.ctrl.hold(item, count);
    if (give) this.w.tick(COMMAND_TICKS);
  }
  protected doEmptyHand(): void {
    this.ctrl.emptyHand();
  }
  protected doGive(item: number, count: number): void {
    this.ctrl.giveItem(item, count);
  }
  protected doInvClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    this.player.inventory.slotClick(area, index, button, shift);
  }
  protected doTeleport(x: number, y: number, z: number): void {
    this.ctrl.teleport(x, y, z);
  }
  protected doSetFlying(flying: boolean): void {
    this.player.flying = flying;
  }
  protected doSetMode(mode: GameMode): void {
    this.ctrl.setMode(mode);
  }
  protected doRespawn(): void {
    this.ctrl.respawn();
  }
  protected doReleaseHelm(): void {
    this.ctrl.releaseHelm();
  }
  protected doDropCursorStack(): void {
    this.ctrl.dropCursorStack();
  }
  protected setViewRadius(r: number): void {
    this.ctrl.viewRadius = r;
  }
  protected teleported(): boolean {
    return true;
  }
  protected acknowledged(): boolean {
    return true;
  }
}

// ====================================================================== network

/** How far a quantized pose (Pos32 x 3, NETCODE section 14) may put the pivot from the true one. */
const POSE_POSITION_PRECISION = Math.sqrt(3) * (0.5 / 512);
/** How far a quantized rotation (Rot64: each component to half of 1/32767) may turn it (radians, 2|dq|). */
const POSE_ANGLE_PRECISION = 2 * 2 * (0.5 / 32767);

class NetWorld extends BaseWorld {
  readonly mode = 'network';
  readonly me: NetMe;
  readonly harness: NetHarness;
  readonly client: HeadlessClient;

  constructor(sim: Simulation, viewRadius: number) {
    super(sim);
    this.harness = new NetHarness({ lockstep: true, starterItems: false });
    this.harness.serve(sim, sim.generator.spec(), testMeta());
    this.client = this.harness.addClient(ME, {}, { local: true, viewRadius });
    this.me = new NetMe(this);
    this.start();
  }

  /** The join (see READY): the Hello arrives; the start of the first tick (the join, Welcome) now. */
  protected join(): void {
    const h = this.harness;
    h.net.advanceTo(h.net.now);
    h.host.netServer.beforeTick();
  }
  protected step(): void {
    this.harness.step();
  }
  protected checkReady(): void {
    const c = this.client;
    if (c.own === null || c.intents === null) throw new Error(`network world: the client is not ready after ${READY_TICKS} ticks`);
  }
  carriedOverlap(carrier: Ship, box: AABB): number {
    const g = carrier.grid;
    let motion = 0;
    let lever = 0;
    for (const x of [box.minX, box.maxX]) {
      for (const y of [box.minY, box.maxY]) {
        for (const z of [box.minZ, box.maxZ]) {
          // the corner held in the carrier's frame, at its previous pose and at its present one
          const l = g.toLocal(vec3(x, y, z));
          const r = vec3(l.x - g.pivot.x, l.y - g.pivot.y, l.z - g.pivot.z);
          const was = qrotate(g.prevRotation, r);
          motion = Math.max(motion, Math.hypot(x - g.prevPosition.x - was.x, y - g.prevPosition.y - was.y, z - g.prevPosition.z - was.z));
          lever = Math.max(lever, Math.hypot(r.x, r.y, r.z));
        }
      }
    }
    return motion + POSE_POSITION_PRECISION + POSE_ANGLE_PRECISION * lever + 1e-6;
  }

  /** The end checks (see AFTER EACH TEST). */
  finish(): void {
    const c = this.client;
    // A world only read (never acted in) has a client that is not ready yet; and a scene changed
    // after the last tick reaches the client with the next one.
    this.ready();
    if (this.changed) this.tick();
    expect(c.status, 'the client is still connected').toBe('ready');
    expect(c.mismatches, 'per-frame checks of the client').toEqual([]);
    expect(this.harness.compareNow(c), "the client's replica equals the server").toEqual([]);
    expect(
      c.corrections.filter((x) => x.c.cause.startsWith('check:')).map((x) => `tick ${x.tick}: ${x.c.cause}`),
      'reports the server refused',
    ).toEqual([]);
  }
}

class NetMe extends BaseMe<NetWorld> {
  private get c(): HeadlessClient {
    return this.w.client;
  }
  protected heldKeys(): HeldKeys {
    return this.c.input;
  }
  protected movedBody(): Player {
    return this.c.own!.player;
  }
  protected doLookAt(x: number, y: number, z: number): void {
    this.c.lookAt(x, y, z);
  }
  protected doLookAtCell(x: number, y: number, z: number, face: Dir | undefined, gridId: number): boolean {
    return this.c.lookAtCell(x, y, z, face, gridId);
  }
  protected doAimAt(x: number, y: number, z: number, face: Dir | undefined, gridId: number, mining: boolean): boolean {
    return this.c.aimAt(x, y, z, face, gridId, mining);
  }
  protected doTargetCell(): (GridCell & { face: Dir }) | null {
    const t = this.c.target;
    return t === null ? null : { gridId: t.gridId, x: t.x, y: t.y, z: t.z, face: t.face as Dir };
  }
  protected doUse(): void {
    this.c.use();
  }
  protected doPressUse(): void {
    this.c.pressUse();
  }
  protected doReleaseUse(): void {
    this.c.releaseUse();
  }
  protected doPressAttack(cell: { x: number; y: number; z: number; face?: Dir; gridId: number }): void {
    this.c.holdAim(cell);
    this.c.pressAttack();
  }
  protected doReleaseAttack(): void {
    this.c.holdAim(null);
    if (this.c.intents?.attackHeld) this.c.releaseAttack();
  }
  protected doSwapHands(): void {
    this.c.swapHands();
  }
  protected inventory(): Inventory {
    return this.c.inventory;
  }
  protected modeNow(): GameMode {
    return this.c.mode;
  }
  protected doHold(item: number, count: number, give: boolean): void {
    const c = this.c;
    if (give) this.giveItem(item, count);
    else if (!this.inventory().hotbar.some((s) => s !== null && s.item === item && s.count > 0)) c.creativePick(item, true);
    const slot = c.inventory.hotbar.findIndex((s) => s !== null && s.item === item && s.count > 0);
    if (slot < 0) throw new Error(`hold: no ${item} in the hotbar`);
    if (slot !== c.inventory.selected) c.selectSlot(slot);
  }
  protected doEmptyHand(): void {
    this.c.emptyHand();
  }
  protected doGive(item: number, count: number): void {
    this.c.hostCommand({ kind: 'give', item, count });
  }
  protected doInvClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    this.c.invClick(area, index, button, shift);
  }
  protected doTeleport(x: number, y: number, z: number): void {
    this.c.hostCommand({ kind: 'teleport', x, y, z });
  }
  protected doSetFlying(flying: boolean): void {
    this.c.own!.player.flying = flying;
  }
  protected doSetMode(mode: GameMode): void {
    this.c.hostCommand({ kind: 'setPlayerMode', entityId: 0, mode });
  }
  protected doRespawn(): void {
    this.c.respawn();
  }
  protected doReleaseHelm(): void {
    this.c.releaseHelm();
  }
  protected doDropCursorStack(): void {
    this.c.dropCursor();
  }
  protected setViewRadius(r: number): void {
    this.c.setViewRadius(r);
  }
  protected teleported(): boolean {
    const own = this.c.own;
    const remote = this.player.remote;
    return own !== null && remote !== null && own.epoch === remote.epoch && !own.reloading;
  }
  protected acknowledged(): boolean {
    return this.c.intents!.settled;
  }
}
