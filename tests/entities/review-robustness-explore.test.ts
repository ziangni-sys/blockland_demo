import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { ItemEntity, Player } from '../../src/entities/entity';
import { B, Bench, deck, fill, makeCell, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

describe('explore', () => {
  it('double syncCarried between ticks', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 5 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    b.tick(20);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    b.entities.syncCarried(); // e.g. "sync the carried player when a screen opens"
    b.tick(1);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    b.tick(1);
    const l2 = ship.grid.toLocal(p.pos, vec3());
    console.log('double sync', l0, l1, l2, p.carrierId, p.vel);
  });

  it('releaseRiders(rotor on moving ship) slip', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-7, -7, 7, 7, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 6 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const plat: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) plat.push([x, 61, z, B.PLANKS_PINE]);
    const tt = b.rotor(2, ship, [0, 61, 0], 2, plat);
    b.tick();
    const start = ship.grid.toWorld(vec3(0.5, 62, 0.5));
    const p = b.entities.createPlayer('survival', start.x, start.y, start.z);
    b.tick(20);
    console.log('carrier', p.carrierId);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    // structure manager: stopRotor -> releaseRiders(rotor), cells into the ship, rotor unregistered
    b.entities.releaseRiders(tt);
    tt.removed = true;
    b.host.list.splice(b.host.list.indexOf(tt), 1);
    for (const [x, y, z, c] of plat) ship.grid.setCell(x, y, z, makeCell(c));
    b.tick(1);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    b.tick(10);
    const l2 = ship.grid.toLocal(p.pos, vec3());
    console.log('release rotor slip', l0, l1, l2, p.carrierId);
  });

  it('re-add during iteration', () => {
    const b = new Bench();
    fill(b.world, -10, 59, -10, 10, 59, 10, B.STONE);
    const it = b.entities.spawnItem(0.5, 61, 0.5, B.STONE, 1, vec3());
    const p = b.entities.createPlayer('survival', 3.5, 60, 3.5);
    let done = false;
    const host = b.host;
    const origEmit = host.emit.bind(host);
    host.emit = (ev) => {
      origEmit(ev);
      if (!done && ev.type === 'land' ) {
        done = true;
      }
    };
    // simulate: remove + add during update via a hurt listener
    b.tick(1);
    p.mode = 'survival';
    let once = false;
    host.emit = (ev) => {
      origEmit(ev);
      if (!once && ev.type === 'hurt') {
        once = true;
        b.entities.remove(p);
        b.entities.add(p);
      }
    };
    b.entities.damage(p, 1, 'test'); // outside iteration: fine
    console.log('count after outside', b.entities.all().filter((e) => e === p).length);
  });

  it('spawnItem count 0', () => {
    const b = new Bench();
    const it = b.entities.spawnItem(0.5, 61, 0.5, B.STONE, 0, vec3());
    console.log('count0 ->', it.stack.count);
    const it2 = b.entities.spawnItem(0.5, 61, 0.5, B.STONE, 500, vec3());
    console.log('count500 ->', it2.stack.count);
  });
});
