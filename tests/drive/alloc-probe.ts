/**
 * Child-process probe for tests/drive/alloc.test.ts (not a test file itself): heap bytes per
 * BodyMover tick, measured like tests/voxel/alloc-probe.ts (bundled with rolldown, V8's sampling
 * heap profiler, best of several rounds of optimised code).
 *
 * Cases:
 *  - 'walk on land': the world only (the voxel queries' world path is allocation-free), a player
 *    walking in a small circle and jumping, inside one chunk;
 *  - 'stand on a moving deck': a deck structure moving and turning under a standing player. The
 *    voxel queries against a structure allocate their local box (voxel/shape.ts structureObb), so
 *    this case measures that, not the mover.
 */
import { Session } from 'node:inspector/promises';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qfromYaw, quat, vec3, type Quat } from '../../src/core/math';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyStructure } from '../../src/entities/body';
import { Player } from '../../src/entities/entity';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';

const CALLS = 50_000;
const ROUNDS = 6;
const CLEAN = 0.05;

const world = new World(1);
world.addChunk(new Chunk(0, 0));
for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.setCell(x, 10, z, makeCell(B.STONE));

// ---- walk on land
const none: readonly BodyStructure[] = [];
const landMover = new BodyMover({ world, structures: () => none });
const walker = new Player(1, 'survival');
walker.setPosition(8.5, 11, 8.5);
walker.input.forward = 1;
let age = 0;
function landTick(): void {
  age++;
  const i = walker.input;
  i.yaw = age * 0.1;
  i.jump = age % 40 < 2;
  landMover.beginCarry();
  landMover.beginStep(walker);
  sanitizeInput(walker);
  landMover.stepPlayer(walker, takeJumpPresses(walker), false);
  landMover.endTick();
}

// ---- stand on a moving deck
const grid = new StructureGrid(5, world);
for (let x = 4; x < 12; x++) for (let z = 4; z < 12; z++) grid.setCell(x, 20, z, makeCell(B.PLANKS_OAK));
grid.pivot.x = 8;
grid.pivot.y = 20.5;
grid.pivot.z = 8;
grid.setPoseImmediate(vec3(8, 20.5, 8), quat());
const deck: BodyStructure = { id: 5, grid, parent: null, children: [], removed: false, hull: null };
const deckList: readonly BodyStructure[] = [deck];
const deckMover = new BodyMover({ world, structures: () => deckList });
const rider = new Player(2, 'survival');
rider.setPosition(8.5, 21, 8.5);
const q: Quat = quat();
let t = 0;
function deckTick(): void {
  t++;
  grid.snapshotPose();
  grid.position.y = 20.5 + 0.1 * Math.sin(t * 0.05);
  qfromYaw(0.3 * Math.sin(t * 0.02), q);
  grid.rotation.x = q.x;
  grid.rotation.y = q.y;
  grid.rotation.z = q.z;
  grid.rotation.w = q.w;
  deckMover.beginCarry();
  if (rider.carrierId !== 0) deckMover.carryRider(rider);
  deckMover.beginStep(rider);
  sanitizeInput(rider);
  deckMover.stepPlayer(rider, takeJumpPresses(rider), false);
  deckMover.endTick();
}

const cases: Record<string, (n: number) => number> = {
  'walk on land': (n) => {
    for (let i = 0; i < n; i++) landTick();
    return walker.pos.x;
  },
  'stand on a moving deck': (n) => {
    for (let i = 0; i < n; i++) deckTick();
    return rider.pos.x;
  },
};

interface ProfileNode {
  selfSize: number;
  children: ProfileNode[];
}
function totalBytes(n: ProfileNode): number {
  let s = n.selfSize;
  for (const c of n.children) s += totalBytes(c);
  return s;
}

const SAMPLING = { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true };
const session = new Session();
session.connect();
await session.post('HeapProfiler.enable');
await session.post('HeapProfiler.startSampling', SAMPLING as never);
await session.post('HeapProfiler.stopSampling');
const out: Record<string, number> = {};
let sink = 0;
for (const [name, run] of Object.entries(cases)) {
  let best = Infinity;
  for (let r = 0; r < ROUNDS && best > CLEAN; r++) {
    sink += run(CALLS * 2);
    await session.post('HeapProfiler.startSampling', SAMPLING as never);
    sink += run(CALLS);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    best = Math.min(best, totalBytes(profile.head) / CALLS);
  }
  out[name] = best;
}
session.disconnect();
process.stdout.write(JSON.stringify({ bytesPerCall: out, sink, carried: rider.carrierId }) + '\n');
