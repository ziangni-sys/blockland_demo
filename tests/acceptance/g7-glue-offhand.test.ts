/**
 * Acceptance scenarios 25–29 (docs/ACCEPTANCE.md "强力胶与副手"; docs/DESIGN.md "强力胶", "副手"),
 * headless, whole simulation. Glue is applied, removed and timed through the player's clicks,
 * looks, held buttons and the off-hand swap key; whether two blocks are joined is proven by what
 * the PLAYER gets when assembling the raft at its helm; what the player sees of the glue is the
 * client's overlay data. Scene: see g7-glue-offhand-helpers.ts.
 */
import { describe, expect, it } from 'vitest';
import { AIR, axisState, cellState, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, PX, PY, PZ } from '../../src/core/dirs';
import { qfromYaw, qmul, vec3 } from '../../src/core/math';
import type { TestWorld } from './world';
import type { Ship } from '../../src/structures/structure';
import { SEA_TOP, label, makeSeaWorld, raftShipByHand, structureLabels } from './g1-stick-glue-helpers';
import {
  EAST,
  EDGE,
  T,
  Toasts,
  assembleRaft,
  buildRaft,
  drawnFace,
  drawnGlue,
  glueClick,
  hardnessTicks,
  idAt,
  makeWorld,
  measureMiningTicks,
  placeAgainst,
  put,
  standSouthEast,
  stoneAt,
} from './g7-glue-offhand-helpers';

const [ex, ey, ez] = EDGE;
const [sx, sy, sz] = EAST;

// =====================================================================================
describe('25. 手持强力胶右键方块露出的面，面上出现胶；贴着这个面放方块，两块相连；贴着没涂胶的面放的方块不相连（自动粘连的材质除外）。', () => {
  it('a right-click with glue in hand puts glue on the exposed face, and the glue shows on it', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const toasts = new Toasts(sim);
    buildRaft(w);
    standSouthEast(w);
    expect(drawnFace(w, ex, ey, ez, PX)).toBeUndefined();
    glueClick(w, ex, ey, ez, PX);
    expect(toasts.keys()).toContain('toast.glue.added');
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    // Shown as glue lying on the plank's open east face, whatever the player holds.
    // Lit like the face under it: by the light of the open cell east of the plank, under the open
    // sky (network mode: the client's replica computed that light; direct mode has no client).
    expect(drawnFace(w, ex, ey, ez, PX)).toEqual({ structureId: 0, x: ex, y: ey, z: ez, face: PX, covered: false, sky: 15, block: 0 });
    me.hold(B.STONE);
    expect(drawnFace(w, ex, ey, ez, PX)?.covered).toBe(false);
  });

  it('a block put against the glued face is joined to it: it goes with the ship', () => {
    const w = makeWorld();
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    glueClick(w, ex, ey, ez, PX);
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
    // Now covered: drawn only while glue is in a hand.
    me.hold(I.GLUE);
    expect(drawnFace(w, ex, ey, ez, PX)).toEqual({ structureId: 0, x: ex, y: ey, z: ez, face: PX, covered: true, sky: 0, block: 0 });
    me.hold(B.STONE);
    expect(drawnFace(w, ex, ey, ez, PX)).toBeUndefined();
    const cells = assembleRaft(w);
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells.length).toBe(6 + 1 + 1);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
  });

  it('a block put against a face without glue is not joined; a plank (auto-sticking) is', () => {
    const w = makeWorld();
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    placeAgainst(w, B.PLANKS_PINE, ex, ey, ez - 1, PX); // (3, T, -4)
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    expect(sim.worldGlue.size).toBe(0);
    const cells = assembleRaft(w);
    expect(cells).not.toContain(stoneAt(sx, sy, sz));
    expect(cells).toContain(`${sx},${sy},${sz - 1}:planks_pine`);
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
  });
});

