/**
 * The shared mesh invariant check (helpers.ts checkInvariants) itself: every triangle must have
 * strictly positive area around its normal; only with the `paddedTriangles` option, and only in the
 * one form the liquid emitter writes for a clipped triangle (docs/SHAPES.md 8.4, 19.6), is a
 * zero-area triangle accepted. Hand-made geometry, one quad each.
 */
import { describe, expect, it } from 'vitest';
import type { GeometryData, MeshData } from '../../src/mesh/types';
import { checkInvariants } from './helpers';

const UP: [number, number, number] = [0, 127, 0];
const DIAG02 = [0, 1, 2, 0, 2, 3];
const DIAG13 = [1, 2, 3, 1, 3, 0];

/** One quad (4 corners, x y z each) facing +Y, in the given draw group. */
function mesh(positions: number[], indices = DIAG02, group: keyof MeshData = 'translucent'): MeshData {
  const normals = new Int8Array(12);
  for (let i = 0; i < 4; i++) normals.set(UP, i * 3);
  const g: GeometryData = {
    vertexCount: 4,
    indexCount: 6,
    positions: new Float32Array(positions),
    normals,
    uvs: new Float32Array(8),
    layers: new Uint16Array(4),
    light: new Uint8Array(16),
    indices: new Uint32Array(indices),
  };
  const m: MeshData = { opaque: null, cutout: null, translucent: null };
  m[group] = g;
  return m;
}

const accepts = (m: MeshData, padded: boolean): boolean => {
  try {
    checkInvariants(m, { paddedTriangles: padded });
    return true;
  } catch {
    return false;
  }
};

// Corners counter-clockwise seen from above (+Y): (0,0,1) (1,0,1) (1,0,0) (0,0,0).
const A = [0, 0, 1];
const Bc = [1, 0, 1];
const C = [1, 0, 0];
const D = [0, 0, 0];

describe('checkInvariants: zero-area triangles', () => {
  it('a proper quad passes with and without the option, in either diagonal', () => {
    for (const idx of [DIAG02, DIAG13]) {
      expect(accepts(mesh([...A, ...Bc, ...C, ...D], idx), false)).toBe(true);
      expect(accepts(mesh([...A, ...Bc, ...C, ...D], idx), true)).toBe(true);
    }
  });

  it('a triangle with its last corner repeated (front copy) or corners 1 and 2 equal (back copy) passes only with the option', () => {
    const front = [...A, ...Bc, ...C, ...C];
    // The back copy of the front piece: corners written 0,3,2,1.
    const back = [...A, ...C, ...C, ...Bc];
    for (const idx of [DIAG02, DIAG13]) {
      expect(accepts(mesh(front, idx), false)).toBe(false);
      expect(accepts(mesh(front, idx), true)).toBe(true);
    }
    // The back copy is wound the other way: seen with a -Y normal it is counter-clockwise.
    const m = mesh(back);
    m.translucent!.normals.fill(0);
    for (let i = 0; i < 4; i++) m.translucent!.normals[i * 3 + 1] = -127;
    expect(accepts(m, false)).toBe(false);
    expect(accepts(m, true)).toBe(true);
  });

  it('other coinciding pairs, collinear corners, clockwise triangles and degenerate quads are rejected even with the option', () => {
    // Corners 0 and 1 coincide; corners 0 and 3 coincide: forms the emitter never writes.
    expect(accepts(mesh([...A, ...A, ...C, ...D]), true)).toBe(false);
    expect(accepts(mesh([...A, ...Bc, ...C, ...A]), true)).toBe(false);
    // Three collinear points with the last repeated: both triangles have zero area.
    expect(accepts(mesh([0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1, 0, 0]), true)).toBe(false);
    // The real triangle clockwise around the normal.
    expect(accepts(mesh([...D, ...C, ...Bc, ...Bc]), true)).toBe(false);
    // All corners equal; two pairs equal (a segment).
    expect(accepts(mesh([...D, ...D, ...D, ...D]), true)).toBe(false);
    expect(accepts(mesh([...D, ...D, ...C, ...C]), true)).toBe(false);
  });
});
