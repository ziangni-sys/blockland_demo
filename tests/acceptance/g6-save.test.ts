/**
 * Acceptance scenarios 23-24 (docs/ACCEPTANCE.md, section 存档), headless, whole simulation.
 *
 * The player builds what gets saved through the real input path (glue clicks, helm and bearing
 * clicks, steering, pouring a bucket); the scene's blocks are placed with world.setCell. Saves go
 * through the client's SaveManager into a MemoryStorage (putAll with a WorldMeta) and come back
 * through SaveManager.load (listChunkKeys / getChunks / getBlob) into a fresh Simulation with the
 * same seed and generator, built with deferInitialLoad (as src/sim/persist.ts recommends); one
 * test also loads the way src/client/game.ts does (a normally constructed Simulation).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cellState, liquidState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NY, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { decodeTicks } from '../../src/save/codec';
import { exportSave, importSave, type SaveBundle } from '../../src/sim/persist';
import { Simulation } from '../../src/sim/simulation';
import { Rotor, Ship } from '../../src/structures/structure';
import { FlatGenerator, VoidGenerator } from '../../src/worldgen/generator';
import {
  EventLog,
  SEA_TOP,
  blobOf,
  cellsOf,
  countId,
  fill,
  glueFace,
  glueStores,
  idAt,
  loadWorld,
  newWorld,
  playerState,
  poseOf,
  readAgain,
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
const RAFT = {
  helm: [2, T, 4] as const,
  bearing: [2, T + 3, 1] as const,
  hub: [2, T + 3, 0] as const,
  stone: [1, T, 2] as const,
  mast: [2, T, 2] as const,
  /** Two sails of the raft's windmill (east arm), glued together. */
  sailA: [3, T + 3, 0] as const,
  sailB: [4, T + 3, 0] as const,
};

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
/** The raft windmill's arms (no lower arm). */
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
  // The player puts the hub (glued to the bearing) and the stone (glued to the mast) in place
  // himself: blocks that already touch cannot be glued (DESIGN 强力胶).
}

interface Harbour {
  sim: Simulation;
  log: EventLog;
}

/**
 * The player plays: glues a sail face of the world windmill and starts it, glues a face of a
 * stone on the pier, glues the raft's mast and puts a stone against it, glues the raft's bearing
 * and puts the windmill hub against it (the arms are scene blocks), glues a sail face, assembles
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

  // World windmill: glue the south face of a sail, then preview + start at the bearing.
  glueFace(sim, [-9, WM.hy, 0, PZ]);
  sim.hold(B.PLANKS_OAK);
  rightClick(sim, WM.bx, WM.by, WM.bz, PX);
  rightClick(sim, WM.bx, WM.by, WM.bz, PX);
  // World glue on the north face of a pier stone.
  glueFace(sim, [-6, T, 5, NZ]);

  // On the raft: glue the mast's west face and put the stone against it.
  sim.teleport(0.5, T, 1.5);
  sim.advance(2);
  glueFace(sim, [RAFT.mast[0], RAFT.mast[1], RAFT.mast[2], NX]);
  sim.hold(B.STONE, 1);
  rightClick(sim, RAFT.mast[0], RAFT.mast[1], RAFT.mast[2], NX);
  // Hovering north of the bearing: glue its front face and put the hub against it (sneak: with
  // a block in hand that places instead of previewing the rotor).
  sim.teleport(2.5, T + 2, -1.5);
  sim.player.flying = true;
  sim.advance(2);
  glueFace(sim, [RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NZ]);
  sim.hold(B.CANVAS);
  sim.player.input.sneak = true;
  rightClick(sim, RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NZ);
  sim.player.input.sneak = false;
  for (const [x, y, z] of cross(RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], T_CROSS)) setBlock(sim.world, x, y, z, B.CANVAS);
  // Glue on a sail of the raft's windmill: it rides into the ship, then into the nested
  // windmill, so the nested structure has a glue store of its own to save.
  glueFace(sim, [RAFT.sailA[0], RAFT.sailA[1], RAFT.sailA[2], NZ]);
  sim.player.flying = false;
  sim.teleport(3.5, T, 1.5);
  sim.advance(2);
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

/** A bundle as comparable plain data: chunks keyed (order-free), blobs by name. */
function bundleBytes(b: SaveBundle): { chunks: Record<string, number[]>; blobs: Record<string, number[]> } {
  return {
    chunks: Object.fromEntries(b.chunks.map(([k, v]) => [String(k), Array.from(v)])),
    blobs: Object.fromEntries(b.blobs.map(([n, v]) => [n, Array.from(v)])),
  };
}

