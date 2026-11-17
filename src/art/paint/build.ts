/**
 * Building materials: glass, stone bricks, clay bricks, sandstone, iron block, crystal lamp,
 * felt (wool) and canvas.
 */
import { Canvas, Field, forLine, paintField, toneIndex, wrap } from '../canvas';
import type { Ramp } from '../color';
import * as M from '../materials';
import { hrand, sfbm, vnoise } from '../noise';
import { rngOf, S, type Painter } from './kit';

// ---------------------------------------------------------------- glass

const paintGlass: Painter = (c) => {
  const g = M.GLASS_FRAME;
  c.clear();
  for (let i = 0; i < S; i++) {
    // Thin frame, lit top/left, shaded bottom/right.
    c.set(i, 0, g[2]!);
    c.set(0, i, g[2]!);
    c.set(i, S - 1, g[1]!);
    c.set(S - 1, i, g[1]!);
  }
  c.set(0, 0, g[3]!);
  c.set(S - 1, S - 1, g[0]!);
  c.set(S - 1, 0, g[1]!);
  c.set(0, S - 1, g[1]!);
  // Diagonal glints: a long and a short streak near the top-left, a fleck bottom-right.
  forLine(3, 7, 7, 3, (x, y) => c.set(x, y, g[3]!));
  forLine(3, 10, 4, 9, (x, y) => c.set(x, y, g[2]!));
  forLine(11, 13, 13, 11, (x, y) => c.set(x, y, g[2]!));
};

// ---------------------------------------------------------------- stone bricks

const paintStoneBricks: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const f = new Field();
  // Two courses of 8 px; vertical joints offset by half a tile between courses.
  const jointX = [15, 7];
  const brickTone = [2 + (rng.next() - 0.5) * 0.5, 2 + (rng.next() - 0.5) * 0.5, 2 + (rng.next() - 0.5) * 0.5];
  f.each((x, y) => {
    const course = y >> 3;
    const row = y & 7;
    const jx = jointX[course]!;
    if (row === 7 || x === jx) return Number.NaN; // mortar, painted below
    // Which brick (for tone variety): course 1 is split into two bricks by its joint.
    const brick = course === 0 ? 0 : x < jx ? 1 : 2;
    let t = brickTone[brick]! + sfbm(x, y, 4, 2, seed + 1) * 0.35;
    // Bevel: lit top / left inner edges, shaded bottom / right.
    if (row === 0) t += 0.75;
    if (row === 6) t -= 0.65;
    if (x === wrap(jx + 1)) t += 0.55;
    if (x === wrap(jx - 1)) t -= 0.55;
    if (hrand(x, y, seed + 2) > 0.94) t -= 1;
    return t;
  });
  // A hairline crack in one brick.
  let x = rng.int(3, 11);
  let y = 9;
  for (let k = 0; k < 4; k++) {
    f.set(x, y, 0.4);
    x += rng.chance(0.5) ? 1 : 0;
    y += 1;
  }
  paintField(c, f, M.STONE_BRICK);
  for (let yy = 0; yy < S; yy++) {
    for (let xx = 0; xx < S; xx++) {
      if (Number.isNaN(f.get(xx, yy))) c.set(xx, yy, M.STONE_BRICK_MORTAR);
    }
  }
};

// ---------------------------------------------------------------- clay bricks

