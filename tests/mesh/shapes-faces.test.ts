/**
 * Which faces the mesher emits for partial cells and around them (docs/SHAPES.md 8.2): a
 * brute-force reference written from the text of 8.2, compared quarter face by quarter face on
 * random inputs, plus the named cases of the package description.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { cellPrimary, cellSecond, ID_MASK, makeCell, makePart, PART_MASK, partHoles } from '../../src/blocks/cell';
import { BLOCKS, OPAQUE, blockDef } from '../../src/blocks/registry';
import { opaqueFill, partAt } from '../../src/blocks/shapes';
import { NY, PX, PY } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { Mesher, buildMesh } from '../../src/mesh/mesher';
import type { MeshData, MeshInput } from '../../src/mesh/types';
import { LOWER, UPPER, WEST, slab, stairFill } from '../shapes';
import { allQuads, checkInsideBox, checkInvariants, dirOfQuad, idx, makeInput, put, quadsOf, type GroupName, type Quad } from './helpers';
import { boxFaceKey, CUTTABLE_IDS, faceKey, isPartial, ownerCell, packedAt, putParts, quadArea, randomPartialCell } from './shape-helpers';

const OFF: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function isCubeFamily(id: number): boolean {
  const d = BLOCKS[id];
  return d !== undefined && d.tileIds.length > 0 && (d.shape === 'cube' || d.shape === 'bearing');
}
/** 8.2 rule 2: a non-opaque cube that hides its faces against itself (glass, ice, leaves). */
function selfCulls(id: number): boolean {
  return isCubeFamily(id) && OPAQUE[id] === 0;
}
/** 8.2 rule 3: a model whose INFO covers its face f: only the snow-like slab in the opaque pass, its bottom. */
function modelCovers(id: number, f: number): boolean {
  const d = BLOCKS[id];
  return d !== undefined && d.shape === 'layers' && d.layer === 'opaque' && f === NY;
}

/**
 * The expected cube-family faces of every interior cell, by group: face keys (shape-helpers
 * faceKey) of whole faces (M1 path) and of quarter faces (octant path), straight from 8.2.
 */
function reference(input: MeshInput): Record<GroupName, string[]> {
  const out: Record<GroupName, string[]> = { opaque: [], cutout: [], translucent: [] };
  const at = (x: number, y: number, z: number) => packedAt(input, x, y, z);
  for (let y = 0; y < input.sy; y++) {
    for (let z = 0; z < input.sz; z++) {
      for (let x = 0; x < input.sx; x++) {
        const c = at(x, y, z);
        const partial = isPartial(c);
        const parts = partial ? [cellPrimary(c) & PART_MASK, cellSecond(c)].filter((p) => p !== 0) : [c];
        for (const part of parts) {
          const id = part & ID_MASK;
          if (!isCubeFamily(id)) continue;
          const fill = ~partHoles(part) & 0xff;
          const group = blockDef(id).layer;
          for (let d = 0; d < 6; d++) {
            const a = d >> 1;
            const o = OFF[d]!;
            // Path: a whole cell takes M1's path for face d when it and the nine cells in front are not partial.
            let clear = !partial;
            for (let i = -1; i <= 1 && clear; i++) {
              for (let j = -1; j <= 1 && clear; j++) {
                const t = [o[0], o[1], o[2]];
                const ta = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
                t[ta[0]!] = i;
                t[ta[1]!] = j;
                if (isPartial(at(x + t[0]!, y + t[1]!, z + t[2]!))) clear = false;
              }
            }
            const n = at(x + o[0], y + o[1], z + o[2]);
            if (clear) {
              const nid = n & ID_MASK;
              if (OPAQUE[nid] === 1 || modelCovers(nid, d ^ 1) || (selfCulls(id) && nid === id)) continue;
              out[group].push(boxFaceKey(d, x, y, z, 1));
              continue;
            }
            for (let oc = 0; oc < 8; oc++) {
              if (((fill >> oc) & 1) === 0) continue;
              const onFace = ((oc >> a) & 1) === ((d & 1) === 0 ? 1 : 0);
              const nA = onFace ? n : c;
              const oA = oc ^ (1 << a);
              if (((opaqueFill(nA) >> oA) & 1) === 1) continue;
              if (selfCulls(id) && (partAt(nA, oA) & ID_MASK) === id) continue;
              if (onFace && !isPartial(nA) && modelCovers(nA & ID_MASK, d ^ 1)) continue;
              out[group].push(boxFaceKey(d, x + (oc & 1) * 0.5, y + ((oc >> 1) & 1) * 0.5, z + ((oc >> 2) & 1) * 0.5, 0.5));
            }
          }
        }
      }
    }
  }
  for (const g of Object.keys(out) as GroupName[]) out[g].sort();
  return out;
}