/** Cells of the ship's windmill whose world positions are compared (hub, a side sail, the top sail). */
const MILL_PROBES = [RAFT.hub, [0, T + 3, 0], [2, T + 5, 0]] as const;

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
  let millWorldBefore: Array<[number, number, number]>;
  let saved: StoredSave;
  let loaded: Simulation;

  let pour: Simulation;
  let pourTime: number;
  let waterAtSave: string[];
  let pourSaved: StoredSave;

  beforeAll(async () => {
    played = playHarbour();
    before = snapshot(played.sim);
    millWorldBefore = MILL_PROBES.map(([x, y, z]) => worldOf(played.sim, 3, x, y, z));
    saved = await saveThroughStorage(played.sim, 'harbour', 'harbour', HARBOUR.seed);
    loaded = loadWorld(HARBOUR, saved.loaded);

    pour = pourWater();
    pourTime = pour.world.time;
    waterAtSave = waterLayer(pour);
    pourSaved = await saveThroughStorage(pour, 'platform', 'platform', POUR.seed);
  });

  it('存档往返: the save goes into the storage and comes back byte for byte (SaveManager.save -> putAll, SaveManager.load)', () => {
    expect(saved.loaded.chunks.length).toBeGreaterThan(0);
    expect(saved.loaded.blobs.map(([n]) => n).sort()).toEqual(saved.exported.blobs.map(([n]) => n).sort());
    expect(bundleBytes(saved.loaded)).toEqual(bundleBytes(saved.exported));
    expect(saved.meta.time).toBe(before.time);
  });

  it('存档往返: saving the reloaded game again, before it runs, gives back exactly the same bytes', async () => {
    const again = exportSave(loadWorld(HARBOUR, await readAgain(saved)));
    expect(bundleBytes(again)).toEqual(bundleBytes(saved.exported));
  });

  it('(premise) what was saved is a nested scene in motion: a world windmill, a ship carrying a windmill, glue in every store', () => {
    // guards the comparisons below against comparing empty or resting things
    expect(before.tree).toEqual([
      [1, 'rotor', 0, 0, []],
      [2, 'ship', 0, 0, [3]],
      [3, 'rotor', 2, 2, []],
    ]);
    const [worldMill, , shipMill] = before.states as Array<{ angle: number; angularSpeed: number }>;
    expect(worldMill!.angle).not.toBe(0);
    expect(worldMill!.angularSpeed).not.toBe(0);
    expect(shipMill!.angle).not.toBe(0);
    expect(shipMill!.angularSpeed).not.toBe(0);
    const ship = before.poses[1]!;
    expect(ship.rotation![3]).toBeLessThan(0.9999); // the ship has turned
    expect(Math.hypot(ship.linearVelocity![0]!, ship.linearVelocity![2]!)).toBeGreaterThan(0.05);
    expect(Math.abs(ship.angularVelocity![1]!)).toBeGreaterThan(1e-3);
    // world, mill 1, ship 2 (stone-mast + the hub glue staying on the spinning windmill's bearing), mill 3 (nested)
    expect(Object.values(before.glue).map((g) => g.length / 4)).toEqual([1, 1, 2, 1]);
    expect(before.glue['structure 2']).toEqual([RAFT.stone[0], RAFT.stone[1], RAFT.stone[2], 0, RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], 2]);
    expect(before.glue['structure 3']).toEqual([RAFT.sailA[0], RAFT.sailA[1], RAFT.sailA[2] - 1, 2]); // the sail's north face (z axis)
    expect(before.player.steeringShipId).toBe(2);
  });

  it('结构体（含嵌套）一致: the same ids, kinds and nesting — the windmill on the ship is still mounted on the ship', () => {
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

  it('结构体（含嵌套）一致: every cell of every structure is identical', () => {
    expect(loaded.structures.all().map(cellsOf)).toEqual(before.cells);
    expect(loaded.structures.all().map((s) => s.grid.count)).toEqual(before.cells.map((c) => c.length));
  });

  it('结构体（含嵌套）一致: poses and velocities are identical (pivot, position, rotation, linear and angular velocity)', () => {
    expect(loaded.structures.all().map(poseOf)).toEqual(before.poses);
    // The nested windmill is where it was in the world: its pose is relative to the ship.
    expect(MILL_PROBES.map(([x, y, z]) => worldOf(loaded, 3, x, y, z))).toEqual(millWorldBefore);
  });

  it('胶水一致: every glue store is identical — the world, the ship, both windmills', () => {
    expect(glueStores(loaded)).toEqual(before.glue);
    expect(loaded.worldGlue.has(-6, T, 5, NZ)).toBe(true);
    expect(loaded.structures.get(2)!.glue.has(RAFT.stone[0], RAFT.stone[1], RAFT.stone[2], PX)).toBe(true);
    expect(loaded.structures.get(2)!.glue.has(RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NZ)).toBe(true);
    expect(loaded.structures.get(1)!.glue.has(-9, WM.hy, 0, PZ)).toBe(true);
    // the nested windmill's own store (glue that rode world -> ship -> windmill on the ship)
    expect(loaded.structures.get(3)!.glue.has(RAFT.sailA[0], RAFT.sailA[1], RAFT.sailA[2], NZ)).toBe(true);
    expect(loaded.structures.get(3)!.glue.size).toBe(1);
  });

  it('风车角度一致: both windmills have exactly the saved angle and speed', () => {
    expect(loaded.structures.all().map(stateOf)).toEqual(before.states);
    const angles = loaded.structures.rotors().map((r) => [r.angle, r.angularSpeed]);
    expect(angles).toEqual(
      (before.states.filter((s) => 'angle' in s) as Array<{ angle: number; angularSpeed: number }>).map((s) => [s.angle, s.angularSpeed]),
    );
  });

  it("存档往返: the client's own way of loading (a Simulation constructed normally, then importSave) gives the same game back", async () => {
    const sim = new Simulation({ seed: HARBOUR.seed, mode: HARBOUR.mode, generator: HARBOUR.generator(), syncChunks: true, rabbits: false, loadRadius: HARBOUR.loadRadius });
    importSave(sim, await readAgain(saved));
    expect(snapshot(sim)).toEqual(before);
  });

  it('存档往返: a player standing on the deck of a sailing ship (not steering) stays aboard through the round trip, in step', async () => {
    const { sim } = playHarbour();
    sim.player.input.forward = 0;
    sim.player.input.strafe = 0;
    sim.use(); // let go of the wheel: the ship coasts on, turning, with the player on its deck
    sim.tick();
    sim.advance(5);
    expect(sim.player.steeringShipId).toBe(0);
    expect(sim.player.carrierId).toBe(2);
    const ship = sim.structures.get(2)!;
    expect(Math.hypot(ship.grid.linearVelocity.x, ship.grid.linearVelocity.z)).toBeGreaterThan(0.05);
    const s = await saveThroughStorage(sim, 'rider', 'rider', HARBOUR.seed);
    const b = loadWorld(HARBOUR, s.loaded);
    expect(snapshot(b)).toEqual(snapshot(sim));
    for (let i = 0; i < 40; i++) {
      sim.tick();
      b.tick();
      expect(playerState(b)).toEqual(playerState(sim));
    }
    expect(snapshot(b)).toEqual(snapshot(sim));
    expect(b.player.carrierId).toBe(2);
  });

  it('存档往返: the player is back at the wheel where he was, with the same inventory', () => {
    expect(playerState(loaded)).toEqual(before.player);
    expect(loaded.world.time).toBe(before.time);
    expect(loaded.rng.state).toBe(before.rng);
  });

  it('结构体、胶水、风车角度一致（读档后继续）: the reloaded game goes on exactly like the one never saved (windmills, ship, player in step)', async () => {
    const a = played.sim;
    const b = loadWorld(HARBOUR, await readAgain(saved));
    expect(snapshot(a)).toEqual(before); // (the unsaved game has not moved on yet)
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
    // the pier stone, the stone glued to the mast and the hub glue: it travelled with the bearing
    // (the ship's windmill keeps running on the world)
    expect(b.worldGlue.size).toBe(3);
    expect(b.structures.rotors().map((r) => [r.id, r.parent])).toEqual([
      [1, null],
      [3, null],
    ]);
    const mill = b.structures.get(3) as Rotor;
    const front = stateFacing(cellState(b.world.getCell(mill.bearingX, mill.bearingY, mill.bearingZ)));
    expect(b.worldGlue.has(mill.bearingX, mill.bearingY, mill.bearingZ, front)).toBe(true);
  });

  it('结构体（含嵌套）、胶水、风车角度一致（读档后能用）: after loading, the player stops both windmills at their bearings — the same blocks and glue come back as in the game never saved, hub glue included', async () => {
    const a = playHarbour().sim; // the same game again, never saved
    const b = loadWorld(HARBOUR, await readAgain(saved));
    expect(snapshot(a)).toEqual(before);
    const logs = [new EventLog(a), new EventLog(b)];
    for (const s of [a, b]) {
      // let go of the wheel, walk (teleport) to the mast, stop the windmill on the ship
      s.player.input.forward = 0;
      s.player.input.strafe = 0;
      s.use();
      s.tick();
      const ship = s.structures.get(2)!;
      const stand = ship.grid.toWorld({ x: 3.5, y: T, z: 1.5 });
      s.teleport(stand.x, stand.y, stand.z);
      s.advance(2);
      rightClick(s, RAFT.bearing[0], RAFT.bearing[1], RAFT.bearing[2], NY, ship.id);
      // over to the pier, stop the windmill on the tower
      s.teleport(HARBOUR.spawn.x, HARBOUR.spawn.y, HARBOUR.spawn.z);
      s.advance(2);
      rightClick(s, WM.bx, WM.by, WM.bz, PX);
    }
    for (const log of logs) expect(log.toastKeys().filter((k) => k === 'toast.rotor.stopped').length).toBe(2);
    // the loaded windmills were found at their bearings and stopped (not previewed as new ones)
    expect(structureTree(b)).toEqual([[2, 'ship', 0, 0, []]]);
    const shipA = a.structures.get(2)!;
    const shipB = b.structures.get(2)!;
    // the ship took its windmill back: the same cells, the same glue
    expect(cellsOf(shipB)).toEqual(cellsOf(shipA));
    expect(Array.from(shipB.glue.toArray())).toEqual(Array.from(shipA.glue.toArray()));
    // stone-mast + the hub glue (it stayed on the bearing) + the sail glue (wherever the snapped angle put it)
    expect(shipB.glue.size).toBe(3);
    expect(shipB.glue.has(RAFT.hub[0], RAFT.hub[1], RAFT.hub[2], PZ)).toBe(true); // hub <-> bearing
    expect(countId(shipB.grid, B.CANVAS, -8, T - 4, -8, 12, T + 10, 12)).toBe(7); // hub + 6 sails, none lost
    // the world windmill is blocks again, with its sail glue, exactly as in the game never saved
    expect(Array.from(b.worldGlue.toArray())).toEqual(Array.from(a.worldGlue.toArray()));
    expect(b.worldGlue.size).toBe(2); // the pier stone + the sail glue
    const region = (s: Simulation): number[] => {
      const out: number[] = [];
      for (let y = WM.hy - 3; y <= WM.hy + 3; y++) for (let x = WM.hx - 3; x <= WM.hx + 3; x++) out.push(s.world.getCell(x, y, WM.hz));
      return out;
    };
    expect(region(b)).toEqual(region(a));
    expect(countId(b.world, B.CANVAS, WM.hx - 3, WM.hy - 3, WM.hz, WM.hx + 3, WM.hy + 3, WM.hz)).toBe(9);
  });

  // ---------------------------------------------------------------- water on the platform

  it('在大平台上倒一格水，0.4 秒后存档: the water is saved mid-flow, with its pending ticks', () => {
    // the source and the four cells it has flowed into so far
    expect(waterAtSave.length).toBe(5);
    expect(waterAtSave.map((c) => c.split(':')[0])).toEqual(['0,-1', '-1,0', '0,0', '1,0', '0,1']);
    const pending = decodeTicks(blobOf(pourSaved.loaded, 'ticks'), pourTime)
      .filter((t) => t.id === B.WATER && t.y === WY)
      .map((t) => `${t.x},${t.z}`)
      .sort();
    expect(pending).toEqual(expect.arrayContaining(['-1,0', '0,-1', '0,1', '1,0']));
    // the reloaded game holds the same pending ticks, in the same order (re-saving gives the same bytes)
    const again = exportSave(loadWorld(POUR, pourSaved.loaded));
    expect(bundleBytes(again)).toEqual(bundleBytes(pourSaved.exported));
  });

  it('读档后水会继续流: after loading the water keeps flowing, tick for tick like the game that was never reloaded', async () => {
    const b = loadWorld(POUR, await readAgain(pourSaved));
    expect(b.world.time).toBe(pourTime);
    expect(waterLayer(b)).toEqual(waterAtSave);
    const a = pour;
    expect(waterLayer(a)).toEqual(waterAtSave); // (the unsaved game has not moved on yet)
    const counts: number[] = [];
    for (let i = 0; i < 60; i++) {
      a.tick();
      b.tick();
      expect(waterLayer(b)).toEqual(waterLayer(a));
      counts.push(waterLayer(b).length);
    }
    // it did not stay frozen at the five saved cells
    expect(counts[4]).toBeGreaterThan(5);
    expect(counts[59]).toBeGreaterThan(counts[4]!);
  });

  it('最终流满 113 格（半径 7 的菱形）: the water ends up in exactly the 113 cells of the radius-7 diamond', async () => {
    const b = loadWorld(POUR, await readAgain(pourSaved));
    const settledAfter = runUntilQuiet(b, 600);
    expect(settledAfter).toBeLessThan(600);
    const layer = waterLayer(b);
    expect(layer.length).toBe(113);
    expect(layer.map((c) => c.split(':')[0]).sort()).toEqual(diamond(7).sort());
    // nothing anywhere else: not above, not below, not beyond the platform
    expect(countId(b.world, B.WATER, -24, 0, -24, 24, 127, 24)).toBe(113);
    // the poured cell is still the one source; the rest is flowing water
    const source = makeCell(B.WATER, liquidState(0, false));
    expect(layer.filter((c) => c.endsWith(`:${source}`)).map((c) => c.split(':')[0])).toEqual(['0,0']);
  });
});

