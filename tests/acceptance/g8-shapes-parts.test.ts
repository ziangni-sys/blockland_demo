/**
 * Acceptance scenario 39 and the placement part of scenario 45 (docs/ACCEPTANCE.md "形状与凿子";
 * docs/SHAPES.md 6.2, 9.2, 16.4), headless, whole simulation, in both modes (direct, and through
 * the protocol):
 *  - 39: a cell holding slabs of two materials; each is mined on its own and returns one block. The
 *    player aims at an octant of the part (w.me.mine with an octant: the client sends it as
 *    Target.sub); one part goes, the other stays.
 *  - 45, placing: a torch cannot be put on a lower slab, it can on an upper slab. (The sand and the
 *    lost support belong to package P6: g8-shapes-updates.test.ts.)
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

/** How many of `item` there are: in the player's inventory (on the server) and lying in the world. */
function owned(w: TestWorld, item: number): number {
  let n = w.me.player.inventory.count(item);
  for (const e of w.sim.entities.all()) if (!e.removed && e instanceof ItemEntity && e.stack.item === item) n += e.stack.count;
  return n;
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
  it('planks below, bricks above: the bricks are mined first (aimed at an upper octant), the planks stay; then the planks; one of each comes back', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    sim.world.setCell(0, T, -2, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.BRICKS, UPPER)));
    me.emptyHand();
    // Octant 6: -X, upper, +Z, on the face toward the player. Bricks take 2 s.
    expect(me.mine(0, T, -2, undefined, 0, 400, 6)).toBe(true);
    expect(partsAt(sim.world, 0, T, -2)).toEqual([{ id: B.PLANKS_OAK, state: 0, fill: LOWER }]);
    // Octant 4: -X, lower, +Z.
    expect(me.mine(0, T, -2, undefined, 0, 400, 4)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    w.tick(20);
    expect(owned(w, B.BRICKS)).toBe(1);
    expect(owned(w, B.PLANKS_OAK)).toBe(1);
  });

  it('two slabs of the same material in one cell are two parts: mined one at a time, two planks come back (one per part)', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    // A full-looking cell of two planks parts: north half and south half.
    sim.world.setCell(0, T, -2, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_OAK, SOUTH)));
    me.emptyHand();
    // The south half faces the player (octant 6); then the north half, through the emptied south half (octant 2).
    expect(me.mine(0, T, -2, undefined, 0, 400, 6)).toBe(true);
    expect(partsAt(sim.world, 0, T, -2)).toEqual([{ id: B.PLANKS_OAK, state: 0, fill: NORTH }]);
    expect(me.mine(0, T, -2, undefined, 0, 400, 2)).toBe(true);
    expect(getPacked(sim.world, 0, T, -2)).toBe(0);
    w.tick(20);
    expect(owned(w, B.PLANKS_OAK)).toBe(2);
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
});
