/**
 * Child-process probe for tests/voxel/ray-alloc.test.ts (not a test file itself): heap bytes per
 * raycastGrid / raycastGrids call, on full blocks, partial cells and two-part cells, in the World
 * and in a rotated StructureGrid. Bundled and run in a fresh node process in both inlining
 * conditions by tests/heap-probe-run.ts.
 *
 * Every ray that hits allocates its GridHit and its point, so the measurement loop is not the one
 * of tests/heap-probe.ts: that one repeats a case until a round is allocation-free and runs
 * 200000 calls per round, which with the sampling profiler (an object every 64 bytes) would take
 * minutes here. This loop warms each case up once and keeps the best of a few shorter rounds;
 * otherwise it measures the same way (V8's sampling heap profiler, objects already collected by
 * minor and major GC included).
 */
import { Session } from 'node:inspector/promises';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { type Vec3 } from '../../src/core/math';
import { Chunk } from '../../src/voxel/chunk';
import type { VoxelGrid } from '../../src/voxel/grid';
import { raycastGrid, raycastGrids } from '../../src/voxel/raycast';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, UPPER, slab } from '../shapes';

const WARM = 100_000;
const CALLS = 20_000;
const ROUNDS = 3;

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}
function totalBytes(n: ProfileNode): number {
  let t = n.selfSize;
  for (const c of n.children) t += totalBytes(c);
  return t;
}

const world = new World(1);
for (let cx = -1; cx <= 0; cx++) for (let cz = -1; cz <= 0; cz++) world.addChunk(new Chunk(cx, cz));
const STONE = makeCell(B.STONE);
const SLAB = slab(B.STONE, LOWER);
const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
/** Stone in octants 0, 1 and planks in 4, 5: a two-part cell whose upper half is empty. */
const TWO_LOW = canonCell(slab(B.STONE, 0x03), slab(B.PLANKS_OAK, 0x30));
// Rows along -Z at y = 60 (rays start at z = 3.5 and run toward -Z):
//  x = 0: a full block at z = -1;            x = 2: a lower slab at z = -1;
//  x = 4: three lower slabs, then a full block; x = 6: a two-part cell (stone below, planks above);
//  x = 8: three TWO_LOW cells, then a full block; x = 10: nothing;
//  x = 12: three lower slabs, then nothing;    x = 14: three TWO_LOW cells, then nothing.
world.setCell(0, 60, -1, STONE);
world.setCell(2, 60, -1, SLAB);
world.setCell(6, 60, -1, TWO);
for (let z = 0; z >= -2; z--) {
  world.setCell(4, 60, z, SLAB);
  world.setCell(12, 60, z, SLAB);
  world.setCell(8, 60, z, TWO_LOW);
  world.setCell(14, 60, z, TWO_LOW);
}
world.setCell(4, 60, -3, STONE);
world.setCell(8, 60, -3, STONE);
// A rotated ship above the rows with the same kinds of cells, hit from above.
const ship = new StructureGrid(1, world);
ship.setPoseImmediate({ x: 0.3, y: 70.2, z: 0.1 }, { x: 0, y: Math.sin(0.35), z: 0, w: Math.cos(0.35) });
ship.setCell(0, 0, 0, STONE);
ship.setCell(0, 0, 2, SLAB);
ship.setCell(0, 0, 4, TWO);

const SOUTH = { x: 0, y: 0, z: -1 };
const DOWN = { x: 0, y: -1, z: 0 };
/** n rays along -Z in column x at height y, the origin varying inside the column. */
const row = (g: VoxelGrid, x: number, y: number) => (n: number): number => {
  let s = 0;
  const o = { x, y, z: 3.5 };
  for (let i = 0; i < n; i++) {
    o.x = x + 0.25 + (i & 7) / 16;
    const h = raycastGrid(g, o, SOUTH, 8);
    if (h !== null) s += h.dist + h.octant;
  }
  return s;
};
/** n rays straight down onto world cell (x, 60, z), from above its -X, -Z quarter. */
const fromAbove = (x: number, z: number) => (n: number): number => {
  let s = 0;
  const o = { x, y: 63, z };
  for (let i = 0; i < n; i++) {
    o.x = x + 0.0625 + (i & 3) / 16; // stays in the cell's -X half
    o.z = z + 0.0625 + ((i >> 2) & 3) / 16; // and its -Z half
    const h = raycastGrid(world, o, DOWN, 8);
    if (h !== null) s += h.dist + h.face;
  }
  return s;
};
/** n rays straight down onto the ship's cell (0, 0, lz), hitting its upper half (or its lower one when that is empty). */
const shipRay = (lz: number) => (n: number): number => {
  let s = 0;
  const target: Vec3 = ship.toWorld({ x: 0.5, y: 0.25, z: lz + 0.5 }, { x: 0, y: 0, z: 0 });
  const o = { x: target.x, y: target.y + 3, z: target.z };
  for (let i = 0; i < n; i++) {
    o.y = target.y + 3 + (i & 7) / 16;
    const h = raycastGrid(ship, o, DOWN, 8);
    if (h !== null) s += h.dist;
  }
  return s;
};
const both: VoxelGrid[] = [world, ship];
const shipOnly: VoxelGrid[] = [ship];
/** n rays of raycastGrids along row x = 0 (a world block hit; the rays miss the ship's box). */
const multi = (grids: VoxelGrid[]) => (n: number): number => {
  let s = 0;
  const o = { x: 0, y: 60.25, z: 3.5 };
  for (let i = 0; i < n; i++) {
    o.x = 0.25 + (i & 7) / 16;
    const h = raycastGrids(grids, o, SOUTH, 8);
    if (h !== null) s += h.dist;
  }
  return s;
};

const cases: Record<string, (n: number) => number> = {
  'world: full block hit': row(world, 0, 60.25),
  'world: miss through air': row(world, 10, 60.25),
  'world: over three slabs, miss': row(world, 12, 60.75),
  'world: through three two-part cells, miss': row(world, 14, 60.75),
  'world: slab hit (cell face)': row(world, 2, 60.25),
  'world: slab top hit (inner face)': fromAbove(2, -1),
  'world: over three slabs to a full block': row(world, 4, 60.75),
  'world: through three two-part cells to a full block': row(world, 8, 60.75),
  'world: two-part cell hit, lower part': row(world, 6, 60.25),
  'world: two-part cell hit, upper part': row(world, 6, 60.75),
  'ship: full block hit': shipRay(0),
  'ship: slab top hit (inner face)': shipRay(2),
  'ship: two-part cell hit': shipRay(4),
  'raycastGrids world+ship: world block hit': multi(both),
  'raycastGrids ship only: miss': multi(shipOnly),
};

const sampling = { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true };
const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
// A throwaway session first: the profiler's first start allocates internal structures.
await session.post('HeapProfiler.startSampling', sampling as never);
await session.post('HeapProfiler.stopSampling');
const out: Record<string, number> = {};
let sink = 0;
for (const [name, run] of Object.entries(cases)) {
  sink += run(WARM);
  let best = Infinity;
  for (let r = 0; r < ROUNDS; r++) {
    await session.post('HeapProfiler.startSampling', sampling as never);
    sink += run(CALLS);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    best = Math.min(best, totalBytes(profile.head) / CALLS);
  }
  out[name] = best;
}
session.disconnect();
process.stdout.write(JSON.stringify({ bytesPerCall: out, sink }) + '\n');