// =====================================================================================
// Scenario 24: a new world with the same seed
// =====================================================================================

/** Shallow sea: stone up to y = 27 (the sea floor), water 28..29, first air at y = SEA_TOP. */
const FLOOR = T - 3;
const SHALLOW: SimSpec = {
  seed: 24,
  mode: 'creative',
  generator: () =>
    new FlatGenerator([
      { id: B.DEEPROCK, thickness: 1 },
      { id: B.STONE, thickness: FLOOR },
      { id: B.WATER, thickness: 2 },
    ]),
  spawn: { x: -1.5, y: T, z: 2.5 },
  loadRadius: 2,
};

/** Two cells of the generated sea floor: identical in every world made from this seed. */
const FLOOR_A = [0, FLOOR, 2] as const;
const FLOOR_B = [0, FLOOR, 3] as const;
const BAY = { helm: [2, T, 2] as const, stone: [1, T, 4] as const, plank: [1, T - 1, 4] as const, bearing: [-3, T + 3, -1] as const };

/** A cobble pier (x -4..-2, z 0..5) for the player to stand on (spawn is on its east edge). */
function buildPier(sim: Simulation): void {
  fill(sim.world, -4, FLOOR + 1, 0, -2, T - 1, 5, B.COBBLE);
}

/** A raft (x 1..5, z 0..5) with a helm facing north (and, unless `stone` is false, a loose stone on its deck). */
function buildRaft(sim: Simulation, stone = true): void {
  const w = sim.world;
  fill(w, 1, T - 1, 0, 5, T - 1, 5, B.PLANKS_OAK);
  setBlock(w, BAY.helm[0], BAY.helm[1], BAY.helm[2], B.HELM, NZ);
  if (stone) setBlock(w, BAY.stone[0], BAY.stone[1], BAY.stone[2], B.STONE);
}

