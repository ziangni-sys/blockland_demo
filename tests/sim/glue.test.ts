import { describe, expect, it } from 'vitest';
import { facingState, layersState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { BLOCKS } from '../../src/blocks/registry';
import { NZ, PX, PY, PZ } from '../../src/core/dirs';
import { explode } from '../../src/sim/explosion';
import { EventLog, FLAT_TOP, click, fill, flatSim, idAt } from './helpers';

const T = FLAT_TOP;
const Y = T + 1; // eye level row

/** Survival mining ticks of a block (its hardness in seconds at 20 TPS). */
function ticksOf(id: number): number {
  return Math.round(BLOCKS[id]!.hardness * 20);
}

describe('superglue in the main hand: one face at a time (DESIGN 强力胶)', () => {
  it('creative: a right-click glues the face the ray hit, at once and for free; sneak + right-click removes it', () => {
    const sim = flatSim();
    sim.world.setCell(0, Y, -2, makeCell(B.STONE));
    const log = new EventLog(sim);
    sim.soloPlayer.hold(I.GLUE, 1);
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.tick();
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.apply');
    click(sim);
    // The face between the block and its neighbour along the hit normal (the open side).
    expect(sim.worldGlue.has(0, Y, -2, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, Y, -1, NZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(log.toastKeys()).toContain('toast.glue.added');
    expect(log.of('sound').map((e) => e.name)).toContain('glue');
    expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(1); // creative: not consumed
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.already');
    click(sim);
    expect(log.toastKeys()).toContain('toast.glue.already');
    expect(sim.worldGlue.size).toBe(1);

    sim.soloPlayer.player.input.sneak = true;
    sim.tick();
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.remove');
    log.clear();
    click(sim);
    expect(sim.worldGlue.size).toBe(0);
    expect(log.toastKeys()).toEqual(['toast.glue.removed']);
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.notGlued');
    click(sim);
    expect(log.toastKeys()).toContain('toast.glue.notGlued');
  });

  it('each face of a block is its own: gluing the top does not glue the side', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -2, makeCell(B.STONE)); // below the eye: its top face shows
    sim.soloPlayer.hold(I.GLUE);
    expect(sim.soloPlayer.useOn(0, T, -2, PY)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(sim.soloPlayer.useOn(0, T, -2, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(true);
    expect(sim.worldGlue.has(0, T, -2, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, T, -2, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(2);
  });

  it('removing works in survival too, at once and without a refund', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.IRON_BLOCK));
    sim.worldGlue.add(0, Y, -2, PZ);
    sim.soloPlayer.hold(I.GLUE, 2);
    sim.soloPlayer.player.input.sneak = true;
    expect(sim.soloPlayer.useOn(0, Y, -2, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(2);
  });

  it('never on unbreakable blocks', () => {
    const sim = flatSim();
    sim.world.setCell(0, Y, -2, makeCell(B.DEEPROCK));
    const log = new EventLog(sim);
    sim.soloPlayer.hold(I.GLUE);
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.tick();
    expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.cannot');
    click(sim);
    expect(sim.worldGlue.size).toBe(0);
    expect(log.toastKeys()).toEqual(['toast.glue.cannot']);
  });
});

describe('the glue ray passes through soft blocks: every exposed glued face can be clicked (DESIGN 强力胶)', () => {
  const softBlocks: Array<[string, number]> = [
    ['a torch', makeCell(B.TORCH)],
    ['a snow layer', makeCell(B.SNOW_LAYER, layersState(1))],
    ['tall grass', makeCell(B.TALL_GRASS)],
  ];
  for (const [what, soft] of softBlocks) {
    it(`with ${what} in front of a glued face: glue in hand aims at the face, sneak removes it, a click glues it again, a left-click breaks the soft block`, () => {
      const sim = flatSim();
      sim.world.setCell(0, T, -3, makeCell(B.STONE));
      sim.soloPlayer.hold(I.GLUE);
      expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
      sim.world.setCell(0, T, -2, soft); // put in front of the glued face afterwards
      expect(sim.worldGlue.has(0, T, -3, PZ)).toBe(true);
      const log = new EventLog(sim);
      // The outline and hint are on the stone's face behind the soft block, not on the soft block.
      sim.soloPlayer.lookAtCell(0, T, -3, PZ);
      sim.tick();
      expect(sim.soloPlayer.view.target).toEqual({ gridId: 0, x: 0, y: T, z: -3, face: PZ });
      expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.already');
      sim.soloPlayer.player.input.sneak = true;
      sim.tick();
      expect(sim.soloPlayer.view.hint?.key).toBe('hint.glue.remove');
      expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
      sim.soloPlayer.player.input.sneak = false;
      expect(sim.worldGlue.size).toBe(0);
      expect(log.toastKeys()).toEqual(['toast.glue.removed']);
      expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
      expect(sim.worldGlue.has(0, T, -3, PZ)).toBe(true);
      // The mining ray still stops at the soft block: a left-click with glue in hand breaks it.
      expect(sim.soloPlayer.mineTargetCell()).toMatchObject({ gridId: 0, x: 0, y: T, z: -2 });
      expect(sim.soloPlayer.mine(0, T, -2)).toBe(true);
      expect(idAt(sim.world, 0, T, -2)).toBe(0);
      expect(idAt(sim.world, 0, T, -3)).toBe(B.STONE);
      expect(sim.worldGlue.has(0, T, -3, PZ)).toBe(true);
    });
  }

  it('a soft block alone is no target for glue: the ray goes on to the hard block behind it', () => {
    const sim = flatSim();
    sim.world.setCell(0, T, -2, makeCell(B.TORCH));
    sim.soloPlayer.hold(I.GLUE);
    sim.soloPlayer.lookAtCell(0, T, -2);
    expect(sim.soloPlayer.targetCell()).not.toMatchObject({ x: 0, y: T, z: -2 });
    sim.soloPlayer.hold(B.STONE); // any other item: the torch is the target
    expect(sim.soloPlayer.targetCell()).toMatchObject({ gridId: 0, x: 0, y: T, z: -2 });
  });
});

describe('survival: the timed glue operation', () => {
  /** A block on the ground in front of the player, glue in hand, aimed at its south face. */
  function scene(id: number = B.PLANKS_OAK, glue = 3) {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, T, -2, makeCell(id));
    sim.world.setCell(1, T, -2, makeCell(B.STONE)); // another block to look at
    sim.soloPlayer.hold(I.GLUE, glue);
    sim.soloPlayer.lookAtCell(0, T, -2, PZ);
    sim.soloPlayer.player.input.use = true;
    sim.soloPlayer.use();
    sim.tick(); // the press starts the operation (and counts as its first tick)
    return sim;
  }

  it('takes exactly the block\'s mining time while held on the same face and uses one glue on completion', () => {
    for (const id of [B.PLANKS_OAK, B.GLASS, B.IRON_BLOCK]) {
      const sim = scene(id);
      const n = ticksOf(id);
      sim.advance(n - 2);
      expect(sim.worldGlue.size).toBe(0);
      expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(3);
      expect(sim.soloPlayer.view.gluing!.progress).toBeCloseTo((n - 1) / n, 5);
      expect(sim.soloPlayer.view.hint).toEqual({ key: 'hint.glue.working', params: { pct: Math.floor(sim.soloPlayer.view.gluing!.progress * 100) } });
      sim.tick();
      expect(sim.worldGlue.has(0, T, -2, PZ)).toBe(true);
      expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(2);
      expect(sim.soloPlayer.view.gluing).toBeNull();
      sim.advance(n + 5); // still holding: nothing more happens
      expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(2);
      expect(sim.worldGlue.size).toBe(1);
    }
  });

  const cancels: Array<[string, (sim: ReturnType<typeof flatSim>) => void]> = [
    ['letting go of the button', (sim) => (sim.soloPlayer.player.input.use = false)],
    ['looking at the sky', (sim) => sim.soloPlayer.lookAt(0.5, Y + 30, -2.5)],
    ['looking at another block', (sim) => sim.soloPlayer.lookAtCell(1, T, -2, PZ)],
    ['looking at another face of the same block', (sim) => sim.soloPlayer.lookAtCell(0, T, -2, PY)],
    [
      'changing the selected slot',
      (sim) => {
        sim.soloPlayer.player.input.slot = (sim.soloPlayer.player.inventory.selected + 1) % 9;
      },
    ],
    ['swapping hands', (sim) => sim.soloPlayer.swapHands()],
    // Any write path that turns one glueable block straight into another: the time is the block's own.
    ['the block turning into another glueable block', (sim) => sim.world.setCell(0, T, -2, makeCell(B.IRON_BLOCK))],
  ];
  for (const [what, act] of cancels) {
    it(`${what} cancels it: no glue, none used, and it does not resume`, () => {
      const sim = scene(B.STONE);
      const n = ticksOf(B.STONE);
      sim.advance(n - 6);
      expect(sim.soloPlayer.view.gluing!.progress).toBeGreaterThan(0.5);
      act(sim);
      sim.tick();
      expect(sim.soloPlayer.view.gluing).toBeNull();
      // Back to the start: glue in hand, aimed at the same face, button held.
      const inv = sim.soloPlayer.player.inventory;
      if (inv.selectedStack()?.item !== I.GLUE) {
        if (inv.offhand?.item === I.GLUE) sim.soloPlayer.swapHands();
        else sim.soloPlayer.hold(I.GLUE);
      }
      sim.soloPlayer.lookAtCell(0, T, -2, PZ);
      sim.soloPlayer.player.input.use = true;
      sim.advance(3 * n);
      expect(sim.worldGlue.size).toBe(0);
      expect(sim.soloPlayer.player.inventory.count(I.GLUE)).toBe(3);
      expect(sim.soloPlayer.view.gluing).toBeNull();
    });
  }
});

describe('the off-hand swap command', () => {
  it('F swaps the selected hotbar stack with the off-hand stack, in both directions, also with an empty side', () => {
    const sim = flatSim({ mode: 'survival' });
    const inv = sim.soloPlayer.player.inventory;
    sim.soloPlayer.hold(I.GLUE, 5);
    const slot = inv.selected;
    expect(inv.offhand).toBeNull();
    sim.soloPlayer.swapHands();
    expect(inv.offhand).toBeNull(); // a command: nothing happens before the tick
    sim.tick();
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 5 });
    expect(inv.hotbar[slot]).toBeNull();
    sim.soloPlayer.hold(B.PLANKS_OAK, 20); // into the (now empty) selected slot
    expect(inv.selected).toBe(slot);
    sim.soloPlayer.swapHands();
    sim.tick();
    expect(inv.offhand).toEqual({ item: B.PLANKS_OAK, count: 20 });
    expect(inv.hotbar[slot]).toEqual({ item: I.GLUE, count: 5 });
    sim.soloPlayer.swapHands();
    sim.tick();
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 5 });
    expect(inv.hotbar[slot]).toEqual({ item: B.PLANKS_OAK, count: 20 });
    // Two presses in one tick swap there and back.
    sim.soloPlayer.swapHands();
    sim.soloPlayer.swapHands();
    sim.tick();
    expect(inv.offhand).toEqual({ item: I.GLUE, count: 5 });
    expect(sim.soloPlayer.player.input.swapPresses).toBe(0);
  });

  it('a dead player swaps nothing (the press is consumed)', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.soloPlayer.hold(I.GLUE, 5);
    sim.entities.kill(sim.soloPlayer.player, 'test');
    sim.soloPlayer.swapHands();
    sim.tick();
    expect(sim.soloPlayer.player.inventory.offhand).toBeNull();
    expect(sim.soloPlayer.player.input.swapPresses).toBe(0);
  });

  it('a swap drops a pending assembly preview, like changing the slot', () => {
    const sim = flatSim();
    for (let x = -1; x <= 1; x++) for (let z = -4; z <= -3; z++) sim.world.setCell(x, T, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(0, T + 1, -3, makeCell(B.HELM, facingState(NZ)));
    sim.soloPlayer.emptyHand();
    expect(sim.soloPlayer.useOn(0, T + 1, -3, PZ)).toBe(true);
    expect(sim.soloPlayer.view.preview?.kind).toBe('ship');
    sim.soloPlayer.swapHands();
    sim.tick();
    expect(sim.soloPlayer.view.preview).toBeNull();
  });

  it('pick block neither searches nor changes the off-hand', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.STONE));
    const inv = sim.soloPlayer.player.inventory;
    inv.offhand = { item: B.STONE, count: 9 };
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    expect(sim.soloPlayer.pickBlock()).toBe(false); // only in the off-hand: survival picks nothing
    expect(inv.offhand).toEqual({ item: B.STONE, count: 9 });
  });
});

