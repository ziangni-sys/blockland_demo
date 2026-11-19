/**
 * Acceptance scenario 47 (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md 16.4), headless, whole
 * simulation, in both modes: after a save round trip, partial blocks and two-part cells are
 * unchanged, in the world (a loaded column, and a column that was unloaded and stashed before the
 * save) and on a ship the player assembled at its helm.
 *
 * The scene is written on the server (w.sim): the tools that make partial blocks come in M2.4.
 * The player's action is the assembly (two right-clicks on the helm) and letting go of the wheel.
 * The save goes through the server's storage path (g6-save-helpers.ts saveThroughStorage) and
 * comes back into a fresh world with the same seed and generator, which the player joins.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PX } from '../../src/core/dirs';
import { exportSave, type SaveBundle } from '../../src/sim/persist';
import { loadWorld, newWorld, readAgain, rightClick, saveThroughStorage, type StoredSave } from './g6-save-helpers';
import { GROUND, partialRaft, placeRow, SHOWCASE, shapesSpec, structureLabels, worldLabels } from './g8-shapes-helpers';
import type { TestWorld } from './world';

const SPEC = shapesSpec(47);
/** The showcase row in the loaded area, the raft beside it, and a column far outside the load radius (3). */
const ROW = { x: -4, y: GROUND, z: -4 };
const RAFT = { x: -3, z: 3 };
const FAR = { cx: 9, cz: 0 };

function bundleBytes(b: SaveBundle): { chunks: Record<string, number[]>; blobs: Record<string, number[]> } {
  return {
    chunks: Object.fromEntries(b.chunks.map(([k, v]) => [String(k), Array.from(v)])),
    blobs: Object.fromEntries(b.blobs.map(([n, v]) => [n, Array.from(v)])),
  };
}

/** Labels of the far column's showcase, loading the column (from the stash) when needed. */
function farLabels(w: TestWorld): string[] {
  const sim = w.sim;
  if (sim.world.getChunk(FAR.cx, FAR.cz) === undefined) sim.chunks.loadColumn(sim.generator, FAR.cx, FAR.cz);
  const x0 = FAR.cx * 16 + 2;
  return worldLabels(sim, x0, GROUND, 5, x0 + SHOWCASE.length - 1, GROUND + 1, 5);
}

interface Played {
  w: TestWorld;
  row: string[];
  far: string[];
  ship: string[];
}

function play(): Played {
  const w = newWorld(SPEC);
  const { sim, me } = w;
  placeRow(sim.world, ROW.x, ROW.y, ROW.z, SHOWCASE);
  // The same row stacked on top of a few full blocks one layer up, in a different order.
  placeRow(sim.world, ROW.x, ROW.y + 1, ROW.z, [...SHOWCASE].reverse());
  const { helm } = partialRaft(sim, RAFT.x, RAFT.z);
  // A column beyond the load radius: loaded by hand, edited, then unloaded into the stash.
  sim.chunks.loadColumn(sim.generator, FAR.cx, FAR.cz);
  const x0 = FAR.cx * 16 + 2;
  placeRow(sim.world, x0, GROUND, 5, SHOWCASE);
  placeRow(sim.world, x0, GROUND + 1, 5, SHOWCASE.slice(3));
  const far = worldLabels(sim, x0, GROUND, 5, x0 + SHOWCASE.length - 1, GROUND + 1, 5);
  w.tick(2);
  // The player assembles the raft at its helm (preview, then assemble: takes the wheel) and lets go.
  me.emptyHand();
  rightClick(w, helm[0], helm[1], helm[2], PX);
  rightClick(w, helm[0], helm[1], helm[2], PX);
  const ship = sim.structures.ships()[0];
  if (ship === undefined) throw new Error('the raft did not assemble');
  me.use();
  w.tick(5);
  sim.chunks.unloadFar(100);
  expect(sim.world.getChunk(FAR.cx, FAR.cz), 'the far column is stashed').toBeUndefined();
  return {
    w,
    row: worldLabels(sim, ROW.x, ROW.y, ROW.z, ROW.x + SHOWCASE.length - 1, ROW.y + 1, ROW.z),
    far,
    ship: structureLabels(ship),
  };
}

describe('47. 存档往返后，部分方块和双部件格子都不变。', () => {
  let played: Played;
  let saved: StoredSave;
  let loaded: TestWorld;

  beforeAll(async () => {
    played = play();
    saved = await saveThroughStorage(played.w, 'shapes', 'shapes', SPEC.seed);
    loaded = loadWorld(SPEC, saved.loaded);
  });

  it('(premise) the scene has every kind of partial cell: parts with holes, two-part cells, a filled two-part cell, a stair, a single octant', () => {
    expect(played.row).toHaveLength(2 * SHOWCASE.length);
    expect(played.row.some((l) => l.includes('+'))).toBe(true); // two-part cells
    expect(played.row).toContain(`${ROW.x + 4},${ROW.y},${ROW.z}:planks_oak[0f]+planks_oak[f0]`);
    expect(played.row).toContain(`${ROW.x + 5},${ROW.y},${ROW.z}:iron_block[80]`);
    expect(played.ship.filter((l) => l.includes('+'))).toHaveLength(2);
    expect(played.far).toHaveLength(SHOWCASE.length + SHOWCASE.length - 3);
  });

  it('the world: every part of every cell of the loaded area is unchanged', () => {
    const { sim } = loaded;
    expect(worldLabels(sim, ROW.x, ROW.y, ROW.z, ROW.x + SHOWCASE.length - 1, ROW.y + 1, ROW.z)).toEqual(played.row);
  });

  it('the world: a column that was unloaded (stashed) before the save is unchanged when it loads again', () => {
    expect(farLabels(loaded)).toEqual(played.far);
  });

  it('the ship: every part of every cell is unchanged (structure save: runs of Cells)', () => {
    const ship = loaded.sim.structures.ships()[0];
    expect(ship).toBeDefined();
    expect(structureLabels(ship!)).toEqual(played.ship);
  });

  it('the save goes into the storage and comes back byte for byte; saving the reloaded world again gives the same bytes', async () => {
    expect(bundleBytes(saved.loaded)).toEqual(bundleBytes(saved.exported));
    const again = exportSave(loadWorld(SPEC, await readAgain(saved)).sim);
    expect(bundleBytes(again)).toEqual(bundleBytes(saved.exported));
  });

  it('the reloaded world runs on with the parts in place (a few ticks change none of them)', () => {
    loaded.tick(20);
    expect(worldLabels(loaded.sim, ROW.x, ROW.y, ROW.z, ROW.x + SHOWCASE.length - 1, ROW.y + 1, ROW.z)).toEqual(played.row);
    expect(structureLabels(loaded.sim.structures.ships()[0]!)).toEqual(played.ship);
  });
});
