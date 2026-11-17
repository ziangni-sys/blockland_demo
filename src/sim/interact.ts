/**
 * Player interaction: turns the player's input (look direction, button presses, selected
 * item) into world changes, and publishes the InteractionView.
 *
 * PLACEHOLDER — creative-style instant mining and placing only. The full implementation
 * (mining times, glue, buckets, helms, bearings, steering) arrives with the simulation module.
 */
import { DIR_X, DIR_Y, DIR_Z } from '../core/dirs';
import { vec3 } from '../core/math';
import { AIR, makeCell } from '../blocks/cell';
import { isBlockItem } from '../blocks/items';
import { REPLACEABLE } from '../blocks/registry';
import { ID_MASK } from '../blocks/cell';
import type { EntityEvent } from '../entities/host';
import { placementCell, raycastGrids, type GridHit } from '../voxel/raycast';
import type { Simulation } from './simulation';
import { emptyView, type InteractionView } from './view';

export const REACH = 5;

export class Interaction {
  private hit: GridHit | null = null;

  constructor(private readonly sim: Simulation) {}

  onEntityEvent(_ev: EntityEvent): void {}

  /** The grid cell the player is looking at, within reach. */
  raycast(): GridHit | null {
    const p = this.sim.player;
    const eye = p.eyePos();
    const cp = Math.cos(p.pitch);
    const dir = vec3(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
    return raycastGrids(this.sim.grids(), eye, dir, REACH);
  }

  tick(): void {
    const sim = this.sim;
    const p = sim.player;
    const input = p.input;
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.inventory.selected = input.slot;
    this.hit = p.dead ? null : this.raycast();
    const hit = this.hit;

    if (input.attackPresses > 0 && hit) {
      const old = hit.grid.getCell(hit.x, hit.y, hit.z);
      if (hit.grid.setCell(hit.x, hit.y, hit.z, AIR)) {
        sim.events.emit({ type: 'blockBroken', gridId: hit.grid.gridId, x: hit.x, y: hit.y, z: hit.z, cell: old });
      }
    }
    if (input.usePresses > 0 && hit) {
      const stack = p.inventory.selectedStack();
      if (stack && isBlockItem(stack.item)) {
        const c = placementCell(hit);
        const cur = hit.grid.getCell(c.x, c.y, c.z);
        if (REPLACEABLE[cur & ID_MASK] === 1) {
          const cell = makeCell(stack.item);
          if (hit.grid.setCell(c.x, c.y, c.z, cell)) {
            sim.events.emit({ type: 'blockPlaced', gridId: hit.grid.gridId, x: c.x, y: c.y, z: c.z, cell });
          }
        }
      }
    }
    input.attackPresses = 0;
    input.usePresses = 0;
    void DIR_X;
    void DIR_Y;
    void DIR_Z;
  }

  buildView(): InteractionView {
    const v = emptyView();
    const h = this.hit;
    if (h) v.target = { gridId: h.grid.gridId, x: h.x, y: h.y, z: h.z, face: h.face };
    return v;
  }
}
