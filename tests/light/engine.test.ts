import { describe, expect, it } from 'vitest';
import { liquidState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { WORLD_HEIGHT } from '../../src/core/constants';
import { Rng } from '../../src/core/rng';
import { LightEngine } from '../../src/light/engine';
import { cellIndex, chunkKey, Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { computeReference, describeMismatches, diffAgainstReference, heightmapErrors, lightSnapshot } from './reference';
import { makeFlatChunk, makeTerrainChunk, TEST_SEA } from './terrain';

const AIR = 0;
const STONE = makeCell(B.STONE);
const LEAVES = makeCell(B.LEAVES_OAK);
const WATER = makeCell(B.WATER);
const LAVA = makeCell(B.LAVA);
const ICE = makeCell(B.ICE);
const GLASS = makeCell(B.GLASS);
const LAMP = makeCell(B.LAMP);
const TORCH = makeCell(B.TORCH);
const PLANKS = makeCell(B.PLANKS_OAK);

type ChunkFactory = (cx: number, cz: number) => Chunk;

/** A world + attached engine, chunks added (and lit) in the given order. */
function buildWorld(coords: ReadonlyArray<readonly [number, number]>, make: ChunkFactory): { world: World; engine: LightEngine } {
  const world = new World(1);
  const engine = new LightEngine(world);
  engine.attach();
  for (const [cx, cz] of coords) addLit(world, engine, make(cx, cz));
  return { world, engine };
}

function addLit(world: World, engine: LightEngine, chunk: Chunk): void {
  world.addChunk(chunk);
  engine.initChunk(chunk);
}

function grid(x0: number, x1: number, z0: number, z1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) out.push([cx, cz]);
  return out;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rng = new Rng(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function expectMatchesReference(world: World, label = ''): void {
  const m = diffAgainstReference(world);
  expect(m.length, `${label} ${describeMismatches(m)}`).toBe(0);
}

function expectHeightmapsCorrect(world: World): void {
  const errs = heightmapErrors(world);
  expect(errs.length, errs.slice(0, 5).join('\n')).toBe(0);
}

function drain(engine: LightEngine): void {
  expect(engine.update()).toBe(true);
  expect(engine.pending).toBe(0);
}

const terrain: ChunkFactory = (cx, cz) => makeTerrainChunk(cx, cz, 1);
const flat = (ground: number): ChunkFactory => (cx, cz) => makeFlatChunk(cx, cz, ground);

// ===================================================================== basics

describe('LightEngine basics', () => {
  it('lights a flat chunk: open sky above ground, dark below, heightmap = ground + 1', () => {
    const { world } = buildWorld([[0, 0]], flat(20));
    const c = world.getChunk(0, 0)!;
    expect(c.lit).toBe(true);
    for (let col = 0; col < 256; col++) expect(c.heightmap[col]).toBe(21);
    expect(world.getSkyLight(5, 21, 5)).toBe(15);
    expect(world.getSkyLight(5, WORLD_HEIGHT - 1, 5)).toBe(15);
    expect(world.getSkyLight(5, 20, 5)).toBe(0);
    expect(world.getSkyLight(5, 3, 5)).toBe(0);
    expect(world.getBlockLight(5, 21, 5)).toBe(0);
  });

  it('empty column has heightmap 0 and is fully lit; a block at y=127 gives heightmap 128', () => {
    const { world, engine } = buildWorld([[0, 0]], () => new Chunk(0, 0));
    const c = world.getChunk(0, 0)!;
    expect(c.heightmap[0]).toBe(0);
    expect(world.getSkyLight(0, 0, 0)).toBe(15);
    world.setCell(0, 127, 0, LEAVES);
    drain(engine);
    expect(c.heightmap[0]).toBe(128);
    // Virtual sky above the world reaches the top layer through one attenuating step.
    expect(world.getSkyLight(0, 127, 0)).toBe(14);
    expectMatchesReference(world);
  });

  it('rejects a chunk that is not the world chunk at its position', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    expect(() => engine.initChunk(new Chunk(0, 0))).toThrow();
  });

  it('ignores state-only changes (liquid level) and identical opacity/emission swaps', () => {
    const { world, engine } = buildWorld([[0, 0]], flat(10));
    world.setCell(3, 11, 3, makeCell(B.WATER, liquidState(0, false)));
    drain(engine);
    world.setCell(3, 11, 3, makeCell(B.WATER, liquidState(3, false)));
    expect(engine.pending).toBe(0);
    world.setCell(4, 10, 4, PLANKS); // stone -> planks: both opaque, no emission
    expect(engine.pending).toBe(0);
    world.setCell(5, 11, 5, GLASS); // air -> glass: both transparent
    expect(engine.pending).toBe(0);
    expectMatchesReference(world);
  });

  it('attach() is idempotent and its unsubscribe stops incremental updates', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    const off = engine.attach();
    expect(engine.attach()).toBe(off);
    addLit(world, engine, makeFlatChunk(0, 0, 10));
    world.setCell(8, 11, 8, LAMP);
    expect(engine.pending).toBeGreaterThan(0);
    drain(engine);
    off();
    world.setCell(8, 11, 8, AIR);
    expect(engine.pending).toBe(0);
    expect(world.getBlockLight(8, 11, 8)).toBe(15); // stale, as expected without the hook
  });

  it('update(budget) makes bounded progress and reports completion', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 0), flat(10));
    world.setCell(15, 11, 8, LAMP);
    world.setCell(16, 11, 8, TORCH);
    let calls = 0;
    while (!engine.update(3)) {
      calls++;
      expect(calls).toBeLessThan(10_000);
    }
    expect(calls).toBeGreaterThan(5);
    expect(engine.pending).toBe(0);
    expect(engine.update(0)).toBe(true);
    expectMatchesReference(world);
  });

  it('marks every section World.markDirty would mark for each changed light byte', () => {
    const { world, engine } = buildWorld(grid(-1, 1, -1, 0), terrain);
    // A second world, used only to evaluate World.markDirty's rule for the changed cells.
    const oracle = new World(1);
    const rng = new Rng(9);
    for (let k = 0; k < 150; k++) {
      const before = lightSnapshot(world);
      const [x, y, z] = randomPos(rng, -16, 31, -16, 15);
      world.setCell(x, y, z, EDIT_CELLS[rng.int(0, EDIT_CELLS.length - 1)]!);
      engine.update(rng.chance(0.5) ? Infinity : rng.int(0, 200));
      const marked = new Set(world.takeDirtySections());
      oracle.takeDirtySections();
      for (const c of world.chunks.values()) {
        const old = before.get(chunkKey(c.cx, c.cz))!;
        for (let i = 0; i < old.length; i++) {
          if (old[i] !== c.light[i]) oracle.markDirty(c.cx * 16 + (i & 15), i >> 8, c.cz * 16 + ((i >> 4) & 15));
        }
      }
      for (const key of oracle.takeDirtySections()) expect(marked.has(key), `edit ${k}: section ${key} not marked`).toBe(true);
    }
  });

  it('marks the sections of changed light dirty, including across a chunk border', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 0), flat(10));
    world.takeDirtySections();
    // Lamp on the east border of chunk 0: light spills into chunk 1.
    world.setCell(15, 20, 8, LAMP);
    world.takeDirtySections();
    drain(engine);
    const dirty = new Set(world.takeDirtySections());
    const sec = (cx: number, y: number, cz: number) => chunkKey(cx, cz) * 8 + Math.floor(y / 16);
    expect(dirty.has(sec(0, 20, 0))).toBe(true);
    expect(dirty.has(sec(1, 20, 0))).toBe(true);
    expect(world.getBlockLight(20, 20, 8)).toBe(10);
  });
});

