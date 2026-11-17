/**
 * Regression tests for the review findings on the light engine:
 *  - out-of-order cell-change events (another listener rewrites the cell before the engine
 *    hears about it);
 *  - chunks leaving the world (unload / replacement) and re-initialising lit chunks, with and
 *    without pending work, with no hook other than the engine's own update()/initChunk();
 *  - dirty marking: re-initialisation marks what changed, and no intermediate state of a
 *    budget-limited removal is ever handed to the mesher;
 *  - removal work proportional to what actually changes.
 * Ground truth is always the brute-force reference over the chunks that are present and lit.
 */
import { describe, expect, it } from 'vitest';
import { ID_MASK, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { Rng } from '../../src/core/rng';
import { LightEngine } from '../../src/light/engine';
import { Chunk, chunkKey } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { describeMismatches, diffAgainstReference, heightmapErrors, lightSnapshot } from './reference';
import { makeFlatChunk, makeTerrainChunk } from './terrain';

const AIR = 0;
const STONE = makeCell(B.STONE);
const LEAVES = makeCell(B.LEAVES_OAK);
const WATER = makeCell(B.WATER);
const GLASS = makeCell(B.GLASS);
const ICE = makeCell(B.ICE);
const LAMP = makeCell(B.LAMP);
const TORCH = makeCell(B.TORCH);
const CELLS = [AIR, AIR, AIR, STONE, STONE, LEAVES, WATER, ICE, GLASS, LAMP, TORCH];

function addLit(world: World, engine: LightEngine, chunk: Chunk): void {
  world.addChunk(chunk);
  engine.initChunk(chunk);
}

function expectConsistent(world: World, label: string): void {
  const m = diffAgainstReference(world);
  expect(m.length, `${label}: ${describeMismatches(m)}`).toBe(0);
  const hm = heightmapErrors(world);
  expect(hm.length, `${label}: ${hm.slice(0, 4).join('; ')}`).toBe(0);
}

function drain(engine: LightEngine): void {
  expect(engine.update()).toBe(true);
}

/** Sections World.markDirty would mark for every light byte that differs from `before`. */
function sectionsChangedSince(world: World, before: Map<number, Uint8Array>): number[] {
  const oracle = new World(0);
  for (const c of world.chunks.values()) {
    const old = before.get(chunkKey(c.cx, c.cz));
    if (!old) continue;
    for (let i = 0; i < old.length; i++) {
      if (old[i] !== c.light[i]) oracle.markDirty(c.cx * 16 + (i & 15), i >> 8, c.cz * 16 + ((i >> 4) & 15));
    }
  }
  return oracle.takeDirtySections();
}

/** Visits needed to finish the pending work (one visit per update(1) call). */
function visitsToDrain(engine: LightEngine): number {
  let n = 1;
  while (!engine.update(1)) n++;
  return n;
}

// ===================================================================== out-of-order events

describe('cell-change listeners that edit cells themselves', () => {
  for (const engineFirst of [false, true]) {
    it(`nested edits (support pops, reverts, replacements) with the engine attached ${engineFirst ? 'first' : 'last'}`, () => {
      const world = new World(3);
      const engine = new LightEngine(world);
      if (engineFirst) engine.attach();
      const rng = new Rng(17);
      let depth = 0;
      world.onCellChange((x, y, z, oldCell, newCell) => {
        if (depth > 2) return;
        depth++;
        // A torch whose support is removed pops off (a nested edit of ANOTHER cell).
        if (SOLID[oldCell & ID_MASK] && !SOLID[newCell & ID_MASK] && (world.getCell(x, y + 1, z) & ID_MASK) === B.TORCH) {
          world.setCell(x, y + 1, z, AIR);
        }
        // Validation rules that revert or alter the SAME cell.
        const r = rng.next();
        if (r < 0.08) world.setCell(x, y, z, oldCell);
        else if (r < 0.12) world.setCell(x, y, z, CELLS[rng.int(0, CELLS.length - 1)]!);
        depth--;
      });
      if (!engineFirst) engine.attach();
      for (let cx = 0; cx <= 1; cx++) for (let cz = 0; cz <= 1; cz++) addLit(world, engine, makeTerrainChunk(cx, cz, 3));
      for (let k = 1; k <= 500; k++) {
        const x = rng.int(0, 31);
        const z = rng.int(0, 31);
        const h = world.chunkAt(x, z)!.heightmap[(x & 15) | ((z & 15) << 4)]!;
        const y = rng.chance(0.5) ? Math.max(0, Math.min(127, h - 1 + rng.int(-2, 2))) : rng.int(20, 80);
        world.setCell(x, y, z, CELLS[rng.int(0, CELLS.length - 1)]!);
        if (rng.chance(0.3)) engine.update(rng.int(0, 100));
        if (k % 100 === 0) {
          drain(engine);
          expectConsistent(world, `after ${k} edits`);
        }
      }
    });
  }

  it('calling cellChanged with arguments that do not describe the cell is harmless', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, makeFlatChunk(0, 0, 20));
    // Claims a lamp was placed, but the cell is still air; then claims stone was removed.
    engine.cellChanged(4, 30, 4, AIR, LAMP);
    engine.cellChanged(6, 20, 6, STONE, AIR);
    drain(engine);
    expectConsistent(world, 'bogus events');
    expect(world.getBlockLight(4, 30, 4)).toBe(0);
  });
});

