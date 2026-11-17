import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { axisState, facingState, makeCell, cellState, stateAxis, stateFacing } from '../../src/blocks/cell';
import { World } from '../../src/voxel/world';
import { StructureGrid } from '../../src/voxel/sgrid';
import { analyzeHull, dryMask, hullKindAt, isDryCell, displacesWater, HULL_BILGE, HULL_OPEN, HULL_SEALED, HULL_SOLID } from '../../src/structures/hull';
import { nearestRot, rotCell, rotCellPos, rotCompose, rotDir, rotEquals, rotInverse, rotToQuat, rotVec, ROT_IDENTITY, type GridRot } from '../../src/structures/orient';
import { qfromAxisAngle, qmul, qrotate, vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import type { Dir } from '../../src/core/dirs';

function boat(w: number, h: number, d: number, id: number): StructureGrid {
  const g = new StructureGrid(1, new World(0));
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) {
    const wall = x === 0 || z === 0 || x === w - 1 || z === d - 1 || y === 0;
    if (wall) g.setCell(x - 3, y + 10, z - 2, makeCell(id));
  }
  return g;
}

describe('hull analysis', () => {
  it('open boat: hold cells are bilge up to the rim, floats when light', () => {
    const g = boat(5, 3, 7, B.PLANKS_OAK);
    const h = analyzeHull(g)!;
    expect(h.solidCount).toBe(5 * 7 * 3 - 3 * 5 * 2);
    expect(h.bilgeCount).toBe(3 * 5 * 2);
    expect(h.sealedCount).toBe(0);
    expect(hullKindAt(h, -2, 11, -1)).toBe(HULL_BILGE);
    expect(hullKindAt(h, -2, 12, -1)).toBe(HULL_BILGE);
    expect(hullKindAt(h, -2, 13, -1)).toBe(HULL_OPEN); // above the rim
    expect(hullKindAt(h, -3, 10, -2)).toBe(HULL_SOLID);
    expect(hullKindAt(h, 100, 0, 0)).toBe(HULL_OPEN);
    expect(h.floats).toBe(true);
    expect(isDryCell(h, -2, 11, -1)).toBe(true);
    expect(displacesWater(h, -3, 10, -2)).toBe(true);
    expect(h.mass).toBeCloseTo(h.solidCount * 0.5);
    expect(h.com.x).toBeCloseTo(-3 + 2.5);
    expect(h.com.z).toBeCloseTo(-2 + 3.5);
    const mask = dryMask(h)!;
    expect(mask.reduce((a, b) => a + b, 0)).toBe(30);
  });
  it('a hole in the side floods the hold down to the hole level', () => {
    const g = boat(5, 3, 7, B.PLANKS_OAK);
    g.setCell(-3, 11, 0, 0); // hole in the wall at the lowest hold level
    const h = analyzeHull(g)!;
    expect(h.bilgeCount).toBe(0);
    g.setCell(-3, 11, 0, makeCell(B.PLANKS_OAK));
    g.setCell(-3, 12, 0, 0); // hole one level up: lower hold level still protected
    const h2 = analyzeHull(g)!;
    expect(h2.bilgeCount).toBe(15);
    expect(hullKindAt(h2, -2, 11, -1)).toBe(HULL_BILGE);
    expect(hullKindAt(h2, -2, 12, -1)).toBe(HULL_OPEN);
  });
  it('sealed cavity is always dry; heavy open hull does not float', () => {
    const g = new StructureGrid(1, new World(0));
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
      if (x === 1 && y === 1 && z === 1) continue;
      g.setCell(x, y, z, makeCell(B.IRON_BLOCK));
    }
    const h = analyzeHull(g)!;
    expect(h.sealedCount).toBe(1);
    expect(hullKindAt(h, 1, 1, 1)).toBe(HULL_SEALED);
    expect(h.floats).toBe(false);
    expect(isDryCell(h, 1, 1, 1)).toBe(true);
    const stone = boat(3, 2, 3, B.STONE); // 1 bilge cell, 17 stone
    const hs = analyzeHull(stone)!;
    expect(hs.bilgeCount).toBe(1);
    expect(hs.floats).toBe(false);
    expect(isDryCell(hs, -2, 11, -1)).toBe(false);
    expect(dryMask(hs)).toBeNull();
  });
  it('inertia of a single cube and of a bar', () => {
    const g = new StructureGrid(1, new World(0));
    g.setCell(0, 0, 0, makeCell(B.STONE));
    const h = analyzeHull(g)!;
    expect(h.inertia[0]).toBeCloseTo(2.6 / 6);
    for (let x = 1; x < 10; x++) g.setCell(x, 0, 0, makeCell(B.STONE));
    const hb = analyzeHull(g)!;
    // bar along x: Iyy ~ m L^2 / 12 (+ cube term)
    const m = 26;
    expect(hb.inertia[4]).toBeCloseTo(m * (100 - 1) / 12 + m / 6, 5);
    expect(hb.inertia[0]).toBeCloseTo(m / 6, 5);
  });
});

