/**
 * Pure day/night + light model shared by the shaders (mirrored in TSL in shading.ts) and by
 * the CPU code that feeds per-frame uniforms. No three.js import: this file is unit-tested
 * in Node.
 *
 * All colours here are LINEAR RGB (the renderer works in linear space and converts to sRGB
 * in its output pass). Authoring constants are written as sRGB hex for readability and
 * converted once at module load (immutable lookup tables).
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Dir3 {
  x: number;
  y: number;
  z: number;
}

// ------------------------------------------------------------------ light curve

/**
 * Shape of the brightness curve: l / (K - (K - 1) l). K = 1 is linear; larger K keeps light
 * bright near its source and lets it fall off quickly towards darkness, which reads like
 * real light falloff on a 16-level grid without the harsh steps of a pure power curve.
 */
export const LIGHT_CURVE_K = 2.7;

/** Never fully black: caves stay faintly readable (applied after the curve). */
export const AMBIENT_FLOOR = 0.028;

/** Brightness 0..1 for a normalized light value 0..1 (1 = level 15). */
export function lightCurve(l: number): number {
  const x = l <= 0 ? 0 : l >= 1 ? 1 : l;
  return x / (LIGHT_CURVE_K - (LIGHT_CURVE_K - 1) * x);
}

/** Final scalar brightness before tinting: floor + (1 - floor) * curve. */
export function shadedBrightness(sky: number, block: number, dayLight: number): number {
  const s = lightCurve(sky * dayLight);
  const b = lightCurve(block);
  const m = s > b ? s : b;
  return AMBIENT_FLOOR + (1 - AMBIENT_FLOOR) * m;
}

/** Ambient occlusion factor for a vertex AO value 0..1 (1 = open). */
export function aoFactor(ao: number): number {
  return 0.45 + 0.55 * (ao <= 0 ? 0 : ao >= 1 ? 1 : ao);
}

/**
 * Fixed directional face term: top brightest, bottom darkest, the two horizontal axes a
 * little different so box shapes read without real shadows. Works for any unit normal
 * (rotated structures) by weighting with the squared components.
 */
export const FACE_TOP = 1.0;
export const FACE_BOTTOM = 0.58;
export const FACE_X = 0.78;
export const FACE_Z = 0.88;

export function faceShade(nx: number, ny: number, nz: number): number {
  const vy = ny > 0 ? FACE_TOP : FACE_BOTTOM;
  return nx * nx * FACE_X + ny * ny * vy + nz * nz * FACE_Z;
}

