/**
 * Every tuning constant of the entities module, in one place.
 *
 * Units: blocks, seconds, blocks/second (velocities), blocks/second^2 (accelerations), ticks
 * where the name says so. "Per tick" factors are applied once per 1/20 s tick.
 */

// ====================================================================== bodies

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;

export const ITEM_HALF_WIDTH = 0.125;
export const ITEM_HEIGHT = 0.25;

export const FALLING_HALF_WIDTH = 0.49;
export const FALLING_HEIGHT = 0.98;

export const TNT_HALF_WIDTH = 0.49;
export const TNT_HEIGHT = 0.98;

export const RABBIT_HALF_WIDTH = 0.2;
export const RABBIT_HEIGHT = 0.5;
export const RABBIT_EYE_HEIGHT = 0.4;

// ====================================================================== structure probes
//
// docs/LESSONS.md 携带与实体 #1: standing, pushing, attaching and crushing must sample the SAME
// body and the attach region must lie strictly inside the push region. All four go through the
// voxel query module with Entity.box() — the one world-axis-aligned body box:
//
//   push / crush : the full box            deepestPenetration / boxOverlapsSolid
//   standing     : footprint, inset 0      hasSupportBelow(grid, box, SUPPORT_GAP, 0)
//   attaching    : footprint, inset > 0    hasSupportBelow(grid, box, SUPPORT_GAP, attachInset)
//   column keep  : footprint, inset > 0    columnHasSolidBelow(grid, box, COLUMN_DEPTH, attachInset)
//
// A body touching a hull only with the outer ATTACH_INSET band of its footprint (a swimmer
// next to a rotated hull corner) can be pushed by it but never attached to it.

/** Support counts when a solid cell lies within this distance below the feet. */
export const SUPPORT_GAP = 0.08;
/** Footprint inset of the attach / column probes (capped by ATTACH_INSET_MAX_FRACTION of the half width). */
export const ATTACH_INSET = 0.1;
/** Small bodies (item drops) use at most this fraction of their half width as attach inset. */
export const ATTACH_INSET_MAX_FRACTION = 0.5;
/** An airborne rider keeps its carrier while a carrier cell lies this far below its footprint. */
export const COLUMN_DEPTH = 16;
/** After being swept into its carrier's parent, a rider may not re-attach for this many ticks. */
export const NO_ATTACH_TICKS = 10;

// ====================================================================== sneak edge guard
//
// The guard keeps a sneaking body standing. Its probe is a DISK of point probes around the feet
// centre, laid out in each grid's own heading (world grid: world axes; a structure: its yaw), so
// the probe is fixed relative to every support while the world-aligned body box turns relative
// to a yawing deck (LESSONS 潜行走到甲板边缘掉下去; review: the old square attach-inset probe
// changed its reach with the relative angle and switched the guard off). Every disk point lies
// within SNEAK_DISK_RADIUS < half width of the centre, i.e. inside the body footprint at EVERY
// relative rotation: guard-supported implies standing-supported (hasSupportBelow, inset 0) for as
// long as the body does not move, however the deck turns — and a carried body keeps its carrier
// through the inset-0 hysteresis.

/** The guard disk is the footprint's inscribed circle shrunk by this margin. Larger than the
 *  per-tick gravity sink (~0.04) so the ground push at a deck edge always wins over the side push. */
export const SNEAK_DISK_MARGIN = 0.06;
/** A body that stands outside the guard disk (walked to the edge, then sneaked) may move only
 *  without getting farther from its support, measured with disks this much larger per step. */
export const SNEAK_LADDER_STEP = 0.05;

// ====================================================================== pushing

/** A structure push whose normal has y above this is ground (a pure vertical correction). */
export const GROUND_NORMAL_Y = 0.7;
/**
 * A push restricted to some axes (others would enter the world or another structure) is only
 * applied while the allowed part of the normal keeps at least this squared length, i.e. the
 * body moves at most 1/sqrt(this) times the penetration depth.
 */
