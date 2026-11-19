/**
 * Rotors against hulls with partial cells (docs/SHAPES.md 12.6, 12.7): a blade pushes a boat of
 * slabs without sliding through it or crushing it (GRAZE_PENALTY, ROTOR_STALE_DEPTH and
 * maxSubstepTravel keep their full-block values), and crushing removes one part per tick with one
 * drop per part at DROP_POINT.
 */
import { describe, expect, it } from 'vitest';
import { cellPrimary, cellSecond, makeCell, PART_MASK, partHoles } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, DROP_POINT, partCount } from '../../src/blocks/shapes';
import { NZ, PX, PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3, type Vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import type { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, slab, SOUTH, UPPER, WEST } from '../shapes';
import { fillWorld, finite, hullExtent, hullSamplePoints, launch, makeSea, newRotor, newShip, plankBoat, pointsIntoHull, setup, terrainPenetration, tick } from './helpers';

/** The blade of rotor.test.ts: hub (hx, 47, hz), a 7 x 4 canvas plate pointing east at angle 0, spinning about +Y. */
function blade(world: World, hx: number, hz: number, startAngle: number): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + 7; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = startAngle;
  qfromAxisAngle(vec3(0, 1, 0), startAngle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

function rotorCorners(r: Rotor): Vec3[] {
  const out: Vec3[] = [];
  r.grid.forEachCell((x, y, z) => {
    for (let k = 0; k < 8; k++) out.push(r.grid.toWorld(vec3(x + (k & 1), y + ((k >> 1) & 1), z + (k >> 2))));
  });
  return out;
}

/** A boat of slabs: floor of upper slabs at y0, a rim of lower slabs at y0 + 1 around the w x d footprint. */
function slabBoat(world: World, x0: number, y0: number, z0: number, w: number, d: number, floor = slab(B.PLANKS_OAK, UPPER), rim = slab(B.PLANKS_OAK, LOWER)): Ship {
  const s = newShip(world, 1);
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      s.grid.setCell(x, y0, z, floor);
      if (x === x0 || z === z0 || x === x0 + w - 1 || z === z0 + d - 1) s.grid.setCell(x, y0 + 1, z, rim);
    }
  }
  return s;
}

describe('a blade pushes a boat of slabs (12.6: the rotor constants stay)', () => {
  it('pushes it away: contacts, no pinning, no crushed part, the blade never deep in its slabs', () => {
    const world = makeSea();
    const { dyn, host } = setup(world);
    const boat = launch(slabBoat(world, 2, 46, -7, 4, 3), dyn);
    const cells = boat.grid.count;
    const rotor = blade(world, 0, 0, 0);
    const p0 = { ...boat.grid.position };
    let contacts = 0;
    let pinned = 0;
    let overlap = 0;
    for (let t = 0; t < 300; t++) {
      tick(dyn, [boat], [rotor], 1);
      const st = dyn.getStats(boat)!;
      contacts += st.rotorContacts;
      pinned += st.pinned;
      if (st.pinned === 0) overlap = Math.max(overlap, pointsIntoHull(boat, rotorCorners(rotor)));
      expect(finite(boat)).toBe(true);
    }
    expect(contacts).toBeGreaterThan(0);
    expect(pinned).toBe(0);
    expect(boat.grid.count).toBe(cells);
    expect(host.drops).toHaveLength(0);
    expect(Math.hypot(boat.grid.position.x - p0.x, boat.grid.position.z - p0.z)).toBeGreaterThan(1);
    expect(overlap).toBeLessThan(0.3);
  });

  it('a boat of slabs gliding along a wall while a blade pushes it is not pinned', () => {
    const world = makeSea();
    fillWorld(world, -6, 36, -24, -4, 52, 20, B.STONE); // long west wall, face x = -3
    const { dyn, host } = setup(world);
    const boat = launch(slabBoat(world, -3, 46, -6, 3, 3), dyn);
    const cells = boat.grid.count;
    const rotor = blade(world, 4, -5, (140 * Math.PI) / 180);
    const z0 = boat.grid.position.z;
    let pinned = 0;
    let wall = 0;
    const pts = hullSamplePoints(boat);
    for (let t = 0; t < 40; t++) {
      tick(dyn, [boat], [rotor], 1);
      pinned += dyn.getStats(boat)!.pinned;
      wall = Math.max(wall, terrainPenetration(world, boat, pts));
    }
    expect(pinned).toBe(0);
    expect(boat.grid.count).toBe(cells);
    expect(host.drops).toHaveLength(0);
    expect(boat.grid.position.z).toBeGreaterThan(z0 + 1);
    expect(wall).toBeLessThan(0.1);
  });
});

