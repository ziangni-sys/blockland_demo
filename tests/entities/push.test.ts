import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import type { Entity } from '../../src/entities/entity';
import type { Rotor } from '../../src/structures/structure';
import { B, Bench, deck, fill, inStructure, inWorld, makeWorld, qfromYaw, TICK_DT } from './harness';

const UP = vec3(0, 1, 0);

/**
 * A vertical-axis rotor on the world: hub cell (0, 61, 0) and a blade two cells high along +X
 * (x = 1..6). Spinning positively about +Y the blade sweeps from +X toward -Z.
 */
function bladeRotor(b: Bench, omega: number, start = 0): Rotor {
  const cells: Array<[number, number, number, number]> = [[0, 61, 0, B.PLANKS_OAK]];
  for (let x = 1; x <= 6; x++) {
    cells.push([x, 61, 0, B.CANVAS]);
    cells.push([x, 62, 0, B.CANVAS]);
  }
  const r = b.rotor(10, null, [0, 61, 0], 2, cells);
  b.spin(r, omega, UP, start);
  return r;
}

function floor(b: Bench): void {
  fill(b.world, -20, 60, -20, 19, 60, 19, B.STONE);
}

function noOverlapCheck(b: Bench, r: Rotor, e: Entity): void {
  b.checks.push(() => {
    if (e.removed) return;
    expect(inStructure(r, e)).toBe(false);
    expect(inWorld(b.world, e)).toBe(false);
  });
}

describe('ACCEPTANCE 17 — a blade sweeping through players', () => {
  it('pushes a free-standing player aside without damage', () => {
    const b = new Bench();
    floor(b);
    b.entities.createPlayer('survival', 15.5, 61, 15.5); // the local player decides the mode
    const r = bladeRotor(b, 1.5);
    const p = b.entities.createPlayer('survival', 0.5, 61, -3.0);
    noOverlapCheck(b, r, p);
    const start = vec3(p.pos.x, p.pos.y, p.pos.z);
    b.tick(40);
    expect(Math.hypot(p.pos.x - start.x, p.pos.z - start.z)).toBeGreaterThan(0.5);
    expect(p.health).toBe(20);
    expect(b.host.count('crush')).toBe(0);
    expect(b.host.count('hurt')).toBe(0);
  });

  for (const mode of ['survival', 'creative'] as const) {
    it(`in a cage of world blocks: ${mode === 'survival' ? 'loses health and is moved to a free spot' : 'is only moved to a free spot'}`, () => {
      const b = new Bench();
      floor(b);
      // 1x2 cage around cell (0, 61..62, -3), roof at y = 63; the blade passes through blocks.
      for (const [x, z] of [
        [-1, -3],
        [1, -3],
        [0, -4],
        [0, -2],
      ]) fill(b.world, x!, 61, z!, x!, 62, z!, B.STONE);
      fill(b.world, -1, 63, -4, 1, 63, -2, B.STONE);
      const r = bladeRotor(b, 1.2);
      const p = b.entities.createPlayer(mode, 0.5, 61, -2.5);
      b.checks.push(() => {
        expect(inWorld(b.world, p)).toBe(false);
      });
      let crushTick = -1;
      for (let i = 0; i < 60 && crushTick < 0; i++) {
        b.tick();
        if (b.host.count('crush', p) > 0) crushTick = i;
      }
      expect(crushTick).toBeGreaterThan(0);
      // moved to a spot free of the world and of the blade
      expect(inStructure(r, p)).toBe(false);
      expect(inWorld(b.world, p)).toBe(false);
      expect(Math.hypot(p.pos.x - 0.5, p.pos.y - 61, p.pos.z + 2.5)).toBeGreaterThan(0.5);
      if (mode === 'survival') {
        expect(p.health).toBe(18);
        expect(b.host.count('hurt', p)).toBe(1);
      } else {
        expect(p.health).toBe(20);
        expect(b.host.count('hurt', p)).toBe(0);
      }
    });
  }

  it('a blade pushing a player along a ship gunwale is not a crush', () => {
    const b = new Bench();
    // Deck x -10..10, z -3..3 at y 60, gunwale (2 high) along the north edge z = -3.
    const cells = deck(-10, -3, 10, 3, 60);
    for (let x = -10; x <= 10; x++) {
      cells.push([x, 61, -3, B.PLANKS_OAK]);
      cells.push([x, 62, -3, B.PLANKS_OAK]);
    }
    const ship = b.ship(1, cells, vec3(0.5, 60.5, 0.5));
    // A paddle (kinematic structure) slanted by 20 degrees so its face pushes partly INTO the
    // gunwale while it sweeps east along the deck.
    const paddleCells: Array<[number, number, number, number]> = [];
    for (let z = -2; z <= 2; z++) for (let y = 61; y <= 62; y++) paddleCells.push([-8, y, z, B.CANVAS]);
    const paddle = b.rotor(20, null, [-8, 61, 0], 2, paddleCells);
    const p0 = vec3(-7.5, 62, 0.5);
    b.drive(paddle, (t) => ({ p: vec3(p0.x + 3 * t * TICK_DT, p0.y, p0.z), q: qfromYaw(0.35) }));
    const p = b.entities.createPlayer('survival', -4.5, 61, -1.65);
    b.tick(3);
    expect(p.carrierId).toBe(ship.id);
    b.checks.push(() => {
      expect(inStructure(ship, p)).toBe(false);
      expect(p.health).toBe(20);
    });
    b.tick(80);
    expect(p.pos.x).toBeGreaterThan(-1); // swept along the gunwale
    expect(b.host.count('crush')).toBe(0);
    expect(inStructure(paddle, p)).toBe(false);
  });
});

