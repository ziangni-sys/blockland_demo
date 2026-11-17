// Scratch exploration (reviewer): run review scenarios against a patched scratch copy. Will be removed.
import { describe, it } from 'vitest';
import { NZ, PX, PY } from '../../src/core/dirs';
import { B } from '../../src/blocks/defs';
import { qfromAxisAngle, vec3 } from '../../src/core/math';
import { createShipDynamics } from '/tmp/claude-0/-home-user-blockland-demo/3986d2ae-4bb4-5b33-be34-1aa75d1d707c/scratchpad/shipphys/physcopy/index';
import { FakeHost, fillWorld, hullSamplePoints, launch, makeSea, newRotor, plankBoat, terrainPenetration, tick } from './helpers';

function graze(bias: number): number {
  (globalThis as any).__SWEEP_BIAS = bias;
  const world = makeSea();
  const host = new FakeHost(world);
  const dyn = createShipDynamics(host);
  const cells: Array<[number, number, number]> = [[0, 50, 3]];
  for (let z = 4; z <= 10; z++) for (let y = 49; y <= 51; y++) cells.push([0, y, z]);
  const rotor = newRotor(world, 100, 0, 50, 3, PX, cells);
  const boat = launch(plankBoat(world, 1, 1, 47, -1, 4, 9, NZ), dyn);
  for (let t = 0; t < 60; t++) tick(dyn, [boat], [rotor], 0);
  boat.grid.linearVelocity.x = -0.3;
  let maxT = 0;
  for (let t = 0; t < 120; t++) {
    tick(dyn, [boat], [rotor], 1);
    const v = boat.grid.linearVelocity;
    maxT = Math.max(maxT, Math.hypot(v.y, v.z));
  }
  return maxT;
}

function slide(useNormal: boolean | 'vo', startDeg: number): string {
  (globalThis as any).__SWEEP_BIAS = 0.35;
  (globalThis as any).__PIN_USE_NORMAL = useNormal;
  const world = makeSea();
  fillWorld(world, -9, 36, -40, -7, 52, 40, B.STONE);
  const host = new FakeHost(world);
  const dyn = createShipDynamics(host);
  const boat = launch(plankBoat(world, 1, -6, 46, -6, 3, 3), dyn);
  const n0 = boat.grid.count;
  const cells: Array<[number, number, number]> = [[0, 47, 0]];
  for (let x = 1; x <= 8; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, 0]);
  const r = newRotor(world, 100, 0, 47, 0, PY, cells);
  r.angle = (startDeg * Math.PI) / 180;
  qfromAxisAngle(vec3(0, 1, 0), r.angle, r.grid.rotation);
  r.grid.snapshotPose();
  let pen = 0;
  for (let t = 0; t < 80; t++) {
    tick(dyn, [boat], [r], 1);
    pen = Math.max(pen, terrainPenetration(world, boat, hullSamplePoints(boat)));
  }
  (globalThis as any).__PIN_USE_NORMAL = false;
  return `destroyed=${n0 - boat.grid.count} pen=${pen.toFixed(3)}`;
}

function corner(useNormal: boolean | 'vo', speed: number): string {
  (globalThis as any).__SWEEP_BIAS = 0.35;
  (globalThis as any).__PIN_USE_NORMAL = useNormal;
  const world = makeSea();
  fillWorld(world, -6, 36, -14, -4, 52, 0, B.STONE);
  fillWorld(world, -6, 36, -3, -1, 52, -2, B.STONE);
  const host = new FakeHost(world);
  const dyn = createShipDynamics(host);
  const boat = launch(plankBoat(world, 1, -3, 46, -6, 3, 3), dyn);
  const n0 = boat.grid.count;
  const cells: Array<[number, number, number]> = [[0, 47, 0]];
  for (let x = 1; x <= 7; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, 0]);
  const r = newRotor(world, 100, 0, 47, 0, PY, cells);
  r.angle = (80 * Math.PI) / 180;
  qfromAxisAngle(vec3(0, 1, 0), r.angle, r.grid.rotation);
  r.grid.snapshotPose();
  const ticks = Math.ceil(((80 * Math.PI) / 180 / speed) * 20) + 20;
  let pen = 0;
  for (let t = 0; t < ticks; t++) {
    tick(dyn, [boat], [r], speed);
    pen = Math.max(pen, terrainPenetration(world, boat, hullSamplePoints(boat)));
  }
  (globalThis as any).__PIN_USE_NORMAL = false;
  return `destroyed=${n0 - boat.grid.count} pen=${pen.toFixed(3)}`;
}

describe('explore11 (patched copy)', () => {
  it('graze with and without sweep bias', () => {
    console.log(`graze bias=0.35 maxT=${graze(0.35).toFixed(2)}  bias=0 maxT=${graze(0).toFixed(2)}`);
  });
  it('slide with relative-velocity vs contact-normal condition (2)', () => {
    for (const s of [110, 120, 130]) console.log(`slide start=${s}: rel-dir ${slide(false, s)} | normal ${slide(true, s)} | blade-vel ${slide('vo', s)}`);
    for (const sp of [1, 0.1]) console.log(`corner speed=${sp}: rel-dir ${corner(false, sp)} | normal ${corner(true, sp)} | blade-vel ${corner('vo', sp)}`);
  });
});
