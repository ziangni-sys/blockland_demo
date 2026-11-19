import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { Inventory, maxStackOf, pickBlockInto, pickBlockItem } from '../../src/entities/inventory';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { ByteReader, ByteWriter, SaveFormatError } from '../../src/save/bytes';

describe('Inventory', () => {
  it('add tops up existing stacks first, then empty hotbar slots, then the backpack', () => {
    const inv = new Inventory();
    inv.main[4] = { item: B.COBBLE, count: 60 };
    inv.hotbar[2] = { item: B.COBBLE, count: 63 };
    expect(inv.add(B.COBBLE, 10)).toBe(0);
    expect(inv.hotbar[2]!.count).toBe(64);
    expect(inv.main[4]!.count).toBe(64);
    expect(inv.hotbar[0]).toEqual({ item: B.COBBLE, count: 5 });
    // fill the hotbar: the next new item goes to the backpack
    for (let i = 0; i < 9; i++) if (inv.hotbar[i] === null) inv.hotbar[i] = { item: B.DIRT, count: 1 };
    expect(inv.add(B.SAND, 70)).toBe(0);
    expect(inv.main[0]).toEqual({ item: B.SAND, count: 64 });
    expect(inv.main[1]).toEqual({ item: B.SAND, count: 6 });
    expect(inv.count(B.SAND)).toBe(70);
    expect(inv.count(B.COBBLE)).toBe(64 + 64 + 5);
  });

  it('respects per-item stack limits and reports what does not fit', () => {
    const inv = new Inventory();
    expect(inv.add(I.BUCKET_WATER, 3)).toBe(0); // max stack 1
    expect(inv.hotbar.slice(0, 3).every((s) => s?.item === I.BUCKET_WATER && s.count === 1)).toBe(true);
    for (let i = 0; i < 9; i++) inv.hotbar[i] = { item: B.STONE, count: 64 };
    for (let i = 0; i < 27; i++) inv.main[i] = { item: B.STONE, count: 64 };
    expect(inv.add(B.STONE, 5)).toBe(5);
    expect(inv.add(B.DIRT, 5)).toBe(5);
    expect(inv.add(B.WATER, 5)).toBe(5); // not an item
    expect(inv.add(B.DIRT, 0)).toBe(0);
  });

  it('consume is all-or-nothing and prefers the selected slot', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: I.GLUE, count: 2 };
    inv.hotbar[3] = { item: I.GLUE, count: 2 };
    inv.main[0] = { item: I.GLUE, count: 5 };
    inv.selected = 3;
    expect(inv.consume(I.GLUE, 10)).toBe(false);
    expect(inv.count(I.GLUE)).toBe(9);
    expect(inv.consume(I.GLUE, 3)).toBe(true);
    expect(inv.hotbar[3]).toBeNull();
    expect(inv.hotbar[0]!.count).toBe(1);
    expect(inv.main[0]!.count).toBe(5);
    expect(inv.consumeSelected()).toBe(false);
    inv.selected = 0;
    expect(inv.selectedStack()).toEqual({ item: I.GLUE, count: 1 });
    expect(inv.consumeSelected()).toBe(true);
    expect(inv.selectedStack()).toBeNull();
    inv.hotbar[0] = { item: B.SAND, count: 3 };
    expect(inv.consumeSelected(4)).toBe(false);
    expect(inv.consumeSelected(3)).toBe(true);
    expect(inv.hotbar[0]).toBeNull();
  });

  it('left click: pick up, place, merge, swap', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.COBBLE, count: 40 };
    inv.hotbar[1] = { item: B.COBBLE, count: 50 };
    inv.main[0] = { item: B.DIRT, count: 7 };
    inv.slotClick('hotbar', 0, 0, false); // pick up 40 cobble
    expect(inv.cursor).toEqual({ item: B.COBBLE, count: 40 });
    expect(inv.hotbar[0]).toBeNull();
    inv.slotClick('hotbar', 1, 0, false); // merge: 50 + 14 = 64, 26 stay on the cursor
    expect(inv.hotbar[1]!.count).toBe(64);
    expect(inv.cursor).toEqual({ item: B.COBBLE, count: 26 });
    inv.slotClick('inventory', 0, 0, false); // swap with dirt
    expect(inv.main[0]).toEqual({ item: B.COBBLE, count: 26 });
    expect(inv.cursor).toEqual({ item: B.DIRT, count: 7 });
    inv.slotClick('inventory', 5, 0, false); // place into an empty slot
    expect(inv.main[5]).toEqual({ item: B.DIRT, count: 7 });
    expect(inv.cursor).toBeNull();
    inv.slotClick('inventory', 6, 0, false); // empty on empty: nothing
    expect(inv.cursor).toBeNull();
    inv.slotClick('inventory', 99, 0, false); // out of range: ignored
    inv.slotClick('hotbar', -1, 0, false);
    expect(inv.cursor).toBeNull();
  });

  it('right click: pick up half, place one, swap different items', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.SAND, count: 9 };
    inv.slotClick('hotbar', 0, 2, false);
    expect(inv.cursor).toEqual({ item: B.SAND, count: 5 });
    expect(inv.hotbar[0]!.count).toBe(4);
    inv.slotClick('hotbar', 1, 2, false); // place one into an empty slot
    expect(inv.hotbar[1]).toEqual({ item: B.SAND, count: 1 });
    inv.slotClick('hotbar', 0, 2, false); // place one onto the same item
    expect(inv.hotbar[0]!.count).toBe(5);
    expect(inv.cursor!.count).toBe(3);
    inv.main[0] = { item: B.DIRT, count: 2 };
    inv.slotClick('inventory', 0, 2, false); // different item: swap
    expect(inv.main[0]).toEqual({ item: B.SAND, count: 3 });
    expect(inv.cursor).toEqual({ item: B.DIRT, count: 2 });
    inv.cursor = { item: B.DIRT, count: 1 };
    inv.slotClick('inventory', 3, 2, false);
    expect(inv.cursor).toBeNull();
    // full stack does not accept one more
    inv.hotbar[5] = { item: B.STONE, count: 64 };
    inv.cursor = { item: B.STONE, count: 3 };
    inv.slotClick('hotbar', 5, 2, false);
    expect(inv.hotbar[5]!.count).toBe(64);
    expect(inv.cursor!.count).toBe(3);
    // half of 1 is 1
    inv.cursor = null;
    inv.main[9] = { item: B.GLASS, count: 1 };
    inv.slotClick('inventory', 9, 2, false);
    expect(inv.cursor).toEqual({ item: B.GLASS, count: 1 });
    expect(inv.main[9]).toBeNull();
  });

  it('shift click moves the stack to the other area, topping up first', () => {
    const inv = new Inventory();
    inv.main[3] = { item: B.COBBLE, count: 30 };
    inv.hotbar[4] = { item: B.COBBLE, count: 50 };
    inv.cursor = { item: B.DIRT, count: 1 };
    inv.slotClick('inventory', 3, 0, true);
    expect(inv.hotbar[4]!.count).toBe(64);
    expect(inv.hotbar[0]).toEqual({ item: B.COBBLE, count: 16 });
    expect(inv.main[3]).toBeNull();
    expect(inv.cursor).toEqual({ item: B.DIRT, count: 1 }); // untouched
    inv.slotClick('hotbar', 0, 2, true);
    expect(inv.main[0]).toEqual({ item: B.COBBLE, count: 16 });
    expect(inv.hotbar[0]).toBeNull();
    // nothing fits: stays
    for (let i = 0; i < 9; i++) inv.hotbar[i] = { item: B.STONE, count: 64 };
    inv.slotClick('inventory', 0, 0, true);
    expect(inv.main[0]).toEqual({ item: B.COBBLE, count: 16 });
  });

  it('creativePick: full stack on the cursor, or straight into the hotbar with shift', () => {
    const inv = new Inventory();
    inv.cursor = { item: B.DIRT, count: 3 };
    inv.creativePick(B.GLASS, false);
    expect(inv.cursor).toEqual({ item: B.GLASS, count: 64 });
    inv.creativePick(I.BUCKET_WATER, false);
    expect(inv.cursor).toEqual({ item: I.BUCKET_WATER, count: 1 });
    inv.hotbar[2] = { item: B.SAND, count: 5 };
    inv.creativePick(B.SAND, true);
    expect(inv.hotbar[2]).toEqual({ item: B.SAND, count: 64 });
    inv.creativePick(B.BRICKS, true);
    expect(inv.hotbar[0]).toEqual({ item: B.BRICKS, count: 64 });
    for (let i = 0; i < 9; i++) inv.hotbar[i] = { item: B.STONE, count: 1 };
    inv.selected = 6;
    inv.creativePick(B.LAMP, true);
    expect(inv.hotbar[6]).toEqual({ item: B.LAMP, count: 64 });
    expect(inv.takeCursor()).toEqual({ item: I.BUCKET_WATER, count: 1 });
    expect(inv.cursor).toBeNull();
    inv.clear();
    expect(inv.hotbar.every((s) => s === null) && inv.main.every((s) => s === null)).toBe(true);
    expect(inv.selected).toBe(0);
  });

  it('serialize / deserialize round trip, and rejects garbage', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.COBBLE, count: 12 };
    inv.hotbar[8] = { item: I.GLUE, count: 64 };
    inv.main[26] = { item: I.BUCKET, count: 3 };
    inv.cursor = { item: B.SAND, count: 1 };
    inv.offhand = { item: I.GLUE, count: 17 };
    inv.selected = 8;
    const w = new ByteWriter();
    inv.serialize(w);
    const bytes = w.finish();
    const back = new Inventory();
    back.hotbar[3] = { item: B.DIRT, count: 1 };
    back.deserialize(new ByteReader(bytes, 'inv'));
    expect(back.hotbar).toEqual(inv.hotbar);
    expect(back.main).toEqual(inv.main);
    expect(back.cursor).toEqual(inv.cursor);
    expect(back.offhand).toEqual({ item: I.GLUE, count: 17 });
    expect(back.selected).toBe(8);
    expect(() => new Inventory().deserialize(new ByteReader(bytes.slice(0, 10), 'inv'))).toThrow(SaveFormatError);
    const bad = bytes.slice();
    bad[0] = 99;
    expect(() => new Inventory().deserialize(new ByteReader(bad, 'inv'))).toThrow(SaveFormatError);
  });

  it('the off-hand: a slot like the others for counting, consuming and clearing; pickups only top it up', () => {
    const inv = new Inventory();
    expect(inv.offhand).toBeNull();
    inv.offhand = { item: I.GLUE, count: 60 };
    expect(inv.count(I.GLUE)).toBe(60);
    // A pickup tops the off-hand stack up but never fills an empty off-hand.
    expect(inv.add(I.GLUE, 10)).toBe(0);
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 64 });
    expect(inv.hotbar[0]).toEqual({ item: I.GLUE, count: 6 });
    const empty = new Inventory();
    empty.add(B.STONE, 5);
    expect(empty.offhand).toBeNull();
    // consume takes from the off-hand last.
    expect(inv.consume(I.GLUE, 10)).toBe(true);
    expect(inv.hotbar[0]).toBeNull();
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 60 });
    expect(inv.consume(I.GLUE, 61)).toBe(false);
    expect(inv.consumeOffhand(59)).toBe(true);
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 1 });
    expect(inv.consumeOffhand(2)).toBe(false);
    expect(inv.consumeOffhand(1)).toBe(true);
    expect(inv.offhand).toBeNull();
    expect(inv.consumeOffhand(1)).toBe(false);
    inv.offhand = { item: B.DIRT, count: 3 };
    inv.clear();
    expect(inv.offhand).toBeNull();
  });

  it('swapOffhand swaps the selected hotbar stack with the off-hand, either side may be empty', () => {
    const inv = new Inventory();
    inv.selected = 4;
    inv.hotbar[4] = { item: I.GLUE, count: 8 };
    inv.swapOffhand();
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 8 });
    expect(inv.hotbar[4]).toBeNull();
    inv.swapOffhand();
    expect(inv.hotbar[4]).toEqual({ item: I.GLUE, count: 8 });
    expect(inv.offhand).toBeNull();
    inv.offhand = { item: B.STONE, count: 2 };
    inv.swapOffhand();
    expect(inv.hotbar[4]).toEqual({ item: B.STONE, count: 2 });
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 8 });
  });

  it('slotClick on the off-hand: pick up, place, merge, half, and shift moves it into the hotbar', () => {
    const inv = new Inventory();
    inv.offhand = { item: I.GLUE, count: 10 };
    inv.slotClick('offhand', 0, 0, false); // pick up
    expect(inv.cursor).toEqual({ item: I.GLUE, count: 10 });
    expect(inv.offhand).toBeNull();
    inv.slotClick('offhand', 0, 2, false); // place one
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 1 });
    inv.slotClick('offhand', 0, 0, false); // merge the rest
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 10 });
    expect(inv.cursor).toBeNull();
    inv.slotClick('offhand', 0, 2, false); // half
    expect(inv.cursor).toEqual({ item: I.GLUE, count: 5 });
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 5 });
    inv.cursor = null;
    inv.slotClick('offhand', 1, 0, false); // the off-hand has one slot
    expect(inv.cursor).toBeNull();
    inv.slotClick('offhand', 0, 0, true); // shift: into the hotbar
    expect(inv.offhand).toBeNull();
    expect(inv.hotbar[0]).toEqual({ item: I.GLUE, count: 5 });
    inv.slotClick('hotbar', 0, 0, true); // shift from the hotbar goes to the backpack, not the off-hand
    expect(inv.offhand).toBeNull();
    expect(inv.main[0]).toEqual({ item: I.GLUE, count: 5 });
  });
});

