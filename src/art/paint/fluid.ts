/**
 * Liquid tiles. Water is translucent (alpha 150..175) with soft caustic lines; lava is opaque
 * with hot blobs and dark crust flecks. The *_flow variants stream along v (the mesher
 * orients v along the flow direction), and everything wraps so the renderer may scroll them.
 */
import { Canvas, Field, toneIndex } from '../canvas';
import type { Ramp } from '../color';
import * as M from '../materials';
import { fbm, hrand, scatter, sfbm, vnoise, worley, worleyResult } from '../noise';
import { rngOf, S, type Painter } from './kit';

/** Water alpha per ramp tone: darker = clearer, caustic highlights a little denser. */
function waterAlpha(i: number, n: number): number {
  return Math.round(150 + (i / (n - 1)) * 25);
}

function paintWaterField(c: Canvas, f: Field, r: Ramp): void {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = toneIndex(f.get(x, y), r.length, x, y, 0.3);
      c.set(x, y, r[i]!, waterAlpha(i, r.length));
    }
  }
}

const paintWaterStill: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 7, 4.6);
  const w = worleyResult();
  const f = new Field();
  f.each((x, y) => {
    worley(pts, x, y, w);
    const edge = w.f2 - w.f1;
    // Caustic network along cell borders, soft falloff to the cell interiors.
    const line = Math.max(0, 1 - edge / 1.9);
    return 1.45 + line * line * 2.9 + sfbm(x, y, 2, 2, seed + 1) * 0.45;
  });
  paintWaterField(c, f, M.WATER);
};

const paintWaterFlow: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const f = new Field();
  // Few lattice cells along y = streaks running along v.
  f.each((x, y) => 1.6 + (vnoise(x, y, 8, 2, seed + 1) - 0.5) * 1.6 + (vnoise(x, y, 16, 4, seed + 2) - 0.5) * 0.5);
  for (let i = 0; i < 6; i++) {
    const x = rng.int(0, S - 1);
    const y0 = rng.int(0, S - 1);
    const len = rng.int(4, 8);
    for (let k = 0; k < len; k++) f.set(x, y0 + k, k === 0 ? 4 : 3.2);
  }
  paintWaterField(c, f, M.WATER);
};

function paintLavaField(c: Canvas, f: Field): void {
  const r = M.LAVA;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) c.set(x, y, r[toneIndex(f.get(x, y), r.length, x, y, 0.25)]!);
}

const paintLavaStill: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 6, 5);
  const w = worleyResult();
  const f = new Field();
  f.each((x, y) => {
    worley(pts, x, y, w);
    const hot = Math.max(0, 1 - w.f1 / 4.6);
    let t = 1.65 + hot * 2.9 + sfbm(x, y, 4, 2, seed + 1) * 0.6;
    // Crust flecks where the surface cools between blobs.
    const crust = fbm(x, y, 4, 2, seed + 2);
    if (w.f2 - w.f1 < 1.2 && crust > 0.5) t = Math.min(t, 0.2 + crust * 0.9);
    if (hrand(x, y, seed + 3) > 0.96) t = 0;
    return t;
  });
  paintLavaField(c, f);
};

const paintLavaFlow: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 6, 4);
  const w = worleyResult();
  const f = new Field();
  f.each((x, y) => {
    // Cells stretched along v (sy < 1) give elongated molten streams.
    worley(pts, x, y, w, 0.4);
    const hot = Math.max(0, 1 - w.f1 / 3.6);
    let t = 1.7 + hot * 2.6 + (vnoise(x, y, 8, 2, seed + 1) - 0.5) * 1.1;
    if (w.f2 - w.f1 < 0.9 && vnoise(x, y, 4, 2, seed + 2) > 0.5) t = Math.min(t, 0.8);
    if (hrand(x, y, seed + 3) > 0.965) t = 0.1;
    return t;
  });
  paintLavaField(c, f);
};

export const FLUID_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  water_still: paintWaterStill,
  water_flow: paintWaterFlow,
  lava_still: paintLavaStill,
  lava_flow: paintLavaFlow,
});
