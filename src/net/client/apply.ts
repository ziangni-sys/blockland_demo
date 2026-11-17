/**
 * The client's copy of the server state as plain data (docs/NETCODE.md sections 5 to 11), and the
 * pure step that applies one TickBatch to it.
 *
 * ReplicaState holds a voxel World (the subscribed columns), the world glue, the structures (Ship
 * and Rotor data objects whose grids are nested like the server's: a rotor on a ship has the
 * ship's grid as parent) and the entities, each with its latest pose and the tick of that pose,
 * the private state, the player table and the globals. It runs no rules: no StructureManager, no
 * fluids, no block updates, no entity logic, no clock, no light, no sample rings (package 5 adds
 * those on top of it). Cells are written with World.setCell / StructureGrid.setCell, so whatever
 * listens to those grids (the light engine, meshing) sees every change.
 *
 * applyBatch applies the sections in their order (section 5). Poses carried by the batch (spawn
 * records, rests, final entity states) and by Samples (applySamples) become the latest pose when
 * their tick is not older than the one held. A pivot change converts a held pose older than the
 * batch to the new pivot (section 7). Removing a structure moves the entities it carried into its
 * parent's frame first (section 7 "移除"), and removes nothing else (no cascade).
 *
 * A batch that breaks a promise of the protocol throws ReplicaError (the connection then ends with
 * protocol_error and the replica is dropped, so a half-applied batch is never used). The codec
 * checks the byte layout; applyBatch checks what needs the replica:
 *  - references: a delta, removal, rest or update of something it was never given; a carrier
 *    (entity spawns, final states) that is neither 0 nor a structure it holds once this batch's
 *    removals and spawns are applied; a rotor mounted on something that is not a ship it holds;
 *  - structure removals: children before parents (section 7), and a removed ship keeps no rotor
 *    that this batch does not remove or re-parent (resend with another parent);
 *  - kinds: a ship record with a parent, rests / helm / control for a rotor, rotor state for a
 *    ship, item / fuse / player fields for an entity of another kind, a spawn of its own entity;
 *  - the same column or id twice in one section;
 *  - a StructureDelta whose cells would make the structure's tight box larger than
 *    MAX_STRUCTURE_BOX_CELLS (checked before any cell is written, so the grid's storage never
 *    grows with the coordinates in the input);
 *  - non-finite pivots, positions, rotations, rotor and helm fields (the codec passes f64 / f32
 *    through as they are).
 * Pristine snapshots are generated synchronously through the PristineSource (package 5 queues
 * them on a ChunkSource instead).
 */
import { AIR } from '../../blocks/cell';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../../core/constants';
import type { Dir } from '../../core/dirs';
import { qrotate, vec3, wrapAngle, type Quat, type Vec3 } from '../../core/math';
import { GlueStore } from '../../structures/glue';
import { Rotor, Ship } from '../../structures/structure';
import { Chunk, chunkKey } from '../../voxel/chunk';
import type { StructureGrid } from '../../voxel/sgrid';
import { World } from '../../voxel/world';
import { MAX_STRUCTURE_BOX_CELLS } from '../protocol';
import type {
  EntityKind,
  EntityMotion,
  EntityRecord,
  GluingView,
  Globals,
  MiningView,
  NetCorrection,
  NetInventory,
  NetVitals,
  PlayerEntry,
  PlayerHeld,
  PlayerLook,
  PreviewView,
  PrivateEvent,
  PrivateState,
  SamplesMsg,
  StructureRecord,
  TickBatchMsg,
  WelcomeMsg,
  WorldEvent,
  WorldRules,
} from '../protocol';
import type { Message } from '../../sim/view';

/** The batch broke a promise of the protocol (it refers to something the replica was not given). */
export class ReplicaError extends Error {
  override readonly name: string = 'ReplicaError';
}

/** Builds the cells of a pristine column (the generator named by Welcome's GeneratorSpec). */
export interface PristineSource {
  generate(cx: number, cz: number): Uint16Array;
}

export interface ReplicaStructure {
  /** Data only: cells, glue, pose (grid.position / rotation is the latest pose), fields. */
  readonly structure: Ship | Rotor;
  /** Tick of the pose held in the grid. */
  poseTick: number;
  /** Tick of the rotor state (angle, angularSpeed, sails, frozen). */
  rotorTick: number;
}

