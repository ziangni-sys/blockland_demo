/**
 * Acceptance scenarios 1–3 (docs/ACCEPTANCE.md "连接与胶水"), headless, at the level of the
 * whole simulation. Which blocks belong together is proven through what the PLAYER gets when
 * assembling: right-click a helm (or a bearing) twice and compare both the highlighted preview
 * and the resulting structure's cells with the expected set. (Scenarios 4 and 5 were replaced
 * by 25–29, tests/acceptance/g7-glue-offhand.test.ts.)
 *
 * Scene convention: flat world (turf top at y = T - 1), the player stands at (0.5, T, 0.5)
 * looking north unless a test says otherwise; scenes are built a few cells north of it.
 */
import { describe, expect, it } from 'vitest';
import { AIR, cellState, facingState, stateAxis } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import type { Simulation } from '../../src/sim/simulation';
import {
  SEA_TOP,
  T,
  Toasts,
  assembleShipByHand,
  idAt,
  labels,
  makeSeaWorld,
  makeWorld,
  put,
  raftShipByHand,
  startRotorByHand,
  structureLabels,
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
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...cloth]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, cloth);
  });

  it('a windmill whose sails are felt of different colours and canvas starts as one rotor holding all of them', () => {
    const w = makeWorld('creative', { x: 0.5, y: T, z: -1.5 });
    const { sim, me } = w;
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
    const a = startRotorByHand(w, 0, T + 4, -4);
    const expected = labels(blades);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expect(a.structure.sails).toBe(blades.length);
    expectWorldAir(sim, blades);
  });

  it('broadleaf and conifer planks join into one body', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const planks: CellSpec[] = [
      [0, T, -3, B.PLANKS_OAK],
      [1, T, -3, B.PLANKS_PINE],
      [2, T, -3, B.PLANKS_OAK],
      [2, T, -4, B.PLANKS_PINE],
      [2, T + 1, -4, B.PLANKS_OAK],
    ];
    for (const [x, y, z, id] of planks) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, planks);
  });

  it('planks and felt do not join: felt and canvas touching the planks under the helm stay in the world', () => {
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, cloth);
  });

  it('felt and planks do not join the other way round either: planks touching the felt under the helm stay', () => {
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...cloth]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, planks);
  });

  it('rubble does not join rubble: the helm takes the rubble block it stands on, not the rubble around it', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const under: CellSpec = [0, T, -3, B.COBBLE];
    const around: CellSpec[] = [
      [1, T, -3, B.COBBLE],
      [-1, T, -3, B.COBBLE],
      [0, T, -4, B.COBBLE],
      [0, T, -2, B.COBBLE],
    ];
    for (const [x, y, z, id] of [under, ...around]) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], under]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, around);
  });

  it('stone bricks join stone bricks', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const bricks: CellSpec[] = [
      [0, T, -3, B.STONE_BRICKS],
      [1, T, -3, B.STONE_BRICKS],
      [2, T, -3, B.STONE_BRICKS],
      [2, T + 1, -3, B.STONE_BRICKS],
      [2, T + 1, -4, B.STONE_BRICKS],
    ];
    for (const [x, y, z, id] of bricks) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...bricks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, bricks);
  });

  it('only the same kind: red bricks, sandstone and glass touching the stone bricks stay in the world', () => {
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...bricks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, others);
  });
});

