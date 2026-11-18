/**
 * Helpers for the save acceptance scenarios (docs/ACCEPTANCE.md 23-24, group g6-save).
 *
 * Scenes are built with world.setCell; everything the PLAYER does (gluing, assembling, starting
 * windmills, steering, pouring) goes through the test world's player (tests/acceptance/world.ts:
 * look + right-click with an item in hand). Saves go through the server's storage path
 * (docs/NETCODE.md section 12): network mode, ServerHost.save() into the host's MemoryStorage
 * (exportSave + the generator blob, SaveStorage.putAll with a WorldMeta); direct mode, the same
 * bundle (net/host/host.ts saveBundle) written with putAll. They come back with net/host/host.ts
 * readSave (listChunkKeys / getChunks / getBlob, as ServerHost.load reads them) into a new test
 * world built the same way (importSave), which the player joins before its first tick.
 */
import { expect } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import type { Dir } from '../../src/core/dirs';
import { readSave, saveBundle } from '../../src/net/host/host';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { MemoryStorage, type SaveStorage } from '../../src/save/storage';
import { exportSave, type SaveBundle } from '../../src/sim/persist';
import type { GameMode, Simulation } from '../../src/sim/simulation';
import type { Message, SimEvent } from '../../src/sim/view';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator, type ChunkGenerator } from '../../src/worldgen/generator';
import { testWorld, type TestWorld } from './world';

// ------------------------------------------------------------------ worlds

/** Sea: deeprock y=0, stone 1..19, water 20..29; first air at y = SEA_TOP. */
export const SEA_TOP = 30;

export function seaGenerator(): FlatGenerator {
  return new FlatGenerator([
    { id: B.DEEPROCK, thickness: 1 },
    { id: B.STONE, thickness: 19 },
    { id: B.WATER, thickness: 10 },
  ]);
}

export interface SimSpec {
  seed: number;
  mode: GameMode;
  generator: () => ChunkGenerator;
  spawn: { x: number; y: number; z: number };
  loadRadius: number;
}

/** A new world as a host opens it (headless: synchronous chunks, no rabbits). */
export function newWorld(spec: SimSpec): TestWorld {
  return testWorld({
    seed: spec.seed,
    mode: spec.mode,
    generator: spec.generator(),
    syncChunks: true,
    rabbits: false,
    loadRadius: spec.loadRadius,
    spawn: spec.spawn,
  });
}

/** A world built to receive a save (same seed and generator), importSave(), then the player rejoins (before the first tick). */
export function loadWorld(spec: SimSpec, bundle: SaveBundle): TestWorld {
  return testWorld({
    seed: spec.seed,
    mode: spec.mode,
    generator: spec.generator(),
    syncChunks: true,
    rabbits: false,
    loadRadius: spec.loadRadius,
    load: bundle,
  });
}


// ------------------------------------------------------------------ storage round trip

export interface StoredSave {
  /** What exportSave produced. */
  exported: SaveBundle;
  /** What came back out of the storage (fresh byte arrays; the bundle importSave takes). */
  loaded: SaveBundle;
  meta: WorldMeta;
  storage: SaveStorage;
}

/**
 * Save the world the way its server does (see the file comment) and read it back the way
 * ServerHost.load does (readSave). Network mode: the host's own save of its own world (meta id
 * and all), into its storage. Direct mode: a fresh MemoryStorage, under `worldId`.
 */
export async function saveThroughStorage(w: TestWorld, worldId: string, seedText: string, seedHash: number): Promise<StoredSave> {
  const sim = w.sim;
  const exported = exportSave(sim);
  let storage: SaveStorage;
  let id: string;
  if (w.harness !== null) {
    const host = w.harness.host;
    expect(await host.save(), 'the host saved').toBe(true);
    storage = w.harness.storage;
    id = host.meta.id;
  } else {
    storage = new MemoryStorage();
    id = worldId;
    const meta: WorldMeta = {
      id,
      name: worldId,
      seed: seedText,
      seedHash: seedHash >>> 0,
      mode: sim.rules.defaultMode,
      createdAt: 0,
      lastPlayed: 0,
      version: SAVE_VERSION,
      time: sim.world.time,
    };
    const b = saveBundle(sim, sim.generator.spec());
    await storage.putAll(id, meta, b.chunks, b.blobs);
  }
  const back = await readSave(storage, id);
  expect(back.generator, 'the generator came back').toEqual(sim.generator.spec());
  return { exported, loaded: back.bundle, meta: back.meta, storage };
}

/** Read the same save out of its storage once more (a second, independent copy of the bytes). */
export async function readAgain(saved: StoredSave): Promise<SaveBundle> {
  return (await readSave(saved.storage, saved.meta.id)).bundle;
}

/** The bytes of one named blob of a bundle. */
export function blobOf(bundle: SaveBundle, name: string): Uint8Array {
  for (const [n, b] of bundle.blobs) if (n === name) return b;
  throw new Error(`the save has no '${name}' blob`);
}

// ------------------------------------------------------------------ player actions

