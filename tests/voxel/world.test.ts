/**
 * Behaviour of the World grid (src/voxel/world.ts, owned by the lead architect). These tests
 * pin down the contract the voxel queries and every other module rely on.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, SECTIONS_PER_CHUNK, WORLD_HEIGHT } from '../../src/core/constants';
import { vec3, quat } from '../../src/core/math';
import { AIR, ID_MASK, makeCell } from '../../src/blocks/cell';
import { canonCell } from '../../src/blocks/shapes';
import { B, CELL_BELOW_WORLD, CELL_UNLOADED } from '../../src/blocks/defs';
import { cellIndex, Chunk, sectionKey, sectionKeyParts } from '../../src/voxel/chunk';
import { SET_EXPLOSION, SET_NO_NEIGHBOR_UPDATE } from '../../src/voxel/grid';
import { TickQueue, World, posKey } from '../../src/voxel/world';
import { LOWER, UPPER, slab } from '../shapes';
import { STONE, emptyWorld } from './helpers';

function sections(keys: Iterable<number>): string[] {
  return [...keys].map((k) => {
    const p = sectionKeyParts(k);
    return `${p.cx},${p.sy},${p.cz}`;
  }).sort();
}

describe('World cells', () => {
  it('reads back writes across chunk borders and negative coordinates', () => {
    const w = emptyWorld();
    const spots: Array<[number, number, number]> = [
      [-1, 0, -1],
      [0, 0, 0],
      [15, 127, 15],
      [16, 64, 16],
      [-16, 5, -17],
      [-17, 5, -16],
      [-32, 1, 31],
      [31, 2, -32],
    ];
    spots.forEach(([x, y, z], i) => expect(w.setCell(x, y, z, makeCell(B.STONE + (i % 3)))).toBe(true));
    spots.forEach(([x, y, z], i) => expect(w.getCell(x, y, z)).toBe(makeCell(B.STONE + (i % 3))));
    // Neighbours across the border are untouched.
    expect(w.getCell(-2, 0, -1)).toBe(AIR);
    expect(w.getCell(0, 0, -1)).toBe(AIR);
    expect(w.getId(-16, 5, -17)).toBe(B.STONE + (4 % 3));
    // The chunk holding (-1,*,-1) is chunk (-1,-1) at local (15, *, 15).
    const c = w.chunkAt(-1, -1)!;
    expect([c.cx, c.cz]).toEqual([-1, -1]);
    expect(c.cells[cellIndex(15, 0, 15)]).toBe(makeCell(B.STONE));
    expect(c.modified).toBe(true);
  });

  it('out of range: deeprock below, air above, unloaded is a solid sentinel; such writes fail', () => {
    const w = emptyWorld(0, 0);
    expect(w.getCell(3, -1, 3)).toBe(CELL_BELOW_WORLD);
    expect(w.getCell(3, -1000, 3)).toBe(CELL_BELOW_WORLD);
    expect(w.getCell(3, WORLD_HEIGHT, 3)).toBe(AIR);
    expect(w.getCell(100, 50, 3)).toBe(CELL_UNLOADED);
    expect(w.getCell(-1, 50, 3)).toBe(CELL_UNLOADED);
    expect(w.setCell(3, -1, 3, STONE)).toBe(false);
    expect(w.setCell(3, WORLD_HEIGHT, 3, STONE)).toBe(false);
    expect(w.setCell(100, 50, 3, STONE)).toBe(false);
    expect(w.setCell(3, 50, 3, AIR)).toBe(false); // unchanged
  });

  it('getIdState is the base layer: getCell & 0xffff everywhere (full blocks, partial and two-part cells, out of range, unloaded); getId its id', () => {
    const w = emptyWorld(0, 1);
    const cells = [STONE, makeCell(B.WATER, 3), slab(B.STONE, LOWER), slab(B.PLANKS_OAK, 0x7f), canonCell(slab(B.STONE, LOWER), slab(B.BRICKS, UPPER))];
    cells.forEach((c, i) => w.setCell(2 + i, 7, 18, c));
    const spots: Array<[number, number, number]> = [[3, -1, 3], [3, WORLD_HEIGHT, 3], [100, 50, 3], [-1, 50, 3], [1, 7, 18]];
    for (let i = 0; i < cells.length; i++) spots.push([2 + i, 7, 18]);
    for (const [x, y, z] of spots) {
      expect(w.getIdState(x, y, z), `${x},${y},${z}`).toBe(w.getCell(x, y, z) & 0xffff);
      expect(w.getId(x, y, z), `${x},${y},${z}`).toBe(w.getCell(x, y, z) & ID_MASK);
    }
    expect(w.getIdState(4, 7, 18)).toBe(slab(B.STONE, LOWER) & 0xffff);
    expect(w.getCell(4, 7, 18)).not.toBe(w.getIdState(4, 7, 18));
  });

  it('chunk cache never serves a removed or replaced chunk', () => {
    const w = emptyWorld(0, 1);
    w.setCell(1, 1, 1, STONE);
    expect(w.getCell(1, 1, 1)).toBe(STONE); // caches chunk (0,0)
    w.removeChunk(0, 0);
    expect(w.getCell(1, 1, 1)).toBe(CELL_UNLOADED);
    expect(w.isLoaded(1, 1)).toBe(false);
    const fresh = new Chunk(0, 0);
    fresh.cells[cellIndex(1, 1, 1)] = makeCell(B.DIRT);
    w.addChunk(fresh);
    expect(w.getCell(1, 1, 1)).toBe(makeCell(B.DIRT));
    expect(w.removeChunk(5, 5)).toBeUndefined();
    // Replacing a loaded chunk in place.
    expect(w.getCell(17, 1, 1)).toBe(AIR);
    const repl = new Chunk(1, 0);
    repl.cells[cellIndex(1, 1, 1)] = STONE;
    w.addChunk(repl);
    expect(w.getCell(17, 1, 1)).toBe(STONE);
  });

  it('isAreaLoaded covers every touched chunk, negative coordinates included', () => {
    const w = emptyWorld(-1, 0);
    expect(w.isAreaLoaded(-16, -16, 15.9, 15.9)).toBe(true);
    expect(w.isAreaLoaded(-16.1, -16, 15.9, 15.9)).toBe(false);
    expect(w.isAreaLoaded(-3, -3, 16, 3)).toBe(false); // touches chunk x = 1
    expect(w.isLoaded(-16, -16)).toBe(true);
    expect(w.isLoaded(-17, 0)).toBe(false);
  });

  it('identity transform and VoxelGrid constants', () => {
    const w = new World(7);
    expect([w.gridId, w.parent, w.isWorld, w.cellBounds()]).toEqual([0, null, true, null]);
    const p = vec3(1.5, -2, 3.25);
    expect(w.toWorld(p)).toEqual(p);
    expect(w.toLocal(p)).toEqual(p);
    expect(w.dirToWorld(p)).toEqual(p);
    expect(w.dirToLocal(p)).toEqual(p);
    expect(w.velocityAt(p)).toEqual(vec3(0, 0, 0));
    expect(w.worldRotation(quat(1, 2, 3, 4))).toEqual(quat(0, 0, 0, 1));
    const out = vec3(9, 9, 9);
    expect(w.toLocal(p, out)).toBe(out);
    expect(w.seed).toBe(7);
  });

  it('light storage: defaults and ranges', () => {
    const w = emptyWorld(0, 0);
    w.setSkyLight(2, 3, 4, 12);
    w.setBlockLight(2, 3, 4, 7);
    expect([w.getSkyLight(2, 3, 4), w.getBlockLight(2, 3, 4), w.getLightRaw(2, 3, 4)]).toEqual([12, 7, (12 << 4) | 7]);
    expect([w.getSkyLight(2, 200, 4), w.getSkyLight(2, -1, 4), w.getSkyLight(100, 5, 4)]).toEqual([15, 0, 15]);
    expect([w.getBlockLight(2, 200, 4), w.getBlockLight(100, 5, 4)]).toEqual([0, 0]);
    expect([w.getLightRaw(2, 200, 4), w.getLightRaw(2, -1, 4), w.getLightRaw(100, 5, 4)]).toEqual([0xf0, 0, 0xf0]);
    w.setSkyLight(2, -1, 4, 5); // ignored, no throw
    w.setBlockLight(100, 5, 4, 5);
  });
});

describe('World change hook', () => {
  it('reports every successful change with old/new cell and flags, in subscription order', () => {
    const w = emptyWorld();
    const log: string[] = [];
    const off1 = w.onCellChange((x, y, z, o, n, f) => log.push(`a ${x},${y},${z} ${o}->${n} f${f}`));
    w.onCellChange((x, y, z, o, n) => log.push(`b ${x},${y},${z} ${o}->${n}`));
    w.setCell(-3, 4, -5, STONE, SET_NO_NEIGHBOR_UPDATE | SET_EXPLOSION);
    w.setCell(-3, 4, -5, STONE); // unchanged: silent
    w.setCell(-3, -4, -5, STONE); // out of range: silent
    w.setCell(500, 4, 0, STONE); // unloaded: silent
    off1();
    w.setCell(-3, 4, -5, AIR);
    expect(log).toEqual([`a -3,4,-5 0->${STONE} f3`, `b -3,4,-5 0->${STONE}`, `b -3,4,-5 ${STONE}->0`]);
  });

  it('listeners see the new cell already stored', () => {
    const w = emptyWorld();
    let seen = -1;
    w.onCellChange((x, y, z) => (seen = w.getCell(x, y, z)));
    w.setCell(1, 2, 3, STONE);
    expect(seen).toBe(STONE);
  });

  // CONTRACT BUG (reported): World.setCell iterates the live listener array, so a listener
  // that unsubscribes itself during dispatch makes the NEXT listener miss that change
  // (splice shifts it into the slot that was just visited). core/events.ts Emitter has the
  // same pattern despite its comment claiming to tolerate it. Remove `.fails` once fixed.
  it('a listener unsubscribing itself during dispatch does not make the next one miss the event', () => {
    const w = emptyWorld();
    const got: string[] = [];
    const off = w.onCellChange(() => {
      got.push('once');
      off();
    });
    w.onCellChange(() => got.push('always'));
    w.setCell(0, 0, 0, STONE);
    expect(got).toEqual(['once', 'always']);
  });
});

describe('World dirty sections', () => {
  it('interior cell marks one section; border and corner cells also mark their neighbours', () => {
    const w = emptyWorld();
    w.setCell(5, 37, 5, STONE); // interior of section (0,2,0)
    expect(sections(w.takeDirtySections())).toEqual(['0,2,0']);
    w.setCell(-16, 37, 5, STONE); // lx = 0 of chunk -1 -> also chunk -2
    expect(sections(w.takeDirtySections())).toEqual(['-1,2,0', '-2,2,0']);
    w.setCell(15, 47, -1, STONE); // lx = 15, ly = 15, lz = 15 (chunk z = -1)
    expect(sections(w.takeDirtySections())).toEqual(['0,2,-1', '0,2,0', '0,3,-1', '0,3,0', '1,2,-1', '1,2,0', '1,3,-1', '1,3,0']);
    w.setCell(3, 0, 3, STONE); // bottom section: no section below
    expect(sections(w.takeDirtySections())).toEqual(['0,0,0']);
    w.setCell(3, WORLD_HEIGHT - 1, 3, STONE); // top: no section above
    expect(sections(w.takeDirtySections())).toEqual([`0,${SECTIONS_PER_CHUNK - 1},0`]);
  });

  it('the interior fast-path cache is reset by takeDirtySections (no lost re-marks)', () => {
    const w = emptyWorld();
    w.setCell(5, 37, 5, STONE);
    expect(w.takeDirtySections()).toEqual([sectionKey(0, 2, 0)]);
    w.setCell(6, 37, 5, STONE); // same section again right after draining
    expect(w.takeDirtySections()).toEqual([sectionKey(0, 2, 0)]);
    // Alternate interior writes between two sections and a border write in between.
    w.setCell(5, 37, 5, AIR);
    w.setCell(5, 20, 5, STONE);
    w.setCell(5, 37, 6, STONE);
    expect(sections(w.takeDirtySections())).toEqual(['0,1,0', '0,2,0']);
    expect(w.takeDirtySections()).toEqual([]);
  });

  it('light changes mark sections only when the value changes', () => {
    const w = emptyWorld();
    w.setBlockLight(5, 37, 5, 9);
    expect(sections(w.takeDirtySections())).toEqual(['0,2,0']);
    w.setBlockLight(5, 37, 5, 9);
    w.setSkyLight(5, 37, 5, 0);
    expect(w.takeDirtySections()).toEqual([]);
  });

  it('addChunk marks the chunk and its loaded neighbours', () => {
    const w = new World();
    w.addChunk(new Chunk(0, 0));
    expect(w.takeDirtySections().length).toBe(SECTIONS_PER_CHUNK);
    w.addChunk(new Chunk(1, 0));
    const s = sections(w.takeDirtySections());
    expect(s.length).toBe(2 * SECTIONS_PER_CHUNK);
    expect(s.filter((k) => k.startsWith('0,')).length).toBe(SECTIONS_PER_CHUNK);
    expect(CHUNK_SIZE).toBe(16);
  });
});

describe('TickQueue', () => {
  it('fires due ticks in scheduling order, exactly at their time', () => {
    const q = new TickQueue();
    q.schedule(1, 2, 3, 30, 5);
    q.schedule(-4, 5, -6, 31, 5);
    q.schedule(0, 0, 0, 30, 7);
    expect(q.size).toBe(3);
    expect(q.takeDue(4)).toEqual([]);
    expect(q.takeDue(5).map((t) => [t.x, t.y, t.z, t.id, t.at])).toEqual([
      [1, 2, 3, 30, 5],
      [-4, 5, -6, 31, 5],
    ]);
    expect(q.takeDue(5)).toEqual([]);
    expect(q.size).toBe(1);
    expect(q.has(0, 0, 0, 30)).toBe(true);
    expect(q.has(0, 0, 0, 31)).toBe(false);
  });

  it('same id keeps the EARLIER time; a different id replaces the entry', () => {
    const q = new TickQueue();
    q.schedule(1, 1, 1, 30, 10);
    q.schedule(1, 1, 1, 30, 12); // later: ignored
    q.schedule(1, 1, 1, 30, 10); // same: ignored
    expect(q.size).toBe(1);
    q.schedule(1, 1, 1, 30, 8); // earlier: moves
    expect(q.takeDue(8).length).toBe(1);
    expect(q.takeDue(10)).toEqual([]); // the superseded entry is stale
    q.schedule(2, 2, 2, 30, 20);
    q.schedule(2, 2, 2, 31, 25); // different block: replaces (even though later)
    expect(q.takeDue(20)).toEqual([]);
    expect(q.takeDue(25).map((t) => t.id)).toEqual([31]);
    expect(q.size).toBe(0);
  });

  it('all() and clear()', () => {
    const q = new TickQueue();
    q.schedule(1, 1, 1, 30, 10);
    q.schedule(1, 1, 1, 30, 9);
    q.schedule(2, 1, 1, 31, 4);
    expect(q.all().map((t) => [t.x, t.at]).sort()).toEqual([
      [1, 9],
      [2, 4],
    ]);
    q.clear();
    expect([q.size, q.takeDue(9).length, q.takeDue(4).length]).toEqual([0, 0, 0]);
  });

  it('World.scheduleTick is relative to world.time with a minimum delay of 1', () => {
    const w = new World();
    w.time = 100;
    w.scheduleTick(1, 2, 3, B.WATER, 5);
    w.scheduleTick(4, 2, 3, B.WATER, 0);
    expect(w.ticks.takeDue(101).map((t) => t.x)).toEqual([4]);
    expect(w.ticks.takeDue(105).map((t) => t.x)).toEqual([1]);
  });

  it('posKey is unique for neighbouring cells, negative coordinates included', () => {
    const keys = new Set<number>();
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (const y of [0, 1, 126, 127]) keys.add(posKey(x, y, z));
    expect(keys.size).toBe(7 * 7 * 4);
    expect(posKey(-4194303, 127, 4194303)).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  // Formerly a reported contract issue (an overdue entry stayed in byPos for good and blocked
  // every later schedule of the same block id at that position); fixed in world.ts.
  it('a tick scheduled in the past does not wedge the position', () => {
    const q = new TickQueue();
    expect(q.takeDue(10)).toEqual([]);
    q.schedule(0, 0, 0, 30, 10); // e.g. restored from a save with an already-due time
    q.schedule(0, 0, 0, 30, 12); // a fresh schedule from the liquid module
    expect(q.has(0, 0, 0, 30)).toBe(true);
    expect(q.takeDue(11).length + q.takeDue(12).length).toBe(1);
    expect(q.size).toBe(0);
  });

  it('after a clock jump the overdue ticks fire on the next call, earliest first', () => {
    const q = new TickQueue();
    q.schedule(1, 0, 0, 30, 6);
    q.schedule(2, 0, 0, 30, 5);
    q.schedule(3, 0, 0, 30, 5);
    q.schedule(4, 0, 0, 30, 12);
    expect(q.takeDue(1)).toEqual([]);
    expect(q.takeDue(10).map((t) => [t.x, t.at])).toEqual([
      [2, 5],
      [3, 5],
      [1, 6],
    ]);
    expect(q.takeDue(11)).toEqual([]);
    expect(q.takeDue(12).map((t) => t.x)).toEqual([4]);
  });
});
