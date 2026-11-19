/**
 * Adversarial review probes for the light engine (robustness / integration lens).
 * Every test here documented a verified defect; all are FIXED and kept as regression tests
 * (cellChanged now reads the cell's current state; departed chunks are detected by the
 * engine itself and their neighbours' border light is orphaned).
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LightEngine } from '../../src/light/engine';
import { World } from '../../src/voxel/world';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import { describeMismatches, diffAgainstReference, heightmapErrors } from './reference';
import { makeFlatChunk } from './terrain';

const AIR = 0;
const STONE = makeCell(B.STONE);
const LAMP = makeCell(B.LAMP);

function addLit(world: World, engine: LightEngine, chunk: Chunk): void {
  world.addChunk(chunk);
  engine.initChunk(chunk);
}

describe('review: re-entrant cell-change listeners', () => {
  it('a listener subscribed before the engine that reverts a removal must not leak sky light', () => {
    // World.onCellChange runs listeners in subscription order, synchronously inside setCell.
    // A listener that itself calls setCell (validation, support checks, blockify ...) makes
    // every LATER listener receive the nested event first and the outer event afterwards,
    // with an oldCell/newCell that no longer describe the cell. The engine trusts those
    // arguments for the heightmap and for the settle step.
    const world = new World(1);
    let reverting = false;
    world.onCellChange((x, y, z, oldCell, newCell) => {
      // "Protected" block: removals at y = 30 are immediately undone.
      if (!reverting && y === 30 && (oldCell & ID_MASK) === B.STONE && newCell === AIR) {
        reverting = true;
        world.setCell(x, y, z, oldCell);
        reverting = false;
      }
    });
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, makeFlatChunk(0, 0, 20));
    world.setCell(5, 30, 5, STONE); // a floating block: column top becomes 31
    expect(engine.update()).toBe(true);
    expect(world.getSkyLight(5, 29, 5)).toBe(14);

    world.setCell(5, 30, 5, AIR); // reverted by the listener: the cell is STONE again
    expect(world.getCell(5, 30, 5)).toBe(STONE);
    expect(engine.update()).toBe(true);

    // The block is still there, so nothing may change.
    expect(world.getChunk(0, 0)!.heightmap[5 | (5 << 4)], 'heightmap').toBe(31);
    expect(world.getSkyLight(5, 30, 5), 'sky light inside the stone block').toBe(0);
    expect(world.getSkyLight(5, 29, 5), 'sky light under the block').toBe(14);
    const m = diffAgainstReference(world);
    expect(m.length, describeMismatches(m)).toBe(0);
    expect(heightmapErrors(world)).toEqual([]);
  });

  it('a listener subscribed before the engine that replaces a placed lamp leaves no ghost emitter light', () => {
    const world = new World(1);
    let replacing = false;
    world.onCellChange((x, y, z, _oldCell, newCell) => {
      // E.g. a rule that turns lamps placed under water into glass.
      if (!replacing && (newCell & ID_MASK) === B.LAMP) {
        replacing = true;
        world.setCell(x, y, z, makeCell(B.GLASS));
        replacing = false;
      }
    });
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, makeFlatChunk(0, 0, 20));
    world.setCell(8, 25, 8, LAMP);
    expect(world.getCell(8, 25, 8)).toBe(makeCell(B.GLASS));
    expect(engine.update()).toBe(true);
    expect(world.getBlockLight(8, 25, 8), 'block light of the glass that replaced the lamp').toBe(0);
    expect(world.getBlockLight(9, 25, 8)).toBe(0);
    const m = diffAgainstReference(world);
    expect(m.length, describeMismatches(m)).toBe(0);
  });

  it('a listener subscribed before the engine that reverts a placement keeps the heightmap right', () => {
    const world = new World(1);
    let reverting = false;
    world.onCellChange((x, y, z, oldCell, newCell) => {
      if (!reverting && y === 40 && (newCell & ID_MASK) === B.STONE) {
        reverting = true;
        world.setCell(x, y, z, oldCell);
        reverting = false;
      }
    });
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, makeFlatChunk(0, 0, 20));
    world.setCell(7, 40, 7, STONE); // rejected: the cell stays AIR
    expect(world.getCell(7, 40, 7)).toBe(AIR);
    expect(engine.update()).toBe(true);
    expect(heightmapErrors(world)).toEqual([]);
    const m = diffAgainstReference(world);
    expect(m.length, describeMismatches(m)).toBe(0);
  });
});

describe('review: chunk unloading with pending work', () => {
  it('unloading a chunk while its removal work is queued must not leave permanent ghost light', () => {
    // A tunnel crossing the x = 16 chunk border, lit by a lamp in chunk 0.
    const make = (cx: number): Chunk => {
      const c = makeFlatChunk(cx, 0, 60);
      for (let lx = 0; lx < 16; lx++) c.cells[cellIndex(lx, 30, 8)] = AIR;
      if (cx === 0) c.cells[cellIndex(14, 30, 8)] = LAMP;
      return c;
    };
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, make(0));
    addLit(world, engine, make(1));
    expect(world.getBlockLight(16, 30, 8)).toBe(13);

    // The lamp is mined; before the queued removal runs, chunk 0 is unloaded (e.g. by
    // ChunkManager.unloadFar, which runs before light.update in a tick, or because the
    // removal did not fit the per-tick budget).
    world.setCell(14, 30, 8, AIR);
    const unloaded = world.removeChunk(0, 0)!;
    expect(engine.update()).toBe(true); // the queued entries for chunk 0 are dropped

    // Later chunk 0 streams back in with its saved cells (lamp gone) and is lit again.
    const back = new Chunk(0, 0, unloaded.cells.slice());
    addLit(world, engine, back);
    expect(engine.update()).toBe(true);

    // There is no emitter anywhere any more.
    expect(world.getBlockLight(16, 30, 8), 'ghost block light in chunk 1').toBe(0);
    expect(world.getBlockLight(14, 30, 8), 'ghost block light pulled back into chunk 0').toBe(0);
    const m = diffAgainstReference(world);
    expect(m.length, describeMismatches(m)).toBe(0);
  });
});
