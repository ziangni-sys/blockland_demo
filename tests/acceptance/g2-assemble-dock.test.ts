/**
 * Acceptance scenarios 6-9 (docs/ACCEPTANCE.md, 组装与停靠), headless, at the level of the whole
 * simulation. Scenes are built with world.setCell; the player acts through the input path the
 * real game uses (look, right-click, left-click, sneak, held item, W/A/S/D at the wheel).
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NY, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { FALL_DELAY } from '../../src/sim/blockupdates';
import type { Simulation } from '../../src/sim/simulation';
import type { Ship } from '../../src/structures/structure';
import {
  EventLog,
  HELM_N,
  SEA_FLOOR,
  SEA_TOP,
  SURFACE,
  countWorld,
  expectedDock,
  facingAt,
  fallingBlocks,
  fill,
  findWorld,
  headingDeg,
  hullOverlapsWorldCell,
  idAt,
  itemDrops,
  key,
  minCentreZ,
  onlyShip,
  rotDirY,
  seaSim,
  shipCells,
  tiltDeg,
  tripleKeys,
} from './g2-assemble-dock-helpers';

const DECK = SEA_TOP - 1; // the raft lies in the top layer of the sea

// ------------------------------------------------------------------ scenes

interface RaftOpts {
  mode?: 'creative' | 'survival';
  /** Rubble pier touching the raft's south edge, with a post reaching under its south-east corner. */
  pier?: boolean;
  /** Felt glued onto the deck and glass glued onto the felt (two glue faces). */
  glued?: boolean;
  /** A 3-plank outrigger sticking out east from the bow (x 5..7, z 0). */
  outrigger?: boolean;
}

/**
 * A 5 x 6 plank raft at the sea surface (x 0..4, z 0..5, y = DECK) with a helm facing north at
 * (2, SEA_TOP, 4). With `pier`: a rubble pier x 0..4, z 6..8 from the sea floor up to the deck
 * layer, touching the raft's south edge, plus a rubble post under the raft at (4, .., 5). The
 * player stands on the pier at (2.5, SEA_TOP, 7.5) (on the raft's stern without a pier).
 */
function raftScene(o: RaftOpts = {}): Simulation {
  const pier = o.pier ?? true;
  const sim = seaSim({ mode: o.mode ?? 'creative', spawn: pier ? { x: 2.5, y: SEA_TOP, z: 7.5 } : { x: 2.5, y: SEA_TOP, z: 5.5 } });
  if (pier) {
    fill(sim, 0, SEA_FLOOR, 6, 4, DECK, 8, B.COBBLE);
    fill(sim, 4, SEA_FLOOR, 5, 4, DECK - 1, 5, B.COBBLE); // post under the raft's corner plank
  }
  fill(sim, 0, DECK, 0, 4, DECK, 5, B.PLANKS_OAK);
  sim.world.setCell(2, SEA_TOP, 4, HELM_N);
  if (o.outrigger) fill(sim, 5, DECK, 0, 7, DECK, 0, B.PLANKS_OAK);
  if (o.glued) {
    sim.world.setCell(0, SEA_TOP, 0, makeCell(B.WOOL_WHITE));
    sim.world.setCell(1, SEA_TOP, 0, makeCell(B.GLASS));
    sim.worldGlue.add(0, SEA_TOP, 0, NY); // felt <-> deck
    sim.worldGlue.add(0, SEA_TOP, 0, PX); // felt <-> glass
  }
  sim.advance(10); // chunks around the scene load
  sim.emptyHand();
  return sim;
}

/** Cells of the raft scene's ship: 30 planks + the helm (+ felt and glass when glued). */
function raftCells(glued: boolean): string[] {
  const out: string[] = [];
  for (let z = 0; z <= 5; z++) for (let x = 0; x <= 4; x++) out.push(key(x, DECK, z));
  out.push(key(2, SEA_TOP, 4));
  if (glued) out.push(key(0, SEA_TOP, 0), key(1, SEA_TOP, 0));
  return out.sort();
}

/** Right-click the world helm of the raft scene from the pier (fails the test if it cannot be aimed at). */
function clickHelm(sim: Simulation): void {
  expect(sim.useOn(2, SEA_TOP, 4, PZ)).toBe(true);
}

/** Assemble the raft through the player: two right-clicks on the helm. */
function assembleRaft(sim: Simulation): Ship {
  clickHelm(sim);
  clickHelm(sim);
  return onlyShip(sim);
}

/** Hold the wheel's keys for `ticks` ticks. */
function steer(sim: Simulation, forward: number, strafe: number, ticks: number): void {
  sim.player.input.forward = forward;
  sim.player.input.strafe = strafe;
  sim.advance(ticks);
  sim.player.input.forward = 0;
  sim.player.input.strafe = 0;
}

/** One right-click (whatever the player aims at) and one tick. */
function click(sim: Simulation): void {
  sim.use();
  sim.tick();
}

/** Sneak + one right-click (whatever the player aims at), then stand up again. */
function sneakClick(sim: Simulation): void {
  sim.player.input.sneak = true;
  sim.use();
  sim.tick();
  sim.player.input.sneak = false;
}

// ==================================================================== scenario 6

