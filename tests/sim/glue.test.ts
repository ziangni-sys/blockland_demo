import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { PX, PY, PZ } from '../../src/core/dirs';
import { EventLog, FLAT_TOP, click, flatSim } from './helpers';

const T = FLAT_TOP;
const Y = T + 1; // eye level row

describe('superglue', () => {
  it('creative: two clicks glue a face, sneak on the second click removes it (ACCEPTANCE 4)', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(0, Y, -2, makeCell(B.STONE)); // A
    w.setCell(1, Y, -2, makeCell(B.STONE)); // B (stone never sticks by itself)
    const log = new EventLog(sim);
    sim.hold(I.GLUE, 1);
    sim.lookAtCell(0, Y, -2, PZ);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.glue.first');
    click(sim);
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: 0, y: Y, z: -2 });
    sim.lookAtCell(1, Y, -2, PZ);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.glue.apply');
    click(sim);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.view.glueAnchor).toBeNull();
    expect(log.toastKeys()).toContain('toast.glue.added');
    expect(sim.player.inventory.count(I.GLUE)).toBe(1); // creative: not consumed

    // Remove: A, then sneak + B.
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.player.input.sneak = true;
    sim.lookAtCell(1, Y, -2, PZ);
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.glue.remove');
    click(sim);
    sim.player.input.sneak = false;
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
    expect(sim.worldGlue.size).toBe(0);
  });

  it('mining either block removes the glue', () => {
    for (const mined of [0, 1]) {
      const sim = flatSim();
      const w = sim.world;
      w.setCell(0, Y, -2, makeCell(B.STONE));
      w.setCell(1, Y, -2, makeCell(B.STONE));
      sim.hold(I.GLUE);
      sim.lookAtCell(0, Y, -2, PZ);
      click(sim);
      sim.lookAtCell(1, Y, -2, PZ);
      click(sim);
      expect(sim.worldGlue.size).toBe(1);
      sim.hold(B.DIRT);
      sim.lookAtCell(mined, Y, -2, PZ);
      sim.attack();
      sim.tick();
      expect(sim.world.getCell(mined, Y, -2)).toBe(0);
      expect(sim.worldGlue.size).toBe(0);
    }
  });

  it('anchor moves to a non-adjacent block, clicking it again or a soft block clears it', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(0, Y, -2, makeCell(B.STONE));
    w.setCell(0, Y, -4, makeCell(B.STONE));
    w.setCell(-1, T, -2, makeCell(B.TORCH));
    sim.hold(I.GLUE);
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(1, T - 1, -2, PY); // ground, not adjacent: moves the anchor
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.glue.move');
    click(sim);
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: 1, y: T - 1, z: -2 });
    click(sim); // the anchor itself: deselect
    expect(sim.view.glueAnchor).toBeNull();
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(-1, T, -2); // a torch cannot carry glue
    sim.tick();
    expect(sim.view.hint?.key).toBe('hint.glue.cannot');
    click(sim);
    expect(sim.view.glueAnchor).toBeNull();
    expect(sim.worldGlue.size).toBe(0);
    // Holding something else clears the selection too.
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    expect(sim.view.glueAnchor).not.toBeNull();
    sim.hold(B.STONE);
    sim.tick();
    expect(sim.view.glueAnchor).toBeNull();
  });

  it('never on unbreakable blocks or liquids', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(0, Y, -2, makeCell(B.STONE));
    w.setCell(1, Y, -2, makeCell(B.DEEPROCK));
    sim.hold(I.GLUE);
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(1, Y, -2, PZ);
    click(sim);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.view.glueAnchor).toBeNull();
  });

  it('survival: takes the slower block\'s mining time while held, consumes exactly one (ACCEPTANCE 5)', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    w.setCell(0, Y, -2, makeCell(B.PLANKS_OAK)); // 1.5 s
    w.setCell(1, Y, -2, makeCell(B.GLASS)); // 0.3 s
    sim.hold(I.GLUE, 3);
    const p = sim.player;
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(1, Y, -2, PZ);
    p.input.use = true;
    sim.use();
    sim.advance(29);
    expect(sim.worldGlue.size).toBe(0);
    expect(sim.view.glueProgress).toBeCloseTo(29 / 30, 5);
    expect(sim.view.hint?.key).toBe('hint.glue.working');
    sim.tick();
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(p.inventory.count(I.GLUE)).toBe(2);
    p.input.use = false;
    sim.tick();

    // Looking away cancels (the anchor stays); nothing is consumed.
    w.setCell(0, Y + 1, -2, makeCell(B.PLANKS_OAK)); // C, on top of A
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(0, Y + 1, -2, PZ);
    p.input.use = true;
    sim.use();
    sim.advance(10);
    expect(sim.view.glueProgress).toBeGreaterThan(0.2);
    p.input.pitch = 1.3; // the sky
    sim.tick();
    expect(sim.view.glueProgress).toBe(0);
    sim.lookAtCell(0, Y + 1, -2, PZ);
    sim.advance(40); // still holding, but the step was cancelled: it needs a new click
    expect(sim.worldGlue.size).toBe(1);
    expect(p.inventory.count(I.GLUE)).toBe(2);
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: 0, y: Y, z: -2 });

    // Letting go cancels as well.
    sim.use();
    sim.advance(5);
    p.input.use = false;
    sim.advance(40);
    expect(sim.worldGlue.size).toBe(1);

    // Removing is free but takes the same time.
    p.input.sneak = true;
    p.input.use = true;
    sim.lookAtCell(0, Y, -2, PZ);
    sim.use();
    sim.tick(); // A is still the anchor: clicking it deselects...
    expect(sim.view.glueAnchor).toBeNull();
    sim.lookAtCell(0, Y, -2, PZ); // ...and the next click picks it again
    sim.use();
    sim.tick();
    expect(sim.view.glueAnchor).toEqual({ gridId: 0, x: 0, y: Y, z: -2 });
    sim.lookAtCell(1, Y, -2, PZ);
    sim.use();
    sim.advance(29);
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(true);
    expect(sim.view.hint?.key).toBe('hint.glue.unglueWorking');
    sim.tick();
    expect(sim.worldGlue.has(0, Y, -2, PX)).toBe(false);
    expect(p.inventory.count(I.GLUE)).toBe(2);
  });

  it('creative gluing is instant', () => {
    const sim = flatSim();
    const w = sim.world;
    w.setCell(0, Y, -2, makeCell(B.IRON_BLOCK)); // 5 s in survival
    w.setCell(1, Y, -2, makeCell(B.IRON_BLOCK));
    sim.hold(I.GLUE);
    sim.lookAtCell(0, Y, -2, PZ);
    click(sim);
    sim.lookAtCell(1, Y, -2, PZ);
    click(sim);
    expect(sim.worldGlue.size).toBe(1);
  });
});
