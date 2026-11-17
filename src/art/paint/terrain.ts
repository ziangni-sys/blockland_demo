/**
 * Natural terrain tiles: stone, rubble, dirt, turf, sand, gravel, deeprock, obsidian, ores,
 * snow, ice, clay.
 */
import { Canvas, Field, forEllipse, paintField, toneIndex, wrap } from '../canvas';
import { mix, type Ramp } from '../color';
import * as M from '../materials';
import { fbm, hrand, scatter, sfbm, vnoise, worley, worleyResult } from '../noise';
import { bevel, growBlob, regionMap, rngOf, S, seedOf, type Painter } from './kit';

// ---------------------------------------------------------------- stone

/** Tone field of the stone strata (shared by stone and every ore). */
function stoneField(seed: number): Field {
  const f = new Field();
  const rng = rngOf(seed, 1);
  const bandTone = [0, 1, 2, 3].map(() => (rng.next() - 0.5) * 0.8);
  // Strata: four 4-px layers whose boundaries wander with a periodic warp along x.
  const warpAt = (x: number, y: number): number => sfbm(x, 0, 2, 2, seed + 11) * 1.7 + sfbm(x, y, 4, 1, seed + 12) * 0.45;
  f.each((x, y) => {
    const yy = y + warpAt(x, y);
    const band = wrap(Math.floor(yy / 4), 4);
    const fr = yy / 4 - Math.floor(yy / 4);
    let t = 2 + bandTone[band]!;
    if (fr < 0.22) t += 0.42;
    else if (fr > 0.78) t -= 0.42;
    t += sfbm(x, y, 4, 2, seed + 13) * 0.3;
    return t;
  });
  // Partial dark seams where the strata part.
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < S; y++) {
      const a = Math.floor((y + warpAt(x, y)) / 4);
      const b = Math.floor((y + 1 + warpAt(x, y + 1)) / 4);
      if (a !== b && vnoise(x, y, 4, 4, seed + 14) > 0.42) f.set(x, y, Math.min(f.get(x, y), 0.6));
    }
  }
  // Chips: short lit flakes with a shadowed underside, aligned with the strata.
  for (let i = 0; i < 7; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    const len = rng.int(1, 3);
    for (let k = 0; k < len; k++) {
      f.set(x + k, y, Math.max(f.get(x + k, y), 2.6) + 0.5);
      f.set(x + k + 1, y + 1, Math.min(f.get(x + k + 1, y + 1), 1.4) - 0.3);
    }
  }
  return f;
}

export const paintStone: Painter = (c, seed) => paintField(c, stoneField(seed), M.STONE);

/** Stone base used under ores (identical to the stone tile so ore veins blend into walls). */
function paintStoneBase(c: Canvas): Field {
  const f = stoneField(seedOf('stone'));
  paintField(c, f, M.STONE);
  return f;
}

// ---------------------------------------------------------------- rubble (cobble)

export const paintRubble: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 8, 5);
  const tone = pts.map(() => 1.6 + rng.next() * 1.1);
  const region = regionMap();
  const w = worleyResult();
  // Mortar where two cells meet; the f3 test rounds the stones off at triple junctions.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      worley(pts, x, y, w);
      const gap = w.f2 - w.f1 < 1.15 || w.f3 - w.f1 < 2.3;
      region[y * S + x] = gap ? -1 : w.id;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const id = region[y * S + x]!;
      if (id < 0) {
        // Mortar: darkest, a touch lighter where a stone above casts no shadow.
        const above = region[wrap(y - 1) * S + x]!;
        const m = above < 0 && hrand(x, y, seed) > 0.6 ? 1 : 0;
        c.set(x, y, M.RUBBLE_MORTAR[m]!);
        continue;
      }
      worley(pts, x, y, w);
      // Dome shading: toward the top-left of each stone is lit.
      let t = tone[id]! - (w.ox + w.oy) * 0.085 + bevel(region, x, y) * 0.55;
      t += (hrand(x, y, seed + 5) - 0.5) * 0.5;
      c.set(x, y, M.RUBBLE[toneIndex(t, M.RUBBLE.length)]!);
    }
  }
};

// ---------------------------------------------------------------- dirt

