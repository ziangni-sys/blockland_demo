/**
 * Explosions (docs/DESIGN.md "爆炸会破坏结构体的格子，但只推动物理结构体"; ACCEPTANCE 11, 13;
 * LESSONS "炸到船上的轴承时叶片幸存，或者风车整个消失").
 *
 * One blast, in this order:
 *  1. SHOCK WAVE (read only). RAY_COUNT rays leave the centre toward the surface of a cube, each
 *     with a random strength power * [0.7, 1.3) drawn from sim.rng (the irregular edge, fully
 *     deterministic). A ray walks in STEP increments; at every step it pays for what its sample
 *     point is in — in the world and in every structure in reach at that point, in the
 *     structure's own local space — (blastResistance + 0.3) * 0.3, plus ATTENUATION for the
 *     distance. What the point is in is the PART filling the octant of the cell the point lies
 *     in (docs/SHAPES.md section 9.4): an empty octant of a partial cell costs nothing, like air;
 *     a full block fills every octant, so it costs what it always did. Every octant a ray still
 *     has strength in, and whose part a blast can remove, is marked. Resistant blocks shadow what
 *     lies behind them; liquids (infinite resistance) stop rays dead, except world liquid
 *     displaced by a hull (the point is in a hard octant of a ship or in its dry hold), which the
 *     hull keeps out.
 *  2. DESTRUCTION, inside structures.beginBatch(): the marked world cells, then the marked cells
 *     of each structure, in the order each cell was first marked. In a cell, every part whose
 *     octants meet the marked octants is removed (first part, then second), and the rest is
 *     written back with one setCell flagged SET_EXPLOSION. Explosive blocks become primed blast
 *     crates with a short random fuse (chain reactions); when the world's drops are on
 *     (WorldRules.dropsEnabled) each other removed part drops its item with chance 1/power, one
 *     draw from sim.rng per part. In a world of full blocks every cell has one part, so the
 *     marks, their order and the random sequence are exactly those of the whole-cell blast, with
 *     one exception (docs/SHAPES.md 19.8): a soft whole-cell block (a torch, a flower) standing in
 *     a ship's dry hold no longer stops a ray in the world water refilled there, since the dry
 *     hold is asked whatever the ship's cell holds (it used to be asked only in empty cells).
 *  3. structures.endBatch(): rotors whose bearing was destroyed blockify now — after the wave
 *     has gone through every structure, so surviving blades land where they should — and
 *     emptied ships are removed (one that still carries rotor remains survives).
 *  4. PUSH: surviving ships get an impulse summed over their cells, a partial cell in proportion
 *     to its volume (rotors are never pushed);
 *     entities within 2 * power take damage scaled by distance and line-of-sight exposure —
 *     players by their own mode (EntityManager.damage), rabbits only in a survival world
 *     (WorldRules.defaultMode) — and are knocked back (item drops are only pushed).
 *  5. The 'explosion' event; queued block updates (sand over the crater, torches) run.
 */
import { AIR, CELL_MULTI_BIT, FULL_LIMIT, HOLES_SHIFT, ID_MASK, PART_MASK, partHoles } from '../blocks/cell';
import { BLOCKS, LIQUID, SOLID } from '../blocks/registry';
import { canonCell, volume8 } from '../blocks/shapes';
import { vec3, type Vec3 } from '../core/math';
import { Player, type Entity } from '../entities/entity';
import { CellSet } from '../structures/collect';
import { isDryHalf, type HullInfo } from '../structures/hull';
import { Ship, type Structure } from '../structures/structure';
import { SET_EXPLOSION, type VoxelGrid } from '../voxel/grid';
import { raycastGrids, type CellPredicate } from '../voxel/raycast';
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

/** Strength a ray pays for standing in a part (AIR: an empty octant; Infinity stops it). */
function partCost(part: number): number {
  const id = part & ID_MASK;
  if (id === AIR) return 0;
  const def = BLOCKS[id];
  return def === undefined ? Infinity : def.blastResistance;
}

/** Can a blast remove this part? (finite resistance, not air, not liquid, breakable) */
function destructible(part: number): boolean {
  const id = part & ID_MASK;
  if (id === AIR || LIQUID[id] !== 0) return false;
  const def = BLOCKS[id];
  return def !== undefined && !def.unbreakable && def.blastResistance < Infinity;
}

/**
 * The part of the cell whose value is `c` (>= FULL_LIMIT: it has holes or a second part) that
 * fills `octant`, or AIR when the octant is empty. Reads the second part only for a two-part cell;
 * it never forms the packed value of a two-part cell (docs/SHAPES.md section 4.4: this runs at
 * ray steps). Values below FULL_LIMIT (air, full blocks) never come here: a full block's single
 * part fills every octant, so the caller uses the value itself.
 */
function partOf(grid: VoxelGrid, c: number, x: number, y: number, z: number, octant: number): number {
  if (((c >>> (HOLES_SHIFT + octant)) & 1) === 0) return c & PART_MASK;
  if (c >= CELL_MULTI_BIT) {
    const p2 = grid.getPart2(x, y, z);
    if (((p2 >>> (HOLES_SHIFT + octant)) & 1) === 0) return p2;
  }
  return AIR;
}

