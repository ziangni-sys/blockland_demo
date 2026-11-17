import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PX } from '../../src/core/dirs';
import { qclone, qfromYaw, vclone, vec3 } from '../../src/core/math';
import { GlueStore } from '../../src/structures/glue';
import type { Rotor, Ship } from '../../src/structures/structure';
import { SET_STRUCTURE_MOVE } from '../../src/voxel/grid';
import { StructureGrid } from '../../src/voxel/sgrid';
import { c, facing, fill, loadArea, log, MILL_BEARING, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

function shipWithRunningMill(s: Scene): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue);
  const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!sr.ok) throw new Error(sr.reason);
  return { ship: sr.structure, rotor: rr.structure };
}

describe('frozen near unloaded chunks (LESSONS 船被弹飞)', () => {
  it('a ship next to an unloaded chunk freezes until it loads', () => {
    const s = scene();
    fill(s.world, 26, 60, 0, 29, 60, 2, c(B.PLANKS_OAK));
    s.world.setCell(27, 61, 1, facing(B.HELM, 5));
    const res = s.mgr.assembleShip(27, 61, 1); // the hull itself is in loaded chunks
    if (!res.ok) throw new Error(res.reason);
    const ship = res.structure;
    s.mgr.step();
    expect(ship.frozen).toBe(true); // x = 30 + 2 reaches chunk x = 2
    loadArea(s.world, 32, -16, 47, 15); // the box grown by 2 also reaches z = -2
    s.mgr.step();
    expect(ship.frozen).toBe(false);
    // Moved away from the loaded area: frozen again.
    ship.grid.setPoseImmediate(vec3(ship.grid.position.x, ship.grid.position.y, ship.grid.position.z + 40), ship.grid.rotation);
    s.mgr.step();
    expect(ship.frozen).toBe(true);
  });

  it('a world rotor near unloaded chunks holds still; a ship rotor follows its ship', () => {
    const s = scene();
    windmill(s.world, 25, 64, 10, 3);
    const rr = s.mgr.startRotor(s.world, 25, 64, 10);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    for (let i = 0; i < 10; i++) s.mgr.step();
    expect(r.frozen).toBe(true);
    expect(r.angle).toBe(0);
    expect(r.grid.angularVelocity).toEqual(vec3());
    loadArea(s.world, 32, 0, 47, 31);
    s.mgr.step();
    expect(r.frozen).toBe(false);
    expect(r.angle).toBeGreaterThan(0);

    const t = scene();
    const { ship, rotor } = shipWithRunningMill(t);
    for (let i = 0; i < 30; i++) t.mgr.step();
    expect(rotor.frozen).toBe(false);
    ship.grid.setPoseImmediate(vec3(28, 61, 0), qfromYaw(0.3));
    const angle = rotor.angle;
    t.mgr.step();
    expect(ship.frozen).toBe(true);
    expect(rotor.frozen).toBe(true);
    expect(rotor.angle).toBe(angle);
    expect(rotor.grid.angularVelocity).toEqual(vec3());
    expect(rotor.angularSpeed).toBeGreaterThan(0); // resumes at speed once thawed
  });
});

describe('glue hooks', () => {
  it('world: removal or a different block id clears glue; state-only changes and bulk moves keep it', () => {
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(0, 70, 0, c(B.STONE_BRICKS));
    s.world.setCell(1, 70, 0, c(B.STONE_BRICKS));
    g.add(0, 70, 0, PX);
    s.world.setCell(1, 70, 0, c(B.BRICKS));
    expect(g.size).toBe(0);
    s.world.setCell(0, 72, 0, log(0));
    s.world.setCell(1, 72, 0, log(0));
    g.add(0, 72, 0, PX);
    s.world.setCell(1, 72, 0, log(1)); // same id, new state
    expect(g.has(0, 72, 0, PX)).toBe(true);
    s.world.setCell(1, 72, 0, 0, SET_STRUCTURE_MOVE); // a bulk move transfers glue itself
    expect(g.has(0, 72, 0, PX)).toBe(true);
    s.world.setCell(0, 72, 0, 0);
    expect(g.size).toBe(0);
  });

  it('ship and rotor grids: removing a cell clears its glue', () => {
    const s = scene();
    windmill(s.world, 10, 64, 10, 3);
    s.host.worldGlue.add(11, 64, 11, PX); // between two felt cells of the +X arm
    const rr = s.mgr.startRotor(s.world, 10, 64, 10);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    expect(r.glue.has(11, 64, 11, PX)).toBe(true);
    r.grid.setCell(12, 64, 11, 0);
    expect(r.glue.size).toBe(0);
    expect(r.sails).toBe(12);

    const { ship } = shipWithRunningMill(s);
    expect(ship.glue.has(2, 61, 0, 3)).toBe(true);
    ship.grid.setCell(2, 60, 0, c(B.PLANKS_PINE)); // replaced by another id
    expect(ship.glue.has(2, 61, 0, 3)).toBe(false);
    expect(ship.glue.size).toBe(1);
    ship.grid.setCell(-3, 60, -2, 0);
    expect(ship.glue.size).toBe(0);
  });

  it('glueFor answers for the world, live and just-removed structures, and rejects foreign grids', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    expect(s.mgr.glueFor(s.world)).toBe(s.host.worldGlue);
    expect(s.mgr.glueFor(ship.grid)).toBe(ship.glue);
    expect(s.mgr.glueFor(rotor.grid)).toBe(rotor.glue);
    s.mgr.stopRotor(rotor);
    expect(s.mgr.glueFor(rotor.grid)).toBe(rotor.glue);
    expect(s.mgr.structureOf(rotor.grid)).toBeNull();
    expect(() => s.mgr.glueFor(new StructureGrid(99, s.world))).toThrow();
    expect(() => s.mgr.glueFor(scene().world)).toThrow();
    expect(s.mgr.gridById(0)).toBe(s.world);
    expect(s.mgr.gridById(rotor.id)).toBeUndefined();
    expect(new GlueStore().size).toBe(0);
  });
});

