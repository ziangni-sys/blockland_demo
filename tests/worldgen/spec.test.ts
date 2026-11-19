/**
 * GeneratorSpec (docs/NETCODE.md sections 3, 14): every generator describes itself as data, the
 * spec rebuilds a generator with identical output, and the spec survives the wire format.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { readGeneratorSpec, writeGeneratorSpec } from '../../src/net/codec';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { FlatGenerator, generatorFromSpec, TerrainGenerator, VoidGenerator, type ChunkGenerator } from '../../src/worldgen/generator';

function sameOutput(a: ChunkGenerator, b: ChunkGenerator): void {
  for (const [cx, cz] of [
    [0, 0],
    [-3, 7],
    [12, -5],
  ] as const) {
    expect(b.generate(cx, cz)).toEqual(a.generate(cx, cz));
  }
  expect(b.spawnPoint()).toEqual(a.spawnPoint());
}

describe('GeneratorSpec', () => {
  it('terrain, flat and void generators rebuild from their spec with identical output', () => {
    const gens: ChunkGenerator[] = [
      new TerrainGenerator(0xdeadbeef),
      new FlatGenerator(),
      new FlatGenerator([{ id: makeCell(B.STONE), thickness: 2 }, { id: B.WATER, thickness: 0 }, { id: B.STONE, thickness: 3 }, { id: B.DIRT, thickness: 500 }], 9),
      new VoidGenerator(5),
    ];
    for (const g of gens) {
      const spec = g.spec();
      const back = generatorFromSpec(spec);
      expect(back.spec()).toEqual(spec);
      sameOutput(g, back);
      const w = new ByteWriter();
      writeGeneratorSpec(w, spec);
      const r = new ByteReader(w.finish(), 'spec');
      expect(readGeneratorSpec(r)).toEqual(spec);
      r.expectEnd();
    }
  });

  it('a flat spec is the real column: runs merged, empty layers dropped, capped at the world height', () => {
    const g = new FlatGenerator([{ id: B.STONE, thickness: 2 }, { id: B.WATER, thickness: 0 }, { id: B.STONE, thickness: 3 }, { id: B.DIRT, thickness: 500 }], 9);
    expect(g.spec()).toEqual({
      kind: 'flat',
      seed: 9,
      layers: [
        { cell: B.STONE, thickness: 5 },
        { cell: B.DIRT, thickness: 123 },
      ],
    });
  });
});
