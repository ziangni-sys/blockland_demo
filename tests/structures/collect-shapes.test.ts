/**
 * Collecting with partial blocks (docs/SHAPES.md 11.1): the fill walks connectedCells on PACKED
 * cells (the queue keeps both parts of every cell it collected, so a parent's holes and second part
 * decide which neighbours join); a cell joins as a whole, both parts; a rotor's hub must touch the
 * bearing's front face ('no_hub' otherwise); sails count by volume (eight felt slabs are four
 * sails); limits count cells; and the 4000-cell budget holds for a ship that is 30% slabs and
 * stairs.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NZ, PX, PZ, type Dir } from '../../src/core/dirs';
import { collectRotor, collectShip } from '../../src/structures/collect';
import { GlueStore } from '../../src/structures/glue';
import { Chunk } from '../../src/voxel/chunk';
import { getPacked } from '../../src/voxel/parts';
import { World } from '../../src/voxel/world';
import { EAST, LOWER, NORTH, slab, SOUTH, stairFill, UPPER, WEST } from '../shapes';
import { HARNESSES, c, cellKeys, type Harness } from './harness';

const HELM_N = makeCell(B.HELM, facingState(NZ));
const facing = (id: number, d: Dir): number => makeCell(id, facingState(d));

/** A 3 x 3 planks deck at y = 0 with a helm at (1, 1, 1). Returns the helm (scenario coordinates). */
function deck(h: Harness): [number, number, number] {
  h.fill(0, 0, 0, 2, 0, 2, c(B.PLANKS_OAK));
  h.set(1, 1, 1, HELM_N);
  return [1, 1, 1];
}

describe('collect: the queue holds packed cells (holes and second parts decide the neighbours)', () => {
  for (const make of HARNESSES) {
    const name = make().name;

    it(`[${name}] a lower slab reached from the deck does not take the block above it; an upper slab does`, () => {
      const h = make();
      const helm = deck(h);
      h.set(3, 0, 0, slab(B.PLANKS_OAK, LOWER)); // sticks to the deck sideways (lower halves touch)
      h.set(3, 1, 0, c(B.PLANKS_OAK)); // above the lower slab: no contact
      h.set(3, 0, 2, slab(B.PLANKS_OAK, UPPER)); // sticks to the deck sideways (upper half of its face)
      h.set(3, 1, 2, c(B.PLANKS_OAK)); // above the upper slab: contact
      const r = collectShip(h.grid, h.glue, ...h.abs(...helm));
      const keys = cellKeys(h, r.cells, r.count);
      expect(keys.has('3,0,0')).toBe(true);
      expect(keys.has('3,1,0')).toBe(false);
      expect(keys.has('3,0,2')).toBe(true);
      expect(keys.has('3,1,2')).toBe(true);
      expect(r.count).toBe(9 + 1 + 3);
    });

    it(`[${name}] a two-part cell joins through either part and takes what its second part sticks to`, () => {
      const h = make();
      const helm = deck(h);
      // Planks below (sticks to the deck), felt above; a felt block on top sticks only to the felt part.
      const two = canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.WOOL_RED, UPPER));
      h.set(3, 0, 1, two);
      h.set(3, 1, 1, c(B.WOOL_BLUE));
      h.set(3, 2, 1, c(B.WOOL_WHITE));
      const r = collectShip(h.grid, h.glue, ...h.abs(...helm));
      const keys = cellKeys(h, r.cells, r.count);
      expect(keys.has('3,0,1')).toBe(true);
      expect(keys.has('3,1,1')).toBe(true);
      expect(keys.has('3,2,1')).toBe(true);
      // The same tower on a cell whose upper part is stone: nothing above it joins.
      const h2 = make();
      deck(h2);
      h2.set(3, 0, 1, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.STONE, UPPER)));
      h2.set(3, 1, 1, c(B.WOOL_BLUE));
      const r2 = collectShip(h2.grid, h2.glue, ...h2.abs(1, 1, 1));
      expect(cellKeys(h2, r2.cells, r2.count).has('3,1,1')).toBe(false);
    });

    it(`[${name}] glue joins only touching cells: a glued face to a slab on the far half takes nothing`, () => {
      const h = make();
      const helm = deck(h);
      h.set(3, 0, 1, slab(B.BRICKS, EAST)); // the far half from the deck
      h.glueFace(2, 0, 1, PX);
      h.set(3, 0, 2, slab(B.BRICKS, WEST)); // the near half
      h.glueFace(2, 0, 2, PX);
      const r = collectShip(h.grid, h.glue, ...h.abs(...helm));
      const keys = cellKeys(h, r.cells, r.count);
      expect(keys.has('3,0,1')).toBe(false);
      expect(keys.has('3,0,2')).toBe(true);
    });

    it(`[${name}] limits count cells: two parts in one cell are one cell`, () => {
      const h = make();
      const helm = deck(h);
      h.set(3, 0, 1, canonCell(slab(B.PLANKS_OAK, NORTH), slab(B.PLANKS_PINE, SOUTH)));
      expect(collectShip(h.grid, h.glue, ...h.abs(...helm), 11).reason).toBe('ok');
      expect(collectShip(h.grid, h.glue, ...h.abs(...helm), 10).reason).toBe('too_big');
    });
  }
});