export interface ReplicaEntity {
  readonly id: number;
  readonly kind: EntityKind;
  /** 0 = none; else pos is local to that structure and yaw relative to its heading. */
  carrierId: number;
  readonly pos: Vec3;
  yaw: number;
  /** Tick of carrierId / pos / yaw / look. */
  poseTick: number;
  /** Players: pitch and flags of the latest motion. */
  look: PlayerLook | null;
  /** Players: flags, helm, held item. */
  player: PlayerHeld | null;
  /** Items. */
  item: number;
  count: number;
  /** Falling blocks. */
  cell: number;
  /** Blast crates: the fuse at fuseTick; the client counts it down. */
  fuse: number;
  fuseTick: number;
}

export interface ReplicaView {
  mining: MiningView | null;
  gluing: GluingView | null;
  preview: PreviewView | null;
  conflicts: Vec3[];
  hint: Message | null;
}

export interface ReplicaPrivate {
  /** The last correction received (null before the first) and the tick of its batch. */
  correction: NetCorrection | null;
  correctionTick: number;
  inventory: NetInventory | null;
  vitals: NetVitals | null;
  readonly view: ReplicaView;
  /** Addressed events of the last applied batch. */
  events: PrivateEvent[];
  ack: number | null;
  moveAck: number | null;
}

export class ReplicaState {
  readonly world = new World();
  readonly worldGlue = new GlueStore();
  readonly structures = new Map<number, ReplicaStructure>();
  readonly entities = new Map<number, ReplicaEntity>();
  readonly private: ReplicaPrivate = {
    correction: null,
    correctionTick: -1,
    inventory: null,
    vitals: null,
    view: { mining: null, gluing: null, preview: null, conflicts: [], hint: null },
    events: [],
    ack: null,
    moveAck: null,
  };
  /** Player table by entity id. */
  readonly players = new Map<number, PlayerEntry>();
  /** World events of the last applied batch. */
  events: WorldEvent[] = [];
  /** Tick of the last applied batch (-1 before the first). */
  tick = -1;
  /** From Welcome. */
  ownEntityId = 0;
  isHost = false;
  worldTime = 0;
  dayOffset = 0;
  rules: WorldRules = { defaultMode: 'creative', dropsEnabled: false };
  tps: number | null = null;
  ready = false;
  roomOpen = false;

  constructor(readonly source: PristineSource) {}
}

/** Take the identity, world clock, rules and player table from Welcome (before the first batch). */
export function applyWelcome(state: ReplicaState, m: WelcomeMsg): void {
  state.ownEntityId = m.entityId;
  state.isHost = m.isHost;
  state.worldTime = m.worldTime;
  state.dayOffset = m.dayOffset;
  state.rules = { ...m.rules };
  state.roomOpen = m.roomOpen;
  state.players.clear();
  for (const p of m.players) state.players.set(p.entityId, { ...p });
}

