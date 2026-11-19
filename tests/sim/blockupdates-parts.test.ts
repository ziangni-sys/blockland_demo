/**
 * Block updates around partial cells (docs/SHAPES.md sections 9.2, 9.3, 9.7): torches, flowers
 * and snow cover need the top face of the cell below fully covered by hard material, in the world
 * and inside structures; sand rests on any hard part. Cells are written directly (the tools that
 * make partial blocks come in M2.4).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX } from '../../src/core/dirs';
import type { ItemEntity } from '../../src/entities/entity';
import { FALL_DELAY } from '../../src/sim/blockupdates';
import type { Simulation } from '../../src/sim/simulation';
import type { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { EAST, LOWER, UPPER, WEST, slab, stairFill } from '../shapes';
import { FLAT_TOP, SEA_TOP, fill, flatSim, idAt, items, seaSim } from './helpers';

const T = FLAT_TOP;

/** Item entities holding `item`. */
function itemEntities(sim: Simulation, item: number): ItemEntity[] {
  return sim.entities.all().filter((e): e is ItemEntity => e.kind === 'item' && !e.removed && (e as ItemEntity).stack.item === item);
}

describe('torches, flowers and snow cover on partial cells (world)', () => {
  it('stand on an upper slab, a full block and two halves that cover the top face; pop off a lower slab, a stair, a half', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    const below: Array<[number, boolean]> = [
      [makeCell(B.STONE), true],
      [slab(B.STONE, UPPER), true],
      [canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)), true],
      [canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)), true],
      [slab(B.STONE, LOWER), false],
      [slab(B.BRICKS, stairFill(PX)), false],
      [slab(B.PLANKS_OAK, WEST), false],
      [slab(B.IRON_BLOCK, 0x80), false],
    ];
    below.forEach(([c], i) => w.setCell(2 * i, T, -4, c));
    sim.tick();
    below.forEach((_, i) => w.setCell(2 * i, T + 1, -4, makeCell(B.TORCH)));
    sim.tick();
    below.forEach(([c, stands], i) => {
      expect(idAt(w, 2 * i, T + 1, -4), `torch on ${c}`).toBe(stands ? B.TORCH : B.AIR);
      expect(getPacked(w, 2 * i, T, -4), 'the cell below is untouched').toBe(c);
    });
    const popped = below.filter(([, s]) => !s).length;
    expect(items(sim, B.TORCH).count).toBe(popped);
  });

  it('flowers and snow cover follow the same rule (a grass tuft and snow cover drop nothing)', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    const soft = [B.FLOWER_RED, B.FLOWER_YELLOW, B.TALL_GRASS, B.SNOW_LAYER];
    soft.forEach((_id, i) => {
      w.setCell(i, T, -6, slab(B.STONE, LOWER));
      w.setCell(i, T, -8, slab(B.STONE, UPPER));
    });
    sim.tick();
    soft.forEach((id, i) => {
      w.setCell(i, T + 1, -6, makeCell(id));
      w.setCell(i, T + 1, -8, makeCell(id));
    });
    sim.tick();
    soft.forEach((id, i) => {
      expect(idAt(w, i, T + 1, -6)).toBe(B.AIR);
      expect(idAt(w, i, T + 1, -8)).toBe(id);
    });
    expect(items(sim, B.FLOWER_RED).count).toBe(1);
    expect(items(sim, B.FLOWER_YELLOW).count).toBe(1);
    expect(items(sim).count).toBe(2);
  });

  it('carving the top of the support (keeping its id) pops the torch; carving under the top face does not', () => {
    const sim = flatSim({ mode: 'survival' });
    const w = sim.world;
    w.setCell(0, T, -3, makeCell(B.PLANKS_OAK));
    w.setCell(2, T, -3, makeCell(B.PLANKS_OAK));
    w.setCell(0, T + 1, -3, makeCell(B.TORCH));
    w.setCell(2, T + 1, -3, makeCell(B.TORCH));
    sim.tick();
    w.setCell(0, T, -3, slab(B.PLANKS_OAK, 0x7f)); // octant 7 (upper, +X, +Z) carved out
    w.setCell(2, T, -3, slab(B.PLANKS_OAK, 0xfe)); // octant 0 (lower, -X, -Z) carved out
    sim.tick();
    expect(idAt(w, 0, T + 1, -3)).toBe(B.AIR);
    expect(idAt(w, 2, T + 1, -3)).toBe(B.TORCH);
    // One drop, at the centre of the torch's cell (a torch is a whole-cell model: DROP_POINT of 0xff).
    const drops = itemEntities(sim, B.TORCH);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.pos.x).toBeCloseTo(0.5, 1);
    expect(drops[0]!.pos.z).toBeCloseTo(-2.5, 1);
  });

  it('the second part that completes the top face holds the torch; removing it pops the torch', () => {
    const sim = flatSim({ mode: 'creative' });
    const w = sim.world;
    w.setCell(0, T, -3, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
    w.setCell(0, T + 1, -3, makeCell(B.TORCH));
    sim.tick();
    expect(idAt(w, 0, T + 1, -3)).toBe(B.TORCH);
    w.setCell(0, T, -3, slab(B.PLANKS_OAK, WEST)); // only the second part changed
    sim.tick();
    expect(idAt(w, 0, T + 1, -3)).toBe(B.AIR);
  });

  it('a torch over a lower slab and an upper octant pops; the two-part cell below keeps both parts', () => {
    const sim = flatSim({ mode: 'creative' });
    const w = sim.world;
    const c = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, 0x40));
    w.setCell(0, T, -3, c);
    w.setCell(0, T + 1, -3, makeCell(B.TORCH));
    sim.advance(3);
    expect(idAt(w, 0, T + 1, -3)).toBe(B.AIR);
    expect(getPacked(w, 0, T, -3)).toBe(c);
  });
});