/**
 * The marks of one grid: the cells in the order they were first marked, and which octants of
 * each were marked (one set per octant, so no per-cell index is needed).
 */
class Marks {
  private readonly cells = new CellSet(64);
  private readonly octants: Array<CellSet | null> = [null, null, null, null, null, null, null, null];
  /** Marked cells in first-mark order, x,y,z triples. */
  readonly list: number[] = [];

  mark(x: number, y: number, z: number, octant: number): void {
    if (this.cells.add(x, y, z)) this.list.push(x, y, z);
    let set = this.octants[octant]!;
    if (set === null) this.octants[octant] = set = new CellSet(64);
    set.add(x, y, z);
  }

  /** The octants marked in cell (x, y, z), as a fill mask. */
  mask(x: number, y: number, z: number): number {
    let m = 0;
    for (let o = 0; o < 8; o++) if (this.octants[o]?.has(x, y, z) === true) m |= 1 << o;
    return m;
  }
}

/** A structure the shock wave can reach, with the octants marked in it. */
interface Target {
  readonly s: Structure;
  readonly grid: VoxelGrid;
  /** Hull analysis of a ship when current (dry hold keeps world water out of the hull). */
  readonly hull: HullInfo | null;
  readonly marks: Marks;
  /**
   * Part the current ray step's point is in (AIR for an empty octant), its cell and octant (0 for
   * a full block: its one part fills every octant).
   */
  part: number;
  lx: number;
  ly: number;
  lz: number;
  octant: number;
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
    out.push({ s, grid: s.grid, hull, marks: new Marks(), part: AIR, lx: 0, ly: 0, lz: 0, octant: 0 });
  }
  return out;
}

/** Phase 1: walk every ray, mark octants. Returns the marks of the world. */
function markCells(sim: Simulation, x: number, y: number, z: number, power: number, targets: Target[]): Marks {
  const world = sim.world;
  const rng = sim.rng;
  const marks = new Marks();
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
      // What the point is in, per grid. A value below FULL_LIMIT (air, a full block) is used as it
      // is: a full block's one part fills every octant, so its mark goes on octant 0, which the
      // removal treats like any other. Only a cell with holes or a second part has its octant
      // worked out (p - floor(p) >= 0.5 per axis, exact in floating point: the octant of
      // floor(2p)) and the part filling it selected. Written out in place on purpose: this runs
      // at every ray step, and a version that called helpers for the octant and the part at every
      // step made a blast near a ship cost about 1.5 times M1 in a world of full blocks.
      for (let t = 0; t < nt; t++) {
        const tg = targets[t]!;
        tg.grid.toLocal(p, l);
        const lx = Math.floor(l.x);
        const ly = Math.floor(l.y);
        const lz = Math.floor(l.z);
        let part = tg.grid.getCell(lx, ly, lz);
        let o = 0;
        if (part >= FULL_LIMIT) {
          o = (l.x - lx >= 0.5 ? 1 : 0) | (l.y - ly >= 0.5 ? 2 : 0) | (l.z - lz >= 0.5 ? 4 : 0);
          part = partOf(tg.grid, part, lx, ly, lz, o);
        }
        tg.part = part;
        // World liquid is kept out by the hull where the point is in a hard octant of a ship or
        // in its dry hold, whatever else the ship's cell holds (docs/SHAPES.md 19.8; for a ship
        // whose hull analysis is current, the same condition as sim/rays.ts displacedByHull; a
        // stale analysis counts as no dry hold here, and a rotor's hard octants count too).
        // The part filling the point's octant is hard exactly when solidAtHalf(grid, floor(2 *
        // local)) is; the dry hold is asked at those half-cell coordinates.
        if (part !== AIR) {
          tg.lx = lx;
          tg.ly = ly;
          tg.lz = lz;
          tg.octant = o;
          cost += partCost(part);
          if (SOLID[part & ID_MASK] === 1) displaced = true;
          else if (tg.hull !== null && isDryHalf(tg.hull, Math.floor(l.x * 2), Math.floor(l.y * 2), Math.floor(l.z * 2))) displaced = true;
        } else if (tg.hull !== null && isDryHalf(tg.hull, Math.floor(l.x * 2), Math.floor(l.y * 2), Math.floor(l.z * 2))) {
          displaced = true;
        }
      }
      let wp = world.getCell(wx, wy, wz);
      let wo = 0;
      if (wp >= FULL_LIMIT) {
        wo = (p.x - wx >= 0.5 ? 1 : 0) | (p.y - wy >= 0.5 ? 2 : 0) | (p.z - wz >= 0.5 ? 4 : 0);
        wp = partOf(world, wp, wx, wy, wz, wo);
      }
      // World liquid where a hull is (or in its dry hold) is kept out by the hull: not in the way.
      if (!(displaced && LIQUID[wp & ID_MASK] !== 0)) cost += partCost(wp);
      f -= (cost + 0.3) * 0.3;
      if (f > 0) {
        if (destructible(wp)) marks.mark(wx, wy, wz, wo);
        for (let t = 0; t < nt; t++) {
          const tg = targets[t]!;
          if (tg.part !== AIR && destructible(tg.part)) tg.marks.mark(tg.lx, tg.ly, tg.lz, tg.octant);
        }
      }
      p.x += dx * STEP;
      p.y += dy * STEP;
      p.z += dz * STEP;
      f -= ATTENUATION;
    }
  }
  return marks;
}

