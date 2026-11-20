/**
 * The landings a client counts in its movement reports (NETCODE section 18 "landings", drive.ts
 * LANDINGS) are the mover's touch-downs (StepFacts.touchedDown): a step that ends on the ground
 * after one that did not. The server reads a gap in that count as a landing no delivered report
 * showed, so the count must miss no touch-down. Two properties of the mover make sure it does not,
 * and these tests pin both:
 *  - a body that touches down in a step ends that step on the ground, also when it walks off the
 *    edge of the tread later in the same step (it moves vertically first, then horizontally, and
 *    the mover keeps the ground it met in any sub-step: physics.ts onWorldGround);
 *  - a jump needs the ground at the START of a step (motion.ts), so no step lands and takes off
 *    again: between two take-offs there is always a step that touched down.
 * (A body that rises again out of liquid it fell into is not a landing: the water-exit lift and
 * swimming need no ground, and nothing is counted.)
 */
import { describe, expect, it } from 'vitest';
import { aabb } from '../../src/core/math';
import { JUMP_SPEED } from '../../src/entities/constants';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyHost } from '../../src/entities/body';
import { Player } from '../../src/entities/entity';
import { hasSupportBelow } from '../../src/voxel/shape';
import { addOctant } from './stairs-scenes';
import { B, LAND_TOP, landRun, makeCell } from './scenes';

const T = LAND_TOP;

/** A mover over the land of a fresh simulation (no structures) and a player standing at (x, y, z). */
function scene(x: number, y: number, z: number) {
  const run = landRun('survival', { x: 0.5, y: T, z: 0.5 }, null);
  const world = run.sim.world;
  const host: BodyHost = { world, structures: () => [] };
  const body = new BodyMover(host, { relocate: false });
  const p = new Player(999, 'survival');
  p.setPosition(x, y, z);
  /** One step as the clients run it (OwnPlayer.step, tests/drive/client.ts). */
  const step = (): void => {
    body.beginCarry();
    body.beginStep(p);
    sanitizeInput(p);
    body.stepPlayer(p, takeJumpPresses(p), false);
    body.endTick();
  };
  return { world, body, p, step };
}

describe('landings: every touch-down of the body is one step that ends on the ground', () => {
  it('a body that comes down on the rim of a block and moves past it in the same step: that step ends on the ground (counted), the next one in the air', () => {
    const s = scene(0.5, T, 0.5);
    const { world, body, p } = s;
    // A block whose top is T + 1, x in [2, 3); the body comes down 0.03 above its top, its
    // footprint over the rim by 0.03, moving +x at 6 blocks/s (0.3 a step): the vertical move
    // lands it on the rim, the horizontal one carries it past.
    for (let z = -1; z <= 1; z++) world.setCell(2, T, z, makeCell(B.STONE));
    p.setPosition(3 + p.halfWidth - 0.03, T + 1.03, 0.5);
    p.vel.x = 6;
    p.vel.y = -1;
    p.onGround = false;
    p.input.yaw = -Math.PI / 2; // facing +x
    p.input.forward = 1;
    p.input.sprint = true;
    s.step();
    const b = p.box(aabb());
    expect(p.pos.y, 'came down on the rim').toBeCloseTo(T + 1, 6);
    expect(b.minX, 'and past it').toBeGreaterThan(3);
    expect(hasSupportBelow(world, b, 0.01), 'nothing under the footprint at the end of the step').toBe(false);
    expect(p.onGround, 'the step ends on the ground').toBe(true);
    expect(body.facts.touchedDown, 'a touch-down').toBe(true);
    s.step();
    expect(p.onGround, 'the next step ends in the air').toBe(false);
    expect(body.facts.touchedDown).toBe(false);
  });

  it('hopping down a half-step staircase with the jump key held, sprinting: take-offs and touch-downs alternate, edge touch-downs included, and no step that began in the air rises', () => {
    // Steps along +x, half a block high and half a block deep, from 7.0 above the land down to it.
    const s = scene(0, 0, 0.5);
    const { world, body, p } = s;
    const top = 14; // half cells above the land
    for (let hx = 0; hx < 40; hx++) {
      const h = Math.max(0, top - Math.max(0, hx - 4));
      for (let hz = -4; hz < 6; hz++) for (let hy = 0; hy < h; hy++) addOctant(world, hx, 2 * T + hy, hz, B.STONE);
    }
    p.setPosition(1, T + top / 2, 0.5);
    p.onGround = true;
    p.input.yaw = -Math.PI / 2;
    p.input.forward = 1;
    p.input.sprint = true;
    p.input.jump = true;
    const events: string[] = [];
    let edges = 0;
    for (let i = 0; i < 120; i++) {
      const wasOnGround = p.onGround;
      const vy0 = p.vel.y;
      s.step();
      if (wasOnGround && p.vel.y > JUMP_SPEED - 2) events.push('J');
      // Began in the air: gravity (or the ground, or a ceiling, stopping it), never a take-off.
      if (!wasOnGround && p.wet === 0) expect(p.vel.y, `step ${i}: began in the air and rose`).toBeLessThanOrEqual(Math.max(vy0, 0));
      if (body.facts.touchedDown) {
        events.push('T');
        if (!hasSupportBelow(world, p.box(aabb()), 0.01)) edges++;
      }
      expect(body.facts.touchedDown).toBe(p.onGround && !wasOnGround);
    }
    const seq = events.join('');
    expect(seq.length, seq).toBeGreaterThan(12);
    expect(seq.match(/J/g)!.length, seq).toBeGreaterThan(5);
    expect(seq, 'two take-offs with no touch-down between them').not.toMatch(/JJ/);
    expect(seq, 'two touch-downs with no take-off between them (the key is held)').not.toMatch(/TT/);
    expect(edges, 'touch-downs that ended past the rim of a tread').toBeGreaterThan(0);
  });
});
