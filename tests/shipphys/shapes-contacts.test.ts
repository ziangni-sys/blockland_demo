/**
 * Contacts with partial cells (docs/SHAPES.md 12.6): slab hulls resting on ground, hulls resting on
 * slab ground, a full hull sliding along and off a half-slab step, half-slab-thick walls against a
 * ship at full speed, world corners on the half lattice, and ships of slabs against each other.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NX, NZ, PX, PZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import type { Body } from '../../src/structures/physics/body';
import type { Ship } from '../../src/structures/structure';
import type { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import {
  columnSurface,
  fillWorld,
  finite,
  hullExtent,
  hullSamplePoints,
  kineticEnergy,
  launch,
  makeWorld,
  mechanicalEnergy,
  newShip,
  plankBoat,
  pointsIntoHull,
  rotateShip,
  setup,
  terrainPenetration,
  tick,
  tilt,
} from './helpers';
import { fillGrid } from './shapes-helpers';

type Dyn = ReturnType<typeof setup>['dyn'];

function bodyOf(dyn: Dyn, s: Ship): Body {
  return (dyn as unknown as { bodyMap: WeakMap<Ship, Body> }).bodyMap.get(s)!;
}

/** Dry land: stone below y = 40. */
function land(): World {
  return makeWorld({ cx0: -3, cx1: 2, cz0: -3, cz1: 2, floorTop: 40, waterTop: 0 });
}

/** A small seeded generator (mulberry32) for the random scenes. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** World y of the lowest sample point of the hull's hard material. */
function bottomY(s: Ship): number {
  return hullExtent(s).minY;
}

/** Run until the ship sleeps (at most `max` ticks); the deepest terrain penetration on the way. */
function settle(world: World, dyn: Dyn, s: Ship, max = 300): number {
  let pen = 0;
  const pts = hullSamplePoints(s);
  for (let t = 0; t < max && !s.asleep; t++) {
    tick(dyn, [s]);
    pen = Math.max(pen, terrainPenetration(world, s, pts));
  }
  return pen;
}

describe('resting on ground', () => {
  it('a raft of upper slabs rests on its slabs: neither sunk into the ground nor hovering on the empty lower halves', () => {
    const world = land();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -2, 42, -2, 2, 42, 2, slab(B.PLANKS_OAK, UPPER));
    launch(raft, dyn);
    const pen = settle(world, dyn, raft);
    expect(raft.asleep).toBe(true);
    expect(pen).toBeLessThan(0.05);
    expect(Math.abs(bottomY(raft) - 40)).toBeLessThan(0.03);
    // the cell layer of the raft hangs half a cell below the ground's top
    expect(Math.abs(raft.grid.toWorld(vec3(0, 42, 0)).y - 39.5)).toBeLessThan(0.03);
    expect(tilt(raft)).toBeLessThan(0.01);
  });

  it('a raft of lower slabs rests on its slabs (no sinking)', () => {
    const world = land();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -2, 42, -2, 2, 42, 2, slab(B.STONE, LOWER));
    launch(raft, dyn);
    const pen = settle(world, dyn, raft);
    expect(raft.asleep).toBe(true);
    expect(pen).toBeLessThan(0.05);
    expect(Math.abs(bottomY(raft) - 40)).toBeLessThan(0.03);
  });

  it('a raft of full blocks rests on ground paved with lower slabs half a cell up, on upper slabs one cell up', () => {
    for (const [fill, top] of [
      [LOWER, 40.5],
      [UPPER, 41],
    ] as const) {
      const world = land();
      for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) world.setCell(x, 40, z, slab(B.STONE, fill));
      const { dyn } = setup(world);
      const raft = newShip(world, 1);
      fillGrid(raft.grid, -2, 43, -2, 2, 43, 2, makeCell(B.PLANKS_OAK));
      launch(raft, dyn);
      const pen = settle(world, dyn, raft);
      expect(raft.asleep).toBe(true);
      expect(pen).toBeLessThan(0.05);
      expect(Math.abs(bottomY(raft) - top)).toBeLessThan(0.03);
    }
  });
});

