import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { AO_BYTE, buildMesh } from '../../src/mesh/mesher';
import type { MeshInput } from '../../src/mesh/types';
import { allQuads, checkInvariants, cornerAt, diagonalOf, dirOfQuad, makeInput, put, putLight, type Quad } from './helpers';

/**
 * Scene: a floor cube at (1,0,1) inside a 3x2x3 box. Its top face has corners
 * A = (1,1,1), B = (2,1,1), C = (2,1,2), D = (1,1,2). The layer above it (y = 1) holds the
 * cells whose occupancy decides AO and smooth light. Corner A touches the cells
 * (0,1,0) [diagonal], (1,1,0) [side -z], (0,1,1) [side -x] and (1,1,1) [straight above].
 */
function floorScene(light: boolean | number = false): MeshInput {
  const input = makeInput(3, 2, 3, light);
  put(input, 1, 0, 1, makeCell(B.STONE));
  return input;
}

function floorTop(input: MeshInput): Quad {
  const q = allQuads(buildMesh(input)).find(
    (q) => dirOfQuad(q) === 2 && q.p.every((p) => p.y === 1 && p.x >= 1 && p.x <= 2 && p.z >= 1 && p.z <= 2),
  );
  if (!q) throw new Error('floor top face missing');
  return q;
}

function aoAt(q: Quad, x: number, z: number): number {
  const k = cornerAt(q, x, 1, z);
  expect(k).toBeGreaterThanOrEqual(0);
  return q.ao[k]!;
}
function skyAt(q: Quad, x: number, z: number): number {
  return q.sky[cornerAt(q, x, 1, z)]!;
}
function blockAt(q: Quad, x: number, z: number): number {
  return q.block[cornerAt(q, x, 1, z)]!;
}

describe('ambient occlusion', () => {
  it('maps levels to the documented bytes', () => {
    expect(AO_BYTE).toEqual([102, 153, 204, 255]);
  });

  it('open floor is unoccluded', () => {
    const q = floorTop(floorScene());
    expect(q.ao).toEqual([255, 255, 255, 255]);
  });

  it('one side neighbour darkens the two corners it touches by one level', () => {
    const s = floorScene();
    put(s, 0, 1, 1, makeCell(B.STONE)); // -x side of the face
    const q = floorTop(s);
    expect(aoAt(q, 1, 1)).toBe(204);
    expect(aoAt(q, 1, 2)).toBe(204);
    expect(aoAt(q, 2, 1)).toBe(255);
    expect(aoAt(q, 2, 2)).toBe(255);
  });

  it('a diagonal corner neighbour darkens only its corner by one level', () => {
    const s = floorScene();
    put(s, 0, 1, 0, makeCell(B.STONE));
    const q = floorTop(s);
    expect(aoAt(q, 1, 1)).toBe(204);
    expect([aoAt(q, 2, 1), aoAt(q, 2, 2), aoAt(q, 1, 2)]).toEqual([255, 255, 255]);
  });

  it('side + corner = two levels', () => {
    const s = floorScene();
    put(s, 0, 1, 1, makeCell(B.STONE));
    put(s, 0, 1, 0, makeCell(B.STONE));
    expect(aoAt(floorTop(s), 1, 1)).toBe(153);
  });

  it('both sides blocked = fully occluded, with or without the corner', () => {
    for (const withCorner of [false, true]) {
      const s = floorScene();
      put(s, 0, 1, 1, makeCell(B.STONE));
      put(s, 1, 1, 0, makeCell(B.STONE));
      if (withCorner) put(s, 0, 1, 0, makeCell(B.STONE));
      const q = floorTop(s);
      expect(aoAt(q, 1, 1)).toBe(102);
      expect(aoAt(q, 2, 1)).toBe(204);
      expect(aoAt(q, 1, 2)).toBe(204);
      expect(aoAt(q, 2, 2)).toBe(255);
    }
  });

  it('only OPAQUE cubes cast AO (glass, leaves, water, plants do not)', () => {
    for (const id of [B.GLASS, B.LEAVES_OAK, B.WATER, B.TALL_GRASS, B.CACTUS, B.HELM]) {
      const s = floorScene();
      put(s, 0, 1, 1, makeCell(id));
      put(s, 1, 1, 0, makeCell(id));
      put(s, 0, 1, 0, makeCell(id));
      expect(floorTop(s).ao, `id ${id}`).toEqual([255, 255, 255, 255]);
    }
  });

  it('is computed even without voxel light (structures), which then reads full sky', () => {
    const s = floorScene(false);
    put(s, 0, 1, 1, makeCell(B.PLANKS_OAK));
    put(s, 1, 1, 0, makeCell(B.PLANKS_OAK));
    const q = floorTop(s);
    expect(aoAt(q, 1, 1)).toBe(102);
    expect(q.sky).toEqual([255, 255, 255, 255]);
    expect(q.block).toEqual([0, 0, 0, 0]);
  });

  it('works on side faces and across the box margin', () => {
    // A cube at the -x border of the box; its -x face looks into the margin, where an
    // opaque cell above-left occludes the top corners of that face.
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, -1, 1, 0, makeCell(B.STONE));
    const q = allQuads(buildMesh(input)).find((q) => dirOfQuad(q) === 1)!;
    expect(q.ao[cornerAt(q, 0, 1, 0)]).toBe(204);
    expect(q.ao[cornerAt(q, 0, 1, 1)]).toBe(204);
    expect(q.ao[cornerAt(q, 0, 0, 0)]).toBe(255);
    expect(q.ao[cornerAt(q, 0, 0, 1)]).toBe(255);
  });
});