describe('6. 木筏加舵轮：第一次右键高亮；世界有变化后要重新预览；第二次右键组装。紧贴着的圆石码头不会被带走。', () => {
  it('第一次右键高亮: the first right-click only previews — the preview lists exactly the raft and the helm, nothing moves', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    sim.lookAtCell(2, SEA_TOP, 4, PZ);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.preview');
    clickHelm(sim);
    // highlighted: the preview is the set of cells the helm would take
    expect(sim.view.preview).not.toBeNull();
    expect(sim.view.preview!.kind).toBe('ship');
    expect(sim.view.preview!.gridId).toBe(0);
    expect(tripleKeys(sim.view.preview!.cells)).toEqual(raftCells(false));
    expect(sim.view.hint).toEqual({ key: 'hint.helm.assemble', params: { count: 31 } });
    // ...and nothing was assembled or moved
    expect(sim.structures.all().length).toBe(0);
    expect(log.of('structureAdded').length).toBe(0);
    expect(countWorld(sim, B.PLANKS_OAK, 0, DECK, 0, 4, DECK, 5)).toBe(30);
    expect(idAt(sim, 2, SEA_TOP, 4)).toBe(B.HELM);
    // the highlight stays while the player keeps looking at the helm
    sim.advance(20);
    expect(tripleKeys(sim.view.preview!.cells)).toEqual(raftCells(false));
    expect(sim.structures.all().length).toBe(0);
  });

  it('世界有变化后要重新预览: a block the player places between the clicks forces a fresh preview, the click after that assembles it too', () => {
    const sim = raftScene();
    // Planks in hand from the start: switching the slot would drop the preview by itself.
    sim.hold(B.PLANKS_OAK);
    clickHelm(sim);
    expect(sim.view.preview!.cells.length).toBe(31 * 3);
    // The player puts a plank on the deck (right-click on the top face of a raft plank).
    expect(sim.useOn(1, DECK, 3, PY)).toBe(true);
    expect(idAt(sim, 1, SEA_TOP, 3)).toBe(B.PLANKS_OAK);
    // the old highlight no longer stands: looking at the helm asks for a new preview
    expect(sim.view.preview).toBeNull();
    sim.lookAtCell(2, SEA_TOP, 4, PZ);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.helm.preview');
    // The next click on the helm previews again — with the new plank — instead of assembling.
    clickHelm(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(sim.view.preview).not.toBeNull();
    expect(tripleKeys(sim.view.preview!.cells)).toEqual([...raftCells(false), key(1, SEA_TOP, 3)].sort());
    expect(sim.view.hint).toEqual({ key: 'hint.helm.assemble', params: { count: 32 } });
    // The click after that assembles, the new plank included.
    clickHelm(sim);
    const ship = onlyShip(sim);
    expect(ship.grid.count).toBe(32);
    expect(ship.grid.getCell(1, SEA_TOP, 3) & ID_MASK).toBe(B.PLANKS_OAK);
  });

  it('世界有变化后要重新预览: a raft block mined between the clicks forces a fresh preview without it', () => {
    const sim = raftScene();
    clickHelm(sim);
    expect(sim.view.preview!.cells.length).toBe(31 * 3);
    expect(sim.mine(4, DECK, 5, PY)).toBe(true); // creative: breaks at once
    expect(idAt(sim, 4, DECK, 5)).not.toBe(B.PLANKS_OAK);
    expect(sim.view.preview).toBeNull();
    clickHelm(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(tripleKeys(sim.view.preview!.cells)).toEqual(raftCells(false).filter((k) => k !== key(4, DECK, 5)));
    clickHelm(sim);
    expect(onlyShip(sim).grid.count).toBe(30);
  });

  it('世界有变化后要重新预览: glue applied between the clicks (by someone else) forces a fresh preview that takes the glued block along', () => {
    const sim = raftScene();
    sim.world.setCell(3, SEA_TOP, 1, makeCell(B.STONE)); // stone lying on the deck: not part of the raft
    sim.advance(2);
    clickHelm(sim);
    expect(tripleKeys(sim.view.preview!.cells)).toEqual(raftCells(false));
    sim.worldGlue.add(3, SEA_TOP, 1, NY); // glued onto the plank under it
    sim.tick();
    clickHelm(sim);
    expect(sim.structures.all().length).toBe(0);
    expect(tripleKeys(sim.view.preview!.cells)).toEqual([...raftCells(false), key(3, SEA_TOP, 1)].sort());
    clickHelm(sim);
    const ship = onlyShip(sim);
    expect(ship.grid.count).toBe(32);
    expect(ship.grid.getCell(3, SEA_TOP, 1) & ID_MASK).toBe(B.STONE);
    expect(ship.glue.size).toBe(1);
  });

  it('第二次右键组装: the second right-click on an unchanged preview assembles exactly the previewed cells', () => {
    const sim = raftScene();
    const log = new EventLog(sim);
    clickHelm(sim);
    const previewed = tripleKeys(sim.view.preview!.cells);
    clickHelm(sim);
    const ship = onlyShip(sim);
    expect(log.of('structureAdded').map((e) => e.id)).toEqual([ship.id]);
    expect(log.toasts()).toContainEqual({ key: 'toast.ship.assembled', params: { count: 31 } });
    // the ship holds exactly what was highlighted, at the same (local = world) coordinates
    expect(tripleKeys(shipCells(ship).flatMap((c) => [c.x, c.y, c.z]))).toEqual(previewed);
    expect(ship.grid.getCell(2, SEA_TOP, 4) & ID_MASK).toBe(B.HELM);
    // the blocks left the world; the footprint is sea again
    expect(countWorld(sim, B.PLANKS_OAK, -3, SEA_FLOOR, -3, 8, SEA_TOP + 3, 9)).toBe(0);
    expect(countWorld(sim, B.HELM, -3, SEA_FLOOR, -3, 8, SEA_TOP + 3, 9)).toBe(0);
    expect(idAt(sim, 2, DECK, 2)).toBe(B.WATER);
    // the player took the wheel
    expect(sim.player.steeringShipId).toBe(ship.id);
    expect(sim.view.preview).toBeNull();
  });

  it('紧贴着的圆石码头不会被带走: the rubble pier touching the raft is not highlighted, not taken, and stays when the ship sails off', () => {
    const sim = raftScene();
    const pierBefore = countWorld(sim, B.COBBLE, -1, SEA_FLOOR, -1, 5, SEA_TOP, 9);
    expect(pierBefore).toBe(5 * 10 * 3 + 9);
    clickHelm(sim);
    const previewed = tripleKeys(sim.view.preview!.cells);
    for (const k of previewed) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      expect(idAt(sim, x, y, z)).not.toBe(B.COBBLE);
    }
    clickHelm(sim);
    const ship = onlyShip(sim);
    let cobbleInShip = 0;
    ship.grid.forEachCell((_x, _y, _z, c) => {
      if ((c & ID_MASK) === B.COBBLE) cobbleInShip++;
    });
    expect(cobbleInShip).toBe(0);
    expect(countWorld(sim, B.COBBLE, -1, SEA_FLOOR, -1, 5, SEA_TOP, 9)).toBe(pierBefore);
    // Sail north for a while: the pier stays where it is, whole.
    steer(sim, 1, 0, 120);
    expect(ship.grid.position.z).toBeLessThan(-2);
    expect(countWorld(sim, B.COBBLE, -1, SEA_FLOOR, -1, 5, SEA_TOP, 9)).toBe(pierBefore);
    expect(countWorld(sim, B.COBBLE, 0, SEA_FLOOR, 6, 4, DECK, 8)).toBe(150);
  });
});

// ==================================================================== scenario 7

/** World y of the bottom face of the raft, at its middle. */
function raftBottomY(ship: Ship): number {
  return ship.grid.toWorld({ x: 2.5, y: DECK, z: 2.5 }).y;
}

