// Scratch exploration (reviewer). Will be removed.
import { describe, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { fillWorld, finite, launch, makeSea, plankBoat, run, setup, terrainPenetration, hullSamplePoints } from './helpers';

describe('explore6', () => {
  it('boat assembled flush against a pier', () => {
    const world = makeSea();
    fillWorld(world, -6, 36, -10, -4, 50, 10, B.COBBLE); // pier x in [-6,-4], face x = -3
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -3, 47, -4, 4, 8, NZ), dyn); // hull x from -3 flush
    const p0 = { ...boat.grid.position };
    let maxV = 0;
    let asleepAt = -1;
    let pen = 0;
    run(dyn, [boat], 400, (t) => {
      const v = boat.grid.linearVelocity;
      maxV = Math.max(maxV, Math.hypot(v.x, v.z));
      if (boat.asleep && asleepAt < 0) asleepAt = t;
      pen = Math.max(pen, terrainPenetration(world, boat, hullSamplePoints(boat)));
    });
    console.log(`flush pier: dx=${(boat.grid.position.x - p0.x).toFixed(4)} dz=${(boat.grid.position.z - p0.z).toFixed(4)} y=${boat.grid.position.y.toFixed(3)} maxHorizV=${maxV.toFixed(3)} asleepAt=${asleepAt} pen=${pen.toFixed(3)} finite=${finite(boat)}`);
  });

  it('boat resting half on an underwater ledge (aground)', () => {
    const world = makeSea();
    fillWorld(world, -10, 36, -10, 0, 46, 10, B.STONE); // ledge top y=47, x <= 0
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 47, -4, 4, 8, NZ), dyn); // x in [-2,2): half on the ledge
    let asleepAt = -1;
    const ys: number[] = [];
    run(dyn, [boat], 600, (t) => {
      if (boat.asleep && asleepAt < 0) asleepAt = t;
      if (t >= 500) ys.push(boat.grid.position.x, boat.grid.position.y, boat.grid.position.z);
    });
    const drift = Math.max(...ys) - Math.min(...ys);
    console.log(`half aground: asleepAt=${asleepAt} asleep=${boat.asleep} pos=(${boat.grid.position.x.toFixed(3)},${boat.grid.position.y.toFixed(3)}) drift-range=${drift}`);
  });
});