describe('ACCEPTANCE 18 — rabbits and item drops', () => {
  function cagedRabbitBench(mode: 'survival' | 'creative'): { b: Bench; reset: () => void; rabbit: ReturnType<Bench['entities']['spawnRabbit']> } {
    const b = new Bench();
    floor(b);
    b.entities.createPlayer(mode, 15.5, 61, 15.5);
    // 1x1x1 cage around cell (0, 61, -3)
    for (const [x, z] of [
      [-1, -3],
      [1, -3],
      [0, -4],
      [0, -2],
    ]) fill(b.world, x!, 61, z!, x!, 61, z!, B.STONE);
    fill(b.world, -1, 62, -4, 1, 62, -2, B.STONE);
    bladeRotor(b, 2.5);
    const rabbit = b.entities.spawnRabbit(0.5, 61, -2.5);
    rabbit.aiTimer = 100000; // keep it still
    const reset = (): void => {
      rabbit.pos.x = 0.5;
      rabbit.pos.y = 61;
      rabbit.pos.z = -2.5;
      rabbit.vel.x = rabbit.vel.y = rabbit.vel.z = 0;
    };
    return { b, reset, rabbit };
  }

  it('survival: squeezed three times, the rabbit is flattened', () => {
    const { b, reset, rabbit } = cagedRabbitBench('survival');
    let crushes = 0;
    for (let i = 0; i < 400 && !rabbit.removed; i++) {
      b.tick();
      const n = b.host.count('crush', rabbit);
      if (n > crushes) {
        crushes = n;
        if (!rabbit.removed) {
          expect(inWorld(b.world, rabbit)).toBe(false);
          reset(); // put it back into the cage for the next pass
        }
      }
    }
    expect(crushes).toBe(3);
    expect(rabbit.removed).toBe(true);
    expect(b.host.count('death', rabbit)).toBe(1);
  });

  it('creative: the rabbit is only moved', () => {
    const { b, reset, rabbit } = cagedRabbitBench('creative');
    let crushes = 0;
    for (let i = 0; i < 400; i++) {
      b.tick();
      const n = b.host.count('crush', rabbit);
      if (n > crushes) {
        crushes = n;
        reset();
      }
    }
    expect(crushes).toBeGreaterThanOrEqual(4);
    expect(rabbit.removed).toBe(false);
    expect(rabbit.crushCount).toBe(0);
  });

  it('item drops are pushed by blades, never destroyed (free or caged)', () => {
    const b = new Bench();
    floor(b);
    b.entities.createPlayer('survival', 15.5, 61, 15.5);
    fill(b.world, 2, 61, -4, 2, 62, -4, B.STONE);
    fill(b.world, 3, 61, -4, 3, 61, -4, B.STONE);
    bladeRotor(b, 2);
    const items = [];
    // different items, so they do not merge into each other
    const kinds = [B.COBBLE, B.DIRT, B.GRAVEL, B.PLANKS_OAK, B.PLANKS_PINE, B.GLASS, B.STONE_BRICKS, B.BRICKS];
    for (let i = 0; i < 8; i++) items.push(b.entities.spawnItem(1.5 + i * 0.4, 61.2, -3.5 + (i % 3) * 0.3, kinds[i]!, 1, vec3(0, 0, 0)));
    // one wedged in a corner of world blocks
    items.push(b.entities.spawnItem(2.5, 61.2, -3.5, B.SAND, 1, vec3(0, 0, 0)));
    const start = items.map((it) => vec3(it.pos.x, it.pos.y, it.pos.z));
    b.tick(200);
    let moved = 0;
    items.forEach((it, i) => {
      if (Math.hypot(it.pos.x - start[i]!.x, it.pos.z - start[i]!.z) > 0.5) moved++;
    });
    expect(moved).toBeGreaterThan(4);
    for (const it of items) {
      expect(it.removed).toBe(false);
      expect(inWorld(b.world, it)).toBe(false);
    }
    expect(b.host.count('despawn')).toBe(0);
  });
});

