/**
 * Adversarial review (correctness): standing / sneaking / stepping at edges.
 *
 * 1. Sneak edge guard. Mover.clipSneak() only engages when the body is supported NOW with the
 *    ATTACH inset (0.1). A body that stands with only the outer < 0.1 band of its footprint on
 *    the block / deck (onGround, and still attached through the inset-0 hysteresis) gets no
 *    guard at all and walks straight off while sneaking. The guard and the standing test use
 *    different footprints, which is exactly LESSONS 携带与实体 #1 ("潜行走到甲板边缘掉下去 →
 *    站立、推开、附着、挤压的采样点定义不一致") and violates ACCEPTANCE 19 (潜行走到甲板边缘不会
 *    掉下去) / the brief ("reject a horizontal step after which nothing supports the box").
 *
 * 2. Walking from a deck onto a pier. A floating ship's deck practically never sits exactly level
 *    with a world block. When it is even 0.01 lower, the world X/Z sweep treats the pier as a
 *    wall (no step-up onto world blocks), so ACCEPTANCE 19 "走上码头…时脱离" only works for a
 *    deck at exactly integer height. (The other direction, world -> slightly higher deck, does
 *    work for walking, because the structure push resolves it as ground.)
 *
 * 3. Rabbits on a raft. rabbitCanHop() refuses a hop when the WORLD cell at / below the target
 *    holds liquid, ignoring that a deck lies in between. A rabbit on any ship floating on water
 *    therefore never hops.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, makeCell, qfromYaw } from './harness';

describe('review: sneak guard uses the attach inset to decide whether it engages', () => {
  it('world platform: a player standing on the outer 0.05 of the footprint sneaks off the edge', () => {
    const b = new Bench();
    fill(b.world, -2, 60, -2, 2, 60, 2, B.STONE); // edge at x = 3
    const p = b.entities.createPlayer('survival', 3.25, 61, 0.5); // footprint overlaps the block by 0.05
    b.tick(3);
    expect(p.onGround).toBe(true);
    expect(p.pos.y).toBe(61);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east, over the edge
    b.tick(40);
    expect(p.pos.y).toBe(61); // sneaking must never step off
  });

  it('deck: an attached rider standing on the outer band sneaks off the edge and falls', () => {
    const b = new Bench();
    fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
    const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5)); // local edge at x = 4
    let x = 0.5;
    b.drive(ship, () => {
      x += 0.01;
      return { p: vec3(x, 60.5, 0.5), q: qfromYaw(0) };
    });
    const p = b.entities.createPlayer('survival', 0.5, 61.01, 0.5);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    // Footprint overlaps the deck by 0.06 (e.g. walked there without sneaking, then stopped).
    const w = ship.grid.toWorld(vec3(4.24, 61, 0.5));
    p.setPosition(w.x, w.y, w.z);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    expect(p.onGround).toBe(true);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2;
    b.tick(30);
    expect(p.carrierId).toBe(ship.id);
    expect(ship.grid.toLocal(p.pos, vec3()).y).toBeCloseTo(61, 3);
  });
});

describe('review: a deck floating a hair below a pier turns the pier into a wall', () => {
  it.each([-0.01, -0.05])('deck %f below the pier top: walking east never reaches the pier', (off) => {
    const b = new Bench();
    fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE); // pier, top at 61, starts at x = 6 (deck ends at 6)
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 60.5 + off, 0.5), qfromYaw(0));
    const p = b.entities.createPlayer('survival', 3.5, 61.02, 0.5);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east, onto the pier
    b.tick(40);
    // ACCEPTANCE 19: 走上码头时脱离 — the player should be on the pier and detached.
    expect(p.pos.x).toBeGreaterThan(6.5);
    expect(p.carrierId).toBe(0);
  });
});

describe('review: rabbits on a raft floating on water never hop', () => {
  it('hops on a raft over water as on the same raft over a dry floor', () => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    b.ship(1, deck(-4, -4, 4, 4, 47), vec3(0.5, 47.5, 0.5)); // deck top at 48, above the water
    const r = b.entities.spawnRabbit(0.5, 48.01, 0.5);
    let hops = 0;
    for (let i = 0; i < 2000; i++) {
      b.tick();
      if (r.vel.y > 3) hops++;
    }
    // The same raft over a dry floor gives ~77 hops in 2000 ticks.
    expect(hops).toBeGreaterThan(10);
  });
});