// ===================================================================== chunks leaving

describe('chunks leaving the world and re-initialisation (no unload hook)', () => {
  /** A 1x1 tunnel at y = 30, z = 8 through solid stone, from x = 0 to x = 47 (chunks 0..2). */
  function tunnelWorld(): { world: World; engine: LightEngine } {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    for (let cx = 0; cx <= 2; cx++) {
      const c = makeFlatChunk(cx, 0, 60);
      for (let lx = 0; lx < 16; lx++) c.set(lx, 30, 8, AIR);
      addLit(world, engine, c);
    }
    return { world, engine };
  }

  it('light a chunk fed into its neighbours disappears when it unloads, and comes back when it reloads', () => {
    const { world, engine } = tunnelWorld();
    world.setCell(20, 30, 8, LAMP); // in chunk 1
    // A shaft from the surface into the tunnel inside chunk 1: sky light runs along it too.
    for (let y = 31; y <= 60; y++) world.setCell(18, y, 8, AIR);
    drain(engine);
    expect(world.getBlockLight(14, 30, 8)).toBe(9);
    expect(world.getSkyLight(14, 30, 8)).toBe(11);
    const before = lightSnapshot(world);

    const middle = world.removeChunk(1, 0)!;
    drain(engine); // nothing else happens: update() notices the chunk is gone
    for (let x = 0; x < 16; x++) {
      expect(world.getBlockLight(x, 30, 8), `block light at x=${x}`).toBe(0);
      expect(world.getSkyLight(x, 30, 8), `sky light at x=${x}`).toBe(0);
    }
    expectConsistent(world, 'unloaded');

    addLit(world, engine, new Chunk(1, 0, middle.cells.slice()));
    drain(engine);
    expectConsistent(world, 'reloaded');
    const after = lightSnapshot(world);
    for (const [k, bytes] of before) expect(Buffer.from(after.get(k)!).equals(Buffer.from(bytes)), `chunk ${k}`).toBe(true);
  });

  it('a chunk replaced by a different chunk object is forgotten before the new one is lit', () => {
    const { world, engine } = tunnelWorld();
    world.setCell(20, 30, 8, LAMP);
    drain(engine);
    // The world swaps chunk 1 for one without the lamp, without any unload in between.
    const fresh = new Chunk(1, 0, world.getChunk(1, 0)!.cells.slice());
    fresh.set(4, 30, 8, AIR);
    addLit(world, engine, fresh);
    drain(engine);
    expect(world.getBlockLight(15, 30, 8)).toBe(0);
    expectConsistent(world, 'replaced');
  });

  it('the same chunk object can be removed and added again (with initChunk)', () => {
    const { world, engine } = tunnelWorld();
    world.setCell(20, 30, 8, LAMP);
    drain(engine);
    const c = world.removeChunk(1, 0)!;
    world.setCell(10, 30, 8, TORCH); // an edit next door while it is away
    world.addChunk(c);
    engine.initChunk(c);
    drain(engine);
    expectConsistent(world, 're-added before any update');
    world.removeChunk(1, 0);
    drain(engine); // this time the engine notices while it is away
    expect(c.lit).toBe(false);
    world.addChunk(c);
    engine.initChunk(c);
    drain(engine);
    expectConsistent(world, 're-added after an update');
  });

  it('re-initialising a chunk whose cells were written without setCell relights its neighbours both ways', () => {
    const { world, engine } = tunnelWorld();
    world.setCell(20, 30, 8, LAMP);
    drain(engine);
    const c = world.getChunk(1, 0)!;
    expect(world.getBlockLight(15, 30, 8)).toBe(10);
    expect(world.getBlockLight(32, 30, 8)).toBe(3);
    // Bypass the hook: move the lamp 8 cells east and open a side passage along the border.
    c.set(4, 30, 8, AIR);
    c.set(12, 30, 8, LAMP);
    for (let lz = 8; lz <= 12; lz++) c.set(15, 31, lz, AIR);
    engine.initChunk(c);
    drain(engine);
    expectConsistent(world, 're-initialised');
    expect(world.getBlockLight(15, 30, 8)).toBe(2); // chunk 0 is darker now
    expect(world.getBlockLight(32, 30, 8)).toBe(11); // chunk 2 is brighter
  });

  it('random unloading, reloading and re-initialising stays equal to the reference of the present chunks', () => {
    const world = new World(3);
    const engine = new LightEngine(world);
    engine.attach();
    const rng = new Rng(4);
    const away = new Map<number, Chunk>(); // removed chunks, by key
    for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) addLit(world, engine, makeTerrainChunk(cx, cz, 3));
    let unloads = 0;
    let reloads = 0;
    let reinits = 0;
    for (let k = 1; k <= 420; k++) {
      const present = [...world.chunks.values()].filter((c) => c.lit);
      const c = present[rng.int(0, present.length - 1)]!;
      const x = c.cx * 16 + (rng.chance(0.4) ? (rng.chance(0.5) ? 0 : 15) : rng.int(0, 15));
      const z = c.cz * 16 + (rng.chance(0.4) ? (rng.chance(0.5) ? 0 : 15) : rng.int(0, 15));
      world.setCell(x, rng.int(15, 90), z, CELLS[rng.int(0, CELLS.length - 1)]!);
      if (rng.chance(0.3)) engine.update(rng.int(0, 200));

      const r = rng.next();
      if (r < 0.06 && present.length > 4) {
        // Unload, often with work still pending.
        const v = present[rng.int(0, present.length - 1)]!;
        world.removeChunk(v.cx, v.cz);
        away.set(chunkKey(v.cx, v.cz), v);
        unloads++;
        if (rng.chance(0.5)) engine.update(rng.int(0, 100));
      } else if (r < 0.12 && away.size > 0) {
        // Reload: usually a new object with the same cells, sometimes the old object itself.
        const keys = [...away.keys()];
        const key = keys[rng.int(0, keys.length - 1)]!;
        const v = away.get(key)!;
        away.delete(key);
        addLit(world, engine, rng.chance(0.7) ? new Chunk(v.cx, v.cz, v.cells.slice()) : v);
        reloads++;
      } else if (r < 0.15) {
        // Re-initialise a lit chunk, sometimes after writing cells behind the engine's back.
        const v = present[rng.int(0, present.length - 1)]!;
        if (world.getChunk(v.cx, v.cz) === v) {
          if (rng.chance(0.5)) {
            for (let j = 0; j < 6; j++) v.set(rng.int(0, 15), rng.int(20, 80), rng.int(0, 15), CELLS[rng.int(0, CELLS.length - 1)]!);
          }
          engine.initChunk(v);
          reinits++;
        }
      }
      if (k % 60 === 0) {
        drain(engine);
        expectConsistent(world, `after ${k} steps`);
      }
    }
    expect(unloads).toBeGreaterThan(10);
    expect(reloads).toBeGreaterThan(5);
    expect(reinits).toBeGreaterThan(5);
  });
});

