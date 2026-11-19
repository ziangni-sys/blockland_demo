/**
 * What the view builder hands the renderer for players (package 12, NETCODE section 18), on a
 * hand-built scene (the replica's surface the view builder reads: a world, a structure grid at its
 * display pose, the entity list at renderTick). The end-to-end scenes are in
 * tests/net/e2e-players-view.test.ts; here are the rules they do not reach:
 *  - own motion: measured in the carrier's frame; a change of carrier keeps the last measure; a
 *    frame whose display time does not advance reports none;
 *  - the own player in third person: posture from ShownPlayer, the held item from the inventory,
 *    its motion measured over the own (rotor) tick, never a name tag; nothing in first person;
 *  - a diver's name: hidden when its eyes are in water and the camera is not, shown again from
 *    within the water.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import type { ItemStack } from '../../src/blocks/items';
import { TPS } from '../../src/core/constants';
import { qfromYaw, vec3 } from '../../src/core/math';
import { Inventory } from '../../src/entities/inventory';
import type { EntityView } from '../../src/net/client/replica';
import type { ClientReplica } from '../../src/net/client/replica';
import { shownPlayer, ViewBuilder, type CameraScene, type EntityScene } from '../../src/client/view';
import { StructureGrid } from '../../src/voxel/sgrid';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';

const SHIP = 9;
const flags = { sneaking: false, sprinting: false, flying: false, dead: false, onGround: true };

type MutableView = EntityView & { pos: { x: number; y: number; z: number }; carrierId: number };

function player(id: number, carrierId: number, name: string): MutableView {
  return { id, kind: 'player', pos: vec3(id, 60, 0), yaw: 0, carrierId, pitch: 0, look: { pitch: 0, flags }, player: { flags, steeringShipId: 0, heldItem: 0 }, name, item: 0, count: 0, cell: 0, fuse: 0 } as MutableView;
}

function sceneWith(views: EntityView[]): { world: World; grid: StructureGrid; scene: CameraScene & EntityScene } {
  const world = new World(1);
  world.addChunk(new Chunk(0, 0));
  const grid = new StructureGrid(SHIP, world);
  grid.pivot.x = 4;
  grid.pivot.y = 60;
  grid.pivot.z = 4;
  grid.setPoseImmediate(vec3(4, 60, 4), qfromYaw(0));
  const scene = {
    world,
    entities: () => views,
    structures: () => [],
    state: { structures: new Map([[SHIP, { structure: { grid } }]]) },
  } as unknown as CameraScene & EntityScene;
  return { world, grid, scene };
}

/** Moves and turns the grid's display pose. */
function poseGrid(grid: StructureGrid, x: number, yaw: number): void {
  const q = qfromYaw(yaw);
  grid.position.x = x;
  grid.rotation.x = q.x;
  grid.rotation.y = q.y;
  grid.rotation.z = q.z;
  grid.rotation.w = q.w;
}

describe('own motion of the other players (EntityRenderState vx, vy, vz)', () => {
  it('is measured in the carrier frame; a change of carrier keeps the last measure; a frame whose display time stands still has none', () => {
    const b = player(1, SHIP, 'Bram');
    const { grid, scene } = sceneWith([b]);
    const v = new ViewBuilder();
    const me = shownPlayer();
    me.id = 100;
    const local = vec3();
    let tick = 0;
    let last = null as ReturnType<ViewBuilder['updateEntities']>[number] | null;
    // The ship sails at 0.4 blocks / tick and turns 0.05 rad / tick; b walks its deck along local +x at 0.1 / tick.
    for (let f = 0; f < 20; f++) {
      tick += 1;
      const yaw = tick * 0.05;
      poseGrid(grid, 4 + tick * 0.4, yaw);
      local.x = 2 + tick * 0.1;
      local.y = 60;
      local.z = 2;
      grid.toWorld(local, b.pos);
      last = v.updateEntities(scene, me, tick, tick).find((e) => e.id === 1)!;
      if (f === 0) {
        expect([last.vx, last.vy, last.vz]).toEqual([0, 0, 0]); // first sight: nothing to compare with
        continue;
      }
      // The walk on the deck, in world axes: local +x turned by the ship's yaw, at 0.1 * TPS blocks / s.
      const along = grid.toWorld(vec3(1, 0, 0), vec3());
      const origin = grid.toWorld(vec3(0, 0, 0), vec3());
      expect(Math.hypot(last.vx, last.vz)).toBeCloseTo(0.1 * TPS, 6);
      expect(last.vx).toBeCloseTo((along.x - origin.x) * 0.1 * TPS, 6);
      expect(last.vz).toBeCloseTo((along.z - origin.z) * 0.1 * TPS, 6);
      expect(last.vy).toBeCloseTo(0, 9);
    }
    const before = { vx: last!.vx, vz: last!.vz };
    // b steps off onto the shore (carrier 0), its world position jumps by 5 blocks: the last measure stays.
    tick += 1;
    b.carrierId = 0;
    b.pos.x += 5;
    const off = v.updateEntities(scene, me, tick, tick).find((e) => e.id === 1)!;
    expect(off.vx).toBe(before.vx);
    expect(off.vz).toBe(before.vz);
    // Measured on land from the next frame on.
    tick += 1;
    b.pos.x += 0.2;
    const land = v.updateEntities(scene, me, tick, tick).find((e) => e.id === 1)!;
    expect(land.vx).toBeCloseTo(0.2 * TPS, 9);
    // The display time does not advance (paused, stalled): no own motion, whatever the position does.
    b.pos.x += 0.3;
    const still = v.updateEntities(scene, me, tick, tick).find((e) => e.id === 1)!;
    expect([still.vx, still.vy, still.vz]).toEqual([0, 0, 0]);
  });
});

