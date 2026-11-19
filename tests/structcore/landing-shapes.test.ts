/**
 * Landing structure cells back as blocks with partial blocks (docs/SHAPES.md 11.3, 11.4): the five
 * results of landing(); the dock preview (planDock) and the commit agree cell by cell, the
 * conflicts carry `limit` for "more than two parts"; parts that do not overlap merge into one cell
 * (one write) and the merged cell is one unit afterwards (it re-assembles whole; its old glue to
 * the world is gone); a cell that cannot land drops once per part, at the part's DROP_POINT
 * (docking and stopping a rotor); and docking in each of the 24 orientations rotates every cell's
 * shapes, second part and state with it (rotCell), the glue faces too.
 */
import { describe, expect, it } from 'vitest';
import { axisState, AIR, makeCell, cellSecond, PART_MASK, partHoles } from '../../src/blocks/cell';
import { B, CELL_UNLOADED } from '../../src/blocks/defs';
import { BLOCKS, SOLID } from '../../src/blocks/registry';
import { canonCell, DROP_POINT, rotateFill } from '../../src/blocks/shapes';
import { ALL_DIRS, DIR_X, DIR_Y, DIR_Z, PX, PY, type Dir } from '../../src/core/dirs';
import { qfromYaw, qrotate, vec3, vsub, type Vec3 } from '../../src/core/math';
import {
  commitDock,
  LAND_CONFLICT,
  LAND_LIMIT,
  LAND_MERGE,
  LAND_OVERWRITE,
  LAND_WRITE,
  landing,
  planDock,
  snapCell,
  type SnapTransform,
} from '../../src/structures/assembly';
import { rotCell, rotDir, type GridRot } from '../../src/structures/orient';
import { applyRotorPose } from '../../src/structures/rotor';
import type { Rotor, Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST, EAST } from '../shapes';
import { c, facing, fill, rotY, scene, windmill, type Scene } from './helpers';

const HELM: readonly [number, number, number] = [0, 61, 2];

/** Partial cells on the raft (all stick to the deck through a planks part, the log slab through glue). */
const PARTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2, 61, -2, slab(B.PLANKS_OAK, LOWER)],
  [-1, 61, -2, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST))],
  [0, 61, -2, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_PINE, UPPER))],
  [1, 61, -2, slab(B.PLANKS_OAK, stairFill(PX))],
  [2, 61, -2, slab(B.PLANKS_OAK, 0x01)],
  [-2, 61, 0, slab(B.LOG_OAK, LOWER, axisState(0))],
  [0, 61, 0, slab(B.PLANKS_OAK, 0x7f)],
  [2, 61, 0, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.WOOL_RED, SOUTH))],
];
const RAFT_CELLS = 25 + 1 + PARTS.length;

/** A 5 x 5 planks deck at y = 60 (x, z in -2..2), a helm facing north at HELM, the partial cells. */
function buildRaft(s: Scene): void {
  fill(s.world, -2, 60, -2, 2, 60, 2, c(B.PLANKS_OAK));
  s.world.setCell(HELM[0], HELM[1], HELM[2], facing(B.HELM, 5));
  for (const [x, y, z, p] of PARTS) s.world.setCell(x, y, z, p);
  s.host.worldGlue.add(-2, 60, 0, PY); // the log slab is glued to the deck
}

function raftShip(s: Scene): Ship {
  buildRaft(s);
  const r = s.mgr.assembleShip(...HELM);
  if (!r.ok) throw new Error(r.reason);
  expect(r.structure.grid.count).toBe(RAFT_CELLS);
  return r.structure;
}

/** Every grid rotation (24): +X and +Y images on different axes, +Z their cross product. */
function allRots(): GridRot[] {
  const out: GridRot[] = [];
  for (const ax of ALL_DIRS) {
    for (const ay of ALL_DIRS) {
      if (ax >> 1 === ay >> 1) continue;
      const cx = DIR_Y[ax]! * DIR_Z[ay]! - DIR_Z[ax]! * DIR_Y[ay]!;
      const cy = DIR_Z[ax]! * DIR_X[ay]! - DIR_X[ax]! * DIR_Z[ay]!;
      const cz = DIR_X[ax]! * DIR_Y[ay]! - DIR_Y[ax]! * DIR_X[ay]!;
      const az = ALL_DIRS.find((d) => DIR_X[d] === cx && DIR_Y[d] === cy && DIR_Z[d] === cz)!;
      out.push({ ax, ay, az });
    }
  }
  return out;
}

