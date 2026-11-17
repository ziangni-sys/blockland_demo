import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { PY } from '../../src/core/dirs';
import { qfromAxisAngle, vec3, type Vec3 } from '../../src/core/math';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  fillWorld,
  finite,
  hullExtent,
  hullSamplePoints,
  launch,
  makeSea,
  newRotor,
  plankBoat,
  pointsIntoHull,
  setup,
  terrainPenetration,
  tick,
} from './helpers';

/**
 * A vertical-axis rotor (axis +Y) with its hub at cell (hx,47,hz) and a 7-long, 4-tall blade
 * plate pointing east at angle 0. Positive speed turns it counter-clockwise seen from above:
 * the blade sweeps east -> north -> west -> south.
 */
function blade(world: Parameters<typeof newRotor>[0], hx: number, hz: number, startAngle: number): Rotor {
  const cells: Array<[number, number, number]> = [[hx, 47, hz]];
  for (let x = hx + 1; x <= hx + 7; x++) for (let y = 46; y <= 49; y++) cells.push([x, y, hz]);
  const r = newRotor(world, 100, hx, 47, hz, PY, cells);
  r.angle = startAngle;
  qfromAxisAngle(vec3(0, 1, 0), startAngle, r.grid.rotation);
  r.grid.snapshotPose();
  return r;
}

/** World positions of every corner of the rotor's cells (for overlap measurements). */
function rotorCorners(r: Rotor): Vec3[] {
  const out: Vec3[] = [];
  r.grid.forEachCell((x, y, z) => {
    for (let k = 0; k < 8; k++) out.push(r.grid.toWorld(vec3(x + (k & 1), y + ((k >> 1) & 1), z + (k >> 2))));
  });
  return out;
}

interface Trace {
  contacts: number;
  pinned: number;
  maxBladeOverlap: number;
  maxWallPen: number;
  countDrops: number[];
  extents: Array<ReturnType<typeof hullExtent>>;
  finite: boolean;
}

function drive(
  world: ReturnType<typeof makeSea>,
  dyn: ReturnType<typeof setup>['dyn'],
  ship: Ship,
  rotor: Rotor,
  speed: number,
  ticks: number,
): Trace {
  const pts = hullSamplePoints(ship);
  const tr: Trace = { contacts: 0, pinned: 0, maxBladeOverlap: 0, maxWallPen: 0, countDrops: [], extents: [], finite: true };
  let prev = ship.grid.count;
  for (let t = 0; t < ticks; t++) {
    const angleBefore = rotor.angle;
    tick(dyn, [ship], [rotor], speed);
    // the dynamics never touches the rotor: it keeps turning exactly as driven
    expect(rotor.angle).toBe(angleBefore + speed * 0.05);
    const st = dyn.getStats(ship)!;
    tr.contacts += st.rotorContacts;
    tr.pinned += st.pinned;
    tr.countDrops.push(prev - ship.grid.count);
    prev = ship.grid.count;
    const livePts = hullSamplePoints(ship);
    tr.maxWallPen = Math.max(tr.maxWallPen, terrainPenetration(world, ship, livePts));
    if (st.pinned === 0) tr.maxBladeOverlap = Math.max(tr.maxBladeOverlap, pointsIntoHull(ship, rotorCorners(rotor)));
    tr.extents.push(hullExtent(ship, livePts.length > 0 ? livePts : pts));
    tr.finite &&= finite(ship);
  }
  return tr;
}

describe('rotor vs ship: open water (ACCEPTANCE 15)', () => {
  it('a spinning blade pushes a floating boat away without damaging it', () => {
    const world = makeSea();
    const { dyn, host } = setup(world);
    const boat = launch(plankBoat(world, 1, 2, 46, -7, 4, 3), dyn);
    const cells = boat.grid.count;
    const rotor = blade(world, 0, 0, 0);
    const p0 = { ...boat.grid.position };
    const tr = drive(world, dyn, boat, rotor, 1, 300);
    expect(tr.finite).toBe(true);
    expect(tr.contacts).toBeGreaterThan(0);
    expect(tr.pinned).toBe(0);
    expect(boat.grid.count).toBe(cells);
    expect(host.drops).toHaveLength(0);
    const moved = Math.hypot(boat.grid.position.x - p0.x, boat.grid.position.z - p0.z);
    expect(moved).toBeGreaterThan(1);
    // the blade never sinks deep into the hull: the boat keeps up with it
    expect(tr.maxBladeOverlap).toBeLessThan(0.3);
  });
});

