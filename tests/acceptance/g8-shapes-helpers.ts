/**
 * Helpers of the shape scenarios (docs/ACCEPTANCE.md 38-47, docs/SHAPES.md 16.4): a flat world, a
 * showcase of partial cells (parts with holes, two-part cells, a two-part cell that fills its cell,
 * a stair, a single octant), and readings of grids as part labels (tests/shapes.ts partLabels), so
 * a scenario compares shapes as text. Scenes are built on the server (w.sim) by writing cells
 * directly: the tools that make partial blocks come in M2.4 (docs/SHAPES.md 14.1).
 */
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import type { Structure } from '../../src/structures/structure';
import type { CellBounds, VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator } from '../../src/worldgen/generator';
import { EAST, LOWER, NORTH, partLabels, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import type { SimSpec } from './g6-save-helpers';

/** First air above the flat world (deeprock 1, stone 30, dirt 3, turf 1). */
export const GROUND = 35;

/** A flat creative world for the shape scenarios. */
export function shapesSpec(seed: number, spawn = { x: 0.5, y: GROUND, z: 0.5 }): SimSpec {
  return { seed, mode: 'creative', generator: () => new FlatGenerator(), spawn, loadRadius: 3 };
}

/**
 * One of each kind of partial cell: a lower planks slab, an upper glass slab, a west stone slab,
 * a two-part cell (stone below, planks above), a two-part cell of one material that fills its cell,
 * a single octant of iron, a brick stair rising east, a wool block with one octant carved out,
 * two carved parts side by side (wool west, felt east, notches out of both), an oak log slab with
 * its axis state.
 */
export const SHOWCASE: readonly number[] = Object.freeze([
  slab(B.PLANKS_OAK, LOWER),
  slab(B.GLASS, UPPER),
  slab(B.STONE, WEST),
  canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)),
  canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)),
  slab(B.IRON_BLOCK, 0x80),
  slab(B.BRICKS, stairFill(PX)),
  slab(B.WOOL_WHITE, 0x7f),
  canonCell(slab(B.WOOL_WHITE, WEST & 0xfe), slab(B.WOOL_RED, EAST & 0x7f)),
  slab(B.LOG_OAK, LOWER, 2),
]);

/** Write `cells` in a row along +X from (x0, y, z). */
export function placeRow(grid: VoxelGrid, x0: number, y: number, z: number, cells: readonly number[]): void {
  cells.forEach((c, i) => grid.setCell(x0 + i, y, z, c));
}

/**
 * A raft for scenario 47: a 5 x 4 planks deck at y = GROUND - 1 from (x0, z0) to +X, +Z, a helm
 * facing north on its first row (the side a player standing north of it sees), partial cells on
 * its last row.
 */
export function partialRaft(sim: Simulation, x0: number, z0: number): { helm: [number, number, number] } {
  const w = sim.world;
  for (let x = x0; x < x0 + 5; x++) for (let z = z0; z < z0 + 4; z++) w.setCell(x, GROUND - 1, z, makeCell(B.PLANKS_OAK));
  const helm: [number, number, number] = [x0 + 2, GROUND, z0];
  w.setCell(helm[0], helm[1], helm[2], makeCell(B.HELM, NZ));
  // Partial cells of planks: their faces overlap the deck's, so they auto-stick like planks.
  const zb = z0 + 3;
  w.setCell(x0, GROUND, zb, slab(B.PLANKS_OAK, LOWER));
  w.setCell(x0 + 1, GROUND, zb, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
  w.setCell(x0 + 2, GROUND, zb, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_PINE, UPPER)));
  w.setCell(x0 + 3, GROUND, zb, slab(B.PLANKS_OAK, stairFill(PX)));
  return { helm };
}

/** Part labels of a box of the world (inclusive corners). */
export function worldLabels(sim: Simulation, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  const box: CellBounds = { minX: x0, minY: y0, minZ: z0, maxX: x1 + 1, maxY: y1 + 1, maxZ: z1 + 1 };
  return partLabels(sim.world, box);
}

/** Part labels of every cell of a structure, in its local coordinates. */
export function structureLabels(s: Structure): string[] {
  const b = s.grid.cellBounds();
  return b === null ? [] : partLabels(s.grid, b);
}
