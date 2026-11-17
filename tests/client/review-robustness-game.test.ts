/**
 * Adversarial review (robustness) of the Game session lifecycle, driven headlessly: the DOM /
 * WebGL / worker edges (render backend, UI, input binder, form shim, worker factory) are
 * replaced by inert fakes; everything else is the real client + a real Simulation.
 * These tests document defects found in review and are expected to FAIL until fixed.
 */
import { describe, expect, it, vi } from 'vitest';

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
vi.mock('../../src/client/workerfactory', () => {
  const no = (): never => {
    throw new Error('no workers in tests');
  };
  return { createGenWorker: no, createGenWorkerFromDataUrl: no, createMeshWorker: no, createMeshWorkerFromDataUrl: no };
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
import { newWorldMeta, SaveManager } from '../../src/client/saves';
import { MemoryStorage } from '../../src/save/storage';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';

function fakeEnv(): { win: Window; canvas: HTMLCanvasElement; uiRoot: HTMLElement } {
  let now = 0;
  const win = {
    navigator: { language: 'en', hardwareConcurrency: 4 },
    performance: { now: () => (now += 1) },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { addEventListener: () => undefined, visibilityState: 'visible' },
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
  } as unknown as Window;
  return { win, canvas: { clientWidth: 800, clientHeight: 600 } as unknown as HTMLCanvasElement, uiRoot: {} as HTMLElement };
}

interface GameInternals {
  saves: SaveManager | null;
  storageReady: Promise<SaveManager> | null;
  backendReady: Promise<boolean> | null;
  startSession(sim: Simulation, meta: ReturnType<typeof newWorldMeta>, gen: FlatGenerator, isNew: boolean): void;
  setScreen(s: string): void;
}

function gameWithWorld(storage: MemoryStorage): { game: Game; sim: Simulation } {
  const game = new Game(fakeEnv());
  const g = game as unknown as GameInternals;
  const saves = new SaveManager(storage);
  g.saves = saves;
  g.storageReady = Promise.resolve(saves);
  g.backendReady = Promise.resolve(true);
  game.storagePersistent = true;
  const gen = new FlatGenerator();
  const sim = new Simulation({ seed: 1, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2, rabbits: false });
  g.startSession(sim, newWorldMeta('wreview', 'Review', '1', 1, 'creative', 0), gen, false);
  game.session!.state = 'ready';
  g.setScreen('pause');
  return { game, sim };
}

describe('review: save & quit when the save fails', () => {
  it('keeps the world open (nothing is lost) when the final save could not be written', async () => {
    const storage = new MemoryStorage();
    // A full disk / revoked storage: every write is refused.
    storage.putAll = () => Promise.reject(new Error('QuotaExceededError (simulated)'));
    const { game, sim } = gameWithWorld(storage);
    sim.world.setCell(1, 40, 1, makeCell(B.BRICKS)); // unsaved work
    await game.saveAndQuit();
    // Fails today: saveAndQuit ignores saveNow()'s `false` and ends the session in `finally`,
    // so the player is sent to the main menu and every change since the last good save is gone.
    expect(game.session).not.toBeNull();
    expect(game.sim?.world.getCell(1, 40, 1)).toBe(makeCell(B.BRICKS));
  });
});

describe('review: debug.setDayTime', () => {
  it('changes the time of day through Simulation.setDayTime, without moving the world clock', () => {
    const { game, sim } = gameWithWorld(new MemoryStorage());
    const clock = sim.world.time;
    game.debug.setDayTime(0.75);
    expect(sim.dayTime).toBeCloseTo(0.75, 2);
    // Fails today: the helper writes sim.world.time directly, which Simulation documents as
    // forbidden ("the clock drives scheduled block ticks: never write world.time to change the
    // time of day — use setDayTime()").
    expect(sim.world.time).toBe(clock);
  });
});
