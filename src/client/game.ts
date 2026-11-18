/**
 * The browser game: owns the render backend, the UI, the page's storage (the world list), worker
 * pools, input and the frame loop, the game server of the open world, and runs the session
 * lifecycle
 *
 *   main menu -> (create | load) -> loading -> play <-> pause / inventory / settings / death
 *             <- save & quit <-
 *
 * MULTIPLAYER FIRST (docs/NETCODE.md sections 1, 15: package 9). The game never touches a
 * Simulation. Opening a world starts the page's own game server (client/server.ts LocalServer: a
 * ServerHost in a Worker, else on the main thread behind a MessageChannel) with a host control
 * message (`create` with the world's meta: the server places the example windmill boat and gives
 * the starter items; or `load`), and connects a NetClient to it through a PortTransport as the
 * host's own connection (client/session.ts WorldSession). Everything the player does goes out as
 * intents, everything shown comes from the replica. The server saves (the first save of a new
 * world, every 30 s of running world, on the pause menu's `save`, on `shutdown`); the page only
 * reads the world list from the same database and deletes worlds (client/saves.ts).
 *
 * PAUSE (single player, section 4). The pause menu (and the settings opened from it, and the death
 * screen, as in M1) pause the world: the client holds first (NetClient.setPaused), then the server
 * stops ticking (host control `pause`); resuming goes the other way round. The inventory screen
 * does not pause: the world runs on and the player stands still.
 *
 * SAVE & QUIT. `shutdown { save: true }`: the server closes only once the world is written. When
 * the save fails it runs on: the world stays open, the pause / death screen says so and offers
 * "Quit without saving" (LESSONS 保存失败仍然退出).
 *
 * The player's identity is the browser's stored random key (client/identity.ts; `?slot=` picks
 * another). The player's mode, the time of day, teleport and give (debug helpers) are host
 * commands.
 */
import { hashString } from '../core/rng';
import { paintAllTiles } from '../art/tiles';
import { renderItemIcon } from '../art/icons';
import type { MeshResponse } from '../mesh/types';
import type { HostToPage } from '../net/host/control';
import type { HostCommand } from '../net/protocol';
import type { BackendInfo, RenderBackend } from '../render/backend';
import { createThreeBackend } from '../render/three/index';
import type { WorldMeta } from '../save/codec';
import { openBestStorage } from '../save/idb';
import type { SaveStorage } from '../save/storage';
import { formatMessage } from '../sim/messages';
import { Rotor, Ship } from '../structures/structure';
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
import type { GenErrorResponse, GenResponse } from '../worldgen/protocol';
import { nextViewMode, type ViewMode } from './camera';
import { debugLines } from './debug';
import { describeError, Faults } from './faults';
import { DEFAULT_PLAYER_NAME, pageRandom, playerKeyFor, slotFromSearch } from './identity';
import { InputState, type InputCommand, type LookSettings } from './input';
import { InputBinder, type InputHost } from './inputdom';
import { FrameLoop } from './loop';
import { checkWorld, listWorlds, makeWorldId, newWorldMeta } from './saves';
import { LocalServer, type OpenCommand, type ServerWay } from './server';
import { WorldSession } from './session';
import { applySettingsPatch, languageFromLocale, SettingsStore, type KeyValueStore } from './settings';
import { clientText, type ClientStringKey } from './strings';
import { ToastList } from './toasts';
import { UiStateBuilder } from './uistate';
import { installFormSubmitShim } from './uishim';
import {
  createGenWorker,
  createGenWorkerFromDataUrl,
  createMeshWorker,
  createMeshWorkerFromDataUrl,
  createServerOnMainThread,
  createServerWorker,
  createServerWorkerFromDataUrl,
} from './workerfactory';
import { WorkerPool } from './workers';

export const CLIENT_VERSION = '0.1.0';

/** Main-thread budget for terrain delivery + meshing per frame while playing / while loading. */
const PLAY_WORK_BUDGET_MS = 4;
const LOADING_WORK_BUDGET_MS = 14;
/** How often frames are drawn while nothing moves (pause, death) or the loading screen covers them. */
const IDLE_RENDER_MS = 250;
const LOADING_RENDER_MS = 1000;
/** IndexedDB is given this long to open before the page falls back to memory storage. */
const STORAGE_TIMEOUT_MS = 5000;
/** Esc events this soon after the pointer lock was lost belong to that same key press. */
const ESC_DEBOUNCE_MS = 300;
/** A server that answers nothing this long after its first command is given up (the next way is tried). */
const SERVER_FIRST_REPLY_MS = 20_000;
/** How long save & quit waits for the server to save and close. */
const SHUTDOWN_SAVE_MS = 60_000;
/** The network client's heartbeat (Ping, reconnection): a timer, so it runs while the page is hidden. */
const HEARTBEAT_MS = 1000;
/** No stall hint this soon after the world resumed (the first batch is on its way). */
const RESUME_QUIET_MS = 1500;
/** The traffic rates of the debug overlay are measured over this long. */
const TRAFFIC_WINDOW_MS = 1000;

export interface GameEnv {
  win: Window;
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
}

interface FrameStats {
  fps: number;
  frameMs: number;
  workMs: number;
  renderMs: number;
  /** The server's tick time (its tickTime reports), mean and longest over the last report. */
  serverTickMs: number;
  serverTickMaxMs: number;
}