describe('resting on an edge: sample points on the edge of a full cell\'s face beside a partial cell', () => {
  // A raft of two rows of full planks and one row of slabs beside them rests 2 cm off the lattice
  // on a one-block-wide kerb of FULL stone (x in [0, 1]), so only the bottom face of the middle
  // row and the edge points of its neighbours touch the kerb. The point (1, 41, z + 0.5) is the
  // midpoint of an edge of the middle row's bottom face, created by pass 2 for the slab's side
  // face. It used to carry only +X, so the prober pushed it out sideways through the kerb's side:
  // the raft was thrown 1.09 blocks west at 2.6 blocks/s, a contact 0.83 deep with normal -X.
  for (const [name, beside] of [
    ['upper slabs', slab(B.PLANKS_OAK, UPPER)],
    ['lower slabs', slab(B.PLANKS_OAK, LOWER)],
    ['full planks', makeCell(B.PLANKS_OAK)],
  ] as const) {
    it(`a raft with a row of ${name} beside its full rows rests on a kerb of full blocks without moving`, () => {
      const world = land();
      fillWorld(world, 0, 40, -6, 0, 40, 6, B.STONE); // the kerb, top at 41
      const { dyn } = setup(world);
      const raft = newShip(world, 1);
      for (let z = -2; z <= 2; z++) {
        raft.grid.setCell(-1, 41, z, makeCell(B.PLANKS_OAK));
        raft.grid.setCell(0, 41, z, makeCell(B.PLANKS_OAK));
        raft.grid.setCell(1, 41, z, beside);
      }
      launch(raft, dyn);
      raft.grid.position.x -= 0.02;
      const x0 = raft.grid.position.x;
      const pts = hullSamplePoints(raft);
      let pen = 0;
      let maxSpeed = 0;
      for (let t = 0; t < 300 && !raft.asleep; t++) {
        tick(dyn, [raft]);
        const v = raft.grid.linearVelocity;
        maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
        pen = Math.max(pen, terrainPenetration(world, raft, pts));
        expect(dyn.getStats(raft)!.maxDepth).toBeLessThan(0.05);
      }
      expect(raft.asleep).toBe(true);
      expect(Math.abs(raft.grid.position.x - x0)).toBeLessThan(0.01);
      expect(maxSpeed).toBeLessThan(0.1);
      expect(pen).toBeLessThan(0.05);
      expect(tilt(raft)).toBeLessThan(0.01);
    });
  }

  it('small random hulls of parts on ground paved with partial cells all fall asleep (120 scenes)', { timeout: 120000 }, () => {
    // Before the edge points took the face normal, one of these scenes (a slab hull on slab
    // pavement) rocked in a 28-tick cycle for thousands of ticks with a contact 0.494 deep where
    // the true depth was 0.006. Full hulls on bumpy full-block ground (the M1 case) all sleep.
    const halves = [LOWER, UPPER, WEST, EAST, NORTH, SOUTH];
    const stairs = [stairFill(PX), stairFill(NX), stairFill(PZ), stairFill(NZ)];
    const awake: number[] = [];
    for (let seed = 1; seed <= 120; seed++) {
      const r = mulberry(seed);
      const part = (id: number, id2: number): number => {
        const y = r();
        if (y < 0.25) return makeCell(id);
        if (y < 0.55) return slab(id, halves[Math.floor(r() * 6)]!);
        if (y < 0.7) return slab(id, stairs[Math.floor(r() * 4)]!);
        if (y < 0.85) return slab(id, 1 + Math.floor(r() * 254));
        let f = 1 + Math.floor(r() * 255);
        while ((f & (f - 1)) === 0) f = 1 + Math.floor(r() * 255);
        let a = 0;
        for (let o = 0; o < 8; o++) if ((f >> o) & 1 && r() < 0.5) a |= 1 << o;
        if (a === 0 || a === f) a = f & -f;
        return canonCell(slab(id, a), slab(id2, f & ~a));
      };
      const world = land();
      const mode = seed % 3;
      for (let z = -8; z <= 8; z++) {
        for (let x = -8; x <= 8; x++) {
          if (r() >= 0.8) continue;
          world.setCell(x, 40, z, mode === 0 ? slab(B.STONE, LOWER) : mode === 1 ? part(B.STONE, B.BRICKS) : slab(B.STONE, r() < 0.5 ? LOWER : UPPER));
        }
      }
      const { dyn } = setup(world);
      const s = newShip(world, 1);
      const w = 2 + Math.floor(r() * 4);
      const d = 2 + Math.floor(r() * 4);
      const fullHull = seed % 2 === 0;
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < d; z++) {
          for (let x = 0; x < w; x++) {
            if (y === 0 || r() < 0.4) s.grid.setCell(x - 2, 43 + y, z - 2, fullHull ? makeCell(B.PLANKS_OAK) : part(B.PLANKS_OAK, B.PLANKS_PINE));
          }
        }
      }
      launch(s, dyn);
      if (seed % 4 === 0) rotateShip(s, vec3(0, 1, 0), 0.3 + r());
      for (let t = 0; t < 1200 && !s.asleep; t++) tick(dyn, [s]);
      expect(finite(s)).toBe(true);
      if (!s.asleep) awake.push(seed);
    }
    expect(awake).toEqual([]);
  });
});

