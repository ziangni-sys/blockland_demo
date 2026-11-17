/**
 * EntityManager: owns every entity and moves them through the world and on / around
 * structures — collision, being carried, being pushed, being crushed — plus health, item
 * pickup, falling blocks, blast crates and rabbit AI.
 *
 * TICK CONTRACT. The simulation calls, every tick and in this order:
 *     [structures move]  ->  syncCarried()  ->  update()
 * syncCarried() begins the entity tick: it first snapshots every entity (pos / yaw / pitch ->
 * prev*). A simulation that wants the snapshot earlier may call beginTick() itself; the
 * snapshot is taken only once per tick either way. update() ends the tick.
 *
 * Per entity, update() runs (docs/LESSONS.md 携带与实体: the ORDER matters):
 *   a. controller: input / AI / nothing -> own velocity relative to the carrier
 *   b. world collision: exact axis sweeps of the own displacement (never into world blocks)
 *   c. structure collision: SAT push-out, axis by axis, sub-stepped against tunnelling
 *   d. crush: a structure still overlaps the body -> damage + nearest free spot
 *   e. attach / detach: carried only while a carrier cell is under the feet
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
import type { VoxelGrid } from '../voxel/grid';
import { boxOverlapsSolid, columnHasSolidBelow, hasSupportBelow, nearestFreeOffset, sweepAxis } from '../voxel/shape';
import {
  COLUMN_DEPTH,
  CRUSH_DAMAGE,
  CRUSH_SEARCH_RADIUS,
  DROWN_DAMAGE,
  DROWN_INTERVAL_TICKS,
  FALL_SAFE_HEIGHT,
  FALLING_MAX_TICKS,
  FLY_TOGGLE_TICKS,
  GRAVITY,
  HURT_TICKS,
  ITEM_BUOYANCY,
  ITEM_DESPAWN_TICKS,
  ITEM_GRAVITY,
  ITEM_HEIGHT,
  LAND_EVENT_HEIGHT,
  LAVA_DAMAGE,
  LAVA_INTERVAL_TICKS,
  MAX_INHERITED_SPEED,
  MERGE_INTERVAL_TICKS,
  MERGE_REACH,
  NO_ATTACH_TICKS,
  PICKUP_REACH_H,
  PICKUP_REACH_V,
  AIR_REFILL_PER_TICK,
  RABBIT_CRUSH_LIMIT,
  RABBIT_HOP_FORWARD,
  RABBIT_HOP_SPEED,
  RABBIT_MAX_DROP,
  RABBIT_SWIM_SPEED,
  REGEN_DELAY_TICKS,
  REGEN_INTERVAL_TICKS,
  SPLASH_SPEED,
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
import { Entity, FallingBlockEntity, ItemEntity, Player, Rabbit, TntEntity, type EntityKind, type GameMode } from './entity';
import { FluidSampler } from './fluids';
import type { EntityHost } from './host';
import { axisValue, finiteAngle } from './input';
import { maxStackOf } from './inventory';
import { passiveMotion, playerMotion } from './motion';
import { Mover, attachInset, boxAt } from './physics';
import { StructureCache, boxNearRec, carryPoint, curToWorld, pointVelocity, type StructRec } from './structs';

const DT = TICK_DT;
const SAVE_VERSION = 1;
const KIND_TAG: Readonly<Record<EntityKind, number>> = Object.freeze({ player: 1, item: 2, falling: 3, tnt: 4, rabbit: 5 });
/** Margin around a body when collecting the structures it may touch this tick. */
const NEAR_MARGIN = 0.5;
/** A carrier that moves a rider farther than this in one tick was re-gridded / teleported: let go. */
const MAX_CARRY_STEP = 4;

export class EntityManager {
  private readonly host: EntityHost;
  private readonly list: Entity[] = [];
  private readonly byId = new Map<number, Entity>();
  private nextId = 1;
  private localPlayer: Player | null = null;

  private readonly cache = new StructureCache();
  private readonly mover: Mover;
  private readonly fluids: FluidSampler;
  /** Ticks completed by update(); keys the per-tick structure cache. */
  private tickCount = 0;
  private cacheTick = -1;
  private snapshotDone = false;
  private iterating = false;
  private readonly pendingBlasts: TntEntity[] = [];

  // ---- scratch (instance-owned, never shared across modules)
  /** Own velocity relative to the carrier of the entity being updated. */
  private readonly rel: Vec3 = vec3();
  private readonly disp: Vec3 = vec3();
  private readonly wish: Vec3 = vec3();
  private readonly t1: Vec3 = vec3();
  private readonly t2: Vec3 = vec3();
  private readonly box1: AABB = aabb();
  private readonly box2: AABB = aabb();
  private readonly grids: VoxelGrid[] = [];
  private readonly items: ItemEntity[] = [];
  /** Vertical distance the last moveBody() teleported the body (crush / unstuck): not a fall. */
  private relocatedDy = 0;

  constructor(host: EntityHost) {
    this.host = host;
    this.mover = new Mover(host.world);
    this.fluids = new FluidSampler(host.world);
  }

  // ================================================================== registry

  /** Every entity (removed ones disappear at the end of the tick at the latest). */
  all(): readonly Entity[] {
    return this.list;
  }
  get(id: number): Entity | undefined {
    return this.byId.get(id);
  }
  /** The (single) local player. */
  get player(): Player | null {
    return this.localPlayer;
  }
  /** A fresh entity id (for entities built outside the spawn helpers). */
  allocateId(): number {
    return this.nextId++;
  }

