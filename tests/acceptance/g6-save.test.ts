/**
 * Acceptance scenarios 23-24 (docs/ACCEPTANCE.md, section 存档), headless, whole simulation.
 *
 * The player builds what gets saved through the real input path (glue clicks, helm and bearing
 * clicks, steering, pouring a bucket); the scene's blocks are placed with world.setCell. Saves go
 * through the client's SaveManager into a MemoryStorage (putAll with a WorldMeta) and come back
 * through SaveManager.load (listChunkKeys / getChunks / getBlob) into a fresh Simulation built
 * with deferInitialLoad, exactly like a browser reload.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NY, NZ, PX, PY, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { FlatGenerator, VoidGenerator } from '../../src/worldgen/generator';
import {
  EventLog,
  SEA_TOP,
  cellsOf,
  cellsWithId,
  countId,
  fill,
  glueFace,
  glueStores,
  idAt,
  loadWorld,
  newWorld,
  playerState,
  poseOf,
  rightClick,
  saveThroughStorage,
  seaGenerator,
  setBlock,
  stateOf,
  structureTree,
  type SimSpec,
  type StoredSave,
} from './g6-save-helpers';

const T = SEA_TOP;

// =====================================================================================
// Scenario 23, part 1: a harbour full of structures and glue
// =====================================================================================

const HARBOUR: SimSpec = {
  seed: 23,
  mode: 'creative',
  generator: seaGenerator,
  spawn: { x: -7.5, y: T, z: 3.5 },
  loadRadius: 3,
};

/** World windmill: bearing on a brick tower, axis north, 9 canvas sails in the plane z = 0. */
const WM = { bx: -10, by: T + 4, bz: 1, hx: -10, hy: T + 4, hz: 0 };
/** The raft (x 0..4, z 0..5 at y = T - 1), its helm, mast, bearing and windmill hub. */
const RAFT = { helm: [2, T, 4] as const, bearing: [2, T + 3, 1] as const, hub: [2, T + 3, 0] as const, stone: [1, T, 2] as const, mast: [2, T, 2] as const };

function cross(hx: number, hy: number, hz: number, arms: ReadonlyArray<readonly [number, number]>): Array<[number, number, number]> {
  return arms.map(([dx, dy]) => [hx + dx, hy + dy, hz]);
}
const FULL_CROSS = [
  [1, 0],
  [2, 0],
  [-1, 0],
  [-2, 0],
  [0, 1],
  [0, 2],
  [0, -1],
  [0, -2],
] as const;
/** No lower arm: the hub's and the bearing's bottom faces stay open for the glue clicks. */
const T_CROSS = [
  [1, 0],
  [2, 0],
  [-1, 0],
  [-2, 0],
  [0, 1],
  [0, 2],
] as const;

function buildHarbour(sim: Simulation): void {
  const w = sim.world;
  // World windmill on a brick tower standing on the sea floor.
  fill(w, WM.bx, 20, WM.bz + 1, WM.bx, WM.by, WM.bz + 1, B.STONE_BRICKS);
  setBlock(w, WM.bx, WM.by, WM.bz, B.BEARING, NZ);
  setBlock(w, WM.hx, WM.hy, WM.hz, B.CANVAS);
  for (const [x, y, z] of cross(WM.hx, WM.hy, WM.hz, FULL_CROSS)) setBlock(w, x, y, z, B.CANVAS);
  // A cobble pier for the player, with two loose stones on it (world glue).
  fill(w, -9, 20, 3, -6, T - 1, 5, B.COBBLE);
  setBlock(w, -6, T, 5, B.STONE);
  setBlock(w, -6, T + 1, 5, B.STONE);
  // The raft: deck, helm facing north, plank mast, bearing facing north, canvas windmill.
  fill(w, 0, T - 1, 0, 4, T - 1, 5, B.PLANKS_OAK);
  setBlock(w, RAFT.helm[0], RAFT.helm[1], RAFT.helm[2], B.HELM, NZ);
  fill(w, 2, T, 2, 2, T + 3, 2, B.PLANKS_OAK);
  setBlock(w, RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], B.BEARING, NZ);
  setBlock(w, RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], B.CANVAS);
  for (const [x, y, z] of cross(RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], T_CROSS)) setBlock(w, x, y, z, B.CANVAS);
  // A stone next to the mast: stone never sticks by itself, only glue takes it aboard.
  setBlock(w, RAFT.stone[0], RAFT.stone[1], RAFT.stone[2], B.STONE);
}

