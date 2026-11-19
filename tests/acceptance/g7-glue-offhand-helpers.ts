/**
 * Helpers for the acceptance scenarios 25–29 (强力胶与副手). Everything the player does goes
 * through the test world's player (tests/acceptance/world.ts: look, right/left click, held item,
 * sneak, the off-hand swap key); internals are only touched to build scenes and to observe
 * results. What the player SEES of the glue is the overlay the client builds (src/client/view.ts
 * collectGlueFaces, the data the renderer draws): in network mode from the client's replica, with
 * the replica's light; in direct mode, where there is no client, from the server's world, with
 * full sky light assumed for the open cells (the light is the client's).
 *
 * Scene convention (flat world, see g1-stick-glue-helpers): a 3 x 2 oak plank raft on the ground
 * at y = T (x 0..2, z -4..-3) with a helm on its back row, the player standing at (0.5, T, 0.5)
 * south of it, looking north. The raft's east edge plank (2, T, -3) has an open east face; the
 * blocks the player glues on are put east of it, at (3, T, -3).
 */
import { expect } from 'vitest';
import { I } from '../../src/blocks/items';
import { NZ, PZ, type Dir } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import type { OverlayFace } from '../../src/render/backend';
import { collectGlueFaces } from '../../src/client/view';
import { T, assembleShipByHand, put } from './g1-stick-glue-helpers';
import { B } from '../../src/blocks/defs';
import { facingState } from '../../src/blocks/cell';
import type { TestWorld } from './world';

export { T, Toasts, hardnessTicks, idAt, makeWorld, measureMiningTicks, put } from './g1-stick-glue-helpers';

/** Raft planks (x 0..2, z -4..-3, y = T) and the helm at (1, T + 1, -3) facing north. */
export function buildRaft(w: TestWorld): void {
  for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) put(w.sim, x, T, z, B.PLANKS_OAK);
  put(w.sim, 1, T + 1, -3, B.HELM, facingState(NZ));
  w.tick(2);
}

/** The raft's east edge plank, whose east (+X) face is open. */
export const EDGE: readonly [number, number, number] = [2, T, -3];
/** Where a block put against the edge plank's east face lands. */
export const EAST: readonly [number, number, number] = [3, T, -3];

/**
 * The player stands where the raft's east side and the cell east of it are in view: south-east
 * of the raft, looking north-west.
 */
export function standSouthEast(w: TestWorld): void {
  w.me.teleport(4.5, T, -0.5);
  w.tick(1);
}

/** With glue in the main hand, one right-click on face `face` of cell (x,y,z) (checked aim). */
export function glueClick(w: TestWorld, x: number, y: number, z: number, face: Dir, gridId = 0): void {
  if (w.me.player.inventory.selectedStack()?.item !== I.GLUE) w.me.hold(I.GLUE);
  expect(w.me.useOn(x, y, z, face, gridId), `aim at face ${face} of ${x},${y},${z}`).toBe(true);
}

/** With `item` in the main hand, place it against face `face` of cell (x,y,z) (checked aim). */
export function placeAgainst(w: TestWorld, item: number, x: number, y: number, z: number, face: Dir, gridId = 0): void {
  w.me.hold(item);
  expect(w.me.useOn(x, y, z, face, gridId), `aim at face ${face} of ${x},${y},${z}`).toBe(true);
}

/**
 * Assemble the raft at its helm (two right-clicks, empty hand) and return the labels of the
 * blocks the ship took, e.g. "3,T,-3:stone" is present when the stone came along.
 */
export function assembleRaft(w: TestWorld): string[] {
  w.me.teleport(1.5, T, 0.5);
  w.tick(1);
  return assembleShipByHand(w, 1, T + 1, -3, PZ).cells;
}

/** "x,y,z:stone" label of a cell (the format structureLabels uses). */
export function stoneAt(x: number, y: number, z: number): string {
  return `${x},${y},${z}:stone`;
}

/**
 * The glued faces the client would draw right now (collectGlueFaces, the way the game builds its
 * overlays: around the eyes, covered ones only with glue in a hand); see the file comment for
 * where the data comes from in each mode.
 */
export function drawnGlue(w: TestWorld): OverlayFace[] {
  const c = w.client;
  const replica = c?.replica ?? null;
  const p = c === null ? w.me.player : c.own!.player;
  const inv = c === null ? p.inventory : c.inventory;
  const main = inv.selectedStack();
  const off = inv.offhand;
  const inHand = (main !== null && main.item === I.GLUE) || (off !== null && off.item === I.GLUE);
  const eye = vec3(p.pos.x, p.pos.y + p.eyeHeight, p.pos.z);
  const world = replica === null ? w.sim.world : replica.world;
  const faces: OverlayFace[] = [];
  collectGlueFaces(world, replica === null ? w.sim.worldGlue : replica.worldGlue, 0, eye, inHand, replica === null ? null : replica.world, faces);
  for (const s of replica === null ? w.sim.structures.all() : replica.structures()) {
    if (s.removed || s.glue.size === 0) continue;
    collectGlueFaces(s.grid, s.glue, s.id, s.grid.toLocal(eye), inHand, null, faces);
  }
  return faces;
}

/** The drawn face of world cell (x,y,z) towards `face`, or undefined. */
export function drawnFace(w: TestWorld, x: number, y: number, z: number, face: Dir): OverlayFace | undefined {
  return drawnGlue(w).find((f) => f.structureId === 0 && f.x === x && f.y === y && f.z === z && f.face === face);
}
