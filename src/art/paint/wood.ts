/**
 * Wood tiles: bark, growth rings, planks, leaves.
 */
import { Canvas, Field, paintField, wrap, wrapDelta } from '../canvas';
import type { Ramp } from '../color';
import * as M from '../materials';
import { hrand, scatter, sfbm, vnoise } from '../noise';
import { rngOf, S, type Painter } from './kit';

/** 1D periodic noise along y in [0,1) (x-independent). */
function noiseY(y: number, cells: number, seed: number): number {
  return vnoise(0, y, 1, cells, seed);
}

// ---------------------------------------------------------------- bark

function paintBark(c: Canvas, seed: number, r: Ramp, plates: boolean): void {
  const rng = rngOf(seed);
  const f = new Field();
  // Grain runs along v: few lattice cells vertically = long vertical streaks.
  f.each((x, y) => 2 + (vnoise(x, y, 8, 2, seed + 1) - 0.5) * 1.1 + (hrand(x, y, seed + 2) - 0.5) * 0.3);
  // Fissures: dark grooves that wander slightly and break up along their length.
  const count = 5;
  for (let i = 0; i < count; i++) {
    const x0 = Math.round((i * S) / count + rng.next() * 1.4);
    for (let y = 0; y < S; y++) {
      if (noiseY(y, 4, seed + 20 + i) < 0.28) continue;
      const x = x0 + Math.round((noiseY(y, 2, seed + 40 + i) - 0.5) * 2.6);
      f.set(x, y, 0.15);
      f.set(x - 1, y, Math.min(f.get(x - 1, y), 1.35)); // groove wall in shade
      f.set(x + 1, y, Math.max(f.get(x + 1, y), 2.75)); // ridge edge facing the light
    }
  }
  if (plates) {
    // Conifer bark breaks into plates: short horizontal cuts between the grooves.
    for (let i = 0; i < 7; i++) {
      const x = rng.int(0, S - 1);
      const y = rng.int(0, S - 1);
      const len = rng.int(2, 3);
      for (let k = 0; k < len; k++) {
        f.set(x + k, y, Math.min(f.get(x + k, y), 0.6));
        f.set(x + k, y + 1, Math.max(f.get(x + k, y + 1), 2.6));
      }
    }
  }
  paintField(c, f, r);
}

// ---------------------------------------------------------------- growth rings

function paintLogEnd(c: Canvas, seed: number, bark: Ramp, wood: Ramp): void {
  const rng = rngOf(seed);
  const f = new Field();
  const p = 3; // superellipse exponent: rings echo the square section toward the bark
  const crackAngle = rng.next() * Math.PI * 2;
  f.each((x, y) => {
    const ox = x + 0.5 - 8;
    const oy = y + 0.5 - 8;
    const r = Math.pow(Math.pow(Math.abs(ox), p) + Math.pow(Math.abs(oy), p), 1 / p);
    const rr = r + sfbm(x, y, 4, 1, seed + 3) * 0.55;
    const ring = Math.floor(rr / 1.75);
    let t = ring % 2 === 0 ? 2.55 : 1.75;
    if (r < 3.2) t -= 0.35; // heartwood
    if (r < 1) t = 0.9; // pith
    t += (hrand(x, y, seed + 4) - 0.5) * 0.3;
    return t;
  });
  // Radial check crack from the pith.
  for (let k = 1; k < 6; k++) {
    const x = Math.floor(8 + Math.cos(crackAngle) * k);
    const y = Math.floor(8 + Math.sin(crackAngle) * k);
    f.set(x, y, 0);
  }
  paintField(c, f, wood);
  // Bark border (outermost ring of pixels) with a lit top-left and shadowed bottom-right.
  for (let i = 0; i < S; i++) {
    const n = (k: number): number => (hrand(i, k, seed + 5) > 0.7 ? 1 : 0);
    c.set(i, 0, bark[2 + n(0)]!);
    c.set(0, i, bark[2 + n(1)]!);
    c.set(i, S - 1, bark[n(2)]!);
    c.set(S - 1, i, bark[n(3)]!);
  }
  // Cambium: a thin pale ring just inside the bark.
  for (let i = 1; i < S - 1; i++) {
    for (const [x, y] of [
      [i, 1],
      [1, i],
      [i, S - 2],
      [S - 2, i],
    ] as const) {
      if (hrand(x, y, seed + 6) > 0.3) c.set(x, y, wood[x === 1 || y === 1 ? 4 : 3]!);
    }
  }
}

// ---------------------------------------------------------------- planks

function paintPlanks(c: Canvas, seed: number, r: Ramp, joints: readonly number[]): void {
  const rng = rngOf(seed);
  const f = new Field();
  f.each((x, y) => {
    const board = y >> 2;
    const row = y & 3;
    // Grain: long streaks along x (few lattice cells across x, one per row vertically).
    let t = 2 + (vnoise(x + board * 5, y, 3, 16, seed + board) - 0.5) * 1.15;
    if (row === 0) t += 0.55;
    else if (row === 2) t -= 0.2;
    else if (row === 3) t = 0.05; // gap between boards
    return t;
  });
  // Darker grain streaks.
  for (let i = 0; i < 6; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    if ((y & 3) === 3) continue; // never on the gap row between boards
    const len = rng.int(2, 4);
    for (let k = 0; k < len; k++) f.set(x + k, y, Math.min(f.get(x + k, y), 1.2));
  }
  for (let b = 0; b < 4; b++) {
    const j = joints[b]!;
    for (let row = 0; row < 3; row++) {
      const y = b * 4 + row;
      f.set(j, y, 0.3);
      f.set(j + 1, y, Math.max(f.get(j + 1, y), 2.8)); // board end catches light
      f.set(j - 1, y, Math.min(f.get(j - 1, y), 1.4));
    }
    // Nail dots near both board ends.
    f.set(j - 2, b * 4 + 1, 0.3);
    f.set(j + 3, b * 4 + 1, 0.3);
  }
  paintField(c, f, r);
}