export const MIN_PUSH_PROJECTION_SQ = 0.1;
/** Pushes clear the face by this much, so a pushed body is reliably "touching", never overlapping. */
export const PUSH_SKIN = 1e-6;
/** Push iterations per structure per sub-step. */
export const MAX_PUSH_ITERATIONS = 4;
/** Relative motion longer than this per tick is split into sub-steps (a 1-cell deck cannot be tunnelled). */
export const MAX_SUBSTEP = 0.4;
/** Hard cap on sub-steps (terminal velocity needs ~8). */
export const MAX_SUBSTEPS = 32;
/** A structure moving faster than this relative to the body biases the push toward its motion. */
export const PREFER_MIN_SPEED = 0.5;
/** Strength of that bias (blocks of depth per unit of alignment; see PushOptions.preferWeight). */
export const PREFER_WEIGHT = 0.3;
/**
 * The bias only applies when the minimal push is at least this deep (a blade that jumped well
 * into the body this tick). A graze is always resolved by the minimal push: biasing it would
 * pick a face many times deeper and fling the body (LESSONS 叶片侧面擦过船时船被猛踢).
 */
export const PREFER_MIN_DEPTH = 0.2;
/**
 * A structure push that would dip the body into ANOTHER structure's floor (pushed along a deck
 * that rolls or pitches a little) lifts the body onto that floor instead of being refused, when
 * the needed lift is at most this. A deeper overlap is a wall: the axis is refused.
 */
export const MAX_PUSH_LIFT = 0.3;
/** Free-spot search radius after a crush. */
export const CRUSH_SEARCH_RADIUS = 3;
/** Free-spot search radius for a body stuck inside world blocks. */
export const UNSTUCK_SEARCH_RADIUS = 2;
/** After a failed free-spot search the next one waits 2^failures ticks, at most this many. */
export const UNSTUCK_MAX_BACKOFF_TICKS = 64;
/** A buried passive body (item drop, crate, falling block) with no free spot nearby rises to the
 *  first free spot at most this many blocks straight above. */
export const BURIED_RISE_LIMIT = 48;
/** World velocity a body may keep when it lets go of a carrier. */
export const MAX_INHERITED_SPEED = 30;

// ====================================================================== player movement

export const GRAVITY = 30;
export const TERMINAL_SPEED = 60;
/** Jump take-off speed: apex sqrt(2 g h) with h = 1.25 blocks. */
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * 1.25);

export const WALK_SPEED = 4.3;
export const SPRINT_SPEED = 5.6;
export const SNEAK_SPEED = 1.3;
/** Share of the gap to the wished horizontal velocity closed per tick on the ground. */
export const GROUND_ACCEL = 0.6;
/** ... in the air (reduced air control, keeps momentum). */
export const AIR_ACCEL = 0.1;
/** Steps a sneaking player may drop without being stopped at an edge. */
export const SNEAK_PROBE_DEPTH = 0.6;
/** Granularity of the sneak edge guard. */
export const SNEAK_STEP = 0.05;
/**
 * A walking body (player, rabbit) on the ground steps up onto a WORLD ledge at most this high
 * instead of being stopped by it. Ships float at arbitrary heights and bob, so a pier built
 * "level" with a deck is practically never exactly level (ACCEPTANCE 19 走上码头). World terrain
 * steps are whole blocks, so this never lets anyone walk up terrain without jumping.
 */
export const STEP_HEIGHT = 0.6;

export const SWIM_SPEED = 2.0;
export const SWIM_SPRINT_SPEED = 2.6;
/** Share of the gap closed per tick while fully submerged. */
export const WATER_ACCEL = 0.2;
/** Downward acceleration of a fully submerged body (gravity minus buoyancy). */
export const WATER_SINK_ACCEL = 4;
/** Upward acceleration added while holding jump in water. */
export const SWIM_UP_ACCEL = 14;
/** Extra downward acceleration while holding sneak in water. */
export const SWIM_DOWN_ACCEL = 10;
/** Swimming up only works while at least this share of the body is wet (treading water). */
export const SWIM_MIN_WET = 0.3;
/** Vertical velocity kept per tick when fully submerged. */
export const WATER_DRAG = 0.8;
/**
 * Upward speed given when climbing out of water against a WORLD ledge (holding jump + moving
 * into it). Structure sides never give it: a swimmer next to a hull is never lifted aboard
 * (ACCEPTANCE 19 船转 45° 时在船角附近游泳，不会被拎上船).
 */
