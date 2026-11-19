/**
 * Behaviour of StructureGrid (src/voxel/sgrid.ts, owned by the lead architect): storage,
 * growth, bounds, pose / nested transforms, velocities and render interpolation.
 */
import { describe, expect, it } from 'vitest';
import {
  qangleBetween,
  qfromYaw,
  qidentity,
  qintegrate,
  qmul,
  qrotate,
  quat,
  vec3,
  type Quat,
  type Vec3,
} from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { AIR, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SET_STRUCTURE_MOVE } from '../../src/voxel/grid';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { STONE, axisAngle, randomQuat } from './helpers';

function expectVecClose(a: Vec3, b: Vec3, digits = 10): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}
/** qangleBetween uses acos, which resolves identical rotations only to ~1e-8 rad. */
function expectQuatSame(a: Quat, b: Quat, tol = 1e-7): void {
  expect(qangleBetween(a, b)).toBeLessThan(tol);
}

describe('StructureGrid storage', () => {
  it('rejects non-positive ids', () => {
    const w = new World();
    expect(() => new StructureGrid(0, w)).toThrow();
    expect(() => new StructureGrid(-1, w)).toThrow();
  });

  it('grows on demand, keeps cells, counts and versions changes', () => {
    const g = new StructureGrid(1, new World());
    expect(g.getCell(0, 0, 0)).toBe(AIR);
    expect(g.cellBounds()).toBeNull();
    expect(g.setCell(5, 5, 5, AIR)).toBe(false); // air outside storage: no growth
    expect(g.storage().layers.base.length).toBe(0);
    const v0 = g.version;
    expect(g.setCell(0, 0, 0, STONE)).toBe(true);
    expect(g.setCell(-7, 3, 9, makeCell(B.PLANKS_OAK))).toBe(true);
    expect(g.setCell(20, -4, -11, makeCell(B.CANVAS))).toBe(true);
    expect(g.getCell(0, 0, 0)).toBe(STONE);
    expect(g.getCell(-7, 3, 9)).toBe(makeCell(B.PLANKS_OAK));
    expect(g.getCell(20, -4, -11)).toBe(makeCell(B.CANVAS));
    expect(g.count).toBe(3);
    expect(g.version).toBeGreaterThan(v0);
    expect(g.setCell(0, 0, 0, STONE)).toBe(false); // unchanged
    expect(g.setCell(0, 0, 0, makeCell(B.DIRT))).toBe(true); // replace keeps count
    expect(g.count).toBe(3);
    expect(g.setCell(0, 0, 0, AIR)).toBe(true);
    expect(g.count).toBe(2);
    expect(g.cellBounds()).toEqual({ minX: -7, minY: -4, minZ: -11, maxX: 21, maxY: 4, maxZ: 10 });
  });

  it('cellBounds is tight, cached per version and shrinks when cells are removed', () => {
    const g = new StructureGrid(1, new World());
    g.setCell(1, 1, 1, STONE);
    g.setCell(4, 2, -3, STONE);
    const b1 = g.cellBounds();
    expect(b1).toEqual({ minX: 1, minY: 1, minZ: -3, maxX: 5, maxY: 3, maxZ: 2 });
    expect(g.cellBounds()).toBe(b1); // cached
    g.setCell(4, 2, -3, AIR);
    expect(g.cellBounds()).toEqual({ minX: 1, minY: 1, minZ: 1, maxX: 2, maxY: 2, maxZ: 2 });
    g.setCell(1, 1, 1, AIR);
    expect(g.cellBounds()).toBeNull();
    expect(g.count).toBe(0);
  });

  it('resize keeps what fits, drops the rest and recounts', () => {
    const g = new StructureGrid(1, new World());
    g.setCell(0, 0, 0, STONE);
    g.setCell(3, 0, 0, STONE);
    g.resize(-1, -1, -1, 3, 3, 3); // covers x in [-1, 2)
    expect([g.getCell(0, 0, 0), g.getCell(3, 0, 0), g.count]).toEqual([STONE, AIR, 1]);
    expect(g.cellBounds()).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 });
    // Writing outside the new storage grows again.
    g.setCell(-5, 7, 2, STONE);
    expect([g.getCell(0, 0, 0), g.getCell(-5, 7, 2), g.count]).toEqual([STONE, STONE, 2]);
  });

  it('forEachCell visits every non-air cell once', () => {
    const rng = new Rng(3);
    const g = new StructureGrid(1, new World());
    const expected = new Map<string, number>();
    for (let i = 0; i < 300; i++) {
      const x = rng.int(-9, 9);
      const y = rng.int(-9, 9);
      const z = rng.int(-9, 9);
      const c = makeCell(B.STONE + rng.int(0, 2));
      g.setCell(x, y, z, c);
      expected.set(`${x},${y},${z}`, c);
    }
    const seen = new Map<string, number>();
    g.forEachCell((x, y, z, c) => {
      expect(seen.has(`${x},${y},${z}`)).toBe(false);
      seen.set(`${x},${y},${z}`, c);
    });
    expect(seen).toEqual(expected);
    expect(g.count).toBe(expected.size);
  });

  it('change listeners get coordinates, old/new cells and flags; unsubscribe works', () => {
    const g = new StructureGrid(1, new World());
    const log: Array<[number, number, number, number, number, number]> = [];
    const off = g.onCellChange((...a) => log.push(a));
    g.setCell(-2, 3, 4, STONE, SET_STRUCTURE_MOVE);
    g.setCell(-2, 3, 4, STONE);
    g.setCell(-2, 3, 4, AIR);
    off();
    g.setCell(1, 1, 1, STONE);
    expect(log).toEqual([
      [-2, 3, 4, AIR, STONE, SET_STRUCTURE_MOVE],
      [-2, 3, 4, STONE, AIR, 0],
    ]);
  });

  it('building a long line cell by cell stays fast enough (growth reallocations)', () => {
    const g = new StructureGrid(1, new World());
    for (let i = 0; i < 2000; i++) g.setCell(i, 0, 0, STONE);
    expect(g.count).toBe(2000);
    expect(g.cellBounds()).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 2000, maxY: 1, maxZ: 1 });
  });

  it('storage follows the tight box, not the edit history (arms built and cleared along each axis)', () => {
    const g = new StructureGrid(1, new World());
    g.setCell(0, 0, 0, STONE);
    const arm = (dx: number, dy: number, dz: number, cell: number): void => {
      for (let i = 1; i <= 1000; i++) g.setCell(i * dx, i * dy, i * dz, cell);
    };
    for (const [dx, dy, dz] of [[1, 0, 0], [0, 0, 1], [0, 1, 0]] as const) {
      arm(dx, dy, dz, STONE);
      // A 1001-cell line: the storage holds a few times its box, never the earlier arms' extents.
      expect(g.storage().layers.base.length).toBeLessThan(4 * 1001 * 5 * 5 * 4);
      arm(dx, dy, dz, AIR);
    }
    expect(g.count).toBe(1);
    expect(g.getCell(0, 0, 0)).toBe(STONE);
  });
});

