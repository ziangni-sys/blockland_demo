import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { StructureManager } from '../../src/structures/manager';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost, fill } from './helpers';

describe('probe', () => {
  it('preview ok but assemble refuses (diagonal chunk unloaded)', () => {
    const world = new World(1);
    world.addChunk(new Chunk(0, 0));
    world.addChunk(new Chunk(1, 0));
    world.addChunk(new Chunk(1, -1));
    // chunk (0,-1) is NOT loaded: it only touches the raft diagonally
    const host = new FakeHost(world);
    const mgr = new StructureManager(host);
    fill(world, 16, 60, 0, 20, 60, 3, c(B.PLANKS_OAK));
    world.setCell(18, 61, 2, facing(B.HELM, 5));
    const p = mgr.previewShip(18, 61, 2);
    expect(p.ok).toBe(true);
    const r = mgr.assembleShip(18, 61, 2);
    expect(r.ok ? 'ok' : r.reason).toBe('ok');
  });
});
