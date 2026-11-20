/**
 * What the client draws of the glue (DESIGN 强力胶: glue on a face is visible): exposed glued
 * faces always (within GLUE_EXPOSED_RADIUS), covered ones only while glue is in the main hand
 * or the off-hand (within GLUE_VIEW_RADIUS); a face switches between the two within
 * GLUE_REFRESH_MS when a block is put on it or taken off. Built from the client's replica (the
 * glue the server replicated, the light the client computes) and the inventory as shown,
 * against a real server (rig.ts).
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { I } from '../../src/blocks/items';
import { NX, NZ, PX, PY, PZ } from '../../src/core/dirs';
import { GLUE_EXPOSED_RADIUS, GLUE_REFRESH_MS, GLUE_VIEW_RADIUS, ViewBuilder } from '../../src/client/view';
import type { OverlayFace } from '../../src/render/backend';
import { fill } from '../sim/helpers';
import { FLAT_TOP, SEA, SEA_TOP, SessionRig } from './rig';

const T = FLAT_TOP;

function glueOf(rig: SessionRig, v: ViewBuilder, now: number): OverlayFace[] {
  return v.updateOverlays(rig.session.replica!, rig.session.shown, null, now).glue;
}

function faceAt(rig: SessionRig, v: ViewBuilder, now: number, x: number, y: number, z: number): OverlayFace[] {
  return glueOf(rig, v, now).filter((f) => f.structureId === 0 && f.x === x && f.y === y && f.z === z);
}

/** Let what changed on the server reach the replica (and its light settle). */
function settle(rig: SessionRig): void {
  rig.ticks(3);
  rig.run(100);
}