/** A raft on the sea with a torch on its deck, assembled at its helm; returns the ship and the torch's local cell. */
function raftWithTorch(mode: 'survival' | 'creative'): { sim: Simulation; ship: Ship; at: [number, number, number] } {
  const sim = seaSim({ mode, spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } });
  const w = sim.world;
  fill(w, 0, 20, 6, 4, SEA_TOP - 1, 8, B.COBBLE);
  fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
  w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
  w.setCell(1, SEA_TOP, 1, makeCell(B.TORCH)); // joins the ship through its mounting face
  w.setCell(3, SEA_TOP, 1, makeCell(B.TORCH));
  const res = sim.structures.assembleShip(2, SEA_TOP, 4);
  if (!res.ok) throw new Error('assembly failed');
  expect(idAt(res.structure.grid, 1, SEA_TOP, 1)).toBe(B.TORCH);
  expect(idAt(res.structure.grid, 3, SEA_TOP, 1)).toBe(B.TORCH);
  sim.advance(5);
  return { sim, ship: res.structure, at: [1, SEA_TOP, 1] };
}

describe('torches on partial cells inside a structure', () => {
  it('carving the plank under a torch on a deck pops the torch (the plank keeps its id); carving below its top face does not', () => {
    const { sim, ship, at } = raftWithTorch('survival');
    const [x, y, z] = at;
    ship.grid.setCell(x, y - 1, z, slab(B.PLANKS_OAK, 0x7f));
    ship.grid.setCell(x + 2, y - 1, z, slab(B.PLANKS_OAK, 0xfe));
    sim.tick();
    expect(idAt(ship.grid, x, y, z)).toBe(B.AIR);
    expect(idAt(ship.grid, x + 2, y, z)).toBe(B.TORCH);
    expect(items(sim, B.TORCH).entities).toBe(1);
  });

  it('replacing the plank with a lower slab pops the torch; with an upper slab it stays', () => {
    const { sim, ship, at } = raftWithTorch('creative');
    const [x, y, z] = at;
    ship.grid.setCell(x, y - 1, z, slab(B.PLANKS_OAK, LOWER));
    ship.grid.setCell(x + 2, y - 1, z, slab(B.PLANKS_OAK, UPPER));
    sim.tick();
    expect(idAt(ship.grid, x, y, z)).toBe(B.AIR);
    expect(idAt(ship.grid, x + 2, y, z)).toBe(B.TORCH);
  });
});

describe('sand on partial cells (docs/SHAPES.md 9.3: sand rests on any hard part)', () => {
  it('sand directly on a lower slab, an upper slab, a single octant or a two-part cell stays a block and never falls', () => {
    const sim = flatSim({ mode: 'creative' });
    const w = sim.world;
    const supports = [slab(B.STONE, LOWER), slab(B.STONE, UPPER), slab(B.IRON_BLOCK, 0x01), slab(B.IRON_BLOCK, 0x80), canonCell(slab(B.STONE, WEST), slab(B.PLANKS_OAK, 0x80))];
    supports.forEach((c, i) => {
      w.setCell(2 * i, T + 3, -5, c); // in mid-air: the slabs themselves never fall
      w.setCell(2 * i, T + 4, -5, makeCell(B.SAND));
      w.setCell(2 * i, T + 5, -5, makeCell(B.GRAVEL));
    });
    sim.advance(FALL_DELAY + 10);
    supports.forEach((c, i) => {
      expect(getPacked(w, 2 * i, T + 3, -5)).toBe(c);
      expect(idAt(w, 2 * i, T + 4, -5)).toBe(B.SAND);
      expect(idAt(w, 2 * i, T + 5, -5)).toBe(B.GRAVEL);
    });
    expect(sim.entities.all().filter((e) => e.kind === 'falling')).toHaveLength(0);
  });

  it('sand whose support is carved away to the last octant stays; once the last part goes, it falls', () => {
    const sim = flatSim({ mode: 'creative' });
    const w = sim.world;
    w.setCell(0, T + 3, -5, makeCell(B.STONE));
    w.setCell(0, T + 4, -5, makeCell(B.SAND));
    sim.tick();
    w.setCell(0, T + 3, -5, slab(B.STONE, 0x20)); // one upper octant left
    sim.advance(FALL_DELAY + 3);
    expect(idAt(w, 0, T + 4, -5)).toBe(B.SAND);
    w.setCell(0, T + 3, -5, 0);
    sim.advance(FALL_DELAY + 1);
    expect(idAt(w, 0, T + 4, -5)).toBe(B.AIR);
    sim.advance(60);
    expect(idAt(w, 0, T, -5)).toBe(B.SAND); // landed on the turf
  });
});
