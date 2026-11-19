/**
 * ShipDynamics.refresh: derived data of a ship after its cells (or the rotors it carries)
 * changed — hull analysis, mass, inertia, centre of mass (the pivot), bow direction — plus
 * the adaptive water damping and the collision shape.
 *
 * Mass includes the rotors mounted on the ship (LESSONS 船上风车坏了，船的帆数、极速、质量不变):
 * each child counts as a point mass at its hub plus an isotropic own inertia. A windmill's
 * centre of mass sits close to its hub and moves little as it spins, so the pivot does not
 * have to chase the blades every tick. Because the mass of the whole ship decides whether it
 * can float, refresh also rewrites hull.floats (and with it displacesWater / isDryCell /
 * dryMask) from the total mass.
 */
import { cellFacing, findFirstHelm, isHelmCell } from './helm';
import { HOLES_SHIFT, ID_MASK } from '../../blocks/cell';
import { BLOCKS } from '../../blocks/registry';
import { CENTROID, FILL_VOLUME } from '../../blocks/shapes';
import type { Vec3 } from '../../core/math';
import { analyzeHull } from '../hull';
import type { Rotor, Ship } from '../structure';
import type { Body } from './body';
import { mat3Invert } from './mat3';
import type { ResolvedOptions } from './options';

/** Mass and own inertia (isotropic approximation about the hub) of one mounted rotor. */
interface RotorMass {
  mass: number;
  /** sum of m * |r|^2 over cells, r relative to the rotor pivot. */
  mr2: number;
}

/**
 * Every part counts as a point mass density x volume at its centroid (docs/SHAPES.md 12.2); a full
 * single-part block at its cell centre, as in M1. Storage order (y, z, x), the order of forEachCell.
 */
function rotorMass(rotor: Rotor): RotorMass {
  const g = rotor.grid;
  let mass = 0;
  let mr2 = 0;
  const p = g.pivot;
  const st = g.storage();
  const base = st.layers.base;
  const holes = st.layers.holes;
  const part2 = st.layers.part2;
  let i = 0;
  for (let y = 0; y < st.sy; y++) {
    for (let z = 0; z < st.sz; z++) {
      for (let x = 0; x < st.sx; x++, i++) {
        const v = base[i]!;
        if (v === 0) continue;
        const h1 = holes !== null ? holes[i]! : 0;
        const p2 = part2 !== null ? part2[i]! : 0;
        const cx = x + st.ox;
        const cy = y + st.oy;
        const cz = z + st.oz;
        if (h1 === 0 && p2 === 0) {
          const def = BLOCKS[v & ID_MASK];
          const m = def ? def.density : 1;
          const dx = cx + 0.5 - p.x;
          const dy = cy + 0.5 - p.y;
          const dz = cz + 0.5 - p.z;
          mass += m;
          mr2 += m * (dx * dx + dy * dy + dz * dz);
          continue;
        }
        for (let k = 0; k < 2; k++) {
          const part = k === 0 ? v | (h1 << HOLES_SHIFT) : p2;
          if (part === 0) continue;
          const fill = ~(part >>> HOLES_SHIFT) & 0xff;
          const def = BLOCKS[part & ID_MASK];
          const m = ((def ? def.density : 1) * FILL_VOLUME[fill]!) / 8;
          const dx = cx + CENTROID[fill * 3]! - p.x;
          const dy = cy + CENTROID[fill * 3 + 1]! - p.y;
          const dz = cz + CENTROID[fill * 3 + 2]! - p.z;
          mass += m;
          mr2 += m * (dx * dx + dy * dy + dz * dz);
        }
      }
    }
  }
  return { mass, mr2 };
}

/** True when the child-rotor signature changed since the last refresh (and records the new one). */
function childrenChanged(ship: Ship, body: Body): boolean {
  const kids = ship.children;
  const sig = body.childSig;
  let same = sig.length === kids.length * 3;
  if (same) {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      if (sig[i * 3] !== k.id || sig[i * 3 + 1] !== k.grid.version || sig[i * 3 + 2] !== k.grid.count) {
        same = false;
        break;
      }
    }
  }
  if (same) return false;
  sig.length = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    sig.push(k.id, k.grid.version, k.grid.count);
  }
  return true;
}

