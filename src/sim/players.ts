/**
 * Players in a world: who has joined, who has left, and the per-player controller.
 *
 * REGISTRY. A Simulation starts with no players. join(key) brings a player into the world: the
 * stored record of that key if there is one (position, look, carrier, mode, health, air, spawn
 * point, the whole inventory including the off-hand and the cursor — entities/manager.ts
 * writePlayerRecord), else a new player at the world spawn in the world's default mode. leave(key)
 * takes the player out of the world and keeps its record, so a later join (in this session or
 * after a save and reload) restores it. A PlayerKey is a stable string chosen by the caller (the
 * client keeps it; later a network identity). There is no "local" player: the simulation treats
 * every joined player alike.
 *
 * ORDER. A player gets an entity id at its first join in a world and keeps it: the record stores
 * it, and a rejoin (also after a reload) reuses it (ids are never handed out twice, so it is
 * always free). Everything that runs per player (actions in tick step 1, pickups, rabbits, chunk
 * anchors, views) goes through online(), which lists the joined players in ascending entity id
 * order, i.e. in the order of their FIRST join in this world. Conflicts between players resolve
 * in that order. The entity list is kept in id order too, so a saved world continues exactly as
 * it would have without the save.
 *
 * LEAVING. A player who leaves lets go of the wheel; the record keeps the world position and,
 * when it stood on a structure, that structure and the feet local to it (NETCODE "场景 36 和玩家
 * 记录"). A rejoining player whose carrier still exists is put back on it where it stood on it,
 * if that spot is free (so a passenger of a ship that sailed on while they were away comes back
 * aboard), else at the world position. What the hands were doing (a preview, mining progress, a
 * timed glue operation) is dropped, as on a reload.
 *
 * LOADING. A save holds the records of the players who were joined as they were, still at the
 * wheel or on a carrier, so a player who joins the loaded world before it first ticks carries on
 * exactly (the single-player client does). Whoever has not joined by the first tick is settled as
 * if they had left when the world was saved (settleAfterLoad): the record lets go of the wheel
 * (keeping its carrier), and a ship nobody steers loses throttle and rudder instead of sailing on
 * unmanned. A later join then restores the player on its carrier as above, not at the wheel.
 *
 * CONTROL. PlayerControl is the handle of one joined player: its entity, its InteractionView,
 * its helm read-out, its chunk view radius, and the scripted controls (look, click, hold, give,
 * teleport, set the mode, respawn ...). They only write what that player's client would write
 * (input, inventory) or what a command would (teleport, mode), so a scripted player behaves
 * exactly like a played one. A control is valid until its player leaves; a rejoin hands out a
 * new one.
 *
 * DRIVE. A joined player starts server-driven: the server moves it from its input (the present
 * client, tests and scripted control). setDrive('client') makes it client-driven: its client moves
 * it and sends move reports (submitReport), the server checks them and keeps the authority on
 * everything else, and tells the client where it put the player whenever it moved it on its own
 * authority (correction / takeCorrection). See entities/drive.ts. Scripted clicks and held keys
 * still reach the server for both; for a client-driven player the held movement keys only matter
 * to its client, except the stick axes and sneak, which its reports carry (helm, docking).
 */
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../core/dirs';
import { vec3, type Vec3 } from '../core/math';
import type { Correction, DriveMode, MoveReport } from '../entities/drive';
import { Player, type GameMode } from '../entities/entity';
import { maxStackOf } from '../entities/inventory';
import { readPlayerRecord, writePlayerRecord } from '../entities/manager';
import { ByteReader, ByteWriter } from '../save/bytes';
import { Ship } from '../structures/structure';
import { boxOverlapsSolid } from '../voxel/shape';
import { Hands } from './interact';
import type { Simulation } from './simulation';
import type { GridCell, HelmView, InteractionView, PlayerKey } from './view';

/** Longest PlayerKey (UTF-16 code units). */
export const MAX_PLAYER_KEY_LENGTH = 128;
/**
 * Largest chunk radius kept loaded around one player, whatever view radius it asks for (the
 * client's largest render distance, 16, plus the ring that is loaded but not drawn).
 */
