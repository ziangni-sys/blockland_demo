/**
 * Child-process probe for tests/drive/alloc.test.ts (not a test file itself): heap bytes per
 * BodyMover tick, measured like tests/voxel/alloc-probe.ts (bundled with rolldown, V8's sampling
 * heap profiler, best of several rounds of optimised code).
 *
 * Cases:
 *  - 'walk on land': the world only (the voxel queries' world path is allocation-free), a player
 *    walking in a small circle and jumping, inside one chunk;
 *  - 'walk on slabs and stairs': the same walk over a field of lower half slabs and octant stairs
 *    (docs/SHAPES.md 15: < 256 B per tick, the world path with partial cells);
 *  - 'stand on a moving deck': a deck structure moving and turning under a standing player. The
 *    voxel queries against a structure allocate their local box (voxel/shape.ts structureObb), so
 *    this case measures that, not the mover;
 *  - 'sneak on a slab deck' / 'sneak on a planks deck': a player sneaking along the edges of a deck
 *    at rest made of lower half slabs (a layered structure grid: the sneak guard's solidAtHalf
 *    probes) / of whole planks (the same deck as M1 had it);
 *  - 'swim over a slab hull' / 'swim over a planks hull': a player swimming in water inside the
 *    bounds of a ship (a plate of lower half slabs / planks with a mast, its hull analysed), so the
 *    fluid samples ask isDryHalf every tick.
 *  - 'judge a jump in the world', 'judge standing on a heeled deck', 'judge standing on a heeled
 *    deck beside a wall': the server judging one move report of a client-driven player
 *    (entities/drive.ts ReportJudge.check) on a fixed state, in the world and on a deck at rest
 *    heeling 9 degrees, in the open and 0.02 short of its deck house on the side its walls lean toward.
 * The structure cases all pay for the local box per structure query (M1); the slab / planks pairs
 * isolate what partial cells add.
 */
import { Session } from 'node:inspector/promises';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { qfromAxisAngle, qfromYaw, quat, vec3, type Quat, type Vec3 } from '../../src/core/math';
import { PX } from '../../src/core/dirs';
import { BodyMover, sanitizeInput, takeJumpPresses, type BodyStructure } from '../../src/entities/body';
import { ClientDrive, emptyReport, ReportJudge } from '../../src/entities/drive';
import { Player } from '../../src/entities/entity';
import { analyzeHull } from '../../src/structures/hull';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { LOWER, slab, stairFill } from '../shapes';

const CALLS = 50_000;
/** The structure cases allocate kilobytes per tick (their local boxes): fewer ticks measure them as well. */
const STRUCTURE_CALLS = 20_000;
const ROUNDS = 6;
/** An allocating case stops once two rounds agree this closely (optimised code, measured twice). */
const STABLE = 0.03;
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

// ---- walk on slabs and stairs: a second chunk, a field of lower slabs and stairs around the walk
world.addChunk(new Chunk(1, 0));
for (let x = 16; x < 32; x++)
  for (let z = 0; z < 16; z++) {
    world.setCell(x, 10, z, makeCell(B.STONE));
    const k = (x * 7 + z * 3) % 5;
    if (k === 1 || k === 2) world.setCell(x, 11, z, slab(B.STONE, LOWER));
    else if (k === 3) world.setCell(x, 11, z, slab(B.BRICKS, stairFill(PX)));
  }
const slabWalker = new Player(3, 'survival');
slabWalker.setPosition(24.5, 12, 8.5);
slabWalker.input.forward = 1;
let slabAge = 0;
function slabTick(): void {
  slabAge++;
  if (slabAge % 200 === 0) {
    // Back to the middle of the field now and then: the steps bend the circle into a drift.
    slabWalker.setPosition(24.5, 12, 8.5);
    slabWalker.vel.x = 0;
    slabWalker.vel.y = 0;
    slabWalker.vel.z = 0;
  }
  const i = slabWalker.input;
  i.yaw = slabAge * 0.1;
  i.jump = slabAge % 40 < 2;
  landMover.beginCarry();
  landMover.beginStep(slabWalker);
  sanitizeInput(slabWalker);
  landMover.stepPlayer(slabWalker, takeJumpPresses(slabWalker), false);
  landMover.endTick();
}

