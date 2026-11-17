import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY, PZ } from '../../src/core/dirs';
import { qfromAxisAngle, qtoMat3, vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import { Chunk } from '../../src/voxel/chunk';
import {
  fillWorld,
  hullSamplePoints,
  launch,
  makeSea,
  makeWorld,
  newRotor,
  newShip,
  plankBoat,
  pointsIntoHull,
  run,
  setup,
  shipBox,
  tick,
} from './helpers';

function settledBoat() {
  const world = makeSea();
  const { dyn, host } = setup(world);
  const boat = launch(plankBoat(world, 1, -2, 47, -4, 5, 9, NZ), dyn);
  run(dyn, [boat], 200);
  return { world, dyn, host, boat };
}

describe('freezing near unloaded chunks (LESSONS 船被弹飞)', () => {
  it('ship.frozen: not simulated at all, state kept for later', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 49, -4, 5, 9, NZ), dyn); // in the air
    boat.frozen = true;
    boat.grid.linearVelocity.x = 2;
    const p = { ...boat.grid.position };
    run(dyn, [boat], 40);
    expect(boat.grid.position).toEqual(p);
    expect(boat.grid.linearVelocity.x).toBe(2);
    expect(dyn.getStats(boat)!.frozen).toBe(true);
    boat.frozen = false;
    run(dyn, [boat], 5);
    expect(boat.grid.position.y).toBeLessThan(p.y);
    expect(boat.grid.position.x).toBeGreaterThan(p.x);
  });

  it('a ship next to unloaded columns is not simulated (safety net), until they load', () => {
    // loaded: chunks cx -1..0, cz -1..0 -> x, z in [-16, 15]; x = 16.. is unloaded
    const world = makeWorld({ cx0: -1, cx1: 0, cz0: -1, cz1: 0 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, 9, 49, -4, 5, 9, NZ), dyn); // x in [9,13]: 2 blocks from x = 16
    const p = { ...boat.grid.position };
    run(dyn, [boat], 20);
    expect(boat.grid.position).toEqual(p);
    expect(dyn.getStats(boat)!.frozen).toBe(true);
    expect(dyn.getStats(boat)!.simulated).toBe(false);
    for (let cz = -1; cz <= 0; cz++) {
      const ch = new Chunk(1, cz);
      for (let y = 0; y < 48; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) ch.set(x, y, z, makeCell(y < 36 ? B.STONE : B.WATER));
      world.addChunk(ch);
    }
    run(dyn, [boat], 5);
    expect(dyn.getStats(boat)!.simulated).toBe(true);
    expect(boat.grid.position.y).toBeLessThan(p.y);
  });

  it('a frozen ship is an immovable obstacle for an awake one', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -2, 46, 10, 5, 9, NZ), dyn);
    const b = launch(plankBoat(world, 2, -2, 46, -10, 5, 9, NZ), dyn);
    run(dyn, [a, b], 60);
    b.frozen = true;
    const pb = { ...b.grid.position };
    a.sails = 40;
    a.throttle = 1;
    const pts = hullSamplePoints(a);
    let worst = 0;
    run(dyn, [a, b], 200, () => {
      worst = Math.max(worst, pointsIntoHull(b, pts.map((p) => a.grid.toWorld(p))));
    });
    expect(b.grid.position).toEqual(pb);
    expect(worst).toBeLessThan(0.15);
    expect(a.grid.position.z).toBeGreaterThan(b.grid.position.z + 8);
  });
});