describe('a blade of slabs (a rotor with partial cells)', () => {
  it('pushes a floating boat away without passing into it or crushing it', () => {
    const world = makeSea();
    const { dyn, host } = setup(world);
    const boat = launch(newShipWith(world), dyn);
    const cells = boat.grid.count;
    // the blade of rotor.test.ts made of north canvas slabs (half as thick)
    const cellsList: Array<[number, number, number]> = [[0, 47, 0]];
    for (let x = 1; x <= 7; x++) for (let y = 46; y <= 49; y++) cellsList.push([x, y, 0]);
    const rotor = newRotor(world, 100, 0, 47, 0, PY, cellsList);
    for (const [x, y, z] of cellsList) rotor.grid.setCell(x, y, z, slab(B.CANVAS, NORTH));
    rotor.grid.snapshotPose();
    const p0 = { ...boat.grid.position };
    let contacts = 0;
    let pinned = 0;
    let overlap = 0;
    const plate: Vec3[] = [];
    for (let t = 0; t < 300; t++) {
      tick(dyn, [boat], [rotor], 1);
      const st = dyn.getStats(boat)!;
      contacts += st.rotorContacts;
      pinned += st.pinned;
      // the slab's own corners (half-cell thick plate)
      plate.length = 0;
      rotor.grid.forEachCell((x, y, z) => {
        for (let k = 0; k < 8; k++) plate.push(rotor.grid.toWorld(vec3(x + (k & 1), y + ((k >> 1) & 1), z + 0.5 * (k >> 2))));
      });
      if (st.pinned === 0) overlap = Math.max(overlap, pointsIntoHull(boat, plate));
      expect(finite(boat)).toBe(true);
    }
    expect(contacts).toBeGreaterThan(0);
    expect(pinned).toBe(0);
    expect(boat.grid.count).toBe(cells);
    expect(host.drops).toHaveLength(0);
    expect(Math.hypot(boat.grid.position.x - p0.x, boat.grid.position.z - p0.z)).toBeGreaterThan(1);
    expect(overlap).toBeLessThan(0.3);
  });
});

/** The full-block boat of rotor.test.ts's open-water case. */
function newShipWith(world: World): Ship {
  const s = newShip(world, 1);
  for (let z = -7; z < -4; z++) {
    for (let x = 2; x < 6; x++) {
      s.grid.setCell(x, 46, z, makeCell(B.PLANKS_OAK));
      if (x === 2 || z === -7 || x === 5 || z === -5) s.grid.setCell(x, 47, z, makeCell(B.PLANKS_OAK));
    }
  }
  return s;
}

