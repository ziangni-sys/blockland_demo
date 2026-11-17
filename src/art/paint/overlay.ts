/**
 * Item icons drawn as tiles (glue, buckets), the glue face overlay and mining cracks.
 */
import { Canvas, forEllipse, toneIndex } from '../canvas';
import type { Ramp, RGB } from '../color';
import * as M from '../materials';
import { rngOf, S, type Painter } from './kit';

/** Adds a 1-px outline OUTSIDE a sprite (transparent pixels touching it become `ink`). */
function outlineOutside(c: Canvas, ink: RGB): void {
  const s = c.size;
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < s && y < s && c.alpha(x, y) > 0;
  const add: Array<[number, number]> = [];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) add.push([x, y]);
    }
  }
  for (const [x, y] of add) c.set(x, y, ink);
}

function tone(r: Ramp, t: number): RGB {
  return r[toneIndex(t, r.length)]!;
}

// ---------------------------------------------------------------- glue tube

const paintGlueItem: Painter = (c) => {
  c.clear();
  // Tube axis from the crimped end (bottom-left) to the neck (top-right).
  const ax = 4;
  const ay = 12;
  const bx = 10;
  const by = 6;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len;
  const uy = dy / len;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5 - ax;
      const py = y + 0.5 - ay;
      const along = px * ux + py * uy; // 0 at the crimp .. len at the neck
      const across = -px * uy + py * ux; // signed distance from the axis (negative = top-left side)
      const half = 2.4 - Math.max(0, along - len + 1.5) * 0.6; // shoulders taper into the neck
      if (along < -0.9 || along > len + 0.3 || Math.abs(across) > half) continue;
      if (along < 1.2) {
        // Crimped, flattened end with ridges.
        c.set(x, y, M.GLUE[Math.round(along * 2) % 2 === 0 ? 1 : 2]!);
        continue;
      }
      const s = across / half; // -1 .. 1
      let t = 2.4 - s * 1.2;
      if (s > -0.75 && s < -0.25) t += 1; // glossy highlight streak
      c.set(x, y, tone(M.GLUE, t));
    }
  }
  // Steel neck and a dark nozzle cap, a bead of glue at the tip.
  c.set(11, 5, M.STEEL[3]!);
  c.set(11, 4, M.STEEL[2]!);
  c.set(12, 5, M.STEEL[1]!);
  c.set(12, 4, M.STEEL[2]!);
  c.set(13, 3, M.GLUE[3]!);
  c.set(13, 2, M.GLUE[4]!);
  outlineOutside(c, M.GLUE[0]!);
};

// ---------------------------------------------------------------- buckets

function paintBucket(c: Canvas, contents: 'empty' | 'water' | 'lava'): void {
  c.clear();
  const steel = M.STEEL;
  // Handle: the upper half of an ellipse, drawn first so the rim covers its ends.
  for (let i = 0; i <= 64; i++) {
    const a = Math.PI + (i / 64) * Math.PI;
    const x = Math.floor(8 + Math.cos(a) * 5.6);
    const y = Math.floor(6.2 + Math.sin(a) * 5.2);
    c.set(x, y, steel[i > 12 && i < 34 ? 3 : 1]!);
  }
  // Body: a tapered cylinder, lit from the left.
  for (let y = 6; y <= 14; y++) {
    const half = 5.4 - (y - 6) * 0.2;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5 - 8) / half;
      if (Math.abs(u) > 1) continue;
      let t = 2.3 - u * 1.4;
      if (u > -0.65 && u < -0.35) t += 0.9;
      if (y === 9 || y === 12) t -= 0.8; // pressed ribs
      if (y === 10 || y === 13) t += 0.3;
      if (y === 14) t -= 0.7;
      c.set(x, y, tone(steel, t));
    }
  }
  // Rim and the opening.
  forEllipse(8, 6, 5.6, 1.7, (x, y, d) => {
    c.set(x, y, steel[d > 0.62 ? (y < 6 ? 4 : 3) : 0]!);
  });
  if (contents !== 'empty') {
    const r = contents === 'water' ? M.WATER : M.LAVA;
    forEllipse(8, 6, 4.3, 1.05, (x, y, d, ox) => {
      const t = contents === 'water' ? 2.5 - ox * 0.3 : 3.2 - d * 1.3;
      c.set(x, y, tone(r, t));
    });
    c.set(6, 5, r[r.length - 1]!);
  } else {
    forEllipse(8, 6, 4.3, 1.05, (x, y) => c.set(x, y, steel[y < 6 ? 1 : 0]!));
  }
  outlineOutside(c, steel[0]!);
}

// ---------------------------------------------------------------- glue face overlay

const GLUE_ALPHA = 140;

