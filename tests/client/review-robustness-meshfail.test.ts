/**
 * Adversarial review (robustness): a section whose meshing throws on the main-thread fallback
 * path (no workers: hosts without Worker support, or after the pool failed) is dropped without
 * ever being marked settled, so WorldSession.loadingProgress() never reports done and the
 * loading screen stays up forever. The worker path handles the same failure (an error reply)
 * by keeping the section settled. Expected to FAIL until fixed.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mesh/mesher', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/mesh/mesher')>();
  class ThrowingMesher {
    build(): never {
      throw new Error('mesher bug (simulated)');
    }
  }
  return { ...orig, Mesher: ThrowingMesher };
});

import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator } from '../../src/worldgen/generator';
import { SectionMesher } from '../../src/client/meshing';
import { sectionKey } from '../../src/voxel/chunk';
import type { RenderBackend } from '../../src/render/backend';

describe('review: main-thread meshing failure', () => {
  it('a section that cannot be meshed still settles (like a worker error reply), so loading can finish', () => {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false });
    sim.tick();
    const backend = { setSectionMesh: () => undefined } as unknown as RenderBackend;
    const errors: string[] = [];
    const m = new SectionMesher(sim.world, backend, null, () => 0, (what) => errors.push(what));
    const p = sim.player.pos;
    for (let i = 0; i < 50; i++) m.update(0, 1e9, p.x, p.y + 1.6, p.z, 0, -1);
    expect(errors.length).toBeGreaterThan(0); // the failure was reported ...
    // ... but the turf section of the player's chunk (non-trivial, so it went to the mesher)
    // is neither queued nor meshed: isSettled() stays false forever and so does
    // loadingProgress().done for any world whose start area contains it.
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(true);
  });
});