describe('a blade face sliding past a hull next to partial cells (GRAZE_PENALTY on the half grid)', () => {
  // The scene of review-robustness-graze.test.ts (LESSONS 叶片侧面擦过船时船被猛踢): a boat drifts
  // against the flat side of a spinning horizontal-axis rotor whose blade slides past its west
  // face. Here partial cells sit on one side or the other of that face, so the contacts are probed
  // on the half grid, where the graze penalty must apply as on the cell grid. Without it the
  // leading or trailing octant face of the blade wins and the boat is dragged along the sweep
  // (3.3 to 6.3 blocks/s in these three scenes; with it, 0.12 to 0.44).
  const P = makeCell(B.PLANKS_OAK);
  const scenes: Array<[string, number, (s: Ship) => void]> = [
    ['a blade of upper slabs against a boat of full planks', -1, () => {}],
    [
      'a blade of upper slabs against a boat whose west wall is a column of west slabs',
      -1,
      (s) => {
        for (let z = -1; z <= 7; z++) for (const y of [47, 48]) s.grid.setCell(1, y, z, slab(B.PLANKS_OAK, WEST));
      },
    ],
    [
      'a blade of upper slabs against a boat of two-part cells (west oak, east pine)',
      -0.3,
      (s) => {
        const cells: Array<[number, number, number]> = [];
        s.grid.forEachCell((x, y, z, c) => {
          if (c === P) cells.push([x, y, z]);
        });
        for (const [x, y, z] of cells) s.grid.setCell(x, y, z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.PLANKS_PINE, EAST)));
      },
    ],
  ];
  for (const [name, vx, carve] of scenes) {
    it(`${name}: only a gentle tangential push`, () => {
      const world = makeSea();
      const { dyn, host } = setup(world);
      // axis +X, hub cell (0, 50, 3); a 7-long, 3-tall plate in the plane x in [0, 1) along +Z
      const cells: Array<[number, number, number]> = [[0, 50, 3]];
      for (let z = 4; z <= 10; z++) for (let y = 49; y <= 51; y++) cells.push([0, y, z]);
      const rotor = newRotor(world, 100, 0, 50, 3, PX, cells);
      for (const [x, y, z] of cells.slice(1)) rotor.grid.setCell(x, y, z, slab(B.CANVAS, UPPER));
      // the boat's west face at x = 1, flush with the plate's +X face
      const boat = plankBoat(world, 1, 1, 47, -1, 4, 9, NZ);
      carve(boat);
      launch(boat, dyn);
      for (let t = 0; t < 60; t++) tick(dyn, [boat], [rotor], 0);
      boat.grid.linearVelocity.x = vx;
      let contacts = 0;
      let maxTangential = 0;
      for (let t = 0; t < 120; t++) {
        tick(dyn, [boat], [rotor], 1);
        const v = boat.grid.linearVelocity;
        contacts += dyn.getStats(boat)!.rotorContacts;
        maxTangential = Math.max(maxTangential, Math.hypot(v.y, v.z));
        expect(finite(boat)).toBe(true);
      }
      expect(contacts).toBeGreaterThan(0);
      expect(host.drops).toHaveLength(0);
      // the threshold of review-robustness-graze.test.ts
      expect(maxTangential).toBeLessThan(2);
    });
  }
});

