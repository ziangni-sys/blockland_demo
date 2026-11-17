/**
 * Headless fixtures for the ship dynamics tests: hand-built worlds (new Chunk + cells), ships
 * built cell by cell, rotors spun by hand, and measurement helpers. No worldgen, no manager.
 */
import { makeCell, facingState, ID_MASK } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { CHUNK_SHIFT, TICK_DT } from '../../src/core/constants';
import { DIR_X, DIR_Y, DIR_Z, type Dir } from '../../src/core/dirs';
import { qfromAxisAngle, qmul, qrotate, qtoMat3, quat, vec3, type Quat, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { GlueStore } from '../../src/structures/glue';
import { displacesWater } from '../../src/structures/hull';
import { Rotor, Ship, type StructureHost } from '../../src/structures/structure';
import { createShipDynamics, type DynamicsOptions } from '../../src/structures/physics';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';

/** Sea layout used by most tests: stone up to FLOOR_TOP (exclusive), water up to WATER_TOP (exclusive). */
export const FLOOR_TOP = 36;
export const WATER_TOP = 48;
/** Water surface height: top of the highest water cell minus 2/16. */
export const SURFACE = WATER_TOP - 2 / 16;

export interface WorldSpec {
  /** Inclusive chunk ranges. */
  cx0: number;
  cx1: number;
  cz0: number;
  cz1: number;
  /** Stone below this y (exclusive). */
  floorTop?: number;
  /** Water from floorTop up to this y (exclusive); 0 = dry land. */
  waterTop?: number;
}

export function makeWorld(spec: WorldSpec): World {
  const world = new World(1);
  const floorTop = spec.floorTop ?? FLOOR_TOP;
  const waterTop = spec.waterTop ?? WATER_TOP;
  const stone = makeCell(B.STONE);
  const water = makeCell(B.WATER);
  for (let cx = spec.cx0; cx <= spec.cx1; cx++) {
    for (let cz = spec.cz0; cz <= spec.cz1; cz++) {
      const ch = new Chunk(cx, cz);
      for (let y = 0; y < Math.max(floorTop, waterTop); y++) {
        const cell = y < floorTop ? stone : water;
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) ch.set(x, y, z, cell);
      }
      world.addChunk(ch);
    }
  }
  return world;
}

/** Standard sea: chunks -3..2 on both axes (x, z in [-48, 47]). */
export function makeSea(): World {
  return makeWorld({ cx0: -3, cx1: 2, cz0: -3, cz1: 2 });
}

/** Fill an inclusive box of WORLD cells (chunks must exist). */
export function fillWorld(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  const cell = makeCell(id);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) world.setCell(x, y, z, cell);
}

export interface Drop {
  x: number;
  y: number;
  z: number;
  item: number;
  count: number;
}

export class FakeHost implements StructureHost {
  readonly world: World;
  readonly worldGlue = new GlueStore();
  readonly rng = new Rng(7);
  creative = false;
  readonly drops: Drop[] = [];
  constructor(world: World) {
    this.world = world;
  }
  spawnDrop(x: number, y: number, z: number, item: number, count: number): void {
    this.drops.push({ x, y, z, item, count });
  }
  blockUpdate(): void {}
  releaseRiders(): void {}
}

export function setup(world: World, opts?: DynamicsOptions) {
  const host = new FakeHost(world);
  const dyn = createShipDynamics(host, opts);
  return { host, dyn };
}

/** A ship whose local coordinates equal the world cells it was "assembled" from (identity pose). */
export function newShip(world: World, id: number): Ship {
  const s = new Ship(id, world);
  return s;
}

/** Fill an inclusive box of ship cells. `hollow`: only floor + walls (open top). */
export function shipBox(
  ship: Ship,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  id: number,
  hollow = false,
): void {
  const cell = makeCell(id);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (hollow && y > y0 && x > x0 && x < x1 && z > z0 && z < z1) continue;
        ship.grid.setCell(x, y, z, cell);
      }
    }
  }
}

/** Place a helm facing `facing` at a ship cell. */
export function addHelm(ship: Ship, x: number, y: number, z: number, facing: Dir): void {
  ship.grid.setCell(x, y, z, makeCell(B.HELM, facingState(facing)));
}