// ===================================================================== dirty marking

describe('dirty marking', () => {
  it('re-initialising a lit chunk marks every section whose light changed', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    for (let cx = 0; cx <= 1; cx++) addLit(world, engine, makeTerrainChunk(cx, 0, 1));
    const c = world.getChunk(0, 0)!;
    const good = lightSnapshot(world);
    // A no-op re-init leaves every byte as it was. (It may still remesh a few sections along
    // the shared border: orphaned border cells are reset and refilled to the same values.)
    engine.initChunk(c);
    drain(engine);
    const same = lightSnapshot(world);
    for (const [k, bytes] of good) expect(Buffer.from(same.get(k)!).equals(Buffer.from(bytes))).toBe(true);
    world.takeDirtySections();

    c.light.fill(0x5a); // corrupted light bytes
    const corrupted = lightSnapshot(world);
    engine.initChunk(c);
    drain(engine);
    const marked = new Set(world.takeDirtySections());
    const needed = sectionsChangedSince(world, corrupted);
    expect(needed.length).toBeGreaterThan(8);
    for (const key of needed) expect(marked.has(key), `section ${key}`).toBe(true);
    const now = lightSnapshot(world);
    for (const [k, bytes] of good) expect(Buffer.from(now.get(k)!).equals(Buffer.from(bytes))).toBe(true);
  });

  /** A wide stone roof high above flat ground: closing a skylight relights a big shaded volume. */
  function roofWorld(): { world: World; engine: LightEngine } {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    for (let cz = -1; cz <= 2; cz++) for (let cx = -1; cx <= 2; cx++) addLit(world, engine, makeFlatChunk(cx, cz, 4));
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) world.setCell(x, 120, z, STONE);
    world.setCell(16, 120, 16, AIR);
    drain(engine);
    return { world, engine };
  }

  it('an edit that overflows the budget hands no intermediate state to the mesher', () => {
    const { world, engine } = roofWorld();
    const before = lightSnapshot(world);
    world.setCell(16, 120, 16, STONE); // close the skylight
    world.takeDirtySections(); // what setCell itself marked
    let calls = 0;
    while (!engine.update(5000)) {
      calls++;
      // Light is half removed / half refilled right now: nothing may be marked for meshing.
      expect(world.takeDirtySections(), `call ${calls}`).toEqual([]);
    }
    expect(calls).toBeGreaterThan(3);
    const marked = new Set(world.takeDirtySections());
    const needed = sectionsChangedSince(world, before);
    expect(needed.length).toBeGreaterThan(10);
    for (const key of needed) expect(marked.has(key), `section ${key}`).toBe(true);
    expectConsistent(world, 'closed');
  });

  it('a sustained overload still flushes after 20 update calls, so meshes never freeze', () => {
    const { world, engine } = roofWorld();
    world.setCell(16, 120, 16, STONE);
    world.takeDirtySections();
    for (let k = 1; k < 20; k++) {
      expect(engine.update(50)).toBe(false);
      expect(world.takeDirtySections()).toEqual([]);
    }
    expect(engine.update(50)).toBe(false);
    expect(world.takeDirtySections().length).toBeGreaterThan(0);
    drain(engine);
    expectConsistent(world, 'after overload');
  });

  it('marks survive chunks that share a dirty slot (8 chunks apart) within one deferral window', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    for (const cx of [0, 8, 16]) addLit(world, engine, makeFlatChunk(cx, 0, 60));
    const before = lightSnapshot(world);
    world.takeDirtySections();
    // Caves with lamps in three chunks that map to the same direct-mapped slot.
    for (const cx of [0, 8, 16]) {
      for (let x = cx * 16 + 2; x < cx * 16 + 14; x++) for (let z = 2; z < 14; z++) world.setCell(x, 30, z, AIR);
      world.setCell(cx * 16 + 8, 30, 8, LAMP);
    }
    world.takeDirtySections();
    // Several calls, all inside one deferral window (fewer than the 20 that force a flush),
    // so the evicted chunks' masks must survive in the spill until the end.
    let calls = 0;
    while (!engine.update(60)) calls++;
    expect(calls).toBeGreaterThan(4);
    expect(calls).toBeLessThan(19);
    const marked = new Set(world.takeDirtySections());
    for (const key of sectionsChangedSince(world, before)) expect(marked.has(key), `section ${key}`).toBe(true);
    expectConsistent(world, 'three caves');
  });
});

