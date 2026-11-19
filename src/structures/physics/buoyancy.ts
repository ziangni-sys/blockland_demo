/**
 * Buoyancy, evaluated per displacing cell at its centre (docs/DESIGN.md 浮力逐点计算，包括密封空腔):
 *     F_i = waterDensity * g * submergedFraction_i   (upward, at the cell centre)
 * The submerged fraction intersects the unit cube centred on the cell (treated as upright) with
 * the world's water in that world column (WorldPatch water model). Applying each force at its
 * cell centre makes a heeled hull right itself and trims it naturally. The displacing octants of
 * cells that do not displace as a whole are half cubes (side 0.5, upright, at the octant centre),
 * handled by a second loop with their own submerged height (docs/SHAPES.md 12.5).
 *
 * Only y and the horizontal lever arm matter for a vertical force, so the torque reduces to
 *     tau = rho g (-sum f_i rz_i, 0, sum f_i rx_i).
 */
import type { Body } from './body';
import { PF_WATER as PF_WATER_IMPORT, WATER_SURFACE_DROP } from './patch';

// Module constants (not imported bindings) in the hot loop; see solver.ts.
const PF_WATER = PF_WATER_IMPORT;
const TOP_FILL = 1 - WATER_SURFACE_DROP;

/**
 * Accumulate buoyancy for the body's current frame. Writes body.submerged and returns nothing;
 * the force / torque are added to the body's velocities over `dt` by applyBuoyancy.
 */
export function applyBuoyancy(body: Body, rhoG: number, dt: number): void {
  const s = body.shape;
  const n = s.dispCount;
  if (n + s.halfCount === 0) {
    body.submerged = 0;
    return;
  }
  const patch = body.patch;
  // A cube whose bottom is at or above the top of the highest water cell of the patch is dry:
  // skip it after one row of the transform (half of a floating hull, most of a tall one).
  const waterTop = patch.waterTop;
  if (waterTop === -Infinity) {
    body.submerged = 0;
    return;
  }
  const f = patch.flags;
  const pox = patch.ox;
  const poy = patch.oy;
  const poz = patch.oz;
  const psx = patch.sx;
  const psy = patch.sy;
  const psz = patch.sz;
  const R = body.R;
  const r0 = R[0]!;
  const r1 = R[1]!;
  const r2 = R[2]!;
  const r3 = R[3]!;
  const r4 = R[4]!;
  const r5 = R[5]!;
  const r6 = R[6]!;
  const r7 = R[7]!;
  const r8 = R[8]!;
  const tx = body.tx;
  const ty = body.ty;
  const tz = body.tz;
  const px = body.px;
  const pz = body.pz;
  const dx = s.dx;
  const dy = s.dy;
  const dz = s.dz;
  let sum = 0;
  let sumRx = 0;
  let sumRz = 0;
  for (let i = 0; i < n; i++) {
    const lx = dx[i]!;
    const ly = dy[i]!;
    const lz = dz[i]!;
    const wy = r3 * lx + r4 * ly + r5 * lz + ty;
    const y0 = wy - 0.5;
    if (y0 >= waterTop) continue;
    const k0 = Math.floor(y0);
    const wx = r0 * lx + r1 * ly + r2 * lz + tx;
    const wz = r6 * lx + r7 * ly + r8 * lz + tz;
    const ix = Math.floor(wx) - pox;
    const iz = Math.floor(wz) - poz;
    const iy = k0 - poy;
    let h0: number;
    let h1: number;
    if (ix >= 0 && iz >= 0 && iy >= 0 && ix < psx && iz < psz && iy + 2 < psy) {
      const base = (iz * psx + ix) * psy + iy;
      const f0 = f[base]! & PF_WATER;
      const f1 = f[base + 1]! & PF_WATER;
      const f2 = f[base + 2]! & PF_WATER;
      h0 = f0 === 0 ? 0 : f1 !== 0 ? 1 : TOP_FILL;
      h1 = f1 === 0 ? 0 : f2 !== 0 ? 1 : TOP_FILL;
    } else {
      const cx = Math.floor(wx);
      const cz = Math.floor(wz);
      h0 = patch.waterFill(cx, k0, cz);
      h1 = patch.waterFill(cx, k0 + 1, cz);
    }
    // Water fills [k0, k0+h0] and [k0+1, k0+1+h1]; the cube spans [y0, y0+1] with
    // fy = y0 - k0 in [0,1): overlap = max(0, h0 - fy) + min(fy, h1). Continuous in y.
    const fy = y0 - k0;
    let frac = h0 - fy;
    if (frac < 0) frac = 0;
    frac += fy < h1 ? fy : h1;
    if (frac > 0) {
      sum += frac;
      sumRx += frac * (wx - px);
      sumRz += frac * (wz - pz);
    }
  }
  // half cubes: [y0, y0 + 0.5] against the water in cells k0 and k0 + 1 (fy in [0, 1)); the
  // submerged volume is the base area 1/4 times the wet height (0..0.5, continuous in y)
  const nh = s.halfCount;
  const hx = s.hcx;
  const hy = s.hcy;
  const hz = s.hcz;
  for (let i = 0; i < nh; i++) {
    const lx = hx[i]!;
    const ly = hy[i]!;
    const lz = hz[i]!;
    const wy = r3 * lx + r4 * ly + r5 * lz + ty;
    const y0 = wy - 0.25;
    if (y0 >= waterTop) continue;
    const k0 = Math.floor(y0);
    const wx = r0 * lx + r1 * ly + r2 * lz + tx;
    const wz = r6 * lx + r7 * ly + r8 * lz + tz;
    const ix = Math.floor(wx) - pox;
    const iz = Math.floor(wz) - poz;
    const iy = k0 - poy;
    let h0: number;
    let h1: number;
    if (ix >= 0 && iz >= 0 && iy >= 0 && ix < psx && iz < psz && iy + 2 < psy) {
      const base = (iz * psx + ix) * psy + iy;
      const f0 = f[base]! & PF_WATER;
      const f1 = f[base + 1]! & PF_WATER;
      const f2 = f[base + 2]! & PF_WATER;
      h0 = f0 === 0 ? 0 : f1 !== 0 ? 1 : TOP_FILL;
      h1 = f1 === 0 ? 0 : f2 !== 0 ? 1 : TOP_FILL;
    } else {
      const cx = Math.floor(wx);
      const cz = Math.floor(wz);
      h0 = patch.waterFill(cx, k0, cz);
      h1 = patch.waterFill(cx, k0 + 1, cz);
    }
    const fy = y0 - k0;
    const top = fy + 0.5;
    let lo = (h0 < top ? h0 : top) - fy;
    if (lo < 0) lo = 0;
    let hi = (top < 1 + h1 ? top : 1 + h1) - 1;
    if (hi < 0) hi = 0;
    const v = 0.25 * (lo + hi);
    if (v > 0) {
      sum += v;
      sumRx += v * (wx - px);
      sumRz += v * (wz - pz);
    }
  }
  body.submerged = sum;
  if (sum === 0) return;
  // linear: vertical only
  body.vy += rhoG * sum * body.invMass * dt;
  // angular: tau = rhoG * (-sumRz, 0, sumRx)
  const tX = -rhoG * sumRz;
  const tZ = rhoG * sumRx;
  const I = body.invIw;
  body.wx += (I[0]! * tX + I[2]! * tZ) * dt;
  body.wy += (I[3]! * tX + I[5]! * tZ) * dt;
  body.wz += (I[6]! * tX + I[8]! * tZ) * dt;
}
