/**
 * The glue lifetime rule when a chunk arrives (DESIGN 强力胶: a glued face stays while one side is
 * a glueable block). Glue beside an unloaded column is kept, since the column might be rock;
 * once the column is added to the world (generated, or restored from a save) its cells are known,
 * and the world's faces in and on the border of that chunk with no glueable side are removed.
 * Faces whose other side is still unloaded stay. The check is one box query per chunk, and
 * nothing at all while the world's store is empty.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NX, PX, PY, PZ } from '../../src/core/dirs';
import { exportSave, importSave } from '../../src/sim/persist';
import { Simulation } from '../../src/sim/simulation';
import type { GlueStore } from '../../src/structures/glue';
import { Chunk, cellIndex } from '../../src/voxel/chunk';
import { FlatGenerator } from '../../src/worldgen/generator';
import { c, glueKeys, scene } from './helpers';
import { SOLO_KEY, soloSim } from '../solo';

/** A chunk whose cells are all air except `cell` at the given chunk-local positions. */
function chunkWith(cx: number, cz: number, cell: number, at: Array<[number, number, number]>): Chunk {
  const cells = new Uint16Array(16 * 16 * 128);
  for (const [lx, y, lz] of at) cells[cellIndex(lx, y, lz)] = cell;
  return new Chunk(cx, cz, cells);
}

/** Faces of a store kept up to date from its change events only. */
function mirrorOf(g: GlueStore): () => string[] {
  const m = new Set(glueKeys(g));
  g.onChange((added, x, y, z, axis) => {
    const k = `${x},${y},${z},${axis}`;
    if (added) m.add(k);
    else m.delete(k);
  });
  return () => [...m].sort();
}

describe('glue when a chunk is added', () => {
  it('a face kept beside an unloaded column floats between two air cells once the column loads as air: removed', () => {
    const s = scene(); // chunks loaded for x in -32..31
    const g = s.host.worldGlue;
    s.world.setCell(31, 70, 0, c(B.STONE));
    g.add(31, 70, 0, PX); // towards the unloaded column x = 32
    s.world.setCell(31, 70, 0, 0);
    expect(g.has(31, 70, 0, PX)).toBe(true); // the unloaded side might be rock
    const mirror = mirrorOf(g);
    s.world.addChunk(new Chunk(2, 0)); // x 32..47, all air
    expect(g.has(31, 70, 0, PX)).toBe(false);
    expect(g.size).toBe(0);
    expect(mirror()).toEqual([]);
    // Two blocks put there later are not glued: no player ever glued them.
    s.world.setCell(32, 70, 0, c(B.STONE));
    s.world.setCell(31, 70, 0, c(B.STONE));
    expect(g.has(31, 70, 0, PX)).toBe(false);
  });

  it('a face from air towards an unloaded column that loads with a stone there: kept (the stone holds it)', () => {
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(31, 70, 0, c(B.STONE));
    g.add(31, 70, 0, PX);
    s.world.setCell(31, 70, 0, 0);
    s.world.addChunk(chunkWith(2, 0, c(B.STONE), [[0, 70, 0]])); // a stone at (32, 70, 0)
    expect(g.has(31, 70, 0, PX)).toBe(true);
  });

  it('a stone\'s exposed face towards an unloaded column: kept when the column loads as air, and as stone', () => {
    for (const fill of [0, c(B.STONE)]) {
      const s = scene();
      const g = s.host.worldGlue;
      s.world.setCell(31, 70, 0, c(B.STONE));
      g.add(31, 70, 0, PX);
      s.world.setCell(-32, 70, 5, c(B.STONE));
      g.add(-32, 70, 5, NX); // on the opposite border, towards x = -33
      s.world.addChunk(fill === 0 ? new Chunk(2, 0) : chunkWith(2, 0, fill, [[0, 70, 0]]));
      expect(g.has(31, 70, 0, PX)).toBe(true);
      expect(g.has(-32, 70, 5, NX)).toBe(true); // that border's chunk is still not loaded
      expect(g.size).toBe(2);
    }
  });

  it('faces inside the new chunk and on its far borders are judged too; faces whose other side is still unloaded stay', () => {
    const s = scene();
    const g = s.host.worldGlue;
    // Glue stored for places in chunk (2, 0) and its border with (3, 0) before either is loaded
    // (as a save restores it): nothing loaded around them, so nothing is judged yet.
    g.add(40, 70, 4, PY); // inside, between two cells that will be air
    g.add(41, 70, 4, PY); // inside, on a stone the chunk brings
    g.add(47, 70, 4, PX); // on the border with the still unloaded (3, 0), from an air cell
    g.add(33, 70, 15, PZ); // on the border with the still unloaded (2, 1)
    s.world.addChunk(chunkWith(2, 0, c(B.STONE), [[9, 70, 4]]));
    expect(g.has(40, 70, 4, PY)).toBe(false);
    expect(g.has(41, 70, 4, PY)).toBe(true);
    expect(g.has(47, 70, 4, PX)).toBe(true);
    expect(g.has(33, 70, 15, PZ)).toBe(true);
    s.world.addChunk(new Chunk(3, 0)); // air: (47, 70, 4) and (48, 70, 4) both air now
    expect(g.has(47, 70, 4, PX)).toBe(false);
    expect(g.has(33, 70, 15, PZ)).toBe(true);
  });

  it('costs nothing with an empty store and one box query per chunk otherwise', () => {
    const s = scene();
    const g = s.host.worldGlue;
    const lookups = (['has', 'dirMaskAt', 'forEach', 'forEachInBox', 'facesInBox', 'remove'] as const).map((m) => vi.spyOn(g, m));
    const looked = (): number => lookups.reduce((n, spy) => n + spy.mock.calls.length, 0);
    for (let cx = 4; cx < 8; cx++) s.world.addChunk(new Chunk(cx, 0));
    expect(looked()).toBe(0);
    g.add(0, 10, 0, PY); // far away
    for (let cx = 4; cx < 8; cx++) s.world.addChunk(new Chunk(cx, 1));
    expect(looked()).toBe(4);
    expect(lookups[3]!.mock.calls.length).toBe(4); // forEachInBox, once per chunk
    expect(g.size).toBe(1);
  });
});

