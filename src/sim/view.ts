/**
 * Read-only data the simulation publishes for the client (contract).
 * The client turns it into render overlays, UI hints and toasts; it never reaches into
 * the interaction code.
 */
import type { Dir } from '../core/dirs';

/** A localisable message: key into the table in src/sim/messages.ts + parameters. */
export interface Message {
  key: string;
  params?: Record<string, number | string>;
}

/** A cell of some grid. gridId 0 = the world, otherwise a structure id (local coordinates). */
export interface GridCell {
  gridId: number;
  x: number;
  y: number;
  z: number;
}

/**
 * A cell a player aims at (docs/NETCODE.md section 10, docs/SHAPES.md 6.3): grid-local cell, the
 * face the ray entered the hit octant by (an inner face of a partial cell included), the octant
 * hit, and the whole (packed) cell seen there. The part aimed at is the one containing that octant
 * (blocks/shapes.ts partAt(cell, sub)). What the client of a client-driven player claims
 * (PlayerControl.claimAim), and what its intents carry (the protocol's Target).
 */
export interface AimTarget extends GridCell {
  face: Dir;
  /** The octant hit, 0..7 (voxel/raycast.ts GridHit.octant). */
  sub: number;
  cell: number;
}

/** The part being mined in survival and its progress (NETCODE section 9, docs/SHAPES.md 6.2, 6.3). */
export interface MiningState extends GridCell {
  /**
   * Bits 0..2: the octant of the mined part the mining ray hit when this mining started (it stays
   * while the crosshair moves over the same part). Bit 3: the progress is for that one octant only
   * (the M2.4 chisel); always 0 in M2.3. Bits 4..7 are 0.
   */
  sub: number;
  /** 0..1. */
  progress: number;
}

/** The face of the timed survival glue operation and its progress (NETCODE section 9). */
export interface GluingState extends MiningState {
  face: Dir;
  /** Always 0: glue belongs to a cell face, not to a part (docs/SHAPES.md 6.2, 6.3). */
  sub: number;
}

/** What one player's actions look like right now. Rebuilt by the simulation every tick, per joined player. */
export interface InteractionView {
  /**
   * The cell the player is looking at within reach (and the face), or null: the use ray's hit (a
   * client-driven player's claimed use target), or the cell being mined while digging with a bucket
   * or glue in hand. Not sent: a client computes its own (NETCODE section 10).
   */
  target: (GridCell & { face: Dir }) | null;
  /** The cell being mined (survival, once it made progress), wherever the player looks now; null when none. */
  mining: MiningState | null;
  /** Cells that the pending assembly would take (first right-click on a helm / bearing). */
  preview: { gridId: number; kind: 'ship' | 'rotor'; cells: Int32Array /* x,y,z triples */ } | null;
  /** World cells that blocked the last docking attempt (shown in red for a moment). */
  conflicts: Array<{ x: number; y: number; z: number }>;
  /** The timed survival glue operation in progress, or null. */
  gluing: GluingState | null;
  /** Hint shown under the crosshair, or null. */
  hint: Message | null;
}

export function emptyView(): InteractionView {
  return { target: null, mining: null, preview: null, conflicts: [], gluing: null, hint: null };
}

/** Steering read-out of a player who holds a helm. */
export interface HelmView {
  throttle: number;
  rudder: number;
  /** Horizontal speed, blocks per second. */
  speed: number;
  sails: number;
}

/**
 * The stable identity of a player in a world, chosen by whoever joins it (sim/players.ts). Not
 * the entity id (which a player keeps from its first join, but which is not chosen by the caller).
 */
export type PlayerKey = string;

/**
 * Things that happened during a tick, for the clients (sounds, particles, toasts).
 *
 * ADDRESSED events concern one player and name it (`player`); only that player's client acts on
 * them. WORLD events are for everyone and carry a position (or a grid) so that a server can later
 * send them only to the clients that can see them.
 */
export type SimEvent =
  // ---- addressed
  | { type: 'toast'; player: PlayerKey; message: Message; kind: 'info' | 'warn' | 'error' }
  | { type: 'playerHurt'; player: PlayerKey; amount: number; cause: string }
  | { type: 'playerDied'; player: PlayerKey; cause: string }
  /** The player took `count` items of `item` from a drop. */
  | { type: 'playerPickup'; player: PlayerKey; item: number; count: number }
  /** The player let go of a ship's wheel; cause = 'stopped' | 'death' | 'removed' | 'respawn' | 'pushed' | ... (EntityManager). */
  | { type: 'helmReleased'; player: PlayerKey; cause: string }
  // ---- world
  /** One part was mined away (or placed): `cell` is that PART's value (blocks/cell.ts; < 2^24, no second part). */
  | { type: 'blockBroken'; gridId: number; x: number; y: number; z: number; cell: number }
  | { type: 'blockPlaced'; gridId: number; x: number; y: number; z: number; cell: number }
  | { type: 'explosion'; x: number; y: number; z: number; power: number }
  | { type: 'structureAdded'; id: number }
  | { type: 'structureRemoved'; id: number }
  | { type: 'sound'; name: string; x: number; y: number; z: number };

/** The player an addressed event is for, or null for a world event (for everyone). */
export function eventPlayer(ev: SimEvent): PlayerKey | null {
  return 'player' in ev ? ev.player : null;
}
