import { describe, expect, it } from 'vitest';
import { cellState, facingState, isLiquidSource, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PY, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { EventLog, FLAT_TOP, SEA_TOP, click, countId, fill, flatSim, idAt, seaSim } from './helpers';

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

/**
 * An open plank boat in the sea, kept exactly where it was assembled (dynamics off after
 * assembly, so its hull analysis exists): floor y = 27, walls y = 28..30, a dry hold x 1..3,
 * z 1..5 that still holds the world's sea water at y = 28..29 (hidden by the hull, never
 * deleted — LESSONS 船舱里冒出水面). The player hovers above the hold's north end.
 */
function openBoat(): { sim: Simulation; shipId: number } {
  const sim = seaSim({ mode: 'survival', spawn: { x: 2.5, y: SEA_TOP + 1, z: 1.5 } });
  const w = sim.world;
  fill(w, 0, 27, 0, 4, 27, 6, B.PLANKS_OAK);
  for (let y = 28; y <= 30; y++) {
    for (let x = 0; x <= 4; x++) {
      w.setCell(x, y, 0, makeCell(B.PLANKS_OAK));
      w.setCell(x, y, 6, makeCell(B.PLANKS_OAK));
    }
    for (let z = 0; z <= 6; z++) {
      w.setCell(0, y, z, makeCell(B.PLANKS_OAK));
      w.setCell(4, y, z, makeCell(B.PLANKS_OAK));
    }
  }
  w.setCell(2, 31, 6, makeCell(B.HELM, facingState(NZ)));
  sim.advance(2);
  const res = sim.structures.assembleShip(2, 31, 6);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('assembly failed');
  sim.structures.dynamics = null;
  sim.teleport(2.5, 31, 1.5);
  sim.player.flying = true;
  sim.advance(2);
  expect(idAt(res.structure.grid, 2, 28, 3)).toBe(B.AIR);
  expect(idAt(w, 2, 28, 3)).toBe(B.WATER);
  expect(idAt(w, 2, 29, 3)).toBe(B.WATER);
  return { sim, shipId: res.structure.id };
}

describe('buckets and the world water hidden inside a hull', () => {
  it('the bucket ray goes through the hidden water to what lies behind it, entering through the right face', () => {
    const { sim } = openBoat();
    // A world block standing in the hold, behind two hidden water cells. The ray comes down
    // steeply but enters it through its north face (a face the ray's dominant axis would not name).
    sim.world.setCell(2, 28, 4, makeCell(B.STONE));
    sim.hold(I.BUCKET_WATER, 1);
    sim.lookAt(2.5, 28.5, 4.0);
    sim.tick();
    expect(sim.targetCell()).toEqual({ gridId: 0, x: 2, y: 28, z: 4, face: NZ });
    expect(sim.view.target).toEqual({ gridId: 0, x: 2, y: 28, z: 4, face: NZ });
  });

  it('no liquid is poured into the hold, even when the clicked block is a world block', () => {
    const { sim } = openBoat();
    const w = sim.world;
    sim.world.setCell(2, 28, 4, makeCell(B.STONE));
    const wet = countId(w, B.WATER, 1, 28, 1, 3, 31, 5);
    const log = new EventLog(sim);
    sim.hold(I.BUCKET_WATER, 1);
    sim.lookAt(2.5, 28.5, 4.0); // the stone's north face: the new source would go to (2, 28, 3)
    click(sim);
    expect(log.toastKeys()).toContain('toast.bucket.structure');
    expect(sim.player.inventory.selectedStack()).toEqual({ item: I.BUCKET_WATER, count: 1 });
    expect(countId(w, B.WATER, 1, 28, 1, 3, 31, 5)).toBe(wet);
    // And an empty bucket finds nothing to scoop there: the stone is what it sees.
    sim.hold(I.BUCKET, 1);
    sim.lookAt(2.5, 28.5, 4.0);
    click(sim);
    expect(sim.player.inventory.selectedStack()).toEqual({ item: I.BUCKET, count: 1 });
    expect(countId(w, B.WATER, 1, 28, 1, 3, 31, 5)).toBe(wet);
  });
});
