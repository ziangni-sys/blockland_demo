/**
 * What the view builder makes of partial cells (docs/SHAPES.md 6.3, 8.6): the outline of the aimed
 * part, the crack condition (the whole part, or one octant when mining.sub bit 3 is set), the
 * preview and conflict tints over the cell's hard parts, glued faces split into covered and exposed
 * quadrants, and the light of an entity standing in a partial cell. A whole-block world gives what
 * it always gave (tests/client/pipeline.test.ts, glue-overlay.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { canonCell } from '../../src/blocks/shapes';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, NY, PX, PY, type Dir } from '../../src/core/dirs';
import { collectGlueFaces, GLUE_REFRESH_MS, partOf, sampleLight, shownPlayer, tintFill, ViewBuilder } from '../../src/client/view';
import type { MiningView, Target } from '../../src/net/protocol';
import type { ClientReplica } from '../../src/net/client/replica';
import type { OverlayFace } from '../../src/render/backend';
import { GlueStore } from '../../src/structures/glue';
import type { Simulation } from '../../src/sim/simulation';
import { getPacked } from '../../src/voxel/parts';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { FLAT_TOP, flatSim } from '../sim/helpers';
import { EAST, LOWER, NORTH, putPart, slab, stairFill, UPPER, WEST } from '../shapes';

const T = FLAT_TOP;

interface FakeView {
  mining: MiningView | null;
  gluing: null;
  preview: { gridId: number; kind: 'ship'; cells: Int32Array } | null;
  conflicts: { x: number; y: number; z: number }[];
  hint: null;
}

/** The parts of a replica updateOverlays reads, over a simulation's world (no structures). */
function replicaOf(sim: Simulation, view: FakeView, glue = new GlueStore()): ClientReplica {
  return {
    world: sim.world,
    worldGlue: glue,
    ownState: { view },
    state: { structures: new Map() },
    structures: () => [],
  } as unknown as ClientReplica;
}

function emptyView(): FakeView {
  return { mining: null, gluing: null, preview: null, conflicts: [], hint: null };
}

function target(x: number, y: number, z: number, sub: number, sim: Simulation): Target {
  return { gridId: 0, x, y, z, face: PY, sub, cell: getPacked(sim.world, x, y, z) };
}