describe('StructureGrid pose and transforms', () => {
  it('parentPoint = position + rotate(rotation, local - pivot)', () => {
    const w = new World();
    const g = new StructureGrid(1, w);
    g.pivot.x = 2;
    g.pivot.y = 0.5;
    g.pivot.z = -1;
    g.setPoseImmediate(vec3(10, 20, 30), qfromYaw(Math.PI / 2));
    // The pivot maps to the position.
    expectVecClose(g.toWorld(vec3(2, 0.5, -1)), vec3(10, 20, 30));
    // local +X (from the pivot) -> world -Z after a 90 degree yaw (CCW from above).
    expectVecClose(g.toWorld(vec3(3, 0.5, -1)), vec3(10, 20, 29));
    expectVecClose(g.dirToWorld(vec3(1, 0, 0)), vec3(0, 0, -1));
    expectVecClose(g.dirToLocal(vec3(0, 0, -1)), vec3(1, 0, 0));
    expectQuatSame(g.worldRotation(), qfromYaw(Math.PI / 2));
    expectVecClose(g.toParent(vec3(3, 0.5, -1)), vec3(10, 20, 29));
    expectVecClose(g.fromParent(vec3(10, 20, 29)), vec3(3, 0.5, -1));
  });

  it('toLocal inverts toWorld and dirToLocal inverts dirToWorld (random poses, out aliasing)', () => {
    const rng = new Rng(11);
    const w = new World();
    for (let i = 0; i < 50; i++) {
      const g = new StructureGrid(1, w);
      g.pivot.x = rng.range(-5, 5);
      g.pivot.y = rng.range(-5, 5);
      g.pivot.z = rng.range(-5, 5);
      g.setPoseImmediate(vec3(rng.range(-1e4, 1e4), rng.range(0, 128), rng.range(-1e4, 1e4)), randomQuat(rng));
      const p = vec3(rng.range(-20, 20), rng.range(-20, 20), rng.range(-20, 20));
      const q = g.toWorld(p);
      expectVecClose(g.toLocal(q), p, 8);
      const alias = vec3(q.x, q.y, q.z);
      expect(g.toLocal(alias, alias)).toBe(alias);
      expectVecClose(alias, p, 8);
      const d = vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      expectVecClose(g.dirToLocal(g.dirToWorld(d)), d, 12);
    }
  });

  it('nested structures compose through every parent', () => {
    const w = new World();
    const ship = new StructureGrid(1, w);
    ship.pivot.x = 3;
    ship.setPoseImmediate(vec3(100, 50, -20), axisAngle(0.1, 1, 0.2, 0.7));
    const rotor = new StructureGrid(2, ship);
    rotor.pivot.y = 0.5;
    rotor.setPoseImmediate(vec3(1, 4, 2), axisAngle(1, 0, 0, 1.1));
    const turntable = new StructureGrid(3, rotor);
    turntable.setPoseImmediate(vec3(-2, 1, 0), qfromYaw(0.3));
    const p = vec3(0.3, 1.7, -2.2);
    // Manual composition.
    const inRotor = turntable.toParent(p);
    const inShip = rotor.toParent(inRotor);
    const inWorld = ship.toParent(inShip);
    expectVecClose(turntable.toWorld(p), inWorld);
    expectVecClose(turntable.toLocal(inWorld), p, 9);
    const rot = qmul(ship.rotation, qmul(rotor.rotation, turntable.rotation));
    expectQuatSame(turntable.worldRotation(), rot);
    const d = vec3(0.2, -0.5, 0.8);
    expectVecClose(turntable.dirToWorld(d), qrotate(rot, d));
    expectVecClose(turntable.dirToLocal(turntable.dirToWorld(d)), d, 12);
  });

  it('setPivotKeepingPose moves the pivot without moving any cell (current and previous pose)', () => {
    const w = new World();
    const g = new StructureGrid(1, w);
    g.setPoseImmediate(vec3(5, 6, 7), axisAngle(1, 2, 3, 0.4));
    g.snapshotPose();
    g.position.x += 0.5;
    const r = qmul(axisAngle(0, 1, 0, 0.2), g.rotation);
    g.rotation.x = r.x;
    g.rotation.y = r.y;
    g.rotation.z = r.z;
    g.rotation.w = r.w;
    const pts = [vec3(0, 0, 0), vec3(3.5, -1, 2), vec3(-4, 2, -0.5)];
    const before = pts.map((p) => g.toWorld(p));
    const prevBefore = pts.map((p) => {
      const pp = g.renderPose(0);
      const rel = qrotate(pp.rotation, vec3(p.x - g.pivot.x, p.y - g.pivot.y, p.z - g.pivot.z));
      return vec3(pp.position.x + rel.x, pp.position.y + rel.y, pp.position.z + rel.z);
    });
    g.setPivotKeepingPose(vec3(1.25, -0.5, 3));
    expect([g.pivot.x, g.pivot.y, g.pivot.z]).toEqual([1.25, -0.5, 3]);
    pts.forEach((p, i) => expectVecClose(g.toWorld(p), before[i]!));
    pts.forEach((p, i) => {
      const pp = g.renderPose(0);
      const rel = qrotate(pp.rotation, vec3(p.x - g.pivot.x, p.y - g.pivot.y, p.z - g.pivot.z));
      expectVecClose(vec3(pp.position.x + rel.x, pp.position.y + rel.y, pp.position.z + rel.z), prevBefore[i]!);
    });
  });

  it('snapshotPose / setPoseImmediate', () => {
    const g = new StructureGrid(1, new World());
    g.setPoseImmediate(vec3(1, 2, 3), qfromYaw(1));
    expect(g.prevPosition).toEqual(vec3(1, 2, 3));
    expect(g.prevRotation).toEqual(qfromYaw(1));
    g.position.y = 9;
    expect(g.prevPosition.y).toBe(2);
    g.snapshotPose();
    expect(g.prevPosition.y).toBe(9);
  });
});

