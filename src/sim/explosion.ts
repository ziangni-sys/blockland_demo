/**
 * Explosions (docs/DESIGN.md "爆炸会破坏结构体的格子，但只推动物理结构体"; ACCEPTANCE 11, 13;
 * LESSONS "炸到船上的轴承时叶片幸存，或者风车整个消失").
 *
 * One blast, in this order:
 *  1. SHOCK WAVE (read only). RAY_COUNT rays leave the centre toward the surface of a cube, each
 *     with a random strength power * [0.7, 1.3) drawn from sim.rng (the irregular edge, fully
 *     deterministic). A ray walks in STEP increments; at every step it pays for the cells it
 *     is in — the world cell and the cell of every structure in reach at that point, in the
 *     structure's own local space — (blastResistance + 0.3) * 0.3, plus ATTENUATION for the
 *     distance. Every cell a ray still has strength in is marked for destruction. Resistant
 *     blocks shadow what lies behind them; liquids (infinite resistance) stop rays dead, except
 *     world liquid displaced by a hull (inside a ship's hard cell or its dry hold), which the
 *     hull keeps out.
 *  2. DESTRUCTION, inside structures.beginBatch(): every marked world cell, then every marked
 *     structure cell, is set to AIR with SET_EXPLOSION. Explosive blocks become primed blast
 *     crates with a short random fuse (chain reactions); when the world's drops are on
 *     (WorldRules.dropsEnabled) a 1/power share of the other blocks drop their item.
 *  3. structures.endBatch(): rotors whose bearing was destroyed blockify now — after the wave
 *     has gone through every structure, so surviving blades land where they should — and
 *     emptied ships are removed (one that still carries rotor remains survives).
 *  4. PUSH: surviving ships get an impulse summed over their cells (rotors are never pushed);
 *     entities within 2 * power take damage scaled by distance and line-of-sight exposure —
 *     players by their own mode (EntityManager.damage), rabbits only in a survival world
 *     (WorldRules.defaultMode) — and are knocked back (item drops are only pushed).
 *  5. The 'explosion' event; queued block updates (sand over the crater, torches) run.
 */
import { AIR, ID_MASK } from '../blocks/cell';
import { BLOCKS, LIQUID, SOLID } from '../blocks/registry';
import { vec3, type Vec3 } from '../core/math';
import { Player, type Entity } from '../entities/entity';
import { CellSet } from '../structures/collect';
import { isDryCell, type HullInfo } from '../structures/hull';
import { Ship, type Structure } from '../structures/structure';
import { SET_EXPLOSION, type VoxelGrid } from '../voxel/grid';
import { raycastGrids, type CellPredicate } from '../voxel/raycast';
import { posKey } from '../voxel/world';
import { spawnBlockDrop } from './drops';
import type { Simulation } from './simulation';

/** Ray step length (blocks). */
export const STEP = 0.3;
/** Strength a ray loses per step just by travelling. */
export const ATTENUATION = 0.225;
/** Fuse range (ticks) of a blast crate set off by another blast. */
export const CHAIN_FUSE_MIN = 10;
export const CHAIN_FUSE_MAX = 30;
/** Entities within this many times the power are hurt and pushed. */
export const ENTITY_RADIUS_FACTOR = 2;
/** Knock-back speed (blocks/s) at full impact. */
export const KNOCKBACK_SPEED = 20;
/** Impulse (mass units * blocks/s) one ship cell receives at full impact. */
export const SHIP_CELL_IMPULSE = 2;

// Ray directions: unit vectors toward the surface points of a 16^3 lattice cube. Immutable
// lookup data, computed once (1352 rays).
const RAY_DIRS: Float64Array = (() => {
  const n = 16;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        if (i !== 0 && i !== n - 1 && j !== 0 && j !== n - 1 && k !== 0 && k !== n - 1) continue;
        const x = (i / (n - 1)) * 2 - 1;
        const y = (j / (n - 1)) * 2 - 1;
        const z = (k / (n - 1)) * 2 - 1;
        const l = Math.sqrt(x * x + y * y + z * z);
        out.push(x / l, y / l, z / l);
      }
    }
  }
  return Float64Array.from(out);
})();
export const RAY_COUNT = RAY_DIRS.length / 3;

