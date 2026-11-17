import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NY, PX, PY } from '../../src/core/dirs';
import { qclone, qfromYaw, vclone, vec3 } from '../../src/core/math';
import { GlueStore } from '../../src/structures/glue';
import type { Rotor, Ship } from '../../src/structures/structure';
import { SET_STRUCTURE_MOVE } from '../../src/voxel/grid';
import { StructureManager } from '../../src/structures/manager';
import { Chunk } from '../../src/voxel/chunk';
import { StructureGrid } from '../../src/voxel/sgrid';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost, fill, loadArea, log, MILL_BEARING, millShip, scene, SHIP_HELM, windmill, type Scene } from './helpers';

const [BX, BY, BZ] = MILL_BEARING;

function shipWithRunningMill(s: Scene): { ship: Ship; rotor: Rotor } {
  millShip(s.world, s.host.worldGlue);
  const rr = s.mgr.startRotor(s.world, BX, BY, BZ);
  if (!rr.ok) throw new Error(rr.reason);
  const sr = s.mgr.assembleShip(SHIP_HELM[0], SHIP_HELM[1], SHIP_HELM[2]);
  if (!sr.ok) throw new Error(sr.reason);
  return { ship: sr.structure, rotor: rr.structure };
}

describe('frozen near unloaded chunks (LESSONS 船被弹飞)', () => {
  it('a ship next to an unloaded chunk freezes until it loads', () => {
    const s = scene();
    fill(s.world, 26, 60, 0, 29, 60, 2, c(B.PLANKS_OAK));
    s.world.setCell(27, 61, 1, facing(B.HELM, 5));
    const res = s.mgr.assembleShip(27, 61, 1); // the hull itself is in loaded chunks
    if (!res.ok) throw new Error(res.reason);
    const ship = res.structure;
    s.mgr.step();
    expect(ship.frozen).toBe(true); // x = 30 + 2 reaches chunk x = 2
    loadArea(s.world, 32, -16, 47, 15); // the box grown by 2 also reaches z = -2
    s.mgr.step();
    expect(ship.frozen).toBe(false);
    // Moved away from the loaded area: frozen again.
    ship.grid.setPoseImmediate(vec3(ship.grid.position.x, ship.grid.position.y, ship.grid.position.z + 40), ship.grid.rotation);
    s.mgr.step();
    expect(ship.frozen).toBe(true);
  });

  it('a world rotor near unloaded chunks holds still; a ship rotor follows its ship', () => {
    const s = scene();
    windmill(s.world, 27, 64, 10, 3); // its blades sweep x 24..30, + 2 reaches chunk x = 2
    const rr = s.mgr.startRotor(s.world, 27, 64, 10);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    for (let i = 0; i < 10; i++) s.mgr.step();
    expect(r.frozen).toBe(true);
    expect(r.angle).toBe(0);
    expect(r.grid.angularVelocity).toEqual(vec3());
    loadArea(s.world, 32, 0, 47, 31);
    s.mgr.step();
    expect(r.frozen).toBe(false);
    expect(r.angle).toBeGreaterThan(0);

    const t = scene();
    const { ship, rotor } = shipWithRunningMill(t);
    for (let i = 0; i < 30; i++) t.mgr.step();
    expect(rotor.frozen).toBe(false);
    ship.grid.setPoseImmediate(vec3(28, 61, 0), qfromYaw(0.3));
    const angle = rotor.angle;
    t.mgr.step();
    expect(ship.frozen).toBe(true);
    expect(rotor.frozen).toBe(true);
    expect(rotor.angle).toBe(angle);
    expect(rotor.grid.angularVelocity).toEqual(vec3());
    expect(rotor.angularSpeed).toBeGreaterThan(0); // resumes at speed once thawed
  });
});

