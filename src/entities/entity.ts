/**
 * Entity data. Every entity is a WORLD-axis-aligned box whose bottom centre is `pos` (the
 * feet). Behaviour (movement, collision, carrying, health) lives in EntityManager; these
 * classes hold state only, so saving, rendering and testing can look at them directly.
 */
import { aabb, vec3, type AABB, type Vec3 } from '../core/math';
import type { ItemStack } from '../blocks/items';
import {
  FALLING_HALF_WIDTH,
  FALLING_HEIGHT,
  ITEM_HALF_WIDTH,
  ITEM_HEIGHT,
  ITEM_PICKUP_DELAY,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_MAX_AIR,
  PLAYER_MAX_HEALTH,
  RABBIT_EYE_HEIGHT,
  RABBIT_HALF_WIDTH,
  RABBIT_HEIGHT,
  TNT_DEFAULT_FUSE,
  TNT_HALF_WIDTH,
  TNT_HEIGHT,
} from './constants';
import type { ClientDrive } from './drive';
import { emptyInput, type PlayerInput } from './input';
import { Inventory } from './inventory';

/** The same strings as EntityKind in src/render/backend.ts. */
export type EntityKind = 'player' | 'item' | 'falling' | 'tnt' | 'rabbit';

export type GameMode = 'creative' | 'survival';

export abstract class Entity {
  readonly id: number;
  abstract readonly kind: EntityKind;
  /** Bottom centre of the body box (the feet), world space. */
  readonly pos: Vec3 = vec3();
  /** `pos` at the start of the current tick (render interpolation). */
  readonly prevPos: Vec3 = vec3();
  /** World velocity, blocks per second (includes the carrier's motion while carried). */
  readonly vel: Vec3 = vec3();
  yaw = 0;
  pitch = 0;
  prevYaw = 0;
  prevPitch = 0;
  halfWidth: number;
  height: number;
  eyeHeight: number;
  onGround = false;
  /** 0..1 share of the body in water, after dry-volume correction. */
  wet = 0;
  /** The eyes are in water (after dry-volume correction). */
  headWet = false;
  inLava = false;
  /** Id of the structure carrying it, 0 = none. */
  carrierId = 0;
  /** While > 0 the entity may not attach (to noAttachStructureId, or to anything when that is 0). */
  noAttachTicks = 0;
  /** Ticks lived. */
  age = 0;
  /** Set when the entity left the world; holders must drop it. */
  removed = false;

  // ---- motion bookkeeping, owned by the EntityManager. Public for the manager, the save code
  // ---- and tests; gameplay code should treat it as read-only.

  /**
   * World velocity of the carrier's material at the feet over the last tick (zero when not
   * carried). `vel - carrierVel` is the entity's own velocity in the carrier's frame.
   */
  readonly carrierVel: Vec3 = vec3();
  /** See noAttachTicks. */
  noAttachStructureId = 0;
  /** Distance fallen since the entity was last supported (fall damage, landing events). */
  fallDistance = 0;
  /** The world stopped part of the carrier's motion this tick (the rider was scraped off). */
  carryBlocked = false;
  /** Horizontal contact normal of the WORLD walls that stopped the last tick's move (0,0 = none). */
  contactNx = 0;
  contactNz = 0;
  /** The last downward move was stopped by a WORLD block (as opposed to a structure). */
  onWorldGround = false;
  /** Ticks to wait before the next free-spot search after failed ones (not saved). */
  unstuckWait = 0;
  /** Consecutive failed free-spot searches (not saved). */
  unstuckFails = 0;

  constructor(id: number, halfWidth: number, height: number, eyeHeight: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`entity id must be a positive integer, got ${id}`);
    this.id = id;
    this.halfWidth = halfWidth;
    this.height = height;
    this.eyeHeight = eyeHeight;
  }

  /** The body box (world space). The ONLY body used for every collision / support / carry test. */
  box(out: AABB = aabb()): AABB {
    const p = this.pos;
    const hw = this.halfWidth;
    out.minX = p.x - hw;
    out.minY = p.y;
    out.minZ = p.z - hw;
    out.maxX = p.x + hw;
    out.maxY = p.y + this.height;
    out.maxZ = p.z + hw;
    return out;
  }

  eyePos(out: Vec3 = vec3()): Vec3 {
    out.x = this.pos.x;
    out.y = this.pos.y + this.eyeHeight;
    out.z = this.pos.z;
    return out;
  }

  /** Copy pos / yaw / pitch into prev*. Called at the start of every tick. */
  snapshot(): void {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevPos.z = this.pos.z;
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
  }

  /** Teleport: move without an interpolation streak. */
  setPosition(x: number, y: number, z: number): void {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.snapshot();
  }
}