describe('ACCEPTANCE 20 — turntables', () => {
  /** 5x5 platform on the world spinning about +Y, hub (0, 61, 0). */
  it('a vertical-axis turntable carries and turns the rider', () => {
    const b = new Bench();
    floor(b);
    const cells: Array<[number, number, number, number]> = [];
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.push([x, 61, z, B.PLANKS_OAK]);
    const r = b.rotor(5, null, [0, 61, 0], 2, cells);
    b.spin(r, 0.8, UP);
    const p = b.entities.createPlayer('survival', 2.1, 62, 0.5);
    b.tick(30);
    expect(p.carrierId).toBe(r.id);
    const l0 = r.grid.toLocal(p.pos, vec3());
    const yaw0 = p.yaw;
    const angle0 = r.angle;
    for (let i = 0; i < 200; i++) {
      b.tick();
      expect(p.carrierId).toBe(r.id);
      const l = r.grid.toLocal(p.pos, vec3());
      expect(Math.abs(l.x - l0.x) + Math.abs(l.z - l0.z)).toBeLessThan(1e-6);
    }
    expect(p.yaw - yaw0).toBeCloseTo(r.angle - angle0, 6);
  });

  it('on a ship: stepping from the turntable to the deck switches carriers without falling through', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-7, -7, 7, 7, 60), vec3(0.5, 60.5, 0.5));
    const DT = TICK_DT;
    b.drive(ship, (t) => ({ p: vec3(0.5 + 1.5 * t * DT, 60.5 + 0.05 * Math.sin(t * 0.2), 0.5), q: qfromYaw(0.25 * t * DT) }));
    const plat: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) plat.push([x, 61, z, B.PLANKS_PINE]);
    const tt = b.rotor(2, ship, [0, 61, 0], 2, plat);
    b.spin(tt, 0.7, UP);
    b.tick();
    const start = ship.grid.toWorld(vec3(0.5, 62, 0.5));
    const p = b.entities.createPlayer('survival', start.x, start.y + 0.01, start.z);
    b.tick(30);
    expect(p.carrierId).toBe(tt.id);
    // walk off the platform onto the deck (1 block down)
    p.input.forward = 1;
    let minLocalY = Infinity;
    b.checks.push(() => {
      minLocalY = Math.min(minLocalY, ship.grid.toLocal(p.pos, vec3()).y);
      expect(inStructure(ship, p)).toBe(false);
    });
    b.tick(25);
    p.input.forward = 0;
    b.tick(20);
    expect(p.carrierId).toBe(ship.id);
    expect(ship.grid.toLocal(p.pos, vec3()).y).toBeCloseTo(61, 5);
    expect(minLocalY).toBeGreaterThan(61 - 0.1);
    // stays with the ship
    const l0 = ship.grid.toLocal(p.pos, vec3());
    b.tick(100);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    expect(Math.abs(l1.x - l0.x) + Math.abs(l1.z - l0.z)).toBeLessThan(1e-3);
    expect(p.health).toBe(20);
  });

  it('on a ship: a rider swept into a cabin wall lets go of the turntable (noAttachTicks) and is never inside the wall', () => {
    const b = new Bench();
    const cells = deck(-7, -7, 7, 7, 60);
    for (let z = -1; z <= 1; z++) for (let y = 62; y <= 63; y++) cells.push([2, y, z, B.PLANKS_OAK]); // cabin wall beside the platform
    const ship = b.ship(1, cells, vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 1 * t * TICK_DT, 60.5, 0.5), q: qfromYaw(0) }));
    const plat: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) plat.push([x, 61, z, B.PLANKS_PINE]);
    const tt = b.rotor(2, ship, [0, 61, 0], 2, plat);
    b.spin(tt, 1.2, UP);
    b.tick();
    const start = ship.grid.toWorld(vec3(1.4, 62, 1.4));
    const p = b.entities.createPlayer('survival', start.x, start.y, start.z);
    let sawRelease = false;
    b.checks.push(() => {
      expect(inStructure(ship, p)).toBe(false);
      expect(ship.grid.toLocal(p.pos, vec3()).y).toBeGreaterThan(61.9); // never through the platform / deck
      if (p.noAttachTicks > 0 && p.noAttachStructureId === tt.id && p.carrierId === ship.id) sawRelease = true;
    });
    b.tick(120);
    expect(sawRelease).toBe(true);
    expect(p.health).toBe(20);
  });
});