describe('StructureGrid velocities', () => {
  it('rigid-body velocity about the pivot', () => {
    const w = new World();
    const g = new StructureGrid(1, w);
    g.pivot.x = 10; // irrelevant to the world-space formula, which uses the pivot's position
    g.setPoseImmediate(vec3(4, 5, 6), qidentity());
    g.linearVelocity.x = 2;
    g.angularVelocity.y = 1; // CCW from above
    // A point one unit east of the pivot's position moves north (-Z) at 1 m/s plus the 2 east.
    expectVecClose(g.velocityAt(vec3(5, 5, 6)), vec3(2, 0, -1));
    expectVecClose(g.velocityAt(vec3(4, 9, 6)), vec3(2, 0, 0)); // on the axis
  });

  it('nested velocity matches a finite difference of the composed motion', () => {
    const w = new World();
    const ship = new StructureGrid(1, w);
    ship.pivot.x = 1.5;
    ship.setPoseImmediate(vec3(30, 48, -12), axisAngle(0.1, 1, 0, 0.5));
    ship.linearVelocity.x = 3;
    ship.linearVelocity.z = -1.5;
    ship.angularVelocity.x = 0.05;
    ship.angularVelocity.y = 0.4;
    const rotor = new StructureGrid(2, ship);
    rotor.pivot.y = 0.5;
    rotor.setPoseImmediate(vec3(2, 5, -1), axisAngle(1, 0, 0, 0.3));
    rotor.angularVelocity.z = 2.5; // spinning in the ship's frame
    rotor.linearVelocity.y = 0.25;
    const local = vec3(0.5, 3.5, 0.5);
    const at = (dt: number): Vec3 => {
      // Advance both poses by dt (constant velocities, exact integration), measure, restore.
      const save = [ship.position, ship.rotation, rotor.position, rotor.rotation].map((o) => ({ ...o }));
      ship.position.x += ship.linearVelocity.x * dt;
      ship.position.y += ship.linearVelocity.y * dt;
      ship.position.z += ship.linearVelocity.z * dt;
      Object.assign(ship.rotation, qintegrate(ship.rotation, ship.angularVelocity, dt));
      rotor.position.x += rotor.linearVelocity.x * dt;
      rotor.position.y += rotor.linearVelocity.y * dt;
      rotor.position.z += rotor.linearVelocity.z * dt;
      Object.assign(rotor.rotation, qintegrate(rotor.rotation, rotor.angularVelocity, dt));
      const p = rotor.toWorld(local);
      Object.assign(ship.position, save[0]);
      Object.assign(ship.rotation, save[1]);
      Object.assign(rotor.position, save[2]);
      Object.assign(rotor.rotation, save[3]);
      return p;
    };
    // Second-order FORWARD difference: qintegrate ignores negative dt (reported), so a
    // central difference would silently freeze the rotations on the backward step.
    const h = 1e-5;
    const p0 = at(0);
    const p1 = at(h);
    const p2 = at(2 * h);
    const fd = vec3(
      (-3 * p0.x + 4 * p1.x - p2.x) / (2 * h),
      (-3 * p0.y + 4 * p1.y - p2.y) / (2 * h),
      (-3 * p0.z + 4 * p1.z - p2.z) / (2 * h),
    );
    const v = rotor.velocityAt(rotor.toWorld(local));
    expectVecClose(v, fd, 5);
  });
});

