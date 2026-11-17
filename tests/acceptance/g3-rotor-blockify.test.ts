/**
 * Acceptance scenarios 10–14 (docs/ACCEPTANCE.md "风车与方块化"), headless, whole simulation.
 *
 * The player builds nothing by hand here — scenes are set with world.setCell — but everything the
 * scenarios are about is done the way the game does it: right-clicking bearings and helms, holding
 * the attack button on a bearing, placing and lighting blast crates, gluing with the glue item.
 * Results are read from the world, the structures and the entity list.
 *
 * Rotation conventions used for the expected cells: a rotor spins right-handed about its bearing's
 * facing (rotor.angle > 0), and blockifying snaps it to the nearest quarter turn (DESIGN 方块化:
 * 吸附到最近的轴对齐姿态). The windmills are built asymmetric (arm lengths or arm colours) so that
 * every quarter turn gives a different, exactly predictable set of cells.
 */
import { describe, expect, it } from 'vitest';
import { cellState, facingState, ID_MASK, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { isSolidCell } from '../../src/blocks/registry';
import { NX, NY, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { qfromYaw, qmul, vec3 } from '../../src/core/math';
import type { Simulation } from '../../src/sim/simulation';
import type { Rotor, Ship } from '../../src/structures/structure';
import {
  Events,
  SEA,
  T,
  cellsIn,
  dropped,
  fill,
  flatWorld,
  gridCells,
  idAt,
  key,
  primedCrates,
  quarterOf,
  seaWorld,
  set,
  spinUntil,
  startByPlayer,
  tickUntilExplosion,
  turnedAboutX,
  turnedAboutY,
  watchShip,
} from './g3-rotor-blockify-helpers';

const HALF_PI = Math.PI / 2;
const CLOTH = [B.CANVAS, B.WOOL_RED, B.WOOL_BLUE, B.WOOL_GREEN, B.WOOL_YELLOW];

type Cell = [number, number, number, number]; // x, y, z, block id

/** Parse "x,y,z:id". */
function parse(s: string): Cell {
  const [xyz, id] = s.split(':');
  const [x, y, z] = xyz!.split(',').map(Number) as [number, number, number];
  return [x, y, z, Number(id)];
}

// =====================================================================================
// 10
// =====================================================================================

/**
 * A canvas windmill on a stone-brick post: bearing (0, Y, Z) facing east, hub (1, Y, Z), arms in
 * the plane x = 1: up 3, south 2, down 1, north 1 (8 cells, 8 sails). The player (survival or
 * creative) stands north of it at (0.5, T, -7.5) and starts it with two right-clicks on the bearing.
 *
 * After it has turned about a quarter turn (angle in [PI/2 - 0.3, PI/2 - 0.2), i.e. NOT exactly
 * aligned: blockifying must snap it to 90 degrees), obstacles are put where six of its cells will
 * land at 90 degrees (+y -> +z, +z -> -y about +X):
 *   up arm  (1,Y+1..Y+3,Z) -> (1,Y,Z+1..Z+3): HARD stone at (1,Y,Z+3), soft snow cover at (1,Y,Z+2)
 *   south   (1,Y,Z+1..Z+2) -> (1,Y-1..Y-2,Z): soft flower at (1,Y-1,Z),   HARD rubble at (1,Y-2,Z)
 *   down    (1,Y-1,Z)      -> (1,Y,Z-1):      soft torch
 *   north   (1,Y,Z-1)      -> (1,Y+1,Z):      a water source (soft, liquid)
 * (the snow cover rests on a stone at (1,Y-1,Z+2), the flower on the rubble, the torch on a stone
 * at (1,Y-1,Z-1)). Then the player right-clicks the bearing again to stop it.
 */
const Y10 = T + 4;
const Z10 = -4;

function windmill10(mode: 'survival' | 'creative') {
  const sim = flatWorld(mode, { x: 0.5, y: T, z: -7.5 }, 10);
  const w = sim.world;
  const Y = Y10;
  const Z = Z10;
  fill(w, -1, T, Z, -1, Y, Z, B.STONE_BRICKS);
  set(w, 0, Y, Z, B.BEARING, facingState(PX));
  const cells: Cell[] = [[1, Y, Z, B.CANVAS]];
  for (const [dy, dz] of [[1, 0], [2, 0], [3, 0], [-1, 0], [0, 1], [0, 2], [0, -1]] as const) cells.push([1, Y + dy, Z + dz, B.CANVAS]);
  for (const [x, y, z, id] of cells) set(w, x, y, z, id);
  sim.advance(2);
  const log = new Events(sim);
  const rotor = startByPlayer(sim, 0, Y, Z, NZ);
  spinUntil(sim, rotor, HALF_PI - 0.3, HALF_PI - 0.2);
  set(w, 1, Y, Z + 3, B.STONE);
  set(w, 1, Y - 1, Z + 2, B.STONE);
  set(w, 1, Y, Z + 2, B.SNOW_LAYER);
  set(w, 1, Y - 2, Z, B.COBBLE);
  set(w, 1, Y - 1, Z, B.FLOWER_RED);
  set(w, 1, Y - 1, Z - 1, B.STONE);
  set(w, 1, Y, Z - 1, B.TORCH);
  set(w, 1, Y + 1, Z, B.WATER);
  sim.tick();
  const soft = [idAt(w, 1, Y, Z + 2), idAt(w, 1, Y - 1, Z), idAt(w, 1, Y, Z - 1), idAt(w, 1, Y + 1, Z)];
  const angle = rotor.angle;
  const stopped = sim.soloPlayer.useOn(0, Y, Z, NZ);
  return { sim, w, rotor, log, cells, angle, stopped, soft };
}

/** Where the 8 canvas cells must be after a 90-degree snap with the two hard conflicts dropped. */
function expected10(): string[] {
  const Y = Y10;
  const Z = Z10;
  return [
    key(1, Y, Z, B.CANVAS), // hub
    key(1, Y, Z + 1, B.CANVAS), // up arm, 1st
    key(1, Y, Z + 2, B.CANVAS), // up arm, 2nd (over the snow cover)
    key(1, Y, Z - 1, B.CANVAS), // down arm (over the torch)
    key(1, Y - 1, Z, B.CANVAS), // south arm, 1st (over the flower)
    key(1, Y + 1, Z, B.CANVAS), // north arm (over the water)
  ].sort();
}

describe('10. 风车转起来后再方块化：被硬方块占住的格子在生存模式下掉落，软方块被覆盖。', () => {
  it('the windmill turns, and stopping it after ~76° puts it back as blocks snapped to the 90° pose', () => {
    const { sim, w, rotor, log, cells, angle, stopped } = windmill10('survival');
    expect(angle).toBeGreaterThan(HALF_PI - 0.31); // it really turned (about a quarter turn)
    expect(stopped).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    expect(log.toastKeys()).toContain('toast.rotor.stopped');
    // Exactly the snapped cells (nothing left at the angle-0 positions, nothing elsewhere).
    expect(cellsIn(w, [B.CANVAS], -2, T, -12, 4, T + 12, 4)).toEqual(expected10());
    // Every rotor cell is accounted for: 6 placed + 2 dropped.
    expect(cellsIn(w, [B.CANVAS], -2, T, -12, 4, T + 12, 4).length + dropped(sim, B.CANVAS)).toBe(cells.length);
  });

  it('survival: the cells landing in hard blocks become item drops, the hard blocks stay as they were', () => {
    const { sim, w, stopped } = windmill10('survival');
    expect(stopped).toBe(true);
    expect(idAt(w, 1, Y10, Z10 + 3)).toBe(B.STONE);
    expect(idAt(w, 1, Y10 - 2, Z10)).toBe(B.COBBLE);
    expect(dropped(sim, B.CANVAS)).toBe(2);
    // The hard blocks were not broken: neither they nor what they would drop is lying around.
    expect(dropped(sim, B.STONE)).toBe(0);
    expect(dropped(sim, B.COBBLE)).toBe(0);
  });

  it('soft blocks in the way are overwritten; overwritten non-liquid blocks drop in survival (flower, torch), water does not', () => {
    const { sim, w, stopped, soft } = windmill10('survival');
    expect(soft).toEqual([B.SNOW_LAYER, B.FLOWER_RED, B.TORCH, B.WATER]); // (scene check: they were in place)
    expect(stopped).toBe(true);
    expect(idAt(w, 1, Y10, Z10 + 2)).toBe(B.CANVAS); // was snow cover
    expect(idAt(w, 1, Y10 - 1, Z10)).toBe(B.CANVAS); // was a flower
    expect(idAt(w, 1, Y10, Z10 - 1)).toBe(B.CANVAS); // was a torch
    expect(idAt(w, 1, Y10 + 1, Z10)).toBe(B.CANVAS); // was a water source
    expect(dropped(sim, B.FLOWER_RED)).toBe(1);
    expect(dropped(sim, B.TORCH)).toBe(1);
    expect(dropped(sim, B.SNOW_LAYER)).toBe(0); // its drop table is empty
    expect(dropped(sim)).toBe(2 + 1 + 1); // + the two canvas cells that hit hard blocks; nothing for the water
    // The supports of the soft blocks are untouched.
    expect(idAt(w, 1, Y10 - 1, Z10 + 2)).toBe(B.STONE);
    expect(idAt(w, 1, Y10 - 1, Z10 - 1)).toBe(B.STONE);
  });

  it('creative: the cells landing in hard blocks just vanish, nothing drops, soft blocks are still overwritten', () => {
    const { sim, w, rotor, stopped } = windmill10('creative');
    expect(stopped).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(cellsIn(w, [B.CANVAS], -2, T, -12, 4, T + 12, 4)).toEqual(expected10());
    expect(idAt(w, 1, Y10, Z10 + 3)).toBe(B.STONE);
    expect(idAt(w, 1, Y10 - 2, Z10)).toBe(B.COBBLE);
    expect(dropped(sim)).toBe(0);
  });
});

// =====================================================================================
// 11
// =====================================================================================

/**
 * A windmill whose four arms have four colours (so that every quarter turn is told apart): post
 * x = -1, bearing (0, H, -4) facing east, canvas hub (1, H, -4), arms of `len` cells in the plane
 * x = 1 — up red, south blue, down green, north yellow. The down arm reaches y = T (the ground is
 * below), and no arm is longer than that, so whatever quarter turn it stops at, every cell lands
 * in open air.
 */
function colouredWindmill(sim: Simulation, H: number, len: number): Cell[] {
  const w = sim.world;
  fill(w, -1, T, -4, -1, H, -4, B.STONE_BRICKS);
  set(w, 0, H, -4, B.BEARING, facingState(PX));
  const cells: Cell[] = [[1, H, -4, B.CANVAS]];
  for (let i = 1; i <= len; i++) {
    cells.push([1, H + i, -4, B.WOOL_RED]);
    cells.push([1, H, -4 + i, B.WOOL_BLUE]);
    cells.push([1, H - i, -4, B.WOOL_GREEN]);
    cells.push([1, H, -4 - i, B.WOOL_YELLOW]);
  }
  for (const [x, y, z, id] of cells) set(w, x, y, z, id);
  return cells;
}

describe('11. 挖掉轴承或用 TNT 炸掉轴承，风车就地方块化。', () => {
  it('mining the bearing (survival, holding the attack button): the windmill blockifies in place the tick the bearing breaks', () => {
    const H = T + 4;
    const sim = flatWorld('survival', { x: 0.5, y: T, z: -0.5 }, 11);
    const cells = colouredWindmill(sim, H, 4);
    sim.advance(2);
    const log = new Events(sim);
    const rotor = startByPlayer(sim, 0, H, -4, PZ);
    spinUntil(sim, rotor, 0.2, 0.3);
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.mine(0, H, -4, PZ)).toBe(true);
    // The very tick the bearing broke:
    expect(idAt(sim.world, 0, H, -4)).toBe(B.AIR);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    expect(log.of('structureRemoved').map((e) => e.id)).toEqual([rotor.id]);
    // ... in place: at the quarter turn nearest to the angle it had, not back at its start pose.
    const k = quarterOf(rotor.angle);
    expect(k).not.toBe(0); // (scene check: it was stopped visibly turned)
    const want = cells.map(([x, y, z, id]) => key(...turnedAboutX(k, 1, H, -4, x, y, z), id)).sort();
    expect(cellsIn(sim.world, CLOTH, -2, T - 1, -12, 4, H + 8, 4)).toEqual(want);
    for (const id of CLOTH) expect(dropped(sim, id)).toBe(0); // all in open air: nothing dropped
  });

  it('mining the bearing in creative (breaks at the first hit): same, the windmill lands in place at its half-turn pose', () => {
    const H = T + 4;
    const sim = flatWorld('creative', { x: 0.5, y: T, z: -0.5 }, 13);
    const cells = colouredWindmill(sim, H, 4);
    sim.advance(2);
    const rotor = startByPlayer(sim, 0, H, -4, PZ);
    spinUntil(sim, rotor, Math.PI - 0.25, Math.PI - 0.15);
    const t0 = sim.ticks;
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.mine(0, H, -4, PZ)).toBe(true);
    expect(sim.ticks - t0).toBe(1); // one hit
    expect(idAt(sim.world, 0, H, -4)).toBe(B.AIR);
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    const want = cells.map(([x, y, z, id]) => key(...turnedAboutX(2, 1, H, -4, x, y, z), id)).sort();
    expect(cellsIn(sim.world, CLOTH, -2, T - 1, -12, 4, H + 8, 4)).toEqual(want);
  });

  it('blowing the bearing up with a blast crate the player lit: after the blast the surviving blades blockify in place, no rotor keeps turning', () => {
    const H = T + 6;
    const sim = flatWorld('creative', { x: -3.5, y: T + 7, z: -1.5 }, 12);
    sim.soloPlayer.player.flying = true;
    const cells = colouredWindmill(sim, H, 6);
    sim.advance(2);
    const log = new Events(sim);
    const rotor = startByPlayer(sim, 0, H, -4, PZ);
    sim.advance(10);
    // A blast crate on top of the post, diagonally above / behind the bearing; lit with an empty hand.
    sim.soloPlayer.hold(B.TNT);
    expect(sim.soloPlayer.useOn(-1, H, -4, PY)).toBe(true);
    expect(idAt(sim.world, -1, H + 1, -4)).toBe(B.TNT);
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.useOn(-1, H + 1, -4, PY)).toBe(true);
    expect(primedCrates(sim).length).toBe(1);
    expect(rotor.removed).toBe(false); // lighting the crate did nothing to the windmill yet
    tickUntilExplosion(sim, log);

    expect(idAt(sim.world, 0, H, -4)).toBe(B.AIR); // the blast took the bearing
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    // What the shock wave left of the rotor is back in the world, at the snapped pose of the angle
    // it had when the blast hit — and nothing else.
    const survivors = gridCells(rotor.grid);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(cells.length);
    const k = quarterOf(rotor.angle);
    expect(k).not.toBe(0); // (scene check)
    const want = survivors
      .map((s) => {
        const [x, y, z, id] = parse(s);
        return key(...turnedAboutX(k, 1, H, -4, x, y, z), id);
      })
      .sort();
    const placed = cellsIn(sim.world, CLOTH, -2, T - 1, -14, 4, H + 9, 6);
    expect(placed).toEqual(want);
    // The four arm tips are beyond the blast's reach at any angle: they must all be there.
    for (const [x, y, z, id] of [
      [1, H + 6, -4, B.WOOL_RED],
      [1, H, 2, B.WOOL_BLUE],
      [1, H - 6, -4, B.WOOL_GREEN],
      [1, H, -10, B.WOOL_YELLOW],
    ] as const) {
      expect(placed).toContain(key(...turnedAboutX(k, 1, H, -4, x, y, z), id));
    }
    // Nothing left turning in the air: a while later still no rotor, and the blocks have not moved.
    sim.advance(40);
    expect(sim.structures.rotors().length).toBe(0);
    expect(cellsIn(sim.world, CLOTH, -2, T - 1, -14, 4, H + 9, 6)).toEqual(placed);
  });
});