/** Line-of-sight blockers for exposure: every HARD cell (the 'unloaded' sentinel included). */
const blocksSight: CellPredicate = (cell) => SOLID[cell & ID_MASK] === 1;

/** Strength a ray pays for standing in a cell (Infinity stops it). */
function cellCost(cell: number): number {
  const id = cell & ID_MASK;
  if (id === AIR) return 0;
  const def = BLOCKS[id];
  return def === undefined ? Infinity : def.blastResistance;
}

/** Can a blast remove this cell? (finite resistance, not air, not liquid, breakable) */
function destructible(cell: number): boolean {
  const id = cell & ID_MASK;
  if (id === AIR || LIQUID[id] !== 0) return false;
  const def = BLOCKS[id];
  return def !== undefined && !def.unbreakable && def.blastResistance < Infinity;
}

/** A structure the shock wave can reach, with the cells marked in it. */
interface Target {
  readonly s: Structure;
  readonly grid: VoxelGrid;
  /** Hull analysis of a ship when current (dry hold keeps world water out of the hull). */
  readonly hull: HullInfo | null;
  readonly marked: CellSet;
  /** Marked cells in discovery order, x,y,z triples. */
  readonly list: number[];
  /** Cell hit by the current ray step (or AIR), and its local coordinates. */
  cell: number;
  lx: number;
  ly: number;
  lz: number;
}

/**
 * A blast of `power` (TNT_POWER = 4 for a blast crate) centred at world point (x, y, z).
 * `source` is the entity that exploded, if any (already removed from the world).
 */