/** A windmill on a brick tower on the pier: bearing facing north, 9 canvas sails in the plane z = -2. */
function buildWindmill(sim: Simulation): void {
  const w = sim.world;
  const [bx, by, bz] = BAY.bearing;
  fill(w, bx, T, bz + 1, bx, by, bz + 1, B.STONE_BRICKS);
  setBlock(w, bx, by, bz, B.BEARING, NZ);
  setBlock(w, bx, by, bz - 1, B.CANVAS);
  for (const [x, y, z] of cross(bx, by, bz - 1, FULL_CROSS)) setBlock(w, x, y, z, B.CANVAS);
}

/** The previous game: glue on the sea floor, a ship with a glued stone, a running windmill, a thrown item. */
function playPreviousGame(): Simulation {
  const sim = newWorld(SHALLOW);
  buildPier(sim);
  buildRaft(sim, false);
  buildWindmill(sim);
  sim.advance(2);
  // Glue the top of a cell of the generated sea floor (through the water), and the deck plank
  // the player then puts the stone on.
  glueFace(sim, [FLOOR_A[0], FLOOR_A[1], FLOOR_A[2], PY]);
  glueFace(sim, [BAY.plank[0], BAY.plank[1], BAY.plank[2], PY]);
  sim.hold(B.STONE, 1);
  rightClick(sim, BAY.plank[0], BAY.plank[1], BAY.plank[2], PY);
  // Start the windmill.
  sim.hold(B.PLANKS_OAK);
  rightClick(sim, BAY.bearing[0], BAY.bearing[1], BAY.bearing[2], PX);
  rightClick(sim, BAY.bearing[0], BAY.bearing[1], BAY.bearing[2], PX);
  // Throw a stack of dirt out of the inventory screen.
  sim.giveItem(B.DIRT, 5);
  const inv = sim.player.inventory;
  const slot = inv.hotbar.findIndex((s) => s !== null && s.item === B.DIRT);
  inv.slotClick('hotbar', slot, 0, false);
  sim.dropCursorStack();
  // Assemble the raft at its helm (takes the wheel) and let the game run.
  sim.emptyHand();
  rightClick(sim, BAY.helm[0], BAY.helm[1], BAY.helm[2], NX);
  rightClick(sim, BAY.helm[0], BAY.helm[1], BAY.helm[2], NX);
  sim.advance(20);
  return sim;
}

