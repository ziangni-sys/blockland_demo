import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PZ, PY } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { Rotor } from '../../src/structures/structure';
import { addHelm, launch, makeSea, newShip, plankBoat, run, setup, shipBox, tick } from './helpers';

describe('refresh: mass properties and pivot', () => {
  it('an empty ship does not crash refresh or step', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    dyn.refresh(s);
    expect(s.mass).toBe(0);
    expect(s.hull).toBeNull();
    tick(dyn, [s]);
    shipBox(s, 0, 47, 0, 1, 47, 1, B.PLANKS_OAK);
    for (let x = 0; x <= 1; x++) for (let z = 0; z <= 1; z++) s.grid.setCell(x, 47, z, 0);
    tick(dyn, [s]);
    expect(s.mass).toBe(0);
    expect(Array.from(s.invInertiaLocal)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('pivot = centre of mass, position = its world point, inverse inertia filled', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -2, 47, -3, 2, 47, 3, B.PLANKS_OAK);
    launch(s, dyn);
    expect(s.grid.pivot.x).toBeCloseTo(0.5);
    expect(s.grid.pivot.y).toBeCloseTo(47.5);
    expect(s.grid.pivot.z).toBeCloseTo(0.5);
    expect(s.grid.position).toEqual(s.grid.pivot); // identity pose right after assembly
    expect(s.hull!.version).toBe(s.grid.version);
    // inverse inertia of a 5 x 1 x 7 slab of density 0.5
    const m = 17.5;
    const Ixx = (m * (1 + 49)) / 12;
    expect(s.invInertiaLocal[0]).toBeCloseTo(1 / Ixx, 6);
    expect(s.invInertiaLocal[1]).toBeCloseTo(0, 9);
  });

  it('removing cells moves the pivot without moving any cell, and keeps every material velocity', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -2, 47, -3, 2, 47, 3, B.PLANKS_OAK);
    launch(s, dyn);
    const g = s.grid;
    g.angularVelocity.y = 0.8;
    g.linearVelocity.x = 1.5;
    const probe = vec3(-2.5, 47.5, 3.5); // a cell that stays
    const before = g.toWorld(probe);
    const vBefore = g.velocityAt(before);
    for (let z = 1; z <= 3; z++) for (let x = -2; x <= 2; x++) g.setCell(x, 47, z, 0); // cut off the stern
    s.asleep = true;
    dyn.refresh(s);
    expect(s.asleep).toBe(false); // a change wakes the ship
    expect(g.pivot.z).toBeLessThan(0.5);
    expect(g.toWorld(probe)).toEqual(expect.objectContaining({ x: expect.closeTo(before.x, 12), y: expect.closeTo(before.y, 12), z: expect.closeTo(before.z, 12) }));
    const vAfter = g.velocityAt(g.toWorld(probe));
    expect(vAfter.x).toBeCloseTo(vBefore.x, 12);
    expect(vAfter.z).toBeCloseTo(vBefore.z, 12);
    expect(s.mass).toBeCloseTo(0.5 * 5 * 4);
  });

  it('refresh is a no-op when nothing changed', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = launch(plankBoat(world, 1, -2, 46, -4, 5, 9), dyn);
    const hull = s.hull;
    s.asleep = true;
    dyn.refresh(s);
    expect(s.hull).toBe(hull);
    expect(s.asleep).toBe(true);
  });

  it('mass includes the rotors mounted on the ship; floating is decided on the whole ship', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -1, 47, -1, 1, 47, 1, B.PLANKS_OAK); // 9 planks: mass 4.5, max displacement 9
    launch(s, dyn);
    expect(s.hull!.floats).toBe(true);
    const comBefore = s.grid.pivot.y;
    // mount a heavy "rotor" on top (iron, 5 cells = 39 mass units)
    const r = new Rotor(50, s.grid);
    r.parent = s;
    r.axis = PY;
    r.grid.pivot.x = 0.5;
    r.grid.pivot.y = 49.5;
    r.grid.pivot.z = 0.5;
    for (let x = -2; x <= 2; x++) r.grid.setCell(x, 49, 0, makeCell(B.IRON_BLOCK));
    r.grid.setPoseImmediate(r.grid.pivot, r.grid.rotation);
    s.children.push(r);
    dyn.refresh(s);
    expect(s.mass).toBeCloseTo(4.5 + 5 * 7.8);
    expect(s.grid.pivot.y).toBeGreaterThan(comBefore + 1);
    expect(s.hull!.floats).toBe(false);
    // losing the rotor's cells is noticed without any change to the ship's own cells
    for (let x = -2; x <= 2; x++) r.grid.setCell(x, 49, 0, 0);
    dyn.refresh(s);
    expect(s.mass).toBeCloseTo(4.5);
    expect(s.hull!.floats).toBe(true);
  });
});

describe('refresh: bow direction from the helm', () => {
  it('forward is the facing of the helm; a second helm does not change it; losing it falls back', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -2, 47, -2, 2, 47, 2, B.PLANKS_OAK);
    addHelm(s, 1, 48, 1, PX);
    launch(s, dyn);
    expect(s.forward).toBe(PX);
    expect([s.helmX, s.helmY, s.helmZ]).toEqual([1, 48, 1]);
    addHelm(s, -1, 48, -1, PZ); // earlier in scan order, but the current helm stays
    dyn.refresh(s);
    expect(s.forward).toBe(PX);
    s.grid.setCell(1, 48, 1, 0);
    dyn.refresh(s);
    expect(s.forward).toBe(PZ);
    expect([s.helmX, s.helmY, s.helmZ]).toEqual([-1, 48, -1]);
    s.grid.setCell(-1, 48, -1, 0);
    dyn.refresh(s);
    expect(s.forward).toBe(PZ); // no helm left: keep the old bow
  });

  it('a ship without any helm keeps its default forward and can still be simulated', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -2, 47, -2, 2, 47, 2, B.PLANKS_OAK);
    launch(s, dyn);
    expect(s.forward).toBe(NZ);
    run(dyn, [s], 20);
    expect(Number.isFinite(s.grid.position.y)).toBe(true);
  });
});
