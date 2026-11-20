/**
 * The camera's step offset in a real session (docs/SHAPES.md 5.7): walking onto a half slab the
 * body rises half a block within one client tick; the eyes glide up instead of jumping. Needs the
 * session to fill ShownPlayer.tick / onGround / tickY from the prediction (src/client/session.ts
 * updateShown), which is what this test pins.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PLAYER_EYE_HEIGHT } from '../../src/entities/constants';
import { fill } from '../sim/helpers';
import { LOWER, slab } from '../shapes';
import { FLAT_TOP, SessionRig } from './rig';

describe('the step offset in a session', () => {
  it('walking onto a lower half slab: the camera rises more gently than the body, never down, and ends at the eyes', async () => {
    let sx = 0;
    let sz = 0;
    const rig = await SessionRig.create({
      setup: (sim) => {
        sx = Math.floor(sim.spawnPoint.x);
        sz = Math.floor(sim.spawnPoint.z);
        fill(sim.world, sx - 3, FLAT_TOP, sz - 12, sx + 3, FLAT_TOP, sz - 3, slab(B.STONE, LOWER));
      },
    });
    rig.playUntilReady();
    rig.run(200);
    const s = rig.session;
    s.held.yaw = 0; // north, toward -Z
    s.held.pitch = 0;
    s.held.forward = 1;
    const feet: number[] = [];
    const cam: number[] = [];
    for (let i = 0; i < 150; i++) {
      rig.run(1000 / 60);
      feet.push(s.shown.feet.y);
      cam.push(rig.backend.camera!.y);
    }
    s.held.forward = 0;
    rig.run(300);
    // The body went up onto the slabs.
    expect(feet[feet.length - 1]).toBeCloseTo(FLAT_TOP + 0.5, 6);
    let maxFeet = 0;
    let maxCam = 0;
    for (let i = 1; i < feet.length; i++) {
      maxFeet = Math.max(maxFeet, feet[i]! - feet[i - 1]!);
      maxCam = Math.max(maxCam, cam[i]! - cam[i - 1]!);
      expect(cam[i]! - cam[i - 1]!).toBeGreaterThan(-1e-9);
    }
    expect(maxCam).toBeLessThan(maxFeet * 0.8);
    expect(rig.backend.camera!.y).toBeCloseTo(FLAT_TOP + 0.5 + PLAYER_EYE_HEIGHT, 3);
    expect(rig.errors).toEqual([]);
  });
});
