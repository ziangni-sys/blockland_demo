/**
 * Adversarial review (robustness / API consistency): assembleShip's extra 'unloaded' refusal
 * checks the collected bounds grown by 1 as a full XZ rectangle, so it also requires chunks that
 * only touch the structure DIAGONALLY. collect never reads those (it reads face neighbours), so
 * previewShip() reports ok — the client highlights the ship, the player confirms — and then
 * assembleShip() refuses with 'unloaded'. Preview and assembly must agree.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { StructureManager } from '../../src/structures/manager';
import { Chunk } from '../../src/voxel/chunk';
import { World } from '../../src/voxel/world';
import { c, facing, FakeHost, fill } from './helpers';

describe('review-robustness: preview and assembly agree near unloaded chunks', () => {
  it('a raft whose only unloaded neighbour chunk is diagonal assembles like its preview says', () => {
    const world = new World(1);
    world.addChunk(new Chunk(0, 0));
    world.addChunk(new Chunk(1, 0));
    world.addChunk(new Chunk(1, -1));
    // Chunk (0,-1) is NOT loaded; it touches the raft (x 16..20, z 0..3) only at a corner.
    const mgr = new StructureManager(new FakeHost(world));
    fill(world, 16, 60, 0, 20, 60, 3, c(B.PLANKS_OAK));
    world.setCell(18, 61, 2, facing(B.HELM, 5));

    const preview = mgr.previewShip(18, 61, 2);
    expect(preview.ok).toBe(true);
    expect(preview.count).toBe(21);

    const res = mgr.assembleShip(18, 61, 2);
    // Currently: { ok: false, reason: 'unloaded' }.
    expect(res.ok ? 'ok' : res.reason).toBe('ok');
  });
});
