import { describe, expect, it } from 'vitest';
import { B, CELL_BELOW_WORLD } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { buildMesh } from '../../src/mesh/mesher';
import { sectionNeighborsLoaded, snapshotSection, snapshotStructure } from '../../src/mesh/snapshot';
import type { MeshInput } from '../../src/mesh/types';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { allQuads, bounds, checkInvariants, idx } from './helpers';

/** A world with chunks cx, cz in [-1, 1] whose cells encode their position. */
function makeWorld(loaded: Array<[number, number]> = []): World {
  const world = new World(42);
  const list = loaded.length > 0 ? loaded : [-1, 0, 1].flatMap((cx) => [-1, 0, 1].map((cz) => [cx, cz] as [number, number]));
  for (const [cx, cz] of list) {
    const c = new Chunk(cx, cz);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          // A distinct id per chunk keeps cells recognisable; light encodes y and x.
          c.cells[cellIndex(lx, y, lz)] = makeCell(chunkBlock(cx, cz), y & 7);
          c.light[cellIndex(lx, y, lz)] = ((y & 15) << 4) | (lx & 15);
        }
      }
    }
    world.addChunk(c);
  }
  return world;
}
function chunkBlock(cx: number, cz: number): number {
  const ids = [B.STONE, B.DIRT, B.SAND, B.GRAVEL, B.COBBLE, B.CLAY, B.BRICKS, B.IRON_BLOCK, B.SNOW_BLOCK];
  return ids[(cx + 1) * 3 + (cz + 1)]!;
}
/** Read the snapshot at section-relative coordinates (margin = -1 / 16). */
function at(input: MeshInput, x: number, y: number, z: number): { cell: number; light: number } {
  const i = idx(input, x, y, z);
  return { cell: input.cells[i]!, light: input.light![i]! };
}

describe('snapshotSection', () => {
  it('copies the interior and the margins across chunk borders', () => {
    const world = makeWorld();
    const s = snapshotSection(world, 0, 2, 0); // world y 32..47
    expect(s.sx).toBe(16);
    expect(s.cells.length).toBe(18 * 18 * 18);
    expect(s.light!.length).toBe(18 * 18 * 18);
    // interior
    expect(at(s, 3, 4, 5)).toEqual({ cell: makeCell(chunkBlock(0, 0), 36 & 7), light: ((36 & 15) << 4) | 3 });
    // -x margin comes from chunk (-1, 0), local x 15
    expect(at(s, -1, 0, 0)).toEqual({ cell: makeCell(chunkBlock(-1, 0), 32 & 7), light: ((32 & 15) << 4) | 15 });
    // +z margin from chunk (0, 1); the corner from chunk (1, -1)
    expect(at(s, 0, 0, 16).cell).toBe(makeCell(chunkBlock(0, 1), 32 & 7));
    expect(at(s, 16, 0, -1).cell).toBe(makeCell(chunkBlock(1, -1), 32 & 7));
    expect(at(s, 16, 0, -1).light).toBe(((32 & 15) << 4) | 0);
    // vertical margins come from the sections above and below
    expect(at(s, 0, -1, 0).cell).toBe(makeCell(chunkBlock(0, 0), 31 & 7));
    expect(at(s, 0, 16, 0).cell).toBe(makeCell(chunkBlock(0, 0), 48 & 7));
  });

  it('matches World.getCell / getLightRaw everywhere for negative chunk coordinates', () => {
    const world = makeWorld();
    const s = snapshotSection(world, -1, 3, -1);
    for (let y = -1; y <= 16; y++) {
      for (let z = -1; z <= 16; z++) {
        for (let x = -1; x <= 16; x++) {
          const wx = -16 + x;
          const wy = 48 + y;
          const wz = -16 + z;
          const got = at(s, x, y, z);
          const loaded = world.isLoaded(wx, wz);
          if (loaded) {
            expect(got.cell).toBe(world.getCell(wx, wy, wz));
            expect(got.light).toBe(world.getLightRaw(wx, wy, wz));
          } else {
            expect(got.cell).toBe(0);
          }
        }
      }
    }
  });

  it('above the world is AIR with full sky; below the world is opaque deeprock with no light', () => {
    const world = makeWorld();
    const top = snapshotSection(world, 0, 7, 0);
    expect(at(top, 4, 16, 4)).toEqual({ cell: 0, light: 0xf0 });
    expect(at(top, -1, 16, 16)).toEqual({ cell: 0, light: 0xf0 });
    const bottom = snapshotSection(world, 0, 0, 0);
    expect(at(bottom, 4, -1, 4)).toEqual({ cell: CELL_BELOW_WORLD, light: 0 });
    expect(at(bottom, 16, -1, -1)).toEqual({ cell: CELL_BELOW_WORLD, light: 0 });
    // the lowest layer's bottom faces are therefore culled
    const m = buildMesh(bottom);
    checkInvariants(m);
    expect(allQuads(m).some((q) => q.nb[1] < 0 && q.p.every((p) => p.y === 0))).toBe(false);
  });

  it('treats unloaded neighbours as AIR with the light World.getLightRaw reports', () => {
    const world = makeWorld([[0, 0]]);
    const s = snapshotSection(world, 0, 1, 0);
    expect(at(s, -1, 3, 3)).toEqual({ cell: 0, light: world.getLightRaw(-1, 19, 3) });
    expect(at(s, 16, 3, 16)).toEqual({ cell: 0, light: 0xf0 });
    expect(at(s, 3, 3, 3).cell).toBe(world.getCell(3, 19, 3));
  });

  it('meshes a section whose border cube is hidden by the neighbouring chunk', () => {
    const world = new World(1);
    for (const [cx, cz] of [
      [0, 0],
      [1, 0],
    ]) {
      world.addChunk(new Chunk(cx!, cz!));
    }
    world.setCell(15, 20, 3, makeCell(B.STONE));
    world.setCell(16, 20, 3, makeCell(B.STONE)); // in chunk (1, 0)
    const m = buildMesh(snapshotSection(world, 0, 1, 0));
    expect(allQuads(m).length).toBe(5); // +x face culled by the neighbour chunk's cube
  });
});

