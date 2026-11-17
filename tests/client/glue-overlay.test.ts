/**
 * What the client draws of the glue (DESIGN 强力胶: glue on a face is visible): exposed glued
 * faces always (within GLUE_EXPOSED_RADIUS), covered ones only while glue is in the main hand
 * or the off-hand (within GLUE_VIEW_RADIUS); a face switches between the two within
 * GLUE_REFRESH_MS when a block is put on it or taken off.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { GLUE_EXPOSED_RADIUS, GLUE_REFRESH_MS, GLUE_VIEW_RADIUS, ViewBuilder } from '../../src/client/view';
import { FLAT_TOP, SEA_TOP, fill, flatSim, seaSim } from '../sim/helpers';

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
      { structureId: 0, x: 3, y: T, z: -3, face: PX, covered: false, sky: 15, block: 0 },
      { structureId: 0, x: 3, y: T, z: -3, face: PY, covered: false, sky: 15, block: 0 },
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
    expect(faceAt(v, sim, 1, 3, T, -3)).toEqual([{ structureId: 0, x: 3, y: T, z: -3, face: PY, covered: true, sky: 0, block: 0 }]);
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

  it('an exposed face carries the light of its open cell, and a light change shows within GLUE_REFRESH_MS', () => {
    const sim = flatSim();
    const y = T + 1;
    // A stone floor tile at (3, T, -3) glued on top; the cell above it gets walled in.
    sim.world.setCell(3, T, -3, makeCell(B.STONE));
    sim.worldGlue.add(3, T, -3, PY);
    sim.hold(B.DIRT);
    const v = new ViewBuilder();
    expect(faceAt(v, sim, 0, 3, T, -3)[0]).toMatchObject({ covered: false, sky: 15, block: 0 });
    fill(sim.world, 2, y, -4, 4, y + 1, -2, B.STONE);
    sim.world.setCell(3, y, -3, 0); // the open cell, closed in on every side
    sim.tick();
    const dark = faceAt(v, sim, GLUE_REFRESH_MS, 3, T, -3)[0]!;
    expect(dark.covered).toBe(false);
    expect(dark.sky).toBe(sim.world.getSkyLight(3, y, -3));
    expect(dark.sky).toBeLessThan(15);
    expect(dark.block).toBe(0);
    sim.world.setCell(3, y, -2, makeCell(B.LAMP)); // a lamp in the wall next to it
    sim.tick();
    const lit = faceAt(v, sim, 2 * GLUE_REFRESH_MS, 3, T, -3)[0]!;
    expect(lit.block).toBe(sim.world.getBlockLight(3, y, -3));
    expect(lit.block).toBeGreaterThan(10);
  });

  it("a ship's glue is drawn in the ship's local cells; a spinning rotor's hub glue shows on the bearing, covered again once it stops", () => {
    const sim = seaSim({ spawn: { x: 5.5, y: SEA_TOP + 1, z: 1.5 } });
    sim.player.flying = true;
    const w = sim.world;
    fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 4, B.PLANKS_OAK);
    w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
    fill(w, 2, SEA_TOP, 2, 2, SEA_TOP + 3, 2, B.PLANKS_OAK);
    const by = SEA_TOP + 3;
    w.setCell(2, by, 1, makeCell(B.BEARING, facingState(NZ)));
    for (const [dx, dy] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]] as const) {
      w.setCell(2 + dx, by + dy, 0, makeCell(B.CANVAS));
    }
    sim.worldGlue.add(2, by, 0, PZ); // hub <-> bearing
    sim.worldGlue.add(4, SEA_TOP - 1, 4, PY); // the deck's open top corner
    const res = sim.structures.assembleShip(2, SEA_TOP, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ship = res.structure;
    sim.advance(5);
    sim.teleport(5.5, SEA_TOP + 1, 1.5);
    sim.player.flying = true;
    sim.advance(2);
    sim.hold(B.DIRT);
    const v = new ViewBuilder();
    let now = 0;
    const shipFaces = () => v.updateOverlays(sim, (now += GLUE_REFRESH_MS)).glue.filter((f) => f.structureId === ship.id);
    // Local cells and the ship's own exposed / covered classification; lit by the ship's pose
    // (sky 15 / block 0 here, the renderer applies the pose light).
    expect(shipFaces()).toEqual([{ structureId: ship.id, x: 4, y: SEA_TOP - 1, z: 4, face: PY, covered: false, sky: 15, block: 0 }]);
    // A change to the ship's glue store shows at once, without waiting for the refresh.
    ship.glue.add(0, SEA_TOP - 1, 0, PY);
    expect(v.updateOverlays(sim, now + 1).glue.some((f) => f.structureId === ship.id && f.x === 0 && f.z === 0)).toBe(true);
    ship.glue.remove(0, SEA_TOP - 1, 0, PY);
    expect(v.updateOverlays(sim, now + 2).glue.some((f) => f.structureId === ship.id && f.x === 0 && f.z === 0)).toBe(false);
    sim.hold(I.GLUE);
    const hub = { structureId: ship.id, x: 2, y: by, z: 0, face: PZ, covered: true, sky: 0, block: 0 };
    expect(shipFaces()).toContainEqual(hub);
    // Start the rotor (empty hand): the hub leaves the ship's grid, the glue stays on the
    // bearing's face, now exposed (decision b), drawn whatever the player holds.
    const inv = sim.player.inventory;
    inv.hotbar[inv.selected] = null;
    expect(sim.useOn(2, by, 1, PX, ship.id)).toBe(true);
    expect(sim.useOn(2, by, 1, PX, ship.id)).toBe(true);
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor.parent).toBe(ship);
    sim.advance(5);
    sim.hold(B.DIRT);
    const onBearing = { structureId: ship.id, x: 2, y: by, z: 1, face: NZ, covered: false, sky: 15, block: 0 };
    expect(shipFaces()).toContainEqual(onBearing);
    expect(v.updateOverlays(sim, (now += GLUE_REFRESH_MS)).glue.some((f) => f.structureId === rotor.id)).toBe(false);
    // Stop it: back between the bearing and the hub, covered.
    inv.hotbar[inv.selected] = null;
    expect(sim.useOn(2, by, 1, PX, ship.id)).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(shipFaces()).not.toContainEqual(onBearing);
    sim.hold(I.GLUE);
    expect(shipFaces()).toContainEqual(hub);
  });
});
