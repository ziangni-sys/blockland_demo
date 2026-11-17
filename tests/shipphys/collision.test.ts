import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { Ship } from '../../src/structures/structure';
import {
  columnSurface,
  fillWorld,
  mechanicalEnergy,
  finite,
  hullExtent,
  hullSamplePoints,
  kineticEnergy,
  launch,
  makeWorld,
  newShip,
  plankBoat,
  pointsIntoHull,
  run,
  setup,
  shipBox,
  speed,
  terrainPenetration,
  tick,
  worldOf,
} from './helpers';

/** Open water x in [-48,47], z in [-112,47]. */
function channel() {
  return makeWorld({ cx0: -3, cx1: 2, cz0: -7, cz1: 2 });
}

type Obstacle = 'thick' | 'thin' | 'post' | 'beach';
const WALL_Z = -40; // southmost obstacle cells; their south face is at z = -39

function build(world: ReturnType<typeof channel>, kind: Obstacle): Vec3[] {
  const corners: Vec3[] = [];
  if (kind === 'thick') fillWorld(world, -12, 36, WALL_Z - 3, 12, 52, WALL_Z, B.STONE);
  if (kind === 'thin') fillWorld(world, -12, 36, WALL_Z, 12, 52, WALL_Z, B.STONE);
  if (kind === 'post') {
    fillWorld(world, 0, 36, WALL_Z, 0, 52, WALL_Z, B.STONE);
    for (let y = 36; y <= 53; y++) for (const [x, z] of [[0, WALL_Z], [1, WALL_Z], [0, WALL_Z + 1], [1, WALL_Z + 1]] as const) corners.push(vec3(x, y, z));
    for (let y = 36; y < 53; y++) corners.push(vec3(0.5, y + 0.5, WALL_Z + 1), vec3(0, y + 0.5, WALL_Z + 0.5), vec3(1, y + 0.5, WALL_Z + 0.5));
  }
  if (kind === 'beach') {
    // rises one block every two blocks northward, from y=46 (under the keel) to dry land
    for (let k = 0; k < 16; k++) {
      const top = 46 + Math.floor(k / 2);
      fillWorld(world, -12, 36, WALL_Z - k, 12, top, WALL_Z - k, B.SAND);
    }
  }
  return corners;
}

interface Run {
  boat: Ship;
  impactTick: number;
  maxPen: number;
  maxPostPen: number;
  minBowZ: number;
  /** Kinetic and mechanical energy every tick from the impact on. */
  kinetic: number[];
  mechanical: number[];
  speedAtImpact: number;
  allFinite: boolean;
}

/** Drive a boat at full speed (40 sails, 10.5 blocks/s) into the obstacle. */
function crash(kind: Obstacle, coast: boolean, ticks = 400): Run {
  const world = channel();
  const corners = build(world, kind);
  const surface = columnSurface(world);
  const { dyn } = setup(world);
  const boat = launch(plankBoat(world, 1, -2, 46, 30, 5, 9, NZ), dyn);
  boat.sails = 40;
  boat.throttle = 1;
  const pts = hullSamplePoints(boat);
  const r: Run = {
    boat,
    impactTick: -1,
    maxPen: 0,
    maxPostPen: 0,
    minBowZ: Infinity,
    kinetic: [],
    mechanical: [],
    speedAtImpact: 0,
    allFinite: true,
  };
  for (let t = 0; t < ticks; t++) {
    const before = speed(boat);
    const kBefore = kineticEnergy(boat);
    tick(dyn, [boat]);
    const st = dyn.getStats(boat)!;
    if (r.impactTick < 0 && st.terrainContacts > 0) {
      r.impactTick = t;
      r.speedAtImpact = before;
      r.kinetic.push(kBefore);
      if (coast) boat.throttle = 0;
    }
    if (r.impactTick >= 0) {
      r.kinetic.push(kineticEnergy(boat));
      if (coast) r.mechanical.push(mechanicalEnergy(boat, surface));
    }
    r.maxPen = Math.max(r.maxPen, terrainPenetration(world, boat, pts));
    if (corners.length > 0) r.maxPostPen = Math.max(r.maxPostPen, pointsIntoHull(boat, corners));
    r.minBowZ = Math.min(r.minBowZ, hullExtent(boat, pts).minZ);
    r.allFinite &&= finite(boat);
  }
  return r;
}