export function explode(sim: Simulation, x: number, y: number, z: number, power: number, source: Entity | null): void {
  void source;
  if (!(power > 0) || !Number.isFinite(power) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const structures = sim.structures;
  const targets = reachableStructures(sim, x, y, z, power);
  const worldMarked = markCells(sim, x, y, z, power, targets);

  const centre = vec3(x, y, z);
  structures.beginBatch();
  try {
    destroy(sim, worldMarked, targets, power);
  } finally {
    structures.endBatch();
  }
  pushShips(sim, centre, power);
  pushEntities(sim, centre, power);
  sim.events.emit({ type: 'explosion', x, y, z, power });
  sim.blocks.flush();
}

/** Structures whose cells may lie within the longest possible ray. */
function reachableStructures(sim: Simulation, x: number, y: number, z: number, power: number): Target[] {
  const reach = ((power * 1.3) / ATTENUATION) * STEP + 1;
  const out: Target[] = [];
  const c = vec3();
  for (const s of sim.structures.all()) {
    const b = s.grid.cellBounds();
    if (b === null) continue;
    c.x = (b.minX + b.maxX) * 0.5;
    c.y = (b.minY + b.maxY) * 0.5;
    c.z = (b.minZ + b.maxZ) * 0.5;
    s.grid.toWorld(c, c);
    const hx = (b.maxX - b.minX) * 0.5;
    const hy = (b.maxY - b.minY) * 0.5;
    const hz = (b.maxZ - b.minZ) * 0.5;
    const radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
    const dx = c.x - x;
    const dy = c.y - y;
    const dz = c.z - z;
    if (dx * dx + dy * dy + dz * dz > (radius + reach) * (radius + reach)) continue;
    let hull: HullInfo | null = null;
    if (s instanceof Ship && s.hull !== null && s.hull.version === s.grid.version) hull = s.hull;
    out.push({ s, grid: s.grid, hull, marked: new CellSet(64), list: [], cell: AIR, lx: 0, ly: 0, lz: 0 });
  }
  return out;
}

/** Phase 1: walk every ray, mark cells. Returns the marked world cells (x,y,z triples, discovery order). */
function markCells(sim: Simulation, x: number, y: number, z: number, power: number, targets: Target[]): number[] {
  const world = sim.world;
  const rng = sim.rng;
  const marked = new Set<number>();
  const list: number[] = [];
  const p = vec3();
  const l = vec3();
  const nt = targets.length;
  for (let r = 0; r < RAY_COUNT; r++) {
    const dx = RAY_DIRS[r * 3]!;
    const dy = RAY_DIRS[r * 3 + 1]!;
    const dz = RAY_DIRS[r * 3 + 2]!;
    let f = power * (0.7 + 0.6 * rng.next());
    p.x = x;
    p.y = y;
    p.z = z;
    while (f > 0) {
      const wx = Math.floor(p.x);
      const wy = Math.floor(p.y);
      const wz = Math.floor(p.z);
      let cost = 0;
      let displaced = false;
      for (let t = 0; t < nt; t++) {
        const tg = targets[t]!;
        tg.grid.toLocal(p, l);
        const lx = Math.floor(l.x);
        const ly = Math.floor(l.y);
        const lz = Math.floor(l.z);
        const c = tg.grid.getCell(lx, ly, lz);
        tg.cell = c;
        if (c !== AIR) {
          tg.lx = lx;
          tg.ly = ly;
          tg.lz = lz;
          cost += cellCost(c);
          if (SOLID[c & ID_MASK] === 1) displaced = true;
        } else if (tg.hull !== null && isDryCell(tg.hull, lx, ly, lz)) {
          displaced = true;
        }
      }
      const wc = world.getCell(wx, wy, wz);
      // World liquid where a hull is (or in its dry hold) is kept out by the hull: not in the way.
      if (!(displaced && LIQUID[wc & ID_MASK] !== 0)) cost += cellCost(wc);
      f -= (cost + 0.3) * 0.3;
      if (f > 0) {
        if (destructible(wc)) {
          const k = posKey(wx, wy, wz);
          if (!marked.has(k)) {
            marked.add(k);
            list.push(wx, wy, wz);
          }
        }
        for (let t = 0; t < nt; t++) {
          const tg = targets[t]!;
          if (tg.cell !== AIR && destructible(tg.cell) && tg.marked.add(tg.lx, tg.ly, tg.lz)) tg.list.push(tg.lx, tg.ly, tg.lz);
        }
      }
      p.x += dx * STEP;
      p.y += dy * STEP;
      p.z += dz * STEP;
      f -= ATTENUATION;
    }
  }
  return list;
}

/** Phase 2: remove every marked cell (world first, then structures in creation order). */
function destroy(sim: Simulation, worldList: number[], targets: Target[], power: number): void {
  const world = sim.world;
  const dropChance = Math.min(1, 1 / power);
  const tmp = vec3();
  for (let i = 0; i < worldList.length; i += 3) {
    const x = worldList[i]!;
    const y = worldList[i + 1]!;
    const z = worldList[i + 2]!;
    removeCell(sim, world, x, y, z, dropChance, tmp);
  }
  for (const tg of targets) {
    if (tg.s.removed) continue;
    const l = tg.list;
    for (let i = 0; i < l.length; i += 3) removeCell(sim, tg.grid, l[i]!, l[i + 1]!, l[i + 2]!, dropChance, tmp);
  }
}

function removeCell(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, dropChance: number, tmp: Vec3): void {
  const cell = grid.getCell(x, y, z);
  if (!destructible(cell)) return; // changed since it was marked (e.g. by a hook)
  if (!grid.setCell(x, y, z, AIR, SET_EXPLOSION)) return;
  const def = BLOCKS[cell & ID_MASK]!;
  if (def.explosive) {
    tmp.x = x + 0.5;
    tmp.y = y + 0.5;
    tmp.z = z + 0.5;
    grid.toWorld(tmp, tmp);
    const fuse = sim.rng.int(CHAIN_FUSE_MIN, CHAIN_FUSE_MAX);
    const tnt = sim.entities.spawnTnt(tmp.x, tmp.y, tmp.z, fuse);
    tnt.setPosition(tmp.x, tmp.y - tnt.height * 0.5, tmp.z);
    return;
  }
  if (sim.rules.dropsEnabled && sim.rng.next() < dropChance) spawnBlockDrop(sim, grid, x, y, z, cell, tmp);
}

/** Phase 4a: every live ship in reach gets the impulses of its cells, applied at their impact-weighted centre. */
function pushShips(sim: Simulation, centre: Vec3, power: number): void {
  const radius = power * ENTITY_RADIUS_FACTOR;
  const dyn = sim.dynamics;
  const c = vec3();
  const imp = vec3();
  const at = vec3();
  for (const ship of sim.structures.ships()) {
    if (ship.removed) continue;
    const g = ship.grid;
    const b = g.cellBounds();
    if (b === null) continue;
    c.x = (b.minX + b.maxX) * 0.5;
    c.y = (b.minY + b.maxY) * 0.5;
    c.z = (b.minZ + b.maxZ) * 0.5;
    g.toWorld(c, c);
    const hx = (b.maxX - b.minX) * 0.5;
    const hy = (b.maxY - b.minY) * 0.5;
    const hz = (b.maxZ - b.minZ) * 0.5;
    const r = Math.sqrt(hx * hx + hy * hy + hz * hz) + radius;
    if ((c.x - centre.x) ** 2 + (c.y - centre.y) ** 2 + (c.z - centre.z) ** 2 > r * r) continue;
    imp.x = imp.y = imp.z = 0;
    at.x = at.y = at.z = 0;
    let weight = 0;
    g.forEachCell((x, y, z) => {
      c.x = x + 0.5;
      c.y = y + 0.5;
      c.z = z + 0.5;
      g.toWorld(c, c);
      const dx = c.x - centre.x;
      const dy = c.y - centre.y;
      const dz = c.z - centre.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= radius) return;
      const impact = 1 - d / radius;
      const s = (impact * SHIP_CELL_IMPULSE) / Math.max(d, 1e-6);
      if (d > 1e-6) {
        imp.x += dx * s;
        imp.y += dy * s;
        imp.z += dz * s;
      } else {
        imp.y += impact * SHIP_CELL_IMPULSE;
      }
      at.x += c.x * impact;
      at.y += c.y * impact;
      at.z += c.z * impact;
      weight += impact;
    });
    if (weight <= 0) continue;
    at.x /= weight;
    at.y /= weight;
    at.z /= weight;
    dyn.applyImpulse(ship, at, imp);
  }
}