/**
 * The emitted faces of cube-family cells (quads owned by a model cell are left out), by group.
 * `m` is the mesh of `withoutLiquids(input)`: a liquid's inside copies face into the neighbour
 * cell and would be taken for that cell's faces.
 */
function emittedCubeFaces(input: MeshInput, m: MeshData): Record<GroupName, string[]> {
  const out: Record<GroupName, string[]> = { opaque: [], cutout: [], translucent: [] };
  for (const q of allQuads(m)) {
    if (dirOfQuad(q) < 0) continue;
    const [x, y, z] = ownerCell(q);
    const c = packedAt(input, x, y, z);
    if (!isCubeFamily(c & ID_MASK)) continue;
    out[q.group].push(faceKey(q));
  }
  for (const g of Object.keys(out) as GroupName[]) out[g].sort();
  return out;
}

/**
 * The input with its interior liquid cells replaced by air. Cube faces do not change: a liquid is
 * not opaque, never shares an id with a cube and covers nothing (margin cells are never meshed).
 */
function withoutLiquids(input: MeshInput): MeshInput {
  const twin: MeshInput = { ...input, cells: input.cells.slice() };
  for (let y = 0; y < input.sy; y++) {
    for (let z = 0; z < input.sz; z++) {
      for (let x = 0; x < input.sx; x++) {
        const i = idx(twin, x, y, z);
        if (blockDef(twin.cells[i]! & ID_MASK).shape === 'liquid') twin.cells[i] = 0;
      }
    }
  }
  return twin;
}

const FULL_CUBES = [B.STONE, B.DIRT, B.GLASS, B.ICE, B.LEAVES_OAK, B.LOG_PINE, B.BEARING, B.PLANKS_OAK, B.LAMP];
const MODELS = [B.TORCH, B.TALL_GRASS, B.SNOW_LAYER, B.CACTUS, B.WATER];
const FUZZ_IDS = [B.STONE, B.GLASS, B.ICE, B.LEAVES_OAK, B.LOG_OAK, B.PLANKS_OAK, B.TURF, B.LAMP, B.LEAVES_PINE];

function randomScene(rng: Rng, n: number): MeshInput {
  const input = makeInput(rng.int(1, n), rng.int(1, n), rng.int(1, n), rng.chance(0.5) ? true : false);
  const air = rng.next() * 0.6;
  const partialShare = 0.15 + rng.next() * 0.5;
  for (let y = -1; y <= input.sy; y++) {
    for (let z = -1; z <= input.sz; z++) {
      for (let x = -1; x <= input.sx; x++) {
        const r = rng.next();
        if (r < air) continue;
        if (rng.next() < partialShare) put(input, x, y, z, randomPartialCell(rng, FUZZ_IDS));
        else if (rng.chance(0.8)) put(input, x, y, z, makeCell(FULL_CUBES[rng.int(0, FULL_CUBES.length - 1)]!, rng.int(0, 7)));
        else put(input, x, y, z, makeCell(MODELS[rng.int(0, MODELS.length - 1)]!, rng.int(0, 15)));
      }
    }
  }
  return input;
}