describe('smooth lighting', () => {
  it('averages the four cells around each vertex in the layer outside the face', () => {
    const s = floorScene(0);
    putLight(s, 1, 1, 1, 15, 0); // straight above
    putLight(s, 0, 1, 1, 11, 4);
    putLight(s, 1, 1, 0, 7, 0);
    putLight(s, 0, 1, 0, 3, 0);
    const q = floorTop(s);
    expect(skyAt(q, 1, 1)).toBe(Math.round(((15 + 11 + 7 + 3) / 4) * 17));
    expect(blockAt(q, 1, 1)).toBe(17);
    // corner C touches (1,1,1) and three cells with light 0
    expect(skyAt(q, 2, 2)).toBe(Math.round((15 / 4) * 17));
  });

  it('rounds the scaled average', () => {
    const s = floorScene(0xf0);
    putLight(s, 0, 1, 0, 14, 0);
    expect(skyAt(floorTop(s), 1, 1)).toBe(Math.round(((15 * 3 + 14) / 4) * 17)); // 251
  });

  it('skips opaque cells instead of averaging in their (dark) stored light', () => {
    const s = floorScene(0xc0); // sky 12 everywhere
    put(s, 0, 1, 1, makeCell(B.STONE));
    putLight(s, 0, 1, 1, 0, 0);
    expect(skyAt(floorTop(s), 1, 1)).toBe(12 * 17);
  });

  it('ignores the diagonal cell when both sides are opaque (no leak through diagonal walls)', () => {
    const s = floorScene(0);
    put(s, 0, 1, 1, makeCell(B.STONE));
    put(s, 1, 1, 0, makeCell(B.STONE));
    putLight(s, 1, 1, 1, 5, 0);
    putLight(s, 0, 1, 0, 15, 15); // bright cell behind the diagonal wall
    const q = floorTop(s);
    expect(skyAt(q, 1, 1)).toBe(5 * 17);
    expect(blockAt(q, 1, 1)).toBe(0);
  });

  it('copies uniform light exactly and keeps sky and block channels apart', () => {
    const s = floorScene((9 << 4) | 6);
    const q = floorTop(s);
    expect(q.sky).toEqual([153, 153, 153, 153]);
    expect(q.block).toEqual([102, 102, 102, 102]);
    checkInvariants(buildMesh(s));
  });
});

describe('diagonal flip', () => {
  it('splits along the brighter diagonal by AO, isolating a lone dark corner', () => {
    const s = floorScene();
    put(s, 0, 1, 0, makeCell(B.STONE)); // darkens corner A only
    const q = floorTop(s);
    const kDark = cornerAt(q, 1, 1, 1);
    expect(diagonalOf(q)).toBe(kDark % 2 === 0 ? '13' : '02');
    // the dark corner is used by exactly one triangle
    expect(q.idx.filter((v) => v === kDark).length).toBe(1);
  });

  it('a lone dark corner on the other diagonal flips the split the other way', () => {
    const s = floorScene();
    put(s, 2, 1, 0, makeCell(B.STONE)); // darkens corner B = (2,1,1) only
    const q = floorTop(s);
    const kDark = cornerAt(q, 2, 1, 1);
    expect(diagonalOf(q)).toBe(kDark % 2 === 0 ? '13' : '02');
  });

  it('breaks AO ties by light: the bright corner sits on the shared diagonal', () => {
    const s = floorScene(0x30);
    putLight(s, 2, 1, 2, 15, 0);
    const q = floorTop(s);
    const kBright = cornerAt(q, 2, 1, 2);
    expect(q.sky[kBright]).toBeGreaterThan(q.sky[(kBright + 1) % 4]!);
    expect(diagonalOf(q)).toBe(kBright % 2 === 0 ? '02' : '13');
  });

  it('every flipped quad keeps counter-clockwise winding', () => {
    const s = floorScene();
    put(s, 0, 1, 0, makeCell(B.STONE));
    put(s, 2, 1, 2, makeCell(B.STONE));
    put(s, 2, 1, 0, makeCell(B.STONE));
    checkInvariants(buildMesh(s));
  });
});
