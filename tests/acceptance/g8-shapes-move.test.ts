/**
 * Acceptance scenario 38 (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md 5.7 and 16.4), headless,
 * whole simulation, in both modes: a half slab fills four of its cell's eight octants; the player
 * walks straight up onto half slabs (a whole block still needs a jump), stands on them without
 * sinking (also after a jump, and on a half slab on the deck of a raft it assembled), and walking
 * along a row of half slabs (pressed against a wall of vertical half slabs whose face is the
 * cells' mid-line, or on top of a row of lower half slabs) is never caught on the seams between
 * the cells.
 *
 * The scenes are written on the server (w.sim): the tools that make partial blocks come in M2.4.
 * The player acts through held keys (walk, jump), clicks (the helm) and the host's teleport; the
 * same ticks run in both modes. Positions are read on the server's entity (`me.player`) and, for
 * the feet heights, also on the body that moved (`me.body`: the client's prediction in network
 * mode): both must be exactly on the slab tops.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { vec3, type Vec3 } from '../../src/core/math';
import { solidFillAt } from '../../src/voxel/parts';
import { LOWER, slab, SOUTH } from '../shapes';
import { assembleAtHelm, releaseWheelByClick, SEA_TOP, seaWorld, yawOf } from './g5-carry-helpers';
import { newWorld } from './g6-save-helpers';
import { GROUND, shapesSpec } from './g8-shapes-helpers';
import type { TestWorld } from './world';

/** Yaws (forward = (-sin yaw, -cos yaw)): toward +X, and toward +Z. */
const EAST = -Math.PI / 2;
const SOUTH_YAW = Math.PI;
/** Walking speed per tick at full speed (WALK_SPEED 4.3 blocks/s, 20 ticks/s), with room for the ramp. */
const MIN_STEP = 0.15;

function bits(f: number): number {
  let n = 0;
  for (let v = f; v !== 0; v &= v - 1) n++;
  return n;
}

/** Fill the box of cells (inclusive corners) at height y with `cell`. */
function layer(w: TestWorld, x0: number, x1: number, y: number, z0: number, z1: number, cell: number): void {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) w.sim.world.setCell(x, y, z, cell);
}

/** Hold the keys for `ticks` ticks, calling `each` after every tick; then let go. */
function hold(w: TestWorld, keys: { yaw: number; forward?: number; jump?: boolean }, ticks: number, each: (t: number) => void = () => undefined): void {
  const i = w.me.input;
  i.yaw = keys.yaw;
  i.forward = keys.forward ?? 1;
  i.jump = keys.jump ?? false;
  for (let t = 0; t < ticks; t++) {
    w.tick();
    each(t);
  }
  i.forward = 0;
  i.jump = false;
}

/** The feet heights of both copies of the player (see the file comment). */
function feet(w: TestWorld): [number, number] {
  return [w.me.player.pos.y, w.me.body.pos.y];
}

