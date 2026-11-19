/**
 * The light model of docs/SHAPES.md section 7 on partial cells, case by case: emitting parts,
 * changes of only the holes (including step 3 of cellChanged, where the changed cell keeps its
 * brightness but a neighbour must go dark), the heightmap by direct(), the top layer, chunk
 * borders with a holes layer on one side, the known approximation of section 7.1, the early
 * return of cellChanged for changes that cannot matter, and listeners that rewrite cells.
 * Every scene is also compared with the reference of section 7.4.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCell, withHoles } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { LightEngine } from '../../src/light/engine';
import { cellIndex, Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';
import { addLit, AIR, drain, expectConsistent, LAMP, lightWorld, SLAB_FILLS, skyReachable, STONE, writeLayers } from './shape-helpers';
import { makeFlatChunk } from './terrain';

const TOP_Y = WORLD_HEIGHT - 1;

/** Chunks of solid stone up to y = 60 (no sky below), lit. */
function solidWorld(chunks: Array<[number, number]> = [[0, 0]]): { world: World; engine: LightEngine } {
  const { world, engine } = lightWorld();
  for (const [cx, cz] of chunks) addLit(world, engine, makeFlatChunk(cx, cz, 60));
  return { world, engine };
}

describe('emitting parts', () => {
  for (const fill of SLAB_FILLS) {
    it(`a crystal-lamp slab (fill ${fill.toString(16)}) lights all six neighbours: through the faces it touches and through its empty half`, () => {
      const { world, engine } = solidWorld();
      for (let x = 7; x <= 9; x++) for (let y = 29; y <= 31; y++) for (let z = 7; z <= 9; z++) world.setCell(x, y, z, AIR);
      world.setCell(8, 30, 8, slab(B.LAMP, fill));
      drain(engine);
      expect(world.getBlockLight(8, 30, 8)).toBe(15);
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const) {
        expect(world.getBlockLight(8 + dx, 30 + dy, 8 + dz), `neighbour ${dx},${dy},${dz}`).toBe(14);
      }
      expectConsistent(world, `lamp slab ${fill}`);
    });
  }

  it('lamp slabs in a chunk lit with them already in place (initChunk), all six orientations side by side', () => {
    const { world, engine } = lightWorld();
    const chunk = makeFlatChunk(0, 0, 60);
    world.addChunk(chunk);
    SLAB_FILLS.forEach((fill, k) => {
      const x = 2 + 2 * k;
      for (let dx = -1; dx <= 1; dx++) for (let y = 29; y <= 31; y++) for (let dz = 7; dz <= 9; dz++) world.setCell(x + dx, y, dz, AIR);
      world.setCell(x, 30, 8, slab(B.LAMP, fill));
    });
    engine.initChunk(chunk);
    drain(engine);
    expectConsistent(world, 'lamp slabs at init');
    // Through a face the slab covers: below the lower slab, above the upper one, and so on.
    expect(world.getBlockLight(2, 29, 8)).toBe(14);
    expect(world.getBlockLight(4, 31, 8)).toBe(14);
    expect(world.getBlockLight(6, 30, 7)).toBe(14);
  });

  it('a lamp placed next to partial cells (a change of full blocks only) shines through the faces they leave open or it touches', () => {
    const { world, engine } = solidWorld([
      [0, 0],
      [1, 0],
    ]);
    // In chunk 0 (holes layer): an upper stone slab at (14, 30, 8) and an east stone slab at
    // (15, 33, 8), the latter on the chunk border; air pockets beyond them.
    world.setCell(14, 30, 8, slab(B.STONE, UPPER));
    world.setCell(13, 30, 8, AIR);
    world.setCell(15, 33, 8, slab(B.STONE, WEST));
    world.setCell(14, 33, 8, AIR);
    drain(engine);
    // Now lamps, as full blocks: one inside chunk 0, one across the border in chunk 1.
    world.setCell(15, 30, 8, LAMP);
    world.setCell(16, 33, 8, LAMP);
    drain(engine);
    // The upper slab's lower half is open toward the lamp: lit, and passes it on.
    expect(world.getBlockLight(14, 30, 8)).toBe(14);
    expect(world.getBlockLight(13, 30, 8)).toBe(13);
    // The west slab closes its west face by itself but its east half is open toward the lamp.
    expect(world.getBlockLight(15, 33, 8)).toBe(14);
    expect(world.getBlockLight(14, 33, 8)).toBe(0);
    expectConsistent(world, 'lamps next to slabs');
  });

  it('light an emitting part shines through a closed face is the cell\'s own source: removing other light never resets it', () => {
    const { world, engine } = solidWorld();
    // C = (8, 30, 8), lit 14 by a lamp lower slab above it through the slab's covered bottom
    // face, and also by a lamp right beside it at the end of a tunnel.
    world.setCell(8, 30, 8, AIR);
    world.setCell(8, 31, 8, slab(B.LAMP, LOWER));
    for (let x = 9; x <= 12; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(9, 30, 8, LAMP);
    drain(engine);
    expect(world.getBlockLight(8, 30, 8)).toBe(14);
    world.setCell(9, 30, 8, AIR); // the removal wave from the lamp (15) could have supported C (14)
    let steps = 0;
    while (!engine.update(1)) {
      expect(world.getBlockLight(8, 30, 8), `step ${steps}`).toBe(14);
      steps++;
    }
    expect(steps).toBeGreaterThan(3);
    expectConsistent(world, 'own source');
  });

  /** A cell S = (8, 31, 8) in solid stone with an air cell below, above and beside (+x) it, each sealed off. */
  function lampCell(content: number): World {
    const { world, engine } = solidWorld();
    world.setCell(8, 30, 8, AIR); // cellar
    world.setCell(8, 32, 8, AIR); // room above
    world.setCell(9, 31, 8, AIR); // pocket beside
    world.setCell(8, 31, 8, content);
    drain(engine);
    expectConsistent(world, `lamp cell ${content}`);
    return world;
  }

  it('stone lower slab + lamp upper slab: dark directly below, lit beside and above; swapped, the opposite', () => {
    let w = lampCell(canonCell(slab(B.STONE, LOWER), slab(B.LAMP, UPPER)));
    expect(w.getBlockLight(8, 31, 8)).toBe(15);
    expect(w.getBlockLight(8, 30, 8), 'below').toBe(0);
    expect(w.getBlockLight(8, 32, 8), 'above').toBe(14);
    expect(w.getBlockLight(9, 31, 8), 'beside').toBe(14);
    w = lampCell(canonCell(slab(B.LAMP, LOWER), slab(B.STONE, UPPER)));
    expect(w.getBlockLight(8, 30, 8), 'below').toBe(14);
    expect(w.getBlockLight(8, 32, 8), 'above').toBe(0);
    expect(w.getBlockLight(9, 31, 8), 'beside').toBe(14);
    // A west lamp slab with an east stone slab: the pocket on the east side gets nothing.
    w = lampCell(canonCell(slab(B.LAMP, WEST), slab(B.STONE, EAST)));
    expect(w.getBlockLight(9, 31, 8), 'beside (east)').toBe(0);
    expect(w.getBlockLight(8, 30, 8), 'below').toBe(14);
    expect(w.getBlockLight(8, 32, 8), 'above').toBe(14);
  });

  it('a lamp part that does not touch a face shines through it only where the face is open', () => {
    // Lamp upper slab with a glass lower slab: below is reached through the glass (open face).
    const w = lampCell(canonCell(slab(B.GLASS, LOWER), slab(B.LAMP, UPPER)));
    expect(w.getBlockLight(8, 30, 8)).toBe(14);
  });

  it('the lamp part comes and goes by changing only the second part', () => {
    const { world, engine } = solidWorld();
    world.setCell(8, 30, 8, AIR);
    world.setCell(8, 32, 8, AIR);
    world.setCell(8, 31, 8, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)));
    drain(engine);
    expect(world.getBlockLight(8, 32, 8)).toBe(0);
    world.setCell(8, 31, 8, canonCell(slab(B.STONE, LOWER), slab(B.LAMP, UPPER)));
    expect(engine.pending).toBeGreaterThan(0);
    drain(engine);
    expect(world.getBlockLight(8, 32, 8)).toBe(14);
    expect(world.getBlockLight(8, 30, 8)).toBe(0);
    world.setCell(8, 31, 8, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER)));
    drain(engine);
    expect(world.getBlockLight(8, 32, 8)).toBe(0);
    expectConsistent(world, 'second part');
  });
});

