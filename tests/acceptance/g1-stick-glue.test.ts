/**
 * Acceptance scenarios 1–5 (docs/ACCEPTANCE.md "连接与胶水"), headless, at the level of the
 * whole simulation. Which blocks belong together is proven through what the PLAYER gets when
 * assembling: right-click a helm (or a bearing) twice and compare both the highlighted preview
 * and the resulting structure's cells with the expected set. Glue is applied, removed and
 * timed through the player's clicks, looks and held buttons.
 *
 * Scene convention: flat world (turf top at y = T - 1), the player stands at (0.5, T, 0.5)
 * looking north unless a test says otherwise; scenes are built a few cells north of it.
 */
import { describe, expect, it } from 'vitest';
import { AIR, cellState, facingState, stateAxis } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import {
  T,
  Toasts,
  assembleShipByHand,
  hardnessTicks,
  idAt,
  labels,
  makeSim,
  measureMiningTicks,
  put,
  startRotorByHand,
  type CellSpec,
} from './g1-stick-glue-helpers';

const HELM_N = facingState(NZ);
const AXIS_X = 0;
const AXIS_Y = 1;
const AXIS_Z = 2;

function logCell(axis: number): number {
  return axis; // axisState(axis)
}

/** The helm of most scenes: on top of (0, T, -3), aimed at through its south face. */
const HX = 0;
const HY = T + 1;
const HZ = -3;

function helmAt(sim: Simulation, x = HX, y = HY, z = HZ): void {
  put(sim, x, y, z, B.HELM, HELM_N);
}

function expectWorld(sim: Simulation, cells: readonly CellSpec[]): void {
  for (const [x, y, z, id] of cells) expect(idAt(sim.world, x, y, z), `world cell ${x},${y},${z}`).toBe(id);
}

function expectWorldAir(sim: Simulation, cells: readonly CellSpec[]): void {
  for (const [x, y, z] of cells) expect(idAt(sim.world, x, y, z), `world cell ${x},${y},${z} was taken`).toBe(AIR);
}

