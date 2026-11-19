/**
 * Placing next to and onto partial cells (docs/SHAPES.md 6.2, 9.2, 14.2; P8b):
 *  - sim/placement.ts planPlacement, both branches (a whole block; a slab, M2.4's) and both
 *    refusals ('occupied', 'twoParts', each with its toast), as a pure function;
 *  - place(): a block put against the top of a lower slab (an inner face) goes into the cell above;
 *    a cell that has parts takes no whole block, no torch, no flower, no snow cover; pouring a
 *    bucket into it does nothing;
 *  - support (sim/support.ts): a torch and a helm need the top face below fully covered;
 *  - the overlap of the placed material with bodies and other grids is shape-aware.
 */
import { describe, expect, it } from 'vitest';
import { cellState, layersState, makeCell, stateLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { canonCell, partAt } from '../../src/blocks/shapes';
import { NX, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { REFUSAL_TOAST, planPlacement, placementTarget } from '../../src/sim/placement';
import type { Simulation } from '../../src/sim/simulation';
import type { VoxelGrid } from '../../src/voxel/grid';
import { getPacked } from '../../src/voxel/parts';
import type { GridHit } from '../../src/voxel/raycast';
import { EAST, LOWER, slab, UPPER, WEST } from '../shapes';
import { EventLog, FLAT_TOP, fill, flatSim, idAt } from './helpers';

const T = FLAT_TOP;
const PLANKS_LOW = slab(B.PLANKS_OAK, LOWER);

/** A hit as the ray would report it: cell (x,y,z) of `grid`, entered through `face` into `octant`. */
function hitOf(grid: VoxelGrid, x: number, y: number, z: number, face: Dir, octant: number): GridHit {
  const cell = getPacked(grid, x, y, z);
  return { grid, x, y, z, face, octant, cell, part: partAt(cell, octant), dist: 0, point: vec3() };
}

describe('planPlacement (sim/placement.ts)', () => {
  it('a whole block: the cell across the entered face, cell face or inner face; replaced soft cover; refused where the target is not replaceable', () => {
    const sim = flatSim();
    const w = sim.world;
    // On the turf's top (a cell face): the cell above.
    expect(planPlacement(w, hitOf(w, 0, T - 1, -2, PY, 2), B.STONE, 0, -1)).toEqual({ x: 0, y: T, z: -2, cell: makeCell(B.STONE), part: makeCell(B.STONE), replaces: false });
    // On the top of a lower slab (an inner face at y + 0.5): the cell above too, half a block above the slab.
    w.setCell(0, T, -2, PLANKS_LOW);
    expect(planPlacement(w, hitOf(w, 0, T, -2, PY, 0), B.STONE, 0, -1)).toMatchObject({ x: 0, y: T + 1, z: -2, cell: makeCell(B.STONE) });
    // A target that has parts takes no whole block (the cell under the slab's empty half included).
    w.setCell(1, T, -2, slab(B.STONE, WEST));
    expect(planPlacement(w, hitOf(w, 1, T - 1, -2, PY, 3), B.PLANKS_OAK, 0, -1)).toBe('occupied');
    expect(planPlacement(w, hitOf(w, 1, T - 1, -2, PY, 3), B.TORCH, 0, -1)).toBe('occupied');
    // A torch or a flower in the target refuses it; soft cover clicked is replaced in place.
    w.setCell(2, T, -2, makeCell(B.TORCH));
    w.setCell(3, T, -2, makeCell(B.FLOWER_RED));
    expect(planPlacement(w, hitOf(w, 2, T - 1, -2, PY, 2), B.STONE, 0, -1)).toBe('occupied');
    expect(planPlacement(w, hitOf(w, 3, T - 1, -2, PY, 2), B.STONE, 0, -1)).toBe('occupied');
    w.setCell(4, T, -2, makeCell(B.TALL_GRASS));
    expect(planPlacement(w, hitOf(w, 4, T, -2, PZ, 4), B.STONE, 0, -1)).toEqual({ x: 4, y: T, z: -2, cell: makeCell(B.STONE), part: makeCell(B.STONE), replaces: true });
    // Snow cover onto snow cover stacks.
    w.setCell(5, T, -2, makeCell(B.SNOW_LAYER, layersState(3)));
    const snow = planPlacement(w, hitOf(w, 5, T, -2, PY, 2), B.SNOW_LAYER, layersState(1), -1);
    expect(snow).toMatchObject({ x: 5, y: T, z: -2, replaces: true });
    expect(stateLayers(cellState((snow as { cell: number }).cell))).toBe(4);
  });

  it('a slab (M2.4): in front of an inner face, against a cell face, on a chosen side; merged, overwritten, or refused', () => {
    const sim = flatSim();
    const w = sim.world;
    // In front of the inner face of a lower slab: the same cell, the upper half, merged.
    w.setCell(0, T, -2, PLANKS_LOW);
    expect(planPlacement(w, hitOf(w, 0, T, -2, PY, 0), B.STONE, 0, 0)).toEqual({
      x: 0,
      y: T,
      z: -2,
      cell: canonCell(PLANKS_LOW, slab(B.STONE, UPPER)),
      part: slab(B.STONE, UPPER),
      replaces: false,
    });
    // Against the turf's top (a cell face): the cell above, against the clicked face (its lower half).
    expect(planPlacement(w, hitOf(w, 1, T - 1, -2, PY, 2), B.STONE, 0, 0)).toEqual({ x: 1, y: T, z: -2, cell: slab(B.STONE, LOWER), part: slab(B.STONE, LOWER), replaces: false });
    // slabMode 1 + Dir: that side of the same target.
    expect(planPlacement(w, hitOf(w, 1, T - 1, -2, PY, 2), B.STONE, 0, 1 + PX)).toMatchObject({ x: 1, y: T, z: -2, part: slab(B.STONE, EAST) });
    // Soft cover clicked: replaced, the slab on the lower half.
    w.setCell(2, T, -2, makeCell(B.TALL_GRASS));
    expect(planPlacement(w, hitOf(w, 2, T, -2, PZ, 4), B.STONE, 0, 0)).toMatchObject({ x: 2, y: T, z: -2, cell: slab(B.STONE, LOWER), replaces: true });
    // Liquid in the target: overwritten.
    w.setCell(3, T, -2, makeCell(B.WATER));
    expect(planPlacement(w, hitOf(w, 3, T - 1, -2, PY, 2), B.STONE, 0, 0)).toMatchObject({ cell: slab(B.STONE, LOWER) });
    // Overlapping the part there: 'occupied'.
    expect(planPlacement(w, hitOf(w, 0, T - 1, -2, PY, 2), B.STONE, 0, 0)).toBe('occupied');
    // Two parts already, the slab would not overlap them: 'twoParts' (docs/SHAPES.md 1.3).
    w.setCell(4, T, -2, canonCell(slab(B.PLANKS_OAK, 0x01), slab(B.STONE, 0x04)));
    expect(planPlacement(w, hitOf(w, 4, T - 1, -2, PY, 2), B.GLASS, 0, 1 + PX)).toBe('twoParts');
    expect(planPlacement(w, hitOf(w, 4, T - 1, -2, PY, 2), B.GLASS, 0, 0)).toBe('occupied');
    // A torch or a flower in the target: 'occupied' (merging would silently overwrite it).
    w.setCell(5, T, -2, makeCell(B.TORCH));
    w.setCell(6, T, -2, makeCell(B.FLOWER_RED));
    expect(planPlacement(w, hitOf(w, 5, T - 1, -2, PY, 2), B.STONE, 0, 0)).toBe('occupied');
    expect(planPlacement(w, hitOf(w, 6, T - 1, -2, PY, 2), B.STONE, 0, 1 + PX)).toBe('occupied');
    // The two refusals and their toasts.
    expect(REFUSAL_TOAST).toEqual({ occupied: 'toast.place.occupied', twoParts: 'toast.place.twoParts' });
  });

  it('the target alone (placementTarget), and the input checks', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(0, T, -2, PLANKS_LOW);
    const inner = hitOf(w, 0, T, -2, PY, 0);
    expect(placementTarget(inner, -1)).toEqual({ x: 0, y: T + 1, z: -2 });
    expect(placementTarget(inner, 0)).toEqual({ x: 0, y: T, z: -2 });
    expect(placementTarget(inner, 1 + NX)).toEqual({ x: 0, y: T, z: -2 });
    for (const bad of [-2, 7, 0.5, NaN]) expect(() => planPlacement(w, inner, B.STONE, 0, bad), `slabMode ${bad}`).toThrow(RangeError);
    // Blocks that cannot be cut are placed whole by the caller: a slab of one is a caller bug.
    expect(() => planPlacement(w, inner, B.TORCH, 0, 0)).toThrow(RangeError);
    expect(() => planPlacement(w, inner, B.SAND, 0, 1 + PX)).toThrow(RangeError);
  });
});

describe('placing whole blocks next to partial cells', () => {
  it('a block put against the top of a lower slab goes into the cell above, leaving the slab as it is', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    sim.world.setCell(0, T, -2, PLANKS_LOW);
    expect(me.aimAt(0, T, -2, PY, 0, false, 4)).toBe(true);
    expect(me.targetCell()).toEqual({ gridId: 0, x: 0, y: T, z: -2, face: PY, octant: 4 });
    me.hold(B.STONE);
    me.use();
    sim.tick();
    expect(getPacked(sim.world, 0, T + 1, -2)).toBe(makeCell(B.STONE));
    expect(getPacked(sim.world, 0, T, -2)).toBe(PLANKS_LOW);
    expect(log.of('blockPlaced').map((e) => [e.y, e.cell])).toEqual([[T + 1, makeCell(B.STONE)]]);
  });

  it('a cell that has parts takes no whole block, torch, flower or snow cover (toast.place.occupied), and no bucket of water', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    const west = slab(B.STONE, WEST);
    sim.world.setCell(0, T, -2, west);
    // The turf's top seen through the slab's empty east half: the target is the slab's cell.
    const aim = (): void => {
      me.lookAt(0.75, T - 0.01, -1.75);
      expect(me.targetCell()).toMatchObject({ gridId: 0, x: 0, y: T - 1, z: -2, face: PY });
    };
    for (const item of [B.PLANKS_OAK, B.TORCH, B.FLOWER_RED, B.SNOW_LAYER]) {
      log.clear();
      me.hold(item);
      aim();
      me.use();
      sim.tick();
      expect(getPacked(sim.world, 0, T, -2), `item ${item}`).toBe(west);
      expect(log.toastKeys(), `item ${item}`).toEqual(['toast.place.occupied']);
      expect(me.player.inventory.selectedStack()?.count, `item ${item}: nothing used`).toBe(64);
    }
    me.hold(I.BUCKET_WATER, 1);
    aim();
    me.use();
    sim.tick();
    expect(getPacked(sim.world, 0, T, -2)).toBe(west);
    expect(me.player.inventory.selectedStack()?.item).toBe(I.BUCKET_WATER);
  });
});