describe('glue in the off-hand: placed blocks stick to the clicked face (DESIGN 副手)', () => {
  /** A stone at eye level; the main hand holds `item`, the off-hand glue (count). */
  function scene(mode: 'creative' | 'survival', item: number, glue: number) {
    const sim = flatSim({ mode });
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    const inv = sim.soloPlayer.player.inventory;
    inv.offhand = { item: I.GLUE, count: glue };
    sim.soloPlayer.hold(item, 32);
    return sim;
  }

  it('creative: the face between the clicked block and the placed one is glued, nothing consumed', () => {
    const sim = scene('creative', B.BRICKS, 4);
    expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.BRICKS);
    expect(sim.worldGlue.has(0, T, -3, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: I.GLUE, count: 4 });
  });

  it('survival: one glue from the off-hand per face; when it runs out later blocks are not glued', () => {
    const sim = scene('survival', B.BRICKS, 2);
    expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true); // (0,T,-2)
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: I.GLUE, count: 1 });
    expect(sim.soloPlayer.useOn(0, T, -3, PY)).toBe(true); // (0,T+1,-3)
    expect(sim.soloPlayer.player.inventory.offhand).toBeNull();
    sim.soloPlayer.hold(B.COBBLE, 8);
    expect(sim.soloPlayer.useOn(0, T, -2, PY)).toBe(true); // on the first brick: placed, not glued
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.COBBLE);
    expect(sim.worldGlue.has(0, T, -3, PZ)).toBe(true);
    expect(sim.worldGlue.has(0, T, -3, PY)).toBe(true);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(false);
    expect(sim.worldGlue.size).toBe(2);
    expect(sim.soloPlayer.player.inventory.count(B.BRICKS)).toBe(30);
  });

  it('blocks that already stick without glue are not glued (no glue spent)', () => {
    const sim = scene('survival', B.PLANKS_PINE, 3);
    sim.world.setCell(0, T, -3, makeCell(B.PLANKS_OAK)); // planks stick to any planks
    expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
    expect(idAt(sim.world, 0, T, -2)).toBe(B.PLANKS_PINE);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: I.GLUE, count: 3 });
  });

  it('a face already glued is not paid for twice', () => {
    const sim = scene('survival', B.BRICKS, 3);
    sim.worldGlue.add(0, T, -3, PZ);
    expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(1);
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: I.GLUE, count: 3 });
  });

  it('nothing is glued when the placed block cannot carry glue, or replaced the clicked block', () => {
    const sim = scene('survival', B.TORCH, 3);
    expect(sim.soloPlayer.useOn(0, T, -3, PY)).toBe(true);
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.TORCH);
    expect(sim.worldGlue.size).toBe(0);
    // A snow layer or tall grass is replaced in place by the block put on it: no face was
    // clicked against. Stone does not stick to stone, so only that rule keeps the clicked face
    // (now between the new stone and the open air) from being glued.
    const log = new EventLog(sim);
    sim.soloPlayer.hold(B.STONE, 8);
    sim.world.setCell(2, T, -3, makeCell(B.SNOW_LAYER, layersState(1)));
    expect(sim.soloPlayer.useOn(2, T, -3, PY)).toBe(true);
    expect(idAt(sim.world, 2, T, -3)).toBe(B.STONE);
    sim.world.setCell(-2, T, -3, makeCell(B.TALL_GRASS));
    expect(sim.soloPlayer.useOn(-2, T, -3, PZ)).toBe(true);
    expect(idAt(sim.world, -2, T, -3)).toBe(B.STONE);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: I.GLUE, count: 3 });
    expect(log.of('sound').map((e) => e.name)).not.toContain('glue');
  });

  it('other items in the off-hand have no effect', () => {
    const sim = scene('survival', B.BRICKS, 3);
    sim.soloPlayer.player.inventory.offhand = { item: B.STONE, count: 5 };
    expect(sim.soloPlayer.useOn(0, T, -3, PZ)).toBe(true);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.soloPlayer.player.inventory.offhand).toEqual({ item: B.STONE, count: 5 });
  });
});