describe('world rotor freeze box: the cells\' world box over a full turn, grown by 2', () => {
  /** Chunk loading as sim/chunks.ts does it: every column with dx^2 + dz^2 <= r^2 + r around the anchor chunk. */
  function discWorld(pcx: number, pcz: number, r = 8): World {
    const world = new World(1);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz <= r * r + r) world.addChunk(new Chunk(pcx + dx, pcz + dz));
      }
    }
    return world;
  }

  /** Bearing at (0,64,0) facing +Z on a planks support; felt arms in the plane z = 1. */
  function bigWindmill(world: World, px: number, nx: number, py: number, ny: number): void {
    world.setCell(0, 64, -1, c(B.PLANKS_OAK));
    world.setCell(0, 64, 0, facing(B.BEARING, 4));
    world.setCell(0, 64, 1, c(B.CANVAS));
    for (let i = 1; i <= px; i++) world.setCell(i, 64, 1, c(B.WOOL_RED));
    for (let i = 1; i <= nx; i++) world.setCell(-i, 64, 1, c(B.WOOL_BLUE));
    for (let i = 1; i <= py; i++) world.setCell(0, 64 + i, 1, c(B.WOOL_WHITE));
    for (let i = 1; i <= ny; i++) world.setCell(0, 64 - i, 1, c(B.WOOL_YELLOW));
  }

  /** Is the world AABB of the rotor's cells in their current pose, grown by 2, loaded? */
  function poseBoxLoaded(world: World, r: Rotor): boolean {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    r.grid.forEachCell((x, y, z) => {
      for (let k = 0; k < 8; k++) {
        const p = r.grid.toWorld(vec3(x + (k & 1), y + ((k >> 1) & 1), z + ((k >> 2) & 1)));
        minX = Math.min(minX, p.x);
        minZ = Math.min(minZ, p.z);
        maxX = Math.max(maxX, p.x);
        maxZ = Math.max(maxZ, p.z);
      }
    });
    return world.isAreaLoaded(minX - 2, minZ - 2, maxX + 2, maxZ + 2);
  }

  function start(world: World): { mgr: StructureManager; rotor: Rotor } {
    const mgr = new StructureManager(new FakeHost(world), null);
    const res = mgr.startRotor(world, 0, 64, 0);
    if (!res.ok) throw new Error(res.reason);
    return { mgr, rotor: res.structure };
  }

  it('a legal 322-cell windmill turns with the player standing at its bearing', () => {
    const world = discWorld(0, 0);
    bigWindmill(world, 99, 99, 63, 60); // 1 + 99 + 99 + 63 + 60 = 322 cells <= ROTOR_MAX_CELLS
    const { mgr, rotor } = start(world);
    expect(rotor.grid.count).toBe(322);
    for (let i = 0; i < 40; i++) {
      mgr.step();
      expect(poseBoxLoaded(world, rotor)).toBe(true);
      expect(rotor.frozen).toBe(false);
    }
    expect(rotor.angle).not.toBe(0);
  });

  it('a 161-cell windmill keeps turning with the player ~5 chunks away', () => {
    const world = discWorld(5, 0);
    bigWindmill(world, 40, 40, 40, 40);
    const { mgr, rotor } = start(world);
    for (let i = 0; i < 40; i++) {
      mgr.step();
      expect(poseBoxLoaded(world, rotor)).toBe(true);
      expect(rotor.frozen).toBe(false);
    }
    expect(rotor.angle).not.toBe(0);
  });

  it('a turntable whose long arm will swing over an unloaded chunk is frozen at angle 0 already, and stays so', () => {
    const s = scene();
    // Bearing facing up at (20,60,10); arms +X 3 (the only one reaching east now) and +Z 10.
    s.world.setCell(20, 59, 10, c(B.PLANKS_OAK));
    s.world.setCell(20, 60, 10, facing(B.BEARING, 2));
    s.world.setCell(20, 61, 10, c(B.CANVAS));
    for (let i = 1; i <= 3; i++) s.world.setCell(20 + i, 61, 10, c(B.WOOL_RED));
    for (let i = 1; i <= 10; i++) s.world.setCell(20, 61, 10 + i, c(B.WOOL_BLUE));
    const res = s.mgr.startRotor(s.world, 20, 60, 10);
    if (!res.ok) throw new Error(res.reason);
    const r = res.structure;
    expect(poseBoxLoaded(s.world, r)).toBe(true); // right now nothing reaches x = 32
    s.mgr.step();
    expect(r.frozen).toBe(true); // a quarter turn later the +Z arm would reach x = 31 (+2)
    expect(r.angle).toBe(0);
    loadArea(s.world, 32, -32, 47, 31);
    s.mgr.step();
    expect(r.frozen).toBe(false);
    // Over a whole turn the flag never flickers: the box does not depend on the angle.
    for (let i = 0; i < 400; i++) {
      s.mgr.step();
      expect(r.frozen).toBe(false);
    }
    expect(Math.abs(r.angle)).toBeGreaterThan(0);
  });
});