describe('octant path: brute-force comparison, quarter face by quarter face (8.2)', () => {
  it('matches on 60 random boxes of whole cubes, cut parts, two-part cells, models and liquids (margin included)', () => {
    const rng = new Rng(4242);
    for (let t = 0; t < 60; t++) {
      const input = randomScene(rng, 6);
      checkInvariants(buildMesh(input));
      const m = buildMesh(withoutLiquids(input));
      expect(emittedCubeFaces(input, m)).toEqual(reference(input));
    }
  });

  it('every quarter face is a 0.5 x 0.5 axis-aligned square, the tile of the material in that direction', () => {
    const rng = new Rng(77);
    for (let t = 0; t < 10; t++) {
      const input = randomScene(rng, 5);
      for (const q of allQuads(buildMesh(withoutLiquids(input)))) {
        const d = dirOfQuad(q);
        if (d < 0) continue;
        const [x, y, z] = ownerCell(q);
        const c = packedAt(input, x, y, z);
        if (!isPartial(c)) continue;
        const area = quadArea(q);
        expect(area).toBeCloseTo(0.25, 9);
        // The part behind the quad: the octant just behind its centre.
        const cx = (q.p[0]!.x + q.p[2]!.x) / 2 - (OFF[d]![0] * 0.25);
        const cy = (q.p[0]!.y + q.p[2]!.y) / 2 - (OFF[d]![1] * 0.25);
        const cz = (q.p[0]!.z + q.p[2]!.z) / 2 - (OFF[d]![2] * 0.25);
        const o = (Math.floor((cx - x) * 2) & 1) | ((Math.floor((cy - y) * 2) & 1) << 1) | ((Math.floor((cz - z) * 2) & 1) << 2);
        const id = partAt(c, o) & ID_MASK;
        const def = blockDef(id);
        if (def.stateKind === 'none') expect(q.tile).toBe(def.tileIds[Math.min(d, def.tileIds.length - 1)]);
        else expect(def.tileIds).toContain(q.tile);
        expect(q.group).toBe(def.layer);
      }
    }
  });
});