describe('StructureGrid renderPose', () => {
  it('interpolates between the previous and current pose', () => {
    const g = new StructureGrid(1, new World());
    g.setPoseImmediate(vec3(0, 0, 0), qidentity());
    g.snapshotPose();
    g.position.x = 2;
    Object.assign(g.rotation, qfromYaw(1));
    const r0 = g.renderPose(0);
    const r1 = g.renderPose(1);
    const rh = g.renderPose(0.5);
    expectVecClose(r0.position, vec3(0, 0, 0));
    expectVecClose(r1.position, vec3(2, 0, 0));
    expectVecClose(rh.position, vec3(1, 0, 0));
    expectQuatSame(r0.rotation, qidentity());
    expectQuatSame(r1.rotation, qfromYaw(1));
    expectQuatSame(rh.rotation, qfromYaw(0.5));
    const outP = vec3();
    const outR = quat();
    const r = g.renderPose(1, outP, outR);
    expect(r.position).toBe(outP);
    expect(r.rotation).toBe(outR);
  });

  it('nested: alpha = 1 reproduces toWorld; alpha = 0 reproduces the snapshot pose', () => {
    const w = new World();
    const ship = new StructureGrid(1, w);
    ship.pivot.z = 2;
    ship.setPoseImmediate(vec3(10, 50, 10), axisAngle(0, 1, 0.2, 0.3));
    const rotor = new StructureGrid(2, ship);
    rotor.pivot.x = 0.5;
    rotor.setPoseImmediate(vec3(1, 3, 1), axisAngle(1, 0, 0, 0.5));
    const pts = [vec3(0, 0, 0), vec3(2.5, 1, -3)];
    const prevWorld = pts.map((p) => rotor.toWorld(p));
    // Move both.
    ship.snapshotPose();
    rotor.snapshotPose();
    ship.position.x += 1;
    Object.assign(ship.rotation, qmul(qfromYaw(0.4), ship.rotation));
    Object.assign(rotor.rotation, qmul(axisAngle(1, 0, 0, 0.7), rotor.rotation));
    const toWorldVia = (alpha: number, p: Vec3): Vec3 => {
      const rp = rotor.renderPose(alpha);
      const rel = qrotate(rp.rotation, vec3(p.x - rotor.pivot.x, p.y - rotor.pivot.y, p.z - rotor.pivot.z));
      return vec3(rp.position.x + rel.x, rp.position.y + rel.y, rp.position.z + rel.z);
    };
    pts.forEach((p) => expectVecClose(toWorldVia(1, p), rotor.toWorld(p)));
    pts.forEach((p, i) => expectVecClose(toWorldVia(0, p), prevWorld[i]!));
    expectQuatSame(rotor.renderPose(1).rotation, rotor.worldRotation());
  });
});