/** The rotations of k quarter yaw turns (+X -> -Z for k = 1, as rotY). */
const YAWS: readonly GridRot[] = [
  { ax: 0, ay: 2, az: 4 },
  { ax: 5, ay: 2, az: 0 },
  { ax: 1, ay: 2, az: 5 },
  { ax: 4, ay: 2, az: 1 },
];

/** The parts of a packed cell as sorted "id:fill" strings. */
function partSet(packed: number): string[] {
  const out: string[] = [];
  for (const p of [packed & PART_MASK, cellSecond(packed)]) if ((p & 0x3ff) !== 0) out.push(`${p & 0x3ff}:${~partHoles(p) & 0xff}`);
  return out.sort();
}

describe('landing(): five results (SHAPES 11.3)', () => {
  it('air: write; soft blocks and liquids: overwrite', () => {
    expect(landing(AIR, slab(B.PLANKS_OAK, LOWER), false)).toBe(LAND_WRITE);
    expect(landing(AIR, c(B.STONE), false)).toBe(LAND_WRITE);
    for (const soft of [c(B.TORCH), c(B.TALL_GRASS), c(B.SNOW_LAYER), c(B.WATER), c(B.LAVA)]) {
      expect(landing(soft, slab(B.PLANKS_OAK, LOWER), false)).toBe(LAND_OVERWRITE);
      expect(landing(soft, canonCell(slab(B.STONE, LOWER), slab(B.BRICKS, UPPER)), false)).toBe(LAND_OVERWRITE);
    }
  });

  it('hard parts: merge when they do not overlap and stay at two parts; conflict on overlap; limit beyond two parts', () => {
    expect(landing(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER), false)).toBe(LAND_MERGE);
    expect(landing(slab(B.STONE, 0x01), slab(B.PLANKS_OAK, 0xfe), false)).toBe(LAND_MERGE);
    expect(landing(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, LOWER), false)).toBe(LAND_CONFLICT);
    expect(landing(slab(B.STONE, LOWER), c(B.PLANKS_OAK), false)).toBe(LAND_CONFLICT); // a full block never merges
    expect(landing(slab(B.STONE, LOWER), c(B.TORCH), false)).toBe(LAND_CONFLICT); // nor does a model block
    expect(landing(c(B.STONE), slab(B.PLANKS_OAK, UPPER), false)).toBe(LAND_CONFLICT);
    const twoDest = canonCell(slab(B.STONE, 0x01), slab(B.BRICKS, 0x02));
    expect(landing(twoDest, slab(B.PLANKS_OAK, 0x04), false)).toBe(LAND_LIMIT);
    expect(landing(slab(B.STONE, 0x01), canonCell(slab(B.PLANKS_OAK, 0x02), slab(B.BRICKS, 0x04)), false)).toBe(LAND_LIMIT);
    // A two-part incoming cell of which one part overlaps: the whole cell conflicts.
    expect(landing(slab(B.STONE, 0x01), canonCell(slab(B.PLANKS_OAK, 0x01), slab(B.BRICKS, 0x80)), false)).toBe(LAND_CONFLICT);
    expect(landing(twoDest, canonCell(slab(B.PLANKS_OAK, 0x01 | 0x40), slab(B.BRICKS, 0x80)), false)).toBe(LAND_CONFLICT);
  });

  it('above the build height, unloaded or below the world: conflict', () => {
    expect(landing(AIR, slab(B.PLANKS_OAK, LOWER), true)).toBe(LAND_CONFLICT);
    expect(landing(CELL_UNLOADED, slab(B.PLANKS_OAK, LOWER), false)).toBe(LAND_CONFLICT);
    expect(landing(c(B.DEEPROCK), c(B.PLANKS_OAK), false)).toBe(LAND_CONFLICT);
  });

  it('full blocks only: exactly the M1 rule (hard: conflict, soft: overwrite, air: write)', () => {
    for (const def of BLOCKS) {
      if (!def) continue;
      const dest = makeCell(def.id);
      const m1 = SOLID[def.id] ? LAND_CONFLICT : dest === AIR ? LAND_WRITE : LAND_OVERWRITE;
      for (const incoming of [c(B.PLANKS_OAK), c(B.HELM), c(B.TORCH)]) expect(landing(dest, incoming, false), def.key).toBe(m1);
    }
  });
});

