/**
 * REVIEW (robustness): Interaction.tick() computes `this.hit` once, runs the right-click
 * (onUse), then mines with the SAME hit. When the right-click removed the structure the hit
 * belongs to (sneak + right-click docks the ship), updateMining() still acts on the dead grid:
 * structureOf() is null so locked() lets it through, breakBlock() clears the cell of the
 * detached grid, spawns its drop (survival) and emits 'blockBroken' for a gridId that no longer
 * exists — while dockShip() already put that very block into the world.
 *
 * Result: an item duplication in survival (hold left-click on the helm, sneak + right-click on
 * the tick the break completes) and an event dependents cannot resolve.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { EventLog, SEA_TOP, countId, fill, idAt, items, seaSim } from './helpers';

function raft(mode: 'creative' | 'survival'): Simulation {
  const sim = seaSim({ mode, spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
  const w = sim.world;
  fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
  fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
  w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
  sim.advance(2);
  // preview + assemble (the player takes the wheel)
  sim.lookAtCell(2, SEA_TOP, 4, PZ);
  sim.use();
  sim.tick();
  sim.use();
  sim.tick();
  expect(sim.structures.ships().length).toBe(1);
  sim.structures.dynamics = null; // keep the raft exactly where it was built
  return sim;
}

describe('review: a right-click that removes the hit structure, then mining in the same tick', () => {
  it('survival: finishing the helm break on the docking tick does not duplicate the helm', () => {
    const sim = raft('survival');
    const ship = sim.structures.ships()[0]!;
    sim.releaseHelm();
    sim.advance(3);
    const log = new EventLog(sim);
    sim.lookAtCell(2, SEA_TOP, 4, PZ, ship.id);
    expect(sim.targetCell()?.gridId).toBe(ship.id);
    const inp = sim.player.input;
    inp.attack = true;
    sim.attack();
    sim.advance(29); // helm: 1.5 s = 30 ticks, one short of breaking
    inp.sneak = true;
    sim.use(); // sneak + right-click on the ship's helm: dock
    sim.tick();
    inp.attack = false;
    inp.sneak = false;
    sim.advance(2);
    expect(ship.removed).toBe(true);
    expect(log.of('blockBroken').filter((e) => e.gridId === ship.id)).toEqual([]);
    const helmsInWorld = countId(sim.world, B.HELM, -5, 20, -5, 10, 40, 12);
    expect(helmsInWorld + items(sim, B.HELM).count).toBe(1);
  });

  it('creative: attack + sneak-dock from the wheel in one tick emits no blockBroken for the removed ship', () => {
    const sim = raft('creative');
    const ship = sim.structures.ships()[0]!;
    expect(sim.player.steeringShipId).toBe(ship.id);
    sim.advance(2);
    const log = new EventLog(sim);
    sim.lookAtCell(3, SEA_TOP - 1, 5, PY, ship.id); // the deck plank beside the helmsman's seat
    expect(sim.targetCell()).toMatchObject({ gridId: ship.id, x: 3, y: SEA_TOP - 1, z: 5 });
    sim.player.input.sneak = true;
    sim.attack();
    sim.use(); // while steering, sneak + right-click docks
    sim.tick();
    sim.player.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(log.of('blockBroken').filter((e) => e.gridId === ship.id)).toEqual([]);
    expect(idAt(sim.world, 3, SEA_TOP - 1, 5)).toBe(B.PLANKS_OAK);
  });
});
