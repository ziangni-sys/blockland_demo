/**
 * Explosions break parts, not cells (docs/SHAPES.md section 9.4): a ray pays for the part filling
 * the octant its sample point is in (an empty octant costs nothing), marks octants, and the blast
 * removes every part a marked octant belongs to, in one write per cell, with one drop roll per part.
 * Ships are pushed in proportion to the volume of their cells. World water in a ship's hull is free
 * only where the point is in a hard octant of the ship (or its dry hold).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell, DROP_POINT } from '../../src/blocks/shapes';
import { NZ } from '../../src/core/dirs';
import type { Vec3 } from '../../src/core/math';
import type { ItemEntity } from '../../src/entities/entity';
import { explode } from '../../src/sim/explosion';
import type { Simulation } from '../../src/sim/simulation';
import type { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, UPPER, slab } from '../shapes';
import { FLAT_TOP, SEA_TOP, fill, flatSim, idAt, seaSim } from './helpers';

const T = FLAT_TOP;

/** A cell at (0, T - 1, -4) boxed in by obsidian on four sides and below, open to the sky. */
function boxedCell(sim: Simulation, cell: number): void {
  const w = sim.world;
  fill(w, -1, T - 2, -5, 1, T - 1, -3, B.OBSIDIAN);
  w.setCell(0, T - 1, -4, cell);
}

describe('explosions break the parts the rays reach', () => {
  it('an obsidian upper slab shields the dirt slab under it in the same cell; a dirt upper slab goes, the obsidian lower slab stays', () => {
    const shielded = flatSim({ seed: 41 });
    shielded.soloPlayer.teleport(30.5, T, 30.5);
    const c1 = canonCell(slab(B.DIRT, LOWER), slab(B.OBSIDIAN, UPPER));
    boxedCell(shielded, c1);
    explode(shielded, 0.5, T + 1, -3.5, 4, null);
    expect(getPacked(shielded.world, 0, T - 1, -4)).toBe(c1);

    const exposed = flatSim({ seed: 41 });
    exposed.soloPlayer.teleport(30.5, T, 30.5);
    boxedCell(exposed, canonCell(slab(B.OBSIDIAN, LOWER), slab(B.DIRT, UPPER)));
    explode(exposed, 0.5, T + 1, -3.5, 4, null);
    expect(getPacked(exposed.world, 0, T - 1, -4)).toBe(slab(B.OBSIDIAN, LOWER));
  });

  it('empty octants cost nothing: a wall of obsidian upper slabs lets the low rays through to the dirt behind it, a full wall does not', () => {
    const behind = (wall: number): number => {
      const sim = flatSim({ seed: 5 });
      sim.soloPlayer.teleport(20.5, T, 20.5);
      const w = sim.world;
      fill(w, -3, T, -2, 3, T, -2, wall);
      fill(w, -3, T + 1, -2, 3, T + 4, -2, B.OBSIDIAN);
      w.setCell(0, T, -3, makeCell(B.DIRT));
      explode(sim, 0.5, T + 0.25, 0.5, 4, null);
      expect(idAt(w, 0, T, -2), 'the wall stands').toBe(B.OBSIDIAN);
      return idAt(w, 0, T, -3);
    };
    expect(behind(makeCell(B.OBSIDIAN))).toBe(B.DIRT);
    expect(behind(slab(B.OBSIDIAN, UPPER))).toBe(B.AIR);
  });

  it('both parts in reach go with one write; each drops on its own roll (two drops at their DROP_POINTs) and draws once from the rng', () => {
    const run = (drops: boolean) => {
      const sim = flatSim({ seed: 61, mode: drops ? 'survival' : 'creative' });
      sim.soloPlayer.teleport(30.5, T, 30.5);
      sim.advance(2);
      const y = T + 6;
      const c = canonCell(slab(B.DIRT, LOWER), slab(B.WOOL_RED, UPPER));
      sim.world.setCell(0, y, 0, c);
      let writes = 0;
      const off = sim.world.onCellChange((x, yy, z) => {
        if (x === 0 && yy === y && z === 0) writes++;
      });
      let draws = 0;
      const next = sim.rng.next.bind(sim.rng);
      sim.rng.next = () => (draws++, next());
      explode(sim, 0.5, y + 0.5, 0.5, 1, null); // power 1: every removed part drops
      sim.rng.next = next;
      off();
      expect(sim.world.getCell(0, y, 0)).toBe(0);
      expect(writes).toBe(1);
      const items = sim.entities.all().filter((e): e is ItemEntity => e.kind === 'item' && !e.removed);
      return { draws, items };
    };
    // Spawning an item draws a random pop velocity: count those draws once.
    const probe = flatSim({ seed: 1 });
    let spawnDraws = 0;
    const next = probe.rng.next.bind(probe.rng);
    probe.rng.next = () => (spawnDraws++, next());
    probe.entities.spawnItem(0, 50, 0, B.DIRT, 1);
    probe.rng.next = next;

    const quiet = run(false);
    expect(quiet.items).toHaveLength(0);
    const loud = run(true);
    // One draw per ray, then per removed part one roll plus the item's own draws.
    expect(loud.draws - quiet.draws).toBe(2 * (1 + spawnDraws));
    const byItem = new Map(loud.items.map((e) => [e.stack.item, e]));
    expect([...byItem.keys()].sort((a, b) => a - b)).toEqual([B.DIRT, B.WOOL_RED].sort((a, b) => a - b));
    for (const [item, fill] of [
      [B.DIRT, LOWER],
      [B.WOOL_RED, UPPER],
    ] as const) {
      const b = byItem.get(item)!.box();
      expect((b.minX + b.maxX) / 2).toBeCloseTo(DROP_POINT[fill * 3]!, 9);
      expect((b.minY + b.maxY) / 2).toBeCloseTo(T + 6 + DROP_POINT[fill * 3 + 1]!, 9);
      expect((b.minZ + b.maxZ) / 2).toBeCloseTo(DROP_POINT[fill * 3 + 2]!, 9);
    }
  });

  it('a blast crate (never a part) still becomes a primed crate', () => {
    const sim = flatSim({ seed: 9 });
    sim.soloPlayer.teleport(20.5, T, 20.5);
    sim.world.setCell(1, T, 0, makeCell(B.TNT));
    sim.world.setCell(-1, T, 0, slab(B.STONE, LOWER));
    explode(sim, 0.5, T + 0.5, 0.5, 4, null);
    expect(idAt(sim.world, 1, T, 0)).toBe(B.AIR);
    expect(sim.entities.all().filter((e) => e.kind === 'tnt')).toHaveLength(1);
  });
});