describe('docking onto parts: preview and commit agree (SHAPES 11.3)', () => {
  /** The raft assembled; world cells under its footprint then hold parts that merge, conflict and overflow. */
  function dockScene() {
    const s = scene();
    const ship = raftShip(s);
    const w = s.world;
    w.setCell(-2, 61, -2, slab(B.BRICKS, UPPER)); // over the lower planks slab: merge
    w.setCell(1, 61, -2, slab(B.BRICKS, 0x44)); // beside the stair, in its free octants: merge
    w.setCell(-1, 61, -2, slab(B.BRICKS, 0x80)); // into the full two-part cell: conflict
    w.setCell(2, 61, -2, canonCell(slab(B.STONE, 0x02), slab(B.BRICKS, 0x04))); // a third part: limit
    w.setCell(0, 60, 0, slab(B.STONE, LOWER)); // under a deck plank: conflict
    // The bricks slab at the merge cell is glued to a world block beside the footprint.
    w.setCell(-3, 61, -2, c(B.STONE));
    s.host.worldGlue.add(-3, 61, -2, PX);
    return { s, ship };
  }

  it('planDock lists the conflicts with `limit`; dockShip refuses with the same list', () => {
    const { s, ship } = dockScene();
    const plan = planDock(s.world, ship.grid);
    const sorted = (a: Array<{ x: number; y: number; z: number; limit: boolean }>) =>
      a.map((p) => `${p.x},${p.y},${p.z}:${p.limit}`).sort();
    expect(sorted(plan.conflicts)).toEqual(['-1,61,-2:false', '0,60,0:false', '2,61,-2:true']);
    expect(plan.placed).toBe(RAFT_CELLS - 3);
    expect(plan.overwritten).toBe(0);
    const res = s.mgr.dockShip(ship);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('blocked');
      expect(sorted(res.conflicts)).toEqual(sorted(plan.conflicts));
    }
    expect(s.mgr.ships()).toHaveLength(1); // nothing happened
  });

  it('the commit lands every cell as planned: merges in one write, drops one item per part of each blocked cell at its DROP_POINT', () => {
    const { s, ship } = dockScene();
    const plan = planDock(s.world, ship.grid);
    const events: string[] = [];
    s.world.onCellChange((x, y, z) => events.push(`${x},${y},${z}`));
    const out = commitDock(s.host, ship, plan.t, null);
    expect(out.report).toEqual({ placed: plan.placed, dropped: plan.conflicts.length, overwritten: plan.overwritten });
    // Merges: one write each, the result in canonical order.
    expect(getPacked(s.world, -2, 61, -2)).toBe(canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.BRICKS, UPPER)));
    expect(getPacked(s.world, 1, 61, -2)).toBe(canonCell(slab(B.PLANKS_OAK, stairFill(PX)), slab(B.BRICKS, 0x44)));
    expect(events.filter((k) => k === '-2,61,-2')).toHaveLength(1);
    // Blocked cells keep what the world had; each blocked ship cell drops once per part.
    expect(getPacked(s.world, -1, 61, -2)).toBe(slab(B.BRICKS, 0x80));
    expect(getPacked(s.world, 0, 60, 0)).toBe(slab(B.STONE, LOWER));
    const drops = s.host.drops.map((d) => `${d.item}@${d.x},${d.y},${d.z}`).sort();
    const at = (x: number, y: number, z: number, fill: number) =>
      `${x + DROP_POINT[fill * 3]!},${y + DROP_POINT[fill * 3 + 1]!},${z + DROP_POINT[fill * 3 + 2]!}`;
    expect(drops).toEqual(
      [
        `${B.PLANKS_OAK}@${at(-1, 61, -2, WEST)}`, // the two-part cell: planks west ...
        `${B.COBBLE}@${at(-1, 61, -2, EAST)}`, // ... and stone east (which drops cobble)
        `${B.PLANKS_OAK}@${at(2, 61, -2, 0x01)}`, // the single octant (limit)
        `${B.PLANKS_OAK}@${at(0, 60, 0, 0xff)}`, // the deck plank: cell centre, as in M1
      ].sort(),
    );
    expect(at(-1, 61, -2, EAST)).toBe('-0.25,61.25,-1.75');
  });

  it('a merged cell is one unit: its old glue to the world is gone, and re-assembling takes it whole', () => {
    const { s, ship } = dockScene();
    // Clear the blocking cells so the dock goes through; the two merges stay.
    s.world.setCell(-1, 61, -2, AIR);
    s.world.setCell(2, 61, -2, AIR);
    s.world.setCell(0, 60, 0, AIR);
    expect(s.host.worldGlue.has(-3, 61, -2, PX)).toBe(true);
    const res = s.mgr.dockShip(ship);
    expect(res.ok && res.report).toEqual({ placed: RAFT_CELLS, dropped: 0, overwritten: 0 });
    expect(s.host.worldGlue.has(-3, 61, -2, PX)).toBe(false); // no joint the move created (SHAPES 17, question 2)
    expect(s.host.worldGlue.has(-2, 60, 0, PY)).toBe(true); // the ship's own glue came along
    const again = s.mgr.assembleShip(...HELM);
    if (!again.ok) throw new Error(again.reason);
    expect(again.structure.grid.count).toBe(RAFT_CELLS); // the same number of cells ...
    expect(getPacked(again.structure.grid, -2, 61, -2)).toBe(canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.BRICKS, UPPER))); // ... merged parts included
    expect(getPacked(s.world, -2, 61, -2)).toBe(AIR);
    expect(getPacked(s.world, -3, 61, -2)).toBe(c(B.STONE)); // the old neighbour stays behind
  });
});

