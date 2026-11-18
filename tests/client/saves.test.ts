/**
 * The page's view of the saved worlds (client/saves.ts): ids and metas for new worlds, the world
 * list, and the check before a server is asked to load a world. Saving and loading themselves are
 * the server's (tests/net/host-save.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/save/storage';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';
import { checkWorld, listWorlds, makeWorldId, newWorldMeta, toSummary } from '../../src/client/saves';

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

describe('the world list and the check before loading', () => {
  it('lists every readable world newest first; deletes; refuses newer and missing worlds', async () => {
    const storage = new MemoryStorage();
    await storage.putAll('a', meta('a', { lastPlayed: 1000 }), [], []);
    await storage.putAll('c', meta('c', { lastPlayed: 3000 }), [[1, new Uint8Array([1, 2, 3])]], [['sim', new Uint8Array([4])]]);
    await storage.putMeta(meta('future', { version: SAVE_VERSION + 1, lastPlayed: 2000 }));
    expect((await listWorlds(storage)).map((w) => w.id)).toEqual(['c', 'future', 'a']);
    const ok = await checkWorld(storage, 'c');
    expect(ok.ok && ok.meta.id).toBe('c');
    const missing = await checkWorld(storage, 'nope');
    expect(missing.ok === false && missing.reason).toBe('missing');
    const fut = await checkWorld(storage, 'future');
    expect(fut.ok === false && fut.reason).toBe('newer');
    await storage.deleteWorld('c');
    expect((await listWorlds(storage)).map((w) => w.id)).toEqual(['future', 'a']);
  });

  it('refuses a world saved by an older build before reading its data; it stays listed and can be deleted', async () => {
    const storage = new MemoryStorage();
    await storage.putAll('old', meta('old', { version: SAVE_VERSION - 1 }), [], [['sim', new Uint8Array([1])]]);
    let reads = 0;
    const getBlob = storage.getBlob.bind(storage);
    storage.getBlob = async (...args) => {
      reads++;
      return getBlob(...args);
    };
    const getChunks = storage.getChunks.bind(storage);
    storage.getChunks = async (...args) => {
      reads++;
      return getChunks(...args);
    };
    const res = await checkWorld(storage, 'old');
    expect(res.ok === false && res.reason).toBe('older');
    expect(reads).toBe(0);
    expect((await listWorlds(storage)).map((w) => w.id)).toEqual(['old']);
    await storage.deleteWorld('old');
    expect(await listWorlds(storage)).toEqual([]);
  });

  it('a storage that fails is reported as an error, not as a missing world', async () => {
    const storage = new MemoryStorage();
    storage.getMeta = () => Promise.reject(new Error('disk on fire'));
    const res = await checkWorld(storage, 'x');
    expect(res.ok === false && res.reason).toBe('error');
  });
});