const paintBricks: Painter = (c, seed) => {
  const f = new Field();
  const mortar = new Uint8Array(S * S);
  f.each((x, y) => {
    const course = y >> 2;
    const row = y & 3;
    const xo = wrap(x + (course % 2) * 4, 8);
    if (row === 3 || xo === 7) {
      mortar[y * S + x] = 1;
      return 0;
    }
    const brickId = course * 2 + Math.floor(wrap(x + (course % 2) * 4) / 8);
    let t = 1.75 + hrand(brickId, 0, seed) * 0.9;
    if (row === 0) t += 0.6;
    if (row === 2) t -= 0.45;
    if (xo === 0) t += 0.35;
    if (xo === 6) t -= 0.35;
    const h = hrand(x, y, seed + 1);
    if (h > 0.9) t += 0.8;
    else if (h < 0.08) t -= 0.8;
    return t;
  });
  paintField(c, f, M.CLAY_BRICK);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!mortar[y * S + x]) continue;
      // Mortar is shaded directly under / right of a brick, light elsewhere.
      const shaded = !mortar[wrap(y - 1) * S + x] || !mortar[y * S + wrap(x - 1)];
      c.set(x, y, M.BRICK_MORTAR[shaded ? 1 : hrand(x, y, seed + 2) > 0.8 ? 1 : 2]!);
      if (shaded && !mortar[wrap(y - 1) * S + wrap(x - 1)] && hrand(x, y, seed + 3) > 0.5) c.set(x, y, M.BRICK_MORTAR[0]!);
    }
  }
};

// ---------------------------------------------------------------- sandstone

const SANDSTONE_BANDS: ReadonlyArray<readonly [number, number]> = [
  [3, 0.55],
  [2, -0.35],
  [4, 0.15],
  [3, -0.55],
  [4, 0.35],
];

const paintSandstoneSide: Painter = (c, seed) => {
  const bandOf = new Int8Array(S);
  const rowIn = new Int8Array(S);
  let y0 = 0;
  SANDSTONE_BANDS.forEach(([h], b) => {
    for (let k = 0; k < h; k++) {
      bandOf[y0 + k] = b;
      rowIn[y0 + k] = k;
    }
    y0 += h;
  });
  const f = new Field();
  f.each((x, y) => {
    const b = bandOf[y]!;
    const [h, tone] = SANDSTONE_BANDS[b]!;
    let t = 2 + tone + (vnoise(x, y, 2, 16, seed + 1) - 0.5) * 0.5;
    if (rowIn[y] === 0) t += 0.45;
    if (rowIn[y] === h - 1) t -= 0.45;
    const pit = hrand(x, y, seed + 2);
    if (pit > 0.95) t -= 1.2;
    else if (pit < 0.04) t += 0.9;
    return t;
  });
  paintField(c, f, M.SANDSTONE);
};

const paintSandstoneTop: Painter = (c, seed) => {
  const f = new Field();
  f.each((x, y) => {
    let t = 2.35 + sfbm(x, y, 2, 2, seed + 1) * 0.5;
    const h = hrand(x, y, seed + 2);
    if (h > 0.96) t -= 1;
    else if (h < 0.03) t += 1;
    return t;
  });
  paintField(c, f, M.SANDSTONE, { dither: 0.4 });
};

// ---------------------------------------------------------------- iron block

const paintIronBlock: Painter = (c, seed) => {
  const f = new Field();
  const seamX = [15, 7];
  f.each((x, y) => {
    const plate = y >> 3;
    const row = y & 7;
    const sx = seamX[plate]!;
    if (row === 7 || x === sx) return 0.1;
    // Brushed finish: thin horizontal streaks (one lattice cell per row).
    let t = 2.2 + (vnoise(x, y, 2, 16, seed + 1) - 0.5) * 1.0 + (hrand(x >> 2, y, seed + 2) - 0.5) * 0.35;
    if (row === 0) t += 0.9;
    if (row === 6) t -= 0.6;
    if (x === wrap(sx + 1)) t += 0.5;
    if (x === wrap(sx - 1)) t -= 0.5;
    return t;
  });
  // Rivets near both ends of every plate: bright head, dark shadow to the lower right.
  for (const [x, y] of [
    [2, 2],
    [12, 2],
    [10, 10],
    [4, 10],
  ] as const) {
    f.set(x, y, 4.2);
    f.set(x + 1, y + 1, 0.6);
    f.set(x + 1, y, 1.6);
    f.set(x, y + 1, 1.6);
  }
  paintField(c, f, M.STEEL);
};

// ---------------------------------------------------------------- crystal lamp