describe('a merged cell counts as written by the dock (SHAPES 11.3)', () => {
  it('a ship cell merging into a world part keeps its glue to the neighbouring ship cell', () => {
    const s = scene();
    const ship = raftShip(s);
    // The log slab (lower, glued to the deck plank below it) lands on an upper bricks slab: merge.
    s.world.setCell(-2, 61, 0, slab(B.BRICKS, UPPER));
    const res = s.mgr.dockShip(ship);
    expect(res.ok && res.report).toEqual({ placed: RAFT_CELLS, dropped: 0, overwritten: 0 });
    expect(getPacked(s.world, -2, 61, 0)).toBe(canonCell(slab(B.LOG_OAK, LOWER, axisState(0)), slab(B.BRICKS, UPPER)));
    // Seen from the deck plank, the merged cell was written by this dock (the glue travelled with
    // both cells), not a world block the ship did not bring: the face keeps its glue.
    expect(s.host.worldGlue.has(-2, 60, 0, PY)).toBe(true);
    expect(s.host.worldGlue.size).toBe(1);
  });
});

describe('a dock commit after a turn drops a blocked cell as it lands, rotated (SHAPES 19.4)', () => {
  it('a quarter yaw: the blocked two-part cell drops each part at the DROP_POINT of its rotated fill', () => {
    const s = scene();
    const ship = raftShip(s);
    const r = YAWS[1]!; // +X -> -Z
    const t: SnapTransform = { r, pivot: vec3(ship.grid.pivot.x, ship.grid.pivot.y, ship.grid.pivot.z), target: vec3(4.3, 90.6, -5.2) };
    // planks on the west half, stone on the east half; turned, the stone lies north (-Z), the planks south.
    const two = canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST));
    expect(getPacked(ship.grid, -1, 61, -2)).toBe(two);
    expect(rotCell(r, two)).toBe(canonCell(slab(B.STONE, NORTH), slab(B.PLANKS_OAK, SOUTH)));
    const d = snapCell(t, -1, 61, -2);
    s.world.setCell(d.x, d.y, d.z, c(B.STONE)); // the only blocked destination
    const out = commitDock(s.host, ship, t, null);
    expect(out.report).toEqual({ placed: RAFT_CELLS - 1, dropped: 1, overwritten: 0 });
    // First part first: the stone (north half, octant 0) drops cobble at octant 0's centre, the
    // planks (south half) at octant 4's centre.
    expect(s.host.drops.map((q) => [q.item, q.x - d.x, q.y - d.y, q.z - d.z])).toEqual([
      [B.COBBLE, 0.25, 0.25, 0.25],
      [B.PLANKS_OAK, 0.25, 0.25, 0.75],
    ]);
  });
});