describe('the rules of 8.2 on named cases', () => {
  /** Quads of the cell at (x, y, z). */
  function quadsOfCell(m: MeshData, x: number, y: number, z: number): Quad[] {
    return allQuads(m).filter((q) => dirOfQuad(q) >= 0 && ownerCell(q).join() === `${x},${y},${z}`);
  }

  it('a lone lower half slab: four quarter faces on top (the middle plane), bottom and two per side', () => {
    const input = makeInput(1, 1, 1);
    putParts(input, 0, 0, 0, slab(B.STONE, LOWER));
    const qs = allQuads(buildMesh(input));
    expect(qs.length).toBe(4 + 4 + 4 * 2);
    const top = qs.filter((q) => dirOfQuad(q) === PY);
    expect(top.length).toBe(4);
    for (const q of top) for (const p of q.p) expect(p.y).toBe(0.5);
  });

  it('two opaque parts touching inside a cell draw no face between them; glass beside stone: the glass face is hidden, the stone face drawn', () => {
    const both = makeInput(1, 1, 1);
    putParts(both, 0, 0, 0, slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    const m = buildMesh(both);
    expect(allQuads(m).filter((q) => q.p.every((p) => p.y === 0.5)).length).toBe(0);
    const mixed = makeInput(1, 1, 1);
    putParts(mixed, 0, 0, 0, slab(B.STONE, LOWER), slab(B.GLASS, UPPER));
    const mm = buildMesh(mixed);
    const mid = allQuads(mm).filter((q) => q.p.every((p) => p.y === 0.5));
    expect(mid.length).toBe(4);
    expect(mid.every((q) => q.group === 'opaque' && dirOfQuad(q) === PY)).toBe(true);
  });

  it('two parts of the same material are two parts but draw like one block', () => {
    const input = makeInput(1, 1, 1);
    putParts(input, 0, 0, 0, slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER));
    expect(allQuads(buildMesh(input)).length).toBe(24);
  });

  it('glass, ice and leaves cull against the same material in a neighbour or in the same cell, not against another', () => {
    for (const id of [B.GLASS, B.ICE, B.LEAVES_OAK]) {
      const input = makeInput(2, 1, 1);
      putParts(input, 0, 0, 0, slab(id, LOWER));
      put(input, 1, 0, 0, makeCell(id));
      const m = buildMesh(input);
      // The slab's +X lower quarters face the same material: hidden; the cube's -X face upper quarters face air: drawn.
      expect(allQuads(m).filter((q) => dirOfQuad(q) === PX && q.p.every((p) => p.x === 1)).length).toBe(0);
      expect(allQuads(m).filter((q) => dirOfQuad(q) === 1 && q.p.every((p) => p.x === 1)).map((q) => Math.min(...q.p.map((p) => p.y)))).toEqual([0.5, 0.5]);
      const other = makeInput(2, 1, 1);
      putParts(other, 0, 0, 0, slab(id, LOWER));
      put(other, 1, 0, 0, makeCell(id === B.GLASS ? B.ICE : B.GLASS));
      expect(allQuads(buildMesh(other)).filter((q) => dirOfQuad(q) === PX && q.p.every((p) => p.x === 1)).length).toBe(2);
    }
  });

  it('a model neighbour hides a quarter face only when its INFO covers that face: snow cover above an upper slab', () => {
    const input = makeInput(1, 2, 1);
    putParts(input, 0, 0, 0, slab(B.STONE, UPPER));
    put(input, 0, 1, 0, makeCell(B.SNOW_LAYER, 0));
    const m = buildMesh(input);
    expect(quadsOfCell(m, 0, 0, 0).filter((q) => dirOfQuad(q) === PY).length).toBe(0);
    // A torch above does not cover anything.
    const torch = makeInput(1, 2, 1);
    putParts(torch, 0, 0, 0, slab(B.STONE, UPPER));
    put(torch, 0, 1, 0, makeCell(B.TORCH));
    expect(quadsOfCell(buildMesh(torch), 0, 0, 0).filter((q) => dirOfQuad(q) === PY).length).toBe(4);
  });

  it('models test a partial neighbour by its opaque cover: torch, snow, cactus, helm and propeller on a lower slab draw their bottom, on an upper slab they do not', () => {
    for (const [fill, drawn] of [
      [LOWER, true],
      [UPPER, false],
    ] as const) {
      // A propeller facing up is mounted on the cell below (its back plate's face there).
      for (const [id, state] of [
        [B.TORCH, 0],
        [B.SNOW_LAYER, 0],
        [B.CACTUS, 0],
        [B.HELM, 0],
        [B.PROPELLER, PY],
      ] as const) {
        const input = makeInput(1, 2, 1);
        putParts(input, 0, 0, 0, slab(B.STONE, fill));
        put(input, 0, 1, 0, makeCell(id, state));
        const bottoms = quadsOfCell(buildMesh(input), 0, 1, 0).filter((q) => dirOfQuad(q) === NY && q.p.every((p) => p.y === 1));
        expect(bottoms.length > 0).toBe(drawn);
      }
    }
    // A snow cover's side toward a cell is hidden only when that cell's opaque octants cover the whole face.
    const sideDrawn = (a: number, b = 0): boolean => {
      const input = makeInput(2, 1, 1);
      put(input, 0, 0, 0, makeCell(B.SNOW_LAYER, 7));
      putParts(input, 1, 0, 0, a, b);
      return quadsOfCell(buildMesh(input), 0, 0, 0).some((q) => dirOfQuad(q) === PX);
    };
    expect(sideDrawn(slab(B.STONE, LOWER))).toBe(true);
    expect(sideDrawn(slab(B.STONE, WEST))).toBe(false);
    expect(sideDrawn(slab(B.GLASS, WEST), slab(B.STONE, 0xaa))).toBe(true);
    expect(sideDrawn(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER))).toBe(false);
  });

  it('a stair and a lone corner octant expose exactly their outer surface', () => {
    for (const fill of [stairFill(PX), 0x01, 0x7f, 0x69]) {
      const input = makeInput(1, 1, 1);
      putParts(input, 0, 0, 0, slab(B.STONE, fill));
      const qs = allQuads(buildMesh(input));
      // Outer surface: an octant face is exposed when the octant across it (inside the cell) is empty or outside the cell.
      let expected = 0;
      for (let o = 0; o < 8; o++) {
        if (((fill >> o) & 1) === 0) continue;
        for (let a = 0; a < 3; a++) {
          for (const side of [0, 1]) {
            const inside = ((o >> a) & 1) !== side;
            if (!inside || ((fill >> (o ^ (1 << a))) & 1) === 0) expected++;
          }
        }
      }
      expect(qs.length).toBe(expected);
    }
  });
});

