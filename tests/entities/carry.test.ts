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

  it('riders follow the real motion even when a structure skips snapshotPose() or entity ticks are skipped', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    const pose = (t: number) => ({ p: vec3(0.5 + 1.5 * t * DT, 60.5 + 0.1 * Math.sin(t * 0.3), 0.5), q: qfromYaw(0.4 * t * DT) });
    const p = b.entities.createPlayer('survival', 2.5, 61, 1.5);
    p.carrierId = ship.id;
    const l0 = local({ ship }, p.pos);
    const g = ship.grid;
    for (let t = 1; t <= 300; t++) {
      // every 7th tick the "physics" forgets to snapshot; every 11th tick the entities are not run
      if (t % 7 !== 0) g.snapshotPose();
      const q = pose(t);
      g.position.x = q.p.x;
      g.position.y = q.p.y;
      g.position.z = q.p.z;
      g.rotation.x = q.q.x;
      g.rotation.y = q.q.y;
      g.rotation.z = q.q.z;
      g.rotation.w = q.q.w;
      if (t % 11 === 0) continue;
      b.entities.syncCarried();
      b.entities.update();
      const l = local({ ship }, p.pos);
      expect(Math.abs(l.x - l0.x) + Math.abs(l.z - l0.z)).toBeLessThan(1e-6);
      expect(p.carrierId).toBe(ship.id);
    }
  });

  it('moving the pivot (centre of mass changed) does not move the riders', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 60.5, 0.5), qfromYaw(0.5));
    const p = b.entities.createPlayer('survival', 1.5, 61, 1.5);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    const w0 = vec3(p.pos.x, p.pos.y, p.pos.z);
    ship.grid.setPivotKeepingPose(vec3(2.25, 60.5, -1.75));
    b.tick(5);
    expect(Math.abs(p.pos.x - w0.x) + Math.abs(p.pos.y - w0.y) + Math.abs(p.pos.z - w0.z)).toBeLessThan(1e-9);
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

  it.each([
    [3.5, 3.5],
    [-3.5, 3.5],
    [3.5, -3.5],
  ])('a swimmer treading water at the corner (%f, %f) of a ship turned 45 degrees is never attached or lifted', (lx, lz) => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    const cells = deck(-3, -3, 3, 3, 46);
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) cells.push([x, 47, z, B.PLANKS_OAK]);
    const ship = b.ship(1, cells, vec3(0.5, 47, 0.5));
    // World position of the corner tip: local (lx, lz) from the pivot, turned 45 degrees about
    // +Y (x' = x cos + z sin, z' = -x sin + z cos). The ship then drifts corner-first into the
    // swimmer while it bobs and wobbles, so the corner keeps shoving the swimmer around.
    const a = Math.PI / 4;
    const corner = vec3(0.5 + lx * Math.cos(a) + lz * Math.sin(a), 0, 0.5 - lx * Math.sin(a) + lz * Math.cos(a));
    const ux = (corner.x - 0.5) / Math.hypot(corner.x - 0.5, corner.z - 0.5);
    const uz = (corner.z - 0.5) / Math.hypot(corner.x - 0.5, corner.z - 0.5);
    b.drive(ship, (t) => ({
      p: vec3(0.5 + ux * 0.4 * t * DT, 47 + 0.08 * Math.sin(t * 0.25), 0.5 + uz * 0.4 * t * DT),
      q: qfromYaw(Math.PI / 4 + 0.12 * Math.sin(t * 0.11)),
    }));
    const p = b.entities.createPlayer('survival', corner.x + ux * 0.35, 46.6, corner.z + uz * 0.35);
    p.input.jump = true; // treading water
    const start = vec3(p.pos.x, p.pos.y, p.pos.z);
    let maxY = -Infinity;
    for (let i = 0; i < 300; i++) {
      b.tick();
      expect(p.carrierId).toBe(0);
      expect(inStructure(ship, p)).toBe(false);
      maxY = Math.max(maxY, p.pos.y);
    }
    expect(maxY).toBeLessThan(47.6); // never lifted onto the rim (top at 48)
    expect(p.wet).toBeGreaterThan(0.3);
    // the corner really did shove the swimmer (the ship drifted 6 blocks into it)
    expect(Math.hypot(p.pos.x - start.x, p.pos.z - start.z)).toBeGreaterThan(2);
  });

  it('swimming INTO a low raft while holding jump climbs aboard and attaches (deliberate, unlike drifting next to it)', () => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    const ship = b.ship(1, deck(-3, -3, 3, 3, 47), vec3(0.5, 47.5, 0.5)); // top at 48, just above the water
    b.drive(ship, (t) => ({ p: vec3(0.5, 47.5 + 0.05 * Math.sin(t * 0.2), 0.5), q: qfromYaw(0.3) }));
    const p = b.entities.createPlayer('survival', 0.5, 46.6, 6.5);
    p.input.jump = true;
    b.tick(40);
    expect(p.carrierId).toBe(0);
    p.input.forward = 1; // north, into the raft
    const n = b.tickUntil(() => p.carrierId === ship.id && p.onGround, 200);
    expect(n).toBeLessThan(200);
    expect(ship.grid.toLocal(p.pos, vec3()).y).toBeCloseTo(48, 3);
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