// ===================================================================== chunk initialisation

describe('initChunk', () => {
  it('matches the reference for a 3x3 terrain world and is independent of add order', () => {
    const coords = grid(-1, 1, -1, 1);
    const orders = [coords, coords.slice().reverse(), shuffled(coords, 7), shuffled(coords, 99)];
    let first: Map<number, Uint8Array> | null = null;
    for (const order of orders) {
      const { world } = buildWorld(order, terrain);
      if (!first) {
        expectMatchesReference(world, 'first order');
        expectHeightmapsCorrect(world);
        first = lightSnapshot(world);
      } else {
        const snap = lightSnapshot(world);
        for (const [k, bytes] of first) expect(Buffer.from(snap.get(k)!).equals(Buffer.from(bytes)), `chunk ${k}`).toBe(true);
      }
    }
  });

  it('matches the reference with holes in the loaded set, then after filling them', () => {
    const { world, engine } = buildWorld(
      [
        [0, 0],
        [2, 0],
        [1, 1],
        [0, 2],
        [2, 2],
      ],
      terrain,
    );
    expectMatchesReference(world, 'checkerboard');
    // Unloaded neighbours never receive anything (nothing to write into) and give nothing.
    for (const [cx, cz] of [
      [1, 0],
      [0, 1],
      [2, 1],
      [1, 2],
    ] as const) {
      addLit(world, engine, terrain(cx, cz));
      expectMatchesReference(world, `after ${cx},${cz}`);
    }
    expectHeightmapsCorrect(world);
  });

  it('pulls light into a new chunk from bright neighbours and pushes its own out', () => {
    // Chunk 0 has a lamp-lit cave on its east edge; chunk 1 has a lamp right at its west edge.
    const make: ChunkFactory = (cx, cz) => {
      const c = makeFlatChunk(cx, cz, 60);
      for (let y = 20; y < 24; y++) for (let lx = 0; lx < 16; lx++) for (let lz = 4; lz < 12; lz++) c.set(lx, y, lz, AIR);
      if (cx === 0) c.set(13, 21, 8, LAMP);
      if (cx === 1) c.set(0, 22, 6, TORCH);
      return c;
    };
    const { world, engine } = buildWorld([[0, 0]], make);
    expect(world.getBlockLight(15, 21, 8)).toBe(13);
    addLit(world, engine, make(1, 0));
    expect(world.getBlockLight(16, 21, 8)).toBe(12);
    expect(world.getBlockLight(15, 22, 6)).toBe(13);
    expectMatchesReference(world);
  });

  it('re-initialising a chunk with stale light bytes overwrites them', () => {
    const { world, engine } = buildWorld([[0, 0]], terrain);
    const c = world.getChunk(0, 0)!;
    const good = c.light.slice();
    c.light.fill(0x5a);
    engine.initChunk(c);
    expect(Buffer.from(c.light).equals(Buffer.from(good))).toBe(true);
  });
});