// =====================================================================================
describe('1. 不同颜色的羊毛和帆布连成一体；木板连成一体；木板和羊毛不连；圆石和圆石不连；同种石砖相连。', () => {
  it('felt of every colour and canvas, in a row where each neighbour differs, is assembled as one body', () => {
    const sim = makeSim();
    const row = [
      B.WOOL_WHITE,
      B.WOOL_RED,
      B.WOOL_ORANGE,
      B.WOOL_YELLOW,
      B.CANVAS, // canvas between felt on both sides
      B.WOOL_GREEN,
      B.WOOL_BLUE,
      B.WOOL_PURPLE,
      B.WOOL_BLACK,
    ];
    const cloth: CellSpec[] = row.map((id, i) => [i, T, -3, id] as const);
    for (const [x, y, z, id] of cloth) put(sim, x, y, z, id);
    helmAt(sim); // on the white felt
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...cloth]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, cloth);
  });

  it('a windmill whose sails are felt of different colours and canvas starts as one rotor holding all of them', () => {
    const sim = makeSim('creative', { x: 0.5, y: T, z: -1.5 });
    for (let y = T; y <= T + 4; y++) put(sim, -1, y, -4, B.STONE_BRICKS); // tower
    put(sim, 0, T + 4, -4, B.BEARING, facingState(PX));
    const blades: CellSpec[] = [
      [1, T + 4, -4, B.CANVAS], // hub
      [1, T + 5, -4, B.WOOL_RED],
      [1, T + 6, -4, B.WOOL_BLUE],
      [1, T + 3, -4, B.WOOL_YELLOW],
      [1, T + 2, -4, B.WOOL_BLACK],
      [1, T + 4, -3, B.WOOL_GREEN],
      [1, T + 4, -5, B.WOOL_WHITE],
      [1, T + 4, -6, B.CANVAS],
    ];
    for (const [x, y, z, id] of blades) put(sim, x, y, z, id);
    const a = startRotorByHand(sim, 0, T + 4, -4);
    const expected = labels(blades);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expect(a.structure.sails).toBe(blades.length);
    expectWorldAir(sim, blades);
  });

  it('broadleaf and conifer planks join into one body', () => {
    const sim = makeSim();
    const planks: CellSpec[] = [
      [0, T, -3, B.PLANKS_OAK],
      [1, T, -3, B.PLANKS_PINE],
      [2, T, -3, B.PLANKS_OAK],
      [2, T, -4, B.PLANKS_PINE],
      [2, T + 1, -4, B.PLANKS_OAK],
    ];
    for (const [x, y, z, id] of planks) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, planks);
  });

  it('planks and felt do not join: felt and canvas touching the planks under the helm stay in the world', () => {
    const sim = makeSim();
    const planks: CellSpec[] = [
      [0, T, -3, B.PLANKS_OAK],
      [1, T, -3, B.PLANKS_PINE],
    ];
    const cloth: CellSpec[] = [
      [2, T, -3, B.WOOL_RED],
      [-1, T, -3, B.WOOL_WHITE],
      [0, T, -4, B.CANVAS],
      [1, T, -2, B.WOOL_BLUE],
      [1, T + 1, -3, B.WOOL_GREEN],
    ];
    for (const [x, y, z, id] of [...planks, ...cloth]) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, cloth);
  });

  it('felt and planks do not join the other way round either: planks touching the felt under the helm stay', () => {
    const sim = makeSim();
    const cloth: CellSpec[] = [
      [0, T, -3, B.WOOL_YELLOW],
      [1, T, -3, B.CANVAS],
    ];
    const planks: CellSpec[] = [
      [2, T, -3, B.PLANKS_OAK],
      [-1, T, -3, B.PLANKS_PINE],
      [0, T, -4, B.PLANKS_OAK],
      [1, T + 1, -3, B.PLANKS_PINE],
    ];
    for (const [x, y, z, id] of [...cloth, ...planks]) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...cloth]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, planks);
  });

  it('rubble does not join rubble: the helm takes the rubble block it stands on, not the rubble around it', () => {
    const sim = makeSim();
    const under: CellSpec = [0, T, -3, B.COBBLE];
    const around: CellSpec[] = [
      [1, T, -3, B.COBBLE],
      [-1, T, -3, B.COBBLE],
      [0, T, -4, B.COBBLE],
      [0, T, -2, B.COBBLE],
    ];
    for (const [x, y, z, id] of [under, ...around]) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], under]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, around);
  });

  it('stone bricks join stone bricks', () => {
    const sim = makeSim();
    const bricks: CellSpec[] = [
      [0, T, -3, B.STONE_BRICKS],
      [1, T, -3, B.STONE_BRICKS],
      [2, T, -3, B.STONE_BRICKS],
      [2, T + 1, -3, B.STONE_BRICKS],
      [2, T + 1, -4, B.STONE_BRICKS],
    ];
    for (const [x, y, z, id] of bricks) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...bricks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, bricks);
  });

  it('only the same kind: red bricks, sandstone and glass touching the stone bricks stay in the world', () => {
    const sim = makeSim();
    const bricks: CellSpec[] = [
      [0, T, -3, B.STONE_BRICKS],
      [1, T, -3, B.STONE_BRICKS],
    ];
    const others: CellSpec[] = [
      [2, T, -3, B.BRICKS],
      [-1, T, -3, B.SANDSTONE],
      [1, T, -4, B.GLASS],
      [1, T + 1, -3, B.BRICKS],
    ];
    for (const [x, y, z, id] of [...bricks, ...others]) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...bricks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, others);
  });
});