// =====================================================================================
// 12
// =====================================================================================

/**
 * At sea, survival. A 5x5 plank raft with a helm (south edge, facing north), a 3-high plank post
 * at its middle with a bearing facing up, a canvas hub on it and four horizontal canvas arms at
 * y = SEA + 4: east 6, west 2, south 1, north 3. The hub is glued to the bearing, so the stopped
 * windmill belongs to the ship. Built at z = 8..12, assembled by the player (two right-clicks on
 * the helm), the windmill started by the player from the deck.
 *
 * Then the ship's pose is changed by hand, as if it had sailed there ('north': moved 8 blocks
 * north, next to a stone cliff z <= -2; 'turn': turned 90° to the left on the spot, next to a
 * cliff x <= -2; both cliffs rise from the sea floor to y = 37): the windmill now sweeps through
 * the rock. Ship-local coordinates stay the build coordinates, which are no longer world ones.
 *
 * Stopping at ~76° snaps to 90° (+z -> +x, +x -> -z about +Y) in the ship's frame: the east arm
 * points to local north, and its cells 4..6, local (2, SEA+4, 6..4), are inside the cliff
 * (world z -2..-4 after 'north', world x -2..-4 after 'turn').
 */
const OZ12 = 8;
const HY12 = SEA + 4;
const HZ12 = OZ12 + 2;