/** Apply one TickBatch, all sections in order (section 5). Batches must come in tick order. */
export function applyBatch(state: ReplicaState, b: TickBatchMsg): void {
  if (b.tick <= state.tick) throw new ReplicaError(`batch of tick ${b.tick} after tick ${state.tick}`);
  state.tick = b.tick;
  const world = state.world;

  // 0. unsubscribe
  for (const { cx, cz } of b.unsubscribe) {
    if (world.getChunk(cx, cz) === undefined) throw new ReplicaError(`unsubscribe from column ${cx},${cz} the replica does not have`);
    world.removeChunk(cx, cz);
    clearColumnGlue(state.worldGlue, cx, cz);
  }
  // 1. snapshots: replace the column's cells and glue
  const columns = new Set<number>();
  for (const s of b.snapshots) {
    once(columns, chunkKey(s.cx, s.cz), `snapshot of column ${s.cx},${s.cz}`);
    const cells = s.cells === 'pristine' ? state.source.generate(s.cx, s.cz) : s.cells.slice();
    world.removeChunk(s.cx, s.cz);
    world.addChunk(new Chunk(s.cx, s.cz, cells));
    clearColumnGlue(state.worldGlue, s.cx, s.cz);
    for (const face of s.glue) setColumnGlue(state.worldGlue, s.cx, s.cz, face, true);
  }
  // 2. chunk deltas
  columns.clear();
  for (const d of b.chunkDeltas) {
    once(columns, chunkKey(d.cx, d.cz), `delta of column ${d.cx},${d.cz}`);
    if (world.getChunk(d.cx, d.cz) === undefined) throw new ReplicaError(`delta for column ${d.cx},${d.cz} the replica does not have`);
    const x0 = d.cx * CHUNK_SIZE;
    const z0 = d.cz * CHUNK_SIZE;
    for (const [i, cell] of d.cells) world.setCell(x0 + (i & 15), i >> 8, z0 + ((i >> 4) & 15), cell);
    for (const [face, added] of d.glue) setColumnGlue(state.worldGlue, d.cx, d.cz, face, added);
  }
  // 3. structure removals (children before parents; no cascade)
  const removing = new Set(b.structureRemoves);
  const removedShips: Ship[] = [];
  for (const id of b.structureRemoves) {
    const s = removeStructure(state, id, removing);
    if (s instanceof Ship) removedShips.push(s);
  }
  // 4. spawns and whole resends (parents before children)
  const ids = new Set<number>();
  for (const rec of b.structureSpawns) {
    once(ids, rec.id, `spawn of structure ${rec.id}`);
    spawnStructure(state, rec, b.tick);
  }
  // A removed ship's rotors are either removed too or resent with another parent (docking).
  for (const ship of removedShips) {
    if (ship.children.length > 0) throw new ReplicaError(`structure ${ship.id} removed while its rotor ${ship.children[0]!.id} stays`);
  }
  // 5. structure deltas
  ids.clear();
  for (const d of b.structureDeltas) {
    once(ids, d.id, `delta of structure ${d.id}`);
    const rs = needStructure(state, d.id);
    const s = rs.structure;
    const g = s.grid;
    if (d.cells !== undefined) {
      checkDeltaBox(g, d.cells, d.id);
      for (const [x, y, z, cell] of d.cells) g.setCell(x, y, z, cell);
    }
    if (d.glue !== undefined) {
      for (const [x, y, z, axis, added] of d.glue) {
        if (added) s.glue.add(x, y, z, (axis * 2) as Dir);
        else s.glue.remove(x, y, z, (axis * 2) as Dir);
      }
    }
    if (d.pivot !== undefined) {
      finiteVec(d.pivot, `pivot of structure ${d.id}`);
      if (rs.poseTick < b.tick) {
        // The held pose used the old pivot: same cells, new reference point.
        const off = qrotate(g.rotation, vec3(d.pivot.x - g.pivot.x, d.pivot.y - g.pivot.y, d.pivot.z - g.pivot.z));
        g.position.x += off.x;
        g.position.y += off.y;
        g.position.z += off.z;
      }
      g.pivot.x = d.pivot.x;
      g.pivot.y = d.pivot.y;
      g.pivot.z = d.pivot.z;
    }
    if (s instanceof Ship) {
      if (d.rotor !== undefined) throw new ReplicaError(`rotor state for ship ${d.id}`);
      if (d.helm !== undefined) {
        s.helmX = d.helm.x;
        s.helmY = d.helm.y;
        s.helmZ = d.helm.z;
        s.forward = d.helm.forward;
        s.helmsmanId = d.helm.helmsmanId;
      }
      if (d.control !== undefined) {
        finite(d.control.throttle, `throttle of ship ${d.id}`);
        finite(d.control.rudder, `rudder of ship ${d.id}`);
        s.throttle = d.control.throttle;
        s.rudder = d.control.rudder;
      }
    } else {
      if (d.helm !== undefined || d.control !== undefined) throw new ReplicaError(`helm fields for rotor ${d.id}`);
      if (d.rotor !== undefined) {
        finite(d.rotor.angle, `angle of rotor ${d.id}`);
        finite(d.rotor.angularSpeed, `angular speed of rotor ${d.id}`);
        s.angle = d.rotor.angle;
        s.angularSpeed = d.rotor.angularSpeed;
        s.sails = d.rotor.sails;
        s.frozen = d.rotor.frozen;
        rs.rotorTick = b.tick;
      }
    }
  }
  // 6. rests
  ids.clear();
  for (const r of b.structureRests) {
    once(ids, r.id, `rest of structure ${r.id}`);
    const rs = needStructure(state, r.id);
    if (!(rs.structure instanceof Ship)) throw new ReplicaError(`rest of rotor ${r.id} (only ships have poses)`);
    setPose(rs.structure.grid, r.pose.pos, r.pose.rot);
    rs.poseTick = b.tick;
  }
  // 7. entity despawns
  for (const id of b.entityDespawns) {
    if (!state.entities.delete(id)) throw new ReplicaError(`despawn of entity ${id} the replica does not have`);
  }
  // 8. entity spawns
  for (const rec of b.entitySpawns) {
    if (rec.id === state.ownEntityId) throw new ReplicaError(`spawn of the client's own entity ${rec.id}`);
    if (state.entities.has(rec.id)) throw new ReplicaError(`spawn of entity ${rec.id} the replica already has`);
    needCarrier(state, rec.carrierId, rec.id);
    state.entities.set(rec.id, entityFromRecord(rec, b.tick));
  }
  // 9. entity updates
  ids.clear();
  for (const u of b.entityUpdates) {
    once(ids, u.id, `update of entity ${u.id}`);
    const e = state.entities.get(u.id);
    if (e === undefined) throw new ReplicaError(`update of entity ${u.id} the replica does not have`);
    if (u.final !== undefined) {
      needCarrier(state, u.final.carrierId, u.id);
      if (b.tick >= e.poseTick) setMotion(e, u.final, b.tick);
    }
    if (u.stack !== undefined) {
      if (e.kind !== 'item') throw new ReplicaError(`item stack for entity ${u.id}, a ${e.kind}`);
      e.item = u.stack.item;
      e.count = u.stack.count;
    }
    if (u.fuse !== undefined) {
      if (e.kind !== 'tnt') throw new ReplicaError(`fuse for entity ${u.id}, a ${e.kind}`);
      e.fuse = u.fuse;
      e.fuseTick = b.tick;
    }
    if (u.player !== undefined) {
      if (e.kind !== 'player') throw new ReplicaError(`player fields for entity ${u.id}, a ${e.kind}`);
      e.player = { flags: { ...u.player.flags }, steeringShipId: u.player.steeringShipId, heldItem: u.player.heldItem };
    }
  }
  // 10. private
  state.private.events = [];
  if (b.private !== null) applyPrivate(state, b.private, b.tick);
  // 11. events
  state.events = b.events;
  // 12. globals
  if (b.globals !== null) applyGlobals(state, b.globals);
}

