/**
 * Helpers for the save acceptance scenarios (docs/ACCEPTANCE.md 23-24, group g6-save).
 *
 * Scenes are built with world.setCell; everything the PLAYER does (gluing, assembling, starting
 * windmills, steering, pouring) goes through the simulation's input path (look + right-click
 * with an item in hand). Saves go through the same path the browser uses: exportSave ->
 * SaveManager.save (SaveStorage.putAll with a WorldMeta) -> SaveManager.load
 * (listChunkKeys / getChunks / getBlob) -> new Simulation({ deferInitialLoad: true }) -> importSave.
 */
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import type { Dir } from '../../src/core/dirs';
import { SaveManager } from '../../src/client/saves';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { MemoryStorage } from '../../src/save/storage';
import { exportSave, importSave, type SaveBundle } from '../../src/sim/persist';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import type { Message, SimEvent } from '../../src/sim/view';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import type { VoxelGrid } from '../../src/voxel/grid';
import { FlatGenerator, VoidGenerator, type ChunkGenerator } from '../../src/worldgen/generator';

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

/** A new world as the client would open it (headless: synchronous chunks, no rabbits). */
export function newWorld(spec: SimSpec): Simulation {
  return new Simulation({
    seed: spec.seed,
    mode: spec.mode,
    generator: spec.generator(),
    syncChunks: true,
    rabbits: false,
    loadRadius: spec.loadRadius,
    spawn: spec.spawn,
  });
}

/** A Simulation built to receive a save (same seed and generator), then importSave(). */
export function loadWorld(spec: SimSpec, bundle: SaveBundle): Simulation {
  const sim = new Simulation({
    seed: spec.seed,
    mode: spec.mode,
    generator: spec.generator(),
    syncChunks: true,
    rabbits: false,
    loadRadius: spec.loadRadius,
    deferInitialLoad: true,
  });
  importSave(sim, bundle);
  return sim;
}

export { VoidGenerator };

// ------------------------------------------------------------------ storage round trip

export interface StoredSave {
  /** What exportSave produced. */
  exported: SaveBundle;
  /** What came back out of the storage (fresh byte arrays). */
  loaded: SaveBundle;
  meta: WorldMeta;
  storage: MemoryStorage;
}

/**
 * Save `sim` the way the client does (SaveManager.save -> putAll with a WorldMeta) into a fresh
 * MemoryStorage and read it back the way the client does (SaveManager.load -> listChunkKeys,
 * getChunks, getBlob).
 */
export async function saveThroughStorage(sim: Simulation, worldId: string, seedText: string, seedHash: number): Promise<StoredSave> {
  const storage = new MemoryStorage();
  const saves = new SaveManager(storage);
  let exported: SaveBundle | null = null;
  const meta: WorldMeta = {
    id: worldId,
    name: worldId,
    seed: seedText,
    seedHash: seedHash >>> 0,
    mode: sim.mode,
    createdAt: 0,
    lastPlayed: 0,
    version: SAVE_VERSION,
    time: sim.world.time,
  };
  await saves.save(() => {
    exported = exportSave(sim);
    return { meta, bundle: exported };
  });
  if (exported === null) throw new Error('the snapshot was never taken');
  const res = await saves.load(worldId);
  if (!res.ok) throw new Error(`SaveManager.load failed: ${res.reason} ${String(res.error)}`);
  return { exported, loaded: res.bundle, meta: res.meta, storage };
}

// ------------------------------------------------------------------ player actions

/** Aim at a cell of a grid and right-click once (one tick). Throws when the ray hits something else. */
export function rightClick(sim: Simulation, x: number, y: number, z: number, face?: Dir, gridId = 0): void {
  if (!sim.useOn(x, y, z, face, gridId)) {
    const t = sim.targetCell();
    throw new Error(`cannot aim at ${gridId}:${x},${y},${z} (ray hits ${t ? `${t.gridId}:${t.x},${t.y},${t.z} face ${t.face}` : 'nothing'})`);
  }
}

/** Glue (or with sneak: unglue) the face between cells a and b of a grid, with glue in hand. */
export function glueFace(
  sim: Simulation,
  a: readonly [number, number, number, Dir?],
  b: readonly [number, number, number, Dir?],
  gridId = 0,
  sneak = false,
): void {
  sim.hold(I.GLUE);
  sim.player.input.sneak = false;
  rightClick(sim, a[0], a[1], a[2], a[3], gridId);
  sim.player.input.sneak = sneak;
  rightClick(sim, b[0], b[1], b[2], b[3], gridId);
  sim.player.input.sneak = false;
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
      hubGlue: s.hubGlue,
    };
  }
  if (s instanceof Ship) {
    return { helm: [s.helmX, s.helmY, s.helmZ], forward: s.forward, throttle: s.throttle, rudder: s.rudder };
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
export function playerState(sim: Simulation): Record<string, unknown> {
  const p = sim.player;
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

/** "x,z" of every cell with block `id` on one layer of a box. */
export function cellsWithId(grid: VoxelGrid, id: number, y: number, x0: number, z0: number, x1: number, z1: number): string[] {
  const out: string[] = [];
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if ((grid.getCell(x, y, z) & ID_MASK) === id) out.push(`${x},${z}`);
  return out;
}