/** Phase 4b: damage and knock-back of every entity in reach. */
function pushEntities(sim: Simulation, centre: Vec3, power: number): void {
  const radius = power * ENTITY_RADIUS_FACTOR;
  const harmsCreatures = sim.rules.defaultMode === 'survival';
  const grids = sim.grids();
  // Damage can remove entities (rabbits), which mutates the live list: iterate a copy.
  const list = sim.entities.all().slice();
  for (const e of list) {
    if (e.removed) continue;
    const cx = e.pos.x;
    const cy = e.pos.y + e.height * 0.5;
    const cz = e.pos.z;
    let dx = cx - centre.x;
    let dy = cy - centre.y;
    let dz = cz - centre.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= radius) continue;
    const impact = (1 - d / radius) * exposure(grids, e, centre);
    if (impact <= 0) continue;
    if (d > 1e-6) {
      dx /= d;
      dy /= d;
      dz /= d;
    } else {
      dx = 0;
      dy = 1;
      dz = 0;
    }
    if (e.kind === 'player' || (e.kind === 'rabbit' && harmsCreatures)) {
      // Classic falloff: quadratic in impact, scaled with the blast radius.
      const damage = Math.floor(((impact * impact + impact) / 2) * 7 * radius + 1);
      sim.entities.damage(e, damage, 'explosion');
      if (e.removed) continue;
    }
    if (e instanceof Player && e.dead) continue;
    const k = impact * KNOCKBACK_SPEED;
    e.vel.x += dx * k;
    e.vel.y += dy * k;
    e.vel.z += dz * k;
  }
}

/**
 * Share (0..1) of sample points of the body that see the blast centre: the 8 corners of the
 * body box pulled 10% inward. A HARD cell of any grid on the segment blocks a point.
 */
function exposure(grids: readonly VoxelGrid[], e: Entity, centre: Vec3): number {
  const b = e.box();
  const ix = (b.maxX - b.minX) * 0.1;
  const iy = (b.maxY - b.minY) * 0.1;
  const iz = (b.maxZ - b.minZ) * 0.1;
  const o = vec3();
  const dir = vec3();
  let seen = 0;
  for (let k = 0; k < 8; k++) {
    o.x = k & 1 ? b.maxX - ix : b.minX + ix;
    o.y = k & 2 ? b.maxY - iy : b.minY + iy;
    o.z = k & 4 ? b.maxZ - iz : b.minZ + iz;
    dir.x = centre.x - o.x;
    dir.y = centre.y - o.y;
    dir.z = centre.z - o.z;
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (len < 1e-6) {
      seen++;
      continue;
    }
    dir.x /= len;
    dir.y /= len;
    dir.z /= len;
    if (raycastGrids(grids, o, dir, len, blocksSight) === null) seen++;
  }
  return seen / 8;
}