function shipWindmill12(move: 'north' | 'turn' = 'north') {
  const sim = seaWorld('survival', { x: 3.5, y: SEA, z: OZ12 + 3.5 }, 12);
  const w = sim.world;
  if (move === 'north') fill(w, -3, 20, -8, 7, 37, -2, B.STONE); // the cliff
  else fill(w, -12, 20, 4, -2, 37, 17, B.STONE);
  fill(w, 0, SEA - 1, OZ12, 4, SEA - 1, OZ12 + 4, B.PLANKS_OAK);
  set(w, 2, SEA, OZ12 + 4, B.HELM, facingState(NZ));
  fill(w, 2, SEA, HZ12, 2, SEA + 2, HZ12, B.PLANKS_OAK);
  set(w, 2, SEA + 3, HZ12, B.BEARING, facingState(PY));
  const cells: Cell[] = [[2, HY12, HZ12, B.CANVAS]];
  for (let i = 1; i <= 6; i++) cells.push([2 + i, HY12, HZ12, B.CANVAS]);
  for (let i = 1; i <= 2; i++) cells.push([2 - i, HY12, HZ12, B.CANVAS]);
  cells.push([2, HY12, HZ12 + 1, B.CANVAS]);
  for (let i = 1; i <= 3; i++) cells.push([2, HY12, HZ12 - i, B.CANVAS]);
  for (const [x, y, z, id] of cells) set(w, x, y, z, id);
  sim.worldGlue.add(2, HY12, HZ12, NY);
  sim.advance(2);

  // Assemble from the deck, let go of the wheel.
  sim.soloPlayer.teleport(3.5, SEA, OZ12 + 3.5);
  sim.advance(3);
  if (!sim.soloPlayer.useOn(2, SEA, OZ12 + 4) || !sim.soloPlayer.useOn(2, SEA, OZ12 + 4)) throw new Error('cannot click the helm');
  const ships = sim.structures.ships();
  if (ships.length !== 1) throw new Error('no ship');
  const ship = ships[0]!;
  sim.soloPlayer.use();
  sim.tick();
  sim.advance(20);
  const onDeck = (): void => {
    const q = ship.grid.toWorld(vec3(3.5, SEA + 0.05, OZ12 + 3.5));
    sim.soloPlayer.teleport(q.x, q.y, q.z);
    sim.advance(5);
  };
  onDeck();
  const rotor = startByPlayer(sim, 2, SEA + 3, HZ12, PZ, ship.id);
  sim.advance(5);

  // "Sail" next to the cliff: pose changed by hand, then let it settle.
  const p = ship.grid.position;
  if (move === 'north') ship.grid.setPoseImmediate(vec3(p.x, p.y, p.z - 8), ship.grid.rotation);
  else ship.grid.setPoseImmediate(vec3(p.x, p.y, p.z), qmul(qfromYaw(HALF_PI), ship.grid.rotation));
  sim.dynamics.wake(ship);
  sim.advance(3);
  onDeck();

  spinUntil(sim, rotor, HALF_PI - 0.3, HALF_PI - 0.2);
  const stopped = sim.soloPlayer.useOn(2, SEA + 3, HZ12, PZ, ship.id);
  return { sim, w, ship, rotor, cells, stopped };
}

