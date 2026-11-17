import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { BLOCKS, OPAQUE, blockDef } from '../../src/blocks/registry';
import { Rng } from '../../src/core/rng';
import { Mesher, buildMesh } from '../../src/mesh/mesher';
import type { MeshData, MeshInput } from '../../src/mesh/types';
import {
  AXIS_NORMALS,
  allQuads,
  checkInsideBox,
  checkInvariants,
  dirOfQuad,
  idx,
  makeInput,
  put,
  quadCount,
  quadsOf,
  uvFrame,
  cross,
  dot,
} from './helpers';

const FACE_CENTER: ReadonlyArray<[number, number, number]> = [
  [1, 0.5, 0.5],
  [0, 0.5, 0.5],
  [0.5, 1, 0.5],
  [0.5, 0, 0.5],
  [0.5, 0.5, 1],
  [0.5, 0.5, 0],
];

describe('single cube', () => {
  const input = makeInput(1, 1, 1);
  put(input, 0, 0, 0, makeCell(B.TNT));
  const mesh = buildMesh(input);
  const quads = quadsOf(mesh.opaque, 'opaque');

  it('emits exactly 6 quads in the opaque group', () => {
    expect(quads.length).toBe(6);
    expect(mesh.cutout).toBeNull();
    expect(mesh.translucent).toBeNull();
    checkInvariants(mesh);
  });

  it('has one quad per direction, on the right plane, with the right tile', () => {
    const tiles = blockDef(B.TNT).tileIds;
    const seen = new Set<number>();
    for (const q of quads) {
      const d = dirOfQuad(q);
      expect(d).toBeGreaterThanOrEqual(0);
      seen.add(d);
      const c = q.p.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4, z: s.z + p.z / 4 }), { x: 0, y: 0, z: 0 });
      expect([c.x, c.y, c.z]).toEqual(FACE_CENTER[d]);
      expect(q.tile).toBe(tiles[d]);
      // all four corners share the tile id
      expect(q.p.length).toBe(4);
    }
    expect(seen.size).toBe(6);
  });

  it('winds every triangle counter-clockwise seen from outside', () => {
    for (const q of quads) {
      for (let t = 0; t < 2; t++) {
        const a = q.p[q.idx[t * 3]!]!;
        const b = q.p[q.idx[t * 3 + 1]!]!;
        const c = q.p[q.idx[t * 3 + 2]!]!;
        const n = cross({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z });
        expect(dot(n, q.n)).toBeGreaterThan(0);
      }
    }
  });

  it('covers the full tile on each face, unmirrored, with documented orientation', () => {
    for (const q of quads) {
      const us = q.uv.map((t) => t[0]).sort();
      const vs = q.uv.map((t) => t[1]).sort();
      expect(us).toEqual([0, 0, 1, 1]);
      expect(vs).toEqual([0, 0, 1, 1]);
      const { du, dv } = uvFrame(q);
      // tile right x tile up points out of the face: not mirrored
      expect(dot(cross(du, dv), q.n)).toBeGreaterThan(0);
      const d = dirOfQuad(q);
      if (d === 2) {
        expect(du).toEqual({ x: 1, y: 0, z: 0 });
        expect(dv).toEqual({ x: 0, y: 0, z: -1 });
      } else if (d === 3) {
        expect(du).toEqual({ x: 1, y: 0, z: 0 });
        expect(dv).toEqual({ x: 0, y: 0, z: 1 });
      } else {
        expect(dv).toEqual({ x: 0, y: 1, z: 0 }); // v grows with +Y on side faces
      }
    }
  });

  it('is fully lit and unoccluded in open space without voxel light', () => {
    for (const q of quads) {
      expect(q.sky).toEqual([255, 255, 255, 255]);
      expect(q.block).toEqual([0, 0, 0, 0]);
      expect(q.ao).toEqual([255, 255, 255, 255]);
      expect(q.flags).toEqual([0, 0, 0, 0]);
    }
  });

  it('uses the end tile only where the block table says so (top/side/bottom blocks)', () => {
    const inp = makeInput(1, 1, 1);
    put(inp, 0, 0, 0, makeCell(B.TURF));
    const qs = allQuads(buildMesh(inp));
    const t = blockDef(B.TURF).tileIds;
    for (const q of qs) expect(q.tile).toBe(t[dirOfQuad(q)]);
  });
});