/** Add m * (|d|^2 I - d d^T) to a row-major inertia tensor. */
function addPointInertia(I: Float64Array, m: number, dx: number, dy: number, dz: number): void {
  I[0] += m * (dy * dy + dz * dz);
  I[4] += m * (dx * dx + dz * dz);
  I[8] += m * (dx * dx + dy * dy);
  I[1] -= m * dx * dy;
  I[2] -= m * dx * dz;
  I[5] -= m * dy * dz;
  I[3] -= m * dx * dy;
  I[6] -= m * dx * dz;
  I[7] -= m * dy * dz;
}

/**
 * Bring the ship's derived data up to date. Returns true when anything was recomputed (the
 * caller wakes the ship). Cheap when nothing changed: a version compare, a child-signature
 * compare and a pivot compare.
 */
export function refreshShip(ship: Ship, body: Body, o: ResolvedOptions): boolean {
  const g = ship.grid;
  const versionChanged = body.hullVersion !== g.version;
  const kidsChanged = childrenChanged(ship, body);
  const p = g.pivot;
  const pivotMoved = body.massValid && (p.x !== body.pivot.x || p.y !== body.pivot.y || p.z !== body.pivot.z);
  if (!versionChanged && !kidsChanged && !pivotMoved && body.massValid) return false;

  if (versionChanged || ship.hull === null || ship.hull.version !== g.version) {
    ship.hull = analyzeHull(g);
  }
  body.hullVersion = g.version;
  const hull = ship.hull;

  // ---- total mass, centre of mass, inertia about it (local axes)
  let mass = hull !== null ? hull.mass : 0;
  let cx = hull !== null ? hull.com.x * hull.mass : 0;
  let cy = hull !== null ? hull.com.y * hull.mass : 0;
  let cz = hull !== null ? hull.com.z * hull.mass : 0;
  const kids = ship.children;
  const kidMass: RotorMass[] = [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    const rm = rotorMass(k);
    kidMass.push(rm);
    mass += rm.mass;
    const hub = k.grid.position; // hub centre in ship-local coordinates
    cx += hub.x * rm.mass;
    cy += hub.y * rm.mass;
    cz += hub.z * rm.mass;
  }

  const I = new Float64Array(9);
  if (mass > 0) {
    cx /= mass;
    cy /= mass;
    cz /= mass;
    if (hull !== null) {
      for (let i = 0; i < 9; i++) I[i] = hull.inertia[i]!;
      addPointInertia(I, hull.mass, hull.com.x - cx, hull.com.y - cy, hull.com.z - cz);
    }
    for (let i = 0; i < kids.length; i++) {
      const hub = kids[i]!.grid.position;
      const rm = kidMass[i]!;
      addPointInertia(I, rm.mass, hub.x - cx, hub.y - cy, hub.z - cz);
      // A spinning rotor's own inertia averaged over its spin is close to isotropic:
      // trace / 3 = (2/3) sum m r^2.
      const own = (2 / 3) * rm.mr2;
      I[0] += own;
      I[4] += own;
      I[8] += own;
    }
    // Guard against a degenerate tensor (should not happen: every non-empty part adds a positive
    // own term per axis, m/6 for a block, m/24 per octant).
    const floor = mass * 1e-3;
    if (I[0]! < floor) I[0] = floor;
    if (I[4]! < floor) I[4] = floor;
    if (I[8]! < floor) I[8] = floor;
  }

  // ---- floating (whole ship) and the shape built from it
  const floats = hull !== null && mass < hull.maxDisplacement * o.waterDensity;
  if (hull !== null) hull.floats = floats;
  body.floats = floats;

  // ---- pivot -> new centre of mass, motion unchanged
  if (mass > 0) {
    const ox = g.position.x;
    const oy = g.position.y;
    const oz = g.position.z;
    if (p.x !== cx || p.y !== cy || p.z !== cz) {
      g.setPivotKeepingPose({ x: cx, y: cy, z: cz });
    }
    // The grid's linear velocity is the pivot's: v_new = v + w x (newCOM - oldCOM).
    const dx = g.position.x - ox;
    const dy = g.position.y - oy;
    const dz = g.position.z - oz;
    const w = g.angularVelocity;
    const v = g.linearVelocity;
    v.x += w.y * dz - w.z * dy;
    v.y += w.z * dx - w.x * dz;
    v.z += w.x * dy - w.y * dx;
  }

  ship.mass = mass;
  body.mass = mass;
  body.invMass = mass > 0 ? 1 / mass : 0;
  if (mass > 0) mat3Invert(I, body.invIl);
  else body.invIl.fill(0);
  ship.invInertiaLocal.set(body.invIl);
  body.pivot.x = g.pivot.x;
  body.pivot.y = g.pivot.y;
  body.pivot.z = g.pivot.z;
  body.massValid = true;

  body.shape.build(g, hull, floats);
  estimateDamping(body, I, o);

  if (versionChanged) selectForward(ship);
  return true;
}