export class Player extends Entity {
  readonly kind = 'player' as const;
  mode: GameMode;
  health = PLAYER_MAX_HEALTH;
  maxHealth = PLAYER_MAX_HEALTH;
  /** Breath in ticks. */
  air = PLAYER_MAX_AIR;
  maxAir = PLAYER_MAX_AIR;
  dead = false;
  /** Ticks of remaining invulnerability / hurt flash. */
  hurtTicks = 0;
  flying = false;
  sneaking = false;
  sprinting = false;
  readonly input: PlayerInput = emptyInput();
  readonly inventory: Inventory = new Inventory();
  /** Ship whose wheel the player holds, 0 = not at a helm. */
  steeringShipId = 0;
  /** Respawn point (feet). */
  readonly spawn: Vec3 = vec3();
  /** Seat (feet) in the steered ship's LOCAL space; valid while steeringShipId != 0. */
  readonly seat: Vec3 = vec3();
  /**
   * Heading (radians, CCW from above) that carriers turned the player by since the client last
   * called takeCarriedYaw(). The simulation already added it to `yaw` and `input.yaw`; a client
   * that keeps its own camera yaw adds the taken amount to it so the view turns with the ship.
   */
  carriedYaw = 0;
  /**
   * Null: the server moves this player from its input (server-driven). Otherwise its client moves
   * it and reports, and this is the server's state of that (entities/drive.ts). Not saved: who
   * drives a player is decided when it joins.
   */
  remote: ClientDrive | null = null;

  // ---- health timers (EntityManager)
  drownTicks = 0;
  lavaTicks = 0;
  /** Ticks since the last damage (regeneration). */
  unhurtTicks = 0;
  /** `age` at the last jump press (double-tap to fly). */
  lastJumpPressAge = -1000;

  constructor(id: number, mode: GameMode) {
    super(id, PLAYER_HALF_WIDTH, PLAYER_HEIGHT, PLAYER_EYE_HEIGHT);
    this.mode = mode;
  }

  takeCarriedYaw(): number {
    const y = this.carriedYaw;
    this.carriedYaw = 0;
    return y;
  }
}

export class ItemEntity extends Entity {
  readonly kind = 'item' as const;
  stack: ItemStack;
  /** Ticks until a player may pick it up. */
  pickupDelay = ITEM_PICKUP_DELAY;

  constructor(id: number, stack: ItemStack) {
    super(id, ITEM_HALF_WIDTH, ITEM_HEIGHT, ITEM_HEIGHT * 0.5);
    this.stack = stack;
  }
}

export class FallingBlockEntity extends Entity {
  readonly kind = 'falling' as const;
  /**
   * The packed cell being carried down: always a full block (< FULL_LIMIT: only sand and gravel
   * fall, and they cannot be cut; manager.ts asserts it where the block is spawned and placed).
   */
  cell: number;

  constructor(id: number, cell: number) {
    super(id, FALLING_HALF_WIDTH, FALLING_HEIGHT, FALLING_HEIGHT * 0.5);
    this.cell = cell;
  }
}

export class TntEntity extends Entity {
  readonly kind = 'tnt' as const;
  /** Ticks until it explodes. */
  fuse: number;

  constructor(id: number, fuse: number = TNT_DEFAULT_FUSE) {
    super(id, TNT_HALF_WIDTH, TNT_HEIGHT, TNT_HEIGHT * 0.5);
    this.fuse = fuse;
  }
}

export type RabbitState = 'idle' | 'hop';

export class Rabbit extends Entity {
  readonly kind = 'rabbit' as const;
  /** Times it was squeezed by a structure in survival (3 = flattened). */
  crushCount = 0;
  // ---- wander AI
  aiState: RabbitState = 'idle';
  /** Ticks left in the idle pause. */
  aiTimer = 0;
  /** Hops left in the current run. */
  hopsLeft = 0;
  /** Ticks to wait on the ground between two hops. */
  hopCooldown = 0;
  /** Heading of the current run. */
  wanderYaw = 0;

  constructor(id: number) {
    super(id, RABBIT_HALF_WIDTH, RABBIT_HEIGHT, RABBIT_EYE_HEIGHT);
  }
}
