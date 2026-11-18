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
vi.mock('../../src/ui/index', () => ({
  createUi: () => ({ update() {}, wantsKeyboard: () => false, dispose() {} }),
}));
vi.mock('../../src/client/uishim', () => ({ installFormSubmitShim: () => () => undefined }));
vi.mock('../../src/client/workerfactory', async () => {
  const { startServerWorker } = await import('../../src/net/host/worker');
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
      openStorage: async () => ({ storage: server.storage as never, persistent: true }),
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

/** A Game with a world created from its menu and played until the loading screen is gone. */
async function gameWithWorld(storage: SaveStorage): Promise<{ game: Game; host: () => ServerHost }> {
  server.storage = storage;
  const game = new Game(fakeEnv());
  games.push(game);
  const g = game as unknown as GameInternals;
  g.storage = storage;
  g.storageReady = Promise.resolve(storage);
  g.backendReady = Promise.resolve(true);
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
