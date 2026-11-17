/**
 * Plants: cactus faces and the cross sprites (flowers, grass tuft).
 * Sprites are cutout: alpha strictly 0 or 255, transparent background.
 */
import { Canvas, Field, paintField, toneIndex, wrap } from '../canvas';
import type { Ramp } from '../color';
import * as M from '../materials';
import { hrand, vnoise } from '../noise';
import { rngOf, S, type Painter } from './kit';

// ---------------------------------------------------------------- cactus

const paintCactusSide: Painter = (c, seed) => {
  const f = new Field();
  // Ribs every 4 px: groove, lit flank, crest, shaded flank.
  const rib = [0.6, 2.8, 2.3, 1.4];
  f.each((x, y) => rib[wrap(x, 4)]! + (vnoise(x, y, 16, 4, seed) - 0.5) * 0.5);
  paintField(c, f, M.CACTUS);
  // Spines along the crests, staggered between neighbouring ribs (period 4 vertically).
  for (let k = 0; k < 4; k++) {
    const x = k * 4 + 2;
    for (let y = (k % 2) * 2; y < S; y += 4) {
      c.set(x, y, M.SPINE);
      c.set(x, y + 1, M.CACTUS[0]!); // areole
    }
  }
};

const paintCactusTop: Painter = (c, seed) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ox = x + 0.5 - 8;
      const oy = y + 0.5 - 8;
      const r = Math.sqrt(ox * ox + oy * oy);
      const a = Math.atan2(oy, ox);
      // Rib star seen from above, lit from the top-left.
      let t = 2 + Math.cos(a * 8) * 0.8 - ((ox + oy) / 8) * 0.6;
      if (Math.max(Math.abs(ox), Math.abs(oy)) > 6.6) t = 1;
      if (r < 1.6) t = 3.6;
      t += (hrand(x, y, seed) - 0.5) * 0.3;
      c.set(x, y, M.CACTUS[toneIndex(t, M.CACTUS.length)]!);
    }
  }
  for (const [x, y] of [
    [7, 3],
    [11, 6],
    [4, 9],
    [9, 11],
  ] as const) {
    c.set(x, y, M.SPINE);
  }
};

const paintCactusBottom: Painter = (c, seed) => {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ox = x + 0.5 - 8;
      const oy = y + 0.5 - 8;
      const r = Math.sqrt(ox * ox + oy * oy);
      const edge = Math.max(Math.abs(ox), Math.abs(oy));
      if (edge > 6.6) {
        c.set(x, y, M.CACTUS[hrand(x, y, seed) > 0.6 ? 1 : 0]!);
        continue;
      }
      // Cut flesh with a dotted ring of vascular bundles.
      let i = 1;
      if (r > 3.5 && r < 4.6 && hrand(x, y, seed + 1) > 0.35) i = 0;
      else if (r < 2) i = 2;
      c.set(x, y, M.CACTUS_FLESH[i]!);
    }
  }
};

// ---------------------------------------------------------------- cross sprites

/** Darkens the bottom/right outline of a sprite region for readability against any ground. */
function outlineSprite(c: Canvas, dark: Ramp[number]): void {
  const s = c.size;
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < s && y < s && c.alpha(x, y) > 0;
  const edge: Array<[number, number]> = [];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x + 1, y) || !solid(x, y + 1)) edge.push([x, y]);
    }
  }
  for (const [x, y] of edge) c.tint(x, y, dark, 0.45);
}

function stem(c: Canvas, topY: number, leaves: ReadonlyArray<readonly [number, number]>): void {
  for (let y = topY; y < S; y++) {
    const x = y < 11 ? 7 : 8;
    c.set(x, y, M.STEM[1]!);
  }
  for (const [x, y] of leaves) c.set(x, y, M.STEM[2]!);
}

function paintFlower(c: Canvas, petals: number, petalRamp: Ramp, centre: Ramp[number], ring: boolean): void {
  c.clear();
  stem(c, 7, [
    [5, 12],
    [6, 12],
    [6, 11],
    [9, 13],
    [10, 13],
    [10, 12],
  ]);
  // Shadow side of the leaves.
  c.set(6, 13, M.STEM[0]!);
  c.set(9, 14, M.STEM[0]!);
  const cx = 8;
  const cy = 5;
  for (let y = 0; y < 11; y++) {
    for (let x = 1; x < S - 1; x++) {
      const ox = x + 0.5 - cx;
      const oy = y + 0.5 - cy;
      const r = Math.sqrt(ox * ox + oy * oy);
      const a = Math.atan2(oy, ox);
      let inside: boolean;
      if (ring) {
        // Daisy: many narrow petals in a ring.
        inside = r <= 4.2 && (r < 1.9 || Math.cos(a * petals) > -0.45);
      } else {
        // Rounded petals: radius modulated by the petal count.
        const rr = 3.1 + Math.cos(a * petals + Math.PI / 2) * 0.9;
        inside = r <= rr;
      }
      if (!inside) continue;
      if (r < (ring ? 1.6 : 1.3)) {
        c.set(x, y, centre);
        continue;
      }
      const t = 2.2 - ((ox + oy) / 4) * 1.1 - (r > 3.2 ? 0.4 : 0);
      c.set(x, y, petalRamp[toneIndex(t, petalRamp.length)]!);
    }
  }
  outlineSprite(c, petalRamp[0]!);
}

const paintFlowerRed: Painter = (c) => {
  paintFlower(c, 5, M.RED_PETAL, M.YELLOW_PETAL[1]!, false);
  c.set(7, 4, M.YELLOW_PETAL[3]!); // pollen
  c.set(8, 5, M.RED_PETAL[0]!);
};

const paintFlowerYellow: Painter = (c) => {
  paintFlower(c, 9, M.YELLOW_PETAL, M.DIRT[1]!, true);
  c.set(7, 4, M.DIRT[3]!);
};

const paintTallGrass: Painter = (c, seed) => {
  c.clear();
  const rng = rngOf(seed);
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const bx = 1.5 + (i * 13) / (blades - 1) + (rng.next() - 0.5) * 1.2;
    const h = rng.int(6, 13);
    const bend = (rng.next() - 0.5) * 5 + (bx < 8 ? -1 : 1);
    const lit = rng.chance(0.5);
    for (let k = 0; k <= h; k++) {
      const t = k / h;
      const x = Math.round(bx + bend * t * t);
      const y = S - 1 - k;
      if (x < 0 || x >= S) continue;
      // Dark at the base, lighter toward the tip; alternate blades get a lit edge.
      let tone = 1 + t * 2.2 + (lit ? 0.6 : 0);
      if (k === h) tone += 0.4;
      c.set(x, y, M.GRASS[toneIndex(tone, M.GRASS.length)]!);
    }
  }
};

export const PLANT_PAINTERS: Readonly<Record<string, Painter>> = Object.freeze({
  cactus_side: paintCactusSide,
  cactus_top: paintCactusTop,
  cactus_bottom: paintCactusBottom,
  flower_red: paintFlowerRed,
  flower_yellow: paintFlowerYellow,
  tall_grass: paintTallGrass,
});

export { outlineSprite };