// =====================================================================================
describe('26. 已经挨着的两块不能涂胶粘上；拆掉其中一块、涂胶、放回去之后相连。', () => {
  it('the face between two blocks that already touch cannot be targeted: no click can glue them', () => {
    const w = makeWorld();
    const { sim, me } = w;
    buildRaft(w);
    put(sim, sx, sy, sz, B.STONE); // touching the edge plank
    standSouthEast(w);
    me.hold(I.GLUE);
    // The shared face is covered on both sides: the ray never hits it.
    expect(me.useOn(ex, ey, ez, PX)).toBe(false);
    expect(me.useOn(sx, sy, sz, NX)).toBe(false); // the stone's west face
    // Right-clicks on the faces the player can reach glue those faces, not the shared one.
    glueClick(w, sx, sy, sz, PZ);
    glueClick(w, sx, sy, sz, PY);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(2);
    const cells = assembleRaft(w);
    expect(cells).not.toContain(stoneAt(sx, sy, sz));
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
  });

  it('take the stone off, glue the face, put the stone back: now they are joined', () => {
    const w = makeWorld();
    const { sim, me } = w;
    buildRaft(w);
    put(sim, sx, sy, sz, B.STONE);
    standSouthEast(w);
    expect(me.mine(sx, sy, sz, PX)).toBe(true);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
    glueClick(w, ex, ey, ez, PX);
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    const cells = assembleRaft(w);
    expect(cells).toContain(stoneAt(sx, sy, sz));
  });
});