describe('LESSONS 站在行驶的船上被风车误推', () => {
  it('a rider on a fast ship right next to the ship\'s own windmill is never pushed or crushed', () => {
    const b = new Bench(makeWorld(-40, -40, 39, 103));
    const ship = b.ship(1, deck(-6, -6, 6, 6, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5, 60.5, 0.5 + 5 * t * TICK_DT), q: qfromYaw(0.3 * t * TICK_DT) }));
    // Windmill on the ship: axis along local +Z, hub (0, 64, -3), blades in the plane z = -3.
    const cells: Array<[number, number, number, number]> = [[0, 64, -3, B.PLANKS_OAK]];
    for (let k = 1; k <= 3; k++) {
      cells.push([k, 64, -3, B.CANVAS], [-k, 64, -3, B.CANVAS], [0, 64 + k, -3, B.CANVAS], [0, 64 - k, -3, B.CANVAS]);
    }
    const mill = b.rotor(2, ship, [0, 64, -3], 4, cells);
    b.spin(mill, 2.5, vec3(0, 0, 1));
    // The blade tips pass y 61..62 at local z in [-3, -2]. The rider's box is world-aligned, so
    // on the yawing deck its corner reaches up to 0.3 * sqrt(2) = 0.42 toward the blades:
    // standing at z = -1.55 it stays 0.03 clear. Judged at last tick's position (the ship
    // moves 0.25 per tick toward +Z) it would be inside the blades every time they pass.
    const p = b.entities.createPlayer('survival', 0.5, 61, -1.55);
    p.carrierId = ship.id; // aboard from the start (no slip while it would attach)
    const l0 = ship.grid.toLocal(p.pos, vec3());
    for (let i = 0; i < 240; i++) {
      b.tick();
      expect(p.carrierId).toBe(ship.id);
      const l = ship.grid.toLocal(p.pos, vec3());
      // (y may differ by the push skin: the feet rest 1e-6 above the deck)
      expect(Math.abs(l.x - l0.x) + Math.abs(l.y - l0.y) + Math.abs(l.z - l0.z)).toBeLessThan(1e-5);
    }
    expect(b.host.count('crush')).toBe(0);
    expect(p.health).toBe(20);
  });
});

describe('a ship moving into a standing player', () => {
  it('pushes the player along; against a wall it is a crush', () => {
    const b = new Bench();
    floor(b);
    b.entities.createPlayer('survival', 15.5, 61, 15.5);
    const cells: Array<[number, number, number, number]> = [];
    for (let z = -2; z <= 2; z++) for (let y = 61; y <= 63; y++) cells.push([-6, y, z, B.PLANKS_OAK]);
    const wallShip = b.ship(3, cells, vec3(-5.5, 62.5, 0.5));
    b.drive(wallShip, (t) => ({ p: vec3(-5.5 + 2.5 * t * TICK_DT, 62.5, 0.5), q: qfromYaw(0) }));
    const p = b.entities.createPlayer('survival', -3.5, 61, 0.5);
    fill(b.world, 2, 61, -3, 2, 63, 3, B.STONE); // wall at x = 2
    b.checks.push(() => expect(inWorld(b.world, p)).toBe(false));
    b.tick(30);
    expect(p.pos.x).toBeGreaterThan(-2);
    expect(b.host.count('crush', p)).toBe(0);
    b.tick(60);
    expect(b.host.count('crush', p)).toBeGreaterThan(0);
    expect(p.health).toBeLessThan(20);
  });
});
