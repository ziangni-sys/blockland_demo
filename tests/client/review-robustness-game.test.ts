/**
 * Adversarial review (robustness) of the Game session lifecycle, driven headlessly: the DOM /
 * WebGL edges (render backend, UI, input binder, form shim) are inert fakes, and the game server
 * is the real Worker entry (net/host/worker.ts startServerWorker) behind a MessageChannel, with a
 * storage the test controls (client/workerfactory.ts is mocked to hand it out as the main-thread
 * way of starting the server). Everything else is the real client: the Game opens the world
 * through host control messages and plays it through the network client; frames are driven by
 * the test, the server ticks on real timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  storage: null as unknown,
  /** The server opens its storage as the real Worker does (workerDeps): IndexedDB, else the page's. */
  realStorage: false,
  host: null as unknown,
  started: 0,
}));

vi.mock('../../src/render/three/index', () => {
  const backend = {
    init: async () => ({ api: 'webgl2', detail: 'fake' }),
    setTiles() {},
    setSectionMesh() {},
    setStructureMesh() {},
    setStructurePose() {},
    setStructureDryVolume() {},
    setEntities() {},
    setCamera() {},
    setEnvironment() {},
    setOverlays() {},
    resize() {},
    render() {},
    stats: () => ({ drawCalls: 0, triangles: 0, sections: 0, structures: 0 }),
    dispose() {},
  };
  return { createThreeBackend: () => backend };
});
/** The last state the game gave its UI. */
const ui = vi.hoisted(() => ({ last: null as unknown }));
vi.mock('../../src/ui/index', () => ({
  createUi: () => ({
    update(state: unknown) {
      ui.last = state;
    },
    wantsKeyboard: () => false,
    dispose() {},
  }),
}));
vi.mock('../../src/client/uishim', () => ({ installFormSubmitShim: () => () => undefined }));
vi.mock('../../src/client/workerfactory', async () => {
  const { startServerWorker, workerDeps } = await import('../../src/net/host/worker');
  const no = (): never => {
    throw new Error('no workers in tests');
  };
  /** The server Worker's entry behind a MessageChannel, its storage the test's. */
  const onChannel = async () => {
    const channel = new MessageChannel();
    const page = channel.port1;
    server.started++;
    server.host = startServerWorker(channel.port2 as never, {
      clock: {
        now: () => performance.now(),
        epochMs: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      openStorage: (page) => (server.realStorage ? workerDeps().openStorage(page) : Promise.resolve({ storage: server.storage as never, persistent: true })),
      host: { chunkBudget: { columns: 8 }, rabbits: false },
    });
    return {
      postMessage: (msg: unknown, transfer: Transferable[]) => page.postMessage(msg, transfer),
      addEventListener: (type: string, fn: (e: { data?: unknown }) => void) => {
        if (type !== 'message') return;
        page.addEventListener('message', fn as never);
        page.start();
      },
      terminate: () => {
        void (server.host as { shutdown(save: boolean): Promise<boolean> }).shutdown(false);
        page.close();
      },
    };
  };
  return {
    createGenWorker: no,
    createGenWorkerFromDataUrl: no,
    createMeshWorker: no,
    createMeshWorkerFromDataUrl: no,
    createServerWorker: no,
    createServerWorkerFromDataUrl: no,
    createServerOnMainThread: onChannel,
  };
});
vi.mock('../../src/client/inputdom', () => ({
  InputBinder: class {
    locked = false;
    dragLook = false;
    engaged = false;
    requestLock(): void {}
    exitLock(): void {}
    update(): void {}
    cancelGesture(): void {}
    dispose(): void {}
  },
}));

import { Game } from '../../src/client/game';
import type { ServerHost } from '../../src/net/host/host';
import type { UiState } from '../../src/ui/model';
import { MemoryStorage, type SaveStorage } from '../../src/save/storage';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';

function fakeEnv(): { win: Window; canvas: HTMLCanvasElement; uiRoot: HTMLElement } {
  const store = new Map<string, string>();
  const win = {
    navigator: { language: 'en', hardwareConcurrency: 4 },
    performance: { now: () => performance.now() },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    setInterval: () => 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    location: { search: '', hash: '' },
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
  } as unknown as Window;
  return { win, canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement, uiRoot: {} as HTMLElement };
}

interface GameInternals {
  leaveWorld(): void;
  storage: SaveStorage | null;
  storageReady: Promise<SaveStorage> | null;
  backendReady: Promise<boolean> | null;
  frame(now: number, dt: number): void;
  setScreen(s: string): void;
}

/** Run the game's frames (every ~16 ms of real time: the server ticks on real timers) until `cond`. */
async function until(game: Game, cond: () => boolean, ms = 30_000): Promise<void> {
  const g = game as unknown as GameInternals;
  const end = performance.now() + ms;
  let last = performance.now();
  while (!cond()) {
    if (performance.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 8));
    const now = performance.now();
    g.frame(now, now - last);
    last = now;
  }
}

