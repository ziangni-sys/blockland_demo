/**
 * The browser game: owns the render backend, the UI, storage, worker pools, input and the
 * frame loop, and runs the session lifecycle
 *
 *   main menu -> (create | load) -> loading -> play <-> pause / inventory / settings / death
 *             <- save & quit <-
 *
 * Fixed-tick rule (DESIGN / ACCEPTANCE 21): the simulation ticks while playing and while the
 * inventory is open (movement zeroed); it does NOT tick on the main menu, loading, pause,
 * settings or death screens, so nothing on a deck moves while paused.
 */
import { DAY_TICKS } from '../core/constants';
import { hashString } from '../core/rng';
import { paintAllTiles } from '../art/tiles';
import { renderItemIcon } from '../art/icons';
import type { BackendInfo, RenderBackend } from '../render/backend';
import { createThreeBackend } from '../render/three/index';
import { openBestStorage } from '../save/idb';
import { SAVE_VERSION, type WorldMeta } from '../save/codec';
import { formatMessage } from '../sim/messages';
import { exportSave, importSave } from '../sim/persist';
import { Simulation } from '../sim/simulation';
import type { Message, SimEvent } from '../sim/view';
import type { MeshResponse } from '../mesh/types';
import { createUi } from '../ui/index';
import {
  DEFAULT_SETTINGS,
  type GameMode,
  type NewWorldOptions,
  type Screen,
  type Settings,
  type UiActions,
  type UiHandle,
  type WorldSummary,
} from '../ui/model';
import { TerrainGenerator } from '../worldgen/generator';
import type { GenErrorResponse, GenResponse } from '../worldgen/protocol';
import { describeError, Faults } from './faults';
import { InputState, type InputCommand, type LookSettings } from './input';
import { InputBinder, type InputHost } from './inputdom';
import { FixedStepClock, FrameLoop } from './loop';
import { makeWorldId, newWorldMeta, SaveManager, storageErrorCode } from './saves';
import { WorldSession } from './session';
import { applySettingsPatch, languageFromLocale, SettingsStore, type KeyValueStore } from './settings';
import { clientText, type ClientStringKey } from './strings';
import { ToastList } from './toasts';
import { UiStateBuilder } from './uistate';
import { createGenWorker, createMeshWorker } from './workerfactory';
import { WorkerPool } from './workers';

export const CLIENT_VERSION = '0.1.0';

/** Autosave interval in milliseconds of running simulation. */
export const AUTOSAVE_MS = 30_000;
/** Main-thread budget for streaming + meshing per frame while playing / while loading. */
const PLAY_WORK_BUDGET_MS = 4;
const LOADING_WORK_BUDGET_MS = 14;
/** How often frames are drawn while nothing moves (pause, death) or the loading screen covers them. */
const IDLE_RENDER_MS = 250;
const LOADING_RENDER_MS = 1000;
/** IndexedDB is given this long to open before the game falls back to memory storage. */
const STORAGE_TIMEOUT_MS = 5000;
/** A teleport longer than this (respawn far away) goes through the loading screen again. */
const RELOAD_DISTANCE = 48;
/** Esc events this soon after the pointer lock was lost belong to that same key press. */
const ESC_DEBOUNCE_MS = 300;

export interface GameEnv {
  win: Window;
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
}

interface FrameStats {
  fps: number;
  frameMs: number;
  tickMs: number;
  workMs: number;
  renderMs: number;
  ticks: number;
}