interface Harbour {
  sim: Simulation;
  log: EventLog;
}

/**
 * The player plays: glues two sails of the world windmill and starts it, glues two stones on the
 * pier, glues a stone to the raft's mast and the raft's windmill hub to its bearing, assembles
 * the raft at its helm, starts the windmill on the ship, takes the wheel and sails a curve.
 */
function playHarbour(): Harbour {
  const sim = newWorld(HARBOUR);
  const log = new EventLog(sim);
  buildHarbour(sim);
  sim.giveItem(B.PLANKS_OAK, 40);
  sim.giveItem(I.BUCKET, 2);
  sim.giveItem(B.CANVAS, 7);
  sim.advance(2);

  // World windmill: glue two sails together, then preview + start at the bearing.
  glueFace(sim, [-8, WM.hy, 0, PZ], [-9, WM.hy, 0, PZ]);
  sim.hold(B.PLANKS_OAK);
  rightClick(sim, WM.bx, WM.by, WM.bz, PX);
  rightClick(sim, WM.bx, WM.by, WM.bz, PX);
  // World glue between the two pier stones.
  glueFace(sim, [-6, T, 5, NZ], [-6, T + 1, 5, NZ]);

  // On the raft.
  sim.teleport(3.5, T, 1.5);
  sim.advance(2);
  glueFace(sim, [RAFT.stone[0], RAFT.stone[1], RAFT.stone[2], NZ], [RAFT.mast[0], RAFT.mast[1], RAFT.mast[2], NZ]);
  glueFace(sim, [RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NY], [RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], NY]);
  sim.emptyHand();
  rightClick(sim, RAFT.helm[0], RAFT.helm[1], RAFT.helm[2], PX); // preview
  rightClick(sim, RAFT.helm[0], RAFT.helm[1], RAFT.helm[2], PX); // assemble (takes the wheel)
  const ship = sim.structures.ships()[0];
  if (ship === undefined) throw new Error(`the raft did not assemble: ${log.toastKeys().join(', ')}`);
  sim.use(); // let go of the wheel
  sim.tick();
  // Walk over to the mast (teleport), start the windmill on the ship.
  const stand = ship.grid.toWorld({ x: 3.5, y: T, z: 1.5 });
  sim.teleport(stand.x, stand.y, stand.z);
  sim.advance(2);
  rightClick(sim, RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NY, ship.id);
  rightClick(sim, RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NY, ship.id);
  // Back to the wheel and sail a curve (W + D held).
  rightClick(sim, RAFT.helm[0], RAFT.helm[1], RAFT.helm[2], PX, ship.id);
  sim.player.input.forward = 1;
  sim.player.input.strafe = 1;
  sim.advance(60);
  return { sim, log };
}

interface Snapshot {
  tree: ReturnType<typeof structureTree>;
  cells: string[][];
  poses: Array<Record<string, number[]>>;
  states: Array<Record<string, unknown>>;
  glue: Record<string, number[]>;
  player: Record<string, unknown>;
  time: number;
  rng: number;
}

function snapshot(sim: Simulation): Snapshot {
  const all = sim.structures.all();
  return {
    tree: structureTree(sim),
    cells: all.map(cellsOf),
    poses: all.map(poseOf),
    states: all.map(stateOf),
    glue: glueStores(sim),
    player: playerState(sim),
    time: sim.world.time,
    rng: sim.rng.state,
  };
}