/**
 * Take the poses of a Samples message as the latest ones where they are not older than what is
 * held. Samples of ids the replica does not have are ignored (package 5 keeps them for a while),
 * and so are entity samples whose carrier it does not hold: the unreliable channel can deliver a
 * sample before the batch that spawns its carrier, or after the batch that removed it. A ship
 * sample naming a rotor is a ReplicaError (only ships have poses).
 */
export function applySamples(state: ReplicaState, m: SamplesMsg): void {
  for (const s of m.ships) {
    const rs = state.structures.get(s.id);
    if (rs === undefined) continue;
    if (!(rs.structure instanceof Ship)) throw new ReplicaError(`ship sample of rotor ${s.id}`);
    if (m.tick < rs.poseTick) continue;
    setPose(rs.structure.grid, s.pose.pos, s.pose.rot);
    rs.poseTick = m.tick;
  }
  for (const s of m.entities) {
    const e = state.entities.get(s.id);
    if (e === undefined || m.tick < e.poseTick) continue;
    if (s.carrierId !== 0 && !state.structures.has(s.carrierId)) continue;
    setMotion(e, s, m.tick);
  }
}

// ====================================================================== helpers

function clearColumnGlue(glue: GlueStore, cx: number, cz: number): void {
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const faces: number[] = [];
  glue.forEachInBox(x0, 0, z0, x0 + CHUNK_SIZE - 1, WORLD_HEIGHT - 1, z0 + CHUNK_SIZE - 1, (x, y, z, axis) => {
    if (x >= x0 && x < x0 + CHUNK_SIZE && z >= z0 && z < z0 + CHUNK_SIZE) faces.push(x, y, z, axis);
  });
  for (let i = 0; i < faces.length; i += 4) glue.remove(faces[i]!, faces[i + 1]!, faces[i + 2]!, (faces[i + 3]! * 2) as Dir);
}

