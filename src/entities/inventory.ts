/**
 * The player's inventory: 9 hotbar slots, 27 backpack slots and the stack held by the mouse
 * cursor while the inventory screen is open.
 *
 * Stack objects stored in the slots belong to the inventory: read them freely, but change
 * counts only through these methods (or replace the slot) — a stack object is never shared
 * between two slots.
 */
import { isItem, itemDef, type ItemStack } from '../blocks/items';
import type { ByteReader, ByteWriter } from '../save/bytes';

export const HOTBAR_SLOTS = 9;
export const MAIN_SLOTS = 27;

const SAVE_VERSION = 1;

export type InventoryArea = 'hotbar' | 'inventory';

/** Largest stack of an item (unknown items: 1, so a corrupt id can never multiply). */
export function maxStackOf(item: number): number {
  return isItem(item) ? itemDef(item).maxStack : 1;
}

function emptySlots(n: number): Array<ItemStack | null> {
  const a: Array<ItemStack | null> = [];
  for (let i = 0; i < n; i++) a.push(null);
  return a;
}

export class Inventory {
  readonly hotbar: Array<ItemStack | null> = emptySlots(HOTBAR_SLOTS);
  readonly main: Array<ItemStack | null> = emptySlots(MAIN_SLOTS);
  /** Stack held by the mouse cursor (inventory screen). */
  cursor: ItemStack | null = null;
  /** Selected hotbar slot 0..8. */
  selected = 0;

  selectedStack(): ItemStack | null {
    return this.hotbar[this.selected] ?? null;
  }

  /**
   * Put `count` of `item` into the inventory: first topping up existing stacks of the item
   * (hotbar, then backpack), then into empty hotbar slots, then empty backpack slots.
   * Returns the amount that did not fit.
   */
  add(item: number, count: number): number {
    if (!(count > 0)) return 0;
    count = Math.floor(count);
    if (!isItem(item)) return count;
    const max = maxStackOf(item);
    let left = count;
    left = this.topUp(this.hotbar, item, left, max);
    left = this.topUp(this.main, item, left, max);
    left = this.fillEmpty(this.hotbar, item, left, max);
    left = this.fillEmpty(this.main, item, left, max);
    return left;
  }

  /** Total count of `item` in the hotbar and the backpack (not the cursor). */
  count(item: number): number {
    let n = 0;
    for (const s of this.hotbar) if (s !== null && s.item === item) n += s.count;
    for (const s of this.main) if (s !== null && s.item === item) n += s.count;
    return n;
  }

  /**
   * Remove `count` of `item`, preferring the selected slot, then the hotbar, then the backpack.
   * All or nothing: returns false (and removes nothing) when there are not enough.
   */
  consume(item: number, count: number): boolean {
    if (!(count > 0)) return true;
    if (this.count(item) < count) return false;
    let left = count;
    left = this.takeFrom(this.hotbar, this.selected, item, left);
    for (let i = 0; i < HOTBAR_SLOTS && left > 0; i++) left = this.takeFrom(this.hotbar, i, item, left);
    for (let i = 0; i < MAIN_SLOTS && left > 0; i++) left = this.takeFrom(this.main, i, item, left);
    return true;
  }

  /** Remove `count` from the selected stack. False (nothing removed) when it holds fewer. */
  consumeSelected(count = 1): boolean {
    const s = this.selectedStack();
    if (s === null || s.count < count) return false;
    s.count -= count;
    if (s.count <= 0) this.hotbar[this.selected] = null;
    return true;
  }