const paintLamp: Painter = (c, seed) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Diamond lattice with an 8-px period (wraps at 16); u, v are the two diagonal coords.
      const u = wrap(x + y, 8);
      const v = wrap(x - y, 8);
      if (u === 7 || v === 0) {
        const lit = u === 7 && v !== 0 ? 2 : v === 0 && u !== 7 ? 1 : 0;
        c.set(x, y, M.LAMP_FRAME[lit]!);
        continue;
      }
      // Distance to the cell centre in lattice units: bright core, amber rim.
      const du = Math.abs(u - 3);
      const dv = Math.abs(v - 4);
      const cell = Math.floor((x + y) / 8) * 3 + Math.floor((x - y + 16) / 8);
      const d = Math.max(du, dv) - hrand(cell, 0, seed) * 0.6;
      let t = 4.2 - d * 1.05;
      if (du + dv <= 1 && u <= 3 && v <= 4) t += 0.5; // hot spot toward the light
      c.set(x, y, M.LAMP_GLOW[toneIndex(t, M.LAMP_GLOW.length)]!);
    }
  }
};

// ---------------------------------------------------------------- felt & canvas

function paintFelt(c: Canvas, seed: number, r: Ramp): void {
  const bi = r === M.WOOL['white'] ? 3 : r === M.WOOL['black'] ? 1 : 2;
  const f = new Field();
  f.each((x, y) => {
    // Soft twill: diagonal ribs with a 4-px period, broken up by fuzzy noise.
    const rib = wrap(x + y * 2, 4) < 2 ? 0.28 : -0.28;
    let t = bi + rib + sfbm(x, y, 4, 2, seed + 1) * 0.55;
    const h = hrand(x, y, seed + 2);
    if (h > 0.93) t += 0.7; // stray light fibre
    else if (h < 0.06) t -= 0.7;
    return t;
  });
  paintField(c, f, r, { dither: 0.45 });
}

const paintCanvas: Painter = (c, seed) => {
  const r = M.CANVAS_CLOTH;
  const f = new Field();
  f.each((x, y) => {
    // Plain cross-weave: alternate over/under threads, plus slub threads.
    let t = 2.7 + ((x + y) % 2 === 0 ? 0.3 : -0.3);
    t += (hrand(x, 0, seed + 1) - 0.5) * 0.35 + (hrand(0, y, seed + 2) - 0.5) * 0.35;
    t += sfbm(x, y, 2, 2, seed + 3) * 0.3;
    return t;
  });
  // Stitched seam: a fold line with a shadow, stitches running beside it (period 4).
  for (let y = 0; y < S; y++) {
    f.set(11, y, 1.1);
    f.set(12, y, 3.9);
    if (wrap(y, 4) < 2) f.set(9, y, 0.6);
    else f.set(9, y, f.get(9, y) + 0.4);
  }
  paintField(c, f, r);
};

export const BUILD_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  glass: paintGlass,
  stone_bricks: paintStoneBricks,
  bricks: paintBricks,
  sandstone_side: paintSandstoneSide,
  sandstone_top: paintSandstoneTop,
  iron_block: paintIronBlock,
  lamp: paintLamp,
  canvas: paintCanvas,
  wool_white: (c, seed) => paintFelt(c, seed, M.WOOL['white']!),
  wool_red: (c, seed) => paintFelt(c, seed, M.WOOL['red']!),
  wool_orange: (c, seed) => paintFelt(c, seed, M.WOOL['orange']!),
  wool_yellow: (c, seed) => paintFelt(c, seed, M.WOOL['yellow']!),
  wool_green: (c, seed) => paintFelt(c, seed, M.WOOL['green']!),
  wool_blue: (c, seed) => paintFelt(c, seed, M.WOOL['blue']!),
  wool_purple: (c, seed) => paintFelt(c, seed, M.WOOL['purple']!),
  wool_black: (c, seed) => paintFelt(c, seed, M.WOOL['black']!),
});