/** The canvas cells of the ship (local) after the 90° snap, the three cells in the rock dropped. */
function expected12(): string[] {
  return [
    [2, HY12, HZ12], // hub
    [2, HY12, HZ12 - 1], // east arm 1..3 -> north
    [2, HY12, HZ12 - 2],
    [2, HY12, HZ12 - 3],
    [1, HY12, HZ12], // north arm -> west
    [0, HY12, HZ12],
    [-1, HY12, HZ12],
    [2, HY12, HZ12 + 1], // west arm -> south
    [2, HY12, HZ12 + 2],
    [3, HY12, HZ12], // south arm -> east
  ]
    .map(([x, y, z]) => key(x!, y!, z!, B.CANVAS))
    .sort();
}

/** Is the centre of local cell (x,y,z) of the ship inside a hard WORLD block? */
function inWorldRock(sim: Simulation, ship: Ship, x: number, y: number, z: number): boolean {
  const c = ship.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5));
  return isSolidCell(sim.world.getCell(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)));
}

describe('12. 船上的风车停在岩石里时，落在岩石里的那几格掉落，船不会被弹飞。', () => {
  it('the cells whose snapped place is inside the world rock become drops (survival), not ship blocks', () => {
    const { sim, ship, rotor, stopped } = shipWindmill12();
    expect(stopped).toBe(true);
    expect(rotor.removed).toBe(true);
    // (scene check) the three outer cells of the east arm, turned north, are inside the cliff
    for (const z of [4, 5, 6]) expect(inWorldRock(sim, ship, 2, HY12, z)).toBe(true);
    for (const z of [4, 5, 6]) expect(idAt(ship.grid, 2, HY12, z)).toBe(B.AIR);
    expect(dropped(sim, B.CANVAS)).toBe(3);
  });

  it('the other cells land in the ship grid at the snapped pose (nothing goes into the world)', () => {
    const { w, ship, rotor, stopped } = shipWindmill12();
    expect(stopped).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(ship.children.length).toBe(0);
    expect(gridCells(ship.grid, [B.CANVAS])).toEqual(expected12());
    expect(cellsIn(w, [B.CANVAS], -8, SEA - 2, -10, 12, 40, 16)).toEqual([]);
  });

  it('the ship is not launched: no ship cell ends up in rock, and it stays put over the next 3 seconds', () => {
    const { sim, ship, stopped } = shipWindmill12();
    expect(stopped).toBe(true);
    const inRock: string[] = [];
    ship.grid.forEachCell((x, y, z) => {
      if (inWorldRock(sim, ship, x, y, z)) inRock.push(`${x},${y},${z}`);
    });
    expect(inRock).toEqual([]);
    const m = watchShip(sim, ship, 60);
    expect(m.maxMove).toBeLessThan(0.05);
    expect(m.maxSpeed).toBeLessThan(0.25);
    expect(m.maxSpin).toBeLessThan(0.25);
    expect(ship.removed).toBe(false);
  });

  it('the same with a ship that has turned 90°: the rock test follows the ship\'s real pose', () => {
    const { sim, w, ship, rotor, stopped } = shipWindmill12('turn');
    expect(stopped).toBe(true);
    expect(rotor.removed).toBe(true);
    for (const z of [4, 5, 6]) expect(inWorldRock(sim, ship, 2, HY12, z)).toBe(true); // (scene check)
    expect(inWorldRock(sim, ship, 2, HY12, 7)).toBe(false); // (scene check)
    expect(dropped(sim, B.CANVAS)).toBe(3);
    expect(gridCells(ship.grid, [B.CANVAS])).toEqual(expected12());
    expect(cellsIn(w, [B.CANVAS], -8, SEA - 2, 0, 12, 40, 20)).toEqual([]);
    const m = watchShip(sim, ship, 60);
    expect(m.maxMove).toBeLessThan(0.05);
    expect(m.maxSpeed).toBeLessThan(0.25);
  });
});

