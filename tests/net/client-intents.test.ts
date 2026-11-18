/**
 * The client's side of package 7 as units: choosing a target along the eye ray or, in third person,
 * the camera ray accepting only hits within REACH of the eyes (net/client/intents.ts); the
 * InventoryPredictor (net/client/inventory.ts): actions replayed on the server's inventory, dropped
 * at their ack, snapping to the server's result.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { chooseTarget, sameTarget } from '../../src/net/client/intents';
import { applyInventoryAction, inventoryFrom, InventoryPredictor } from '../../src/net/client/inventory';
import type { NetInventory } from '../../src/net/protocol';
import { Inventory } from '../../src/entities/inventory';
import { FLAT_TOP, flatSim } from '../sim/helpers';

const T = FLAT_TOP;

function net(inv: Inventory): NetInventory {
  return {
    selected: inv.selected,
    hotbar: inv.hotbar.map((s) => (s === null ? null : { ...s })),
    main: inv.main.map((s) => (s === null ? null : { ...s })),
    offhand: inv.offhand === null ? null : { ...inv.offhand },
    cursor: inv.cursor === null ? null : { ...inv.cursor },
  };
}

describe('choosing the target (net/client/intents.ts)', () => {
  it('first person: the eye ray within REACH; third person: the camera ray, only hits within REACH of the eyes', () => {
    const sim = flatSim();
    sim.world.setCell(0, T + 1, -4, makeCell(B.STONE));
    sim.world.setCell(0, T + 1, -7, makeCell(B.BRICKS));
    const scene = sim.interaction.rayScene();
    const eye = vec3(0.5, T + 1.5, 0.5);
    const dir = vec3(0, 0, -1);
    const t = chooseTarget(scene, 'plain', { eye, origin: eye, dir });
    expect(t).toEqual({ gridId: 0, x: 0, y: T + 1, z: -4, face: PZ, sub: 0, cell: makeCell(B.STONE) });
    // A camera 4 blocks behind the eyes: the same block is hit (3.5 from the eyes)...
    const cam = vec3(0.5, T + 1.5, 4.5);
    expect(sameTarget(chooseTarget(scene, 'plain', { eye, origin: cam, dir }), t)).toBe(true);
    // ... and with the stone gone, the bricks 7.5 from the eyes (11.5 from the camera) are not.
    sim.world.setCell(0, T + 1, -4, makeCell(B.AIR));
    expect(chooseTarget(scene, 'plain', { eye, origin: eye, dir })).toBeNull();
    expect(chooseTarget(scene, 'plain', { eye, origin: cam, dir })).toBeNull();
    // A camera looking past the eyes at a block within reach of them, though farther from the camera.
    sim.world.setCell(0, T + 1, -3, makeCell(B.GLASS));
    const side = vec3(3.5, T + 1.5, 4.5);
    const toward = vec3(0.5 - 3.5, 0, -2.5 - 4.5);
    const len = Math.hypot(toward.x, toward.z);
    toward.x /= len;
    toward.z /= len;
    expect(chooseTarget(scene, 'plain', { eye, origin: side, dir: toward })).toMatchObject({ x: 0, y: T + 1, z: -3 });
  });

  it('sameTarget compares every field, the cell value included', () => {
    const a = { gridId: 0, x: 1, y: 2, z: 3, face: NZ, sub: 0, cell: makeCell(B.STONE) } as const;
    expect(sameTarget(a, { ...a })).toBe(true);
    expect(sameTarget(a, { ...a, cell: makeCell(B.COBBLE) })).toBe(false);
    expect(sameTarget(a, { ...a, face: PZ })).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
    expect(sameTarget(a, null)).toBe(false);
  });
});

describe('InventoryPredictor (net/client/inventory.ts)', () => {
  it('shows the server\'s inventory with the unacknowledged actions replayed, and drops each at its ack', () => {
    const server = new Inventory();
    server.hotbar[0] = { item: B.PLANKS_OAK, count: 64 };
    server.hotbar[1] = { item: I.GLUE, count: 4 };
    const p = new InventoryPredictor();
    expect(p.inventory).toBeNull();
    p.update(net(server), null, false);
    expect(p.inventory!.hotbar[0]).toEqual({ item: B.PLANKS_OAK, count: 64 });
    p.predict(1, { kind: 'selectSlot', slot: 1 });
    p.predict(2, { kind: 'swapHands' });
    p.predict(3, { kind: 'invClick', area: 'hotbar', index: 0, button: 2, shift: false });
    const shown = p.inventory!;
    expect(shown.selected).toBe(1);
    expect(shown.offhand).toEqual({ item: I.GLUE, count: 4 });
    expect(shown.hotbar[1]).toBeNull();
    expect(shown.cursor).toEqual({ item: B.PLANKS_OAK, count: 32 });
    expect(p.unacknowledged).toBe(3);
    // The server did 1 and 2 (same result): only 3 is replayed on its inventory.
    server.selected = 1;
    server.swapOffhand();
    p.update(net(server), 2, false);
    expect(p.unacknowledged).toBe(1);
    expect(p.inventory!.cursor).toEqual({ item: B.PLANKS_OAK, count: 32 });
    expect(p.inventory!.offhand).toEqual({ item: I.GLUE, count: 4 });
  });

  it('an action the server resolved differently snaps to the server\'s result at its ack; nothing is duplicated', () => {
    const server = new Inventory();
    for (let i = 0; i < 8; i++) server.hotbar[i] = { item: B.DIRT, count: 64 };
    server.main[0] = { item: B.GLASS, count: 10 };
    const p = new InventoryPredictor();
    p.update(net(server), 0, false);
    // Shift-click the glass into the hotbar: the client sees it go into the empty slot 8.
    p.predict(1, { kind: 'invClick', area: 'inventory', index: 0, button: 0, shift: true });
    expect(p.inventory!.hotbar[8]).toEqual({ item: B.GLASS, count: 10 });
    expect(p.inventory!.main[0]).toBeNull();
    // Meanwhile a pickup filled slot 8 on the server: the click found no room.
    server.hotbar[8] = { item: B.SAND, count: 3 };
    p.update(net(server), 0, false); // the pickup arrives first: still replayed (no room now)
    expect(p.inventory!.main[0]).toEqual({ item: B.GLASS, count: 10 });
    expect(p.inventory!.hotbar[8]).toEqual({ item: B.SAND, count: 3 });
    server.slotClick('inventory', 0, 0, true);
    p.update(net(server), 1, false);
    expect(p.unacknowledged).toBe(0);
    expect(net(p.inventory!)).toEqual(net(server));
    expect(p.inventory!.count(B.GLASS)).toBe(10);
  });

  it('every action replays as the server applies it (creative-only actions only in creative; pick block; closing; dropping the cursor)', () => {
    const inv = new Inventory();
    inv.hotbar[0] = { item: B.STONE, count: 5 };
    applyInventoryAction(inv, { kind: 'creativePick', item: B.GLASS, shift: true }, false);
    expect(inv.count(B.GLASS)).toBe(0);
    applyInventoryAction(inv, { kind: 'creativePick', item: B.GLASS, shift: true }, true);
    expect(inv.count(B.GLASS)).toBe(64);
    applyInventoryAction(inv, { kind: 'pickBlock', item: B.STONE }, false);
    expect(inv.selected).toBe(0);
    applyInventoryAction(inv, { kind: 'pickBlock', item: -1 }, true);
    expect(inv.selected).toBe(0);
    inv.cursor = { item: B.DIRT, count: 3 };
    applyInventoryAction(inv, { kind: 'closeInventory' }, false);
    expect(inv.cursor).toBeNull();
    expect(inv.count(B.DIRT)).toBe(3);
    inv.cursor = { item: B.DIRT, count: 2 };
    applyInventoryAction(inv, { kind: 'dropCursor' }, false);
    expect(inv.cursor).toBeNull();
    expect(inv.count(B.DIRT)).toBe(3);
    applyInventoryAction(inv, { kind: 'selectSlot', slot: 9 }, false); // out of range: ignored
    expect(inv.selected).toBe(0);
    expect(net(inventoryFrom(net(inv)))).toEqual(net(inv));
  });
});