/** A deck at rest at y 40 (cells x 4..9, z 4..9) all of `cell`, a player sneaking in wide circles on it (along its edges). */
function sneakCase(id: number, cell: number): { tick: () => void; rider: Player } {
  const g = new StructureGrid(id, world);
  for (let x = 4; x < 10; x++) for (let z = 4; z < 10; z++) g.setCell(x, 40, z, cell);
  g.pivot.x = 7;
  g.pivot.y = 40.5;
  g.pivot.z = 7;
  g.setPoseImmediate(vec3(7, 40.5, 7), quat());
  const s: BodyStructure = { id, grid: g, parent: null, children: [], removed: false, hull: null };
  const list: readonly BodyStructure[] = [s];
  const mover = new BodyMover({ world, structures: () => list });
  const p = new Player(id, 'survival');
  p.setPosition(7, 41, 7);
  p.input.forward = 1;
  p.input.sneak = true;
  let a = 0;
  return {
    rider: p,
    tick: () => {
      a++;
      p.input.yaw = a * 0.01;
      g.snapshotPose();
      mover.beginCarry();
      if (p.carrierId !== 0) mover.carryRider(p);
      mover.beginStep(p);
      sanitizeInput(p);
      mover.stepPlayer(p, takeJumpPresses(p), false);
      mover.endTick();
    },
  };
}
const sneakSlab = sneakCase(11, slab(B.PLANKS_OAK, LOWER));
const sneakPlanks = sneakCase(12, makeCell(B.PLANKS_OAK));

/** Water x 0..15, y 20..30 (chunk 0); a ship at rest in it: a plate of `plate` (x 2..13, z 2..13, y 21) with a mast to y 29; a player swimming over the plate. */
for (let x = 0; x < 16; x++) for (let y = 20; y <= 30; y++) for (let z = 0; z < 16; z++) world.setCell(x, y, z, makeCell(B.WATER));
function swimCase(id: number, plate: number): { tick: () => void; swimmer: Player; dryChecks: () => boolean } {
  const g = new StructureGrid(id, world);
  for (let x = 2; x < 14; x++) for (let z = 2; z < 14; z++) g.setCell(x, 21, z, plate);
  for (let y = 22; y < 30; y++) g.setCell(7, y, 7, makeCell(B.PLANKS_OAK));
  g.pivot.x = 8;
  g.pivot.y = 22;
  g.pivot.z = 8;
  g.setPoseImmediate(vec3(8, 22, 8), quat());
  const s: BodyStructure = { id, grid: g, parent: null, children: [], removed: false, hull: analyzeHull(g) };
  const list: readonly BodyStructure[] = [s];
  const mover = new BodyMover({ world, structures: () => list });
  const p = new Player(id, 'survival');
  p.setPosition(10.5, 24, 10.5);
  p.input.forward = 1;
  let a = 0;
  return {
    swimmer: p,
    dryChecks: () => s.hull !== null && p.wet > 0,
    tick: () => {
      a++;
      p.input.yaw = a * 0.05;
      p.input.jump = a % 30 < 10;
      g.snapshotPose();
      mover.beginCarry();
      mover.beginStep(p);
      sanitizeInput(p);
      mover.stepPlayer(p, takeJumpPresses(p), false);
      mover.endTick();
    },
  };
}
const swimSlab = swimCase(21, slab(B.PLANKS_OAK, LOWER));
const swimPlanks = swimCase(22, makeCell(B.PLANKS_OAK));

/**
 * Judging one move report (entities/drive.ts ReportJudge.check) on a fixed state: the reference
 * at `from`, the report at `to` (in `carrier`'s frame, else the world), standing or in the air.
 * check() changes nothing but the judge's scratch, so the same report is judged again and again.
 */