const games: Game[] = [];

/**
 * A Game with a world created from its menu and played until the loading screen is gone.
 * `storage` is the page's storage (the world list); `persistent` false makes it a memory storage
 * as the page opens one where IndexedDB is unavailable.
 */
async function gameWithWorld(storage: SaveStorage, persistent = true): Promise<{ game: Game; host: () => ServerHost }> {
  server.storage = storage;
  const game = new Game(fakeEnv());
  games.push(game);
  const g = game as unknown as GameInternals;
  g.storage = storage;
  g.storageReady = Promise.resolve(storage);
  g.backendReady = Promise.resolve(true);
  game.storagePersistent = persistent;
  game.storageReason = persistent ? '' : 'unavailable';
  game.changeSettings({ renderDistance: 4 });
  await game.newWorld({ name: 'Review', seed: 'review', mode: 'creative' });
  expect(game.server?.mode).toBe('main thread');
  await until(game, () => game.screen === 'none' && game.session?.state === 'ready');
  return { game, host: () => server.host as ServerHost };
}

afterEach(() => {
  // Close every game's world (its server goes with it) before the next test starts its own.
  for (const g of games.splice(0)) if (g.session) (g as unknown as GameInternals).leaveWorld();
  server.host = null;
  server.realStorage = false;
  vi.unstubAllGlobals();
});

describe('review: a world kept in memory (no IndexedDB: the sandboxed single-file build)', { timeout: 60_000 }, () => {
  it('stays in the world list after save & quit for the rest of the page session, and loads again with its blocks', async () => {
    // Neither the page nor its server can open IndexedDB: the page keeps a memory storage, and
    // the server (opening its storage as the real Worker does) saves into the page's.
    vi.stubGlobal('indexedDB', undefined);
    server.realStorage = true;
    const pageStorage = new MemoryStorage();
    const { game, host } = await gameWithWorld(pageStorage, false);
    expect(game.debug.state().worldPersistent).toBe(false);
    const id = game.worldMeta!.id;
    const at = host().sim.spawnPoint;
    const cell = { x: Math.floor(at.x) + 2, y: Math.floor(at.y) + 2, z: Math.floor(at.z) };
    host().sim.world.setCell(cell.x, cell.y, cell.z, makeCell(B.BRICKS));
    await until(game, () => game.debug.cell(cell.x, cell.y, cell.z) === makeCell(B.BRICKS));

    const g = game as unknown as GameInternals;
    g.setScreen('pause');
    await game.saveAndQuit();
    expect(game.screen).toBe('mainMenu');
    expect(game.server).toBeNull();
    await until(game, () => game.worlds.some((w) => w.id === id));
    expect((await pageStorage.getMeta(id))?.name).toBe('Review');

    // Play again: a new server reads the world back from the page's storage.
    await game.loadWorld(id);
    await until(game, () => game.screen === 'none' && game.session?.state === 'ready');
    expect(game.worldMeta?.id).toBe(id);
    expect(host().sim.world.getCell(cell.x, cell.y, cell.z)).toBe(makeCell(B.BRICKS));
    await until(game, () => game.debug.cell(cell.x, cell.y, cell.z) === makeCell(B.BRICKS));
    expect(server.started).toBeGreaterThanOrEqual(2);
  });
});