describe('a half-slab step', () => {
  /** Ground at y 40; a step of lower stone slabs on it for x >= 0 (top at 40.5). */
  function stepWorld(): World {
    const world = land();
    for (let x = 0; x <= 12; x++) for (let z = -12; z <= 12; z++) world.setCell(x, 40, z, slab(B.STONE, LOWER));
    return world;
  }

  it('the world corners along the step edge are on the half lattice, with the step top and side as their exposed faces', () => {
    const world = stepWorld();
    const { dyn } = setup(world);
    const raft = launch(plankBoat(world, 1, -2, 42, -2, 4, 4), dyn);
    const b = bodyOf(dyn, raft);
    b.loadPose();
    b.patch.fill(world, -8, 34, -8, 8, 46, 8);
    b.patch.collectCorners(-4, 38, -4, 4, 43, 4);
    let edge = 0;
    for (let j = 0; j < b.patch.cornerCount; j++) {
      if (b.patch.cornerX[j] === 0 && b.patch.cornerY[j] === 40.5) {
        edge++;
        expect(b.patch.cornerMask[j]).toBe((1 << 1) | (1 << 2)); // -X (the step's side) and +Y (its top)
      }
    }
    // every half-lattice z from -4 to 4 along the edge
    expect(edge).toBe(17);
    // The foot of the step's side, x = 0, y = 40: at integer z these are corners of the full stone
    // cells below the ground line, beside the slab cells. Their exposed faces come from the
    // octants (the stone's top at x < 0, the slab's -X side above it); at the cell level the slab
    // cell would count as not hard, leaving +Y alone, and the corner would be dropped.
    let foot = 0;
    for (let j = 0; j < b.patch.cornerCount; j++) {
      if (b.patch.cornerX[j] === 0 && b.patch.cornerY[j] === 40) {
        foot++;
        expect(b.patch.cornerMask[j]).toBe((1 << 1) | (1 << 2)); // -X and +Y
      }
    }
    expect(foot).toBe(17);
  });

  it('a full hull resting across the step edge slides along it on the step, without catching or sinking into the low side', () => {
    const world = stepWorld();
    const { dyn } = setup(world);
    // 4 x 4 raft over x -2..1: half on the step (x >= 0), half over the low ground
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -2, 42, -6, 1, 42, -3, makeCell(B.PLANKS_OAK));
    launch(raft, dyn);
    let pen = settle(world, dyn, raft);
    expect(raft.asleep).toBe(true);
    // it rests on the step at 40.5, tilted onto the edge at worst
    expect(bottomY(raft)).toBeGreaterThan(40 - 0.03);
    // slide along the edge (+Z)
    raft.grid.linearVelocity.z = 3;
    const z0 = raft.grid.position.z;
    const pts = hullSamplePoints(raft);
    for (let t = 0; t < 40; t++) {
      tick(dyn, [raft]);
      pen = Math.max(pen, terrainPenetration(world, raft, pts));
    }
    expect(raft.grid.position.z - z0).toBeGreaterThan(0.5);
    expect(pen).toBeLessThan(0.05);
    expect(finite(raft)).toBe(true);
  });

  it('a full hull driven off the step drops half a cell onto the low ground, never into the step', () => {
    const world = stepWorld();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, 2, 42, -2, 5, 42, 1, makeCell(B.PLANKS_OAK));
    launch(raft, dyn);
    let pen = settle(world, dyn, raft);
    expect(Math.abs(bottomY(raft) - 40.5)).toBeLessThan(0.03);
    const pts = hullSamplePoints(raft);
    for (let t = 0; t < 120; t++) {
      raft.grid.linearVelocity.x = -2;
      raft.asleep = false;
      tick(dyn, [raft]);
      pen = Math.max(pen, terrainPenetration(world, raft, pts));
    }
    expect(hullExtent(raft, pts).maxX).toBeLessThan(0.1); // off the step
    expect(Math.abs(bottomY(raft) - 40)).toBeLessThan(0.05);
    expect(pen).toBeLessThan(0.05);
  });
});

