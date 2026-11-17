import { describe, expect, it } from 'vitest';
import { vec3, type Vec3 } from '../../src/core/math';
import { B, Bench, deck, fill, inStructure, inWorld, makeCell, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

function local(b: { ship: { grid: { toLocal(p: Vec3, o?: Vec3): Vec3 } } }, p: Vec3): Vec3 {
  return b.ship.grid.toLocal(p, vec3());
}

describe('ACCEPTANCE 19 — riding a ship', () => {
  it('a player standing on a deck that moves and yaws keeps its deck position for hundreds of ticks', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({
      p: vec3(0.5 + 1.2 * t * DT, 60.5 + 0.15 * Math.sin(t * 0.21), 0.5 - 0.7 * t * DT), // stays inside the loaded area
      q: qfromYaw(0.35 * t * DT + 0.05 * Math.sin(t * 0.13)),
    }));
    const p = b.entities.createPlayer('survival', 3.2, 61.02, 1.7);
    b.tick(30); // the deck slid under the player before it attached: let that slip die out
    expect(p.carrierId).toBe(ship.id);
    const l0 = local({ ship }, p.pos);
    const yaw0 = p.yaw;
    const shipYaw0 = 0.35 * b.ticks * DT + 0.05 * Math.sin(b.ticks * 0.13);
    for (let i = 0; i < 400; i++) {
      b.tick();
      expect(p.carrierId).toBe(ship.id);
      const l = local({ ship }, p.pos);
      expect(Math.abs(l.x - l0.x)).toBeLessThan(1e-6);
      expect(Math.abs(l.z - l0.z)).toBeLessThan(1e-6);
      expect(Math.abs(l.y - 61)).toBeLessThan(1e-6);
    }
    const shipYaw = 0.35 * b.ticks * DT + 0.05 * Math.sin(b.ticks * 0.13);
    expect(p.yaw - yaw0).toBeCloseTo(shipYaw - shipYaw0, 9);
    expect(p.input.yaw).toBe(p.yaw);
    expect(p.takeCarriedYaw()).toBeCloseTo(p.yaw - 0, 9);
    expect(p.health).toBe(20);
    expect(b.host.count('crush')).toBe(0);
  });

  it('walking on a moving, turning deck feels like walking on land', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-8, -8, 8, 8, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 3 * t * DT, 60.5, 0.5), q: qfromYaw(0.2 * t * DT) }));
    const p = b.entities.createPlayer('survival', 0.5, 61, 4.5);
    b.tick(30);
    const l0 = local({ ship }, p.pos);
    // Look toward deck-north; from now on the simulation turns the look with the deck.
    p.input.yaw = 0.2 * b.ticks * DT;
    p.input.forward = 1;
    b.tick(40);
    const l1 = local({ ship }, p.pos);
    // ~4.3 b/s for 2 s along local -Z, minus the spin-up
    expect(l0.z - l1.z).toBeGreaterThan(7.6);
    expect(l0.z - l1.z).toBeLessThan(8.7);
    expect(Math.abs(l1.x - l0.x)).toBeLessThan(0.05);
    expect(p.carrierId).toBe(ship.id);
  });

  it('jumping while the ship moves lands on the same deck spot', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 4 * t * DT, 60.5 + 0.1 * Math.sin(t * 0.3), 0.5 - 2 * t * DT), q: qfromYaw(0.4 * t * DT) }));
    const p = b.entities.createPlayer('survival', 2.5, 61, -1.5);
    b.tick(30);
    const l0 = local({ ship }, p.pos);
    p.input.jump = true;
    b.tick();
    p.input.jump = false;
    expect(p.onGround).toBe(false);
    let top = 0;
    const n = b.tickUntil(() => {
      top = Math.max(top, local({ ship }, p.pos).y - 61);
      return p.onGround;
    }, 60);
    expect(n).toBeLessThan(60);
    expect(top).toBeGreaterThan(1.1);
    expect(p.carrierId).toBe(ship.id);
    const l1 = local({ ship }, p.pos);
    expect(Math.abs(l1.x - l0.x)).toBeLessThan(1e-6);
    expect(Math.abs(l1.z - l0.z)).toBeLessThan(1e-6);
  });

  it('walking onto a world pier detaches; the ship then leaves without the player', () => {
    const b = new Bench();
    fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE); // pier, top at 61, next to the deck (deck x <= 5)
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    let moving = false;
    let z = 0.5;
    b.drive(ship, () => {
      if (moving) z += 1.5 * DT;
      return { p: vec3(0.5, 60.5, z), q: qfromYaw(0) };
    });
    const p = b.entities.createPlayer('survival', 3.5, 61, 0.5);
    b.tick(3);
    expect(p.carrierId).toBe(ship.id);
    p.input.forward = 1;
    p.input.yaw = -Math.PI / 2; // east, onto the pier
    b.tickUntil(() => p.carrierId === 0, 60);
    expect(p.carrierId).toBe(0);
    expect(p.pos.x).toBeLessThan(6.5); // detached as soon as the pier is underfoot
    b.tick(10);
    p.input.forward = 0;
    b.tick(40);
    const x = p.pos.x;
    const pz = p.pos.z;
    moving = true;
    b.tick(60);
    expect(p.carrierId).toBe(0);
    expect(p.pos.x).toBeCloseTo(x, 6);
    expect(p.pos.z).toBeCloseTo(pz, 6);
    expect(p.pos.y).toBe(61);
  });

  it('jumping overboard detaches (and keeps the ship velocity for a moment)', () => {
    const b = new Bench();
    fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
    const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 2 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const p = b.entities.createPlayer('survival', 0.5, 61, 2.5);
    b.tick(3);
    expect(p.carrierId).toBe(ship.id);
    p.input.forward = -1; // walk backwards = south, off the deck edge (z = 4)
    p.input.jump = true;
    b.tickUntil(() => p.carrierId === 0, 60);
    expect(p.carrierId).toBe(0);
    const lz = local({ ship }, p.pos).z;
    expect(lz).toBeGreaterThan(3.5 + 0.3 - 0.1 - 1e-6); // the inset footprint has left the hull's column
    expect(p.vel.x).toBeGreaterThan(1.5);
    p.input.forward = 0;
    p.input.jump = false;
    b.tick(60);
    expect(p.carrierId).toBe(0);
    expect(p.pos.y).toBe(41);
  });

  it('a swimmer treading water next to the corner of a ship turned 45 degrees is never attached or lifted', () => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    const cells = deck(-3, -3, 3, 3, 46);
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) cells.push([x, 47, z, B.PLANKS_OAK]);
    const ship = b.ship(1, cells, vec3(0.5, 47, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5, 47 + 0.06 * Math.sin(t * 0.25), 0.5), q: qfromYaw(Math.PI / 4 + 0.03 * Math.sin(t * 0.11)) }));
    b.tick();
    // The corner at local (+3.5, +3.5) and at local (-3.5, +3.5); put a swimmer just off each tip.
    for (const [lx, lz] of [
      [3.5, 3.5],
      [-3.5, 3.5],
      [3.5, -3.5],
    ]) {
      const c = ship.grid.toWorld(vec3(0.5 + lx, 47, 0.5 + lz));
      const dx = c.x - 0.5;
      const dz = c.z - 0.5;
      const l = Math.hypot(dx, dz);
      const p = b.entities.createPlayer('survival', c.x + (dx / l) * 0.2, 46.6, c.z + (dz / l) * 0.2);
      p.input.jump = true; // treading water
      let maxY = -Infinity;
      for (let i = 0; i < 300; i++) {
        b.tick();
        expect(p.carrierId).toBe(0);
        maxY = Math.max(maxY, p.pos.y);
      }
      expect(maxY).toBeLessThan(47.6); // never lifted onto the rim (top at 48)
      expect(p.wet).toBeGreaterThan(0.3);
    }
  });

  it.each([0.17, -0.17, 0.4])('walking along a world wall on a ship yawed by %f rad costs no health', (shipYaw) => {
    const b = new Bench();
    const cells = deck(-6, -6, 6, 6, 60);
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) if (Math.abs(x) === 6 || Math.abs(z) === 6) cells.push([x, 61, z, B.PLANKS_OAK]);
    const ship = b.ship(1, cells, vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({
      p: vec3(0.5, 60.5 + 0.04 * Math.sin(t * 0.3), 0.5),
      q: qfromYaw(shipYaw + 0.02 * Math.sin(t * 0.07)),
    }));
    // World wall whose south face (z = -4) cuts across the deck, through the rotated gunwale.
    fill(b.world, -20, 61, -6, 20, 63, -5, B.STONE);
    b.tick();
    const p = b.entities.createPlayer('survival', -3.5, 61.05, -3.6);
    b.checks.push(() => {
      expect(inWorld(b.world, p)).toBe(false);
      expect(p.health).toBe(20);
    });
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    for (const yaw of [-Math.PI / 2 + 0.3, Math.PI / 2 - 0.3, -Math.PI / 2 + 0.6, Math.PI / 2 - 0.05]) {
      p.input.forward = 1;
      p.input.yaw = yaw; // along the wall, pressing into it
      b.tick(70);
    }
    expect(b.host.count('crush')).toBe(0);
    expect(b.host.count('hurt')).toBe(0);
    expect(inStructure(ship, p)).toBe(false);
  });
});