// ------------------------------------------------------------------ colours

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function hexToLinear(hex: number): RGB {
  return {
    r: srgbToLinear(((hex >> 16) & 255) / 255),
    g: srgbToLinear(((hex >> 8) & 255) / 255),
    b: srgbToLinear((hex & 255) / 255),
  };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function mixRGB(a: Readonly<RGB>, b: Readonly<RGB>, t: number, out: RGB): RGB {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

function setRGB(out: RGB, c: Readonly<RGB>): RGB {
  out.r = c.r;
  out.g = c.g;
  out.b = c.b;
  return out;
}

// Authoring palette (sRGB hex -> linear). Original palette, tuned by eye in the dev harness.
const DAY_ZENITH: Readonly<RGB> = Object.freeze(hexToLinear(0x3a78d8));
const DAY_HORIZON: Readonly<RGB> = Object.freeze(hexToLinear(0xa8cdef));
const TWILIGHT_ZENITH: Readonly<RGB> = Object.freeze(hexToLinear(0x3d4f8f));
const TWILIGHT_HORIZON: Readonly<RGB> = Object.freeze(hexToLinear(0xf0a070));
const NIGHT_ZENITH: Readonly<RGB> = Object.freeze(hexToLinear(0x03060f));
const NIGHT_HORIZON: Readonly<RGB> = Object.freeze(hexToLinear(0x0d1528));
const SUN_GLOW: Readonly<RGB> = Object.freeze(hexToLinear(0xff8a3c));

const SKY_TINT_DAY: Readonly<RGB> = Object.freeze(hexToLinear(0xfffaf2));
const SKY_TINT_TWILIGHT: Readonly<RGB> = Object.freeze(hexToLinear(0xffd2a6));
const SKY_TINT_NIGHT: Readonly<RGB> = Object.freeze(hexToLinear(0x9db4ff));
/** Warm torch / lamp light. */
export const BLOCK_TINT: Readonly<RGB> = Object.freeze(hexToLinear(0xffd29a));

const SUN_CORE: Readonly<RGB> = Object.freeze(hexToLinear(0xfff6d8));
const SUN_LOW: Readonly<RGB> = Object.freeze(hexToLinear(0xffb060));
const MOON_CORE: Readonly<RGB> = Object.freeze(hexToLinear(0xdfe7ff));

const CLOUD_DAY: Readonly<RGB> = Object.freeze(hexToLinear(0xffffff));
const CLOUD_TWILIGHT: Readonly<RGB> = Object.freeze(hexToLinear(0xffc8a8));
const CLOUD_NIGHT: Readonly<RGB> = Object.freeze(hexToLinear(0x2a3550));

const WATER_FOG: Readonly<RGB> = Object.freeze(hexToLinear(0x0f4f5c));
const LAVA_FOG: Readonly<RGB> = Object.freeze(hexToLinear(0xd8500a));

/** Skylight multiplier at night (moonlight). */
export const NIGHT_LIGHT = 0.2;

/** Tilt of the sun path towards +Z (south), radians. */
export const SUN_TILT = 0.32;

/**
 * Direction TOWARDS the sun for a dayTime in [0,1): 0 sunrise (east, +X), 0.25 noon,
 * 0.5 sunset (west), 0.75 midnight. The moon is exactly opposite.
 */
export function sunDirection(dayTime: number, out: Dir3): Dir3 {
  const a = dayTime * Math.PI * 2;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = c;
  out.y = s * Math.cos(SUN_TILT);
  out.z = s * Math.sin(SUN_TILT);
  return out;
}

/** Skylight multiplier 0..1 (NIGHT_LIGHT at night, 1 by day), smooth across sunrise / sunset. */
export function dayLightFactor(dayTime: number): number {
  const e = Math.sin(dayTime * Math.PI * 2) * Math.cos(SUN_TILT);
  return NIGHT_LIGHT + (1 - NIGHT_LIGHT) * smoothstep(-0.16, 0.24, e);
}

/** 1 around sunrise / sunset, 0 at noon and midnight. */
export function twilightFactor(dayTime: number): number {
  const e = Math.sin(dayTime * Math.PI * 2) * Math.cos(SUN_TILT);
  return 1 - smoothstep(0.0, 0.42, Math.abs(e + 0.03));
}

/** 1 deep at night, 0 by day. */
export function nightFactor(dayTime: number): number {
  const e = Math.sin(dayTime * Math.PI * 2) * Math.cos(SUN_TILT);
  return 1 - smoothstep(-0.32, 0.02, e);
}

/** Everything the sky / fog / lighting shaders need for one moment of the day. */
export interface SkyState {
  sunDir: Dir3;
  moonDir: Dir3;
  zenith: RGB;
  horizon: RGB;
  /** Glow added around the sun near the horizon (already scaled by twilight strength). */
  sunGlow: RGB;
  sunColor: RGB;
  moonColor: RGB;
  /** Multiplies skylight on terrain. */
  skyTint: RGB;
  blockTint: RGB;
  cloudColor: RGB;
  dayLight: number;
  twilight: number;
  night: number;
  /** 0..1 star visibility. */
  stars: number;
}

export function createSkyState(): SkyState {
  const c = (): RGB => ({ r: 0, g: 0, b: 0 });
  return {
    sunDir: { x: 1, y: 0, z: 0 },
    moonDir: { x: -1, y: 0, z: 0 },
    zenith: c(),
    horizon: c(),
    sunGlow: c(),
    sunColor: c(),
    moonColor: c(),
    skyTint: c(),
    blockTint: c(),
    cloudColor: c(),
    dayLight: 1,
    twilight: 0,
    night: 0,
    stars: 0,
  };
}

/** Fills `out` for the given dayTime (wrapped into [0,1)). Allocation-free. */
export function computeSkyState(dayTime: number, out: SkyState): SkyState {
  const t = dayTime - Math.floor(dayTime);
  sunDirection(t, out.sunDir);
  out.moonDir.x = -out.sunDir.x;
  out.moonDir.y = -out.sunDir.y;
  out.moonDir.z = -out.sunDir.z;

  const day = smoothstep(-0.12, 0.3, out.sunDir.y);
  const tw = twilightFactor(t);
  const night = nightFactor(t);
  out.dayLight = dayLightFactor(t);
  out.twilight = tw;
  out.night = night;
  out.stars = smoothstep(0.35, 0.9, night);

  // Base gradient: night -> day by sun height, then pull towards the twilight palette.
  mixRGB(NIGHT_ZENITH, DAY_ZENITH, day, out.zenith);
  mixRGB(NIGHT_HORIZON, DAY_HORIZON, day, out.horizon);
  const twz = tw * 0.75;
  mixRGB(out.zenith, TWILIGHT_ZENITH, twz * (1 - night * 0.6), out.zenith);
  mixRGB(out.horizon, TWILIGHT_HORIZON, tw * (1 - night * 0.5), out.horizon);

  const glow = tw * (1 - night * 0.7);
  out.sunGlow.r = SUN_GLOW.r * glow;
  out.sunGlow.g = SUN_GLOW.g * glow;
  out.sunGlow.b = SUN_GLOW.b * glow;

  mixRGB(SUN_CORE, SUN_LOW, tw, out.sunColor);
  setRGB(out.moonColor, MOON_CORE);

  // Skylight tint: neutral by day, warm at golden hour, cool moonlight at night.
  mixRGB(SKY_TINT_NIGHT, SKY_TINT_DAY, day, out.skyTint);
  mixRGB(out.skyTint, SKY_TINT_TWILIGHT, tw * 0.8 * (1 - night), out.skyTint);
  setRGB(out.blockTint, BLOCK_TINT);

  mixRGB(CLOUD_NIGHT, CLOUD_DAY, day, out.cloudColor);
  mixRGB(out.cloudColor, CLOUD_TWILIGHT, tw * (1 - night * 0.8), out.cloudColor);
  return out;
}

// ------------------------------------------------------------------ fog

export interface FogParams {
  start: number;
  end: number;
  /** Used only when submerged (otherwise the shader takes the sky horizon colour). */
  color: RGB;
  /** 1 when the fog colour is the fixed `color` (submerged), 0 when it follows the sky. */
  fixedColor: number;
}

export function createFogParams(): FogParams {
  return { start: 0, end: 1, color: { r: 0, g: 0, b: 0 }, fixedColor: 0 };
}

/**
 * Distance fog fitted to the view distance: fully clear for the first ~55%, then blending to
 * the horizon colour so chunk loading at the edge is hidden. Submerged: short, tinted.
 */
export function computeFog(
  viewDistance: number,
  submerged: 'none' | 'water' | 'lava',
  dayLight: number,
  out: FogParams,
): FogParams {
  const vd = viewDistance > 8 ? viewDistance : 8;
  if (submerged === 'water') {
    out.start = 0;
    out.end = Math.min(28, vd * 0.6);
    const k = 0.25 + 0.75 * dayLight;
    out.color.r = WATER_FOG.r * k;
    out.color.g = WATER_FOG.g * k;
    out.color.b = WATER_FOG.b * k;
    out.fixedColor = 1;
  } else if (submerged === 'lava') {
    out.start = 0;
    out.end = 2.5;
    setRGB(out.color, LAVA_FOG);
    out.fixedColor = 1;
  } else {
    out.start = vd * 0.55;
    out.end = vd * 0.98;
    out.color.r = 0;
    out.color.g = 0;
    out.color.b = 0;
    out.fixedColor = 0;
  }
  return out;
}
