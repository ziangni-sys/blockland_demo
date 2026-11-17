/**
 * Acceptance scenarios 25–29 (docs/ACCEPTANCE.md "强力胶与副手"; docs/DESIGN.md "强力胶", "副手"),
 * headless, whole simulation. Glue is applied, removed and timed through the player's clicks,
 * looks, held buttons and the off-hand swap key; whether two blocks are joined is proven by what
 * the PLAYER gets when assembling the raft at its helm; what the player sees of the glue is the
 * client's overlay data. Scene: see g7-glue-offhand-helpers.ts.
 */
import { describe, expect, it } from 'vitest';
import { AIR } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, PX, PY, PZ } from '../../src/core/dirs';
import {
  EAST,
  EDGE,
  T,
  Toasts,
  assembleRaft,
  buildRaft,
  drawnFace,
  glueClick,
  hardnessTicks,
  idAt,
  makeSim,
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
    const sim = makeSim();
    const toasts = new Toasts(sim);
    buildRaft(sim);
    standSouthEast(sim);
    expect(drawnFace(sim, ex, ey, ez, PX)).toBeUndefined();
    glueClick(sim, ex, ey, ez, PX);
    expect(toasts.keys()).toContain('toast.glue.added');
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    // Shown as glue lying on the plank's open east face, whatever the player holds.
    expect(drawnFace(sim, ex, ey, ez, PX)).toEqual({ structureId: 0, x: ex, y: ey, z: ez, face: PX, covered: false });
    sim.hold(B.STONE);
    expect(drawnFace(sim, ex, ey, ez, PX)?.covered).toBe(false);
  });

  it('a block put against the glued face is joined to it: it goes with the ship', () => {
    const sim = makeSim();
    buildRaft(sim);
    standSouthEast(sim);
    glueClick(sim, ex, ey, ez, PX);
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
    // Now covered: drawn only while glue is in a hand.
    sim.hold(I.GLUE);
    expect(drawnFace(sim, ex, ey, ez, PX)).toEqual({ structureId: 0, x: ex, y: ey, z: ez, face: PX, covered: true });
    sim.hold(B.STONE);
    expect(drawnFace(sim, ex, ey, ez, PX)).toBeUndefined();
    const cells = assembleRaft(sim);
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells.length).toBe(6 + 1 + 1);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
  });

  it('a block put against a face without glue is not joined; a plank (auto-sticking) is', () => {
    const sim = makeSim();
    buildRaft(sim);
    standSouthEast(sim);
    placeAgainst(sim, B.PLANKS_PINE, ex, ey, ez - 1, PX); // (3, T, -4)
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    expect(sim.worldGlue.size).toBe(0);
    const cells = assembleRaft(sim);
    expect(cells).not.toContain(stoneAt(sx, sy, sz));
    expect(cells).toContain(`${sx},${sy},${sz - 1}:planks_pine`);
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
  });
});

// =====================================================================================
describe('26. 已经挨着的两块不能涂胶粘上；拆掉其中一块、涂胶、放回去之后相连。', () => {
  it('the face between two blocks that already touch cannot be targeted: no click can glue them', () => {
    const sim = makeSim();
    buildRaft(sim);
    put(sim, sx, sy, sz, B.STONE); // touching the edge plank
    standSouthEast(sim);
    sim.hold(I.GLUE);
    // The shared face is covered on both sides: the ray never hits it.
    expect(sim.useOn(ex, ey, ez, PX)).toBe(false);
    expect(sim.useOn(sx, sy, sz, NX)).toBe(false); // the stone's west face
    // Right-clicks on the faces the player can reach glue those faces, not the shared one.
    glueClick(sim, sx, sy, sz, PZ);
    glueClick(sim, sx, sy, sz, PY);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(2);
    const cells = assembleRaft(sim);
    expect(cells).not.toContain(stoneAt(sx, sy, sz));
    expect(idAt(sim.world, sx, sy, sz)).toBe(B.STONE);
  });

  it('take the stone off, glue the face, put the stone back: now they are joined', () => {
    const sim = makeSim();
    buildRaft(sim);
    put(sim, sx, sy, sz, B.STONE);
    standSouthEast(sim);
    expect(sim.mine(sx, sy, sz, PX)).toBe(true);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
    glueClick(sim, ex, ey, ez, PX);
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    const cells = assembleRaft(sim);
    expect(cells).toContain(stoneAt(sx, sy, sz));
  });
});