describe('changes of only the holes', () => {
  /**
   * A tunnel along x at y = 30 from a lamp at x = 4 to the cell X = (8, 30, 8), and a sealed air
   * pocket A = (8, 31, 8) on top of X: A is lit only through X's top face.
   */
  function tunnel(xContent: number): { world: World; engine: LightEngine } {
    const { world, engine } = solidWorld();
    for (let x = 5; x <= 7; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(4, 30, 8, LAMP);
    world.setCell(8, 31, 8, AIR);
    world.setCell(8, 30, 8, xContent);
    drain(engine);
    return { world, engine };
  }

  it('lower slab -> upper slab (same id and state): X keeps its light, the pocket on top goes dark (step 3)', () => {
    const lower = slab(B.STONE, LOWER);
    const { world, engine } = tunnel(lower);
    expect(world.getBlockLight(8, 30, 8)).toBe(11);
    expect(world.getBlockLight(8, 31, 8)).toBe(10);
    const upper = withHoles(lower, ~UPPER & 0xff);
    expect(upper & 0xffff).toBe(lower & 0xffff); // the base layer does not change
    world.setCell(8, 30, 8, upper);
    expect(engine.pending, 'the change is processed').toBeGreaterThan(0);
    drain(engine);
    expect(world.getBlockLight(8, 30, 8), 'X itself').toBe(11);
    expect(world.getBlockLight(8, 31, 8), 'the pocket on top').toBe(0);
    expectConsistent(world, 'upper');
    // And back: the face opens again.
    world.setCell(8, 30, 8, lower);
    drain(engine);
    expect(world.getBlockLight(8, 31, 8)).toBe(10);
    expectConsistent(world, 'lower again');
  });

  it('chiselling one octant opens the faces it lies on; filling it closes them again', () => {
    // X = (8, 30, 8) a stone cube without octant 7 (+x +y +z) at the end of a tunnel from a lamp
    // at x = 12; the pocket A = (8, 31, 8) on top of X.
    const chipped = slab(B.STONE, 0xff & ~0x80);
    const { world, engine } = solidWorld();
    for (let x = 9; x <= 11; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(12, 30, 8, LAMP);
    world.setCell(8, 31, 8, AIR);
    world.setCell(8, 30, 8, chipped);
    drain(engine);
    // X's medium is air (op 0): it is lit through its +x face, which octant 7 no longer fills,
    // and passes light on to A through its +y face, likewise.
    expect(world.getBlockLight(8, 30, 8)).toBe(11);
    expect(world.getBlockLight(8, 31, 8)).toBe(10);
    world.setCell(8, 30, 8, makeCell(B.STONE));
    drain(engine);
    expect(world.getBlockLight(8, 31, 8)).toBe(0);
    world.setCell(8, 30, 8, chipped);
    drain(engine);
    expect(world.getBlockLight(8, 31, 8)).toBe(10);
    expectConsistent(world, 'chipped');
  });

  it('a change that cannot matter is skipped: a glass slab in air, a stone slab turned into a planks slab', () => {
    const { world, engine } = solidWorld();
    // The skipped changes never reach the processing of a change (cellChanged's step 2).
    const processed = vi.spyOn(LightEngine.prototype as unknown as { changeGeneral: () => void }, 'changeGeneral');
    try {
      world.setCell(8, 61, 8, slab(B.GLASS, LOWER));
      world.setCell(8, 61, 8, slab(B.GLASS, WEST)); // only the holes change, but glass covers nothing
      expect(processed).not.toHaveBeenCalled();
      world.setCell(9, 61, 8, slab(B.STONE, LOWER));
      expect(processed).toHaveBeenCalledTimes(1);
      drain(engine);
      world.setCell(9, 61, 8, slab(B.PLANKS_OAK, LOWER)); // same opacity, same covers, no emission
      expect(processed).toHaveBeenCalledTimes(1);
      world.setCell(9, 61, 8, slab(B.PLANKS_OAK, UPPER)); // the covers change
      expect(processed).toHaveBeenCalledTimes(2);
    } finally {
      processed.mockRestore();
    }
    drain(engine);
    expectConsistent(world, 'skipped');
  });
});

describe('heightmap by direct() and the sky', () => {
  it('lower slab: sky enters it, the cell below is the top of the shade; upper slab: its own top face stops the sky', () => {
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 10));
    const c = world.getChunk(0, 0)!;
    world.setCell(3, 40, 3, slab(B.STONE, LOWER));
    world.setCell(5, 40, 5, slab(B.STONE, UPPER));
    world.setCell(7, 40, 7, slab(B.GLASS, UPPER)); // glass covers nothing: no shade at all
    drain(engine);
    expect(c.heightmap[3 | (3 << 4)]).toBe(40);
    expect(world.getSkyLight(3, 40, 3)).toBe(15);
    expect(world.getSkyLight(3, 39, 3)).toBe(14);
    expect(c.heightmap[5 | (5 << 4)]).toBe(41);
    expect(world.getSkyLight(5, 40, 5)).toBe(14);
    expect(c.heightmap[7 | (7 << 4)]).toBe(11);
    expectConsistent(world, 'slabs');
  });

  it('west slab over east slab: the upper layer is under open sky, the face between them stops it', () => {
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 10));
    const c = world.getChunk(0, 0)!;
    world.setCell(4, 40, 4, slab(B.STONE, WEST));
    world.setCell(4, 39, 4, slab(B.STONE, EAST));
    drain(engine);
    expect(c.heightmap[4 | (4 << 4)]).toBe(40);
    expect(world.getSkyLight(4, 40, 4)).toBe(15);
    expect(world.getSkyLight(4, 39, 4)).toBe(14);
    // Removing the upper slab (the cell above the old top) opens the column: the cell below it
    // was already 15, so the re-settled cell under it starts the fill.
    world.setCell(4, 40, 4, AIR);
    drain(engine);
    expect(c.heightmap[4 | (4 << 4)]).toBe(11);
    expect(world.getSkyLight(4, 39, 4)).toBe(15);
    expect(world.getSkyLight(4, 38, 4)).toBe(15);
    expectConsistent(world, 'opened');
    // And putting it back raises the top again.
    world.setCell(4, 40, 4, slab(B.STONE, WEST));
    drain(engine);
    expect(c.heightmap[4 | (4 << 4)]).toBe(40);
    expectConsistent(world, 'closed');
  });

  it('a deep shaft under a west/east pair opens and closes losslessly', () => {
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 60));
    for (let y = 30; y <= 60; y++) world.setCell(8, y, 8, AIR);
    world.setCell(8, 61, 8, slab(B.STONE, WEST));
    world.setCell(8, 60, 8, slab(B.STONE, EAST));
    drain(engine);
    expect(world.getSkyLight(8, 30, 8)).toBe(0);
    world.setCell(8, 60, 8, slab(B.STONE, WEST));
    drain(engine);
    expect(world.getSkyLight(8, 30, 8)).toBe(15);
    world.setCell(8, 60, 8, slab(B.STONE, EAST));
    drain(engine);
    expect(world.getSkyLight(8, 30, 8)).toBe(0);
    expectConsistent(world, 'shaft');
  });

  it('the bottom layer: a change at y = 0 that leaves the column open writes heightmap 0, and the column keeps working', () => {
    // Only the bottom layer is solid (y = 0); every column is open above it, heightmap 1.
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 0));
    const c = world.getChunk(0, 0)!;
    const hm = (x: number, z: number): number => c.heightmap[x | (z << 4)]!;
    // A stone lower slab at y = 0 (the chunk gets its holes layer): its top face is open and
    // it has no cell below, so the column never stops the straight-down sky.
    world.setCell(3, 0, 3, slab(B.STONE, LOWER));
    drain(engine);
    expect(hm(3, 3)).toBe(0);
    expect(world.getSkyLight(3, 0, 3)).toBe(15);
    expectConsistent(world, 'slab at y = 0');
    // A full cell at y = 0 of the holes chunk removed (full -> air by the face-rule path).
    world.setCell(8, 0, 8, AIR);
    drain(engine);
    expect(hm(8, 8)).toBe(0);
    expectConsistent(world, 'air at y = 0');
    // A glass slab at y = 0 of a column that was already open (hOld = 0): still 0.
    world.setCell(8, 0, 8, slab(B.GLASS, UPPER));
    drain(engine);
    expect(hm(8, 8)).toBe(0);
    // Later changes higher up in the same columns keep heightmap and light right.
    for (const [x, z] of [[3, 3], [8, 8]] as const) {
      world.setCell(x, 127, z, STONE);
      drain(engine);
      expect(hm(x, z)).toBe(128);
      expectConsistent(world, `stone at y = 127 over ${x},${z}`);
      world.setCell(x, 127, z, AIR);
      drain(engine);
      expect(hm(x, z)).toBe(0);
      expect(world.getSkyLight(x, 0, z)).toBe(15);
      expectConsistent(world, `stone at y = 127 over ${x},${z} removed`);
    }
    // The full stone back at y = 0: the column stops at 0 again.
    world.setCell(3, 0, 3, STONE);
    drain(engine);
    expect(hm(3, 3)).toBe(1);
    expectConsistent(world, 'stone back at y = 0');
  });

  it('the top layer: upper slabs close the virtual layer above, a lower slab is under open sky', () => {
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 10));
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.setCell(x, TOP_Y, z, slab(B.STONE, UPPER));
    world.setCell(4, TOP_Y, 4, AIR);
    world.setCell(8, TOP_Y, 8, slab(B.STONE, LOWER));
    drain(engine);
    expect(world.getSkyLight(4, TOP_Y, 4)).toBe(15);
    expect(world.getSkyLight(4, TOP_Y - 1, 4)).toBe(15);
    expect(world.getSkyLight(4, 11, 4)).toBe(15);
    expect(world.getSkyLight(8, TOP_Y, 8)).toBe(15);
    // Beside the hole: the upper slab's lower half is open to it.
    expect(world.getSkyLight(5, TOP_Y, 4)).toBe(14);
    expect(world.getChunk(0, 0)!.heightmap[8 | (8 << 4)]).toBe(TOP_Y);
    expect(world.getChunk(0, 0)!.heightmap[9 | (9 << 4)]).toBe(TOP_Y + 1);
    expectConsistent(world, 'top layer');
    world.setCell(4, TOP_Y, 4, slab(B.STONE, UPPER));
    drain(engine);
    expect(world.getSkyLight(4, 11, 4)).toBe(0);
    expectConsistent(world, 'top layer closed');
  });
});