/** Finish building: identity pose (position == pivot), then refresh (pivot -> COM). */
export function launch(ship: Ship, dyn: { refresh(s: Ship): void }): Ship {
  const g = ship.grid;
  g.setPoseImmediate(g.pivot, quat());
  dyn.refresh(ship);
  return ship;
}

/** A plank boat: floor + 1-high rim (open hold), helm facing `facing` on the floor near the stern. */
export function plankBoat(world: World, id: number, x0: number, y0: number, z0: number, w: number, d: number, facing: Dir = 5): Ship {
  const s = newShip(world, id);
  shipBox(s, x0, y0, z0, x0 + w - 1, y0 + 1, z0 + d - 1, B.PLANKS_OAK, true);
  addHelm(s, x0 + (w >> 1), y0 + 1, z0 + d - 2, facing);
  return s;
}

/**
 * A big closed plank hull (sealed hold) of len (z) x wid (x) x hgt, bow toward -Z, with decks
 * every other level and bulkheads every third row until `target` cells.
 */
export function bigShip(world: World, id: number, len: number, wid: number, hgt: number, target: number, y0: number, z0: number): Ship {
  const s = new Ship(id, world);
  const x0 = -(wid >> 1);
  const c = makeCell(B.PLANKS_OAK);
  for (let y = 0; y < hgt; y++) {
    for (let z = 0; z < len; z++) {
      for (let x = 0; x < wid; x++) {
        const shell = y === 0 || y === hgt - 1 || x === 0 || x === wid - 1 || z === 0 || z === len - 1;
        if (shell) s.grid.setCell(x0 + x, y0 + y, z0 + z, c);
      }
    }
  }
  for (let y = 2; y < hgt - 1 && s.grid.count < target; y += 2) {
    for (let z = 1; z < len - 1 && s.grid.count < target; z++) {
      for (let x = 1; x < wid - 1 && s.grid.count < target; x++) s.grid.setCell(x0 + x, y0 + y, z0 + z, c);
    }
  }
  for (let z = 1; z < len - 1 && s.grid.count < target; z += 3) {
    for (let y = 1; y < hgt - 1 && s.grid.count < target; y++) {
      for (let x = 1; x < wid - 1 && s.grid.count < target; x++) s.grid.setCell(x0 + x, y0 + y, z0 + z, c);
    }
  }
  addHelm(s, 0, y0 + hgt, z0 + len - 2, 5);
  return s;
}

// ------------------------------------------------------------------ rotors

/**
 * A rotor mounted on the world, spinning about `axis` through the centre of cell (hx,hy,hz).
 * `cells` lists world cells (identity pose at assembly).
 */
export function newRotor(world: World, id: number, hx: number, hy: number, hz: number, axis: Dir, cells: ReadonlyArray<[number, number, number]>, id2 = B.CANVAS): Rotor {
  const r = new Rotor(id, world);
  r.axis = axis;
  r.bearingX = hx - DIR_X[axis]!;
  r.bearingY = hy - DIR_Y[axis]!;
  r.bearingZ = hz - DIR_Z[axis]!;
  const g = r.grid;
  g.pivot.x = hx + 0.5;
  g.pivot.y = hy + 0.5;
  g.pivot.z = hz + 0.5;
  for (const [x, y, z] of cells) g.setCell(x, y, z, makeCell(id2));
  g.setPoseImmediate(g.pivot, quat());
  return r;
}

/** Spin a rotor by hand: snapshot, advance angle by speed*dt, set rotation and angular velocity. */
export function spinRotor(r: Rotor, speed: number): void {
  r.grid.snapshotPose();
  r.angularSpeed = speed;
  r.angle += speed * TICK_DT;
  const u = vec3(DIR_X[r.axis]!, DIR_Y[r.axis]!, DIR_Z[r.axis]!);
  const spin = qfromAxisAngle(u, r.angle);
  qmul(r.baseRotation, spin, r.grid.rotation);
  const w = qrotate(r.baseRotation, u);
  r.grid.angularVelocity.x = w.x * speed;
  r.grid.angularVelocity.y = w.y * speed;
  r.grid.angularVelocity.z = w.z * speed;
}

// ------------------------------------------------------------------ driving

export interface Stepper {
  step(ships: readonly Ship[], rotors: readonly Rotor[]): void;
}