// =====================================================================================
// 13
// =====================================================================================

/**
 * At sea, creative. A 7x7 plank raft (y = SEA - 1, x/z 0..6), helm (3, SEA, 6) facing north, plank
 * post (3, SEA..SEA+2, 3) with a two-plank ledge (2, SEA+2, 3), (2, SEA+2, 2), a bearing
 * (3, SEA+3, 3) facing up, a canvas hub (3, SEA+4, 3) glued to it and four horizontal arms of 7 at
 * the hub's level (east red, south blue, west yellow, north green).
 *
 * The player assembles it at the helm, puts a blast crate on the ledge — diagonally under the hub,
 * next to the bearing — and lights it with an empty hand, then (while the crate settles on the
 * ledge, its top just below the blades) starts the windmill on the ship. The crate goes off ~3.5 s
 * later, the windmill turning.
 */
const HY13 = SEA + 4;

function shipWindmill13() {
  const sim = seaWorld('creative', { x: 3.5, y: SEA + 1, z: 8.5 }, 13);
  sim.soloPlayer.player.flying = true;
  const w = sim.world;
  fill(w, 0, SEA - 1, 0, 6, SEA - 1, 6, B.PLANKS_OAK);
  set(w, 3, SEA, 6, B.HELM, facingState(NZ));
  fill(w, 3, SEA, 3, 3, SEA + 2, 3, B.PLANKS_OAK);
  set(w, 2, SEA + 2, 3, B.PLANKS_OAK);
  set(w, 2, SEA + 2, 2, B.PLANKS_OAK);
  set(w, 3, SEA + 3, 3, B.BEARING, facingState(PY));
  const cells: Cell[] = [[3, HY13, 3, B.CANVAS]];
  for (let i = 1; i <= 7; i++) {
    cells.push([3 + i, HY13, 3, B.WOOL_RED]);
    cells.push([3, HY13, 3 + i, B.WOOL_BLUE]);
    cells.push([3 - i, HY13, 3, B.WOOL_YELLOW]);
    cells.push([3, HY13, 3 - i, B.WOOL_GREEN]);
  }
  for (const [x, y, z, id] of cells) set(w, x, y, z, id);
  sim.worldGlue.add(3, HY13, 3, NY);
  sim.advance(2);

  if (!sim.soloPlayer.useOn(3, SEA, 6) || !sim.soloPlayer.useOn(3, SEA, 6)) throw new Error('cannot click the helm');
  const ship = sim.structures.ships()[0]!;
  if (ship === undefined) throw new Error('no ship');
  sim.soloPlayer.use(); // let go of the wheel
  sim.tick();
  sim.advance(20);
  const fly = (x: number, y: number, z: number): void => {
    const q = ship.grid.toWorld(vec3(x, y, z));
    sim.soloPlayer.teleport(q.x, q.y, q.z);
    sim.soloPlayer.player.flying = true;
    sim.tick();
  };
  // Hovering west of the post, head below the blades' plane.
  fly(0.5, SEA + 2, 1.5);
  sim.soloPlayer.hold(B.TNT);
  if (!sim.soloPlayer.useOn(2, SEA + 2, 2, PY, ship.id)) throw new Error('cannot place the crate');
  const placedCrate = idAt(ship.grid, 2, SEA + 3, 2);
  sim.soloPlayer.emptyHand();
  if (!sim.soloPlayer.useOn(2, SEA + 3, 2, NX, ship.id)) throw new Error('cannot light the crate');
  const lit = primedCrates(sim).length;
  sim.advance(10);
  const rotor = startByPlayer(sim, 3, SEA + 3, 3, NX, ship.id);
  fly(-9.5, SEA + 2, 3.5); // out of the way
  const log = new Events(sim);
  const blast = tickUntilExplosion(sim, log);
  return { sim, w, ship, rotor, cells, blast, placedCrate, lit, log };
}

