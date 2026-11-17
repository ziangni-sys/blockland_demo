import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY } from '../../src/core/dirs';
import type { ItemEntity } from '../../src/entities/entity';
import { FALL_DELAY } from '../../src/sim/blockupdates';
import { FLAT_TOP, SEA_TOP, click, fill, flatSim, idAt, items, seaSim } from './helpers';

const T = FLAT_TOP;

describe('block updates', () => {
  it('unglued sand on a deck falls when the ship is assembled and lands on it as an item (ACCEPTANCE 9)', () => {
    const sim = seaSim({ mode: 'survival', spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    w.setCell(1, SEA_TOP, 1, makeCell(B.SAND));
    w.setCell(3, SEA_TOP, 1, makeCell(B.SAND));
    sim.worldGlue.add(3, SEA_TOP, 1, 3 /* NY: glued to the deck */);
    sim.advance(3);
    sim.lookAtCell(2, SEA_TOP, 4, 4 /* PZ */);
    click(sim);
    click(sim);
    const ship = sim.structures.ships()[0]!;
    expect(ship).toBeDefined();
    // The glued sand came along, the loose one stayed in the world...
    expect(idAt(ship.grid, 3, SEA_TOP, 1)).toBe(B.SAND);
    expect(idAt(w, 1, SEA_TOP, 1)).toBe(B.SAND);
    // ...and falls a moment later: onto the ship, where it becomes an item.
    sim.advance(FALL_DELAY + 1);
    expect(idAt(w, 1, SEA_TOP, 1)).not.toBe(B.SAND);
    sim.advance(40);
    expect(items(sim, B.SAND).entities).toBe(1);
    const drop = sim.entities.all().find((e) => e.kind === 'item') as ItemEntity;
    expect(drop.carrierId).toBe(ship.id);
    // Nothing became a sand block anywhere around.
    let sand = 0;
    for (let y = 20; y <= SEA_TOP + 2; y++) for (let z = -3; z <= 8; z++) for (let x = -3; x <= 8; x++) if (idAt(w, x, y, z) === B.SAND) sand++;
    expect(sand).toBe(0);
  });

  it('a torch pops off when its base is mined (drop in survival, nothing in creative)', () => {
    for (const mode of ['survival', 'creative'] as const) {
      const sim = flatSim({ mode });
      sim.world.setCell(0, T, -3, makeCell(B.STONE));
      sim.world.setCell(0, T + 1, -3, makeCell(B.TORCH));
      sim.tick();
      sim.world.setCell(0, T, -3, 0);
      sim.tick();
      expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.AIR);
      expect(items(sim, B.TORCH).entities).toBe(mode === 'survival' ? 1 : 0);
    }
  });

  it('a cactus column pops when the sand under it goes; gravity blocks fall and land as blocks', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    w.setCell(0, T - 1, -3, makeCell(B.SAND));
    w.setCell(0, T, -3, makeCell(B.CACTUS));
    w.setCell(0, T + 1, -3, makeCell(B.CACTUS));
    w.setCell(0, T + 2, -3, makeCell(B.CACTUS));
    sim.tick();
    w.setCell(0, T - 1, -3, makeCell(B.DIRT));
    sim.tick();
    expect(idAt(w, 0, T, -3)).toBe(B.AIR);
    expect(idAt(w, 0, T + 1, -3)).toBe(B.AIR);
    expect(idAt(w, 0, T + 2, -3)).toBe(B.AIR);
    expect(items(sim, B.CACTUS).count).toBe(3);

    // Sand placed in mid-air falls and lands as a block.
    w.setCell(3, T + 4, -3, makeCell(B.GRAVEL));
    w.setCell(3, T + 5, -3, makeCell(B.SAND));
    sim.advance(FALL_DELAY + 1);
    expect(idAt(w, 3, T + 4, -3)).toBe(B.AIR);
    sim.advance(60);
    expect(idAt(w, 3, T, -3)).toBe(B.GRAVEL);
    expect(idAt(w, 3, T + 1, -3)).toBe(B.SAND);
    expect(sim.entities.all().filter((e) => e.kind === 'falling').length).toBe(0);
  });

  it('a soft block overwritten by water is washed away and drops its item', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    w.setCell(1, T, -3, makeCell(B.FLOWER_YELLOW));
    w.setCell(0, T, -3, makeCell(B.WATER));
    sim.advance(20);
    expect(idAt(w, 1, T, -3)).toBe(B.WATER);
    expect(items(sim, B.FLOWER_YELLOW).entities).toBe(1);
  });

  it('inside a structure, a torch pops when the plank under it is mined', () => {
    const sim = seaSim({ mode: 'survival', spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    w.setCell(1, SEA_TOP, 1, makeCell(B.TORCH)); // joins the ship through its mounting face
    const res = sim.structures.assembleShip(2, SEA_TOP, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    expect(idAt(ship.grid, 1, SEA_TOP, 1)).toBe(B.TORCH);
    sim.advance(5);
    ship.grid.setCell(1, SEA_TOP - 1, 1, 0);
    sim.tick();
    expect(idAt(ship.grid, 1, SEA_TOP, 1)).toBe(B.AIR);
    expect(items(sim, B.TORCH).entities).toBe(1);
    void PY;
  });
});
