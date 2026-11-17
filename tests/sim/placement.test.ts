import { describe, expect, it } from 'vitest';
import { cellState, facingState, makeCell, stateAxis, stateFacing, stateLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { qfromYaw } from '../../src/core/math';
import { EventLog, FLAT_TOP, click, fill, flatSim, idAt } from './helpers';

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

describe('placement on ships', () => {
  /** A 3x3 plank deck hovering at y = T + 1 (dynamics off: it stays exactly there), helm facing north at (1, T + 2, 2). */
  function hoveringRaft(sim: ReturnType<typeof flatSim>) {
    sim.structures.dynamics = null;
    const w = sim.world;
    fill(w, 0, T + 1, 0, 2, T + 1, 2, B.PLANKS_OAK);
    w.setCell(1, T + 2, 2, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(1, T + 2, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('assembly failed');
    return res.structure;
  }

  it('snow cover stacks on a deck like in the world; a grass tuft on a deck is replaced in place', () => {
    const sim = flatSim({ spawn: { x: 1.5, y: T, z: 5.5 } });
    const ship = hoveringRaft(sim);
    sim.teleport(1.5, T + 3, -2.5);
    sim.player.flying = true;
    sim.tick();
    const log = new EventLog(sim);
    sim.hold(B.SNOW_LAYER);
    expect(sim.useOn(1, T + 1, 0, PY, ship.id)).toBe(true);
    for (let i = 0; i < 2; i++) expect(sim.useOn(1, T + 2, 0, undefined, ship.id)).toBe(true);
    expect(idAt(ship.grid, 1, T + 3, 0)).toBe(B.AIR); // nothing went on top of the cover
    expect(stateLayers(cellState(ship.grid.getCell(1, T + 2, 0)))).toBe(3);
    expect(log.toastKeys()).toEqual([]);

    ship.grid.setCell(0, T + 2, 0, makeCell(B.TALL_GRASS));
    sim.hold(B.PLANKS_OAK);
    expect(sim.useOn(0, T + 2, 0, undefined, ship.id)).toBe(true);
    expect(idAt(ship.grid, 0, T + 2, 0)).toBe(B.PLANKS_OAK);
    expect(idAt(ship.grid, 0, T + 3, 0)).toBe(B.AIR);
  });

  it('sneak + right-click with a block item on a ship helm places the block (as on a world helm); docking needs an empty hand', () => {
    // The player stands on the ground south-east of the hovering raft, below its deck.
    const sim = flatSim({ spawn: { x: 4.5, y: T, z: 4.5 } });
    const ship = hoveringRaft(sim);
    sim.advance(3);
    const log = new EventLog(sim);
    sim.hold(B.STONE);
    sim.lookAtCell(1, T + 2, 2, PX, ship.id);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.steerPlace'); // says how to dock with a block in hand
    sim.player.input.sneak = true;
    sim.lookAtCell(1, T + 2, 2, PX, ship.id); // the eye is lower while sneaking
    sim.tick();
    expect(sim.view.target).toMatchObject({ gridId: ship.id, x: 1, y: T + 2, z: 2 });
    expect(sim.view.hint).toBeNull();
    expect(sim.useOn(1, T + 2, 2, PX, ship.id)).toBe(true);
    expect(ship.removed).toBe(false);
    expect(idAt(ship.grid, 2, T + 2, 2)).toBe(B.STONE);
    expect(log.toastKeys()).not.toContain('toast.dock.done');

    sim.emptyHand();
    sim.lookAtCell(1, T + 2, 2, PZ, ship.id);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.steer');
    expect(sim.useOn(1, T + 2, 2, PZ, ship.id)).toBe(true);
    sim.player.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(log.toastKeys()).toContain('toast.dock.done');
    expect(idAt(sim.world, 2, T + 2, 2)).toBe(B.STONE);
    expect(idAt(sim.world, 1, T + 2, 2)).toBe(B.HELM);
  });

  it('a ship cannot grow past its assembly limit by placing blocks (it could never be assembled again)', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: 0.5 }, loadRadius: 4 });
    sim.advance(25); // every chunk under the deck and around it
    sim.structures.dynamics = null;
    const w = sim.world;
    const y0 = T + 1;
    // A two-layer deck of 50 x 40 x 2 = 4000 cells, minus two corner cells, plus the helm.
    fill(w, -20, y0, -20, 29, y0 + 1, 19, B.PLANKS_OAK);
    w.setCell(29, y0 + 1, 19, 0);
    w.setCell(29, y0 + 1, 18, 0);
    w.setCell(0, y0 + 2, 3, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(0, y0 + 2, 3);
    expect(res.ok ? 'ok' : res.reason).toBe('ok');
    if (!res.ok) return;
    const ship = res.structure;
    expect(ship.grid.count).toBe(sim.shipMaxCells - 1);
    sim.teleport(0.5, y0 + 2, 0.5);
    sim.player.flying = true;
    sim.tick();
    const log = new EventLog(sim);
    sim.hold(B.STONE);
    expect(sim.useOn(0, y0 + 1, -2, PY, ship.id)).toBe(true);
    expect(idAt(ship.grid, 0, y0 + 2, -2)).toBe(B.STONE);
    expect(ship.grid.count).toBe(sim.shipMaxCells);
    expect(sim.useOn(2, y0 + 1, -2, PY, ship.id)).toBe(true);
    expect(idAt(ship.grid, 2, y0 + 2, -2)).toBe(B.AIR);
    expect(ship.grid.count).toBe(sim.shipMaxCells);
    expect(log.toasts()).toContainEqual({ key: 'fail.ship.too_big', params: { max: sim.shipMaxCells } });
    // Replacing soft cover adds no cell, so it is still allowed at the limit.
    ship.grid.setCell(4, y0 + 2, -2, makeCell(B.TALL_GRASS));
    expect(ship.grid.count).toBe(sim.shipMaxCells + 1); // (set directly, past the limit)
    expect(sim.useOn(4, y0 + 2, -2, undefined, ship.id)).toBe(true);
    expect(idAt(ship.grid, 4, y0 + 2, -2)).toBe(B.STONE);
  });
});