describe('13. 船上的轴承被炸：轴心和爆炸半径内的帆布被炸掉，其余落回船上。整条小船被炸光时，风车剩下的部分落回（空）船上。', () => {
  it('a blast at the bearing of a ship windmill destroys the bearing, the hub and the sails within the blast radius', () => {
    const { ship, rotor, cells, blast, placedCrate, lit } = shipWindmill13();
    expect(placedCrate).toBe(B.TNT);
    expect(lit).toBe(1);
    expect(idAt(ship.grid, 3, SEA + 3, 3)).toBe(B.AIR); // the bearing was blown up
    expect(rotor.removed).toBe(true);
    const survivors = new Set(gridCells(rotor.grid));
    expect(survivors.has(key(3, HY13, 3, B.CANVAS))).toBe(false); // the hub
    // Every rotor cell whose centre was within 2 blocks of the blast when it went off is gone (2
    // blocks: even the weakest ray of a blast crate crosses 2 blocks of air and a canvas / felt cell
    // with strength to spare). The hub's place in the ship stays empty.
    const near: string[] = [];
    for (const [x, y, z, id] of cells) {
      const c = rotor.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5));
      if (Math.hypot(c.x - blast.x, c.y - blast.y, c.z - blast.z) <= 2) near.push(key(x, y, z, id));
    }
    expect(near.length).toBeGreaterThanOrEqual(2); // (scene check: the hub and at least one inner arm cell)
    for (const s of near) expect(survivors.has(s)).toBe(false);
    expect(idAt(ship.grid, 3, HY13, 3)).toBe(B.AIR);
  });

  it('the rest of the windmill falls back onto the ship grid at the snapped pose: nothing in the world, no rotor left', () => {
    const { sim, w, ship, rotor, cells, blast } = shipWindmill13();
    expect(rotor.removed).toBe(true);
    expect(sim.structures.rotors().length).toBe(0);
    expect(ship.children.length).toBe(0);
    expect(ship.removed).toBe(false);
    const survivors = gridCells(rotor.grid);
    const k = quarterOf(rotor.angle);
    const want = survivors.map((s) => {
      const [x, y, z, id] = parse(s);
      return key(...turnedAboutY(k, 3, HY13, 3, x, y, z), id);
    });
    expect(gridCells(ship.grid, CLOTH)).toEqual(want.sort());
    // Every cell out of the blast's reach (> 5 blocks: rays fade within 4.95 even in open air) survived.
    let far = 0;
    for (const [x, y, z, id] of cells) {
      const c = rotor.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5));
      if (Math.hypot(c.x - blast.x, c.y - blast.y, c.z - blast.z) > 5) {
        far++;
        expect(survivors).toContain(key(x, y, z, id));
      }
    }
    expect(far).toBeGreaterThan(8);
    expect(cellsIn(w, CLOTH, -8, SEA - 2, -8, 14, SEA + 12, 14)).toEqual([]);
    expect(dropped(sim)).toBe(0);
  });

  /**
   * On land, creative: the smallest ship — two planks, a helm on one, a bearing (facing up) on the
   * other — with a vertical canvas mast of 8 on the bearing, hub glued to the bearing. Assembled
   * and started by the player; a blast crate on the ground right next to it blows the whole hull
   * away.
   */
  function smallShip() {
    const sim = flatWorld('creative', { x: 2.5, y: T, z: 2.5 }, 31);
    const w = sim.world;
    set(w, 0, T, 0, B.PLANKS_OAK);
    set(w, 1, T, 0, B.PLANKS_OAK);
    set(w, 0, T + 1, 0, B.HELM, facingState(NZ));
    set(w, 1, T + 1, 0, B.BEARING, facingState(PY));
    const mast: Cell[] = [];
    for (let y = T + 2; y <= T + 9; y++) mast.push([1, y, 0, B.CANVAS]);
    for (const [x, y, z, id] of mast) set(w, x, y, z, id);
    sim.worldGlue.add(1, T + 2, 0, NY);
    sim.advance(2);
    if (!sim.soloPlayer.useOn(0, T + 1, 0) || !sim.soloPlayer.useOn(0, T + 1, 0)) throw new Error('cannot click the helm');
    const ship = sim.structures.ships()[0]!;
    if (ship === undefined) throw new Error('no ship');
    sim.soloPlayer.use(); // let go of the wheel
    sim.tick();
    sim.soloPlayer.teleport(2.5, T, 2.5);
    sim.advance(5);
    const rotor = startByPlayer(sim, 1, T + 1, 0, PZ, ship.id);
    sim.advance(10);
    sim.soloPlayer.hold(B.TNT);
    if (!sim.soloPlayer.useOn(1, T - 1, 1, PY)) throw new Error('cannot place the crate');
    sim.soloPlayer.emptyHand();
    if (!sim.soloPlayer.useOn(1, T, 1, PY)) throw new Error('cannot light the crate');
    const lit = primedCrates(sim).length;
    sim.soloPlayer.teleport(30.5, T, 30.5);
    const log = new Events(sim);
    tickUntilExplosion(sim, log);
    return { sim, w, ship, rotor, mast, lit, log };
  }

  it('a small ship blown away entirely: what is left of its windmill ends up in the (otherwise empty) ship', () => {
    const { ship, rotor, mast, lit } = smallShip();
    expect(lit).toBe(1);
    expect(rotor.removed).toBe(true);
    expect(ship.removed).toBe(false);
    const survivors = gridCells(rotor.grid);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(mast.length);
    // Not one hull cell survived; the ship holds exactly the mast remains (on the spin axis, so in place).
    expect(gridCells(ship.grid, [B.PLANKS_OAK, B.HELM, B.BEARING])).toEqual([]);
    expect(gridCells(ship.grid)).toEqual(survivors);
    expect(ship.grid.count).toBe(survivors.length);
  });

  it('... with no orphan rotor, nothing lost into the world, and the ship goes on being simulated', () => {
    const { sim, w, ship, rotor } = smallShip();
    const survivors = gridCells(rotor.grid);
    expect(sim.structures.rotors().length).toBe(0);
    expect(ship.children.length).toBe(0);
    expect(sim.structures.ships()).toContain(ship);
    expect(cellsIn(w, [B.CANVAS], -6, 0, -6, 8, T + 12, 8)).toEqual([]);
    sim.advance(40);
    expect(ship.removed).toBe(false);
    expect(sim.structures.ships()).toContain(ship);
    expect(gridCells(ship.grid)).toEqual(survivors);
    const p = ship.grid.position;
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    expect(cellsIn(w, [B.CANVAS], -6, 0, -6, 8, T + 12, 8)).toEqual([]);
  });
});

// =====================================================================================
// 14
// =====================================================================================

/**
 * At sea, creative: a 5x5 raft with a helm (2, SEA, 4) facing north, a plank post (2, SEA..by, 2)
 * and on its north face a bearing (2, by, 1) facing north; a canvas windmill in the plane z = 0
 * (hub (2, by, 0), up 2, down 1, west 2 — no east arm, so the player hovering north-east sees the
 * hub's and the bearing's east faces). The player glues the bearing's front face with the glue
 * item and puts the hub canvas against it (DESIGN 强力胶: glue belongs to a face; blocks that
 * already touch cannot be glued), and (when `start`) starts the windmill on the world.
 */