describe('7. 船能漂浮、行驶、转向；撞墙会停住，不会穿墙。', () => {
  it('漂浮: the assembled raft floats at the surface, upright, for hundreds of ticks', () => {
    const sim = raftScene({ pier: false });
    const ship = assembleRaft(sim);
    sim.advance(40); // settle
    let minBottom = Infinity;
    let maxBottom = -Infinity;
    let maxTilt = 0;
    for (let t = 0; t < 400; t++) {
      sim.tick();
      const b = raftBottomY(ship);
      minBottom = Math.min(minBottom, b);
      maxBottom = Math.max(maxBottom, b);
      maxTilt = Math.max(maxTilt, tiltDeg(ship));
    }
    // partly in the water: the bottom is below the surface, the deck top above it
    expect(maxBottom).toBeLessThan(SURFACE);
    expect(minBottom + 1).toBeGreaterThan(SURFACE);
    // it does not sink or bob away
    expect(maxBottom - minBottom).toBeLessThan(0.1);
    // upright
    expect(maxTilt).toBeLessThan(3);
    expect(ship.removed).toBe(false);
  });

  it('行驶: W at the wheel drives the raft toward its bow (north)', () => {
    const sim = raftScene({ pier: false });
    const ship = assembleRaft(sim);
    sim.advance(40);
    const p0 = { ...ship.grid.position };
    // nothing pressed: it stays
    sim.advance(100);
    expect(Math.hypot(ship.grid.position.x - p0.x, ship.grid.position.z - p0.z)).toBeLessThan(0.1);
    sim.player.input.forward = 1;
    sim.advance(200);
    expect(ship.throttle).toBe(1);
    const p1 = ship.grid.position;
    expect(p0.z - p1.z).toBeGreaterThan(6); // ~2.5 blocks/s rowing speed after the spin-up
    expect(Math.abs(p1.x - p0.x)).toBeLessThan(0.3);
    expect(sim.helmView()!.speed).toBeGreaterThan(1.5);
    expect(Math.abs(headingDeg(ship))).toBeLessThan(3);
    sim.player.input.forward = 0;
  });

  it('行驶: S at the wheel drives it astern (south)', () => {
    const sim = raftScene({ pier: false });
    const ship = assembleRaft(sim);
    sim.advance(40);
    const z0 = ship.grid.position.z;
    steer(sim, -1, 0, 200);
    expect(ship.grid.position.z - z0).toBeGreaterThan(2);
  });

  it('转向: D turns the raft to the right (clockwise from above), A to the left', () => {
    for (const [strafe, sign] of [
      [1, -1],
      [-1, 1],
    ] as const) {
      const sim = raftScene({ pier: false });
      const ship = assembleRaft(sim);
      sim.advance(40);
      steer(sim, 1, 0, 60); // under way, heading north
      const h0 = headingDeg(ship);
      const x0 = ship.grid.position.x;
      sim.player.input.forward = 1;
      sim.player.input.strafe = strafe;
      sim.advance(60);
      expect(ship.rudder).toBe(strafe);
      const turned = headingDeg(ship) - h0;
      // heading: yaw grows to the left (counter-clockwise from above)
      expect(Math.sign(turned)).toBe(sign);
      expect(Math.abs(turned)).toBeGreaterThan(20);
      // the course bends the same way: east for a right turn, west for a left turn
      expect(Math.sign(ship.grid.position.x - x0)).toBe(-sign);
      expect(Math.abs(ship.grid.position.x - x0)).toBeGreaterThan(0.5);
      // it stays upright while turning
      expect(tiltDeg(ship)).toBeLessThan(10);
    }
  });

  /**
   * Full throttle for `ticks` ticks (at a wall): the smallest world z any cell centre of the ship
   * reached over all ticks, the top speed, the speed at the end, and how much the ship still moved
   * over the last 100 ticks.
   */
  function crash(sim: Simulation, ship: Ship, ticks: number) {
    const cells = shipCells(ship);
    let minZ = Infinity;
    let topSpeed = 0;
    const lastZ: number[] = [];
    sim.player.input.forward = 1;
    for (let t = 0; t < ticks; t++) {
      sim.tick();
      minZ = Math.min(minZ, minCentreZ(ship, cells));
      topSpeed = Math.max(topSpeed, sim.helmView()?.speed ?? 0);
      if (t >= ticks - 100) lastZ.push(ship.grid.position.z);
    }
    const speedAtEnd = sim.helmView()?.speed ?? NaN;
    sim.player.input.forward = 0;
    return { minZ, topSpeed, speedAtEnd, drift: Math.max(...lastZ) - Math.min(...lastZ) };
  }

  for (const thickness of [3, 1]) {
    it(`撞墙会停住，不会穿墙: rowing at full throttle into a ${thickness === 1 ? 'one-block-thin' : 'three-block-thick'} wall — stops at it, never through it`, () => {
      const sim = raftScene({ pier: false });
      const WZ = -12; // southmost wall row
      fill(sim, -10, SEA_FLOOR, WZ - thickness + 1, 14, SEA_TOP + 3, WZ, B.STONE);
      const wallCells = countWorld(sim, B.STONE, -10, SEA_FLOOR, WZ - thickness + 1, 14, SEA_TOP + 3, WZ);
      expect(wallCells).toBe(thickness * 25 * 14); // the whole wall is loaded and built
      const ship = assembleRaft(sim);
      const r = crash(sim, ship, 400);
      // it reached the wall (the bow cells' centres half a block from its face)...
      expect(r.minZ).toBeLessThan(WZ + 1 + 0.75);
      // ...no cell centre ever got into the wall or past it...
      expect(r.minZ).toBeGreaterThan(WZ + 1);
      // ...and it stopped there, the throttle still open
      expect(r.speedAtEnd).toBeLessThan(0.2);
      expect(r.drift).toBeLessThan(0.05);
      expect(r.topSpeed).toBeGreaterThan(2);
      expect(countWorld(sim, B.STONE, -10, SEA_FLOOR, WZ - thickness + 1, 14, SEA_TOP + 3, WZ)).toBe(wallCells);
    });
  }

  /**
   * A 5 x 9 raft (x 0..4, z 0..8) with the helm at the stern (2, SEA_TOP, 7) and a mast amidships
   * carrying a bearing facing north with a 5 x 5 canvas sail (hub glued to the bearing). The player
   * stands on the deck at (4.5, SEA_TOP, 6.5). `wall(sim)` builds the obstacle once the chunks are
   * loaded; then the player starts the windmill (two right-clicks on the bearing) and takes the
   * ship (two right-clicks on the helm).
   */
  function sailShip(loadRadius: number, wall: (sim: Simulation) => void): { sim: Simulation; ship: Ship } {
    const sim = seaSim({ spawn: { x: 4.5, y: SEA_TOP, z: 6.5 } });
    fill(sim, 0, DECK, 0, 4, DECK, 8, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP, 7, HELM_N);
    fill(sim, 2, SEA_TOP, 5, 2, SEA_TOP + 4, 5, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP + 4, 4, makeCell(B.BEARING, facingState(NZ)));
    fill(sim, 0, SEA_TOP + 2, 3, 4, SEA_TOP + 6, 3, B.CANVAS);
    sim.worldGlue.add(2, SEA_TOP + 4, 3, PZ); // hub <-> bearing
    sim.loadRadius = loadRadius; // the whole wall must be loaded when it is built
    sim.advance(30); // (4 chunk columns per tick)
    wall(sim);
    sim.emptyHand();
    expect(sim.useOn(2, SEA_TOP + 4, 4, PX)).toBe(true);
    expect(sim.useOn(2, SEA_TOP + 4, 4, PX)).toBe(true);
    expect(sim.structures.rotors().length).toBe(1);
    expect(sim.useOn(2, SEA_TOP, 7, PX)).toBe(true);
    expect(sim.useOn(2, SEA_TOP, 7, PX)).toBe(true);
    const ship = onlyShip(sim);
    expect(sim.player.steeringShipId).toBe(ship.id);
    sim.advance(20);
    expect(ship.sails).toBe(25);
    return { sim, ship };
  }

  it('撞墙会停住，不会穿墙: a windmill ship at sail speed (25 sails) into a one-block-thin wall — stops at it, never through it', () => {
    const WZ = -40;
    const { sim, ship } = sailShip(3, (s) => {
      fill(s, -10, SEA_FLOOR, WZ, 14, SEA_TOP + 3, WZ, B.STONE);
      expect(countWorld(s, B.STONE, -10, SEA_FLOOR, WZ, 14, SEA_TOP + 3, WZ)).toBe(25 * 14);
    });
    const r = crash(sim, ship, 400);
    expect(r.topSpeed).toBeGreaterThan(6); // faster than rowing
    expect(r.minZ).toBeLessThan(WZ + 1 + 0.75);
    expect(r.minZ).toBeGreaterThan(WZ + 1);
    expect(r.speedAtEnd).toBeLessThan(0.2);
    expect(r.drift).toBeLessThan(0.05);
    expect(countWorld(sim, B.STONE, -10, SEA_FLOOR, WZ, 14, SEA_TOP + 3, WZ)).toBe(25 * 14);
  });

  it('撞墙会停住，不会穿墙: the windmill ship hitting the thin wall at sail speed, ~25 degrees off square — never through it, ends stopped against it', () => {
    const WZ = -40;
    const { sim, ship } = sailShip(5, (s) => {
      fill(s, -40, SEA_FLOOR, WZ, 40, SEA_TOP + 3, WZ, B.STONE); // wide: the ship slides along it
      expect(countWorld(s, B.STONE, -40, SEA_FLOOR, WZ, 40, SEA_TOP + 3, WZ)).toBe(81 * 14);
    });
    const cells = shipCells(ship);
    // a touch of port rudder while speeding up, then straight on
    sim.player.input.forward = 1;
    sim.player.input.strafe = -1;
    for (let t = 0; t < 300 && headingDeg(ship) < 6; t++) sim.tick();
    sim.player.input.strafe = 0;
    let minZ = Infinity;
    let headingAtImpact = NaN;
    let speedAtImpact = 0;
    for (let t = 0; t < 400; t++) {
      const v = sim.helmView()!.speed;
      const h = headingDeg(ship);
      sim.tick();
      const m = minCentreZ(ship, cells);
      if (Number.isNaN(headingAtImpact) && m < WZ + 1 + 0.75) {
        headingAtImpact = h;
        speedAtImpact = v;
      }
      minZ = Math.min(minZ, m);
    }
    expect(headingAtImpact).toBeGreaterThan(15);
    expect(headingAtImpact).toBeLessThan(35);
    expect(speedAtImpact).toBeGreaterThan(6);
    expect(minZ).toBeGreaterThan(WZ + 1);
    expect(sim.helmView()!.speed).toBeLessThan(0.2);
    expect(minCentreZ(ship, cells)).toBeLessThan(WZ + 1 + 0.75);
    expect(countWorld(sim, B.STONE, -40, SEA_FLOOR, WZ, 40, SEA_TOP + 3, WZ)).toBe(81 * 14);
    sim.player.input.forward = 0;
  });
});

