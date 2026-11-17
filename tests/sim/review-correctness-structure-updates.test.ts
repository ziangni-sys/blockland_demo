/**
 * Adversarial review (correctness): block updates and placement rules inside structures.
 */
import { describe, expect, it } from 'vitest';
import { cellState, facingState, makeCell, stateLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PY } from '../../src/core/dirs';
import { qfromAxisAngle } from '../../src/core/math';
import { EventLog, FLAT_TOP, click, fill, flatSim, idAt } from './helpers';

const T = FLAT_TOP;

describe('review: support rules after a rotor blockifies onto a ship', () => {
  /**
   * DESIGN 组装和方块化之后要触发方块更新 ("没有支撑的花草掉落"), brief: "a structure cell that loses
   * the HARD block under a support-needing block pops that block too". A torch standing on the
   * top blade of a ship-mounted windmill that stops upside down ends up UNDER the blade, with
   * nothing below it in the ship grid. It must pop (the same rule as on a world-mounted rotor),
   * not hang in the ship forever.
   */
  it('a torch that lands upside down on the ship pops off', () => {
    const sim = flatSim({ mode: 'survival', spawn: { x: 12.5, y: T, z: 12.5 } });
    sim.structures.dynamics = null; // keep the hovering test ship exactly where it is
    const w = sim.world;
    const y0 = T + 2;
    // A small plank deck hovering in the air, a helm on it, a tall plank mast.
    fill(w, 0, y0, 0, 2, y0, 2, B.PLANKS_OAK);
    w.setCell(1, y0 + 1, 2, makeCell(B.HELM, facingState(NZ)));
    fill(w, 0, y0 + 1, 1, 0, y0 + 8, 1, B.PLANKS_OAK);
    // Bearing on top of the mast's east side facing +X; hub + cross of canvas in the plane x = 2.
    const by = y0 + 8;
    w.setCell(1, by, 1, makeCell(B.BEARING, facingState(PX)));
    for (const [dy, dz] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, -1]] as const) {
      w.setCell(2, by + dy, 1 + dz, makeCell(B.CANVAS));
    }
    w.setCell(2, by + 3, 1, makeCell(B.TORCH)); // standing on the top blade (mounts below)
    sim.worldGlue.add(2, by, 1, 1 /* NX: hub <-> bearing, so the stopped windmill rides along */);
    const sres = sim.structures.assembleShip(1, y0 + 1, 2);
    expect(sres.ok).toBe(true);
    if (!sres.ok) return;
    const ship = sres.structure;
    sim.tick();
    const rres = sim.structures.startRotor(ship.grid, 1, by, 1);
    expect(rres.ok ? 'ok' : rres.reason).toBe('ok');
    if (!rres.ok) return;
    const rotor = rres.structure;
    expect(idAt(rotor.grid, 2, by + 3, 1)).toBe(B.TORCH);
    // Turn it half a revolution about its axis (+X) and stop it there.
    const g = rotor.grid;
    g.setPoseImmediate(g.pivot, qfromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI));
    rotor.angle = Math.PI;
    sim.structures.stopRotor(rotor);
    expect(rotor.removed).toBe(true);
    // The torch landed under the (former top) blade, with nothing below it in the ship grid.
    expect(idAt(ship.grid, 2, by - 2, 1)).toBe(B.CANVAS);
    expect(idAt(ship.grid, 2, by - 4, 1)).toBe(B.AIR);
    sim.advance(3);
    // It must pop off (drop in survival) instead of hanging there forever.
    expect(idAt(ship.grid, 2, by - 3, 1)).not.toBe(B.TORCH);
  });
});

describe('review: snow layers stack on structures too', () => {
  it('a second snow layer clicked onto a snow layer on a ship deck stacks', () => {
    const sim = flatSim({ spawn: { x: 1.5, y: T, z: 4.5 } });
    sim.structures.dynamics = null;
    const w = sim.world;
    const y0 = T + 1;
    fill(w, 0, y0, 0, 2, y0, 2, B.PLANKS_OAK);
    w.setCell(1, y0 + 1, 2, makeCell(B.HELM, facingState(NZ)));
    const sres = sim.structures.assembleShip(1, y0 + 1, 2);
    expect(sres.ok).toBe(true);
    if (!sres.ok) return;
    const ship = sres.structure;
    sim.player.flying = true;
    sim.teleport(1.5, T + 3, -2.5);
    sim.player.flying = true;
    sim.tick();
    const log = new EventLog(sim);
    sim.hold(B.SNOW_LAYER);
    expect(sim.useOn(1, y0, 0, PY, ship.id)).toBe(true);
    expect(idAt(ship.grid, 1, y0 + 1, 0)).toBe(B.SNOW_LAYER);
    // Same click on the snow layer itself (as in the world): it should stack, not refuse.
    sim.lookAtCell(1, y0 + 1, 0, undefined, ship.id);
    click(sim);
    expect(log.toastKeys()).not.toContain('toast.place.support');
    expect(stateLayers(cellState(ship.grid.getCell(1, y0 + 1, 0)))).toBe(2);
  });
});