function gluedRaftWindmill(start = true) {
  const sim = seaWorld('creative', { x: 4.5, y: SEA + 2, z: -0.5 }, 15);
  sim.soloPlayer.player.flying = true;
  const w = sim.world;
  const by = SEA + 3;
  fill(w, 0, SEA - 1, 0, 4, SEA - 1, 4, B.PLANKS_OAK);
  set(w, 2, SEA, 4, B.HELM, facingState(NZ));
  fill(w, 2, SEA, 2, 2, by, 2, B.PLANKS_OAK); // post
  set(w, 2, by, 1, B.BEARING, facingState(NZ)); // mounted on the post's north face
  sim.advance(2);
  sim.soloPlayer.hold(I.GLUE);
  if (!sim.soloPlayer.useOn(2, by, 1, NZ)) throw new Error('cannot glue'); // the bearing's front face
  sim.soloPlayer.hold(B.CANVAS);
  sim.soloPlayer.player.input.sneak = true; // with a block in hand, sneak + right-click on a bearing places
  if (!sim.soloPlayer.useOn(2, by, 1, NZ)) throw new Error('cannot place the hub'); // the hub, against it
  sim.soloPlayer.player.input.sneak = false;
  if ((w.getCell(2, by, 0) & ID_MASK) !== B.CANVAS) throw new Error('no hub');
  if (!sim.worldGlue.has(2, by, 0, PZ)) throw new Error('no glue');
  const windmill: Cell[] = [[2, by, 0, B.CANVAS]];
  for (const [dx, dy] of [[0, 1], [0, 2], [0, -1], [-1, 0], [-2, 0]] as const) windmill.push([2 + dx, by + dy, 0, B.CANVAS]);
  for (const [x, y, z, id] of windmill) set(w, x, y, z, id);
  sim.advance(2);
  sim.soloPlayer.emptyHand();
  const rotor = start ? startByPlayer(sim, 2, by, 1, PX) : (null as unknown as Rotor);
  return { sim, w, by, windmill, rotor };
}