describe('half-slab-thick walls (12.6)', () => {
  /** Open water x in [-48, 47], z in [-112, 47]. */
  function channel(): World {
    return makeWorld({ cx0: -3, cx1: 2, cz0: -7, cz1: 2 });
  }
  const WALL_Z = -40;

  // [name, wall cell, z of the wall face the boat meets]. The two-part wall (north half stone,
  // south half bricks) is hard over its whole cell only if the world patch counts the second part
  // (the bricks) as hard; its face is then at WALL_Z + 1, else at WALL_Z + 0.5.
  for (const [name, cell, face] of [
    ['south slabs', slab(B.STONE, SOUTH), WALL_Z + 1],
    ['north slabs', slab(B.STONE, NORTH), WALL_Z + 0.5],
    ['two-part cells (north stone, south bricks)', canonCell(slab(B.STONE, NORTH), slab(B.BRICKS, SOUTH)), WALL_Z + 1],
  ] as const) {
    it(`a wall of ${name} (its face at z = ${face}) stops a boat at full speed: no tunnelling, no kinetic energy gained`, () => {
      const world = channel();
      for (let x = -12; x <= 12; x++) for (let y = 36; y <= 52; y++) world.setCell(x, y, WALL_Z, cell);
      const surface = columnSurface(world);
      const { dyn } = setup(world);
      // the boat of collision.test.ts: 40 sails, about 10.5 blocks/s when it reaches the wall;
      // the throttle is cut at the impact, as in collision.test.ts's energy checks
      const boat = launch(plankBoat(world, 1, -2, 46, 30, 5, 9, NZ), dyn);
      boat.sails = 40;
      boat.throttle = 1;
      const pts = hullSamplePoints(boat);
      let maxPen = 0;
      let minBowZ = Infinity;
      let speedAtImpact = -1;
      const kinetic: number[] = [];
      const mechanical: number[] = [];
      for (let t = 0; t < 400; t++) {
        const v = boat.grid.linearVelocity;
        const before = Math.hypot(v.x, v.z);
        const kBefore = kineticEnergy(boat);
        tick(dyn, [boat]);
        if (speedAtImpact < 0 && dyn.getStats(boat)!.terrainContacts > 0) {
          speedAtImpact = before;
          kinetic.push(kBefore);
          boat.throttle = 0;
        }
        if (speedAtImpact >= 0) {
          kinetic.push(kineticEnergy(boat));
          mechanical.push(mechanicalEnergy(boat, surface));
        }
        maxPen = Math.max(maxPen, terrainPenetration(world, boat, pts));
        minBowZ = Math.min(minBowZ, hullExtent(boat, pts).minZ);
      }
      expect(finite(boat)).toBe(true);
      expect(speedAtImpact).toBeGreaterThan(10);
      expect(maxPen).toBeLessThan(0.1);
      expect(minBowZ).toBeGreaterThan(face - 0.1);
      expect(minBowZ).toBeLessThan(face + 0.3); // it did reach the wall
      // The kinetic-energy checks of collision.test.ts: the impact removes almost all of it at
      // once, it never comes back above its value before the impact, and the boat comes to rest.
      const k0 = kinetic[0]!;
      expect(kinetic[1]!).toBeLessThan(0.05 * k0);
      for (const e of kinetic) expect(e).toBeLessThanOrEqual(k0);
      expect(kinetic[kinetic.length - 1]!).toBeLessThan(0.001 * k0);
      // collision.test.ts also requires the mechanical energy (kinetic + gravity + buoyancy
      // potential) never to increase. That holds for walls whose face is on a cell plane. It does
      // not for the north slabs, whose face is on the half-cell plane z = WALL_Z + 0.5: the bow's
      // displacement cubes are buoyed by the water of the column their centre is in (12.5), and
      // when the bow touches the wall the centres of its cubes cross into the wall cells' column
      // and back. That column holds no water at the bow's height (water never shares a cell with
      // a part), so the buoyancy potential has a step there: the measured energy rises by about
      // 4 J (5 bow cubes x g x their potential at a draught of 0.41) in one tick and falls back.
      // It is not a net gain over a cycle, and the kinetic-energy checks above still hold.
      if (face === WALL_Z + 1) {
        for (let i = 1; i < mechanical.length; i++) expect(mechanical[i]!).toBeLessThanOrEqual(mechanical[i - 1]! + 1e-9 * Math.abs(mechanical[i - 1]!));
      }
    });
  }
});

