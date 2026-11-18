/**
 * Adversarial review (robustness): a section whose meshing throws on the main-thread fallback
 * path (no workers: hosts without Worker support, or after the pool failed) must still settle
 * (like a worker's error reply), or WorldSession.loadingProgress() never reports done and the
 * loading screen stays up forever.
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

import { SectionMesher } from '../../src/client/meshing';
import { sectionKey } from '../../src/voxel/chunk';
import type { RenderBackend } from '../../src/render/backend';
import { FLAT_TOP, flatWorld } from './rig';

describe('review: main-thread meshing failure', () => {
  it('a section that cannot be meshed still settles (like a worker error reply), so loading can finish', () => {
    const world = flatWorld(2);
    const backend = { setSectionMesh: () => undefined } as unknown as RenderBackend;
    const errors: string[] = [];
    const m = new SectionMesher(world, backend, null, () => 0, (what) => errors.push(what));
    for (let i = 0; i < 50; i++) m.update(0, 1e9, 0.5, FLAT_TOP + 1.6, 0.5, 0, -1);
    expect(errors.length).toBeGreaterThan(0); // the failure was reported ...
    // ... and the turf section of the middle chunk (non-trivial, so it went to the mesher) is settled.
    expect(m.isSettled(sectionKey(0, 2, 0))).toBe(true);
  });
});
