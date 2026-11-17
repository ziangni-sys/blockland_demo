/**
 * Headless test bench for the entities module: a hand-built world, hand-built structures
 * (Ships / Rotors constructed directly, no structure manager) and a tiny fake EntityHost.
 *
 * Each Bench.tick() runs the simulation's order: every structure snapshotPose() + scripted
 * motion, then entities.syncCarried(), then entities.update().
 */
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { CHUNK_SHIFT, TICK_DT } from '../../src/core/constants';
import type { Dir } from '../../src/core/dirs';
import { aabb, qfromAxisAngle, qfromYaw, qmul, quat, vec3, type AABB, type Quat, type Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import type { Entity } from '../../src/entities/entity';
import type { EntityEvent, EntityHost } from '../../src/entities/host';
import { EntityManager } from '../../src/entities/manager';
import { analyzeHull } from '../../src/structures/hull';
import { Rotor, Ship, type Structure } from '../../src/structures/structure';
import { Chunk } from '../../src/voxel/chunk';
import { boxOverlapsSolid } from '../../src/voxel/shape';
import { World } from '../../src/voxel/world';

export interface Blast {
  x: number;
  y: number;
  z: number;
  power: number;
  source: Entity | null;
}

export class TestHost implements EntityHost {
  readonly world: World;
  readonly rng: Rng;
  /** The world rule the entities module asks for (rabbit crush limit). */
  harmsCreatures = true;
  readonly list: Structure[] = [];
  readonly events: EntityEvent[] = [];
  readonly blasts: Blast[] = [];

  constructor(world: World, seed = 12345) {
    this.world = world;
    this.rng = new Rng(seed);
  }
  structures(): readonly Structure[] {
    return this.list;
  }
  structure(id: number): Structure | undefined {
    for (const s of this.list) if (s.id === id && !s.removed) return s;
    return undefined;
  }
  explode(x: number, y: number, z: number, power: number, source: Entity | null): void {
    this.blasts.push({ x, y, z, power, source });
  }
  emit(ev: EntityEvent): void {
    this.events.push(ev);
  }
  count(type: EntityEvent['type'], entity?: Entity): number {
    let n = 0;
    for (const e of this.events) if (e.type === type && (entity === undefined || e.entity === entity)) n++;
    return n;
  }
}

/** A world with empty (air) chunks loaded over [x0, x1] x [z0, z1] (world coordinates, inclusive). */
export function makeWorld(x0 = -40, z0 = -40, x1 = 39, z1 = 39, seed = 7): World {
  const world = new World(seed);
  for (let cx = x0 >> CHUNK_SHIFT; cx <= x1 >> CHUNK_SHIFT; cx++) {
    for (let cz = z0 >> CHUNK_SHIFT; cz <= z1 >> CHUNK_SHIFT; cz++) world.addChunk(new Chunk(cx, cz));
  }
  return world;
}

/** Fill an inclusive box of world cells with a block id (0 = air) or a full cell value. */
export function fill(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, cell: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) world.setCell(x, y, z, cell);
}

export type Motion = (tick: number) => void;

export class Bench {
  readonly world: World;
  readonly host: TestHost;
  readonly entities: EntityManager;
  readonly motions: Motion[] = [];
  ticks = 0;
  /** Called after every tick (assertions that must hold every tick). */
  readonly checks: Array<(tick: number) => void> = [];