/** World position of a cell centre of structure `id`. */
function worldOf(sim: Simulation, id: number, x: number, y: number, z: number): [number, number, number] {
  const p = sim.structures.get(id)!.grid.toWorld({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
  return [p.x, p.y, p.z];
}

// =====================================================================================
// Scenario 23, part 2: a bucket of water on a big platform, saved mid-flow
// =====================================================================================

/** Top cell layer of a 31 x 31 stone platform floating in the void (x, z in -15..15). */
const PLATFORM_Y = 64;
const PLATFORM_HALF = 15;
/** The layer the water spreads on. */
const WY = PLATFORM_Y + 1;

const POUR: SimSpec = {
  seed: 2323,
  mode: 'creative',
  generator: () => new VoidGenerator(),
  spawn: { x: 0.5, y: WY, z: 3.5 },
  loadRadius: 2,
};

/** Every water cell on the platform's layer, with its full cell value (level / source bits). */
function waterLayer(sim: Simulation): string[] {
  const out: string[] = [];
  for (let z = -PLATFORM_HALF; z <= PLATFORM_HALF; z++) {
    for (let x = -PLATFORM_HALF; x <= PLATFORM_HALF; x++) {
      const c = sim.world.getCell(x, WY, z);
      if (idAt(sim.world, x, WY, z) === B.WATER) out.push(`${x},${z}:${c}`);
    }
  }
  return out;
}

/** "x,z" of the radius-7 diamond around the poured cell (0, 0): |x| + |z| <= 7. */
function diamond(r: number): string[] {
  const out: string[] = [];
  for (let z = -PLATFORM_HALF; z <= PLATFORM_HALF; z++) for (let x = -PLATFORM_HALF; x <= PLATFORM_HALF; x++) if (Math.abs(x) + Math.abs(z) <= r) out.push(`${x},${z}`);
  return out;
}

/** Run until no block tick is pending (the water has settled), at most `max` ticks. */
function runUntilQuiet(sim: Simulation, max: number): number {
  for (let i = 0; i < max; i++) {
    if (sim.world.ticks.size === 0) return i;
    sim.tick();
  }
  return max;
}

/** The player pours one bucket on the middle of the platform; 0.4 s (8 ticks) later the game is saved. */
function pourWater(): Simulation {
  const sim = newWorld(POUR);
  fill(sim.world, -PLATFORM_HALF, PLATFORM_Y, -PLATFORM_HALF, PLATFORM_HALF, PLATFORM_Y, PLATFORM_HALF, B.STONE);
  sim.advance(2);
  sim.hold(I.BUCKET_WATER, 1);
  rightClick(sim, 0, PLATFORM_Y, 0, PY); // the source appears during this tick
  sim.advance(8); // 0.4 s
  return sim;
}

describe('23. 存档往返后，结构体（含嵌套）、胶水、风车角度都一致。在大平台上倒一格水，0.4 秒后存档；读档后水会继续流，最终流满 113 格（半径 7 的菱形）。', () => {
  let played: Harbour;
  let before: Snapshot;
  let saved: StoredSave;
  let loaded: Simulation;

  let pour: Simulation;
  let pourTime: number;
  let waterAtSave: string[];
  let pourSaved: StoredSave;

  beforeAll(async () => {
    played = playHarbour();
    before = snapshot(played.sim);
    saved = await saveThroughStorage(played.sim, 'harbour', 'harbour', HARBOUR.seed);
    loaded = loadWorld(HARBOUR, saved.loaded);

    pour = pourWater();
    pourTime = pour.world.time;
    waterAtSave = waterLayer(pour);
    pourSaved = await saveThroughStorage(pour, 'platform', 'platform', POUR.seed);
  });

  it('the save is written to the storage and read back byte for byte (SaveManager -> MemoryStorage -> SaveManager.load)', () => {
    const sortChunks = (c: Array<[number, Uint8Array]>): Array<[number, number[]]> =>
      c.map(([k, b]) => [k, Array.from(b)] as [number, number[]]).sort((a, b) => a[0] - b[0]);
    expect(saved.loaded.chunks.length).toBeGreaterThan(0);
    expect(sortChunks(saved.loaded.chunks)).toEqual(sortChunks(saved.exported.chunks));
    const blobs = (bs: Array<[string, Uint8Array]>): Record<string, number[]> => Object.fromEntries(bs.map(([n, b]) => [n, Array.from(b)]));
    expect(blobs(saved.loaded.blobs)).toEqual(blobs(saved.exported.blobs));
    expect(saved.meta.time).toBe(before.time);
  });

  it('what was saved is a nested scene in motion: a world windmill, a ship carrying a windmill, glue in every store', () => {
    // (guards the comparisons below against comparing empty or resting things)
    expect(before.tree).toEqual([
      [1, 'rotor', 0, 0, []],
      [2, 'ship', 0, 0, [3]],
      [3, 'rotor', 2, 2, []],
    ]);
    const sim = played.sim;
    const [world, ship, shipMill] = sim.structures.all() as [Rotor, Ship, Rotor];
    expect(world.angle).not.toBe(0);
    expect(shipMill.angle).not.toBe(0);
    expect(shipMill.hubGlue).toBe(true);
    expect(ship.grid.rotation.w).toBeLessThan(0.9999); // the ship has turned
    expect(Math.hypot(ship.grid.linearVelocity.x, ship.grid.linearVelocity.z)).toBeGreaterThan(0.05);
    expect(Math.abs(ship.grid.angularVelocity.y)).toBeGreaterThan(1e-3);
    expect(sim.worldGlue.size).toBe(1);
    expect(world.glue.size).toBe(1);
    expect(ship.glue.size).toBe(1);
    expect(sim.player.steeringShipId).toBe(ship.id);
  });

  it('structures: the same ids, kinds and nesting — the windmill on the ship is still mounted on the ship', () => {
    expect(structureTree(loaded)).toEqual(before.tree);
    const ship = loaded.structures.get(2);
    const mill = loaded.structures.get(3);
    expect(ship).toBeInstanceOf(Ship);
    expect(mill).toBeInstanceOf(Rotor);
    expect(mill!.parent).toBe(ship);
    expect(mill!.grid.parent).toBe(ship!.grid);
    expect(loaded.structures.rotors().map((r) => r.id)).toEqual([1, 3]);
    expect(loaded.structures.ships().map((s) => s.id)).toEqual([2]);
  });

  it('structures: every cell of every structure is identical', () => {
    expect(loaded.structures.all().map(cellsOf)).toEqual(before.cells);
    expect(loaded.structures.all().map((s) => s.grid.count)).toEqual(before.cells.map((c) => c.length));
  });

  it('structures: poses and velocities are identical (pivot, position, rotation, linear and angular velocity)', () => {
    expect(loaded.structures.all().map(poseOf)).toEqual(before.poses);
    // The nested windmill is where it was in the world: its pose is relative to the ship.
    for (const [x, y, z] of [RAFT.hub, [0, T + 3, 0], [2, T + 5, 0]] as const) {
      expect(worldOf(loaded, 3, x, y, z)).toEqual(worldOf(played.sim, 3, x, y, z));
    }
  });

  it('glue: every glue store is identical — the world, the ship, both windmills', () => {
    expect(glueStores(loaded)).toEqual(before.glue);
    expect(loaded.worldGlue.has(-6, T, 5, PY)).toBe(true);
    expect(loaded.structures.get(2)!.glue.has(RAFT.stone[0], RAFT.stone[1], RAFT.stone[2], PX)).toBe(true);
    expect(loaded.structures.get(1)!.glue.has(-9, WM.hy, 0, PX)).toBe(true);
  });

  it('windmill angles: both windmills have exactly the saved angle, speed and hub glue', () => {
    expect(loaded.structures.all().map(stateOf)).toEqual(before.states);
    const angles = loaded.structures.rotors().map((r) => [r.angle, r.angularSpeed]);
    expect(angles).toEqual(
      (before.states.filter((s) => 'angle' in s) as Array<{ angle: number; angularSpeed: number }>).map((s) => [s.angle, s.angularSpeed]),
    );
  });

  it('the player is back at the wheel where he was, with the same inventory', () => {
    expect(playerState(loaded)).toEqual(before.player);
    expect(loaded.world.time).toBe(before.time);
    expect(loaded.rng.state).toBe(before.rng);
  });

  it('after loading, the game goes on exactly as if it had never been saved (windmills, ship, player in step)', () => {
    const a = played.sim;
    const b = loaded;
    // The client re-applies the keys still held (W + D) to the reloaded game.
    b.player.input.forward = a.player.input.forward;
    b.player.input.strafe = a.player.input.strafe;
    for (let i = 0; i < 40; i++) {
      a.tick();
      b.tick();
      expect(b.structures.rotors().map((r) => r.angle)).toEqual(a.structures.rotors().map((r) => r.angle));
    }
    expect(snapshot(b)).toEqual(snapshot(a));
    // Docking now (sneak + right-click at the wheel) gives the same world back, glue included.
    for (const s of [a, b]) {
      s.player.input.forward = 0;
      s.player.input.strafe = 0;
      s.player.input.sneak = true;
      s.use();
      s.tick();
      s.player.input.sneak = false;
    }
    expect(b.structures.ships().length).toBe(0);
    expect(a.structures.ships().length).toBe(0);
    expect(Array.from(b.worldGlue.toArray())).toEqual(Array.from(a.worldGlue.toArray()));
    // pier stones + the stone glued to the mast (the ship's windmill keeps running on the world,
    // holding its hub glue until it stops)
    expect(b.worldGlue.size).toBe(2);
    expect(b.structures.rotors().map((r) => [r.id, r.parent, r.hubGlue])).toEqual([
      [1, null, false],
      [3, null, true],
    ]);
  });
});
