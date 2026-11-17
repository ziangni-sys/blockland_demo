import { describe, expect, it } from 'vitest';
import { qfromAxisAngle, qfromYaw, qintegrate, qrotate, qrotateInv, qtoMat3, qyaw, vec3 } from '../../src/core/math';
import { B, CELL_UNLOADED } from '../../src/blocks/defs';
import { BLOCKS, TILE_NAMES, blockDef, isSolidCell } from '../../src/blocks/registry';
import { cellId, cellState, liquidAmount, liquidState, makeCell } from '../../src/blocks/cell';
import { allItems, I, itemDef } from '../../src/blocks/items';
import { Chunk, chunkKey, chunkKeyX, chunkKeyZ, sectionKey, sectionKeyParts } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { StructureGrid } from '../../src/voxel/sgrid';

describe('math', () => {
  it('quaternion rotation matches matrix and inverse', () => {
    const q = qfromAxisAngle(vec3(0, 1, 0), Math.PI / 2);
    const v = qrotate(q, vec3(0, 0, -1));
    expect(v.x).toBeCloseTo(-1);
    expect(v.z).toBeCloseTo(0);
    const back = qrotateInv(q, v);
    expect(back.z).toBeCloseTo(-1);
    const m = qtoMat3(q);
    expect(m[2]! * -1).toBeCloseTo(v.x);
  });
  it('yaw round trips', () => {
    for (const yaw of [-2, -0.5, 0, 0.7, 3]) expect(qyaw(qfromYaw(yaw))).toBeCloseTo(yaw);
  });
  it('integrates angular velocity exactly', () => {
    let q = qfromYaw(0);
    for (let i = 0; i < 100; i++) q = qintegrate(q, vec3(0, 1, 0), 0.01);
    expect(qyaw(q)).toBeCloseTo(1, 6);
  });
});

describe('blocks', () => {
  it('cell encoding', () => {
    const c = makeCell(B.WATER, liquidState(3, false));
    expect(cellId(c)).toBe(B.WATER);
    expect(cellState(c)).toBe(3);
    expect(liquidAmount(cellState(c))).toBe(5);
    expect(liquidAmount(liquidState(0, false))).toBe(8);
  });
  it('registry is consistent', () => {
    for (const [name, id] of Object.entries(B)) {
      expect(BLOCKS[id], name).toBeDefined();
    }
    expect(blockDef(B.STONE).stick).toBe('none');
    expect(blockDef(B.PLANKS_OAK).stick).toBe('planks');
    expect(blockDef(B.WOOL_RED).sail).toBe(true);
    expect(isSolidCell(CELL_UNLOADED)).toBe(true);
    expect(isSolidCell(makeCell(B.TORCH))).toBe(false);
    expect(TILE_NAMES.length).toBeGreaterThan(40);
    expect(itemDef(I.GLUE).key).toBe('glue');
    expect(allItems().some((i) => i.id === B.WATER)).toBe(false);
  });
});

describe('world storage', () => {
  it('keys round trip', () => {
    for (const [x, z] of [[0, 0], [-1, 5], [1234, -4321]] as const) {
      const k = chunkKey(x, z);
      expect(chunkKeyX(k)).toBe(x);
      expect(chunkKeyZ(k)).toBe(z);
      expect(sectionKeyParts(sectionKey(x, 5, z))).toEqual({ cx: x, sy: 5, cz: z });
    }
  });
  it('get/set, hooks, dirty sections, ticks', () => {
    const w = new World(1);
    expect(w.getCell(0, 10, 0)).toBe(CELL_UNLOADED);
    w.addChunk(new Chunk(0, 0));
    w.addChunk(new Chunk(-1, 0));
    w.takeDirtySections();
    const seen: number[][] = [];
    w.onCellChange((x, y, z, o, n) => seen.push([x, y, z, o, n]));
    expect(w.setCell(-1, 20, 3, makeCell(B.STONE))).toBe(true);
    expect(w.getId(-1, 20, 3)).toBe(B.STONE);
    expect(w.setCell(-1, 20, 3, makeCell(B.STONE))).toBe(false);
    expect(seen).toEqual([[-1, 20, 3, 0, B.STONE]]);
    const dirty = w.takeDirtySections();
    expect(dirty).toContain(sectionKey(-1, 1, 0));
    expect(dirty).toContain(sectionKey(0, 1, 0));
    expect(w.getCell(0, -1, 0)).toBe(makeCell(B.DEEPROCK));
    expect(w.getCell(0, 500, 0)).toBe(0);
    w.scheduleTick(1, 2, 3, B.WATER, 5);
    expect(w.ticks.takeDue(4)).toEqual([]);
    expect(w.ticks.takeDue(5).length).toBe(1);
    expect(w.ticks.size).toBe(0);
  });
});

describe('structure grid', () => {
  it('stores cells sparsely and transforms through parents', () => {
    const w = new World(1);
    const ship = new StructureGrid(1, w);
    ship.setCell(-3, 2, 7, makeCell(B.PLANKS_OAK));
    ship.setCell(5, 2, 7, makeCell(B.PLANKS_OAK));
    expect(ship.count).toBe(2);
    expect(ship.getCell(-3, 2, 7)).toBe(makeCell(B.PLANKS_OAK));
    expect(ship.cellBounds()).toEqual({ minX: -3, minY: 2, minZ: 7, maxX: 6, maxY: 3, maxZ: 8 });
    ship.pivot.x = 1; ship.pivot.y = 2; ship.pivot.z = 7;
    ship.setPoseImmediate(vec3(100, 50, 100), qfromYaw(Math.PI / 2));
    const p = ship.toWorld(vec3(1, 2, 6)); // one cell "forward" (-Z) of pivot, yawed left 90deg -> -X
    expect(p.x).toBeCloseTo(99);
    expect(p.z).toBeCloseTo(100);
    const back = ship.toLocal(p);
    expect(back.x).toBeCloseTo(1);
    expect(back.z).toBeCloseTo(6);

    const rotor = new StructureGrid(2, ship);
    rotor.setPoseImmediate(vec3(1, 4, 7), qfromYaw(0));
    const rp = rotor.toWorld(vec3(0, 0, -1));
    expect(rp.x).toBeCloseTo(99);
    expect(rp.y).toBeCloseTo(52);
    const rl = rotor.toLocal(rp);
    expect(rl.z).toBeCloseTo(-1);
    // velocity: ship spinning about +Y at 1 rad/s -> point 1 unit toward -X of pivot moves toward +Z
    ship.angularVelocity.y = 1;
    const v = ship.velocityAt(vec3(99, 50, 100));
    expect(v.z).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(0);
    // pivot change keeps cells in place
    const before = ship.toWorld(vec3(5, 2, 7));
    ship.setPivotKeepingPose(vec3(3, 2, 7));
    const after = ship.toWorld(vec3(5, 2, 7));
    expect(after.x).toBeCloseTo(before.x);
    expect(after.z).toBeCloseTo(before.z);
  });
});