describe('38. 半砖占 4 个八分格。玩家能直接走上半砖，站在半砖上不下陷；贴着一排半砖走不被接缝卡住。', () => {
  it('a half slab fills 4 octants; the player walks up onto a platform of lower half slabs without jumping, feet at the ground or on the slab top every tick', () => {
    const w = newWorld(shapesSpec(38));
    layer(w, 3, 9, GROUND, -1, 1, slab(B.STONE, LOWER));
    expect(bits(solidFillAt(w.sim.world, 3, GROUND, 0))).toBe(4);
    w.ready();
    const heights = new Set<number>();
    hold(w, { yaw: EAST }, 30, () => {
      for (const y of feet(w)) heights.add(y);
    });
    w.tick(10); // let the walk die out
    expect([...heights].sort()).toEqual([GROUND, GROUND + 0.5]); // up in one tick: no jump, no hover, no sinking
    expect(w.me.player.pos.x).toBeGreaterThan(4);
    expect(feet(w)).toEqual([GROUND + 0.5, GROUND + 0.5]);
  });

  it('a whole block is not walked up: the player stops at it, and gets onto it with a jump', () => {
    const w = newWorld(shapesSpec(381, { x: 0.5, y: GROUND, z: 5.5 }));
    layer(w, 3, 9, GROUND, 4, 6, makeCell(B.STONE));
    w.ready();
    hold(w, { yaw: EAST }, 30);
    w.tick(10);
    expect(w.me.player.pos.y).toBe(GROUND);
    expect(w.me.player.pos.x).toBeCloseTo(3 - w.me.player.halfWidth, 6);
    hold(w, { yaw: EAST, jump: true }, 12);
    w.tick(20);
    expect(w.me.player.pos.y).toBe(GROUND + 1);
  });

  it('standing on a half slab it does not sink: 60 ticks still, then a jump lands back exactly on the slab top', () => {
    const w = newWorld(shapesSpec(382));
    layer(w, 3, 9, GROUND, -1, 1, slab(B.PLANKS_OAK, LOWER));
    w.ready();
    hold(w, { yaw: EAST }, 20);
    w.tick(10);
    for (let t = 0; t < 60; t++) {
      w.tick();
      expect(feet(w), `tick ${t}`).toEqual([GROUND + 0.5, GROUND + 0.5]);
      expect(w.me.player.onGround).toBe(true);
    }
    let top = 0;
    hold(w, { yaw: EAST, forward: 0, jump: true }, 1);
    for (let t = 0; t < 30; t++) {
      w.tick();
      top = Math.max(top, w.me.player.pos.y);
    }
    expect(top).toBeGreaterThan(GROUND + 1.5); // it really jumped
    expect(feet(w)).toEqual([GROUND + 0.5, GROUND + 0.5]);
  });

  it('walking along a wall of vertical half slabs, pressed into its face (the cells\' mid-line), and along the top of a row of lower half slabs: never caught on the seams', () => {
    const w = newWorld(shapesSpec(383, { x: 0.5, y: GROUND, z: 1.5 }));
    // The wall: the south halves of cells x -2..16, z = 2, two high; its face at z = 2.5.
    for (let x = -2; x <= 16; x++) for (let y = GROUND; y <= GROUND + 1; y++) w.sim.world.setCell(x, y, 2, slab(B.STONE, SOUTH));
    // The row: lower half slabs x -2..16, z -4..-2.
    layer(w, -2, 16, GROUND, -4, -2, slab(B.STONE, LOWER));
    w.ready();
    const hw = w.me.player.halfWidth;
    let x = w.me.player.pos.x;
    // Along the wall, 0.25 rad into it.
    hold(w, { yaw: EAST - 0.25 }, 50, (t) => {
      const p = w.me.player.pos;
      expect(p.z, `tick ${t}`).toBeLessThan(2.5 - hw + 1e-9);
      if (t >= 8) expect(p.x - x, `tick ${t}: dx`).toBeGreaterThan(MIN_STEP);
      x = p.x;
    });
    expect(w.me.player.pos.z).toBeCloseTo(2.5 - hw, 9); // it was pressed against the face all along
    expect(w.me.player.pos.x).toBeGreaterThan(9);
    expect(w.me.player.pos.y).toBe(GROUND);
    // Along the top of the row, from its west end.
    w.me.teleport(-1.5, GROUND + 0.5, -3);
    w.tick(5);
    x = w.me.player.pos.x;
    hold(w, { yaw: EAST }, 50, (t) => {
      expect(feet(w), `tick ${t}`).toEqual([GROUND + 0.5, GROUND + 0.5]);
      if (t >= 8) expect(w.me.player.pos.x - x, `tick ${t}: dx`).toBeGreaterThan(MIN_STEP);
      x = w.me.player.pos.x;
    });
    expect(w.me.player.pos.x).toBeGreaterThan(8);
  });

  it('on the deck of a raft the player assembled at sea: it walks up onto a platform of lower half slabs (half a block up in the frame of the deck) and stands on it, carried, without sinking', () => {
    const w = seaWorld('creative', vec3(1.5, SEA_TOP, 5.5), 384);
    const { sim, me } = w;
    // A 7 x 9 planks deck in the surface layer (x -3..3, z 3..11), the helm facing north on its
    // first row, lower half slabs (x -2..0, z 6..8) south of the seat behind the helm (-0.5, 4.5).
    layer(w, -3, 3, SEA_TOP - 1, 3, 11, makeCell(B.PLANKS_OAK));
    layer(w, -2, 0, SEA_TOP, 6, 8, slab(B.PLANKS_OAK, LOWER));
    sim.world.setCell(-1, SEA_TOP, 3, makeCell(B.HELM, NZ));
    w.tick(2);
    me.emptyHand();
    const ship = assembleAtHelm(w, vec3(-1, SEA_TOP, 3));
    releaseWheelByClick(w); // standing at the seat
    w.tick(40); // the raft settles on the water
    const at = (): Vec3 => ship.grid.toLocal(vec3(me.player.pos.x, me.player.pos.y, me.player.pos.z));
    // The raft floats with a slight heel (its helm and slabs are off centre), so a body standing on
    // its deck is a little above the deck's top in the deck's frame (the box's lowest corner rests
    // on it): the heights below are measured from where the player stands on the deck itself.
    const deck = at().y;
    expect(deck - SEA_TOP).toBeGreaterThanOrEqual(0);
    expect(deck - SEA_TOP).toBeLessThan(0.02);
    hold(w, { yaw: SOUTH_YAW + yawOf(ship.grid) }, 12);
    w.tick(10);
    expect(at().z).toBeGreaterThan(6.3);
    expect(at().z).toBeLessThan(8.7);
    const onSlab = at().y;
    expect(onSlab - deck).toBeCloseTo(0.5, 2); // half a block up
    for (let t = 0; t < 40; t++) {
      w.tick();
      expect(Math.abs(at().y - onSlab), `tick ${t}`).toBeLessThan(1e-6); // and it does not sink
      expect(me.player.carrierId).toBe(ship.id);
    }
  });
});