export const MAX_VIEW_RADIUS = 17;
/** A rejoining player fits on its carrier when its body box, inset this much (blocks), overlaps no hard cell. */
const BOARD_INSET = 0.1;
/** A carrier that puts the record's feet this close (blocks, summed over the axes) to its world position has not moved since. */
const SAME_PLACE = 1e-9;
/** Layout of the 'players' save blob. Only this version is read. */
const PLAYERS_BLOB_VERSION = 1;

function checkKey(key: PlayerKey): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_PLAYER_KEY_LENGTH) {
    throw new RangeError(`player key must be a string of 1..${MAX_PLAYER_KEY_LENGTH} characters`);
  }
}

export class PlayerRegistry {
  /** Records of the players who are not in the world: their entity id and writePlayerRecord bytes, by key. */
  private readonly offline = new Map<PlayerKey, OfflineRecord>();
  private readonly byKey = new Map<PlayerKey, PlayerControl>();
  private readonly byEntity = new Map<Player, PlayerControl>();
  /** Joined players in ascending entity id order. Replaced (never mutated) on join / leave. */
  private ordered: readonly PlayerControl[] = [];
  /** A save was loaded and the world has not ticked since (settleAfterLoad). */
  private loaded = false;

  constructor(private readonly sim: Simulation) {}

  /**
   * Bring the player `key` into the world: restore its stored record, or spawn a new player at
   * the world spawn in the world's default mode. Loads the ground around it (synchronously) so
   * it stands on something at the next tick. Throws when `key` has already joined.
   */
  join(key: PlayerKey): PlayerControl {
    checkKey(key);
    if (this.byKey.has(key)) throw new Error(`player '${key}' has already joined`);
    const sim = this.sim;
    const record = this.offline.get(key);
    let p: Player;
    if (record !== undefined) {
      // The kept id; only a damaged save could have given it to something else meanwhile.
      const id = sim.entities.get(record.id) === undefined ? record.id : sim.entities.allocateId();
      const rec = readPlayerRecord(new ByteReader(record.bytes, 'player'), id);
      p = rec.player;
      if (rec.carrierPos !== null) this.boardAgain(p, rec.carrierPos);
      sim.entities.add(p);
    } else {
      const s = sim.spawnPoint;
      p = sim.entities.spawnPlayer(sim.rules.defaultMode, s.x, s.y, s.z);
    }
    this.offline.delete(key);
    const control = new PlayerControl(sim, key, p);
    this.byKey.set(key, control);
    this.byEntity.set(p, control);
    this.ordered = [...this.ordered, control].sort((a, b) => a.entityId - b.entityId);
    sim.chunks.loadAround(sim.generator, p.pos.x, p.pos.z, 1);
    return control;
  }

  /**
   * Take the player `key` out of the world, keeping its record for a later join (see LEAVING
   * in the header). Throws when `key` has not joined.
   */
  leave(key: PlayerKey): void {
    const control = this.byKey.get(key);
    if (control === undefined) throw new Error(`player '${key}' has not joined`);
    const p = control.player;
    // Lets go of the wheel (an addressed helmReleased event: the player is still registered).
    this.sim.entities.remove(p);
    this.storeOffline(key, p);
    this.byKey.delete(key);
    this.byEntity.delete(p);
    this.ordered = this.ordered.filter((c) => c !== control);
    control.detach();
  }

  /**
   * A rejoining player whose record names a carrier: back on that structure, `local` being its feet
   * there, when the structure still exists and the body fits there (no hard cell of the world or of
   * any structure in it); else it stays at the record's world position, carried by nothing.
   */
  private boardAgain(p: Player, local: Vec3): void {
    const sim = this.sim;
    const s = sim.structures.get(p.carrierId);
    if (s !== undefined && !s.removed) {
      const w = s.grid.toWorld(local, vec3());
      // The carrier has not moved since the record was written (a save loaded and joined before
      // the first tick): the player carries on exactly as it was, motion included.
      if (Math.abs(w.x - p.pos.x) + Math.abs(w.y - p.pos.y) + Math.abs(w.z - p.pos.z) < SAME_PLACE) return;
      // Else it comes back standing still on it (the motion it left with means nothing now).
      p.vel.x = p.vel.y = p.vel.z = 0;
      p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
      sim.chunks.loadAround(sim.generator, w.x, w.z, 1);
      const prev = vec3(p.pos.x, p.pos.y, p.pos.z);
      p.setPosition(w.x, w.y, w.z);
      // (A little inset: on a rolling deck the world-aligned box dips into it at a corner.)
      const box = p.box();
      box.minX += BOARD_INSET;
      box.minY += BOARD_INSET;
      box.minZ += BOARD_INSET;
      box.maxX -= BOARD_INSET;
      box.maxY -= BOARD_INSET;
      box.maxZ -= BOARD_INSET;
      if (!boxOverlapsSolid(sim.world, box) && !sim.structures.all().some((o) => !o.removed && boxOverlapsSolid(o.grid, box))) return;
      p.setPosition(prev.x, prev.y, prev.z);
    }
    p.carrierId = 0;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
  }

