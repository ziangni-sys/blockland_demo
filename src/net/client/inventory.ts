/**
 * Inventory prediction on the client (docs/NETCODE.md section 10): InventoryPredictor.
 *
 * Inventory actions — a click on a slot, the creative palette, swapping hands, selecting a slot,
 * pick block, dropping the cursor stack, closing the screen — are pure functions of the inventory
 * (entities/inventory.ts; pick block also reads the replica's cell, which the action carries as the
 * item it picks), so the client computes the same result the server will. The predictor keeps the
 * server's inventory as last received and every action sent since that the server has not
 * acknowledged (seq above the batch's `ack`): the inventory shown is the server's with those
 * replayed on top, recomputed whenever the server's inventory or ack arrives. So an action shows at
 * once; one the server resolved differently (a pickup filled the slot meanwhile, a swap of a dead
 * player was consumed) snaps to the server's result when its ack arrives; nothing the server did
 * not do stays, and nothing it did is lost, whatever the link loses or reorders (both travel on the
 * reliable channel, and the ack comes with the inventory it produced).
 *
 * What changes the inventory without an inventory action (placing, mining, pickups, buckets,
 * glue) is not predicted: it shows when the server's inventory arrives.
 */
import type { ItemStack } from '../../blocks/items';
import { HOTBAR_SLOTS, Inventory, MAIN_SLOTS, pickBlockInto } from '../../entities/inventory';
import type { InventoryArea, NetInventory } from '../protocol';

/** An inventory action as the predictor replays it (the intents of the same name). */
export type InventoryAction =
  | { kind: 'swapHands' }
  | { kind: 'selectSlot'; slot: number }
  | { kind: 'invClick'; area: InventoryArea; index: number; button: 0 | 2; shift: boolean }
  | { kind: 'creativePick'; item: number; shift: boolean }
  /** `item`: what the part aimed at in the replica picks (entities/inventory.ts pickBlockItem of partAt(target.cell, target.sub)). */
  | { kind: 'pickBlock'; item: number }
  | { kind: 'dropCursor' }
  | { kind: 'closeInventory' };

/** Apply one action to an inventory, as the server does (`creative`: the player's mode). */
export function applyInventoryAction(inv: Inventory, a: InventoryAction, creative: boolean): void {
  switch (a.kind) {
    case 'swapHands':
      inv.swapOffhand();
      return;
    case 'selectSlot':
      if (Number.isInteger(a.slot) && a.slot >= 0 && a.slot < HOTBAR_SLOTS) inv.selected = a.slot;
      return;
    case 'invClick':
      inv.slotClick(a.area, a.index, a.button, a.shift);
      return;
    case 'creativePick':
      if (creative) inv.creativePick(a.item, a.shift);
      return;
    case 'pickBlock':
      if (a.item >= 0) pickBlockInto(inv, a.item, creative);
      return;
    case 'dropCursor':
      inv.takeCursor();
      return;
    case 'closeInventory':
      // What does not fit is thrown into the world by the server: it shows as a drop.
      inv.stowCursor();
      return;
  }
}

function copyStack(s: ItemStack | null): ItemStack | null {
  return s === null ? null : { item: s.item, count: s.count };
}

/** An Inventory holding a copy of `n`. */
export function inventoryFrom(n: NetInventory): Inventory {
  const inv = new Inventory();
  for (let i = 0; i < HOTBAR_SLOTS; i++) inv.hotbar[i] = copyStack(n.hotbar[i] ?? null);
  for (let i = 0; i < MAIN_SLOTS; i++) inv.main[i] = copyStack(n.main[i] ?? null);
  inv.offhand = copyStack(n.offhand);
  inv.cursor = copyStack(n.cursor);
  inv.selected = n.selected;
  return inv;
}

export class InventoryPredictor {
  private server: NetInventory | null = null;
  private ackValue: number | null = null;
  private creative = false;
  /** Actions sent and not acknowledged yet, by seq ascending. */
  private readonly pending: Array<{ seq: number; action: InventoryAction }> = [];
  private shown: Inventory | null = null;

  /**
   * What the server said in a batch (the replica's private state after applying it): its inventory
   * and ack (either may be unchanged), and the player's mode (null: unknown yet).
   */
  update(inventory: NetInventory | null, ack: number | null, creative: boolean): void {
    if (inventory !== this.server || ack !== this.ackValue || creative !== this.creative) this.shown = null;
    this.server = inventory;
    this.ackValue = ack;
    this.creative = creative;
    if (ack !== null) {
      let k = 0;
      while (k < this.pending.length && this.pending[k]!.seq <= ack) k++;
      if (k > 0) this.pending.splice(0, k);
    }
  }

  /** An inventory action was sent as intent `seq`: it shows at once. */
  predict(seq: number, action: InventoryAction): void {
    this.pending.push({ seq, action });
    if (this.shown !== null) applyInventoryAction(this.shown, action, this.creative);
  }

  /** The inventory to show (do not change it): the server's with the unacknowledged actions replayed; null before the server's first. */
  get inventory(): Inventory | null {
    if (this.shown === null && this.server !== null) {
      const inv = inventoryFrom(this.server);
      for (const p of this.pending) applyInventoryAction(inv, p.action, this.creative);
      this.shown = inv;
    }
    return this.shown;
  }

  /** The server's ack as last received. */
  get ack(): number | null {
    return this.ackValue;
  }

  /** Actions waiting for the server's ack. */
  get unacknowledged(): number {
    return this.pending.length;
  }
}
