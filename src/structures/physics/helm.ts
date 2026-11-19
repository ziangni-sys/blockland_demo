/** Helm lookup for the bow direction (ShipDynamics.refresh). */
import type { Dir } from '../../core/dirs';
import type { Vec3 } from '../../core/math';
import { AIR, cellState, ID_MASK, stateFacing } from '../../blocks/cell';
import { B } from '../../blocks/defs';
import type { StructureGrid } from '../../voxel/sgrid';

export function isHelmCell(cell: number): boolean {
  return (cell & ID_MASK) === B.HELM;
}

/** Facing of a 'facing' block cell (the helm's bow direction). */
export function cellFacing(cell: number): Dir {
  return stateFacing(cellState(cell));
}

/**
 * First helm cell in a deterministic scan of the grid storage (y, then z, then x ascending).
 * Writes its coordinates to `out` and returns the cell, or AIR when the grid has no helm.
 * Only the base layer is read: a helm cannot be cut and never shares its cell, so a helm cell is
 * always a full block whose whole value is in the base layer.
 */
export function findFirstHelm(g: StructureGrid, out: Vec3): number {
  const { sx, sy, sz, ox, oy, oz, layers } = g.storage();
  const cells = layers.base;
  let i = 0;
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++, i++) {
        const c = cells[i]!;
        if (c !== AIR && (c & ID_MASK) === B.HELM) {
          out.x = x + ox;
          out.y = y + oy;
          out.z = z + oz;
          return c;
        }
      }
    }
  }
  return AIR;
}
