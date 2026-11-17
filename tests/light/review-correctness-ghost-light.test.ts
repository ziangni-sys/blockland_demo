/**
 * Adversarial review (correctness): permanent ghost light when a removal chain is cut by
 * re-initialising or unloading a chunk. FIXED: these are regression tests now. The engine
 * notices departed / re-initialised chunks (update() and initChunk() check its lit-chunk
 * registry against the world) and orphans the border light of their neighbours; the
 * "Engine: ..." notes below record what the original engine produced.
 *
 * The removal BFS only reaches stale cells by walking strictly decreasing light from the
 * removed source. Two things cut that walk:
 *  - initChunk() on an already-lit chunk wipes its light (light.fill(0)) while removal entries
 *    that still have to cross it are pending;
 *  - world.removeChunk() (ChunkManager.unloadFar) drops every queued entry in the absent chunk,
 *    and blocks every removal that would pass through it.
 * Stale light left behind in the neighbour is then treated as a legitimate seed, and when the
 * chunk is lit again initChunk() PULLS it back across the border. Reloading identical content
 * does not restore consistency: the ghost light is permanent and spreads into both chunks.
 *
 * Every test below ends with all chunks loaded, lit and drained, so the brute-force reference is
 * the ground truth: all block light must be 0 because no emitter is left.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LightEngine } from '../../src/light/engine';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { describeMismatches, diffAgainstReference } from './reference';
import { makeFlatChunk } from './terrain';

const AIR = 0;
const LAMP = makeCell(B.LAMP);
const TORCH = makeCell(B.TORCH);

/** Two solid chunks (0,0) and (1,0), stone up to y = 60, lit and attached. */
function twoChunks(): { world: World; engine: LightEngine } {
  const world = new World(1);
  const engine = new LightEngine(world);
  engine.attach();
  for (const cx of [0, 1]) {
    const c = makeFlatChunk(cx, 0, 60);
    world.addChunk(c);
    engine.initChunk(c);
  }
  return { world, engine };
}

function drain(engine: LightEngine): void {
  while (!engine.update()) {
    /* empty */
  }
}

function expectNoBlockLight(world: World, label: string): void {
  let lit = 0;
  for (const c of world.chunks.values()) for (let i = 0; i < c.light.length; i++) if ((c.light[i]! & 15) !== 0) lit++;
  const m = diffAgainstReference(world);
  expect(m.length, `${label}: ${describeMismatches(m)}`).toBe(0);
  expect(lit, `${label}: cells with block light although no emitter exists`).toBe(0);
}

/** Reload a chunk the way ChunkManager does: a NEW Chunk object with the same cells. */
function reload(world: World, engine: LightEngine, cx: number, cz: number, cells: Uint16Array): void {
  const fresh = new Chunk(cx, cz, cells.slice());
  world.addChunk(fresh);
  engine.initChunk(fresh);
}

describe('review: removal chains cut by re-init / unload leave ghost light', () => {
  it('initChunk on an already-lit chunk while a removal is pending (the report says re-init is safe)', () => {
    const { world, engine } = twoChunks();
    for (let x = 8; x <= 24; x++) world.setCell(x, 30, 8, AIR); // 1x1 tunnel across the border at x = 15|16
    world.setCell(12, 30, 8, LAMP);
    drain(engine);
    expect(world.getBlockLight(16, 30, 8)).toBe(11);

    world.setCell(12, 30, 8, AIR); // lamp removed
    engine.update(2); // the removal walks 2 cells, then the tick's budget runs out
    engine.initChunk(world.getChunk(0, 0)!); // re-init (cells were only changed through setCell)
    drain(engine);

    // Engine: x = 8..24 keep block light 3..11..3 forever, fed by (16,30,8) = 11.
    expectNoBlockLight(world, 're-init with pending removal');
  });

  it('removal that loops through an unloaded chunk: reload with IDENTICAL content keeps ghost light', () => {
    const { world, engine } = twoChunks();
    // U-shaped tunnel B -> A -> B. B = chunk (0,0), A = chunk (1,0). The z = 8 leg in B is
    // reachable only through A (solid stone between the legs inside B).
    for (let x = 13; x <= 17; x++) {
      world.setCell(x, 30, 4, AIR);
      world.setCell(x, 30, 8, AIR);
    }
    for (let z = 4; z <= 8; z++) world.setCell(17, 30, z, AIR);
    world.setCell(13, 30, 4, TORCH);
    drain(engine);
    expect(world.getBlockLight(15, 30, 8)).toBe(4); // came round through A
    expect(engine.pending).toBe(0);

    // A goes out of range and is unloaded (ChunkManager.unloadFar); nothing is pending.
    const aCells = world.getChunk(1, 0)!.cells.slice();
    world.removeChunk(1, 0);
    // Something in B removes the torch (fluids, a falling block, a structure blockifying ...).
    world.setCell(13, 30, 4, AIR);
    drain(engine);

    // A comes back in range with exactly the same cells.
    reload(world, engine, 1, 0, aCells);
    drain(engine);

    // Engine: (15,30,8)=4, (14,30,8)=3, (13,30,8)=2 in B and (16..17,30,8)/(17,30,7) = 3,2,1 in A.
    expectNoBlockLight(world, 'loop through unloaded chunk');
  });

  it('unloading a chunk while its removal is pending drops the chain; reload pulls the stale light back', () => {
    const { world, engine } = twoChunks();
    for (let x = 8; x <= 24; x++) world.setCell(x, 30, 8, AIR);
    world.setCell(17, 30, 8, LAMP); // in A, 2 cells from the border
    drain(engine);
    expect(world.getBlockLight(15, 30, 8)).toBe(13);

    world.setCell(17, 30, 8, AIR);
    engine.update(2); // budget runs out while the chain is still inside A
    const aCells = world.getChunk(1, 0)!.cells.slice();
    world.removeChunk(1, 0); // unloaded mid-chain: its queued entries are dropped
    drain(engine);
    reload(world, engine, 1, 0, aCells);
    drain(engine);

    // Engine: B keeps 13..6 at x = 15..8 and A receives 12..4 at x = 16..24.
    expectNoBlockLight(world, 'unload with pending removal');
  });
});