describe('14. 轴心和轴承之间的胶，在风车启动再停下之后仍然在。', () => {
  it('glue the hub to the bearing, start the windmill, let it turn half a turn, stop it: the glue is there again', () => {
    const sim = flatWorld('creative', { x: 2.5, y: T, z: -1.5 }, 14);
    const w = sim.world;
    const Y = T + 4;
    fill(w, -1, T, -4, -1, Y, -4, B.STONE_BRICKS);
    set(w, 0, Y, -4, B.BEARING, facingState(PX));
    sim.advance(2);
    const log = new Events(sim);
    // Glue: right-click the bearing's front face with the glue in hand, then put the hub on it.
    sim.soloPlayer.hold(I.GLUE);
    expect(sim.soloPlayer.useOn(0, Y, -4, PX)).toBe(true);
    expect(log.toastKeys()).toContain('toast.glue.added');
    sim.soloPlayer.hold(B.CANVAS);
    sim.soloPlayer.player.input.sneak = true; // with a block in hand, sneak + right-click on a bearing places
    expect(sim.soloPlayer.useOn(0, Y, -4, PX)).toBe(true);
    sim.soloPlayer.player.input.sneak = false;
    expect(idAt(w, 1, Y, -4)).toBe(B.CANVAS); // hub
    expect(sim.worldGlue.has(1, Y, -4, NX)).toBe(true);
    for (const [dy, dz] of [[1, 0], [2, 0], [-1, 0], [0, -1], [0, -2]] as const) set(w, 1, Y + dy, -4 + dz, B.CANVAS);
    sim.advance(2);

    sim.soloPlayer.emptyHand();
    const rotor = startByPlayer(sim, 0, Y, -4, PZ);
    spinUntil(sim, rotor, Math.PI - 0.25, Math.PI - 0.15);
    expect(sim.soloPlayer.useOn(0, Y, -4, PZ)).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(idAt(w, 1, Y, -4)).toBe(B.CANVAS); // the hub is back in front of the bearing
    expect(sim.worldGlue.has(1, Y, -4, NX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('... so a windmill stopped on a raft is taken along when the raft is assembled into a ship', () => {
    const { sim, w, by, windmill, rotor } = gluedRaftWindmill();
    sim.soloPlayer.emptyHand();
    spinUntil(sim, rotor, Math.PI - 0.25, Math.PI - 0.15);
    // Stop it from above the bearing (the turned arms now hide its east face).
    sim.soloPlayer.teleport(4.5, by + 0.5, 2.5);
    sim.soloPlayer.player.flying = true;
    expect(sim.soloPlayer.useOn(2, by, 1, PY)).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(sim.worldGlue.has(2, by, 0, PZ)).toBe(true);

    // Assemble the raft at its helm.
    sim.soloPlayer.teleport(2.5, SEA + 1, 6.5);
    sim.soloPlayer.player.flying = true;
    sim.tick();
    expect(sim.soloPlayer.useOn(2, SEA, 4)).toBe(true);
    expect(sim.soloPlayer.useOn(2, SEA, 4)).toBe(true);
    const ship = sim.structures.ships()[0];
    expect(ship).toBeDefined();
    expect(gridCells(ship!.grid, [B.CANVAS]).length).toBe(windmill.length);
    expect(ship!.glue.has(2, by, 0, PZ)).toBe(true);
    expect(cellsIn(w, [B.CANVAS], -4, SEA - 2, -4, 8, by + 4, 8)).toEqual([]);
  });

  it('also when the windmill is started on a ship, the ship docks turned by 90° while it spins, and it is stopped on the world', () => {
    const { sim, w, by, windmill } = gluedRaftWindmill(false);
    sim.soloPlayer.emptyHand();
    sim.soloPlayer.teleport(2.5, SEA + 1, 6.5);
    sim.soloPlayer.player.flying = true;
    sim.tick();
    expect(sim.soloPlayer.useOn(2, SEA, 4)).toBe(true);
    expect(sim.soloPlayer.useOn(2, SEA, 4)).toBe(true);
    const ship = sim.structures.ships()[0]!;
    expect(gridCells(ship.grid, [B.CANVAS]).length).toBe(windmill.length); // the glue took it along
    sim.soloPlayer.use(); // let go of the wheel
    sim.tick();
    sim.advance(20);
    const fly = (x: number, y: number, z: number): void => {
      const q = ship.grid.toWorld(vec3(x, y, z));
      sim.soloPlayer.teleport(q.x, q.y, q.z);
      sim.soloPlayer.player.flying = true;
      sim.tick();
    };
    fly(4.5, by - 1, -0.5);
    const rotor = startByPlayer(sim, 2, by, 1, PX, ship.id);
    sim.advance(10);
    // The ship turns 90° to the left (pose set by hand), then the player docks it: sneak + right-click
    // on the helm with an empty hand. The windmill keeps turning, now on the world.
    ship.grid.setPoseImmediate(ship.grid.position, qmul(qfromYaw(HALF_PI), ship.grid.rotation));
    sim.dynamics.wake(ship);
    sim.advance(20);
    fly(2.5, SEA + 1, 6.5);
    sim.soloPlayer.player.input.sneak = true;
    expect(sim.soloPlayer.useOn(2, SEA, 4, undefined, ship.id)).toBe(true);
    sim.soloPlayer.player.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(rotor.removed).toBe(false);
    expect(rotor.parent).toBeNull();
    // The bearing now faces west (north turned left), the hub is in front of it once stopped.
    const [bx, byy, bz] = [rotor.bearingX, rotor.bearingY, rotor.bearingZ];
    expect(idAt(w, bx, byy, bz)).toBe(B.BEARING);
    expect(stateFacing(cellState(w.getCell(bx, byy, bz)))).toBe(NX);
    spinUntil(sim, rotor, 1.2, 1.3);
    sim.soloPlayer.teleport(bx + 2.5, byy + 0.5, bz + 2.5);
    sim.soloPlayer.player.flying = true;
    sim.tick();
    expect(sim.soloPlayer.useOn(bx, byy, bz)).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(idAt(w, bx - 1, byy, bz)).toBe(B.CANVAS);
    expect(sim.worldGlue.has(bx, byy, bz, NX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
  });
});

// =====================================================================================
// 10 + glue: a stop never glues a blade to the terrain that stopped its neighbour
// =====================================================================================

describe('10 与胶：风车停在地形里时，叶片不会和挡住它的地形粘在一起（结构体移动不会产生新的胶连接）。', () => {
  it('two blade cells glued together; after a half turn the outer one lands in a stone and drops: the inner one is not glued to the stone, and the restarted windmill leaves the stone in the world', () => {
    const sim = flatWorld('creative', { x: 2.5, y: T, z: -1.5 }, 16);
    const w = sim.world;
    const Y = T + 4;
    const Z = -4;
    // Bearing (0, Y, Z) facing east on a stone-brick post; canvas hub (1, Y, Z), up arm (1, Y+1..Y+2), down arm (1, Y-1).
    fill(w, -1, T, Z, -1, Y, Z, B.STONE_BRICKS);
    set(w, 0, Y, Z, B.BEARING, facingState(PX));
    for (const dy of [0, 1, 2, -1]) set(w, 1, Y + dy, Z, B.CANVAS);
    sim.advance(2);
    // The player glues the top of the up arm and puts a third canvas on it: two glued blade cells.
    sim.soloPlayer.teleport(3.5, Y + 2, Z + 0.5);
    sim.soloPlayer.player.flying = true;
    sim.tick();
    sim.soloPlayer.hold(I.GLUE);
    expect(sim.soloPlayer.useOn(1, Y + 2, Z, PY)).toBe(true);
    sim.soloPlayer.hold(B.CANVAS);
    expect(sim.soloPlayer.useOn(1, Y + 2, Z, PY)).toBe(true);
    expect(idAt(w, 1, Y + 3, Z)).toBe(B.CANVAS);
    expect(sim.worldGlue.has(1, Y + 2, Z, PY)).toBe(true);
    sim.soloPlayer.teleport(2.5, T, -1.5);
    sim.soloPlayer.player.flying = false;
    sim.advance(2);
    sim.soloPlayer.emptyHand();
    sim.rules.dropsEnabled = true; // so the cell that lands in the stone shows up as a drop (a world rule)

    const rotor = startByPlayer(sim, 0, Y, Z, PZ);
    expect(rotor.grid.count).toBe(5);
    expect(rotor.glue.has(1, Y + 2, Z, PY)).toBe(true);
    spinUntil(sim, rotor, Math.PI - 0.25, Math.PI - 0.15);
    // A half turn about +X puts the up arm at (1, Y-1..Y-3): its tip lands in this stone.
    set(w, 1, Y - 3, Z, B.STONE);
    sim.tick();
    expect(sim.soloPlayer.useOn(0, Y, Z, PZ)).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(idAt(w, 1, Y - 2, Z)).toBe(B.CANVAS);
    expect(idAt(w, 1, Y - 3, Z)).toBe(B.STONE);
    expect(dropped(sim, B.CANVAS)).toBe(1); // the tip
    expect(sim.worldGlue.has(1, Y - 2, Z, NY)).toBe(false); // blade and stone are not joined
    expect(sim.worldGlue.size).toBe(0);

    const again = startByPlayer(sim, 0, Y, Z, PZ);
    expect(again.grid.count).toBe(4); // hub, two blade cells of the old up arm, the old down arm
    expect(gridCells(again.grid, [B.STONE])).toEqual([]);
    expect(idAt(w, 1, Y - 3, Z)).toBe(B.STONE);
  });
});