  add<T extends Entity>(e: T): T {
    if (this.byId.has(e.id)) throw new Error(`duplicate entity id ${e.id}`);
    e.removed = false;
    e.snapshot();
    this.list.push(e);
    this.byId.set(e.id, e);
    if (e.id >= this.nextId) this.nextId = e.id + 1;
    if (e instanceof Player && this.localPlayer === null) this.localPlayer = e;
    return e;
  }

  remove(e: Entity): void {
    if (e.removed) return;
    e.removed = true;
    if (e instanceof Player) {
      this.releaseHelm(e, 'removed');
      if (this.localPlayer === e) this.localPlayer = null;
    }
    if (this.byId.get(e.id) === e) this.byId.delete(e.id);
    if (!this.iterating) {
      const i = this.list.indexOf(e);
      if (i >= 0) this.list.splice(i, 1);
    }
  }

  clear(): void {
    this.list.length = 0;
    this.byId.clear();
    this.nextId = 1;
    this.localPlayer = null;
    this.pendingBlasts.length = 0;
    this.snapshotDone = false;
    this.cacheTick = -1;
    this.cache.reset();
  }

  // ================================================================== spawning

  /** A new local player with feet at (x, y, z); that is also its spawn point. Replaces an existing local player. */
  createPlayer(mode: GameMode, x: number, y: number, z: number): Player {
    if (this.localPlayer !== null) this.remove(this.localPlayer);
    const p = new Player(this.allocateId(), mode);
    p.setPosition(x, y, z);
    p.spawn.x = x;
    p.spawn.y = y;
    p.spawn.z = z;
    this.add(p);
    this.localPlayer = p;
    return p;
  }