export const WATER_EXIT_SPEED = 7.5;
/** A body this wet and not on the ground is swimming (never kept by a carrier's column). */
export const SWIMMING_WET = 0.3;

export const LAVA_SPEED = 1.0;
export const LAVA_ACCEL = 0.15;
export const LAVA_SINK_ACCEL = 6;
export const LAVA_SWIM_UP_ACCEL = 10;
export const LAVA_DRAG = 0.6;

export const FLY_SPEED = 10;
export const FLY_SPRINT_MULTIPLIER = 1.8;
export const FLY_VERTICAL_SPEED = 7.5;
export const FLY_ACCEL = 0.3;
/** Two jump presses at most this many ticks apart toggle creative flying (300 ms). */
export const FLY_TOGGLE_TICKS = 6;

// ====================================================================== health

export const PLAYER_MAX_HEALTH = 20;
export const PLAYER_MAX_AIR = 300;
/** Ticks of invulnerability after taking damage. */
export const HURT_TICKS = 10;
/** Falls up to this height are harmless; beyond it 1 point per started block. */
export const FALL_SAFE_HEIGHT = 3.5;
/** Air regained per tick when the head is out of water. */
export const AIR_REFILL_PER_TICK = 5;
export const DROWN_DAMAGE = 2;
export const DROWN_INTERVAL_TICKS = 20;
export const LAVA_DAMAGE = 4;
export const LAVA_INTERVAL_TICKS = 10;
export const CRUSH_DAMAGE = 2;
/** Natural regeneration: +1 health every REGEN_INTERVAL_TICKS once unhurt for REGEN_DELAY_TICKS. */
export const REGEN_DELAY_TICKS = 100;
export const REGEN_INTERVAL_TICKS = 80;
/** Below this height an entity has fallen out of the world. */
export const VOID_Y = -64;
/** 'land' events are emitted for falls at least this high. */
export const LAND_EVENT_HEIGHT = 1;
/** 'splash' events when hitting water faster than this (downward). */
export const SPLASH_SPEED = 4;

// ====================================================================== items, falling blocks, crates

export const ITEM_GRAVITY = 16;
export const ITEM_TERMINAL_SPEED = 40;
/** Upward acceleration of a fully submerged item (floats with about 3/4 of it under water). */
export const ITEM_BUOYANCY = 22;
export const ITEM_GROUND_FRICTION = 0.6;
export const ITEM_AIR_DRAG = 0.98;
export const ITEM_WATER_DRAG = 0.85;
export const ITEM_PICKUP_DELAY = 10;
export const ITEM_DESPAWN_TICKS = 6000;
/** Pickup reach: the player's box grown by this much horizontally / vertically (~1.3 blocks from the centre). */
export const PICKUP_REACH_H = 1.0;
export const PICKUP_REACH_V = 0.5;
/** Identical stacks this close (box gap) merge. */
export const MERGE_REACH = 0.5;
export const MERGE_INTERVAL_TICKS = 10;

/** A falling block still airborne after this many ticks turns into an item drop. */
export const FALLING_MAX_TICKS = 600;

export const TNT_DEFAULT_FUSE = 80;
export const TNT_POWER = 4;
export const TNT_HOP_SPEED = 4;

// ====================================================================== rabbits

export const RABBIT_HOP_SPEED = 5.2;
export const RABBIT_HOP_FORWARD = 2.6;
export const RABBIT_SWIM_SPEED = 1.2;
/** A hop that would land above a drop deeper than this is refused. */
export const RABBIT_MAX_DROP = 3;
export const RABBIT_CRUSH_LIMIT = 3;