describe('every block with a set of masks', () => {
  const MASKS = [LOWER, UPPER, WEST, 0xaa, 0x0f, 0xf0, stairFill(PX), stairFill(5), 0x01, 0x80, 0x7f, 0xfe, 0x69, 0x96, 0x17];

  it('meshes every registered block as a part with each mask, alone and beside a second part, without breaking invariants', () => {
    for (const def of BLOCKS) {
      if (!def) continue;
      for (const fill of MASKS) {
        for (const light of [false, true]) {
          const input = makeInput(1, 1, 1, light);
          put(input, 0, 0, 0, makePart(def.id, 0, ~fill & 0xff));
          put(input, 0, -1, 0, makeCell(B.STONE));
          const m = buildMesh(input);
          checkInvariants(m);
          checkInsideBox(m, 0, 1);
          if (CUTTABLE_IDS.includes(def.id)) {
            const two = makeInput(1, 1, 1, light);
            putParts(two, 0, 0, 0, makePart(def.id, 0, ~fill & 0xff), makePart(B.GLASS, 0, fill));
            const mt = buildMesh(two);
            checkInvariants(mt);
            checkInsideBox(mt, 0, 1);
          }
        }
      }
    }
  });

  it('a model block never shows holes: given a holes byte (never a valid cell) it is drawn whole', () => {
    for (const id of [B.TORCH, B.TALL_GRASS, B.SNOW_LAYER, B.CACTUS, B.HELM, B.PROPELLER, B.WATER, B.LAVA]) {
      for (const state of [0, 3, 7]) {
        const holed = makeInput(1, 1, 1, true);
        put(holed, 0, 0, 0, makePart(id, state, 0x33));
        const whole = makeInput(1, 1, 1, true);
        put(whole, 0, 0, 0, makeCell(id, state));
        expect(buildMesh(holed)).toEqual(buildMesh(whole));
      }
    }
  });

  it('cut cubes draw in the group of their material', () => {
    const input = makeInput(3, 1, 1);
    putParts(input, 0, 0, 0, slab(B.STONE, LOWER));
    putParts(input, 1, 0, 0, slab(B.LEAVES_OAK, LOWER));
    putParts(input, 2, 0, 0, slab(B.ICE, LOWER));
    const m = buildMesh(input);
    expect(quadsOf(m.opaque, 'opaque').every((q) => q.p.every((p) => p.x <= 1))).toBe(true);
    expect(quadsOf(m.cutout, 'cutout').every((q) => q.p.every((p) => p.x >= 1 && p.x <= 2))).toBe(true);
    expect(quadsOf(m.translucent, 'translucent').every((q) => q.p.every((p) => p.x >= 2))).toBe(true);
  });

  it('a lamp half slab is emissive on every quarter face', () => {
    const input = makeInput(1, 1, 1);
    putParts(input, 0, 0, 0, slab(B.LAMP, LOWER));
    for (const q of allQuads(buildMesh(input))) expect(q.flags).toEqual([1, 1, 1, 1]);
  });
});

describe('determinism and reuse with layers', () => {
  it('identical output for identical layered input; a reused Mesher equals fresh ones; the input is not modified', () => {
    const rng = new Rng(9);
    const inputs = [randomScene(rng, 8), randomScene(rng, 8), randomScene(rng, 4)];
    const copies = inputs.map((i) => ({ cells: i.cells.slice(), holes: i.holes?.slice() ?? null, part2: i.part2?.slice() ?? null }));
    const fresh = inputs.map((i) => buildMesh(i));
    const mesher = new Mesher();
    const plain = makeInput(4, 4, 4, true);
    put(plain, 1, 1, 1, makeCell(B.STONE));
    // Interleave a job without layers: the layered scratch must not leak into it, nor the other way round.
    const order = [0, 1, 2, 1, 0, 2];
    for (const k of order) {
      expect(mesher.build(inputs[k]!)).toEqual(fresh[k]);
      expect(mesher.build(plain)).toEqual(buildMesh(plain));
    }
    inputs.forEach((i, k) => {
      expect(i.cells).toEqual(copies[k]!.cells);
      expect(i.holes).toEqual(copies[k]!.holes);
      expect(i.part2).toEqual(copies[k]!.part2);
    });
  });
});
