/**
 * The three rays as pure functions (src/sim/rays.ts; NETCODE section 10): the plain ray, the glue
 * ray through soft blocks, the bucket ray and the water a hull displaces, cellDisplaced; and that
 * a server-driven player's hands cast exactly these. With partial cells (docs/SHAPES.md 6.1, 4.4):
 * the rays pass through empty octants, and what a hull displaces is decided per octant.
 */
import { describe, expect, it } from 'vitest';
import { facingState, liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NY, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { qidentity, vec3 } from '../../src/core/math';
import { REACH, castRay, cellDisplaced, displacedByHull, glueTargetable, isBucket, lookDir, partlyDisplaced, rayKindOf, rayPredicate, type RayScene, type RayShip } from '../../src/sim/rays';
import { analyzeHull, isDryHalf } from '../../src/structures/hull';
import type { Ship } from '../../src/structures/structure';
import { targetable, targetableOrLiquidSource } from '../../src/voxel/raycast';
import { LOWER, UPPER, slab } from '../shapes';
import { emptyWorld, structure } from '../voxel/helpers';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from './helpers';

const T = FLAT_TOP;

describe('rays (sim/rays.ts)', () => {
  it('the use ray follows the held item; the predicates', () => {
    expect(rayKindOf(-1)).toBe('plain');
    expect(rayKindOf(B.PLANKS_OAK)).toBe('plain');
    expect(rayKindOf(I.GLUE)).toBe('glue');
    for (const b of [I.BUCKET, I.BUCKET_WATER, I.BUCKET_LAVA]) {
      expect(isBucket(b)).toBe(true);
      expect(rayKindOf(b)).toBe('bucket');
    }
    expect(rayPredicate('plain')).toBe(targetable);
    expect(rayPredicate('glue')).toBe(glueTargetable);
    expect(rayPredicate('bucket')).toBe(targetableOrLiquidSource);
    expect(glueTargetable(makeCell(B.TORCH))).toBe(false);
    expect(glueTargetable(makeCell(B.STONE))).toBe(true);
    expect(REACH).toBe(5);
  });

  it('lookDir: yaw 0 looks toward -Z, yaw grows turning left, pitch > 0 up (ARCHITECTURE 朝向)', () => {
    const d = lookDir(0, 0);
    expect([d.x, d.y, d.z].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-0, 0, -1]);
    const l = lookDir(Math.PI / 2, 0);
    expect(l.x).toBeCloseTo(-1, 12);
    expect(lookDir(0, Math.PI / 2).y).toBeCloseTo(1, 12);
  });

  it('plain stops at the torch in front of a block; glue passes through it to the block; nothing beyond REACH', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T, -2, makeCell(B.TORCH));
    const scene = sim.interaction.rayScene();
    const eye = vec3(0.5, T + 0.5, 0.5);
    const dir = vec3(0, 0, -1);
    expect(castRay(scene, eye, dir, 'plain')).toMatchObject({ x: 0, y: T, z: -2, face: PZ });
    expect(castRay(scene, eye, dir, 'glue')).toMatchObject({ x: 0, y: T, z: -3, face: PZ });
    expect(castRay(scene, eye, dir, 'glue', 2)).toBeNull(); // its face is 2.5 away
    sim.world.setCell(0, T, -2, makeCell(B.AIR));
    sim.world.setCell(0, T, -3, makeCell(B.AIR));
    sim.world.setCell(0, T, -6, makeCell(B.STONE));
    expect(castRay(scene, eye, dir, 'plain')).toBeNull(); // 6 blocks away
  });

  it('bucket: stops at a world water source, not behind a hull; the water a hull displaces is passed through (cellDisplaced)', () => {
    const sim = seaSim({ spawn: { x: 2.5, y: SEA_TOP + 8, z: 12.5 } });
    const w = sim.world;
    // A 3x3 plank floor with walls, floor at y 28: its hold (y 29) is below the waterline.
    fill(w, 0, SEA_TOP - 2, 0, 4, SEA_TOP - 2, 4, B.PLANKS_OAK);
    for (let y = SEA_TOP - 1; y <= SEA_TOP; y++) {
      for (let i = 0; i <= 4; i++) {
        w.setCell(i, y, 0, makeCell(B.PLANKS_OAK));
        w.setCell(i, y, 4, makeCell(B.PLANKS_OAK));
        w.setCell(0, y, i, makeCell(B.PLANKS_OAK));
        w.setCell(4, y, i, makeCell(B.PLANKS_OAK));
      }
    }
    w.setCell(1, SEA_TOP - 1, 1, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(1, SEA_TOP - 1, 1);
    if (!res.ok) throw new Error(res.reason);
    const ship: Ship = res.structure;
    const scene: RayScene = { grids: sim.grids(), ships: [{ grid: ship.grid, hull: analyzeHull(ship.grid) }] };
    // Straight down into the hold: the hidden world water (y 29) is skipped, the floor is hit.
    const down = vec3(0, -1, 0);
    const hold = castRay(scene, vec3(2.5, SEA_TOP + 1.5, 2.5), down, 'bucket');
    expect(hold).toMatchObject({ y: SEA_TOP - 2 });
    expect(hold!.grid).toBe(ship.grid);
    // Outside the boat the open sea's surface source is hit.
    const sea = castRay(scene, vec3(8.5, SEA_TOP + 1.5, 2.5), down, 'bucket');
    expect(sea).toMatchObject({ x: 8, y: SEA_TOP - 1, z: 2, face: PY });
    expect(sea!.grid.isWorld).toBe(true);
    // The plain ray ignores water: it goes down to the sea floor (out of reach here).
    expect(castRay(scene, vec3(8.5, SEA_TOP + 1.5, 2.5), down, 'plain')).toBeNull();
    // cellDisplaced: the hold cell is all inside the dry hold; the open sea's is not.
    expect(cellDisplaced(scene.ships, 2, SEA_TOP - 1, 2)).toBe(true);
    expect(cellDisplaced(scene.ships, 8, SEA_TOP - 1, 2)).toBe(false);
    expect(cellDisplaced([], 2, SEA_TOP - 1, 2)).toBe(false);
  });

  it('a server-driven player\'s hands cast exactly these rays (use ray of the held item, mining ray plain)', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T, -2, makeCell(B.TORCH));
    me.lookAtCell(0, T, -3, PZ);
    me.hold(I.GLUE);
    const p = me.player;
    const scene = sim.interaction.rayScene();
    const glue = castRay(scene, p.eyePos(), lookDir(p.yaw, p.pitch), 'glue');
    const plain = castRay(scene, p.eyePos(), lookDir(p.yaw, p.pitch), 'plain');
    expect(me.targetCell()).toEqual({ gridId: 0, x: glue!.x, y: glue!.y, z: glue!.z, face: glue!.face, octant: glue!.octant });
    expect(me.mineTargetCell()).toEqual({ gridId: 0, x: plain!.x, y: plain!.y, z: plain!.z, face: plain!.face, octant: plain!.octant });
    expect(glue!.z).toBe(-3);
    expect(plain!.z).toBe(-2);
  });

  it('plain and glue rays pass over a lower slab to the block behind it; below the mid-plane they stop at the slab', () => {
    const sim = flatSim();
    const s = slab(B.STONE, LOWER);
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T, -2, s);
    const scene = sim.interaction.rayScene();
    const dir = vec3(0, 0, -1);
    const high = vec3(0.5, T + 0.75, 0.5);
    for (const kind of ['plain', 'glue'] as const) {
      expect(castRay(scene, high, dir, kind)).toMatchObject({ x: 0, y: T, z: -3, face: PZ, octant: 7, part: makeCell(B.STONE) });
      expect(castRay(scene, vec3(0.5, T + 0.25, 0.5), dir, kind)).toMatchObject({ x: 0, y: T, z: -2, face: PZ, octant: 5, part: s, cell: s });
    }
  });

  it('displacedByHull decides by octant: the empty half above a hull slab is not displaced (bucket ray, cellDisplaced)', () => {
    const world = emptyWorld();
    const WATER = makeCell(B.WATER, liquidState(0, false));
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity()); // local = world coordinates
    // A lower slab and a full block of the hull, each in the same place as a world water source.
    world.setCell(0, 40, 0, WATER);
    world.setCell(2, 40, 0, WATER);
    ship.setCell(0, 40, 0, slab(B.PLANKS_OAK, LOWER));
    ship.setCell(2, 40, 0, makeCell(B.PLANKS_OAK));
    const ships: RayShip[] = [{ grid: ship, hull: null }];
    expect(displacedByHull(ships, vec3(0.5, 40.25, 0.5))).toBe(true);
    expect(displacedByHull(ships, vec3(0.5, 40.75, 0.5))).toBe(false);
    expect(displacedByHull(ships, vec3(0.9, 40.49, 0.1))).toBe(true);
    expect(displacedByHull(ships, vec3(0.9, 40.5, 0.1))).toBe(false); // the mid-plane belongs to the upper half
    expect(displacedByHull(ships, vec3(2.5, 40.75, 0.5))).toBe(true);
    expect(displacedByHull(ships, vec3(1.5, 40.25, 0.5))).toBe(false); // outside every hull cell
    // The water above the slab is visible: the bucket ray stops at the world source there; above
    // the full block the hull hides all of it and the ray stops at the hull.
    const scene: RayScene = { grids: [world, ship], ships };
    const down = vec3(0, -1, 0);
    // (Grids are compared by identity, not inside toEqual: a failing toEqual would serialise them.)
    const a = castRay(scene, vec3(0.5, 42, 0.5), down, 'bucket')!;
    expect(a.grid === world).toBe(true);
    expect([a.x, a.y, a.z, a.face, a.dist, a.part]).toEqual([0, 40, 0, PY, 1, WATER]);
    const b = castRay(scene, vec3(2.5, 42, 0.5), down, 'bucket')!;
    expect(b.grid === ship).toBe(true);
    expect([b.x, b.y, b.z, b.face, b.dist]).toEqual([2, 40, 0, PY, 1]);
    // cellDisplaced (the server's check of a claimed bucket target): only the cell all of whose
    // octants the hull covers.
    expect(cellDisplaced(ships, 0, 40, 0)).toBe(false);
    expect(cellDisplaced(ships, 2, 40, 0)).toBe(true);
  });

  it('cellDisplaced asks every octant, not the cell centre: an upper slab, a cell lacking one octant (partlyDisplaced: any octant)', () => {
    const world = emptyWorld();
    const WATER = makeCell(B.WATER, liquidState(0, false));
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity()); // local = world coordinates
    // Hull cells in the same places as world water sources. The cell centre lies on the three
    // mid-planes, so it is in octant 7 (half-open octants): for the upper slab and for the cell
    // lacking only octant 0 the centre is displaced although part of the cell is not.
    const fills = [UPPER, 0xfe, 0x7f, 0x80, LOWER, 0xff];
    fills.forEach((f, i) => {
      world.setCell(2 * i, 40, 0, WATER);
      ship.setCell(2 * i, 40, 0, f === 0xff ? makeCell(B.PLANKS_OAK) : slab(B.PLANKS_OAK, f));
    });
    world.setCell(20, 40, 0, WATER); // and one with no hull at all
    const ships: RayShip[] = [{ grid: ship, hull: null }];
    expect(displacedByHull(ships, vec3(0.5, 40.5, 0.5))).toBe(true); // the upper slab's centre
    expect(displacedByHull(ships, vec3(2.5, 40.5, 0.5))).toBe(true); // 0xfe's centre
    expect(fills.map((_f, i) => cellDisplaced(ships, 2 * i, 40, 0))).toEqual([false, false, false, false, false, true]);
    expect(fills.map((_f, i) => partlyDisplaced(ships, 2 * i, 40, 0))).toEqual([true, true, true, true, true, true]);
    expect(cellDisplaced(ships, 20, 40, 0)).toBe(false);
    expect(partlyDisplaced(ships, 20, 40, 0)).toBe(false);
    expect(partlyDisplaced([], 0, 40, 0)).toBe(false);
    // The bucket ray agrees with cellDisplaced: from below into the upper slab's cell it stops at
    // the world water in the lower half; from +X into 0xfe's cell at the open octant 0 level too.
    const scene: RayScene = { grids: [world, ship], ships };
    const up = castRay(scene, vec3(0.25, 38.5, 0.25), vec3(0, 1, 0), 'bucket')!;
    expect(up.grid === world).toBe(true);
    expect([up.x, up.y, up.z, up.face, up.part]).toEqual([0, 40, 0, NY, WATER]);
    const side = castRay(scene, vec3(1.9, 40.25, 0.25), vec3(1, 0, 0), 'bucket')!;
    expect(side.grid === world).toBe(true);
    expect([side.x, side.y, side.z, side.face, side.part]).toEqual([2, 40, 0, NX, WATER]);
  });

  it('displacedByHull reads the dry hold per octant: a mixed wall cell and a slab inside a sealed hold', () => {
    const world = emptyWorld();
    const WATER = makeCell(B.WATER, liquidState(0, false));
    const ship = structure(world, 1, vec3(0, 0, 0), qidentity()); // local = world coordinates
    const Y0 = 40;
    // A sealed plank box 5 x 5 x 5 (walls at 0 and 4, hold 1..3), with:
    //  - E = (4, Y0+2, 2) in the +X wall: planks in every octant but 0 and 7. Octant 0 lies against
    //    the hold (dry, sealed), octant 7 against the outside (open); the six hard octants between
    //    keep the wall tight.
    //  - H = (2, Y0+1, 2) on the hold's floor: a lower slab, so its upper half is dry hold.
    for (let z = 0; z <= 4; z++)
      for (let y = 0; y <= 4; y++)
        for (let x = 0; x <= 4; x++) if (x === 0 || x === 4 || y === 0 || y === 4 || z === 0 || z === 4) ship.setCell(x, Y0 + y, z, makeCell(B.PLANKS_OAK));
    ship.setCell(4, Y0 + 2, 2, slab(B.PLANKS_OAK, 0x7e));
    ship.setCell(2, Y0 + 1, 2, slab(B.PLANKS_OAK, LOWER));
    const hull = analyzeHull(ship)!;
    // The premises, from the hull analysis itself (half-grid coordinates 2 x cell + octant bit).
    expect(isDryHalf(hull, 8, 2 * Y0 + 4, 4)).toBe(true); // E, octant 0
    expect(isDryHalf(hull, 9, 2 * Y0 + 5, 5)).toBe(false); // E, octant 7
    expect(isDryHalf(hull, 4, 2 * Y0 + 3, 4)).toBe(true); // H, octant 2 (upper half)
    const ships: RayShip[] = [{ grid: ship, hull }];
    // E: dry octant 0 and the hard octants are displaced, the open octant 7 is not.
    expect(displacedByHull(ships, vec3(4.25, Y0 + 2.25, 2.25))).toBe(true); // octant 0: dry
    expect(displacedByHull(ships, vec3(4.75, Y0 + 2.25, 2.25))).toBe(true); // octant 1: hard
    expect(displacedByHull(ships, vec3(4.25, Y0 + 2.75, 2.75))).toBe(true); // octant 6: hard
    expect(displacedByHull(ships, vec3(4.75, Y0 + 2.75, 2.75))).toBe(false); // octant 7: open to the outside
    // H: the hard lower half and the dry upper half; an empty hold cell; outside the box.
    expect(displacedByHull(ships, vec3(2.25, Y0 + 1.25, 2.25))).toBe(true);
    expect(displacedByHull(ships, vec3(2.25, Y0 + 1.75, 2.25))).toBe(true);
    expect(displacedByHull(ships, vec3(2.5, Y0 + 2.5, 2.5))).toBe(true);
    expect(displacedByHull(ships, vec3(6.5, Y0 + 2.5, 2.5))).toBe(false);
    // World water sources in E and H: E is not all displaced (octant 7), H is (hard + dry).
    world.setCell(4, Y0 + 2, 2, WATER);
    world.setCell(2, Y0 + 1, 2, WATER);
    expect(cellDisplaced(ships, 4, Y0 + 2, 2)).toBe(false);
    expect(cellDisplaced(ships, 2, Y0 + 1, 2)).toBe(true);
    expect(partlyDisplaced(ships, 4, Y0 + 2, 2)).toBe(true);
    expect(partlyDisplaced(ships, 6, Y0 + 2, 2)).toBe(false);
    const scene: RayScene = { grids: [world, ship], ships };
    // From outside along -X at octant 7's level: the visible water in E's octant 7 is hit.
    const w = castRay(scene, vec3(6.5, Y0 + 2.75, 2.75), vec3(-1, 0, 0), 'bucket')!;
    expect(w.grid === world).toBe(true);
    expect([w.x, w.y, w.z, w.face, w.dist, w.part]).toEqual([4, Y0 + 2, 2, PX, 1.5, WATER]);
    // From inside the hold along +X at octant 0's level: E's water there is dry hold, so the ray
    // goes on to E's hard octant 1 (an inner face at x 4.5).
    const d = castRay(scene, vec3(3.5, Y0 + 2.25, 2.25), vec3(1, 0, 0), 'bucket')!;
    expect(d.grid === ship).toBe(true);
    expect([d.x, d.y, d.z, d.face, d.octant, d.dist]).toEqual([4, Y0 + 2, 2, NX, 1, 1]);
    // Down through the hold onto H: its water is hidden by the dry upper half and the hard lower
    // half, so the ray stops at the slab's top (an inner face at y + 0.5).
    const s = castRay(scene, vec3(2.25, Y0 + 2.9, 2.25), vec3(0, -1, 0), 'bucket')!;
    expect(s.grid === ship).toBe(true);
    expect([s.x, s.y, s.z, s.face, s.octant]).toEqual([2, Y0 + 1, 2, PY, 0]);
    expect(s.dist).toBeCloseTo(1.4, 12);
  });
});
