/**
 * REVIEW (robustness): support rules inside a SHIP are not re-evaluated after bulk writes.
 *
 * BlockUpdates.onStructureChange() drops every change flagged SET_NO_NEIGHBOR_UPDATE, on the
 * assumption (blockupdates.ts header) that "the structures module calls updateAround() for every
 * touched cell once the move is complete". That is only true for WORLD cells: StructureHost
 * .blockUpdate is world-only, and blockifyGrid() writes a ship rotor's cells into the SHIP grid
 * with the move flags. So a torch (or flower, snow cover, cactus) that a ship rotor brings back
 * at a quarter turn — now beside its former support — floats in the ship forever, while exactly
 * the same windmill on the world pops it (DESIGN 组装和方块化之后要触发方块更新：没有支撑的花草掉落;
 * brief: "a structure cell that loses the HARD block under a support-needing block pops that
 * block too"). The same applies to startRotor() on a ship taking a soft block's support away.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX } from '../../src/core/dirs';
import type { VoxelGrid } from '../../src/voxel/grid';
import { SEA_TOP, countId, fill, seaSim } from './helpers';

const Y = SEA_TOP;

function run(onShip: boolean): number {
  const sim = seaSim({ mode: 'survival', spawn: { x: 10.5, y: Y + 10, z: 10.5 } });
  sim.soloPlayer.player.flying = true;
  const w = sim.world;
  // raft + helm; a plank post carrying a bearing that faces +X
  fill(w, 0, Y - 1, 0, 4, Y - 1, 4, B.PLANKS_OAK);
  w.setCell(2, Y, 4, makeCell(B.HELM, facingState(NZ)));
  w.setCell(0, Y, 2, makeCell(B.PLANKS_OAK));
  w.setCell(0, Y + 1, 2, makeCell(B.PLANKS_OAK));
  w.setCell(1, Y + 1, 2, makeCell(B.BEARING, facingState(PX)));
  // the blade: hub + a canvas column going up, a torch standing on top of it
  for (let y = Y + 1; y <= Y + 5; y++) w.setCell(2, y, 2, makeCell(B.CANVAS));
  w.setCell(2, Y + 6, 2, makeCell(B.TORCH));
  sim.advance(2);
  const rres = sim.structures.startRotor(w, 1, Y + 1, 2);
  expect(rres.ok).toBe(true);
  if (!rres.ok) return -1;
  const rotor = rres.structure;
  let host: VoxelGrid = w;
  if (onShip) {
    const sres = sim.structures.assembleShip(2, Y, 4);
    expect(sres.ok).toBe(true);
    if (!sres.ok) return -1;
    expect(rotor.parent).toBe(sres.structure);
    host = sres.structure.grid;
  }
  sim.structures.dynamics = null;
  // spin to roughly a quarter turn, then stop: the column lies down, the torch is beside its support
  for (let i = 0; i < 2000; i++) {
    sim.tick();
    const a = ((rotor.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (rotor.angularSpeed !== 0 && a > Math.PI / 3 && a < (2 * Math.PI) / 3) break;
  }
  sim.structures.stopRotor(rotor);
  sim.advance(3);
  return countId(host, B.TORCH, -10, Y - 10, -10, 15, Y + 15, 15);
}

describe('review: support rules after a rotor blockifies', () => {
  it('control: on the world, the unsupported torch pops', () => {
    expect(run(false)).toBe(0);
  });

  it('on a ship, the unsupported torch pops as well', () => {
    expect(run(true)).toBe(0);
  });
});
