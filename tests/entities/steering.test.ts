import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { vec3 } from '../../src/core/math';
import { Player } from '../../src/entities/entity';
import { analyzeHull } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import { B, Bench, deck, fill, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;
const NZ = 5;

/** 9x9 deck at y 60 with a helm at local (0, 61, -2) facing north (-Z). */
function helmShip(b: Bench): Ship {
  const cells = deck(-4, -4, 4, 4, 60);
  const ship = b.ship(1, cells, vec3(0.5, 60.5, 0.5));
  ship.grid.setCell(0, 61, -2, makeCell(B.HELM, facingState(NZ)));
  ship.forward = NZ;
  return ship;
}

describe('ACCEPTANCE 21 — steering', () => {
  it('the seat follows the ship (position and heading); WASD does not move the helmsman', () => {
    const b = new Bench();
    const ship = helmShip(b);
    b.drive(ship, (t) => ({ p: vec3(0.5 + 2 * t * DT, 60.5 + 0.1 * Math.sin(t * 0.2), 0.5 - 1 * t * DT), q: qfromYaw(0.3 * t * DT) }));
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    b.tick(3);
    expect(b.entities.startSteering(p, ship, 0, 61, -2)).toBe(true);
    expect(p.steeringShipId).toBe(ship.id);
    expect(ship.helmsmanId).toBe(p.id);
    expect(p.seat).toEqual(vec3(0.5, 61, -0.5));
    p.input.forward = 1;
    p.input.strafe = 1;
    p.input.jump = true;
    const yaw0 = p.yaw;
    for (let i = 0; i < 200; i++) {
      b.tick();
      const seat = ship.grid.toWorld(p.seat, vec3());
      expect(Math.abs(p.pos.x - seat.x) + Math.abs(p.pos.y - seat.y) + Math.abs(p.pos.z - seat.z)).toBeLessThan(1e-9);
      expect(p.carrierId).toBe(ship.id);
      expect(ship.helmsmanId).toBe(p.id);
    }
    expect(p.yaw - yaw0).toBeCloseTo(0.3 * 200 * DT, 9);
    // a second player cannot take the wheel
    const q = b.entities.add(new Player(b.entities.allocateId(), 'survival'));
    expect(b.entities.startSteering(q, ship, 0, 61, -2)).toBe(false);
  });

  it('death releases the wheel; respawn puts the player at the spawn point', () => {
    const b = new Bench();
    fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
    const ship = helmShip(b);
    b.drive(ship, (t) => ({ p: vec3(0.5 + 1 * t * DT, 60.5, 0.5), q: qfromYaw(0.2 * t * DT) }));
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    p.spawn.x = 10.5;
    p.spawn.y = 41;
    p.spawn.z = -7.5;
    b.tick(2);
    b.entities.startSteering(p, ship, 0, 61, -2);
    ship.throttle = 0.8;
    ship.rudder = -0.4;
    b.tick(20);
    b.entities.kill(p, 'test');
    expect(p.dead).toBe(true);
    expect(p.steeringShipId).toBe(0);
    expect(p.carrierId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(ship.rudder).toBe(0);
    expect(b.host.count('helmReleased', p)).toBe(1);
    expect(b.host.count('death', p)).toBe(1);
    // dead players do not move with the ship
    const x = p.pos.x;
    b.tick(20);
    expect(p.pos.x).toBe(x);
    b.entities.respawn(p);
    expect(p.dead).toBe(false);
    expect(p.health).toBe(20);
    expect(p.air).toBe(300);
    expect(p.pos).toEqual(vec3(10.5, 41, -7.5));
    expect(p.prevPos).toEqual(p.pos);
    b.tick(5);
    expect(p.pos.y).toBe(41);
    expect(p.onGround).toBe(true);
  });

  it('stopSteering leaves the player aboard; releaseRiders frees helmsman and riders', () => {
    const b = new Bench();
    const ship = helmShip(b);
    b.drive(ship, (t) => ({ p: vec3(0.5 + 1 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    const item = b.entities.spawnItem(2.5, 61.3, 2.5, B.COBBLE, 3, vec3(0, 0, 0));
    b.tick(10);
    expect(item.carrierId).toBe(ship.id);
    b.entities.startSteering(p, ship, 0, 61, -2);
    ship.throttle = 1;
    b.tick(5);
    b.entities.stopSteering(p);
    expect(ship.throttle).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    b.tick(5);
    expect(p.carrierId).toBe(ship.id);
    b.entities.startSteering(p, ship, 0, 61, -2);
    b.tick(2);
    b.entities.releaseRiders(ship);
    expect(p.steeringShipId).toBe(0);
    expect(p.carrierId).toBe(0);
    expect(item.carrierId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
    expect(item.vel.x).toBeCloseTo(0, 6); // the dock does not move: carrier velocity dropped
  });

  it('a seat that ends up inside a world block releases the wheel; a removed ship too', () => {
    const b = new Bench();
    const ship = helmShip(b);
    b.drive(ship, (t) => ({ p: vec3(0.5, 60.5, 0.5 - 2 * t * DT), q: qfromYaw(0) }));
    // a low beam across the deck path at the helmsman's head height
    fill(b.world, -10, 62, -12, 10, 62, -12, B.STONE);
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    b.tick(2);
    b.entities.startSteering(p, ship, 0, 61, -2);
    b.tickUntil(() => p.steeringShipId === 0, 300);
    expect(p.steeringShipId).toBe(0);
    expect(b.host.events.find((e) => e.type === 'helmReleased')?.cause).toBe('blocked');
    // removed ship
    const c = new Bench();
    const ship2 = helmShip(c);
    const q = c.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    c.tick(2);
    c.entities.startSteering(q, ship2, 0, 61, -2);
    c.tick(2);
    ship2.removed = true;
    c.host.list.length = 0;
    c.tick();
    expect(q.steeringShipId).toBe(0);
    expect(c.host.count('helmReleased', q)).toBe(1);
  });
});

describe('ACCEPTANCE 22 — drowning and dry hulls', () => {
  /**
   * An open boat: floor at y 44, walls two high (45..46) around a 3x3 hold, a helm in the hold
   * facing north, completely under water (water up to y 55). `id` decides whether it floats.
   */
  function sunkBoat(id: number): { b: Bench; ship: Ship } {
    const b = new Bench();
    fill(b.world, -12, 38, -12, 12, 38, 12, B.STONE);
    fill(b.world, -12, 39, -12, 12, 55, 12, makeCell(B.WATER));
    const cells: Array<[number, number, number, number]> = deck(-2, -2, 2, 2, 44, id);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 2 || Math.abs(z) === 2) {
      cells.push([x, 45, z, id]);
      cells.push([x, 46, z, id]);
    }
    const ship = b.ship(1, cells, vec3(0.5, 45, 0.5));
    ship.grid.setCell(0, 45, -1, makeCell(B.HELM, facingState(NZ)));
    ship.forward = NZ;
    return { b, ship };
  }

  it('the helmsman of a ship whose hull does not float drowns', () => {
    const { b, ship } = sunkBoat(B.STONE);
    ship.hull = analyzeHull(ship.grid);
    expect(ship.hull!.floats).toBe(false);
    const p = b.entities.spawnPlayer('survival', 0.5, 45, 0.5);
    b.tick(2);
    expect(b.entities.startSteering(p, ship, 0, 45, -1)).toBe(true);
    b.tick(5);
    expect(p.headWet).toBe(true);
    b.tick(300);
    expect(p.air).toBe(0);
    b.tickUntil(() => p.dead, 400);
    expect(p.dead).toBe(true);
    expect(b.host.events.some((e) => e.type === 'hurt' && e.cause === 'drown')).toBe(true);
    expect(p.steeringShipId).toBe(0);
    expect(ship.helmsmanId).toBe(0);
  });

  it('no drowning in the dry hold of a ship that floats', () => {
    const { b, ship } = sunkBoat(B.PLANKS_OAK);
    ship.hull = analyzeHull(ship.grid);
    expect(ship.hull!.floats).toBe(true);
    const p = b.entities.spawnPlayer('survival', 0.5, 45, 0.5);
    b.tick(2);
    b.entities.startSteering(p, ship, 0, 45, -1);
    for (let i = 0; i < 400; i++) {
      b.tick();
      expect(p.wet).toBe(0);
      expect(p.headWet).toBe(false);
    }
    expect(p.air).toBe(300);
    expect(p.health).toBe(20);
  });

  it('no drowning in a sealed cabin under water, even when the ship cannot float', () => {
    const b = new Bench();
    fill(b.world, -12, 38, -12, 12, 38, 12, B.STONE);
    fill(b.world, -12, 39, -12, 12, 55, 12, makeCell(B.WATER));
    const cells: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 44; y <= 47; y++) {
      if (x === 0 && z === 0 && (y === 45 || y === 46)) continue;
      cells.push([x, y, z, B.IRON_BLOCK]);
    }
    const ship = b.ship(1, cells, vec3(0.5, 45.5, 0.5));
    ship.hull = analyzeHull(ship.grid);
    expect(ship.hull!.floats).toBe(false);
    b.drive(ship, (t) => ({ p: vec3(0.5, 45.5 - 0.02 * Math.sin(t * 0.1), 0.5), q: qfromYaw(0) }));
    const p = b.entities.spawnPlayer('survival', 0.5, 45, 0.5);
    for (let i = 0; i < 400; i++) {
      b.tick();
      expect(p.headWet).toBe(false);
      expect(p.wet).toBe(0);
    }
    expect(p.air).toBe(300);
    expect(p.carrierId).toBe(ship.id);
    // the same spot without the hull is water
    ship.removed = true;
    b.host.list.length = 0;
    b.tick();
    expect(p.headWet).toBe(true);
  });
});
