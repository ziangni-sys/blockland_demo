/**
 * Glue next to partial cells (docs/SHAPES.md 6.2, 10.3; P8b): glue belongs to a CELL face, so an
 * inner face (the top of a lower slab) refuses glue and its removal (toast.glue.inner); two cells
 * that touch on the face (their hard covers overlap) cannot be glued directly (toast.glue.touching:
 * DESIGN "已经挨着的两块不能直接粘", reachable now that a face can be half covered); a cell across
 * whose material does not touch the face leaves it open; the off-hand glue needs the placed block
 * to touch the clicked one; the survival time is the hardness of the part clicked. And docking
 * refused because a cell would hold three parts says so (toast.dock.twoParts, docs/SHAPES.md 11.3).
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { canonCell } from '../../src/blocks/shapes';
import { PX, PY, PZ } from '../../src/core/dirs';
import { LOWER, slab, UPPER } from '../shapes';
import { EventLog, FLAT_TOP, fill, flatSim, idAt } from './helpers';

const T = FLAT_TOP;

describe('glue on partial cells (main hand)', () => {
  it('an inner face refuses glue, and its removal, with toast.glue.inner; the crosshair hint promises neither', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    sim.world.setCell(0, T, -2, slab(B.PLANKS_OAK, LOWER));
    me.hold(I.GLUE);
    expect(me.aimAt(0, T, -2, PY, 0, false, 4)).toBe(true); // the slab's top, at y + 0.5
    sim.tick();
    expect(me.view.hint).toBeNull(); // not hint.glue.apply
    me.use();
    sim.tick();
    expect(log.toastKeys()).toEqual(['toast.glue.inner']);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(false);
    // Glue on the cell's top face (y + 1) cannot be removed through the inner face either.
    sim.worldGlue.add(0, T, -2, PY);
    log.clear();
    sim.tick();
    expect(me.view.hint).toBeNull(); // not hint.glue.already
    me.player.input.sneak = true;
    expect(me.aimAt(0, T, -2, PY, 0, false, 4)).toBe(true);
    sim.tick();
    expect(me.view.hint).toBeNull(); // not hint.glue.remove
    me.use();
    sim.tick();
    me.player.input.sneak = false;
    expect(log.toastKeys()).toEqual(['toast.glue.inner']);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(true);
  });

  it('two cells that touch on the face cannot be glued (toast.glue.touching, and no hint promises it); removing glue there works', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    // A full block, and in front of its +Z face a lower slab: the face's upper half is exposed.
    sim.world.setCell(0, T, -2, makeCell(B.PLANKS_OAK));
    sim.world.setCell(0, T, -1, slab(B.PLANKS_OAK, LOWER));
    me.hold(I.GLUE);
    expect(me.aimAt(0, T, -2, PZ, 0, false, 6)).toBe(true);
    sim.tick();
    expect(me.view.hint).toBeNull(); // not hint.glue.apply
    me.use();
    sim.tick();
    expect(log.toastKeys()).toEqual(['toast.glue.touching']);
    expect(sim.worldGlue.has(0, T, -2, PZ)).toBe(false);
    // Glued before the slab came (it was placed against the glued face): sneak removes it.
    sim.worldGlue.add(0, T, -2, PZ);
    log.clear();
    sim.tick();
    expect(me.view.hint?.key).toBe('hint.glue.already'); // as the click answers (toast.glue.already)
    me.player.input.sneak = true;
    expect(me.aimAt(0, T, -2, PZ, 0, false, 6)).toBe(true);
    sim.tick();
    expect(me.view.hint?.key).toBe('hint.glue.remove');
    me.use();
    sim.tick();
    me.player.input.sneak = false;
    expect(log.toastKeys()).toEqual(['toast.glue.removed']);
    expect(sim.worldGlue.has(0, T, -2, PZ)).toBe(false);
  });

  it('a cell across with material only away from the face does not touch it: the face is glued', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    // An upper slab above a full block: the block's top face is seen through the slab's empty lower half.
    sim.world.setCell(0, T, -2, makeCell(B.PLANKS_OAK));
    sim.world.setCell(0, T + 1, -2, slab(B.PLANKS_OAK, UPPER));
    me.hold(I.GLUE);
    me.lookAt(0.25, T + 0.99, -1.75);
    expect(me.targetCell()).toMatchObject({ x: 0, y: T, z: -2, face: PY });
    sim.tick();
    expect(me.view.hint?.key).toBe('hint.glue.apply');
    me.use();
    sim.tick();
    expect(log.toastKeys()).toEqual(['toast.glue.added']);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(true);
  });

  it('a lower slab beside an upper slab: they only meet along a line, so the face between them can be glued', () => {
    const sim = flatSim();
    const me = sim.soloPlayer;
    const log = new EventLog(sim);
    // On a stone pillar, level with the eyes: the lower slab's +X face is seen through the upper slab's empty lower half.
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    sim.world.setCell(1, T, -2, makeCell(B.STONE));
    sim.world.setCell(0, T + 1, -2, slab(B.PLANKS_OAK, LOWER));
    sim.world.setCell(1, T + 1, -2, slab(B.PLANKS_OAK, UPPER));
    me.teleport(3.5, T, -1.5);
    me.hold(I.GLUE);
    expect(me.aimAt(0, T + 1, -2, PX, 0, false, 5)).toBe(true);
    me.use();
    sim.tick();
    expect(log.toastKeys()).toEqual(['toast.glue.added']);
    expect(sim.worldGlue.has(0, T + 1, -2, PX)).toBe(true);
  });

  it('survival: the gluing takes the hardness of the part clicked, not of the cell\'s first part', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = sim.soloPlayer;
    // Glass below (0.3 s, the first part), bricks above (2 s = 40 ticks): the top face belongs to the bricks.
    sim.world.setCell(0, T, -2, canonCell(slab(B.GLASS, LOWER), slab(B.BRICKS, UPPER)));
    me.hold(I.GLUE, 4);
    expect(me.aimAt(0, T, -2, PY, 0, false, 6)).toBe(true);
    me.player.input.use = true;
    me.use();
    sim.advance(20);
    expect(me.view.gluing).toEqual({ gridId: 0, x: 0, y: T, z: -2, face: PY, sub: 0, progress: expect.closeTo(20 / 40, 6) });
    sim.advance(20);
    me.player.input.use = false;
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(true);
    expect(me.player.inventory.count(I.GLUE)).toBe(3);
  });
});

describe('what the hands prepare is dropped when a cell changes only its shape (docs/SHAPES.md 6.2)', () => {
  it('a timed glue operation stops when the other part of the cell is chiselled; an assembly preview is dropped when a deck cell loses an octant', () => {
    const sim = flatSim({ mode: 'survival', spawn: { x: 4.5, y: T, z: 4.5 } });
    const me = sim.soloPlayer;
    sim.world.setCell(4, T, 2, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.STONE, UPPER)));
    me.hold(I.GLUE, 4);
    expect(me.aimAt(4, T, 2, PZ, 0, false, 6)).toBe(true);
    me.player.input.use = true;
    me.use();
    sim.advance(5);
    expect(me.view.gluing).not.toBeNull();
    sim.world.setCell(4, T, 2, canonCell(slab(B.PLANKS_OAK, LOWER & 0xfe), slab(B.STONE, UPPER)));
    sim.tick();
    expect(me.view.gluing).toBeNull();
    me.player.input.use = false;
    // A helm on a deck: the preview, then one deck cell chiselled (no id changes): the preview goes.
    fill(sim.world, 0, T, 0, 2, T, 1, B.PLANKS_OAK);
    sim.world.setCell(1, T + 1, 1, makeCell(B.HELM));
    me.emptyHand();
    expect(me.useOn(1, T + 1, 1, PZ)).toBe(true);
    expect(me.view.preview).not.toBeNull();
    sim.world.setCell(0, T, 0, slab(B.PLANKS_OAK, 0xfe));
    sim.tick();
    expect(me.view.preview).toBeNull();
  });
});

describe('the off-hand glue needs the two cells to touch', () => {
  it('a block put on the top of a lower slab (half a block above it) is not glued and costs nothing; one put on an upper slab is', () => {
    const sim = flatSim({ mode: 'survival' });
    const me = sim.soloPlayer;
    const inv = me.player.inventory;
    // Stone slabs under planks: they do not stick without glue (planks on planks would).
    sim.world.setCell(0, T, -2, slab(B.STONE, LOWER));
    sim.world.setCell(1, T, -2, slab(B.STONE, UPPER));
    me.hold(B.PLANKS_OAK, 10);
    inv.offhand = { item: I.GLUE, count: 5 };
    expect(me.aimAt(0, T, -2, PY, 0, false, 4)).toBe(true);
    me.use();
    sim.tick();
    expect(idAt(sim.world, 0, T + 1, -2)).toBe(B.PLANKS_OAK);
    expect(sim.worldGlue.has(0, T, -2, PY)).toBe(false);
    expect(inv.offhand?.count).toBe(5);
    expect(me.aimAt(1, T, -2, PY, 0, false, 7)).toBe(true);
    me.use();
    sim.tick();
    expect(idAt(sim.world, 1, T + 1, -2)).toBe(B.PLANKS_OAK);
    expect(sim.worldGlue.has(1, T, -2, PY)).toBe(true);
    expect(inv.offhand?.count).toBe(4);
  });
});

describe('docking into cells that would hold three parts', () => {
  it('says why (toast.dock.twoParts with the count); an ordinary conflict keeps toast.dock.blocked', () => {
    const sim = flatSim({ spawn: { x: 4.5, y: T, z: 4.5 } });
    sim.structures.dynamics = null; // the raft hovers exactly where it was built
    const w = sim.world;
    fill(w, 0, T + 1, 0, 2, T + 1, 2, B.PLANKS_OAK);
    w.setCell(1, T + 2, 2, makeCell(B.HELM));
    const res = sim.structures.assembleShip(1, T + 2, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    // A deck cell chiselled down to octant 0; the world cell it lands on holds two parts beside it.
    ship.grid.setCell(0, T + 1, 0, slab(B.PLANKS_OAK, 0x01));
    w.setCell(0, T + 1, 0, canonCell(slab(B.STONE, 0x02), slab(B.GLASS, 0x04)));
    sim.tick();
    const log = new EventLog(sim);
    const me = sim.soloPlayer;
    me.emptyHand();
    me.player.input.sneak = true;
    expect(me.useOn(1, T + 2, 2, PZ, ship.id)).toBe(true);
    expect(ship.removed).toBe(false);
    expect(log.toasts()).toEqual([{ key: 'toast.dock.twoParts', params: { count: 1 } }]);
    expect(me.view.conflicts).toEqual([{ x: 0, y: T + 1, z: 0 }]);
    // An overlap instead: the ordinary message.
    w.setCell(0, T + 1, 0, makeCell(B.STONE));
    sim.tick();
    log.clear();
    expect(me.useOn(1, T + 2, 2, PZ, ship.id)).toBe(true);
    me.player.input.sneak = false;
    expect(ship.removed).toBe(false);
    expect(log.toasts()).toEqual([{ key: 'toast.dock.blocked', params: { count: 1 } }]);
  });
});
