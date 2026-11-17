import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/save/storage';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { makeWorldId, newWorldMeta, SaveManager, toSummary } from '../../src/client/saves';
import { Simulation } from '../../src/sim/simulation';
import { exportSave, importSave } from '../../src/sim/persist';
import { FlatGenerator } from '../../src/worldgen/generator';
import { B } from '../../src/blocks/defs';

function meta(id: string, extra: Partial<WorldMeta> = {}): WorldMeta {
  return { ...newWorldMeta(id, 'W', 'seed', 7, 'creative', 1000), ...extra };
}

describe('save helpers', () => {
  it('world ids are distinct and short', () => {
    const ids = new Set<string>();
    let r = 0.1;
    for (let i = 0; i < 100; i++) {
      r = (r * 9301 + 49297) % 233280 / 233280;
      ids.add(makeWorldId(1_700_000_000_000 + i, () => r));
    }
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id.length).toBeLessThan(32);
  });

  it('newWorldMeta writes the current format version', () => {
    const m = newWorldMeta('w1', 'Name', 'abc', 0xffffffff, 'survival', 5.7);
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.seedHash).toBe(0xffffffff);
    expect(m.createdAt).toBe(5);
    expect(toSummary(m)).toEqual({ id: 'w1', name: 'Name', seed: 'abc', mode: 'survival', lastPlayed: 5 });
  });
});

describe('SaveManager', () => {
  it('serializes saves and coalesces requests made while one is running', async () => {
    const storage = new MemoryStorage();
    const writes: number[] = [];
    const orig = storage.putAll.bind(storage);
    let gate: () => void = () => undefined;
    let first = true;
    storage.putAll = async (...args) => {
      writes.push(args[1].time);
      if (first) {
        first = false;
        await new Promise<void>((r) => (gate = r));
      }
      return orig(...args);
    };
    const m = new SaveManager(storage);
    const bundle = { chunks: [], blobs: [] };
    const p1 = m.save(() => ({ meta: meta('a', { time: 1 }), bundle }));
    await Promise.resolve();
    await Promise.resolve();
    expect(m.busy).toBe(true);
    const p2 = m.save(() => ({ meta: meta('a', { time: 2 }), bundle }));
    const p3 = m.save(() => ({ meta: meta('a', { time: 3 }), bundle }));
    expect(p3).toBe(p2);
    gate();
    await Promise.all([p1, p2, p3]);
    expect(writes).toEqual([1, 3]);
    expect(m.busy).toBe(false);
    expect((await storage.getMeta('a'))!.time).toBe(3);
    await m.idle();
  });

  it('a failing save rejects without blocking later saves', async () => {
    const storage = new MemoryStorage();
    const m = new SaveManager(storage);
    const bundle = { chunks: [], blobs: [] };
    await expect(m.save(() => ({ meta: { ...meta('b'), id: '' }, bundle }))).rejects.toBeTruthy();
    await m.save(() => ({ meta: meta('b', { time: 9 }), bundle }));
    expect((await storage.getMeta('b'))!.time).toBe(9);
    await m.save(() => null); // skipped
  });

  it('loads what exportSave wrote, refuses newer and missing worlds', async () => {
    const storage = new MemoryStorage();
    const m = new SaveManager(storage);
    const gen = new FlatGenerator();
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2 });
    sim.tick();
    const p = sim.player.pos;
    sim.world.setCell(Math.floor(p.x) + 2, Math.floor(p.y), Math.floor(p.z), B.BRICKS);
    await m.save(() => ({ meta: meta('c', { time: sim.world.time }), bundle: exportSave(sim) }));
    const res = await m.load('c');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bundle.chunks.length).toBe(1);
    expect(res.bundle.blobs.map(([n]) => n).sort()).toEqual(['entities', 'glue', 'sim', 'structures', 'ticks']);
    const sim2 = new Simulation({ seed: 1, mode: 'creative', generator: gen, syncChunks: true, loadRadius: 2 });
    importSave(sim2, res.bundle);
    sim2.tick();
    expect(sim2.world.getId(Math.floor(p.x) + 2, Math.floor(p.y), Math.floor(p.z))).toBe(B.BRICKS);

    expect((await m.load('nope')).ok).toBe(false);
    await storage.putMeta(meta('future', { version: SAVE_VERSION + 1 }));
    const fut = await m.load('future');
    expect(fut.ok === false && fut.reason).toBe('newer');
    expect((await m.list()).map((w) => w.id).sort()).toEqual(['c', 'future']);
    await m.delete('c');
    expect((await m.list()).map((w) => w.id)).toEqual(['future']);
  });
});
