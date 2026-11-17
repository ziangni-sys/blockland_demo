/**
 * EntityManager: the server's entity rules. It owns every entity (registry, spawning, saving)
 * and decides what happens to them: damage and death, vitals (air, drowning, lava), fall
 * damage, suffocation, squeezes, item pickup and merging, creature AI, falling blocks, blast
 * crates and their fuses, the helm seat, and the events. HOW a body moves — carrying, own
 * motion, collision, push-out, relocation, attaching — is the BodyMover's business (body.ts);
 * the manager runs one and acts on the facts each step reports.
 *
 * TICK CONTRACT. The simulation calls, every tick and in this order:
 *     [structures move]  ->  syncCarried()  ->  update()
 * syncCarried() begins the entity tick: it first snapshots every entity (pos / yaw / pitch ->
 * prev*). A simulation that wants the snapshot earlier may call beginTick() itself; the
 * snapshot is taken only once per tick either way. update() ends the tick (and runs
 * syncCarried() itself first if it was not called since the previous update()).
 * syncCarried() carries only the structure motion since the previous carry, so calling it
 * again in the same tick, or between two ticks (LESSONS 打开界面：把被携带的玩家同步到结构体
 * 当前位置), moves nobody twice and loses no motion.
 *
 * Re-entrancy: entities removed while the manager iterates (from an event listener, from
 * host.explode(), ...) stay in all() with removed = true until the iteration ends; iterate a
 * copy of all() if you add or remove entities while walking it outside the manager.
 *
 * Per entity, update() runs the body step (body.ts: controller, world collision, structure
 * push-out, squeeze, attach / detach), then the rules on its facts: a squeeze hurts (players by
 * their own mode) or flattens (rabbits, when the world harms creatures), a body stuck in world
 * blocks suffocates, a landing after a long fall hurts, a seated player pushed off its seat lets
 * go of the wheel.
 *
 * CLIENT-DRIVEN PLAYERS (drive.ts). A player whose client moves it is not carried or stepped by
 * the server (unless it sits at a helm: the seat is the server's; or it hangs in the air with
 * nothing holding it up and no valid reports: fallOnServer). Its move reports are checked
 * and applied in update(), in its place in the entity order; the server keeps the rules: vitals
 * from the fluids where the report puts it, falls on the reported track, squeezes judged with
 * hysteresis (judgeSqueeze), suffocation. Whenever the server moves such a player on its own
 * authority it raises a correction (raise()); corrections raised in a tick are settled at its end.
 *
 * Determinism: no Math.random / Date; randomness comes from host.rng only. All state is on
 * the instance (no module-level mutable state).
 */
import { TICK_DT } from '../core/constants';
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { aabb, vec3, type AABB, type Vec3 } from '../core/math';
import { ID_MASK } from '../blocks/cell';
import { isItem } from '../blocks/items';
import { BLOCKS, LIQUID, REPLACEABLE, SOLID } from '../blocks/registry';
import type { ByteReader, ByteWriter } from '../save/bytes';
import type { Ship, Structure } from '../structures/structure';
import { boxOverlapsSolid, hasSupportBelow } from '../voxel/shape';
import {
  CRUSH_DAMAGE,
  CRUSH_SEARCH_RADIUS,
  DROWN_DAMAGE,
  DROWN_INTERVAL_TICKS,
  FALL_SAFE_HEIGHT,
  FALLING_MAX_TICKS,
  FLY_SPEED,
  FLY_SPRINT_MULTIPLIER,
  GRAVITY,
  HURT_TICKS,
  ITEM_BUOYANCY,
  ITEM_DESPAWN_TICKS,
  ITEM_GRAVITY,
  ITEM_HEIGHT,
  JUMP_SPEED,
  LAND_EVENT_HEIGHT,
  LAVA_DAMAGE,
  LAVA_INTERVAL_TICKS,
  MERGE_INTERVAL_TICKS,
  MERGE_REACH,
  PICKUP_REACH_H,
  PREFER_MIN_SPEED,
  PICKUP_REACH_V,
  PLAYER_MAX_HEALTH,
  AIR_REFILL_PER_TICK,
  RABBIT_CRUSH_LIMIT,
  RABBIT_HOP_FORWARD,
  RABBIT_HOP_SPEED,
  RABBIT_MAX_DROP,
  RABBIT_SWIM_SPEED,
  REGEN_DELAY_TICKS,
  REGEN_INTERVAL_TICKS,
  REPORT_CREDIT_TICKS,
  REPORT_DEBT_TICKS,
  REPORT_MAX_LAG,
  REPORT_QUEUE_LIMIT,
  REPORT_SLACK_BURST,
  REPORT_SLACK_RATE,
  REPORT_STALL_TICKS,
  SPLASH_SPEED,
  SPRINT_SPEED,
  SQUEEZE_DEPTH,
  SQUEEZE_TICKS,
  SUPPORT_GAP,
  SWIM_UP_ACCEL,
  SWIMMING_WET,
  TNT_DEFAULT_FUSE,
  TNT_HOP_SPEED,
  TNT_POWER,
  UNSTUCK_SEARCH_RADIUS,
  VOID_Y,
  WATER_DRAG,
  WATER_SINK_ACCEL,
} from './constants';
import { BodyMover, sanitizeInput, takeJumpPresses, trackFall } from './body';
import { ClientDrive, ReportJudge, copyReport, emptyReport, hardDepth, type Correction, type DriveMode, type MoveReport } from './drive';
import { Entity, FallingBlockEntity, ItemEntity, Player, Rabbit, TntEntity, type EntityKind, type GameMode } from './entity';
import type { EntityHost } from './host';
import { axisValue } from './input';
import { maxStackOf } from './inventory';
import { attachInset, boxAt } from './physics';
import { headingOf, pointVelocity, type StructRec } from './structs';

const DT = TICK_DT;
/** Layout of the entity blob. Version 2: players are no longer part of it. */
const SAVE_VERSION = 2;
const KIND_TAG: Readonly<Record<EntityKind, number>> = Object.freeze({ player: 1, item: 2, falling: 3, tnt: 4, rabbit: 5 });
/** spawnItem() splits a count above the item's stack size into at most this many drops. */
const MAX_SPAWN_STACKS = 64;
/**
 * A client-driven player's checks remember a structure's motion near / through the body this long
 * (ticks): REPORT_MAX_LAG, the lead of the server's poses over the client's copies they allow for.
 */
const PUSH_MEMORY_TICKS = Math.ceil(REPORT_MAX_LAG / TICK_DT);
/** judgeSqueeze() results. */
const SQUEEZE_CLEAR = 0;
const SQUEEZE_HELD = 1;
const SQUEEZE_DONE = 2;

export class EntityManager {
  private readonly host: EntityHost;
  private readonly list: Entity[] = [];
  private readonly byId = new Map<number, Entity>();
  private nextId = 1;

  /** Moves the bodies (body.ts); the manager acts on what it reports. */
  private readonly body: BodyMover;
  /** Checks the move reports of client-driven players (drive.ts). */
  private readonly judge: ReportJudge;
  /** Client-driven players with a correction raised in the current tick (settled at its end). */
  private readonly unsettled: Player[] = [];
  /** Ticks completed by update() (staggers the item merge scan). */
  private tickCount = 0;
  private snapshotDone = false;
  /** syncCarried() ran since the last update() (update() runs it itself otherwise). */
  private carriedThisTick = false;
  /** > 0 while the manager walks `list`: remove() then only marks; endIteration() compacts. */
  private iterDepth = 0;
  private removedWhileIterating = false;
  private readonly pendingBlasts: TntEntity[] = [];

  // ---- scratch (instance-owned, never shared across modules)
  /** A creature's chosen velocity relative to its carrier. */
  private readonly aiRel: Vec3 = vec3();
  private readonly t1: Vec3 = vec3();
  private readonly t2: Vec3 = vec3();
  private readonly box1: AABB = aabb();
  private readonly box2: AABB = aabb();
  private readonly items: ItemEntity[] = [];
  /** pickups(): the live players, and those in reach of one drop. */
  private readonly pickers: Player[] = [];
  private readonly takers: Player[] = [];
  private readonly overlapNear: StructRec[] = [];

  constructor(host: EntityHost) {
    this.host = host;
    this.body = new BodyMover(host);
    this.judge = new ReportJudge(this.body, host.world);
  }

  // ================================================================== registry

  /** Every entity (removed ones disappear at the end of the tick at the latest). */
  all(): readonly Entity[] {
    return this.list;
  }
  get(id: number): Entity | undefined {
    return this.byId.get(id);
  }
  /** A fresh entity id (for entities built outside the spawn helpers). */
  allocateId(): number {
    return this.nextId++;
  }

