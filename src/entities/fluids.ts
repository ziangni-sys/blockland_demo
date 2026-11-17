/**
 * How much of a body is in water / lava, after the dry-volume correction.
 *
 * World water inside a floating hull is never deleted (LESSONS 船舱里冒出水面): it is cut away
 * when drawing and ignored here. A point inside a ship's dry cell — isDryCell(hull, local cell)
 * — is not in water. isDryCell already encodes LESSONS 沉船上不会溺水: a sealed cavity is always
 * dry, an open hold only while the ship can float, so the helmsman of a sinking ship drowns
 * while a sailor in the sealed cabin of a submerged one does not.
 */
import { ID_MASK, cellState, liquidAmount } from '../blocks/cell';
import { LIQUID, LIQUID_LAVA, LIQUID_WATER } from '../blocks/registry';
import { vec3, type Vec3 } from '../core/math';
import { isDryCell } from '../structures/hull';
import type { World } from '../voxel/world';
import type { Entity } from './entity';
import { curToLocal, type StructRec } from './structs';

/** Vertical sample spacing through the body. */
const SAMPLE_SPACING = 0.25;

export class FluidSampler {
  /** Share of the body in lava from the last sample(). */
  lavaShare = 0;
  private readonly local: Vec3 = vec3();
  private readonly point: Vec3 = vec3();
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Fill e.wet, e.headWet, e.inLava (and this.lavaShare) from the body's centre line. */
  sample(e: Entity, near: readonly StructRec[]): void {
    const n = Math.max(2, Math.ceil(e.height / SAMPLE_SPACING));
    let water = 0;
    let lava = 0;
    const x = e.pos.x;
    const z = e.pos.z;
    for (let i = 0; i < n; i++) {
      const y = e.pos.y + (e.height * (i + 0.5)) / n;
      const k = this.liquidAt(x, y, z, near);
      if (k === LIQUID_WATER) water++;
      else if (k === LIQUID_LAVA) lava++;
    }
    e.wet = water / n;
    this.lavaShare = lava / n;
    e.inLava = lava > 0;
    e.headWet = this.liquidAt(x, e.pos.y + e.eyeHeight, z, near) === LIQUID_WATER;
  }

  /** Liquid kind (0 none, 1 water, 2 lava) at a world point, honouring liquid surface height and dry hulls. */
  liquidAt(x: number, y: number, z: number, near: readonly StructRec[]): number {
    const world = this.world;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const cell = world.getCell(ix, iy, iz);
    const liq = LIQUID[cell & ID_MASK]!;
    if (liq === 0) return 0;
    // Surface of a liquid cell without the same liquid above: amount/9 of the cell (a source
    // is 8/9 full); with liquid above the cell is full.
    if (LIQUID[world.getCell(ix, iy + 1, iz) & ID_MASK] !== liq) {
      if (y - iy >= liquidAmount(cellState(cell)) / 9) return 0;
    }
    for (let k = 0; k < near.length; k++) {
      const r = near[k]!;
      const ship = r.ship;
      if (ship === null || ship.hull === null) continue;
      if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY || z < r.minZ || z > r.maxZ) continue;
      const p = this.point;
      p.x = x;
      p.y = y;
      p.z = z;
      const l = curToLocal(r, p, this.local);
      if (isDryCell(ship.hull, Math.floor(l.x), Math.floor(l.y), Math.floor(l.z))) return 0;
    }
    return liq;
  }
}
