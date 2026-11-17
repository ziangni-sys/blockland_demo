/**
 * Adversarial review (correctness): false crush on a rolled / pitched deck.
 *
 * Mover.applyPush() refuses a push axis when the moved box "newly overlaps ANOTHER structure"
 * (newlyOverlapsOther). For a body standing on a deck that is not exactly level (every
 * physical ship rolls and pitches a little), moving the body horizontally UPHILL by even a
 * fraction of a block makes its bottom corner dip into the sloped deck: that counts as a new
 * overlap with "another structure" (the deck), so the push from a blade / paddle / turntable
 * is refused, pushBlocked -> the remaining overlap is a crush -> damage + relocation.
 *
 * Nothing pins the player: it stands on an open deck and a paddle pushes it along the deck.
 * DESIGN 实体被挤: only "推不动（被世界方块或另一个结构体挡住）" is a crush; LESSONS 被风车沿
 * 船舷推时误判挤伤 / 站在甲板上被推回去. With roll 0.01 rad (0.6 degrees) the player in this
 * scene is "crushed" 15 times and loses 10 health; pushing downhill or on a level deck is fine.
 *
 * The same happens with the ship's own turntable / windmill sweeping a rider along a rolling
 * deck (found by fuzzing a turntable on a gently rolling ship: many crushes on the open deck).
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import { B, Bench, deck, TICK_DT } from './harness';

describe('review: a push uphill along a slightly rolled deck is judged a crush', () => {
  it.each([0.01, 0.03, -0.03])('paddle pushing a standing player along a deck rolled by %f rad: no crush, no damage', (roll) => {
    const b = new Bench();
    const ship = b.ship(1, deck(-6, -6, 6, 6, 60), vec3(0.5, 60.5, 0.5));
    // Roll about +X: the deck slopes along z (for roll > 0, -z is uphill).
    ship.grid.setPoseImmediate(vec3(0.5, 60.5, 0.5), qfromAxisAngle(vec3(1, 0, 0), roll));
    // A 3-wide, 2-high paddle (kinematic structure on the world) sweeping along z through the player,
    // toward the uphill side.
    const pc: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let y = 61; y <= 62; y++) pc.push([x, y, 0, B.CANVAS]);
    const paddle = b.rotor(20, null, [0, 61, 0], 2, pc);
    const dir = roll > 0 ? -1 : 1;
    const z0 = dir < 0 ? 4.5 : -3.5;
    b.drive(paddle, (t) => ({ p: vec3(0.5, 61.7, z0 + dir * 1.5 * t * TICK_DT), q: { x: 0, y: 0, z: 0, w: 1 } }));
    const p = b.entities.createPlayer('survival', 0.5, 61.4, 0.5);
    b.tick(90);
    expect(Math.abs(p.pos.z - 0.5)).toBeGreaterThan(2); // it was really pushed along the deck
    expect(p.carrierId).toBe(ship.id);
    expect(b.host.count('crush', p)).toBe(0);
    expect(p.health).toBe(20);
  });
});