describe('pick block and closing the screen as pure functions on the inventory (NETCODE section 10)', () => {
  it('pickBlockItem: the block itself; nothing for air, liquids, the unloaded sentinel', () => {
    expect(pickBlockItem(makeCell(B.STONE))).toBe(B.STONE);
    expect(pickBlockItem(makeCell(B.LOG_OAK, 2))).toBe(B.LOG_OAK);
    expect(pickBlockItem(makeCell(B.AIR))).toBe(-1);
    expect(pickBlockItem(makeCell(B.WATER, liquidState(0, false)))).toBe(-1);
    expect(pickBlockItem(makeCell(B.UNLOADED))).toBe(-1);
  });

  it('pickBlockInto: hotbar first; creative fills the selected empty slot, else the first empty one, else replaces; survival swaps from the backpack or does nothing', () => {
    const inv = new Inventory();
    inv.hotbar[4] = { item: B.STONE, count: 3 };
    expect(pickBlockInto(inv, B.STONE, false)).toBe(true);
    expect(inv.selected).toBe(4);
    // creative, not in the hotbar: the selected slot when empty
    inv.selected = 1;
    expect(pickBlockInto(inv, B.GLASS, true)).toBe(true);
    expect(inv.hotbar[1]).toEqual({ item: B.GLASS, count: maxStackOf(B.GLASS) });
    // ... else the first empty slot
    expect(pickBlockInto(inv, B.BRICKS, true)).toBe(true);
    expect(inv.selected).toBe(0);
    expect(inv.hotbar[0]!.item).toBe(B.BRICKS);
    // ... else it replaces the selected slot
    for (let i = 0; i < 9; i++) inv.hotbar[i] ??= { item: B.DIRT, count: 1 };
    inv.selected = 8;
    expect(pickBlockInto(inv, B.SAND, true)).toBe(true);
    expect(inv.hotbar[8]!.item).toBe(B.SAND);
    // survival: from the backpack, swapping with the selected slot; nothing created
    const s = new Inventory();
    s.hotbar[2] = { item: B.DIRT, count: 7 };
    s.main[5] = { item: B.GLASS, count: 2 };
    s.selected = 2;
    expect(pickBlockInto(s, B.GLASS, false)).toBe(true);
    expect(s.hotbar[2]).toEqual({ item: B.GLASS, count: 2 });
    expect(s.main[5]).toEqual({ item: B.DIRT, count: 7 });
    expect(pickBlockInto(s, B.BRICKS, false)).toBe(false);
    expect(s.count(B.BRICKS)).toBe(0);
    // the off-hand is never involved
    s.offhand = { item: B.LAMP, count: 1 };
    expect(pickBlockInto(s, B.LAMP, false)).toBe(false);
  });

  it('stowCursor: the cursor goes back like a pickup; what does not fit is returned, off the cursor', () => {
    const inv = new Inventory();
    inv.cursor = { item: B.COBBLE, count: 20 };
    expect(inv.stowCursor()).toBeNull();
    expect(inv.cursor).toBeNull();
    expect(inv.count(B.COBBLE)).toBe(20);
    for (let i = 0; i < 9; i++) inv.hotbar[i] = { item: B.DIRT, count: 64 };
    for (let i = 0; i < 27; i++) inv.main[i] = { item: B.DIRT, count: 64 };
    inv.hotbar[0] = { item: B.COBBLE, count: 60 };
    inv.cursor = { item: B.COBBLE, count: 10 };
    expect(inv.stowCursor()).toEqual({ item: B.COBBLE, count: 6 });
    expect(inv.cursor).toBeNull();
    expect(inv.hotbar[0]!.count).toBe(64);
    expect(inv.stowCursor()).toBeNull();
  });
});