// ===================================================================== work per edit

describe('removal work is proportional to what changes', () => {
  it('closing a skylight in a high roof, re-placing a roof edge block, removing a lamp', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    for (let cz = -1; cz <= 2; cz++) for (let cx = -1; cx <= 2; cx++) addLit(world, engine, makeFlatChunk(cx, cz, 4));
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) world.setCell(x, 120, z, STONE);
    drain(engine);
    const changedBy = (edit: () => void): { visits: number; changed: number } => {
      const a = lightSnapshot(world);
      edit();
      const visits = visitsToDrain(engine);
      const b = lightSnapshot(world);
      let changed = 0;
      for (const [k, x] of a) {
        const y = b.get(k)!;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) changed++;
      }
      return { visits, changed };
    };
    changedBy(() => world.setCell(16, 120, 16, AIR));
    const close = changedBy(() => world.setCell(16, 120, 16, STONE));
    changedBy(() => world.setCell(0, 120, 16, AIR));
    const edge = changedBy(() => world.setCell(0, 120, 16, STONE));
    // The original stack-based removal needed 87,210 and 20,891 visits here.
    expect(close.changed).toBeGreaterThan(15_000);
    expect(close.visits).toBeLessThan(2.5 * close.changed);
    expect(edge.visits).toBeLessThan(3.5 * edge.changed);
    expectConsistent(world, 'roof');

    for (let x = 4; x < 28; x++) for (let z = 4; z < 28; z++) world.setCell(x, 2, z, AIR); // a cave under the floor
    drain(engine);
    changedBy(() => world.setCell(16, 2, 16, LAMP));
    const lamp = changedBy(() => world.setCell(16, 2, 16, AIR));
    expect(lamp.visits).toBeLessThanOrEqual(lamp.changed + 2);
    expectConsistent(world, 'cave');
  });
});