describe('face culling', () => {
  it('two adjacent cubes share no inner face', () => {
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const) {
      const input = makeInput(2, 2, 2);
      put(input, 0, 0, 0, makeCell(B.STONE));
      put(input, dx, dy, dz, makeCell(B.COBBLE));
      const m = buildMesh(input);
      checkInvariants(m);
      expect(quadCount(m)).toBe(10);
      // no quad lies on the shared plane
      const axis = dx ? 'x' : dy ? 'y' : 'z';
      for (const q of allQuads(m)) {
        const onPlane = q.p.every((p) => p[axis] === 1);
        expect(onPlane).toBe(false);
      }
    }
  });

  it('culls box-border faces against opaque margin cells only', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, 1, 0, 0, makeCell(B.STONE)); // margin +X: opaque
    put(input, -1, 0, 0, makeCell(B.GLASS)); // margin -X: transparent
    put(input, 0, 1, 0, makeCell(B.WATER)); // margin +Y: liquid
    put(input, 0, -1, 0, makeCell(B.DEEPROCK)); // margin -Y: opaque
    const m = buildMesh(input);
    const dirs = allQuads(m).map(dirOfQuad).sort();
    expect(dirs).toEqual([1, 2, 4, 5]);
    // margin cells are never meshed themselves
    expect(quadCount(m)).toBe(4);
  });

  it('keeps faces against non-opaque neighbours of another kind', () => {
    const input = makeInput(2, 1, 1);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, 1, 0, 0, makeCell(B.GLASS));
    const m = buildMesh(input);
    const stone = quadsOf(m.opaque, 'opaque');
    const glass = quadsOf(m.cutout, 'cutout');
    expect(stone.length).toBe(6); // its +X face is seen through the glass
    expect(glass.length).toBe(5); // the glass face against stone is hidden
    expect(glass.some((q) => dirOfQuad(q) === 1)).toBe(false);
  });

  it('culls shared faces between identical glass, ice and leaves, but not between different kinds', () => {
    for (const id of [B.GLASS, B.ICE, B.LEAVES_OAK]) {
      const input = makeInput(2, 1, 1);
      put(input, 0, 0, 0, makeCell(id));
      put(input, 1, 0, 0, makeCell(id));
      expect(quadCount(buildMesh(input))).toBe(10);
    }
    const input = makeInput(2, 1, 1);
    put(input, 0, 0, 0, makeCell(B.GLASS));
    put(input, 1, 0, 0, makeCell(B.ICE));
    expect(quadCount(buildMesh(input))).toBe(12);
    // leaves keep faces against air and against other non-opaque cells
    const l = makeInput(1, 1, 1);
    put(l, 0, 0, 0, makeCell(B.LEAVES_PINE));
    put(l, 1, 0, 0, makeCell(B.GLASS));
    put(l, 0, 1, 0, makeCell(B.LEAVES_OAK));
    expect(quadCount(buildMesh(l))).toBe(6);
  });

  it('routes faces to the group of BlockDef.layer', () => {
    const input = makeInput(3, 1, 1);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, 1, 0, 0, makeCell(B.LEAVES_OAK));
    put(input, 2, 0, 0, makeCell(B.ICE));
    const m = buildMesh(input);
    expect(quadsOf(m.opaque, 'opaque').every((q) => q.p.every((p) => p.x <= 1))).toBe(true);
    expect(quadsOf(m.cutout, 'cutout').every((q) => q.p.every((p) => p.x >= 1 && p.x <= 2))).toBe(true);
    expect(quadsOf(m.translucent, 'translucent').every((q) => q.p.every((p) => p.x >= 2))).toBe(true);
  });

  it('hides the face under a snow cover slab', () => {
    const input = makeInput(1, 2, 1);
    put(input, 0, 0, 0, makeCell(B.STONE));
    put(input, 0, 1, 0, makeCell(B.SNOW_LAYER, 0));
    const m = buildMesh(input);
    const stoneTop = allQuads(m).filter((q) => dirOfQuad(q) === 2 && q.p.every((p) => p.y === 1));
    expect(stoneTop.length).toBe(0);
  });

  it('marks light-emitting cubes emissive', () => {
    const input = makeInput(1, 1, 1);
    put(input, 0, 0, 0, makeCell(B.LAMP));
    for (const q of allQuads(buildMesh(input))) expect(q.flags).toEqual([1, 1, 1, 1]);
  });

  it('draws nothing for air, unknown ids and the unloaded sentinel', () => {
    const input = makeInput(3, 1, 1);
    put(input, 0, 0, 0, makeCell(B.UNLOADED));
    put(input, 1, 0, 0, makeCell(999)); // unregistered id
    put(input, 2, 0, 0, makeCell(B.AIR));
    const m = buildMesh(input);
    expect(m).toEqual({ opaque: null, cutout: null, translucent: null });
  });
});