// =====================================================================================
describe('2. 竖原木上下相连、左右不连；横原木只沿自身轴向相连；点方块侧面放原木得到横原木。', () => {
  it('upright logs stacked on top of each other join', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const trunk: CellSpec[] = [
      [0, T, -3, B.LOG_OAK],
      [0, T + 1, -3, B.LOG_OAK],
      [0, T + 2, -3, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of trunk) put(sim, x, y, z, id, logCell(AXIS_Y));
    helmAt(sim, 0, T + 3, -3);
    const a = assembleShipByHand(w, 0, T + 3, -3);
    const expected = labels([[0, T + 3, -3, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, trunk);
  });

  it('upright logs side by side do not join', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const under: CellSpec = [0, T, -3, B.LOG_OAK];
    const beside: CellSpec[] = [
      [1, T, -3, B.LOG_OAK],
      [-1, T, -3, B.LOG_OAK],
      [0, T, -4, B.LOG_OAK],
      [0, T, -2, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of [under, ...beside]) put(sim, x, y, z, id, logCell(AXIS_Y));
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], under]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, beside);
  });

  it('a log lying east-west joins the logs lying in line with it along x', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const trunk: CellSpec[] = [
      [-1, T, -3, B.LOG_OAK],
      [0, T, -3, B.LOG_OAK],
      [1, T, -3, B.LOG_OAK],
      [2, T, -3, B.LOG_OAK],
    ];
    for (const [x, y, z, id] of trunk) put(sim, x, y, z, id, logCell(AXIS_X));
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, trunk);
  });

  it('a log lying north-south joins along z, but not the north-south logs lying beside it', () => {
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM], ...trunk]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, beside);
  });

  it('a lying log joins only along its own axis: not logs beside, above or below it, nor logs lying another way', () => {
    const w = makeWorld();
    const { sim, me } = w;
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
    const a = assembleShipByHand(w, 0, T + 2, -3);
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
    const w = makeWorld();
    const { sim, me } = w;
    put(sim, 0, T, -3, B.LOG_OAK, logCell(AXIS_X));
    put(sim, 1, T, -3, B.LOG_PINE, logCell(AXIS_X));
    put(sim, -1, T, -3, B.LOG_PINE, logCell(AXIS_X));
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
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
    const w = makeWorld();
    const { sim, me } = w;
    put(sim, 0, T, -3, B.STONE);
    put(sim, -3, T, -3, B.STONE);
    me.hold(B.LOG_OAK);

    expect(me.useOn(0, T, -3, PZ)).toBe(true); // south side face
    expect(idAt(sim.world, 0, T, -2)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T, -2)))).toBe(AXIS_Z);

    expect(me.useOn(-3, T, -3, PX)).toBe(true); // east side face
    expect(idAt(sim.world, -2, T, -3)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(-2, T, -3)))).toBe(AXIS_X);

    expect(me.useOn(0, T, -3, PY)).toBe(true); // top face
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.LOG_OAK);
    expect(stateAxis(cellState(sim.world.getCell(0, T + 1, -3)))).toBe(AXIS_Y);
  });

  it('logs the player lays against side faces form a lying trunk that a helm on it assembles; an upright log in line stays', () => {
    const w = makeWorld('creative', { x: 4.5, y: T, z: -1.5 });
    const { sim, me } = w;
    put(sim, 0, T, -3, B.STONE);
    me.hold(B.LOG_OAK);
    expect(me.useOn(0, T, -3, PX)).toBe(true); // east face of the stone -> log at (1, T, -3)
    expect(me.useOn(1, T, -3, PX)).toBe(true); // east face of that log -> log at (2, T, -3)
    expect(stateAxis(cellState(sim.world.getCell(1, T, -3)))).toBe(AXIS_X);
    expect(stateAxis(cellState(sim.world.getCell(2, T, -3)))).toBe(AXIS_X);
    me.hold(B.HELM);
    expect(me.useOn(1, T, -3, PY)).toBe(true); // the helm on top of the first log
    expect(idAt(sim.world, 1, T + 1, -3)).toBe(B.HELM);
    me.hold(B.LOG_OAK);
    expect(me.useOn(3, T - 1, -3, PY)).toBe(true); // top face of the ground -> upright log at (3, T, -3)
    expect(stateAxis(cellState(sim.world.getCell(3, T, -3)))).toBe(AXIS_Y);

    const a = assembleShipByHand(w, 1, T + 1, -3, PX);
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
    const w = makeWorld();
    const { sim, me } = w;
    put(sim, 0, T, -3, B.COBBLE);
    me.hold(B.HELM);
    expect(me.useOn(0, T, -3, PY)).toBe(true);
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.HELM);
    const a = assembleShipByHand(w, 0, T + 1, -3);
    const expected = labels([
      [0, T + 1, -3, B.HELM],
      [0, T, -3, B.COBBLE],
    ]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, [[0, T, -3, B.COBBLE]]);
  });

  it('the helm sticks only to the block below it: rubble beside it or on top of it stays', () => {
    const w = makeWorld();
    const { sim, me } = w;
    put(sim, 0, T, -3, B.COBBLE);
    const notBelow: CellSpec[] = [
      [1, T + 1, -3, B.COBBLE],
      [-1, T + 1, -3, B.COBBLE],
      [0, T + 1, -4, B.COBBLE],
      [0, T + 2, -3, B.COBBLE],
    ];
    for (const [x, y, z, id] of notBelow) put(sim, x, y, z, id);
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
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
    const w = makeWorld('creative', { x: 4.5, y: T, z: -0.5 });
    const { sim, me } = w;
    const planks = raft(sim);
    me.hold(B.BEARING);
    expect(me.useOn(2, T, -4, PX)).toBe(true); // east face of a raft plank
    expect(idAt(sim.world, 3, T, -4)).toBe(B.BEARING);
    const a = assembleShipByHand(w, 1, T + 1, -3);
    const expected = labels([[1, T + 1, -3, B.HELM], [3, T, -4, B.BEARING], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorldAir(sim, [[3, T, -4, B.BEARING]]);
  });

  it('the front of a bearing does not stick: a bearing facing the raft stays, and so does the block in front of the ship\'s bearing', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const planks = raft(sim);
    put(sim, 3, T, -4, B.BEARING, facingState(PX)); // back on the raft
    put(sim, 4, T, -4, B.PLANKS_OAK); // in front of it (where a rotor's hub would be)
    put(sim, -1, T, -4, B.BEARING, facingState(PX)); // its FRONT against the raft, its back on air
    put(sim, 1, T, -6, B.BEARING, facingState(PZ)); // front against the raft from the north
    put(sim, 1, T + 1, -7, B.CANVAS); // (unrelated decoration nowhere near the raft)
    const a = assembleShipByHand(w, 1, T + 1, -3);
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
    const w = makeWorld();
    const { sim, me } = w;
    put(sim, 0, T, -3, B.DEEPROCK);
    helmAt(sim);
    const a = assembleShipByHand(w, HX, HY, HZ);
    const expected = labels([[HX, HY, HZ, B.HELM]]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [[0, T, -3, B.DEEPROCK]]);
  });

  it('deeprock cannot be glued to a raft, and even glue forced onto its face does not pull it into the ship', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const toasts = new Toasts(sim);
    const planks: CellSpec[] = [];
    for (let z = -4; z <= -3; z++) for (let x = 0; x <= 2; x++) planks.push([x, T, z, B.PLANKS_OAK]);
    for (const [x, y, z, id] of planks) put(sim, x, y, z, id);
    helmAt(sim, 1, T + 1, -3);
    put(sim, 3, T, -3, B.DEEPROCK);
    // The player tries to put glue on it.
    me.hold(I.GLUE);
    expect(me.useOn(3, T, -3, PZ)).toBe(true);
    expect(me.useOn(3, T, -3, PY)).toBe(true);
    expect(toasts.keys()).toEqual(['toast.glue.cannot', 'toast.glue.cannot']);
    expect(sim.worldGlue.size).toBe(0);
    // Glue written straight into the store (as a corrupt save might) changes nothing either.
    sim.worldGlue.add(2, T, -3, PX);
    const a = assembleShipByHand(w, 1, T + 1, -3);
    const expected = labels([[1, T + 1, -3, B.HELM], ...planks]);
    expect(a.preview).toEqual(expected);
    expect(a.cells).toEqual(expected);
    expectWorld(sim, [[3, T, -3, B.DEEPROCK]]);
  });

  it('a deeprock block the player puts on the deck of a ship does not become part of the ship (a stone put the same way does)', () => {
    const w = makeSeaWorld();
    const { sim, me } = w;
    const ship = raftShipByHand(w);
    const n0 = ship.grid.count;
    me.hold(B.STONE);
    expect(me.useOn(3, SEA_TOP - 1, 5, PY, ship.id)).toBe(true);
    expect(idAt(ship.grid, 3, SEA_TOP, 5)).toBe(B.STONE); // building on a deck works
    expect(ship.grid.count).toBe(n0 + 1);
    me.hold(B.DEEPROCK);
    expect(me.useOn(1, SEA_TOP - 1, 5, PY, ship.id)).toBe(true);
    const inShip = structureLabels(ship.grid).filter((l) => l.endsWith(':deeprock'));
    expect(inShip).toEqual([]);
    expect(ship.grid.count).toBe(n0 + 1);
  });

  it('a bearing with deeprock in front has nothing to turn: no rotor starts, even with sails glued to the deeprock', () => {
    const w = makeWorld('creative', { x: 0.5, y: T, z: -1.5 });
    const { sim, me } = w;
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
    me.emptyHand();
    expect(me.useOn(0, T + 4, -4, PZ)).toBe(true);
    expect(me.useOn(0, T + 4, -4, PZ)).toBe(true);
    expect(toasts.keys()).toContain('fail.rotor.no_hub');
    expect(sim.structures.rotors().length).toBe(0);
    expect(me.view.preview).toBeNull();
    expectWorld(sim, [
      [1, T + 4, -4, B.DEEPROCK],
      ...sails.map(([x, y, z]) => [x, y, z, B.CANVAS] as const),
    ]);
  });
});
