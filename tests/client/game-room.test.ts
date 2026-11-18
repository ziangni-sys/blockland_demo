/**
 * Package 11 with the real Game, headless, two pages in one process: the DOM / WebGL edges are
 * inert fakes (as in review-robustness-game.test.ts), the host's server is the real Worker entry on
 * a MessageChannel, the same-browser signalling is Node's own BroadcastChannel and WebRTC is
 * package 10's fake on a LoopbackNet driven by real timers. Everything else is the product: the
 * Game's UI actions (what the screens call), its Lobby, sessions, NetClients and the server.
 *
 * The host opens its world from the room screen; a guest page opened through the invitation link
 * asks for a name first and then joins; both see the player list; the host's world no longer
 * pauses; the host removes the guest, who sees why and goes back to the menu; a guest leaves from
 * its pause menu; the host closes the world and the guest sees that.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ storage: null as unknown, host: null as unknown }));

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
  const onChannel = async () => {
    const channel = new MessageChannel();
    const page = channel.port1;
    server.host = startServerWorker(channel.port2 as never, {
      clock: { now: () => performance.now(), epochMs: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      openStorage: () => Promise.resolve({ storage: server.storage as never, persistent: true }),
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
  return { createGenWorker: no, createGenWorkerFromDataUrl: no, createMeshWorker: no, createMeshWorkerFromDataUrl: no, createServerWorker: no, createServerWorkerFromDataUrl: no, createServerOnMainThread: onChannel };
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
import { clientText } from '../../src/client/strings';
import type { ServerHost } from '../../src/net/host/host';
import { LoopbackNet } from '../../src/net/loopback';
import { MemoryStorage, type SaveStorage } from '../../src/save/storage';
import type { UiActions } from '../../src/ui/model';
import { FakeRtcNet } from '../net/fakertc';

const intervals = new Set<ReturnType<typeof setInterval>>();
/** Addresses the pages set with history.replaceState, in order. */
const addresses: string[] = [];

function fakeEnv(search: string, stored: Record<string, string> = {}): { win: Window; canvas: HTMLCanvasElement; uiRoot: HTMLElement } {
  const store = new Map<string, string>(Object.entries(stored));
  const win = {
    navigator: { language: 'en', hardwareConcurrency: 4 },
    performance: { now: () => performance.now() },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (h: number) => clearTimeout(h),
    setInterval: (fn: () => void, ms?: number) => {
      const h = setInterval(fn, ms);
      intervals.add(h);
      return h;
    },
    clearInterval: (h: ReturnType<typeof setInterval>) => {
      clearInterval(h);
      intervals.delete(h);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    location: { search, hash: '', origin: 'http://blocklands.test', pathname: '/', href: `http://blocklands.test/${search}` },
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => addresses.push(url) },
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
  actions: UiActions;
}

const internals = (g: Game): GameInternals => g as unknown as GameInternals;
const games: Game[] = [];
let stopNet: (() => void) | null = null;

/** Every game's frames (about every 8 ms of real time: the server ticks on real timers) until `cond`. */
async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const end = performance.now() + ms;
  let last = performance.now();
  while (!cond()) {
    if (performance.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 8));
    const now = performance.now();
    for (const g of games) internals(g).frame(now, now - last);
    last = now;
  }
}

