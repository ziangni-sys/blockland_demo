/**
 * Test grids for the stick / glue / collect tests. Every scenario is written in RELATIVE
 * coordinates and runs on two grids:
 *  - a World whose origin straddles chunk borders at negative world x/z;
 *  - a StructureGrid whose origin is negative on every axis (structure-local space).
 * Worlds are built by hand (new Chunk + setCell), never through worldgen.
 */
import { makeCell } from '../../src/blocks/cell';
import { CHUNK_SHIFT } from '../../src/core/constants';
import type { Dir } from '../../src/core/dirs';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { GlueStore } from '../../src/structures/glue';

export interface Harness {
  readonly name: string;
  readonly grid: VoxelGrid;
  readonly glue: GlueStore;
  /** Added to scenario coordinates to get grid coordinates. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Set a cell (scenario coordinates). `cell` may be a block id or a full cell value. */
  set(x: number, y: number, z: number, cell: number): void;
  /** Fill the inclusive box with one cell value (scenario coordinates). */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void;
  /** Glue the face from (x,y,z) towards dir (scenario coordinates). */
  glueFace(x: number, y: number, z: number, dir: Dir): void;
  /** Scenario -> grid coordinates. */
  abs(x: number, y: number, z: number): [number, number, number];
  /** Grid -> scenario coordinates as a "x,y,z" key. */
  relKey(x: number, y: number, z: number): string;
}

function ensureChunk(world: World, x: number, z: number): void {
  const cx = x >> CHUNK_SHIFT;
  const cz = z >> CHUNK_SHIFT;
  if (!world.getChunk(cx, cz)) world.addChunk(new Chunk(cx, cz));
}

function makeHarness(
  name: string,
  grid: VoxelGrid,
  ox: number,
  oy: number,
  oz: number,
  beforeSet: (x: number, y: number, z: number) => void,
): Harness {
  const glue = new GlueStore();
  const h: Harness = {
    name,
    grid,
    glue,
    ox,
    oy,
    oz,
    set(x, y, z, cell) {
      beforeSet(x + ox, y + oy, z + oz);
      grid.setCell(x + ox, y + oy, z + oz, cell);
    },
    fill(x0, y0, z0, x1, y1, z1, cell) {
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) h.set(x, y, z, cell);
    },
    glueFace(x, y, z, dir) {
      glue.add(x + ox, y + oy, z + oz, dir);
    },
    abs(x, y, z) {
      return [x + ox, y + oy, z + oz];
    },
    relKey(x, y, z) {
      return `${x - ox},${y - oy},${z - oz}`;
    },
  };
  return h;
}

/** World harness: origin (-9, 60, -7), chunks around it pre-loaded with air, more on demand. */
export function worldHarness(): Harness {
  const world = new World(1);
  const ox = -9;
  const oy = 60;
  const oz = -7;
  for (let x = ox - 16; x <= ox + 16; x += 16) for (let z = oz - 16; z <= oz + 16; z += 16) ensureChunk(world, x, z);
  return makeHarness('World', world, ox, oy, oz, (x, _y, z) => ensureChunk(world, x, z));
}

/** StructureGrid harness: local origin (-6, -5, -4), so scenarios span negative and positive local coords. */
export function structureHarness(): Harness {
  const grid = new StructureGrid(7, new World(2));
  return makeHarness('StructureGrid', grid, -6, -5, -4, () => {});
}

export const HARNESSES: ReadonlyArray<() => Harness> = [worldHarness, structureHarness];

/** Shorthand for a plain cell of a block id (state 0). */
export const c = (id: number, state = 0): number => makeCell(id, state);

/** Set of "x,y,z" keys (scenario coordinates) of a CollectResult's cells. */
export function cellKeys(h: Harness, cells: Int32Array, count = cells.length / 3): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < count; i++) s.add(h.relKey(cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!));
  return s;
}

export function keysOfBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push(`${x},${y},${z}`);
  return out;
}
