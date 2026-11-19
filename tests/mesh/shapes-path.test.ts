/**
 * Which path a face takes (docs/SHAPES.md 8.2): a face whose own cell and whose nine cells in front
 * are all without parts is M1's face, byte for byte, even when partial cells exist elsewhere in the
 * same job; and jobs without layers are M1's mesher as a whole.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { Rng } from '../../src/core/rng';
import { buildMesh } from '../../src/mesh/mesher';
import type { MeshData, MeshInput } from '../../src/mesh/types';
import { LOWER, slab } from '../shapes';
import { allQuads, dirOfQuad, makeInput, put, type Quad } from './helpers';
import { boxFaceKey, faceKey, isPartial, ownerCell, packedAt, putParts, randomPartialCell } from './shape-helpers';

const OFF: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function isCube(id: number): boolean {
  const d = BLOCKS[id];
  return d !== undefined && (d.shape === 'cube' || d.shape === 'bearing');
}

/** The face (x, y, z, d) of a whole cell has no partial cell among itself and its nine cells in front. */
function windowClear(input: MeshInput, x: number, y: number, z: number, d: number): boolean {
  if (isPartial(packedAt(input, x, y, z))) return false;
  const a = d >> 1;
  const ta = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const t = [...OFF[d]!];
      t[ta[0]!] = i;
      t[ta[1]!] = j;
      if (isPartial(packedAt(input, x + t[0]!, y + t[1]!, z + t[2]!))) return false;
    }
  }
  return true;
}

/** Every byte a quad carries (vertex order included). */
function bytesOf(q: Quad): string {
  return JSON.stringify([q.group, q.p, q.nb, q.uv, q.tile, q.sky, q.block, q.ao, q.flags, q.idx]);
}

/** In output order: the quads of whole-cube faces whose window is clear, as byte records. */
function clearFaceQuads(input: MeshInput, m: MeshData): string[] {
  const out: string[] = [];
  for (const q of allQuads(m)) {
    const d = dirOfQuad(q);
    if (d < 0) continue;
    const [x, y, z] = ownerCell(q);
    if (faceKey(q) !== boxFaceKey(d, x, y, z, 1)) continue;
    const c = packedAt(input, x, y, z);
    if (isPartial(c) || !isCube(c & ID_MASK) || !windowClear(input, x, y, z, d)) continue;
    out.push(`${x},${y},${z},${d} ${bytesOf(q)}`);
  }
  return out;
}

const CUBES = [B.STONE, B.DIRT, B.TURF, B.GLASS, B.ICE, B.LEAVES_OAK, B.LOG_OAK, B.BEARING, B.LAMP, B.PLANKS_OAK];
const MODELS = [B.TORCH, B.TALL_GRASS, B.SNOW_LAYER, B.CACTUS, B.HELM, B.PROPELLER];

function scene(rng: Rng, partialShare: number): MeshInput {
  const input = makeInput(rng.int(2, 9), rng.int(2, 9), rng.int(2, 9), rng.chance(0.7) ? 0 : false);
  const air = rng.next() * 0.5;
  for (let i = 0; i < input.cells.length; i++) if (input.light) input.light[i] = rng.int(0, 255);
  for (let y = -1; y <= input.sy; y++) {
    for (let z = -1; z <= input.sz; z++) {
      for (let x = -1; x <= input.sx; x++) {
        if (rng.next() < air) continue;
        if (rng.next() < partialShare) put(input, x, y, z, randomPartialCell(rng));
        else if (rng.chance(0.85)) put(input, x, y, z, makeCell(CUBES[rng.int(0, CUBES.length - 1)]!, rng.int(0, 63)));
        else put(input, x, y, z, makeCell(MODELS[rng.int(0, MODELS.length - 1)]!, rng.int(0, 63)));
      }
    }
  }
  return input;
}

/** The same input with every partial cell replaced by air and no extra layers: a job M1 could mesh. */
function withoutParts(input: MeshInput): MeshInput {
  const cells = input.cells.slice();
  for (let i = 0; i < cells.length; i++) {
    if ((input.holes !== null && input.holes[i] !== 0) || (input.part2 !== null && input.part2[i] !== 0)) cells[i] = 0;
  }
  return { ...input, cells, holes: null, part2: null };
}