function dirtField(seed: number): Field {
  const rng = rngOf(seed, 2);
  const f = new Field();
  f.each((x, y) => 2 + sfbm(x, y, 4, 2, seed + 21) * 0.55 + (hrand(x, y, seed + 22) - 0.5) * 0.35);
  // Clods: small lit lumps with a shadowed lower-right rim.
  const clods = scatter(rng, 9, 4);
  for (const p of clods) {
    const rx = 1.1 + rng.next() * 0.9;
    const ry = 0.9 + rng.next() * 0.6;
    forEllipse(p.x, p.y, rx, ry, (x, y, d, ox, oy) => {
      f.set(x, y, 2.55 - (ox + oy) * 0.45 + (d < 0.5 ? 0.25 : 0));
    });
    // Shadow pixels just below / right of the lump.
    forEllipse(p.x + 0.8, p.y + 0.9, rx, ry, (x, y) => {
      if (f.get(x, y) < 2.5) f.set(x, y, Math.min(f.get(x, y), 1.1));
    });
  }
  // Dark pores.
  for (let i = 0; i < 6; i++) f.set(rng.int(0, S - 1), rng.int(0, S - 1), 0.2);
  return f;
}

export const paintDirt: Painter = (c, seed) => {
  const f = dirtField(seed);
  paintField(c, f, M.DIRT);
  // A few grey pebbles.
  const rng = rngOf(seed, 3);
  for (let i = 0; i < 3; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    c.set(x, y, M.STONE[3]!);
    c.set(x + 1, y, M.STONE[2]!);
    c.set(x + 1, y + 1, M.DIRT[0]!);
  }
};

// ---------------------------------------------------------------- turf

function grassField(seed: number): Field {
  const rng = rngOf(seed, 4);
  const f = new Field();
  f.each((x, y) => 1.7 + sfbm(x, y, 2, 2, seed + 31) * 0.45 + (hrand(x, y, seed + 32) - 0.5) * 0.5);
  // Tufts on a jittered 4x4 grid: two or three short blades leaning slightly.
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const bx = gx * 4 + rng.int(0, 3);
      const by = gy * 4 + rng.int(0, 3);
      const blades = rng.int(2, 3);
      for (let b = 0; b < blades; b++) {
        const x = bx + (b === 0 ? 0 : b === 1 ? -1 : 1);
        const h = b === 0 ? 3 : 2;
        const lean = b === 1 ? -1 : b === 2 ? 1 : 0;
        for (let k = 0; k < h; k++) {
          const px = x + (k === h - 1 ? lean : 0);
          const py = by - k;
          f.set(px, py, k === h - 1 ? 3.6 : 3);
        }
        // Shadow at the blade's foot.
        f.set(x + 1, by + 1, Math.min(f.get(x + 1, by + 1), 0.9));
      }
    }
  }
  // Scattered pale blades.
  for (let i = 0; i < 7; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    f.set(x, y, 4);
    if (rng.chance(0.5)) f.set(x, y + 1, 3.2);
  }
  return f;
}

export const paintTurfTop: Painter = (c, seed) => paintField(c, grassField(seed), M.GRASS);

export const paintTurfSide: Painter = (c) => {
  // The dirt part is exactly the dirt tile, so the side blends into dirt below it.
  paintDirt(c, seedOf('dirt'));
  const seed = seedOf('turf_side');
  const grass = grassField(seedOf('turf_top'));
  for (let x = 0; x < S; x++) {
    // Fringe depth: periodic along x so neighbouring blocks join; occasional long drips.
    let depth = 3 + Math.round(sfbm(x, 0, 4, 2, seed + 41) * 1.6);
    if (hrand(x, 0, seed + 42) > 0.82) depth += 2;
    depth = Math.max(2, Math.min(6, depth));
    for (let y = 0; y < depth; y++) {
      let t = grass.get(x, y + 5);
      if (y === 0) t = Math.max(t, 3); // catches the light along the top edge
      if (y === depth - 1) t = Math.min(t, 1.2); // blade tips curl into shade
      c.set(x, y, M.GRASS[toneIndex(t, M.GRASS.length)]!);
    }
    // Shadow cast on the dirt directly below the fringe.
    c.set(x, depth, M.DIRT[hrand(x, depth, seed) > 0.5 ? 0 : 1]!);
  }
};

// ---------------------------------------------------------------- sand

export const paintSand: Painter = (c, seed) => {
  const f = new Field();
  const phase = hrand(0, 0, seed) * Math.PI * 2;
  f.each((x, y) => {
    // Wind ripples: wavy lines with a 4-px wavelength; the x * 0.5 shear advances the phase
    // by exactly two wavelengths across the tile, so it stays periodic.
    const p = y + x * 0.5 + Math.sin((x / S) * Math.PI * 2 + phase) * 1.3;
    const ripple = Math.cos((p / 4) * Math.PI * 2);
    let t = 2 + ripple * 0.42 + sfbm(x, y, 2, 2, seed + 51) * 0.35;
    const h = hrand(x, y, seed + 52);
    if (h > 0.93) t += 1.2;
    else if (h < 0.05) t -= 1.1;
    return t;
  });
  paintField(c, f, M.SAND, { dither: 0.35 });
};