describe('glue hooks: the lifetime rule (a glued face stays while one side is a glueable block)', () => {
  it('world: replacing or removing one side keeps the glue; it goes once neither side is glueable', () => {
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(0, 70, 0, c(B.STONE_BRICKS));
    s.world.setCell(1, 70, 0, c(B.STONE_BRICKS));
    g.add(0, 70, 0, PX);
    s.world.setCell(1, 70, 0, c(B.BRICKS)); // replaced by another glueable block
    expect(g.has(0, 70, 0, PX)).toBe(true);
    s.world.setCell(1, 70, 0, 0); // removed: the other side still holds it
    expect(g.has(0, 70, 0, PX)).toBe(true);
    s.world.setCell(1, 70, 0, c(B.TORCH)); // a soft block on the open side changes nothing
    expect(g.has(0, 70, 0, PX)).toBe(true);
    s.world.setCell(0, 70, 0, c(B.SAND)); // the remaining side swapped for another glueable block
    expect(g.has(0, 70, 0, PX)).toBe(true);
    s.world.setCell(0, 70, 0, 0); // neither side glueable now
    expect(g.size).toBe(0);
  });

  it('world: state-only changes keep it; a liquid or a soft block is not glueable', () => {
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(0, 72, 0, log(0));
    g.add(0, 72, 0, PY); // top face, open
    s.world.setCell(0, 72, 0, log(1)); // same id, new state
    expect(g.has(0, 72, 0, PY)).toBe(true);
    s.world.setCell(0, 72, 0, c(B.WATER));
    expect(g.size).toBe(0);
    s.world.setCell(2, 72, 0, c(B.STONE));
    g.add(2, 72, 0, NY);
    s.world.setCell(2, 72, 0, c(B.SNOW_LAYER));
    expect(g.size).toBe(0);
  });

  it('world: bulk structure writes (SET_STRUCTURE_MOVE) follow the same rule', () => {
    const s = scene();
    const g = s.host.worldGlue;
    s.world.setCell(0, 74, 0, c(B.STONE));
    s.world.setCell(1, 74, 0, c(B.STONE));
    g.add(0, 74, 0, PX);
    s.world.setCell(1, 74, 0, 0, SET_STRUCTURE_MOVE);
    expect(g.has(0, 74, 0, PX)).toBe(true);
    s.world.setCell(0, 74, 0, 0, SET_STRUCTURE_MOVE);
    expect(g.size).toBe(0);
  });

  it('world: an unloaded neighbour counts as glueable, so glue at the edge of the loaded area is kept', () => {
    const s = scene(); // chunks loaded for x in -32..31
    const g = s.host.worldGlue;
    s.world.setCell(31, 70, 0, c(B.STONE));
    g.add(31, 70, 0, PX); // towards the unloaded column x = 32
    s.world.setCell(31, 70, 0, 0);
    expect(g.has(31, 70, 0, PX)).toBe(true);
    s.world.setCell(30, 70, 0, c(B.STONE));
    g.add(30, 70, 0, PX); // towards (31, 70, 0), loaded and air
    s.world.setCell(30, 70, 0, 0);
    expect(g.has(30, 70, 0, PX)).toBe(false);
  });

  it('ship and rotor grids: the same rule on their own glue', () => {
    const s = scene();
    windmill(s.world, 10, 64, 10, 3);
    s.host.worldGlue.add(11, 64, 11, PX); // between two felt cells of the +X arm
    const rr = s.mgr.startRotor(s.world, 10, 64, 10);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    expect(r.glue.has(11, 64, 11, PX)).toBe(true);
    r.grid.setCell(12, 64, 11, 0);
    expect(r.glue.has(11, 64, 11, PX)).toBe(true); // (11, 64, 11) is still felt
    r.grid.setCell(11, 64, 11, 0);
    expect(r.glue.size).toBe(0);
    expect(r.sails).toBe(11);

    const { ship } = shipWithRunningMill(s);
    expect(ship.glue.has(2, 61, 0, 3)).toBe(true);
    ship.grid.setCell(2, 60, 0, c(B.PLANKS_PINE)); // replaced by another id
    expect(ship.glue.has(2, 61, 0, 3)).toBe(true);
    ship.grid.setCell(2, 60, 0, 0);
    expect(ship.glue.has(2, 61, 0, 3)).toBe(true); // (2, 61, 0) still holds it
    ship.grid.setCell(2, 61, 0, 0);
    expect(ship.glue.has(2, 61, 0, 3)).toBe(false);
  });

  it('costs nothing noticeable with empty stores: many terrain writes do not touch the glue', () => {
    const s = scene();
    const g = s.host.worldGlue;
    let changes = 0;
    g.onChange(() => changes++);
    for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) s.world.setCell(x, 65, z, c(B.STONE));
    for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) s.world.setCell(x, 65, z, 0);
    expect(changes).toBe(0);
    expect(g.size).toBe(0);
  });

  it('glueFor answers for the world, live and just-removed structures, and rejects foreign grids', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    expect(s.mgr.glueFor(s.world)).toBe(s.host.worldGlue);
    expect(s.mgr.glueFor(ship.grid)).toBe(ship.glue);
    expect(s.mgr.glueFor(rotor.grid)).toBe(rotor.glue);
    s.mgr.stopRotor(rotor);
    expect(s.mgr.glueFor(rotor.grid)).toBe(rotor.glue);
    expect(s.mgr.structureOf(rotor.grid)).toBeNull();
    expect(() => s.mgr.glueFor(new StructureGrid(99, s.world))).toThrow();
    expect(() => s.mgr.glueFor(scene().world)).toThrow();
    expect(s.mgr.gridById(0)).toBe(s.world);
    expect(s.mgr.gridById(rotor.id)).toBeUndefined();
    expect(new GlueStore().size).toBe(0);
  });
});