// =====================================================================================
describe('27. 拆掉粘着的一侧方块，胶留在另一侧的面上，重新放上方块仍然相连；两侧都拆掉，胶消失。', () => {
  function gluedStone() {
    const w = makeWorld();
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    glueClick(w, ex, ey, ez, PX);
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    return w;
  }

  it('mining the stone leaves the glue on the plank\'s face, still shown there; a stone put back is joined again', () => {
    const w = gluedStone();
    const { sim, me } = w;
    expect(me.mine(sx, sy, sz, PX)).toBe(true);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    me.hold(B.STONE);
    expect(drawnFace(w, ex, ey, ez, PX)?.covered).toBe(false);
    placeAgainst(w, B.BRICKS, ex, ey, ez, PX); // any glueable block: no glue in either hand now
    const cells = assembleRaft(w);
    expect(cells).toContain(`${sx},${sy},${sz}:bricks`);
  });

  it('the glue stays on the stone\'s face when the plank goes instead (a ship plank can be replaced without regluing)', () => {
    const w = gluedStone();
    const { sim, me } = w;
    me.teleport(1.5, T, -1.5);
    w.tick(1);
    me.hold(B.DIRT);
    expect(me.mine(ex, ey, ez, PZ)).toBe(true);
    expect(idAt(sim.world, ex, ey, ez)).toBe(AIR);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    placeAgainst(w, B.PLANKS_OAK, sx, sy, sz, NX); // a new plank where the old one was, against the glued face
    expect(idAt(sim.world, ex, ey, ez)).toBe(B.PLANKS_OAK);
    const cells = assembleRaft(w);
    expect(cells).toContain(stoneAt(sx, sy, sz));
  });

  it('with both sides taken off, the glue is gone', () => {
    const w = gluedStone();
    const { sim, me } = w;
    expect(me.mine(sx, sy, sz, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(me.mine(ex, ey, ez, PX)).toBe(true);
    expect(idAt(sim.world, ex, ey, ez)).toBe(AIR);
    expect(sim.worldGlue.size).toBe(0);
    expect(drawnFace(w, ex, ey, ez, PX)).toBeUndefined();
  });
});

// =====================================================================================
describe('28. 潜行右键露出的胶面去掉胶。生存模式涂胶耗时等于该方块的挖掘时间，中途移开视线取消，完成后消耗 1 个胶；创造模式瞬间完成。', () => {
  it('sneak + right-click on an exposed glued face removes its glue (and the stone put there afterwards is not joined)', () => {
    const w = makeWorld();
    const { sim, me } = w;
    const toasts = new Toasts(sim);
    buildRaft(w);
    standSouthEast(w);
    glueClick(w, ex, ey, ez, PX);
    me.input.sneak = true;
    glueClick(w, ex, ey, ez, PX);
    me.input.sneak = false;
    expect(toasts.keys()).toContain('toast.glue.removed');
    expect(sim.worldGlue.size).toBe(0);
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    expect(assembleRaft(w)).not.toContain(stoneAt(sx, sy, sz));
  });

  /**
   * Survival: right-click the edge plank's east face with glue in hand and keep the button held
   * on it. Returns the ticks — the click's tick counted as the first — until the face is glued,
   * or -1 if it is not glued within maxTicks.
   */
  function holdGlue(w: TestWorld, maxTicks: number): number {
    const { sim, me } = w;
    if (me.player.inventory.selectedStack()?.item !== I.GLUE) me.hold(I.GLUE);
    expect(me.aimAt(ex, ey, ez, PX), 'aim at the glued face').toBe(true);
    me.pressUse();
    try {
      w.tick();
      for (let n = 1; n <= maxTicks; n++) {
        if (sim.worldGlue.has(ex, ey, ez, PX)) return n;
        w.tickWhile();
      }
      return -1;
    } finally {
      me.releaseUse();
    }
  }

  it('survival: gluing takes exactly the block\'s mining time and uses one glue when it completes', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    put(sim, 5, T, -2, B.PLANKS_OAK); // a copy of the plank, to time mining it
    const mining = measureMiningTicks(w, 5, T, -2, PZ);
    expect(mining).toBe(hardnessTicks(B.PLANKS_OAK));
    w.tick(10);
    me.hold(I.GLUE, 3);
    const n = holdGlue(w, mining + 40);
    expect(n).toBe(mining);
    expect(me.player.inventory.count(I.GLUE)).toBe(2);
  });

  it('survival: looking away part-way cancels — no glue, none used, and holding on afterwards does not finish it', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    me.hold(I.GLUE, 3);
    const total = hardnessTicks(B.PLANKS_OAK);
    expect(me.aimAt(ex, ey, ez, PX), 'aim at the face').toBe(true);
    me.pressUse();
    w.tick();
    w.tick(total - 5);
    expect(me.view.gluing!.progress).toBeGreaterThan(0.5);
    me.lookAt(ex + 0.5, ey + 30, ez + 0.5); // the sky, button still held
    w.tick();
    expect(me.view.gluing).toBeNull();
    me.lookAtCell(ex, ey, ez, PX); // back on the face, still holding
    w.tick(3 * total);
    me.releaseUse();
    expect(sim.worldGlue.size).toBe(0);
    expect(me.player.inventory.count(I.GLUE)).toBe(3);
  });

  it('creative: one right-click glues at once, even on the hardest block, and uses no glue', () => {
    const w = makeWorld('creative');
    const { sim, me } = w;
    buildRaft(w);
    put(sim, ex, ey, ez, B.IRON_BLOCK); // 5 s in survival
    standSouthEast(w);
    me.hold(I.GLUE, 1);
    glueClick(w, ex, ey, ez, PX); // one tick, button not held
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    expect(me.view.gluing).toBeNull();
    expect(me.player.inventory.count(I.GLUE)).toBe(1);
  });
});