describe('support (sim/support.ts)', () => {
  /** A slab of planks at (0, T, -2) and (2, T, -2); what `item` does put on top of each (aiming at the top face of the slab's octant 4). */
  function onTop(item: number, fillA: number): { placed: boolean; toasts: string[] } {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    sim.world.setCell(0, T, -2, slab(B.PLANKS_OAK, fillA));
    me.hold(item);
    const octant = fillA === UPPER ? 6 : 4;
    expect(me.aimAt(0, T, -2, PY, 0, false, octant)).toBe(true);
    me.use();
    sim.tick();
    return { placed: idAt(sim.world, 0, T + 1, -2) === item, toasts: log.toastKeys() };
  }

  it('a torch: not on a lower slab (toast.place.support), on an upper slab yes', () => {
    expect(onTop(B.TORCH, LOWER)).toEqual({ placed: false, toasts: ['toast.place.support'] });
    expect(onTop(B.TORCH, UPPER)).toEqual({ placed: true, toasts: [] });
  });

  it('a helm: the top face below fully covered (not a lower slab, not air: toast.place.support), an upper slab or a full block yes', () => {
    expect(onTop(B.HELM, LOWER)).toEqual({ placed: false, toasts: ['toast.place.support'] });
    expect(onTop(B.HELM, UPPER)).toEqual({ placed: true, toasts: [] });
    // Against the side of a floating block: nothing below.
    const sim = flatSim();
    const log = new EventLog(sim);
    sim.world.setCell(0, T + 2, -3, makeCell(B.STONE));
    sim.soloPlayer.hold(B.HELM);
    expect(sim.soloPlayer.aimAt(0, T + 2, -3, PZ, 0)).toBe(true);
    sim.soloPlayer.use();
    sim.tick();
    expect(idAt(sim.world, 0, T + 2, -2)).toBe(B.AIR);
    expect(log.toastKeys()).toEqual(['toast.place.support']);
  });
});

