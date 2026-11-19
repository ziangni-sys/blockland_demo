/**
 * Adversarial review (correctness lens): fault isolation during loading. An exception in one
 * subsystem is reported once and the game goes on: a section whose main-thread mesh throws (no
 * workers: strict sandboxes, worker start failures) must not keep the loading screen up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshData, MeshInput } from '../../src/mesh/types';
import { Mesher } from '../../src/mesh/mesher';
import { SessionRig } from './rig';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review: loading with a section that cannot be meshed on the main thread', () => {
  it('still finishes loading (the failure is reported once, like the worker path does)', async () => {
    // One deterministic mesher bug: the first non-trivial section meshed (the one nearest the
    // camera, inside the must-be-meshed area around the player) throws, once.
    const original = Mesher.prototype.build;
    let thrown = 0;
    vi.spyOn(Mesher.prototype, 'build').mockImplementation(function (this: Mesher, input: MeshInput): MeshData {
      if (thrown === 0) {
        thrown++;
        throw new Error('mesher bug');
      }
      return original.call(this, input);
    });
    const rig = await SessionRig.create();
    rig.playUntilReady();
    expect(thrown).toBe(1);
    expect(rig.errors.length).toBeGreaterThan(0); // reported
    // The player is not stuck on the loading screen because of one bad section.
    expect(rig.session.loadingProgress().done).toBe(true);
  });
});