// =====================================================================================
describe('29. 副手拿强力胶时，主手放出的方块自动粘到点击的面上；生存模式每块消耗 1 个胶，胶用完后放出的方块不粘。', () => {
  /** The player puts glue in the off-hand with the swap key (F) and takes stones in the main hand. */
  function offhandGlue(w: TestWorld, glue: number): void {
    const { me } = w;
    me.hold(I.GLUE, glue);
    me.swapHands();
    w.tick();
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: glue });
    me.hold(B.STONE, 16);
  }

  it('survival: each placed block sticks to the clicked face, using one glue; once the glue is used up, placed blocks do not stick', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    offhandGlue(w, 2);
    placeAgainst(w, B.STONE, ex, ey, ez - 1, PX); // (3, T, -4): glued, 1 left
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
    placeAgainst(w, B.STONE, ex, ey, ez, PX); // (3, T, -3): glued, none left
    expect(me.player.inventory.offhand).toBeNull();
    placeAgainst(w, B.STONE, ex, ey, ez - 1, PY); // (2, T + 1, -4) on the raft: not glued
    expect(idAt(sim.world, ex, ey + 1, ez - 1)).toBe(B.STONE);
    expect(sim.worldGlue.size).toBe(2);
    expect(me.player.inventory.count(B.STONE)).toBe(13);
    const cells = assembleRaft(w);
    expect(cells).toContain(stoneAt(sx, sy, sz - 1));
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells).not.toContain(stoneAt(ex, ey + 1, ez - 1));
  });

  it('creative: the off-hand glue is not used up', () => {
    const w = makeWorld('creative');
    const { sim, me } = w;
    buildRaft(w);
    standSouthEast(w);
    offhandGlue(w, 1);
    placeAgainst(w, B.STONE, ex, ey, ez - 1, PX);
    placeAgainst(w, B.STONE, ex, ey, ez, PX);
    placeAgainst(w, B.STONE, ex, ey, ez - 1, PY);
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
    const cells = assembleRaft(w);
    expect(cells).toContain(stoneAt(sx, sy, sz - 1));
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells).toContain(stoneAt(ex, ey + 1, ez - 1));
  });

  it('blocks that connect anyway are not glued and cost nothing: a log on the end of a log, a helm on a block, a bearing with its back to a block', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    put(sim, 2, T, -3, B.LOG_OAK, axisState(1)); // an upright log
    put(sim, 0, T, -3, B.STONE);
    put(sim, -2, T, -3, B.STONE);
    offhandGlue(w, 10);
    const offhand = (): number => me.player.inventory.offhand?.count ?? 0;
    // Logs stick along their axis: an upright log on top of an upright log.
    placeAgainst(w, B.LOG_OAK, 2, T, -3, PY);
    expect(idAt(sim.world, 2, T + 1, -3)).toBe(B.LOG_OAK);
    expect(sim.worldGlue.size).toBe(0);
    expect(offhand()).toBe(10);
    // A helm mounts on the block below it.
    placeAgainst(w, B.HELM, 0, T, -3, PY);
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.HELM);
    expect(sim.worldGlue.size).toBe(0);
    expect(offhand()).toBe(10);
    // A bearing mounts with its back on the clicked face.
    placeAgainst(w, B.BEARING, -2, T, -3, PZ);
    expect(idAt(sim.world, -2, T, -2)).toBe(B.BEARING);
    expect(stateFacing(cellState(sim.world.getCell(-2, T, -2)))).toBe(PZ);
    expect(sim.worldGlue.size).toBe(0);
    expect(offhand()).toBe(10);
  });

  it('blocks that would not connect without glue are glued, one glue each: a log on the side of an upright log, a stone on the front of a bearing', () => {
    const w = makeWorld('survival');
    const { sim, me } = w;
    put(sim, 2, T, -3, B.LOG_OAK, axisState(1));
    put(sim, -2, T, -3, B.STONE);
    offhandGlue(w, 10);
    // A log put against the side of an upright log lies along that face's axis: logs beside each other do not stick.
    placeAgainst(w, B.LOG_OAK, 2, T, -3, PZ);
    expect(idAt(sim.world, 2, T, -2)).toBe(B.LOG_OAK);
    expect(sim.worldGlue.has(2, T, -3, PZ)).toBe(true);
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 9 });
    // The front of a bearing does not stick: a stone put there (sneaking, so the bearing is not clicked) is glued.
    placeAgainst(w, B.BEARING, -2, T, -3, PZ);
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 9 });
    me.input.sneak = true;
    placeAgainst(w, B.STONE, -2, T, -2, PZ);
    me.input.sneak = false;
    expect(idAt(sim.world, -2, T, -1)).toBe(B.STONE);
    expect(sim.worldGlue.has(-2, T, -2, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 8 });
  });
});

