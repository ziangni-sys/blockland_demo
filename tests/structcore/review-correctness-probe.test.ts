import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { StructureManager } from '../../src/structures/manager';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost, fill, scene, WATER, windmill } from './helpers';

describe('probe: unloaded over-refusal', () => {
  it('previewShip ok but assembleShip refuses', () => {
    const world = new World(1);
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1]] as const) world.addChunk(new Chunk(cx, cz));
    const host = new FakeHost(world);
    const mgr = new StructureManager(host, null);
    fill(world, 2, 60, 2, 28, 60, 2, c(B.PLANKS_OAK));
    fill(world, 2, 60, 2, 2, 60, 28, c(B.PLANKS_OAK));
    world.setCell(2, 61, 2, facing(B.HELM, 5));
    const p = mgr.previewShip(2, 61, 2);
    console.log('preview', p.ok, p.reason, p.count);
    const r = mgr.assembleShip(2, 61, 2);
    console.log('assemble', r.ok, !r.ok && r.reason);
  });
});

describe('probe: water dupe', () => {
  it('one source on a raft deck in a dry dock', () => {
    const s = scene();
    fill(s.world, -6, 59, -6, 10, 59, 8, c(B.STONE));
    fill(s.world, 0, 60, 0, 4, 60, 3, c(B.PLANKS_OAK));
    s.world.setCell(2, 61, 1, facing(B.HELM, 5));
    s.world.setCell(0, 61, 3, WATER);
    const count = (): number => {
      let n = 0;
      for (let x = -6; x <= 10; x++) for (let z = -6; z <= 8; z++) for (let y = 59; y <= 63; y++) if (s.world.getCell(x, y, z) === WATER) n++;
      return n;
    };
    const before = count();
    const r = s.mgr.assembleShip(2, 61, 1);
    expect(r.ok).toBe(true);
    console.log('sources before', before, 'after', count());
  });
  it('one source next to a world windmill arm tip', () => {
    const s = scene();
    windmill(s.world, 0, 64, 0, 3);
    s.world.setCell(4, 64, 1, WATER);
    const count = (): number => {
      let n = 0;
      for (let x = -6; x <= 6; x++) for (let z = -2; z <= 3; z++) for (let y = 58; y <= 70; y++) if (s.world.getCell(x, y, z) === WATER) n++;
      return n;
    };
    const before = count();
    expect(s.mgr.startRotor(s.world, 0, 64, 0).ok).toBe(true);
    console.log('rotor sources before', before, 'after', count());
  });
});
