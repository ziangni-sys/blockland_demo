/**
 * The structure box limit through the player's hands (docs/DESIGN.md 组装与方块化, 放置与挖掘):
 * the first right-click on a helm or a bearing already reports a structure spread over too large
 * an area and highlights nothing; building onto a ship or a stopped rotor past the limit is
 * refused with the same message, like the cell-count limit.
 */
import { describe, expect, it } from 'vitest';
import { AIR, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { STRUCTURE_MAX_BOX_CELLS } from '../../src/core/constants';
import { NX, PY, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { EventLog, click, fill, idAt, voidSim } from './helpers';

const LIMIT = STRUCTURE_MAX_BOX_CELLS;

function boxCells(sim: Simulation, gridId: number): number {
  const b = sim.structures.gridById(gridId)!.cellBounds()!;
  return (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ);
}

/** A void world whose loaded chunks hold the plus-shaped frames below (|x|, |z| <= 66 on the axes). */
function frameSim(): Simulation {
  const sim = voidSim({ spawn: { x: 0.5, y: 64, z: 0.5 }, loadRadius: 5 });
  sim.structures.dynamics = null;
  const edges = [[-66, 0], [-66, -1], [65, 0], [65, -1], [0, -65], [-1, -65], [0, 64], [-1, 64]] as const;
  for (let i = 0; i < 200 && !edges.every(([x, z]) => sim.world.isLoaded(x, z)); i++) sim.tick();
  for (const [x, z] of edges) expect(sim.world.isLoaded(x, z), `${x},${z}`).toBe(true);
  return sim;
}

/** Fly the player to a world point (no fall between the clicks). */
function hover(sim: Simulation, x: number, y: number, z: number): void {
  sim.soloPlayer.teleport(x, y, z);
  sim.soloPlayer.player.flying = true;
}

describe('assembly preview and the box limit (预览和实际组装的判定保证一致)', () => {
  /**
   * Planks along x (x0..64) and z (-64..63) at y = 0 and up the mast x = z = 0 (y 0..127), a helm
   * on (1,0,0). Box (65 - x0) x 128 x 128: x0 = -64 is 129 wide (over), x0 = -63 exactly the limit.
   */
  function shipFrame(sim: Simulation, x0: number): void {
    const w = sim.world;
    fill(w, x0, 0, 0, 64, 0, 0, B.PLANKS_OAK);
    fill(w, 0, 0, -64, 0, 0, 63, B.PLANKS_OAK);
    fill(w, 0, 0, 0, 0, 127, 0, B.PLANKS_OAK);
    w.setCell(1, 1, 0, makeCell(B.HELM, facingState(PZ)));
  }

  it('ship: the first click reports too_spread and shows nothing; the second click assembles nothing', () => {
    const sim = frameSim();
    shipFrame(sim, -64);
    hover(sim, 1.5, 1, 3.5);
    const log = new EventLog(sim);
    expect(sim.soloPlayer.useOn(1, 1, 0)).toBe(true);
    expect(log.toasts()).toEqual([{ key: 'fail.ship.too_spread', params: { max: sim.shipMaxCells, box: LIMIT } }]);
    expect(sim.soloPlayer.view.preview).toBeNull();
    click(sim);
    expect(log.toastKeys()).toEqual(['fail.ship.too_spread', 'fail.ship.too_spread']);
    expect(sim.structures.all()).toEqual([]);
    expect(idAt(sim.world, 0, 127, 0)).toBe(B.PLANKS_OAK);
  });

  it('ship: one column narrower (box exactly the limit) previews every cell and assembles', () => {
    const sim = frameSim();
    shipFrame(sim, -63);
    hover(sim, 1.5, 1, 3.5);
    const log = new EventLog(sim);
    expect(sim.soloPlayer.useOn(1, 1, 0)).toBe(true);
    expect(log.toasts()).toEqual([]);
    expect(sim.soloPlayer.view.preview?.cells.length).toBe((128 + 127 + 127 + 1) * 3);
    click(sim);
    const ships = sim.structures.ships();
    expect(ships.length).toBe(1);
    expect(boxCells(sim, ships[0]!.id)).toBe(LIMIT);
  });

  /**
   * A bearing at (0,0,0) facing up; canvas in front of it: along x (x0..64) and z (-64..63) at
   * y = 1 and up x = z = 0 (y 1..127). Box (65 - x0) x 127 x 128: x0 = -65 is over the limit,
   * x0 = -64 just under it (2 097 024 cells).
   */
  function rotorFrame(sim: Simulation, x0: number): void {
    const w = sim.world;
    w.setCell(0, 0, 0, makeCell(B.BEARING, facingState(PY)));
    fill(w, x0, 1, 0, 64, 1, 0, B.CANVAS);
    fill(w, 0, 1, -64, 0, 1, 63, B.CANVAS);
    fill(w, 0, 1, 0, 0, 127, 0, B.CANVAS);
  }

  it('rotor: the first click reports too_spread and shows nothing; the second click starts nothing', () => {
    const sim = frameSim();
    rotorFrame(sim, -65);
    hover(sim, 2.5, 0, 2.5);
    const log = new EventLog(sim);
    expect(sim.soloPlayer.useOn(0, 0, 0)).toBe(true);
    expect(log.toasts()).toEqual([
      { key: 'fail.rotor.too_spread', params: { max: sim.rotorMaxCells, min: sim.rotorMinSails, sails: expect.any(Number), box: LIMIT } },
    ]);
    expect(sim.soloPlayer.view.preview).toBeNull();
    click(sim);
    expect(log.toastKeys()).toEqual(['fail.rotor.too_spread', 'fail.rotor.too_spread']);
    expect(sim.structures.all()).toEqual([]);
  });

  it('rotor: one column narrower (just under the limit) previews every cell and starts', () => {
    const sim = frameSim();
    rotorFrame(sim, -64);
    hover(sim, 2.5, 0, 2.5);
    const log = new EventLog(sim);
    expect(sim.soloPlayer.useOn(0, 0, 0)).toBe(true);
    expect(log.toasts()).toEqual([]);
    expect(sim.soloPlayer.view.preview?.cells.length).toBe((129 + 127 + 126) * 3);
    click(sim);
    const rotors = sim.structures.rotors();
    expect(rotors.length).toBe(1);
    expect(boxCells(sim, rotors[0]!.id)).toBe(129 * 127 * 128);
  });
});

describe('building onto a structure and the box limit (放置与挖掘)', () => {
  it('a ship at the limit refuses blocks that would widen its box and takes blocks inside it', () => {
    const sim = voidSim({ spawn: { x: 0.5, y: 64, z: 0.5 } });
    sim.structures.dynamics = null;
    fill(sim.world, 0, 64, 0, 2, 64, 2, B.PLANKS_OAK);
    sim.world.setCell(1, 65, 1, makeCell(B.HELM, facingState(PZ)));
    const res = sim.structures.assembleShip(1, 65, 1);
    if (!res.ok) throw new Error(res.reason);
    const ship = res.structure;
    const g = ship.grid;
    // Test setup: two far planks make the tight box x 0..1023, y 64..65, z 0..1023 = 2^21.
    g.setCell(1023, 64, 0, makeCell(B.PLANKS_OAK));
    g.setCell(0, 64, 1023, makeCell(B.PLANKS_OAK));
    expect(boxCells(sim, ship.id)).toBe(LIMIT);
    hover(sim, -3.5, 66, 1.5);
    sim.soloPlayer.hold(B.PLANKS_PINE);
    sim.tick();
    const log = new EventLog(sim);
    const spread = { key: 'fail.ship.too_spread', params: { box: LIMIT } };

    // West of the raft: the box would be 1025 wide.
    expect(sim.soloPlayer.useOn(0, 64, 1, NX, ship.id)).toBe(true);
    expect(g.getCell(-1, 64, 1)).toBe(AIR);
    expect(log.toasts()).toEqual([spread]);
    // On the deck, inside the box: allowed.
    expect(sim.soloPlayer.useOn(0, 64, 0, PY, ship.id)).toBe(true);
    expect(idAt(g, 0, 65, 0)).toBe(B.PLANKS_PINE);
    // On top of that: the box would be 3 high.
    expect(sim.soloPlayer.useOn(0, 65, 0, PY, ship.id)).toBe(true);
    expect(g.getCell(0, 66, 0)).toBe(AIR);
    expect(log.toasts()).toEqual([spread, spread]);
    expect(boxCells(sim, ship.id)).toBe(LIMIT);

    // One column narrower: the block west of the raft brings the box exactly to the limit.
    g.setCell(1023, 64, 0, AIR);
    g.setCell(1022, 64, 0, makeCell(B.PLANKS_OAK));
    expect(sim.soloPlayer.useOn(0, 64, 1, NX, ship.id)).toBe(true);
    expect(idAt(g, -1, 64, 1)).toBe(B.PLANKS_PINE);
    expect(boxCells(sim, ship.id)).toBe(LIMIT);
    expect(sim.soloPlayer.useOn(-1, 64, 1, NX, ship.id)).toBe(true);
    expect(g.getCell(-2, 64, 1)).toBe(AIR);
    expect(log.toasts()).toEqual([spread, spread, spread]);
  });

  it('a stopped rotor at the limit refuses blocks that would widen its box', () => {
    const sim = voidSim({ spawn: { x: 0.5, y: 64, z: 0.5 } });
    const w = sim.world;
    w.setCell(0, 66, -3, makeCell(B.BEARING, facingState(PZ)));
    for (const [x, y] of [[0, 66], [1, 66], [-1, 66], [0, 67], [0, 65]] as const) w.setCell(x, y, -2, makeCell(B.CANVAS));
    const res = sim.structures.startRotor(w, 0, 66, -3);
    if (!res.ok) throw new Error(res.reason);
    const rotor = res.structure;
    const g = rotor.grid;
    // Test setup: the tight box becomes x -1..126, y 65..192, z -2..125 = 128^3. Its blades now
    // sweep into unloaded chunks, so it stays frozen at speed 0: a stopped rotor, editable.
    g.setCell(126, 66, -2, makeCell(B.CANVAS));
    g.setCell(0, 192, -2, makeCell(B.CANVAS));
    g.setCell(0, 66, 125, makeCell(B.CANVAS));
    expect(boxCells(sim, rotor.id)).toBe(LIMIT);
    hover(sim, -3.5, 66, 0.5);
    sim.soloPlayer.hold(B.CANVAS);
    sim.tick();
    expect(rotor.editable).toBe(true);
    const log = new EventLog(sim);
    expect(sim.soloPlayer.useOn(-1, 66, -2, NX, rotor.id)).toBe(true);
    expect(g.getCell(-2, 66, -2)).toBe(AIR);
    expect(log.toasts()).toEqual([{ key: 'fail.rotor.too_spread', params: { box: LIMIT } }]);
    expect(sim.soloPlayer.useOn(-1, 66, -2, PY, rotor.id)).toBe(true);
    expect(idAt(g, -1, 67, -2)).toBe(B.CANVAS);
    expect(log.toasts().length).toBe(1);
  });
});
