// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import type { Ship } from '../../src/structures/structure';
import { fillWorld, finite, launch, makeSea, makeWorld, newRotor, newShip, plankBoat, run, setup, shipBox, tick } from './helpers';

function snap(s: Ship): string {
  const g = s.grid;
  return JSON.stringify([g.position, g.rotation, g.linearVelocity, g.angularVelocity]);
}

describe('explore3', () => {
  it('sleeper resting on a carrier whose support cells are mined', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 40, waterTop: 0 });
    const { dyn } = setup(world);
    const carrier = newShip(world, 1);
    shipBox(carrier, -4, 40, -4, 3, 40, 3, B.PLANKS_OAK);
    shipBox(carrier, -1, 41, -1, 0, 41, 0, B.PLANKS_OAK); // platform
    launch(carrier, dyn);
    const crate = newShip(world, 2);
    shipBox(crate, -1, 42, -1, 0, 42, 0, B.PLANKS_OAK);
    launch(crate, dyn);
    run(dyn, [carrier, crate], 120);
    console.log(`asleep carrier=${carrier.asleep} crate=${crate.asleep} crateY=${crate.grid.position.y.toFixed(3)}`);
    for (let x = -1; x <= 0; x++) for (let z = -1; z <= 0; z++) carrier.grid.setCell(x, 41, z, 0);
    dyn.refresh(carrier); // what the manager does every tick
    const y0 = crate.grid.position.y;
    run(dyn, [carrier, crate], 100);
    console.log(`after mining: carrier asleep=${carrier.asleep} crate asleep=${crate.asleep} crate dy=${(crate.grid.position.y - y0).toFixed(3)} stats=${JSON.stringify(dyn.getStats(crate))}`);
  });

  it('order independence for two far-apart ships', () => {
    const mk = () => {
      const world = makeSea();
      const { dyn } = setup(world);
      const a = launch(plankBoat(world, 1, -30, 47, -30, 4, 6, NZ), dyn);
      const b = launch(plankBoat(world, 2, 20, 47, 20, 4, 6, NZ), dyn);
      a.throttle = 1;
      b.rudder = 1;
      return { dyn, a, b };
    };
    const r1 = mk();
    const r2 = mk();
    for (let t = 0; t < 100; t++) {
      for (const s of [r1.a, r1.b]) s.grid.snapshotPose();
      r1.dyn.step([r1.a, r1.b], []);
      for (const s of [r2.a, r2.b]) s.grid.snapshotPose();
      r2.dyn.step([r2.b, r2.a], []);
    }
    console.log(`order independence a: ${snap(r1.a) === snap(r2.a)} b: ${snap(r1.b) === snap(r2.b)}`);
  });

  it('soft-only remains hover', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, 0, 50, 0, 2, 50, 2, B.PLANKS_OAK);
    s.grid.setCell(1, 51, 1, makeCell(60)); // torch on the deck
    launch(s, dyn);
    run(dyn, [s], 5);
    for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) s.grid.setCell(x, 50, z, 0);
    dyn.refresh(s);
    const y0 = s.grid.position.y;
    run(dyn, [s], 100);
    console.log(`torch-only ship count=${s.grid.count} mass=${s.mass} dy=${(s.grid.position.y - y0).toFixed(3)} simulated=${dyn.getStats(s)!.simulated} vy=${s.grid.linearVelocity.y}`);
  });

  it('boat moored near a spinning windmill: sleep fraction', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 47, 6, 4, 4, NZ), dyn); // z in [6,10)
    const cells: Array<[number, number, number]> = [[0, 50, 0]];
    for (let x = 1; x <= 5; x++) for (let y = 49; y <= 52; y++) cells.push([x, y, 0]);
    const r = newRotor(world, 100, 0, 50, 0, PY, cells);
    let asleep = 0;
    let simulated = 0;
    let contacts = 0;
    for (let t = 0; t < 400; t++) {
      tick(dyn, [boat], [r], 1);
      if (t >= 200) {
        if (boat.asleep) asleep++;
        if (dyn.getStats(boat)!.simulated) simulated++;
        contacts += dyn.getStats(boat)!.rotorContacts;
      }
    }
    console.log(`near windmill: asleep ${asleep}/200 simulated ${simulated}/200 contacts=${contacts}`);
  });

  it('ship falls from height onto a 1-thick slab with air below', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 10, waterTop: 0 });
    fillWorld(world, -10, 60, -10, 10, 60, 10, B.STONE); // slab at y=60
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -2, 120, -2, 2, 121, 2, B.STONE);
    launch(s, dyn);
    let minY = Infinity;
    let maxV = 0;
    run(dyn, [s], 200, () => {
      minY = Math.min(minY, s.grid.position.y);
      maxV = Math.max(maxV, Math.abs(s.grid.linearVelocity.y));
    });
    console.log(`slab fall: final y=${s.grid.position.y.toFixed(3)} minY=${minY.toFixed(3)} maxV=${maxV.toFixed(2)} asleep=${s.asleep} finite=${finite(s)}`);
  });

  it('extreme coordinates', () => {
    const X = 3_000_000;
    const cx = X >> 4;
    const world = makeWorld({ cx0: cx - 2, cx1: cx + 2, cz0: cx - 2, cz1: cx + 2 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, X, 47, X, 4, 6, NZ), dyn);
    run(dyn, [boat], 200);
    const world2 = makeSea();
    const d2 = setup(world2).dyn;
    const boat2 = launch(plankBoat(world2, 1, 0, 47, 0, 4, 6, NZ), d2);
    run(d2, [boat2], 200);
    console.log(`far y=${boat.grid.position.y.toFixed(5)} near y=${boat2.grid.position.y.toFixed(5)} asleep far=${boat.asleep} near=${boat2.asleep}`);
  });
});

void vec3;