  /**
   * Add an entity. The list stays in ascending id order (the update order): a new entity has the
   * largest id and goes last; an entity that comes back with an older id (a player rejoining
   * under its kept id, sim/players.ts) takes its old place — only outside an iteration, which an
   * insertion would disturb (it then goes last).
   */
  add<T extends Entity>(e: T): T {
    if (this.byId.has(e.id)) throw new Error(`duplicate entity id ${e.id}`);
    e.removed = false;
    e.snapshot();
    const list = this.list;
    if (list.length > 0 && list[list.length - 1]!.id > e.id && this.iterDepth === 0) {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.id < e.id) lo = mid + 1;
        else hi = mid;
      }
      list.splice(lo, 0, e);
    } else {
      list.push(e);
    }
    this.byId.set(e.id, e);
    if (e.id >= this.nextId) this.nextId = e.id + 1;
    return e;
  }

  remove(e: Entity): void {
    if (e.removed) return;
    e.removed = true;
    if (e instanceof Player) this.releaseHelm(e, 'removed');
    if (this.byId.get(e.id) === e) this.byId.delete(e.id);
    if (this.iterDepth > 0) {
      // Someone is walking the list (this manager, or a callback it invoked): splicing now
      // would make that loop skip the next entity. Compacted when the outermost walk ends.
      this.removedWhileIterating = true;
    } else {
      const i = this.list.indexOf(e);
      if (i >= 0) this.list.splice(i, 1);
    }
  }

  clear(): void {
    this.list.length = 0;
    this.byId.clear();
    this.nextId = 1;
    this.pendingBlasts.length = 0;
    this.unsettled.length = 0;
    this.snapshotDone = false;
    this.carriedThisTick = false;
    this.body.reset();
  }

  private beginIteration(): void {
    this.iterDepth++;
  }

  private endIteration(): void {
    if (--this.iterDepth > 0 || !this.removedWhileIterating) return;
    this.removedWhileIterating = false;
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!e.removed) list[w++] = e;
    }
    list.length = w;
  }

  // ================================================================== spawning

  /**
   * A new player with feet at (x, y, z); that is also its spawn point. Any number of players may
   * exist; which client drives which one is the simulation's business (sim/players.ts).
   */
  spawnPlayer(mode: GameMode, x: number, y: number, z: number): Player {
    const p = new Player(this.allocateId(), mode);
    p.setPosition(x, y, z);
    p.spawn.x = x;
    p.spawn.y = y;
    p.spawn.z = z;
    return this.add(p);
  }

  /**
   * An item drop whose box is CENTRED at (x, y, z). Without `vel` it gets a small random toss.
   * A count above the item's stack size is split into several full drops (all with the same
   * `vel`, or each with its own toss); the first one is returned.
   * Throws a RangeError for ids that are not items and for counts that are not finite or below 1
   * (a drop-table bug must not go unnoticed, nor create items from nothing / unsaveable stacks).
   */
  spawnItem(x: number, y: number, z: number, item: number, count: number, vel?: Vec3): ItemEntity {
    if (!isItem(item)) throw new RangeError(`spawnItem: ${item} is not an item id`);
    if (!Number.isFinite(count) || count < 1) throw new RangeError(`spawnItem: bad count ${count}`);
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new RangeError('spawnItem: position is not finite');
    const max = maxStackOf(item);
    let left = Math.floor(count);
    if (left > max * MAX_SPAWN_STACKS) throw new RangeError(`spawnItem: count ${count} exceeds ${MAX_SPAWN_STACKS} stacks`);
    let first: ItemEntity | null = null;
    while (left > 0) {
      const n = left < max ? left : max;
      left -= n;
      const e = this.spawnStack(x, y, z, item, n, vel);
      if (first === null) first = e;
    }
    return first!;
  }

  private spawnStack(x: number, y: number, z: number, item: number, count: number, vel: Vec3 | undefined): ItemEntity {
    const e = new ItemEntity(this.allocateId(), { item, count });
    e.setPosition(x, y - ITEM_HEIGHT * 0.5, z);
    if (vel !== undefined) {
      e.vel.x = vel.x;
      e.vel.y = vel.y;
      e.vel.z = vel.z;
    } else {
      const rng = this.host.rng;
      e.vel.x = rng.range(-1.2, 1.2);
      e.vel.y = 3;
      e.vel.z = rng.range(-1.2, 1.2);
    }
    e.yaw = this.host.rng.range(-Math.PI, Math.PI);
    e.prevYaw = e.yaw;
    return this.add(e);
  }

  /** A falling block starting in world cell (x, y, z) (the caller has already emptied that cell). */
  spawnFalling(x: number, y: number, z: number, cell: number): FallingBlockEntity {
    const e = new FallingBlockEntity(this.allocateId(), cell);
    e.setPosition(Math.floor(x) + 0.5, Math.floor(y), Math.floor(z) + 0.5);
    return this.add(e);
  }

  /** A primed blast crate starting in world cell (x, y, z); it hops up a little. */
  spawnTnt(x: number, y: number, z: number, fuse: number = TNT_DEFAULT_FUSE): TntEntity {
    const e = new TntEntity(this.allocateId(), Math.max(0, Math.floor(fuse)));
    e.setPosition(Math.floor(x) + 0.5, Math.floor(y), Math.floor(z) + 0.5);
    const a = this.host.rng.range(0, Math.PI * 2);
    e.vel.x = Math.cos(a) * 0.4;
    e.vel.z = Math.sin(a) * 0.4;
    e.vel.y = TNT_HOP_SPEED;
    return this.add(e);
  }

  /** A rabbit with feet at (x, y, z). */
  spawnRabbit(x: number, y: number, z: number): Rabbit {
    const e = new Rabbit(this.allocateId());
    e.setPosition(x, y, z);
    const rng = this.host.rng;
    e.yaw = rng.range(-Math.PI, Math.PI);
    e.prevYaw = e.yaw;
    e.wanderYaw = e.yaw;
    e.aiTimer = rng.int(10, 60);
    return this.add(e);
  }

  /**
   * Throw a stack from the player's eyes along the look direction (dropping the cursor stack,
   * the drop key). It cannot be picked up again for 2 seconds. Same argument checks as
   * spawnItem(); returns the first drop.
   */
  dropFromPlayer(player: Player, item: number, count: number): ItemEntity {
    const cp = Math.cos(player.pitch);
    const fx = -Math.sin(player.yaw) * cp;
    const fy = Math.sin(player.pitch);
    const fz = -Math.cos(player.yaw) * cp;
    const v = vec3(player.vel.x + fx * 6, player.vel.y + fy * 6 + 1.5, player.vel.z + fz * 6);
    const before = this.list.length;
    const e = this.spawnItem(player.pos.x, player.pos.y + player.eyeHeight - 0.3, player.pos.z, item, count, v);
    // every stack of a split drop (spawnItem appends them in order)
    for (let i = before; i < this.list.length; i++) {
      const d = this.list[i]!;
      if (d instanceof ItemEntity) d.pickupDelay = 40;
    }
    return e;
  }

  // ================================================================== tick

  /** Snapshot every entity for render interpolation. Idempotent within a tick (see the tick contract). */
  beginTick(): void {
    if (this.snapshotDone) return;
    this.snapshotDone = true;
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i]!.snapshot();
  }

  /**
   * Tick step 4 (after the structures moved): every carried entity follows its carrier —
   * position transformed from the carrier's previous pose to its current one, yaw turned by
   * the carrier's heading change — moving with world sweeps so a passing wall scrapes it off
   * instead of dragging it inside. Helmsmen follow their seat.
   */
  syncCarried(): void {
    this.beginTick();
    // Always re-read the poses: only the motion since the previous carry is carried (see the
    // tick contract), so a repeated call is harmless and a stale cache is never used.
    const body = this.body;
    body.beginCarry();
    this.carriedThisTick = true;
    const world = this.host.world;
    const list = this.list;
    this.beginIteration();
    try {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        e.carryBlocked = false;
        if (e.removed || !world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) continue;
        if (e instanceof Player && e.steeringShipId !== 0) this.syncSeat(e);
        else if (e.carrierId !== 0) this.carry(e);
      }
    } finally {
      this.endIteration();
    }
  }

  /** A rider follows its carrier — unless its client moves it (it rides its reference, update()). */
  private carry(e: Entity): void {
    if (e instanceof Player && e.remote !== null) return;
    this.body.carryRider(e);
  }

  /** Tick steps 5–6: own motion, collision, push, crush, attach / detach, pickups, fuses, AI. */
  update(): void {
    if (!this.carriedThisTick) this.syncCarried();
    const list = this.list;
    const n = list.length;
    const blasts = this.pendingBlasts;
    this.beginIteration();
    try {
      for (let i = 0; i < n; i++) {
        const e = list[i]!;
        if (!e.removed) this.updateEntity(e);
      }
      this.pickups();
      this.merges();
      // Still inside the iteration: the simulation's explosion walks all() and damages
      // (removes) entities; those removals must not shift the list under it.
      for (let i = 0; i < blasts.length; i++) {
        const t = blasts[i]!;
        this.host.explode(t.pos.x, t.pos.y + t.height * 0.5, t.pos.z, TNT_POWER, t);
      }
    } finally {
      blasts.length = 0;
      this.endIteration();
    }
    this.settleCorrections();
    this.body.endTick();
    this.tickCount++;
    this.snapshotDone = false;
    this.carriedThisTick = false;
  }

  // ================================================================== structures interface

  /**
   * Everything carried by `structure` (or by a structure mounted on it) lets go, and its
   * helmsman releases the wheel. Call before a structure blockifies / docks / dies / is re-gridded.
   */
  releaseRiders(structure: Structure): void {
    const body = this.body;
    body.beginRelease(structure);
    const list = this.list;
    this.beginIteration();
    try {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        if (e.removed) continue;
        if (e instanceof Player && e.steeringShipId !== 0 && body.isReleasing(e.steeringShipId)) this.releaseHelm(e, 'released');
        if (body.handOff(e) && e instanceof Player) this.raise(e, 'release');
      }
    } finally {
      this.endIteration();
    }
  }

  /**
   * Seat the player at a helm: feet on the floor of the cell behind the helm (helm cell minus
   * ship.forward), or where the player stands if that cell is blocked. Returns false when the
   * player is dead, the ship is gone or someone else holds the wheel.
   */
  startSteering(player: Player, ship: Ship, helmX: number, helmY: number, helmZ: number): boolean {
    if (player.dead || player.removed || ship.removed) return false;
    if (ship.helmsmanId !== 0 && ship.helmsmanId !== player.id) {
      const other = this.byId.get(ship.helmsmanId);
      if (other instanceof Player && !other.removed && other.steeringShipId === ship.id) return false;
    }
    if (player.steeringShipId !== 0 && player.steeringShipId !== ship.id) this.releaseHelm(player, 'switched');
    const g = ship.grid;
    const f = ship.forward;
    const sx = helmX - DIR_X[f]!;
    const sy = helmY - DIR_Y[f]!;
    const sz = helmZ - DIR_Z[f]!;
    const blocked = SOLID[g.getCell(sx, sy, sz) & ID_MASK] === 1 || SOLID[g.getCell(sx, sy + 1, sz) & ID_MASK] === 1;
    if (!blocked) {
      player.seat.x = sx + 0.5;
      player.seat.y = sy;
      player.seat.z = sz + 0.5;
    } else {
      g.toLocal(player.pos, player.seat);
    }
    player.steeringShipId = ship.id;
    player.flying = false;
    ship.helmsmanId = player.id;
    ship.helmX = helmX;
    ship.helmY = helmY;
    ship.helmZ = helmZ;
    // Sit down now; the seat follows the ship from the next syncCarried() on.
    this.body.sit(player, ship);
    this.raise(player, 'seat');
    return true;
  }

  /** Let go of the wheel (clears both sides, zeroes throttle and rudder). The player stays aboard as a rider. */
  stopSteering(player: Player): void {
    this.releaseHelm(player, 'stopped');
  }

  /** The helmsman follows its seat, as long as it may sit there (tick step 4). */
  private syncSeat(p: Player): void {
    const s = this.host.structure(p.steeringShipId);
    if (s === undefined || s.removed || s.kind !== 'ship') {
      this.releaseHelm(p, 'missing');
      if (p.carrierId !== 0) this.carry(p);
      return;
    }
    const ship = s as Ship;
    if (ship.helmsmanId !== p.id) {
      if (ship.helmsmanId === 0) ship.helmsmanId = p.id; // re-claim after loading a save
      else {
        this.releaseHelm(p, 'taken');
        if (p.carrierId !== 0) this.carry(p);
        return;
      }
    }
    const seat = this.body.followSeat(p);
    if (seat === 'lost') {
      this.releaseHelm(p, 'missing');
    } else if (seat === 'blocked') {
      // LESSONS 舵手穿过方块: a seat inside a world block releases the wheel; the rider then
      // follows the deck with world sweeps like anyone else and the push logic takes over.
      this.releaseHelm(p, 'blocked');
      this.carry(p);
    }
  }

  private releaseHelm(p: Player, cause: string): void {
    const id = p.steeringShipId;
    if (id === 0) return;
    p.steeringShipId = 0;
    const s = this.host.structure(id);
    if (s !== undefined && s.kind === 'ship') {
      const ship = s as Ship;
      if (ship.helmsmanId === p.id) {
        ship.helmsmanId = 0;
        ship.throttle = 0;
        ship.rudder = 0;
      }
    }
    this.raise(p, `unseat:${cause}`);
    this.host.emit({ type: 'helmReleased', entity: p, cause });
  }

  // ================================================================== health

  /** Damage: players in survival only (with HURT_TICKS invulnerability); rabbits die; item drops burn. */
  damage(e: Entity, amount: number, cause: string): void {
    if (e.removed || !(amount > 0)) return;
    if (e instanceof Player) {
      if (e.dead || e.mode === 'creative') return;
      if (e.hurtTicks > 0 && cause !== 'void') return;
      e.health -= amount;
      e.hurtTicks = HURT_TICKS;
      e.unhurtTicks = 0;
      this.host.emit({ type: 'hurt', entity: e, amount, cause });
      if (e.health <= 0) this.kill(e, cause);
    } else if (e instanceof Rabbit) {
      this.kill(e, cause);
    } else if (e instanceof ItemEntity) {
      // Structures never destroy drops (they only push them); explosions, lava and the void do.
      if (cause === 'crush') return;
      this.host.emit({ type: 'despawn', entity: e, cause });
      this.remove(e);
    }
  }

  /** Death: a player stays (dead = true, detached, wheel released) until respawn(); others are removed. */
  kill(e: Entity, cause: string): void {
    if (e instanceof Player) {
      if (e.dead || e.removed) return;
      e.dead = true;
      e.health = 0;
      this.releaseHelm(e, 'death');
      e.carrierId = 0;
      e.carrierVel.x = e.carrierVel.y = e.carrierVel.z = 0;
      e.vel.x = e.vel.y = e.vel.z = 0;
      e.flying = false;
      e.sprinting = false;
      e.fallDistance = 0;
      this.raise(e, 'death');
      this.host.emit({ type: 'death', entity: e, cause });
      return;
    }
    if (e.removed) return;
    this.host.emit({ type: e instanceof Rabbit ? 'death' : 'despawn', entity: e, cause });
    this.remove(e);
  }

  /** Back to the spawn point with full health and air. */
  respawn(player: Player): void {
    this.releaseHelm(player, 'respawn');
    player.dead = false;
    player.health = player.maxHealth;
    player.air = player.maxAir;
    player.hurtTicks = 0;
    player.drownTicks = 0;
    player.lavaTicks = 0;
    player.unhurtTicks = 0;
    player.fallDistance = 0;
    player.carrierId = 0;
    player.noAttachTicks = 0;
    player.noAttachStructureId = 0;
    player.carrierVel.x = player.carrierVel.y = player.carrierVel.z = 0;
    player.vel.x = player.vel.y = player.vel.z = 0;
    player.onGround = false;
    player.flying = false;
    player.setPosition(player.spawn.x, player.spawn.y, player.spawn.z);
    this.raise(player, 'respawn');
  }

  // ================================================================== commands that move a player

  /** Move a player's feet to a world point: lets go of any helm or carrier, no velocity, no fall. */
  teleport(p: Player, x: number, y: number, z: number): void {
    this.releaseHelm(p, 'stopped');
    p.carrierId = 0;
    p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.fallDistance = 0;
    p.setPosition(x, y, z);
    this.raise(p, 'teleport');
  }

  /** A blast's knock-back: adds to the body's velocity. */
  knock(e: Entity, dvx: number, dvy: number, dvz: number): void {
    e.vel.x += dvx;
    e.vel.y += dvy;
    e.vel.z += dvz;
    if (e instanceof Player && e.remote !== null) {
      e.remote.inherit += Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      this.raise(e, 'knock');
    }
  }

  /** A player's game mode (DESIGN: per player). Survival ends flight. */
  setMode(p: Player, mode: GameMode): void {
    p.mode = mode;
    if (mode === 'survival' && p.flying) {
      p.flying = false;
      this.raise(p, 'mode');
    }
  }

  // ================================================================== client-driven players (drive.ts)

  /** Who moves this player: the server ('server', from its input) or its client ('client', from move reports). */
  driveOf(p: Player): DriveMode {
    return p.remote === null ? 'server' : 'client';
  }

  /**
   * Switch who moves the player. To 'client': the server stops moving it and waits for move
   * reports of the epoch of the correction raised now ('drive'), which tells the client where the
   * player is. To 'server': the server moves it from its input again, from where it is.
   */
  setDrive(p: Player, mode: DriveMode): void {
    if (mode === this.driveOf(p)) return;
    if (mode === 'server') {
      p.remote = null;
      return;
    }
    p.remote = new ClientDrive();
    this.raise(p, 'drive');
  }

  /**
   * A move report of a client-driven player arrived: it is checked and applied in the next tick's
   * entity step (with any others that arrived meanwhile, oldest first). Copied; ignored for a
   * server-driven player. At most REPORT_QUEUE_LIMIT wait; the oldest are dropped.
   */
  submitReport(p: Player, rep: MoveReport): void {
    const d = p.remote;
    if (d === null) return;
    const q = d.queue;
    if (q.length >= REPORT_QUEUE_LIMIT) {
      d.spare.push(q.shift()!);
      d.dropped++;
    }
    q.push(copyReport(rep, d.spare.pop() ?? emptyReport()));
  }

  /** The correction waiting to be sent to a client-driven player's client, or null. */
  correctionOf(p: Player): Readonly<Correction> | null {
    const d = p.remote;
    return d !== null && d.pending ? d.correction : null;
  }

  /** Take (and clear) the waiting correction: a copy, or null. */
  takeCorrection(p: Player): Correction | null {
    const d = p.remote;
    if (d === null || !d.pending) return null;
    d.pending = false;
    // Taken: from now on it is what the client adopts, so it must not change any more.
    d.dirty = false;
    const c = d.correction;
    return { ...c, pos: { ...c.pos }, vel: { ...c.vel }, seat: { ...c.seat } };
  }

  /**
   * The server moved a client-driven player on its own authority (or refused a report: cause
   * 'check:<what>'): new epoch, correction pending.
   */
  private raise(p: Player, cause: string): void {
    const d = p.remote;
    if (d === null) return;
    d.epoch++;
    d.pending = true;
    d.correction.cause = cause;
    if (!d.dirty) {
      d.dirty = true;
      d.serverMoved = false;
      this.unsettled.push(p);
    }
    // A refused report leaves the reference where it was; anything else is a new state.
    if (!cause.startsWith('check:')) d.serverMoved = true;
    this.settle(p, d);
  }

  /** Write the player's present state into its correction and make it the reference of the next report. */
  private settle(p: Player, d: ClientDrive): void {
    const c = d.correction;
    c.epoch = d.epoch;
    this.judge.toReportFrame(p, c);
    if (c.carrierId === 0 && p.carrierId !== 0) {
      // The carrier has no record any more: the player stands in the world.
      p.carrierId = 0;
      p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
    }
    c.pitch = p.pitch;
    c.onGround = p.onGround;
    c.flying = p.flying;
    c.seatShipId = p.steeringShipId;
    c.seat.x = p.seat.x;
    c.seat.y = p.seat.y;
    c.seat.z = p.seat.z;
    d.carrierId = c.carrierId;
    d.pos.x = c.pos.x;
    d.pos.y = c.pos.y;
    d.pos.z = c.pos.z;
    d.vel.x = c.vel.x;
    d.vel.y = c.vel.y;
    d.vel.z = c.vel.z;
    d.yaw = c.yaw;
    d.pitch = c.pitch;
    d.onGround = c.onGround;
    d.flying = c.flying;
    d.fresh = true;
    d.idleTicks = 0;
    d.squeezeTicks = 0;
    if (d.serverMoved) {
      // The vertical envelope starts again at the new state: a jump when something holds the
      // body up, else no more upward speed than it has (a knock-back's included).
      const vy = p.vel.y - p.carrierVel.y;
      const up = Math.min(vy > 0 ? vy : 0, JUMP_SPEED + d.inherit);
      d.resetEnvelope(this.judge.heldUp(p) ? Math.max(up, JUMP_SPEED) : up);
    }
  }

  /** End of the tick: corrections raised in it take the state the tick left the player in. */
  private settleCorrections(): void {
    const list = this.unsettled;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      const d = p.remote;
      if (d === null || !d.dirty) continue;
      d.dirty = false;
      if (!p.removed) this.settle(p, d);
    }
    list.length = 0;
  }

  /** The player rides its reference: world position, velocity and look from the reference frames at the present poses. */
  private followReference(p: Player, d: ClientDrive): void {
    const yaw = this.judge.toWorld(d.carrierId, d.pos, d.vel, d.yaw, p.pos, p.carrierVel, p.vel);
    if (Number.isNaN(yaw)) {
      // The carrier vanished without releasing its riders: stay where the player was, in the world.
      d.carrierId = 0;
      d.pos.x = p.pos.x;
      d.pos.y = p.pos.y;
      d.pos.z = p.pos.z;
      d.vel.x = p.vel.x - p.carrierVel.x;
      d.vel.y = p.vel.y - p.carrierVel.y;
      d.vel.z = p.vel.z - p.carrierVel.z;
      d.yaw = p.yaw;
      p.carrierId = 0;
      p.carrierVel.x = p.carrierVel.y = p.carrierVel.z = 0;
      p.vel.x = d.vel.x;
      p.vel.y = d.vel.y;
      p.vel.z = d.vel.z;
      return;
    }
    p.carrierId = d.carrierId;
    p.yaw = yaw;
    p.pitch = d.pitch;
    p.input.yaw = yaw;
    p.input.pitch = d.pitch;
    p.onGround = d.onGround;
    // Standing on the world (never while carried): the world itself holds the reported feet.
    p.onWorldGround = d.carrierId === 0 && d.onGround && hasSupportBelow(this.host.world, p.box(this.box2), SUPPORT_GAP, 0);
  }

  /** Move reports of a seated client-driven player: only the stick axes, the sneak key and the look count. */
  private takeSeatedReports(p: Player, d: ClientDrive): void {
    const q = d.queue;
    const inp = p.input;
    for (let i = 0; i < q.length; i++) {
      const rep = q[i]!;
      if (rep.epoch !== d.epoch || !(rep.seq > d.lastSeq)) {
        d.dropped++;
        continue;
      }
      d.lastSeq = rep.seq;
      d.accepted++;
      inp.forward = axisValue(rep.forward);
      inp.strafe = axisValue(rep.strafe);
      inp.sneak = rep.sneak === true;
      const r = rep.carrierId !== 0 ? this.body.record(rep.carrierId) : undefined;
      if (Number.isFinite(rep.yaw)) inp.yaw = r !== undefined ? rep.yaw + headingOf(r.q1) : rep.yaw;
      if (Number.isFinite(rep.pitch)) inp.pitch = rep.pitch;
    }
    this.recycleReports(d);
    inp.jumpPresses = 0;
  }

  private recycleReports(d: ClientDrive): void {
    const q = d.queue;
    for (let i = 0; i < q.length; i++) d.spare.push(q[i]!);
    q.length = 0;
  }

  /**
   * A client-driven player's tick (not seated): check and apply its move reports, then the rules
   * the server keeps — vitals from the fluids where the reports put it, falls on the reported
   * track, squeezes (with hysteresis: see judgeSqueeze), suffocation. A body nothing holds up
   * whose reports stopped, or that rose above the vertical envelope, falls on the server's own
   * authority (takeover).
   */
  private updateClientDriven(p: Player, d: ClientDrive): void {
    const inp = p.input;
    const slot = Math.floor(inp.slot);
    if (slot >= 0 && slot < p.inventory.hotbar.length) p.inventory.selected = slot;
    if (p.mode !== 'creative' && p.flying) {
      p.flying = false;
      this.raise(p, 'mode');
    }
    // The client toggles flight itself (its reports say whether it flies).
    inp.jumpPresses = 0;
    if (p.dead) {
      p.vel.x = p.vel.y = p.vel.z = 0;
      d.dropped += d.queue.length;
      this.recycleReports(d);
      return;
    }
    if (p.hurtTicks > 0) p.hurtTicks--;
    p.unhurtTicks++;
    d.credit = Math.min(REPORT_CREDIT_TICKS, d.credit + 1);
    d.slack = Math.min(REPORT_SLACK_BURST, d.slack + REPORT_SLACK_RATE * DT);
    d.inherit *= 0.9;
    d.idleTicks++;
    // Ride along with the reference: no report may arrive in this tick.
    this.followReference(p, d);
    this.holdPush(p, d);
    const body = this.body;
    const judge = this.judge;
    let sampled = false;
    let landed = -1;
    let landedFromAir = false;
    let landedDry = false;
    const q = d.queue;
    for (let i = 0; i < q.length; i++) {
      const rep = q[i]!;
      if (rep.epoch !== d.epoch || !(rep.seq > d.lastSeq)) {
        d.dropped++;
        continue;
      }
      // Movement time: the client ticks the report claims, within what the server's clock grants.
      const gap = d.fresh ? 1 : rep.seq - d.lastSeq;
      const ticks = Math.max(0, Math.min(gap, d.credit + REPORT_DEBT_TICKS));
      const fail = judge.check(p, d, rep, ticks);
      if (fail !== null) {
        // The rest of the queue carries the old epoch: it is dropped below.
        d.rejected++;
        this.raise(p, `check:${fail}`);
        // Risen with nothing to lift it: the server lets it fall itself.
        if (fail === 'rise') d.takeover = true;
        continue;
      }
      d.accepted++;
      d.credit -= ticks;
      d.slack -= judge.slackUsed;
      d.lastSeq = rep.seq;
      d.fresh = false;
      d.idleTicks = 0;
      d.takeover = false;
      if (judge.switchSpeed > d.inherit) d.inherit = judge.switchSpeed;
      // Flight ended: the body keeps the flight's speed and loses it as any airborne body does.
      if (d.flying && !rep.flying) d.inherit = Math.max(d.inherit, FLY_SPEED * FLY_SPRINT_MULTIPLIER - SPRINT_SPEED);
      const y0 = p.pos.y;
      const wasOnGround = d.onGround;
      d.carrierId = rep.carrierId;
      d.pos.x = rep.pos.x;
      d.pos.y = rep.pos.y;
      d.pos.z = rep.pos.z;
      d.vel.x = rep.vel.x;
      d.vel.y = rep.vel.y;
      d.vel.z = rep.vel.z;
      d.yaw = rep.yaw;
      d.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rep.pitch));
      // On the ground only where something holds the feet up: a claim in mid-air keeps falling.
      d.onGround = judge.groundOk;
      d.flying = rep.flying === true;
      p.flying = d.flying;
      p.sneaking = rep.sneaking === true && !p.flying;
      p.sprinting = rep.sprinting === true && !p.sneaking;
      inp.forward = axisValue(rep.forward);
      inp.strafe = axisValue(rep.strafe);
      inp.sneak = rep.sneak === true;
      this.followReference(p, d);
      // Vitals where the report puts the body; the fall on the reported track (a fall that ends
      // on a moving deck counts from where it began: both ends at the server's present poses).
      body.sampleFluids(p);
      sampled = true;
      if (d.onGround || p.wet > 0 || p.inLava || p.flying) d.resetEnvelope(JUMP_SPEED);
      else {
        d.envRise += judge.dy;
        d.envTop = judge.envTop;
        d.envVy = judge.envVy;
      }
      const total = trackFall(p, y0 > p.pos.y ? y0 - p.pos.y : 0, false);
      // Several reports can arrive in one tick (jitter, coalescing): the landing report may be
      // followed by standing ones, whose "landings" of 0 must not hide it. The largest counts.
      if (total > landed) {
        landed = total;
        landedFromAir = !wasOnGround;
        landedDry = p.wet === 0 && !p.inLava;
      }
    }
    this.recycleReports(d);
    if (!sampled) body.sampleFluids(p);
    // Reports stopped while nothing holds the body up: it may not hang in the air.
    if (!d.takeover && d.idleTicks > REPORT_STALL_TICKS && !judge.heldUp(p)) d.takeover = true;
    if (d.takeover) {
      // (Its step reports a splash with the rest of its facts.)
      this.fallOnServer(p, d);
      return;
    }
    if (body.facts.liquidEntrySpeed > SPLASH_SPEED) this.host.emit({ type: 'splash', entity: p, amount: body.facts.liquidEntrySpeed });
    // A structure deep in the body is the squeeze rules' business: no free way out of world blocks then.
    if (this.judgeSqueeze(p, d) === SQUEEZE_CLEAR) this.judgeWorldStuck(p, d);
    if (p.removed || p.dead) return;
    if (landed >= 0) {
      if (landedFromAir && landed >= LAND_EVENT_HEIGHT) this.host.emit({ type: 'land', entity: p, amount: landed });
      if (landed > FALL_SAFE_HEIGHT && landedDry) this.damage(p, Math.ceil(landed - FALL_SAFE_HEIGHT), 'fall');
    }
    if (!p.dead) this.playerHealth(p);
  }

  /**
   * Remember, for REPORT_MAX_LAG, the fastest structure motion near a client-driven player and the
   * fastest speed of its carrier at it (ClientDrive.pushRecent, carrierRecent).
   */
  private holdPush(p: Player, d: ClientDrive): void {
    const cv = p.carrierVel;
    d.recordSpeeds(this.judge.structureSpeed(p, p.pos, p.carrierId, cv), Math.sqrt(cv.x * cv.x + cv.y * cv.y + cv.z * cv.z));
  }

  /**
   * The server moves a client-driven player itself, with no input, and applies the usual rules
   * (falls, squeezes, suffocation): a correction every tick it does, until something holds the
   * body up or a report of the current epoch is accepted (ClientDrive.takeover).
   */
  private fallOnServer(p: Player, d: ClientDrive): void {
    const inp = p.input;
    inp.forward = 0;
    inp.strafe = 0;
    inp.jump = false;
    inp.sneak = false;
    inp.sprint = false;
    // From a velocity the server can vouch for: the reported one is the client's word. No faster
    // than the movement limits allow, no more upward speed than the vertical envelope.
    const v = p.vel;
    const cv = p.carrierVel;
    const rx = v.x - cv.x;
    const rz = v.z - cv.z;
    const h = Math.sqrt(rx * rx + rz * rz);
    const hMax = SPRINT_SPEED + d.inherit;
    if (h > hMax) {
      v.x = cv.x + (rx * hMax) / h;
      v.z = cv.z + (rz * hMax) / h;
    }
    if (v.y - cv.y > d.envVy) v.y = cv.y + d.envVy;
    this.stepOnServer(p, 0, false);
    if (p.removed || p.dead) {
      d.takeover = false;
      return;
    }
    d.serverMoved = true;
    if (!d.dirty) this.raise(p, 'fall');
    if (p.onGround || p.wet > 0 || p.inLava) d.takeover = false;
    this.playerHealth(p);
  }

  /**
   * Squeeze judgement of a client-driven player. Its client pushes its body out of structures at
   * the poses of its LAGGING copies, so at the server's present poses the reported body often
   * overlaps a structure a little, briefly — that must not hurt. The server pushes a copy of the
   * reported body out at its present poses (the same push as for any body, body.ts pushOut): if
   * that clears it, the client will be pushed too, soon. A squeeze candidate is a body that a
   * structure overlaps by more than SQUEEZE_DEPTH and that neither the usual push nor one leaning
   * along the structure's recent motion can free without leaving it that deep in the structure or
   * pushing it that much deeper into world blocks (ReportJudge.ghostStuck); SQUEEZE_TICKS candidate
   * ticks in a row are a squeeze: the server moves the player to the nearest free spot (a
   * correction) and the squeeze rules apply (survival hurt, creative only moved).
   * Returns SQUEEZE_CLEAR (no structure overlaps the body), SQUEEZE_HELD (one does, by more than
   * SQUEEZE_DEPTH: being judged) or SQUEEZE_DONE (squeezed now).
   */
  private judgeSqueeze(p: Player, d: ClientDrive): number {
    const body = this.body;
    const judge = this.judge;
    const b = p.box(this.box1);
    const near = body.structuresNear(b, 0, this.overlapNear);
    let overlap = false;
    let deep = false;
    let fastest = PREFER_MIN_SPEED;
    const c = this.t1;
    c.x = p.pos.x;
    c.y = p.pos.y + p.height * 0.5;
    c.z = p.pos.z;
    if (d.pushDirTicks > 0) d.pushDirTicks--;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (!boxOverlapsSolid(r.grid, b)) continue;
      overlap = true;
      if (hardDepth(r.grid, b) > SQUEEZE_DEPTH) deep = true;
      if (r.id === p.carrierId) continue;
      // Remember which way it moves through the body, relative to the body's carrier.
      const v = pointVelocity(r, c, this.t2);
      const vx = v.x - p.carrierVel.x;
      const vy = v.y - p.carrierVel.y;
      const vz = v.z - p.carrierVel.z;
      const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (s > fastest) {
        fastest = s;
        d.pushDir.x = vx / s;
        d.pushDir.y = vy / s;
        d.pushDir.z = vz / s;
        d.pushDirTicks = PUSH_MEMORY_TICKS;
      }
    }
    if (!overlap) {
      d.squeezeTicks = d.deepRun = d.plainStuckRun = 0;
      return SQUEEZE_CLEAR;
    }
    d.overlapTicks++;
    if (deep) {
      d.deepOverlapTicks++;
      if (++d.deepRun > d.longestDeepRun) d.longestDeepRun = d.deepRun;
    } else d.deepRun = 0;
    // Two push-outs of a copy of the reported body: the usual one, and one leaning along the
    // structures' (recent) motion in the carrier's frame — the way the lagging client is pushed.
    const plain = deep && judge.ghostStuck(p, null);
    if (plain) {
      if (++d.plainStuckRun > d.longestPlainStuckRun) d.longestPlainStuckRun = d.plainStuckRun;
    } else d.plainStuckRun = 0;
    if (!plain || (d.pushDirTicks > 0 && !judge.ghostStuck(p, d.pushDir))) {
      d.squeezeTicks = 0;
      return deep ? SQUEEZE_HELD : SQUEEZE_CLEAR;
    }
    d.squeezeCandidateTicks++;
    d.squeezeTicks++;
    if (d.squeezeTicks > d.longestSqueezeRun) d.longestSqueezeRun = d.squeezeTicks;
    if (d.squeezeTicks < SQUEEZE_TICKS) return SQUEEZE_HELD;
    // Squeezed: out of it from where the push left the body (unless that is inside world blocks).
    if (judge.ghostEnd(this.t2)) {
      p.pos.x = this.t2.x;
      p.pos.y = this.t2.y;
      p.pos.z = this.t2.z;
    }
    body.unstick(p, CRUSH_SEARCH_RADIUS);
    p.vel.x = p.carrierVel.x;
    p.vel.y = p.carrierVel.y;
    p.vel.z = p.carrierVel.z;
    p.fallDistance = 0;
    this.raise(p, 'crush');
    this.crushed(p);
    return SQUEEZE_DONE;
  }

  /**
   * A client-driven player deeper in world blocks than lag explains (a block put into it): moved
   * to the nearest free spot (a correction), or suffocating when there is none.
   */
  private judgeWorldStuck(p: Player, d: ClientDrive): void {
    const tol = this.judge.worldTolerance(p.carrierId, p.carrierId !== 0 ? Math.max(this.judge.speedAt(p.carrierId, p.pos), d.carrierRecent) : 0);
    if (!(hardDepth(this.host.world, p.box(this.box1)) > tol)) {
      p.unstuckFails = 0;
      p.unstuckWait = 0;
      return;
    }
    if (this.body.unstick(p, UNSTUCK_SEARCH_RADIUS)) {
      p.vel.x = p.carrierVel.x;
      p.vel.y = p.carrierVel.y;
      p.vel.z = p.carrierVel.z;
      p.fallDistance = 0;
      this.raise(p, 'unstick');
    } else {
      this.damage(p, 1, 'suffocate');
    }
  }

  // ================================================================== save

  /**
   * Every entity except players (players are saved per PlayerKey by the simulation, with
   * writePlayerRecord). Never writes a value deserialize() would reject: an entity whose state is
   * not finite (or a drop that holds nothing) is left out — one broken entity must not make the
   * whole save unloadable.
   */
  serialize(w: ByteWriter): void {
    w.u8(SAVE_VERSION);
    w.varuint(this.nextId);
    let count = 0;
    for (const e of this.list) if (saveable(e)) count++;
    w.varuint(count);
    for (const e of this.list) {
      if (!saveable(e)) continue;
      w.u8(KIND_TAG[e.kind]);
      w.varuint(e.id);
      writeCommon(w, e, e.pos);
      if (e instanceof ItemEntity) {
        w.varuint(e.stack.item);
        w.varuint(uint(e.stack.count));
        w.varuint(uint(e.pickupDelay));
      } else if (e instanceof FallingBlockEntity) {
        w.u16(e.cell & 0xffff);
      } else if (e instanceof TntEntity) {
        w.varuint(uint(e.fuse));
      } else if (e instanceof Rabbit) {
        w.u8(Math.min(255, uint(e.crushCount)));
        w.u8(e.aiState === 'hop' ? 1 : 0);
        w.varint(int(e.aiTimer));
        w.varint(int(e.hopsLeft));
        w.varint(int(e.hopCooldown));
        w.f64(finiteOr(e.wanderYaw, 0));
      }
    }
  }

  /**
   * Replace every entity with the saved ones (players are not part of this blob: the players
   * that are in the manager are dropped too — the simulation loads and joins them separately).
   * Atomic: the whole blob is parsed first, so a corrupt or truncated one throws
   * (SaveFormatError) and leaves the current entities untouched.
   */
  deserialize(r: ByteReader): void {
    const v = r.u8();
    if (v !== SAVE_VERSION) r.fail(`unsupported entity save version ${v}`);
    const nextId = r.varuint();
    const count = r.count(8);
    const parsed: Entity[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const tag = r.u8();
      const id = r.varuint();
      if (id === 0) r.fail('entity id 0');
      if (seen.has(id)) r.fail(`duplicate entity id ${id}`);
      seen.add(id);
      const common = readCommon(r);
      let e: Entity;
      if (tag === KIND_TAG.item) {
        const item = r.varuint();
        const cnt = r.varuint();
        const it = new ItemEntity(id, { item, count: cnt });
        it.pickupDelay = r.varuint();
        if (!isItem(item) || cnt === 0) {
          // An item that no longer exists (or an empty drop): leave it out rather than fail the load.
          continue;
        }
        e = it;
      } else if (tag === KIND_TAG.falling) {
        e = new FallingBlockEntity(id, r.u16());
      } else if (tag === KIND_TAG.tnt) {
        e = new TntEntity(id, r.varuint());
      } else if (tag === KIND_TAG.rabbit) {
        const rb = new Rabbit(id);
        rb.crushCount = r.u8();
        rb.aiState = r.u8() === 1 ? 'hop' : 'idle';
        rb.aiTimer = r.varint();
        rb.hopsLeft = r.varint();
        rb.hopCooldown = r.varint();
        rb.wanderYaw = readFinite(r);
        e = rb;
      } else {
        r.fail(`unknown entity kind tag ${tag}`);
      }
      applyCommon(e, common);
      parsed.push(e);
    }
    this.clear();
    for (const e of parsed) this.add(e);
    if (nextId > this.nextId) this.nextId = nextId;
  }

  // ================================================================== per-entity update

  private updateEntity(e: Entity): void {
    const world = this.host.world;
    if (!world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) return; // frozen: never fall into the unknown
    this.body.beginStep(e);
    if (e.pos.y < VOID_Y) {
      this.fellOut(e);
      return;
    }
    if (e instanceof Player) this.updatePlayer(e);
    else if (e instanceof ItemEntity) this.updateItem(e);
    else if (e instanceof FallingBlockEntity) this.updateFalling(e);
    else if (e instanceof TntEntity) this.updateTnt(e);
    else if (e instanceof Rabbit) this.updateRabbit(e);
  }

  private fellOut(e: Entity): void {
    if (e instanceof Player) {
      if (e.mode === 'creative') this.respawn(e);
      else if (!e.dead) this.kill(e, 'void');
      return;
    }
    this.host.emit({ type: 'despawn', entity: e, cause: 'void' });
    this.remove(e);
  }

  /**
   * The rules every body step is followed by: 'splash' when a dry body hit the water fast, then
   * a squeeze (DESIGN 实体被挤: the body has already been moved to the nearest free spot).
   */
  private afterStep(e: Entity): void {
    const facts = this.body.facts;
    if (facts.liquidEntrySpeed > SPLASH_SPEED) this.host.emit({ type: 'splash', entity: e, amount: facts.liquidEntrySpeed });
    if (facts.crushedBy !== 0) this.crushed(e);
  }

  // ------------------------------------------------------------------ player

  private updatePlayer(p: Player): void {
    const d = p.remote;
    if (d !== null && p.steeringShipId === 0) {
      this.updateClientDriven(p, d);
      return;
    }
    if (d !== null) this.takeSeatedReports(p, d);
    sanitizeInput(p);
    const inp = p.input;
    const slot = Math.floor(inp.slot);
    if (slot >= 0 && slot < p.inventory.hotbar.length) p.inventory.selected = slot;
    if (p.mode !== 'creative') p.flying = false;
    const presses = takeJumpPresses(p);
    if (p.dead) {
      p.vel.x = p.vel.y = p.vel.z = 0;
      return;
    }
    if (p.hurtTicks > 0) p.hurtTicks--;
    p.unhurtTicks++;
    this.stepOnServer(p, presses, p.mode === 'creative');
    if (!p.removed && !p.dead) this.playerHealth(p);
  }

  /** The server moves a player itself (from its input) and applies the rules to the facts of the step. */
  private stepOnServer(p: Player, presses: number, mayFly: boolean): void {
    const body = this.body;
    body.stepPlayer(p, presses, mayFly);
    const facts = body.facts;
    // The seat is the server's even for a client-driven player: moving it off is a correction.
    if (p.remote !== null && facts.relocated) this.raise(p, facts.crushedBy !== 0 ? 'crush' : 'unstick');
    this.afterStep(p);
    // A body stuck in world blocks with no free spot nearby suffocates.
    if (facts.stuckInWorld) this.damage(p, 1, 'suffocate');
    if (p.removed || p.dead) return;
    if (facts.pushedOffSeat && p.steeringShipId !== 0) this.releaseHelm(p, 'pushed');
    if (facts.landedFall >= 0) {
      const total = facts.landedFall;
      if (facts.landedFromAir && total >= LAND_EVENT_HEIGHT) this.host.emit({ type: 'land', entity: p, amount: total });
      if (total > FALL_SAFE_HEIGHT) {
        // Fluids were sampled before this tick's move: a fast fall can enter shallow water and
        // hit its bottom in the same tick. Water at the landing spot always breaks the fall.
        body.resampleFluids(p);
        if (p.wet === 0 && !p.inLava) this.damage(p, Math.ceil(total - FALL_SAFE_HEIGHT), 'fall');
      }
    }
  }

  private playerHealth(p: Player): void {
    if (p.mode === 'creative') {
      p.air = p.maxAir;
      p.drownTicks = 0;
      p.lavaTicks = 0;
      return;
    }
    if (p.headWet) {
      if (p.air > 0) p.air--;
      if (p.air <= 0) {
        p.air = 0;
        if (++p.drownTicks >= DROWN_INTERVAL_TICKS) {
          p.drownTicks = 0;
          this.damage(p, DROWN_DAMAGE, 'drown');
        }
      }
    } else {
      p.air = Math.min(p.maxAir, p.air + AIR_REFILL_PER_TICK);
      p.drownTicks = 0;
    }
    if (p.dead) return;
    if (p.inLava) {
      if (p.lavaTicks++ % LAVA_INTERVAL_TICKS === 0) this.damage(p, LAVA_DAMAGE, 'lava');
    } else {
      p.lavaTicks = 0;
    }
    if (p.dead) return;
    if (p.health < p.maxHealth && p.unhurtTicks >= REGEN_DELAY_TICKS && (p.unhurtTicks - REGEN_DELAY_TICKS) % REGEN_INTERVAL_TICKS === 0) {
      p.health = Math.min(p.maxHealth, p.health + 1);
    }
  }

  // ------------------------------------------------------------------ passive bodies

  private updateItem(e: ItemEntity): void {
    if (e.pickupDelay > 0) e.pickupDelay--;
    if (e.age >= ITEM_DESPAWN_TICKS) {
      this.host.emit({ type: 'despawn', entity: e, cause: 'timeout' });
      this.remove(e);
      return;
    }
    const fluid = this.body.sampleFluids(e);
    if (e.inLava) {
      this.host.emit({ type: 'despawn', entity: e, cause: 'lava' });
      this.remove(e);
      return;
    }
    this.body.stepPassive(e, fluid, ITEM_GRAVITY, ITEM_BUOYANCY, false);
    this.afterStep(e);
  }

  private updateTnt(e: TntEntity): void {
    const fluid = this.body.sampleFluids(e);
    this.body.stepPassive(e, fluid, ITEM_GRAVITY, 0, false);
    this.afterStep(e);
    if (e.removed) return;
    if (--e.fuse <= 0) {
      e.fuse = 0;
      this.pendingBlasts.push(e);
      this.remove(e);
    }
  }

  private updateFalling(e: FallingBlockEntity): void {
    const fluid = this.body.sampleFluids(e);
    const y0 = e.pos.y;
    this.body.stepPassive(e, fluid, ITEM_GRAVITY, 0, true);
    this.afterStep(e);
    if (e.removed) return;
    if (e.pos.y < y0) e.fallDistance += y0 - e.pos.y;
    if (e.onWorldGround) this.landFalling(e);
    // LESSONS 沙子落到船上悬浮: landing on a structure always yields an item drop.
    else if (this.body.facts.groundStructureId !== 0 || e.carrierId !== 0) this.fallingToItem(e, 'structure');
    else if (e.age > FALLING_MAX_TICKS) this.fallingToItem(e, 'timeout');
  }

  private landFalling(e: FallingBlockEntity): void {
    const world = this.host.world;
    const x = Math.floor(e.pos.x);
    const y = Math.floor(e.pos.y + 0.5);
    const z = Math.floor(e.pos.z);
    const here = world.getCell(x, y, z);
    // A structure cell (or part of one) in the target cell wins: hard blocks may not be placed into structures.
    const ok = REPLACEABLE[here & ID_MASK] === 1 && !this.body.structureInCell(x, y, z);
    if (ok && world.setCell(x, y, z, e.cell)) {
      this.host.emit({ type: 'land', entity: e, amount: e.fallDistance });
      this.remove(e);
      return;
    }
    this.fallingToItem(e, 'blocked');
  }

  private fallingToItem(e: FallingBlockEntity, cause: string): void {
    const def = BLOCKS[e.cell & ID_MASK];
    this.host.emit({ type: 'land', entity: e, cause });
    this.remove(e);
    if (def === undefined || def.drop === null) return;
    const item = def.drop === undefined ? def.id : def.drop.item;
    const count = def.drop === undefined ? 1 : def.drop.count;
    if (!isItem(item) || count <= 0) return;
    this.spawnItem(e.pos.x, e.pos.y + e.height * 0.5, e.pos.z, item, count, vec3(0, 1, 0));
  }

  // ------------------------------------------------------------------ rabbits

  private updateRabbit(e: Rabbit): void {
    const rng = this.host.rng;
    const fluid = this.body.sampleFluids(e);
    if (e.inLava) {
      this.kill(e, 'lava');
      return;
    }
    const rel = this.aiRel;
    rel.x = e.vel.x - e.carrierVel.x;
    rel.y = e.vel.y - e.carrierVel.y;
    rel.z = e.vel.z - e.carrierVel.z;
    const dirx = -Math.sin(e.wanderYaw);
    const dirz = -Math.cos(e.wanderYaw);
    let vy0 = rel.y;
    let vy1: number;
    if (fluid > SWIMMING_WET && !e.onGround) {
      // Paddle along, bobbing at the surface.
      const w = Math.min(1, fluid);
      rel.x += (dirx * RABBIT_SWIM_SPEED - rel.x) * 0.2;
      rel.z += (dirz * RABBIT_SWIM_SPEED - rel.z) * 0.2;
      const ay = -GRAVITY * (1 - w) - WATER_SINK_ACCEL * w + (w > 0.4 ? SWIM_UP_ACCEL : 0);
      vy1 = (vy0 + ay * DT) * (1 + (WATER_DRAG - 1) * w);
      if (rng.chance(0.02)) e.wanderYaw += rng.range(-1.5, 1.5);
      e.aiState = 'hop';
      e.hopsLeft = Math.max(e.hopsLeft, 1);
    } else {
      if (e.onGround) {
        rel.x *= 0.5;
        rel.z *= 0.5;
      }
      if (e.aiState === 'idle') {
        if (--e.aiTimer <= 0) {
          e.aiState = 'hop';
          e.wanderYaw = rng.range(-Math.PI, Math.PI);
          e.hopsLeft = rng.int(2, 5);
          e.hopCooldown = 0;
        }
      } else if (e.onGround) {
        if (e.hopCooldown > 0) {
          e.hopCooldown--;
        } else if (e.hopsLeft <= 0) {
          e.aiState = 'idle';
          e.aiTimer = rng.int(20, 80);
        } else {
          e.hopsLeft--;
          if (this.rabbitCanHop(e, dirx, dirz)) {
            vy0 = RABBIT_HOP_SPEED;
            rel.x = dirx * RABBIT_HOP_FORWARD;
            rel.z = dirz * RABBIT_HOP_FORWARD;
            e.hopCooldown = rng.int(2, 6);
          } else {
            // A cliff or water ahead: turn away and think again.
            e.wanderYaw += Math.PI * rng.range(0.5, 1.5);
            e.hopCooldown = 4;
          }
        }
      }
      vy1 = vy0 - GRAVITY * DT;
    }
    if (vy1 < -60) vy1 = -60;
    const dx = rel.x * DT;
    const dz = rel.z * DT;
    const dy = (vy0 + vy1) * 0.5 * DT;
    rel.y = vy1;
    // Face where it is going.
    let turn = e.wanderYaw - e.yaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    e.yaw += turn * 0.35;
    this.body.stepWalker(e, rel, dx, dy, dz);
    this.afterStep(e);
  }

  /**
   * Is the spot one hop ahead safe: supported within RABBIT_MAX_DROP and not water / lava?
   * A structure floor under the spot (a raft, a deck) is safe ground whatever lies under it:
   * the world's water below a floating ship must not keep its rabbits from ever hopping.
   */
  private rabbitCanHop(e: Rabbit, dirx: number, dirz: number): boolean {
    const tx = e.pos.x + dirx * 1.1;
    const tz = e.pos.z + dirz * 1.1;
    // Probe from just above a 1-block step down to RABBIT_MAX_DROP below the current feet.
    const b = boxAt(e, tx, e.pos.y + 1.05, tz, this.box1);
    const depth = RABBIT_MAX_DROP + 1.05;
    const inset = attachInset(e);
    const reach = this.t1;
    reach.x = dirx * 1.2;
    reach.y = -RABBIT_MAX_DROP;
    reach.z = dirz * 1.2;
    if (this.body.structureSupports(e, reach, b, depth, inset)) return true;
    const world = this.host.world;
    const fx = Math.floor(tx);
    const fz = Math.floor(tz);
    const fy = Math.floor(e.pos.y + 0.1);
    if (LIQUID[world.getCell(fx, fy, fz) & ID_MASK] !== 0 || LIQUID[world.getCell(fx, fy - 1, fz) & ID_MASK] !== 0) return false;
    return hasSupportBelow(world, b, depth, inset);
  }

  // ------------------------------------------------------------------ crush

  /**
   * DESIGN 实体被挤: the body has already been moved to the nearest free spot. Players take
   * damage in survival (their own mode; HURT_TICKS of invulnerability), rabbits are flattened at
   * the third squeeze when the world harms creatures (host.harmsCreatures: a survival world),
   * item drops / falling blocks / crates are only moved.
   */
  private crushed(e: Entity): void {
    this.host.emit({ type: 'crush', entity: e, cause: 'structure' });
    if (e instanceof Player) {
      this.damage(e, CRUSH_DAMAGE, 'crush');
    } else if (e instanceof Rabbit && this.host.harmsCreatures) {
      e.crushCount++;
      if (e.crushCount >= RABBIT_CRUSH_LIMIT) this.kill(e, 'crush');
    }
  }

  // ------------------------------------------------------------------ pickups and merging

  /**
   * Every live player collects the drops within its pickup reach. A drop several players can
   * reach goes to the nearest one (distance from the drop to the player's feet; a tie goes to the
   * lower entity id); what does not fit into that player's inventory is offered to the next
   * nearest, and so on. Players are considered in ascending id order, so the outcome depends only
   * on positions and inventories (and on ids for exact ties).
   */
  private pickups(): void {
    const world = this.host.world;
    const players = this.pickers;
    players.length = 0;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!(e instanceof Player) || e.removed || e.dead) continue;
      if (!world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) continue;
      players.push(e);
    }
    if (players.length === 0) return;
    players.sort((a, b) => a.id - b.id);
    const reach = this.box2;
    const takers = this.takers;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!(e instanceof ItemEntity) || e.removed || e.pickupDelay > 0) continue;
      // A drop in an unloaded chunk is frozen: it does nothing, not even get picked up.
      if (!world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) continue;
      const b = e.box(this.box1);
      takers.length = 0;
      for (let j = 0; j < players.length; j++) {
        const p = players[j]!;
        p.box(reach);
        if (
          b.minX >= reach.maxX + PICKUP_REACH_H ||
          b.maxX <= reach.minX - PICKUP_REACH_H ||
          b.minY >= reach.maxY + PICKUP_REACH_V ||
          b.maxY <= reach.minY - PICKUP_REACH_V ||
          b.minZ >= reach.maxZ + PICKUP_REACH_H ||
          b.maxZ <= reach.minZ - PICKUP_REACH_H
        ) {
          continue;
        }
        takers.push(p);
      }
      if (takers.length === 0) continue;
      if (takers.length > 1) {
        const ex = e.pos.x;
        const ey = e.pos.y;
        const ez = e.pos.z;
        const d2 = (p: Player): number => (p.pos.x - ex) ** 2 + (p.pos.y - ey) ** 2 + (p.pos.z - ez) ** 2;
        // Stable sort on an id-ordered list: equal distances keep the lower id first.
        takers.sort((a, c) => d2(a) - d2(c));
      }
      for (let j = 0; j < takers.length && e.stack.count > 0; j++) {
        const p = takers[j]!;
        const left = p.inventory.add(e.stack.item, e.stack.count);
        const taken = e.stack.count - left;
        if (taken <= 0) continue;
        e.stack.count = left;
        this.host.emit({ type: 'pickup', entity: e, amount: taken, player: p });
      }
      if (e.stack.count <= 0) this.remove(e);
    }
  }

  /**
   * Identical drops close to each other merge. Each drop looks around every
   * MERGE_INTERVAL_TICKS, staggered by id and phased by the manager's tick counter (not by the
   * drop's age: a frozen drop does not age and would otherwise be due every tick). Only drops
   * in loaded chunks take part (frozen ones do nothing). The drops are sorted by x so a due one
   * only scans its neighbours along x: O(n log n) instead of O(n^2) per tick.
   */
  private merges(): void {
    const items = this.items;
    items.length = 0;
    const world = this.host.world;
    const phase = this.tickCount;
    let due = false;
    let maxHalf = 0;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!(e instanceof ItemEntity) || e.removed) continue;
      if (!world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) continue;
      items.push(e);
      if (e.halfWidth > maxHalf) maxHalf = e.halfWidth;
      if ((phase + e.id) % MERGE_INTERVAL_TICKS === 0) due = true;
    }
    if (!due || items.length < 2) return;
    items.sort(byPosX);
    const ba = this.box1;
    const bb = this.box2;
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      if (a.removed || (phase + a.id) % MERGE_INTERVAL_TICKS !== 0) continue;
      const max = maxStackOf(a.stack.item);
      if (a.stack.count >= max) continue;
      a.box(ba);
      // Boxes within MERGE_REACH of each other have centres at most this far apart along x.
      const reachX = a.halfWidth + maxHalf + MERGE_REACH;
      for (let dir = -1; dir <= 1 && !a.removed; dir += 2) {
        for (let j = i + dir; j >= 0 && j < items.length; j += dir) {
          const b = items[j]!;
          if (Math.abs(b.pos.x - a.pos.x) > reachX) break;
          if (b.removed || b.stack.item !== a.stack.item) continue;
          b.box(bb);
          if (bb.minX - MERGE_REACH >= ba.maxX || bb.maxX + MERGE_REACH <= ba.minX) continue;
          if (bb.minY - MERGE_REACH >= ba.maxY || bb.maxY + MERGE_REACH <= ba.minY) continue;
          if (bb.minZ - MERGE_REACH >= ba.maxZ || bb.maxZ + MERGE_REACH <= ba.minZ) continue;
          // The bigger stack (ties: the older entity) absorbs the other.
          const into = a.stack.count > b.stack.count || (a.stack.count === b.stack.count && a.id < b.id) ? a : b;
          const from = into === a ? b : a;
          const moved = Math.min(from.stack.count, max - into.stack.count);
          if (moved <= 0) continue;
          into.stack.count += moved;
          from.stack.count -= moved;
          into.age = Math.min(into.age, from.age);
          into.pickupDelay = Math.max(into.pickupDelay, from.pickupDelay);
          if (from.stack.count <= 0) {
            this.host.emit({ type: 'despawn', entity: from, cause: 'merged' });
            this.remove(from);
          }
          if (a.removed) break;
          a.box(ba);
        }
      }
    }
  }
}

