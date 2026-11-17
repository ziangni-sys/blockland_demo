/**
 * Review (gameplay / ACCEPTANCE 19 "走上码头…时脱离"): leaving a floating ship by walking.
 *
 * World collision is a pure axis sweep with no step-up, so ANY world ledge, however small, is a
 * wall. Ships float at arbitrary heights and bob, so a pier built level with the deck is almost
 * never exactly level: whenever the deck is a few hundredths below the pier top the player cannot
 * walk off the ship (measured: blocked at 0.02, 0.05, 0.2). The existing pier test only passes
 * because it puts the deck exactly level with the pier and keeps it still.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, qfromYaw } from './harness';

describe('review: walking from a bobbing ship onto a pier', () => {
  it.each([0.02, 0.05])('a deck %f below the pier top does not stop a player walking ashore', (dy) => {
    const b = new Bench();
    fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE); // pier, top at 61, next to the deck edge (x = 6)
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 60.5 - dy, 0.5), qfromYaw(0));
    const p = b.entities.createPlayer('survival', 3.5, 61 - dy + 0.01, 0.5);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east, toward the pier
    b.tick(40);
    expect(p.pos.x).toBeGreaterThan(7);
    expect(p.pos.y).toBe(61);
    expect(p.carrierId).toBe(0);
  });
});
