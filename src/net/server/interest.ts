/**
 * Interest (docs/NETCODE.md sections 6 to 8): which chunk columns, structures and entities a
 * client is told about.
 *
 * CHUNKS. The subscription circle of radius r about the chunk under the player's feet, the
 * ChunkManager's test: dx^2 + dz^2 <= r^2 + r. A subscribed column is let go when it leaves the
 * circle of r + 2 (the hysteresis of ChunkManager.unloadMargin).
 *
 * STRUCTURES. A bounding sphere per root structure (a ship, or a rotor mounted on the world): its
 * centre is the root's pivot in the world (a world rotor's axis centre), its radius the largest
 * of: the distance from the pivot to the farthest corner of the cell box; for a world rotor its
 * swept sphere; for every rotor mounted on it, the distance of that rotor's pivot from the root's
 * pivot plus that rotor's swept sphere (structures/rotor.ts measureSweep, sweepSphereRadius).
 * The sphere enters a client's interest when its horizontal distance from the centre of the
 * player's chunk minus its radius is at most (r + 4) * 16 blocks and leaves it beyond
 * (r + 6) * 16; a rotor mounted on a ship comes and goes with the ship.
 *
 * ENTITIES are decided by the Replicator from what the client has been given (a carried entity
 * with its carrier's spawn, a free one with the snapshot of the column under it).
 */
import { CHUNK_SHIFT, CHUNK_SIZE } from '../../core/constants';
import { measureSweep, sweepSphereRadius, type RotorSweep } from '../../structures/rotor';
import { Rotor, type Structure } from '../../structures/structure';

/** Column offset (dx, dz) from the centre column inside the circle of radius r (ChunkManager's test). */
export function inChunkCircle(dx: number, dz: number, r: number): boolean {
  return dx * dx + dz * dz <= r * r + r;
}

/** Chunk coordinate of a world coordinate. */
export function chunkOf(v: number): number {
  return Math.floor(v) >> CHUNK_SHIFT;
}

/**
 * The column offsets of the circle of radius r, nearest first (ties by dx, then dz), as
 * (dx, dz) pairs. The same for every centre: callers cache it per radius.
 */
export function circleOffsets(r: number): Int32Array {
  const list: Array<[number, number, number]> = [];
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) if (inChunkCircle(dx, dz, r)) list.push([dx, dz, dx * dx + dz * dz]);
  }
  list.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  const out = new Int32Array(list.length * 2);
  list.forEach(([dx, dz], i) => {
    out[i * 2] = dx;
    out[i * 2 + 1] = dz;
  });
  return out;
}

/** Sphere of a root structure: world centre (horizontal) and radius, blocks. */
export interface StructureSphere {
  readonly root: Structure;
  x: number;
  z: number;
  radius: number;
}

/** The root of a structure: itself, or the ship it is mounted on. */
export function rootOf(s: Structure): Structure {
  return s.parent ?? s;
}

/** Depth of a structure below the world (0 = root, 1 = a rotor on a ship). Parents are sent before children. */
export function depthOf(s: Structure): number {
  return s.parent === null ? 0 : 1;
}

interface SweepCache {
  version: number;
  readonly sweep: RotorSweep;
}

/** Bounding spheres of the root structures, rebuilt every tick (the sweeps are cached by grid version). */
export class StructureSpheres {
  private readonly spheres = new Map<number, StructureSphere>();
  private readonly sweeps = new WeakMap<Rotor, SweepCache>();

  /** Recompute every root's sphere from the structures' present poses and cells. */
  update(all: readonly Structure[]): void {
    this.spheres.clear();
    for (const s of all) {
      if (s.parent !== null) continue;
      const g = s.grid;
      let radius = cornerDistance(s);
      if (s instanceof Rotor) radius = Math.max(radius, this.sweepRadius(s));
      for (const c of s.children) {
        const p = c.grid.position;
        const d = Math.hypot(p.x - g.pivot.x, p.y - g.pivot.y, p.z - g.pivot.z);
        radius = Math.max(radius, d + this.sweepRadius(c));
      }
      this.spheres.set(s.id, { root: s, x: g.position.x, z: g.position.z, radius });
    }
  }

  /** The sphere of a root (by id), or undefined. */
  get(rootId: number): StructureSphere | undefined {
    return this.spheres.get(rootId);
  }

  all(): IterableIterator<StructureSphere> {
    return this.spheres.values();
  }

  private sweepRadius(r: Rotor): number {
    let c = this.sweeps.get(r);
    if (c === undefined) {
      c = { version: -1, sweep: { a0: 0, a1: 0, radius: 0 } };
      this.sweeps.set(r, c);
    }
    if (c.version !== r.grid.version) {
      measureSweep(r, c.sweep);
      c.version = r.grid.version;
    }
    return sweepSphereRadius(c.sweep);
  }
}

/** Distance from a structure's pivot to the farthest corner of its cell box (0 without cells). */
function cornerDistance(s: Structure): number {
  const g = s.grid;
  const b = g.cellBounds();
  if (b === null) return 0;
  const p = g.pivot;
  const dx = Math.max(Math.abs(b.minX - p.x), Math.abs(b.maxX - p.x));
  const dy = Math.max(Math.abs(b.minY - p.y), Math.abs(b.maxY - p.y));
  const dz = Math.max(Math.abs(b.minZ - p.z), Math.abs(b.maxZ - p.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal distance from the sphere's surface to the centre of column (cx, cz) (negative inside). */
export function sphereGap(sphere: StructureSphere, cx: number, cz: number): number {
  const mx = (cx + 0.5) * CHUNK_SIZE;
  const mz = (cz + 0.5) * CHUNK_SIZE;
  return Math.hypot(sphere.x - mx, sphere.z - mz) - sphere.radius;
}

/**
 * Is the root structure in the interest of a client with subscription radius r whose player
 * stands in column (cx, cz)? `wasIn`: it was in at the last decision (hysteresis).
 */
export function structureInterest(sphere: StructureSphere, cx: number, cz: number, r: number, wasIn: boolean): boolean {
  const gap = sphereGap(sphere, cx, cz);
  return gap <= (wasIn ? r + 6 : r + 4) * CHUNK_SIZE;
}