// ---------------------------------------------------------------- gravel

export const paintGravel: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 15, 3.3);
  const kind = pts.map(() => rng.int(0, M.GRAVEL_KINDS.length - 1));
  const tone = pts.map(() => 1.3 + rng.next() * 1.2);
  const region = regionMap();
  const w = worleyResult();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      worley(pts, x, y, w);
      region[y * S + x] = w.f2 - w.f1 < 0.95 || w.f3 - w.f1 < 1.7 ? -1 : w.id;
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const id = region[y * S + x]!;
      if (id < 0) {
        c.set(x, y, hrand(x, y, seed) > 0.7 ? mix(M.GRAVEL_GAP, M.GRAVEL_KINDS[1]![0]!, 0.5) : M.GRAVEL_GAP);
        continue;
      }
      worley(pts, x, y, w);
      const r = M.GRAVEL_KINDS[kind[id]!]!;
      const t = tone[id]! + bevel(region, x, y) * 0.6 - (w.ox + w.oy) * 0.06;
      c.set(x, y, r[toneIndex(t, r.length)]!);
    }
  }
};

// ---------------------------------------------------------------- deeprock

export const paintDeeprock: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 10, 3.8);
  // Each crystal facet is a tilted plane: brightness is linear in the offset from its seed.
  const nx = pts.map(() => rng.next() * 2 - 1);
  const ny = pts.map(() => rng.next() * 2 - 1);
  const base = pts.map(() => 1.5 + rng.next() * 1.1);
  const veinPairs = new Set<number>();
  for (let i = 0; i < pts.length; i++) if (rng.chance(0.35)) veinPairs.add(i);
  const w = worleyResult();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      worley(pts, x, y, w);
      const edge = w.f2 - w.f1;
      if (edge < 0.9 && (veinPairs.has(w.id) || veinPairs.has(w.id2)) && (w.id + w.id2) % 2 === 0) {
        const lit = hrand(x, y, seed + 3) > 0.75;
        c.set(x, y, M.DEEPROCK_VEIN[lit ? 2 : edge < 0.45 ? 1 : 0]!);
        continue;
      }
      let t = base[w.id]! + (nx[w.id]! * w.ox + ny[w.id]! * w.oy) * 0.32;
      if (edge < 0.8) t = Math.min(t, 0.7);
      c.set(x, y, M.DEEPROCK[toneIndex(t, M.DEEPROCK.length)]!);
    }
  }
};

// ---------------------------------------------------------------- obsidian

export const paintObsidian: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 8, 4.4);
  const nx = pts.map(() => rng.next() * 2 - 1);
  const ny = pts.map(() => rng.next() * 2 - 1);
  const base = pts.map(() => 0.6 + rng.next() * 1.1);
  const w = worleyResult();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      worley(pts, x, y, w);
      const edge = w.f2 - w.f1;
      const t = base[w.id]! + (nx[w.id]! * w.ox + ny[w.id]! * w.oy) * 0.28;
      c.set(x, y, M.OBSIDIAN[toneIndex(t, M.OBSIDIAN.length)]!);
      // Glassy rim light on the side of a facet edge that faces the top-left light.
      if (edge < 1.0 && w.ox + w.oy < 0) {
        const g = edge < 0.5 ? 1 : 0;
        c.set(x, y, M.OBSIDIAN_GLOSS[g]!);
      }
    }
  }
  // A few bright glints at facet corners.
  for (let i = 0; i < 4; i++) {
    const p = pts[i]!;
    const x = Math.floor(p.x) - 1;
    const y = Math.floor(p.y) - 1;
    c.set(x, y, M.OBSIDIAN_GLOSS[i === 0 ? 3 : 2]!);
    if (i < 2) c.set(x + 1, y, M.OBSIDIAN_GLOSS[1]!);
  }
};

// ---------------------------------------------------------------- ores

interface OreStyle {
  ramp: Ramp;
  count: number;
  cells: [number, number];
  compact: number;
  stretch: number;
  minDist: number;
  /** Optional accent painted on some shadow-side pixels (copper patina). */
  accent?: Ramp;
}