describe('faces with a clear window are M1 faces, byte for byte (8.2)', () => {
  it('on 40 random boxes with partial cells sprinkled among whole cubes and models', () => {
    const rng = new Rng(31337);
    let compared = 0;
    for (let t = 0; t < 40; t++) {
      const input = scene(rng, 0.03 + rng.next() * 0.1);
      const layered = clearFaceQuads(input, buildMesh(input));
      const m1 = clearFaceQuads(input, buildMesh(withoutParts(input)));
      // Same faces, same bytes, same order.
      expect(layered).toEqual(m1);
      compared += m1.length;
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it('one half slab in a field of stone changes only the faces whose window holds it', () => {
    const input = makeInput(7, 3, 7, 0xf0);
    for (let x = -1; x <= 7; x++) for (let z = -1; z <= 7; z++) put(input, x, 0, z, makeCell(B.STONE));
    putParts(input, 3, 1, 3, slab(B.STONE, LOWER));
    const layered = allQuads(buildMesh(input)).map(bytesOf);
    const plain = new Set(allQuads(buildMesh(withoutParts(input))).map(bytesOf));
    // The floor tops that see the slab: the 3 x 3 cells under and around it.
    const changed = allQuads(buildMesh(withoutParts(input))).filter((q) => !layered.includes(bytesOf(q)));
    const owners = new Set(changed.map((q) => ownerCell(q).join()));
    expect([...owners].sort()).toEqual(['2,0,2', '2,0,3', '2,0,4', '3,0,2', '3,0,3', '3,0,4', '4,0,2', '4,0,3', '4,0,4']);
    // Everything else is there unchanged.
    expect(layered.filter((b) => plain.has(b)).length).toBe(plain.size - changed.length);
  });
});

describe('jobs without layers are the M1 mesher', () => {
  /**
   * Hash of the mesher output on 60 random full-block boxes (every registered block in every state,
   * random light). The constant was computed with the same code at the M1 baseline, commit c20ea8e
   * (the code before Milestone 2.3).
   */
  it('gives the same bytes as the M1 baseline on random full-block scenes', () => {
    const M1_HASH = 0xbe459147;
    const fnv = (h: number, bytes: Uint8Array): number => {
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
      return h;
    };
    let h = 0x811c9dc5;
    const ids: number[] = [];
    for (const d of BLOCKS) if (d) ids.push(d.id);
    for (let seed = 1; seed <= 60; seed++) {
      const rng = new Rng(seed);
      const n = rng.int(1, 12);
      const len = (n + 2) ** 3;
      const inp: MeshInput = { sx: n, sy: n, sz: n, cells: new Uint16Array(len), holes: null, part2: null, light: seed % 3 !== 0 ? new Uint8Array(len) : null };
      const airBias = rng.next();
      for (let i = 0; i < len; i++) {
        inp.cells[i] = rng.next() < airBias ? 0 : makeCell(ids[rng.int(0, ids.length - 1)]!, rng.int(0, 63));
        if (inp.light) inp.light[i] = rng.int(0, 255);
      }
      const m = buildMesh(inp);
      for (const g of [m.opaque, m.cutout, m.translucent]) {
        if (!g) {
          h = fnv(h, new Uint8Array([0]));
          continue;
        }
        for (const a of [g.positions, g.normals, g.uvs, g.layers, g.light, g.indices]) h = fnv(h, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      }
    }
    expect(h.toString(16)).toBe(M1_HASH.toString(16));
  });

  it('layers that are present but all zero mesh exactly like no layers', () => {
    const rng = new Rng(5);
    for (let t = 0; t < 5; t++) {
      const input = withoutParts(scene(rng, 0));
      const zero: MeshInput = { ...input, holes: new Uint8Array(input.cells.length), part2: new Uint32Array(input.cells.length) };
      expect(buildMesh(zero)).toEqual(buildMesh(input));
    }
  });
});
