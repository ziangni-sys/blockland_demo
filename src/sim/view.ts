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

/** What one player's actions look like right now. Rebuilt by the simulation every tick, per joined player. */
export interface InteractionView {
  /** The cell the player is looking at within reach (and the face), or null. */
  target: (GridCell & { face: Dir }) | null;
  /** Mining progress on the target, 0..1 (0 = not mining). */
  breakProgress: number;
  /** Cells that the pending assembly would take (first right-click on a helm / bearing). */
  preview: { gridId: number; kind: 'ship' | 'rotor'; cells: Int32Array /* x,y,z triples */ } | null;
  /** World cells that blocked the last docking attempt (shown in red for a moment). */
  conflicts: Array<{ x: number; y: number; z: number }>;
  /** Progress of the timed survival glue operation on the target face, 0..1 (0 = none). */
  glueProgress: number;
  /** Hint shown under the crosshair, or null. */
  hint: Message | null;
}

export function emptyView(): InteractionView {
  return { target: null, breakProgress: 0, preview: null, conflicts: [], glueProgress: 0, hint: null };
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