describe('the glue lifetime rule on the game\'s write paths (a face keeps its glue while one side is glueable)', () => {
  it('an explosion that takes one side keeps the glue on the other; one that takes both removes it', () => {
    const sim = flatSim();
    const w = sim.world;
    fill(w, -12, T, -12, -12, T + 6, -12, B.OBSIDIAN); // blast-proof wall
    w.setCell(-11, T + 3, -12, makeCell(B.PLANKS_OAK));
    sim.worldGlue.add(-12, T + 3, -12, PX); // obsidian | planks
    explode(sim, -10.5, T + 3.5, -11.5, 4, null);
    expect(idAt(w, -11, T + 3, -12)).toBe(0);
    expect(idAt(w, -12, T + 3, -12)).toBe(B.OBSIDIAN);
    expect(sim.worldGlue.has(-12, T + 3, -12, PX)).toBe(true);

    w.setCell(8, T + 3, -8, makeCell(B.PLANKS_OAK));
    w.setCell(9, T + 3, -8, makeCell(B.PLANKS_OAK));
    sim.worldGlue.add(8, T + 3, -8, PX);
    explode(sim, 9, T + 3.5, -7.5, 4, null);
    expect(idAt(w, 8, T + 3, -8)).toBe(0);
    expect(idAt(w, 9, T + 3, -8)).toBe(0);
    expect(sim.worldGlue.has(8, T + 3, -8, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('a falling block takes no glue with it: the face it left keeps glue only if its other side is glueable', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(4, T + 3, -4, makeCell(B.SAND));
    w.setCell(4, T + 2, -4, makeCell(B.STONE)); // the support
    w.setCell(5, T + 3, -4, makeCell(B.STONE));
    sim.worldGlue.add(4, T + 3, -4, PX); // sand | stone
    sim.worldGlue.add(4, T + 3, -4, NZ); // sand | air
    w.setCell(4, T + 2, -4, 0); // the support goes: the sand falls
    sim.advance(40);
    expect(idAt(w, 4, T + 3, -4)).toBe(0);
    expect(idAt(w, 4, T, -4)).toBe(B.SAND);
    expect(sim.worldGlue.has(4, T + 3, -4, PX)).toBe(true); // still on the stone
    expect(sim.worldGlue.has(4, T + 3, -4, NZ)).toBe(false);
    expect(sim.worldGlue.size).toBe(1);
  });

  it('liquid flowing over a glued face changes nothing; a liquid is no glueable side', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(-4, T, -4, makeCell(B.STONE));
    sim.worldGlue.add(-4, T, -4, PY); // the stone's top
    w.setCell(-4, T + 1, -4, makeCell(B.WATER)); // a source on top of it, flowing out
    sim.advance(40);
    expect(idAt(w, -3, T, -4)).toBe(B.WATER);
    expect(sim.worldGlue.has(-4, T, -4, PY)).toBe(true);
    w.setCell(-4, T, -4, 0); // the stone goes: water on one side, air on the other
    expect(sim.worldGlue.size).toBe(0);
  });
});
