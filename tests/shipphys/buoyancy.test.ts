import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { vec3 } from '../../src/core/math';
import {
  FLOOR_TOP,
  SURFACE,
  finite,
  launch,
  makeSea,
  newShip,
  rotateShip,
  run,
  setup,
  shipBox,
  terrainPenetration,
  tilt,
  worldOf,
} from './helpers';

describe('buoyancy: Archimedes', () => {
  it('a plank raft floats at the predicted draught', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    shipBox(raft, -2, 47, -3, 2, 47, 3, B.PLANKS_OAK); // 35 planks, density 0.5
    launch(raft, dyn);
    expect(raft.mass).toBeCloseTo(17.5);
    run(dyn, [raft], 200); // 10 s
    const draught = SURFACE - worldOf(raft, -2, 47, -3).y;
    expect(draught).toBeGreaterThan(0.5 * 0.97);
    expect(draught).toBeLessThan(0.5 * 1.03);
    expect(tilt(raft)).toBeLessThan(0.01);
    expect(finite(raft)).toBe(true);
  });

  it('a hollow stone boat floats at the predicted draught', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = newShip(world, 1);
    // 16 x 16 open boat, walls 8 high: 676 stone cells (density 2.6) around a dry hold
    shipBox(boat, -8, 41, -8, 7, 48, 7, B.STONE, true);
    launch(boat, dyn);
    const hull = boat.hull!;
    expect(hull.floats).toBe(true);
    const expected = boat.mass / 256; // every 16x16 layer displaces 256 cells
    expect(expected).toBeGreaterThan(6.5);
    expect(expected).toBeLessThan(7.5);
    run(dyn, [boat], 300);
    const draught = SURFACE - worldOf(boat, -8, 41, -8).y;
    expect(Math.abs(draught - expected) / expected).toBeLessThan(0.03);
    expect(tilt(boat)).toBeLessThan(0.01);
  });

  it('a sealed cavity displaces water: a closed glass box floats on its air pocket', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const box = newShip(world, 1);
    shipBox(box, -1, 45, -1, 1, 47, 1, B.GLASS); // 3x3x3 glass (density 0.9) ...
    box.grid.setCell(0, 46, 0, 0); // ... around one sealed air cell
    launch(box, dyn);
    expect(box.hull!.sealedCount).toBe(1);
    expect(box.hull!.floats).toBe(true); // 23.4 < 27
    run(dyn, [box], 300);
    const draught = SURFACE - worldOf(box, -1, 45, -1).y;
    const expected = box.mass / 9; // 9 displacing cells per layer
    expect(Math.abs(draught - expected) / expected).toBeLessThan(0.03);
    expect(tilt(box)).toBeLessThan(0.02);
  });

  it('a solid stone raft sinks to the bottom, rests and falls asleep', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    shipBox(raft, -2, 46, -2, 2, 46, 2, B.STONE);
    launch(raft, dyn);
    expect(raft.hull!.floats).toBe(false);
    let sleptAt = -1;
    run(dyn, [raft], 600, (t) => {
      if (raft.asleep && sleptAt < 0) sleptAt = t;
    });
    const bottom = worldOf(raft, -2, 46, -2).y;
    expect(Math.abs(bottom - FLOOR_TOP)).toBeLessThan(0.03);
    expect(terrainPenetration(world, raft)).toBeLessThan(0.03);
    expect(raft.asleep).toBe(true);
    expect(sleptAt).toBeGreaterThan(0);
  });
});

describe('buoyancy: stability', () => {
  it('a raft heeled by 20 degrees rights itself', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    shipBox(raft, -2, 47, -3, 2, 47, 3, B.PLANKS_OAK);
    launch(raft, dyn);
    run(dyn, [raft], 100);
    rotateShip(raft, vec3(0, 0, 1), (20 * Math.PI) / 180);
    dyn.wake(raft);
    expect(tilt(raft)).toBeGreaterThan(0.34);
    const tilts: number[] = [];
    run(dyn, [raft], 200, () => tilts.push(tilt(raft)));
    expect(tilts[tilts.length - 1]!).toBeLessThan((1 * Math.PI) / 180);
    // it comes back without swinging far past upright
    expect(Math.max(...tilts.slice(10))).toBeLessThan((20 * Math.PI) / 180);
  });

  it('a boat heeled by 20 degrees rights itself', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = newShip(world, 1);
    shipBox(boat, -2, 46, -4, 2, 48, 4, B.PLANKS_OAK, true);
    launch(boat, dyn);
    run(dyn, [boat], 100);
    rotateShip(boat, vec3(0, 0, 1), (-20 * Math.PI) / 180);
    run(dyn, [boat], 200);
    expect(tilt(boat)).toBeLessThan((1 * Math.PI) / 180);
  });

  it('bobbing after a drop decays quickly', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    shipBox(raft, -2, 49, -3, 2, 49, 3, B.PLANKS_OAK); // dropped from 1.6 blocks above equilibrium
    launch(raft, dyn);
    const ys: number[] = [];
    run(dyn, [raft], 200, () => ys.push(raft.grid.position.y));
    const eq = ys[ys.length - 1]!;
    // count crossings of the equilibrium after the first impact: a few at most
    let crossings = 0;
    for (let i = 1; i < ys.length; i++) {
      if (Math.sign(ys[i]! - eq - 0.005) !== Math.sign(ys[i - 1]! - eq - 0.005)) crossings++;
    }
    expect(crossings).toBeLessThanOrEqual(5);
    // settled within 4 s
    for (let i = 80; i < ys.length; i++) expect(Math.abs(ys[i]! - eq)).toBeLessThan(0.02);
    expect(Math.abs(raft.grid.linearVelocity.y)).toBeLessThan(0.01);
  });
});