// ==================================================================== scenario 8

/** How far an angle advanced from a0 to a1 (radians, in [0, 2 pi): the rotors here turn the positive way). */
function angleAdvance(a0: number, a1: number): number {
  const t = 2 * Math.PI;
  return (((a1 - a0) % t) + t) % t;
}

/** Docking destination of the ship-local cell (x,y,z) in an expectedDock() result. */
function destOf(exp: ReturnType<typeof expectedDock>, x: number, y: number, z: number): { x: number; y: number; z: number } {
  for (const [c, d] of exp.dest) if (c.x === x && c.y === y && c.z === z) return d;
  throw new Error(`no ship cell at ${x},${y},${z}`);
}

/** Leave the pier, then turn left in place until the heading passes `minDeg`, and let the ship settle. */
function turnLeft(sim: Simulation, ship: Ship, minDeg: number): void {
  steer(sim, 1, 0, 60);
  sim.advance(40);
  sim.player.input.strafe = -1;
  for (let t = 0; t < 600 && headingDeg(ship) < minDeg; t++) sim.tick();
  sim.player.input.strafe = 0;
  sim.advance(100);
}

/** Every ship cell's block is in the world at its expected docking destination. */
function expectDocked(sim: Simulation, exp: ReturnType<typeof expectedDock>): void {
  for (const [c, d] of exp.dest) {
    const id = c.cell & ID_MASK;
    expect(idAt(sim, d.x, d.y, d.z), `cell ${c.x},${c.y},${c.z} -> ${d.x},${d.y},${d.z}`).toBe(id);
  }
}