/** Aim at a cell of a grid and right-click once (one tick). Throws when the ray hits something else. */
export function rightClick(w: TestWorld, x: number, y: number, z: number, face?: Dir, gridId = 0): void {
  if (!w.me.useOn(x, y, z, face, gridId)) {
    const t = w.me.targetCell();
    throw new Error(`cannot aim at ${gridId}:${x},${y},${z} (ray hits ${t ? `${t.gridId}:${t.x},${t.y},${t.z} face ${t.face}` : 'nothing'})`);
  }
}

/** With glue in hand, right-click face `a[3]` of cell a of a grid: glue it (or with sneak: remove its glue). */
export function glueFace(w: TestWorld, a: readonly [number, number, number, Dir], gridId = 0, sneak = false): void {
  w.me.hold(I.GLUE);
  w.me.input.sneak = sneak;
  rightClick(w, a[0], a[1], a[2], a[3], gridId);
  w.me.input.sneak = false;
}

// ------------------------------------------------------------------ observation

export function idAt(grid: VoxelGrid, x: number, y: number, z: number): number {
  return grid.getCell(x, y, z) & ID_MASK;
}

export function setBlock(grid: VoxelGrid, x: number, y: number, z: number, id: number, facing?: Dir): void {
  grid.setCell(x, y, z, facing === undefined ? makeCell(id) : makeCell(id, facingState(facing)));
}

/** Fill an inclusive box of world cells with a block id. */
export function fill(grid: VoxelGrid, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const c = makeCell(id);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) grid.setCell(x, y, z, c);
    }
  }
}

/** Records every SimEvent. */
export class EventLog {
  readonly list: SimEvent[] = [];
  constructor(sim: Simulation) {
    sim.events.on((e) => this.list.push(e));
  }
  toasts(): Message[] {
    return this.list.filter((e): e is Extract<SimEvent, { type: 'toast' }> => e.type === 'toast').map((t) => t.message);
  }
  toastKeys(): string[] {
    return this.toasts().map((m) => m.key);
  }
  clear(): void {
    this.list.length = 0;
  }
}

function v3(v: { x: number; y: number; z: number }): [number, number, number] {
  return [v.x, v.y, v.z];
}
function q4(q: { x: number; y: number; z: number; w: number }): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

/** Every cell of a structure as "x,y,z:cell" in storage order. */
export function cellsOf(s: Structure): string[] {
  const out: string[] = [];
  s.grid.forEachCell((x, y, z, c) => out.push(`${x},${y},${z}:${c}`));
  return out;
}

/** Identity and nesting of every structure: [id, kind, parent id, grid parent id, children ids]. */
export function structureTree(sim: Simulation): Array<[number, string, number, number, number[]]> {
  return sim.structures.all().map((s) => [s.id, s.kind, s.parent?.id ?? 0, s.grid.parent.gridId, s.children.map((c) => c.id)]);
}

/** Pose and velocities of a structure grid, as plain arrays (exact numbers). */
export function poseOf(s: Structure): Record<string, number[]> {
  const g = s.grid;
  return {
    pivot: v3(g.pivot),
    position: v3(g.position),
    rotation: q4(g.rotation),
    prevPosition: v3(g.prevPosition),
    prevRotation: q4(g.prevRotation),
    linearVelocity: v3(g.linearVelocity),
    angularVelocity: v3(g.angularVelocity),
  };
}

/** Kind-specific saved state of a structure. */
export function stateOf(s: Structure): Record<string, unknown> {
  if (s instanceof Rotor) {
    return {
      bearing: [s.bearingX, s.bearingY, s.bearingZ],
      axis: s.axis,
      baseRotation: q4(s.baseRotation),
      angle: s.angle,
      angularSpeed: s.angularSpeed,
      sails: s.sails,
    };
  }
  if (s instanceof Ship) {
    return { helm: [s.helmX, s.helmY, s.helmZ], forward: s.forward, throttle: s.throttle, rudder: s.rudder, asleep: s.asleep, restTicks: s.restTicks };
  }
  return {};
}

/** Every glue store: the world's and each structure's (canonical arrays). */
export function glueStores(sim: Simulation): Record<string, number[]> {
  const out: Record<string, number[]> = { world: Array.from(sim.worldGlue.toArray()) };
  for (const s of sim.structures.all()) out[`structure ${s.id}`] = Array.from(s.glue.toArray());
  return out;
}

/** The player's saved state that matters to the player: where, looking where, holding what. */
export function playerState(w: TestWorld): Record<string, unknown> {
  const p = w.me.player;
  const inv = p.inventory;
  return {
    id: p.id,
    mode: p.mode,
    pos: v3(p.pos),
    vel: v3(p.vel),
    yaw: p.yaw,
    pitch: p.pitch,
    spawn: v3(p.spawn),
    health: p.health,
    flying: p.flying,
    carrierId: p.carrierId,
    steeringShipId: p.steeringShipId,
    seat: v3(p.seat),
    selected: inv.selected,
    hotbar: inv.hotbar.map((s) => (s === null ? null : [s.item, s.count])),
    main: inv.main.map((s) => (s === null ? null : [s.item, s.count])),
  };
}

/** Number of world cells with block `id` in an inclusive box. */
export function countId(grid: VoxelGrid, id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if ((grid.getCell(x, y, z) & ID_MASK) === id) n++;
  return n;
}