describe('sectionNeighborsLoaded', () => {
  it('requires the chunk and all eight neighbours', () => {
    const world = makeWorld();
    expect(sectionNeighborsLoaded(world, 0, 0)).toBe(true);
    expect(sectionNeighborsLoaded(world, 1, 0)).toBe(false);
    world.removeChunk(-1, 1);
    expect(sectionNeighborsLoaded(world, 0, 0)).toBe(false);
    expect(sectionNeighborsLoaded(new World(), 0, 0)).toBe(false);
  });
});

describe('snapshotStructure', () => {
  it('returns null for an empty grid', () => {
    const world = new World();
    expect(snapshotStructure(new StructureGrid(1, world))).toBeNull();
    const g = new StructureGrid(2, world);
    g.setCell(3, 3, 3, makeCell(B.STONE));
    g.setCell(3, 3, 3, 0);
    expect(snapshotStructure(g)).toBeNull();
  });

  it('snapshots the tight bounds box, with negative local coordinates', () => {
    const world = new World();
    const g = new StructureGrid(5, world);
    g.setCell(-3, -1, 2, makeCell(B.PLANKS_OAK));
    g.setCell(-2, -1, 2, makeCell(B.PLANKS_OAK));
    g.setCell(-3, 0, 4, makeCell(B.WOOL_RED));
    const snap = snapshotStructure(g)!;
    expect(snap).not.toBeNull();
    expect([snap.ox, snap.oy, snap.oz]).toEqual([-3, -1, 2]);
    const inp = snap.input;
    expect([inp.sx, inp.sy, inp.sz]).toEqual([2, 2, 3]);
    expect(inp.light).toBeNull();
    expect(inp.cells.length).toBe(4 * 4 * 5);
    expect(inp.cells[idx(inp, 0, 0, 0)]).toBe(makeCell(B.PLANKS_OAK));
    expect(inp.cells[idx(inp, 1, 0, 0)]).toBe(makeCell(B.PLANKS_OAK));
    expect(inp.cells[idx(inp, 0, 1, 2)]).toBe(makeCell(B.WOOL_RED));
    // everything else, margin included, is AIR
    let nonAir = 0;
    for (const c of inp.cells) if (c !== 0) nonAir++;
    expect(nonAir).toBe(3);

    // mesh vertices + (ox, oy, oz) land on the structure's local cells
    const m = buildMesh(inp);
    checkInvariants(m);
    const b = bounds(m);
    expect([b.min.x + snap.ox, b.min.y + snap.oy, b.min.z + snap.oz]).toEqual([-3, -1, 2]);
    expect([b.max.x + snap.ox, b.max.y + snap.oy, b.max.z + snap.oz]).toEqual([-1, 1, 5]);
    // no voxel light: full sky, still AO-capable
    for (const q of allQuads(m)) expect(q.sky.every((s) => s === 255)).toBe(true);
  });

  it('copies correctly when storage is larger than the bounds', () => {
    const world = new World();
    const g = new StructureGrid(9, world);
    g.setCell(10, 10, 10, makeCell(B.STONE));
    g.setCell(-5, 4, 0, makeCell(B.GLASS)); // forces a large, offset storage box
    g.setCell(-5, 4, 0, 0); // bounds shrink back while storage stays large
    g.setCell(9, 10, 11, makeCell(B.DIRT));
    const snap = snapshotStructure(g)!;
    expect([snap.ox, snap.oy, snap.oz]).toEqual([9, 10, 10]);
    expect([snap.input.sx, snap.input.sy, snap.input.sz]).toEqual([2, 1, 2]);
    for (let y = 0; y < 1; y++) {
      for (let z = 0; z < 2; z++) {
        for (let x = 0; x < 2; x++) {
          expect(snap.input.cells[idx(snap.input, x, y, z)]).toBe(g.getCell(x + 9, y + 10, z + 10));
        }
      }
    }
  });
});