  /** The record of player `p` now: its carrier's frame, when it stands on a live structure, goes with it. */
  private recordOf(p: Player): Uint8Array {
    const s = p.carrierId !== 0 ? this.sim.structures.get(p.carrierId) : undefined;
    const w = new ByteWriter();
    writePlayerRecord(w, p, s !== undefined && !s.removed ? s.grid.toLocal(p.pos, vec3()) : null);
    return w.finish();
  }

  /** Keep the record of a player who is out of the world. */
  private storeOffline(key: PlayerKey, p: Player): void {
    this.offline.set(key, { id: p.id, bytes: this.recordOf(p) });
  }

  /**
   * Called at the start of every tick; does something only at the first tick after a save was
   * loaded (see LOADING in the header). A record that is still offline then lets go of the wheel,
   * as leave() would have: its ship loses throttle and rudder unless a joined player steers it.
   * The record keeps its carrier.
   */
  settleAfterLoad(): void {
    if (!this.loaded) return;
    this.loaded = false;
    const sim = this.sim;
    for (const [key, rec] of [...this.offline]) {
      const { player: p, carrierPos } = readPlayerRecord(new ByteReader(rec.bytes, 'player'), rec.id);
      if (p.steeringShipId === 0) continue;
      const shipId = p.steeringShipId;
      p.steeringShipId = 0;
      const ship = shipId === 0 ? undefined : sim.structures.get(shipId);
      if (ship instanceof Ship && (ship.helmsmanId === 0 || ship.helmsmanId === p.id)) {
        // Nobody re-took this wheel yet (a joined helmsman re-claims it in its first entity step).
        const steered = this.ordered.some((c) => c.player.steeringShipId === shipId);
        if (!steered) {
          ship.helmsmanId = 0;
          ship.throttle = 0;
          ship.rudder = 0;
        }
      }
      const w = new ByteWriter();
      writePlayerRecord(w, p, carrierPos);
      this.offline.set(key, { id: rec.id, bytes: w.finish() });
    }
  }

  /** The control of a joined player, or undefined. */
  get(key: PlayerKey): PlayerControl | undefined {
    return this.byKey.get(key);
  }

  /** The control of the joined player whose entity this is, or undefined. */
  controlOf(p: Player): PlayerControl | undefined {
    return this.byEntity.get(p);
  }

  /** Joined players in ascending entity id order (order of first join in this world). Do not keep it across a join or leave. */
  online(): readonly PlayerControl[] {
    return this.ordered;
  }

  /** Every player this world knows, joined or not, sorted by key. */
  keys(): PlayerKey[] {
    return [...new Set([...this.byKey.keys(), ...this.offline.keys()])].sort(compareKeys);
  }

  /**
   * The 'players' save blob: the record of every known player, joined ones as they are now,
   * sorted by key.
   */
  serialize(w: ByteWriter): void {
    const keys = this.keys();
    w.varuint(PLAYERS_BLOB_VERSION);
    w.varuint(keys.length);
    for (const key of keys) {
      w.string(key);
      const c = this.byKey.get(key);
      if (c !== undefined) {
        w.varuint(c.entityId);
        w.bytes(this.recordOf(c.player));
      } else {
        const o = this.offline.get(key)!;
        w.varuint(o.id);
        w.bytes(o.bytes);
      }
    }
  }

