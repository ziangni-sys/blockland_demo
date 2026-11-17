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

/** What the player's actions look like right now. Rebuilt by the simulation every tick. */
export interface InteractionView {
  /** The cell the player is looking at within reach (and the face), or null. */
  target: (GridCell & { face: Dir }) | null;
  /** Mining progress on the target, 0..1 (0 = not mining). */
  breakProgress: number;
  /** Cells that the pending assembly would take (first right-click on a helm / bearing). */
  preview: { gridId: number; kind: 'ship' | 'rotor'; cells: Int32Array /* x,y,z triples */ } | null;
  /** World cells that blocked the last docking attempt (shown in red for a moment). */
  conflicts: Array<{ x: number; y: number; z: number }>;
  /** First block picked for a glue operation, or null. */
  glueAnchor: GridCell | null;
  /** Progress of a glue operation in survival, 0..1. */
  glueProgress: number;
  /** Hint shown under the crosshair, or null. */
  hint: Message | null;
}

export function emptyView(): InteractionView {
  return { target: null, breakProgress: 0, preview: null, conflicts: [], glueAnchor: null, glueProgress: 0, hint: null };
}

/** Things that happened during a tick, for the client (sounds, particles, toasts). */
export type SimEvent =
  | { type: 'toast'; message: Message; kind: 'info' | 'warn' | 'error' }
  | { type: 'blockBroken'; gridId: number; x: number; y: number; z: number; cell: number }
  | { type: 'blockPlaced'; gridId: number; x: number; y: number; z: number; cell: number }
  | { type: 'explosion'; x: number; y: number; z: number; power: number }
  | { type: 'structureAdded'; id: number }
  | { type: 'structureRemoved'; id: number }
  | { type: 'playerHurt'; amount: number; cause: string }
  | { type: 'playerDied'; cause: string }
  | { type: 'sound'; name: string; x: number; y: number; z: number };