function paintOre(c: Canvas, seed: number, style: OreStyle): void {
  const stone = paintStoneBase(c);
  const rng = rngOf(seed);
  const centres = scatter(rng, style.count, style.minDist);
  const region = regionMap();
  centres.forEach((p, id) => {
    const cells = rng.int(style.cells[0], style.cells[1]);
    for (const [dx, dy] of growBlob(rng, cells, style.compact, style.stretch)) {
      region[wrap(Math.floor(p.y) + dy) * S + wrap(Math.floor(p.x) + dx)] = id;
    }
  });
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const id = region[y * S + x]!;
      if (id < 0) {
        // Embed shadow: stone just below / right of a nugget darkens.
        const up = region[wrap(y - 1) * S + x]!;
        const left = region[y * S + wrap(x - 1)]!;
        if (up >= 0 || left >= 0) c.set(x, y, M.STONE[Math.max(0, toneIndex(stone.get(x, y), 5) - 2)]!);
        continue;
      }
      const b = bevel(region, x, y);
      let t = 1.4 + b * 0.75 + (hrand(x, y, seed + 9) - 0.5) * 0.4;
      if (style.accent && b < 0 && hrand(x, y, seed + 10) > 0.35) {
        c.set(x, y, style.accent[b < -1 ? 0 : 1]!);
        continue;
      }
      t = Math.max(0, t);
      c.set(x, y, style.ramp[toneIndex(t, style.ramp.length)]!);
    }
  }
}

export const paintCoalOre: Painter = (c, seed) =>
  paintOre(c, seed, { ramp: M.COAL, count: 4, cells: [5, 7], compact: 1.6, stretch: 1.3, minDist: 5.5 });
export const paintIronOre: Painter = (c, seed) =>
  paintOre(c, seed, { ramp: M.IRON_NUGGET, count: 5, cells: [3, 5], compact: 2.4, stretch: 1, minDist: 4.8 });
export const paintCopperOre: Painter = (c, seed) =>
  paintOre(c, seed, { ramp: M.COPPER_NUGGET, count: 4, cells: [4, 6], compact: 0.6, stretch: 2, minDist: 5.2, accent: M.PATINA });

// ---------------------------------------------------------------- snow, ice, clay

export const paintSnow: Painter = (c, seed) => {
  const f = new Field();
  f.each((x, y) => {
    let t = 3 + sfbm(x, y, 2, 3, seed + 61) * 0.9;
    const h = hrand(x, y, seed + 62);
    if (h > 0.95) t = 4.2; // sparkle
    return t;
  });
  // Soft drift shadows: lower-right side of the large-scale bumps.
  f.each((x, y, t) => {
    const slope = fbm(x - 1, y - 1, 2, 2, seed + 61) - fbm(x + 1, y + 1, 2, 2, seed + 61);
    return t + slope * 3;
  });
  paintField(c, f, M.SNOW, { dither: 0.5 });
};

export const paintIce: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const f = new Field();
  // Polished streaks along the diagonal.
  f.each((x, y) => 2 + Math.sin(((x + y) / S) * Math.PI * 4 + 0.6) * 0.45 + sfbm(x, y, 2, 2, seed + 71) * 0.4);
  // Cracks: random walks that wrap, white with a darker shadow line under them.
  const crack = new Uint8Array(S * S);
  for (let i = 0; i < 3; i++) {
    let x = rng.int(0, S - 1);
    let y = rng.int(0, S - 1);
    const dir = rng.next() * Math.PI * 2;
    const len = rng.int(7, 12);
    for (let k = 0; k < len; k++) {
      crack[wrap(y) * S + wrap(x)] = 1;
      const a = dir + (rng.next() - 0.5) * 1.3;
      x += Math.round(Math.cos(a));
      y += Math.round(Math.sin(a));
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (crack[y * S + x]) f.set(x, y, 4.4);
      else if (crack[wrap(y - 1) * S + wrap(x - 1)]) f.set(x, y, 0.4);
    }
  }
  paintField(c, f, M.ICE, { alpha: 200 });
};

export const paintClay: Painter = (c, seed) => {
  const f = new Field();
  f.each((x, y) => {
    let t = 2 + sfbm(x, y, 2, 2, seed + 81) * 0.5;
    // Smooth horizontal smears.
    t += (vnoise(x, y, 2, 8, seed + 82) - 0.5) * 0.7;
    if (hrand(x, y, seed + 83) > 0.965) t -= 1.2; // pores
    return t;
  });
  paintField(c, f, M.CLAY, { dither: 0.4 });
};

/** Exposed for the turf-side fringe test and contact sheets. */
export const TERRAIN_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  stone: paintStone,
  cobble: paintRubble,
  dirt: paintDirt,
  turf_top: paintTurfTop,
  turf_side: paintTurfSide,
  sand: paintSand,
  gravel: paintGravel,
  deeprock: paintDeeprock,
  obsidian: paintObsidian,
  coal_ore: paintCoalOre,
  iron_ore: paintIronOre,
  copper_ore: paintCopperOre,
  snow: paintSnow,
  ice: paintIce,
  clay: paintClay,
});

