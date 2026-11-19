/**
 * The mesher's input carries the holes and second-part layers (docs/SHAPES.md 8.1): snapshots copy
 * them (margins across chunk borders included) and give null when the padded box has no non-zero
 * entry, so jobs without partial cells are exactly what they were; checkInput validates their
 * lengths; the worker transfer list carries them. Until the shape-aware mesher lands, a cell with
 * parts meshes as a full block of its first part's material (16.3), whatever the extra layers say.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { buildMesh } from '../../src/mesh/mesher';
import { snapshotSection, snapshotStructure } from '../../src/mesh/snapshot';
import { meshInputTransferables, type MeshInput } from '../../src/mesh/types';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';
import { idx } from './helpers';

const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
const SLAB = slab(B.PLANKS_OAK, LOWER);

function world(): World {
  const w = new World();
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.addChunk(new Chunk(cx, cz));
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) w.setCell(x, 20, z, makeCell(B.STONE));
  return w;
}

describe('mesh snapshots carry the layers', () => {
  it('snapshotSection: parts inside and in the margin (from a neighbouring chunk) land at their padded index', () => {
    const w = world();
    w.setCell(3, 21, 4, TWO); // section (0, 1, 0): world y 16..31
    w.setCell(-1, 22, 5, SLAB); // the -x margin, in chunk (-1, 0)
    const s = snapshotSection(w, 0, 1, 0);
    expect(s.holes).not.toBeNull();
    expect(s.part2).not.toBeNull();
    expect(s.holes!.length).toBe(s.cells.length);
    expect(s.part2!.length).toBe(s.cells.length);
    const i = idx(s, 3, 5, 4);
    expect([s.cells[i], s.holes![i], s.part2![i]]).toEqual([TWO % 0x10000, (TWO >>> 16) & 0xff, Math.floor(TWO / 2 ** 25)]);
    const m = idx(s, -1, 6, 5);
    expect([s.cells[m], s.holes![m], s.part2![m]]).toEqual([SLAB & 0xffff, (SLAB >>> 16) & 0xff, 0]);
    // Exactly those two cells have entries.
    expect(s.holes!.filter((v) => v !== 0).length).toBe(2);
    expect(s.part2!.filter((v) => v !== 0).length).toBe(1);
  });

  it('a section without parts gets null layers, even next to a chunk that has them and in a chunk whose layer is allocated but all zero', () => {
    const w = world();
    w.setCell(40, 21, 4, TWO); // chunk (2, 0) is not loaded: ignored; then put one far in chunk (1, 0)
    w.setCell(30, 60, 4, TWO);
    expect(snapshotSection(w, 0, 1, 0)).toMatchObject({ holes: null, part2: null });
    w.setCell(3, 21, 4, SLAB);
    w.setCell(3, 21, 4, makeCell(B.STONE)); // the chunk keeps an all-zero holes layer
    expect(w.getChunk(0, 0)!.holes).not.toBeNull();
    const s = snapshotSection(w, 0, 1, 0);
    expect([s.holes, s.part2]).toEqual([null, null]);
  });

  it('snapshotStructure: the tight box with its margin, layers only when the box has entries', () => {
    const g = new StructureGrid(1, new World());
    g.setCell(0, 0, 0, makeCell(B.PLANKS_OAK));
    g.setCell(1, 0, 0, makeCell(B.PLANKS_OAK));
    expect(snapshotStructure(g)!.input).toMatchObject({ holes: null, part2: null });
    g.setCell(1, 1, 0, TWO);
    const snap = snapshotStructure(g)!;
    const i = idx(snap.input, 1 - snap.ox, 1 - snap.oy, 0 - snap.oz);
    expect([snap.input.cells[i], snap.input.holes![i], snap.input.part2![i]]).toEqual([TWO % 0x10000, (TWO >>> 16) & 0xff, Math.floor(TWO / 2 ** 25)]);
    expect(snap.input.cells[idx(snap.input, 0, 0, 0)]).toBe(makeCell(B.PLANKS_OAK));
  });
});

describe('mesh input contract', () => {
  it('checkInput refuses extra layers of the wrong length', () => {
    const base = (): MeshInput => ({ sx: 1, sy: 1, sz: 1, cells: new Uint16Array(27), holes: null, part2: null, light: null });
    expect(() => buildMesh({ ...base(), holes: new Uint8Array(26) })).toThrow(/holes has 26 entries/);
    expect(() => buildMesh({ ...base(), part2: new Uint32Array(28) })).toThrow(/part2 has 28 entries/);
    expect(() => buildMesh({ ...base(), holes: new Uint8Array(27), part2: new Uint32Array(27) })).not.toThrow();
  });

  it('until the shape-aware mesher: a cell with parts meshes as a full block of its first part (16.3)', () => {
    const w = world();
    w.setCell(3, 21, 4, TWO);
    const layered = snapshotSection(w, 0, 1, 0);
    const plain: MeshInput = { ...layered, holes: null, part2: null };
    expect(buildMesh(layered)).toEqual(buildMesh(plain));
    w.setCell(3, 21, 4, makeCell(B.STONE));
    expect(buildMesh(snapshotSection(w, 0, 1, 0))).toEqual(buildMesh(plain));
  });

  it('the worker transfer list carries every layer that is not null', () => {
    const w = world();
    const plain = snapshotSection(w, 0, 1, 0);
    expect(meshInputTransferables(plain)).toEqual([plain.cells.buffer, plain.light!.buffer]);
    w.setCell(3, 21, 4, TWO);
    const s = snapshotSection(w, 0, 1, 0);
    expect(meshInputTransferables(s)).toEqual([s.cells.buffer, s.holes!.buffer, s.part2!.buffer, s.light!.buffer]);
    const g = new StructureGrid(1, new World());
    g.setCell(0, 0, 0, SLAB);
    const st = snapshotStructure(g)!.input;
    expect(meshInputTransferables(st)).toEqual([st.cells.buffer, st.holes!.buffer]);
  });
});