describe('grid rotations', () => {
  const all: GridRot[] = [];
  for (let ax = 0; ax < 6; ax++) for (let ay = 0; ay < 6; ay++) {
    if (ax >> 1 === ay >> 1) continue;
    const q = { ax: ax as Dir, ay: ay as Dir, az: 0 as Dir };
    // az = ax × ay
    const v = rotVec({ ax: 0, ay: 2, az: 4 }, 0, 0, 0);
    void v;
    const X = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const a = X[ax]!, b = X[ay]!;
    const c = [a[1]!*b[2]!-a[2]!*b[1]!, a[2]!*b[0]!-a[0]!*b[2]!, a[0]!*b[1]!-a[1]!*b[0]!];
    const az = X.findIndex((e) => e[0] === c[0] && e[1] === c[1] && e[2] === c[2]) as Dir;
    all.push({ ...q, az });
  }
  it('there are 24 and each round-trips through quaternions', () => {
    expect(all.length).toBe(24);
    for (const r of all) {
      const q = rotToQuat(r);
      expect(rotEquals(nearestRot(q), r)).toBe(true);
      const v = qrotate(q, vec3(1, 2, 3));
      const w = rotVec(r, 1, 2, 3);
      expect(v.x).toBeCloseTo(w.x); expect(v.y).toBeCloseTo(w.y); expect(v.z).toBeCloseTo(w.z);
      expect(rotEquals(rotCompose(r, rotInverse(r)), ROT_IDENTITY)).toBe(true);
      expect(rotEquals(rotCompose(rotInverse(r), r), ROT_IDENTITY)).toBe(true);
    }
  });
  it('nearestRot snaps perturbed rotations', () => {
    const rng = new Rng(7);
    for (const r of all) {
      const axis = vec3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const l = Math.hypot(axis.x, axis.y, axis.z);
      axis.x /= l; axis.y /= l; axis.z /= l;
      const q = qmul(qfromAxisAngle(axis, rng.range(-0.35, 0.35)), rotToQuat(r));
      expect(rotEquals(nearestRot(q), r)).toBe(true);
    }
  });
  it('rotates block states and cell positions', () => {
    const yaw90: GridRot = nearestRot(qfromAxisAngle(vec3(0, 1, 0), Math.PI / 2)); // +X -> -Z
    expect(rotDir(yaw90, 0)).toBe(5);
    expect(stateAxis(cellState(rotCell(yaw90, makeCell(B.LOG_OAK, axisState(0)))))).toBe(2);
    expect(stateAxis(cellState(rotCell(yaw90, makeCell(B.LOG_OAK, axisState(1)))))).toBe(1);
    expect(stateFacing(cellState(rotCell(yaw90, makeCell(B.BEARING, facingState(4)))))).toBe(0);
    expect(rotCell(yaw90, makeCell(B.STONE))).toBe(makeCell(B.STONE));
    // cell (2,0,0) about pivot (0.5,0.5,0.5) placed at (10.5, 5.5, 10.5): +X offset 2 -> -Z offset 2
    const p = rotCellPos(yaw90, 2, 0, 0, vec3(0.5, 0.5, 0.5), vec3(10.5, 5.5, 10.5));
    expect(p).toEqual({ x: 10, y: 5, z: 8 });
  });
});
