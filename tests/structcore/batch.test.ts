import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { SET_EXPLOSION } from '../../src/voxel/grid';
import type { StructureGrid } from '../../src/voxel/sgrid';
import type { Rotor, Ship } from '../../src/structures/structure';
import { c, MILL_BEARING, MILL_CELLS, millShip, scene, SHIP_CELLS, SHIP_HELM, windmill, type Scene } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

function shipThenMill(s: Scene): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue, true);
  const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!sr.ok) throw new Error(sr.reason);
  const rr = s.mgr.startRotor(sr.structure.grid, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  return { ship: sr.structure, rotor: rr.structure };
}

/** Remove every cell of `g` within `radius` of the cell centre (cx,cy,cz) (grid-local), as an explosion would. */
function blast(g: StructureGrid, cx: number, cy: number, cz: number, radius: number): number {
  const victims: Array<[number, number, number]> = [];
  g.forEachCell((x, y, z) => {
    if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= radius * radius) victims.push([x, y, z]);
  });
  for (const [x, y, z] of victims) g.setCell(x, y, z, 0, SET_EXPLOSION);
  return victims.length;
}

describe('explosions and batches (ACCEPTANCE 13)', () => {
  it('a bearing blown up on a ship: hub and sails in the radius are gone, the rest lands on the ship', () => {
    const s = scene();
    const { ship, rotor } = shipThenMill(s);
    s.mgr.beginBatch();
    // The blast is centred on the bearing; the shock wave reaches the rotor too. Order of
    // processing must not matter: the ship first, the rotor second.
    const shipLost = blast(ship.grid, BX, BY, BZ, 1);
    expect(rotor.removed).toBe(false); // deferred: the rotor still has to take its own damage
    const rotorLost = blast(rotor.grid, BX, BY, BZ, 1.2); // the hub, right in front of the bearing
    expect(rotorLost).toBe(1);
    expect(rotor.sails).toBe(MILL_CELLS - 1);
    s.mgr.endBatch();
    expect(rotor.removed).toBe(true);
    expect(ship.removed).toBe(false);
    expect(ship.grid.count).toBe(SHIP_CELLS - shipLost + MILL_CELLS - rotorLost);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).toBe(0); // the hub did not survive
    expect(ship.grid.getCell(BX + 1, BY, BZ + 1)).toBe(c(B.WOOL_RED)); // the arms did
    expect(ship.grid.getCell(BX, BY - 2, BZ + 1)).toBe(c(B.WOOL_YELLOW));
  });

  it('a whole small ship blown away: the windmill remains fall back onto the (empty) ship', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipThenMill(s);
    s.mgr.beginBatch();
    blast(ship.grid, 0, 60, 0, 100); // everything
    expect(ship.grid.count).toBe(0);
    blast(rotor.grid, BX + 2, BY, BZ + 1, 0.5); // one arm tip
    s.mgr.endBatch();
    expect(rotor.removed).toBe(true);
    expect(ship.removed).toBe(false);
    expect(s.mgr.ships()).toEqual([ship]);
    expect(ship.grid.count).toBe(MILL_CELLS - 1);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
    // The next step keeps it (it has cells); the dynamics recompute it then.
    s.mgr.step();
    expect(ship.removed).toBe(false);
    expect(s.dyn!.refreshed).toContain(ship);
  });

  it('a ship emptied without rotors is destroyed at endBatch, riders released first', () => {
    const s = scene();
    millShip(s.world, s.host.worldGlue);
    const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
    if (!sr.ok) throw new Error(sr.reason);
    const ship = sr.structure;
    s.mgr.beginBatch();
    blast(ship.grid, 0, 60, 0, 100);
    expect(ship.removed).toBe(false);
    s.mgr.endBatch();
    expect(ship.removed).toBe(true);
    expect(s.mgr.ships()).toEqual([]);
    expect(s.host.released).toContain(ship);
  });

  it('without a batch the bearing loss blockifies at once (so the blast then hits the fallen blocks)', () => {
    const s = scene();
    const { ship, rotor } = shipThenMill(s);
    ship.grid.setCell(BX, BY, BZ, 0, SET_EXPLOSION);
    expect(rotor.removed).toBe(true);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).toBe(c(B.CANVAS));
  });

  it('world rotors behave the same inside a batch; batches nest', () => {
    const s = scene();
    windmill(s.world, 0, 64, 0, 3);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const rotor = rr.structure;
    s.mgr.beginBatch();
    s.mgr.beginBatch();
    s.world.setCell(0, 64, 0, 0, SET_EXPLOSION);
    rotor.grid.setCell(3, 64, 1, 0, SET_EXPLOSION);
    s.mgr.endBatch();
    expect(rotor.removed).toBe(false);
    s.mgr.endBatch();
    expect(rotor.removed).toBe(true);
    expect(s.world.getCell(0, 64, 1)).toBe(c(B.CANVAS));
    expect(s.world.getCell(3, 64, 1)).toBe(0);
    expect(s.world.getCell(2, 64, 1)).toBe(c(B.WOOL_RED));
    expect(() => s.mgr.endBatch()).toThrow();
  });

  it('a rotor stopped by hand while pending is not stopped twice', () => {
    const s = scene();
    const { ship, rotor } = shipThenMill(s);
    s.mgr.beginBatch();
    ship.grid.setCell(BX, BY, BZ, 0, SET_EXPLOSION);
    const rep = s.mgr.stopRotor(rotor);
    expect(rep.placed).toBe(MILL_CELLS);
    s.mgr.endBatch();
    expect(ship.grid.count).toBe(SHIP_CELLS - 1 + MILL_CELLS);
  });
});
