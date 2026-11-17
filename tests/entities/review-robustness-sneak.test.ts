/**
 * Review (robustness): ACCEPTANCE 19 "潜行走到甲板边缘不会掉下去" on a deck that TURNS.
 *
 * The sneak guard (Mover.clipSneak) only engages while the box is supported by the ATTACH
 * inset probe at its current position. On a yawing deck the world-aligned body box rotates
 * relative to the deck every tick, so a player the guard stopped at a corner/edge loses inset
 * support without moving; the guard then disengages ("Only engages when the body is supported
 * now") and the next forward step walks straight off the deck.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

describe('review: sneak edge guard on a turning deck', () => {
  it.each([0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -0.3])(
    'a player sneaking toward the edge of a yawing ship (heading %f rad, deck frame) never falls off',
    (heading) => {
      const b = new Bench();
      const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
      // Turns at 0.4 rad/s (a ship at ~3 blocks/s with the rudder over), no translation.
      const shipYaw = (t: number) => 0.5 + 0.4 * t * DT;
      b.drive(ship, (t) => ({ p: vec3(0.5, 60.5, 0.5), q: qfromYaw(shipYaw(t)) }));
      b.tick();
      const w = ship.grid.toWorld(vec3(0.5, 61.01, 0.5));
      const p = b.entities.spawnPlayer('survival', w.x, w.y, w.z);
      p.carrierId = ship.id;
      b.tick(5);
      expect(p.carrierId).toBe(ship.id);
      p.input.sneak = true;
      p.input.forward = 1;
      for (let i = 0; i < 300; i++) {
        p.input.yaw = heading + shipYaw(b.ticks); // keep walking the same way across the deck
        b.tick();
        expect(p.carrierId).toBe(ship.id);
        expect(ship.grid.toLocal(p.pos, vec3()).y).toBeGreaterThan(60.99);
      }
    },
  );
});

describe('review: sneak edge guard when the player already stands near the edge', () => {
  it('a player standing on the outer 0.05 of a ledge who starts sneaking outward does not fall', () => {
    const b = new Bench();
    fill(b.world, -2, 60, -2, 2, 60, 2, B.STONE); // 5x5 platform, east edge at x = 3
    // Standing (not sneaking) with only 0.05 of the footprint over the platform: still on the
    // ground (inset-0 support), but outside the ATTACH-inset probe the guard requires.
    const p = b.entities.spawnPlayer('survival', 3.25, 61, 0.5);
    b.tick(3);
    expect(p.onGround).toBe(true);
    expect(p.pos.y).toBe(61);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east, toward the edge
    b.tick(40);
    expect(p.pos.y).toBe(61);
  });
});