// =====================================================================================
describe('2. 竖原木上下相连、左右不连；横原木只沿自身轴向相连；点方块侧面放原木得到横原木。', () => {
  it('upright logs stacked on top of each other join', () => {
    const sim = makeSim();
    const trunk: CellSpec[] = [
      [0, T, -3, B.LOG_OAK],
      [0, T + 1, -3, B.LOG_OAK],
      [0, T + 2, -3, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of trunk) put(sim, x, y, z, id, logCell(AXIS_Y));
    helmAt(sim, 0, T + 3, -3);
    const a = assembleShipByHand(sim, 0, T + 3, -3);
    const expected = labels([[0, T + 3, -3, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, trunk);
  });

  it('upright logs side by side do not join', () => {
    const sim = makeSim();
    const under: CellSpec = [0, T, -3, B.LOG_OAK];
    const beside: CellSpec[] = [
      [1, T, -3, B.LOG_OAK],
      [-1, T, -3, B.LOG_OAK],
      [0, T, -4, B.LOG_OAK],
      [0, T, -2, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of [under, ...beside]) put(sim, x, y, z, id, logCell(AXIS_Y));
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], under]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, beside);
  });

  it('a log lying east-west joins the logs lying in line with it along x', () => {
    const sim = makeSim();
    const trunk: CellSpec[] = [
      [-1, T, -3, B.LOG_OAK],
      [0, T, -3, B.LOG_OAK],
      [1, T, -3, B.LOG_OAK],
      [2, T, -3, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of trunk) put(sim, x, y, z, id, logCell(AXIS_X));
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, trunk);
  });

  it('a log lying north-south joins along z, but not the north-south logs lying beside it', () => {
    const sim = makeSim();
    const trunk: CellSpec[] = [
      [0, T, -3, B.LOG_PINE],
      [0, T, -4, B.LOG_PINE],
      [0, T, -5, B.LOG_PINE],
    ];
    const beside: CellSpec[] = [
      [1, T, -4, B.LOG_PINE],
      [-1, T, -5, B.LOG_PINE],
    ];
    for (const [x, y, z, id] of [...trunk, ...beside]) put(sim, x, y, z, id, logCell(AXIS_Z));
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, beside);
  });

  it('a lying log joins only along its own axis: not logs beside, above or below it, nor logs lying another way', () => {
    const sim = makeSim();
    // East-west trunk raised one row, helm on its west end.
    const trunk: CellSpec[] = [
      [0, T + 1, -3, B.LOG_OAK],
      [1, T + 1, -3, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of trunk) put(sim, x, y, z, id, logCell(AXIS_X));
    const sameAxisOffLine: CellSpec[] = [
      [1, T + 1, -4, B.LOG_OAK], // beside (north)
      [1, T, -3, B.LOG_OAK], // below
      [1, T + 2, -3, B.LOG_OAK], // above
    ];
    for (const [x, y, z, id] of sameAxisOffLine) put(sim, x, y, z, id, logCell(AXIS_X));
    put(sim, 2, T + 1, -3, B.LOG_OAK, logCell(AXIS_Z)); // in line, but lying north-south
    put(sim, -1, T + 1, -3, B.LOG_OAK, logCell(AXIS_Y)); // in line, but upright
    put(sim, 0, T + 1, -4, B.LOG_PINE, logCell(AXIS_Z)); // another kind beside, lying the other way
    helmAt(sim, 0, T + 2, -3);
    const a = assembleShipByHand(sim, 0, T + 2, -3);
    const expected = labels([[0, T + 2, -3, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [
      ...sameAxisOffLine,
      [2, T + 1, -3, B.LOG_OAK],
      [-1, T + 1, -3, B.LOG_OAK],
      [0, T + 1, -4, B.LOG_PINE],
    ]);
  });

  it('a lying log does not join a log of another kind lying in line with it (one trunk = one kind)', () => {
    const sim = makeSim();
    put(sim, 0, T, -3, B.LOG_OAK, logCell(AXIS_X));
    put(sim, 1, T, -3, B.LOG_PINE, logCell(AXIS_X));
    put(sim, -1, T, -3, B.LOG_PINE, logCell(AXIS_X));
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([
      [HX, HY, HZ, B.HELM],
      [0, T, -3, B.LOG_OAK],
    ]);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [
      [1, T, -3, B.LOG_PINE],
      [-1, T, -3, B.LOG_PINE],
    ]);
  });

  it('the player clicking the side face of a block places a lying log (along that face\'s axis); the top face an upright one', () => {
    const sim = makeSim();
    put(sim, 0, T, -3, B.STONE);
    put(sim, -3, T, -3, B.STONE);
    sim.hold(B.LOG_OAK);

    expect(sim.useOn(0, T, -3, PZ)).toBe(true); // south side face
    expect(idAt(sim.world, 0, T, -2)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T, -2)))).toBe(AXIS_Z);

    expect(sim.useOn(-3, T, -3, PX)).toBe(true); // east side face
    expect(idAt(sim.world, -2, T, -3)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(-2, T, -3)))).toBe(AXIS_X);

    expect(sim.useOn(0, T, -3, PY)).toBe(true); // top face
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T + 1, -3)))).toBe(AXIS_Y);
  });

  it('logs the player lays against side faces form a lying trunk that a helm on it assembles; an upright log in line stays', () => {
    const sim = makeSim('creative', { x: 4.5, y: T, z: -1.5 });
    put(sim, 0, T, -3, B.STONE);
    sim.hold(B.LOG_OAK);
    expect(sim.useOn(0, T, -3, PX)).toBe(true); // east face of the stone -> log at (1, T, -3)
    expect(sim.useOn(1, T, -3, PX)).toBe(true); // east face of that log -> log at (2, T, -3)
    expect(stateAxis(cellState(sim.world.getCell(1, T, -3)))).toBe(AXIS_X);
    expect(stateAxis(cellState(sim.world.getCell(2, T, -3)))).toBe(AXIS_X);
    sim.hold(B.HELM);
    expect(sim.useOn(1, T, -3, PY)).toBe(true); // the helm on top of the first log
    expect(idAt(sim.world, 1, T + 1, -3)).toBe(B.HELM);
    sim.hold(B.LOG_OAK);
    expect(sim.useOn(3, T - 1, -3, PY)).toBe(true); // top face of the ground -> upright log at (3, T, -3)
    expect(stateAxis(cellState(sim.world.getCell(3, T, -3)))).toBe(AXIS_Y);

    const a = assembleShipByHand(sim, 1, T + 1, -3, PX);
    const expected = labels([
      [1, T + 1, -3, B.HELM],
      [1, T, -3, B.LOG_OAK],
      [2, T, -3, B.LOG_OAK],
    ]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [
      [0, T, -3, B.STONE],
      [3, T, -3, B.LOG_OAK],
    ]);
  });
});