// =====================================================================================
describe('25、28、29 在转过一个角度的船上：涂胶、去胶和副手涂胶都落在船自己的面上，粘上的方块随船走。', () => {
  /** The deck row of the sea raft (raftShipByHand: planks x 0..4, z 0..5, helm at (2, SEA_TOP, 4)). */
  const D = SEA_TOP - 1;
  /** Turn the floating ship by `yaw` and move it out to sea, away from the dock (the pose is set by hand). */
  function turnAndSail(w: TestWorld, ship: Ship, yaw: number): void {
    const p = ship.grid.position;
    ship.grid.setPoseImmediate(vec3(p.x, p.y, p.z - 12), qmul(qfromYaw(yaw), ship.grid.rotation));
    w.sim.dynamics.wake(ship);
    w.tick(40);
  }
  /** The (creative) player hovers at ship-local point (x, y, z). */
  function hover(w: TestWorld, ship: Ship, x: number, y: number, z: number): void {
    const q = ship.grid.toWorld(vec3(x, y, z));
    w.me.teleport(q.x, q.y, q.z);
    w.me.setFlying(true);
    w.tick();
  }
  /** The (survival) player stands on the deck at ship-local cell (3, D + 1, 3) and is carried. */
  function standOnDeck(w: TestWorld, ship: Ship): void {
    const q = ship.grid.toWorld(vec3(3.5, D + 1.05, 3.5));
    w.me.teleport(q.x, q.y, q.z);
    w.tick(10);
  }
  /** World cells (above the sea floor) holding block `id`. */
  function findWorld(sim: TestWorld['sim'], id: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (let y = D - 2; y <= D + 3; y++) {
      for (let z = -30; z <= 20; z++) for (let x = -20; x <= 25; x++) if (idAt(sim.world, x, y, z) === id) out.push([x, y, z]);
    }
    return out;
  }

  it('creative, the ship turned by 100°: the clicked local face is glued in the ship\'s store and drawn there; sneak removes it; glued stones ride along when the ship docks and is assembled again', () => {
    const w = makeSeaWorld('creative');
    const { sim, me } = w;
    const ship = raftShipByHand(w);
    turnAndSail(w, ship, (100 * Math.PI) / 180);
    hover(w, ship, 6.5, D + 1.2, 2.5); // east of the raft's east edge (local +X)

    // Main hand: the east face of plank (4, D, 2) in the ship's own frame.
    glueClick(w, 4, D, 2, PX, ship.id);
    expect(ship.glue.has(4, D, 2, PX)).toBe(true);
    expect(ship.glue.size).toBe(1);
    expect(sim.worldGlue.size).toBe(0);
    expect(drawnGlue(w)).toContainEqual({ structureId: ship.id, x: 4, y: D, z: 2, face: PX, covered: false, sky: 15, block: 0 });
    me.input.sneak = true;
    glueClick(w, 4, D, 2, PX, ship.id);
    me.input.sneak = false;
    expect(ship.glue.size).toBe(0);

    // Glue it again and put a stone against it; a second stone against an unglued face.
    glueClick(w, 4, D, 2, PX, ship.id);
    placeAgainst(w, B.STONE, 4, D, 2, PX, ship.id);
    placeAgainst(w, B.STONE, 4, D, 0, PX, ship.id);
    // Off-hand glue (swap key): a third stone put against plank (4, D, 4) is glued on its own.
    me.hold(I.GLUE);
    me.swapHands();
    w.tick();
    placeAgainst(w, B.STONE, 4, D, 4, PX, ship.id);
    expect(idAt(ship.grid, 5, D, 2)).toBe(B.STONE);
    expect(idAt(ship.grid, 5, D, 0)).toBe(B.STONE);
    expect(idAt(ship.grid, 5, D, 4)).toBe(B.STONE);
    expect(ship.glue.has(4, D, 2, PX)).toBe(true);
    expect(ship.glue.has(4, D, 4, PX)).toBe(true);
    expect(ship.glue.size).toBe(2);
    expect(sim.worldGlue.size).toBe(0);

    // Dock (sneak + right-click on the helm, empty hand), then assemble the raft again at its helm.
    me.emptyHand();
    hover(w, ship, 2.5, D + 2, 6.5);
    me.input.sneak = true;
    expect(me.useOn(2, SEA_TOP, 4, undefined, ship.id)).toBe(true);
    me.input.sneak = false;
    expect(ship.removed).toBe(true);
    expect(sim.worldGlue.size).toBe(2);
    const helms = findWorld(sim, B.HELM);
    expect(helms.length).toBe(1);
    const [hx, hy, hz] = helms[0]!;
    const stones = findWorld(sim, B.STONE);
    expect(stones.length).toBe(3);
    me.teleport(hx + 0.5, hy + 1.5, hz + 0.5);
    me.setFlying(true);
    w.tick();
    expect(me.useOn(hx, hy, hz, PY)).toBe(true);
    expect(me.useOn(hx, hy, hz, PY)).toBe(true);
    const again = sim.structures.ships();
    expect(again.length).toBe(1);
    const taken = structureLabels(again[0]!.grid).filter((l) => l.endsWith(':stone'));
    expect(taken.length).toBe(2);
    const left = findWorld(sim, B.STONE);
    expect(left.length).toBe(1);
    expect(taken).not.toContain(label(left[0]![0], left[0]![1], left[0]![2], B.STONE));
  });

  it('survival, on the deck of the turned ship: the timed glue and the off-hand glue land in the ship\'s store and use one glue each', () => {
    const w = makeSeaWorld('survival');
    const { sim, me } = w;
    const ship = raftShipByHand(w);
    turnAndSail(w, ship, (-130 * Math.PI) / 180);
    // A brick on the deck to glue; the player stands on the deck south-east of it.
    me.hold(B.BRICKS, 4);
    standOnDeck(w, ship);
    expect(me.useOn(2, D, 1, PY, ship.id)).toBe(true);
    expect(idAt(ship.grid, 2, D + 1, 1)).toBe(B.BRICKS);

    // Main hand, survival: hold the button on the brick's east face for the brick's mining time.
    me.hold(I.GLUE, 3);
    expect(me.aimAt(2, D + 1, 1, PX, ship.id)).toBe(true);
    me.pressUse();
    w.tick();
    const total = hardnessTicks(B.BRICKS);
    let n = 1;
    while (!ship.glue.has(2, D + 1, 1, PX) && n < total + 20) {
      me.lookAtCell(2, D + 1, 1, PX, ship.id); // the player keeps looking at it as the ship rocks
      w.tickWhile();
      n++;
    }
    me.releaseUse();
    expect(n).toBe(total);
    expect(ship.glue.size).toBe(1);
    expect(sim.worldGlue.size).toBe(0);
    expect(me.player.inventory.count(I.GLUE)).toBe(2);

    // Off-hand: the glue goes to the off-hand (swap key); a stone put against the brick's south face is glued to it.
    me.swapHands();
    w.tick();
    placeAgainst(w, B.STONE, 2, D + 1, 1, PZ, ship.id);
    expect(idAt(ship.grid, 2, D + 1, 2)).toBe(B.STONE);
    expect(ship.glue.has(2, D + 1, 1, PZ)).toBe(true);
    expect(ship.glue.size).toBe(2);
    expect(sim.worldGlue.size).toBe(0);
    expect(me.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
  });
});