/** Phase 2: remove the marked parts (world first, then structures in creation order). */
function destroy(sim: Simulation, worldMarks: Marks, targets: Target[], power: number): void {
  const dropChance = Math.min(1, 1 / power);
  const tmp = vec3();
  removeMarked(sim, sim.world, worldMarks, dropChance, tmp);
  for (const tg of targets) {
    if (tg.s.removed) continue;
    removeMarked(sim, tg.grid, tg.marks, dropChance, tmp);
  }
}

/**
 * Remove the marked parts of one grid, cell by cell in first-mark order. Each cell is read again
 * here: it may have changed since it was marked (by a hook, or an earlier removal). A full block
 * (a value below FULL_LIMIT: one part filling every octant) meets any marked octant, so it goes
 * when a blast can destroy it, without looking at the marks: the M1 path, kept short because
 * nearly every marked cell is one.
 */
function removeMarked(sim: Simulation, grid: VoxelGrid, marks: Marks, dropChance: number, tmp: Vec3): void {
  const l = marks.list;
  for (let i = 0; i < l.length; i += 3) {
    const x = l[i]!;
    const y = l[i + 1]!;
    const z = l[i + 2]!;
    const cell = grid.getCell(x, y, z);
    if (cell < FULL_LIMIT) {
      if (destructible(cell) && grid.setCell(x, y, z, AIR, SET_EXPLOSION)) blastedPart(sim, grid, x, y, z, cell, dropChance, tmp);
    } else {
      removeParts(sim, grid, x, y, z, cell, marks.mask(x, y, z), dropChance, tmp);
    }
  }
}

/** Is `part` (0 = none) one the blast removes: it fills a marked octant and a blast can destroy it? */
function blasted(part: number, mask: number): boolean {
  return part !== AIR && (~partHoles(part) & mask) !== 0 && destructible(part);
}

/**
 * Remove every part of cell (x, y, z), whose value is `cell` (>= FULL_LIMIT: it has holes or a
 * second part), that fills one of the marked octants `mask` and that a blast can destroy, in one
 * setCell; then, first part before second, prime it (a blast crate) or let it drop.
 */
function removeParts(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, cell: number, mask: number, dropChance: number, tmp: Vec3): void {
  const p1 = cell & PART_MASK;
  const p2 = cell < CELL_MULTI_BIT ? AIR : grid.getPart2(x, y, z);
  const r1 = blasted(p1, mask);
  const r2 = blasted(p2, mask);
  if (!r1 && !r2) return;
  if (!grid.setCell(x, y, z, canonCell(r1 ? AIR : p1, r2 ? AIR : p2), SET_EXPLOSION)) return;
  if (r1) blastedPart(sim, grid, x, y, z, p1, dropChance, tmp);
  if (r2) blastedPart(sim, grid, x, y, z, p2, dropChance, tmp);
}

/** What becomes of a part the blast removed: a blast crate is primed, anything else may drop. */
function blastedPart(sim: Simulation, grid: VoxelGrid, x: number, y: number, z: number, part: number, dropChance: number, tmp: Vec3): void {
  const def = BLOCKS[part & ID_MASK]!;
  if (def.explosive) {
    // A blast crate cannot be cut (docs/SHAPES.md section 1.4): it is always the whole cell.
    tmp.x = x + 0.5;
    tmp.y = y + 0.5;
    tmp.z = z + 0.5;
    grid.toWorld(tmp, tmp);
    const fuse = sim.rng.int(CHAIN_FUSE_MIN, CHAIN_FUSE_MAX);
    const tnt = sim.entities.spawnTnt(tmp.x, tmp.y, tmp.z, fuse);
    tnt.setPosition(tmp.x, tmp.y - tnt.height * 0.5, tmp.z);
    return;
  }
  if (sim.rules.dropsEnabled && sim.rng.next() < dropChance) spawnBlockDrop(sim, grid, x, y, z, part, tmp);
}

/**
 * Phase 4a: every live ship in reach gets the impulses of its cells, applied at their
 * impact-weighted centre. A cell with holes or a second part counts with its volume, volume8 / 8
 * (docs/SHAPES.md section 9.4); a full block counts 1, models included (whose volume8 is 0), so a
 * ship of full blocks is pushed exactly as before.
 */
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
    g.forEachCell((x, y, z, packed) => {
      const share = packed < FULL_LIMIT ? 1 : volume8(packed) / 8;
      c.x = x + 0.5;
      c.y = y + 0.5;
      c.z = z + 0.5;
      g.toWorld(c, c);
      const dx = c.x - centre.x;
      const dy = c.y - centre.y;
      const dz = c.z - centre.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= radius) return;
      const impact = (1 - d / radius) * share;
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
    sim.entities.knock(e, dx * k, dy * k, dz * k);
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