// ===================================================================== targeted scenarios

describe('incremental scenarios', () => {
  it('a roof darkens the area below it and removing it restores the light', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 1), flat(10));
    const before = lightSnapshot(world);
    // 5x5 roof at y=20 straddling the corner where 4 chunks meet.
    for (let x = 14; x <= 18; x++) for (let z = 14; z <= 18; z++) world.setCell(x, 20, z, STONE);
    drain(engine);
    // Under the centre (16,_,16) the nearest open column is 3 steps away: 15 - 3.
    expect(world.getSkyLight(16, 15, 16)).toBe(12);
    expect(world.getSkyLight(16, 19, 16)).toBe(12);
    expect(world.getSkyLight(14, 15, 16)).toBe(14);
    expect(world.getSkyLight(16, 21, 16)).toBe(15);
    expect(world.getChunk(1, 1)!.heightmap[0]).toBe(21);
    expectMatchesReference(world, 'roofed');
    expectHeightmapsCorrect(world);

    for (let x = 14; x <= 18; x++) for (let z = 14; z <= 18; z++) world.setCell(x, 20, z, AIR);
    drain(engine);
    const after = lightSnapshot(world);
    for (const [k, bytes] of before) expect(Buffer.from(after.get(k)!).equals(Buffer.from(bytes))).toBe(true);
    expectHeightmapsCorrect(world);
  });

  it('light enters a closed room through a 1-cell hole, and leaves when it is plugged', () => {
    const { world, engine } = buildWorld(grid(0, 0, 0, 0), flat(10));
    // Hollow stone box x,z 2..12, y 11..20 (shell), interior 3..11 x 12..19 x 3..11.
    for (let x = 2; x <= 12; x++)
      for (let y = 11; y <= 20; y++)
        for (let z = 2; z <= 12; z++) {
          const shell = x === 2 || x === 12 || z === 2 || z === 12 || y === 20;
          world.setCell(x, y, z, shell ? STONE : AIR);
        }
    drain(engine);
    expect(world.getSkyLight(7, 15, 7)).toBe(0);
    world.setCell(7, 20, 7, AIR); // the hole
    drain(engine);
    expect(world.getSkyLight(7, 20, 7)).toBe(15);
    expect(world.getSkyLight(7, 12, 7)).toBe(15); // straight down, lossless
    expect(world.getSkyLight(8, 12, 7)).toBe(14);
    expect(world.getSkyLight(11, 12, 11)).toBe(7); // 8 sideways steps
    expect(world.getSkyLight(11, 19, 11)).toBe(7);
    expectMatchesReference(world, 'open');
    world.setCell(7, 20, 7, STONE);
    drain(engine);
    for (let x = 3; x <= 11; x++)
      for (let y = 12; y <= 19; y++) for (let z = 3; z <= 11; z++) expect(world.getSkyLight(x, y, z)).toBe(0);
    expectMatchesReference(world, 'plugged');
  });

  it('water attenuates sky light by 2 per cell of depth; ice and leaves attenuate too', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 0), flat(20));
    // A 20-deep sea over the whole world.
    for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) for (let y = 21; y <= 40; y++) world.setCell(x, y, z, WATER);
    drain(engine);
    for (let d = 1; d <= 9; d++) expect(world.getSkyLight(10, 41 - d, 8), `depth ${d}`).toBe(Math.max(0, 15 - 2 * d));
    expect(world.getChunk(0, 0)!.heightmap[8 | (8 << 4)]).toBe(41);
    // Ice cap: one step down into ice costs 2, then water below continues.
    world.setCell(10, 41, 8, ICE);
    drain(engine);
    expect(world.getSkyLight(10, 41, 8)).toBe(13);
    // Leaves cost 1 downward.
    world.setCell(20, 50, 8, LEAVES);
    world.setCell(20, 49, 8, LEAVES);
    drain(engine);
    expect(world.getSkyLight(20, 48, 8)).toBe(14); // neighbours at 15 feed it sideways
    expectMatchesReference(world);
    // Drain the sea again: back to open sky down to the floor.
    for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) for (let y = 21; y <= 41; y++) world.setCell(x, y, z, AIR);
    drain(engine);
    expect(world.getSkyLight(10, 21, 8)).toBe(15);
    expectMatchesReference(world);
    expectHeightmapsCorrect(world);
  });

  it('removing emitters leaves no ghost light', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 1), flat(60));
    // Dark cave across the 4-chunk corner.
    for (let x = 4; x < 28; x++) for (let z = 4; z < 28; z++) for (let y = 20; y < 26; y++) world.setCell(x, y, z, AIR);
    drain(engine);
    world.setCell(15, 22, 15, LAMP);
    world.setCell(17, 22, 16, TORCH);
    world.setCell(10, 21, 20, LAVA);
    drain(engine);
    expect(world.getBlockLight(15, 22, 15)).toBe(15);
    expect(world.getBlockLight(16, 22, 15)).toBe(14);
    expectMatchesReference(world, 'lit');
    world.setCell(15, 22, 15, AIR);
    drain(engine);
    expect(world.getBlockLight(15, 22, 15)).toBe(11); // now fed by the torch 3 steps away
    world.setCell(17, 22, 16, AIR);
    world.setCell(10, 21, 20, AIR);
    drain(engine);
    for (const c of world.chunks.values()) for (let i = 0; i < c.light.length; i++) expect(c.light[i]! & 15).toBe(0);
    expectMatchesReference(world, 'dark');
  });

  it('an opaque emitter lights its surroundings but blocks light passing through', () => {
    const { world, engine } = buildWorld(grid(0, 0, 0, 0), flat(60));
    for (let x = 1; x < 15; x++) for (let y = 20; y < 23; y++) world.setCell(x, y, 8, AIR); // 1-wide tunnel
    world.setCell(2, 21, 8, TORCH);
    drain(engine);
    expect(world.getBlockLight(6, 21, 8)).toBe(10);
    world.setCell(4, 21, 8, LAMP);
    drain(engine);
    expect(world.getBlockLight(4, 21, 8)).toBe(15);
    expect(world.getBlockLight(6, 21, 8)).toBe(13);
    world.setCell(4, 21, 8, STONE);
    drain(engine);
    // Around the plug through the 3-high tunnel: (3,21) (3,22) (4,22) (5,22) (5,21) (6,21).
    expect(world.getBlockLight(6, 21, 8)).toBe(8);
    expectMatchesReference(world);
  });

  it('opening a plug on a chunk border lets light in from the other chunk only (all 4 directions)', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 1), flat(60));
    // Four sealed 1x1 tunnels, each crossing a chunk border, lit only from the far side.
    const tunnels: Array<{ lamp: [number, number, number]; plug: [number, number, number]; cells: Array<[number, number, number]> }> = [];
    const along = (axis: 'x' | 'z', y: number, fixed: number, lamp: number, plug: number) => {
      const cells: Array<[number, number, number]> = [];
      for (let t = 8; t <= 24; t++) cells.push(axis === 'x' ? [t, y, fixed] : [fixed, y, t]);
      const at = (t: number): [number, number, number] => (axis === 'x' ? [t, y, fixed] : [fixed, y, t]);
      tunnels.push({ lamp: at(lamp), plug: at(plug), cells });
    };
    along('x', 30, 8, 10, 16); // light from -x into lx = 0
    along('x', 34, 8, 21, 15); // light from +x into lx = 15
    along('z', 38, 8, 10, 16); // light from -z into lz = 0
    along('z', 42, 8, 21, 15); // light from +z into lz = 15
    for (const t of tunnels) {
      for (const [x, y, z] of t.cells) world.setCell(x, y, z, AIR);
      world.setCell(...t.lamp, LAMP);
      world.setCell(...t.plug, STONE);
    }
    drain(engine);
    for (const t of tunnels) {
      world.setCell(...t.plug, AIR);
      drain(engine);
      expect(world.getBlockLight(...t.plug)).toBe(9); // 6 steps from the lamp
    }
    expectMatchesReference(world);
  });

  it('never writes into an added-but-unlit chunk; lighting it later pulls everything across', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    addLit(world, engine, makeFlatChunk(0, 0, 30));
    const late = makeFlatChunk(1, 0, 30);
    world.addChunk(late); // not lit yet
    // Edits on chunk 0's east border, including a lamp and an opening into the stone.
    world.setCell(15, 25, 8, LAMP);
    world.setCell(15, 31, 3, TORCH);
    for (let y = 20; y <= 30; y++) world.setCell(15, y, 12, AIR);
    world.setCell(16, 28, 8, LAMP); // inside the unlit chunk: ignored until initChunk
    drain(engine);
    expect(late.light.every((v) => v === 0)).toBe(true);
    expect(late.lit).toBe(false);
    expectMatchesReference(world, 'before');
    engine.initChunk(late);
    expect(late.lit).toBe(true);
    expect(engine.pending).toBe(0);
    expectMatchesReference(world, 'after');
    expectHeightmapsCorrect(world);
  });

  it('a chunk added after its neighbour was edited sees the edits', () => {
    const { world, engine } = buildWorld(grid(0, 0, 0, 0), terrain);
    const rng = new Rng(5);
    for (let k = 0; k < 120; k++) {
      const x = 15 - rng.int(0, 2);
      const z = rng.int(0, 15);
      const y = rng.int(20, 70);
      const pick = rng.int(0, 5);
      world.setCell(x, y, z, [AIR, AIR, STONE, LAMP, TORCH, WATER][pick]!);
      if (k % 7 === 0) engine.update(rng.int(0, 40));
    }
    // Leave work pending on purpose: initChunk must cope with an unfinished neighbour.
    addLit(world, engine, terrain(1, 0));
    drain(engine);
    expectMatchesReference(world);
    expectHeightmapsCorrect(world);
  });

  it('the virtual sky above the world feeds a fully covered top layer', () => {
    const { world, engine } = buildWorld(grid(0, 0, 0, 0), flat(10));
    // Cover the whole top layer so no top cell has an open neighbour at its side.
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.setCell(x, 127, z, WATER);
    world.setCell(4, 127, 4, LEAVES);
    world.setCell(9, 127, 9, ICE);
    world.setCell(12, 127, 3, STONE);
    drain(engine);
    expect(world.getSkyLight(0, 127, 0)).toBe(13);
    expect(world.getSkyLight(4, 127, 4)).toBe(14);
    expect(world.getSkyLight(9, 127, 9)).toBe(13);
    expect(world.getSkyLight(12, 127, 3)).toBe(0);
    expect(world.getSkyLight(4, 126, 4)).toBe(14);
    expect(world.getSkyLight(0, 126, 0)).toBe(13);
    expect(world.getSkyLight(12, 126, 3)).toBe(12);
    expect(world.getSkyLight(0, 11, 0)).toBe(13);
    expectMatchesReference(world, 'covered');
    expectHeightmapsCorrect(world);
    // Uncover everything: back to full open sky.
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) world.setCell(x, 127, z, AIR);
    drain(engine);
    expect(world.getSkyLight(0, 11, 0)).toBe(15);
    expectMatchesReference(world, 'uncovered');
  });

  it('raising a column top while the column below is still propagating', () => {
    const { world, engine } = buildWorld(grid(0, 0, 0, 0), flat(40));
    // A slab roof at y=50; then open a hole and, before processing, re-close the column lower down.
    for (let x = 2; x <= 12; x++) for (let z = 2; z <= 12; z++) world.setCell(x, 50, z, STONE);
    drain(engine);
    for (const budget of [0, 1, 3, 6, 15]) {
      world.setCell(7, 50, 7, AIR);
      engine.update(budget);
      world.setCell(7, 45, 7, LEAVES);
      engine.update(budget);
      world.setCell(7, 47, 7, WATER);
      engine.update(budget);
      world.setCell(7, 50, 7, STONE);
      drain(engine);
      expectMatchesReference(world, `budget ${budget}`);
      world.setCell(7, 45, 7, AIR);
      world.setCell(7, 47, 7, AIR);
      drain(engine);
    }
    expectHeightmapsCorrect(world);
  });

  it('handles the bottom and top layers (y = 0 and y = 127)', () => {
    const { world, engine } = buildWorld(grid(0, 1, 0, 0), flat(0));
    world.setCell(3, 127, 3, STONE);
    world.setCell(4, 127, 3, WATER);
    world.setCell(5, 127, 3, LEAVES);
    world.setCell(15, 127, 7, ICE);
    world.setCell(16, 127, 7, STONE);
    world.setCell(8, 0, 8, LAMP); // replaces deeprock at y=0
    world.setCell(9, 0, 8, AIR);
    drain(engine);
    expect(world.getSkyLight(4, 127, 3)).toBe(13);
    expect(world.getSkyLight(5, 127, 3)).toBe(14);
    expect(world.getSkyLight(3, 126, 3)).toBe(14);
    expect(world.getBlockLight(8, 1, 8)).toBe(14);
    expect(world.getBlockLight(9, 0, 8)).toBe(14);
    expectMatchesReference(world, 'placed');
    world.setCell(3, 127, 3, AIR);
    world.setCell(5, 127, 3, AIR);
    world.setCell(8, 0, 8, STONE);
    drain(engine);
    expectMatchesReference(world, 'removed');
    expectHeightmapsCorrect(world);
  });
});