describe('sleep and wake', () => {
  it('a floating boat falls asleep and stays exactly put', () => {
    const { dyn, boat } = settledBoat();
    expect(boat.asleep).toBe(true);
    expect(boat.restTicks).toBeGreaterThanOrEqual(40);
    expect(boat.grid.linearVelocity).toEqual({ x: 0, y: 0, z: 0 });
    const p = { ...boat.grid.position };
    run(dyn, [boat], 100);
    expect(boat.grid.position).toEqual(p);
    expect(dyn.getStats(boat)!.simulated).toBe(false);
  });

  it('wake() wakes it; it falls asleep again when nothing happens', () => {
    const { dyn, boat } = settledBoat();
    dyn.wake(boat);
    expect(boat.asleep).toBe(false);
    expect(boat.restTicks).toBe(0);
    tick(dyn, [boat]);
    expect(dyn.getStats(boat)!.simulated).toBe(true);
    run(dyn, [boat], 60);
    expect(boat.asleep).toBe(true);
  });

  it('throttle or rudder wakes a sleeping ship', () => {
    const { dyn, boat } = settledBoat();
    boat.throttle = 0.5;
    run(dyn, [boat], 20);
    expect(boat.asleep).toBe(false);
    expect(boat.grid.linearVelocity.z).toBeLessThan(-0.1);
    const s2 = settledBoat();
    s2.boat.rudder = -1;
    run(s2.dyn, [s2.boat], 20);
    expect(s2.boat.asleep).toBe(false);
    expect(s2.boat.grid.angularVelocity.y).toBeGreaterThan(0.05);
  });

  it('a cell change (grid.version) wakes it', () => {
    const { dyn, boat } = settledBoat();
    const v = boat.grid.version;
    boat.grid.setCell(-2, 49, -4, makeCell(B.PLANKS_OAK)); // a new cell on the rim
    expect(boat.grid.version).not.toBe(v);
    tick(dyn, [boat]);
    expect(dyn.getStats(boat)!.simulated).toBe(true);
  });

  it('being moved by game code (teleport) wakes it', () => {
    const { dyn, boat } = settledBoat();
    const p = { ...boat.grid.position };
    boat.grid.setPoseImmediate(vec3(p.x, p.y + 2, p.z), boat.grid.rotation);
    tick(dyn, [boat]);
    expect(dyn.getStats(boat)!.simulated).toBe(true);
    expect(boat.grid.position.y).toBeLessThan(p.y + 2);
  });

  it('a moving rotor in reach wakes it, a far one does not', () => {
    const { world, dyn, boat } = settledBoat();
    const far: Rotor = newRotor(world, 90, 30, 47, 30, PY, [[30, 47, 30], [31, 47, 30], [32, 47, 30]]);
    run(dyn, [boat], 10);
    for (let t = 0; t < 10; t++) tick(dyn, [boat], [far], 1);
    expect(boat.asleep).toBe(true);
    const near: Rotor = newRotor(world, 91, 7, 47, 0, PY, [[7, 47, 0], [6, 47, 0], [5, 47, 0], [4, 47, 0]]);
    tick(dyn, [boat], [far, near], 1);
    expect(boat.asleep).toBe(false);
  });

  it('an awake ship approaching wakes a sleeping one', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -2, 47, 12, 5, 9, NZ), dyn);
    const b = launch(plankBoat(world, 2, -2, 47, -6, 5, 9, NZ), dyn);
    run(dyn, [a, b], 200);
    expect(a.asleep && b.asleep).toBe(true);
    a.throttle = 1;
    let bWoke = false;
    run(dyn, [a, b], 200, () => {
      if (!b.asleep) bWoke = true;
    });
    expect(bWoke).toBe(true);
    expect(b.grid.position.z).toBeLessThan(-1); // pushed north by a
  });
});

describe('sleep islands: ships resting against each other', () => {
  it('two boats moored side by side, touching, both fall asleep and stay put', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -5, 47, -4, 5, 9, NZ), dyn); // x in [-5, 0)
    const b = launch(plankBoat(world, 2, 0, 47, -4, 5, 9, NZ), dyn); // x in [0, 5): touching
    run(dyn, [a, b], 400);
    expect(a.asleep).toBe(true);
    expect(b.asleep).toBe(true);
    const pa = { ...a.grid.position };
    const pb = { ...b.grid.position };
    run(dyn, [a, b], 600);
    expect(a.asleep && b.asleep).toBe(true);
    expect(a.grid.position).toEqual(pa);
    expect(b.grid.position).toEqual(pb);
  });

  it("a raft resting in another boat's hold: both sleep", () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -3, 46, -5, 7, 11, NZ), dyn); // floor y=46, rim y=47
    const raft = newShip(world, 2);
    shipBox(raft, -1, 47, -2, 0, 47, -1, B.PLANKS_OAK); // on the floor, inside the rim
    launch(raft, dyn);
    let bothAt = -1;
    run(dyn, [boat, raft], 600, (t) => {
      if (bothAt < 0 && boat.asleep && raft.asleep) bothAt = t;
    });
    expect(bothAt).toBeGreaterThan(0);
    const pr = { ...raft.grid.position };
    run(dyn, [boat, raft], 200);
    expect(raft.grid.position).toEqual(pr);
    // the raft never sank into the floor
    const pts = hullSamplePoints(raft);
    expect(pointsIntoHull(boat, pts.map((p) => raft.grid.toWorld(p)))).toBeLessThan(0.05);
  });

  it('a quiet awake ship does not wake its sleeping neighbour; a moving one does', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -5, 47, -4, 5, 9, NZ), dyn);
    const b = launch(plankBoat(world, 2, 0, 47, -4, 5, 9, NZ), dyn);
    run(dyn, [a, b], 400);
    expect(a.asleep && b.asleep).toBe(true);
    dyn.wake(a);
    run(dyn, [a, b], 5);
    expect(b.asleep).toBe(true);
    expect(dyn.getStats(a)!.simulated).toBe(true);
    dyn.applyImpulse(a, { ...a.grid.position }, vec3(2 * a.mass, 0, 0)); // shove a into b
    run(dyn, [a, b], 3);
    expect(b.asleep).toBe(false);
  });
});