  constructor(world: World = makeWorld(), seed = 12345) {
    this.world = world;
    this.host = new TestHost(world, seed);
    this.entities = new EntityManager(this.host);
  }

  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.ticks++;
      this.world.time++;
      for (const s of this.host.list) s.grid.snapshotPose();
      for (const m of this.motions) m(this.ticks);
      this.entities.syncCarried();
      this.entities.update();
      for (const c of this.checks) c(this.ticks);
    }
  }

  /** Tick until `pred` holds (or `max` ticks); returns the number of ticks run. */
  tickUntil(pred: () => boolean, max = 400): number {
    for (let i = 0; i < max; i++) {
      if (pred()) return i;
      this.tick();
    }
    return max;
  }

  /** A ship built from `cells` ([x, y, z, blockId] in its local == initial world coordinates). */
  ship(id: number, cells: Array<[number, number, number, number]>, pivot?: Vec3): Ship {
    const s = new Ship(id, this.world);
    for (const [x, y, z, b] of cells) s.grid.setCell(x, y, z, makeCell(b));
    s.hull = analyzeHull(s.grid);
    const c = pivot ?? s.hull!.com;
    s.grid.pivot.x = c.x;
    s.grid.pivot.y = c.y;
    s.grid.pivot.z = c.z;
    s.grid.setPoseImmediate(vec3(c.x, c.y, c.z), quat());
    s.mass = s.hull!.mass;
    this.host.list.push(s);
    return s;
  }

  /**
   * A rotor mounted on `parent` (null = the world). Its cells are given in the parent's local
   * coordinates (== its own local coordinates right after assembly); `hub` is the hub cell.
   */
  rotor(id: number, parent: Ship | null, hub: [number, number, number], axis: Dir, cells: Array<[number, number, number, number]>): Rotor {
    const r = new Rotor(id, parent ? parent.grid : this.world);
    r.parent = parent;
    if (parent) parent.children.push(r);
    r.axis = axis;
    for (const [x, y, z, b] of cells) r.grid.setCell(x, y, z, makeCell(b));
    const p = vec3(hub[0] + 0.5, hub[1] + 0.5, hub[2] + 0.5);
    r.grid.pivot.x = p.x;
    r.grid.pivot.y = p.y;
    r.grid.pivot.z = p.z;
    r.grid.setPoseImmediate(p, quat());
    this.host.list.push(r);
    return r;
  }

  /** Drive a structure each tick: `pose(t)` returns its parent-space position and rotation at tick t. */
  drive(s: Structure, pose: (t: number) => { p: Vec3; q: Quat }): void {
    this.motions.push((t) => {
      const { p, q } = pose(t);
      s.grid.position.x = p.x;
      s.grid.position.y = p.y;
      s.grid.position.z = p.z;
      s.grid.rotation.x = q.x;
      s.grid.rotation.y = q.y;
      s.grid.rotation.z = q.z;
      s.grid.rotation.w = q.w;
    });
  }

  /** Spin a rotor about its axis at `omega` rad/s (rotation = axis-angle(angle)). */
  spin(r: Rotor, omega: number, axisVec: Vec3, start = 0): void {
    const base = r.grid.position;
    const p0 = vec3(base.x, base.y, base.z);
    this.drive(r, (t) => {
      r.angle = start + omega * t * TICK_DT;
      return { p: p0, q: qfromAxisAngle(axisVec, r.angle) };
    });
  }
}

/** Ship yawed by `yaw` (radians) about its pivot, at pivot position p. */
export function yawPose(p: Vec3, yaw: number): { p: Vec3; q: Quat } {
  return { p, q: qfromYaw(yaw) };
}

export function rotateAbout(q1: Quat, q2: Quat): Quat {
  return qmul(q1, q2);
}

/** Rectangular deck of one block id at local y, x0..x1, z0..z1 inclusive. */
export function deck(x0: number, z0: number, x1: number, z1: number, y: number, id: number = B.PLANKS_OAK): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, y, z, id]);
  return out;
}

export function boxOf(e: Entity): AABB {
  return e.box(aabb());
}

/** True when the entity's body overlaps a solid world block. */
export function inWorld(world: World, e: Entity): boolean {
  return boxOverlapsSolid(world, e.box(aabb()));
}

export function inStructure(s: Structure, e: Entity): boolean {
  return boxOverlapsSolid(s.grid, e.box(aabb()));
}

export { B, makeCell, vec3, quat, qfromYaw, qfromAxisAngle, TICK_DT };
