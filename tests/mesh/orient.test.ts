import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { axisState, facingState, makeCell } from '../../src/blocks/cell';
import { blockDef } from '../../src/blocks/registry';
import type { Axis, Dir } from '../../src/core/dirs';
import { buildMesh } from '../../src/mesh/mesher';
import { allQuads, checkInvariants, cross, dirOfQuad, dot, makeInput, put, uvFrame, type V3 } from './helpers';

const DIR_VEC: readonly V3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

function single(cell: number) {
  const input = makeInput(1, 1, 1);
  put(input, 0, 0, 0, cell);
  const m = buildMesh(input);
  checkInvariants(m);
  return allQuads(m);
}

describe('logs (stateKind axis)', () => {
  const [side, end] = blockDef(B.LOG_OAK).tileIds as [number, number];

  for (const axis of [0, 1, 2] as Axis[]) {
    it(`axis ${'xyz'[axis]}: end tiles on the two axis faces, bark grain along the axis`, () => {
      const quads = single(makeCell(B.LOG_OAK, axisState(axis)));
      expect(quads.length).toBe(6);
      for (const q of quads) {
        const d = dirOfQuad(q);
        const { du, dv } = uvFrame(q);
        expect(dot(cross(du, dv), q.n)).toBeGreaterThan(0); // never mirrored
        if (d >> 1 === axis) {
          expect(q.tile).toBe(end);
        } else {
          expect(q.tile).toBe(side);
          // the tile's v direction (grain) is parallel to the log axis
          const along = [dv.x, dv.y, dv.z][axis]!;
          expect(Math.abs(along)).toBeCloseTo(1, 6);
          expect(Math.abs(dv.x) + Math.abs(dv.y) + Math.abs(dv.z)).toBeCloseTo(1, 6);
        }
      }
    });
  }
});

describe('bearing (stateKind facing)', () => {
  const [front, back, side] = blockDef(B.BEARING).tileIds as [number, number, number];

  for (const f of [0, 1, 2, 3, 4, 5] as Dir[]) {
    it(`facing ${f}: front on the facing face, back opposite, side tiles point to the front`, () => {
      const quads = single(makeCell(B.BEARING, facingState(f)));
      expect(quads.length).toBe(6);
      for (const q of quads) {
        const d = dirOfQuad(q);
        const { du, dv } = uvFrame(q);
        expect(dot(cross(du, dv), q.n)).toBeGreaterThan(0);
        if (d === f) expect(q.tile).toBe(front);
        else if (d === (f ^ 1)) expect(q.tile).toBe(back);
        else {
          expect(q.tile).toBe(side);
          // tile "up" (v) points toward the front face
          const fv = DIR_VEC[f]!;
          expect(dv.x).toBeCloseTo(fv.x, 6);
          expect(dv.y).toBeCloseTo(fv.y, 6);
          expect(dv.z).toBeCloseTo(fv.z, 6);
        }
      }
    });
  }

  it('is an opaque full cube that hides its neighbours', () => {
    const input = makeInput(2, 1, 1);
    put(input, 0, 0, 0, makeCell(B.BEARING, facingState(0)));
    put(input, 1, 0, 0, makeCell(B.STONE));
    expect(allQuads(buildMesh(input)).length).toBe(10);
  });
});