describe('the own player', () => {
  it('in third person: posture from the shown player, the held stack, motion over the own tick, no name; nothing in first person', () => {
    const { scene } = sceneWith([]);
    const v = new ViewBuilder();
    const me = shownPlayer();
    me.id = 100;
    me.feet.x = 8;
    me.feet.y = 60;
    me.feet.z = 8;
    me.yaw = 0.7;
    me.pitch = -0.3;
    me.inventory = new Inventory();
    me.inventory.hotbar[2] = { item: B.STONE, count: 5 } as ItemStack;
    me.inventory.selected = 2;
    me.sneaking = true;
    v.updateCamera(scene, me, 70, 0.05, 'front');
    let self = v.updateEntities(scene, me, 50, 10).find((e) => e.id === me.id)!;
    expect(self).toBeDefined();
    expect(self.posture).toBe('sneak');
    expect(self.held).toBe(B.STONE);
    expect(self.label).toBeNull();
    expect(self.yaw).toBe(0.7);
    expect(self.headYaw).toBe(0.7);
    expect(self.headPitch).toBe(-0.3);
    // The own prediction runs on the rotor tick: the renderTick stands still, the own tick moves on.
    me.feet.x += 0.25;
    self = v.updateEntities(scene, me, 50, 11).find((e) => e.id === me.id)!;
    expect(self.vx).toBeCloseTo(0.25 * TPS, 9);
    me.sneaking = false;
    me.flying = true;
    expect(v.updateEntities(scene, me, 50, 12).find((e) => e.id === me.id)!.posture).toBe('fly');
    me.flying = false;
    me.sprinting = true;
    expect(v.updateEntities(scene, me, 50, 13).find((e) => e.id === me.id)!.posture).toBe('sprint');
    // At a wheel (here of a ship the replica does not hold: the body keeps the look): the helm posture.
    me.steeringShipId = 77;
    self = v.updateEntities(scene, me, 50, 14).find((e) => e.id === me.id)!;
    expect(self.posture).toBe('helm');
    expect(self.yaw).toBe(0.7);
    expect(self.label).toBeNull();
    v.updateCamera(scene, me, 70, 0.05, 'first');
    expect(v.updateEntities(scene, me, 50, 15).some((e) => e.id === me.id)).toBe(false);
  });
});

describe("a diver's name", () => {
  it('is hidden while its eyes are under water and the camera is not; seen from within the water it shows', () => {
    const diver = player(1, 0, 'Wade');
    const swimmer = player(2, 0, 'Iris');
    const { world, scene } = sceneWith([diver, swimmer]);
    // Sea from y 40 to 52 over the whole chunk.
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 40; y <= 52; y++) world.setCell(x, y, z, B.WATER);
    diver.pos.x = 4;
    diver.pos.y = 44; // eyes at 45.6, deep in the water
    diver.pos.z = 4;
    swimmer.pos.x = 6;
    swimmer.pos.y = 52.2; // eyes over the surface
    swimmer.pos.z = 4;
    const v = new ViewBuilder();
    const me = shownPlayer();
    me.id = 100;
    const replica = (): ClientReplica => ({ ...scene, dayTime: 0 }) as unknown as ClientReplica;
    // The camera in the air above the sea.
    me.feet.x = 8;
    me.feet.y = 56;
    me.feet.z = 8;
    v.updateCamera(scene, me, 70, 0.05, 'first');
    expect(v.updateEnvironment(replica(), 0, 4).submerged).toBe('none');
    let list = v.updateEntities(scene, me, 1, 1);
    expect(list.find((e) => e.id === 1)!.label).toBeNull();
    expect(list.find((e) => e.id === 2)!.label).toBe('Iris');
    // The camera dives in too: the diver's name shows (it fades with the water's fog in the renderer).
    me.feet.y = 44;
    v.updateCamera(scene, me, 70, 0.05, 'first');
    expect(v.updateEnvironment(replica(), 0, 4).submerged).toBe('water');
    list = v.updateEntities(scene, me, 2, 2);
    expect(list.find((e) => e.id === 1)!.label).toBe('Wade');
    expect(list.find((e) => e.id === 2)!.label).toBe('Iris');
  });
});