const paintGlueFace: Painter = (c, seed) => {
  c.clear();
  const rng = rngOf(seed);
  // Central splat with a lumpy edge, droplets thrown around it.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ox = x + 0.5 - 8;
      const oy = y + 0.5 - 8;
      const a = Math.atan2(oy, ox);
      const r = Math.sqrt(ox * ox + oy * oy);
      const edge = 3.6 + Math.sin(a * 5 + 0.7) * 0.7 + Math.sin(a * 3 + 2.1) * 0.45;
      if (r > edge) continue;
      const lit = ox + oy < -1.6 && r > 1;
      const rim = r > edge - 1;
      c.set(x, y, M.GLUE[lit ? 3 : rim ? 1 : 2]!, lit ? GLUE_ALPHA + 20 : GLUE_ALPHA);
    }
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng.next() * 0.5;
    const d = 5.2 + rng.next() * 1.8;
    const rr = 0.6 + rng.next() * 0.8;
    forEllipse(8 + Math.cos(a) * d, 8 + Math.sin(a) * d, rr, rr, (x, y) => {
      if (x >= 0 && y >= 0 && x < S && y < S) c.set(x, y, M.GLUE[1]!, GLUE_ALPHA);
    });
  }
};

// ---------------------------------------------------------------- cracks

const CRACK_ALPHA = 200;
const CRACK_STAGES = 8;

/**
 * Growth time of every crack pixel (Infinity = never cracks). One deterministic crack tree
 * radiating from the centre; stage k shows every pixel whose time is below its threshold,
 * so each stage contains all the cracks of the previous one.
 */
function crackTimes(): Float32Array {
  const rng = rngOf(0x0c7ac4);
  const time = new Float32Array(S * S).fill(Infinity);
  interface Tip {
    x: number;
    y: number;
    a: number;
    left: number;
    t: number;
  }
  const tips: Tip[] = [];
  const mains = 5;
  for (let i = 0; i < mains; i++) {
    const a = ((i + 0.2 + rng.next() * 0.6) / mains) * Math.PI * 2;
    tips.push({ x: 8 + Math.cos(a) * 0.8, y: 8 + Math.sin(a) * 0.8, a, left: 8 + rng.int(0, 2), t: 1 + rng.next() });
  }
  while (tips.length) {
    const tip = tips.shift()!;
    while (tip.left > 0) {
      const px = Math.floor(tip.x);
      const py = Math.floor(tip.y);
      if (px < 0 || py < 0 || px >= S || py >= S) break;
      const i = py * S + px;
      if (tip.t < time[i]!) time[i] = tip.t;
      // Branch only away from the centre, so the impact point does not clot into a blob.
      if (tip.left > 2 && tip.t > 3.5 && rng.chance(0.25)) {
        tips.push({ x: tip.x, y: tip.y, a: tip.a + (rng.chance(0.5) ? 0.85 : -0.85), left: Math.floor(tip.left * 0.55), t: tip.t + 1 });
      }
      tip.a += (rng.next() - 0.5) * 0.55;
      tip.x += Math.cos(tip.a);
      tip.y += Math.sin(tip.a);
      tip.t += 1;
      tip.left--;
    }
  }
  // The impact point itself.
  for (const [x, y] of [
    [7, 7],
    [8, 8],
  ] as const) {
    time[y * S + x] = 0;
  }
  return time;
}

/** Crack pixels shown at stage 0: the impact point plus a stub of every main crack. */
const CRACK_FIRST = 7;

/**
 * Crack overlay for one stage. Two tones, both at CRACK_ALPHA:
 *  - the dark line itself (reads on light and mid-tone blocks);
 *  - a 1-px light "chipped" edge on the line's lower-right side, the groove wall that faces
 *    the top-left light (reads on near-black blocks such as obsidian or black felt, where a
 *    dark line alone is invisible).
 * Stages reveal the crack pixels in growth order (time, then index), in equal steps from
 * CRACK_FIRST to the whole tree, so progress shows evenly over a dig instead of a dot for
 * the first quarter. A prefix of the growth order is a union of branch prefixes, so every
 * stage is a connected tree from the centre and contains all of the previous stage.
 */
function paintCrack(stage: number): Painter {
  return (c) => {
    c.clear();
    const time = crackTimes();
    const order: number[] = [];
    for (let i = 0; i < S * S; i++) if (time[i]! !== Infinity) order.push(i);
    order.sort((a, b) => time[a]! - time[b]! || a - b);
    const count = Math.round(CRACK_FIRST + ((order.length - CRACK_FIRST) * stage) / (CRACK_STAGES - 1));
    const crack = new Uint8Array(S * S);
    for (let k = 0; k < count; k++) crack[order[k]!] = 1;
    // Out-of-tile neighbours count as uncracked: the overlay is drawn per face, it never tiles.
    const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < S && y < S && crack[y * S + x] === 1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (at(x, y)) c.set(x, y, M.CRACK, CRACK_ALPHA);
        // Lit wall: below-right of a crack pixel; for a crack running down-right ("\"), to its right.
        else if (at(x - 1, y - 1) || (at(x - 1, y) && at(x - 2, y - 1))) c.set(x, y, M.CRACK_CHIP, CRACK_ALPHA);
      }
    }
  };
}

const crackPainters: Record<string, Painter> = {};
for (let k = 0; k < CRACK_STAGES; k++) crackPainters[`crack_${k}`] = paintCrack(k);

export const OVERLAY_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  item_glue: paintGlueItem,
  item_bucket: (c) => paintBucket(c, 'empty'),
  item_bucket_water: (c) => paintBucket(c, 'water'),
  item_bucket_lava: (c) => paintBucket(c, 'lava'),
  glue_face: paintGlueFace,
  ...crackPainters,
});