// ---------------------------------------------------------------- leaves

/** Broadleaf: rounded clusters with ~22 % see-through gaps. */
const paintLeavesOak: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const pts = scatter(rng, 8, 4.8);
  const rad = pts.map(() => 3 + rng.next() * 1.3);
  // Cluster scale for a 22 % hole fraction: a pixel is covered once the scale reaches its
  // smallest dist / radius over all clusters, so the hole fraction at scale s is the share
  // of pixels whose cover scale exceeds s. The smallest scale leaving at most 22 % holes is
  // therefore the (HOLES + 1)-th largest cover scale; no search needed.
  const HOLES = Math.floor(0.22 * S * S);
  const cover = new Float64Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let m = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dx = wrapDelta(x + 0.5 - pts[i]!.x);
        const dy = wrapDelta(y + 0.5 - pts[i]!.y);
        m = Math.min(m, Math.sqrt(dx * dx + dy * dy) / rad[i]!);
      }
      cover[y * S + x] = m;
    }
  }
  const sorted = Float64Array.from(cover).sort();
  // Nudged up by a relative epsilon so the pixel that defines the scale passes the <= test below.
  const scale = Math.min(2, Math.max(0.4, sorted[S * S - 1 - HOLES]! * (1 + 1e-9)));
  const owner = new Int16Array(S * S).fill(-1);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      for (let i = pts.length - 1; i >= 0; i--) {
        const dx = wrapDelta(x + 0.5 - pts[i]!.x);
        const dy = wrapDelta(y + 0.5 - pts[i]!.y);
        if (Math.sqrt(dx * dx + dy * dy) <= rad[i]! * scale) {
          owner[y * S + x] = i; // later clusters sit on top
          break;
        }
      }
    }
  }
  const f = new Field(S, NaN);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = owner[y * S + x]!;
      if (i < 0) continue;
      const r = rad[i]! * scale;
      const dx = wrapDelta(x + 0.5 - pts[i]!.x);
      const dy = wrapDelta(y + 0.5 - pts[i]!.y);
      const dn = Math.sqrt(dx * dx + dy * dy) / r;
      let t = 2.1 - ((dx + dy) / r) * 0.95;
      if (dn > 0.78 && dx + dy > 0) t = Math.min(t, 0.8); // shaded rim
      const up = owner[wrap(y - 1) * S + x]!;
      const left = owner[y * S + wrap(x - 1)]!;
      if ((up >= 0 && up !== i && up > i) || (left >= 0 && left !== i && left > i)) t -= 1.1; // shadow of the cluster above
      if (hrand(x, y, seed + 7) > 0.88 && dx + dy < 0) t += 0.9; // glossy leaf
      f.set(x, y, t);
    }
  }
  paintField(c, f, M.LEAVES_OAK);
};

/** Conifer: herringbone sprigs of diagonal needles, ~22 % see-through gaps. */
const paintLeavesPine: Painter = (c, seed) => {
  const rng = rngOf(seed);
  const f = new Field(S, NaN);
  const opaque = (): number => {
    let n = 0;
    for (let i = 0; i < S * S; i++) if (!Number.isNaN(f.v[i]!)) n++;
    return n / (S * S);
  };
  for (let sprig = 0; sprig < 80 && opaque() < 0.77; sprig++) {
    const x0 = rng.int(0, S - 1);
    const y0 = rng.int(0, S - 1);
    const dir = rng.chance(0.5) ? 1 : -1;
    const len = rng.int(4, 7);
    const droop = rng.chance(0.5) ? 1 : 0;
    for (let i = 0; i < len; i++) {
      const x = x0 + i * dir;
      const y = y0 + (droop && i > len / 2 ? 1 : 0);
      // Needles first so the twig stays visible on top of them.
      if (i % 2 === 0 && i < len - 1) {
        for (let k = 1; k <= 2; k++) {
          const tip = k === 2;
          f.set(x + k * dir, y - k, tip ? (hrand(x, y, seed + sprig) > 0.85 ? 3.6 : 2.8) : 2.1);
          f.set(x + k * dir, y + k, tip ? 2.4 : 1.6);
        }
      }
      f.set(x, y, 0.9);
    }
  }
  paintField(c, f, M.LEAVES_PINE);
};

export const WOOD_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  log_oak_side: (c, seed) => paintBark(c, seed, M.OAK_BARK, false),
  log_pine_side: (c, seed) => paintBark(c, seed, M.PINE_BARK, true),
  log_oak_end: (c, seed) => paintLogEnd(c, seed, M.OAK_BARK, M.OAK_END),
  log_pine_end: (c, seed) => paintLogEnd(c, seed, M.PINE_BARK, M.PINE_END),
  planks_oak: (c, seed) => paintPlanks(c, seed, M.PLANKS_OAK, [3, 11, 7, 15]),
  planks_pine: (c, seed) => paintPlanks(c, seed, M.PLANKS_PINE, [5, 13, 1, 9]),
  leaves_oak: paintLeavesOak,
  leaves_pine: paintLeavesPine,
});
