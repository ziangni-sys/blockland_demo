/**
 * The other save blobs that hold a cell (docs/SHAPES.md 13.2, 13.3): a falling block's cell is a
 * varuint, a full block checked with cellProblem on reading (entity blob version 3), and the
 * generator blob's flat layers pass generatorSpecProblem when the host reads a save
 * (SaveFormatError otherwise). Plus generatorSpecProblem itself and the flat generator's
 * constructor, which used to mask a layer to 16 bits.
 */
import { describe, expect, it } from 'vitest';
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { FallingBlockEntity } from '../../src/entities/entity';
import { writeGeneratorSpec } from '../../src/net/codec';
import { GENERATOR_BLOB, readSave } from '../../src/net/host/host';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';
import { SAVE_VERSION } from '../../src/save/codec';
import { MemoryStorage } from '../../src/save/storage';
import { Simulation } from '../../src/sim/simulation';
import { FlatGenerator, generatorFromSpec, generatorSpecProblem, type GeneratorSpec } from '../../src/worldgen/generator';
import { LOWER, slab } from '../shapes';

function sim(): Simulation {
  return new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 1 });
}
function entityBlob(s: Simulation): Uint8Array {
  const w = new ByteWriter();
  s.entities.serialize(w);
  return w.finish();
}

describe('falling blocks in the entity blob (version 3)', () => {
  it('round-trip their cell as a varuint; the blob is version 3', () => {
    const a = sim();
    a.entities.spawnFalling(0.5, 60, 0.5, makeCell(B.SAND));
    a.entities.spawnFalling(3.5, 70, 0.5, makeCell(B.GRAVEL, 63));
    const bytes = entityBlob(a);
    expect(bytes[0]).toBe(3);
    const b = sim();
    b.entities.deserialize(new ByteReader(bytes, 'entities'));
    const cells = b.entities.all().filter((e): e is FallingBlockEntity => e instanceof FallingBlockEntity).map((e) => e.cell);
    expect(cells.sort()).toEqual([makeCell(B.SAND), makeCell(B.GRAVEL, 63)].sort());
  });

  it('the writer refuses a cell that is not a full block; the reader refuses an invalid or partial one (SaveFormatError)', () => {
    const a = sim();
    const e = a.entities.spawnFalling(0.5, 60, 0.5, makeCell(B.SAND));
    e.cell = slab(B.STONE, LOWER);
    expect(() => entityBlob(a)).toThrow(RangeError);
    // Locate the cell's byte by encoding two blobs that differ only there.
    e.cell = makeCell(B.SAND);
    const sand = entityBlob(a);
    e.cell = makeCell(B.GRAVEL);
    const gravel = entityBlob(a);
    const at = sand.findIndex((v, i) => v !== gravel[i]);
    expect(sand.length).toBe(gravel.length);
    const patched = (cell: number): Uint8Array => {
      const w = new ByteWriter();
      w.raw(sand.subarray(0, at)).varuint(cell).raw(sand.subarray(at + 1));
      return w.finish();
    };
    expect(() => sim().entities.deserialize(new ByteReader(patched(makeCell(B.SAND)), 'entities'))).not.toThrow();
    expect(() => sim().entities.deserialize(new ByteReader(patched(makeCell(999)), 'entities'))).toThrow(SaveFormatError);
    expect(() => sim().entities.deserialize(new ByteReader(patched(0x0400), 'entities'))).toThrow(/id 0 with state/);
    expect(() => sim().entities.deserialize(new ByteReader(patched(slab(B.STONE, LOWER)), 'entities'))).toThrow(/not a full block/);
  });
});

describe('generatorSpecProblem and the flat generator', () => {
  const flat = (cells: number[]): GeneratorSpec => ({ kind: 'flat', seed: 1, layers: cells.map((cell) => ({ cell, thickness: 2 })) });

  it('every flat layer must be a valid full block; other kinds have nothing to check', () => {
    expect(generatorSpecProblem({ kind: 'terrain', seed: 5 })).toBeNull();
    expect(generatorSpecProblem({ kind: 'void', seed: 5 })).toBeNull();
    expect(generatorSpecProblem(flat([makeCell(B.DEEPROCK), makeCell(B.STONE), 0, makeCell(B.LOG_OAK, 2)]))).toBeNull();
    expect(generatorSpecProblem(flat([makeCell(B.STONE), makeCell(999)]))).toMatch(/flat layer 1: unknown block id 999/);
    expect(generatorSpecProblem(flat([makePart(0, 1, 0)]))).toMatch(/flat layer 0: id 0 with state/);
    expect(generatorSpecProblem(flat([slab(B.STONE, LOWER)]))).toMatch(/flat layer 0: .* not a full block/);
  });

  it('the flat generator refuses what generatorSpecProblem refuses (RangeError), never masking a layer', () => {
    expect(() => new FlatGenerator([{ id: makeCell(999), thickness: 1 }])).toThrow(RangeError);
    expect(() => new FlatGenerator([{ id: slab(B.STONE, LOWER), thickness: 1 }])).toThrow(RangeError);
    expect(() => new FlatGenerator([{ id: 0x10000 | B.STONE, thickness: 1 }])).toThrow(RangeError); // used to be masked to stone
    expect(() => generatorFromSpec(flat([makeCell(999)]))).toThrow(RangeError);
    expect(generatorFromSpec(flat([makeCell(B.STONE)])).generate(0, 0)[0]).toBe(makeCell(B.STONE));
  });

  it('the host refuses a save whose generator blob has an invalid flat layer (SaveFormatError)', async () => {
    const storage = new MemoryStorage();
    const meta = { id: 'g', name: 'g', seed: 'g', seedHash: 7, mode: 'creative' as const, createdAt: 0, lastPlayed: 0, version: SAVE_VERSION, time: 0 };
    const blob = (spec: GeneratorSpec): Uint8Array => {
      const w = new ByteWriter();
      w.varuint(1);
      writeGeneratorSpec(w, spec);
      return w.finish();
    };
    await storage.putAll('g', meta, [], [[GENERATOR_BLOB, blob(flat([makeCell(B.STONE)]))]]);
    expect((await readSave(storage, 'g')).generator).toEqual(flat([makeCell(B.STONE)]));
    await storage.putAll('g', meta, [], [[GENERATOR_BLOB, blob(flat([makeCell(B.STONE), makeCell(999)]))]]);
    await expect(readSave(storage, 'g')).rejects.toThrow(SaveFormatError);
    await expect(readSave(storage, 'g')).rejects.toThrow(/flat layer 1/);
  });
});