  /**
   * Replace every stored record with the saved ones. Only while nobody has joined (loading a save
   * comes before the first join). Atomic: every record is decoded once first, so a corrupt blob
   * throws (SaveFormatError) and changes nothing.
   */
  deserialize(r: ByteReader): void {
    if (this.byKey.size > 0) throw new Error('players can only be loaded while nobody has joined');
    const v = r.varuint();
    if (v !== PLAYERS_BLOB_VERSION) r.fail(`unsupported players blob version ${v}`);
    const n = r.count(2);
    const parsed = new Map<PlayerKey, OfflineRecord>();
    const ids = new Set<number>();
    for (let i = 0; i < n; i++) {
      const key = r.string();
      if (key.length === 0 || key.length > MAX_PLAYER_KEY_LENGTH) r.fail(`bad player key length ${key.length}`);
      if (parsed.has(key)) r.fail(`duplicate player key '${key}'`);
      const id = r.varuint();
      if (id === 0 || !Number.isSafeInteger(id)) r.fail(`bad entity id ${id} of player '${key}'`);
      if (ids.has(id)) r.fail(`entity id ${id} of player '${key}' is taken twice`);
      ids.add(id);
      const bytes = r.bytes();
      const rr = new ByteReader(bytes, `player '${key}'`);
      readPlayerRecord(rr, id);
      rr.expectEnd();
      parsed.set(key, { id, bytes });
    }
    r.expectEnd();
    this.offline.clear();
    for (const [k, b] of parsed) this.offline.set(k, b);
    this.loaded = true;
  }
}

interface OfflineRecord {
  /** The entity id the player had and gets again at its next join. */
  readonly id: number;
  readonly bytes: Uint8Array;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The handle of one joined player (see CONTROL in the header). */
export class PlayerControl {
  /** This player's hands (interaction state); the view is rebuilt every tick. */
  readonly hands: Hands;
  private entity: Player | null;
  /** Entity id of this join (fixed: the order key of online()). */
  readonly entityId: number;
  private radius: number;

  constructor(
    private readonly sim: Simulation,
    readonly key: PlayerKey,
    player: Player,
  ) {
    this.entity = player;
    this.entityId = player.id;
    this.hands = new Hands(sim, sim.interaction, player, key);
    this.radius = sim.defaultViewRadius;
  }

  /** Called by the registry when the player leaves: the control is dead from now on. */
  detach(): void {
    this.entity = null;
  }

  /** False once the player left (a rejoin hands out a new control). */
  get online(): boolean {
    return this.entity !== null;
  }

  /** The player's entity. Throws once the player left. */
  get player(): Player {
    const p = this.entity;
    if (p === null) throw new Error(`player '${this.key}' has left`);
    return p;
  }

  private requireOnline(): void {
    if (this.entity === null) throw new Error(`player '${this.key}' has left`);
  }

  /** What this player's actions look like right now (overlays, hint). Rebuilt every tick. */
  get view(): InteractionView {
    return this.hands.view;
  }

  /**
   * Chunk radius kept loaded around this player (its client's view distance), capped at
   * MAX_VIEW_RADIUS. Starts at the simulation's default. Non-finite values are ignored.
   */
  get viewRadius(): number {
    return this.radius;
  }
  set viewRadius(r: number) {
    if (!Number.isFinite(r)) return;
    this.radius = Math.max(0, Math.min(MAX_VIEW_RADIUS, Math.floor(r)));
  }

  /** Steering read-out while the player holds a helm, else null. */
  helmView(): HelmView | null {
    const id = this.player.steeringShipId;
    if (id === 0) return null;
    const ship = this.sim.structures.get(id);
    if (!(ship instanceof Ship)) return null;
    const v = ship.grid.linearVelocity;
    return { throttle: ship.throttle, rudder: ship.rudder, speed: Math.hypot(v.x, v.z), sails: ship.sails };
  }

  // ------------------------------------------------------------------ commands

