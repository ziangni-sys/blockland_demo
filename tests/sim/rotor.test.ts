import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { PX, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { NZ } from '../../src/core/dirs';
import { EventLog, FLAT_TOP, SEA_TOP, click, countId, fill, flatSim, idAt, seaSim } from './helpers';

const T = FLAT_TOP;

/**
 * A windmill on a tower: rubble-brick tower x=-1, z=-4, y T..T+4; bearing (0, T+4, -4) facing
 * east; canvas hub (1, T+4, -4) with a cross of 8 canvas sails in the plane x = 1 (9 sails).
 * The player stands south-west of it, outside everything the blades sweep.
 */
function windmill(sim: Simulation, sails = true): void {
  const w = sim.world;
  fill(w, -1, T, -4, -1, T + 4, -4, B.STONE_BRICKS);
  w.setCell(0, T + 4, -4, makeCell(B.BEARING, facingState(PX)));
  w.setCell(1, T + 4, -4, makeCell(B.CANVAS));
  if (!sails) return;
  for (const [dy, dz] of [
    [1, 0],
    [2, 0],
    [-1, 0],
    [-2, 0],
    [0, 1],
    [0, 2],
    [0, -1],
    [0, -2],
  ] as const) {
    w.setCell(1, T + 4 + dy, -4 + dz, makeCell(B.CANVAS));
  }
}

function aimBearing(sim: Simulation): void {
  sim.soloPlayer.lookAtCell(0, T + 4, -4, PZ);
}

describe('bearing: preview, start, stop', () => {
  it('previews, starts, refuses edits while spinning, and stops back into blocks', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim);
    const log = new EventLog(sim);
    aimBearing(sim);
    sim.tick();
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.bearing.preview');
    click(sim);
    expect(sim.soloPlayer.view.preview?.kind).toBe('rotor');
    expect(sim.soloPlayer.view.preview?.cells.length).toBe(9 * 3);
    expect(sim.soloPlayer.view.hint).toEqual({ key: 'hint.bearing.start', params: { count: 9, sails: 9 } });
    click(sim);
    const rotors = sim.structures.rotors();
    expect(rotors.length).toBe(1);
    const rotor = rotors[0]!;
    expect(rotor.sails).toBe(9);
    expect(log.toastKeys()).toContain('toast.rotor.started');
    expect(countId(sim.world, B.CANVAS, 0, T, -8, 2, T + 8, 0)).toBe(0);
    sim.advance(10);
    expect(rotor.angularSpeed).toBeGreaterThan(0);
    expect(rotor.editable).toBe(false);
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.bearing.stop');

    // Spinning: no mining, placing or gluing on it.
    sim.soloPlayer.lookAt(1.5, T + 4.5, -4.5); // the hub (it turns about its own centre)
    sim.tick();
    expect(sim.soloPlayer.view.target?.gridId).toBe(rotor.id);
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.rotor.spinning');
    const before = rotor.grid.count;
    sim.soloPlayer.attack();
    sim.soloPlayer.player.input.attack = true;
    sim.advance(20);
    sim.soloPlayer.player.input.attack = false;
    expect(rotor.grid.count).toBe(before);
    sim.soloPlayer.hold(B.PLANKS_OAK);
    click(sim);
    expect(rotor.grid.count).toBe(before);
    expect(log.toastKeys()).toContain('toast.place.spinning');
    const glueBefore = rotor.glue.size;
    sim.soloPlayer.hold(I.GLUE);
    click(sim);
    expect(log.toastKeys()).toContain('toast.glue.spinning');
    expect(rotor.glue.size).toBe(glueBefore);
    expect(sim.soloPlayer.view.glueProgress).toBe(0);

    // Right-click the bearing again: stop, the windmill turns back into blocks.
    sim.soloPlayer.hold(B.STONE);
    aimBearing(sim);
    click(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(log.toastKeys()).toContain('toast.rotor.stopped');
    expect(countId(sim.world, B.CANVAS, 0, T, -8, 2, T + 8, 0)).toBe(9);
    expect(idAt(sim.world, 0, T + 4, -4)).toBe(B.BEARING);
  });

  it('mining the bearing of a running windmill blockifies it in place (ACCEPTANCE 11)', () => {
    const sim = flatSim({ mode: 'survival', spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim);
    const res = sim.structures.startRotor(sim.world, 0, T + 4, -4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rotor = res.structure;
    sim.advance(30);
    expect(rotor.angle).not.toBe(0);
    const log = new EventLog(sim);
    sim.soloPlayer.hold(B.DIRT);
    aimBearing(sim);
    sim.soloPlayer.player.input.attack = true;
    sim.advance(40); // bearing: 2 s
    sim.soloPlayer.player.input.attack = false;
    expect(idAt(sim.world, 0, T + 4, -4)).toBe(B.AIR);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.all().length).toBe(0);
    expect(log.of('structureRemoved').map((e) => e.id)).toEqual([rotor.id]);
    // Every canvas cell is back in the world (open air around: nothing dropped).
    expect(countId(sim.world, B.CANVAS, -2, T, -8, 4, T + 8, 0)).toBe(9);
  });

  it('too few sails: a toast with the reason, the preview shows the rotor but never starts it', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim, false);
    sim.world.setCell(1, T + 5, -4, makeCell(B.CANVAS));
    const log = new EventLog(sim);
    aimBearing(sim);
    click(sim);
    expect(log.toasts()).toContainEqual({ key: 'fail.rotor.not_enough_sails', params: { max: 400, min: 4, sails: 2 } });
    expect(sim.soloPlayer.view.preview?.cells.length).toBe(2 * 3);
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.bearing.preview');
    click(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(log.toastKeys().filter((k) => k === 'fail.rotor.not_enough_sails').length).toBe(2);
  });

  it('nothing in front of the bearing: no_hub', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim, false);
    sim.world.setCell(1, T + 4, -4, 0);
    const log = new EventLog(sim);
    aimBearing(sim);
    click(sim);
    expect(log.toastKeys()).toEqual(['fail.rotor.no_hub']);
    expect(sim.soloPlayer.view.preview).toBeNull();
  });

  it('a change between the clicks re-previews instead of starting', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim);
    aimBearing(sim);
    click(sim);
    expect(sim.soloPlayer.view.preview?.cells.length).toBe(27);
    sim.world.setCell(1, T + 7, -4, makeCell(B.CANVAS)); // one more sail on top
    click(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(sim.soloPlayer.view.preview?.cells.length).toBe(30);
    click(sim);
    expect(sim.structures.rotors().length).toBe(1);
    expect(sim.structures.rotors()[0]!.grid.count).toBe(10);
  });

  it('the preview is dropped after looking away for a while, or when switching slots', () => {
    const sim = flatSim({ spawn: { x: 0.5, y: T, z: -1.5 } });
    windmill(sim);
    aimBearing(sim);
    click(sim);
    expect(sim.soloPlayer.view.preview).not.toBeNull();
    sim.soloPlayer.player.input.pitch = -1.2; // look at the ground
    sim.advance(20);
    expect(sim.soloPlayer.view.preview).not.toBeNull();
    sim.advance(15);
    expect(sim.soloPlayer.view.preview).toBeNull();
    aimBearing(sim);
    click(sim);
    expect(sim.soloPlayer.view.preview).not.toBeNull();
    sim.soloPlayer.player.input.slot = 4;
    sim.tick();
    expect(sim.soloPlayer.view.preview).toBeNull();
  });

  it('works the same on a ship: the rotor mounts on the ship and stops back into it', () => {
    const sim = seaSim({ spawn: { x: 5.5, y: SEA_TOP + 1, z: 1.5 } });
    sim.soloPlayer.player.flying = true;
    const w = sim.world;
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 4, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    fill(w, 2, SEA_TOP, 2, 2, SEA_TOP + 3, 2, B.PLANKS_OAK);
    const by = SEA_TOP + 3;
    w.setCell(2, by, 1, makeCell(B.BEARING, facingState(NZ)));
    for (const [dx, dy] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]] as const) {
      w.setCell(2 + dx, by + dy, 0, makeCell(B.CANVAS));
    }
    sim.worldGlue.add(2, by, 0, PZ); // hub <-> bearing: the stopped windmill rides along
    const sres = sim.structures.assembleShip(2, SEA_TOP, 4);
    expect(sres.ok).toBe(true);
    if (!sres.ok) return;
    const ship = sres.structure;
    expect(ship.grid.count).toBe(25 + 1 + 4 + 1 + 9);
    sim.advance(5);
    sim.soloPlayer.teleport(5.5, SEA_TOP + 1, 1.5);
    sim.soloPlayer.player.flying = true;
    sim.advance(2);

    expect(sim.soloPlayer.useOn(2, by, 1, PX, ship.id)).toBe(true);
    expect(sim.soloPlayer.view.preview).toMatchObject({ gridId: ship.id, kind: 'rotor' });
    expect(sim.soloPlayer.view.preview!.cells.length).toBe(27);
    expect(sim.soloPlayer.useOn(2, by, 1, PX, ship.id)).toBe(true);
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor).toBeDefined();
    expect(rotor.parent).toBe(ship);
    expect(ship.glue.has(2, by, 0, PZ)).toBe(true); // stays on the bearing while the hub spins
    sim.advance(20);
    expect(rotor.angularSpeed).toBeGreaterThan(0);
    expect(ship.sails).toBe(9);
    expect(sim.soloPlayer.useOn(2, by, 1, PX, ship.id)).toBe(true);
    expect(rotor.removed).toBe(true);
    let canvas = 0;
    ship.grid.forEachCell((_x, _y, _z, c) => {
      if ((c & 1023) === B.CANVAS) canvas++;
    });
    expect(canvas).toBe(9);
    expect(ship.glue.has(2, by, 0, PZ)).toBe(true); // ACCEPTANCE 14: it holds the hub again when it stops
  });
});
