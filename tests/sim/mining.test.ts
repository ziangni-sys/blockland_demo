import { describe, expect, it } from 'vitest';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PY, PZ } from '../../src/core/dirs';
import { I } from '../../src/blocks/items';
import { BREAK_COOLDOWN, CREATIVE_BREAK_INTERVAL } from '../../src/sim/interact';
import { EventLog, FLAT_TOP, flatSim, idAt, items } from './helpers';

const Y = FLAT_TOP + 1; // eye-level row (the eye is at FLAT_TOP + 1.62)

describe('mining', () => {
  it('survival: stone takes hardness / TICK_DT ticks of holding, then drops rubble at the cell', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.STONE));
    const log = new EventLog(sim);
    sim.lookAtCell(0, Y, -2, PZ);
    sim.player.input.attack = true;
    sim.advance(29);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.STONE);
    expect(sim.view.breakProgress).toBeGreaterThan(0.9);
    expect(sim.view.breakProgress).toBeLessThan(1);
    sim.tick();
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    const broken = log.of('blockBroken');
    expect(broken.length).toBe(1);
    expect(broken[0]).toMatchObject({ gridId: 0, x: 0, y: Y, z: -2 });
    // Stone drops rubble (BlockDef.drop), at the centre of the cell.
    expect(items(sim, B.COBBLE).entities).toBe(1);
    const drop = sim.entities.all().find((e) => e.kind === 'item')!;
    expect(drop.pos.x).toBeCloseTo(0.5, 1);
    expect(drop.pos.z).toBeCloseTo(-1.5, 1);
  });

  it('survival: dirt is faster than stone; hardness 0 breaks on the first tick', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.DIRT));
    sim.lookAtCell(0, Y, -2, PZ);
    sim.player.input.attack = true;
    sim.advance(9);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.DIRT);
    sim.tick(); // 10 ticks * 0.05 s = 0.5 s
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    sim.player.input.attack = false;
    sim.tick();

    sim.world.setCell(0, FLAT_TOP, -2, makeCell(B.FLOWER_RED));
    sim.lookAtCell(0, FLAT_TOP, -2);
    sim.attack(); // a quick click: press without holding
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -2)).toBe(B.AIR);
    expect(items(sim, B.FLOWER_RED).entities).toBe(1);
  });

  it('survival: progress resets when the target changes or the button is released', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.STONE));
    const p = sim.player;
    sim.lookAtCell(0, Y, -2, PZ);
    p.input.attack = true;
    sim.advance(20);
    // look at the sky for a tick
    p.input.pitch = 1.4;
    sim.tick();
    expect(sim.view.breakProgress).toBe(0);
    sim.lookAtCell(0, Y, -2, PZ);
    sim.advance(29);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.STONE);
    // release
    p.input.attack = false;
    sim.tick();
    p.input.attack = true;
    sim.advance(29);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.STONE);
    sim.tick();
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
  });

  it('creative: instant on the press, then one block every few ticks while held; no drops', () => {
    const sim = flatSim({ mode: 'creative' });
    for (let z = -2; z >= -4; z--) sim.world.setCell(0, Y, z, makeCell(B.STONE));
    const p = sim.player;
    sim.lookAtCell(0, Y, -2, PZ);
    sim.attack();
    p.input.attack = true;
    sim.tick();
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    expect(idAt(sim.world, 0, Y, -3)).toBe(B.STONE);
    sim.advance(CREATIVE_BREAK_INTERVAL - 1);
    expect(idAt(sim.world, 0, Y, -3)).toBe(B.STONE);
    sim.tick();
    expect(idAt(sim.world, 0, Y, -3)).toBe(B.AIR);
    expect(items(sim).entities).toBe(0);
    // A fresh press is always instant.
    p.input.attack = false;
    sim.tick();
    sim.attack();
    sim.tick();
    expect(idAt(sim.world, 0, Y, -4)).toBe(B.AIR);
  });

  it('survival: after a block breaks, holding on waits a moment before the next one starts', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, FLAT_TOP, -2, makeCell(B.FLOWER_RED));
    sim.world.setCell(0, FLAT_TOP, -3, makeCell(B.FLOWER_RED));
    const p = sim.player;
    sim.lookAt(0.5, FLAT_TOP + 0.5, -1.5);
    p.input.attack = true;
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -2)).toBe(B.AIR);
    sim.lookAt(0.5, FLAT_TOP + 0.5, -2.5);
    sim.advance(BREAK_COOLDOWN - 1);
    expect(idAt(sim.world, 0, FLAT_TOP, -3)).toBe(B.FLOWER_RED);
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -3)).toBe(B.AIR);
  });

  it('unbreakable blocks cannot be mined, in either mode, and say so', () => {
    for (const mode of ['creative', 'survival'] as const) {
      const sim = flatSim({ mode });
      sim.world.setCell(0, Y, -2, makeCell(B.DEEPROCK));
      sim.lookAtCell(0, Y, -2, PZ);
      sim.attack();
      sim.player.input.attack = true;
      sim.advance(200);
      expect(idAt(sim.world, 0, Y, -2)).toBe(B.DEEPROCK);
      expect(sim.view.hint?.key).toBe('hint.unbreakable');
      expect(sim.view.breakProgress).toBe(0);
    }
  });

  it('a dead player does nothing; presses are consumed', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.DIRT));
    sim.lookAtCell(0, Y, -2, PZ);
    sim.entities.kill(sim.player, 'test');
    sim.attack();
    sim.player.input.attack = true;
    sim.advance(40);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.DIRT);
    expect(sim.player.input.attackPresses).toBe(0);
    expect(sim.view.target).toBeNull();
    sim.respawn();
    sim.lookAtCell(0, Y, -2, PZ);
    sim.advance(10);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    void NZ;
  });

  it('with a bucket in hand, a left-click digs through water like with any other item; the outline follows the dig', () => {
    const sim = flatSim({ mode: 'survival' });
    const T = FLAT_TOP;
    sim.advance(2);
    sim.world.setCell(0, T - 1, -1, makeCell(B.WATER, liquidState(0, false))); // a source in a one-cell pit
    sim.hold(I.BUCKET, 1);
    sim.lookAtCell(0, T - 2, -1, PY); // the dirt under the water, right in front of the feet
    sim.tick();
    // The bucket's use ray stops at the source (what a right-click would scoop).
    expect(sim.view.target).toMatchObject({ gridId: 0, x: 0, y: T - 1, z: -1 });
    const m = sim.interaction.raycastMining();
    expect(m && [m.grid.gridId, m.x, m.y, m.z]).toEqual([0, 0, T - 2, -1]); // the left-click's ray does not
    sim.player.input.attack = true;
    sim.attack();
    sim.advance(5);
    expect(sim.view.hint?.key).not.toBe('hint.unbreakable');
    expect(sim.view.target).toMatchObject({ gridId: 0, x: 0, y: T - 2, z: -1, face: PY });
    expect(sim.view.breakProgress).toBeGreaterThan(0);
    sim.advance(10); // dirt: 0.5 s
    sim.player.input.attack = false;
    expect(idAt(sim.world, 0, T - 2, -1)).not.toBe(B.DIRT); // (the water runs down into the hole)
    expect(items(sim, B.DIRT).entities).toBe(1);
    // The scripted helper digs with the same ray: the stone under the next pit, bucket in hand.
    sim.world.setCell(1, T - 1, -1, makeCell(B.WATER, liquidState(0, false)));
    sim.world.setCell(1, T - 2, -1, makeCell(B.STONE));
    sim.tick();
    expect(sim.mine(1, T - 2, -1, PY)).toBe(true);
    expect(sim.targetCell()).not.toMatchObject({ x: 1, y: T - 2, z: -1 }); // the bucket's ray stops at the water
    expect(sim.world.getCell(1, T - 2, -1) & 1023).not.toBe(B.STONE);
  });
});
