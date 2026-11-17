/**
 * Animation fields of the voxel shaders (liquid bobbing, ripples, plant sway), defined so they
 * stay precise and seamless arbitrarily far from the world origin. No three.js import: the
 * TSL graphs in shading.ts are built from these tables, and the CPU mirror below is tested.
 *
 * float32 cannot hold world coordinates like 1 048 576.3 precisely, so the shaders evaluate
 * every field relative to an ANIMATION ORIGIN: the camera position snapped down to a multiple
 * of WAVE_PERIOD. Every wave vector component is a whole number of cycles per WAVE_PERIOD, so
 * each field is exactly WAVE_PERIOD-periodic in x and z: moving the origin by a multiple of
 * the period (when the camera crosses a period boundary) changes nothing on screen.
 */

/** Period (blocks) of every animation field along x and z; also the origin snapping step. */
export const WAVE_PERIOD = 256;

/** Wavenumber (radians per block) with `cycles` whole periods per WAVE_PERIOD. */
function k(cycles: number): number {
  return (2 * Math.PI * cycles) / WAVE_PERIOD;
}

/** One travelling wave a * sin(kx * x + kz * z + w * t). */
export interface Wave {
  readonly kx: number;
  readonly kz: number;
  /** Angular speed, radians per second. */
  readonly w: number;
  /** Amplitude, blocks. */
  readonly a: number;
}

/** Vertical bobbing of liquid-surface vertices (sum of three waves, then BOB_OFFSET). */
export const BOB_WAVES: readonly Wave[] = Object.freeze([
  Object.freeze({ kx: k(25), kz: k(11), w: 1.3, a: 0.022 }),
  Object.freeze({ kx: k(-8), kz: k(34), w: 1.7, a: 0.018 }),
  Object.freeze({ kx: k(56), kz: k(56), w: 2.3, a: 0.009 }),
]);
/**
 * Keeps the bobbing surface (almost) below its resting height: the sum of the amplitudes is
 * 0.049, so a surface vertex never rises more than 0.014 above where the mesher put it and
 * never pokes through a block resting on the water.
 */
export const BOB_OFFSET = -0.035;

/**
 * Ripple height field of water surfaces in the fragment shader; only its analytic gradient
 * is used (shading normal). The first two waves also drive the crest shimmer at HALF their
 * wavenumbers, so their cycle counts are even (keeps the half-frequency field periodic too).
 */
export const RIPPLE_WAVES: readonly Wave[] = Object.freeze([
  Object.freeze({ kx: k(78), kz: k(28), w: 2.1, a: 0.012 }),
  Object.freeze({ kx: k(-36), kz: k(94), w: 2.7, a: 0.01 }),
  Object.freeze({ kx: k(167), kz: k(134), w: -3.9, a: 0.004 }),
]);

/** Spatial phase of plant sway: phase = kx * x + kz * z. */
export const SWAY_PHASE: Readonly<{ kx: number; kz: number }> = Object.freeze({ kx: k(29), kz: k(18) });

/** Animation origin for a camera coordinate: snapped down to a multiple of WAVE_PERIOD. */
export function animOrigin(c: number): number {
  return Math.floor(c / WAVE_PERIOD) * WAVE_PERIOD;
}

/** CPU mirror of the shader's bobbing offset at anim-space (x, z) and time t. */
export function bobHeight(x: number, z: number, t: number): number {
  let h = BOB_OFFSET;
  for (const wv of BOB_WAVES) h += wv.a * Math.sin(wv.kx * x + wv.kz * z + wv.w * t);
  return h;
}