function online(): void {
  const loop = new LoopbackNet();
  stopNet = loop.startRealtime({ now: () => performance.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
  const rtc = new FakeRtcNet(loop);
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {
    return rtc.createPeer();
  });
}

/** The host: a world created from the menu and played; its name chosen before. */
async function hostGame(): Promise<{ game: Game; host: () => ServerHost }> {
  const storage = new MemoryStorage();
  server.storage = storage;
  const game = new Game(fakeEnv('?signal=broadcast', { playerName: 'Hester' }));
  games.push(game);
  const g = internals(game);
  g.storage = storage;
  g.storageReady = Promise.resolve(storage);
  g.backendReady = Promise.resolve(true);
  game.storagePersistent = true;
  game.changeSettings({ renderDistance: 4 });
  await game.newWorld({ name: 'Together', seed: 'together', mode: 'creative' });
  await until(() => game.screen === 'none' && game.session?.state === 'ready');
  return { game, host: () => server.host as ServerHost };
}

/** A page opened at `search` (started like main.ts starts it). */
function page(search: string, stored: Record<string, string> = {}): Game {
  const game = new Game(fakeEnv(search, stored));
  games.push(game);
  const g = internals(game);
  const storage = new MemoryStorage();
  g.storage = storage;
  g.storageReady = Promise.resolve(storage);
  game.changeSettings({ renderDistance: 4 });
  game.start();
  return game;
}

/** The host opens its room from the pause menu's room screen, as a player clicks it; the invitation link. */
async function openRoom(host: Game): Promise<string> {
  const g = internals(host);
  g.setScreen('pause');
  g.actions.openRoomScreen();
  expect(host.screen).toBe('room');
  g.actions.openRoom('service');
  await until(() => host.lobby.view().room?.status === 'open');
  return host.lobby.view().room!.link!;
}

const names = (g: Game): string[] => g.lobby.view().players.map((p) => `${p.name}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''}`);

afterEach(() => {
  for (const g of games.splice(0)) if (g.session) internals(g).leaveWorld();
  for (const h of intervals) clearInterval(h);
  intervals.clear();
  addresses.length = 0;
  stopNet?.();
  stopNet = null;
  server.host = null;
  vi.unstubAllGlobals();
});

describe('playing together with the real Game (package 11)', { timeout: 180_000 }, () => {
  it('room screen -> open; a page opened through the link asks for a name, then joins; the lists; the world does not pause; the host removes the guest, who sees why', async () => {
    online();
    const { game: host } = await hostGame();
    expect(host.lobby.view()).toMatchObject({ role: 'host', pauses: true });
    // Single play: the pause menu's mode switch carries the world's rules with it.
    const rules = (): string | undefined => host.session?.replica?.state.rules.defaultMode;
    expect(rules()).toBe('creative');
    internals(host).actions.setMode('survival');
    await until(() => rules() === 'survival');
    internals(host).actions.setMode('creative');
    await until(() => rules() === 'creative' && host.session?.mode === 'creative');
    const link = await openRoom(host);
    expect(link).toMatch(/^http:\/\/blocklands\.test\/\?join=[A-Z2-9]{8}&signal=broadcast$/);
    expect(host.toasts.list.some((t) => t.text.startsWith('The room is open'))).toBe(true);
    // The pause menu no longer pauses the world.
    internals(host).actions.closeScreen();
    expect(host.screen).toBe('pause');
    expect(host.debug.state().paused).toBe(false);
    expect(host.lobby.view().pauses).toBe(false);

    const guest = page(link.slice(link.indexOf('?')));
    expect(guest.screen).toBe('name');
    expect(guest.lobby.nameChosen).toBe(false);
    expect(addresses).toEqual([]);
    internals(guest).actions.setPlayerName('  Gus ');
    expect(guest.lobby.playerName).toBe('Gus');
    // The join started: the address loses ?join= (a reload opens the menu), keeps ?signal=.
    expect(addresses).toEqual(['http://blocklands.test/?signal=broadcast']);
    await until(() => guest.lobby.view().join !== null);
    expect(guest.screen).toBe('loading');
    await until(() => guest.screen === 'none' && guest.session?.state === 'ready');
    await until(() => host.lobby.view().players.length === 2);
    expect(names(host)).toEqual(['Hester (host) (you)', 'Gus']);
    expect(names(guest)).toEqual(['Hester (host)', 'Gus (you)']);
    expect(guest.lobby.view().role).toBe('guest');
    expect(host.toasts.list.some((t) => t.text === '\u2068Gus\u2069 joined the world')).toBe(true);
    expect(guest.debug.state().isHost).toBe(false);

    // The host sets the guest's mode from the room screen.
    const gusId = host.lobby.view().players.find((p) => p.name === 'Gus')!.entityId;
    internals(host).actions.setPlayerMode(gusId, 'survival');
    await until(() => guest.session?.mode === 'survival');
    // Online the host's own mode is its own; the world's rules are set on the room screen.
    internals(host).actions.setMode('survival');
    await until(() => host.session?.mode === 'survival');
    // Both commands would have been carried out in the same tick: a few batches later the rules are as they were.
    const tick = (): number => host.session?.replica?.state.tick ?? 0;
    const at = tick();
    await until(() => tick() > at + 5);
    expect(rules()).toBe('creative');
    expect(host.lobby.view().room!.rules).toBe('creative');
    internals(host).actions.setWorldRules('survival');
    await until(() => host.lobby.view().room?.rules === 'survival' && guest.session?.replica?.state.rules.defaultMode === 'survival');
    expect(guest.lobby.setWorldRules('creative')).toBe(false); // only the host

    // ... and removes it.
    internals(host).actions.kickPlayer(gusId);
    await until(() => guest.lobby.view().join?.stage === 'failed');
    expect(guest.screen).toBe('loading');
    expect(guest.session).toBeNull();
    expect(guest.lobby.view().join).toMatchObject({ error: clientText('en', 'kick.kicked'), canRetry: false, wasIn: true });
    await until(() => host.lobby.view().players.length === 1);
    expect(host.toasts.list.some((t) => t.text === '\u2068Gus\u2069 left the world')).toBe(true);
    internals(guest).actions.abandonJoin();
    expect(guest.screen).toBe('mainMenu');
    expect(guest.lobby.view().join).toBeNull();
  });

  it('a guest joins from the join screen with the room code, leaves from its pause menu (which never pauses); another joins; the host closes the world: the guest sees it', async () => {
    online();
    const { game: host } = await hostGame();
    const link = await openRoom(host);
    const code = host.lobby.view().room!.code!;
    expect(link).toContain(code.replace('-', ''));

    const ann = page('?signal=broadcast', { playerName: 'Ann' });
    expect(ann.screen).toBe('mainMenu');
    // A join can be given up at any stage: here while it is still reaching the service.
    internals(ann).actions.openJoinScreen();
    internals(ann).actions.join('ZZZZ-ZZZZ');
    await until(() => ann.lobby.view().join !== null);
    expect(ann.screen).toBe('loading');
    expect(ann.lobby.view().join!.stage).not.toBe('failed');
    internals(ann).actions.abandonJoin();
    expect(ann.screen).toBe('mainMenu');
    expect(ann.lobby.view().join).toBeNull();
    expect(ann.lobby.view().role).toBeNull();
    internals(ann).actions.openJoinScreen();
    expect(ann.screen).toBe('join');
    internals(ann).actions.join(code.toLowerCase());
    await until(() => ann.screen === 'none' && ann.session?.state === 'ready');
    // The guest's pause menu: no pause, "leave the room".
    internals(ann).setScreen('pause');
    expect(ann.lobby.view().pauses).toBe(false);
    internals(ann).actions.leaveRoom();
    expect(ann.screen).toBe('mainMenu');
    expect(ann.session).toBeNull();
    await until(() => host.toasts.list.some((t) => t.text === '\u2068Ann\u2069 left the world'));

    const bob = page('?signal=broadcast', { playerName: 'Bob' });
    internals(bob).actions.openJoinScreen();
    internals(bob).actions.join(link);
    await until(() => bob.screen === 'none' && bob.session?.state === 'ready');
    internals(host).setScreen('pause');
    await host.saveAndQuit();
    expect(host.screen).toBe('mainMenu');
    await until(() => bob.lobby.view().join?.stage === 'failed');
    expect(bob.screen).toBe('loading');
    expect(bob.lobby.view().join).toMatchObject({ error: clientText('en', 'kick.shutdown'), canRetry: false });
  });
});