/**
 * Bow direction from the helm: keep the current helm cell if it is still a helm, else the
 * first helm of a deterministic scan (y, then z, then x ascending); with no helm at all the
 * previous forward stays.
 */
function selectForward(ship: Ship): void {
  const g = ship.grid;
  const cur = g.getCell(ship.helmX, ship.helmY, ship.helmZ);
  if (isHelmCell(cur)) {
    ship.forward = cellFacing(cur);
    return;
  }
  const found: Vec3 = { x: 0, y: 0, z: 0 };
  const cell = findFirstHelm(g, found);
  if (cell !== 0) {
    ship.helmX = found.x;
    ship.helmY = found.y;
    ship.helmZ = found.z;
    ship.forward = cellFacing(cell);
  }
}

/**
 * Linear water damping adapted to the hull, so that every ship design bobs briefly and
 * settles instead of oscillating (LESSONS 船纵倾、横倾过大). From the upright equilibrium
 * waterline (Archimedes on the displacing cells, layer by layer: displaced volume = m / rho)
 * we take the waterplane area A and its second moments Ix, Iz; then
 *     heave:  w^2 = rho g A / m        roll about local X: w^2 = rho g Ix / I_xx   (Z likewise)
 * and the damping is 2 * zeta * w. Ships that cannot float keep moderate defaults. A hull with
 * half cubes works on half layers instead (estimateDampingHalf).
 */
function estimateDamping(body: Body, I: Float64Array, o: ResolvedOptions): void {
  body.heaveDamping = 3;
  body.rollDampingX = 2;
  body.rollDampingZ = 2;
  const s = body.shape;
  const n = s.dispCount;
  if (!body.floats || n + s.halfCount === 0 || body.mass <= 0) return;
  if (s.halfCount > 0) {
    estimateDampingHalf(body, I, o);
    return;
  }
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = s.dy[i]!;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const layers = Math.round(ymax - ymin) + 1;
  const counts = new Float64Array(layers);
  for (let i = 0; i < n; i++) counts[Math.round(s.dy[i]! - ymin)]! += 1;
  const rho = o.waterDensity;
  const volume = body.mass / rho;
  let acc = 0;
  let wl = layers - 1;
  for (let l = 0; l < layers; l++) {
    if (acc + counts[l]! >= volume) {
      wl = l;
      break;
    }
    acc += counts[l]!;
  }
  const yWl = ymin + wl;
  let area = 0;
  let ix = 0;
  let iz = 0;
  const c = body.pivot;
  for (let i = 0; i < n; i++) {
    if (Math.abs(s.dy[i]! - yWl) > 0.25) continue;
    area += 1;
    const dz = s.dz[i]! - c.z;
    const dx = s.dx[i]! - c.x;
    ix += dz * dz + 1 / 12;
    iz += dx * dx + 1 / 12;
  }
  if (area <= 0) return;
  setDamping(body, I, o, area, ix, iz);
}