describe('8. 停靠位置被挡住时拒绝并标红。停靠成功后，方块和胶回到世界，船上的风车改挂到世界；再次组装时方块数和胶数都一致。', () => {
  /**
   * The glued raft with its outrigger, sailed off the pier and turned ~30 degrees to port (the nearest axis-aligned
   * pose is still the unrotated one). Returns the ship and the two docking destinations chosen
   * for the blocking stones: world cells where a ship cell would land but which the hull does
   * not touch now (corner cells swing well clear of their snapped place at 30 degrees).
   */
  function yawedShipWithBlockers() {
    const sim = raftScene({ glued: true, outrigger: true });
    const log = new EventLog(sim);
    const ship = assembleRaft(sim);
    expect(ship.grid.count).toBe(36);
    expect(ship.glue.size).toBe(2);
    turnLeft(sim, ship, 15);
    const h = headingDeg(ship);
    expect(h).toBeGreaterThan(20);
    expect(h).toBeLessThan(40);
    expect(tiltDeg(ship)).toBeLessThan(5);
    const exp = expectedDock(ship);
    expect(exp.k).toBe(0);
    const free = [...exp.dest.values()].filter((d) => !hullOverlapsWorldCell(ship, d.x, d.y, d.z));
    expect(free.length).toBeGreaterThanOrEqual(2);
    const blockers = [free[0]!, free[free.length - 1]!];
    const before = blockers.map((b) => sim.world.getCell(b.x, b.y, b.z));
    for (const b of blockers) sim.world.setCell(b.x, b.y, b.z, makeCell(B.STONE));
    return { sim, log, ship, blockers, restore: () => blockers.forEach((b, i) => sim.world.setCell(b.x, b.y, b.z, before[i]!)) };
  }

  function expectRefused(sim: Simulation, log: EventLog, ship: Ship, blockers: Array<{ x: number; y: number; z: number }>): void {
    // refused, with the reason
    expect(log.toasts()).toContainEqual({ key: 'toast.dock.blocked', params: { count: blockers.length } });
    expect(log.toastKeys()).not.toContain('toast.dock.done');
    // the ship still exists, untouched
    expect(sim.structures.ships().length).toBe(1);
    expect(sim.structures.ships()[0]).toBe(ship);
    expect(ship.removed).toBe(false);
    expect(ship.grid.count).toBe(36);
    expect(ship.glue.size).toBe(2);
    expect(countWorld(sim, B.PLANKS_OAK, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(0);
    expect(countWorld(sim, B.HELM, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(0);
    // marked red: exactly the blocking world cells
    expect(sim.view.conflicts.map((c) => key(c.x, c.y, c.z)).sort()).toEqual(blockers.map((b) => key(b.x, b.y, b.z)).sort());
  }

  it('停靠位置被挡住时拒绝并标红: sneak + right-click from the wheel is refused and the blocking world cells are marked', () => {
    const { sim, log, ship, blockers } = yawedShipWithBlockers();
    expect(sim.player.steeringShipId).toBe(ship.id);
    // (the stones lie where cells of the ship, as it floats now, would be put)
    const dests = [...expectedDock(ship).dest.values()].map((d) => key(d.x, d.y, d.z));
    for (const b of blockers) expect(dests).toContain(key(b.x, b.y, b.z));
    sneakClick(sim);
    expectRefused(sim, log, ship, blockers);
    // the blockers are still there; nothing was dropped or overwritten
    for (const b of blockers) expect(idAt(sim, b.x, b.y, b.z)).toBe(B.STONE);
  });

  it('停靠位置被挡住时拒绝并标红: sneak + right-click on the helm with an empty hand is refused the same way', () => {
    const { sim, log, ship, blockers } = yawedShipWithBlockers();
    click(sim); // a plain right-click at the wheel lets go of it
    expect(sim.player.steeringShipId).toBe(0);
    sim.player.input.sneak = true;
    expect(sim.useOn(2, SEA_TOP, 4, PZ, ship.id)).toBe(true);
    sim.player.input.sneak = false;
    expectRefused(sim, log, ship, blockers);
  });

  it('停靠成功后，方块和胶回到世界: every block and both glue faces land in the world at the snapped position', () => {
    const { sim, log, ship, restore } = yawedShipWithBlockers();
    sneakClick(sim); // blocked first
    expect(log.toastKeys()).toContain('toast.dock.blocked');
    restore();
    click(sim); // let go of the wheel; dock from the helm this time
    const exp = expectedDock(ship);
    expect(exp.k).toBe(0);
    sim.player.input.sneak = true;
    expect(sim.useOn(2, SEA_TOP, 4, PZ, ship.id)).toBe(true);
    sim.player.input.sneak = false;
    expect(log.toasts()).toContainEqual({ key: 'toast.dock.done', params: { count: 36 } });
    expect(ship.removed).toBe(true);
    expect(sim.structures.all().length).toBe(0);
    expect(log.of('structureRemoved').map((e) => e.id)).toEqual([ship.id]);
    expect(sim.view.conflicts).toEqual([]);
    // blocks: each one where the snapped pose puts it, nothing else
    expectDocked(sim, exp);
    for (const [c, d] of exp.dest) expect(sim.world.getCell(d.x, d.y, d.z)).toBe(c.cell); // unrotated: same state bits
    expect(countWorld(sim, B.PLANKS_OAK, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(33);
    expect(countWorld(sim, B.HELM, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(1);
    expect(countWorld(sim, B.WOOL_WHITE, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(1);
    expect(countWorld(sim, B.GLASS, -12, SEA_FLOOR, -20, 12, SEA_TOP + 3, 6)).toBe(1);
    const helm = destOf(exp, 2, SEA_TOP, 4);
    expect(facingAt(sim, helm.x, helm.y, helm.z)).toBe(NZ);
    // glue: felt <-> deck and felt <-> glass, at the new place
    const felt = destOf(exp, 0, SEA_TOP, 0);
    expect(sim.worldGlue.has(felt.x, felt.y, felt.z, NY)).toBe(true);
    expect(sim.worldGlue.has(felt.x, felt.y, felt.z, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
  });

  it('停靠成功后，方块和胶回到世界: a ship turned ~90 degrees docks rotated a quarter turn, blocks, facings and glue faces with it', () => {
    const sim = raftScene({ glued: true });
    const log = new EventLog(sim);
    const ship = assembleRaft(sim);
    turnLeft(sim, ship, 75);
    const h = headingDeg(ship);
    expect(h).toBeGreaterThan(70);
    expect(h).toBeLessThan(110);
    const exp = expectedDock(ship);
    expect(exp.k).toBe(1);
    click(sim); // let go of the wheel
    sim.player.input.sneak = true;
    expect(sim.useOn(2, SEA_TOP, 4, PZ, ship.id)).toBe(true);
    sim.player.input.sneak = false;
    expect(log.toastKeys()).toContain('toast.dock.done');
    expect(ship.removed).toBe(true);
    expectDocked(sim, exp);
    const helm = destOf(exp, 2, SEA_TOP, 4);
    expect(facingAt(sim, helm.x, helm.y, helm.z)).toBe(rotDirY(1, NZ)); // now facing west
    const felt = destOf(exp, 0, SEA_TOP, 0);
    const glass = destOf(exp, 1, SEA_TOP, 0);
    expect(Math.abs(glass.x - felt.x) + Math.abs(glass.z - felt.z)).toBe(1);
    expect(sim.worldGlue.has(felt.x, felt.y, felt.z, NY)).toBe(true);
    expect(sim.worldGlue.has(felt.x, felt.y, felt.z, rotDirY(1, PX))).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
  });

  it('再次组装时方块数和胶数都一致: docking and assembling again gives the same cell count and glue count', () => {
    const sim = raftScene({ glued: true });
    const ship = assembleRaft(sim);
    turnLeft(sim, ship, 75);
    const exp = expectedDock(ship);
    expect(exp.k).toBe(1);
    const n0 = ship.grid.count;
    const g0 = ship.glue.size;
    expect([n0, g0]).toEqual([33, 2]);
    sneakClick(sim); // dock from the wheel
    expect(ship.removed).toBe(true);
    // The player stands behind the helm (on the docked deck) and assembles it again.
    const helm = destOf(exp, 2, SEA_TOP, 4);
    const back = rotDirY(exp.k, PZ);
    expect(sim.useOn(helm.x, helm.y, helm.z, back)).toBe(true);
    expect(sim.view.preview!.cells.length).toBe(n0 * 3);
    expect(sim.useOn(helm.x, helm.y, helm.z, back)).toBe(true);
    const again = onlyShip(sim);
    expect(again).not.toBe(ship);
    expect(again.grid.count).toBe(n0);
    expect(again.glue.size).toBe(g0);
    expect(sim.worldGlue.size).toBe(0);
  });

  /**
   * A 5 x 9 raft (x 0..4, z 0..8) with the helm at the stern (2, SEA_TOP, 7), a 4-high mast at
   * (2, .., 5) carrying a bearing facing north at (2, SEA_TOP + 3, 4) and a cross of 9 canvas in
   * front of it (hub glued to the bearing), felt glued onto the stern deck and glass onto the felt.
   * The player starts the windmill and assembles the ship himself.
   */
  function windmillShip() {
    const sim = seaSim({ spawn: { x: 4.5, y: SEA_TOP, z: 6.5 } });
    const by = SEA_TOP + 3;
    fill(sim, 0, DECK, 0, 4, DECK, 8, B.PLANKS_OAK);
    sim.world.setCell(2, SEA_TOP, 7, HELM_N);
    fill(sim, 2, SEA_TOP, 5, 2, by, 5, B.PLANKS_OAK);
    sim.world.setCell(2, by, 4, makeCell(B.BEARING, facingState(NZ)));
    for (const [dx, dy] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]] as const) {
      sim.world.setCell(2 + dx, by + dy, 3, makeCell(B.CANVAS));
    }
    sim.worldGlue.add(2, by, 3, PZ); // hub <-> bearing
    sim.world.setCell(4, SEA_TOP, 8, makeCell(B.WOOL_RED));
    sim.world.setCell(3, SEA_TOP, 8, makeCell(B.GLASS));
    sim.worldGlue.add(4, SEA_TOP, 8, NY);
    sim.worldGlue.add(4, SEA_TOP, 8, NX);
    sim.advance(10);
    sim.emptyHand();
    expect(sim.useOn(2, by, 4, PX)).toBe(true);
    expect(sim.useOn(2, by, 4, PX)).toBe(true);
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor).toBeDefined();
    expect(sim.useOn(2, SEA_TOP, 7, PX)).toBe(true);
    expect(sim.useOn(2, SEA_TOP, 7, PX)).toBe(true);
    const ship = onlyShip(sim);
    expect(rotor.parent).toBe(ship);
    expect(sim.player.steeringShipId).toBe(ship.id);
    return { sim, ship, rotor, by };
  }

  it('船上的风车改挂到世界: a windmill running on the ship keeps running after docking, mounted on the world', () => {
    const { sim, ship, rotor, by } = windmillShip();
    steer(sim, 1, 0, 60);
    sim.advance(60);
    expect(rotor.angularSpeed).toBeGreaterThan(0);
    expect(ship.sails).toBe(9);
    const w0 = rotor.angularSpeed;
    const exp = expectedDock(ship);
    expect(exp.k).toBe(0);
    sneakClick(sim); // dock from the wheel
    expect(ship.removed).toBe(true);
    expect(sim.structures.ships().length).toBe(0);
    // the windmill is the same live structure, now hanging on the world
    expect(rotor.removed).toBe(false);
    expect(sim.structures.rotors().length).toBe(1);
    expect(sim.structures.rotors()[0]).toBe(rotor);
    expect(rotor.parent).toBeNull();
    expect(rotor.grid.parent).toBe(sim.world);
    // on the docked bearing, which faces where it faced on the ship
    const bearing = destOf(exp, 2, by, 4);
    expect([rotor.bearingX, rotor.bearingY, rotor.bearingZ]).toEqual([bearing.x, bearing.y, bearing.z]);
    expect(idAt(sim, bearing.x, bearing.y, bearing.z)).toBe(B.BEARING);
    expect(facingAt(sim, bearing.x, bearing.y, bearing.z)).toBe(NZ);
    const hub = rotor.grid.position;
    expect(hub.x).toBeCloseTo(bearing.x + 0.5, 6);
    expect(hub.y).toBeCloseTo(bearing.y + 0.5, 6);
    expect(hub.z).toBeCloseTo(bearing.z - 0.5, 6);
    // its sails did not become world blocks
    expect(countWorld(sim, B.CANVAS, bearing.x - 4, bearing.y - 4, bearing.z - 3, bearing.x + 4, bearing.y + 4, bearing.z + 1)).toBe(0);
    // still turning, at the same speed
    expect(rotor.angularSpeed).toBe(w0);
    const a0 = rotor.angle;
    sim.advance(20);
    expect(rotor.frozen).toBe(false);
    expect(angleAdvance(a0, rotor.angle)).toBeCloseTo(w0 * 1.0, 3); // 20 ticks = 1 s at the same speed
    expect(rotor.grid.position.x).toBeCloseTo(hub.x, 6);
    expect(rotor.grid.position.z).toBeCloseTo(hub.z, 6);
  });

  it('船上的风车改挂到世界: on a ship turned a quarter turn, the running windmill ends up on the rotated bearing, still turning', () => {
    const { sim, ship, rotor, by } = windmillShip();
    turnLeft(sim, ship, 75);
    const h = headingDeg(ship);
    expect(h).toBeGreaterThan(70);
    expect(h).toBeLessThan(110);
    expect(tiltDeg(ship)).toBeLessThan(10);
    expect(rotor.angularSpeed).toBeGreaterThan(0);
    const w0 = rotor.angularSpeed;
    const exp = expectedDock(ship);
    expect(exp.k).toBe(1);
    sneakClick(sim); // dock from the wheel
    expect(ship.removed).toBe(true);
    expect(rotor.removed).toBe(false);
    expect(rotor.parent).toBeNull();
    expect(rotor.grid.parent).toBe(sim.world);
    const bearing = destOf(exp, 2, by, 4);
    expect([rotor.bearingX, rotor.bearingY, rotor.bearingZ]).toEqual([bearing.x, bearing.y, bearing.z]);
    expect(idAt(sim, bearing.x, bearing.y, bearing.z)).toBe(B.BEARING);
    const facing = rotDirY(1, NZ); // north turned a quarter turn to port: west
    expect(facingAt(sim, bearing.x, bearing.y, bearing.z)).toBe(facing);
    // the hub sits right in front of the bearing, the sails around it in the plane across the axis
    const hub = rotor.grid.position;
    expect(hub.x).toBeCloseTo(bearing.x + 0.5 - 1, 6);
    expect(hub.y).toBeCloseTo(bearing.y + 0.5, 6);
    expect(hub.z).toBeCloseTo(bearing.z + 0.5, 6);
    const a0 = rotor.angle;
    sim.advance(20);
    expect(rotor.angularSpeed).toBe(w0);
    expect(angleAdvance(a0, rotor.angle)).toBeCloseTo(w0 * 1.0, 3);
    // every sail stays in the plane x = hub.x while it turns (the spin axis is the bearing's)
    rotor.grid.forEachCell((x, y, z) => {
      const c = rotor.grid.toWorld({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      expect(Math.abs(c.x - hub.x)).toBeLessThan(1e-6);
    });
  });

  it('再次组装时方块数和胶数都一致: the windmill ship assembled again has the same cell and glue counts (the windmill rides along)', () => {
    const { sim, ship, rotor } = windmillShip();
    steer(sim, 1, 0, 60);
    sim.advance(60);
    const n0 = ship.grid.count;
    const g0 = ship.glue.size;
    expect(n0).toBe(45 + 1 + 4 + 1 + 2); // deck, helm, mast, bearing, felt + glass (the canvas spins in the rotor)
    // felt-deck, felt-glass, and the hub-bearing face: it stays on the bearing (a glueable block
    // left behind) while the hub spins in the rotor.
    expect(g0).toBe(3);
    expect(ship.glue.has(2, SEA_TOP + 3, 4, NZ)).toBe(true);
    const exp = expectedDock(ship);
    sneakClick(sim);
    expect(ship.removed).toBe(true);
    const helm = destOf(exp, 2, SEA_TOP, 7);
    const back = rotDirY(exp.k, PZ);
    expect(sim.useOn(helm.x, helm.y, helm.z, back)).toBe(true);
    expect(sim.useOn(helm.x, helm.y, helm.z, back)).toBe(true);
    const again = onlyShip(sim);
    expect(again.grid.count).toBe(n0);
    expect(again.glue.size).toBe(g0);
    expect(rotor.removed).toBe(false);
    expect(rotor.parent).toBe(again);
  });
});

// ==================================================================== scenario 9

/**
 * The raft and pier scene in survival, with two sand blocks on the deck: a loose one at
 * (1, SEA_TOP, 1) and one at (3, SEA_TOP, 1) glued to the plank under it.
 */
function sandScene(): Simulation {
  const sim = raftScene({ mode: 'survival' });
  sim.world.setCell(1, SEA_TOP, 1, makeCell(B.SAND));
  sim.world.setCell(3, SEA_TOP, 1, makeCell(B.SAND));
  sim.worldGlue.add(3, SEA_TOP, 1, NY);
  sim.advance(5);
  // resting on the raft, the sand stays put
  expect(idAt(sim, 1, SEA_TOP, 1)).toBe(B.SAND);
  expect(fallingBlocks(sim)).toBe(0);
  return sim;
}

/** Sand blocks anywhere around the scene (sea floor included). */
function worldSand(sim: Simulation): string[] {
  return findWorld(sim, B.SAND, -6, SEA_FLOOR, -6, 10, SEA_TOP + 8, 12);
}

describe('9. 甲板上没粘的沙子在组装后会掉落；落到船上变成掉落物。', () => {
  it('甲板上没粘的沙子在组装后会掉落: the loose sand is not taken along and falls once the deck under it has gone; the glued sand rides along', () => {
    const sim = sandScene();
    const ship = assembleRaft(sim);
    // assembling took the glued sand, not the loose one
    expect(ship.grid.getCell(3, SEA_TOP, 1) & ID_MASK).toBe(B.SAND);
    expect(ship.grid.getCell(1, SEA_TOP, 1) & ID_MASK).toBe(B.AIR);
    expect(ship.grid.count).toBe(32);
    // the loose one is still in the world for a moment, then falls (it is not left hanging over the sea)
    expect(idAt(sim, 1, SEA_TOP, 1)).toBe(B.SAND);
    sim.advance(FALL_DELAY + 1);
    expect(idAt(sim, 1, SEA_TOP, 1)).not.toBe(B.SAND);
    sim.advance(40);
    expect(worldSand(sim)).toEqual([]);
    // the glued one stays on the ship
    expect(ship.grid.getCell(3, SEA_TOP, 1) & ID_MASK).toBe(B.SAND);
  });

  it('落到船上变成掉落物: the sand that falls onto the ship becomes an item drop lying on the deck — not a block, not a block hovering for ever', () => {
    const sim = sandScene();
    const ship = assembleRaft(sim);
    sim.advance(FALL_DELAY + 10);
    // landed within a few ticks: one sand item, no falling block left
    expect(fallingBlocks(sim)).toBe(0);
    let drops = itemDrops(sim, B.SAND);
    expect(drops.entities).toBe(1);
    expect(drops.count).toBe(1);
    // and it stays an item on the deck, carried by the ship
    sim.advance(200);
    drops = itemDrops(sim, B.SAND);
    expect(drops.entities).toBe(1);
    expect(drops.list[0]!.carrierId).toBe(ship.id);
    const deckTop = ship.grid.toWorld({ x: 1.5, y: SEA_TOP, z: 1.5 }).y;
    expect(Math.abs(drops.list[0]!.pos.y - deckTop)).toBeLessThan(0.2);
    expect(fallingBlocks(sim)).toBe(0);
    expect(worldSand(sim)).toEqual([]);
    expect(ship.grid.getCell(1, SEA_TOP, 1) & ID_MASK).toBe(B.AIR);
  });

  it('落到船上变成掉落物: sand dropped from six blocks up onto a floating ship becomes an item on its deck; sand dropped beside it lands as a block on the sea floor', () => {
    const sim = raftScene({ mode: 'survival' });
    // a rubble tower on the pier for the player, and two sand blocks resting on glass high above
    fill(sim, 1, SEA_TOP, 7, 1, SEA_TOP + 3, 7, B.COBBLE);
    sim.world.setCell(1, SEA_TOP + 5, 3, makeCell(B.GLASS));
    sim.world.setCell(1, SEA_TOP + 6, 3, makeCell(B.SAND)); // above the deck
    sim.world.setCell(-2, SEA_TOP + 5, 4, makeCell(B.GLASS));
    sim.world.setCell(-2, SEA_TOP + 6, 4, makeCell(B.SAND)); // above open water, west of the raft
    const ship = assembleRaft(sim);
    sim.advance(60); // floats, settles
    sim.teleport(1.5, SEA_TOP + 4, 7.5);
    sim.emptyHand();
    sim.advance(2);
    // the player breaks the glass under the sand over the deck
    expect(sim.mine(1, SEA_TOP + 5, 3, PZ)).toBe(true);
    for (let t = 0; t < 40; t++) sim.tick();
    expect(fallingBlocks(sim)).toBe(0);
    let drops = itemDrops(sim, B.SAND);
    expect(drops.entities).toBe(1);
    expect(drops.list[0]!.carrierId).toBe(ship.id);
    // nothing became a sand block, neither in the world nor on the ship
    expect(worldSand(sim)).toEqual([key(-2, SEA_TOP + 6, 4)]);
    let shipSand = 0;
    ship.grid.forEachCell((_x, _y, _z, c) => {
      if ((c & ID_MASK) === B.SAND) shipSand++;
    });
    expect(shipSand).toBe(0);
    // ...while sand that misses the ship falls through the sea and lands as a block on the floor
    expect(sim.mine(-2, SEA_TOP + 5, 4, PZ)).toBe(true);
    sim.advance(200);
    expect(fallingBlocks(sim)).toBe(0);
    expect(worldSand(sim)).toEqual([key(-2, SEA_FLOOR, 4)]);
    drops = itemDrops(sim, B.SAND);
    expect(drops.entities).toBe(1);
    expect(drops.list[0]!.carrierId).toBe(ship.id);
  });
});

// ==================================================================== 6 + 8 with glue: docking never glues a ship to a pier

describe('6、8 与胶：停靠不会把船和码头粘在一起（结构体移动不会产生新的胶连接）。', () => {
  /** Rubble or plank pier west of the raft: posts x -3..-2, z -1..1 up to the deck's top, and one block reaching east to (-1, SEA_TOP, 0). */
  function buildPier(sim: Simulation, id: number): number {
    fill(sim, -3, SEA_FLOOR, -1, -2, SEA_TOP, 1, id);
    sim.world.setCell(-1, SEA_TOP, 0, makeCell(id));
    return countWorld(sim, id, -4, SEA_FLOOR, -2, -1, SEA_TOP + 1, 2);
  }

  /** Where the raft's (0, SEA_TOP, 0) lands when it docks now: unmoved, unturned. */
  function expectDocksInPlace(ship: Ship): void {
    const exp = expectedDock(ship);
    expect(exp.k).toBe(0);
    expect(destOf(exp, 2, SEA_TOP, 4)).toEqual({ x: 2, y: SEA_TOP, z: 4 });
  }

  for (const [name, pierId] of [['rubble', B.COBBLE], ['plank', B.PLANKS_PINE]] as const) {
    it(`a raft carrying an open glued face docks with it against a ${name} pier: assembled again it has the same blocks, and the pier stays whole`, () => {
      const sim = raftScene({ glued: true, pier: false });
      // The player glues the felt's open west face, and leaves it open.
      sim.teleport(-2.5, SEA_TOP + 1, 0.5);
      sim.player.flying = true;
      sim.tick();
      sim.hold(I.GLUE);
      expect(sim.useOn(0, SEA_TOP, 0, NX)).toBe(true);
      expect(sim.worldGlue.has(0, SEA_TOP, 0, NX)).toBe(true);
      sim.teleport(2.5, SEA_TOP, 5.5);
      sim.player.flying = false;
      sim.advance(2);
      sim.emptyHand();
      const ship = assembleRaft(sim);
      expect(ship.grid.count).toBe(33);
      expect(ship.glue.size).toBe(3);
      expect(ship.glue.has(0, SEA_TOP, 0, NX)).toBe(true); // the open face rides along
      // Someone builds a pier beside the floating raft, touching the felt's glued face.
      const pierCells = buildPier(sim, pierId);
      sim.tick();
      expectDocksInPlace(ship);
      sneakClick(sim); // dock from the wheel
      expect(ship.removed).toBe(true);
      expect(idAt(sim, 0, SEA_TOP, 0)).toBe(B.WOOL_WHITE);
      expect(idAt(sim, -1, SEA_TOP, 0)).toBe(pierId);
      expect(sim.worldGlue.has(0, SEA_TOP, 0, NX)).toBe(false); // felt and pier are not joined
      expect(sim.worldGlue.size).toBe(2);
      // Assembled again at the helm: the same 33 blocks, none of the pier.
      const again = assembleRaft(sim);
      expect(again).not.toBe(ship);
      expect(again.grid.count).toBe(33);
      expect(again.glue.size).toBe(2);
      let pierInShip = 0;
      again.grid.forEachCell((_x, _y, _z, c) => {
        if ((c & ID_MASK) === pierId) pierInShip++;
      });
      expect(pierInShip).toBe(0);
      expect(countWorld(sim, pierId, -4, SEA_FLOOR, -2, -1, SEA_TOP + 1, 2)).toBe(pierCells);
    });
  }

  it('a pier block with an open glued face: a ship docks with a plank against it; the pier is not taken and the face has no glue', () => {
    const sim = raftScene({ pier: false });
    const pierCells = buildPier(sim, B.COBBLE); // its east end is diagonal to the deck corner: not touching the raft
    sim.advance(2);
    // The player glues the pier's open east face, over the raft's north-west corner.
    sim.teleport(1.5, SEA_TOP, 1.5);
    sim.advance(2);
    sim.hold(I.GLUE);
    expect(sim.useOn(-1, SEA_TOP, 0, PX)).toBe(true);
    expect(sim.worldGlue.has(-1, SEA_TOP, 0, PX)).toBe(true);
    sim.teleport(2.5, SEA_TOP, 5.5);
    sim.advance(2);
    sim.emptyHand();
    const ship = assembleRaft(sim);
    expect(ship.grid.count).toBe(31);
    expect(sim.worldGlue.has(-1, SEA_TOP, 0, PX)).toBe(true); // stays on the pier
    click(sim); // let go of the wheel
    // The player puts a plank on the ship's deck corner, right beside the glued pier face. It is a
    // ship block: the world's glue does not reach it.
    sim.teleport(1.5, SEA_TOP, 1.5);
    sim.advance(2);
    sim.hold(B.PLANKS_OAK);
    expect(sim.useOn(0, DECK, 0, PY, ship.id)).toBe(true);
    expect(ship.grid.getCell(0, SEA_TOP, 0) & ID_MASK).toBe(B.PLANKS_OAK);
    expect(ship.grid.count).toBe(32);
    sim.emptyHand();
    sim.teleport(2.5, SEA_TOP, 5.5);
    sim.advance(2);
    expectDocksInPlace(ship);
    sim.player.input.sneak = true;
    expect(sim.useOn(2, SEA_TOP, 4, PZ, ship.id)).toBe(true); // dock from the helm
    sim.player.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(idAt(sim, 0, SEA_TOP, 0)).toBe(B.PLANKS_OAK);
    expect(sim.worldGlue.has(-1, SEA_TOP, 0, PX)).toBe(false); // the pier's face, now against the plank
    expect(sim.worldGlue.size).toBe(0);
    const again = assembleRaft(sim);
    expect(again.grid.count).toBe(32);
    expect(again.grid.getCell(-1, SEA_TOP, 0)).toBe(0);
    expect(idAt(sim, -1, SEA_TOP, 0)).toBe(B.COBBLE);
    expect(countWorld(sim, B.COBBLE, -4, SEA_FLOOR, -2, -1, SEA_TOP + 1, 2)).toBe(pierCells);
  });
});