describe('robustness', () => {
  it('rejects inputs whose arrays do not match the dimensions', () => {
    const bad: MeshInput = { sx: 2, sy: 2, sz: 2, cells: new Uint16Array(10), light: null };
    expect(() => buildMesh(bad)).toThrow(RangeError);
    const badLight: MeshInput = { sx: 1, sy: 1, sz: 1, cells: new Uint16Array(27), light: new Uint8Array(3) };
    expect(() => buildMesh(badLight)).toThrow(RangeError);
  });

  it('handles an empty box', () => {
    expect(buildMesh(makeInput(0, 0, 0))).toEqual({ opaque: null, cutout: null, translucent: null });
    expect(buildMesh(makeInput(16, 16, 16, true))).toEqual({ opaque: null, cutout: null, translucent: null });
  });

  it('meshes every registered block in every state without breaking invariants', () => {
    for (const def of BLOCKS) {
      if (!def) continue;
      for (let state = 0; state < 64; state++) {
        for (const support of [B.STONE, B.AIR]) {
          const input = makeInput(1, 1, 1, true);
          put(input, 0, 0, 0, makeCell(def.id, state));
          put(input, 0, -1, 0, makeCell(support)); // margin cell: never meshed itself
          const m = buildMesh(input);
          checkInvariants(m);
          checkInsideBox(m, 0, 1);
        }
      }
    }
  });
});

describe('determinism and reuse', () => {
  function randomInput(seed: number, n = 12): MeshInput {
    const rng = new Rng(seed);
    const ids = [B.AIR, B.AIR, B.AIR, B.STONE, B.GLASS, B.WATER, B.LOG_OAK, B.TALL_GRASS, B.TORCH, B.SNOW_LAYER, B.CACTUS, B.HELM, B.PROPELLER, B.BEARING, B.LAVA, B.LEAVES_OAK];
    const input = makeInput(n, n, n, true);
    for (let i = 0; i < input.cells.length; i++) {
      input.cells[i] = makeCell(ids[rng.int(0, ids.length - 1)]!, rng.int(0, 63));
      input.light![i] = rng.int(0, 255);
    }
    return input;
  }

  it('returns identical output for identical input', () => {
    const a = buildMesh(randomInput(7));
    const b = buildMesh(randomInput(7));
    expect(a).toEqual(b);
    checkInvariants(a);
  });

  it('a reused Mesher gives the same results as fresh ones, in any order, without aliasing', () => {
    const mesher = new Mesher();
    const inputs = [randomInput(1), randomInput(2, 5), randomInput(3, 16)];
    const fresh = inputs.map((i) => buildMesh(i));
    const first = inputs.map((i) => mesher.build(i));
    const second = [...inputs].reverse().map((i) => mesher.build(i)).reverse();
    expect(first).toEqual(fresh);
    expect(second).toEqual(fresh);
    // outputs are exact-size copies: no shared buffers between results
    const buffers = new Set<ArrayBufferLike>();
    for (const m of [...first, ...second]) {
      for (const g of [m.opaque, m.cutout, m.translucent]) {
        if (!g) continue;
        for (const a of [g.positions, g.normals, g.uvs, g.layers, g.light, g.indices]) {
          expect(a.byteLength).toBe(a.buffer.byteLength);
          expect(buffers.has(a.buffer)).toBe(false);
          buffers.add(a.buffer);
        }
      }
    }
  });

  it('does not modify its input', () => {
    const input = randomInput(11);
    const cells = input.cells.slice();
    const light = input.light!.slice();
    buildMesh(input);
    expect(input.cells).toEqual(cells);
    expect(input.light).toEqual(light);
  });
});

