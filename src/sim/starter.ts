/**
 * The starter items: what a player gets the first time it enters a world (docs/NETCODE.md
 * section 17 item 5: every player, guests included). Enough to build a raft with a helm and a
 * small windmill right away, so the core of the game is in the player's hands from the first
 * minute. The single-player client (client/game.ts) gives them in a new world; the server host
 * (net/host/host.ts) to every identity that joins a world for the first time.
 */
import { B } from '../blocks/defs';
import { I } from '../blocks/items';
import type { PlayerControl } from './players';

/** [item, count] in the order they go into the inventory. */
export const STARTER_ITEMS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [B.PLANKS_OAK, 64],
  [B.WOOL_WHITE, 32],
  [B.CANVAS, 32],
  [B.HELM, 1],
  [B.BEARING, 2],
  [I.GLUE, 16],
  [B.LOG_OAK, 16],
  [B.COBBLE, 32],
  [I.BUCKET_WATER, 1],
] as const);

/** Put the starter items into a joined player's inventory. */
export function giveStarterItems(me: PlayerControl): void {
  for (const [item, count] of STARTER_ITEMS) me.giveItem(item, count);
}