function safeLocalStorage(win: Window): KeyValueStore | null {
  try {
    const s = win.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function search(win: Window): string {
  try {
    return win.location?.search ?? '';
  } catch {
    return '';
  }
}

export class Game implements InputHost {
  readonly version = CLIENT_VERSION;
  readonly input = new InputState();
  readonly faults: Faults;
  readonly toasts = new ToastList();
  readonly backend: RenderBackend;
  /** This browser's player key (client/identity.ts). */
  readonly playerKey: string;

  settings: Settings;
  screen: Screen = 'mainMenu';
  settingsReturn: Screen = 'mainMenu';
  session: WorldSession | null = null;
  /** The open world's game server. */
  server: LocalServer | null = null;
  /** The open world's meta as the server reported it. */
  worldMeta: WorldMeta | null = null;
  /** What the open world's server said about its storage (`ready`). */
  worldPersistent = false;
  worlds: WorldSummary[] = [];
  backendInfo: BackendInfo | null = null;
  backendError: string | null = null;
  /** The page's own storage (the world list). */
  storagePersistent = false;
  storageReason = '';
  readonly stats: FrameStats = { fps: 0, frameMs: 0, workMs: 0, renderMs: 0, serverTickMs: 0, serverTickMaxMs: 0 };
  /** Camera mode (F5): first person, third person from behind, from the front. Client only. */
  viewMode: ViewMode = 'first';

  private readonly win: Window;
  private readonly canvas: HTMLCanvasElement;
  private readonly settingsStore: SettingsStore;
  private readonly ui: UiHandle;
  private readonly binder: InputBinder;
  private readonly loop: FrameLoop;
  private readonly uiBuilder = new UiStateBuilder();
  private storage: SaveStorage | null = null;
  private storageReady: Promise<SaveStorage> | null = null;
  private backendReady: Promise<boolean> | null = null;
  private genPool: WorkerPool<GenResponse | GenErrorResponse> | null = null;
  private meshPool: WorkerPool<MeshResponse> | null = null;
  private loading: { text: string; progress: number } | null = null;
  /** A menu action (create / load / quit) is in progress; further ones are ignored. */
  private busy = false;
  /**
   * The last "Save & quit" could not write the world: the world stays open and the pause /
   * death screen offers an explicit "Quit without saving" (window.confirm does nothing in the
   * host page). Cleared by the next successful save and when the session ends.
   */
  private quitUnsaved = false;
  /** A newer build wrote the open world: it is never written again (quitting does not try). */
  private saveBlocked = false;
  /** The world is closing on purpose (its server's Kick(shutdown) is expected). */
  private quitting = false;
  /** The page paused the world (single player). */
  private worldPaused = false;
  private resumedAt = -Infinity;
  private envTime = 0;
  private lastRender = -Infinity;
  private renderDirty = true;
  private lockLostAt = -Infinity;
  private hintMsg: unknown = null;
  private hintLang = '';
  private hintText: string | null = null;
  private debugLines: string[] | null = null;
  private debugAt = -Infinity;
  private fpsFrames = 0;
  private fpsSince = 0;
  private serverTps: number | null = null;
  private readonly traffic = { at: -Infinity, in: 0, out: 0, inRate: 0, outRate: 0 };
  private heartbeat: unknown = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = (): void => this.resize();
  private readonly onVisibility = (): void => this.visibilityChanged();
  private readonly actions: UiActions;

  constructor(env: GameEnv) {
    this.win = env.win;
    this.canvas = env.canvas;
    const local = safeLocalStorage(env.win);
    this.settingsStore = new SettingsStore(local);
    this.settings = this.settingsStore.load({ ...DEFAULT_SETTINGS, language: languageFromLocale(env.win.navigator?.language) });
    this.playerKey = playerKeyFor(local, slotFromSearch(search(env.win)), pageRandom(env.win));
    this.faults = new Faults(
      (rec) => this.toast(clientText(this.settings.language, 'fault', { what: rec.what, msg: rec.message }), 'error'),
      (msg, err) => console.error(msg, err),
    );
    // Adding #webgl2 to the page address forces the WebGL2 backend (an escape hatch for
    // machines where the WebGPU path misbehaves).
    this.backend = createThreeBackend({ forceWebGL: wantsWebGL2(env.win) });
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
    // Sandboxed hosts without allow-forms never deliver form submit events (see uishim.ts).
    installFormSubmitShim(env.uiRoot);
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
    this.heartbeat = this.win.setInterval(() => this.session?.heartbeat(this.win.performance.now()), HEARTBEAT_MS);
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
      case 'cycleView':
        if (this.inWorld()) {
          this.viewMode = nextViewMode(this.viewMode);
          this.renderDirty = true;
        }
        break;
      case 'pickBlock':
        this.pickBlock();
        break;
      default:
        break;
    }
  }
  /**
   * Middle click: the looked-at block in hand (a predicted inventory action: the shown inventory
   * selects its slot at once, and the hotbar selection follows it).
   */
  private pickBlock(): void {
    const s = this.session;
    if (!s || !this.isPlaying()) return;
    try {
      s.pickBlock();
    } catch (e) {
      this.faults.report('pick block', e);
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

  get pointerLocked(): boolean {
    return this.binder.locked;
  }
  get dragLook(): boolean {
    return this.binder.dragLook;
  }
  get workerModes(): { terrain: string; mesh: string; server: string } {
    const mode = (p: WorkerPool<{ id: number }> | null): string => (!p ? 'main thread' : p.failed ? `main thread (${p.failReason})` : p.state);
    return { terrain: mode(this.genPool), mesh: mode(this.meshPool), server: this.server?.mode ?? '—' };
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

  /** The page's storage: the world list (the game server opens the same database for saving). */
  private async openStorage(): Promise<SaveStorage> {
    const giveUp = new Promise<void>((resolve) => this.win.setTimeout(resolve, STORAGE_TIMEOUT_MS));
    const best = await openBestStorage(undefined, { giveUp });
    this.storagePersistent = best.persistent;
    if (!best.persistent) {
      this.storageReason = best.reason;
      console.warn(`[blocklands] saving to memory only: ${best.error.message}`);
      this.toast(this.storageNotice(best.reason), 'warn');
    }
    this.storage = best.storage;
    await this.refreshWorlds();
    return best.storage;
  }

  private storageNotice(reason: string): string {
    const key: ClientStringKey = reason === 'newer-version' ? 'storage.newer' : reason === 'blocked' ? 'storage.blocked' : 'storage.memory';
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
      alternatives: [createGenWorkerFromDataUrl],
      firstReplyTimeoutMs: 20_000,
      now,
      onFailed: warn('terrain'),
    });
    const cores = this.win.navigator?.hardwareConcurrency ?? 4;
    this.meshPool = new WorkerPool<MeshResponse>({
      name: 'mesh',
      size: cores >= 8 ? 3 : 2,
      create: createMeshWorker,
      alternatives: [createMeshWorkerFromDataUrl],
      firstReplyTimeoutMs: 20_000,
      now,
      onFailed: warn('mesh'),
    });
  }

  /** Ways of starting the game server, in the order they are tried (client/server.ts). */
  private serverWays(): ServerWay[] {
    const ways: ServerWay[] = [];
    if (typeof Worker !== 'undefined') {
      ways.push({ mode: 'worker', create: createServerWorker }, { mode: 'worker (data URL)', create: createServerWorkerFromDataUrl });
    }
    ways.push({ mode: 'main thread', create: createServerOnMainThread });
    return ways;
  }

  private async refreshWorlds(): Promise<void> {
    if (!this.storage) return;
    try {
      this.worlds = await listWorlds(this.storage);
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
    const hidden = this.win.document.visibilityState === 'hidden';
    // A hidden page has no frames: the network client applies what arrives as it arrives.
    this.session?.setHidden(hidden);
    if (hidden) {
      this.input.releaseAll();
      if (this.isPlaying()) this.pause();
      else if (this.session) this.server?.post({ type: 'save' });
    } else {
      // Drop the hidden time instead of catching up in a burst.
      this.loop.resetTimebase();
    }
  }

  // ================================================================== messages

  toast(text: string, kind: 'info' | 'warn' | 'error'): void {
    this.toasts.push(text, kind, this.win.performance.now());
  }

  /** A report of the open world's server (client/server.ts LocalServer.onReport). */
  private onServerReport(server: LocalServer, m: HostToPage): void {
    if (server !== this.server) return;
    const lang = this.settings.language;
    switch (m.type) {
      case 'saved':
        if (m.ok) {
          this.quitUnsaved = false;
          if (this.worldMeta && this.worlds.every((w) => w.id !== this.worldMeta!.id)) void this.refreshWorlds();
        } else if (m.code === 'newer-version') {
          this.saveBlocked = true;
          this.toast(clientText(lang, 'save.newerWorld'), 'error');
        } else if (m.code === 'quota') {
          this.toast(clientText(lang, 'save.quota'), 'error');
        } else {
          console.error('[blocklands] save failed', m.code);
          this.toast(clientText(lang, 'save.failed', { msg: m.code ?? '?' }), 'error');
        }
        break;
      case 'status':
        this.serverTps = m.tps;
        break;
      case 'tickTime':
        this.stats.serverTickMs = m.meanMs;
        this.stats.serverTickMaxMs = m.maxMs;
        break;
      case 'error':
        if (m.what === 'shutdown') break; // save & quit handles it
        if (m.what === 'pause') {
          // The server refused to pause (its room is open): the client must not hold either.
          this.worldPaused = false;
          this.session?.setPaused(false);
          break;
        }
        if (m.what === 'tick') {
          console.error('[blocklands] the world stopped', m.message);
          this.toast(clientText(lang, 'server.stopped', { msg: m.message.split('\n')[0] ?? '' }), 'error');
          break;
        }
        this.faults.report(`server ${m.what}`, new Error(m.message));
        break;
      default:
        break;
    }
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
      // Scenario 21: opening the inventory lets go of the helm.
      s.releaseHelm();
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
        s.closeInventory();
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
    this.pauseWorld(true);
    this.server?.post({ type: 'save' });
  }

  /**
   * Single-player pause (section 4): the client holds before the server stops, and the server
   * goes on before the client does.
   */
  private pauseWorld(paused: boolean): void {
    const s = this.session;
    const server = this.server;
    if (!s || !server || this.worldPaused === paused) return;
    this.worldPaused = paused;
    if (paused) {
      s.setPaused(true);
      server.post({ type: 'pause', paused: true });
    } else {
      server.post({ type: 'pause', paused: false });
      s.setPaused(false);
      this.resumedAt = this.win.performance.now();
    }
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
    this.pauseWorld(false);
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
      quitWithoutSaving: () => this.quitWithoutSaving(),
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
          s.invClick(area, index, button, shift);
        } catch (e) {
          this.faults.report('inventory', e);
        }
      },
      creativePick: (item, shift) => {
        const s = this.session;
        if (!s || this.screen !== 'inventory') return;
        try {
          s.creativePick(item, shift);
        } catch (e) {
          this.faults.report('inventory', e);
        }
      },
      dropCursor: () => {
        const s = this.session;
        if (!s || this.screen !== 'inventory') return;
        try {
          s.dropCursor();
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
    if (rdChanged) this.session?.setViewRadius(loadRadiusFor(next.renderDistance));
  }

  /**
   * The pause menu's mode switch: this player's mode and the world's rules with it (host
   * commands, section 10), as single player always did.
   */
  private setMode(mode: GameMode): void {
    const s = this.session;
    if (!s || (mode !== 'creative' && mode !== 'survival')) return;
    try {
      s.requestMode(mode);
    } catch (e) {
      this.faults.report('set mode', e);
    }
  }

  private respawn(): void {
    const s = this.session;
    if (!s || this.screen !== 'death') return;
    // The server must run to carry the respawn out.
    this.pauseWorld(false);
    try {
      s.respawn();
    } catch (e) {
      this.faults.report('respawn', e);
    }
    this.setScreen('none');
    this.binder.requestLock();
  }

  private async graphicsReady(): Promise<boolean> {
    const ok = await (this.backendReady ?? Promise.resolve(false));
    if (!ok) this.toast(clientText(this.settings.language, 'graphics.failed', { msg: this.backendError ?? '?' }), 'error');
    return ok;
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
      await (this.storageReady ?? this.openStorage());
      this.showLoading('loading.server', 0.02);
      let seedText = typeof opts.seed === 'string' ? opts.seed.trim().slice(0, 64) : '';
      // An empty seed gets a random one, written as text so the world list shows a seed that
      // reproduces the world when typed in again.
      if (seedText === '') seedText = String(Math.floor(Math.random() * 0xffffffff) >>> 0);
      const seed = hashString(seedText);
      const mode: GameMode = opts.mode === 'survival' ? 'survival' : 'creative';
      const name = (typeof opts.name === 'string' && opts.name.trim()) || 'World';
      const meta = newWorldMeta(makeWorldId(Date.now(), Math.random), name.slice(0, 64), seedText, seed, mode, Date.now());
      // The server makes the terrain world of the seed, places the example windmill boat, saves
      // the world once and gives this player the starter items when it joins.
      if (!(await this.openWorld({ type: 'create', meta, options: {} }))) this.backToMenu();
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
      const storage = await (this.storageReady ?? this.openStorage());
      this.showLoading('loading.reading', 0.02);
      const res = await checkWorld(storage, id);
      if (!res.ok) {
        const msg =
          res.reason === 'missing'
            ? clientText(lang, 'load.missing')
            : res.reason === 'newer'
              ? clientText(lang, 'load.newer')
              : res.reason === 'older'
                ? clientText(lang, 'load.older')
                : clientText(lang, 'load.failed', { msg: describeError(res.error) });
        if (res.reason === 'error') console.error('[blocklands] load failed', res.error);
        this.toast(msg, 'error');
        return this.backToMenu();
      }
      this.showLoading('loading.server', 0.04);
      if (!(await this.openWorld({ type: 'load', worldId: id }))) this.backToMenu();
    } catch (e) {
      this.faults.report('load world', e);
      this.backToMenu();
    } finally {
      this.busy = false;
    }
  }

  private async deleteWorld(id: string): Promise<void> {
    try {
      const storage = await (this.storageReady ?? this.openStorage());
      await storage.deleteWorld(id);
    } catch (e) {
      this.toast(clientText(this.settings.language, 'delete.failed', { msg: describeError(e) }), 'error');
    }
    await this.refreshWorlds();
  }

  /**
   * Start a game server for the world `command` names and connect to it. False (the server is
   * gone again, the player was told why) when it could not be started or could not open the world.
   */
  private async openWorld(command: OpenCommand): Promise<boolean> {
    const lang = this.settings.language;
    const server: LocalServer = new LocalServer({
      ways: this.serverWays(),
      firstReplyTimeoutMs: SERVER_FIRST_REPLY_MS,
      setTimer: (fn, ms) => this.win.setTimeout(fn, ms),
      clearTimer: (h) => this.win.clearTimeout(h as number),
      onReport: (m) => this.onServerReport(server, m),
      onCrash: () => {
        if (server !== this.server) return;
        console.error('[blocklands] the game server stopped');
        this.toast(clientText(this.settings.language, 'server.crashed'), 'error');
      },
    });
    let first: HostToPage;
    try {
      first = await server.start(command);
    } catch (e) {
      console.error('[blocklands] the game server could not be started', e);
      this.toast(clientText(lang, 'server.failed', { msg: describeError(e) }), 'error');
      server.terminate();
      return false;
    }
    if (first.type !== 'ready') {
      const msg = first.type === 'error' ? first.message : first.type;
      console.error('[blocklands] the game server could not open the world', msg);
      this.toast(clientText(lang, command.type === 'load' ? 'load.failed' : 'server.failed', { msg }), 'error');
      server.terminate();
      return false;
    }
    if (server.failures.length > 0) console.warn(`[blocklands] game server: ${server.failures.join('; ')}; running as ${server.mode}`);
    this.server = server;
    this.worldMeta = first.meta;
    this.worldPersistent = first.persistent;
    if (!first.persistent) {
      console.warn(`[blocklands] the world is kept in memory only: ${first.reason ?? '?'}`);
      this.toast(this.storageNotice(first.reason ?? ''), 'warn');
    }
    if (command.type === 'create') void this.refreshWorlds();
    this.startSession(server);
    return true;
  }

  private startSession(server: LocalServer): void {
    const session: WorldSession = new WorldSession({
      backend: this.backend,
      genPool: this.genPool,
      meshPool: this.meshPool,
      now: () => this.win.performance.now(),
      onError: (what, err) => this.faults.report(what, err),
      openTransport: (ready, failed) => {
        if (server !== this.server) return failed('the server is gone');
        try {
          ready(server.connect());
        } catch (e) {
          failed(describeError(e));
        }
      },
      playerKey: this.playerKey,
      name: DEFAULT_PLAYER_NAME,
      viewRadius: loadRadiusFor(this.settings.renderDistance),
      onToast: (message, kind) => this.toast(formatMessage(this.settings.language, message), kind),
      onStatus: (status) => this.onNetStatus(session, status),
    });
    this.session = session;
    this.input.releaseAll();
    this.input.setLook(0, 0);
    this.envTime = 0;
    this.worldPaused = false;
    this.binder.exitLock();
    this.showLoading('loading.connecting', 0.05);
    session.start();
  }

  /** The connection ended for good (kicked, refused, broken): the world closes (saved first when possible). */
  private onNetStatus(s: WorldSession, status: string): void {
    if (s !== this.session || this.quitting) return;
    const lang = this.settings.language;
    let msg: string | null = null;
    if (status === 'kicked') msg = clientText(lang, 'net.kicked', { reason: s.net.kick?.reason ?? '?' });
    else if (status === 'refused') msg = clientText(lang, 'net.refused', { reason: s.net.refusal?.reason ?? '?' });
    else if (status === 'failed') msg = clientText(lang, 'net.failed', { msg: s.net.failure ?? '?' });
    if (msg === null) return;
    console.error(`[blocklands] ${msg}`);
    this.toast(msg, 'error');
    const server = this.server;
    this.quitting = true;
    // The server itself is fine: let it save and close before it goes.
    if (server) void this.shutdownServer(server, !this.saveBlocked).finally(() => server.terminate());
    this.server = null;
    this.leaveWorld();
  }

  private backToMenu(): void {
    this.loading = null;
    this.setScreen('mainMenu');
    void this.refreshWorlds();
  }

  /** Ask the server to shut down (saving first when `save`); true once it closed. */
  private async shutdownServer(server: LocalServer, save: boolean): Promise<boolean> {
    const answer = server.waitFor((m) => m.type === 'closed' || (m.type === 'error' && m.what === 'shutdown'), save ? SHUTDOWN_SAVE_MS : 10_000);
    server.post({ type: 'shutdown', save });
    const m = await answer;
    return m !== null && m.type === 'closed';
  }

  async saveAndQuit(): Promise<void> {
    const s = this.session;
    const server = this.server;
    if (!s || !server || this.busy) return;
    this.busy = true;
    const from = this.screen;
    let closed = false;
    try {
      this.binder.exitLock();
      this.quitting = true;
      this.showLoading('loading.saving', 1);
      // A world a newer build wrote is never written again: closing loses nothing it could keep.
      closed = await this.shutdownServer(server, !this.saveBlocked);
    } catch (e) {
      this.faults.report('save & quit', e);
    } finally {
      this.busy = false;
    }
    if (closed || this.session !== s) {
      this.leaveWorld();
      return;
    }
    // The world could not be written: it stays open (the server runs on), and the player may
    // retry or choose "Quit without saving" explicitly.
    this.quitting = false;
    this.quitUnsaved = true;
    this.loading = null;
    this.setScreen(from === 'death' ? 'death' : 'pause');
    this.toast(clientText(this.settings.language, 'save.quitFailed'), 'error');
  }

  /** The explicit choice offered after a failed "Save & quit": close the world unsaved. */
  quitWithoutSaving(): void {
    if (!this.session || this.busy || !this.quitUnsaved) return;
    if (this.screen !== 'pause' && this.screen !== 'death') return;
    this.quitting = true;
    this.server?.post({ type: 'shutdown', save: false });
    this.leaveWorld();
  }

  private leaveWorld(): void {
    this.endSession();
    this.backToMenu();
  }

  private endSession(): void {
    const s = this.session;
    if (s) {
      this.session = null;
      s.dispose();
    }
    this.server?.terminate();
    this.server = null;
    this.worldMeta = null;
    this.quitUnsaved = false;
    this.saveBlocked = false;
    this.quitting = false;
    this.worldPaused = false;
    this.serverTps = null;
    this.genPool?.cancelAll();
    this.meshPool?.cancelAll();
    this.input.releaseAll();
  }

  /** Ask the server to save now; resolves with whether it succeeded (false without a world). */
  saveNow(): Promise<boolean> {
    const server = this.server;
    if (!server || !this.session) return Promise.resolve(false);
    const answer = server.waitFor((m) => m.type === 'saved', SHUTDOWN_SAVE_MS);
    server.post({ type: 'save' });
    return answer.then((m) => m !== null && m.type === 'saved' && m.ok);
  }

  // ================================================================== frame

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
    if (s) rendered = this.sessionFrame(s, now, dt);
    if (!rendered) this.stats.renderMs = 0;
    this.updateUi(now);
    this.stats.frameMs = this.win.performance.now() - t0;
  }

  private sessionFrame(s: WorldSession, now: number, dt: number): boolean {
    const wasLoading = s.state === 'loading';
    const playing = this.screen === 'none' && !wasLoading;
    const budget = wasLoading ? LOADING_WORK_BUDGET_MS : PLAY_WORK_BUDGET_MS;
    const w0 = this.win.performance.now();
    // The held keys and the look go to the prediction; the look comes back turned by the carrier.
    this.input.writeHeld(s.held, playing);
    const shown = s.update(now, dt / 1000, budget, { fov: this.settings.fov, viewMode: this.viewMode, step: !this.worldPaused });
    if (s !== this.session) return false;
    this.input.setLook(s.held.yaw, s.held.pitch);
    this.sendInputs(s, playing);
    if (!this.worldPaused) this.envTime += dt / 1000;
    if (s.state === 'ready' && s.dead && (this.screen === 'none' || this.screen === 'inventory')) {
      if (this.screen === 'inventory') this.closeInventory(false);
      this.binder.exitLock();
      this.setScreen('death');
      this.pauseWorld(true);
    }
    s.work(now, budget, s.state === 'ready');
    this.stats.workMs = this.win.performance.now() - w0;
    if (s.state === 'loading') return this.loadingFrame(s, now, dt, shown);
    if (this.screen === 'loading') this.finishLoading(s);
    if (!shown) return false;
    // While nothing moves (pause, death, settings) a frame now and then is enough.
    const still = this.worldPaused || this.screen === 'settings';
    if (still && !this.renderDirty && now - this.lastRender < IDLE_RENDER_MS) return false;
    s.present(dt / 1000, this.settings.renderDistance, this.envTime, now);
    return this.render(now);
  }

  /** The player's clicks, keys and hotbar choices of this frame, as intents (see client/input.ts). */
  private sendInputs(s: WorldSession, playing: boolean): void {
    if (s.state !== 'ready') {
      this.input.takeEvents(false);
      return;
    }
    try {
      const slot = this.input.takeSlotChange();
      if (slot >= 0) s.selectSlot(slot);
      for (const ev of this.input.takeEvents(playing)) {
        switch (ev) {
          case 'useDown':
            s.releaseUse();
            s.pressUse(this.input.sneaking);
            break;
          case 'useUp':
            s.releaseUse();
            break;
          case 'attackDown':
            s.releaseAttack();
            s.pressAttack();
            break;
          case 'attackUp':
            s.releaseAttack();
            break;
          case 'swap':
            s.swapHands();
            break;
        }
      }
      // Buttons let go of without an event (a screen opened, the window lost focus): the server lets go too.
      if (s.useHeld && !this.input.useHeld) s.releaseUse();
      if (s.attackHeld && !this.input.attackHeld) s.releaseAttack();
      // The hotbar follows the inventory as shown (pick block, the server's answer).
      this.input.followSlot(s.selected);
    } catch (e) {
      this.faults.report('input', e);
    }
  }

  private loadingFrame(s: WorldSession, now: number, dt: number, shown: boolean): boolean {
    const prog = s.loadingProgress();
    const lang = this.settings.language;
    const text =
      prog.phase === 'connecting'
        ? clientText(lang, s.net.status === 'reconnecting' ? 'loading.reconnecting' : 'loading.connecting')
        : prog.phase === 'terrain'
          ? clientText(lang, 'loading.terrain', { done: prog.chunksLoaded, total: prog.chunksNeeded })
          : prog.phase === 'meshing'
            ? clientText(lang, 'loading.meshing', { done: prog.sectionsReady, total: prog.sectionsNeeded })
            : clientText(lang, 'loading.finishing');
    this.loading = { text, progress: Math.max(0.05, prog.progress) };
    if (this.screen !== 'loading') {
      // A far respawn or teleport reloads: the loading screen covers it (the body is frozen meanwhile).
      if (this.screen === 'inventory') this.closeInventory(false);
      this.binder.exitLock();
      this.setScreen('loading');
    }
    // Draw now and then behind the opaque loading screen: uploads the new meshes to the GPU
    // gradually instead of all in the first playable frame.
    if (!shown || now - this.lastRender < LOADING_RENDER_MS) return false;
    s.present(dt / 1000, this.settings.renderDistance, this.envTime, now);
    return this.render(now);
  }

  private finishLoading(s: WorldSession): void {
    this.loading = null;
    if (s.dead) {
      this.setScreen('death');
      this.pauseWorld(true);
    } else {
      this.setScreen('none');
    }
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
      const inWorld = s !== null && s.state === 'ready';
      const vitals = inWorld ? (s.replica?.ownState.vitals ?? null) : null;
      let hint: string | null = null;
      if (inWorld && this.screen === 'none') {
        const stall = this.worldPaused || now - this.resumedAt < RESUME_QUIET_MS ? null : s.net.stall(now);
        if (stall !== null) {
          hint = clientText(this.settings.language, stall === 'host' ? 'net.hostStalled' : 'net.linkUnstable');
        } else {
          const msg = s.replica?.ownState.view.hint ?? null;
          if (msg !== this.hintMsg || this.settings.language !== this.hintLang) {
            this.hintMsg = msg;
            this.hintLang = this.settings.language;
            this.hintText = msg ? formatMessage(this.settings.language, msg) : null;
          }
          hint = this.hintText;
        }
      }
      if (this.settings.showDebug && inWorld) {
        if (now - this.debugAt >= 250) {
          this.debugAt = now;
          this.debugLines = this.buildDebug(s, now);
        }
      } else {
        this.debugLines = null;
      }
      const state = this.uiBuilder.build({
        screen: this.screen,
        settingsReturn: this.settingsReturn,
        mode: inWorld ? s.mode : 'creative',
        inventory: inWorld ? s.inventory : null,
        selected: this.input.slot,
        health: vitals ? vitals.health : 20,
        maxHealth: vitals ? vitals.maxHealth : 20,
        air: vitals ? vitals.air : 300,
        maxAir: vitals ? vitals.maxAir : 300,
        hint,
        toasts: this.toasts.list,
        debug: this.debugLines,
        helm: inWorld && this.screen === 'none' ? s.helm() : null,
        worlds: this.worlds,
        settings: this.settings,
        loading: this.screen === 'loading' ? this.loading : null,
        pointerLocked: this.binder.dragLook ? this.binder.engaged : this.binder.locked,
        dragLook: this.binder.dragLook,
        quitUnsaved: this.quitUnsaved,
        renderer: this.backendInfo ? (this.backendInfo.api === 'webgpu' ? 'WebGPU' : 'WebGL2') : this.backendError ? '—' : '…',
        version: this.version,
      });
      this.ui.update(state);
    } catch (e) {
      this.faults.report('UI', e);
    }
  }

  private buildDebug(s: WorldSession, now: number): string[] {
    const st = this.stats;
    const rs = this.backend.stats();
    const r = s.replica;
    const clock = s.net.clock;
    const own = s.own;
    const ms = s.mesher?.stats;
    const ts = s.terrain?.stats;
    const workers = this.workerModes;
    const tr = this.traffic;
    if (now - tr.at >= TRAFFIC_WINDOW_MS) {
      const span = (now - tr.at) / 1000;
      tr.inRate = Number.isFinite(span) ? (s.traffic.in - tr.in) / span : 0;
      tr.outRate = Number.isFinite(span) ? (s.traffic.out - tr.out) / span : 0;
      tr.at = now;
      tr.in = s.traffic.in;
      tr.out = s.traffic.out;
    }
    const structures = r?.structures() ?? [];
    let ships = 0;
    let rotors = 0;
    for (const x of structures) {
      if (x instanceof Ship) ships++;
      else if (x instanceof Rotor) rotors++;
    }
    const p = own?.player ?? null;
    return debugLines({
      version: this.version,
      rendererDetail: this.backendInfo?.detail ?? '?',
      fps: st.fps,
      frameMs: st.frameMs,
      workMs: st.workMs,
      renderMs: st.renderMs,
      yaw: s.shown.yaw,
      pitch: s.shown.pitch,
      drawCalls: rs.drawCalls,
      triangles: rs.triangles,
      sectionsDrawn: rs.sections,
      sectionsMeshed: s.mesher?.meshedCount ?? 0,
      meshQueued: ms?.queued ?? 0,
      meshJobs: ms?.inFlight ?? 0,
      player: p ? { x: p.pos.x, y: p.pos.y, z: p.pos.z, flying: p.flying, carrierId: p.carrierId } : null,
      mode: s.mode,
      columns: r?.chunks.size ?? 0,
      generating: r?.chunks.generating ?? 0,
      chunksInFlight: ts?.inFlight ?? 0,
      chunksWaiting: ts?.waiting ?? 0,
      deliverMs: ts?.deliverMs ?? 0,
      structures: structures.length,
      ships,
      rotors,
      entities: r?.state.entities.size ?? 0,
      target: s.intents?.useTarget ?? null,
      dayTime: r?.dayTime ?? 0,
      serverTick: r?.state.tick ?? 0,
      netStatus: s.net.status,
      rttMs: clock?.rtt ?? null,
      delayTicks: clock?.D ?? null,
      rotorLead: clock?.rotorLead ?? null,
      inBytesPerSec: tr.inRate,
      outBytesPerSec: tr.outRate,
      server: workers.server,
      serverTps: r?.state.tps ?? this.serverTps,
      serverTickMs: st.serverTickMs,
      serverTickMaxMs: st.serverTickMaxMs,
      storage: this.worldPersistent ? 'IndexedDB' : `memory (${this.storageReason || 'worker'})`,
      workers: `${workers.terrain} / ${workers.mesh}`,
      faults: this.faults.recent,
    });
  }

  // ================================================================== debug helpers

  /** Scripting / debugging helpers exposed on window.__blocklands. */
  readonly debug = {
    /** Summary of the running state (used by the browser scripts). */
    state: (): Record<string, unknown> => {
      const s = this.session;
      const r = s?.replica ?? null;
      const own = s?.own ?? null;
      const shownFeet = s?.shown.feet;
      return {
        screen: this.screen,
        sessionState: s?.state ?? null,
        netStatus: s?.net.status ?? null,
        renderer: this.backendInfo?.api ?? null,
        rendererDetail: this.backendInfo?.detail ?? null,
        storagePersistent: this.storagePersistent,
        worldPersistent: this.server ? this.worldPersistent : null,
        pointerLocked: this.binder.locked,
        dragLook: this.binder.dragLook,
        viewMode: this.viewMode,
        paused: this.worldPaused,
        chunks: r ? r.world.chunks.size : 0,
        sectionsMeshed: s?.mesher?.meshedCount ?? 0,
        sectionsDrawn: this.backend.stats().sections,
        meshQueue: s?.mesher?.stats.queued ?? 0,
        player:
          own && s
            ? {
                x: own.player.pos.x,
                y: own.player.pos.y,
                z: own.player.pos.z,
                shownX: shownFeet!.x,
                shownY: shownFeet!.y,
                shownZ: shownFeet!.z,
                eyeHeight: own.player.eyeHeight,
                yaw: s.shown.yaw,
                pitch: s.shown.pitch,
                dead: s.dead,
                mode: s.mode,
                carrierId: own.player.carrierId,
                steeringShipId: own.player.steeringShipId,
                onGround: own.player.onGround,
                wet: own.player.wet,
                headWet: own.player.headWet,
                flying: own.player.flying,
                health: r?.ownState.vitals?.health ?? null,
              }
            : null,
        target: s?.intents?.useTarget ?? null,
        mining: r?.ownState.view.mining ?? null,
        preview: r?.ownState.view.preview ? r.ownState.view.preview.cells.length / 3 : 0,
        hint: r?.ownState.view.hint ? formatMessage(this.settings.language, r.ownState.view.hint) : null,
        inventory: s?.inventory ? { hotbar: s.inventory.hotbar.map((x) => (x ? { item: x.item, count: x.count } : null)), selected: s.inventory.selected, offhand: s.inventory.offhand } : null,
        structures: r ? r.structures().map((x) => ({ id: x.id, kind: x instanceof Ship ? 'ship' : 'rotor', cells: x.grid.count, x: x.grid.position.x, y: x.grid.position.y, z: x.grid.position.z })) : [],
        helm: s?.helm() ?? null,
        entities: r ? r.state.entities.size : 0,
        worldTime: r ? r.state.tick : 0,
        dayTime: r ? r.dayTime : 0,
        worlds: this.worlds.map((w) => ({ id: w.id, name: w.name })),
        worldId: this.worldMeta?.id ?? null,
        faults: this.faults.recent.map((f) => `${f.what}: ${f.message}`),
        stats: { ...this.stats, rttMs: s?.net.clock?.rtt ?? null, delayTicks: s?.net.clock?.D ?? null, serverTps: r?.state.tps ?? this.serverTps, trafficIn: s?.traffic.in ?? 0, trafficOut: s?.traffic.out ?? 0 },
        workers: this.workerModes,
        playerKey: this.playerKey,
      };
    },
    /** Set the time of day `t` (0..1, 0 = sunrise): a host command (the world clock is never written). */
    setDayTime: (t: number): boolean => {
      if (!Number.isFinite(t)) return false;
      this.renderDirty = true;
      return this.session?.hostCommand({ kind: 'setDayTime', t }) ?? false;
    },
    /** Point the view (radians). */
    look: (yaw: number, pitch: number): void => {
      this.input.setLook(yaw, pitch);
      this.renderDirty = true;
    },
    /** Move the player (feet): a host command; the server answers with a correction. */
    teleport: (x: number, y: number, z: number): boolean => {
      this.renderDirty = true;
      return this.session?.hostCommand({ kind: 'teleport', x, y, z }) ?? false;
    },
    /** Any host command (see net/protocol.ts HostCommand). */
    hostCommand: (command: HostCommand): boolean => this.session?.hostCommand(command) ?? false,
    /** World cell value at integer coordinates, as the replica holds it (-1 without a world). */
    cell: (x: number, y: number, z: number): number => this.session?.replica?.world.getCell(x, y, z) ?? -1,
    /**
     * Give a stack of `item` (a host command); resolves once it shows in the inventory, with its
     * hotbar slot selected when it went to the hotbar. False after 5 s without it.
     */
    give: async (item: number, count = 64): Promise<boolean> => {
      const s = this.session;
      if (!s) return false;
      const had = countItem(s, item);
      if (!s.hostCommand({ kind: 'give', item, count })) return false;
      const end = this.win.performance.now() + 5000;
      while (this.win.performance.now() < end) {
        await new Promise<void>((r) => this.win.setTimeout(r, 50));
        if (this.session !== s) return false;
        if (countItem(s, item) > had) {
          const idx = s.inventory?.hotbar.findIndex((st) => st !== null && st.item === item) ?? -1;
          if (idx >= 0) this.input.selectSlot(idx);
          return true;
        }
      }
      return false;
    },
    /** Set the camera mode ('first' | 'back' | 'front'), or cycle it like F5 without an argument. */
    view: (mode?: ViewMode): ViewMode => {
      if (mode === 'first' || mode === 'back' || mode === 'front') this.viewMode = mode;
      else this.viewMode = nextViewMode(this.viewMode);
      this.renderDirty = true;
      return this.viewMode;
    },
    /** Pick block (what the middle mouse button does). */
    pick: (): boolean => this.session?.pickBlock() ?? false,
    /** Save immediately (resolves with whether it succeeded). */
    save: (): Promise<boolean> => this.saveNow(),
    backendStats: () => this.backend.stats(),
  };
}

/** How many of `item` the shown inventory holds. */
function countItem(s: WorldSession, item: number): number {
  const inv = s.inventory;
  if (!inv) return 0;
  let n = 0;
  for (const st of [...inv.hotbar, ...inv.main, inv.offhand]) if (st && st.item === item) n += st.count;
  return n;
}

/**
 * Chunk radius the client subscribes to for a render distance: one ring more, because a section
 * is meshed only once all 8 neighbouring chunks exist, so the outermost ring is never drawn.
 * Render distance N therefore shows N chunks.
 */
export function loadRadiusFor(renderDistance: number): number {
  return renderDistance + 1;
}

/** True when the page address asks for the WebGL2 backend (#webgl2). */
function wantsWebGL2(win: Window): boolean {
  try {
    return /webgl2/i.test(win.location?.hash ?? '');
  } catch {
    return false;
  }
}