function setDamping(body: Body, I: Float64Array, o: ResolvedOptions, area: number, ix: number, iz: number): void {
  const g = o.gravity * o.waterDensity;
  const clampC = (v: number): number => (v < 0.5 ? 0.5 : v > 25 ? 25 : v);
  body.heaveDamping = clampC(2 * o.heaveDampingRatio * Math.sqrt((g * area) / body.mass));
  body.rollDampingX = clampC(2 * o.rollDampingRatio * Math.sqrt((g * ix) / Math.max(I[0]!, 1e-6)));
  body.rollDampingZ = clampC(2 * o.rollDampingRatio * Math.sqrt((g * iz) / Math.max(I[8]!, 1e-6)));
}

/**
 * estimateDamping for a hull with half cubes (docs/SHAPES.md 12.5), on half layers: the bottom of
 * a unit cube is dy - 0.5, of a half cube dy - 0.25; half layer j = round((bottom - ymin) * 2). A
 * unit cube gives 0.5 to half layers j and j + 1, a half cube 0.125 to j. The waterline half layer
 * wl is the first at which the accumulated volume reaches mass / rho (else the top one). The
 * waterplane counts each displacing body crossing half layer wl once: a unit cube (j or j + 1 is
 * wl) with area 1 and own second moment 1/12, a half cube (j is wl) with area 1/4 and own second
 * moment 1/48 per unit area (a square of side 0.5). The two half cubes of an upright slab lie in
 * different half layers, so a column's area is never counted twice.
 */
function estimateDampingHalf(body: Body, I: Float64Array, o: ResolvedOptions): void {
  const s = body.shape;
  const n = s.dispCount;
  const nh = s.halfCount;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = s.dy[i]! - 0.5;
    if (b < ymin) ymin = b;
    if (b + 0.5 > ymax) ymax = b + 0.5;
  }
  for (let i = 0; i < nh; i++) {
    const b = s.hcy[i]! - 0.25;
    if (b < ymin) ymin = b;
    if (b > ymax) ymax = b;
  }
  const layers = Math.round((ymax - ymin) * 2) + 1;
  const vol = new Float64Array(layers);
  for (let i = 0; i < n; i++) {
    const j = Math.round((s.dy[i]! - 0.5 - ymin) * 2);
    vol[j]! += 0.5;
    vol[j + 1]! += 0.5;
  }
  for (let i = 0; i < nh; i++) vol[Math.round((s.hcy[i]! - 0.25 - ymin) * 2)]! += 0.125;
  const volume = body.mass / o.waterDensity;
  let acc = 0;
  let wl = layers - 1;
  for (let l = 0; l < layers; l++) {
    acc += vol[l]!;
    if (acc >= volume) {
      wl = l;
      break;
    }
  }
  let area = 0;
  let ix = 0;
  let iz = 0;
  const c = body.pivot;
  for (let i = 0; i < n; i++) {
    const j = Math.round((s.dy[i]! - 0.5 - ymin) * 2);
    if (j !== wl && j + 1 !== wl) continue;
    area += 1;
    const dz = s.dz[i]! - c.z;
    const dx = s.dx[i]! - c.x;
    ix += dz * dz + 1 / 12;
    iz += dx * dx + 1 / 12;
  }
  for (let i = 0; i < nh; i++) {
    if (Math.round((s.hcy[i]! - 0.25 - ymin) * 2) !== wl) continue;
    area += 0.25;
    const dz = s.hcz[i]! - c.z;
    const dx = s.hcx[i]! - c.x;
    ix += (dz * dz + 1 / 48) / 4;
    iz += (dx * dx + 1 / 48) / 4;
  }
  if (area <= 0) return;
  setDamping(body, I, o, area, ix, iz);
}
