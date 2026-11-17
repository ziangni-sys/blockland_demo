// Scratch exploration (reviewer): performance scenarios not covered by perf.test.ts. Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import { bigShip, fillWorld, launch, makeWorld, newRotor, setup, spinRotor, rotateShip } from './helpers';

function timeTicks(dyn: { step(s: readonly Ship[], r: readonly Rotor[]): void; getStats(s: Ship): { simulated: boolean } | null }, ships: Ship[], rotors: Rotor[], warm: number, n: number): number {
  const once = () => {
    for (const s of ships) s.grid.snapshotPose();
    for (const r of rotors) spinRotor(r, 1);
    dyn.step(ships, rotors);
  };
  for (let t = 0; t < warm; t++) once();
  const times: number[] = [];
  for (let t = 0; t < n; t++) {
    const t0 = performance.now();
    once();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times.reduce((a, b) => a + b, 0) / times.length;
}

describe('explore perf', () => {
  it('4000-cell ship moored beside a spinning windmill (rotor in reach, not touching)', () => {
    const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
    const { dyn } = setup(world);
    const s = launch(bigShip(world, 1, 50, 16, 8, 4000, 46, 0), dyn); // x in [-8,8), z in [0,50)
    // vertical-axis windmill whose hub is 12 blocks east of the hull, 7-long blades
    const hx = 16;
    const hz = 25;
    const cells: Array<[number, number, number]> = [[hx, 50, hz]];
    for (let x = hx + 1; x <= hx + 7; x++) for (let y = 49; y <= 52; y++) cells.push([x, y, hz]);
    for (let x = hx - 7; x <= hx - 1; x++) for (let y = 49; y <= 52; y++) cells.push([x, y, hz]);
    const r = newRotor(world, 100, hx, 50, hz, PY, cells);
    s.rudder = 0.01;
    const avgR = timeTicks(dyn, [s], [r], 80, 150);
    const st = dyn.getStats(s)!;
    console.log(`[review perf] 4000 + windmill: ${avgR.toFixed(3)} ms/tick simulated=${st.simulated} rotorContacts=${st.rotorContacts}`);
    const world2 = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
    const d2 = setup(world2).dyn;
    const s2 = launch(bigShip(world2, 1, 50, 16, 8, 4000, 46, 0), d2);
    s2.rudder = 0.01;
    const avg0 = timeTicks(d2, [s2], [], 80, 150);
    console.log(`[review perf] 4000 alone (same frames, may sleep): ${avg0.toFixed(3)} ms/tick simulated=${d2.getStats(s2)!.simulated}`);
  });

  it('two 4000-cell ships moored side by side (ship-ship broadphase)', () => {
    const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3 });
    const { dyn } = setup(world);
    const a = launch(bigShip(world, 1, 50, 16, 8, 4000, 46, 0), dyn); // x in [-8,8)
    const b = launch(bigShip(world, 2, 50, 16, 8, 4000, 46, 0), dyn);
    // move b 18 blocks east (2-block gap)
    b.grid.position.x += 18;
    b.grid.snapshotPose();
    a.rudder = 0.2; // keep them awake
    b.rudder = -0.2;
    const avg = timeTicks(dyn, [a, b], [], 40, 100);
    console.log(`[review perf] two 4000 ships side by side: ${avg.toFixed(3)} ms/tick shipContacts=${dyn.getStats(a)!.shipContacts}`);
  });

  it('4000-cell ship yawed 45 degrees near a shore', () => {
    const world = makeWorld({ cx0: -6, cx1: 5, cz0: -6, cz1: 5 });
    fillWorld(world, -90, 36, -60, 90, 50, -58, B.STONE);
    const { dyn } = setup(world);
    const s = launch(bigShip(world, 1, 50, 16, 8, 4000, 46, -10), dyn);
    rotateShip(s, vec3(0, 1, 0), Math.PI / 4);
    s.throttle = 1;
    s.sails = 40;
    const avg = timeTicks(dyn, [s], [], 40, 150);
    console.log(`[review perf] 4000 yawed 45: ${avg.toFixed(3)} ms/tick ter=${dyn.getStats(s)!.terrainContacts}`);
  });

  it('4000-cell ship landing on flat ground (contact heavy)', () => {
    const world = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3, floorTop: 40, waterTop: 0 });
    const { dyn } = setup(world);
    const s = launch(bigShip(world, 1, 50, 16, 8, 4000, 42, 0), dyn);
    const times: number[] = [];
    for (let t = 0; t < 120; t++) {
      s.grid.snapshotPose();
      const t0 = performance.now();
      dyn.step([s], []);
      const dt = performance.now() - t0;
      if (t > 10 && dyn.getStats(s)!.simulated) times.push(dt);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`[review perf] 4000 landing: ${avg.toFixed(3)} ms/tick over ${times.length} max=${Math.max(...times).toFixed(2)}`);
    const world1 = makeWorld({ cx0: -4, cx1: 3, cz0: -6, cz1: 3, floorTop: 40, waterTop: 0 });
    const d1 = setup(world1).dyn;
    const s1 = launch(bigShip(world1, 1, 30, 10, 6, 1000, 42, 0), d1);
    const t1: number[] = [];
    for (let t = 0; t < 120; t++) {
      s1.grid.snapshotPose();
      const t0 = performance.now();
      d1.step([s1], []);
      const dt = performance.now() - t0;
      if (t > 10 && d1.getStats(s1)!.simulated) t1.push(dt);
    }
    console.log(`[review perf] 1000 landing: ${(t1.reduce((a, b) => a + b, 0) / t1.length).toFixed(3)} ms/tick over ${t1.length}`);
  });
});

void qfromAxisAngle;