// =====================================================================================
describe('27. 拆掉粘着的一侧方块，胶留在另一侧的面上，重新放上方块仍然相连；两侧都拆掉，胶消失。', () => {
  function gluedStone() {
    const sim = makeSim();
    buildRaft(sim);
    standSouthEast(sim);
    glueClick(sim, ex, ey, ez, PX);
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    return sim;
  }

  it('mining the stone leaves the glue on the plank\'s face, still shown there; a stone put back is joined again', () => {
    const sim = gluedStone();
    expect(sim.mine(sx, sy, sz, PX)).toBe(true);
    expect(idAt(sim.world, sx, sy, sz)).toBe(AIR);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    sim.hold(B.STONE);
    expect(drawnFace(sim, ex, ey, ez, PX)?.covered).toBe(false);
    placeAgainst(sim, B.BRICKS, ex, ey, ez, PX); // any glueable block: no glue in either hand now
    const cells = assembleRaft(sim);
    expect(cells).toContain(`${sx},${sy},${sz}:bricks`);
  });

  it('the glue stays on the stone\'s face when the plank goes instead (a ship plank can be replaced without regluing)', () => {
    const sim = gluedStone();
    sim.teleport(1.5, T, -1.5);
    sim.advance(1);
    sim.hold(B.DIRT);
    expect(sim.mine(ex, ey, ez, PZ)).toBe(true);
    expect(idAt(sim.world, ex, ey, ez)).toBe(AIR);
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    placeAgainst(sim, B.PLANKS_OAK, sx, sy, sz, NX); // a new plank where the old one was, against the glued face
    expect(idAt(sim.world, ex, ey, ez)).toBe(B.PLANKS_OAK);
    const cells = assembleRaft(sim);
    expect(cells).toContain(stoneAt(sx, sy, sz));
  });

  it('with both sides taken off, the glue is gone', () => {
    const sim = gluedStone();
    expect(sim.mine(sx, sy, sz, PX)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(sim.mine(ex, ey, ez, PX)).toBe(true);
    expect(idAt(sim.world, ex, ey, ez)).toBe(AIR);
    expect(sim.worldGlue.size).toBe(0);
    expect(drawnFace(sim, ex, ey, ez, PX)).toBeUndefined();
  });
});

// =====================================================================================
describe('28. 潜行右键露出的胶面去掉胶。生存模式涂胶耗时等于该方块的挖掘时间，中途移开视线取消，完成后消耗 1 个胶；创造模式瞬间完成。', () => {
  it('sneak + right-click on an exposed glued face removes its glue (and the stone put there afterwards is not joined)', () => {
    const sim = makeSim();
    const toasts = new Toasts(sim);
    buildRaft(sim);
    standSouthEast(sim);
    glueClick(sim, ex, ey, ez, PX);
    sim.player.input.sneak = true;
    glueClick(sim, ex, ey, ez, PX);
    sim.player.input.sneak = false;
    expect(toasts.keys()).toContain('toast.glue.removed');
    expect(sim.worldGlue.size).toBe(0);
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    expect(assembleRaft(sim)).not.toContain(stoneAt(sx, sy, sz));
  });

  /**
   * Survival: right-click the edge plank's east face with glue in hand and keep the button held
   * on it. Returns the ticks — the click's tick counted as the first — until the face is glued,
   * or -1 if it is not glued within maxTicks.
   */
  function holdGlue(sim: ReturnType<typeof makeSim>, maxTicks: number): number {
    const input = sim.player.input;
    input.use = true;
    try {
      glueClick(sim, ex, ey, ez, PX);
      for (let n = 1; n <= maxTicks; n++) {
        if (sim.worldGlue.has(ex, ey, ez, PX)) return n;
        sim.tick();
      }
      return -1;
    } finally {
      input.use = false;
    }
  }

  it('survival: gluing takes exactly the block\'s mining time and uses one glue when it completes', () => {
    const sim = makeSim('survival');
    buildRaft(sim);
    standSouthEast(sim);
    put(sim, 5, T, -2, B.PLANKS_OAK); // a copy of the plank, to time mining it
    const mining = measureMiningTicks(sim, 5, T, -2, PZ);
    expect(mining).toBe(hardnessTicks(B.PLANKS_OAK));
    sim.advance(10);
    sim.hold(I.GLUE, 3);
    const n = holdGlue(sim, mining + 40);
    expect(n).toBe(mining);
    expect(sim.player.inventory.count(I.GLUE)).toBe(2);
  });

  it('survival: looking away part-way cancels — no glue, none used, and holding on afterwards does not finish it', () => {
    const sim = makeSim('survival');
    buildRaft(sim);
    standSouthEast(sim);
    sim.hold(I.GLUE, 3);
    const total = hardnessTicks(B.PLANKS_OAK);
    const input = sim.player.input;
    input.use = true;
    glueClick(sim, ex, ey, ez, PX);
    sim.advance(total - 5);
    expect(sim.view.glueProgress).toBeGreaterThan(0.5);
    sim.lookAt(ex + 0.5, ey + 30, ez + 0.5); // the sky, button still held
    sim.tick();
    expect(sim.view.glueProgress).toBe(0);
    sim.lookAtCell(ex, ey, ez, PX); // back on the face, still holding
    sim.advance(3 * total);
    input.use = false;
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(3);
  });

  it('creative: one right-click glues at once, even on the hardest block, and uses no glue', () => {
    const sim = makeSim('creative');
    buildRaft(sim);
    put(sim, ex, ey, ez, B.IRON_BLOCK); // 5 s in survival
    standSouthEast(sim);
    sim.hold(I.GLUE, 1);
    glueClick(sim, ex, ey, ez, PX); // one tick, button not held
    expect(sim.worldGlue.has(ex, ey, ez, PX)).toBe(true);
    expect(sim.view.glueProgress).toBe(0);
    expect(sim.player.inventory.count(I.GLUE)).toBe(1);
  });
});

// =====================================================================================
describe('29. 副手拿强力胶时，主手放出的方块自动粘到点击的面上；生存模式每块消耗 1 个胶，胶用完后放出的方块不粘。', () => {
  /** The player puts glue in the off-hand with the swap key (F) and takes stones in the main hand. */
  function offhandGlue(sim: ReturnType<typeof makeSim>, glue: number): void {
    sim.hold(I.GLUE, glue);
    sim.swapHands();
    sim.tick();
    expect(sim.player.inventory.offhand).toEqual({ item: I.GLUE, count: glue });
    sim.hold(B.STONE, 16);
  }

  it('survival: each placed block sticks to the clicked face, using one glue; once the glue is used up, placed blocks do not stick', () => {
    const sim = makeSim('survival');
    buildRaft(sim);
    standSouthEast(sim);
    offhandGlue(sim, 2);
    placeAgainst(sim, B.STONE, ex, ey, ez - 1, PX); // (3, T, -4): glued, 1 left
    expect(sim.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
    placeAgainst(sim, B.STONE, ex, ey, ez, PX); // (3, T, -3): glued, none left
    expect(sim.player.inventory.offhand).toBeNull();
    placeAgainst(sim, B.STONE, ex, ey, ez - 1, PY); // (2, T + 1, -4) on the raft: not glued
    expect(idAt(sim.world, ex, ey + 1, ez - 1)).toBe(B.STONE);
    expect(sim.worldGlue.size).toBe(2);
    expect(sim.player.inventory.count(B.STONE)).toBe(13);
    const cells = assembleRaft(sim);
    expect(cells).toContain(stoneAt(sx, sy, sz - 1));
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells).not.toContain(stoneAt(ex, ey + 1, ez - 1));
  });

  it('creative: the off-hand glue is not used up', () => {
    const sim = makeSim('creative');
    buildRaft(sim);
    standSouthEast(sim);
    offhandGlue(sim, 1);
    placeAgainst(sim, B.STONE, ex, ey, ez - 1, PX);
    placeAgainst(sim, B.STONE, ex, ey, ez, PX);
    placeAgainst(sim, B.STONE, ex, ey, ez - 1, PY);
    expect(sim.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
    const cells = assembleRaft(sim);
    expect(cells).toContain(stoneAt(sx, sy, sz - 1));
    expect(cells).toContain(stoneAt(sx, sy, sz));
    expect(cells).toContain(stoneAt(ex, ey + 1, ez - 1));
  });
});
