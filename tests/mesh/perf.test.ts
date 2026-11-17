/**
 * Performance budgets (docs: typical terrain section < 2.5 ms, buried ~0.1 ms, empty ~0).
 * Each budget is checked on the MEDIAN of many runs after warm-up, which is robust against
 * a busy machine; the measured numbers are printed for the report.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { liquidState, makeCell } from '../../src/blocks/cell';
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
        input.light![idx(input, x, y, z)] = y > h ? 0xf0 : 0;
      }
    }
  }
  return input;
}

/** A 16^3 ocean section: sand floor, water up to y = 13, open sky above. */
function oceanSection(): MeshInput {
  const input = makeInput(16, 16, 16, 0);
  for (let z = -1; z <= 16; z++) {
    for (let x = -1; x <= 16; x++) {
      for (let y = -1; y <= 16; y++) {
        put(input, x, y, z, y < 3 ? makeCell(B.SAND) : y < 14 ? makeCell(B.WATER) : 0);
        input.light![idx(input, x, y, z)] = (y >= 14 ? 15 : y >= 3 ? Math.max(0, 15 - 2 * (14 - y)) : 0) << 4;
      }
    }
  }
  return input;
}

/**
 * Worst case for liquids: terraced terrain with water spilling over every step — flowing
 * cells of mixed levels on each terrace and falling columns down each riser. Most liquid
 * cells have exposed (double-sided) faces and sloped tops.
 */
function cascadeSection(): MeshInput {
  const input = makeInput(16, 16, 16, 0);
  for (let z = -1; z <= 16; z++) {
    for (let x = -1; x <= 16; x++) {
      const ground = 2 + ((x + 1) >> 2) * 3; // a 3-high step every 4 columns
      for (let y = -1; y <= 16; y++) {
        let cell = 0;
        if (y < ground) cell = makeCell(B.STONE);
        else if (y === ground && (x + z) % 3 !== 0) cell = makeCell(B.WATER, liquidState((x + 2 * z) & 7, false));
        else if (y > ground && y < ground + 4 && ((x + 1) & 3) === 0 && z % 2 === 0) cell = makeCell(B.WATER, liquidState(0, true));
        put(input, x, y, z, cell);
        input.light![idx(input, x, y, z)] = y >= ground ? 0xf0 : 0;
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
    const ocean = oceanSection();
    const cascade = cascadeSection();
    const mesher = new Mesher();
    const quads = quadCount(buildMesh(terrain));
    const oceanQuads = quadCount(buildMesh(ocean));
    const cascadeQuads = quadCount(buildMesh(cascade));

    const tTerrainFresh = measure(() => buildMesh(terrain), 100);
    const tTerrainReused = measure(() => mesher.build(terrain), 100);
    const tSolid = measure(() => mesher.build(solid), 200);
    const tSolidFresh = measure(() => buildMesh(solid), 200);
    const tEmpty = measure(() => buildMesh(empty), 200);
    const tOcean = measure(() => buildMesh(ocean), 100);
    const tCascade = measure(() => buildMesh(cascade), 100);

    console.log(
      `[mesh perf] terrain ${quads} quads: fresh ${tTerrainFresh.toFixed(3)} ms, reused ${tTerrainReused.toFixed(3)} ms; ` +
        `buried: reused ${tSolid.toFixed(3)} ms, fresh ${tSolidFresh.toFixed(3)} ms; empty ${tEmpty.toFixed(4)} ms; ` +
        `ocean ${oceanQuads} quads: fresh ${tOcean.toFixed(3)} ms; cascade ${cascadeQuads} quads: fresh ${tCascade.toFixed(3)} ms`,
    );
    expect(quads).toBeGreaterThan(300);
    expect(cascadeQuads).toBeGreaterThan(1000);
    expect(tTerrainFresh).toBeLessThan(2.5);
    expect(tTerrainReused).toBeLessThan(2.5);
    expect(tOcean).toBeLessThan(2.5);
    expect(tCascade).toBeLessThan(2.5);
    // "about 0.1 ms" for a buried section: allow 2.5x headroom for a loaded test machine.
    expect(tSolid).toBeLessThan(0.25);
    expect(tSolidFresh).toBeLessThan(0.25);
    expect(tEmpty).toBeLessThan(0.05);
  });
});