describe('collision: full speed into obstacles', () => {
  for (const kind of ['thick', 'thin', 'post', 'beach'] as const) {
    it(`${kind}: stops without tunnelling, bounded penetration, no energy gain`, () => {
      const r = crash(kind, true);
      expect(r.allFinite).toBe(true);
      expect(r.impactTick).toBeGreaterThan(0);
      if (kind !== 'beach') expect(r.speedAtImpact).toBeGreaterThan(10);
      expect(r.maxPen).toBeLessThan(0.1);
      expect(r.maxPostPen).toBeLessThan(0.1);
      if (kind === 'thick' || kind === 'thin') expect(r.minBowZ).toBeGreaterThan(WALL_Z + 1 - 0.1);
      if (kind === 'post') expect(r.minBowZ).toBeGreaterThan(WALL_Z + 1 - 0.1 - 9); // still south of the far side
      // The impact removes almost all kinetic energy at once and nothing ever gives it back:
      // kinetic energy stays below its value just before the impact...
      const k0 = r.kinetic[0]!;
      expect(r.kinetic[1]!).toBeLessThan(0.05 * k0);
      for (const e of r.kinetic) expect(e).toBeLessThanOrEqual(k0);
      // ...and the mechanical energy (kinetic + gravity + buoyancy potential) never increases.
      // (Kinetic energy alone may: the hull bobs, trading buoyancy potential for motion.)
      const m = r.mechanical;
      for (let i = 1; i < m.length; i++) expect(m[i]!).toBeLessThanOrEqual(m[i - 1]! + 1e-9 * Math.abs(m[i - 1]!));
      expect(r.kinetic[r.kinetic.length - 1]!).toBeLessThan(0.001 * k0);
    });
  }

  it('the penetration probes used here do see an overlap', () => {
    const world = channel();
    const corners = build(world, 'post');
    build(world, 'thin');
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, WALL_Z + 1, 5, 9, NZ), dyn); // bow touching the wall
    boat.grid.position.z -= 0.25; // ... and now 0.25 into it
    expect(terrainPenetration(world, boat)).toBeGreaterThan(0.2);
    expect(pointsIntoHull(boat, corners)).toBeGreaterThan(0.2);
  });

  it('thin wall with the throttle held open: pressed against it, never through', () => {
    const r = crash('thin', false, 500);
    expect(r.allFinite).toBe(true);
    expect(r.maxPen).toBeLessThan(0.1);
    expect(r.minBowZ).toBeGreaterThan(WALL_Z + 1 - 0.1);
    expect(speed(r.boat)).toBeLessThan(0.2);
  });

  it('a yawed boat sliding into a thin wall at 30 degrees glances off without crossing it', () => {
    const world = channel();
    build(world, 'thin');
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 46, -20, 5, 9, NZ), dyn);
    // heading north-north-west
    boat.grid.rotation.y = Math.sin(Math.PI / 12);
    boat.grid.rotation.w = Math.cos(Math.PI / 12);
    boat.grid.linearVelocity.z = -8;
    boat.grid.linearVelocity.x = -3;
    const pts = hullSamplePoints(boat);
    let maxPen = 0;
    let minZ = Infinity;
    for (let t = 0; t < 200; t++) {
      tick(dyn, [boat]);
      maxPen = Math.max(maxPen, terrainPenetration(world, boat, pts));
      minZ = Math.min(minZ, hullExtent(boat, pts).minZ);
      expect(finite(boat)).toBe(true);
    }
    expect(maxPen).toBeLessThan(0.1);
    expect(minZ).toBeGreaterThan(WALL_Z + 1 - 0.1);
  });
});

describe('collision: land', () => {
  it('dropped from 10 blocks onto land: settles, rests at the surface and sleeps', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 60, waterTop: 0 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 70, -4, 5, 9, NZ), dyn);
    const pts = hullSamplePoints(boat);
    let maxPen = 0;
    let sleptAt = -1;
    for (let t = 0; t < 300; t++) {
      tick(dyn, [boat]);
      maxPen = Math.max(maxPen, terrainPenetration(world, boat, pts));
      if (boat.asleep && sleptAt < 0) sleptAt = t;
      expect(finite(boat)).toBe(true);
    }
    expect(maxPen).toBeLessThan(0.1);
    expect(sleptAt).toBeGreaterThan(0);
    expect(sleptAt).toBeLessThan(200);
    expect(Math.abs(worldOf(boat, -2, 70, -4).y - 60)).toBeLessThan(0.03);
  });

  it('resting 600 ticks: zero drift', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 60, waterTop: 0 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 61, -4, 5, 9, NZ), dyn);
    run(dyn, [boat], 120);
    expect(boat.asleep).toBe(true);
    const p = { ...boat.grid.position };
    const q = { ...boat.grid.rotation };
    run(dyn, [boat], 600);
    expect(boat.grid.position).toEqual(p);
    expect(boat.grid.rotation).toEqual(q);
  });

  it('a floating ship at rest: zero drift once asleep', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1 });
    const { dyn } = setup(world);
    const boat = launch(plankBoat(world, 1, -2, 47, -4, 5, 9, NZ), dyn);
    run(dyn, [boat], 200);
    expect(boat.asleep).toBe(true);
    const p = { ...boat.grid.position };
    run(dyn, [boat], 600);
    expect(boat.grid.position).toEqual(p);
  });

  it('a ship on a ledge half over the edge tips over and falls, without snagging', () => {
    const world = makeWorld({ cx0: -2, cx1: 1, cz0: -2, cz1: 1, floorTop: 50, waterTop: 0 });
    fillWorld(world, -16, 50, -16, 0, 59, 15, B.STONE); // cliff top at y=60 for x <= 0
    const { dyn } = setup(world);
    const s = newShip(world, 1);
    shipBox(s, -1, 60, -2, 4, 60, 2, B.PLANKS_OAK); // 2 of 6 columns over the cliff
    launch(s, dyn);
    run(dyn, [s], 200);
    expect(s.grid.position.y).toBeLessThan(55);
    expect(terrainPenetration(world, s)).toBeLessThan(0.1);
    expect(finite(s)).toBe(true);
  });
});

describe('collision: ship against ship', () => {
  it('two boats driven head-on do not pass through each other', () => {
    const world = channel();
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -2, 46, 0, 5, 9, NZ), dyn); // heading north
    const b = launch(plankBoat(world, 2, -2, 46, -40, 5, 9, 4), dyn); // heading south
    a.sails = b.sails = 40;
    a.throttle = b.throttle = 1;
    const pa = hullSamplePoints(a);
    const pb = hullSamplePoints(b);
    let worst = 0;
    for (let t = 0; t < 300; t++) {
      tick(dyn, [a, b]);
      const wa = pa.map((p) => a.grid.toWorld(p));
      const wb = pb.map((p) => b.grid.toWorld(p));
      worst = Math.max(worst, pointsIntoHull(b, wa), pointsIntoHull(a, wb));
      expect(finite(a) && finite(b)).toBe(true);
    }
    expect(worst).toBeLessThan(0.3);
    // a is still south of b
    expect(a.grid.position.z).toBeGreaterThan(b.grid.position.z + 5);
  });
});