/** "Open a new world" with the same seed, in the same process, as the client does. */
function openNewWorld(): Simulation {
  return newWorld(SHALLOW);
}

describe('24. 用同一个种子开新世界时，没有上一局的胶水。', () => {
  let old: Simulation;
  let oldGlue: number[];
  let oldShipGlue: number[];

  beforeAll(() => {
    old = playPreviousGame();
    oldGlue = Array.from(old.worldGlue.toArray());
    // (read defensively: the premise test reports a scene that did not come out as planned)
    oldShipGlue = Array.from(old.structures.get(2)?.glue.toArray() ?? []);
  });

  it('(premise) the previous game had glue on the generated sea floor and on its ship, a ship, a windmill and a thrown item', () => {
    expect(oldGlue).toEqual([FLOOR_A[0], FLOOR_A[1], FLOOR_A[2], 1]); // FLOOR_A's top face (y axis)
    expect(structureTree(old)).toEqual([
      [1, 'rotor', 0, 0, []],
      [2, 'ship', 0, 0, []],
    ]);
    expect(oldShipGlue.length / 4).toBe(1);
    expect(old.structures.get(2)?.grid.count).toBe(30 + 1 + 1); // planks + helm + the glued stone
    expect(old.entities.all().filter((e) => e.kind === 'item').length).toBe(1);
    // a new world from the same seed has the same terrain: the glued sea-floor cells exist there too
    const fresh = openNewWorld();
    expect(idAt(fresh.world, FLOOR_A[0], FLOOR_A[1], FLOOR_A[2])).toBe(B.STONE);
    expect(idAt(fresh.world, FLOOR_B[0], FLOOR_B[1], FLOOR_B[2])).toBe(B.STONE);
  });

  it('没有上一局的胶水（世界）: the sea-floor face glued in the previous game is not glued — the player is offered to apply it', () => {
    const fresh = openNewWorld();
    expect(fresh.worldGlue.size).toBe(0);
    expect(fresh.worldGlue.has(FLOOR_A[0], FLOOR_A[1], FLOOR_A[2], PY)).toBe(false);
    const log = new EventLog(fresh);
    buildPier(fresh); // somewhere to stand (does not touch the sea floor)
    fresh.advance(2);
    fresh.hold(I.GLUE);
    fresh.lookAtCell(FLOOR_A[0], FLOOR_A[1], FLOOR_A[2], PY);
    fresh.tick();
    expect(fresh.view.hint?.key).toBe('hint.glue.apply'); // 'hint.glue.already' if the old glue were there
    fresh.player.input.sneak = true;
    fresh.tick();
    expect(fresh.view.hint?.key).toBe('hint.glue.notGlued'); // nothing to remove either
    fresh.player.input.sneak = false;
    rightClick(fresh, FLOOR_A[0], FLOOR_A[1], FLOOR_A[2], PY);
    expect(log.toastKeys()).toContain('toast.glue.added');
    expect(log.toastKeys()).not.toContain('toast.glue.already');
    expect(fresh.worldGlue.size).toBe(1);
  });

  it('没有上一局的胶水（结构体）: none of the previous structures (which carried glue) exist, and structure ids start again at 1', () => {
    const fresh = openNewWorld();
    expect(fresh.structures.all().length).toBe(0);
    expect(fresh.structures.get(1)).toBeUndefined();
    expect(fresh.structures.get(2)).toBeUndefined();
    // the player builds the same raft and windmill again: they get the first ids of a new world
    buildPier(fresh);
    buildRaft(fresh);
    buildWindmill(fresh);
    fresh.advance(2);
    fresh.emptyHand();
    rightClick(fresh, BAY.helm[0], BAY.helm[1], BAY.helm[2], NX);
    rightClick(fresh, BAY.helm[0], BAY.helm[1], BAY.helm[2], NX);
    fresh.use(); // let go of the wheel
    fresh.tick();
    fresh.teleport(SHALLOW.spawn.x, SHALLOW.spawn.y, SHALLOW.spawn.z);
    fresh.advance(1);
    fresh.hold(B.PLANKS_OAK);
    rightClick(fresh, BAY.bearing[0], BAY.bearing[1], BAY.bearing[2], PX);
    rightClick(fresh, BAY.bearing[0], BAY.bearing[1], BAY.bearing[2], PX);
    expect(structureTree(fresh)).toEqual([
      [1, 'ship', 0, 0, []],
      [2, 'rotor', 0, 0, []],
    ]);
  });

  it('新世界里没有上一局的东西: only the new player, at the spawn, with an empty inventory', () => {
    const fresh = openNewWorld();
    expect(fresh.entities.all().map((e) => [e.id, e.kind])).toEqual([[1, 'player']]);
    const p = fresh.player;
    expect([p.pos.x, p.pos.y, p.pos.z]).toEqual([SHALLOW.spawn.x, SHALLOW.spawn.y, SHALLOW.spawn.z]);
    expect([p.steeringShipId, p.carrierId]).toEqual([0, 0]);
    expect(p.inventory.hotbar.every((st) => st === null)).toBe(true);
    expect(p.inventory.main.every((st) => st === null)).toBe(true);
    expect(fresh.worldGlue.size).toBe(0);
    expect(fresh.structures.all().length).toBe(0);
  });

  it('互不影响: the previous game keeps its glue, ship and windmill, and glue added in the new world does not reach it', () => {
    const fresh = openNewWorld();
    buildPier(fresh);
    fresh.advance(2);
    // glue a face in the new world that the previous game never glued
    glueFace(fresh, [FLOOR_B[0], FLOOR_B[1], FLOOR_B[2], PY]);
    expect(fresh.worldGlue.has(FLOOR_B[0], FLOOR_B[1], FLOOR_B[2], PY)).toBe(true);
    expect(old.worldGlue.has(FLOOR_B[0], FLOOR_B[1], FLOOR_B[2], PY)).toBe(false);
    expect(Array.from(old.worldGlue.toArray())).toEqual(oldGlue);
    expect(structureTree(old)).toEqual([
      [1, 'rotor', 0, 0, []],
      [2, 'ship', 0, 0, []],
    ]);
    expect(Array.from(old.structures.get(2)?.glue.toArray() ?? [])).toEqual(oldShipGlue);
    // and the previous game still runs: its windmill turns on
    const mill = old.structures.get(1) as Rotor;
    const angle = mill.angle;
    old.advance(10);
    expect(mill.removed).toBe(false);
    expect(mill.angle).not.toBe(angle);
    expect(Array.from(old.worldGlue.toArray())).toEqual(oldGlue);
    expect(old.entities.all().filter((e) => e.kind === 'item').length).toBe(1);
  });
});