  /**
   * An item drop whose box is CENTRED at (x, y, z). Without `vel` it gets a small random toss.
   * Throws for ids that are not items (a drop table bug must not go unnoticed).
   */
  spawnItem(x: number, y: number, z: number, item: number, count: number, vel?: Vec3): ItemEntity {
    if (!isItem(item)) throw new RangeError(`spawnItem: ${item} is not an item id`);
    const e = new ItemEntity(this.allocateId(), { item, count: Math.max(1, Math.floor(count)) });
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
   * the drop key). It cannot be picked up again for 2 seconds.
   */
  dropFromPlayer(player: Player, item: number, count: number): ItemEntity {
    const cp = Math.cos(player.pitch);
    const fx = -Math.sin(player.yaw) * cp;
    const fy = Math.sin(player.pitch);
    const fz = -Math.cos(player.yaw) * cp;
    const v = vec3(player.vel.x + fx * 6, player.vel.y + fy * 6 + 1.5, player.vel.z + fz * 6);
    const e = this.spawnItem(player.pos.x, player.pos.y + player.eyeHeight - 0.3, player.pos.z, item, count, v);
    e.pickupDelay = 40;
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
    this.ensureCache();
    const world = this.host.world;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      e.carryBlocked = false;
      if (e.removed || !world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) continue;
      if (e instanceof Player && e.steeringShipId !== 0) this.syncSeat(e);
      else if (e.carrierId !== 0) this.syncRider(e);
    }
  }

  /** Tick steps 5–6: own motion, collision, push, crush, attach / detach, pickups, fuses, AI. */
  update(): void {
    this.beginTick();
    this.ensureCache();
    this.iterating = true;
    const list = this.list;
    const n = list.length;
    try {
      for (let i = 0; i < n; i++) {
        const e = list[i]!;
        if (!e.removed) this.updateEntity(e);
      }
      this.pickups();
      this.merges();
    } finally {
      this.iterating = false;
    }
    const blasts = this.pendingBlasts;
    for (let i = 0; i < blasts.length; i++) {
      const t = blasts[i]!;
      this.host.explode(t.pos.x, t.pos.y + t.height * 0.5, t.pos.z, TNT_POWER, t);
    }
    blasts.length = 0;
    this.compact();
    this.tickCount++;
    this.snapshotDone = false;
  }

  // ================================================================== structures interface

  /**
   * Everything carried by `structure` (or by a structure mounted on it) lets go, and its
   * helmsman releases the wheel. Call before a structure blockifies / docks / dies / is re-gridded.
   */
  releaseRiders(structure: Structure): void {
    const ids = new Set<number>();
    const collect = (s: Structure): void => {
      ids.add(s.id);
      for (const c of s.children) collect(c);
    };
    collect(structure);
    // Its frame is about to jump (blockify / dock / re-grid): never carry anything across that.
    for (const id of ids) this.cache.forget(id);
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e instanceof Player && e.steeringShipId !== 0 && ids.has(e.steeringShipId)) this.releaseHelm(e, 'released');
      if (e.carrierId !== 0 && ids.has(e.carrierId)) {
        // The structure turns into blocks that do not move: keep only the own motion.
        e.vel.x -= e.carrierVel.x;
        e.vel.y -= e.carrierVel.y;
        e.vel.z -= e.carrierVel.z;
        e.carrierVel.x = 0;
        e.carrierVel.y = 0;
        e.carrierVel.z = 0;
        e.carrierId = 0;
      }
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
    const w = g.toWorld(player.seat, this.t1);
    player.pos.x = w.x;
    player.pos.y = w.y;
    player.pos.z = w.z;
    const r = this.cacheTick === this.tickCount ? this.cache.get(ship.id) : undefined;
    if (r !== undefined) pointVelocity(r, player.pos, player.carrierVel);
    else player.carrierVel.x = player.carrierVel.y = player.carrierVel.z = 0;
    player.vel.x = player.carrierVel.x;
    player.vel.y = player.carrierVel.y;
    player.vel.z = player.carrierVel.z;
    player.carrierId = ship.id;
    player.fallDistance = 0;
    return true;
  }

  /** Let go of the wheel (clears both sides, zeroes throttle and rudder). The player stays aboard as a rider. */
  stopSteering(player: Player): void {
    this.releaseHelm(player, 'stopped');
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
  }

  // ================================================================== save

  /** All entities including the player (position, look, health, air, mode, flying, inventory, spawn). */
  serialize(w: ByteWriter): void {
    w.u8(SAVE_VERSION);
    w.varuint(this.nextId);
    let count = 0;
    for (const e of this.list) if (!e.removed) count++;
    w.varuint(count);
    for (const e of this.list) {
      if (e.removed) continue;
      w.u8(KIND_TAG[e.kind]);
      w.varuint(e.id);
      writeVec(w, e.pos);
      writeVec(w, e.vel);
      writeVec(w, e.carrierVel);
      w.f64(e.yaw);
      w.f64(e.pitch);
      w.bool(e.onGround);
      w.f64(e.wet);
      w.bool(e.headWet);
      w.bool(e.inLava);
      w.varuint(e.carrierId);
      w.varuint(uint(e.noAttachTicks));
      w.varuint(e.noAttachStructureId);
      w.varuint(uint(e.age));
      w.f64(e.fallDistance);
      w.f64(e.contactNx);
      w.f64(e.contactNz);
      w.bool(e.onWorldGround);
      if (e instanceof Player) {
        w.u8(e.mode === 'creative' ? 1 : 0);
        w.f64(e.health);
        w.f64(e.maxHealth);
        w.varuint(uint(e.air));
        w.varuint(uint(e.maxAir));
        w.bool(e.dead);
        w.varuint(uint(e.hurtTicks));
        w.bool(e.flying);
        w.bool(e.sneaking);
        w.bool(e.sprinting);
        w.varuint(e.steeringShipId);
        writeVec(w, e.seat);
        writeVec(w, e.spawn);
        w.varuint(uint(e.drownTicks));
        w.varuint(uint(e.lavaTicks));
        w.varuint(Math.min(uint(e.unhurtTicks), 1 << 30));
        w.varint(Math.max(-(1 << 30), int(e.lastJumpPressAge)));
        w.u8(e.input.slot & 0xff);
        e.inventory.serialize(w);
      } else if (e instanceof ItemEntity) {
        w.varuint(e.stack.item);
        w.varuint(e.stack.count);
        w.varuint(uint(e.pickupDelay));
      } else if (e instanceof FallingBlockEntity) {
        w.u16(e.cell & 0xffff);
      } else if (e instanceof TntEntity) {
        w.varuint(uint(e.fuse));
      } else if (e instanceof Rabbit) {
        w.u8(Math.min(255, e.crushCount));
        w.u8(e.aiState === 'hop' ? 1 : 0);
        w.varint(int(e.aiTimer));
        w.varint(int(e.hopsLeft));
        w.varint(int(e.hopCooldown));
        w.f64(e.wanderYaw);
      }
    }
  }

  /** Replace every entity with the saved ones. */
  deserialize(r: ByteReader): void {
    const v = r.u8();
    if (v !== SAVE_VERSION) r.fail(`unsupported entity save version ${v}`);
    const nextId = r.varuint();
    const count = r.count(8);
    this.clear();
    for (let i = 0; i < count; i++) {
      const tag = r.u8();
      const id = r.varuint();
      if (id === 0) r.fail('entity id 0');
      if (this.byId.has(id)) r.fail(`duplicate entity id ${id}`);
      const pos = readVec(r);
      const vel = readVec(r);
      const cvel = readVec(r);
      const yaw = r.f64();
      const pitch = r.f64();
      const onGround = r.bool();
      const wet = r.f64();
      const headWet = r.bool();
      const inLava = r.bool();
      const carrierId = r.varuint();
      const noAttachTicks = r.varuint();
      const noAttachStructureId = r.varuint();
      const age = r.varuint();
      const fallDistance = r.f64();
      const cnx = r.f64();
      const cnz = r.f64();
      const onWorldGround = r.bool();
      let e: Entity;
      if (tag === KIND_TAG.player) {
        const mode: GameMode = r.u8() === 1 ? 'creative' : 'survival';
        const p = new Player(id, mode);
        p.health = r.f64();
        p.maxHealth = r.f64();
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
        p.input.slot = r.u8();
        p.inventory.deserialize(r);
        p.input.slot = p.inventory.selected;
        e = p;
      } else if (tag === KIND_TAG.item) {
        const item = r.varuint();
        const cnt = r.varuint();
        const it = new ItemEntity(id, { item, count: Math.max(1, cnt) });
        it.pickupDelay = r.varuint();
        if (!isItem(item)) {
          // An item that no longer exists: drop it from the world rather than fail the load.
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
        rb.wanderYaw = r.f64();
        e = rb;
      } else {
        r.fail(`unknown entity kind tag ${tag}`);
      }
      copyVec(e.pos, pos);
      copyVec(e.vel, vel);
      copyVec(e.carrierVel, cvel);
      e.yaw = yaw;
      e.pitch = pitch;
      if (e instanceof Player) {
        // The look is driven by input.yaw / pitch: seed it, or the first tick after loading
        // would snap the view to 0 until the client writes its own.
        e.input.yaw = yaw;
        e.input.pitch = pitch;
      }
      e.onGround = onGround;
      e.wet = wet;
      e.headWet = headWet;
      e.inLava = inLava;
      e.carrierId = carrierId;
      e.noAttachTicks = noAttachTicks;
      e.noAttachStructureId = noAttachStructureId;
      e.age = age;
      e.fallDistance = fallDistance;
      e.contactNx = cnx;
      e.contactNz = cnz;
      e.onWorldGround = onWorldGround;
      this.add(e);
    }
    if (nextId > this.nextId) this.nextId = nextId;
  }

  // ================================================================== carrying

  private ensureCache(): void {
    if (this.cacheTick === this.tickCount) return;
    this.cache.rebuild(this.host.structures());
    this.cacheTick = this.tickCount;
  }

  private syncRider(e: Entity): void {
    let r = this.cache.get(e.carrierId);
    if (r === undefined) {
      this.detach(e, e.vel);
      return;
    }
    // Own velocity in the carrier's frame, which turns with the carrier: standing still on a
    // yawing deck or turntable stays standing still (no fictitious slide).
    let relx = e.vel.x - e.carrierVel.x;
    const rely = e.vel.y - e.carrierVel.y;
    let relz = e.vel.z - e.carrierVel.z;
    let target = carryPoint(r, e.pos, this.t1);
    // LESSONS 转盘在船上: a rider swept by a rotor into a cell of the rotor's PARENT lets go of
    // the rotor and stays with the parent; it may not re-attach to the rotor for a while.
    const parent = r.parent;
    if (parent !== null && r.moved) {
      const bt = boxAt(e, target.x, target.y, target.z, this.box1);
      if (boxNearRec(bt, parent, 0) && boxOverlapsSolid(parent.grid, bt)) {
        const pt = carryPoint(parent, e.pos, this.t2);
        const bp = boxAt(e, pt.x, pt.y, pt.z, this.box2);
        if (!(boxNearRec(bp, parent, 0) && boxOverlapsSolid(parent.grid, bp))) {
          e.noAttachTicks = NO_ATTACH_TICKS;
          e.noAttachStructureId = r.id;
          e.carrierId = parent.id;
          r = parent;
          target = pt;
        }
      }
    }
    const dx = target.x - e.pos.x;
    const dy = target.y - e.pos.y;
    const dz = target.z - e.pos.z;
    if (dx * dx + dy * dy + dz * dz > MAX_CARRY_STEP * MAX_CARRY_STEP) {
      this.detach(e, e.vel);
      return;
    }
    const a = r.dyaw;
    if (a !== 0) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = relx * c + relz * s;
      relz = -relx * s + relz * c;
      relx = x;
      this.turn(e, a);
    }
    e.carrierVel.x = dx / DT;
    e.carrierVel.y = dy / DT;
    e.carrierVel.z = dz / DT;
    this.carryMove(e, dx, dy, dz);
    e.vel.x = relx + e.carrierVel.x;
    e.vel.y = rely + e.carrierVel.y;
    e.vel.z = relz + e.carrierVel.z;
  }

  private syncSeat(p: Player): void {
    const s = this.host.structure(p.steeringShipId);
    if (s === undefined || s.removed || s.kind !== 'ship') {
      this.releaseHelm(p, 'missing');
      if (p.carrierId !== 0) this.syncRider(p);
      return;
    }
    const ship = s as Ship;
    if (ship.helmsmanId !== p.id) {
      if (ship.helmsmanId === 0) ship.helmsmanId = p.id; // re-claim after loading a save
      else {
        this.releaseHelm(p, 'taken');
        if (p.carrierId !== 0) this.syncRider(p);
        return;
      }
    }
    const r = this.cache.get(ship.id);
    if (r === undefined) {
      this.releaseHelm(p, 'missing');
      return;
    }
    p.carrierId = ship.id;
    const target = curToWorld(r, p.seat, this.t1);
    // LESSONS 舵手穿过方块: a seat inside a world block releases the wheel; the rider then
    // follows the deck with world sweeps like anyone else and the push logic takes over.
    if (boxOverlapsSolid(this.host.world, boxAt(p, target.x, target.y, target.z, this.box1))) {
      this.releaseHelm(p, 'blocked');
      this.syncRider(p);
      return;
    }
    pointVelocity(r, target, p.carrierVel);
    p.pos.x = target.x;
    p.pos.y = target.y;
    p.pos.z = target.z;
    if (r.dyaw !== 0) this.turn(p, r.dyaw);
    p.vel.x = p.carrierVel.x;
    p.vel.y = p.carrierVel.y;
    p.vel.z = p.carrierVel.z;
    p.onGround = true;
  }

  /** Turn an entity's heading with its carrier (the player's look too). */
  private turn(e: Entity, a: number): void {
    e.yaw += a;
    if (e instanceof Player) {
      e.input.yaw += a;
      e.carriedYaw += a;
    }
  }

  /** Carrier motion applied with world sweeps: a wall scrapes the rider off instead of swallowing it. */
  private carryMove(e: Entity, dx: number, dy: number, dz: number): void {
    const world = this.host.world;
    const b = e.box(this.box1);
    if (dy !== 0) {
      const m = sweepAxisSafe(world, b, 1, dy);
      if (m !== dy) e.carryBlocked = true;
      e.pos.y += m;
      b.minY += m;
      b.maxY += m;
    }
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    for (let k = 0; k < 2; k++) {
      const axis = (k === 0) === xFirst ? 0 : 2;
      const d = axis === 0 ? dx : dz;
      if (d === 0) continue;
      const m = sweepAxisSafe(world, b, axis, d);
      if (m !== d) e.carryBlocked = true;
      if (axis === 0) {
        e.pos.x += m;
        b.minX += m;
        b.maxX += m;
      } else {
        e.pos.z += m;
        b.minZ += m;
        b.maxZ += m;
      }
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
    this.host.emit({ type: 'helmReleased', entity: p, cause });
  }

  /** Let go of the carrier, keeping the world velocity `v` (vel or the working relative+carrier velocity). */
  private detach(e: Entity, v: Vec3): void {
    if (e.carrierId === 0) return;
    let vx = v.x;
    let vy = v.y;
    let vz = v.z;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (sp > MAX_INHERITED_SPEED) {
      const k = MAX_INHERITED_SPEED / sp;
      vx *= k;
      vy *= k;
      vz *= k;
    }
    e.vel.x = vx;
    e.vel.y = vy;
    e.vel.z = vz;
    e.carrierVel.x = 0;
    e.carrierVel.y = 0;
    e.carrierVel.z = 0;
    e.carrierId = 0;
  }

  // ================================================================== per-entity update

  private updateEntity(e: Entity): void {
    const world = this.host.world;
    if (!world.isLoaded(Math.floor(e.pos.x), Math.floor(e.pos.z))) return; // frozen: never fall into the unknown
    e.age++;
    if (e.noAttachTicks > 0 && --e.noAttachTicks === 0) e.noAttachStructureId = 0;
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

  /** 'splash' when a body that was dry hits the water fast (call after sampleFluids, before moving). */
  private splashCheck(e: Entity, wasWet: number): void {
    if (wasWet === 0 && e.wet > 0 && e.vel.y < -SPLASH_SPEED) this.host.emit({ type: 'splash', entity: e, amount: -e.vel.y });
  }

  /** rel := own velocity relative to the carrier. */
  private loadRel(e: Entity): Vec3 {
    const rel = this.rel;
    rel.x = e.vel.x - e.carrierVel.x;
    rel.y = e.vel.y - e.carrierVel.y;
    rel.z = e.vel.z - e.carrierVel.z;
    return rel;
  }

  /** Collect the structures within reach of the body (and of its displacement this tick). */
  private gatherNear(e: Entity, dx: number, dy: number, dz: number, extra = 0): void {
    const b = e.box(this.box2);
    if (dx < 0) b.minX += dx;
    else b.maxX += dx;
    if (dy < 0) b.minY += dy;
    else b.maxY += dy;
    if (dz < 0) b.minZ += dz;
    else b.maxZ += dz;
    this.cache.near(b, NEAR_MARGIN + extra, this.mover.near);
  }

  /** Fluid share before moving (the controller needs it). */
  private sampleFluids(e: Entity): number {
    this.gatherNear(e, 0, 0, 0);
    this.fluids.sample(e, this.mover.near);
    return e.wet + this.fluids.lavaShare;
  }

  /**
   * Steps b–e for a displacement already chosen by the controller (in this.rel / this.disp).
   * Returns the structure that crushed the body this tick, or null.
   */
  private moveBody(e: Entity, sneakGuard: boolean): StructRec | null {
    const d = this.disp;
    const rel = this.rel;
    this.relocatedDy = 0;
    if (Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > NEAR_MARGIN * 0.5) this.gatherNear(e, d.x, d.y, d.z);
    const mover = this.mover;
    mover.move(e, rel, d.x, d.y, d.z, sneakGuard);
    e.onWorldGround = mover.onWorldGround;
    e.onGround = mover.onWorldGround || mover.groundRec !== null;
    e.contactNx = mover.contactNx;
    e.contactNz = mover.contactNz;
    // d. crush: whatever overlap remains was made by a structure (own motion was taken back).
    let crushed: StructRec | null = null;
    if (mover.near.length > 0) {
      crushed = mover.findOverlap(e);
      if (crushed !== null) {
        this.relocate(e, CRUSH_SEARCH_RADIUS);
        this.crushed(e);
        if (e.removed) return crushed;
      }
    }
    if (crushed === null && mover.inWorldBlock(e)) {
      // Something put a world block into the body (placed, landed, blockified): step aside.
      if (!this.relocate(e, UNSTUCK_SEARCH_RADIUS) && e instanceof Player) this.damage(e, 1, 'suffocate');
    }
    // e. attach / detach
    this.updateCarrier(e);
    e.vel.x = rel.x + e.carrierVel.x;
    e.vel.y = rel.y + e.carrierVel.y;
    e.vel.z = rel.z + e.carrierVel.z;
    return crushed;
  }

  /** Move the body to the nearest spot free of the world and every near structure (same overlap test as pushing). */
  private relocate(e: Entity, radius: number): boolean {
    const grids = this.grids;
    grids.length = 0;
    grids.push(this.host.world);
    const near = this.mover.near;
    for (let k = 0; k < near.length; k++) grids.push(near[k]!.grid);
    const off = nearestFreeOffset(grids, e.box(this.box1), radius);
    if (off === null) return false;
    e.pos.x += off.x;
    e.pos.y += off.y;
    e.pos.z += off.z;
    this.relocatedDy += off.y;
    // Stand still relative to the carrier: no velocity survives being squeezed out.
    this.rel.x = 0;
    this.rel.y = 0;
    this.rel.z = 0;
    return true;
  }

  /**
   * Step e (DESIGN 携带): carried only while a cell of the structure is under the feet.
   *  - landed on a world block -> detach;
   *  - standing on a structure (attach probe, innermost first) -> that structure;
   *  - airborne with a carrier -> keep it while its column under the footprint holds a cell
   *    (jumping on a deck keeps you with the ship), else its parent's, else detach.
   *    Swimmers are never kept (ACCEPTANCE 19: a swimmer next to a hull is never picked up).
   */
  private updateCarrier(e: Entity): void {
    const flying = e instanceof Player && e.flying;
    if (e.onWorldGround || (flying && !e.onGround)) {
      this.detachRel(e);
      return;
    }
    const b = e.box(this.box1);
    const inset = attachInset(e);
    const near = this.mover.near;
    let stand: StructRec | null = null;
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      if (this.attachBlocked(e, r)) continue;
      if (b.minY - SUPPORT_GAP >= r.maxY || b.minY <= r.minY) continue;
      if (hasSupportBelow(r.grid, b, SUPPORT_GAP, inset)) {
        stand = r;
        break;
      }
    }
    const cur = e.carrierId !== 0 ? this.cache.get(e.carrierId) : undefined;
    // Hysteresis: once attached, plain standing (inset 0) keeps the carrier.
    if (stand === null && cur !== undefined && e.onGround && !this.attachBlocked(e, cur) && hasSupportBelow(cur.grid, b, SUPPORT_GAP, 0)) {
      stand = cur;
    }
    if (stand !== null) {
      this.setCarrier(e, stand);
      return;
    }
    const swimming = e.wet >= SWIMMING_WET && !e.onGround;
    if (cur !== undefined && !flying && !swimming) {
      for (let r: StructRec | null = cur; r !== null; r = r.parent) {
        if (columnHasSolidBelow(r.grid, b, COLUMN_DEPTH, inset)) {
          this.setCarrier(e, r);
          return;
        }
      }
    }
    this.detachRel(e);
  }

  private attachBlocked(e: Entity, r: StructRec): boolean {
    return e.noAttachTicks > 0 && (e.noAttachStructureId === 0 || e.noAttachStructureId === r.id);
  }

  /** Switch carrier keeping the world velocity continuous. */
  private setCarrier(e: Entity, r: StructRec): void {
    if (e.carrierId === r.id) return;
    const rel = this.rel;
    const vx = rel.x + e.carrierVel.x;
    const vy = rel.y + e.carrierVel.y;
    const vz = rel.z + e.carrierVel.z;
    pointVelocity(r, e.pos, e.carrierVel);
    rel.x = vx - e.carrierVel.x;
    rel.y = vy - e.carrierVel.y;
    rel.z = vz - e.carrierVel.z;
    e.carrierId = r.id;
  }

  /** Detach during update(): the working relative velocity becomes the world velocity. */
  private detachRel(e: Entity): void {
    if (e.carrierId === 0) return;
    const rel = this.rel;
    const v = this.t2;
    v.x = rel.x + e.carrierVel.x;
    v.y = rel.y + e.carrierVel.y;
    v.z = rel.z + e.carrierVel.z;
    this.detach(e, v);
    rel.x = e.vel.x;
    rel.y = e.vel.y;
    rel.z = e.vel.z;
  }

  // ------------------------------------------------------------------ player

  private updatePlayer(p: Player): void {
    const inp = p.input;
    inp.forward = axisValue(inp.forward);
    inp.strafe = axisValue(inp.strafe);
    inp.yaw = finiteAngle(inp.yaw, p.yaw);
    inp.pitch = finiteAngle(inp.pitch, p.pitch);
    const slot = Math.floor(inp.slot);
    if (slot >= 0 && slot < p.inventory.hotbar.length) p.inventory.selected = slot;
    if (p.mode !== 'creative') p.flying = false;
    const presses = inp.jumpPresses > 0 ? Math.min(8, Math.floor(inp.jumpPresses)) : 0;
    inp.jumpPresses = 0;
    if (p.dead) {
      p.vel.x = p.vel.y = p.vel.z = 0;
      return;
    }
    if (p.hurtTicks > 0) p.hurtTicks--;
    p.unhurtTicks++;
    p.yaw = inp.yaw;
    p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, inp.pitch));

    const seated = p.steeringShipId !== 0;
    // Double-tap jump toggles creative flight.
    if (!seated && p.mode === 'creative') {
      for (let i = 0; i < presses; i++) {
        if (p.age - p.lastJumpPressAge <= FLY_TOGGLE_TICKS) {
          p.flying = !p.flying;
          p.lastJumpPressAge = -1000;
          if (p.flying) p.vel.y = p.carrierVel.y;
        } else {
          p.lastJumpPressAge = p.age;
        }
      }
    }
    p.sneaking = inp.sneak && !p.flying && !seated;
    p.sprinting = inp.sprint && inp.forward > 0 && !p.sneaking && !seated;

    const wasOnGround = p.onGround;
    const wasWet = p.wet;
    const fluid = this.sampleFluids(p);
    const rel = this.loadRel(p);
    const d = this.disp;
    let guard = false;
    if (seated) {
      rel.x = rel.y = rel.z = 0;
      d.x = d.y = d.z = 0;
    } else {
      guard = playerMotion(p, rel, fluid, p.inLava, this.wish, d);
    }
    this.splashCheck(p, wasWet);
    const y0 = p.pos.y;
    this.moveBody(p, guard && !p.flying);
    if (p.removed || p.dead) return;
    if (seated && p.steeringShipId !== 0) {
      p.onGround = true;
      // Pushed far off the seat (a blade swept through the helm): let go of the wheel.
      const r = this.cache.get(p.steeringShipId);
      if (r !== undefined) {
        const s = curToWorld(r, p.seat, this.t1);
        const dx = s.x - p.pos.x;
        const dy = s.y - p.pos.y;
        const dz = s.z - p.pos.z;
        if (dx * dx + dy * dy + dz * dz > 0.25) this.releaseHelm(p, 'pushed');
      }
    }
    // Falls and landing. A crush / unstuck relocation is a teleport, not a fall.
    const y1 = p.pos.y - this.relocatedDy;
    const fell = y1 < y0 ? y0 - y1 : 0;
    if (p.wet > 0 || p.inLava || p.flying || p.steeringShipId !== 0) {
      p.fallDistance = 0;
    } else if (p.onGround) {
      const total = p.fallDistance + fell;
      p.fallDistance = 0;
      if (!wasOnGround && total >= LAND_EVENT_HEIGHT) this.host.emit({ type: 'land', entity: p, amount: total });
      if (total > FALL_SAFE_HEIGHT) {
        // Fluids were sampled before this tick's move: a fast fall can enter shallow water and
        // hit its bottom in the same tick. Water at the landing spot always breaks the fall.
        this.fluids.sample(p, this.mover.near);
        if (p.wet === 0 && !p.inLava) this.damage(p, Math.ceil(total - FALL_SAFE_HEIGHT), 'fall');
      }
    } else {
      p.fallDistance += fell;
    }
    if (!p.dead) this.playerHealth(p);
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
    const wasWet = e.wet;
    const fluid = this.sampleFluids(e);
    if (e.inLava) {
      this.host.emit({ type: 'despawn', entity: e, cause: 'lava' });
      this.remove(e);
      return;
    }
    const rel = this.loadRel(e);
    this.splashCheck(e, wasWet);
    passiveMotion(e, rel, fluid, ITEM_GRAVITY, ITEM_BUOYANCY, this.disp);
    this.moveBody(e, false);
  }

  private updateTnt(e: TntEntity): void {
    const wasWet = e.wet;
    const fluid = this.sampleFluids(e);
    const rel = this.loadRel(e);
    this.splashCheck(e, wasWet);
    passiveMotion(e, rel, fluid, ITEM_GRAVITY, 0, this.disp);
    this.moveBody(e, false);
    if (e.removed) return;
    if (--e.fuse <= 0) {
      e.fuse = 0;
      this.pendingBlasts.push(e);
      this.remove(e);
    }
  }

  private updateFalling(e: FallingBlockEntity): void {
    const wasWet = e.wet;
    const fluid = this.sampleFluids(e);
    const rel = this.loadRel(e);
    this.splashCheck(e, wasWet);
    passiveMotion(e, rel, fluid, ITEM_GRAVITY, 0, this.disp);
    rel.x = 0;
    rel.z = 0;
    this.disp.x = 0;
    this.disp.z = 0;
    const y0 = e.pos.y;
    this.moveBody(e, false);
    if (e.removed) return;
    if (e.pos.y < y0) e.fallDistance += y0 - e.pos.y;
    if (this.mover.onWorldGround) this.landFalling(e);
    // LESSONS 沙子落到船上悬浮: landing on a structure always yields an item drop.
    else if (this.mover.groundRec !== null || e.carrierId !== 0) this.fallingToItem(e, 'structure');
    else if (e.age > FALLING_MAX_TICKS) this.fallingToItem(e, 'timeout');
  }

  private landFalling(e: FallingBlockEntity): void {
    const world = this.host.world;
    const x = Math.floor(e.pos.x);
    const y = Math.floor(e.pos.y + 0.5);
    const z = Math.floor(e.pos.z);
    const here = world.getCell(x, y, z);
    let ok = REPLACEABLE[here & ID_MASK] === 1;
    if (ok) {
      // A structure cell (or part of one) in the target cell wins: hard blocks may not be placed into structures.
      const cb = this.box1;
      cb.minX = x + 0.02;
      cb.minY = y + 0.02;
      cb.minZ = z + 0.02;
      cb.maxX = x + 0.98;
      cb.maxY = y + 0.98;
      cb.maxZ = z + 0.98;
      const near = this.mover.near;
      for (let k = 0; k < near.length && ok; k++) {
        const r = near[k]!;
        if (boxNearRec(cb, r, 0) && boxOverlapsSolid(r.grid, cb)) ok = false;
      }
    }
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
    const wasWet = e.wet;
    const fluid = this.sampleFluids(e);
    if (e.inLava) {
      this.kill(e, 'lava');
      return;
    }
    const rel = this.loadRel(e);
    this.splashCheck(e, wasWet);
    const d = this.disp;
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
    d.x = rel.x * DT;
    d.z = rel.z * DT;
    d.y = (vy0 + vy1) * 0.5 * DT;
    rel.y = vy1;
    // Face where it is going.
    let dy = e.wanderYaw - e.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    e.yaw += dy * 0.35;
    this.moveBody(e, false);
  }

  /** Is the spot one hop ahead safe: supported within RABBIT_MAX_DROP and not water / lava? */
  private rabbitCanHop(e: Rabbit, dirx: number, dirz: number): boolean {
    const tx = e.pos.x + dirx * 1.1;
    const tz = e.pos.z + dirz * 1.1;
    this.gatherNear(e, dirx * 1.2, -RABBIT_MAX_DROP, dirz * 1.2);
    const world = this.host.world;
    const fx = Math.floor(tx);
    const fz = Math.floor(tz);
    const fy = Math.floor(e.pos.y + 0.1);
    if (LIQUID[world.getCell(fx, fy, fz) & ID_MASK] !== 0 || LIQUID[world.getCell(fx, fy - 1, fz) & ID_MASK] !== 0) return false;
    const b = boxAt(e, tx, e.pos.y + 1.05, tz, this.box1);
    // Probe from just above a 1-block step down to RABBIT_MAX_DROP below the current feet.
    return this.mover.supported(b, RABBIT_MAX_DROP + 1.05, attachInset(e));
  }

  // ------------------------------------------------------------------ crush

  /**
   * DESIGN 实体被挤: the body has already been moved to the nearest free spot. Players take
   * damage in survival (HURT_TICKS of invulnerability), rabbits are flattened at the third
   * squeeze in survival, item drops / falling blocks / crates are only moved.
   */
  private crushed(e: Entity): void {
    this.host.emit({ type: 'crush', entity: e, cause: 'structure' });
    if (e instanceof Player) {
      this.damage(e, CRUSH_DAMAGE, 'crush');
    } else if (e instanceof Rabbit && this.survival()) {
      e.crushCount++;
      if (e.crushCount >= RABBIT_CRUSH_LIMIT) this.kill(e, 'crush');
    }
  }

  /** The world's mode is the local player's mode (creative when there is no player). */
  private survival(): boolean {
    const p = this.localPlayer;
    return p !== null && p.mode === 'survival';
  }

  // ------------------------------------------------------------------ pickups and merging

  private pickups(): void {
    const p = this.localPlayer;
    if (p === null || p.dead || p.removed) return;
    const reach = p.box(this.box2);
    reach.minX -= PICKUP_REACH_H;
    reach.maxX += PICKUP_REACH_H;
    reach.minZ -= PICKUP_REACH_H;
    reach.maxZ += PICKUP_REACH_H;
    reach.minY -= PICKUP_REACH_V;
    reach.maxY += PICKUP_REACH_V;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!(e instanceof ItemEntity) || e.removed || e.pickupDelay > 0) continue;
      const b = e.box(this.box1);
      if (b.minX >= reach.maxX || b.maxX <= reach.minX || b.minY >= reach.maxY || b.maxY <= reach.minY || b.minZ >= reach.maxZ || b.maxZ <= reach.minZ) continue;
      const left = p.inventory.add(e.stack.item, e.stack.count);
      const taken = e.stack.count - left;
      if (taken <= 0) continue;
      e.stack.count = left;
      this.host.emit({ type: 'pickup', entity: e, amount: taken });
      if (left <= 0) this.remove(e);
    }
  }

  private merges(): void {
    // Only drops take part; each one looks around every MERGE_INTERVAL_TICKS (staggered by id).
    const items = this.items;
    items.length = 0;
    let due = false;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (e instanceof ItemEntity && !e.removed) {
        items.push(e);
        if ((e.age + e.id) % MERGE_INTERVAL_TICKS === 0) due = true;
      }
    }
    if (!due) return;
    const ba = this.box1;
    const bb = this.box2;
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      if (a.removed || (a.age + a.id) % MERGE_INTERVAL_TICKS !== 0) continue;
      const max = maxStackOf(a.stack.item);
      if (a.stack.count >= max) continue;
      a.box(ba);
      for (let j = 0; j < items.length; j++) {
        const b = items[j]!;
        if (b === a || b.removed || b.stack.item !== a.stack.item) continue;
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

  private compact(): void {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (!e.removed) list[w++] = e;
    }
    list.length = w;
  }
}

// ====================================================================== helpers

/** sweepAxis on the world with a numeric axis. */
function sweepAxisSafe(world: VoxelGrid, b: AABB, axis: number, d: number): number {
  return sweepAxis(world, b, axis as 0 | 1 | 2, d);
}

/** A tick counter as a non-negative integer (save fields are integers even if a caller set a fraction). */
function uint(v: number): number {
  return v > 0 ? Math.floor(v) : 0;
}
function int(v: number): number {
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

function writeVec(w: ByteWriter, v: Vec3): void {
  w.f64(v.x);
  w.f64(v.y);
  w.f64(v.z);
}
function readVec(r: ByteReader): Vec3 {
  return vec3(r.f64(), r.f64(), r.f64());
}
function copyVec(out: Vec3, v: Vec3): void {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
}
