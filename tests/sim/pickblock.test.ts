import { describe, expect, it } from 'vitest';
import { facingState, liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NY, NZ, PY, PZ } from '../../src/core/dirs';
import { maxStackOf } from '../../src/entities/inventory';
import type { Simulation } from '../../src/sim/simulation';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from './helpers';

const T = FLAT_TOP;

/** A flat world with a stone block 2 cells north of the player, looked at (top face). */
function stoneScene(mode: 'creative' | 'survival'): Simulation {
  const sim = flatSim({ mode });
  sim.world.setCell(0, T, -2, makeCell(B.STONE));
  sim.soloPlayer.lookAtCell(0, T, -2, PY);
  return sim;
}

describe('pick block (middle click)', () => {
  it('creative: fills the selected slot when it is empty, with the block itself (not its drop)', () => {
    const sim = stoneScene('creative');
    const inv = sim.soloPlayer.player.inventory;
    inv.selected = 3;
    sim.soloPlayer.player.input.slot = 3;
    expect(sim.soloPlayer.targetCell()).toMatchObject({ gridId: 0, x: 0, y: T, z: -2 });
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(3);
    expect(inv.hotbar[3]).toEqual({ item: B.STONE, count: maxStackOf(B.STONE) });
    expect(sim.soloPlayer.player.input.slot).toBe(3);
    // The next tick applies input.slot: the pick is not overwritten.
    sim.tick();
    expect(inv.selected).toBe(3);
    expect(inv.selectedStack()?.item).toBe(B.STONE);
  });

  it('creative: selects the hotbar slot that already holds the block', () => {
    const sim = stoneScene('creative');
    const inv = sim.soloPlayer.player.inventory;
    inv.hotbar[0] = { item: B.DIRT, count: 5 };
    inv.hotbar[6] = { item: B.STONE, count: 2 };
    inv.selected = 0;
    sim.soloPlayer.player.input.slot = 0;
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(6);
    expect(inv.hotbar[6]).toEqual({ item: B.STONE, count: 2 }); // untouched
    expect(inv.hotbar[0]).toEqual({ item: B.DIRT, count: 5 });
    sim.tick();
    expect(inv.selected).toBe(6);
  });

  it('creative: first empty hotbar slot when the selected one is taken, else replaces the selected slot', () => {
    const sim = stoneScene('creative');
    const inv = sim.soloPlayer.player.inventory;
    inv.hotbar[0] = { item: B.DIRT, count: 5 };
    inv.hotbar[1] = { item: B.SAND, count: 5 };
    inv.selected = 0;
    sim.soloPlayer.player.input.slot = 0;
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(2);
    expect(inv.hotbar[2]?.item).toBe(B.STONE);
    expect(inv.hotbar[0]).toEqual({ item: B.DIRT, count: 5 });

    // Full hotbar without stone: the selected slot is replaced.
    for (let i = 0; i < 9; i++) inv.hotbar[i] = { item: B.PLANKS_OAK, count: 1 };
    inv.selected = 4;
    sim.soloPlayer.player.input.slot = 4;
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(4);
    expect(inv.hotbar[4]).toEqual({ item: B.STONE, count: maxStackOf(B.STONE) });
    expect(inv.count(B.PLANKS_OAK)).toBe(8);
  });

  it('survival: selects the hotbar slot, swaps a backpack stack in, never creates items', () => {
    const sim = stoneScene('survival');
    const inv = sim.soloPlayer.player.inventory;
    const p = sim.soloPlayer.player;
    // None at all: nothing happens.
    inv.hotbar[0] = { item: B.DIRT, count: 5 };
    inv.selected = 0;
    p.input.slot = 0;
    expect(sim.soloPlayer.pickBlock()).toBe(false);
    expect(inv.count(B.STONE)).toBe(0);
    expect(inv.selected).toBe(0);
    expect(inv.hotbar[0]).toEqual({ item: B.DIRT, count: 5 });

    // Only in the backpack: swapped with the selected hotbar slot.
    inv.main[7] = { item: B.STONE, count: 9 };
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(0);
    expect(inv.hotbar[0]).toEqual({ item: B.STONE, count: 9 });
    expect(inv.main[7]).toEqual({ item: B.DIRT, count: 5 });
    expect(inv.count(B.STONE)).toBe(9);

    // In the hotbar: that slot is selected; nothing moves.
    inv.selected = 5;
    p.input.slot = 5;
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selected).toBe(0);
    expect(p.input.slot).toBe(0);
    sim.tick();
    expect(inv.selected).toBe(0);
    expect(inv.count(B.STONE)).toBe(9);
    expect(inv.count(B.DIRT)).toBe(5);

    // Backpack swap into an EMPTY selected slot leaves the backpack slot empty.
    inv.hotbar[0] = null;
    inv.main[2] = { item: B.STONE, count: 3 };
    inv.selected = 8;
    p.input.slot = 8;
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.hotbar[8]).toEqual({ item: B.STONE, count: 3 });
    expect(inv.main[2]).toBeNull();
  });

  it('picks the facing-carrying block by id (a helm), not its state', () => {
    const sim = flatSim({ mode: 'creative' });
    sim.world.setCell(0, T, -2, makeCell(B.HELM, facingState(NZ)));
    sim.soloPlayer.lookAtCell(0, T, -2, PZ);
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(sim.soloPlayer.player.inventory.selectedStack()?.item).toBe(B.HELM);
  });

  it('air, liquids and unloaded cells pick nothing', () => {
    const sim = flatSim({ mode: 'creative' });
    const inv = sim.soloPlayer.player.inventory;
    // Looking straight up into the sky.
    const p = sim.soloPlayer.player;
    sim.soloPlayer.lookAt(p.pos.x, p.pos.y + 50, p.pos.z);
    expect(sim.soloPlayer.pickBlock()).toBe(false);
    expect(inv.hotbar.every((s) => s === null)).toBe(true);

    // A water source in front of the player: the plain use ray goes through it (to the ground).
    sim.world.setCell(0, T, -2, makeCell(B.WATER, liquidState(0, false)));
    sim.world.setCell(0, T - 1, -2, makeCell(B.GLASS));
    sim.soloPlayer.lookAtCell(0, T, -2, NY); // through the water, onto the glass under it
    expect(sim.soloPlayer.targetCell()).toMatchObject({ x: 0, y: T - 1, z: -2 });
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(inv.selectedStack()?.item).toBe(B.GLASS);

    // With a bucket in hand the use ray stops at the source (as the outline does): nothing.
    sim.soloPlayer.hold(I.BUCKET, 1);
    const sel = inv.selected;
    sim.soloPlayer.lookAtCell(0, T, -2);
    expect(sim.soloPlayer.targetCell()).toMatchObject({ x: 0, y: T, z: -2 });
    expect(sim.soloPlayer.pickBlock()).toBe(false);
    expect(inv.selected).toBe(sel);
    expect(inv.selectedStack()?.item).toBe(I.BUCKET);

    // Far beyond the loaded area every cell reads as the unloaded sentinel: rays pass through it.
    sim.soloPlayer.teleport(5000.5, T, 5000.5);
    sim.soloPlayer.lookAt(5000.5, T - 3, 5000.5 - 2);
    expect(sim.world.getChunk(312, 312)).toBeUndefined();
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.pickBlock()).toBe(false);
  });

  it('nothing happens for a dead player', () => {
    const sim = stoneScene('creative');
    sim.soloPlayer.player.dead = true;
    expect(sim.soloPlayer.pickBlock()).toBe(false);
    expect(sim.soloPlayer.player.inventory.hotbar.every((s) => s === null)).toBe(true);
  });

  it('works on structures: picks a block of an assembled ship', () => {
    const sim = seaSim({ mode: 'creative', spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
    const w = sim.world;
    fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    w.setCell(1, SEA_TOP, 5, makeCell(B.WOOL_RED)); // red felt on the deck, glued to the plank below
    sim.worldGlue.add(1, SEA_TOP, 5, 3 /* NY */);
    const res = sim.structures.assembleShip(2, SEA_TOP, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    expect(ship.grid.getCell(1, SEA_TOP, 5) & 0x3ff).toBe(B.WOOL_RED);
    // The world cell is now water / air: the ray must hit the ship's cell.
    expect(sim.soloPlayer.lookAtCell(1, SEA_TOP, 5, PY, ship.id)).toBe(true);
    expect(sim.soloPlayer.targetCell()).toMatchObject({ gridId: ship.id, x: 1, y: SEA_TOP, z: 5 });
    expect(sim.soloPlayer.pickBlock()).toBe(true);
    expect(sim.soloPlayer.player.inventory.selectedStack()?.item).toBe(B.WOOL_RED);
  });
});
