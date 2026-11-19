/**
 * Fingerprints cover all three layers (docs/SHAPES.md 13.4): a difference only in a holes byte or
 * only in a second part gives a different hash, while columns and structures of full blocks hash
 * exactly as before M2.3 (the browser scripts keep their recorded values), and a null layer hashes
 * like an all-zero one.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { Chunk } from '../../src/voxel/chunk';
import { columnHash, gridHash, layersHash } from '../../src/voxel/fingerprint';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';

/** The M2.2 column hash: FNV-1a over the base layer, one step per cell. */
function oldColumnHash(cells: Uint16Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cells.length; i++) h = Math.imul(h ^ cells[i]!, 0x01000193) >>> 0;
  return h;
}

/** The M2.2 grid hash over (x, y, z, cell) with 16-bit halves. */
function oldGridHash(cells: Array<[number, number, number, number]>): number {
  let sum = 0;
  for (const c of cells) {
    let h = 0x811c9dc5;
    for (const v of c) {
      h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
      h = Math.imul(h ^ (v >>> 16), 0x01000193) >>> 0;
    }
    sum = (sum + h) >>> 0;
  }
  return sum;
}

function column(seed: number): Uint16Array {
  const rng = new Rng(seed);
  const cells = new Uint16Array(CHUNK_VOLUME);
  for (let i = 0; i < 40 * 256; i++) cells[i] = rng.chance(0.1) ? makeCell(B.COAL_ORE) : makeCell(B.STONE);
  return cells;
}

describe('layersHash / columnHash', () => {
  it('a column of full blocks hashes as before, whether its extra layers are null or all zero', () => {
    const base = column(1);
    const h = oldColumnHash(base);
    expect(layersHash({ base, holes: null, part2: null })).toBe(h);
    expect(layersHash({ base, holes: new Uint8Array(CHUNK_VOLUME), part2: new Uint32Array(CHUNK_VOLUME) })).toBe(h);
    expect(columnHash(new Chunk(0, 0, base))).toBe(h);
  });

  it('only the holes, or only the second part, differ: different hashes; columnHash of a chunk = layersHash of its layers', () => {
    const w = new World();
    w.addChunk(new Chunk(0, 0, column(2)));
    const c = w.getChunk(0, 0)!;
    const two = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
    w.setCell(3, 50, 3, two);
    const h0 = columnHash(c);
    expect(h0).toBe(layersHash(c.layers()));
    w.setCell(3, 50, 3, canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.PLANKS_OAK, UPPER))); // holes only
    const h1 = columnHash(c);
    w.setCell(3, 50, 3, canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.GLASS, UPPER))); // second part only
    const h2 = columnHash(c);
    expect(new Set([h0, h1, h2]).size).toBe(3);
    // Back to full blocks: the hash of a column that never had layers.
    w.setCell(3, 50, 3, makeCell(B.STONE));
    expect(columnHash(c)).toBe(oldColumnHash(c.cells));
  });

  it('the same holes at another index hash differently (indices are mixed in)', () => {
    const base = column(3);
    const a = new Uint8Array(CHUNK_VOLUME);
    a[5] = 0x0f;
    const b = new Uint8Array(CHUNK_VOLUME);
    b[6] = 0x0f;
    expect(layersHash({ base, holes: a, part2: null })).not.toBe(layersHash({ base, holes: b, part2: null }));
  });
});

/**
 * layersHash written again from the words of docs/SHAPES.md 13.4, as a list of FNV-1a input
 * values: the base layer one entry per step, then (only if there is a non-zero holes entry) the
 * separator 0x48 and per non-zero holes entry its index as 4 bytes little endian and its value;
 * then the same for the second-part layer with separator 0x50 and the value as 4 bytes LE too.
 */
function specSteps(base: number[], holes: number[], part2: number[]): number[] {
  const le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const steps = [...base];
  if (holes.some((x) => x !== 0)) {
    steps.push(0x48);
    holes.forEach((x, i) => x !== 0 && steps.push(...le(i), x));
  }
  if (part2.some((x) => x !== 0)) {
    steps.push(0x50);
    part2.forEach((x, i) => x !== 0 && steps.push(...le(i), ...le(x)));
  }
  return steps;
}
function fnv(steps: number[]): number {
  let h = 0x811c9dc5;
  for (const s of steps) h = Math.imul(h ^ s, 0x01000193) >>> 0;
  return h;
}

/** layersHash of the two volumes below, computed once from specSteps. */
const KAT1 = 0x42e42593;
const KAT2 = 0x5359eb3e;

describe('layersHash follows the algorithm of 13.4 exactly (known answers)', () => {
  // Two small volumes (layersHash takes any volume): one with a holes entry, one with a holes
  // entry and a second-part entry at a non-zero index.
  const base1 = [0, 1, 0x0402, 0];
  const holes1 = [0, 0, 0x33, 0];
  const base2 = [3, 0, 0, 3, 0, 7];
  const holes2 = [0, 0, 0, 0xcc, 0, 0];
  const part2v2 = [0, 0, 0, 0x330007, 0, 0];
  const vol1 = { base: Uint16Array.from(base1), holes: Uint8Array.from(holes1), part2: null };
  const vol2 = { base: Uint16Array.from(base2), holes: Uint8Array.from(holes2), part2: Uint32Array.from(part2v2) };

  it('matches the reference written from the text, and the pinned values', () => {
    expect(layersHash(vol1)).toBe(fnv(specSteps(base1, holes1, [])));
    expect(layersHash(vol2)).toBe(fnv(specSteps(base2, holes2, part2v2)));
    // Pinned: a change of the algorithm (another separator, order, byte width) fails here even
    // if the reference above were changed along with it.
    expect(layersHash(vol1)).toBe(KAT1);
    expect(layersHash(vol2)).toBe(KAT2);
  });

  it('the same second part at another index hashes differently (indices are mixed in)', () => {
    const moved = { base: vol2.base, holes: Uint8Array.from([0, 0, 0, 0, 0, 0xcc]), part2: Uint32Array.from([0, 0, 0, 0, 0, 0x330007]) };
    const sameHolesMoved = { base: vol2.base, holes: vol2.holes, part2: Uint32Array.from([0, 0, 0, 0, 0x330007, 0]) };
    expect(layersHash(moved)).not.toBe(layersHash(vol2));
    expect(layersHash(sameHolesMoved)).not.toBe(layersHash(vol2));
  });
});

describe('gridHash', () => {
  it('a structure of full blocks hashes as before; holes or a second part change it', () => {
    const g = new StructureGrid(1, new World());
    const cells: Array<[number, number, number, number]> = [
      [0, 0, 0, makeCell(B.PLANKS_OAK)],
      [-3, 70, 9, makeCell(B.LOG_OAK, 2)],
      [5, -1, -400, makeCell(B.HELM, 5)],
    ];
    for (const [x, y, z, v] of cells) g.setCell(x, y, z, v);
    expect(gridHash(g)).toBe(oldGridHash(cells));
    g.setCell(1, 0, 0, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    const h0 = gridHash(g);
    g.setCell(1, 0, 0, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER))); // second part only
    const h1 = gridHash(g);
    g.setCell(1, 0, 0, canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.GLASS, UPPER))); // holes only
    const h2 = gridHash(g);
    expect(new Set([oldGridHash(cells), h0, h1, h2]).size).toBe(4);
    // Only the second part's holes differ: bits above 2^32 of the packed cell only.
    g.setCell(1, 0, 0, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER & 0x7f)));
    expect(gridHash(g)).not.toBe(h1);
  });
});