describe('review: the game opens its world through its own server', { timeout: 60_000 }, () => {
  it('a new world: the server places the example boat and gives the starter items; the client plays it; save & quit closes it, saved', async () => {
    const storage = new MemoryStorage();
    const { game, host } = await gameWithWorld(storage);
    const sim = host().sim;
    // The example windmill boat (blocks: a helm and a bearing near the spawn), by the server.
    let helms = 0;
    const p = sim.spawnPoint;
    for (let x = Math.floor(p.x) - 45; x <= p.x + 45; x++) for (let z = Math.floor(p.z) - 45; z <= p.z + 45; z++) if (sim.world.getId(x, 48, z) === B.HELM) helms++;
    expect(helms).toBe(1);
    // The starter items, shown from the server's inventory.
    expect(game.session!.inventory!.hotbar.filter((s) => s !== null).length).toBe(9);
    expect(game.debug.state().worldPersistent).toBe(true);
    // The world is saved once right after it is made.
    expect(await storage.getMeta(game.worldMeta!.id)).not.toBeNull();
    const id = game.worldMeta!.id;
    const g = game as unknown as GameInternals;
    g.setScreen('pause');
    await game.saveAndQuit();
    expect(game.session).toBeNull();
    expect(game.server).toBeNull();
    expect(game.screen).toBe('mainMenu');
    expect((await storage.listWorlds()).map((m) => m.id)).toContain(id);
  });
});

describe('review: save & quit when the save fails', { timeout: 60_000 }, () => {
  it('keeps the world open (nothing is lost) when the final save could not be written; "quit without saving" then closes it', async () => {
    const storage = new MemoryStorage();
    // A full disk / revoked storage: every write is refused (the world's first save fails too).
    storage.putAll = () => Promise.reject(new Error('QuotaExceededError (simulated)'));
    const { game, host } = await gameWithWorld(storage);
    const sim = host().sim;
    const at = sim.spawnPoint;
    sim.world.setCell(Math.floor(at.x) + 1, Math.floor(at.y) + 3, Math.floor(at.z), makeCell(B.BRICKS)); // unsaved work
    const g = game as unknown as GameInternals;
    g.setScreen('pause');
    await game.saveAndQuit();
    expect(game.session).not.toBeNull();
    expect(game.server).not.toBeNull();
    expect(game.screen).toBe('pause');
    expect(game.toasts.list.some((t) => /could not be saved/.test(t.text))).toBe(true);
    expect(host().state).toBe('running');
    expect(sim.world.getCell(Math.floor(at.x) + 1, Math.floor(at.y) + 3, Math.floor(at.z))).toBe(makeCell(B.BRICKS));
    // The explicit choice: close it unsaved.
    game.quitWithoutSaving();
    expect(game.session).toBeNull();
    expect(game.screen).toBe('mainMenu');
  });
});

describe('review: debug helpers are host commands', { timeout: 60_000 }, () => {
  it('setDayTime changes the time of day through the server (its day offset), without moving the world clock', async () => {
    const { game, host } = await gameWithWorld(new MemoryStorage());
    const sim = host().sim;
    const t0 = sim.world.time;
    const offset0 = sim.dayOffset;
    expect(game.debug.setDayTime(0.75)).toBe(true);
    await until(game, () => sim.dayOffset !== offset0);
    expect(sim.dayTime).toBeCloseTo(0.75, 2);
    expect(sim.world.time - t0).toBeLessThan(100); // the clock just ran on: it was never set
    await until(game, () => Math.abs((game.session!.replica!.dayTime - 0.75 + 1) % 1) < 0.01);
  });

  it('pausing in the pause menu stops the server and the client; resuming starts both again', async () => {
    const { game, host } = await gameWithWorld(new MemoryStorage());
    const sim = host().sim;
    game.command('escape');
    expect(game.screen).toBe('pause');
    await until(game, () => host().paused);
    const t = sim.world.time;
    await new Promise((r) => setTimeout(r, 300));
    expect(sim.world.time).toBe(t);
    expect(game.session!.net.paused).toBe(true);
    game.command('escape'); // resume (the Esc that released the lock is long past)
    expect(game.screen).toBe('none');
    await until(game, () => !host().paused && sim.world.time > t + 2);
    expect(game.session!.net.paused).toBe(false);
  });
});

describe('review: death and respawn', { timeout: 60_000 }, () => {
  it('dying shows the death screen and pauses the world (server and client); respawning plays on, alive', async () => {
    const { game, host } = await gameWithWorld(new MemoryStorage());
    const sim = host().sim;
    const me = sim.players.get(game.playerKey)!;
    sim.entities.kill(me.player, 'void');
    await until(game, () => game.screen === 'death' && host().paused);
    expect(game.session!.dead).toBe(true);
    expect(game.session!.net.paused).toBe(true);
    const t = sim.world.time;
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.world.time).toBe(t);
    (game as unknown as { actions: { respawn(): void } }).actions.respawn();
    // The server runs again to carry the respawn out; the respawn correction reloads if it is far.
    await until(game, () => game.screen === 'none' && game.session?.state === 'ready' && !me.player.dead && !game.session.dead);
    expect(host().paused).toBe(false);
    expect(game.session!.net.paused).toBe(false);
    expect(me.player.health).toBe(me.player.maxHealth);
    await until(game, () => sim.world.time > t + 5);
  });
});

