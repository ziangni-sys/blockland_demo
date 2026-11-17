/**
 * Colour utilities for the procedural art: sRGB <-> OKLab conversion and hue-shifted tone ramps.
 *
 * Every material is painted from a small ramp (3-6 tones) instead of free RGB noise. That is
 * what gives the tiles a hand-painted pixel look and keeps large surfaces calm from afar.
 * Ramps are built in OKLab (perceptually uniform lightness) and follow the art direction's
 * hue-shift rule: darker tones rotate toward blue-violet, lighter tones toward warm yellow.
 */

/** An sRGB colour, components 0..255 (integers once produced by this module). */
export type RGB = readonly [number, number, number];

/** OKLab hue (degrees) that shadows drift toward: blue-violet. */
export const SHADOW_HUE = 285;
/** OKLab hue (degrees) that highlights drift toward: warm yellow. */
export const HIGHLIGHT_HUE = 92;

/** Parses '#rrggbb' (or 'rrggbb'). Throws on anything else. */
export function hex(s: string): RGB {
  const v = s.charCodeAt(0) === 35 ? s.slice(1) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) throw new Error(`bad colour '${s}'`);
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** '#rrggbb' of a colour (debugging, tests). */
export function toHex(c: RGB): string {
  const h = (v: number): string => clampByte(v).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function fromLinear(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

/** OKLab triple [L, a, b]; L in 0..1. */
export type Lab = readonly [number, number, number];

export function rgbToOklab(c: RGB): Lab {
  const r = toLinear(c[0]);
  const g = toLinear(c[1]);
  const b = toLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear-light sRGB of an OKLab colour, unclamped (may be out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/**
 * OKLab -> sRGB bytes. Out-of-gamut colours are brought in by reducing chroma (keeping
 * lightness and hue) rather than per-channel clipping, which would visibly skew the hue.
 */
export function oklabToRgb(L: number, a: number, b: number): RGB {
  let lin = oklabToLinear(L, a, b);
  const inGamut = (v: [number, number, number]): boolean =>
    v[0] >= -1e-4 && v[0] <= 1.0001 && v[1] >= -1e-4 && v[1] <= 1.0001 && v[2] >= -1e-4 && v[2] <= 1.0001;
  if (!inGamut(lin)) {
    // Bisection on a chroma scale factor: 18 steps is far below one byte of error.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) * 0.5;
      if (inGamut(oklabToLinear(L, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
    lin = oklabToLinear(L, a * lo, b * lo);
  }
  return [clampByte(fromLinear(lin[0])), clampByte(fromLinear(lin[1])), clampByte(fromLinear(lin[2]))];
}

/** Linear blend of two sRGB colours (t = 0 -> a, 1 -> b), rounded. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [clampByte(a[0] + (b[0] - a[0]) * t), clampByte(a[1] + (b[1] - a[1]) * t), clampByte(a[2] + (b[2] - a[2]) * t)];
}

/** Signed shortest angular difference to - from, in degrees (-180, 180]. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * Shift a colour along the art direction's light/shadow axis.
 * `steps` < 0 darkens (and cools toward blue-violet), > 0 lightens (and warms toward yellow).
 * Fractional steps are fine. Parameters as in RampOptions.
 */
export function shiftTone(base: RGB, steps: number, opts: RampOptions = {}): RGB {
  const step = opts.step ?? 0.07;
  const hueShift = opts.hueShift ?? 8;
  const tint = opts.tint ?? 0.006;
  const satShift = opts.satShift ?? 0.05;
  const [L0, a0, b0] = rgbToOklab(base);
  if (steps === 0) return [base[0], base[1], base[2]];
  const k = Math.abs(steps);
  const target = steps < 0 ? SHADOW_HUE : HIGHLIGHT_HUE;
  // Shadows sit a little further apart than highlights: dark ramps read better that way.
  const L = L0 + (steps < 0 ? -step * 1.08 : step) * k;
  let C = Math.sqrt(a0 * a0 + b0 * b0);
  const h = (Math.atan2(b0, a0) * 180) / Math.PI;
  // Rotate the hue toward the target, never past it.
  const d = angleDelta(h, target);
  const rot = Math.sign(d) * Math.min(Math.abs(d), hueShift * k);
  C *= steps < 0 ? 1 + satShift * k : Math.max(0, 1 - satShift * k);
  const hr = ((h + rot) * Math.PI) / 180;
  let a = C * Math.cos(hr);
  let b = C * Math.sin(hr);
  // Additive tint so near-greys (whose hue is meaningless) still get cool shadows / warm lights.
  const tr = (target * Math.PI) / 180;
  a += Math.cos(tr) * tint * k;
  b += Math.sin(tr) * tint * k;
  return oklabToRgb(Math.min(1, Math.max(0, L)), a, b);
}

export interface RampOptions {
  /** Number of tones (default 5). */
  n?: number;
  /** Index of the base colour inside the ramp (default floor((n - 1) / 2)). */
  baseIndex?: number;
  /** OKLab lightness change per step (default 0.07). */
  step?: number;
  /** Hue rotation per step, degrees, toward SHADOW_HUE / HIGHLIGHT_HUE (default 8). */
  hueShift?: number;
  /** OKLab chroma added per step in the target hue direction (default 0.006). */
  tint?: number;
  /** Relative chroma change per step: shadows gain, highlights lose (default 0.05). */
  satShift?: number;
}

/** A tone ramp, darkest first. */
export type Ramp = readonly RGB[];

/**
 * Builds a hue-shifted ramp around `base`, darkest tone first. The base colour itself is
 * at index `baseIndex`, so painters can think in "tone offsets" from the material colour.
 */
export function ramp(base: string | RGB, opts: RampOptions = {}): Ramp {
  const c = typeof base === 'string' ? hex(base) : base;
  const n = opts.n ?? 5;
  const bi = opts.baseIndex ?? Math.floor((n - 1) / 2);
  const out: RGB[] = [];
  for (let i = 0; i < n; i++) out.push(shiftTone(c, i - bi, opts));
  return Object.freeze(out);
}

/** Ramp from explicit colours (darkest first). */
export function rampOf(...colours: string[]): Ramp {
  return Object.freeze(colours.map(hex));
}

/**
 * Darkens a colour for a face in shade: `f` in 0..1 (1 = fully lit, unchanged). Lightness
 * drops and the hue drifts toward blue-violet, matching the tiles' own shading, so shaded
 * faces of icons do not turn muddy grey.
 */
export function shadeColor(c: RGB, f: number): RGB {
  if (f >= 1) return [c[0], c[1], c[2]];
  const k = 1 - Math.max(0, f);
  const [L, a, b] = rgbToOklab(c);
  const C = Math.sqrt(a * a + b * b);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  const d = angleDelta(h, SHADOW_HUE);
  const rot = Math.sign(d) * Math.min(Math.abs(d), 40 * k);
  const hr = ((h + rot) * Math.PI) / 180;
  const tr = (SHADOW_HUE * Math.PI) / 180;
  const a2 = C * Math.cos(hr) + Math.cos(tr) * 0.03 * k;
  const b2 = C * Math.sin(hr) + Math.sin(tr) * 0.03 * k;
  return oklabToRgb(L * (1 - k * 0.8), a2, b2);
}

/** Relative luminance-ish lightness (OKLab L) of a colour, 0..1. */
export function lightness(c: RGB): number {
  return rgbToOklab(c)[0];
}
