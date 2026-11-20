/**
 * Rays hit octants (docs/SHAPES.md 6.1), headless, whole simulation, in both modes: the player's
 * rays pass through the empty octants of a partial cell (DESIGN "材质 + 形状": the ray reaches what
 * lies behind the gap above a slab) and stop at the top of a lower slab, an inner face. No numbered
 * scenario of docs/ACCEPTANCE.md covers this; the file checks that the server's rays (direct mode)
 * and the client's rays on its replica (network mode) agree on the octant-level targets, through
 * the whole protocol.
 *
 * The scene is written on the server (w.sim): the tools that make partial blocks come in M2.4. The
 * player's actions are the looks and the mining (creative: one click breaks). What is asserted is
 * which cell and face is targeted, and that the targeted cell is the one that breaks; how much of
 * a partial cell mining removes (one part) is scenario 39, tests/acceptance/g8-shapes-parts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { PY, PZ } from '../../src/core/dirs';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, slab } from '../shapes';
import { newWorld } from './g6-save-helpers';
import { GROUND, shapesSpec } from './g8-shapes-helpers';

const SLAB = slab(B.STONE, LOWER);
const PLANKS = makeCell(B.PLANKS_OAK);

describe('射线打到八分格：越过下半砖上方的空隙点到后面的方块；点下半砖的顶面（内面）点到半砖。', () => {
  it('the block behind the slab is targeted through the gap and mined; then the slab is targeted on its top and mined', () => {
    const w = newWorld(shapesSpec(81));
    const { sim, me } = w;
    // Facing north from the spawn (0.5, GROUND, 0.5): a lower slab right in front, planks behind it.
    sim.world.setCell(0, GROUND, -1, SLAB);
    sim.world.setCell(0, GROUND, -2, PLANKS);
    w.tick(2);
    me.emptyHand();
    // The centre of the planks' south face: the ray from the eyes crosses the slab's cell above its
    // mid-plane (its upper octants are empty), so it reaches the planks.
    expect(me.aimAt(0, GROUND, -2, PZ)).toBe(true);
    expect(me.targetCell()).toMatchObject({ gridId: 0, x: 0, y: GROUND, z: -2, face: PZ });
    expect(me.mine(0, GROUND, -2, PZ)).toBe(true);
    expect(getPacked(sim.world, 0, GROUND, -2)).toBe(0);
    expect(getPacked(sim.world, 0, GROUND, -1)).toBe(SLAB);
    // The centre of the slab's cell is the middle of its top: the ray goes through the empty upper
    // half and stops there, on an inner face (GROUND + 0.5), which is still PY.
    expect(me.aimAt(0, GROUND, -1)).toBe(true);
    expect(me.targetCell()).toMatchObject({ gridId: 0, x: 0, y: GROUND, z: -1, face: PY });
    expect(me.mine(0, GROUND, -1)).toBe(true);
    expect(getPacked(sim.world, 0, GROUND, -1)).toBe(0);
    w.tick(2);
  });
});