/** One tick as the manager would run it (ship poses snapshotted, rotors advanced first). */
export function tick(dyn: Stepper, ships: readonly Ship[], rotors: readonly Rotor[] = [], rotorSpeed = 0): void {
  for (const s of ships) s.grid.snapshotPose();
  for (const r of rotors) spinRotor(r, rotorSpeed);
  dyn.step(ships, rotors);
}

export function run(dyn: Stepper, ships: readonly Ship[], ticks: number, each?: (t: number) => void): void {
  for (let t = 0; t < ticks; t++) {
    tick(dyn, ships);
    each?.(t);
  }
}

// ------------------------------------------------------------------ measurements

/** World y of the bottom face of local cell layer `ly` at local (x, z) (any rotation). */
export function worldOf(ship: Ship, x: number, y: number, z: number): Vec3 {
  return ship.grid.toWorld(vec3(x, y, z));
}

export function speed(ship: Ship): number {
  const v = ship.grid.linearVelocity;
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** Kinetic energy 1/2 m v^2 + 1/2 w^T I w (I from the inverse inertia). */
export function kineticEnergy(ship: Ship): number {
  const g = ship.grid;
  const v = g.linearVelocity;
  const w = g.angularVelocity;
  const inv = ship.invInertiaLocal;
  const Il = invert3(inv);
  const R = qtoMat3(g.rotation);
  // w_local = R^T w
  const lx = R[0]! * w.x + R[3]! * w.y + R[6]! * w.z;
  const ly = R[1]! * w.x + R[4]! * w.y + R[7]! * w.z;
  const lz = R[2]! * w.x + R[5]! * w.y + R[8]! * w.z;
  const ix = Il[0]! * lx + Il[1]! * ly + Il[2]! * lz;
  const iy = Il[3]! * lx + Il[4]! * ly + Il[5]! * lz;
  const iz = Il[6]! * lx + Il[7]! * ly + Il[8]! * lz;
  return 0.5 * ship.mass * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * (lx * ix + ly * iy + lz * iz);
}

/**
 * Mechanical energy: kinetic + gravity + buoyancy potential. Buoyancy on a displacing cell is
 * rho g frac(y) with frac(y) = clamp(s + 0.5 - y, 0, 1) for a column whose surface is at s, so
 * its potential is rho g G(y) with G = 0 / u^2/2 / u - 1/2 for u = s + 0.5 - y <= 0 / < 1 / >= 1.
 * `surfaceAt(x, z)` gives the water surface of a world column (-Infinity = no water).
 * With the throttle off, nothing but contacts, drag and damping act on top of these forces,
 * so this must never increase.
 */
export function mechanicalEnergy(ship: Ship, surfaceAt: (x: number, z: number) => number, g = 9.81): number {
  const hull = ship.hull!;
  let ub = 0;
  const p = vec3();
  for (let y = hull.oy; y < hull.oy + hull.sy; y++) {
    for (let z = hull.oz; z < hull.oz + hull.sz; z++) {
      for (let x = hull.ox; x < hull.ox + hull.sx; x++) {
        if (!displacesWater(hull, x, y, z)) continue;
        ship.grid.toWorld(vec3(x + 0.5, y + 0.5, z + 0.5), p);
        const s = surfaceAt(Math.floor(p.x), Math.floor(p.z));
        const u = s + 0.5 - p.y;
        ub += u <= 0 ? 0 : u < 1 ? (u * u) / 2 : u - 0.5;
      }
    }
  }
  return kineticEnergy(ship) + ship.mass * g * ship.grid.position.y + g * ub;
}

/** Surface of the highest water run of a world column (or -Infinity). */
export function columnSurface(world: World): (x: number, z: number) => number {
  return (x, z) => {
    for (let y = 127; y >= 0; y--) if ((world.getCell(x, y, z) & ID_MASK) === B.WATER) return y + 1 - 2 / 16;
    return -Infinity;
  };
}

function invert3(m: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m) as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const Bc = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * Bc + c * C;
  const s = 1 / det;
  return Float64Array.from([
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    Bc * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ]);
}

/** Tilt of the ship's local +Y from world +Y, radians. */
export function tilt(ship: Ship): number {
  const up = qrotate(ship.grid.rotation, vec3(0, 1, 0));
  return Math.acos(Math.max(-1, Math.min(1, up.y)));
}