/** Add or remove a column glue face (lx | lz<<4 | y<<8 | axis<<15); set semantics. */
function setColumnGlue(glue: GlueStore, cx: number, cz: number, face: number, added: boolean): void {
  const x = cx * CHUNK_SIZE + (face & 15);
  const z = cz * CHUNK_SIZE + ((face >> 4) & 15);
  const y = (face >> 8) & 127;
  const dir = ((face >> 15) * 2) as Dir;
  if (added) glue.add(x, y, z, dir);
  else glue.remove(x, y, z, dir);
}

function needStructure(state: ReplicaState, id: number): ReplicaStructure {
  const rs = state.structures.get(id);
  if (rs === undefined) throw new ReplicaError(`structure ${id} is not in the replica`);
  return rs;
}

/** A carrier is 0 (the world) or a structure the replica holds. */
function needCarrier(state: ReplicaState, carrierId: number, entityId: number): void {
  if (carrierId !== 0 && !state.structures.has(carrierId)) throw new ReplicaError(`entity ${entityId} carried by structure ${carrierId}, which the replica does not have`);
}

/** Each column or id at most once per section. */
function once(seen: Set<number>, key: number, what: string): void {
  if (seen.has(key)) throw new ReplicaError(`${what} twice in one batch`);
  seen.add(key);
}

function finite(v: number, what: string): void {
  if (!Number.isFinite(v)) throw new ReplicaError(`${what} is not finite: ${v}`);
}

function finiteVec(v: Vec3, what: string): void {
  if (!(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))) throw new ReplicaError(`${what} is not finite`);
}

/** Finite and not zero (a rotation is normalised on the server). */
function finiteQuat(q: Quat, what: string): void {
  const n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (!(Number.isFinite(n) && n > 0)) throw new ReplicaError(`${what} is not a rotation`);
}

/** Within the box limit of section 7 (each side and the volume). */
function boxFits(sx: number, sy: number, sz: number): boolean {
  const lim = MAX_STRUCTURE_BOX_CELLS;
  return sx <= lim && sy <= lim && sz <= lim && sx * sy * sz <= lim;
}

/**
 * Throw unless the structure's tight box after the delta's cells stays within
 * MAX_STRUCTURE_BOX_CELLS. Called before any cell is written (StructureGrid.setCell grows the
 * storage to whatever coordinate it is given). Fast path: the box of the current cells and the
 * delta's non-air cells fits. Otherwise the exact box after the delta is computed: the final
 * value of each cell in the delta (the last one listed), the current cells that the delta does
 * not clear, and the delta's non-air cells.
 */