describe('applyImpulse', () => {
  it('through the centre of mass: pure translation, wakes the ship', () => {
    const { dyn, boat } = settledBoat();
    const m = boat.mass;
    dyn.applyImpulse(boat, { ...boat.grid.position }, vec3(0, 0, -2 * m)); // along the bow
    expect(boat.asleep).toBe(false);
    expect(boat.grid.linearVelocity.z).toBeCloseTo(-2, 12);
    expect(boat.grid.angularVelocity.y).toBeCloseTo(0, 12);
    tick(dyn, [boat]);
    expect(boat.grid.linearVelocity.z).toBeLessThan(-1.9); // only light forward drag
    expect(boat.grid.linearVelocity.z).toBeGreaterThan(-2);
  });

  it('off-centre: angular velocity = I_world^-1 (r x J)', () => {
    const { dyn, boat } = settledBoat();
    const q = qfromAxisAngle(vec3(0, 1, 0), 0.7);
    boat.grid.setPoseImmediate(boat.grid.position, q);
    const c = boat.grid.position;
    const r = vec3(0, 0.5, -3);
    const J = vec3(4, 0, 0);
    dyn.applyImpulse(boat, vec3(c.x + r.x, c.y + r.y, c.z + r.z), J);
    const tau = vec3(r.y * J.z - r.z * J.y, r.z * J.x - r.x * J.z, r.x * J.y - r.y * J.x);
    const R = qtoMat3(q);
    const Il = boat.invInertiaLocal;
    // I_w^-1 = R Il R^T
    const lt = [0, 1, 2].map((i) => R[i]! * tau.x + R[3 + i]! * tau.y + R[6 + i]! * tau.z);
    const ll = [0, 1, 2].map((i) => Il[i * 3]! * lt[0]! + Il[i * 3 + 1]! * lt[1]! + Il[i * 3 + 2]! * lt[2]!);
    const w = [0, 1, 2].map((i) => R[i * 3]! * ll[0]! + R[i * 3 + 1]! * ll[1]! + R[i * 3 + 2]! * ll[2]!);
    expect(boat.grid.angularVelocity.x).toBeCloseTo(w[0]!, 12);
    expect(boat.grid.angularVelocity.y).toBeCloseTo(w[1]!, 12);
    expect(boat.grid.angularVelocity.z).toBeCloseTo(w[2]!, 12);
    expect(boat.grid.linearVelocity.x).toBeCloseTo(4 / boat.mass, 12);
  });
});

describe('determinism', () => {
  function scenario(): Float64Array {
    const world = makeSea();
    fillWorld(world, -20, 36, -30, 20, 52, -29, B.STONE);
    const { dyn } = setup(world);
    const ships: Ship[] = [
      launch(plankBoat(world, 1, -2, 46, 0, 5, 9, NZ), dyn),
      launch(plankBoat(world, 2, 4, 46, -12, 5, 7, PZ), dyn),
    ];
    ships[0]!.sails = 30;
    ships[0]!.throttle = 1;
    ships[0]!.rudder = 0.3;
    ships[1]!.throttle = 0.6;
    const cells: Array<[number, number, number]> = [[-6, 47, -8]];
    for (let x = -5; x <= 0; x++) for (let y = 46; y <= 48; y++) cells.push([x, y, -8]);
    const rotor = newRotor(world, 50, -6, 47, -8, PY, cells);
    const out: number[] = [];
    for (let t = 0; t < 300; t++) {
      tick(dyn, ships, [rotor], 0.8);
      for (const s of ships) {
        const g = s.grid;
        out.push(g.position.x, g.position.y, g.position.z, g.rotation.x, g.rotation.y, g.rotation.z, g.rotation.w);
        out.push(g.linearVelocity.x, g.linearVelocity.y, g.linearVelocity.z, g.angularVelocity.x, g.angularVelocity.y, g.angularVelocity.z);
        out.push(g.count, g.pivot.x, g.pivot.y, g.pivot.z);
      }
    }
    return Float64Array.from(out);
  }

  it('two identical runs are bit-identical', () => {
    const a = scenario();
    const b = scenario();
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });
});