// =====================================================================================
describe('3. 舵轮和它下方的圆石相连；轴承和背面的方块相连，正面不连；基岩不能被连入结构体。', () => {
  it('a helm the player puts on a rubble block is assembled together with that rubble block', () => {
    const sim = makeSim();
    put(sim, 0, T, -3, B.COBBLE);
    sim.hold(B.HELM);
    expect(sim.useOn(0, T, -3, PY)).toBe(true);
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.HELM);
    const a = assembleShipByHand(sim, 0, T + 1, -3);
    const expected = labels([
      [0, T + 1, -3, B.HELM],
      [0, T, -3, B.COBBLE],
    ]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, [[0, T, -3, B.COBBLE]]);
  });

  it('the helm sticks only to the block below it: rubble beside it or on top of it stays', () => {
    const sim = makeSim();
    put(sim, 0, T, -3, B.COBBLE);
    const notBelow: CellSpec[] = [
      [1, T + 1, -3, B.COBBLE],
      [-1, T + 1, -3, B.COBBLE],
      [0, T + 1, -4, B.COBBLE],
      [0, T + 2, -3, B.COBBLE],
    ];
    for (const [x, y, z, id] of notBelow) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([
      [HX, HY, HZ, B.HELM],
      [0, T, -3, B.COBBLE],
    ]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, notBelow);
  });

  /** A 3x3 plank raft (x 0..2, z -5..-3) on the ground, helm on its south-middle plank. */
  function raft(sim: Simulation): CellSpec[] {
    const planks: CellSpec[] = [];
    for (let z = -5; z <= -3; z++) for (let x = 0; x <= 2; x++) planks.push([x, T, z, B.PLANKS_OAK]);
    for (const [x, y, z, id] of planks) put(sim, x, y, z, id);
    helmAt(sim, 1, T + 1, -3);
    return planks;
  }

  it('a bearing the player mounts on the side of the raft (its back on a plank) is part of the ship', () => {
    const sim = makeSim('creative', { x: 4.5, y: T, z: -0.5 });
    const planks = raft(sim);
    sim.hold(B.BEARING);
    expect(sim.useOn(2, T, -4, PX)).toBe(true); // east face of a raft plank
    expect(idAt(sim.world, 3, T, -4)).toBe(B.BEARING);
    const a = assembleShipByHand(sim, 1, T + 1, -3);
    const expected = labels([[1, T + 1, -3, B.HELM], [3, T, -4, B.BEARING], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, [[3, T, -4, B.BEARING]]);
  });

  it('the front of a bearing does not stick: a bearing facing the raft stays, and so does the block in front of the ship\'s bearing', () => {
    const sim = makeSim();
    const planks = raft(sim);
    put(sim, 3, T, -4, B.BEARING, facingState(PX)); // back on the raft
    put(sim, 4, T, -4, B.PLANKS_OAK); // in front of it (where a rotor's hub would be)
    put(sim, -1, T, -4, B.BEARING, facingState(PX)); // its FRONT against the raft, its back on air
    put(sim, 1, T, -6, B.BEARING, facingState(PZ)); // front against the raft from the north
    put(sim, 1, T + 1, -7, B.CANVAS); // (unrelated decoration nowhere near the raft)
    const a = assembleShipByHand(sim, 1, T + 1, -3);
    const expected = labels([[1, T + 1, -3, B.HELM], [3, T, -4, B.BEARING], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [
      [4, T, -4, B.PLANKS_OAK],
      [-1, T, -4, B.BEARING],
      [1, T, -6, B.BEARING],
    ]);
  });

  it('deeprock under a helm is not taken: the ship is the helm alone', () => {
    const sim = makeSim();
    put(sim, 0, T, -3, B.DEEPROCK);
    helmAt(sim);
    const a = assembleShipByHand(sim, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM]]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [[0, T, -3, B.DEEPROCK]]);
  });

  it('deeprock cannot be glued to a raft, and even glue forced onto its face does not pull it into the ship', () => {
    const sim = makeSim();
    const toasts = new Toasts(sim);
    const planks: CellSpec[] = [];
    for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) planks.push([x, T, z, B.PLANKS_OAK]);
    for (const [x, y, z, id] of planks) put(sim, x, y, z, id);
    helmAt(sim, 1, T + 1, -3);
    put(sim, 3, T, -3, B.DEEPROCK);
    // The player tries to glue it on.
    sim.hold(I.GLUE);
    expect(sim.useOn(2, T, -3, PZ)).toBe(true);
    expect(sim.useOn(3, T, -3, PZ)).toBe(true);
    expect(toasts.keys()).toContain('toast.glue.cannot');
    expect(sim.worldGlue.size).toBe(0);
    // Glue written straight into the store (as a corrupt save might) changes nothing either.
    sim.worldGlue.add(2, T, -3, PX);
    const a = assembleShipByHand(sim, 1, T + 1, -3);
    const expected = labels([[1, T + 1, -3, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [[3, T, -3, B.DEEPROCK]]);
  });

  it('a bearing with deeprock in front has nothing to turn: no rotor starts, even with sails glued to the deeprock', () => {
    const sim = makeSim('creative', { x: 0.5, y: T, z: -1.5 });
    const toasts = new Toasts(sim);
    for (let y = T; y <= T + 4; y++) put(sim, -1, y, -4, B.STONE_BRICKS);
    put(sim, 0, T + 4, -4, B.BEARING, facingState(PX));
    put(sim, 1, T + 4, -4, B.DEEPROCK); // the hub cell
    const sails: Array<[number, number, number, Dir]> = [
      [1, T + 5, -4, 3 /* NY: towards the deeprock */],
      [1, T + 3, -4, PY],
      [1, T + 4, -3, NZ],
      [1, T + 4, -5, PZ],
    ];
    for (const [x, y, z, d] of sails) {
      put(sim, x, y, z, B.CANVAS);
      sim.worldGlue.add(x, y, z, d); // forced: the player could not do this
    }
    sim.emptyHand();
    expect(sim.useOn(0, T + 4, -4, PZ)).toBe(true);
    expect(sim.useOn(0, T + 4, -4, PZ)).toBe(true);
    expect(toasts.keys()).toContain('fail.rotor.no_hub');
    expect(sim.structures.rotors().length).toBe(0);
    expect(sim.view.preview).toBeNull();
    expectWorld(sim, [
      [1, T + 4, -4, B.DEEPROCK],
      ...sails.map(([x, y, z]) => [x, y, z, B.CANVAS] as const),
    ]);
  });
});

