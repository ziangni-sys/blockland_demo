/**
 * What the client draws of the glue (DESIGN 强力胶: glue on a face is visible): exposed glued
 * faces always (within GLUE_EXPOSED_RADIUS), covered ones only while glue is in the main hand
 * or the off-hand (within GLUE_VIEW_RADIUS); a face switches between the two within
 * GLUE_REFRESH_MS when a block is put on it or taken off.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, PX, PY } from '../../src/core/dirs';
import { GLUE_EXPOSED_RADIUS, GLUE_REFRESH_MS, GLUE_VIEW_RADIUS, ViewBuilder } from '../../src/client/view';
import { FLAT_TOP, flatSim } from '../sim/helpers';

const T = FLAT_TOP;

function faceAt(v: ViewBuilder, sim: ReturnType<typeof flatSim>, now: number, x: number, y: number, z: number) {
  return v.updateOverlays(sim, now).glue.filter((f) => f.structureId === 0 && f.x === x && f.y === y && f.z === z);
}

describe('glue overlays', () => {
  it('an exposed glued face is drawn whatever the player holds, as its hard cell plus the open side', () => {
    const sim = flatSim();
    sim.world.setCell(3, T, -3, makeCell(B.STONE));
    sim.worldGlue.add(3, T, -3, PY); // top face, open
    sim.worldGlue.add(4, T, -3, NX); // the stone's east face, stored from the air cell's side
    sim.hold(B.DIRT);
    sim.tick();
    const v = new ViewBuilder();
    const glue = v.updateOverlays(sim, 0).glue;
    expect([...glue].sort((a, b) => a.face - b.face)).toEqual([
      { structureId: 0, x: 3, y: T, z: -3, face: PX, covered: false },
      { structureId: 0, x: 3, y: T, z: -3, face: PY, covered: false },
    ]);
  });

  it('a covered face is drawn only while glue is in the main hand or the off-hand', () => {
    const sim = flatSim();
    sim.world.setCell(3, T, -3, makeCell(B.STONE));
    sim.world.setCell(3, T + 1, -3, makeCell(B.STONE));
    sim.worldGlue.add(3, T, -3, PY);
    const v = new ViewBuilder();
    sim.hold(B.DIRT);
    expect(faceAt(v, sim, 0, 3, T, -3)).toEqual([]);
    sim.hold(I.GLUE);
    expect(faceAt(v, sim, 1, 3, T, -3)).toEqual([{ structureId: 0, x: 3, y: T, z: -3, face: PY, covered: true }]);
    sim.player.inventory.swapOffhand(); // glue in the off-hand, nothing in the main hand
    expect(sim.player.inventory.offhand?.item).toBe(I.GLUE);
    expect(faceAt(v, sim, 2, 3, T, -3).length).toBe(1);
    sim.player.inventory.offhand = null;
    expect(faceAt(v, sim, 3, 3, T, -3)).toEqual([]);
  });

  it('switches between covered and exposed within GLUE_REFRESH_MS when a block is put on the face or taken off', () => {
    const sim = flatSim();
    sim.world.setCell(3, T, -3, makeCell(B.STONE));
    sim.worldGlue.add(3, T, -3, PY);
    sim.hold(I.GLUE);
    const v = new ViewBuilder();
    expect(faceAt(v, sim, 0, 3, T, -3)[0]?.covered).toBe(false);
    sim.world.setCell(3, T + 1, -3, makeCell(B.STONE)); // no glue change: only the refresh sees it
    expect(faceAt(v, sim, GLUE_REFRESH_MS, 3, T, -3)[0]?.covered).toBe(true);
    sim.world.setCell(3, T + 1, -3, 0);
    expect(faceAt(v, sim, 2 * GLUE_REFRESH_MS, 3, T, -3)[0]?.covered).toBe(false);
    expect(GLUE_REFRESH_MS).toBeLessThanOrEqual(250);
  });

  it('reaches: exposed faces within GLUE_EXPOSED_RADIUS, covered ones within GLUE_VIEW_RADIUS', () => {
    const sim = flatSim({ loadRadius: 3 });
    const px = Math.floor(sim.player.pos.x);
    const pz = Math.floor(sim.player.pos.z);
    const near = px + GLUE_VIEW_RADIUS;
    const mid = px + GLUE_VIEW_RADIUS + 3;
    const far = px + GLUE_EXPOSED_RADIUS + 3;
    for (const x of [near, mid, far]) {
      sim.world.setCell(x, T, pz, makeCell(B.STONE));
      sim.world.setCell(x, T + 1, pz, makeCell(B.STONE));
      sim.worldGlue.add(x, T, pz, PY); // covered
      sim.worldGlue.add(x, T + 1, pz, PY); // exposed
    }
    sim.hold(I.GLUE);
    const glue = new ViewBuilder().updateOverlays(sim, 0).glue;
    const drawn = (x: number, covered: boolean): boolean => glue.some((f) => f.x === x && f.covered === covered);
    expect(drawn(near, true)).toBe(true);
    expect(drawn(near, false)).toBe(true);
    expect(drawn(mid, true)).toBe(false);
    expect(drawn(mid, false)).toBe(true);
    expect(drawn(far, true)).toBe(false);
    expect(drawn(far, false)).toBe(false);
  });

  it('nothing is drawn for a dead player, and an unchanged result keeps the same array', () => {
    const sim = flatSim();
    sim.world.setCell(3, T, -3, makeCell(B.STONE));
    sim.worldGlue.add(3, T, -3, PY);
    const v = new ViewBuilder();
    const a = v.updateOverlays(sim, 0).glue;
    expect(a.length).toBe(1);
    expect(v.updateOverlays(sim, GLUE_REFRESH_MS * 3).glue).toBe(a);
    sim.entities.kill(sim.player, 'test');
    expect(v.updateOverlays(sim, GLUE_REFRESH_MS * 4).glue).toEqual([]);
  });
});
