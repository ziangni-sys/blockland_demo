/**
 * The liquid rules read only the base layer of the world (World.getIdState: the id and state of a
 * cell's first part), never World.getCell, which adds the holes and the second-part bit and costs
 * about a fifth more per read in a chunk with partial cells. That changes no decision: every rule
 * reads the id or the liquid state bits, and a cell with parts has a hard first part
 * (docs/SHAPES.md I7), so its id alone tells it from air and liquid.
 *
 * Proof by difference: random scenes full of partial cells (slabs in every direction, stairs,
 * single octants carved out, two-part cells) with water and lava pouring over and around them, and
 * parts put down and taken away while the liquid moves, run side by side in a World and in one
 * whose getIdState returns the full cell value (getCell, what the liquid code read before). Every
 * cell (all three layers), every pending tick and every deferred cell must stay the same, tick by
 * tick. And the liquid in a scene equals the liquid in the same scene with every partial cell
 * replaced by a full block of its first part's id. The rule itself (no getCell read) only shows in
 * the time, so one more case counts the getCell calls the liquid code makes: none.
 */
import { describe, expect, it } from 'vitest';
import { AIR, ID_MASK, cellPrimary, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { CHUNK_SHIFT } from '../../src/core/constants';
import { HORIZONTAL_DIRS } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { Fluids, pumpTicks } from '../../src/liquid/fluids';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, SOUTH, UPPER, WEST, slab, stairFill } from '../shapes';
import { FLOOR_Y, SURFACE, chunkCoords, lava, liquidCells, makeChunk, water, type CellFn, type ChunkRange, type FluidWorld } from './helpers';

/** The liquid code as it read the world before: the full cell value (first part with its holes, second-part bit). */
class FullReadWorld extends World {
  override getIdState(x: number, y: number, z: number): number {
    return this.getCell(x, y, z);
  }
}

/** A World that counts getCell calls: the liquid code must make none (it reads getIdState). */
class CountingWorld extends World {
  getCellCalls = 0;
  override getCell(x: number, y: number, z: number): number {
    this.getCellCalls++;
    return super.getCell(x, y, z);
  }
}

/** 3 x 2 chunks; the chunks around them are unloaded, so some liquid waits at the border (deferred cells). */
const RANGE: ChunkRange = { minCx: -1, maxCx: 1, minCz: 0, maxCz: 1 };

function build(fn: CellFn, full: boolean, world: World = full ? new FullReadWorld(1) : new World(1)): FluidWorld {
  for (const [cx, cz] of chunkCoords(RANGE)) world.addChunk(makeChunk(cx, cz, fn));
  const fluids = new Fluids(world);
  fluids.attach();
  for (const c of world.chunks.values()) fluids.rescheduleChunk(c);
  return { world, fluids };
}

/** Partial cells of hard materials: slabs on every side, stairs, a cell with one octant carved out, two-part cells. */
function partialCells(): number[] {
  const out: number[] = [];
  for (const id of [B.STONE, B.PLANKS_OAK, B.BRICKS]) {
    for (const f of [LOWER, UPPER, WEST, EAST, NORTH, SOUTH]) out.push(slab(id, f));
    for (const d of HORIZONTAL_DIRS) out.push(slab(id, stairFill(d)));
    out.push(slab(id, 0xff & ~0x10), slab(id, 0x7f));
  }
  out.push(canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER)));
  out.push(canonCell(slab(B.BRICKS, WEST), slab(B.STONE, EAST)));
  out.push(canonCell(slab(B.PLANKS_OAK, 0x0f & ~0x01), slab(B.STONE, 0xf0)));
  return out;
}
const PARTS = partialCells();

/**
 * A random scene: a floor at FLOOR_Y with gaps (some over a second floor two below), partial cells
 * on and in the floor, low walls of partial and full cells, and water and lava sources above.
 */
function scene(seed: number): { fn: CellFn; edits: Array<{ t: number; x: number; y: number; z: number; cell: number }> } {
  const rng = new Rng(seed);
  const x0 = RANGE.minCx << CHUNK_SHIFT;
  const x1 = ((RANGE.maxCx + 1) << CHUNK_SHIFT) - 1;
  const z0 = RANGE.minCz << CHUNK_SHIFT;
  const z1 = ((RANGE.maxCz + 1) << CHUNK_SHIFT) - 1;
  const cells = new Map<string, number>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      cells.set(key(x, FLOOR_Y - 2, z), makeCell(B.STONE));
      const r = rng.next();
      if (r < 0.06) continue; // a gap in the floor
      cells.set(key(x, FLOOR_Y, z), r < 0.3 ? PARTS[rng.int(0, PARTS.length - 1)]! : makeCell(B.STONE));
      const w = rng.next();
      if (w < 0.12) cells.set(key(x, SURFACE, z), PARTS[rng.int(0, PARTS.length - 1)]!);
      else if (w < 0.16) cells.set(key(x, SURFACE, z), makeCell(B.COBBLE));
      if (w < 0.05) cells.set(key(x, SURFACE + 1, z), PARTS[rng.int(0, PARTS.length - 1)]!);
    }
  for (let k = 0; k < 14; k++) {
    const x = rng.int(x0 + 2, x1 - 2);
    const z = rng.int(z0 + 2, z1 - 2);
    const y = SURFACE + rng.int(0, 3);
    if (cells.has(key(x, y, z))) continue;
    cells.set(key(x, y, z), k % 4 === 3 ? lava() : water());
  }
  // Parts put down into the flow, and cells cleared, while it moves (the same in both worlds).
  const edits: Array<{ t: number; x: number; y: number; z: number; cell: number }> = [];
  for (let k = 0; k < 40; k++) {
    const t = rng.int(1, 300);
    const x = rng.int(x0, x1);
    const z = rng.int(z0, z1);
    const y = rng.int(FLOOR_Y, SURFACE + 2);
    edits.push({ t, x, y, z, cell: rng.next() < 0.7 ? PARTS[rng.int(0, PARTS.length - 1)]! : AIR });
  }
  edits.sort((a, b) => a.t - b.t);
  return { fn: (x, y, z) => cells.get(key(x, y, z)) ?? AIR, edits };
}