function judgeCase(mover: BodyMover, carrier: { id: number; grid: StructureGrid } | null, from: Vec3, to: Vec3, onGround: boolean): { tick: () => void; verdict: () => string | null } {
  const judge = new ReportJudge(mover, world);
  const p = new Player(50 + (carrier?.id ?? 0), 'survival');
  const d = new ClientDrive();
  p.remote = d;
  mover.beginCarry();
  const w = carrier !== null ? carrier.grid.toWorld(from) : from;
  p.setPosition(w.x, w.y, w.z);
  p.carrierId = carrier?.id ?? 0;
  d.carrierId = p.carrierId;
  d.pos.x = from.x;
  d.pos.y = from.y;
  d.pos.z = from.z;
  d.onGround = true;
  d.reportedOnGround = true;
  d.fresh = false;
  d.viewTick = 98;
  const rep = emptyReport();
  rep.seq = 1;
  rep.carrierId = p.carrierId;
  rep.pos.x = to.x;
  rep.pos.y = to.y;
  rep.pos.z = to.z;
  rep.vel.y = onGround ? 0 : 6;
  rep.onGround = onGround;
  rep.viewTick = 98;
  return { tick: () => void judge.check(p, d, rep, 1, 100, false), verdict: () => judge.check(p, d, rep, 1, 100, false) };
}
// In the world: a jump off the stone floor (y 11).
const judgeAir = judgeCase(landMover, null, vec3(8.5, 11, 8.5), vec3(8.78, 11.39, 8.5), false);
/** A deck at rest heeling 9 degrees about x (planks x 4..13, z 4..13 at y 60) with a deck house (x 10..12, y 61..62, z 6..8). */
const heeled = new StructureGrid(31, world);
for (let x = 4; x < 14; x++) for (let z = 4; z < 14; z++) heeled.setCell(x, 60, z, makeCell(B.PLANKS_OAK));
for (let x = 10; x < 13; x++) for (let y = 61; y < 63; y++) for (let z = 6; z < 9; z++) heeled.setCell(x, y, z, makeCell(B.PLANKS_OAK));
heeled.pivot.x = 9;
heeled.pivot.y = 60.5;
heeled.pivot.z = 9;
heeled.setPoseImmediate(vec3(9, 60.5, 9), qfromAxisAngle(vec3(1, 0, 0), (9 * Math.PI) / 180));
const heeledList: readonly BodyStructure[] = [{ id: 31, grid: heeled, parent: null, children: [], removed: false, hull: null }];
const heeledMover = new BodyMover({ world, structures: () => heeledList });
const heeledDeck = { id: 31, grid: heeled };
// Standing in the open, and standing beside the deck house, 0.02 short of its face z = 6: the side
// the deck's walls lean toward (its up leans toward +z), within the reach of that lean, where
// drive.ts clearOfLeaningWalls asks about the side's strip and its corners.
const judgeDeckOpen = judgeCase(heeledMover, heeledDeck, vec3(6.5, 61, 9.5), vec3(6.6, 61, 9.5), true);
const judgeDeckWall = judgeCase(heeledMover, heeledDeck, vec3(11, 61, 5.66), vec3(11.1, 61, 5.68), true);

const cases: Record<string, (n: number) => number> = {
  'walk on land': (n) => {
    for (let i = 0; i < n; i++) landTick();
    return walker.pos.x;
  },
  'walk on slabs and stairs': (n) => {
    for (let i = 0; i < n; i++) slabTick();
    return slabWalker.pos.x;
  },
  'stand on a moving deck': (n) => {
    for (let i = 0; i < n; i++) deckTick();
    return rider.pos.x;
  },
  'sneak on a slab deck': (n) => {
    for (let i = 0; i < n; i++) sneakSlab.tick();
    return sneakSlab.rider.pos.x;
  },
  'sneak on a planks deck': (n) => {
    for (let i = 0; i < n; i++) sneakPlanks.tick();
    return sneakPlanks.rider.pos.x;
  },
  'swim over a slab hull': (n) => {
    for (let i = 0; i < n; i++) swimSlab.tick();
    return swimSlab.swimmer.pos.x;
  },
  'swim over a planks hull': (n) => {
    for (let i = 0; i < n; i++) swimPlanks.tick();
    return swimPlanks.swimmer.pos.x;
  },
  'judge a jump in the world': (n) => {
    for (let i = 0; i < n; i++) judgeAir.tick();
    return n;
  },
  'judge standing on a heeled deck': (n) => {
    for (let i = 0; i < n; i++) judgeDeckOpen.tick();
    return n;
  },
  'judge standing on a heeled deck beside a wall': (n) => {
    for (let i = 0; i < n; i++) judgeDeckWall.tick();
    return n;
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
  const calls = name.startsWith('walk on') || name === 'judge a jump in the world' ? CALLS : STRUCTURE_CALLS;
  let best = Infinity;
  for (let r = 0; r < ROUNDS && best > CLEAN; r++) {
    sink += run(calls * 2);
    await session.post('HeapProfiler.startSampling', SAMPLING as never);
    sink += run(calls);
    const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
    const bytes = totalBytes(profile.head) / calls;
    const stable = Math.abs(bytes - best) <= STABLE * best;
    best = Math.min(best, bytes);
    if (stable) break;
  }
  out[name] = best;
}
session.disconnect();
/** Where the bodies ended up (the scenes did what they claim): carried, still on the decks, wet over the plates. */
const scenes = {
  carried: rider.carrierId,
  sneakCarried: [sneakSlab.rider.carrierId, sneakPlanks.rider.carrierId],
  slabWalkerXZ: [slabWalker.pos.x, slabWalker.pos.z],
  sneakY: [sneakSlab.rider.pos.y, sneakPlanks.rider.pos.y],
  swimWet: [swimSlab.dryChecks(), swimPlanks.dryChecks()],
  swimXZ: [swimSlab.swimmer.pos.x, swimSlab.swimmer.pos.z, swimPlanks.swimmer.pos.x, swimPlanks.swimmer.pos.z],
  judgeVerdicts: [judgeAir.verdict(), judgeDeckOpen.verdict(), judgeDeckWall.verdict()],
};
process.stdout.write(JSON.stringify({ bytesPerCall: out, sink, ...scenes }) + '\n');
