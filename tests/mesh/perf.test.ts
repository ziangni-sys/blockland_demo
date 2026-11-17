/**
 * Performance budgets (docs: typical terrain section < 2.5 ms, buried ~0.1 ms, empty ~0).
 * Each budget is checked on the MEDIAN of many runs after warm-up, which is robust against
 * a busy machine; the measured numbers are printed for the report.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { rand2 } from '../../src/core/rng';
import { Mesher, buildMesh } from '../../src/mesh/mesher';
import type { MeshInput } from '../../src/mesh/types';
import { idx, makeInput, put, quadCount } from './helpers';

/** A 16^3 section of rolling terrain: turf over dirt over stone, plants, sky light above ground. */
export function terrainSection(seed = 1): MeshInput {
  const input = makeInput(16, 16, 16, 0);
  for (let z = -1; z <= 16; z++) {
    for (let x = -1; x <= 16; x++) {
      const h = Math.round(7 + 3 * Math.sin(x / 3.1 + seed) + 2.5 * Math.cos(z / 4.3) + 2 * rand2(x, z, seed));
      for (let y = -1; y <= 16; y++) {
        let cell = 0;
        if (y < h - 3) cell = makeCell(rand2(x * 7 + y, z, seed) < 0.03 ? B.COAL_ORE : B.STONE);
        else if (y < h) cell = makeCell(B.DIRT);
        else if (y === h) cell = makeCell(B.TURF);
        else if (y === h + 1 && rand2(x, z, seed + 9) < 0.15) cell = makeCell(B.TALL_GRASS);
        put(input, x, y, z, cell);
        const sky = y > h ? 15 : y === h ? 0 : 0;
        input.light![idx(input, x, y, z)] = sky << 4;
      }
    }
  }
  return input;
}

function solidSection(): MeshInput {
  const input = makeInput(16, 16, 16, 0);
  input.cells.fill(makeCell(B.STONE));
  return input;
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

describe('performance', () => {
  it('meets the section budgets', () => {
    const terrain = terrainSection();
    const solid = solidSection();
    const empty = makeInput(16, 16, 16, true);
    const mesher = new Mesher();
    const quads = quadCount(buildMesh(terrain));

    const tTerrainFresh = measure(() => buildMesh(terrain), 100);
    const tTerrainReused = measure(() => mesher.build(terrain), 100);
    const tSolid = measure(() => mesher.build(solid), 200);
    const tSolidFresh = measure(() => buildMesh(solid), 200);
    const tEmpty = measure(() => buildMesh(empty), 200);

    console.log(
      `[mesh perf] terrain ${quads} quads: fresh ${tTerrainFresh.toFixed(3)} ms, reused ${tTerrainReused.toFixed(3)} ms; ` +
        `buried: reused ${tSolid.toFixed(3)} ms, fresh ${tSolidFresh.toFixed(3)} ms; empty ${tEmpty.toFixed(4)} ms`,
    );
    expect(quads).toBeGreaterThan(300);
    expect(tTerrainFresh).toBeLessThan(2.5);
    expect(tTerrainReused).toBeLessThan(2.5);
    expect(tSolid).toBeLessThan(0.15);
    expect(tSolidFresh).toBeLessThan(0.15);
    expect(tEmpty).toBeLessThan(0.05);
  });
});