describe('collect: the rotor hub must touch the bearing (SHAPES 11.1)', () => {
  for (const make of HARNESSES) {
    const name = make().name;

    /** A bearing at (0,0,0) facing +Z with a backing block, and a felt sheet beyond the hub cell (0,0,1). */
    function rotorScene(h: Harness, hub: number): void {
      h.set(0, 0, -1, c(B.PLANKS_OAK));
      h.set(0, 0, 0, facing(B.BEARING, PZ));
      h.set(0, 0, 1, hub);
      for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) if (x !== 0 || y !== 0) h.set(x, y, 1, c(B.WOOL_RED));
    }

    it(`[${name}] a hub whose material lies on the far half from the bearing: 'no_hub'; on the near half, or a full hub: ok`, () => {
      for (const [hub, reason] of [
        [slab(B.CANVAS, SOUTH), 'no_hub'], // +Z half: away from the bearing
        [slab(B.CANVAS, NORTH), 'ok'], // -Z half: against the bearing's front
        [slab(B.CANVAS, LOWER), 'ok'], // touches the lower half of the front face
        [canonCell(slab(B.STONE, NORTH & LOWER), slab(B.CANVAS, SOUTH)), 'ok'], // a stone corner touches
        [c(B.CANVAS), 'ok'],
      ] as const) {
        const h = make();
        rotorScene(h, hub);
        const r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
        expect(r.reason, `hub ${hub}`).toBe(reason);
        if (reason === 'ok') {
          expect(getPacked(h.grid, ...h.abs(0, 0, 1))).toBe(hub);
          expect(cellKeys(h, r.cells, r.count).has('0,0,1')).toBe(true);
        } else {
          expect(r.count).toBe(0);
        }
      }
    });
  }
});

describe('collect: sails by volume (SHAPES 11.1)', () => {
  for (const make of HARNESSES) {
    const name = make().name;

    /** Bearing at (0,0,0) facing +Z, a canvas lower-slab hub, `n` felt lower slabs in a row towards +X. */
    function slabRotor(h: Harness, n: number): void {
      h.set(0, 0, -1, c(B.PLANKS_OAK));
      h.set(0, 0, 0, facing(B.BEARING, PZ));
      h.set(0, 0, 1, slab(B.CANVAS, LOWER));
      for (let i = 1; i <= n; i++) h.set(i, 0, 1, slab(B.WOOL_RED, LOWER));
    }

    it(`[${name}] a hub slab and seven felt slabs are four sails (enough); six are three and a half (not enough)`, () => {
      const h = make();
      slabRotor(h, 7);
      const ok = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0));
      expect(ok.reason).toBe('ok');
      expect(ok.sails).toBe(4);
      const h2 = make();
      slabRotor(h2, 6);
      const short = collectRotor(h2.grid, h2.glue, ...h2.abs(0, 0, 0));
      expect(short.reason).toBe('not_enough_sails');
      expect(short.sails).toBe(3.5);
      expect(short.count).toBe(7);
    });

    it(`[${name}] a two-part cell counts only its sail part; a chiselled felt block counts its octants`, () => {
      const h = make();
      slabRotor(h, 0);
      h.set(1, 0, 1, canonCell(slab(B.WOOL_RED, LOWER), slab(B.PLANKS_OAK, UPPER)));
      h.set(2, 0, 1, slab(B.WOOL_BLUE, 0x7f));
      h.set(3, 0, 1, slab(B.WOOL_BLUE, 0x01));
      const r = collectRotor(h.grid, h.glue, ...h.abs(0, 0, 0), 400, 0);
      expect(r.count).toBe(4);
      expect(r.sails).toBe(0.5 + 0.5 + 7 / 8 + 1 / 8);
    });
  }
});

describe('collect: performance with partial blocks', () => {
  function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  }

  it('a 4000-cell ship of which 30% are slabs, stairs and two-part cells takes a few milliseconds (< 25 ms)', () => {
    const w = new World(6);
    for (let cx = -1; cx <= 4; cx++) for (let cz = -1; cz <= 4; cz++) w.addChunk(new Chunk(cx, cz));
    // A planks raft like the full-block budget's, every third cell of each row a partial cell that
    // still meets its neighbours with planks: lower slabs, stairs, two-part cells.
    const kinds = [
      slab(B.PLANKS_OAK, LOWER),
      slab(B.PLANKS_PINE, stairFill(PX)),
      canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.WOOL_RED, UPPER)),
      canonCell(slab(B.PLANKS_OAK, WEST), slab(B.PLANKS_PINE, EAST)),
    ];
    let partial = 0;
    let total = 0;
    const put = (x: number, z: number, i: number): void => {
      const cell = i % 10 < 3 ? kinds[i % kinds.length]! : c(B.PLANKS_OAK);
      if (cell !== c(B.PLANKS_OAK)) partial++;
      total++;
      w.setCell(x, 50, z, cell);
    };
    let i = 0;
    for (let x = 0; x < 63; x++) for (let z = 0; z < 63; z++) put(x, z, i++);
    for (let x = 0; x < 30; x++) put(x, 63, i++);
    w.setCell(30, 50, 30, c(B.PLANKS_OAK)); // the helm needs a fully covered top face below it
    w.setCell(30, 51, 30, HELM_N);
    expect(partial / total).toBeGreaterThan(0.28);
    const glue = new GlueStore();
    const times: number[] = [];
    let count = 0;
    for (let k = 0; k < 25; k++) {
      const t = performance.now();
      const r = collectShip(w, glue, 30, 51, 30);
      times.push(performance.now() - t);
      count = r.count;
    }
    const ms = median(times);
    console.log(`[collect perf] 4000-cell ship, 30% partial: median ${ms.toFixed(3)} ms`);
    expect(count).toBe(4000);
    expect(ms).toBeLessThan(25);
  });
});