/** The last UI state, after a few more frames. */
async function uiAfterFrames(game: Game, frames = 5): Promise<UiState> {
  let n = 0;
  await until(game, () => ++n > frames);
  return ui.last as UiState;
}

describe('review: the stall hint in single player', { timeout: 60_000 }, () => {
  it('the host never gets the "host is slowed down" hint (it is this page); a guest gets it as a notice under the context hint, never instead of it', async () => {
    const { game, host } = await gameWithWorld(new MemoryStorage());
    const s = game.session!;
    // The world runs below 15 TPS (a slow machine on the main-thread fallback): the globals say so.
    host().replicator.tps = 10;
    await until(game, () => s.replica!.state.tps === 10);
    expect(s.net.stall(performance.now())).toBe('host');
    let state = await uiAfterFrames(game);
    expect(state.screen).toBe('none');
    expect(state.hint).toBeNull();
    expect(state.notice).toBeNull();

    // The same seen by a guest (package 11): a context hint stays, the stall notice comes below it.
    (s.net.welcome as { isHost: boolean }).isHost = false;
    s.replica!.ownState.view.hint = { key: 'hint.helm.steer' };
    state = await uiAfterFrames(game);
    expect(state.hint).toBe('Right-click to steer · Sneak + right-click to dock');
    expect(state.notice).toMatch(/host.s server/);
  });
});

describe('review: the server fails', { timeout: 60_000 }, () => {
  it('a simulation error stops the world: the pause screen says so and offers quit without saving, nothing resumes it; save & quit still saves', async () => {
    const storage = new MemoryStorage();
    const { game, host } = await gameWithWorld(storage);
    const sim = host().sim;
    const id = game.worldMeta!.id;
    sim.tick = () => {
      throw new Error('review: injected simulation failure');
    };
    await until(game, () => game.screen === 'pause');
    let state = await uiAfterFrames(game);
    expect(state.worldStopped).toBe(true);
    expect(game.session!.net.paused).toBe(true);
    expect(game.toasts.list.some((t) => /stopped/.test(t.text))).toBe(true);
    // Neither Esc nor the resume action plays on in a stopped world.
    game.command('escape');
    (game as unknown as { actions: { resume(): void } }).actions.resume();
    state = await uiAfterFrames(game);
    expect(game.screen).toBe('pause');
    expect(state.worldStopped).toBe(true);
    const before = (await storage.getMeta(id))!.lastPlayed;
    await new Promise((r) => setTimeout(r, 5));
    await game.saveAndQuit();
    expect(game.screen).toBe('mainMenu');
    expect(game.session).toBeNull();
    expect((await storage.getMeta(id))!.lastPlayed).toBeGreaterThan(before);
  });

  it('a crash of the server (an error event after it answered) stops the world the same way; quit without saving closes it', async () => {
    const { game } = await gameWithWorld(new MemoryStorage());
    (game.server as unknown as { o: { onCrash(): void } }).o.onCrash();
    await until(game, () => game.screen === 'pause');
    expect((await uiAfterFrames(game)).worldStopped).toBe(true);
    game.quitWithoutSaving();
    expect(game.screen).toBe('mainMenu');
    expect(game.server).toBeNull();
  });

  it('a server failure while the world is still loading closes it and returns to the menu', async () => {
    const storage = new MemoryStorage();
    server.storage = storage;
    const game = new Game(fakeEnv());
    games.push(game);
    const g = game as unknown as GameInternals;
    g.storage = storage;
    g.storageReady = Promise.resolve(storage);
    g.backendReady = Promise.resolve(true);
    game.storagePersistent = true;
    await game.newWorld({ name: 'Early', seed: 'early', mode: 'creative' });
    expect(game.session?.state).toBe('loading');
    (game.server as unknown as { o: { onCrash(): void } }).o.onCrash();
    await until(game, () => game.screen === 'mainMenu' && game.server === null);
    expect(game.session).toBeNull();
    expect(game.toasts.list.some((t) => /stopped/.test(t.text))).toBe(true);
  });
});
