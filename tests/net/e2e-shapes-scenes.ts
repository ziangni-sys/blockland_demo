/**
 * Scenes of the end-to-end tests with partial blocks (tests/net/e2e-shapes-*.test.ts; docs/SHAPES.md
 * 16.2 P10): real HeadlessClients against a real ServerHost (tests/net/harness.ts) on the flat sea
 * of tests/net/e2e-scenes.ts. Partial cells are written on the server (the tools that make them come
 * in M2.4, docs/SHAPES.md 14.1).
 */
import { cellSecond, facingState, ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { ItemEntity } from '../../src/entities/entity';
import type { CellBounds, VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import type { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, partLabels, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import type { HeadlessClient } from './harness';
import { fill, loadArea, SEA_TOP } from './e2e-scenes';

/** The surface layer of the sea, where rafts float. */
export const DECK = SEA_TOP - 1;

/** One of each kind of partial cell (as tests/acceptance/g8-shapes-helpers.ts SHOWCASE). */
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
 * A raft at the sea's surface: a 5 x 6 planks deck (x0..x0+4, z0..z0+5), a helm facing north at
 * (x0 + 2, SEA_TOP, z0 + 4), and partial cells of planks, stone, pine and red wool on its bow row
 * (z0) at SEA_TOP: a lower slab, a west/east two-part cell, a lower/upper two-part cell, a stair, a
 * north/south two-part cell. Returns the helm.
 */
export function partialRaft(sim: Simulation, x0: number, z0: number): { x: number; y: number; z: number } {
  loadArea(sim, x0 - 8, z0 - 8, x0 + 12, z0 + 13);
  fill(sim, x0, DECK, z0, x0 + 4, DECK, z0 + 5, B.PLANKS_OAK);
  const helm = { x: x0 + 2, y: SEA_TOP, z: z0 + 4 };
  sim.world.setCell(helm.x, helm.y, helm.z, makeCell(B.HELM, facingState(NZ)));
  placeRow(sim.world, x0, SEA_TOP, z0, RAFT_PARTS);
  return helm;
}
export const RAFT_PARTS: readonly number[] = Object.freeze([
  slab(B.PLANKS_OAK, LOWER),
  canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)),
  canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_PINE, UPPER)),
  slab(B.PLANKS_OAK, stairFill(PX)),
  canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.WOOL_RED, SOUTH)),
]);

/** Part labels (tests/shapes.ts partLabels) of an inclusive box of a world. */
export function boxLabels(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  const box: CellBounds = { minX: x0, minY: y0, minZ: z0, maxX: x1 + 1, maxY: y1 + 1, maxZ: z1 + 1 };
  return partLabels(world, box);
}

/** An inclusive box of world cells. */
export type Box = readonly [number, number, number, number, number, number];

/** Parts per block id: world cells of a box, every structure, item stacks lying in the world. */
export interface PartCount {
  [id: number]: number;
}

function addCell(out: Map<number, number>, packed: number, ids: ReadonlySet<number>): void {
  const a = packed & ID_MASK;
  if (ids.has(a)) out.set(a, (out.get(a) ?? 0) + 1);
  const p2 = cellSecond(packed);
  if (p2 !== 0 && ids.has(p2 & ID_MASK)) out.set(p2 & ID_MASK, (out.get(p2 & ID_MASK) ?? 0) + 1);
}

/**
 * Count the parts of `ids`: in the world cells of `box` (getPacked reads both parts), in every
 * structure, and in the item stacks lying around (an item of a block id counts as that block).
 * Returns "id:count" strings sorted, so a test compares them as text.
 */
export function countParts(
  world: VoxelGrid,
  structures: Iterable<{ grid: { forEachCell(fn: (x: number, y: number, z: number, packed: number) => void): void } }>,
  items: Iterable<{ item: number; count: number }>,
  box: Box,
  ids: readonly number[],
): string[] {
  const set = new Set(ids);
  const out = new Map<number, number>();
  for (const id of ids) out.set(id, 0);
  const [x0, y0, z0, x1, y1, z1] = box;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = getPacked(world, x, y, z);
        if (c !== 0) addCell(out, c, set);
      }
    }
  }
  for (const s of structures) s.grid.forEachCell((_x, _y, _z, p) => addCell(out, p, set));
  for (const it of items) if (set.has(it.item)) out.set(it.item, out.get(it.item)! + it.count);
  return [...out].map(([id, n]) => `${id}:${n}`);
}

/** Parts on the server (see countParts): the world, its structures, the item entities. */
export function serverParts(sim: Simulation, box: Box, ids: readonly number[]): string[] {
  const items: Array<{ item: number; count: number }> = [];
  for (const e of sim.entities.all()) if (!e.removed && e instanceof ItemEntity) items.push(e.stack);
  return countParts(sim.world, sim.structures.all(), items, box, ids);
}

/** Parts in a client's replica (see countParts), or null while a column of the box is missing there. */
export function replicaParts(c: HeadlessClient, box: Box, ids: readonly number[]): string[] | null {
  const r = c.replica;
  if (r === null || !c.ready) return null;
  for (let cx = box[0] >> 4; cx <= box[3] >> 4; cx++) for (let cz = box[2] >> 4; cz <= box[5] >> 4; cz++) if (!r.chunks.present(cx, cz)) return null;
  const items: Array<{ item: number; count: number }> = [];
  for (const e of r.state.entities.values()) if (e.kind === 'item') items.push({ item: e.item, count: e.count });
  return countParts(r.world, [...r.state.structures.values()].map((rs) => rs.structure), items, box, ids);
}