describe('glue of a saved world, reloaded chunk by chunk', () => {
  const opts = () => ({
    seed: 3,
    mode: 'creative' as const,
    generator: new FlatGenerator(), // deeprock, stone, dirt, turf: the first air cell is y = 35
    syncChunks: true,
    rabbits: false,
    loadRadius: 2,
    spawn: { x: 8, y: 35, z: 8 },
  });

  it('keeps every valid face, whatever order the chunks come back in, and the event mirror stays identical', () => {
    const a = soloSim(opts());
    a.advance(5); // every chunk within the load radius
    const w = a.world;
    const g = a.worldGlue;
    const stone = makeCell(B.STONE);
    const put = (x: number, y: number, z: number): void => void w.setCell(x, y, z, stone);
    put(15, 40, 3); // a glued pair across the x = 15 | 16 border
    put(16, 40, 3);
    g.add(15, 40, 3, PX);
    put(15, 41, 5); // exposed faces across that border, from either side
    g.add(15, 41, 5, PX);
    put(16, 42, 6);
    g.add(16, 42, 6, NX);
    put(3, 40, -1); // across the z = -1 | 0 border
    g.add(3, 40, -1, PZ);
    put(31, 40, 10); // across the x = 31 | 32 border (a chunk at the edge of the load radius)
    g.add(31, 40, 10, PX);
    put(-17, 40, 2); // across the x = -17 | -16 border
    g.add(-17, 40, 2, PX);
    g.add(5, 34, 5, PY); // the ground's open top face
    put(8, 40, 8); // a pair inside one chunk
    put(8, 41, 8);
    g.add(8, 40, 8, PY);
    put(20, 45, 20); // a stone glued to a stone that was then mined: the face stays on it
    put(20, 46, 20);
    g.add(20, 45, 20, PY);
    w.setCell(20, 46, 20, 0);
    const faces = glueKeys(g);
    expect(faces.length).toBe(9);
    const bundle = exportSave(a);

    for (const reversed of [false, true]) {
      const b = new Simulation(opts());
      b.worldGlue.add(1, 34, 1, PY); // something that the import must clear
      const mirror = mirrorOf(b.worldGlue);
      importSave(b, bundle);
      b.join(SOLO_KEY); // loads the 3 x 3 chunks around the player
      expect(glueKeys(b.worldGlue)).toEqual(faces);
      const cols: Array<[number, number]> = [];
      for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) cols.push([cx, cz]);
      if (reversed) cols.reverse();
      for (const [cx, cz] of cols) {
        b.chunks.loadColumn(b.generator, cx, cz);
        expect(glueKeys(b.worldGlue)).toEqual(faces);
      }
      expect(b.world.chunks.size).toBe(25);
      expect(mirror()).toEqual(faces);
    }
  });
});
