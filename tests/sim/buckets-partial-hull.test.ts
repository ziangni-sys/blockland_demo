/**
 * Pouring a liquid source into a world cell that a ship's hull occupies in part (docs/SHAPES.md
 * 9.1): refused whichever octants the hull cell fills. The cell centre alone is not enough to ask:
 * for a hull aligned with the world it lies on three mid-planes and answers for octant 7 only, so a
 * lower slab of the hull would let the water in.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ } from '../../src/core/dirs';
import { getPacked } from '../../src/voxel/parts';
import { slab } from '../shapes';
import { EventLog, FLAT_TOP, click, flatSim, idAt } from './helpers';

const T = FLAT_TOP;

describe('no liquid is poured into a world cell a hull occupies in part', () => {
  for (const [name, fill] of [['lower slab 0x33', 0x33], ['all but octant 7 (0x7f)', 0x7f], ['upper slab 0xcc', 0xcc]] as const) {
    it(name, () => {
      const sim = flatSim({ mode: 'creative', spawn: { x: 2.75, y: T, z: 2.5 } });
      const w = sim.world;
      w.setCell(0, T, 0, makeCell(B.PLANKS_OAK));
      w.setCell(1, T, 0, makeCell(B.PLANKS_OAK));
      w.setCell(2, T, 0, slab(B.PLANKS_OAK, fill));
      w.setCell(0, T + 1, 0, makeCell(B.HELM, facingState(NZ)));
      const res = sim.structures.assembleShip(0, T + 1, 0);
      if (!res.ok) throw new Error(`assembly failed: ${JSON.stringify(res)}`);
      sim.structures.dynamics = null; // keep it where it was built
      const ship = res.structure;
      expect(getPacked(ship.grid, ship.grid.cellBounds()!.minX + 2, ship.grid.cellBounds()!.minY, ship.grid.cellBounds()!.minZ)).not.toBe(0);
      // A grass tuft in the world cell under the hull cell, aimed at from above through the hull
      // cell's empty upper +X+Z octant (octant 7): the target is the tuft, replaced by the source.
      w.setCell(2, T, 0, makeCell(B.TALL_GRASS));
      const log = new EventLog(sim);
      sim.soloPlayer.hold(I.BUCKET_WATER, 1);
      sim.soloPlayer.lookAt(2.75, T + 1, 0.75);
      sim.tick();
      expect(sim.soloPlayer.targetCell()).toMatchObject({ gridId: 0, x: 2, y: T, z: 0 });
      click(sim);
      // Expected: refused like any hull cell with hard octants (the source would be hidden
      // under the hull and left behind when the ship sails away).
      expect(log.toastKeys()).toContain('toast.bucket.structure');
      expect(idAt(w, 2, T, 0)).toBe(B.TALL_GRASS);
    });
  }
});
