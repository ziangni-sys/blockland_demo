/**
 * Review (integration): releaseRiders(rotor) for a rotor mounted on a MOVING ship.
 *
 * StructureManager.stopRotor() calls host.releaseRiders(rotor, null) and then blockifies the rotor's
 * cells INTO ITS PARENT SHIP (bearing mined / blown up while sailing). EntityManager.releaseRiders
 * strips the rider's whole carrier velocity ("The structure turns into blocks that do not move:
 * keep only the own motion") although those blocks keep moving with the ship. On the next tick
 * the rider is not carried, the deck sails on under it, it re-attaches with a large velocity
 * relative to the deck and skids: a ~0.5 block jump at 6 b/s, ~0.9 at the 10.5 b/s top speed —
 * the "停靠时站在转盘上的人被瞬移" class of bug (LESSONS) for the bearing-removed path.
 */
import { describe, expect, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { B, Bench, deck, makeCell, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

describe('review: releaseRiders on a rotor mounted on a moving ship', () => {
  it('the rider of a turntable that is blockified into a sailing ship stays where it stood on the deck', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-7, -7, 7, 7, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(-20 + 6 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const plat: Array<[number, number, number, number]> = [];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) plat.push([x, 61, z, B.PLANKS_PINE]);
    const tt = b.rotor(2, ship, [0, 61, 0], 2, plat);
    b.tick();
    const start = ship.grid.toWorld(vec3(0.5, 62, 0.5));
    const p = b.entities.spawnPlayer('survival', start.x, start.y, start.z);
    b.tick(20);
    expect(p.carrierId).toBe(tt.id);
    const l0 = ship.grid.toLocal(p.pos, vec3());

    // What StructureManager.stopRotor does: release the riders, unregister the rotor, write its
    // cells into the parent ship's grid (same local coordinates: the turntable did not turn).
    b.entities.releaseRiders(tt, null);
    tt.removed = true;
    b.host.list.splice(b.host.list.indexOf(tt), 1);
    ship.children.length = 0;
    for (const [x, y, z, c] of plat) ship.grid.setCell(x, y, z, makeCell(c));

    let worst = 0;
    for (let i = 0; i < 30; i++) {
      b.tick();
      const l = ship.grid.toLocal(p.pos, vec3());
      worst = Math.max(worst, Math.hypot(l.x - l0.x, l.z - l0.z));
    }
    expect(p.carrierId).toBe(ship.id);
    expect(worst).toBeLessThan(0.05);
  });
});