describe('the glue rules where the cells landed use the faces cells are on (SHAPES 11.3 settlePlacedGlue)', () => {
  it('an exposed glued face of a landed cell stays while the cell is on that face, and goes when it is not', () => {
    const s = scene();
    const ship = raftShip(s);
    // Glue put straight into the ship's store on the exposed top faces of two slabs: the lower
    // slab is not on its top face, the upper half of the two-part cell is.
    ship.glue.add(-2, 61, -2, PY); // lower planks slab
    ship.glue.add(0, 61, -2, PY); // planks below, pine above
    const res = s.mgr.dockShip(ship);
    expect(res.ok).toBe(true);
    expect(s.host.worldGlue.has(-2, 61, -2, PY)).toBe(false);
    expect(s.host.worldGlue.has(0, 61, -2, PY)).toBe(true);
  });
});

describe('a rotor stopping onto parts (SHAPES 11.3)', () => {
  it('merges where the parts fit, and drops each part of a blocked cell at its DROP_POINT', () => {
    const s = scene();
    windmill(s.world, 0, 65, 0, 2); // hub (0,65,1), arms of 2 felt cells in the plane z = 1
    const two = canonCell(slab(B.WOOL_WHITE, LOWER), slab(B.WOOL_BLUE, UPPER));
    s.world.setCell(1, 65, 1, two);
    s.world.setCell(2, 65, 1, slab(B.WOOL_RED, LOWER));
    s.world.setCell(0, 66, 1, slab(B.WOOL_WHITE, WEST));
    const r = s.mgr.startRotor(s.world, 0, 65, 0);
    if (!r.ok) throw new Error(r.reason);
    const rotor: Rotor = r.structure;
    expect(rotor.grid.count).toBe(9);
    expect(rotor.sails).toBe(9 - 0.5 - 0.5);
    s.world.setCell(1, 65, 1, slab(B.STONE, LOWER)); // overlaps the white half: conflict
    s.world.setCell(2, 65, 1, slab(B.STONE, UPPER)); // fits over the red slab: merge
    s.world.setCell(0, 66, 1, canonCell(slab(B.STONE, 0x02), slab(B.BRICKS, 0x08))); // fits, but a third part: limit
    const rep = s.mgr.stopRotor(rotor);
    expect(rep).toEqual({ placed: 7, dropped: 2, overwritten: 0 });
    expect(getPacked(s.world, 2, 65, 1)).toBe(canonCell(slab(B.WOOL_RED, LOWER), slab(B.STONE, UPPER)));
    expect(getPacked(s.world, 1, 65, 1)).toBe(slab(B.STONE, LOWER));
    expect(getPacked(s.world, 0, 66, 1)).toBe(canonCell(slab(B.STONE, 0x02), slab(B.BRICKS, 0x08)));
    expect(s.host.drops.map((d) => [d.item, d.x, d.y, d.z])).toEqual([
      [B.WOOL_WHITE, 1.25, 65.25, 1.25],
      [B.WOOL_BLUE, 1.25, 65.75, 1.25],
      [B.WOOL_WHITE, 0.25, 66.25, 1.25],
    ]);
  });
});

describe('a rotor stopping after a quarter turn drops a blocked cell as it lands, rotated (SHAPES 19.4)', () => {
  it('the two-part arm cell, turned to point up, drops each part at the DROP_POINT of its rotated fill', () => {
    const s = scene();
    windmill(s.world, 0, 65, 0, 2); // bearing facing +Z, hub (0,65,1), arms of 2 felt cells in the plane z = 1
    // The first cell of the +X arm: white felt below, blue felt above.
    s.world.setCell(1, 65, 1, canonCell(slab(B.WOOL_WHITE, LOWER), slab(B.WOOL_BLUE, UPPER)));
    const r = s.mgr.startRotor(s.world, 0, 65, 0);
    if (!r.ok) throw new Error(r.reason);
    const rotor: Rotor = r.structure;
    rotor.angle = Math.PI / 2; // a quarter turn about +Z: the +X arm points up
    applyRotorPose(rotor);
    s.world.setCell(0, 66, 1, c(B.STONE)); // where that cell lands
    const rep = s.mgr.stopRotor(rotor);
    expect(rep).toEqual({ placed: 8, dropped: 1, overwritten: 0 });
    // Turned a quarter about +Z, the lower half lies on +X and the upper half on -X: blue (west,
    // octant 0) is the first part now, white (east) the second.
    expect(s.host.drops.map((q) => [q.item, q.x, q.y, q.z])).toEqual([
      [B.WOOL_BLUE, 0.25, 66.25, 1.25],
      [B.WOOL_WHITE, 0.75, 66.25, 1.25],
    ]);
    expect(getPacked(s.world, 0, 66, 1)).toBe(c(B.STONE));
  });
});

