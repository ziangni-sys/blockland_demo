/**
 * Tiny RGBA image with a 3x5 bitmap font, for composing contact sheets. Tooling only.
 */

/** 3x5 glyphs, rows top to bottom, 3 bits per row (MSB = left). */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  a: [2, 5, 7, 5, 5],
  b: [6, 5, 6, 5, 6],
  c: [3, 4, 4, 4, 3],
  d: [6, 5, 5, 5, 6],
  e: [7, 4, 6, 4, 7],
  f: [7, 4, 6, 4, 4],
  g: [3, 4, 5, 5, 3],
  h: [5, 5, 7, 5, 5],
  i: [7, 2, 2, 2, 7],
  j: [1, 1, 1, 5, 2],
  k: [5, 5, 6, 5, 5],
  l: [4, 4, 4, 4, 7],
  m: [5, 7, 7, 5, 5],
  n: [6, 5, 5, 5, 5],
  o: [2, 5, 5, 5, 2],
  p: [6, 5, 6, 4, 4],
  q: [2, 5, 5, 6, 3],
  r: [6, 5, 6, 5, 5],
  s: [3, 4, 2, 1, 6],
  t: [7, 2, 2, 2, 2],
  u: [5, 5, 5, 5, 7],
  v: [5, 5, 5, 5, 2],
  w: [5, 5, 7, 7, 5],
  x: [5, 5, 2, 5, 5],
  y: [5, 5, 2, 2, 2],
  z: [7, 1, 2, 4, 7],
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [6, 1, 2, 4, 7],
  '3': [6, 1, 2, 1, 6],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 6, 1, 6],
  '6': [3, 4, 7, 5, 7],
  '7': [7, 1, 2, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 6],
  _: [0, 0, 0, 0, 7],
  '-': [0, 0, 7, 0, 0],
  '.': [0, 0, 0, 0, 2],
  ':': [0, 2, 0, 2, 0],
  '(': [2, 4, 4, 4, 2],
  ')': [2, 1, 1, 1, 2],
  ' ': [0, 0, 0, 0, 0],
};

export class Image {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;

  constructor(w: number, h: number, bg: readonly [number, number, number] = [32, 32, 38]) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /** Source-over blend of one pixel (clipped). */
  put(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    const t = a / 255;
    this.data[o] = Math.round(this.data[o]! + (r - this.data[o]!) * t);
    this.data[o + 1] = Math.round(this.data[o + 1]! + (g - this.data[o + 1]!) * t);
    this.data[o + 2] = Math.round(this.data[o + 2]! + (b - this.data[o + 2]!) * t);
  }

  rect(x: number, y: number, w: number, h: number, c: readonly [number, number, number]): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c[0], c[1], c[2]);
  }

  /** Checkerboard to reveal transparency. */
  checker(x: number, y: number, w: number, h: number, cell = 8): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = ((Math.floor(i / cell) + Math.floor(j / cell)) & 1) === 0 ? 92 : 128;
        this.put(x + i, y + j, v, v, v);
      }
    }
  }

  /** Draws an RGBA source image (row 0 top), scaled by an integer factor, alpha-blended. */
  blit(src: Uint8Array | Uint8ClampedArray, sw: number, sh: number, x: number, y: number, scale = 1): void {
    for (let sy = 0; sy < sh; sy++) {
      for (let sx = 0; sx < sw; sx++) {
        const o = (sy * sw + sx) * 4;
        const a = src[o + 3]!;
        if (a === 0) continue;
        for (let j = 0; j < scale; j++) {
          for (let i = 0; i < scale; i++) this.put(x + sx * scale + i, y + sy * scale + j, src[o]!, src[o + 1]!, src[o + 2]!, a);
        }
      }
    }
  }

  text(s: string, x: number, y: number, scale = 1, c: readonly [number, number, number] = [230, 230, 230]): void {
    let cx = x;
    for (const ch of s.toLowerCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[' ']!;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
          if ((g[row]! >> (2 - col)) & 1) this.rect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += 4 * scale;
    }
  }
}

/** Width in pixels of a text label at the given scale. */
export function textWidth(s: string, scale = 1): number {
  return s.length * 4 * scale - scale;
}