describe('step', () => {
  it('snapshots poses, spins rotors before the dynamics, refreshes ships, sums sails', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipWithRunningMill(s);
    const dyn = s.dyn!;
    let checked = 0;
    dyn.onStep = (ships, rotors) => {
      expect(ships).toEqual([ship]);
      expect(rotors).toEqual([rotor]);
      expect(dyn.refreshed[dyn.refreshed.length - 1]).toBe(ship);
      // the rotor already advanced this tick: prev -> current brackets the tick
      if (rotor.angularSpeed > 0) expect(rotor.grid.rotation).not.toEqual(rotor.grid.prevRotation);
      checked++;
    };
    const pos = vclone(ship.grid.position);
    for (let i = 0; i < 5; i++) s.mgr.step();
    expect(checked).toBe(5);
    expect(dyn.steps).toBe(5);
    expect(ship.grid.prevPosition).toEqual(pos);
    expect(ship.sails).toBe(9);
    rotor.grid.setCell(BX + 2, BY, BZ + 1, 0);
    s.mgr.step();
    expect(ship.sails).toBe(8);
  });

  it('a bearing broken during the dynamics step blockifies after it, not in the middle', () => {
    const s = scene({ dynamics: true });
    const { ship, rotor } = shipWithRunningMill(s);
    let seen = false;
    s.dyn!.onStep = () => {
      if (seen) return;
      seen = true;
      ship.grid.setCell(BX, BY, BZ, 0); // e.g. crushed against terrain
      expect(rotor.removed).toBe(false);
    };
    s.mgr.step();
    expect(seen).toBe(true);
    expect(rotor.removed).toBe(true);
    expect(ship.grid.getCell(BX, BY, BZ + 1)).not.toBe(0);
  });

  it('removes ships emptied outside a batch at the end of the step (riders released first)', () => {
    const s = scene();
    const { ship, rotor } = shipWithRunningMill(s);
    s.mgr.stopRotor(rotor);
    const cells: Array<[number, number, number]> = [];
    ship.grid.forEachCell((x, y, z) => cells.push([x, y, z]));
    for (const [x, y, z] of cells) ship.grid.setCell(x, y, z, 0);
    expect(ship.removed).toBe(false);
    s.mgr.step();
    expect(ship.removed).toBe(true);
    expect(s.host.released[s.host.released.length - 1]).toBe(ship);
    expect(s.mgr.all()).toEqual([]);
  });

  it('a rotor whose cells were all destroyed is removed and frees its bearing', () => {
    const s = scene();
    windmill(s.world, 0, 64, 0, 1);
    const rr = s.mgr.startRotor(s.world, 0, 64, 0);
    if (!rr.ok) throw new Error(rr.reason);
    const r = rr.structure;
    const cells: Array<[number, number, number]> = [];
    r.grid.forEachCell((x, y, z) => cells.push([x, y, z]));
    for (const [x, y, z] of cells) r.grid.setCell(x, y, z, 0);
    s.mgr.step();
    expect(r.removed).toBe(true);
    expect(s.mgr.rotorAtBearing(s.world, 0, 64, 0)).toBeNull();
    expect(s.world.getCell(0, 64, 1)).toBe(0);
  });

  it('wakes a ship when a world cell next to it changes, not when far away', () => {
    const s = scene({ dynamics: true });
    const { ship } = shipWithRunningMill(s);
    s.mgr.step();
    const dyn = s.dyn!;
    dyn.woken.length = 0;
    s.world.setCell(20, 60, 0, c(B.STONE));
    expect(dyn.woken).toEqual([]);
    s.world.setCell(4, 60, 0, c(B.STONE)); // right next to the deck edge (x = 3)
    expect(dyn.woken).toEqual([ship]);
    // After the ship moved, the box follows it.
    ship.grid.setPoseImmediate(vec3(ship.grid.position.x + 12, ship.grid.position.y, ship.grid.position.z), qclone(ship.grid.rotation));
    s.mgr.step();
    dyn.woken.length = 0;
    s.world.setCell(16, 60, 0, c(B.STONE));
    expect(dyn.woken).toEqual([ship]);
  });

  it('lists are immutable snapshots: stopping while iterating visits everything', () => {
    const s = scene();
    for (let i = 0; i < 4; i++) {
      windmill(s.world, -20 + i * 10, 64, -10, 1);
      expect(s.mgr.startRotor(s.world, -20 + i * 10, 64, -10).ok).toBe(true);
    }
    const list = s.mgr.rotors();
    expect(list.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    for (const r of list) s.mgr.stopRotor(r);
    expect(list.length).toBe(4);
    expect(s.mgr.rotors()).toEqual([]);
    expect(list.every((r) => r.removed)).toBe(true);
  });
});