describe('step', () => {
  it('snapshots poses, spins rotors before the dynamics, refreshes ships, sums sails', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipWithRunningMill(s);
    const dyn = s.dyn!;
    let checked = 0;
    dyn.onStep = (ships, rotors) => {
      expect(ships).toEqual([ship]);
      expect(rotors).toEqual([rotor]);
      expect(dyn.refreshed[dyn.refreshed.length - 1]).toBe(ship);
      // the rotor already advanced this tick: prev -> current brackets the tick
      if (rotor.angularSpeed > 0) expect(rotor.grid.rotation).not.toEqual(rotor.grid.prevRotation);
      checked++;
    };
    const pos = vclone(ship.grid.position);
    for (let i = 0; i < 5; i++) s.mgr.step();
    expect(checked).toBe(5);
    expect(dyn.steps).toBe(5);
    expect(ship.grid.prevPosition).toEqual(pos);
    expect(ship.sails).toBe(9);
    rotor.grid.setCell(BX + 2, BY, BZ + 1, 0);
    s.mgr.step();
    expect(ship.sails).toBe(8);
  });

  it('a bearing broken during the dynamics step blockifies after it, not in the middle', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipWithRunningMill(s);
    let seen = false;
    s.dyn!.onStep = () => {
      if (seen) return;
      seen = true;
      ship.grid.setCell(BX, BY, BZ, 0); // e.g. crushed against terrain
      expect(rotor.removed).toBe(false);
    };
    s.mgr.step();
    expect(seen).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).not.toBe(0);
  });

  it('removes ships emptied outside a batch at the end of the step (riders released first)', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    s.mgr.stopRotor(rotor);
    const cells: Array<[number, number, number]> = [];
    ship.grid.forEachCell((x, y, z) => cells.push([x, y, z]));
    for (const [x, y, z] of cells) ship.grid.setCell(x, y, z, 0);
    expect(ship.removed).toBe(false);
    s.mgr.step();
    expect(ship.removed).toBe(true);
    expect(s.host.released[s.host.released.length - 1]).toBe(ship);
    expect(s.mgr.all()).toEqual([]);
  });

  it('a rotor whose cells were all destroyed is removed and frees its bearing', () => {
    const s = scene();
    windmill(s.world, 0, 64, 0, 1);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    const cells: Array<[number, number, number]> = [];
    r.grid.forEachCell((x, y, z) => cells.push([x, y, z]));
    for (const [x, y, z] of cells) r.grid.setCell(x, y, z, 0);
    s.mgr.step();
    expect(r.removed).toBe(true);
    expect(s.mgr.rotorAtBearing(s.world, 0, 64, 0)).toBeNull();
    expect(s.world.getCell(0, 64, 1)).toBe(0);
  });

  it('wakes a ship when a world cell next to it changes, not when far away', () => {
    const s = scene({ dynamics: true });
    const { ship } = shipWithRunningMill(s);
    s.mgr.step();
    const dyn = s.dyn!;
    dyn.woken.length = 0;
    s.world.setCell(20, 60, 0, c(B.STONE));
    expect(dyn.woken).toEqual([]);
    s.world.setCell(4, 60, 0, c(B.STONE)); // right next to the deck edge (x = 3)
    expect(dyn.woken).toEqual([ship]);
    // After the ship moved, the box follows it.
    ship.grid.setPoseImmediate(vec3(ship.grid.position.x + 12, ship.grid.position.y, ship.grid.position.z), qclone(ship.grid.rotation));
    s.mgr.step();
    dyn.woken.length = 0;
    s.world.setCell(16, 60, 0, c(B.STONE));
    expect(dyn.woken).toEqual([ship]);
  });

  it('lists are immutable snapshots: stopping while iterating visits everything', () => {
    const s = scene();
    for (let i = 0; i < 4; i++) {
      windmill(s.world, -20 + i * 10, 64, -10, 1);
      expect(s.mgr.startRotor(s.world, -20 + i * 10, 64, -10).ok).toBe(true);
    }
    const list = s.mgr.rotors();
    expect(list.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    for (const r of list) s.mgr.stopRotor(r);
    expect(list.length).toBe(4);
    expect(s.mgr.rotors()).toEqual([]);
    expect(list.every((r) => r.removed)).toBe(true);
  });
});