// =====================================================================================
describe('4. 两次右键涂胶、潜行两次右键拆胶；挖掉任一侧方块，胶消失。', () => {
  const Y = T + 1;
  /** Two stone blocks side by side at eye level, A west of B (stone never sticks by itself). */
  function pair(sim: Simulation): void {
    put(sim, 0, Y, -2, B.STONE); // A
    put(sim, 1, Y, -2, B.STONE); // B
  }
  function glueAB(sim: Simulation): void {
    expect(sim.useOn(0, Y, -2, PZ)).toBe(true);
    expect(sim.useOn(1, Y, -2, PZ)).toBe(true);
  }

  it('with glue in hand, a right-click on block A and one on the adjacent block B glue the face between them', () => {
    const sim = makeSim();
    const toasts = new Toasts(sim);
    pair(sim);
    sim.hold(I.GLUE);
    expect(sim.useOn(0, Y, -2, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(0); // one click is not enough
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: 0, y: Y, z: -2 });
    expect(sim.useOn(1, Y, -2, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.worldGlue.has(1, Y, -2, NX)).toBe(true); // the same face seen from B
    expect(sim.worldGlue.size).toBe(1);
    expect(toasts.keys()).toContain('toast.glue.added');
    expect(sim.view.glueAnchor).toBeNull();
  });

  it('glue made with two right-clicks holds: a stone glued to the raft goes with the ship', () => {
    const sim = makeSim();
    for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) put(sim, x, T, z, B.PLANKS_OAK);
    helmAt(sim, 1, T + 1, -3);
    put(sim, 3, T, -3, B.STONE);
    sim.hold(I.GLUE);
    expect(sim.useOn(2, T, -3, PZ)).toBe(true);
    expect(sim.useOn(3, T, -3, PZ)).toBe(true);
    expect(sim.worldGlue.has(2, T, -3, PX)).toBe(true);
    const a = assembleShipByHand(sim, 1, T + 1, -3);
    expect(a.cells).toContain(`3,${T},-3:stone`);
    expect(a.structure.glue.has(2, T, -3, PX)).toBe(true);
    expect(idAt(sim.world, 3, T, -3)).toBe(AIR);
  });

  it('sneak + right-click A, sneak + right-click B removes that glue', () => {
    const sim = makeSim();
    const toasts = new Toasts(sim);
    pair(sim);
    sim.hold(I.GLUE);
    glueAB(sim);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.view.glueAnchor).toBeNull();
    sim.player.input.sneak = true;
    expect(sim.useOn(0, Y, -2, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true); // the first sneak click only picks A
    expect(sim.useOn(1, Y, -2, PZ)).toBe(true);
    sim.player.input.sneak = false;
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(0);
    expect(toasts.keys()).toContain('toast.glue.removed');
  });

  it('the same two right-clicks without sneaking do not remove the glue', () => {
    const sim = makeSim();
    const toasts = new Toasts(sim);
    pair(sim);
    sim.hold(I.GLUE);
    glueAB(sim);
    glueAB(sim);
    expect(toasts.keys()).toContain('toast.glue.already');
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('a stone unglued again with sneak + two right-clicks no longer goes with the ship', () => {
    const sim = makeSim();
    for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) put(sim, x, T, z, B.PLANKS_OAK);
    helmAt(sim, 1, T + 1, -3);
    put(sim, 3, T, -3, B.STONE);
    sim.hold(I.GLUE);
    expect(sim.useOn(2, T, -3, PZ)).toBe(true);
    expect(sim.useOn(3, T, -3, PZ)).toBe(true);
    sim.player.input.sneak = true;
    expect(sim.useOn(2, T, -3, PZ)).toBe(true);
    expect(sim.useOn(3, T, -3, PZ)).toBe(true);
    sim.player.input.sneak = false;
    expect(sim.worldGlue.size).toBe(0);
    const a = assembleShipByHand(sim, 1, T + 1, -3);
    expect(a.cells).not.toContain(`3,${T},-3:stone`);
    expect(idAt(sim.world, 3, T, -3)).toBe(B.STONE);
  });

  /** A-B glued, plus an unrelated glued pair C-D (C on the ground west of A, D behind C). */
  function twoGluedPairs(sim: Simulation): void {
    pair(sim);
    put(sim, -1, T, -2, B.STONE); // C
    put(sim, -1, T, -3, B.STONE); // D
    sim.hold(I.GLUE);
    glueAB(sim);
    expect(sim.useOn(-1, T, -2, PZ)).toBe(true);
    expect(sim.useOn(-1, T, -3, PY)).toBe(true);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.worldGlue.has(-1, T, -2, NZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
  }

  it('mining block A (one side of the face) makes that glue disappear; other glue stays', () => {
    const sim = makeSim();
    twoGluedPairs(sim);
    expect(sim.mine(0, Y, -2, PZ)).toBe(true);
    expect(idAt(sim.world, 0, Y, -2)).toBe(AIR);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
    expect(sim.worldGlue.has(-1, T, -2, NZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('mining block B (the other side) makes that glue disappear too; other glue stays', () => {
    const sim = makeSim();
    twoGluedPairs(sim);
    expect(sim.mine(1, Y, -2, PZ)).toBe(true);
    expect(idAt(sim.world, 1, Y, -2)).toBe(AIR);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
    expect(sim.worldGlue.has(-1, T, -2, NZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('a block put back where the mined one was is not glued (the glue went with the block)', () => {
    const sim = makeSim();
    twoGluedPairs(sim);
    put(sim, 1, Y, -3, B.STONE); // behind B, to build against
    expect(sim.mine(1, Y, -2, PZ)).toBe(true);
    sim.hold(B.STONE);
    expect(sim.useOn(1, Y, -3, PZ)).toBe(true); // a new stone at (1, Y, -2)
    expect(idAt(sim.world, 1, Y, -2)).toBe(B.STONE);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
  });
});

// =====================================================================================
describe('5. 生存模式：涂胶耗时等于两块中较慢的挖掘时间；中途移开视线会取消；完成后消耗 1 个胶。创造模式瞬间完成。', () => {
  const Y = T + 1;
  const A: readonly [number, number, number] = [0, Y, -2];
  const Bc: readonly [number, number, number] = [1, Y, -2];

  /**
   * The player picks A (one right-click), then right-clicks B and keeps the button held while
   * looking at it. Returns the number of ticks — the click's tick counted as the first — after
   * which the A-B face is glued, or -1 if it is not glued within maxTicks.
   */
  function holdGlueOnB(sim: Simulation, maxTicks: number): number {
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: A[0], y: A[1], z: A[2] });
    const input = sim.player.input;
    input.use = true;
    try {
      expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true);
      for (let n = 1; n <= maxTicks; n++) {
        if (sim.worldGlue.has(A[0], A[1], A[2], PX)) return n;
        sim.tick();
      }
      return -1;
    } finally {
      input.use = false;
    }
  }

  /** Mining time (ticks) of each block, measured by the player on copies of them. */
  function miningTicksOf(sim: Simulation, a: number, b: number): [number, number] {
    put(sim, -2, Y, -2, a);
    put(sim, -3, Y, -2, b);
    const ta = measureMiningTicks(sim, -2, Y, -2, PZ);
    const tb = measureMiningTicks(sim, -3, Y, -2, PZ);
    sim.advance(10); // let the break cooldown pass and the drops settle
    return [ta, tb];
  }

  for (const [a, b, slower] of [
    [B.PLANKS_OAK, B.GLASS, 'A'], // planks 1.5 s, glass 0.3 s
    [B.WOOL_WHITE, B.BRICKS, 'B'], // felt 0.8 s, red bricks 2 s
  ] as const) {
    it(`gluing ${slower === 'A' ? 'slow A to fast B' : 'fast A to slow B'} takes exactly the slower block's mining time`, () => {
      const sim = makeSim('survival');
      const [ta, tb] = miningTicksOf(sim, a, b);
      expect(ta).toBe(hardnessTicks(a));
      expect(tb).toBe(hardnessTicks(b));
      const expected = Math.max(hardnessTicks(a), hardnessTicks(b));
      expect(expected).toBe(slower === 'A' ? ta : tb);
      put(sim, A[0], A[1], A[2], a);
      put(sim, Bc[0], Bc[1], Bc[2], b);
      sim.hold(I.GLUE, 5);
      const n = holdGlueOnB(sim, expected + 40);
      expect(n).toBe(Math.max(ta, tb));
      expect(n).toBe(expected);
    });
  }

  it('while the button is held the face is not glued yet and no glue is used; the hint says it is working', () => {
    const sim = makeSim('survival');
    put(sim, A[0], A[1], A[2], B.IRON_BLOCK); // 5 s
    put(sim, Bc[0], Bc[1], Bc[2], B.STONE);
    sim.hold(I.GLUE, 3);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    sim.player.input.use = true;
    expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true);
    sim.advance(hardnessTicks(B.IRON_BLOCK) - 2);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(3);
    expect(sim.view.hint?.key).toBe('hint.glue.working');
    expect(sim.view.glueProgress).toBeCloseTo((hardnessTicks(B.IRON_BLOCK) - 1) / hardnessTicks(B.IRON_BLOCK), 5);
    sim.player.input.use = false;
  });

  it('looking away from B part-way (at the sky) cancels: no glue, no glue used, and holding on afterwards does not finish it', () => {
    const sim = makeSim('survival');
    put(sim, A[0], A[1], A[2], B.STONE); // 1.5 s
    put(sim, Bc[0], Bc[1], Bc[2], B.STONE);
    sim.hold(I.GLUE, 3);
    const total = hardnessTicks(B.STONE);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    const input = sim.player.input;
    input.use = true;
    expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true);
    sim.advance(total - 5); // most of the way
    expect(sim.view.glueProgress).toBeGreaterThan(0.5);
    sim.lookAt(1.5, Y + 30, -2.5); // up at the sky, button still held
    sim.tick();
    expect(sim.view.glueProgress).toBe(0);
    sim.lookAtCell(Bc[0], Bc[1], Bc[2], PZ); // back on B, still holding
    sim.advance(3 * total);
    input.use = false;
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(3);
  });

  it('looking away from B at another block part-way also cancels', () => {
    const sim = makeSim('survival');
    put(sim, A[0], A[1], A[2], B.STONE);
    put(sim, Bc[0], Bc[1], Bc[2], B.STONE);
    sim.hold(I.GLUE, 3);
    const total = hardnessTicks(B.STONE);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    const input = sim.player.input;
    input.use = true;
    expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true);
    sim.advance(total - 5);
    sim.lookAtCell(A[0], A[1], A[2], PZ); // the view slides over to A
    sim.advance(2);
    sim.lookAtCell(Bc[0], Bc[1], Bc[2], PZ);
    sim.advance(3 * total);
    input.use = false;
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(3);
  });

  it('completing the step uses up exactly one glue, at the moment the face is glued', () => {
    const sim = makeSim('survival');
    put(sim, A[0], A[1], A[2], B.PLANKS_OAK);
    put(sim, Bc[0], Bc[1], Bc[2], B.PLANKS_PINE);
    sim.hold(I.GLUE, 3);
    const total = hardnessTicks(B.PLANKS_OAK);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    const input = sim.player.input;
    input.use = true;
    expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true);
    sim.advance(total - 2);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(3);
    sim.tick();
    expect(sim.worldGlue.has(A[0], A[1], A[2], PX)).toBe(true);
    expect(sim.player.inventory.count(I.GLUE)).toBe(2);
    sim.advance(20); // still holding: nothing more happens
    input.use = false;
    expect(sim.player.inventory.count(I.GLUE)).toBe(2);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('creative: the second right-click glues at once, even between the hardest blocks, and uses no glue', () => {
    const sim = makeSim('creative');
    put(sim, A[0], A[1], A[2], B.IRON_BLOCK); // 5 s each in survival
    put(sim, Bc[0], Bc[1], Bc[2], B.IRON_BLOCK);
    put(sim, A[0], A[1] + 1, A[2], B.IRON_BLOCK); // C, on top of A
    sim.hold(I.GLUE, 1);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    expect(sim.useOn(Bc[0], Bc[1], Bc[2], PZ)).toBe(true); // one tick, button not held
    expect(sim.worldGlue.has(A[0], A[1], A[2], PX)).toBe(true);
    expect(sim.view.glueProgress).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(1);
    expect(sim.useOn(A[0], A[1], A[2], PZ)).toBe(true);
    expect(sim.useOn(A[0], A[1] + 1, A[2], PZ)).toBe(true);
    expect(sim.worldGlue.has(A[0], A[1], A[2], PY)).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
    expect(sim.player.inventory.count(I.GLUE)).toBe(1);
  });
});
