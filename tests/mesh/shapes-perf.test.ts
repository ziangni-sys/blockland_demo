/**
 * Mesher budgets with partial cells (docs/SHAPES.md 15): a 16^3 section half of which is half slabs
 * and stairs (< 5 ms), and a half-slab raft filling the 24^3 padded box that client/structures.ts
 * still meshes synchronously on the main thread (< 8 ms). Medians of many runs after warm-up; the
 * numbers are printed for the report.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell, makePart } from '../../src/blocks/cell';
import { HALF_FILL, canonCell } from '../../src/blocks/shapes';
import type { Dir } from '../../src/core/dirs';
import { Mesher, buildMesh } from '../../src/mesh/mesher';
import type { MeshInput } from '../../src/mesh/types';
import { LOWER, UPPER, stairFill } from '../shapes';
import { idx, makeInput, put, quadCount } from './helpers';


/**
 * A 16^3 section of rolling terrain more than half of whose cells are half slabs and stairs: the
 * ground below the surface is made of two-part cells (a lower and an upper slab of two materials,
 * or a west and an east one), the surface cell of each column is a stair rising toward the higher
 * neighbour or a lower slab, and every fourth column carries a small post of vertical slabs.
 * Sky light above the ground.
 */
export function slabSection(seed = 1): MeshInput {
  const input = makeInput(16, 16, 16, 0);
  const part = (mat: number, fill: number) => makePart(mat, 0, ~fill & 0xff);
  const height = (x: number, z: number) => Math.round(9 + 3 * Math.sin(x / 3.1 + seed) + 2.5 * Math.cos(z / 4.3));
  for (let z = -1; z <= 16; z++) {
    for (let x = -1; x <= 16; x++) {
      const h = height(x, z);
      // The stair rises toward the highest of the four neighbours that is higher than this column.
      let rise = -1;
      let best = h;
      for (const [d, dx, dz] of [
        [0, 1, 0],
        [1, -1, 0],
        [4, 0, 1],
        [5, 0, -1],
      ] as const) {
        const n = height(x + dx, z + dz);
        if (n > best) {
          best = n;
          rise = d;
        }
      }
      for (let y = -1; y <= 16; y++) {
        let cell = 0;
        if (y < h) {
          const pair = ((x + z + y) & 1) === 0;
          cell = pair
            ? canonCell(part(B.STONE, LOWER), part(B.COBBLE, UPPER))
            : canonCell(part(y < h - 3 ? B.STONE : B.DIRT, HALF_FILL[1]!), part(B.CLAY, HALF_FILL[0]!));
        } else if (y === h) cell = rise >= 0 ? part(B.TURF, stairFill(rise as Dir)) : part(B.TURF, LOWER);
        else if (y <= h + 2 && (x & 3) === 0 && (z & 3) === 0) cell = part(B.PLANKS_OAK, HALF_FILL[4]!);
        put(input, x, y, z, cell);
        input.light![idx(input, x, y, z)] = y > h ? 0xf0 : 0x00;
      }
    }
  }
  return input;
}

/**
 * A raft in a 22 x 22 x 22 box (padded 24^3): a deck of lower plank slabs, railings of vertical
 * slabs, a stair ramp, a cabin of upper slabs and a log mast with slab yards. No voxel light.
 */
export function slabRaft(): MeshInput {
  const n = 22;
  const input = makeInput(n, n, n, false);
  const deck = makePart(B.PLANKS_OAK, 0, ~LOWER & 0xff);
  for (let x = 0; x < n; x++) {
    for (let z = 0; z < n; z++) {
      put(input, x, 0, z, deck);
      if (x === 0 || z === 0 || x === n - 1 || z === n - 1) {
        const side = x === 0 ? 1 : x === n - 1 ? 0 : z === 0 ? 5 : 4;
        for (let y = 1; y <= 2; y++) put(input, x, y, z, makePart(B.PLANKS_PINE, 0, ~HALF_FILL[side]! & 0xff));
      }
    }
  }
  for (let i = 0; i < 8; i++) put(input, 3 + i, 1 + Math.floor(i / 2), 4, makePart(B.COBBLE, 0, ~(i % 2 === 0 ? LOWER : stairFill(0)) & 0xff));
  for (let x = 12; x < 20; x++) {
    for (let z = 12; z < 20; z++) {
      for (let y = 1; y <= 4; y++) {
        const wall = x === 12 || z === 12 || x === 19 || z === 19;
        if (wall) put(input, x, y, z, makePart(B.PLANKS_OAK, 0, ~(y % 2 ? LOWER : UPPER) & 0xff));
      }
      put(input, x, 5, z, makePart(B.PLANKS_PINE, 0, ~UPPER & 0xff));
    }
  }
  for (let y = 1; y < n; y++) put(input, 6, y, 16, makeCell(B.LOG_OAK, 1));
  for (let x = 1; x < n - 1; x++) for (const y of [8, 14, 19]) put(input, x, y, 16, makePart(B.CANVAS, 0, ~LOWER & 0xff));
  put(input, 6, 8, 16, makeCell(B.LOG_OAK, 1));
  put(input, 6, 14, 16, makeCell(B.LOG_OAK, 1));
  put(input, 6, 19, 16, makeCell(B.LOG_OAK, 1));
  return input;
}

/** Share of the interior cells that are partial. */
function partialShare(input: MeshInput): number {
  let n = 0;
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) if (input.holes![idx(input, x, y, z)] !== 0) n++;
  return n / 4096;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function measure(fn: () => void, runs: number): number {
  for (let i = 0; i < Math.min(20, runs); i++) fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return median(t);
}

describe('performance with partial cells', () => {
  it('meets the budgets of docs/SHAPES.md 15: slab section < 5 ms, 24^3 slab raft < 8 ms', () => {
    const section = slabSection();
    const raft = slabRaft();
    const mesher = new Mesher();
    const sectionQuads = quadCount(buildMesh(section));
    const raftQuads = quadCount(buildMesh(raft));
    const tSection = measure(() => mesher.build(section), 60);
    const tSectionFresh = measure(() => buildMesh(section), 60);
    const tRaft = measure(() => mesher.build(raft), 60);
    console.log(
      `[mesh perf, partial] slab section ${sectionQuads} quads: reused ${tSection.toFixed(3)} ms, fresh ${tSectionFresh.toFixed(3)} ms; ` +
        `slab raft 24^3 ${raftQuads} quads: ${tRaft.toFixed(3)} ms`,
    );
    expect(sectionQuads).toBeGreaterThan(2000);
    expect(partialShare(section)).toBeGreaterThan(0.5);
    expect(raftQuads).toBeGreaterThan(3000);
    expect(tSection).toBeLessThan(5);
    expect(tSectionFresh).toBeLessThan(5);
    expect(tRaft).toBeLessThan(8);
  });
});