describe('fuzz: emitted cube faces equal a brute-force count of visible faces', () => {
  const CUBES: readonly number[] = [B.STONE, B.DIRT, B.GLASS, B.ICE, B.LEAVES_OAK, B.LEAVES_PINE, B.LOG_PINE, B.BEARING, B.PLANKS_OAK];
  const NON_CUBES: readonly number[] = [B.AIR, B.WATER, B.TALL_GRASS, B.TORCH];
  const SELF_CULL = new Set<number>([B.GLASS, B.ICE, B.LEAVES_OAK, B.LEAVES_PINE]);
  const OFFS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const;

  function bruteForce(input: MeshInput): Record<'opaque' | 'cutout' | 'translucent', number> {
    const out = { opaque: 0, cutout: 0, translucent: 0 };
    for (let y = 0; y < input.sy; y++) {
      for (let z = 0; z < input.sz; z++) {
        for (let x = 0; x < input.sx; x++) {
          const id = input.cells[idx(input, x, y, z)]! & 0x3ff;
          if (!CUBES.includes(id)) continue;
          for (const [dx, dy, dz] of OFFS) {
            const nid = input.cells[idx(input, x + dx, y + dy, z + dz)]! & 0x3ff;
            if (OPAQUE[nid]) continue;
            if (SELF_CULL.has(id) && nid === id) continue;
            out[blockDef(id).layer]++;
          }
        }
      }
    }
    return out;
  }

  it('matches on 40 random boxes (including the margin)', () => {
    const rng = new Rng(1234);
    for (let t = 0; t < 40; t++) {
      const sx = rng.int(1, 9);
      const sy = rng.int(1, 9);
      const sz = rng.int(1, 9);
      const input = makeInput(sx, sy, sz, rng.chance(0.5) ? true : false);
      const density = rng.next();
      for (let i = 0; i < input.cells.length; i++) {
        if (rng.next() < density) input.cells[i] = makeCell(CUBES[rng.int(0, CUBES.length - 1)]!, rng.int(0, 7));
        else input.cells[i] = makeCell(NON_CUBES[rng.int(0, NON_CUBES.length - 1)]!, 0);
      }
      // Count only cube faces: drop the non-cube cells' own geometry by comparing per group
      // after replacing non-cube interior cells with air in a twin input.
      const twin: MeshInput = { ...input, cells: input.cells.slice() };
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          for (let x = 0; x < sx; x++) {
            const i = idx(twin, x, y, z);
            if (!CUBES.includes(twin.cells[i]! & 0x3ff)) twin.cells[i] = 0;
          }
        }
      }
      // Air and the original non-cube cells are both non-opaque and never self-cull with a
      // cube, so visibility of cube faces is identical in both inputs.
      const m: MeshData = buildMesh(twin);
      checkInvariants(m);
      const expected = bruteForce(input);
      expect({
        opaque: m.opaque ? m.opaque.vertexCount / 4 : 0,
        cutout: m.cutout ? m.cutout.vertexCount / 4 : 0,
        translucent: m.translucent ? m.translucent.vertexCount / 4 : 0,
      }).toEqual(expected);
      // and every emitted face is axis aligned
      for (const q of allQuads(m)) expect(AXIS_NORMALS.some((a) => a.join() === q.nb.join())).toBe(true);
    }
  });
});