describe('glue overlays', () => {
  it('an exposed glued face is drawn whatever the player holds, as its hard cell plus the open side', async () => {
    const rig = await SessionRig.create({
      setup: (sim) => {
        sim.world.setCell(3, T, -3, makeCell(B.STONE));
        sim.worldGlue.add(3, T, -3, PY); // top face, open
        sim.worldGlue.add(4, T, -3, NX); // the stone's east face, stored from the air cell's side
      },
    });
    rig.playUntilReady();
    rig.hold(B.PLANKS_OAK);
    rig.run(100);
    const glue = glueOf(rig, new ViewBuilder(), 0);
    expect([...glue].sort((a, b) => a.face - b.face)).toEqual([
      { structureId: 0, x: 3, y: T, z: -3, face: PX, covered: false, sky: 15, block: 0, fill: 0xff, quads: 15 },
      { structureId: 0, x: 3, y: T, z: -3, face: PY, covered: false, sky: 15, block: 0, fill: 0xff, quads: 15 },
    ]);
  });

  it('a covered face is drawn only while glue is in the main hand or the off-hand (as shown: at once)', async () => {
    const rig = await SessionRig.create({
      setup: (sim) => {
        sim.world.setCell(3, T, -3, makeCell(B.STONE));
        sim.world.setCell(3, T + 1, -3, makeCell(B.STONE));
        sim.worldGlue.add(3, T, -3, PY);
      },
    });
    rig.playUntilReady();
    const v = new ViewBuilder();
    rig.hold(B.PLANKS_OAK);
    rig.frame();
    expect(faceAt(rig, v, 0, 3, T, -3)).toEqual([]);
    rig.hold(I.GLUE);
    rig.frame();
    expect(faceAt(rig, v, 1, 3, T, -3)).toEqual([{ structureId: 0, x: 3, y: T, z: -3, face: PY, covered: true, sky: 0, block: 0, fill: 0xff, quads: 15 }]);
    rig.session.swapHands(); // glue in the off-hand, nothing in the main hand
    rig.frame();
    expect(rig.session.inventory!.offhand?.item).toBe(I.GLUE);
    expect(faceAt(rig, v, 2, 3, T, -3).length).toBe(1);
    rig.session.swapHands(); // glue back in the main hand ...
    rig.hold(B.PLANKS_OAK); // ... and planks selected: no glue in either hand
    rig.frame();
    expect(faceAt(rig, v, 3, 3, T, -3)).toEqual([]);
  });

  it('switches between covered and exposed within GLUE_REFRESH_MS when a block is put on the face or taken off', async () => {
    const rig = await SessionRig.create({
      setup: (sim) => {
        sim.world.setCell(3, T, -3, makeCell(B.STONE));
        sim.worldGlue.add(3, T, -3, PY);
      },
    });
    rig.playUntilReady();
    rig.hold(I.GLUE);
    rig.frame();
    const v = new ViewBuilder();
    expect(faceAt(rig, v, 0, 3, T, -3)[0]?.covered).toBe(false);
    rig.sim.world.setCell(3, T + 1, -3, makeCell(B.STONE)); // no glue change: only the refresh sees it
    settle(rig);
    expect(faceAt(rig, v, 1, 3, T, -3)[0]?.covered).toBe(false); // not before the refresh
    expect(faceAt(rig, v, GLUE_REFRESH_MS, 3, T, -3)[0]?.covered).toBe(true);
    rig.sim.world.setCell(3, T + 1, -3, 0);
    settle(rig);
    expect(faceAt(rig, v, 2 * GLUE_REFRESH_MS, 3, T, -3)[0]?.covered).toBe(false);
    expect(GLUE_REFRESH_MS).toBeLessThanOrEqual(250);
  });

  it('reaches: exposed faces within GLUE_EXPOSED_RADIUS, covered ones within GLUE_VIEW_RADIUS', async () => {
    const near = GLUE_VIEW_RADIUS;
    const mid = GLUE_VIEW_RADIUS + 3;
    const far = GLUE_EXPOSED_RADIUS + 3;
    const rig = await SessionRig.create({
      setup: (sim) => {
        for (const x of [near, mid, far]) {
          sim.world.setCell(x, T, 0, makeCell(B.STONE));
          sim.world.setCell(x, T + 1, 0, makeCell(B.STONE));
          sim.worldGlue.add(x, T, 0, PY); // covered
          sim.worldGlue.add(x, T + 1, 0, PY); // exposed
        }
      },
    });
    rig.playUntilReady();
    rig.hold(I.GLUE);
    rig.frame();
    const glue = glueOf(rig, new ViewBuilder(), 0);
    const drawn = (x: number, covered: boolean): boolean => glue.some((f) => f.x === x && f.covered === covered);
    expect(drawn(near, true)).toBe(true);
    expect(drawn(near, false)).toBe(true);
    expect(drawn(mid, true)).toBe(false);
    expect(drawn(mid, false)).toBe(true);
    expect(drawn(far, true)).toBe(false);
    expect(drawn(far, false)).toBe(false);
  });

  it('nothing is drawn for a dead player, and an unchanged result keeps the same array', async () => {
    const rig = await SessionRig.create({
      mode: 'survival',
      setup: (sim) => {
        sim.world.setCell(3, T, -3, makeCell(B.STONE));
        sim.worldGlue.add(3, T, -3, PY);
      },
    });
    rig.playUntilReady();
    const v = new ViewBuilder();
    const a = glueOf(rig, v, 0);
    expect(a.length).toBe(1);
    expect(glueOf(rig, v, GLUE_REFRESH_MS * 3)).toBe(a);
    const p = rig.sim.players.online()[0]!.player;
    rig.sim.entities.kill(p, 'test');
    rig.runUntil(() => rig.session.dead);
    rig.frame();
    expect(glueOf(rig, v, GLUE_REFRESH_MS * 4)).toEqual([]);
  });

  it('an exposed face carries the light of its open cell (the client\'s light), and a light change shows within GLUE_REFRESH_MS', async () => {
    const y = T + 1;
    const rig = await SessionRig.create({
      setup: (sim) => {
        // A stone floor tile at (3, T, -3) glued on top; the cell above it gets walled in later.
        sim.world.setCell(3, T, -3, makeCell(B.STONE));
        sim.worldGlue.add(3, T, -3, PY);
      },
    });
    rig.playUntilReady();
    rig.hold(B.PLANKS_OAK);
    rig.frame();
    const v = new ViewBuilder();
    expect(faceAt(rig, v, 0, 3, T, -3)[0]).toMatchObject({ covered: false, sky: 15, block: 0 });
    fill(rig.sim.world, 2, y, -4, 4, y + 1, -2, B.STONE);
    rig.sim.world.setCell(3, y, -3, 0); // the open cell, closed in on every side
    settle(rig);
    const world = rig.session.replica!.world;
    const dark = faceAt(rig, v, GLUE_REFRESH_MS, 3, T, -3)[0]!;
    expect(dark.covered).toBe(false);
    expect(dark.sky).toBe(world.getSkyLight(3, y, -3));
    expect(dark.sky).toBeLessThan(15);
    expect(dark.block).toBe(0);
    rig.sim.world.setCell(3, y, -2, makeCell(B.LAMP)); // a lamp in the wall next to it
    settle(rig);
    const lit = faceAt(rig, v, 2 * GLUE_REFRESH_MS, 3, T, -3)[0]!;
    expect(lit.block).toBe(world.getBlockLight(3, y, -3));
    expect(lit.block).toBeGreaterThan(10);
  });

  it("a ship's glue is drawn in the ship's local cells; a spinning rotor's hub glue shows on the bearing, covered again once it stops", async () => {
    const by = SEA_TOP + 3;
    let shipId = 0;
    const rig = await SessionRig.create({
      generator: SEA,
      setup: (sim) => {
        const w = sim.world;
        fill(w, 0, SEA_TOP - 1, 0, 4, SEA_TOP - 1, 4, B.PLANKS_OAK);
        w.setCell(2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
        fill(w, 2, SEA_TOP, 2, 2, SEA_TOP + 3, 2, B.PLANKS_OAK);
        w.setCell(2, by, 1, makeCell(B.BEARING, facingState(NZ)));
        for (const [dx, dy] of [[0, 0], [1, 0], [2, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [0, -1], [0, -2]] as const) {
          w.setCell(2 + dx, by + dy, 0, makeCell(B.CANVAS));
        }
        sim.worldGlue.add(2, by, 0, PZ); // hub <-> bearing
        sim.worldGlue.add(4, SEA_TOP - 1, 4, PY); // the deck's open top corner
        const res = sim.structures.assembleShip(2, SEA_TOP, 4);
        expect(res.ok).toBe(true);
        if (res.ok) shipId = res.structure.id;
      },
    });
    rig.playUntilReady();
    rig.teleport(5.5, SEA_TOP + 1, 1.5);
    rig.session.own!.player.flying = true; // creative: hover next to the boat instead of sinking
    rig.hold(B.PLANKS_OAK);
    rig.run(200);
    const v = new ViewBuilder();
    let now = 0;
    const shipFaces = (): OverlayFace[] => glueOf(rig, v, (now += GLUE_REFRESH_MS)).filter((f) => f.structureId === shipId);
    // Local cells and the ship's own exposed / covered classification; lit by the ship's pose
    // (sky 15 / block 0 here, the renderer applies the pose light).
    expect(shipFaces()).toEqual([{ structureId: shipId, x: 4, y: SEA_TOP - 1, z: 4, face: PY, covered: false, sky: 15, block: 0, fill: 0xff, quads: 15 }]);
    // A change to the ship's glue store shows at once, without waiting for the refresh.
    const ship = rig.sim.structures.get(shipId)!;
    ship.glue.add(0, SEA_TOP - 1, 0, PY);
    settle(rig);
    expect(glueOf(rig, v, now + 1).some((f) => f.structureId === shipId && f.x === 0 && f.z === 0)).toBe(true);
    ship.glue.remove(0, SEA_TOP - 1, 0, PY);
    settle(rig);
    expect(glueOf(rig, v, now + 2).some((f) => f.structureId === shipId && f.x === 0 && f.z === 0)).toBe(false);
    rig.hold(I.GLUE);
    rig.frame();
    const hub = { structureId: shipId, x: 2, y: by, z: 0, face: PZ, covered: true, sky: 0, block: 0, fill: 0xff, quads: 15 };
    expect(shipFaces()).toContainEqual(hub);
    // Start the rotor (planks in hand: the bearing comes before placing): the hub leaves the
    // ship's grid, the glue stays on the bearing's face, now exposed, drawn whatever the player holds.
    rig.hold(B.PLANKS_OAK);
    expect(rig.useOn(2, by, 1, PX, shipId)).toBe(true);
    expect(rig.useOn(2, by, 1, PX, shipId)).toBe(true);
    const rotor = rig.sim.structures.rotors()[0]!;
    expect(rotor.parent).toBe(ship);
    settle(rig);
    const onBearing = { structureId: shipId, x: 2, y: by, z: 1, face: NZ, covered: false, sky: 15, block: 0, fill: 0xff, quads: 15 };
    expect(shipFaces()).toContainEqual(onBearing);
    expect(glueOf(rig, v, (now += GLUE_REFRESH_MS)).some((f) => f.structureId === rotor.id)).toBe(false);
    // Stop it: back between the bearing and the hub, covered.
    expect(rig.useOn(2, by, 1, PX, shipId)).toBe(true);
    expect(rotor.removed).toBe(true);
    settle(rig);
    expect(shipFaces()).not.toContainEqual(onBearing);
    rig.hold(I.GLUE);
    rig.frame();
    expect(shipFaces()).toContainEqual(hub);
    expect(rig.errors).toEqual([]);
  });
});