/**
 * A row of 12 cells on the flat ground, a helm at its far end; the near 8 cells are `near`, the
 * rest full planks; `top`, when given, stands on the fourth cell.
 */
function rowShip(near: number, top = 0): { sim: Simulation; ship: Ship } {
  const sim = flatSim({ seed: 71, spawn: { x: 5.5, y: T, z: 8.5 } });
  const w = sim.world;
  for (let x = 0; x < 12; x++) w.setCell(x, T, 0, x < 8 ? near : makeCell(B.PLANKS_OAK));
  w.setCell(11, T + 1, 0, makeCell(B.HELM, facingState(NZ)));
  if (top !== 0) w.setCell(3, T + 1, 0, top);
  // A world wall between the blast and the ship: rays never reach the ship, the push does.
  fill(w, -1, T - 1, -2, -1, T + 2, 2, B.OBSIDIAN);
  const res = sim.structures.assembleShip(11, T + 1, 0);
  if (!res.ok) throw new Error(`assembly failed: ${JSON.stringify(res)}`);
  return { sim, ship: res.structure };
}

describe('ships are pushed in proportion to the volume of their cells', () => {
  /** The impulse explode() gives the row ship, and where. */
  const push = (near: number, top = 0): { at: Vec3; imp: Vec3 } => {
    const { sim, ship } = rowShip(near, top);
    const cells = ship.grid.count;
    let got: { at: Vec3; imp: Vec3 } | null = null;
    const apply = sim.dynamics.applyImpulse.bind(sim.dynamics);
    sim.dynamics.applyImpulse = (s, at, imp) => {
      if (s === ship) got = { at: { ...at }, imp: { ...imp } };
      apply(s, at, imp);
    };
    explode(sim, -2.5, T + 0.5, 0.5, 4, null);
    expect(ship.grid.count, 'no cell of the ship was destroyed').toBe(cells);
    if (got === null) throw new Error('the ship was not pushed');
    return got;
  };

  it('a ship of lower slabs gets exactly half the impulse of the same ship of full planks, at the same point', () => {
    const full = push(makeCell(B.PLANKS_OAK));
    const half = push(slab(B.PLANKS_OAK, LOWER));
    expect(full.imp.x).toBeGreaterThan(0);
    expect(half.imp).toEqual({ x: full.imp.x / 2, y: full.imp.y / 2, z: full.imp.z / 2 });
    expect(half.at).toEqual(full.at);
  });

  it('a whole-cell model (a torch: no hard octant) still counts as one cell, as it did before partial cells', () => {
    const withTorch = push(makeCell(B.PLANKS_OAK), makeCell(B.TORCH));
    const withPlank = push(makeCell(B.PLANKS_OAK), makeCell(B.PLANKS_OAK));
    const without = push(makeCell(B.PLANKS_OAK));
    expect(withTorch).toEqual(withPlank);
    expect(withTorch.imp).not.toEqual(without.imp);
  });
});

describe('world water inside a ship hull', () => {
  /** A two-cell raft floating at the sea surface: a plank under the helm, and `cell` east of it. */
  function raft(cell: number): Simulation {
    const sim = seaSim({ seed: 16, spawn: { x: 10.5, y: SEA_TOP + 20, z: 10.5 } });
    sim.soloPlayer.player.flying = true;
    const w = sim.world;
    w.setCell(1, SEA_TOP - 1, 0, makeCell(B.PLANKS_OAK));
    w.setCell(2, SEA_TOP - 1, 0, cell);
    w.setCell(1, SEA_TOP, 0, makeCell(B.HELM, facingState(NZ)));
    const res = sim.structures.assembleShip(1, SEA_TOP, 0);
    if (!res.ok) throw new Error('assembly failed');
    sim.structures.dynamics = null; // keep it in place
    expect(idAt(w, 2, SEA_TOP - 1, 0), 'the hull cell was refilled with world water').toBe(B.WATER);
    return sim;
  }

  it('is free only in the hard octants: rays from above stop in the water of a lower slab\'s empty upper half, an upper slab is reached', () => {
    const lower = raft(slab(B.PLANKS_OAK, LOWER));
    const ship1 = lower.structures.ships()[0]!;
    explode(lower, 3.5, SEA_TOP + 1, 0.5, 4, null);
    expect(getPacked(ship1.grid, 2, SEA_TOP - 1, 0)).toBe(slab(B.PLANKS_OAK, LOWER));

    const upper = raft(slab(B.PLANKS_OAK, UPPER));
    const ship2 = upper.structures.ships()[0]!;
    explode(upper, 3.5, SEA_TOP + 1, 0.5, 4, null);
    expect(getPacked(ship2.grid, 2, SEA_TOP - 1, 0)).toBe(0);
  });
});
