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
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.soloPlayer.player.input.attack = true;
    sim.advance(29);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.STONE);
    expect(sim.soloPlayer.view.mining!.progress).toBeGreaterThan(0.9);
    expect(sim.soloPlayer.view.mining!.progress).toBeLessThan(1);
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
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.soloPlayer.player.input.attack = true;
    sim.advance(9);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.DIRT);
    sim.tick(); // 10 ticks * 0.05 s = 0.5 s
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    sim.soloPlayer.player.input.attack = false;
    sim.tick();

    sim.world.setCell(0, FLAT_TOP, -2, makeCell(B.FLOWER_RED));
    sim.soloPlayer.lookAtCell(0, FLAT_TOP, -2);
    sim.soloPlayer.attack(); // a quick click: press without holding
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -2)).toBe(B.AIR);
    expect(items(sim, B.FLOWER_RED).entities).toBe(1);
  });

  it('survival: progress resets when the target changes or the button is released', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.STONE));
    const p = sim.soloPlayer.player;
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    p.input.attack = true;
    sim.advance(20);
    // look at the sky for a tick
    p.input.pitch = 1.4;
    sim.tick();
    expect(sim.soloPlayer.view.mining).toBeNull();
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
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
    const p = sim.soloPlayer.player;
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.soloPlayer.attack();
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
    sim.soloPlayer.attack();
    sim.tick();
    expect(idAt(sim.world, 0, Y, -4)).toBe(B.AIR);
  });

  it('survival: after a block breaks, holding on waits a moment before the next one starts', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, FLAT_TOP, -2, makeCell(B.FLOWER_RED));
    sim.world.setCell(0, FLAT_TOP, -3, makeCell(B.FLOWER_RED));
    const p = sim.soloPlayer.player;
    sim.soloPlayer.lookAt(0.5, FLAT_TOP + 0.5, -1.5);
    p.input.attack = true;
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -2)).toBe(B.AIR);
    sim.soloPlayer.lookAt(0.5, FLAT_TOP + 0.5, -2.5);
    sim.advance(BREAK_COOLDOWN - 1);
    expect(idAt(sim.world, 0, FLAT_TOP, -3)).toBe(B.FLOWER_RED);
    sim.tick();
    expect(idAt(sim.world, 0, FLAT_TOP, -3)).toBe(B.AIR);
  });

  it('unbreakable blocks cannot be mined, in either mode, and say so', () => {
    for (const mode of ['creative', 'survival'] as const) {
      const sim = flatSim({ mode });
      sim.world.setCell(0, Y, -2, makeCell(B.DEEPROCK));
      sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
      sim.soloPlayer.attack();
      sim.soloPlayer.player.input.attack = true;
      sim.advance(200);
      expect(idAt(sim.world, 0, Y, -2)).toBe(B.DEEPROCK);
      expect(sim.soloPlayer.view.hint?.key).toBe('hint.unbreakable');
      expect(sim.soloPlayer.view.mining).toBeNull();
    }
  });

  it('a dead player does nothing; presses are consumed; death and respawn let go of the buttons', () => {
    const sim = flatSim({ mode: 'survival' });
    sim.world.setCell(0, Y, -2, makeCell(B.DIRT));
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    const input = sim.soloPlayer.player.input;
    input.attack = true;
    input.use = true;
    sim.tick();
    sim.entities.kill(sim.soloPlayer.player, 'test');
    // Death lets go of both buttons (NETCODE section 10).
    expect(input.attack).toBe(false);
    expect(input.use).toBe(false);
    sim.soloPlayer.attack();
    input.attack = true;
    sim.advance(40);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.DIRT);
    expect(input.attackPresses).toBe(0);
    expect(sim.soloPlayer.view.target).toBeNull();
    // A button held through the respawn does not go on mining: it takes a new press.
    sim.soloPlayer.respawn();
    expect(input.attack).toBe(false);
    sim.soloPlayer.lookAtCell(0, Y, -2, PZ);
    sim.advance(10);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.DIRT);
    sim.soloPlayer.attack();
    input.attack = true;
    sim.advance(10);
    expect(idAt(sim.world, 0, Y, -2)).toBe(B.AIR);
    void NZ;
  });

  it('with a bucket in hand, a left-click digs through water like with any other item; the outline follows the dig', () => {
    const sim = flatSim({ mode: 'survival' });
    const T = FLAT_TOP;
    sim.advance(2);
    sim.world.setCell(0, T - 1, -1, makeCell(B.WATER, liquidState(0, false))); // a source in a one-cell pit
    sim.soloPlayer.hold(I.BUCKET, 1);
    sim.soloPlayer.lookAtCell(0, T - 2, -1, PY); // the dirt under the water, right in front of the feet
    sim.tick();
    // The bucket's use ray stops at the source (what a right-click would scoop).
    expect(sim.soloPlayer.view.target).toMatchObject({ gridId: 0, x: 0, y: T - 1, z: -1 });
    const m = sim.soloPlayer.mineTargetCell();
    expect(m && [m.gridId, m.x, m.y, m.z]).toEqual([0, 0, T - 2, -1]); // the left-click's ray does not
    sim.soloPlayer.player.input.attack = true;
    sim.soloPlayer.attack();
    sim.advance(5);
    expect(sim.soloPlayer.view.hint?.key).not.toBe('hint.unbreakable');
    expect(sim.soloPlayer.view.target).toMatchObject({ gridId: 0, x: 0, y: T - 2, z: -1, face: PY });
    expect(sim.soloPlayer.view.mining!.progress).toBeGreaterThan(0);
    sim.advance(10); // dirt: 0.5 s
    sim.soloPlayer.player.input.attack = false;
    expect(idAt(sim.world, 0, T - 2, -1)).not.toBe(B.DIRT); // (the water runs down into the hole)
    expect(items(sim, B.DIRT).entities).toBe(1);
    // The scripted helper digs with the same ray: the stone under the next pit, bucket in hand.
    sim.world.setCell(1, T - 1, -1, makeCell(B.WATER, liquidState(0, false)));
    sim.world.setCell(1, T - 2, -1, makeCell(B.STONE));
    sim.tick();
    expect(sim.soloPlayer.mine(1, T - 2, -1, PY)).toBe(true);
    expect(sim.soloPlayer.targetCell()).not.toMatchObject({ x: 1, y: T - 2, z: -1 }); // the bucket's ray stops at the water
    expect(sim.world.getCell(1, T - 2, -1) & 1023).not.toBe(B.STONE);
  });
});