/** Points sampled densely on the hard hull cells: all corners, edge midpoints and face centres. */
export function hullSamplePoints(ship: Ship): Vec3[] {
  const out: Vec3[] = [];
  const seen = new Set<string>();
  ship.grid.forEachCell((x, y, z, cell) => {
    if (SOLID[cell & ID_MASK] !== 1) return;
    for (let i = 0; i <= 2; i++) {
      for (let j = 0; j <= 2; j++) {
        for (let k = 0; k <= 2; k++) {
          if (i === 1 && j === 1 && k === 1) continue;
          const key = `${2 * x + i},${2 * y + j},${2 * z + k}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(vec3(x + i / 2, y + j / 2, z + k / 2));
        }
      }
    }
  });
  return out;
}

/**
 * Depth of point p inside hard cells: the distance to the nearest non-hard cell among the
 * 26 neighbours of the cell containing it (1 when they are all hard, i.e. "deep"). This is the
 * true distance to free space for overlaps below one cell, also in concave corners.
 */
function depthIn(solid: (x: number, y: number, z: number) => boolean, px: number, py: number, pz: number): number {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  if (!solid(cx, cy, cz)) return 0;
  let best = 1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx | dy | dz) === 0 || solid(cx + dx, cy + dy, cz + dz)) continue;
        const ex = dx < 0 ? px - cx : dx > 0 ? cx + 1 - px : 0;
        const ey = dy < 0 ? py - cy : dy > 0 ? cy + 1 - py : 0;
        const ez = dz < 0 ? pz - cz : dz > 0 ? cz + 1 - pz : 0;
        best = Math.min(best, Math.sqrt(ex * ex + ey * ey + ez * ez));
      }
    }
  }
  return best;
}

/** Deepest penetration of the hull's sample points into hard world cells (blocks). */
export function terrainPenetration(world: World, ship: Ship, pts = hullSamplePoints(ship)): number {
  let worst = 0;
  const w = vec3();
  const solid = (x: number, y: number, z: number) => SOLID[world.getCell(x, y, z) & ID_MASK] === 1;
  for (const p of pts) {
    ship.grid.toWorld(p, w);
    worst = Math.max(worst, depthIn(solid, w.x, w.y, w.z));
  }
  return worst;
}

/** Deepest penetration of a set of world points (e.g. post corners) into the hull's hard cells. */
export function pointsIntoHull(ship: Ship, worldPts: readonly Vec3[]): number {
  let worst = 0;
  const l = vec3();
  const solid = (x: number, y: number, z: number) => SOLID[ship.grid.getCell(x, y, z) & ID_MASK] === 1;
  for (const p of worldPts) {
    ship.grid.toLocal(p, l);
    worst = Math.max(worst, depthIn(solid, l.x, l.y, l.z));
  }
  return worst;
}

/** Min / max of world coordinates over the hull sample points. */
export function hullExtent(ship: Ship, pts = hullSamplePoints(ship)) {
  const e = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const w = vec3();
  for (const p of pts) {
    ship.grid.toWorld(p, w);
    e.minX = Math.min(e.minX, w.x);
    e.minY = Math.min(e.minY, w.y);
    e.minZ = Math.min(e.minZ, w.z);
    e.maxX = Math.max(e.maxX, w.x);
    e.maxY = Math.max(e.maxY, w.y);
    e.maxZ = Math.max(e.maxZ, w.z);
  }
  return e;
}

export function finite(ship: Ship): boolean {
  const g = ship.grid;
  const vals = [
    g.position.x,
    g.position.y,
    g.position.z,
    g.rotation.x,
    g.rotation.y,
    g.rotation.z,
    g.rotation.w,
    g.linearVelocity.x,
    g.linearVelocity.y,
    g.linearVelocity.z,
    g.angularVelocity.x,
    g.angularVelocity.y,
    g.angularVelocity.z,
  ];
  return vals.every((v) => Number.isFinite(v));
}

/** Rotation by `angle` about a unit axis, applied to a ship's current rotation (pre-multiplied). */
export function rotateShip(ship: Ship, axis: Vec3, angle: number): void {
  const q: Quat = qfromAxisAngle(axis, angle);
  const r = qmul(q, ship.grid.rotation);
  ship.grid.setPoseImmediate(ship.grid.position, r);
}

export function chunkOf(x: number): number {
  return x >> CHUNK_SHIFT;
}

/** Wrap an angle to (-PI, PI]. */
export function wrap(a: number): number {
  const t = Math.PI * 2;
  a %= t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}
