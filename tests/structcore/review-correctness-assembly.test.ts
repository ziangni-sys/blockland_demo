/**
 * REVIEW (correctness): assembly-time defects of the structcore module.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import type { World } from '../../src/voxel/world';
import { c, facing, fill, scene, WATER, windmill } from './helpers';

function sourcesIn(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (world.getCell(x, y, z) === WATER) out.push([x, y, z]);
  }
  return out;
}

describe('REVIEW: the water refill multiplies a single source (DESIGN 水的处理 is about the sea closing over the hull)', () => {
  it('one bucket of water on a raft deck in a DRY dock becomes 21 sources', () => {
    const s = scene();
    fill(s.world, -6, 59, -6, 10, 59, 8, c(B.STONE)); // dry ground
    fill(s.world, 0, 60, 0, 4, 60, 3, c(B.PLANKS_OAK)); // raft 5 x 4 lying on it
    s.world.setCell(2, 61, 1, facing(B.HELM, 5));
    s.world.setCell(0, 61, 3, WATER); // a puddle poured on the deck
    expect(sourcesIn(s.world, -6, 59, -6, 10, 63, 8).length).toBe(1);
    expect(s.mgr.assembleShip(2, 61, 1).ok).toBe(true);
    // The cell under the puddle sees a source "directly above", then the fixpoint spreads it
    // horizontally over the whole vacated deck: 20 new water sources from one bucket.
    expect(sourcesIn(s.world, -6, 59, -6, 10, 63, 8).length).toBeLessThanOrEqual(2); // FAILS: 21
  });

  it('starting a windmill next to one source leaves a cross of water sources hanging in the air', () => {
    const s = scene();
    windmill(s.world, 0, 64, 0, 3); // arms in the plane z = 1, nothing below them but air
    s.world.setCell(4, 64, 1, WATER); // a single source just past the +X arm tip
    expect(s.mgr.startRotor(s.world, 0, 64, 0).ok).toBe(true);
    const created = sourcesIn(s.world, -6, 58, -2, 6, 70, 3).filter(([x, y, z]) => !(x === 4 && y === 64 && z === 1));
    // No new source may float on air: each must rest on a hard block or on another source.
    const floating = created.filter(([x, y, z]) => {
      const below = s.world.getCell(x, y - 1, z);
      return below !== WATER && SOLID[below & 0x3ff] !== 1;
    });
    expect(created.length).toBe(10); // the whole horizontal arm row + the lower arm column
    expect(floating).toEqual([]); // FAILS: 7 float in mid-air (6 of the horizontal arm + the lowest arm cell)
  });
});