describe('rotor vs ship: pinning (ACCEPTANCE 16)', () => {
  /** Boat in the corner of a west wall (face x = -3) and a south wall (face z = -3); the hub is
   * east of the corner, so the blade sweeps west then south-west: into the corner. */
  function corner() {
    const world = makeSea();
    fillWorld(world, -6, 36, -14, -4, 52, 0, B.STONE); // west wall: x <= -4
    fillWorld(world, -6, 36, -3, -1, 52, -2, B.STONE); // south wall: z in [-3, -2]
    const { dyn, host } = setup(world);
    const boat = launch(plankBoat(world, 1, -3, 46, -6, 3, 3), dyn); // x in [-3,0), z in [-6,-3)
    return { world, dyn, host, boat };
  }

  for (const speed of [1, 0.1]) {
    it(`a blade turning at ${speed} rad/s wedging a boat into a corner breaks its cells one at a time, never pushes it into the wall`, () => {
      const { world, dyn, host, boat } = corner();
      const cells = boat.grid.count;
      const rotor = blade(world, 0, 0, (80 * Math.PI) / 180);
      const ticks = Math.ceil(((80 * Math.PI) / 180 / speed) * 20) + 20; // to ~160 degrees
      const tr = drive(world, dyn, boat, rotor, speed, ticks);
      expect(tr.finite).toBe(true);
      expect(tr.pinned).toBeGreaterThan(0);
      const destroyed = cells - boat.grid.count;
      expect(destroyed).toBeGreaterThan(0);
      for (const d of tr.countDrops) expect(d).toBeLessThanOrEqual(1); // one at a time
      // every destroyed cell dropped its item through the host
      expect(host.drops.length).toBe(destroyed);
      for (const d of host.drops) {
        expect([B.PLANKS_OAK, B.HELM]).toContain(d.item);
        expect(d.count).toBe(1);
      }
      // never into the walls
      expect(tr.maxWallPen).toBeLessThan(0.1);
      for (const e of tr.extents) {
        expect(e.minX).toBeGreaterThan(-3 - 0.1);
        expect(e.maxZ).toBeLessThan(-3 + 0.1);
      }
    });
  }

  it('creative mode: pinned cells are destroyed without drops', () => {
    const { world, dyn, host, boat } = corner();
    host.creative = true;
    const cells = boat.grid.count;
    const rotor = blade(world, 0, 0, (80 * Math.PI) / 180);
    drive(world, dyn, boat, rotor, 1, 50);
    expect(boat.grid.count).toBeLessThan(cells);
    expect(host.drops).toHaveLength(0);
  });

  it('a boat gliding along a wall while a blade pushes it is not pinned', () => {
    const world = makeSea();
    fillWorld(world, -6, 36, -24, -4, 52, 20, B.STONE); // long west wall, face x = -3
    const { dyn, host } = setup(world);
    const boat = launch(plankBoat(world, 1, -3, 46, -6, 3, 3), dyn);
    const cells = boat.grid.count;
    // hub east of the boat: the blade crosses it moving south (+Z), along the wall
    const rotor = blade(world, 4, -5, (140 * Math.PI) / 180);
    const z0 = boat.grid.position.z;
    const tr = drive(world, dyn, boat, rotor, 1, 40);
    expect(tr.finite).toBe(true);
    expect(tr.contacts).toBeGreaterThan(0);
    expect(tr.pinned).toBe(0);
    expect(boat.grid.count).toBe(cells);
    expect(host.drops).toHaveLength(0);
    expect(boat.grid.position.z).toBeGreaterThan(z0 + 1);
    expect(tr.maxWallPen).toBeLessThan(0.1);
  });
});
