/**
 * Adversarial review (correctness lens): fault isolation during loading. The brief requires
 * that an exception in one subsystem is reported once and the game goes on. The worker path
 * of SectionMesher treats a failed section as settled (meshed.add) so loading can finish;
 * the main-thread fallback (no workers: strict sandboxes, worker start failures) does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshData, MeshInput } from '../../src/mesh/types';
import { Mesher } from '../../src/mesh/mesher';
import type { RenderBackend } from '../../src/render/backend';
import { FlatGenerator } from '../../src/worldgen/generator';
import { WorldSession } from '../../src/client/session';
import { soloSim } from '../solo';

function nullBackend(): RenderBackend {
  const noop = (): void => undefined;
  return {
    init: async () => ({ api: 'webgl2', detail: 'fake' }),
    setTiles: noop,
    setSectionMesh: noop,
    setStructureMesh: noop,
    setStructurePose: noop,
    setStructureDryVolume: noop,
    setEntities: noop,
    setCamera: noop,
    setEnvironment: noop,
    setOverlays: noop,
    resize: noop,
    render: noop,
    stats: () => ({ drawCalls: 0, triangles: 0, sections: 0, structures: 0 }),
    dispose: noop,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review: loading with a section that cannot be meshed on the main thread', () => {
  it('still finishes loading (the failure is reported once, like the worker path does)', () => {
    const gen = new FlatGenerator();
    const sim = soloSim({ seed: 1, mode: 'creative', generator: gen, loadRadius: 4, rabbits: false });
    const errors: string[] = [];
    const s = new WorldSession(sim, sim.soloPlayer, { id: 'x', name: 'x', seed: '', seedHash: 1, mode: 'creative', createdAt: 0, lastPlayed: 0, version: 1, time: 0 }, gen, true, {
      backend: nullBackend(),
      genPool: null,
      meshPool: null,
      now: () => 0,
      onError: (what, err) => errors.push(`${what}: ${String(err)}`),
      onEvent: () => undefined,
    });
    sim.tick();
    // One deterministic mesher bug: the surface section of the player's own chunk throws.
    const original = Mesher.prototype.build;
    let thrown = 0;
    vi.spyOn(Mesher.prototype, 'build').mockImplementation(function (this: Mesher, input: MeshInput): MeshData {
      // The first non-trivial section meshed is the one nearest the camera (inside the
      // must-be-meshed area around the player): it throws, once.
      if (thrown === 0) {
        thrown++;
        throw new Error('mesher bug');
      }
      return original.call(this, input);
    });
    let frames = 0;
    while (!s.loadingProgress().done && frames < 600) {
      s.work(0, 1e9, sim.soloPlayer.player.pos.x, sim.soloPlayer.player.pos.y + 1.6, sim.soloPlayer.player.pos.z, Number.NaN);
      frames++;
    }
    const prog = s.loadingProgress();
    expect(errors.length).toBeGreaterThan(0); // reported
    // The player must not be stuck on the loading screen forever because of one bad section.
    expect(prog.done).toBe(true);
  });
});
