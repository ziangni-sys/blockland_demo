/**
 * Sampling rule of the dry-volume cut (shading.ts dryVolumeFactor), as a pure CPU mirror for
 * tests. No three.js import.
 *
 * The mask is an R8 3D texture in DryVolume byte order (width = local x, height = local z,
 * depth = local y), dry texels normalized to 1. A texel is a cell (DryVolume scale 1) or an
 * octant (scale 2: hulls with half-filled cells, docs/SHAPES.md 12.8). The shader samples it
 *   - at the CENTRE of the fragment's texel layer in y (exact texel in y), and
 *   - bilinearly (hardware LINEAR, clamp to edge) in x and z,
 * and cuts world water where the value exceeds DRY_THRESHOLD.
 *
 * Why: inside a dry texel the bilinear value never drops below 0.25 (an inner corner of the
 * hold has one dry texel out of the four around the vertex), so every dry fragment is cut;
 * the cut reaches at most ~0.3 texels into neighbouring texels, which for the dry texels of a
 * hull are always hard or dry themselves (hull.ts: in its flood, a bilge / sealed node's
 * horizontal neighbours at the same height that are not hard are bilge / sealed too) — that
 * overlap hides the z-fight line where the water plane meets the inner wall faces. Trilinear
 * filtering in y let a non-dry layer above or below (hold floor, deck) pull corner values under
 * the threshold near the floor.
 */

/** Mask value above which world water is cut. */
export const DRY_THRESHOLD = 0.2;

/**
 * Mask value the shader computes at mask coordinates (u, v, w) in [0, 1]^3
 * (u = local x, v = local z, w = local y, each over the box size). sx, sy, sz count TEXELS
 * (cells times the DryVolume scale); `mask` holds 0 / 1 (or 0 / 255) per texel,
 * index = x + z * sx + y * sx * sz.
 */
export function sampleDryMask(mask: ArrayLike<number>, sx: number, sy: number, sz: number, u: number, v: number, w: number): number {
  const norm = (i: number): number => (mask[i]! !== 0 ? 1 : 0);
  // Nearest layer in y (the shader's floor(w * sy) + 0.5, clamped into the box).
  const cy = Math.min(sy - 1, Math.max(0, Math.floor(clamp01(w) * sy)));
  // Bilinear in x / z with texel centres at (i + 0.5) / size and clamp-to-edge.
  const fx = clamp01(u) * sx - 0.5;
  const fz = clamp01(v) * sz - 0.5;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;
  const at = (x: number, z: number): number => {
    const xi = Math.min(sx - 1, Math.max(0, x));
    const zi = Math.min(sz - 1, Math.max(0, z));
    return norm(xi + zi * sx + cy * sx * sz);
  };
  const a = at(x0, z0) * (1 - tx) + at(x0 + 1, z0) * tx;
  const b = at(x0, z0 + 1) * (1 - tx) + at(x0 + 1, z0 + 1) * tx;
  return a * (1 - tz) + b * tz;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
