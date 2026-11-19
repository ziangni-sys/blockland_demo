/**
 * Regression tests written while fixing the adversarial review findings: they pin the limits of
 * each fix (what must still NOT happen) and the cases the review tests do not cover.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qmul, vec3 } from '../../src/core/math';
import { ItemEntity, Player } from '../../src/entities/entity';
import type { EntityEvent } from '../../src/entities/host';
import { SNEAK_LADDER_STEP } from '../../src/entities/constants';
import { Inventory } from '../../src/entities/inventory';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { B, Bench, deck, fill, inStructure, inWorld, makeCell, makeWorld, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;
const UP = vec3(0, 1, 0);

describe('step-up onto world ledges (pier fix): its limits', () => {
  it('walking into a 1-block world step is still blocked: no auto-climbing terrain', () => {
    const b = new Bench();
    fill(b.world, -20, 60, -20, 19, 60, 19, B.STONE);
    fill(b.world, -5, 61, -20, 5, 61, -3, B.STONE); // a 1-high step, face at z = -2
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 2.5);
    p.input.forward = 1; // north
    b.checks.push(() => expect(inWorld(b.world, p)).toBe(false));
    b.tick(60);
    expect(p.pos.y).toBe(61);
    expect(p.pos.z).toBeCloseTo(-2 + 0.3, 6);
  });

  it('a deck 0.5 below a pier: the player steps ashore and detaches; 0.7 below: it cannot', () => {
    for (const [dy, ashore] of [
      [0.5, true],
      [0.7, false],
    ] as const) {
      const b = new Bench();
      fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE); // pier, top at 61
      const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
      ship.grid.setPoseImmediate(vec3(0.5, 60.5 - dy, 0.5), qfromYaw(0));
      const p = b.entities.spawnPlayer('survival', 3.5, 61 - dy + 0.01, 0.5);
      b.tick(5);
      expect(p.carrierId).toBe(ship.id);
      p.input.forward = 1;
      p.input.yaw = -Math.PI / 2; // east
      b.checks.push(() => expect(inWorld(b.world, p)).toBe(false));
      b.tick(40);
      if (ashore) {
        expect(p.pos.x).toBeGreaterThan(7);
        expect(p.pos.y).toBe(61);
        expect(p.carrierId).toBe(0);
      } else {
        expect(p.pos.x).toBeLessThan(6);
        expect(p.carrierId).toBe(ship.id);
      }
    }
  });

  it('boarding: from a pier the player walks onto a deck 0.4 higher and attaches; 0.7 higher blocks', () => {
    for (const [dy, aboard] of [
      [0.4, true],
      [0.7, false],
    ] as const) {
      const b = new Bench();
      fill(b.world, 6, 60, -2, 14, 60, 2, B.STONE); // pier, top at 61, west face at x = 6
      const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
      ship.grid.setPoseImmediate(vec3(0.5, 60.5 + dy, 0.5), qfromYaw(0.2)); // deck top 61 + dy, slightly turned
      const p = b.entities.spawnPlayer('survival', 9.5, 61, 0.5);
      b.tick(3);
      p.input.forward = 1;
      p.input.yaw = Math.PI / 2; // west, toward the deck
      b.checks.push(() => {
        expect(inStructure(ship, p)).toBe(false);
        expect(inWorld(b.world, p)).toBe(false);
      });
      b.tick(40);
      if (aboard) {
        expect(p.carrierId).toBe(ship.id);
        expect(ship.grid.toLocal(p.pos, vec3()).y).toBeCloseTo(61, 4);
        expect(p.pos.x).toBeLessThan(4);
      } else {
        expect(p.carrierId).toBe(0);
        expect(p.pos.y).toBe(61);
      }
      expect(b.host.count('crush')).toBe(0);
    }
  });

  it('a swimmer swimming into a raft side whose top is within a step of its feet is still not lifted aboard', () => {
    const b = new Bench();
    fill(b.world, -20, 40, -20, 19, 40, 19, B.STONE);
    fill(b.world, -20, 41, -20, 19, 47, 19, makeCell(B.WATER));
    const ship = b.ship(1, deck(-3, -3, 3, 3, 47), vec3(0.5, 47.5, 0.5)); // top at 48
    const p = b.entities.spawnPlayer('survival', 0.5, 47.5, 6.5); // feet 0.5 below the deck top
    p.input.forward = 1;
    p.input.jump = true;
    for (let i = 0; i < 120; i++) {
      b.tick();
      expect(p.carrierId).toBe(0);
      expect(p.pos.y).toBeLessThan(47.6);
    }
    expect(ship.grid.toLocal(p.pos, vec3()).z).toBeLessThan(4.5);
  });

  it('item drops never step up', () => {
    const b = new Bench();
    fill(b.world, -20, 60, -20, 19, 60, 19, B.STONE);
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 61.3, 0.5), qfromYaw(0)); // deck top at 61.8
    fill(b.world, 6, 61, -2, 8, 61, 2, B.STONE); // a 1-high world ledge (top 62) beside the deck
    const it = b.entities.spawnItem(5.6, 61.95, 0.5, B.COBBLE, 1, vec3(6, 0, 0));
    b.tick(30);
    expect(it.pos.x).toBeLessThan(6);
    expect(inWorld(b.world, it)).toBe(false);
  });
});

describe('sneak edge guard: more shapes', () => {
  it('a sneaking rider of a world turntable spinning at 0.6 rad/s never walks off', () => {
    for (const heading of [0, 2.2]) {
      const b = new Bench();
      fill(b.world, -20, 50, -20, 19, 50, 19, B.STONE);
      const cells: Array<[number, number, number, number]> = [];
      for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.push([x, 61, z, B.PLANKS_OAK]);
      const tt = b.rotor(5, null, [0, 61, 0], 2, cells);
      b.spin(tt, 0.6, UP);
      const p = b.entities.spawnPlayer('survival', 0.5, 62, 0.5);
      b.tick(10);
      expect(p.carrierId).toBe(tt.id);
      p.input.sneak = true;
      p.input.forward = 1;
      for (let i = 0; i < 300; i++) {
        p.input.yaw = heading + tt.angle;
        b.tick();
        expect(p.carrierId).toBe(tt.id);
        expect(p.pos.y).toBeGreaterThan(61.99);
      }
    }
  });

  it('a player standing in the band outside the guard disk can still sneak ALONG the edge, never outward', () => {
    const b = new Bench();
    fill(b.world, -2, 60, -5, 2, 60, 5, B.STONE); // east edge at x = 3
    const p = b.entities.spawnPlayer('survival', 3.27, 61, 0.5);
    b.tick(3);
    expect(p.onGround).toBe(true);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = 0; // north, along the edge
    b.tick(40);
    expect(p.pos.y).toBe(61);
    expect(p.pos.z).toBeLessThan(-0.8); // moved along
    // never farther out than the next rung of the support ladder (no ratchet)
    expect(p.pos.x).toBeLessThanOrEqual(3.27 + SNEAK_LADDER_STEP);
    p.input.yaw = -Math.PI / 4; // north-east, half outward
    b.tick(40);
    expect(p.pos.y).toBe(61);
    expect(p.pos.x).toBeLessThanOrEqual(3.27 + SNEAK_LADDER_STEP);
    p.input.yaw = -Math.PI / 2; // straight out, for a long time
    b.tick(200);
    expect(p.pos.y).toBe(61);
    expect(p.pos.x).toBeLessThanOrEqual(3.27 + SNEAK_LADDER_STEP);
  });

  it('at the outer corner of a world platform, sneaking diagonally outward stops', () => {
    const b = new Bench();
    fill(b.world, -2, 60, -2, 2, 60, 2, B.STONE); // corner at (3, 3)
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 0.5);
    p.input.sneak = true;
    p.input.forward = 1;
    p.input.yaw = (-3 * Math.PI) / 4; // toward +x +z
    b.tick(120);
    expect(p.pos.y).toBe(61);
    expect(p.pos.x).toBeGreaterThan(2.5);
    expect(p.pos.z).toBeGreaterThan(2.5);
  });

  it('a rider stopped at the deck edge by sneaking can jump there and comes down with the sailing, yawing ship', () => {
    const b = new Bench();
    fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
    const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
    const shipYaw = (t: number) => 0.3 * t * DT;
    b.drive(ship, (t) => ({ p: vec3(-8 + 3 * t * DT, 60.5, 0.5), q: qfromYaw(shipYaw(t)) }));
    b.tick();
    const w = ship.grid.toWorld(vec3(0.5, 61.01, 0.5));
    const p = b.entities.spawnPlayer('survival', w.x, w.y, w.z);
    p.carrierId = ship.id;
    b.tick(5);
    p.input.sneak = true;
    p.input.forward = 1;
    for (let i = 0; i < 80; i++) {
      p.input.yaw = Math.PI + shipYaw(b.ticks); // toward the deck's local +Z edge
      b.tick();
    }
    p.input.forward = 0;
    const l0 = ship.grid.toLocal(p.pos, vec3());
    expect(l0.z).toBeGreaterThan(3.5); // really at the edge (local edge at z = 4)
    for (let k = 0; k < 3; k++) {
      p.input.jump = true;
      b.tick();
      p.input.jump = false;
      for (let i = 0; i < 30; i++) {
        b.tick();
        expect(p.carrierId).toBe(ship.id);
      }
      expect(p.onGround).toBe(true);
      const l = ship.grid.toLocal(p.pos, vec3());
      expect(l.y).toBeCloseTo(61, 4);
      expect(Math.hypot(l.x - l0.x, l.z - l0.z)).toBeLessThan(1e-3);
    }
  });
});

describe('landing on a deck rim', () => {
  it.each([1.5, 6])('a body falling %f blocks onto a turned deck with its footprint 0.1 over the rim lands on it', (h) => {
    const b = new Bench();
    fill(b.world, -30, 40, -30, 29, 40, 29, B.STONE);
    const ship = b.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setPoseImmediate(vec3(0.5, 60.5, 0.5), qfromYaw(0.25));
    const w = ship.grid.toWorld(vec3(0.5, 61 + h, 4.2)); // centre 0.2 beyond the local edge z = 4
    const p = b.entities.spawnPlayer('survival', w.x, w.y, w.z);
    b.tick(60);
    expect(p.onGround).toBe(true);
    expect(p.carrierId).toBe(ship.id);
    expect(ship.grid.toLocal(p.pos, vec3()).y).toBeCloseTo(61, 4);
    // An item drop (no player around to pick it up) with its box 0.07 over the rim.
    const c = new Bench();
    const ship2 = c.ship(1, deck(-3, -3, 3, 3, 60), vec3(0.5, 60.5, 0.5));
    ship2.grid.setPoseImmediate(vec3(0.5, 60.5, 0.5), qfromYaw(0.25));
    const wi = ship2.grid.toWorld(vec3(-1.5, 61 + h, 4.055));
    const it = c.entities.spawnItem(wi.x, wi.y, wi.z, B.COBBLE, 1, vec3());
    c.tick(60);
    expect(it.onGround).toBe(true);
    expect(it.carrierId).toBe(ship2.id);
    expect(ship2.grid.toLocal(it.pos, vec3()).y).toBeCloseTo(61, 4);
  });
});

describe('free-spot search', () => {
  it('drops buried deep in rock rise to the surface (and stay out of the rock)', () => {
    const b = new Bench();
    fill(b.world, -12, 20, -12, 12, 50, 12, B.STONE); // solid hill, top at 51
    b.entities.spawnPlayer('survival', 8.5, 51, 8.5);
    const drops: ItemEntity[] = [];
    for (let k = 0; k < 5; k++) drops.push(b.entities.spawnItem(-3.5 + k, 45.5, 0.5, B.CANVAS + 0 * k, 1, vec3()));
    b.tick(40);
    for (const d of drops) {
      if (d.removed) continue; // merged into a neighbour
      expect(inWorld(b.world, d)).toBe(false);
      expect(d.pos.y).toBeCloseTo(51, 5);
    }
  });

  it('a buried player is not risen through the rock: suffocation damage instead', () => {
    const b = new Bench();
    fill(b.world, -12, 20, -12, 12, 50, 12, B.STONE);
    const p = b.entities.spawnPlayer('survival', 0.5, 45, 0.5);
    b.tick(60);
    expect(p.pos.y).toBe(45);
    expect(p.health).toBeLessThan(20);
    expect(b.host.count('hurt', p)).toBeGreaterThan(1);
  });
});

describe('spawnItem', () => {
  it('splits a count above the stack size into full drops', () => {
    const b = new Bench();
    const first = b.entities.spawnItem(0.5, 61, 0.5, B.COBBLE, 150, vec3());
    const drops = b.entities.all().filter((e): e is ItemEntity => e instanceof ItemEntity);
    expect(drops[0]).toBe(first);
    expect(drops.map((d) => d.stack.count)).toEqual([64, 64, 22]);
    expect(() => b.entities.spawnItem(0.5, 61, 0.5, B.COBBLE, 2.7, vec3())).not.toThrow(); // floored to 2
    expect(() => b.entities.spawnItem(Number.NaN, 61, 0.5, B.COBBLE, 1)).toThrow(RangeError);
  });
});

describe('inventory', () => {
  it('a corrupt blob leaves the inventory untouched', () => {
    const src = new Inventory();
    src.add(B.COBBLE, 70);
    src.add(B.DIRT, 5);
    const w = new ByteWriter();
    src.serialize(w);
    const bytes = w.finish();
    const inv = new Inventory();
    inv.add(B.SAND, 9);
    inv.selected = 4;
    expect(() => inv.deserialize(new ByteReader(bytes.slice(0, bytes.length - 3)))).toThrow();
    expect(inv.count(B.SAND)).toBe(9);
    expect(inv.count(B.COBBLE)).toBe(0);
    expect(inv.selected).toBe(4);
  });

  it('a stack a caller broke (fraction, zero) never makes serialize throw', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.COBBLE, count: 3.5 };
    inv.hotbar[1] = { item: B.DIRT, count: 0 };
    const w = new ByteWriter();
    expect(() => inv.serialize(w)).not.toThrow();
    const back = new Inventory();
    back.deserialize(new ByteReader(w.finish()));
    expect(back.hotbar[0]).toEqual({ item: B.COBBLE, count: 3 });
    expect(back.hotbar[1]).toBe(null);
  });
});

describe('re-entrancy', () => {
  it('a helmReleased listener that removes the helmsman does not make releaseRiders skip the next rider', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    ship.grid.setCell(0, 61, -2, makeCell(B.STONE)); // something to call a helm (any cell works for the seat logic)
    const p = b.entities.spawnPlayer('survival', 0.5, 61, 1.5);
    const rabbit = b.entities.spawnRabbit(2.5, 61, 2.5);
    rabbit.aiTimer = 100000;
    b.tick(5);
    expect(rabbit.carrierId).toBe(ship.id);
    expect(b.entities.startSteering(p, ship, 0, 61, -2)).toBe(true);
    b.tick(2);
    const emit = b.host.emit.bind(b.host);
    b.host.emit = (ev: EntityEvent) => {
      emit(ev);
      if (ev.type === 'helmReleased' && ev.entity instanceof Player) b.entities.remove(ev.entity);
    };
    b.entities.releaseRiders(ship, null);
    expect(p.removed).toBe(true);
    expect(rabbit.carrierId).toBe(0);
    expect(b.entities.all()).not.toContain(p);
  });

  it('a chain crate spawned by an explosion survives the end of the tick', () => {
    const b = new Bench();
    fill(b.world, -10, 59, -10, 10, 59, 10, B.STONE);
    b.host.explode = () => {
      b.entities.spawnTnt(3, 60, 3, 40);
    };
    b.entities.spawnTnt(0, 60, 0, 2);
    b.tick(3);
    const crates = b.entities.all().filter((e) => e.kind === 'tnt');
    expect(crates.length).toBe(1);
    expect(crates[0]!.removed).toBe(false);
  });
});

describe('carrying is idempotent', () => {
  it('a repeated syncCarried() on a yawing, sailing ship moves and turns the rider only once', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(-10 + 4 * t * DT, 60.5, 0.5), q: qfromYaw(0.5 * t * DT) }));
    b.tick();
    const w = ship.grid.toWorld(vec3(2.5, 61, 1.5));
    const p = b.entities.spawnPlayer('survival', w.x, w.y, w.z);
    b.tick(20);
    expect(p.carrierId).toBe(ship.id);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    const rel0 = p.yaw - 0.5 * b.ticks * DT;
    for (let i = 0; i < 10; i++) {
      b.world.time++;
      for (const s of b.host.list) s.grid.snapshotPose();
      for (const m of b.motions) m(++b.ticks);
      b.entities.syncCarried();
      b.entities.syncCarried();
      b.entities.update();
      const ownX = p.vel.x - p.carrierVel.x;
      b.entities.syncCarried(); // between ticks too
      expect(p.vel.x - p.carrierVel.x).toBeCloseTo(ownX, 9); // the own motion is untouched
    }
    const l1 = ship.grid.toLocal(p.pos, vec3());
    expect(Math.hypot(l1.x - l0.x, l1.z - l0.z)).toBeLessThan(1e-6);
    expect(p.yaw - 0.5 * b.ticks * DT).toBeCloseTo(rel0, 9);
    b.tick();
    expect(p.carrierVel.x).toBeGreaterThan(1); // the ship's velocity is back after the next tick's carry
  });
});

describe('structure pushes: the floor lift has limits', () => {
  it('a paddle pinning a rider against a 2-high cabin wall on the deck is a crush, never a climb over it', () => {
    const b = new Bench();
    const cells = deck(-6, -3, 6, 3, 60);
    for (let z = -3; z <= 3; z++) for (let y = 61; y <= 62; y++) cells.push([3, y, z, B.PLANKS_OAK]);
    const ship = b.ship(1, cells, vec3(0.5, 60.5, 0.5));
    // a rolling deck, so the floor lift is in play
    ship.grid.setPoseImmediate(vec3(0.5, 60.5, 0.5), qfromAxisAngle(vec3(0, 0, 1), 0.02));
    const pc: Array<[number, number, number, number]> = [];
    for (let z = -1; z <= 1; z++) for (let y = 61; y <= 62; y++) pc.push([-4, y, z, B.CANVAS]);
    const paddle = b.rotor(20, null, [-4, 61, 0], 2, pc);
    b.drive(paddle, (t) => ({ p: vec3(-3.5 + 1.5 * t * DT, 61.6, 0.5), q: { x: 0, y: 0, z: 0, w: 1 } }));
    const p = b.entities.spawnPlayer('survival', 0.5, 61.1, 0.5);
    let maxLocalY = -Infinity;
    b.checks.push(() => {
      maxLocalY = Math.max(maxLocalY, ship.grid.toLocal(p.pos, vec3()).y);
      expect(inStructure(ship, p)).toBe(false);
    });
    b.tick(80);
    expect(b.host.count('crush', p)).toBeGreaterThan(0);
    expect(p.health).toBeLessThan(20);
    expect(maxLocalY).toBeLessThan(61.5);
  });
});

describe('structure pushes on a rolling, pitching ship', () => {
  it('bodies on the open deck around the ship\'s own spinning turntable are pushed, never crushed', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-6, -6, 6, 6, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({
      p: vec3(0.5 + 0.5 * t * DT, 60.5 + 0.06 * Math.sin(t * 0.2), 0.5),
      q: qmul(qfromYaw(0.2 * t * DT), qmul(qfromAxisAngle(vec3(1, 0, 0), 0.03 * Math.sin(t * 0.1)), qfromAxisAngle(vec3(0, 0, 1), 0.025 * Math.cos(t * 0.13)))),
    }));
    const plat: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) plat.push([x, 61, z, B.PLANKS_PINE]);
    const tt = b.rotor(2, ship, [0, 61, 0], 2, plat);
    b.spin(tt, 1.1, UP);
    b.tick();
    b.entities.spawnPlayer('survival', 30.5, 61, 30.5); // survival world, far away
    const bodies = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const w = ship.grid.toWorld(vec3(0.5 + 2.25 * Math.cos(a), 61.02, 0.5 + 2.25 * Math.sin(a)));
      if (k % 2 === 0) {
        const r = b.entities.spawnRabbit(w.x, w.y, w.z);
        r.aiTimer = 100000; // stays put: only the turntable moves it
        bodies.push(r);
      } else {
        const it = b.entities.spawnItem(w.x, w.y + 0.13, w.z, B.COBBLE + k, 1, vec3());
        it.pickupDelay = 100000; // the player on deck must not pick it up
        bodies.push(it);
      }
    }
    const pw = ship.grid.toWorld(vec3(0.5, 61.02, -1.9));
    const p = b.entities.spawnPlayer('survival', pw.x, pw.y, pw.z);
    b.tick(400);
    expect(b.host.count('crush')).toBe(0);
    expect(p.health).toBe(20);
    for (const e of [...bodies, p]) {
      expect(e.removed).toBe(false);
      expect(e.carrierId === ship.id || e.carrierId === tt.id).toBe(true);
    }
  });
});

describe('frozen drops', () => {
  it('a drop in an unloaded chunk within reach is not picked up', () => {
    const b = new Bench(makeWorld(-16, -16, 15, 15));
    fill(b.world, -16, 40, -16, 15, 40, 15, B.STONE);
    const p = b.entities.spawnPlayer('survival', 15.5, 41, 0.5);
    const it = b.entities.spawnItem(16.3, 41.2, 0.5, B.COBBLE, 1, vec3());
    it.pickupDelay = 0;
    b.tick(20);
    expect(it.removed).toBe(false);
    expect(p.inventory.count(B.COBBLE)).toBe(0);
  });
});

describe('look input', () => {
  it('a look poisoned with NaN everywhere (input and body) recovers a finite look', () => {
    const b = new Bench();
    fill(b.world, -10, 59, -10, 10, 59, 10, B.STONE);
    const p = b.entities.spawnPlayer('survival', 0.5, 60, 0.5);
    b.tick(2);
    p.yaw = Number.NaN;
    p.pitch = Number.NaN;
    p.input.yaw = Number.NaN;
    p.input.pitch = Number.POSITIVE_INFINITY;
    p.input.forward = 1;
    b.tick(3);
    expect(Number.isFinite(p.yaw)).toBe(true);
    expect(Number.isFinite(p.pitch)).toBe(true);
    expect(Number.isFinite(p.input.yaw)).toBe(true);
    expect(Number.isFinite(p.pos.x + p.pos.z)).toBe(true);
  });
});