  /** This player's game mode (DESIGN: per player). Survival ends flight. */
  setMode(mode: GameMode): void {
    this.sim.entities.setMode(this.player, mode);
  }
  respawn(): void {
    const p = this.player;
    if (p.dead) this.sim.entities.respawn(p);
  }
  /** Let go of the helm, if the player holds one (the client calls this when a screen opens). */
  releaseHelm(): void {
    const p = this.player;
    if (p.steeringShipId !== 0) this.sim.entities.stopSteering(p);
  }
  /** Throw the stack held by the inventory cursor into the world (clicking outside the inventory). */
  dropCursorStack(): void {
    const p = this.player;
    const stack = p.inventory.takeCursor();
    if (stack) this.sim.entities.dropFromPlayer(p, stack.item, stack.count);
  }
  /**
   * Pick block (middle click): put the block the player looks at (the use ray's target, what
   * the outline shows; world or structure) in hand — see Hands.pickBlock for the hotbar and
   * backpack rules (creative fills a slot, survival only selects or swaps). Also writes
   * input.slot, so the next tick keeps the selection; a client that drives input.slot must
   * adopt player.inventory.selected afterwards. Returns true when the block is in hand.
   */
  pickBlock(): boolean {
    this.requireOnline();
    return this.hands.pickBlock();
  }

  // ------------------------------------------------------------------ scripted control

  /** Point the player's view at a world point (writes input.yaw / pitch like the client does). */
  lookAt(x: number, y: number, z: number): void {
    const p = this.player;
    const e = p.eyePos();
    const dx = x - e.x;
    const dy = y - e.y;
    const dz = z - e.z;
    const h = Math.hypot(dx, dz);
    if (h < 1e-12 && Math.abs(dy) < 1e-12) return;
    // forward = (-sin(yaw) cos(pitch), sin(pitch), -cos(yaw) cos(pitch))
    const yaw = h < 1e-12 ? p.yaw : Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, h);
    p.input.yaw = yaw;
    p.input.pitch = pitch;
    p.yaw = yaw;
    p.pitch = pitch;
  }

  /**
   * Point the view at a cell of a grid (0 = world, else a structure id): at the centre of
   * `face` when given (the ray then enters through that face, if the eye is on its outer
   * side), else at the cell centre. Returns false when the grid does not exist.
   */
  lookAtCell(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    const g = this.sim.structures.gridById(gridId);
    if (g === undefined) return false;
    const p = vec3(x + 0.5, y + 0.5, z + 0.5);
    if (face !== undefined) {
      // Slightly inside the face: the ray crosses the face near its centre, never an edge.
      p.x += DIR_X[face]! * 0.45;
      p.y += DIR_Y[face]! * 0.45;
      p.z += DIR_Z[face]! * 0.45;
    }
    g.toWorld(p, p);
    this.lookAt(p.x, p.y, p.z);
    return true;
  }

  /** Queue one right-click (consumed by the next tick). */
  use(): void {
    this.player.input.usePresses++;
  }
  /** Queue one left-click (consumed by the next tick). */
  attack(): void {
    this.player.input.attackPresses++;
  }
  /** Queue one off-hand swap (the F key; carried out by the next tick). */
  swapHands(): void {
    this.player.input.swapPresses++;
  }

  /**
   * Hold nothing: select the first empty hotbar slot, or empty the selected one when the hotbar
   * is full (its stack is discarded). Useful before clicks that differ with a block in hand
   * (lighting a blast crate, sneak + right-click docking at a ship's helm).
   */
  emptyHand(): void {
    const p = this.player;
    const inv = p.inventory;
    let slot = inv.hotbar.findIndex((s) => s === null || s.count <= 0);
    if (slot < 0) {
      slot = inv.selected;
      inv.hotbar[slot] = null;
    }
    inv.selected = slot;
    p.input.slot = slot;
  }

  /** Put items into the inventory like a pickup does. Returns the amount that did not fit. */
  giveItem(item: number, count = 1): number {
    return this.player.inventory.add(item, count);
  }

  /**
   * Hold `item` in hand: a hotbar slot already holding it is selected; otherwise a stack of
   * `count` (default: a full stack) goes into the first empty hotbar slot, or replaces the
   * selected one when the hotbar is full.
   */
  hold(item: number, count: number = maxStackOf(item)): void {
    const p = this.player;
    const inv = p.inventory;
    let slot = inv.hotbar.findIndex((s) => s !== null && s.item === item);
    if (slot < 0) {
      slot = inv.hotbar.findIndex((s) => s === null);
      if (slot < 0) slot = inv.selected;
      inv.hotbar[slot] = { item, count: Math.max(1, Math.floor(count)) };
    }
    inv.selected = slot;
    p.input.slot = slot;
  }

