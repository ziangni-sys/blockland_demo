/**
 * Package 7 end to end: the client's inventory prediction (net/client/inventory.ts InventoryPredictor;
 * NETCODE section 10 哪些立刻预测).
 *  - An action the server resolves differently (a pickup filled the slot meanwhile) shows the
 *    prediction at once and snaps to the server's inventory when its ack arrives.
 *  - Random inventory actions with pickups in between, on each link: the client always ends with the
 *    server's inventory, and no item is created or lost (survival: what the server holds plus what
 *    was thrown out is what it started with plus what was picked up).
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { Rng } from '../../src/core/rng';
import { ItemEntity } from '../../src/entities/entity';
import type { Inventory } from '../../src/entities/inventory';
import { LINKS } from './e2e-scenes';
import { inventoryOf } from './intent-scenes';
import { LAND, ownWorld, stat } from './own-scenes';

function total(inv: Inventory): Map<number, number> {
  const m = new Map<number, number>();
  const add = (s: { item: number; count: number } | null): void => {
    if (s !== null) m.set(s.item, (m.get(s.item) ?? 0) + s.count);
  };
  for (const s of inv.hotbar) add(s);
  for (const s of inv.main) add(s);
  add(inv.offhand);
  add(inv.cursor);
  return m;
}

function shownNet(inv: Inventory): ReturnType<typeof inventoryOf> {
  const copy = (s: { item: number; count: number } | null): { item: number; count: number } | null => (s === null ? null : { item: s.item, count: s.count });
  return { selected: inv.selected, hotbar: inv.hotbar.map(copy), main: inv.main.map(copy), offhand: copy(inv.offhand), cursor: copy(inv.cursor) };
}

describe('package 7: inventory prediction end to end', () => {
  it('an action the server resolves differently (a pickup took the slot meanwhile) snaps to the server\'s result at its ack', async () => {
    const r = await ownWorld(LAND, 'survival', LINKS[1]!.make(700));
    const { c, sim, h, ctrl } = r;
    const inv = ctrl.player.inventory;
    // A full hotbar but for slot 8, glass in the backpack.
    inv.hotbar[8] = null;
    inv.main[0] = { item: B.GLASS, count: 10 };
    h.run(50);
    c.catchUp(sim.ticks);
    expect(c.inventory.hotbar[8]).toBeNull();
    // Shift-click the glass into the hotbar: the client shows it in slot 8 at once...
    c.invClick('inventory', 0, 0, true);
    expect(c.inventory.hotbar[8]).toEqual({ item: B.GLASS, count: 10 });
    // ... while on the server a drop at the player's feet is picked up into slot 8 first.
    const d = sim.entities.spawnItem(ctrl.player.pos.x, ctrl.player.pos.y + 0.2, ctrl.player.pos.z, B.LAMP, 2, { x: 0, y: 0, z: 0 });
    d.pickupDelay = 0;
    h.runUntil(() => d.removed, 1000, 1);
    expect(inv.hotbar[8]).toEqual({ item: B.LAMP, count: 2 });
    c.waitAck();
    // The server found no room: the glass stays in the backpack; the client shows exactly that.
    expect(inv.main[0]).toEqual({ item: B.GLASS, count: 10 });
    expect(shownNet(c.inventory)).toEqual(inventoryOf(ctrl));
    expect(c.inventory.count(B.GLASS)).toBe(10);
    expect(c.inventory.count(B.LAMP)).toBe(2);
  }, 60_000);

  for (const [i, l] of LINKS.entries()) {
    it(`random inventory actions with pickups between them: no item created or lost; the client ends with the server's inventory (${l.name})`, async () => {
      const r = await ownWorld(LAND, 'survival', l.make(710 + i));
      const { c, sim, h, ctrl } = r;
      ctrl.giveItem(B.GLASS, 20);
      ctrl.giveItem(B.LAMP, 5);
      h.run(50);
      c.catchUp(sim.ticks);
      const start = total(ctrl.player.inventory);
      const picked = new Map<number, number>();
      sim.events.on((e) => {
        if (e.type === 'playerPickup' && e.player === 'p') picked.set(e.item, (picked.get(e.item) ?? 0) + e.count);
      });
      const rng = new Rng(9000 + i);
      // Every tick the server's inventory; every batch the client applies with nothing unacknowledged
      // left, its shown inventory must be the server's of that batch's tick.
      const serverAt = new Map<number, string>();
      r.onTick(() => serverAt.set(sim.ticks, JSON.stringify(inventoryOf(ctrl))));
      let differ = 0;
      let checks = 0;
      c.onBatch = (b) => {
        const want = serverAt.get(b.tick);
        if (want === undefined || c.intents!.inventory.unacknowledged > 0) return;
        checks++;
        if (JSON.stringify(shownNet(c.inventory)) !== want) differ++;
      };
      for (let k = 0; k < 200; k++) {
        const a = rng.int(0, 9);
        if (a <= 4) c.invClick(rng.chance(0.75) ? 'hotbar' : rng.chance(0.8) ? 'inventory' : 'offhand', rng.int(0, 8), rng.chance(0.5) ? 0 : 2, rng.chance(0.25));
        else if (a === 5) c.swapHands();
        else if (a === 6) c.selectSlot(rng.int(0, 8));
        else if (a === 7) c.closeInventory();
        else if (a === 8 && rng.chance(0.2)) c.dropCursor();
        else {
          // A drop lands at the player's feet: picked up on the server, unpredicted.
          const p = ctrl.player.pos;
          const d = sim.entities.spawnItem(p.x, p.y + 0.2, p.z, rng.chance(0.5) ? B.SANDSTONE : B.GLASS, rng.int(1, 4), { x: 0, y: 0, z: 0 });
          d.pickupDelay = 0;
        }
        h.run(rng.int(0, 60));
      }
      c.closeInventory();
      c.waitAck();
      h.run(2000);
      c.catchUp(sim.ticks);
      expect(shownNet(c.inventory)).toEqual(inventoryOf(ctrl));
      expect(differ).toBe(0);
      expect(checks).toBeGreaterThan(20);
      // Conservation: held + thrown (drops still in the world, none picked up again) = start + picked up.
      const held = total(ctrl.player.inventory);
      const thrown = new Map<number, number>();
      for (const e of sim.entities.all()) if (e instanceof ItemEntity && !e.removed) thrown.set(e.stack.item, (thrown.get(e.stack.item) ?? 0) + e.stack.count);
      for (const item of new Set([...start.keys(), ...picked.keys(), ...held.keys(), ...thrown.keys()])) {
        expect((held.get(item) ?? 0) + (thrown.get(item) ?? 0), `item ${item}`).toBe((start.get(item) ?? 0) + (picked.get(item) ?? 0));
      }
      stat(`inventory prediction, ${l.name}: 200 actions, the shown inventory equal to the server's at all ${checks} batches applied with nothing unacknowledged`);
    }, 120_000);
  }
});