/** Sort order of the merge sweep (deterministic: ties by id). */
function byPosX(a: Entity, b: Entity): number {
  return a.pos.x - b.pos.x || a.id - b.id;
}

// ====================================================================== helpers

/** A tick counter as a non-negative integer (save fields are integers even if a caller set a fraction). */
function uint(v: number): number {
  return v > 0 ? (v < Number.MAX_SAFE_INTEGER ? Math.floor(v) : Number.MAX_SAFE_INTEGER) : 0;
}
function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
/** Written in place of a non-finite vector. Immutable. */
const ORIGIN: Readonly<Vec3> = Object.freeze(vec3(0, 0, 0));

/** Does serialize() write this entity? (see serialize) */
function saveable(e: Entity): boolean {
  if (e.removed || e instanceof Player) return false;
  if (!finiteVec(e.pos)) return false;
  if (e instanceof ItemEntity) return isItem(e.stack.item) && Number.isFinite(e.stack.count) && e.stack.count >= 1;
  return true;
}
function int(v: number): number {
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

function writeVec(w: ByteWriter, v: Vec3): void {
  w.f64(v.x);
  w.f64(v.y);
  w.f64(v.z);
}
/** A saved float that must be finite (a NaN position would poison every query it reaches). */
function readFinite(r: ByteReader): number {
  const v = r.f64();
  if (!Number.isFinite(v)) r.fail(`non-finite value in an entity record`);
  return v;
}
function readVec(r: ByteReader): Vec3 {
  return vec3(readFinite(r), readFinite(r), readFinite(r));
}
function copyVec(out: Vec3, v: Vec3): void {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
}

// ====================================================================== records

/** The fields every saved entity has, as read back (all finite). */
interface CommonFields {
  pos: Vec3;
  vel: Vec3;
  cvel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  wet: number;
  headWet: boolean;
  inLava: boolean;
  carrierId: number;
  noAttachTicks: number;
  noAttachStructureId: number;
  age: number;
  fallDistance: number;
  cnx: number;
  cnz: number;
  onWorldGround: boolean;
}

/** The common fields of an entity; `pos` is written in place of e.pos (a player with a broken position writes its spawn). */
function writeCommon(w: ByteWriter, e: Entity, pos: Vec3): void {
  writeVec(w, pos);
  writeVec(w, finiteVec(e.vel) ? e.vel : ORIGIN);
  writeVec(w, finiteVec(e.carrierVel) ? e.carrierVel : ORIGIN);
  w.f64(finiteOr(e.yaw, 0));
  w.f64(finiteOr(e.pitch, 0));
  w.bool(e.onGround);
  w.f64(finiteOr(e.wet, 0));
  w.bool(e.headWet);
  w.bool(e.inLava);
  w.varuint(uint(e.carrierId));
  w.varuint(uint(e.noAttachTicks));
  w.varuint(uint(e.noAttachStructureId));
  w.varuint(uint(e.age));
  w.f64(finiteOr(e.fallDistance, 0));
  w.f64(finiteOr(e.contactNx, 0));
  w.f64(finiteOr(e.contactNz, 0));
  w.bool(e.onWorldGround);
}

function readCommon(r: ByteReader): CommonFields {
  return {
    pos: readVec(r),
    vel: readVec(r),
    cvel: readVec(r),
    yaw: readFinite(r),
    pitch: readFinite(r),
    onGround: r.bool(),
    wet: readFinite(r),
    headWet: r.bool(),
    inLava: r.bool(),
    carrierId: r.varuint(),
    noAttachTicks: r.varuint(),
    noAttachStructureId: r.varuint(),
    age: r.varuint(),
    fallDistance: readFinite(r),
    cnx: readFinite(r),
    cnz: readFinite(r),
    onWorldGround: r.bool(),
  };
}

function applyCommon(e: Entity, c: CommonFields): void {
  copyVec(e.pos, c.pos);
  copyVec(e.vel, c.vel);
  copyVec(e.carrierVel, c.cvel);
  e.yaw = c.yaw;
  e.pitch = c.pitch;
  e.onGround = c.onGround;
  e.wet = c.wet;
  e.headWet = c.headWet;
  e.inLava = c.inLava;
  e.carrierId = c.carrierId;
  e.noAttachTicks = c.noAttachTicks;
  e.noAttachStructureId = c.noAttachStructureId;
  e.age = c.age;
  e.fallDistance = c.fallDistance;
  e.contactNx = c.cnx;
  e.contactNz = c.cnz;
  e.onWorldGround = c.onWorldGround;
  e.snapshot();
}

/** Layout version of a player record (writePlayerRecord). Only this version is read. */
const PLAYER_RECORD_VERSION = 1;

/**
 * Everything a player keeps between sessions: position and motion, look, carrier and seat,
 * mode, health, air, death, flight, spawn point, the selected slot and the whole inventory
 * (hotbar, backpack, off-hand, cursor), and the timers that go with them (hurt flash, breath and
 * lava timers, regeneration, the double-tap-to-fly timer). Not part of it: the entity id (the
 * caller keeps it next to the record) and the input, except the selected slot. Never writes a value readPlayerRecord would reject (non-finite fields become safe defaults).
 */
export function writePlayerRecord(w: ByteWriter, p: Player): void {
  w.u8(PLAYER_RECORD_VERSION);
  writeCommon(w, p, finiteVec(p.pos) ? p.pos : finiteVec(p.spawn) ? p.spawn : ORIGIN);
  w.u8(p.mode === 'creative' ? 1 : 0);
  w.f64(finiteOr(p.health, p.maxHealth));
  w.f64(finiteOr(p.maxHealth, PLAYER_MAX_HEALTH));
  w.varuint(uint(p.air));
  w.varuint(uint(p.maxAir));
  w.bool(p.dead);
  w.varuint(uint(p.hurtTicks));
  w.bool(p.flying);
  w.bool(p.sneaking);
  w.bool(p.sprinting);
  w.varuint(uint(p.steeringShipId));
  writeVec(w, finiteVec(p.seat) ? p.seat : ORIGIN);
  writeVec(w, finiteVec(p.spawn) ? p.spawn : ORIGIN);
  w.varuint(uint(p.drownTicks));
  w.varuint(uint(p.lavaTicks));
  w.varuint(Math.min(uint(p.unhurtTicks), 1 << 30));
  w.varint(Math.max(-(1 << 30), int(p.lastJumpPressAge)));
  p.inventory.serialize(w);
}

/**
 * A player entity with id `id` from a record written by writePlayerRecord. Throws
 * SaveFormatError on a corrupt or truncated record.
 */
export function readPlayerRecord(r: ByteReader, id: number): Player {
  const v = r.u8();
  if (v !== PLAYER_RECORD_VERSION) r.fail(`unsupported player record version ${v}`);
  const common = readCommon(r);
  const mode: GameMode = r.u8() === 1 ? 'creative' : 'survival';
  const p = new Player(id, mode);
  p.health = readFinite(r);
  p.maxHealth = readFinite(r);
  p.air = r.varuint();
  p.maxAir = r.varuint();
  p.dead = r.bool();
  p.hurtTicks = r.varuint();
  p.flying = r.bool();
  p.sneaking = r.bool();
  p.sprinting = r.bool();
  p.steeringShipId = r.varuint();
  copyVec(p.seat, readVec(r));
  copyVec(p.spawn, readVec(r));
  p.drownTicks = r.varuint();
  p.lavaTicks = r.varuint();
  p.unhurtTicks = r.varuint();
  p.lastJumpPressAge = r.varint();
  p.inventory.deserialize(r);
  p.input.slot = p.inventory.selected;
  applyCommon(p, common);
  // The look is driven by input.yaw / pitch: seed it, or the first tick after joining would snap
  // the view to 0 until the client writes its own.
  p.input.yaw = p.yaw;
  p.input.pitch = p.pitch;
  return p;
}
