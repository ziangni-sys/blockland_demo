/**
 * Acceptance scenario 47 (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md 16.4), headless, whole
 * simulation, in both modes: after a save round trip, partial blocks and two-part cells are
 * unchanged, in the world (a loaded column, and a column that was unloaded and stashed before the
 * save), on a ship the player assembled at its helm and on a spinning windmill of half slabs the
 * player started at its bearing; glue on partial faces in all three is unchanged too.
 *
 * The scene is written on the server (w.sim): the tools that make partial blocks come in M2.4.
 * The player's actions are the assembly (two right-clicks on the helm), letting go of the wheel,
 * and starting the windmill (two right-clicks on the bearing).
 * The save goes through the server's storage path (g6-save-helpers.ts saveThroughStorage) and
 * comes back into a fresh world with the same seed and generator, which the player joins.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX, PY, PZ } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import { NORTH, slab, SOUTH } from '../shapes';
import { exportSave, type SaveBundle } from '../../src/sim/persist';
import { glueStores, loadWorld, newWorld, readAgain, rightClick, saveThroughStorage, type StoredSave } from './g6-save-helpers';
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
  rotor: string[];
  glue: Record<string, number[]>;
}

/**
 * A windmill of half slabs: a bearing facing north at BEARING, its hub the south half of the cell
 * in front of it (touching the bearing's face), two arms of south half slabs of canvas in each of
 * four directions (9 cells, each half canvas: 4.5 sails), the tip of the east arm a two-part cell (canvas south,
 * planks north).
 */
const BEARING = { x: 4, y: GROUND + 3, z: 2 };
function halfSlabWindmill(sim: Simulation): void {
  const w = sim.world;
  const { x, y, z } = BEARING;
  w.setCell(x, y, z, makeCell(B.BEARING, facingState(NZ)));
  const arms: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]];
  for (const [dx, dy] of arms) w.setCell(x + dx, y + dy, z - 1, slab(B.CANVAS, SOUTH));
  w.setCell(x + 2, y, z - 1, canonCell(slab(B.CANVAS, SOUTH), slab(B.PLANKS_OAK, NORTH)));
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
  halfSlabWindmill(sim);
  // Glue on partial faces: in the world (the south face of the row's lower slab: its lower half),
  // on the raft (the south face of its lower slab: rides along into the ship), on the windmill
  // (the top face of its upper arm: a south half slab covers half of it; rides into the rotor).
  sim.worldGlue.add(ROW.x, ROW.y, ROW.z, PZ);
  sim.worldGlue.add(RAFT.x, GROUND, RAFT.z + 3, PZ);
  sim.worldGlue.add(BEARING.x, BEARING.y + 2, BEARING.z - 1, PY);
  w.tick(2);
  // The player assembles the raft at its helm (preview, then assemble: takes the wheel) and lets go.
  me.emptyHand();
  rightClick(w, helm[0], helm[1], helm[2], PX);
  rightClick(w, helm[0], helm[1], helm[2], PX);
  const ship = sim.structures.ships()[0];
  if (ship === undefined) throw new Error('the raft did not assemble');
  me.use();
  w.tick(5);
  // The player starts the windmill from behind its bearing (preview, then start) and lets it spin.
  me.teleport(BEARING.x + 0.5, GROUND, BEARING.z + 2.5);
  rightClick(w, BEARING.x, BEARING.y, BEARING.z, PZ);
  rightClick(w, BEARING.x, BEARING.y, BEARING.z, PZ);
  const rotor = sim.structures.rotors()[0];
  if (rotor === undefined) throw new Error('the windmill did not start');
  w.tick(20);
  sim.chunks.unloadFar(100);
  expect(sim.world.getChunk(FAR.cx, FAR.cz), 'the far column is stashed').toBeUndefined();
  return {
    w,
    row: worldLabels(sim, ROW.x, ROW.y, ROW.z, ROW.x + SHOWCASE.length - 1, ROW.y + 1, ROW.z),
    far,
    ship: structureLabels(ship),
    rotor: structureLabels(rotor),
    glue: glueStores(sim),
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
    expect(played.rotor).toHaveLength(9);
    expect(played.rotor.filter((l) => l.includes('+'))).toHaveLength(1);
    // Glue on partial faces in all three kinds of grid: the world, the ship, the rotor.
    const { sim } = played.w;
    const ship = sim.structures.ships()[0]!;
    const rotor = sim.structures.rotors()[0]!;
    expect(sim.worldGlue.has(ROW.x, ROW.y, ROW.z, PZ)).toBe(true);
    expect(ship.glue.has(RAFT.x, GROUND, RAFT.z + 3, PZ)).toBe(true);
    expect(rotor.glue.size).toBe(1);
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

  it('the rotor: every part of every cell is unchanged, and it still spins', () => {
    const rotor = loaded.sim.structures.rotors()[0];
    expect(rotor).toBeDefined();
    expect(structureLabels(rotor!)).toEqual(played.rotor);
    expect(rotor!.sails).toBe(4.5);
  });

  it('glue on partial faces: the world\'s, the ship\'s and the rotor\'s glue are unchanged', () => {
    expect(glueStores(loaded.sim)).toEqual(played.glue);
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