  /** Move the player's feet to a world point: lets go of any helm or carrier, no velocity, no fall. */
  teleport(x: number, y: number, z: number): void {
    this.sim.entities.teleport(this.player, x, y, z);
  }

  // ------------------------------------------------------------------ drive (see DRIVE in the header)

  /** Who moves this player: 'server' (from its input) or 'client' (from its move reports). */
  get drive(): DriveMode {
    return this.sim.entities.driveOf(this.player);
  }
  /** Switch who moves this player (to 'client' raises a correction telling the client where it is). */
  setDrive(mode: DriveMode): void {
    this.sim.entities.setDrive(this.player, mode);
  }
  /** A move report from this player's client (checked and applied in the next tick; copied). */
  submitReport(report: MoveReport): void {
    this.sim.entities.submitReport(this.player, report);
  }
  /** The correction waiting for this player's client, or null (client-driven players only). */
  get correction(): Readonly<Correction> | null {
    return this.sim.entities.correctionOf(this.player);
  }
  /** Take the waiting correction (a copy) to send it; null when there is none. */
  takeCorrection(): Correction | null {
    return this.sim.entities.takeCorrection(this.player);
  }

  /**
   * The cell the player looks at right now with the held item's use ray (what a right-click acts
   * on: with a bucket in hand, liquid sources count), or null.
   */
  targetCell(): (GridCell & { face: Dir }) | null {
    this.requireOnline();
    const h = this.hands.raycast();
    return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
  }
  /** The cell a left-click would mine right now (liquid never counts), or null. */
  mineTargetCell(): (GridCell & { face: Dir }) | null {
    this.requireOnline();
    const h = this.hands.raycastMining();
    return h === null ? null : { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
  }

  /**
   * Aim at a cell (see lookAtCell), right-click once and run one tick (of the whole
   * simulation). Returns false — and clicks nothing — when that cell is not what the ray hits
   * (out of reach, hidden behind something), so a scripted scene fails loudly instead of
   * clicking the wrong block.
   */
  useOn(x: number, y: number, z: number, face?: Dir, gridId = 0): boolean {
    if (!this.aimAt(x, y, z, face, gridId)) return false;
    this.use();
    this.sim.tick();
    return true;
  }

  /**
   * Aim at a cell and hold the attack button until it is gone (survival mining takes the
   * block's hardness in seconds; creative breaks it at once), at most `maxTicks` ticks of the
   * whole simulation. Returns true when the cell was mined; false when it could not be aimed at
   * or did not break in time.
   */
  mine(x: number, y: number, z: number, face?: Dir, gridId = 0, maxTicks = 400): boolean {
    if (!this.aimAt(x, y, z, face, gridId, true)) return false;
    const input = this.player.input;
    const grid = this.sim.structures.gridById(gridId)!;
    const before = grid.getCell(x, y, z);
    this.attack();
    input.attack = true;
    try {
      for (let i = 0; i < maxTicks; i++) {
        this.sim.tick();
        const g = this.sim.structures.gridById(gridId);
        if (g === undefined || g.getCell(x, y, z) !== before) return true;
        // Keep aiming at the cell: a carrier may have turned the player.
        if (!this.aimAt(x, y, z, face, gridId, true)) return false;
      }
      return false;
    } finally {
      input.attack = false;
    }
  }

  /**
   * lookAtCell + check that the ray hits exactly that cell: the use ray of the held item, or the
   * mining ray (which never stops at liquid, even with a bucket in hand).
   */
  aimAt(x: number, y: number, z: number, face: Dir | undefined, gridId: number, mining = false): boolean {
    if (!this.lookAtCell(x, y, z, face, gridId)) return false;
    const h = mining ? this.hands.raycastMining() : this.hands.raycast();
    return h !== null && h.grid.gridId === gridId && h.x === x && h.y === y && h.z === z && (face === undefined || h.face === face);
  }
}