describe('chunk borders with a holes layer on one side only', () => {
  it('partial emitters on the border light the chunk without layers, and the other way round', () => {
    const { world, engine } = solidWorld([
      [0, 0],
      [1, 0],
    ]);
    // Chunk 0 gets partial cells (a holes layer); chunk 1 stays full blocks only.
    world.setCell(15, 31, 8, canonCell(slab(B.STONE, LOWER), slab(B.LAMP, UPPER)));
    world.setCell(16, 31, 8, AIR);
    world.setCell(15, 30, 8, AIR);
    drain(engine);
    expect(world.getChunk(1, 0)!.holes).toBe(null);
    expect(world.getBlockLight(16, 31, 8)).toBe(14);
    expect(world.getBlockLight(15, 30, 8)).toBe(0);
    // A lamp in chunk 1 next to a partial cell of chunk 0 that closes the shared face.
    world.setCell(16, 35, 8, LAMP);
    world.setCell(15, 35, 8, slab(B.STONE, 0xff & ~0x01)); // octant 0 missing: the +x face is covered
    world.setCell(14, 35, 8, AIR);
    drain(engine);
    expect(world.getBlockLight(15, 35, 8)).toBe(0);
    world.setCell(15, 35, 8, slab(B.STONE, 0xff & ~0x02)); // octant 1 missing: on the +x face
    drain(engine);
    expect(world.getBlockLight(15, 35, 8)).toBe(14);
    expect(world.getBlockLight(14, 35, 8)).toBe(0); // octant 1 is not on the -x face
    expectConsistent(world, 'border');
  });

  it('a full cell beside a partial cell across the border changes by the face rule', () => {
    const { world, engine } = solidWorld([
      [0, 0],
      [1, 0],
    ]);
    // Chunk 0: an east stone slab at (15, 30, 8) closes the shared face by itself, its west half
    // lit from a lamp down a tunnel in chunk 0. Chunk 1 has no holes layer.
    world.setCell(15, 30, 8, slab(B.STONE, EAST));
    for (let x = 12; x <= 14; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(11, 30, 8, LAMP);
    drain(engine);
    expect(world.getBlockLight(15, 30, 8)).toBe(11);
    // A full block of chunk 1 next to it is dug out: nothing passes the closed face.
    world.setCell(16, 30, 8, AIR);
    drain(engine);
    expect(world.getBlockLight(16, 30, 8)).toBe(0);
    expectConsistent(world, 'border cell');
  });

  it('a removed border cell of the chunk without layers is refilled by the face rule: nothing through the face a slab across the border closes', () => {
    const { world, engine } = solidWorld([
      [0, 0],
      [1, 0],
    ]);
    // A tunnel along x at y = 30 from x = 13 to x = 20 across the border x = 15 | 16. At x = 15
    // an east stone slab closes the shared face by itself; a lamp at x = 13 lights its west half.
    for (let x = 13; x <= 20; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(15, 30, 8, slab(B.STONE, EAST));
    world.setCell(13, 30, 8, LAMP);
    // A second lamp at x = 20 lights the tunnel in chunk 1, which has no holes layer.
    world.setCell(20, 30, 8, LAMP);
    drain(engine);
    expect(world.getChunk(1, 0)!.holes).toBe(null);
    expect(world.getBlockLight(15, 30, 8)).toBe(13);
    expect(world.getBlockLight(16, 30, 8)).toBe(11);
    // The second lamp goes: the removal wave runs up to the border, and x = 16 asks its
    // neighbours what they give it now. The slab (13) gives nothing through the face it closes;
    // M1's pull would read its level through that face and give 12.
    world.setCell(20, 30, 8, STONE);
    drain(engine);
    for (let x = 16; x <= 19; x++) expect(world.getBlockLight(x, 30, 8), `x = ${x}`).toBe(0);
    expectConsistent(world, 'border refill');
  });

  it('the same with the partial cell already in the chunk when it is lit (no change of a partial cell is ever heard)', () => {
    const { world, engine } = lightWorld();
    const c0 = makeFlatChunk(0, 0, 60);
    const holes = new Uint8Array(c0.cells.length);
    const part2 = new Uint32Array(c0.cells.length);
    writeLayers(c0.cells, holes, part2, cellIndex(15, 30, 8), slab(B.STONE, EAST));
    for (let x = 12; x <= 14; x++) c0.cells[cellIndex(x, 30, 8)] = 0;
    c0.cells[cellIndex(11, 30, 8)] = LAMP;
    addLit(world, engine, new Chunk(0, 0, c0.cells, undefined, holes, part2));
    addLit(world, engine, makeFlatChunk(1, 0, 60));
    drain(engine);
    expect(world.getBlockLight(15, 30, 8)).toBe(11);
    world.setCell(16, 30, 8, AIR);
    drain(engine);
    expect(world.getBlockLight(16, 30, 8)).toBe(0);
    expectConsistent(world, 'border cell, layers from the start');
  });

  it('a chunk lit next to a chunk with partial cells on the shared border (exchange)', () => {
    const { world, engine } = solidWorld([[0, 0]]);
    // Border cells of chunk 0 (x = 15), each facing an enclosed air cell of chunk 1 (x = 16):
    // a lamp part touching the shared face (lower quadrants), the rest stone: 14 across.
    world.setCell(15, 31, 8, canonCell(slab(B.LAMP, LOWER), slab(B.STONE, UPPER)));
    // A lamp part away from the shared face, which the stone part covers: nothing across.
    world.setCell(15, 33, 8, canonCell(slab(B.LAMP, WEST), slab(B.STONE, EAST)));
    // An east slab lit from a sky shaft on its west side: its east face, covered, passes nothing.
    for (let y = 40; y <= 60; y++) world.setCell(14, y, 8, AIR);
    world.setCell(15, 40, 8, slab(B.STONE, EAST));
    drain(engine);
    expect(world.getSkyLight(15, 40, 8)).toBe(14);
    const late = makeFlatChunk(1, 0, 60);
    for (const y of [31, 33, 40]) late.cells[cellIndex(0, y, 8)] = 0;
    addLit(world, engine, late);
    drain(engine);
    expect(world.getBlockLight(16, 31, 8)).toBe(14);
    expect(world.getBlockLight(16, 33, 8)).toBe(0);
    expect(world.getSkyLight(16, 40, 8)).toBe(0);
    expectConsistent(world, 'exchange');
  });

  it('a chunk lit with emitters on the shared border lights the chunk that was there (through closed faces too)', () => {
    for (const layered of [true, false]) {
      const { world, engine } = solidWorld([[0, 0]]);
      // Chunk 0 (lit first): enclosed air cells at x = 15, and one stone west slab, whose east
      // face (the shared one) is open on its side.
      for (const y of [31, 33, 35]) world.setCell(15, y, 8, AIR);
      world.setCell(15, 37, 8, slab(B.STONE, WEST));
      world.setCell(14, 37, 8, AIR);
      drain(engine);
      // Chunk 1 arrives with its emitters on the border x = 16, with a holes layer or without.
      const late = makeFlatChunk(1, 0, 60);
      let holes: Uint8Array | null = null;
      let part2: Uint32Array | null = null;
      if (layered) {
        holes = new Uint8Array(late.cells.length);
        part2 = new Uint32Array(late.cells.length);
        // A lamp part on the shared face, stone east of it: the face is closed, the lamp touches it.
        writeLayers(late.cells, holes, part2, cellIndex(0, 31, 8), canonCell(slab(B.LAMP, WEST), slab(B.STONE, EAST)));
        // A lamp part away from the shared face, stone covering it: nothing across.
        writeLayers(late.cells, holes, part2, cellIndex(0, 33, 8), canonCell(slab(B.LAMP, EAST), slab(B.STONE, WEST)));
      }
      // A full lamp (closed face by its own cover) next to the air cell and next to the slab.
      late.cells[cellIndex(0, 35, 8)] = LAMP;
      late.cells[cellIndex(0, 37, 8)] = LAMP;
      addLit(world, engine, new Chunk(1, 0, late.cells, undefined, holes, part2));
      drain(engine);
      if (layered) {
        expect(world.getBlockLight(15, 31, 8)).toBe(14);
        expect(world.getBlockLight(15, 33, 8)).toBe(0);
      }
      expect(world.getBlockLight(15, 35, 8)).toBe(14);
      expect(world.getBlockLight(15, 37, 8)).toBe(14);
      expect(world.getBlockLight(14, 37, 8)).toBe(0); // the slab's west face is closed by its stone
      expectConsistent(world, `emitters on the border of the new chunk (layers: ${layered})`);
    }
  });
});

describe('the known approximation of section 7.1 (one light value per cell)', () => {
  it('a cell whose only empty octants are 0 and 7 passes light although they do not touch', () => {
    const { world, engine } = lightWorld();
    addLit(world, engine, makeFlatChunk(0, 0, 60));
    // A shaft from the sky down to y = 41, the chipped cell at y = 40, a pocket at y = 39.
    for (let y = 41; y <= 60; y++) world.setCell(8, y, 8, AIR);
    world.setCell(8, 40, 8, slab(B.STONE, 0xff & ~0x81));
    world.setCell(8, 39, 8, AIR);
    drain(engine);
    expectConsistent(world, 'approximation');
    // Octant 7 (top) is open to the shaft, octant 0 (bottom) to the pocket: by the face rule
    // light passes; by octants it would not (the half-cell flood does not reach the pocket).
    expect(world.getSkyLight(8, 39, 8)).toBe(15);
    expect(skyReachable(world)(8, 39, 8)).toBe(false);
  });

  it('a lamp part walled off by opaque material of its own cell still lights the cell, and through it the far side', () => {
    // Two sealed rooms in solid stone, A (x 4..7) and B (x 9..12), one wall cell (x = 8) between.
    const { world, engine } = solidWorld();
    for (let y = 20; y <= 22; y++) for (let z = 6; z <= 9; z++) for (let x = 4; x <= 12; x++) if (x !== 8) world.setCell(x, y, z, AIR);
    drain(engine);
    // The wall cell (8, 21, 8): lamp in the lower west quarter (octants 0, 4), stone over it and
    // east of it (octants 1, 2, 5, 6), the upper east quarter (octants 3, 7) empty. The empty
    // octants are connected, yet no lamp octant touches them: on the half-cell grid the lamp
    // reaches room A only. The cell has one light value, emit(c) = 15, and its east face is open
    // (the empty quarter), so room B gets 14, like room A.
    world.setCell(8, 21, 8, canonCell(slab(B.LAMP, 0x11), slab(B.STONE, 0x66)));
    drain(engine);
    expectConsistent(world, 'walled-off lamp part');
    expect(world.getBlockLight(8, 21, 8)).toBe(15);
    expect(world.getBlockLight(7, 21, 8)).toBe(14);
    expect(world.getBlockLight(9, 21, 8)).toBe(14);
  });
});

describe('listeners that rewrite cells', () => {
  for (const engineFirst of [true, false]) {
    it(`a listener ${engineFirst ? 'after' : 'before'} the engine that undoes changes of holes`, () => {
      const world = new World(1);
      const engine = new LightEngine(world);
      if (engineFirst) engine.attach();
      let busy = false;
      const lower = slab(B.STONE, LOWER);
      world.onCellChange((x, y, z, oldCell, newCell) => {
        // Upper slabs are not allowed at y = 31: put the old content back.
        if (!busy && y === 31 && newCell === withHoles(lower, ~UPPER & 0xff)) {
          busy = true;
          world.setCell(x, y, z, oldCell);
          busy = false;
        }
      });
      if (!engineFirst) engine.attach();
      addLit(world, engine, makeFlatChunk(0, 0, 60));
      for (let x = 5; x <= 7; x++) world.setCell(x, 31, 8, AIR);
      world.setCell(4, 31, 8, LAMP);
      world.setCell(8, 32, 8, AIR);
      world.setCell(8, 31, 8, lower);
      drain(engine);
      expect(world.getBlockLight(8, 32, 8)).toBe(10);
      world.setCell(8, 31, 8, withHoles(lower, ~UPPER & 0xff)); // undone by the listener
      expect(world.getCell(8, 31, 8)).toBe(lower);
      drain(engine);
      expect(world.getBlockLight(8, 32, 8)).toBe(10);
      expectConsistent(world, 'undone');
    });
  }
});