/**
 * The first difference between what the liquid code left behind in two worlds (all three layers of
 * every chunk, the pending ticks, the deferred cells), or null when there is none.
 */
function difference(a: FluidWorld, b: FluidWorld): string | null {
  for (const [k, ca] of a.world.chunks) {
    const cb = b.world.chunks.get(k)!;
    const la = ca.layers();
    const lb = cb.layers();
    for (let i = 0; i < la.base.length; i++) {
      const ha = la.holes !== null ? la.holes[i]! : 0;
      const hb = lb.holes !== null ? lb.holes[i]! : 0;
      const qa = la.part2 !== null ? la.part2[i]! : 0;
      const qb = lb.part2 !== null ? lb.part2[i]! : 0;
      if (la.base[i] !== lb.base[i] || ha !== hb || qa !== qb) {
        const x = (ca.cx << CHUNK_SHIFT) + (i & 15);
        const z = (ca.cz << CHUNK_SHIFT) + ((i >> 4) & 15);
        return `cell ${x},${i >> 8},${z}: ${la.base[i]}/${ha}/${qa} against ${lb.base[i]}/${hb}/${qb}`;
      }
    }
  }
  const ticks = (fw: FluidWorld): string =>
    fw.world.ticks
      .all()
      .map((t) => `${t.x},${t.y},${t.z}:${t.id}@${t.at}`)
      .sort()
      .join(' ');
  const ta = ticks(a);
  const tb = ticks(b);
  if (ta !== tb) return `pending ticks: ${ta} against ${tb}`;
  if (a.fluids.deferredCount !== b.fluids.deferredCount) return `deferred cells: ${a.fluids.deferredCount} against ${b.fluids.deferredCount}`;
  return null;
}

describe('the liquid rules read the base layer only (World.getIdState): the same result as reading whole cells', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`scene ${seed}: water and lava over and around partial cells, parts put down and cleared on the way: every cell, tick and deferred cell the same as with whole-cell reads, every 10 ticks for 400 ticks`, () => {
      const { fn, edits } = scene(seed);
      const a = build(fn, false);
      const b = build(fn, true);
      expect(difference(a, b)).toBe(null);
      let e = 0;
      let flowed = 0;
      for (let t = 1; t <= 400; t++) {
        while (e < edits.length && edits[e]!.t === t) {
          const { x, y, z, cell } = edits[e++]!;
          a.world.setCell(x, y, z, cell);
          b.world.setCell(x, y, z, cell);
        }
        pumpTicks(a.world, a.fluids, 1);
        pumpTicks(b.world, b.fluids, 1);
        if (t % 10 === 0) {
          expect(difference(a, b), `tick ${t}`).toBe(null);
          flowed = Math.max(flowed, liquidCells(a.world).length);
        }
      }
      // The scene did what it claims: liquid spread among the partial cells.
      expect(flowed).toBeGreaterThan(40);
    });
  }

  // The difference test above cannot see whether getCell is read (both worlds give the same
  // answers by design); this one pins the rule itself. A getCell read per liquid step would cost
  // a fifth more in chunks with partial cells and change no result, so only a count notices it.
  it('the liquid code never calls World.getCell: 400 ticks of a scene with edits, with only Fluids attached, make no getCell call', () => {
    const { fn, edits } = scene(7);
    const world = new CountingWorld(1);
    const a = build(fn, false, world);
    let e = 0;
    let flowed = 0;
    for (let t = 1; t <= 400; t++) {
      while (e < edits.length && edits[e]!.t === t) {
        const { x, y, z, cell } = edits[e++]!;
        a.world.setCell(x, y, z, cell);
      }
      pumpTicks(a.world, a.fluids, 1);
      if (t % 50 === 0) flowed = Math.max(flowed, liquidCells(a.world).length);
    }
    expect(flowed).toBeGreaterThan(40);
    expect(world.getCellCalls).toBe(0);
  });

  it('the liquid in a scene with partial cells equals the liquid in the same scene with each partial cell a full block of its first part', () => {
    for (const seed of [11, 12, 13]) {
      const { fn } = scene(seed);
      const asBlock: CellFn = (x, y, z) => {
        const c = fn(x, y, z);
        return c >= 0x10000 ? makeCell(cellPrimary(c) & ID_MASK) : c;
      };
      const a = build(fn, false);
      const b = build(asBlock, false);
      for (let t = 1; t <= 300; t++) {
        pumpTicks(a.world, a.fluids, 1);
        pumpTicks(b.world, b.fluids, 1);
        if (t % 20 === 0) expect(liquidCells(a.world), `scene ${seed}, tick ${t}`).toEqual(liquidCells(b.world));
      }
    }
  });
});