describe('the overlap of the placed material (shape-aware, docs/SHAPES.md 6.2)', () => {
  /** Hands.placementBlocked: would `part` at cell (x,y,z) of `grid` overlap a body or another grid? (White box: M2.3 places only whole blocks.) */
  function blocked(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, part: number): boolean {
    const hands = sim.soloPlayer.hands as unknown as { placementBlocked(g: VoxelGrid, x: number, y: number, z: number, part: number): boolean };
    return hands.placementBlocked(grid, x, y, z, part);
  }

  it('bodies: a slab goes beside a body that stands in the other half of the cell; the half it would fill is refused', () => {
    const sim = flatSim();
    // A rabbit (0.4 wide, 0.5 high) in the west half of world cell (1, T, 0).
    const r = sim.entities.spawnRabbit(1.25, T, 0.5);
    r.setPosition(1.25, T, 0.5);
    expect(blocked(sim, sim.world, 1, T, 0, slab(B.STONE, EAST))).toBe(false);
    expect(blocked(sim, sim.world, 1, T, 0, slab(B.STONE, UPPER))).toBe(false);
    expect(blocked(sim, sim.world, 1, T, 0, slab(B.STONE, WEST))).toBe(true);
    expect(blocked(sim, sim.world, 1, T, 0, slab(B.STONE, LOWER))).toBe(true);
    expect(blocked(sim, sim.world, 1, T, 0, makeCell(B.STONE))).toBe(true);
  });

  it('bodies on a structure grid, and the world\'s partial cells against a structure cell', () => {
    const sim = flatSim({ spawn: { x: 6.5, y: T, z: 6.5 } });
    sim.structures.dynamics = null; // the raft stays exactly where it is put
    const w = sim.world;
    fill(w, 0, T + 1, 0, 2, T + 1, 2, B.PLANKS_OAK);
    w.setCell(1, T + 2, 2, makeCell(B.HELM));
    const res = sim.structures.assembleShip(1, T + 2, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const g = res.structure.grid;
    // Ship cell (3, T + 1, 0) lies on world cell (3, T + 1, 0) (the raft has not moved).
    const r = sim.entities.spawnRabbit(3.25, T + 1, 0.5);
    r.setPosition(3.25, T + 1, 0.5);
    expect(blocked(sim, g, 3, T + 1, 0, slab(B.PLANKS_OAK, EAST))).toBe(false);
    expect(blocked(sim, g, 3, T + 1, 0, slab(B.PLANKS_OAK, WEST))).toBe(true);
    r.setPosition(10.5, T, 10.5);
    // A world upper slab where the ship cell would go: a lower slab of the ship fits under it.
    w.setCell(3, T + 1, 0, slab(B.STONE, UPPER));
    expect(blocked(sim, g, 3, T + 1, 0, slab(B.PLANKS_OAK, LOWER))).toBe(false);
    expect(blocked(sim, g, 3, T + 1, 0, slab(B.PLANKS_OAK, UPPER))).toBe(true);
    expect(blocked(sim, g, 3, T + 1, 0, makeCell(B.PLANKS_OAK))).toBe(true);
    // And the other way: a world cell where the ship has an upper slab.
    w.setCell(3, T + 1, 0, 0);
    g.setCell(0, T + 1, 0, slab(B.PLANKS_OAK, UPPER));
    expect(blocked(sim, w, 0, T + 1, 0, slab(B.STONE, LOWER))).toBe(false);
    expect(blocked(sim, w, 0, T + 1, 0, makeCell(B.STONE))).toBe(true);
  });
});
