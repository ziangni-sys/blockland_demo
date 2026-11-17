import { describe, expect, it } from 'vitest';
import { cellState, facingState, isLiquidSource, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY, PZ } from '../../src/core/dirs';
import { EventLog, FLAT_TOP, SEA_TOP, click, fill, flatSim, idAt, seaSim } from './helpers';

const T = FLAT_TOP;

describe('buckets', () => {
  it('survival: pour a source, scoop it back; flowing liquid cannot be scooped', () => {
    const sim = flatSim({ mode: 'survival' });
    const p = sim.player;
    sim.hold(I.BUCKET_WATER, 1);
    sim.lookAtCell(0, T - 1, -2, PY);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.WATER);
    expect(isLiquidSource(cellState(sim.world.getCell(0, T, -2)))).toBe(true);
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET, count: 1 });
    sim.advance(10); // it starts to flow
    expect(idAt(sim.world, 1, T, -2)).toBe(B.WATER);

    // Aiming at a flowing cell goes through it to the ground: nothing to scoop there.
    sim.lookAt(1.5, T + 0.05, -1.5);
    click(sim);
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET, count: 1 });
    // The source itself can be scooped.
    sim.lookAt(0.5, T + 0.6, -1.5);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).not.toBe(B.WATER);
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
    sim.advance(60);
    expect(idAt(sim.world, 1, T, -2)).toBe(B.AIR); // the rest dried up
  });

  it('a stack of empty buckets fills one; lava works the same; creative keeps the bucket', () => {
    const sim = flatSim({ mode: 'survival' });
    const p = sim.player;
    sim.world.setCell(0, T, -2, makeCell(B.LAVA));
    sim.hold(I.BUCKET, 3);
    sim.lookAt(0.5, T + 0.6, -1.5);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.AIR);
    expect(p.inventory.count(I.BUCKET)).toBe(2);
    expect(p.inventory.count(I.BUCKET_LAVA)).toBe(1);

    const c = flatSim({ mode: 'creative' });
    c.hold(I.BUCKET_WATER, 1);
    c.lookAtCell(0, T - 1, -2, PY);
    click(c);
    expect(idAt(c.world, 0, T, -2)).toBe(B.WATER);
    expect(c.player.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
  });

  it('a structure in the line of sight is never looked through, and liquid is never put on it', () => {
    const sim = seaSim({ mode: 'survival', spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 2, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 3, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(2, SEA_TOP, 3);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    sim.advance(5);
    const log = new EventLog(sim);
    const p = sim.player;
    // Empty bucket aimed at the deck, with sea water right behind it.
    sim.hold(I.BUCKET, 1);
    sim.lookAtCell(1, SEA_TOP - 1, 4, PY, ship.id);
    sim.tick();
    expect(sim.view.target?.gridId).toBe(ship.id);
    expect(sim.view.hint?.key).toBe('hint.bucket.structure');
    click(sim);
    expect(log.toastKeys()).toContain('toast.bucket.structure');
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET, count: 1 });
    // The same aim at open water works.
    sim.lookAtCell(5, SEA_TOP - 1, 6, PY); // the sea just east of the dock
    click(sim);
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
    // A full bucket aimed at the deck: nothing is poured onto the ship.
    sim.lookAtCell(1, SEA_TOP - 1, 4, PY, ship.id);
    click(sim);
    expect(p.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
    let water = 0;
    ship.grid.forEachCell((_x, _y, _z, c) => {
      if ((c & 1023) === B.WATER) water++;
    });
    expect(water).toBe(0);
    void PZ;
  });
});
