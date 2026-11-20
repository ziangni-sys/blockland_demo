/**
 * Acceptance scenario 39 and the placement part of scenario 45 (docs/ACCEPTANCE.md "形状与凿子";
 * docs/SHAPES.md 6.2, 9.2, 16.4), headless, whole simulation, in both modes (direct, and through
 * the protocol):
 *  - 39: a cell holding slabs of two materials; each is mined on its own and returns one block. The
 *    player aims at an octant of the part (w.me.mine with an octant: the client sends it as
 *    Target.sub); one part goes, the other stays. In survival the drops are picked up: the server's
 *    inventory and, in network mode, the inventory the client shows count one block per part.
 *  - 45, placing: a torch cannot be put on a lower slab, it can on an upper slab; in survival, a
 *    torch whose top face is chiselled away under it drops and is picked up again. (The sand and
 *    the torch on a written scene are in g8-shapes-updates.test.ts.)
 *
 * Scenes are written on the server (w.sim): the tools that make partial blocks come in M2.4, which
 * replays scenario 39 placing the slabs with a chisel in the off-hand (docs/SHAPES.md 14.2, 16.4).
 * The player mines and places through w.me.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import type { Simulation } from '../../src/sim/simulation';
import { PY } from '../../src/core/dirs';
import { ItemEntity } from '../../src/entities/entity';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, NORTH, partsAt, slab, SOUTH, UPPER } from '../shapes';
import { makeWorld, T } from './g1-stick-glue-helpers';
import type { TestWorld } from './world';

/** Item entities of `item` lying in the world (on the server). */
function lying(w: TestWorld, item: number): number {
  let n = 0;
  for (const e of w.sim.entities.all()) if (!e.removed && e instanceof ItemEntity && e.stack.item === item) n += e.stack.count;
  return n;
}

/**
 * How many of `item` the player has picked up: the server's inventory, and in network mode the
 * inventory the client shows (they must agree).
 */
function carried(w: TestWorld, item: number): number {
  const n = w.me.player.inventory.count(item);
  if (w.client !== null) expect(w.client.inventory.count(item), 'the inventory the client shows').toBe(n);
  return n;
}

/** The player walks north through the emptied cell, over the drops (they scatter a little), and stops. */
function walkOver(w: TestWorld): void {
  w.tick(10); // the drops' pickup delay
  w.me.input.yaw = 0;
  w.me.input.pitch = 0;
  w.me.input.forward = 1;
  w.tick(12);
  w.me.input.forward = 0;
  w.tick(10);
}

/** Keys of the toasts the server sends from now on. */
function toasts(sim: Simulation): string[] {
  const keys: string[] = [];
  sim.events.on((e) => {
    if (e.type === 'toast') keys.push(e.message.key);
  });
  return keys;
}

describe('39. 一格里放两种材质的半砖；分别挖掉，各返还 1 个方块。', () => {
  it('planks below, bricks above: the bricks are mined first (aimed at an upper octant), the planks stay; then the planks; one of each comes back into the inventory', () => {
    // The player stands right south of the cell: the drops land within its pickup reach.
    const w = makeWorld('survival', { x: 0.5, y: T, z: -0.5 });
    const { sim, me } = w;
    sim.world.setCell(0, T, -2, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.BRICKS, UPPER)));
    me.emptyHand();
    // Octant 6: -X, upper, +Z, on the face toward the player. Bricks take 2 s.
    expect(me.mine(0, T, -2, undefined, 0, 400, 6)).toBe(true);
    expect(partsAt(sim.world, 0, T, -2)).toEqual([{ id: B.PLANKS_OAK, state: 0, fill: LOWER }]);
    // Octant 4: -X, lower, +Z.
    expect(me.mine(0, T, -2, undefined, 0, 400, 4)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    walkOver(w);
    expect(carried(w, B.BRICKS)).toBe(1);
    expect(carried(w, B.PLANKS_OAK)).toBe(1);
    expect(lying(w, B.BRICKS) + lying(w, B.PLANKS_OAK)).toBe(0);
  });

  it('two slabs of the same material in one cell are two parts: mined one at a time, two planks come back into the inventory (one per part)', () => {
    const w = makeWorld('survival', { x: 0.5, y: T, z: -0.5 });
    const { sim, me } = w;
    // A full-looking cell of two planks parts: north half and south half.
    sim.world.setCell(0, T, -2, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)));
    me.emptyHand();
    // The south half faces the player (octant 6); then the north half, through the emptied south half (octant 2).
    expect(me.mine(0, T, -2, undefined, 0, 400, 6)).toBe(true);
    expect(partsAt(sim.world, 0, T, -2)).toEqual([{ id: B.PLANKS_OAK, state: 0, fill: NORTH }]);
    expect(me.mine(0, T, -2, undefined, 0, 400, 2)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    walkOver(w);
    expect(carried(w, B.PLANKS_OAK)).toBe(2);
    expect(lying(w, B.PLANKS_OAK)).toBe(0);
  });
});

describe('45. 火把不能放在下半砖上，能放在上半砖上；沙子落到半砖上停住。（放置部分）', () => {
  it('a torch put on the top of a lower slab is refused (toast.place.support); on an upper slab it stands', () => {
    const w = makeWorld('creative');
    const { sim, me } = w;
    sim.world.setCell(0, T, -2, slab(B.STONE, LOWER));
    sim.world.setCell(2, T, -2, slab(B.STONE, UPPER));
    const keys = toasts(sim);
    me.hold(B.TORCH);
    // The lower slab's top (the inner face of octant 4): the torch would go into the cell above, standing on nothing whole.
    expect(me.aimAt(0, T, -2, PY, 0, false, 4)).toBe(true);
    me.use();
    w.tick();
    expect(getPacked(sim.world, 0, T + 1, -2)).toBe(0);
    expect(keys).toEqual(['toast.place.support']);
    // The upper slab's top (a cell face, octant 6): the torch stands on it.
    expect(me.aimAt(2, T, -2, PY, 0, false, 6)).toBe(true);
    me.use();
    w.tick();
    expect(getPacked(sim.world, 2, T + 1, -2)).toBe(makeCell(B.TORCH));
    expect(keys).toEqual(['toast.place.support']);
  });

  it('survival: the player puts a torch from its inventory on an upper slab; chiselling the top of the slab away under it makes the torch drop, and the player picks it up again', () => {
    const w = makeWorld('survival', { x: 0.5, y: T, z: -0.5 });
    const { sim, me } = w;
    sim.world.setCell(0, T, -2, slab(B.STONE, UPPER));
    me.giveItem(B.TORCH, 1);
    me.hold(B.TORCH, 1);
    expect(me.aimAt(0, T, -2, PY, 0, false, 6)).toBe(true);
    me.use();
    w.tick();
    expect(getPacked(sim.world, 0, T + 1, -2)).toBe(makeCell(B.TORCH));
    expect(carried(w, B.TORCH)).toBe(0);
    // Chiselling (a direct write until M2.4): the two upper octants on the south side go, so the
    // top face under the torch is no longer covered.
    sim.world.setCell(0, T, -2, slab(B.STONE, 0x0c));
    w.tick(2);
    expect(getPacked(sim.world, 0, T + 1, -2)).toBe(0);
    expect(lying(w, B.TORCH)).toBe(1);
    walkOver(w);
    expect(carried(w, B.TORCH)).toBe(1);
    expect(lying(w, B.TORCH)).toBe(0);
  });
});
