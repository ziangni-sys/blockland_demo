import { describe, expect, it } from 'vitest';
import { cellState, makeCell, stateAxis, stateFacing, stateLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { qfromYaw } from '../../src/core/math';
import { EventLog, FLAT_TOP, click, flatSim, idAt } from './helpers';

const T = FLAT_TOP; // first air row; the ground's top face is at y = T

describe('placement', () => {
  it('logs take the axis of the clicked face (side face -> lying log)', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.world.setCell(-2, T + 1, -2, makeCell(B.STONE));
    sim.world.setCell(0, T + 1, -3, makeCell(B.STONE));
    sim.hold(B.LOG_OAK);

    sim.lookAtCell(0, T, -2, PY); // top face
    click(sim);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T + 1, -2)))).toBe(1);

    sim.lookAtCell(-2, T + 1, -2, PX); // east face
    click(sim);
    expect(idAt(sim.world, -1, T + 1, -2)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(-1, T + 1, -2)))).toBe(0);

    sim.world.setCell(0, T + 1, -2, 0); // clear the line of sight
    sim.lookAtCell(0, T + 1, -3, PZ); // south face
    click(sim);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T + 1, -2)))).toBe(2);
  });

  it('bearings and propellers face away from the clicked block; the helm faces where the player looks', () => {
    const sim = flatSim();
    sim.world.setCell(-2, T + 1, -2, makeCell(B.STONE));
    sim.hold(B.BEARING);
    sim.lookAtCell(-2, T + 1, -2, PX);
    click(sim);
    expect(idAt(sim.world, -1, T + 1, -2)).toBe(B.BEARING);
    expect(stateFacing(cellState(sim.world.getCell(-1, T + 1, -2)))).toBe(PX);

    sim.world.setCell(0, T + 1, -3, makeCell(B.STONE));
    sim.hold(B.PROPELLER);
    sim.lookAtCell(0, T + 1, -3, PZ);
    click(sim);
    expect(stateFacing(cellState(sim.world.getCell(0, T + 1, -2)))).toBe(PZ);

    // helm north of the player: looking north
    sim.world.setCell(0, T, -3, 0);
    sim.world.setCell(0, T + 1, -3, 0);
    sim.world.setCell(0, T + 1, -2, 0);
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.hold(B.HELM);
    sim.lookAtCell(0, T, -2, PY);
    click(sim);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.HELM);
    expect(stateFacing(cellState(sim.world.getCell(0, T + 1, -2)))).toBe(NZ);
    // helm east of the player: looking east
    sim.world.setCell(2, T, 0, makeCell(B.STONE));
    sim.lookAtCell(2, T, 0, PY);
    click(sim);
    expect(idAt(sim.world, 2, T + 1, 0)).toBe(B.HELM);
    expect(stateFacing(cellState(sim.world.getCell(2, T + 1, 0)))).toBe(PX);
    // and west
    sim.world.setCell(-2, T, 0, makeCell(B.STONE));
    sim.lookAtCell(-2, T, 0, PY);
    click(sim);
    expect(stateFacing(cellState(sim.world.getCell(-2, T + 1, 0)))).toBe(NX);
  });

  it('support rules: torches need a hard block below, cactus needs sand or cactus', () => {
    const sim = flatSim();
    const log = new EventLog(sim);
    sim.world.setCell(0, T + 2, -3, makeCell(B.STONE)); // floating block
    sim.hold(B.TORCH);
    sim.lookAtCell(0, T + 2, -3, PZ); // side face: the torch would hang in the air
    click(sim);
    expect(idAt(sim.world, 0, T + 2, -2)).toBe(B.AIR);
    expect(log.toastKeys()).toContain('toast.place.support');

    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.lookAtCell(0, T, -2, PY);
    click(sim);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.TORCH);

    sim.hold(B.CACTUS);
    sim.lookAtCell(1, T - 1, -2, PY); // turf
    click(sim);
    expect(idAt(sim.world, 1, T, -2)).toBe(B.AIR);
    sim.world.setCell(1, T - 1, -2, makeCell(B.SAND));
    click(sim);
    expect(idAt(sim.world, 1, T, -2)).toBe(B.CACTUS);
    sim.lookAtCell(1, T, -2, PY);
    click(sim);
    expect(idAt(sim.world, 1, T + 1, -2)).toBe(B.CACTUS);
  });

  it('a hard block never goes into an entity body; soft blocks and other cells are fine', () => {
    const sim = flatSim();
    const log = new EventLog(sim);
    sim.hold(B.STONE);
    // straight down: the cell the player stands in
    sim.lookAtCell(0, T - 1, 0, PY);
    click(sim);
    expect(idAt(sim.world, 0, T, 0)).toBe(B.AIR);
    expect(log.toastKeys()).toContain('toast.place.occupied');
    // a rabbit
    const r = sim.entities.spawnRabbit(0.5, T, -1.5);
    sim.lookAtCell(0, T - 1, -2, PY);
    r.setPosition(0.5, T, -1.5);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.AIR);
    // a torch (soft) may go where the rabbit is
    sim.hold(B.TORCH);
    r.setPosition(0.5, T, -1.5);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.TORCH);
  });

  it('the overlap test is exact for rotated structure grids', () => {
    const sim = flatSim();
    sim.structures.dynamics = null; // keep the test ship exactly where it is put
    // A plank + helm "ship" hovering in the air, turned 45 degrees about the plank's centre.
    sim.world.setCell(0, T + 3, -6, makeCell(B.HELM));
    sim.world.setCell(0, T + 2, -6, makeCell(B.PLANKS_OAK));
    const res = sim.structures.assembleShip(0, T + 3, -6);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    const g = ship.grid;
    const pivot = { x: 0.5, y: T + 2.5, z: -5.5 };
    g.setPivotKeepingPose(pivot);
    g.setPoseImmediate(pivot, qfromYaw(Math.PI / 4));
    // The new cell goes east of the plank in the SHIP's frame; in the world it is a diamond
    // centred at c whose world AABB is sqrt(2) wide.
    const c = g.toWorld({ x: 1.5, y: T + 2.5, z: -5.5 });
    sim.teleport(2.5, T, -7.5); // outside the plank's east face, within reach
    const rabbit = sim.entities.spawnRabbit(0, 0, 0);
    const tryPlace = (dx: number, dz: number): boolean => {
      sim.hold(B.STONE);
      sim.lookAtCell(0, T + 2, -6, PX, ship.id);
      rabbit.setPosition(c.x + dx, T + 2, c.z + dz);
      rabbit.vel.x = rabbit.vel.y = rabbit.vel.z = 0;
      sim.use();
      sim.tick();
      const placed = idAt(g, 1, T + 2, -6) === B.STONE;
      if (placed) g.setCell(1, T + 2, -6, 0);
      return placed;
    };
    // Rabbit (half width 0.2) at c + (0.6, 0.6): inside the cell's world AABB, outside the cell.
    expect(tryPlace(0.6, 0.6)).toBe(true);
    // At c + (0.45, 0.45) its nearest corner (0.25, 0.25) is inside the diamond.
    expect(tryPlace(0.45, 0.45)).toBe(false);
    expect(tryPlace(0, 0)).toBe(false);
  });

  it('snow cover stacks; survival consumes one item per block, creative none', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.hold(B.SNOW_LAYER, 10);
    sim.lookAtCell(0, T, -2, PY);
    click(sim);
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.SNOW_LAYER);
    sim.lookAtCell(0, T + 1, -2);
    click(sim);
    click(sim);
    expect(stateLayers(cellState(sim.world.getCell(0, T + 1, -2)))).toBe(3);
    expect(sim.player.inventory.count(B.SNOW_LAYER)).toBe(7);

    const c = flatSim({ mode: 'creative' });
    c.world.setCell(0, T, -2, makeCell(B.STONE));
    c.hold(B.PLANKS_OAK, 5);
    c.lookAtCell(0, T, -2, PY);
    click(c);
    expect(idAt(c.world, 0, T + 1, -2)).toBe(B.PLANKS_OAK);
    expect(c.player.inventory.count(B.PLANKS_OAK)).toBe(5);
  });

  it('clicking a grass tuft replaces it; blocks go only into replaceable cells', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -2, makeCell(B.TALL_GRASS));
    sim.hold(B.PLANKS_OAK);
    sim.lookAtCell(0, T, -2);
    click(sim);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.PLANKS_OAK);
  });
});