// ===================================================================== randomized

interface FuzzOptions {
  seed: number;
  coords: Array<[number, number]>;
  edits: number;
  checkEvery: number;
  maxBudget: number;
}

const EDIT_CELLS = [AIR, AIR, AIR, STONE, STONE, LEAVES, WATER, ICE, GLASS, LAMP, TORCH, LAVA];

/** A random edit position biased toward the interesting places. */
function randomPos(rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number): [number, number, number] {
  const r = rng.next();
  let x = rng.int(minX, maxX);
  let z = rng.int(minZ, maxZ);
  let y = rng.int(25, 75);
  if (r < 0.25) {
    // On a chunk border (either side).
    if (rng.chance(0.5)) x = (Math.floor(x / 16) * 16 + (rng.chance(0.5) ? 0 : 15)) | 0;
    else z = (Math.floor(z / 16) * 16 + (rng.chance(0.5) ? 0 : 15)) | 0;
  } else if (r < 0.35) {
    // A chunk corner column.
    x = Math.floor(x / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
    z = Math.floor(z / 16) * 16 + (rng.chance(0.5) ? 0 : 15);
  } else if (r < 0.42) {
    y = rng.chance(0.5) ? 0 : WORLD_HEIGHT - 1;
  } else if (r < 0.5) {
    y = rng.int(0, WORLD_HEIGHT - 1);
  }
  return [x, y, z];
}

/** One random edit: single cells, small clusters, slabs, or edits at a column's top. */
function randomEdit(world: World, rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number): void {
  const [x, y, z] = randomPos(rng, minX, maxX, minZ, maxZ);
  const cell = EDIT_CELLS[rng.int(0, EDIT_CELLS.length - 1)]!;
  const r = rng.next();
  if (r < 0.15) {
    // Column top: place right on it, float above it, or remove the topmost light-blocker.
    const c = world.chunkAt(x, z);
    if (!c) return;
    const h = c.heightmap[(x & 15) | ((z & 15) << 4)]!;
    const t = rng.next();
    if (t < 0.4) world.setCell(x, Math.min(h, WORLD_HEIGHT - 1), z, cell === AIR ? STONE : cell);
    else if (t < 0.6) world.setCell(x, Math.min(h + rng.int(1, 12), WORLD_HEIGHT - 1), z, cell === AIR ? LEAVES : cell);
    else if (h > 0) world.setCell(x, h - 1, z, AIR);
  } else if (r < 0.22) {
    // A slab (roof / floor / pool) up to 5x5.
    const sx = rng.int(2, 5);
    const sz = rng.int(2, 5);
    for (let dx = 0; dx < sx; dx++) for (let dz = 0; dz < sz; dz++) world.setCell(x + dx, y, z + dz, cell);
  } else if (r < 0.35) {
    const n = rng.int(2, 6);
    for (let j = 0; j < n; j++) world.setCell(x + (j % 2), y, z + (j >> 1), cell);
  } else {
    world.setCell(x, y, z, cell);
  }
}

function fuzz(opts: FuzzOptions): void {
  const { world, engine } = buildWorld(opts.coords, terrain);
  const rng = new Rng(opts.seed);
  const xs = opts.coords.map((c) => c[0]);
  const zs = opts.coords.map((c) => c[1]);
  const minX = Math.min(...xs) * 16;
  const maxX = Math.max(...xs) * 16 + 15;
  const minZ = Math.min(...zs) * 16;
  const maxZ = Math.max(...zs) * 16 + 15;
  for (let k = 1; k <= opts.edits; k++) {
    randomEdit(world, rng, minX, maxX, minZ, maxZ);
    const r = rng.next();
    if (r < 0.3) engine.update(rng.int(0, opts.maxBudget));
    else if (r < 0.4) engine.update();
    if (k % opts.checkEvery === 0 || k === opts.edits) {
      drain(engine);
      expectMatchesReference(world, `seed ${opts.seed} after ${k} edits`);
      expectHeightmapsCorrect(world);
    }
  }
}

describe('randomized edit sequences vs brute-force reference', () => {
  it('2x2 chunks around the origin (negative coords), interleaved budgets', () => {
    fuzz({ seed: 1, coords: grid(-1, 0, -1, 0), edits: 600, checkEvery: 60, maxBudget: 60 });
  });

  it('3x1 chunks, tiny budgets', () => {
    fuzz({ seed: 2, coords: grid(0, 2, 0, 0), edits: 500, checkEvery: 50, maxBudget: 8 });
  });

  it('2x2 chunks, large budgets', () => {
    fuzz({ seed: 3, coords: grid(3, 4, -2, -1), edits: 600, checkEvery: 100, maxBudget: 2000 });
  });

  it('2x2 chunks spanning sea and land, mixed budgets, many seeds', () => {
    for (const seed of [10, 11, 12, 13]) {
      fuzz({ seed, coords: grid(-2, -1, -1, 0), edits: 250, checkEvery: 125, maxBudget: 200 });
    }
  });

  it('chunks that stay unlit while their neighbours are edited, then get lit', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    const rng = new Rng(21);
    const coords = shuffled(grid(-1, 1, 0, 1), 8);
    // Everything is in the world from the start, but chunks get lit one by one.
    const chunks = coords.map(([cx, cz]) => terrain(cx, cz));
    for (const c of chunks) world.addChunk(c);
    for (const c of chunks) {
      engine.initChunk(c);
      for (let k = 0; k < 60; k++) randomEdit(world, rng, -16, 31, 0, 31);
      if (rng.chance(0.5)) engine.update(rng.int(0, 100));
      // Unlit chunks have not been touched by the engine.
      for (const u of chunks) if (!u.lit) expect(u.light.every((v) => v === 0)).toBe(true);
    }
    drain(engine);
    expectMatchesReference(world);
    expectHeightmapsCorrect(world);
  });

  it('result does not depend on how update(budget) calls interleave with the edits', () => {
    const rng0 = new Rng(77);
    const edits: Array<[number, number, number, number]> = [];
    for (let k = 0; k < 250; k++) {
      const [x, y, z] = randomPos(rng0, 0, 31, 0, 15);
      edits.push([x, y, z, EDIT_CELLS[rng0.int(0, EDIT_CELLS.length - 1)]!]);
    }
    const run = (schedule: (k: number, engine: LightEngine) => void): Map<number, Uint8Array> => {
      const { world, engine } = buildWorld(grid(0, 1, 0, 0), terrain);
      edits.forEach(([x, y, z, cell], k) => {
        world.setCell(x, y, z, cell);
        schedule(k, engine);
      });
      drain(engine);
      return lightSnapshot(world);
    };
    const eager = run((_k, e) => e.update());
    const lazy = run(() => {});
    const r = new Rng(3);
    const budgeted = run((_k, e) => e.update(r.int(0, 30)));
    for (const [key, bytes] of eager) {
      expect(Buffer.from(lazy.get(key)!).equals(Buffer.from(bytes))).toBe(true);
      expect(Buffer.from(budgeted.get(key)!).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('chunks streamed in while edits are still pending', () => {
    const world = new World(1);
    const engine = new LightEngine(world);
    engine.attach();
    const rng = new Rng(11);
    const order = shuffled(grid(0, 2, 0, 1), 4);
    for (const [cx, cz] of order) {
      addLit(world, engine, terrain(cx, cz));
      for (let k = 0; k < 40; k++) {
        const loaded = [...world.chunks.values()];
        const c = loaded[rng.int(0, loaded.length - 1)]!;
        const [x, y, z] = randomPos(rng, c.cx * 16, c.cx * 16 + 15, c.cz * 16, c.cz * 16 + 15);
        world.setCell(x, y, z, EDIT_CELLS[rng.int(0, EDIT_CELLS.length - 1)]!);
        if (rng.chance(0.3)) engine.update(rng.int(0, 50));
      }
    }
    drain(engine);
    expectMatchesReference(world);
    expectHeightmapsCorrect(world);
  });

  it('test terrain around the origin has the features the comparisons rely on', () => {
    const { world } = buildWorld(grid(-1, 1, -1, 1), terrain);
    const ref = computeReference(world);
    expect(ref.sweeps).toBeGreaterThan(2);
    const count = new Map<number, number>();
    let openSea = 0;
    let darkAir = 0;
    let shadedAir = 0;
    for (const c of world.chunks.values()) {
      for (let i = 0; i < c.cells.length; i++) count.set(c.cells[i]!, (count.get(c.cells[i]!) ?? 0) + 1);
      for (let col = 0; col < 256; col++) {
        const top = cellIndex(col & 15, TEST_SEA - 1, col >> 4);
        // Top water cell under open sky: one step into water costs 2.
        if (c.cells[top] === WATER && c.heightmap[col] === TEST_SEA) {
          expect(c.light[top]! >> 4).toBe(13);
          openSea++;
        }
        for (let y = 1; y < c.heightmap[col]!; y++) {
          const i = col | (y << 8);
          if (c.cells[i] !== AIR) continue;
          const s = c.light[i]! >> 4;
          if (s === 0) darkAir++;
          else if (s < 15) shadedAir++;
        }
      }
    }
    expect(openSea).toBeGreaterThan(50);
    expect(darkAir).toBeGreaterThan(500); // sealed caves
    expect(shadedAir).toBeGreaterThan(200); // overhangs, canopies, cave mouths
    for (const cell of [LEAVES, LAVA, GLASS, ICE, WATER]) expect(count.get(cell) ?? 0, `cell ${cell}`).toBeGreaterThan(0);
    expect((count.get(TORCH) ?? 0) + (count.get(LAMP) ?? 0)).toBeGreaterThan(0);
  });
});