describe('docking in every orientation rotates shapes, second parts and states (SHAPES 11.4)', () => {
  const rots = allRots();

  it('there are 24 distinct rotations', () => {
    expect(new Set(rots.map((r) => `${r.ax}${r.ay}${r.az}`)).size).toBe(24);
  });

  for (const r of rots) {
    it(`rotation (${r.ax}, ${r.ay}, ${r.az}): each cell lands as rotCell of itself, each part's fill as rotateFill of its own, glue faces follow`, () => {
      const s = scene();
      const ship = raftShip(s);
      const before = new Map<string, number>();
      ship.grid.forEachCell((x, y, z, p) => before.set(`${x},${y},${z}`, p));
      const t: SnapTransform = { r, pivot: vec3(ship.grid.pivot.x, ship.grid.pivot.y, ship.grid.pivot.z), target: vec3(4.3, 90.6, -5.2) };
      const out = commitDock(s.host, ship, t, null);
      expect(out.report).toEqual({ placed: RAFT_CELLS, dropped: 0, overwritten: 0 });
      const d: Vec3 = vec3();
      for (const [k, p] of before) {
        const [x, y, z] = k.split(',').map(Number) as [number, number, number];
        snapCell(t, x, y, z, d);
        const got = getPacked(s.world, d.x, d.y, d.z);
        expect(got, k).toBe(rotCell(r, p));
        // Independently of rotCell: the same materials, each fill rotated by the octant table.
        const want = [p & PART_MASK, cellSecond(p)]
          .filter((q) => (q & 0x3ff) !== 0)
          .map((q) => `${q & 0x3ff}:${rotateFill(~partHoles(q) & 0xff, r.ax, r.ay)}`)
          .sort();
        expect(partSet(got), k).toEqual(want);
      }
      // The glued face between the deck and the log slab: from snapCell(deck) towards rotDir(+Y).
      const a = snapCell(t, -2, 60, 0);
      expect(s.host.worldGlue.has(a.x, a.y, a.z, rotDir(r, PY as Dir))).toBe(true);
      expect(s.host.worldGlue.size).toBe(1);
    });
  }

  for (const k of [0, 1, 2, 3]) {
    it(`a player dock at yaw ${k * 90} (the only upright ones), then re-assembly: the same cells, rotated`, () => {
      const s = scene();
      const ship = raftShip(s);
      const target = { x: 9, y: 62, z: -6 };
      const q = qfromYaw(k * (Math.PI / 2));
      const off = qrotate(q, vsub(vec3(HELM[0] + 0.5, HELM[1] + 0.5, HELM[2] + 0.5), ship.grid.pivot));
      ship.grid.setPoseImmediate(vec3(target.x + 0.5 - off.x, target.y + 0.5 - off.y, target.z + 0.5 - off.z), q);
      const res = s.mgr.dockShip(ship);
      expect(res.ok && res.report.placed).toBe(RAFT_CELLS);
      const again = s.mgr.assembleShip(target.x, target.y, target.z);
      if (!again.ok) throw new Error(again.reason);
      expect(again.structure.grid.count).toBe(RAFT_CELLS);
      for (const [x, y, z, p] of PARTS) {
        const [rx, rz] = rotY(x - HELM[0], z - HELM[2], k);
        const yaw = YAWS[k]!;
        expect(getPacked(again.structure.grid, target.x + rx, target.y + y - HELM[1], target.z + rz), `${x},${z}`).toBe(rotCell(yaw, p));
      }
    });
  }
});