describe('the target outline wraps the aimed part (docs/SHAPES.md 8.6)', () => {
  it('fill = the occupancy of the part holding the target octant; whole blocks, models and liquids 0xff', () => {
    const sim = flatSim();
    const w = sim.world;
    // Two parts: stone lower half, planks upper half.
    w.setCell(1, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    w.setCell(2, T, 1, slab(B.STONE, stairFill(NX as Dir)));
    w.setCell(3, T, 1, makeCell(B.TORCH));
    w.setCell(4, T, 1, makeCell(B.WATER));
    const v = new ViewBuilder();
    const r = replicaOf(sim, emptyView());
    const me = shownPlayer();
    const fillAt = (x: number, sub: number): number => v.updateOverlays(r, me, target(x, T, 1, sub, sim), 0).target!.fill;
    for (const o of [0, 1, 4, 5]) expect(fillAt(1, o)).toBe(LOWER);
    for (const o of [2, 3, 6, 7]) expect(fillAt(1, o)).toBe(UPPER);
    expect(fillAt(2, 0)).toBe(stairFill(NX as Dir));
    expect(fillAt(3, 5)).toBe(0xff);
    expect(fillAt(4, 0)).toBe(0xff);
    // A whole block: the unit cube, whatever octant.
    w.setCell(5, T, 1, makeCell(B.STONE));
    for (let o = 0; o < 8; o++) expect(fillAt(5, o)).toBe(0xff);
    const o = v.updateOverlays(r, me, target(5, T, 1, 3, sim), 0);
    expect(o.target).toEqual({ structureId: 0, x: 5, y: T, z: 1, fill: 0xff });
    expect(o.targetOctant).toBe(-1);
    expect(o.placement).toBeNull();
  });

  it('partOf reads the two part values only: the part holding the octant, 0 for an empty octant', () => {
    const lower = slab(B.STONE, LOWER);
    const upper = slab(B.PLANKS_OAK, UPPER);
    // getCell of the two-part cell: the first part plus bit 24.
    const c = lower | (1 << 24);
    for (const o of [0, 1, 4, 5]) expect(partOf(c, upper, o)).toBe(lower);
    for (const o of [2, 3, 6, 7]) expect(partOf(c, upper, o)).toBe(upper);
    expect(partOf(lower, 0, 2)).toBe(0);
    expect(partOf(makeCell(B.STONE), 0, 6)).toBe(makeCell(B.STONE));
    expect(partOf(0, 0, 0)).toBe(0);
  });
});

describe('the crack condition (docs/SHAPES.md 6.3)', () => {
  function crack(sim: Simulation, mining: MiningView, t: Target): { progress: number; fill: number } {
    const view = emptyView();
    view.mining = mining;
    const o = new ViewBuilder().updateOverlays(replicaOf(sim, view), shownPlayer(), t, 0);
    return { progress: o.breakProgress, fill: o.breakFill };
  }
  const mine = (x: number, y: number, z: number, sub: number, progress = 0.5): MiningView => ({ gridId: 0, x, y, z, sub, progress });

  it('bit 3 clear: cracks over the whole mined part while the target is on that part, not on the other part of the cell', () => {
    const sim = flatSim();
    sim.world.setCell(1, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    // Mining the lower part (first hit at octant 0); the target moved within it: still shown.
    expect(crack(sim, mine(1, T, 1, 0), target(1, T, 1, 5, sim))).toEqual({ progress: 0.5, fill: LOWER });
    // The target is on the upper part of the same cell: no cracks.
    expect(crack(sim, mine(1, T, 1, 0), target(1, T, 1, 2, sim)).progress).toBe(0);
    // Mining the upper part.
    expect(crack(sim, mine(1, T, 1, 7), target(1, T, 1, 3, sim))).toEqual({ progress: 0.5, fill: UPPER });
    // Another cell: none.
    expect(crack(sim, mine(1, T, 1, 0), target(2, T - 1, 1, 0, sim)).progress).toBe(0);
    // The same coordinates on another grid (a structure): none.
    expect(crack(sim, { gridId: 4, x: 1, y: T, z: 1, sub: 0, progress: 0.5 }, target(1, T, 1, 5, sim)).progress).toBe(0);
  });

  it('bit 3 set: cracks over that one octant while the target is on that octant (M2.4, the server sends it as 0 today)', () => {
    const sim = flatSim();
    sim.world.setCell(1, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
    expect(crack(sim, mine(1, T, 1, 8 | 4), target(1, T, 1, 4, sim))).toEqual({ progress: 0.5, fill: 1 << 4 });
    // Same part, other octant: no cracks.
    expect(crack(sim, mine(1, T, 1, 8 | 4), target(1, T, 1, 0, sim)).progress).toBe(0);
  });

  it('a whole block: cracks over the unit cube, as always; progress clamped to 0..1', () => {
    const sim = flatSim();
    expect(crack(sim, mine(1, T - 1, 1, 0, 1.5), target(1, T - 1, 1, 0, sim))).toEqual({ progress: 1, fill: 0xff });
    expect(crack(sim, mine(1, T - 1, 1, 0, 0.25), target(1, T - 1, 1, 6, sim))).toEqual({ progress: 0.25, fill: 0xff });
  });
});

describe('preview and conflict tints cover the hard parts (docs/SHAPES.md 8.6)', () => {
  it("tintFill: the union of the cell's hard parts; whole blocks, model blocks and air 0xff (a listed cell is always drawn)", () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(1, T, 1, slab(B.STONE, stairFill(NX as Dir)));
    putPart(w, 2, T, 1, slab(B.STONE, WEST));
    putPart(w, 2, T, 1, slab(B.PLANKS_OAK, 0x02)); // one octant of the east half
    w.setCell(3, T, 1, makeCell(B.TORCH));
    expect(tintFill(w, 1, T, 1)).toBe(stairFill(NX as Dir));
    expect(tintFill(w, 2, T, 1)).toBe(WEST | 0x02);
    expect(tintFill(w, 3, T, 1)).toBe(0xff);
    expect(tintFill(w, 1, T - 1, 1)).toBe(0xff);
    expect(tintFill(w, 1, T + 3, 1)).toBe(0xff);
  });

  it('a dock conflict at or above the build height (planDock lists it; the world reads air there) is drawn as a whole cell, as before shapes', () => {
    const sim = flatSim();
    const view = emptyView();
    view.conflicts = [{ x: 1, y: WORLD_HEIGHT, z: 1 }, { x: 1, y: WORLD_HEIGHT + 3, z: 1 }];
    const o = new ViewBuilder().updateOverlays(replicaOf(sim, view), shownPlayer(), null, 0);
    expect(o.conflicts).toEqual([
      { structureId: 0, x: 1, y: WORLD_HEIGHT, z: 1, fill: 0xff },
      { structureId: 0, x: 1, y: WORLD_HEIGHT + 3, z: 1, fill: 0xff },
    ]);
  });

  it("a preview on a structure reads each cell's fill from that structure's grid, not from the world", () => {
    const sim = flatSim();
    const ship = flatSim();
    // The structure's cell is a half slab; the world cell at the same coordinates is air.
    ship.world.setCell(1, T + 3, 1, slab(B.PLANKS_OAK, NORTH));
    const view = emptyView();
    view.preview = { gridId: 7, kind: 'ship', cells: new Int32Array([1, T + 3, 1]) };
    const r = replicaOf(sim, view);
    (r.state.structures as Map<number, unknown>).set(7, { structure: { grid: ship.world } });
    const o = new ViewBuilder().updateOverlays(r, shownPlayer(), null, 0);
    expect(o.preview).toEqual([{ structureId: 7, x: 1, y: T + 3, z: 1, fill: NORTH }]);
  });

  it('the lists carry each cell\'s fill, read when the server sends a new list', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(1, T, 1, slab(B.PLANKS_OAK, NORTH));
    const view = emptyView();
    view.preview = { gridId: 0, kind: 'ship', cells: new Int32Array([1, T, 1, 1, T - 1, 1]) };
    view.conflicts = [{ x: 1, y: T, z: 1 }];
    const v = new ViewBuilder();
    const r = replicaOf(sim, view);
    const o = v.updateOverlays(r, shownPlayer(), null, 0);
    expect(o.preview).toEqual([
      { structureId: 0, x: 1, y: T, z: 1, fill: NORTH },
      { structureId: 0, x: 1, y: T - 1, z: 1, fill: 0xff },
    ]);
    expect(o.conflicts).toEqual([{ structureId: 0, x: 1, y: T, z: 1, fill: NORTH }]);
    const list = o.preview;
    expect(v.updateOverlays(r, shownPlayer(), null, 1).preview).toBe(list); // cached while the list is the same
  });
});

describe('glued faces split into covered and exposed quadrants (docs/SHAPES.md 8.6)', () => {
  function faces(sim: Simulation, glue: GlueStore, showCovered: boolean): OverlayFace[] {
    const out: OverlayFace[] = [];
    collectGlueFaces(sim.world, glue, 0, { x: 0, y: T, z: 0 }, showCovered, sim.world, out);
    return out;
  }
  function lit(sim: Simulation, x: number, y: number, z: number, sky: number): void {
    sim.world.setSkyLight(x, y, z, sky);
  }

  it('a whole block half under a slab: the covered half only with glue in hand, the exposed half always, lit by the cell in front of it', () => {
    const sim = flatSim();
    const w = sim.world;
    const glue = new GlueStore();
    w.setCell(1, T, 1, makeCell(B.STONE));
    w.setCell(1, T + 1, 1, slab(B.PLANKS_OAK, WEST)); // covers the -X half of the stone's top
    glue.add(1, T, 1, PY);
    lit(sim, 1, T + 1, 1, 9);
    // Top face (PY) quadrants: u = x, v = z; the -X half is hu = 0: q 0 and 2.
    const covered = { structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PY, covered: true, sky: 0, block: 0, quads: 0b0101 };
    const exposed = { structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PY, covered: false, sky: 9, block: 0, quads: 0b1010 };
    expect(faces(sim, glue, true)).toEqual([covered, exposed]);
    expect(faces(sim, glue, false)).toEqual([exposed]);
  });

  it("the exposed part on the upper cell's side is its own entry, on that cell's face toward the glue, lit by the lower cell", () => {
    const sim = flatSim();
    const w = sim.world;
    const glue = new GlueStore();
    w.setCell(1, T, 1, slab(B.STONE, WEST)); // covers the -X half of its own top face
    w.setCell(1, T + 1, 1, makeCell(B.STONE));
    glue.add(1, T, 1, PY);
    lit(sim, 1, T, 1, 4);
    // A covers the -X half of the face (q 0, 2), B the whole face: covered -X half, B's +X half exposed.
    expect(faces(sim, glue, true)).toEqual([
      { structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PY, covered: true, sky: 0, block: 0, quads: 0b0101 },
      { structureId: 0, x: 1, y: T + 1, z: 1, fill: 0xff, face: NY, covered: false, sky: 4, block: 0, quads: 0b1010 },
    ]);
  });

  it('a lower and an upper half slab side by side touch along a line only: two exposed halves, nothing covered', () => {
    const sim = flatSim();
    const w = sim.world;
    const glue = new GlueStore();
    w.setCell(1, T, 1, slab(B.STONE, LOWER));
    w.setCell(2, T, 1, slab(B.STONE, UPPER));
    glue.add(1, T, 1, PX);
    lit(sim, 2, T, 1, 7);
    lit(sim, 1, T, 1, 3);
    // +X face quadrants: u = y, v = z; lower half hu = 0: q 0, 2.
    expect(faces(sim, glue, true)).toEqual([
      { structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PX, covered: false, sky: 7, block: 0, quads: 0b0101 },
      { structureId: 0, x: 2, y: T, z: 1, fill: 0xff, face: NX, covered: false, sky: 3, block: 0, quads: 0b1010 },
    ]);
  });

  it('two whole blocks: one covered entry; a block and air: one exposed entry on the block; nothing on either side: on A, all four quadrants', () => {
    const sim = flatSim();
    const w = sim.world;
    const glue = new GlueStore();
    w.setCell(1, T, 1, makeCell(B.STONE));
    w.setCell(2, T, 1, makeCell(B.STONE));
    glue.add(1, T, 1, PX);
    expect(faces(sim, glue, true)).toEqual([{ structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PX, covered: true, sky: 0, block: 0, quads: 15 }]);
    expect(faces(sim, glue, false)).toEqual([]);
    w.setCell(1, T, 1, 0);
    lit(sim, 1, T, 1, 12);
    expect(faces(sim, glue, true)).toEqual([{ structureId: 0, x: 2, y: T, z: 1, fill: 0xff, face: NX, covered: false, sky: 12, block: 0, quads: 15 }]);
    w.setCell(2, T, 1, 0);
    lit(sim, 2, T, 1, 11);
    expect(faces(sim, glue, true)).toEqual([{ structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PX, covered: false, sky: 11, block: 0, quads: 15 }]);
  });
});

describe('the glue list of the view builder', () => {
  it('a refresh where only the quadrants changed (the slab on a glued face swapped for its other half) sends a new list', () => {
    const sim = flatSim();
    const w = sim.world;
    const glue = new GlueStore();
    w.setCell(1, T, 1, makeCell(B.STONE));
    w.setCell(1, T + 1, 1, slab(B.PLANKS_OAK, WEST));
    glue.add(1, T, 1, PY);
    sim.world.setSkyLight(1, T + 1, 1, 9);
    const me = shownPlayer();
    me.feet.x = 1.5;
    me.feet.y = T + 1;
    me.feet.z = 3.5;
    const v = new ViewBuilder();
    const r = replicaOf(sim, emptyView(), glue);
    const first = v.updateOverlays(r, me, null, 0).glue;
    expect(first).toEqual([{ structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PY, covered: false, sky: 9, block: 0, quads: 0b1010 }]);
    // The other half: same cell, face, side and light; only the quadrants differ.
    w.setCell(1, T + 1, 1, slab(B.PLANKS_OAK, EAST));
    const second = v.updateOverlays(r, me, null, GLUE_REFRESH_MS + 1).glue;
    expect(second).not.toBe(first);
    expect(second).toEqual([{ structureId: 0, x: 1, y: T, z: 1, fill: 0xff, face: PY, covered: false, sky: 9, block: 0, quads: 0b0101 }]);
    // Nothing changed at the next refresh: the same array.
    expect(v.updateOverlays(r, me, null, 2 * GLUE_REFRESH_MS + 2).glue).toBe(second);
  });
});

describe('sampleLight in partial cells (docs/SHAPES.md 8.6)', () => {
  it('steps up a cell only when the cell is opaque in all eight octants', () => {
    const sim = flatSim();
    const w = sim.world;
    const light = { sky: 0, block: 0 };
    const probe = (x: number): number => {
      w.setSkyLight(x, T, 1, 5);
      w.setSkyLight(x, T + 1, 1, 13);
      sampleLight(w, x + 0.5, T + 0.25, 1.5, light);
      return light.sky;
    };
    w.setCell(1, T, 1, slab(B.STONE, LOWER)); // a body standing on a lower slab samples in the slab's cell
    expect(probe(1)).toBe(5);
    w.setCell(2, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER))); // all eight octants opaque
    expect(probe(2)).toBe(13);
    w.setCell(3, T, 1, canonCell(slab(B.STONE, LOWER), slab(B.GLASS, UPPER))); // glass is not opaque
    expect(probe(3)).toBe(5);
    w.setCell(4, T, 1, makeCell(B.STONE));
    expect(probe(4)).toBe(13);
    w.setCell(5, T, 1, 0);
    expect(probe(5)).toBe(5);
  });
});
