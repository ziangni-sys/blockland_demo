/**
 * Helpers for the acceptance scenarios 25–29 (强力胶与副手). Everything the player does goes
 * through the Simulation's scripted controls (look, right/left click, held item, sneak, the
 * off-hand swap key); internals are only touched to build scenes and to observe results. What
 * the player SEES of the glue is read from the client's overlay builder (src/client/view.ts),
 * the same data the renderer draws.
 *
 * Scene convention (flat world, see g1-stick-glue-helpers): a 3 x 2 oak plank raft on the ground
 * at y = T (x 0..2, z -4..-3) with a helm on its back row, the player standing at (0.5, T, 0.5)
 * south of it, looking north. The raft's east edge plank (2, T, -3) has an open east face; the
 * blocks the player glues on are put east of it, at (3, T, -3).
 */
import { expect } from 'vitest';
import { I } from '../../src/blocks/items';
import { NZ, PZ, type Dir } from '../../src/core/dirs';
import type { OverlayFace } from '../../src/render/backend';
import { ViewBuilder } from '../../src/client/view';
import type { Simulation } from '../../src/sim/simulation';
import { T, assembleShipByHand, put } from './g1-stick-glue-helpers';
import { B } from '../../src/blocks/defs';
import { facingState } from '../../src/blocks/cell';

export { T, Toasts, hardnessTicks, idAt, makeSim, measureMiningTicks, put } from './g1-stick-glue-helpers';

/** Raft planks (x 0..2, z -4..-3, y = T) and the helm at (1, T + 1, -3) facing north. */
export function buildRaft(sim: Simulation): void {
  for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) put(sim, x, T, z, B.PLANKS_OAK);
  put(sim, 1, T + 1, -3, B.HELM, facingState(NZ));
  sim.advance(2);
}

/** The raft's east edge plank, whose east (+X) face is open. */
export const EDGE: readonly [number, number, number] = [2, T, -3];
/** Where a block put against the edge plank's east face lands. */
export const EAST: readonly [number, number, number] = [3, T, -3];

/**
 * The player stands where the raft's east side and the cell east of it are in view: south-east
 * of the raft, looking north-west.
 */
export function standSouthEast(sim: Simulation): void {
  sim.soloPlayer.teleport(4.5, T, -0.5);
  sim.advance(1);
}

/** With glue in the main hand, one right-click on face `face` of cell (x,y,z) (checked aim). */
export function glueClick(sim: Simulation, x: number, y: number, z: number, face: Dir, gridId = 0): void {
  if (sim.soloPlayer.player.inventory.selectedStack()?.item !== I.GLUE) sim.soloPlayer.hold(I.GLUE);
  expect(sim.soloPlayer.useOn(x, y, z, face, gridId), `aim at face ${face} of ${x},${y},${z}`).toBe(true);
}

/** With `item` in the main hand, place it against face `face` of cell (x,y,z) (checked aim). */
export function placeAgainst(sim: Simulation, item: number, x: number, y: number, z: number, face: Dir, gridId = 0): void {
  sim.soloPlayer.hold(item);
  expect(sim.soloPlayer.useOn(x, y, z, face, gridId), `aim at face ${face} of ${x},${y},${z}`).toBe(true);
}

/**
 * Assemble the raft at its helm (two right-clicks, empty hand) and return the labels of the
 * blocks the ship took, e.g. "3,T,-3:stone" is present when the stone came along.
 */
export function assembleRaft(sim: Simulation): string[] {
  sim.soloPlayer.teleport(1.5, T, 0.5);
  sim.advance(1);
  return assembleShipByHand(sim, 1, T + 1, -3, PZ).cells;
}

/** "x,y,z:stone" label of a cell (the format structureLabels uses). */
export function stoneAt(x: number, y: number, z: number): string {
  return `${x},${y},${z}:stone`;
}

/** The glued faces the client would draw right now (built the way the game builds its overlays). */
export function drawnGlue(sim: Simulation): OverlayFace[] {
  const v = new ViewBuilder();
  return v.updateOverlays(sim, sim.soloPlayer, 0).glue;
}

/** The drawn face of world cell (x,y,z) towards `face`, or undefined. */
export function drawnFace(sim: Simulation, x: number, y: number, z: number, face: Dir): OverlayFace | undefined {
  return drawnGlue(sim).find((f) => f.structureId === 0 && f.x === x && f.y === y && f.z === z && f.face === face);
}
