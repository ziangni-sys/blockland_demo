/**
 * Adversarial review (correctness): ACCEPTANCE 19 "船转 45° 时在船角附近游泳，不会被拎上船" and the
 * brief's "A swimmer next to a hull is never attached".
 *
 * The implementer's acceptance test only TREADS water (jump held, no forward input), so it never
 * exercises the climb-out boost in motion.ts (playerMotion): while any part of the body is wet,
 * holding jump and moving at least ~17 degrees into a horizontal contact (world wall OR structure
 * side) sets vy = WATER_EXIT_SPEED (7.5 b/s) EVERY tick of contact. Swimming at the surface is
 * done with W + space, so a swimmer swimming toward the corner of a ship turned 45 degrees (each
 * face normal is 45 degrees to the approach) is launched ~1.3 blocks above the rim, lands on the
 * deck and is attached — exactly the "拎上船" the acceptance line forbids.
 *
 * Note for the fixer: this conflicts with the implementer's deliberate "swimming INTO a low raft
 * while holding jump climbs aboard" feature (carry.test.ts); the lead must decide whether the
 * climb-out applies to structures at all. As specified, it must not lift a swimmer near a hull.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, makeCell, qfromYaw, TICK_DT } from './harness';

describe('review: swimming (W + space) at the corner of a ship turned 45 degrees', () => {
  it.each([0.15, -0.15, 0.4])('swimming toward the corner (heading offset %f rad) is never lifted aboard or attached', (offset) => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    // Same hull as the implementer's ACCEPTANCE 19 test: deck at 46, 1-high rim at 47 (top 48).
    const cells = deck(-3, -3, 3, 3, 46);
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) cells.push([x, 47, z, B.PLANKS_OAK]);
    const ship = b.ship(1, cells, vec3(0.5, 47, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 47, 0.5), qfromYaw(Math.PI / 4));
    b.drive(ship, (t) => ({ p: vec3(0.5, 47 + 0.05 * Math.sin(t * 0.25), 0.5), q: qfromYaw(Math.PI / 4 + 0.02 * Math.sin(t * TICK_DT)) }));
    const corner = ship.grid.toWorld(vec3(4, 47, 4)); // the tip of the local (+x, +z) corner
    const p = b.entities.createPlayer('survival', corner.x + 3.5, 46.6, corner.z);
    const dx = corner.x - p.pos.x;
    const dz = corner.z - p.pos.z;
    p.input.yaw = Math.atan2(-dx, -dz) + offset;
    p.input.forward = 1;
    p.input.jump = true; // W + space: how one swims at the surface
    let maxY = -Infinity;
    for (let i = 0; i < 120; i++) {
      b.tick();
      expect(p.carrierId).toBe(0);
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY).toBeLessThan(47.6); // never lifted onto the rim (top at 48)
  });
});