  /**
   * A click on a slot of the inventory screen.
   *  - left  (0): empty cursor picks the stack up; otherwise place it into an empty slot, merge
   *               into the same item (as far as it fits) or swap with a different item.
   *  - right (2): empty cursor picks up half (rounded up); otherwise place one item into an
   *               empty slot or onto the same item; a different item is swapped.
   *  - shift    : move the slot's whole stack to the other area (hotbar <-> backpack), topping
   *               up existing stacks first; whatever does not fit stays. The cursor is untouched.
   */
  slotClick(area: InventoryArea, index: number, button: 0 | 2, shift: boolean): void {
    const slots = area === 'hotbar' ? this.hotbar : this.main;
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) return;
    const slot = slots[index] ?? null;
    if (shift) {
      if (slot === null) return;
      const other = area === 'hotbar' ? this.main : this.hotbar;
      const max = maxStackOf(slot.item);
      let left = this.topUp(other, slot.item, slot.count, max);
      left = this.fillEmpty(other, slot.item, left, max);
      if (left <= 0) slots[index] = null;
      else slot.count = left;
      return;
    }
    const cur = this.cursor;
    if (button === 0) {
      if (cur === null) {
        this.cursor = slot;
        slots[index] = null;
      } else if (slot === null) {
        slots[index] = cur;
        this.cursor = null;
      } else if (slot.item === cur.item) {
        const max = maxStackOf(slot.item);
        const moved = Math.min(cur.count, Math.max(0, max - slot.count));
        slot.count += moved;
        cur.count -= moved;
        if (cur.count <= 0) this.cursor = null;
      } else {
        slots[index] = cur;
        this.cursor = slot;
      }
      return;
    }
    // right button
    if (cur === null) {
      if (slot === null) return;
      const take = Math.ceil(slot.count / 2);
      this.cursor = { item: slot.item, count: take };
      slot.count -= take;
      if (slot.count <= 0) slots[index] = null;
    } else if (slot === null) {
      slots[index] = { item: cur.item, count: 1 };
      cur.count -= 1;
      if (cur.count <= 0) this.cursor = null;
    } else if (slot.item === cur.item) {
      if (slot.count < maxStackOf(slot.item)) {
        slot.count += 1;
        cur.count -= 1;
        if (cur.count <= 0) this.cursor = null;
      }
    } else {
      slots[index] = cur;
      this.cursor = slot;
    }
  }

  /**
   * Creative palette: a full stack of `item` on the cursor (replacing whatever it held). With
   * shift the stack goes straight into the hotbar instead: an existing stack of the item is
   * filled up, else the first empty slot, else the selected slot is replaced.
   */
  creativePick(item: number, shift: boolean): void {
    if (!isItem(item)) return;
    const max = maxStackOf(item);
    if (!shift) {
      this.cursor = { item, count: max };
      return;
    }
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const s = this.hotbar[i];
      if (s && s.item === item) {
        s.count = max;
        return;
      }
    }
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (this.hotbar[i] === null) {
        this.hotbar[i] = { item, count: max };
        return;
      }
    }
    this.hotbar[this.selected] = { item, count: max };
  }

  /** Remove and return the cursor stack (closing the screen, dropping it). */
  takeCursor(): ItemStack | null {
    const c = this.cursor;
    this.cursor = null;
    return c;
  }

  clear(): void {
    this.hotbar.fill(null);
    this.main.fill(null);
    this.cursor = null;
    this.selected = 0;
  }

  // ------------------------------------------------------------ save

  serialize(w: ByteWriter): void {
    w.u8(SAVE_VERSION);
    w.u8(this.selected);
    for (const s of this.hotbar) writeSlot(w, s);
    for (const s of this.main) writeSlot(w, s);
    writeSlot(w, this.cursor);
  }

  /** Replace the whole content. Stacks of items that no longer exist are dropped. */
  deserialize(r: ByteReader): void {
    const v = r.u8();
    if (v !== SAVE_VERSION) r.fail(`unsupported inventory version ${v}`);
    const sel = r.u8();
    if (sel >= HOTBAR_SLOTS) r.fail(`bad selected slot ${sel}`);
    this.selected = sel;
    for (let i = 0; i < HOTBAR_SLOTS; i++) this.hotbar[i] = readSlot(r);
    for (let i = 0; i < MAIN_SLOTS; i++) this.main[i] = readSlot(r);
    this.cursor = readSlot(r);
  }

  // ------------------------------------------------------------ helpers

  private topUp(slots: Array<ItemStack | null>, item: number, left: number, max: number): number {
    for (let i = 0; i < slots.length && left > 0; i++) {
      const s = slots[i];
      if (!s || s.item !== item || s.count >= max) continue;
      const n = Math.min(max - s.count, left);
      s.count += n;
      left -= n;
    }
    return left;
  }

  private fillEmpty(slots: Array<ItemStack | null>, item: number, left: number, max: number): number {
    for (let i = 0; i < slots.length && left > 0; i++) {
      if (slots[i] !== null) continue;
      const n = Math.min(max, left);
      slots[i] = { item, count: n };
      left -= n;
    }
    return left;
  }

  private takeFrom(slots: Array<ItemStack | null>, i: number, item: number, left: number): number {
    const s = slots[i];
    if (!s || s.item !== item || left <= 0) return left;
    const n = Math.min(s.count, left);
    s.count -= n;
    if (s.count <= 0) slots[i] = null;
    return left - n;
  }
}

function writeSlot(w: ByteWriter, s: ItemStack | null): void {
  if (s === null || s.count <= 0) {
    w.varuint(0);
    return;
  }
  w.varuint(s.item + 1);
  w.varuint(s.count);
}

function readSlot(r: ByteReader): ItemStack | null {
  const tag = r.varuint();
  if (tag === 0) return null;
  const item = tag - 1;
  const count = r.varuint();
  if (count === 0) r.fail('empty stack in a filled slot');
  if (!isItem(item)) return null;
  return { item, count: Math.min(count, maxStackOf(item)) };
}
