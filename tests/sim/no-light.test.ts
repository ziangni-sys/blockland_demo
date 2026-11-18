/**
 * The server computes no light (docs/NETCODE.md section 15, package 9): the game rules never read
 * it, light is the client's (net/client/replica.ts). Every chunk of a Simulation shares one light
 * array holding open sky, which nothing writes.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { chunkKey } from '../../src/voxel/chunk';
import { FLAT_TOP, flatSim } from './helpers';

const OPEN_SKY = 0xf0;

describe('the server computes no light', () => {
  it('every chunk shares one open-sky light array that edits, ticks, unloading and restoring never write', () => {
    const sim = flatSim({ loadRadius: 2 });
    sim.advance(5);
    expect('light' in sim).toBe(false);
    const chunks = [...sim.world.chunks.values()];
    expect(chunks.length).toBeGreaterThan(4);
    const light = chunks[0]!.light;
    for (const c of chunks) expect(c.light).toBe(light);
    expect(light.every((v) => v === OPEN_SKY)).toBe(true);

    // A roof and a torch under it light nothing on the server.
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) sim.world.setCell(x, FLAT_TOP + 3, z, B.STONE);
    sim.world.setCell(1, FLAT_TOP, 1, B.TORCH);
    sim.advance(10);
    expect(light.every((v) => v === OPEN_SKY)).toBe(true);
    expect(sim.world.getSkyLight(0, FLAT_TOP, 0)).toBe(15);
    expect(sim.world.getBlockLight(1, FLAT_TOP, 1)).toBe(0);

    // The modified chunk goes to the stash when nothing needs it, and comes back sharing it.
    const chunks2 = sim.chunks;
    chunks2.setAnchors([{ x: 10_000, z: 10_000, radius: 0 }]);
    chunks2.unloadFar(1000);
    expect(sim.world.getChunk(0, 0)).toBeUndefined();
    expect(chunks2.stash.has(chunkKey(0, 0))).toBe(true);
    chunks2.setAnchors([{ x: 0.5, z: 0.5, radius: 1 }]);
    chunks2.wanted(16);
    const back = sim.world.getChunk(0, 0)!;
    expect(back.modified).toBe(true);
    expect(back.light).toBe(light);
    expect(sim.world.getId(0, FLAT_TOP + 3, 0)).toBe(B.STONE);
    // A freshly generated column shares it too.
    const fresh = chunks2.loadColumn(sim.generator, 40, 40);
    expect(fresh?.light).toBe(light);
    expect(light.every((v) => v === OPEN_SKY)).toBe(true);
  });
});