function safeLocalStorage(win: Window): KeyValueStore | null {
  try {
    const s = win.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export class Game implements InputHost {
  readonly version = CLIENT_VERSION;
  readonly input = new InputState();
  readonly faults: Faults;
  readonly toasts = new ToastList();
  readonly clock = new FixedStepClock();
  readonly backend: RenderBackend;

  settings: Settings;
  screen: Screen = 'mainMenu';
  settingsReturn: Screen = 'mainMenu';
  session: WorldSession | null = null;
  worlds: WorldSummary[] = [];
  backendInfo: BackendInfo | null = null;
  backendError: string | null = null;
  storagePersistent = false;
  storageReason = '';
  readonly stats: FrameStats = { fps: 0, frameMs: 0, tickMs: 0, workMs: 0, renderMs: 0, ticks: 0 };

  private readonly win: Window;
  private readonly canvas: HTMLCanvasElement;
  private readonly settingsStore: SettingsStore;
  private readonly ui: UiHandle;
  private readonly binder: InputBinder;
  private readonly loop: FrameLoop;
  private readonly uiBuilder = new UiStateBuilder();
  private saves: SaveManager | null = null;
  private storageReady: Promise<SaveManager> | null = null;
  private backendReady: Promise<boolean> | null = null;
  private genPool: WorkerPool<GenResponse | GenErrorResponse> | null = null;
  private meshPool: WorkerPool<MeshResponse> | null = null;
  private loading: { text: string; progress: number } | null = null;
  /** A menu action (create / load / quit) is in progress; further ones are ignored. */
  private busy = false;
  private envTime = 0;
  private lastCarriedYaw = 0;
  private lastRender = -Infinity;
  private renderDirty = true;
  private lockLostAt = -Infinity;
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;
  private hintMsg: Message | null = null;
  private hintLang = '';
  private hintText: string | null = null;
  private debugLines: string[] | null = null;
  private debugAt = -Infinity;
  private fpsFrames = 0;
  private fpsSince = 0;
  private tickTimeAcc = 0;
  private tickCountAcc = 0;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = (): void => this.resize();
  private readonly onVisibility = (): void => this.visibilityChanged();
  private readonly actions: UiActions;

  constructor(env: GameEnv) {
    this.win = env.win;
    this.canvas = env.canvas;
    this.settingsStore = new SettingsStore(safeLocalStorage(env.win));
    this.settings = this.settingsStore.load({ ...DEFAULT_SETTINGS, language: languageFromLocale(env.win.navigator?.language) });
    this.faults = new Faults(
      (rec) => this.toast(clientText(this.settings.language, 'fault', { what: rec.what, msg: rec.message }), 'error'),
      (msg, err) => console.error(msg, err),
    );
    this.backend = createThreeBackend();
    this.actions = this.makeActions();
    this.ui = createUi(env.uiRoot, this.actions, {
      iconProvider: (item, size) => {
        try {
          return renderItemIcon(item, size);
        } catch {
          return null;
        }
      },
    });
    this.binder = new InputBinder(env.win, env.canvas, this);
    this.loop = new FrameLoop(
      {
        request: (cb) => env.win.requestAnimationFrame(cb),
        cancel: (h) => env.win.cancelAnimationFrame(h),
        now: () => env.win.performance.now(),
      },
      (now, dt) => this.frame(now, dt),
    );
  }

  /** Boot: graphics, storage, worker pools, listeners and the frame loop. */
  start(): void {
    this.backendReady = this.initBackend();
    this.storageReady = this.openStorage();
    this.createPools();
    this.win.addEventListener('resize', this.onResize);
    this.win.document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.canvas);
    }
    this.loop.start();
  }

  // ================================================================== InputHost

  isPlaying(): boolean {
    return this.screen === 'none' && this.session !== null && this.session.state === 'ready';
  }
  inWorld(): boolean {
    return this.session !== null && this.session.state === 'ready';
  }
  wantsKeyboard(): boolean {
    return this.ui.wantsKeyboard();
  }
  lookSettings(): LookSettings {
    return this.settings;
  }
  command(cmd: InputCommand): void {
    switch (cmd) {
      case 'toggleInventory':
        if (this.screen === 'none') this.openInventory();
        else if (this.screen === 'inventory') this.closeInventory(true);
        break;
      case 'escape':
        this.escape();
        break;
      case 'toggleDebug':
        this.changeSettings({ showDebug: !this.settings.showDebug });
        break;
      default:
        break;
    }
  }
  onLockLost(): void {
    this.lockLostAt = this.win.performance.now();
    // Esc while locked only exits the lock (the key never reaches the page): that is "pause".
    if (this.isPlaying()) this.pause();
  }
  onPointerStateChange(): void {
    this.renderDirty = true;
  }

  // ================================================================== accessors (debug handle)

  /** The running simulation, if any. */
  get sim(): Simulation | null {
    return this.session?.sim ?? null;
  }
  get pointerLocked(): boolean {
    return this.binder.locked;
  }
  get dragLook(): boolean {
    return this.binder.dragLook;
  }
  get workerModes(): { terrain: string; mesh: string } {
    const mode = (p: WorkerPool<{ id: number }> | null): string => (!p ? 'main thread' : p.failed ? `main thread (${p.failReason})` : p.state);
    return { terrain: mode(this.genPool), mesh: mode(this.meshPool) };
  }

  // ================================================================== boot

  private async initBackend(): Promise<boolean> {
    try {
      this.resize();
      this.backendInfo = await this.backend.init(this.canvas);
      this.backend.setTiles(paintAllTiles());
      this.resize();
      return true;
    } catch (e) {
      this.backendError = describeError(e);
      console.error('[blocklands] graphics init failed', e);
      this.toast(clientText(this.settings.language, 'graphics.failed', { msg: this.backendError }), 'error');
      return false;
    }
  }

  private async openStorage(): Promise<SaveManager> {
    const giveUp = new Promise<void>((resolve) => this.win.setTimeout(resolve, STORAGE_TIMEOUT_MS));
    const best = await openBestStorage(undefined, { giveUp });
    this.storagePersistent = best.persistent;
    if (!best.persistent) {
      this.storageReason = best.reason;
      console.warn(`[blocklands] saving to memory only: ${best.error.message}`);
      this.toast(this.storageNotice(), 'warn');
    }
    this.saves = new SaveManager(best.storage);
    await this.refreshWorlds();
    return this.saves;
  }

  private storageNotice(): string {
    const key: ClientStringKey = this.storageReason === 'newer-version' ? 'storage.newer' : this.storageReason === 'blocked' ? 'storage.blocked' : 'storage.memory';
    return clientText(this.settings.language, key);
  }

  private createPools(): void {
    const now = (): number => this.win.performance.now();
    const warn = (what: string) => (reason: string) => console.warn(`[blocklands] ${what} workers unavailable, using the main thread: ${reason}`);
    if (typeof Worker === 'undefined') return;
    this.genPool = new WorkerPool<GenResponse | GenErrorResponse>({
      name: 'terrain',
      size: 2,
      create: createGenWorker,
      firstReplyTimeoutMs: 20_000,
      now,
      onFailed: warn('terrain'),
    });
    const cores = this.win.navigator?.hardwareConcurrency ?? 4;
    this.meshPool = new WorkerPool<MeshResponse>({
      name: 'mesh',
      size: cores >= 8 ? 3 : 2,
      create: createMeshWorker,
      firstReplyTimeoutMs: 20_000,
      now,
      onFailed: warn('mesh'),
    });
  }

  private async refreshWorlds(): Promise<void> {
    if (!this.saves) return;
    try {
      this.worlds = await this.saves.list();
    } catch (e) {
      this.faults.report('world list', e);
    }
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || this.win.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || this.win.innerHeight);
    // Cap the backing store: beyond ~4 MPx extra pixels cost far more than they show.
    let dpr = Math.min(2, this.win.devicePixelRatio || 1);
    const maxPixels = 2560 * 1600;
    if (w * h * dpr * dpr > maxPixels) dpr = Math.max(0.5, Math.sqrt(maxPixels / (w * h)));
    try {
      this.backend.resize(w, h, dpr);
    } catch (e) {
      this.faults.report('resize', e);
    }
    this.renderDirty = true;
  }

  private visibilityChanged(): void {
    if (this.win.document.visibilityState === 'hidden') {
      this.input.releaseAll();
      if (this.isPlaying()) this.pause();
      else void this.saveNow('autosave');
    } else {
      // Drop the hidden time instead of simulating it in a burst.
      this.loop.resetTimebase();
    }
  }

  // ================================================================== messages

  toast(text: string, kind: 'info' | 'warn' | 'error'): void {
    this.toasts.push(text, kind, this.win.performance.now());
  }

  private onSimEvent(ev: SimEvent): void {
    if (ev.type === 'toast') this.toast(formatMessage(this.settings.language, ev.message), ev.kind);
  }

  // ================================================================== screens

  private setScreen(s: Screen): void {
    if (this.screen === s) return;
    this.screen = s;
    this.renderDirty = true;
    if (s !== 'none') this.binder.cancelGesture();
  }

  private openInventory(): void {
    const s = this.session;
    if (!s || s.state !== 'ready') return;
    this.binder.exitLock();
    try {
      s.sim.releaseHelm();
    } catch (e) {
      this.faults.report('release helm', e);
    }
    this.setScreen('inventory');
  }

  /** Close the inventory; a stack left on the cursor goes back into the inventory (or is dropped). */
  private closeInventory(relock: boolean): void {
    const s = this.session;
    if (s) {
      try {
        const inv = s.sim.player.inventory;
        const c = inv.takeCursor();
        if (c) {
          const left = inv.add(c.item, c.count);
          if (left > 0) {
            inv.cursor = { item: c.item, count: left };
            s.sim.dropCursorStack();
          }
        }
      } catch (e) {
        this.faults.report('inventory', e);
      }
    }
    this.setScreen('none');
    if (relock) this.binder.requestLock();
  }

  private pause(): void {
    if (this.screen !== 'none' && this.screen !== 'inventory') return;
    if (this.screen === 'inventory') this.closeInventory(false);
    this.binder.exitLock();
    this.setScreen('pause');
    void this.saveNow('autosave');
  }

  private escape(): void {
    switch (this.screen) {
      case 'none':
        this.pause();
        break;
      case 'pause':
        // The Esc that released the pointer lock may also arrive as a key event: not a resume.
        if (this.win.performance.now() - this.lockLostAt > ESC_DEBOUNCE_MS) this.resume();
        break;
      case 'inventory':
        this.closeInventory(true);
        break;
      case 'settings':
        this.actions.closeSettings();
        break;
      default:
        break;
    }
  }

  private resume(): void {
    if (this.screen !== 'pause' || !this.inWorld()) return;
    this.setScreen('none');
    this.binder.requestLock();
  }

  // ================================================================== UI actions

  private makeActions(): UiActions {
    return {
      newWorld: (opts) => void this.newWorld(opts),
      loadWorld: (id) => void this.loadWorld(id),
      deleteWorld: (id) => void this.deleteWorld(id),
      resume: () => this.resume(),
      saveAndQuit: () => void this.saveAndQuit(),
      respawn: () => this.respawn(),
      openSettings: () => {
        if (this.screen !== 'mainMenu' && this.screen !== 'pause') return;
        this.settingsReturn = this.screen;
        this.setScreen('settings');
      },
      closeSettings: () => {
        if (this.screen !== 'settings') return;
        this.setScreen(this.settingsReturn === 'pause' && this.inWorld() ? 'pause' : 'mainMenu');
      },
      changeSettings: (patch) => this.changeSettings(patch),
      setMode: (mode) => this.setMode(mode),
      selectHotbar: (i) => this.input.selectSlot(i),
      slotClick: (area, index, button, shift) => {
        const s = this.session;
        if (!s || this.screen !== 'inventory') return;
        try {
          s.sim.player.inventory.slotClick(area, index, button, shift);
        } catch (e) {
          this.faults.report('inventory', e);
        }
      },
      creativePick: (item, shift) => {
        const s = this.session;
        if (!s || this.screen !== 'inventory' || s.sim.mode !== 'creative') return;
        try {
          s.sim.player.inventory.creativePick(item, shift);
        } catch (e) {
          this.faults.report('inventory', e);
        }
      },
      dropCursor: () => {
        const s = this.session;
        if (!s || this.screen !== 'inventory') return;
        try {
          s.sim.dropCursorStack();
        } catch (e) {
          this.faults.report('inventory', e);
        }
      },
      closeScreen: () => {
        if (this.screen === 'inventory') this.closeInventory(true);
        else if (this.screen === 'settings') this.actions.closeSettings();
        else if (this.screen === 'pause') this.resume();
      },
    };
  }

  changeSettings(patch: Partial<Settings>): void {
    const next = applySettingsPatch(this.settings, patch);
    if (next === this.settings) return;
    const rdChanged = next.renderDistance !== this.settings.renderDistance;
    this.settings = next;
    this.settingsStore.save(next);
    this.renderDirty = true;
    this.debugAt = -Infinity;
    const sim = this.sim;
    if (rdChanged && sim) sim.loadRadius = next.renderDistance;
  }

  private setMode(mode: GameMode): void {
    const sim = this.sim;
    if (!sim || (mode !== 'creative' && mode !== 'survival')) return;
    try {
      sim.setMode(mode);
    } catch (e) {
      this.faults.report('set mode', e);
    }
  }

  private respawn(): void {
    const s = this.session;
    if (!s || this.screen !== 'death') return;
    try {
      s.sim.respawn();
    } catch (e) {
      this.faults.report('respawn', e);
    }
    this.setScreen('none');
    this.binder.requestLock();
    this.checkTeleport(true);
  }

  private async graphicsReady(): Promise<boolean> {
    const ok = await (this.backendReady ?? Promise.resolve(false));
    if (!ok) this.toast(clientText(this.settings.language, 'graphics.failed', { msg: this.backendError ?? '?' }), 'error');
    return ok;
  }

  /** Let the loading screen paint before a long synchronous step. */
  private nextFrame(): Promise<void> {
    return new Promise((resolve) => this.win.requestAnimationFrame(() => this.win.setTimeout(resolve, 0)));
  }

  private showLoading(key: ClientStringKey, progress: number): void {
    this.loading = { text: clientText(this.settings.language, key), progress };
    this.setScreen('loading');
  }

  async newWorld(opts: NewWorldOptions): Promise<void> {
    if (this.busy || this.session) return;
    this.busy = true;
    try {
      this.showLoading('loading.graphics', 0);
      if (!(await this.graphicsReady())) return this.backToMenu();
      // Storage first: the initial save of the new world needs it.
      await (this.storageReady ?? this.openStorage());
      this.showLoading('loading.preparing', 0.02);
      await this.nextFrame();
      let seedText = typeof opts.seed === 'string' ? opts.seed.trim().slice(0, 64) : '';
      // An empty seed gets a random one, written as text so the world list shows a seed that
      // reproduces the world when typed in again.
      if (seedText === '') seedText = String(Math.floor(Math.random() * 0xffffffff) >>> 0);
      const seed = hashString(seedText);
      const mode: GameMode = opts.mode === 'survival' ? 'survival' : 'creative';
      const name = (typeof opts.name === 'string' && opts.name.trim()) || 'World';
      const generator = new TerrainGenerator(seed);
      const sim = new Simulation({ seed, mode, generator, loadRadius: this.settings.renderDistance });
      const id = makeWorldId(Date.now(), Math.random);
      const meta = newWorldMeta(id, name.slice(0, 64), seedText, seed, mode, Date.now());
      this.startSession(sim, meta, generator, true);
    } catch (e) {
      this.faults.report('new world', e);
      this.backToMenu();
    } finally {
      this.busy = false;
    }
  }

  async loadWorld(id: string): Promise<void> {
    if (this.busy || this.session) return;
    this.busy = true;
    const lang = this.settings.language;
    try {
      this.showLoading('loading.graphics', 0);
      if (!(await this.graphicsReady())) return this.backToMenu();
      const saves = await (this.storageReady ?? this.openStorage());
      this.showLoading('loading.reading', 0.02);
      const res = await saves.load(id);
      if (!res.ok) {
        const msg =
          res.reason === 'missing'
            ? clientText(lang, 'load.missing')
            : res.reason === 'newer'
              ? clientText(lang, 'load.newer')
              : clientText(lang, 'load.failed', { msg: describeError(res.error) });
        if (res.reason === 'error') console.error('[blocklands] load failed', res.error);
        this.toast(msg, 'error');
        return this.backToMenu();
      }
      this.showLoading('loading.preparing', 0.04);
      await this.nextFrame();
      const meta = res.meta;
      const generator = new TerrainGenerator(meta.seedHash);
      const sim = new Simulation({ seed: meta.seedHash, mode: meta.mode, generator, loadRadius: this.settings.renderDistance });
      try {
        importSave(sim, res.bundle);
      } catch (e) {
        console.error('[blocklands] save is unreadable', e);
        this.toast(clientText(lang, 'load.failed', { msg: describeError(e) }), 'error');
        return this.backToMenu();
      }
      this.startSession(sim, meta, generator, false);
    } catch (e) {
      this.faults.report('load world', e);
      this.backToMenu();
    } finally {
      this.busy = false;
    }
  }

  private async deleteWorld(id: string): Promise<void> {
    try {
      const saves = await (this.storageReady ?? this.openStorage());
      await saves.delete(id);
    } catch (e) {
      this.toast(clientText(this.settings.language, 'delete.failed', { msg: describeError(e) }), 'error');
    }
    await this.refreshWorlds();
  }

  private startSession(sim: Simulation, meta: WorldMeta, generator: TerrainGenerator, isNew: boolean): void {
    const session = new WorldSession(sim, meta, generator, isNew, {
      backend: this.backend,
      genPool: this.genPool,
      meshPool: this.meshPool,
      now: () => this.win.performance.now(),
      onError: (what, err) => this.faults.report(what, err),
      onEvent: (ev) => this.onSimEvent(ev),
    });
    this.session = session;
    const p = sim.player;
    this.input.releaseAll();
    this.input.setLook(p.yaw, p.pitch);
    this.input.selectSlot(p.inventory.selected);
    this.clock.reset();
    this.envTime = 0;
    this.lastCarriedYaw = 0;
    if (!this.storagePersistent && this.saves) this.toast(this.storageNotice(), 'warn');
    this.beginLoading();
  }

  /**
   * Enter (or re-enter, after a far respawn) the loading phase: one tick with zeroed input
   * sets the chunk manager's anchors at the player, then the simulation waits until the area
   * around the player is generated and meshed.
   */
  private beginLoading(): void {
    const s = this.session;
    if (!s) return;
    s.state = 'loading';
    this.binder.exitLock();
    this.input.writeTo(s.sim.player.input, false);
    this.runTick(s);
    this.showLoading('loading.terrain', 0.05);
  }

  private finishLoading(s: WorldSession): void {
    s.state = 'ready';
    this.loading = null;
    this.clock.reset();
    this.lastPlayerX = s.sim.player.pos.x;
    this.lastPlayerZ = s.sim.player.pos.z;
    this.setScreen(s.sim.player.dead ? 'death' : 'none');
    if (s.isNew && !s.savedOnce) void this.saveNow('initial');
  }

  private backToMenu(): void {
    this.loading = null;
    this.setScreen('mainMenu');
    void this.refreshWorlds();
  }

  async saveAndQuit(): Promise<void> {
    const s = this.session;
    if (!s || this.busy) return;
    this.busy = true;
    try {
      this.binder.exitLock();
      this.showLoading('loading.saving', 1);
      await this.saveNow('quit');
      await this.saves?.idle();
    } finally {
      this.endSession();
      this.busy = false;
      this.backToMenu();
    }
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.genPool?.cancelAll();
    this.meshPool?.cancelAll();
    s.dispose();
    this.input.releaseAll();
  }

  /**
   * Save the running world (serialized with any save in progress). Errors become toasts; the
   * returned promise never rejects.
   */
  async saveNow(reason: 'autosave' | 'initial' | 'quit'): Promise<boolean> {
    const s = this.session;
    const saves = this.saves;
    if (!s || !saves || s.state !== 'ready' || s.saveBlocked) return false;
    s.sinceAutosave = 0;
    try {
      await saves.save(() => {
        const sim = s.sim;
        const meta: WorldMeta = { ...s.meta, mode: sim.mode, lastPlayed: Date.now(), time: sim.world.time, version: SAVE_VERSION };
        const bundle = exportSave(sim);
        s.meta = meta;
        return { meta, bundle };
      });
      s.savedOnce = true;
      if (reason !== 'autosave' || this.worlds.every((w) => w.id !== s.meta.id)) void this.refreshWorlds();
      return true;
    } catch (e) {
      const lang = this.settings.language;
      const code = storageErrorCode(e);
      if (code === 'newer-version') {
        s.saveBlocked = true;
        this.toast(clientText(lang, 'save.newerWorld'), 'error');
      } else if (code === 'quota') {
        this.toast(clientText(lang, 'save.quota'), 'error');
      } else {
        console.error('[blocklands] save failed', e);
        this.toast(clientText(lang, 'save.failed', { msg: describeError(e) }), 'error');
      }
      return false;
    }
  }

  // ================================================================== frame

  private runTick(s: WorldSession): void {
    const t0 = this.win.performance.now();
    try {
      s.sim.tick();
    } catch (e) {
      this.faults.report('simulation tick', e);
    }
    this.tickTimeAcc += this.win.performance.now() - t0;
    this.tickCountAcc++;
    try {
      const turned = s.sim.player.takeCarriedYaw();
      this.input.addYaw(turned);
      this.lastCarriedYaw = turned;
    } catch {
      this.lastCarriedYaw = 0;
    }
  }

  /** After a respawn / teleport far away, show the loading screen until the area is ready. */
  private checkTeleport(force = false): void {
    const s = this.session;
    if (!s || s.state !== 'ready') return;
    const p = s.sim.player.pos;
    const far = Math.hypot(p.x - this.lastPlayerX, p.z - this.lastPlayerZ) > RELOAD_DISTANCE;
    this.lastPlayerX = p.x;
    this.lastPlayerZ = p.z;
    if (far || force) {
      const prog = s.loadingProgress();
      if (!prog.done) this.beginLoading();
    }
  }

  private frame(now: number, dt: number): void {
    const t0 = now;
    this.countFps(now);
    try {
      this.binder.update(now);
      this.toasts.update(now);
      this.genPool?.poll();
      this.meshPool?.poll();
    } catch (e) {
      this.faults.report('input', e);
    }
    const s = this.session;
    let rendered = false;
    if (s) {
      if (s.state === 'loading') rendered = this.loadingFrame(s, now, dt);
      else rendered = this.playFrame(s, now, dt);
    }
    if (!rendered) this.stats.renderMs = 0;
    this.updateUi(now);
    this.stats.frameMs = this.win.performance.now() - t0;
  }

  private loadingFrame(s: WorldSession, now: number, dt: number): boolean {
    const p = s.sim.player;
    const w0 = this.win.performance.now();
    s.work(now, LOADING_WORK_BUDGET_MS, p.pos.x, p.pos.y + p.eyeHeight, p.pos.z, Number.NaN);
    this.stats.workMs = this.win.performance.now() - w0;
    const prog = s.loadingProgress();
    const lang = this.settings.language;
    const text =
      prog.phase === 'terrain'
        ? clientText(lang, 'loading.terrain', { done: prog.chunksLoaded, total: prog.chunksNeeded })
        : prog.phase === 'meshing'
          ? clientText(lang, 'loading.meshing', { done: prog.sectionsReady, total: prog.sectionsNeeded })
          : clientText(lang, 'loading.finishing');
    this.loading = { text, progress: Math.max(0.05, prog.progress) };
    // Draw now and then behind the opaque loading screen: uploads the new meshes to the GPU
    // gradually instead of all in the first playable frame.
    let rendered = false;
    if (now - this.lastRender >= LOADING_RENDER_MS || prog.done) {
      s.present(this.clock.alpha, dt / 1000, this.input.yaw, this.input.pitch, this.settings.fov, this.settings.renderDistance, this.envTime, now);
      rendered = this.render(now);
    }
    if (prog.done) this.finishLoading(s);
    return rendered;
  }

  private playFrame(s: WorldSession, now: number, dt: number): boolean {
    const sim = s.sim;
    if (sim.player.dead && (this.screen === 'none' || this.screen === 'inventory')) {
      if (this.screen === 'inventory') this.closeInventory(false);
      this.binder.exitLock();
      this.setScreen('death');
    }
    const running = this.screen === 'none' || this.screen === 'inventory';
    const playing = this.screen === 'none';
    const n = this.clock.advance(dt, running);
    for (let i = 0; i < n; i++) {
      // Written before every tick: presses go to the first one, the look direction (turned by
      // a carrier during the previous tick) to each.
      this.input.writeTo(sim.player.input, playing);
      this.runTick(s);
    }
    if (n === 0) this.input.writeTo(sim.player.input, playing);
    if (this.tickCountAcc >= 20) {
      this.stats.tickMs = this.tickTimeAcc / this.tickCountAcc;
      this.tickTimeAcc = 0;
      this.tickCountAcc = 0;
    }
    this.stats.ticks += n;
    if (running) {
      this.envTime += dt / 1000;
      s.sinceAutosave += dt;
      if (s.sinceAutosave >= AUTOSAVE_MS) void this.saveNow('autosave');
    }
    if (n > 0) this.checkTeleport();
    if (s.state !== 'ready') return false;

    const alpha = this.clock.alpha;
    // The last tick turned the player with the ship by lastCarriedYaw; blend that turn in
    // with alpha like the ship's own pose, or the view would turn in 20 Hz steps.
    const yaw = this.input.yaw - this.lastCarriedYaw * (1 - alpha);
    const cam = s.view.camera;
    const w0 = this.win.performance.now();
    s.work(now, PLAY_WORK_BUDGET_MS, cam.x, cam.y, cam.z, yaw);
    this.stats.workMs = this.win.performance.now() - w0;
    // While nothing moves (pause, death, settings) a frame now and then is enough.
    if (!running && !this.renderDirty && now - this.lastRender < IDLE_RENDER_MS) return false;
    s.present(alpha, dt / 1000, yaw, this.input.pitch, this.settings.fov, this.settings.renderDistance, this.envTime, now);
    return this.render(now);
  }

  private render(now: number): boolean {
    const r0 = this.win.performance.now();
    try {
      this.backend.render();
    } catch (e) {
      this.faults.report('rendering', e);
    }
    this.stats.renderMs = this.win.performance.now() - r0;
    this.lastRender = now;
    this.renderDirty = false;
    return true;
  }

  private countFps(now: number): void {
    this.fpsFrames++;
    if (this.fpsSince === 0) this.fpsSince = now;
    const span = now - this.fpsSince;
    if (span >= 500) {
      this.stats.fps = (this.fpsFrames * 1000) / span;
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
  }

  // ================================================================== UI

  private updateUi(now: number): void {
    try {
      const s = this.session;
      const sim = s && s.state === 'ready' ? s.sim : null;
      const p = sim ? sim.player : null;
      let hint: string | null = null;
      if (sim && this.screen === 'none') {
        const msg = sim.view.hint;
        if (msg !== this.hintMsg || this.settings.language !== this.hintLang) {
          this.hintMsg = msg;
          this.hintLang = this.settings.language;
          this.hintText = msg ? formatMessage(this.settings.language, msg) : null;
        }
        hint = this.hintText;
      }
      if (this.settings.showDebug && sim) {
        if (now - this.debugAt >= 250) {
          this.debugAt = now;
          this.debugLines = this.buildDebug(s!);
        }
      } else {
        this.debugLines = null;
      }
      const state = this.uiBuilder.build({
        screen: this.screen,
        settingsReturn: this.settingsReturn,
        mode: sim ? sim.mode : 'creative',
        inventory: p ? p.inventory : null,
        selected: this.input.slot,
        health: p ? p.health : 20,
        maxHealth: p ? p.maxHealth : 20,
        air: p ? p.air : 300,
        maxAir: p ? p.maxAir : 300,
        hint,
        toasts: this.toasts.list,
        debug: this.debugLines,
        helm: sim && this.screen === 'none' ? sim.helmView() : null,
        worlds: this.worlds,
        settings: this.settings,
        loading: this.screen === 'loading' ? this.loading : null,
        pointerLocked: this.binder.dragLook ? this.binder.engaged : this.binder.locked,
        dragLook: this.binder.dragLook,
        renderer: this.backendInfo ? (this.backendInfo.api === 'webgpu' ? 'WebGPU' : 'WebGL2') : this.backendError ? '—' : '…',
        version: this.version,
      });
      this.ui.update(state);
    } catch (e) {
      this.faults.report('UI', e);
    }
  }

  private buildDebug(s: WorldSession): string[] {
    const sim = s.sim;
    const p = sim.player;
    const st = this.stats;
    const rs = this.backend.stats();
    const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(1);
    const yawDeg = (((this.input.yaw * 180) / Math.PI) % 360 + 360) % 360;
    const facing = ['north', 'west', 'south', 'east'][Math.round(yawDeg / 90) % 4];
    const ms = s.mesher.stats;
    const cs = s.streamer.stats;
    const ships = sim.structures.ships().length;
    const rotors = sim.structures.rotors().length;
    const t = sim.view.target;
    const day = sim.world.time % DAY_TICKS;
    const hh = Math.floor(((day / DAY_TICKS) * 24 + 6) % 24);
    const mm = Math.floor((((day / DAY_TICKS) * 24 * 60) % 60));
    const lines = [
      `Blocklands ${this.version} · ${this.backendInfo?.detail ?? '?'}`,
      `${st.fps.toFixed(0)} fps · frame ${st.frameMs.toFixed(1)} ms · tick ${st.tickMs.toFixed(2)} ms · work ${st.workMs.toFixed(1)} ms · render ${st.renderMs.toFixed(1)} ms`,
      `xyz ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)} · chunk ${Math.floor(p.pos.x) >> 4}, ${Math.floor(p.pos.z) >> 4}`,
      `facing ${facing} (yaw ${deg(this.input.yaw)}°, pitch ${deg(this.input.pitch)}°)${p.flying ? ' · flying' : ''}${p.carrierId ? ` · on #${p.carrierId}` : ''}`,
      `chunks ${sim.world.chunks.size} · gen ${cs.inFlight} in flight, ${cs.waiting} waiting · provide ${cs.provideMs.toFixed(1)} ms`,
      `sections ${s.mesher.meshedCount} meshed · queue ${ms.queued} · jobs ${ms.inFlight} · drawn ${rs.sections}`,
      `structures ${sim.structures.all().length} (${ships} ships, ${rotors} rotors) · entities ${sim.entities.all().length}`,
      `draw calls ${rs.drawCalls} · triangles ${(rs.triangles / 1000).toFixed(0)}k`,
      t ? `target ${t.gridId === 0 ? 'world' : `#${t.gridId}`} ${t.x} ${t.y} ${t.z} face ${t.face}` : 'target —',
      `time ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} (tick ${sim.world.time}) · ${sim.mode}`,
      `storage ${this.storagePersistent ? 'IndexedDB' : `memory (${this.storageReason || '…'})`} · workers ${this.workerModes.terrain} / ${this.workerModes.mesh}`,
    ];
    for (const f of this.faults.recent) lines.push(`! ${f.what}: ${f.message}${f.count > 1 ? ` ×${f.count}` : ''}`);
    return lines;
  }

  // ================================================================== debug helpers

  /** Scripting / debugging helpers exposed on window.__blocklands. */
  readonly debug = {
    /** Summary of the running state (used by the e2e smoke test). */
    state: (): Record<string, unknown> => {
      const s = this.session;
      const sim = s?.sim;
      return {
        screen: this.screen,
        sessionState: s?.state ?? null,
        renderer: this.backendInfo?.api ?? null,
        rendererDetail: this.backendInfo?.detail ?? null,
        storagePersistent: this.storagePersistent,
        pointerLocked: this.binder.locked,
        dragLook: this.binder.dragLook,
        chunks: sim ? sim.world.chunks.size : 0,
        sectionsMeshed: s ? s.mesher.meshedCount : 0,
        sectionsDrawn: this.backend.stats().sections,
        meshQueue: s ? s.mesher.stats.queued : 0,
        player: sim ? { x: sim.player.pos.x, y: sim.player.pos.y, z: sim.player.pos.z, dead: sim.player.dead, mode: sim.mode } : null,
        target: sim ? sim.view.target : null,
        worldTime: sim ? sim.world.time : 0,
        worlds: this.worlds.map((w) => ({ id: w.id, name: w.name })),
        worldId: s ? s.meta.id : null,
        faults: this.faults.recent.map((f) => `${f.what}: ${f.message}`),
        stats: { ...this.stats },
        workers: this.workerModes,
      };
    },
    /** Set the world clock (0..1 of a day, 0 = sunrise) — night screenshots. */
    setDayTime: (t: number): void => {
      const sim = this.sim;
      if (!sim || !Number.isFinite(t)) return;
      const day = Math.floor(sim.world.time / DAY_TICKS);
      sim.world.time = Math.max(0, Math.floor((day + (((t % 1) + 1) % 1)) * DAY_TICKS));
      this.renderDirty = true;
    },
    /** Point the view (radians). */
    look: (yaw: number, pitch: number): void => {
      this.input.setLook(yaw, pitch);
      this.renderDirty = true;
    },
    /** Move the player (feet). */
    teleport: (x: number, y: number, z: number): void => {
      const sim = this.sim;
      if (!sim) return;
      sim.player.setPosition(x, y, z);
      this.renderDirty = true;
    },
    /** World cell value at integer coordinates. */
    cell: (x: number, y: number, z: number): number => this.sim?.world.getCell(x, y, z) ?? -1,
    /** Put a stack in the selected hotbar slot (creative testing). */
    give: (item: number): void => {
      const sim = this.sim;
      if (!sim) return;
      sim.player.inventory.creativePick(item, true);
      const idx = sim.player.inventory.hotbar.findIndex((st) => st !== null && st.item === item);
      if (idx >= 0) this.input.selectSlot(idx);
    },
    /** Save immediately (returns whether it succeeded). */
    save: (): Promise<boolean> => this.saveNow('autosave'),
    backendStats: () => this.backend.stats(),
  };
}
