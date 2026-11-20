/**
 * Acceptance scenario 44 (docs/ACCEPTANCE.md "形状与凿子"; docs/SHAPES.md 7.1, 16.4), headless,
 * whole simulation, in both modes: under a roof of half slabs it is dark; where a slab of the roof
 * is missing, light comes through.
 *
 * Light is computed only on the client (docs/ARCHITECTURE.md tick order, step 7: the server has no
 * light engine). So what the player sees is read where the player's machine computes it:
 *  - network mode: the client's replica (ClientReplica.light, lit by NetClient.frame from the
 *    columns and cell deltas the server sent): nothing on the server side is lit;
 *  - direct mode there is no client: a copy of the server's world with its own LightEngine, kept up
 *    to date from the server's cell changes, holds the same cells a client's exact copy would (the
 *    light tests in tests/light/scenario44.test.ts compare this engine with the reference of
 *    section 7.4). The server's world itself stays unlit.
 *
 * The roof is built on the server (w.sim): the tools that make partial blocks come in M2.4. The
 * player opens the gap: it stands in the room and mines one slab of the roof above it.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NY } from '../../src/core/dirs';
import { LightEngine } from '../../src/light/engine';
import { getPacked } from '../../src/voxel/parts';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { LOWER, slab, UPPER } from '../shapes';
import { newWorld } from './g6-save-helpers';
import { GROUND, shapesSpec } from './g8-shapes-helpers';
import type { TestWorld } from './world';

/** The room: walls x -3..3, z -3..3, from the ground up to the roof layer; the player at its centre. */
const R = 3;
const ROOF = GROUND + 3;

/** The sky light the player's machine shows at a cell (see the file comment). */
type SkyAt = (x: number, y: number, z: number) => number;

/**
 * The world as the player's machine lights it: the client's replica; in direct mode a copy of the
 * server's world (the server's chunks share one light array: it computes none), kept up to date
 * from the server's cell changes as a replica is from the deltas, and lit by its own engine.
 */
function lightOf(w: TestWorld): SkyAt {
  if (w.client !== null) {
    const r = w.client.replica;
    if (r === null) throw new Error('the client has no replica');
    return (x, y, z) => r.world.getSkyLight(x, y, z);
  }
  const copy = new World(w.sim.world.seed);
  const engine = new LightEngine(copy);
  engine.attach();
  for (const c of w.sim.world.chunks.values()) {
    const l = c.layers();
    copy.addChunk(new Chunk(c.cx, c.cz, l.base.slice(), undefined, l.holes?.slice() ?? null, l.part2?.slice() ?? null));
  }
  for (const c of copy.chunks.values()) engine.initChunk(c);
  w.sim.world.onCellChange((x, y, z) => copy.setCell(x, y, z, getPacked(w.sim.world, x, y, z)));
  return (x, y, z) => {
    engine.update(Infinity);
    return copy.getSkyLight(x, y, z);
  };
}

/** A walled room under a roof of `roof` (per column of the interior). */
function room(w: TestWorld, roof: (x: number, z: number) => number): void {
  const wd = w.sim.world;
  for (let y = GROUND; y <= ROOF; y++) {
    for (let x = -R; x <= R; x++) {
      for (let z = -R; z <= R; z++) {
        const edge = Math.abs(x) === R || Math.abs(z) === R;
        if (edge) wd.setCell(x, y, z, makeCell(B.STONE));
        else if (y === ROOF) wd.setCell(x, y, z, roof(x, z));
      }
    }
  }
}

/** The highest sky light in the room below the roof layer. */
function roomSky(sky: SkyAt): number {
  let m = 0;
  for (let y = GROUND; y < ROOF; y++) for (let x = -R + 1; x < R; x++) for (let z = -R + 1; z < R; z++) m = Math.max(m, sky(x, y, z));
  return m;
}

describe('44. 半砖铺成的屋顶下面是暗的，有缺口的地方透光。', () => {
  for (const [name, roof] of [
    ['lower slabs', () => slab(B.STONE, LOWER)],
    ['upper slabs', () => slab(B.STONE, UPPER)],
    ['a checkerboard of lower and upper slabs', (x: number, z: number) => slab(B.STONE, (x + z) & 1 ? LOWER : UPPER)],
  ] as const) {
    it(`under a roof of ${name} it is dark; the player mines one slab of it and light comes in under the gap`, () => {
      const w = newWorld(shapesSpec(44, { x: 0.5, y: GROUND, z: 0.5 }));
      room(w, roof);
      w.tick(2);
      const sky = lightOf(w);
      w.ready();
      expect(sky(R + 2, GROUND, 0), '(premise) the open sky outside').toBe(15);
      expect(roomSky(sky), 'sky light under the whole roof').toBe(0);
      // The player mines the roof slab above the cell north-east of it (creative: one click), from
      // below: an octant of the slab on its underside.
      const octant = getPacked(w.sim.world, 1, ROOF, -1) === slab(B.STONE, LOWER) ? 0 : 2;
      expect(w.me.mine(1, ROOF, -1, NY, 0, 40, octant)).toBe(true);
      expect(getPacked(w.sim.world, 1, ROOF, -1)).toBe(0);
      w.tick(2);
      // Straight down through the gap, full sky light to the floor; around it, light spreads.
      for (let y = GROUND; y < ROOF; y++) expect(sky(1, y, -1), `under the gap at y ${y}`).toBe(15);
      expect(sky(0, GROUND, 0)).toBe(13);
      // The far corner of the room is lit only from the gap's column, through the room: one level
      // less per cell of the way (3 + 3 cells).
      expect(sky(-2, GROUND, 2)).toBe(15 - 6);
    });
  }
});