describe('crushing removes one part at a time (12.7)', () => {
  /**
   * The corner of rotor.test.ts (west wall face x = -3, south wall face z = -3, the blade sweeping
   * into the corner), with a boat whose every cell holds two planks halves (north oak, south pine).
   */
  function corner(kind: 'two-part' | 'slabs'): { world: World; dyn: ReturnType<typeof setup>['dyn']; host: ReturnType<typeof setup>['host']; boat: Ship } {
    const world = makeSea();
    fillWorld(world, -6, 36, -14, -4, 52, 0, B.STONE);
    fillWorld(world, -6, 36, -3, -1, 52, -2, B.STONE);
    const { dyn, host } = setup(world);
    let boat: Ship;
    if (kind === 'two-part') {
      const two = canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_PINE, SOUTH));
      boat = newShip(world, 1);
      for (let z = -6; z < -3; z++) {
        for (let x = -3; x < 0; x++) {
          boat.grid.setCell(x, 46, z, two);
          if (x === -3 || z === -6 || x === -1 || z === -4) boat.grid.setCell(x, 47, z, two);
        }
      }
    } else {
      // partial cells: the floor two-part (upper oak slab + lower pine slab), a rim of lower slabs
      boat = slabBoat(world, -3, 46, -6, 3, 3, canonCell(slab(B.PLANKS_PINE, LOWER), slab(B.PLANKS_OAK, UPPER)), slab(B.PLANKS_OAK, LOWER));
    }
    launch(boat, dyn);
    return { world, dyn, host, boat };
  }

  for (const kind of ['two-part', 'slabs'] as const) it(`${kind} cells: each tick removes at most one part; a two-part cell takes two ticks; one drop per part, at the corner + DROP_POINT of the part`, () => {
    const { world, dyn, host, boat } = corner(kind);
    const rotor = blade(world, 0, 0, (80 * Math.PI) / 180);
    const removed: Array<{ part: number; at: Vec3 }> = [];
    boat.grid.onCellChange((x, y, z, oldCell, newCell) => {
      expect(partCount(newCell)).toBe(partCount(oldCell) - 1);
      const was = [cellPrimary(oldCell) & PART_MASK, cellSecond(oldCell)];
      const now = [cellPrimary(newCell) & PART_MASK, cellSecond(newCell)];
      const part = was.find((p) => p !== 0 && !now.includes(p))!;
      const f = ~partHoles(part) & 0xff;
      removed.push({ part, at: boat.grid.toWorld(vec3(x + DROP_POINT[f * 3]!, y + DROP_POINT[f * 3 + 1]!, z + DROP_POINT[f * 3 + 2]!)) });
    });
    const cells0 = boat.grid.count;
    let maxPerTick = 0;
    for (let t = 0; t < 140; t++) {
      const before = removed.length;
      tick(dyn, [boat], [rotor], 1);
      maxPerTick = Math.max(maxPerTick, removed.length - before);
      expect(finite(boat)).toBe(true);
    }
    expect(removed.length).toBeGreaterThan(2);
    expect(maxPerTick).toBe(1);
    // fewer cells disappeared than parts: some cells lost one part and kept the other first
    expect(cells0 - boat.grid.count).toBeLessThan(removed.length);
    // one drop per removed part, of its material, at its drop point
    expect(host.drops).toHaveLength(removed.length);
    for (let i = 0; i < removed.length; i++) {
      const d = host.drops[i]!;
      expect(d.item).toBe(removed[i]!.part & 0x3ff);
      expect(d.count).toBe(1);
      expect(d.x).toBeCloseTo(removed[i]!.at.x, 9);
      expect(d.y).toBeCloseTo(removed[i]!.at.y, 9);
      expect(d.z).toBeCloseTo(removed[i]!.at.z, 9);
    }
    expect(new Set(host.drops.map((d) => d.item)).size).toBeGreaterThan(kind === 'two-part' ? 1 : 0);
  });

  it('crushing a full block still drops at the cell centre (M1)', () => {
    const world = makeSea();
    fillWorld(world, -6, 36, -14, -4, 52, 0, B.STONE);
    fillWorld(world, -6, 36, -3, -1, 52, -2, B.STONE);
    const { dyn, host } = setup(world);
    const boat = newShip(world, 1);
    for (let z = -6; z < -3; z++) for (let x = -3; x < 0; x++) boat.grid.setCell(x, 46, z, makeCell(B.PLANKS_OAK));
    launch(boat, dyn);
    const rotor = blade(world, 0, 0, (80 * Math.PI) / 180);
    const centres: Vec3[] = [];
    boat.grid.onCellChange((x, y, z) => centres.push(boat.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5))));
    for (let t = 0; t < 100; t++) tick(dyn, [boat], [rotor], 1);
    expect(centres.length).toBeGreaterThan(0);
    expect(host.drops).toHaveLength(centres.length);
    for (let i = 0; i < centres.length; i++) {
      expect(host.drops[i]!.x).toBeCloseTo(centres[i]!.x, 9);
      expect(host.drops[i]!.y).toBeCloseTo(centres[i]!.y, 9);
      expect(host.drops[i]!.z).toBeCloseTo(centres[i]!.z, 9);
    }
    // never into the walls
    expect(hullExtent(boat).minX).toBeGreaterThan(-3 - 0.1);
  });
});