describe('terrain corners against a hull of slabs', () => {
  it('a boat with a bow of upright slabs driven into a thin post: the post\'s corners stay out of its slabs', () => {
    const world = makeWorld({ cx0: -3, cx1: 2, cz0: -7, cz1: 2 });
    const WALL_Z = -40;
    for (let y = 36; y <= 52; y++) world.setCell(0, y, WALL_Z, makeCell(B.STONE));
    const corners: Vec3[] = [];
    for (let y = 36; y <= 53; y++) for (const [x, z] of [[0, WALL_Z], [1, WALL_Z], [0, WALL_Z + 1], [1, WALL_Z + 1]] as const) corners.push(vec3(x, y, z));
    for (let y = 36; y < 53; y++) corners.push(vec3(0.5, y + 0.5, WALL_Z + 1), vec3(0, y + 0.5, WALL_Z + 0.5), vec3(1, y + 0.5, WALL_Z + 0.5));
    const { dyn } = setup(world);
    // the boat of collision.test.ts, its bow (north) row of rim and floor cells made of south slabs
    const boat = plankBoat(world, 1, -2, 46, 30, 5, 9, NZ);
    for (let x = -2; x <= 2; x++) for (const y of [46, 47]) boat.grid.setCell(x, y, 30, slab(B.PLANKS_OAK, SOUTH));
    launch(boat, dyn);
    boat.sails = 40;
    boat.throttle = 1;
    let worst = 0;
    let contact = false;
    for (let t = 0; t < 400; t++) {
      tick(dyn, [boat]);
      contact ||= dyn.getStats(boat)!.terrainContacts > 0;
      worst = Math.max(worst, pointsIntoHull(boat, corners));
    }
    expect(contact).toBe(true);
    expect(finite(boat)).toBe(true);
    expect(worst).toBeLessThan(0.1);
  });
});

describe('ships of slabs against each other', () => {
  it('a full boat driven into a boat of slabs pushes it without passing into its slabs', () => {
    const world = makeWorld({ cx0: -3, cx1: 2, cz0: -5, cz1: 2 });
    const { dyn } = setup(world);
    const a = launch(plankBoat(world, 1, -3, 46, 0, 5, 7, NZ), dyn);
    const b = newShip(world, 2);
    // a slab boat north of it: floor of upper slabs, a rim of vertical slabs
    for (let z = -12; z <= -8; z++) {
      for (let x = -3; x <= 1; x++) {
        b.grid.setCell(x, 46, z, slab(B.PLANKS_OAK, UPPER));
        if (z === -8) b.grid.setCell(x, 47, z, slab(B.PLANKS_OAK, SOUTH));
      }
    }
    launch(b, dyn);
    a.sails = 20;
    a.throttle = 1;
    const zb = b.grid.position.z;
    let worst = 0;
    for (let t = 0; t < 200; t++) {
      tick(dyn, [a, b]);
      const pa: Vec3[] = hullSamplePoints(a).map((p) => a.grid.toWorld(p));
      const pb: Vec3[] = hullSamplePoints(b).map((p) => b.grid.toWorld(p));
      worst = Math.max(worst, pointsIntoHull(b, pa), pointsIntoHull(a, pb));
    }
    expect(finite(a) && finite(b)).toBe(true);
    expect(b.grid.position.z).toBeLessThan(zb - 1); // pushed north
    expect(worst).toBeLessThan(0.15);
  });
});