function checkDeltaBox(g: StructureGrid, cells: ReadonlyArray<readonly [number, number, number, number]>, id: number): void {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let solid = 0;
  for (const [x, y, z, cell] of cells) {
    if (cell === AIR) continue;
    solid++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (solid === 0) return;
  const b = g.cellBounds();
  if (b !== null) {
    if (minX >= b.minX && minY >= b.minY && minZ >= b.minZ && maxX < b.maxX && maxY < b.maxY && maxZ < b.maxZ) return;
    if (boxFits(Math.max(maxX + 1, b.maxX) - Math.min(minX, b.minX), Math.max(maxY + 1, b.maxY) - Math.min(minY, b.minY), Math.max(maxZ + 1, b.maxZ) - Math.min(minZ, b.minZ))) return;
  } else if (boxFits(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1)) {
    return;
  }
  // Slow path (a box at the limit, or bad input): the exact box after the delta.
  const final = new Map<string, number>();
  for (const [x, y, z, cell] of cells) final.set(`${x},${y},${z}`, cell);
  minX = minY = minZ = Infinity;
  maxX = maxY = maxZ = -Infinity;
  const take = (x: number, y: number, z: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };
  for (const [x, y, z, cell] of cells) if (final.get(`${x},${y},${z}`) === cell && cell !== AIR) take(x, y, z);
  g.forEachCell((x, y, z) => {
    if (final.get(`${x},${y},${z}`) !== AIR) take(x, y, z);
  });
  if (minX === Infinity) return;
  if (!boxFits(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1)) throw new ReplicaError(`delta makes structure ${id}'s box larger than ${MAX_STRUCTURE_BOX_CELLS} cells`);
}

function setPose(g: StructureGrid, pos: Vec3, rot: Quat): void {
  g.setPoseImmediate(pos, rot);
}

/** Heading of a rotation about +Y (structures/entities: headingOf). */
function heading(q: Quat): number {
  return wrapAngle(2 * Math.atan2(q.y, q.w));
}

/** Remove one listed structure; its rotors that this batch also removes must have come first. */
function removeStructure(state: ReplicaState, id: number, removing: ReadonlySet<number>): Ship | Rotor {
  const rs = needStructure(state, id);
  const s = rs.structure;
  for (const child of s.children) {
    if (removing.has(child.id)) throw new ReplicaError(`structure ${id} removed before its rotor ${child.id}`);
  }
  const parentId = s.parent?.id ?? 0;
  // Carried entities move into the parent's frame at the structure's latest pose.
  for (const e of state.entities.values()) {
    if (e.carrierId !== id) continue;
    const p = s.grid.toParent(e.pos);
    e.pos.x = p.x;
    e.pos.y = p.y;
    e.pos.z = p.z;
    e.yaw = wrapAngle(e.yaw + heading(s.grid.rotation));
    e.carrierId = parentId;
  }
  detachRotor(s);
  s.removed = true;
  state.structures.delete(id);
  return s;
}

function detachRotor(s: Ship | Rotor): void {
  if (!(s instanceof Rotor) || s.parent === null) return;
  const list = s.parent.children;
  const i = list.indexOf(s);
  if (i >= 0) list.splice(i, 1);
}

function spawnStructure(state: ReplicaState, rec: StructureRecord, tick: number): void {
  finiteVec(rec.pivot, `pivot of structure ${rec.id}`);
  finiteVec(rec.position, `position of structure ${rec.id}`);
  finiteQuat(rec.rotation, `rotation of structure ${rec.id}`);
  if (rec.kind === 'rotor') {
    finiteQuat(rec.baseRotation, `base rotation of rotor ${rec.id}`);
    finite(rec.angle, `angle of rotor ${rec.id}`);
    finite(rec.angularSpeed, `angular speed of rotor ${rec.id}`);
  } else {
    if (rec.parentId !== 0) throw new ReplicaError(`ship ${rec.id} mounted on structure ${rec.parentId} (ships are mounted on the world)`);
    finite(rec.throttle, `throttle of ship ${rec.id}`);
    finite(rec.rudder, `rudder of ship ${rec.id}`);
  }
  let parentGrid: World | StructureGrid = state.world;
  let parent: Ship | null = null;
  if (rec.parentId !== 0) {
    const p = needStructure(state, rec.parentId).structure;
    if (!(p instanceof Ship)) throw new ReplicaError(`structure ${rec.id} mounted on ${rec.parentId}, which is not a ship`);
    parent = p;
    parentGrid = p.grid;
  }
  let rs = state.structures.get(rec.id);
  if (rs !== undefined && rs.structure.kind !== rec.kind) throw new ReplicaError(`structure ${rec.id} changed kind`);
  if (rs === undefined) {
    rs = { structure: rec.kind === 'ship' ? new Ship(rec.id, parentGrid) : new Rotor(rec.id, parentGrid), poseTick: tick, rotorTick: tick };
    state.structures.set(rec.id, rs);
  }
  rs.poseTick = tick;
  rs.rotorTick = tick;
  const s = rs.structure;
  const g = s.grid;
  loadCells(g, rec);
  s.glue.clear();
  for (let i = 0; i < rec.glue.length; i += 4) s.glue.add(rec.glue[i]!, rec.glue[i + 1]!, rec.glue[i + 2]!, (rec.glue[i + 3]! * 2) as Dir);
  g.pivot.x = rec.pivot.x;
  g.pivot.y = rec.pivot.y;
  g.pivot.z = rec.pivot.z;
  setPose(g, rec.position, rec.rotation);
  if (s instanceof Rotor && rec.kind === 'rotor') {
    if (s.parent !== parent) {
      detachRotor(s);
      s.parent = parent;
      if (parent !== null) parent.children.push(s);
    } else if (parent !== null && !parent.children.includes(s)) {
      parent.children.push(s);
    }
    g.parent = parentGrid;
    s.bearingX = rec.bearing.x;
    s.bearingY = rec.bearing.y;
    s.bearingZ = rec.bearing.z;
    s.axis = rec.axis;
    const q = s.baseRotation;
    q.x = rec.baseRotation.x;
    q.y = rec.baseRotation.y;
    q.z = rec.baseRotation.z;
    q.w = rec.baseRotation.w;
    s.angle = rec.angle;
    s.angularSpeed = rec.angularSpeed;
    s.sails = rec.sails;
    s.frozen = rec.frozen;
  } else if (s instanceof Ship && rec.kind === 'ship') {
    s.helmX = rec.helm.x;
    s.helmY = rec.helm.y;
    s.helmZ = rec.helm.z;
    s.forward = rec.forward;
    s.throttle = rec.throttle;
    s.rudder = rec.rudder;
    s.helmsmanId = rec.helmsmanId;
  }
}

/** Replace a grid's cells with a record's box. */
function loadCells(g: StructureGrid, rec: StructureRecord): void {
  g.resize(0, 0, 0, 0, 0, 0);
  if (rec.sx === 0) return;
  g.resize(rec.minX, rec.minY, rec.minZ, rec.sx, rec.sy, rec.sz);
  g.cells.set(rec.cells);
  let n = 0;
  for (let i = 0; i < rec.cells.length; i++) if (rec.cells[i] !== AIR) n++;
  g.count = n;
  g.version++;
}

function entityFromRecord(rec: EntityRecord, tick: number): ReplicaEntity {
  const e: ReplicaEntity = {
    id: rec.id,
    kind: rec.kind,
    carrierId: rec.carrierId,
    pos: { x: rec.pos.x, y: rec.pos.y, z: rec.pos.z },
    yaw: rec.yaw,
    poseTick: tick,
    look: null,
    player: null,
    item: 0,
    count: 0,
    cell: 0,
    fuse: 0,
    fuseTick: tick,
  };
  switch (rec.kind) {
    case 'player':
      e.look = { pitch: rec.pitch, flags: { ...rec.flags } };
      e.player = { flags: { ...rec.flags }, steeringShipId: rec.steeringShipId, heldItem: rec.heldItem };
      break;
    case 'item':
      e.item = rec.item;
      e.count = rec.count;
      break;
    case 'falling':
      e.cell = rec.cell;
      break;
    case 'tnt':
      e.fuse = rec.fuse;
      break;
    case 'rabbit':
      break;
  }
  return e;
}

function setMotion(e: ReplicaEntity, m: EntityMotion, tick: number): void {
  if (m.kind !== e.kind) throw new ReplicaError(`entity ${e.id} is a ${e.kind}, its motion says ${m.kind}`);
  e.carrierId = m.carrierId;
  e.pos.x = m.pos.x;
  e.pos.y = m.pos.y;
  e.pos.z = m.pos.z;
  e.yaw = m.yaw;
  if (m.look !== null) e.look = { pitch: m.look.pitch, flags: { ...m.look.flags } };
  e.poseTick = tick;
}

function applyPrivate(state: ReplicaState, p: PrivateState, tick: number): void {
  const pr = state.private;
  if (p.correction !== undefined) {
    pr.correction = p.correction;
    pr.correctionTick = tick;
  }
  if (p.inventory !== undefined) pr.inventory = p.inventory;
  if (p.vitals !== undefined) pr.vitals = p.vitals;
  if (p.view !== undefined) {
    const v = p.view;
    if (v.mining !== undefined) pr.view.mining = v.mining;
    if (v.gluing !== undefined) pr.view.gluing = v.gluing;
    if (v.preview !== undefined) pr.view.preview = v.preview;
    if (v.conflicts !== undefined) pr.view.conflicts = v.conflicts;
    if (v.hint !== undefined) pr.view.hint = v.hint;
  }
  if (p.events !== undefined) pr.events = p.events;
  if (p.ack !== undefined) pr.ack = p.ack;
  if (p.moveAck !== undefined) pr.moveAck = p.moveAck;
}

function applyGlobals(state: ReplicaState, g: Globals): void {
  if (g.dayOffset !== undefined) state.dayOffset = g.dayOffset;
  if (g.rules !== undefined) state.rules = { ...g.rules };
  if (g.players !== undefined) {
    for (const op of g.players) {
      if (op.op === 'join') state.players.set(op.entityId, { entityId: op.entityId, name: op.name, host: op.host });
      else state.players.delete(op.entityId);
    }
  }
  if (g.tps !== undefined) state.tps = g.tps;
  if (g.ready === true) state.ready = true;
  if (g.roomOpen !== undefined) state.roomOpen = g.roomOpen;
}
