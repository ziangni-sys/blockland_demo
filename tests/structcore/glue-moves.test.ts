/**
 * Glue moving between grids (DESIGN 强力胶): a glued face travels with the moved cells when both
 * sides move, or when the side staying behind is not a glueable block; it stays in the source
 * grid when the other side is a glueable block that stays; faces turn with the cells and merge
 * with a face the destination already glues; afterwards the lifetime rule holds at the
 * destination. (The hub–bearing face, which stays on the bearing: rotor.test.ts, dock.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NY, PX, PY, PZ } from '../../src/core/dirs';
import { applyRotorPose } from '../../src/structures/rotor';
import { c, millShip, scene, SHIP_HELM, windmill } from './helpers';

const [HX, HY, HZ] = SHIP_HELM;

describe('glue moving between grids', () => {
  it('assembly: an exposed glued face of a ship block travels into the ship; none of it stays in the world', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const g = s.host.worldGlue;
    g.add(1, 60, 1, PY); // the deck's top face, open
    g.add(-3, 60, 0, NY); // its bottom face, open
    const before = g.size;
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    expect(g.size).toBe(0);
    expect(ship.glue.size).toBe(before);
    expect(ship.glue.has(1, 60, 1, PY)).toBe(true);
    expect(ship.glue.has(-3, 60, 0, NY)).toBe(true);
  });

  it('a face between a moved cell and a glueable block that stays behind stays in the source, not duplicated', () => {
    const s = scene();
    // A windmill whose +X arm tip touches a stone behind the bearing's plane (z = bz): not part
    // of the rotor (rotors only take cells in front of the bearing).
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    s.world.setCell(hx + 2, hy, hz - 1, c(B.STONE));
    s.host.worldGlue.add(hx + 2, hy, hz, 5 /* -Z: tip -> stone */);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(s.world.getCell(hx + 2, hy, hz - 1)).toBe(c(B.STONE));
    expect(s.host.worldGlue.has(hx + 2, hy, hz, 5)).toBe(true); // stays on the stone
    expect(rotor.glue.size).toBe(0);
  });

  it('docking: exposed faces travel back, turned with the ship; a face landing on a face the world already glues merges', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const r = s.mgr.assembleShip(HX, HY, HZ);
    if (!r.ok) throw new Error(r.reason);
    const ship = r.structure;
    ship.glue.add(1, 60, 1, PY); // exposed: deck top
    ship.glue.add(2, 60, 2, PY); // exposed: deck top, will merge
    // A world stone right above the second deck cell, its bottom face glued in the world.
    s.world.setCell(2, 61, 2, c(B.STONE));
    s.host.worldGlue.add(2, 61, 2, NY);
    const shipFaces = ship.glue.size;
    const worldFaces = s.host.worldGlue.size;
    const res = s.mgr.dockShip(ship); // pose identity: docks where it was assembled
    expect(res.ok).toBe(true);
    expect(s.host.worldGlue.has(1, 60, 1, PY)).toBe(true);
    expect(s.host.worldGlue.has(2, 60, 2, PY)).toBe(true);
    expect(s.host.worldGlue.size).toBe(worldFaces + shipFaces - 1); // merged, stored once
  });

  it('rotor start and stop: an exposed face on a sail rides along and comes back turned with it', () => {
    const s = scene();
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    s.host.worldGlue.add(hx + 1, hy, hz, PZ); // the +X arm's south face, open
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.glue.has(hx + 1, hy, hz, PZ)).toBe(true);
    expect(s.host.worldGlue.size).toBe(0);
    rotor.angle = Math.PI / 2; // a quarter turn about +Z: the +X arm points up
    applyRotorPose(rotor);
    s.mgr.stopRotor(rotor);
    expect(s.world.getCell(hx, hy + 1, hz)).toBe(c(B.WOOL_RED));
    expect(s.host.worldGlue.has(hx, hy + 1, hz, PZ)).toBe(true);
    expect(s.host.worldGlue.size).toBe(1);
  });

  it('blockify: glue on a cell that dropped goes; a face between a placed cell and a dropped one stays on the placed one', () => {
    const s = scene();
    const [hx, hy, hz] = windmill(s.world, 0, 64, 0, 2);
    const g = s.host.worldGlue;
    g.add(hx + 2, hy, hz, PZ); // the +X arm tip's open south face
    g.add(hx + 1, hy, hz, PX); // between the two cells of the +X arm
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    expect(rotor.glue.size).toBe(2);
    // After a half turn the arm tip lands in a stone and drops; the inner arm cell is placed.
    s.world.setCell(hx - 2, hy, hz, c(B.STONE));
    rotor.angle = Math.PI;
    applyRotorPose(rotor);
    const rep = s.mgr.stopRotor(rotor);
    expect(rep.dropped).toBe(1);
    expect(s.world.getCell(hx - 1, hy, hz)).toBe(c(B.WOOL_RED));
    expect(s.world.getCell(hx - 2, hy, hz)).toBe(c(B.STONE));
    expect(g.has(hx - 2, hy, hz, 5 /* -Z */)).toBe(false); // the dropped tip's face is gone
    expect(g.has(hx - 1, hy, hz, 1 /* -X: towards the stone */)).toBe(true);
    expect(g.size).toBe(1);
  });
});
