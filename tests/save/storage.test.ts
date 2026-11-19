import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chunk, cellIndex, chunkKey } from '../../src/voxel/chunk';
import { SaveFormatError } from '../../src/save/bytes';
import {
  SAVE_VERSION,
  decodeChunk,
  decodeMeta,
  decodeTicks,
  encodeChunk,
  encodeMeta,
  encodeTicks,
  isNewerSave,
  type WorldMeta,
} from '../../src/save/codec';
import { MemoryStorage, SaveStorageError, type SaveStorage } from '../../src/save/storage';
import { IdbStorage, openBestStorage, type BestStorage } from '../../src/save/idb';

function meta(id: string, lastPlayed: number, over: Partial<WorldMeta> = {}): WorldMeta {
  return {
    id,
    name: `World ${id}`,
    seed: `seed-${id}`,
    seedHash: 42,
    mode: 'creative',
    createdAt: 1000,
    lastPlayed,
    version: SAVE_VERSION,
    time: 77,
    ...over,
  };
}

const bytes = (...v: number[]): Uint8Array => Uint8Array.from(v);
const K1 = chunkKey(0, 0);
const K2 = chunkKey(-1, 5);
const K3 = chunkKey(300, -300);

/** Raw access to the fake IndexedDB for tests that need to plant or inspect records. */
function rawOpen(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rawTx(db: IDBDatabase, store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
function rawCount(db: IDBDatabase, store: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbCounter = 0;
const freshDbName = (): string => `blocklands-test-${++dbCounter}`;

/**
 * Watches every connection opened through the global factory: how many were opened, and
 * which of them were closed. Hooks only public API (factory.open, IDBDatabase.close).
 */
interface ConnectionTracker {
  readonly opened: IDBDatabase[];
  readonly closed: Set<IDBDatabase>;
  /** Connections opened and not closed. */
  readonly live: number;
  /** Called with each connection the moment its open request succeeds, before anyone else sees it. */
  onOpen: ((db: IDBDatabase) => void) | null;
  restore(): void;
}
function trackConnections(): ConnectionTracker {
  const factory = indexedDB as IDBFactory & { open: IDBFactory['open'] };
  const realOpen = factory.open;
  const proto = (globalThis as unknown as { IDBDatabase: { prototype: IDBDatabase } }).IDBDatabase.prototype;
  const realClose = proto.close;
  const tracker: ConnectionTracker = {
    opened: [],
    closed: new Set(),
    get live() {
      return this.opened.filter((db) => !this.closed.has(db)).length;
    },
    onOpen: null,
    restore() {
      factory.open = realOpen;
      proto.close = realClose;
    },
  };
  factory.open = function (this: IDBFactory, name: string, version?: number) {
    const req = realOpen.call(this, name, version);
    // Registered before the caller assigns req.onsuccess, so this listener runs first.
    req.addEventListener('success', () => {
      tracker.opened.push(req.result);
      tracker.onOpen?.(req.result);
    });
    return req;
  } as IDBFactory['open'];
  proto.close = function (this: IDBDatabase) {
    tracker.closed.add(this);
    return realClose.call(this);
  };
  return tracker;
}

const settle = (p: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

// ====================================================================== shared behaviour

function storageSuite(label: string, make: () => Promise<SaveStorage>): void {
  describe(`SaveStorage behaviour: ${label}`, () => {
    let s: SaveStorage;
    beforeEach(async () => {
      s = await make();
    });

    it('starts empty', async () => {
      expect(await s.listWorlds()).toEqual([]);
      expect(await s.getMeta('nope')).toBeNull();
      expect(await s.getChunk('nope', K1)).toBeNull();
      expect(await s.getBlob('nope', 'glue')).toBeNull();
      expect(await s.getChunks('nope', [K1, K2])).toEqual([null, null]);
    });

    it('puts, gets and overwrites meta', async () => {
      const m = meta('a', 5);
      await s.putMeta(m);
      expect(await s.getMeta('a')).toEqual(m);
      await s.putMeta({ ...m, name: 'Renamed', lastPlayed: 9, time: 1234 });
      const got = await s.getMeta('a');
      expect(got?.name).toBe('Renamed');
      expect(got?.time).toBe(1234);
      expect(await s.listWorlds()).toHaveLength(1);
    });

    it('returns meta copies and strips unknown fields', async () => {
      await s.putMeta({ ...meta('a', 5), junk: 1 } as WorldMeta);
      const got = (await s.getMeta('a'))!;
      expect(got).toEqual(meta('a', 5));
      got.name = 'mutated';
      expect((await s.getMeta('a'))!.name).toBe('World a');
      const list = await s.listWorlds();
      list[0]!.name = 'mutated';
      expect((await s.listWorlds())[0]!.name).toBe('World a');
    });

    it('lists worlds newest lastPlayed first, with deterministic ties', async () => {
      await s.putMeta(meta('old', 100));
      await s.putMeta(meta('newest', 900));
      await s.putMeta(meta('mid', 500));
      await s.putMeta(meta('tie-b', 300, { createdAt: 10 }));
      await s.putMeta(meta('tie-a', 300, { createdAt: 10 }));
      await s.putMeta(meta('tie-new', 300, { createdAt: 50 }));
      expect((await s.listWorlds()).map((m) => m.id)).toEqual(['newest', 'mid', 'tie-new', 'tie-a', 'tie-b', 'old']);
      await s.putMeta(meta('old', 1000));
      expect((await s.listWorlds())[0]!.id).toBe('old');
    });

    it('puts and gets chunks, overwriting by key', async () => {
      await s.putChunks('w', [
        [K1, bytes(1, 2, 3)],
        [K2, bytes(4)],
      ]);
      expect(await s.getChunk('w', K1)).toEqual(bytes(1, 2, 3));
      expect(await s.getChunk('w', K2)).toEqual(bytes(4));
      expect(await s.getChunk('w', K3)).toBeNull();
      await s.putChunks('w', [[K1, bytes(9)]]);
      expect(await s.getChunk('w', K1)).toEqual(bytes(9));
      expect(await s.getChunk('w', K2)).toEqual(bytes(4));
      // duplicate keys in one call: last wins
      await s.putChunks('w', [
        [K3, bytes(1)],
        [K3, bytes(2)],
      ]);
      expect(await s.getChunk('w', K3)).toEqual(bytes(2));
      await s.putChunks('w', []);
      // empty records are stored as empty, not as missing
      await s.putChunks('w', [[K1, new Uint8Array(0)]]);
      const empty = await s.getChunk('w', K1);
      expect(empty).toBeInstanceOf(Uint8Array);
      expect(empty!.length).toBe(0);
    });

    it('getChunks keeps the order of keys, with nulls for missing and copies for duplicates', async () => {
      await s.putChunks('w', [
        [K1, bytes(1)],
        [K3, bytes(3)],
      ]);
      const got = await s.getChunks('w', [K3, K2, K1, K3]);
      expect(got).toEqual([bytes(3), null, bytes(1), bytes(3)]);
      expect(got[0]).not.toBe(got[3]);
      expect(await s.getChunks('w', [])).toEqual([]);
      expect(await s.getChunks('other', [K1])).toEqual([null]);
    });

    it('handles many chunks in one call', async () => {
      const entries: Array<[number, Uint8Array]> = [];
      for (let cx = -10; cx < 10; cx++) for (let cz = -5; cz < 5; cz++) entries.push([chunkKey(cx, cz), bytes(cx & 255, cz & 255, 7)]);
      await s.putChunks('big', entries);
      const got = await s.getChunks('big', entries.map(([k]) => k));
      expect(got).toEqual(entries.map(([, b]) => b));
    });

    it('puts and gets named blobs per world', async () => {
      await s.putBlob('w', 'glue', bytes(1, 1));
      await s.putBlob('w', 'structures', bytes(2));
      await s.putBlob('v', 'glue', bytes(3));
      expect(await s.getBlob('w', 'glue')).toEqual(bytes(1, 1));
      expect(await s.getBlob('w', 'structures')).toEqual(bytes(2));
      expect(await s.getBlob('v', 'glue')).toEqual(bytes(3));
      expect(await s.getBlob('w', 'entities')).toBeNull();
      await s.putBlob('w', 'glue', bytes(8));
      expect(await s.getBlob('w', 'glue')).toEqual(bytes(8));
    });

    it('putAll commits meta, chunks and blobs, leaving other records alone', async () => {
      await s.putChunks('w', [[K3, bytes(33)]]);
      await s.putBlob('w', 'player', bytes(44));
      await s.putAll(
        'w',
        meta('w', 10),
        [
          [K1, bytes(1)],
          [K2, bytes(2)],
        ],
        [
          ['glue', bytes(5)],
          ['ticks', bytes(6)],
        ],
      );
      expect(await s.getMeta('w')).toEqual(meta('w', 10));
      expect(await s.getChunks('w', [K1, K2, K3])).toEqual([bytes(1), bytes(2), bytes(33)]);
      expect(await s.getBlob('w', 'glue')).toEqual(bytes(5));
      expect(await s.getBlob('w', 'ticks')).toEqual(bytes(6));
      expect(await s.getBlob('w', 'player')).toEqual(bytes(44));
      await s.putAll('w', meta('w', 20, { time: 999 }), [[K1, bytes(11)]], []);
      expect((await s.getMeta('w'))!.time).toBe(999);
      expect(await s.getChunk('w', K1)).toEqual(bytes(11));
    });

    it('a failing putAll leaves nothing behind (new world)', async () => {
      const goodChunks: Array<[number, Uint8Array]> = [
        [K1, bytes(1)],
        [K2, bytes(2)],
      ];
      const failures: Array<() => Promise<void>> = [
        () => s.putAll('n', meta('n', 1), [...goodChunks, [K3, 'nope' as unknown as Uint8Array]], [['glue', bytes(1)]]),
        () => s.putAll('n', meta('n', 1), [...goodChunks, [NaN, bytes(3)]], []),
        () => s.putAll('n', meta('n', 1), goodChunks, [['glue', bytes(1)], ['', bytes(2)]]),
        () => s.putAll('n', meta('other', 1), goodChunks, []),
        () => s.putAll('n', { ...meta('n', 1), mode: 'peaceful' } as unknown as WorldMeta, goodChunks, []),
      ];
      for (const f of failures) {
        await expect(f()).rejects.toThrow(TypeError);
        expect(await s.getMeta('n')).toBeNull();
        expect(await s.getChunks('n', [K1, K2, K3])).toEqual([null, null, null]);
        expect(await s.getBlob('n', 'glue')).toBeNull();
        expect(await s.listWorlds()).toEqual([]);
      }
    });

    it('a failing putAll leaves an existing world unchanged', async () => {
      await s.putAll('w', meta('w', 1), [[K1, bytes(1)]], [['glue', bytes(1)]]);
      await expect(
        s.putAll('w', meta('w', 2), [[K1, bytes(9)], [K2, bytes(9)], [-5, bytes(9)]], [['glue', bytes(9)]]),
      ).rejects.toThrow(TypeError);
      expect(await s.getMeta('w')).toEqual(meta('w', 1));
      expect(await s.getChunks('w', [K1, K2])).toEqual([bytes(1), null]);
      expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    });

    it('deleteWorld removes one world only (including worlds whose ids share a prefix)', async () => {
      for (const id of ['w', 'w1', 'v', 'x']) {
        await s.putAll(id, meta(id, 1), [[K1, bytes(id.length)], [K2, bytes(2)]], [['glue', bytes(3)], ['ticks', bytes(4)]]);
      }
      await s.deleteWorld('w');
      expect(await s.getMeta('w')).toBeNull();
      expect(await s.getChunks('w', [K1, K2])).toEqual([null, null]);
      expect(await s.getBlob('w', 'glue')).toBeNull();
      expect(await s.getBlob('w', 'ticks')).toBeNull();
      for (const id of ['w1', 'v', 'x']) {
        expect(await s.getMeta(id)).toEqual(meta(id, 1));
        expect(await s.getChunks(id, [K1, K2])).toEqual([bytes(id.length), bytes(2)]);
        expect(await s.getBlob(id, 'glue')).toEqual(bytes(3));
        expect(await s.getBlob(id, 'ticks')).toEqual(bytes(4));
      }
      expect((await s.listWorlds()).map((m) => m.id).sort()).toEqual(['v', 'w1', 'x']);
      await s.deleteWorld('does-not-exist');
      await s.deleteWorld('w');
      expect(await s.listWorlds()).toHaveLength(3);
      // a deleted world can be recreated from scratch
      await s.putChunks('w', [[K3, bytes(7)]]);
      expect(await s.getChunks('w', [K1, K3])).toEqual([null, bytes(7)]);
    });

    it('stored bytes are isolated from later mutation of the caller arrays', async () => {
      const chunk = bytes(1, 2, 3);
      const blob = bytes(4, 5);
      const all = bytes(6);
      const pending = s.putChunks('w', [[K1, chunk]]);
      chunk[0] = 99; // mutate before the promise settles
      await pending;
      chunk[1] = 99;
      await s.putBlob('w', 'glue', blob);
      blob.fill(0);
      await s.putAll('w', meta('w', 1), [[K2, all]], [['ticks', all]]);
      all[0] = 0;
      expect(await s.getChunk('w', K1)).toEqual(bytes(1, 2, 3));
      expect(await s.getBlob('w', 'glue')).toEqual(bytes(4, 5));
      expect(await s.getChunk('w', K2)).toEqual(bytes(6));
      expect(await s.getBlob('w', 'ticks')).toEqual(bytes(6));
      // returned arrays are the caller's to mutate
      const got = (await s.getChunk('w', K1))!;
      got[0] = 42;
      expect(await s.getChunk('w', K1)).toEqual(bytes(1, 2, 3));
      const many = await s.getChunks('w', [K1]);
      many[0]![0] = 42;
      expect(await s.getChunk('w', K1)).toEqual(bytes(1, 2, 3));
    });

    it('stores exactly the viewed bytes of a subarray', async () => {
      const big = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
      await s.putChunks('w', [[K1, big.subarray(10, 14)]]);
      const got = (await s.getChunk('w', K1))!;
      expect([...got]).toEqual([10, 11, 12, 13]);
      expect(got.buffer.byteLength).toBe(4);
    });

    it('round-trips real codec output end to end', async () => {
      const chunk = new Chunk(-2, 3);
      for (let y = 0; y < 40; y++) for (let i = 0; i < 256; i++) chunk.cells[(y << 8) | i] = y === 0 ? 7 : y < 36 ? 1 : 3;
      chunk.cells[cellIndex(5, 40, 5)] = 8 | (1 << 10);
      const m = meta('e2e', 123);
      await s.putAll(
        'e2e',
        m,
        [[chunkKey(chunk.cx, chunk.cz), encodeChunk(chunk)]],
        [
          ['meta-copy', encodeMeta(m)],
          ['ticks', encodeTicks([{ x: -30, y: 41, z: 50, id: 40, at: 1010 }], 1000)],
        ],
      );
      const [stored] = await s.getChunks('e2e', [chunkKey(-2, 3)]);
      const back = decodeChunk(stored!);
      expect(back.layers).toEqual({ base: chunk.cells, holes: null, part2: null });
      expect(decodeMeta((await s.getBlob('e2e', 'meta-copy'))!)).toEqual(m);
      expect(decodeTicks((await s.getBlob('e2e', 'ticks'))!, 0)).toEqual([{ x: -30, y: 41, z: 50, id: 40, at: 10 }]);
    });

    it('listChunkKeys lists exactly one world\'s stored chunks, ascending', async () => {
      expect(await s.listChunkKeys('w')).toEqual([]);
      await s.putChunks('w', [
        [K3, bytes(3)],
        [K1, bytes(1)],
      ]);
      await s.putAll('w', meta('w', 1), [[K2, bytes(2)]], [['glue', bytes(9)]]);
      await s.putChunks('w1', [[chunkKey(7, 7), bytes(7)]]); // id sharing a prefix
      await s.putChunks('v', [[K1, bytes(1)]]);
      await s.putBlob('x', 'glue', bytes(1)); // blobs are not chunks
      expect(await s.listChunkKeys('w')).toEqual([K1, K2, K3].sort((a, b) => a - b));
      expect(await s.listChunkKeys('w1')).toEqual([chunkKey(7, 7)]);
      expect(await s.listChunkKeys('v')).toEqual([K1]);
      expect(await s.listChunkKeys('x')).toEqual([]);
      await s.deleteWorld('w');
      expect(await s.listChunkKeys('w')).toEqual([]);
      expect(await s.listChunkKeys('w1')).toEqual([chunkKey(7, 7)]);
      // Many chunks, including the extreme corners of the chunk key space.
      const keys: number[] = [chunkKey(-524288, -524288), chunkKey(524287, 524287)];
      for (let i = 0; i < 150; i++) keys.push(chunkKey(i - 75, (i * 7) % 11));
      await s.putChunks('big', keys.map((k) => [k, bytes(1)] as [number, Uint8Array]));
      expect(await s.listChunkKeys('big')).toEqual([...new Set(keys)].sort((a, b) => a - b));
    });

    it('listWorldIds finds every world with any record, sorted by code units', async () => {
      expect(await s.listWorldIds()).toEqual([]);
      await s.putMeta(meta('meta-only', 1));
      await s.putChunks('chunks-only', [[K1, bytes(1)]]);
      await s.putBlob('blob-only', 'glue', bytes(1));
      const odd = ['Zed', 'zed', 'é', '\u{1d538}', '￯', 'a b', 'w', 'w1'];
      for (const id of odd) await s.putAll(id, meta(id, 1), [[K2, bytes(2)]], [['ticks', bytes(3)]]);
      const all = ['meta-only', 'chunks-only', 'blob-only', ...odd];
      expect(await s.listWorldIds()).toEqual([...all].sort());
      // listWorlds only shows worlds with meta
      expect((await s.listWorlds()).map((m) => m.id).sort()).toEqual(['meta-only', ...odd].sort());
      for (const id of ['chunks-only', 'blob-only', 'w']) await s.deleteWorld(id);
      expect(await s.listWorldIds()).toEqual(all.filter((id) => !['chunks-only', 'blob-only', 'w'].includes(id)).sort());
    });

    it('refuses writes that would downgrade a world saved by a newer build', async () => {
      const newer = SAVE_VERSION + 1;
      await s.putAll('n', meta('n', 5, { version: newer }), [[K1, bytes(1)]], [['glue', bytes(1)]]);
      await s.putAll('ok', meta('ok', 1), [[K1, bytes(1)]], []);
      expect(isNewerSave((await s.listWorlds()).find((m) => m.id === 'n')!)).toBe(true);
      const refused: Array<() => Promise<void>> = [
        () => s.putAll('n', meta('n', 9), [[K1, bytes(9)], [K2, bytes(9)]], [['glue', bytes(9)], ['ticks', bytes(9)]]),
        () => s.putMeta(meta('n', 9)),
        () => s.putChunks('n', [[K1, bytes(9)], [K2, bytes(9)]]),
        () => s.putBlob('n', 'glue', bytes(9)),
      ];
      for (const write of refused) {
        const err = await write().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(SaveStorageError);
        expect((err as SaveStorageError).code).toBe('newer-version');
        expect((err as Error).message).toMatch(/newer version of the game/);
        // nothing at all was written
        expect(await s.getMeta('n')).toEqual(meta('n', 5, { version: newer }));
        expect(await s.getChunks('n', [K1, K2])).toEqual([bytes(1), null]);
        expect(await s.getBlob('n', 'glue')).toEqual(bytes(1));
        expect(await s.getBlob('n', 'ticks')).toBeNull();
      }
      // Writing the same or a newer version is fine (the newer build itself, or a later one).
      await s.putMeta(meta('n', 6, { version: newer }));
      await s.putAll('n', meta('n', 7, { version: newer + 1 }), [[K2, bytes(2)]], []);
      expect(await s.getChunk('n', K2)).toEqual(bytes(2));
      // Other worlds are unaffected, and an explicit delete is always allowed.
      await s.putChunks('ok', [[K2, bytes(2)]]);
      await s.deleteWorld('n');
      expect(await s.listWorldIds()).toEqual(['ok']);
      await s.putAll('n', meta('n', 8), [[K1, bytes(8)]], []);
      expect(await s.getChunk('n', K1)).toEqual(bytes(8));
    });

    it('rejects (never throws synchronously) on invalid arguments', async () => {
      const calls: Array<() => Promise<unknown>> = [
        () => s.getMeta(''),
        () => s.getChunk('w', -1),
        () => s.getChunk('w', 1.5),
        () => s.getChunks('w', [K1, NaN]),
        () => s.getBlob('w', ''),
        () => s.putBlob('w', 'glue', [1, 2] as unknown as Uint8Array),
        () => s.putChunks('', [[K1, bytes(1)]]),
        () => s.putChunks('w', [[K1]] as unknown as Array<[number, Uint8Array]>),
        () => s.putMeta({ id: 'x' } as WorldMeta),
        () => s.deleteWorld(5 as unknown as string),
        () => s.getMeta('x'.repeat(129)),
        () => s.listChunkKeys(''),
        () => s.listChunkKeys(undefined as unknown as string),
      ];
      for (const call of calls) {
        let promise: Promise<unknown> | undefined;
        expect(() => {
          promise = call();
        }).not.toThrow();
        await expect(promise).rejects.toThrow(TypeError);
      }
    });
  });
}

storageSuite('MemoryStorage', async () => new MemoryStorage());
storageSuite('IdbStorage', async () => IdbStorage.open(freshDbName()));

// ====================================================================== IndexedDB specifics

describe('IdbStorage specifics', () => {
  it('persists across connections and creates the documented schema', async () => {
    const name = freshDbName();
    const a = await IdbStorage.open(name);
    await a.putAll('w', meta('w', 1), [[K1, bytes(1, 2)]], [['glue', bytes(3)]]);
    a.close();
    const b = new IdbStorage(name); // lazy open on first use
    expect(await b.getMeta('w')).toEqual(meta('w', 1));
    expect(await b.getChunk('w', K1)).toEqual(bytes(1, 2));
    expect(await b.getBlob('w', 'glue')).toEqual(bytes(3));
    b.close();
    const raw = await rawOpen(name);
    expect([...raw.objectStoreNames].sort()).toEqual(['blobs', 'chunks', 'meta']);
    const tx = raw.transaction(['meta', 'chunks', 'blobs']);
    expect(tx.objectStore('meta').keyPath).toBe('id');
    expect(tx.objectStore('chunks').keyPath).toBeNull();
    const key = await new Promise<IDBValidKey>((resolve) => {
      const req = tx.objectStore('chunks').openKeyCursor();
      req.onsuccess = () => resolve(req.result!.key);
    });
    expect(key).toEqual(['w', K1]);
    raw.close();
  });

  it('reopens after close() without losing data', async () => {
    const s = await IdbStorage.open(freshDbName());
    await s.putBlob('w', 'glue', bytes(1));
    s.close();
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    s.close();
  });

  it('rolls back every write of a putAll that fails inside the transaction', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putAll('w', meta('w', 1), [[K1, bytes(1)]], [['glue', bytes(1)]]);
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }).IDBObjectStore.prototype;
    const realPut = proto.put;
    let calls = 0;
    proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      ++calls;
      // 1st putAll: meta, K1, K2, then fail on the first blob. 2nd: meta, K1, then fail on K2.
      if (calls === 4 || calls === 7) throw new Error('injected failure');
      return realPut.call(this, value, key);
    } as typeof proto.put;
    try {
      await expect(
        s.putAll('w', meta('w', 2), [[K1, bytes(9)], [K2, bytes(9)]], [['glue', bytes(9)], ['ticks', bytes(9)]]),
      ).rejects.toThrow(/injected failure/);
      await expect(s.putAll('n', meta('n', 2), [[K1, bytes(9)], [K2, bytes(9)]], [['glue', bytes(9)]])).rejects.toThrow(
        SaveStorageError,
      );
    } finally {
      proto.put = realPut;
    }
    expect(calls).toBe(7);
    expect(await s.getMeta('w')).toEqual(meta('w', 1));
    expect(await s.getChunks('w', [K1, K2])).toEqual([bytes(1), null]);
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    expect(await s.getBlob('w', 'ticks')).toBeNull();
    expect(await s.getMeta('n')).toBeNull();
    expect(await s.getChunk('n', K1)).toBeNull();
    s.close();
    const raw = await rawOpen(name);
    expect(await rawCount(raw, 'chunks')).toBe(1);
    expect(await rawCount(raw, 'blobs')).toBe(1);
    expect(await rawCount(raw, 'meta')).toBe(1);
    raw.close();
  });

  it('rejects with a clear error when a transaction aborts asynchronously', async () => {
    const s = await IdbStorage.open(freshDbName());
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }).IDBObjectStore.prototype;
    const realPut = proto.put;
    proto.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const req = realPut.call(this, value, key);
      const tx = this.transaction;
      // Simulate the backend failing after the request was queued (e.g. quota).
      req.addEventListener('success', () => tx.abort());
      return req;
    } as typeof proto.put;
    try {
      await expect(s.putChunks('w', [[K1, bytes(1)], [K2, bytes(2)]])).rejects.toThrow(/transaction aborted/);
    } finally {
      proto.put = realPut;
    }
    expect(await s.getChunks('w', [K1, K2])).toEqual([null, null]);
    s.close();
  });

  it('reports corrupted records as SaveFormatError and keeps listing the other worlds', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putMeta(meta('good', 1));
    const raw = await rawOpen(name);
    await rawTx(raw, 'meta', (st) => st.put({ id: 'bad', name: 7 }));
    await rawTx(raw, 'chunks', (st) => st.put('not bytes', ['good', K1]));
    await rawTx(raw, 'blobs', (st) => st.put(new Uint8Array([1, 2]).buffer, ['good', 'glue']));
    raw.close();
    expect((await s.listWorlds()).map((m) => m.id)).toEqual(['good']);
    await expect(s.getMeta('bad')).rejects.toThrow(SaveFormatError);
    await expect(s.getChunk('good', K1)).rejects.toThrow(SaveFormatError);
    await expect(s.getChunks('good', [K2, K1])).rejects.toThrow(SaveFormatError);
    expect(await s.getBlob('good', 'glue')).toEqual(bytes(1, 2)); // ArrayBuffer is accepted
    s.close();
  });

  it('steps aside when another tab upgrades the database, then fails clearly', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putBlob('w', 'glue', bytes(1));
    // A newer game version in another tab upgrades to version 2: not blocked by us.
    const newer = await rawOpen(name, 2);
    newer.close();
    await expect(s.getBlob('w', 'glue')).rejects.toThrow(/newer version of the game/);
    const err = await s.getBlob('w', 'glue').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveStorageError);
    expect((err as SaveStorageError).code).toBe('newer-version');
  });

  it('recovers when another tab deletes the database', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putBlob('w', 'glue', bytes(1));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('delete blocked'));
    });
    expect(await s.getBlob('w', 'glue')).toBeNull(); // reconnected to a fresh, empty database
    await s.putBlob('w', 'glue', bytes(2));
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(2));
    s.close();
  });

  it('refuses a database with the right version but foreign stores', async () => {
    const name = freshDbName();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('something-else');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await expect(IdbStorage.open(name)).rejects.toThrow(/no "meta" store/);
    expect(((await IdbStorage.open(name).catch((e: unknown) => e)) as SaveStorageError).code).toBe('incompatible');
  });

  it('reports a quota failure with code quota', async () => {
    const s = await IdbStorage.open(freshDbName());
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }).IDBObjectStore.prototype;
    const realPut = proto.put;
    proto.put = function () {
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    } as typeof proto.put;
    let err: unknown;
    try {
      err = await s.putChunks('w', [[K1, bytes(1)]]).catch((e: unknown) => e);
    } finally {
      proto.put = realPut;
    }
    expect(err).toBeInstanceOf(SaveStorageError);
    expect((err as SaveStorageError).code).toBe('quota');
    expect((err as Error).message).toMatch(/quota exceeded/);
    s.close();
  });

  it('a world with an unreadable meta record stays discoverable and deletable', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putAll('good', meta('good', 1), [[K1, bytes(1)]], []);
    await s.putAll('bad', meta('bad', 1), [[K1, bytes(1)], [K2, bytes(2)]], [['glue', bytes(3)]]);
    const raw = await rawOpen(name);
    await rawTx(raw, 'meta', (st) => st.put({ id: 'bad', name: 7 })); // corrupt it
    raw.close();
    expect((await s.listWorlds()).map((m) => m.id)).toEqual(['good']); // hidden from the list ...
    expect(await s.listWorldIds()).toEqual(['bad', 'good']); // ... but not lost
    expect(await s.listChunkKeys('bad')).toEqual([K1, K2].sort((a, b) => a - b));
    // A damaged record never blocks a repair (it has no usable version) ...
    await s.putMeta(meta('bad', 2));
    expect(await s.getMeta('bad')).toEqual(meta('bad', 2));
    // ... and the leftovers can be removed through the API.
    await s.deleteWorld('bad');
    expect(await s.listWorldIds()).toEqual(['good']);
    s.close();
    const check = await rawOpen(name);
    expect(await rawCount(check, 'chunks')).toBe(1);
    expect(await rawCount(check, 'blobs')).toBe(0);
    check.close();
  });

  it('the downgrade guard reads the stored record inside the write transaction', async () => {
    // A newer build (another tab) writes its meta behind our back; our next write must see it.
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putAll('w', meta('w', 1), [[K1, bytes(1)]], []);
    const raw = await rawOpen(name);
    await rawTx(raw, 'meta', (st) => st.put(meta('w', 2, { version: SAVE_VERSION + 1 })));
    raw.close();
    const err = await s.putAll('w', meta('w', 3), [[K1, bytes(9)]], []).catch((e: unknown) => e);
    expect((err as SaveStorageError).code).toBe('newer-version');
    expect(await s.getChunk('w', K1)).toEqual(bytes(1));
    expect((await s.getMeta('w'))!.version).toBe(SAVE_VERSION + 1);
    s.close();
  });

  it('opens lazily once for concurrent first calls', async () => {
    const name = freshDbName();
    const s = new IdbStorage(name);
    const results = await Promise.all([
      s.putBlob('w', 'glue', bytes(1)),
      s.putChunks('w', [[K1, bytes(2)]]),
      s.putMeta(meta('w', 1)),
      s.getMeta('w'),
      s.listWorlds(),
    ]);
    expect(results).toHaveLength(5);
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    expect(await s.getChunk('w', K1)).toEqual(bytes(2));
    s.close();
  });

  it('deletes a large world without touching its neighbours', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    for (const id of ['alpha', 'beta', 'gamma']) {
      const entries: Array<[number, Uint8Array]> = [];
      for (let i = 0; i < 150; i++) entries.push([chunkKey(i - 75, i % 7), bytes(i & 255)]);
      await s.putAll(id, meta(id, 1), entries, [['glue', bytes(1)], ['structures', bytes(2)]]);
    }
    await s.deleteWorld('beta');
    s.close();
    const raw = await rawOpen(name);
    expect(await rawCount(raw, 'chunks')).toBe(300);
    expect(await rawCount(raw, 'blobs')).toBe(4);
    expect(await rawCount(raw, 'meta')).toBe(2);
    raw.close();
    const again = await IdbStorage.open(name);
    expect((await again.listWorlds()).map((m) => m.id).sort()).toEqual(['alpha', 'gamma']);
    expect(await again.getChunk('alpha', chunkKey(-75, 0))).toEqual(bytes(0));
    expect(await again.getChunk('beta', chunkKey(-75, 0))).toBeNull();
    again.close();
  });


  it('validates the database name', () => {
    expect(() => new IdbStorage('')).toThrow(TypeError);
  });
});

// ====================================================================== close() semantics
//
// Regression tests for two review findings: close() must be authoritative in both
// directions. A call made BEFORE close() completes on the old connection and never reopens
// the database; a call made AFTER close() opens a fresh connection and never inherits the
// old one. And no connection may be left open behind the caller's back.

describe('IdbStorage close() semantics', () => {
  let tracker: ConnectionTracker | null = null;
  afterEach(() => {
    tracker?.restore();
    tracker = null;
  });

  it('a call made after close() during the initial open opens a fresh connection', async () => {
    tracker = trackConnections();
    const s = new IdbStorage(freshDbName());
    const before = s.getMeta('w'); // starts the lazy open
    s.close(); // retires that open
    const after = s.getMeta('w'); // must not inherit the retired open
    expect(await settle(after)).toEqual({ ok: true, value: null });
    // The call made before close() is not punished for it either: it completes.
    expect(await settle(before)).toEqual({ ok: true, value: null });
    expect(tracker.opened).toHaveLength(2);
    s.close();
    expect(tracker.live).toBe(0); // the retired connection was closed once its call started
  });

  it('an abandoned warm-up call followed by close() does not poison the next write', async () => {
    tracker = trackConnections();
    const s = new IdbStorage(freshDbName());
    void s.ping().catch(() => undefined);
    s.close();
    await expect(s.putBlob('w', 'glue', bytes(1))).resolves.toBeUndefined();
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    s.close();
    expect(tracker.live).toBe(0);
  });

  it('a call made just before close() completes and does not reopen the database', async () => {
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    tracker = trackConnections();
    const pending = s.putMeta(meta('w', 1)); // made BEFORE close()
    s.close();
    expect(await settle(pending)).toEqual({ ok: true, value: undefined });
    expect(tracker.opened).toHaveLength(0); // nothing reopened behind the caller's back
    // The write really landed (checked on a separate connection).
    const other = await IdbStorage.open(name);
    expect(await other.getMeta('w')).toEqual(meta('w', 1));
    other.close();
  });

  it('a fire-and-forget save followed by close() is not lost, even while still opening', async () => {
    tracker = trackConnections();
    const name = freshDbName();
    const s = new IdbStorage(name); // not opened yet
    void s.putAll('w', meta('w', 1), [[K1, bytes(1)]], [['glue', bytes(2)]]);
    s.close();
    const check = await IdbStorage.open(name);
    expect(await check.getMeta('w')).toEqual(meta('w', 1));
    expect(await check.getChunk('w', K1)).toEqual(bytes(1));
    expect(await check.getBlob('w', 'glue')).toEqual(bytes(2));
    check.close();
    expect(tracker.live).toBe(0);
  });

  it('calls made while the database opens apply in call order', async () => {
    tracker = trackConnections();
    const s = new IdbStorage(freshDbName());
    let second: Promise<void> | null = null;
    // Make the second write at the most dangerous moment: the connection is already known
    // to the storage (it is installing its handlers) while the first write is still queued
    // behind the open. It must still go after the first write.
    tracker.onOpen = (db) => {
      let handler: unknown = null;
      Object.defineProperty(db, 'onversionchange', {
        configurable: true,
        get: () => handler,
        set: (fn: unknown) => {
          handler = fn;
          second ??= s.putBlob('w', 'glue', bytes(2));
        },
      });
    };
    const first = s.putBlob('w', 'glue', bytes(1));
    await first;
    expect(second).not.toBeNull(); // the hook fired, so the race was really exercised
    await second;
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(2));
    s.close();
  });

  /** Make the next `n` db.transaction() calls throw like a connection the browser closed. */
  function breakTransactions(n: number): () => void {
    const proto = (globalThis as unknown as { IDBDatabase: { prototype: IDBDatabase } }).IDBDatabase.prototype;
    const real = proto.transaction;
    let left = n;
    proto.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      // fake-indexeddb runs schema upgrades through transaction(..., 'versionchange'): leave those alone.
      if (left > 0 && (args[1] as string | undefined) !== 'versionchange') {
        left--;
        throw Object.assign(new Error('The database connection is closing.'), { name: 'InvalidStateError' });
      }
      return real.apply(this, args);
    } as IDBDatabase['transaction'];
    return () => {
      proto.transaction = real;
    };
  }

  it('replaces a connection that died between calls (once), closing the dead one', async () => {
    const s = await IdbStorage.open(freshDbName());
    tracker = trackConnections();
    const restore = breakTransactions(1);
    try {
      await s.putBlob('w', 'glue', bytes(1));
    } finally {
      restore();
    }
    expect(tracker.opened).toHaveLength(1); // one replacement connection
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    s.close();
    expect(tracker.live).toBe(0);
  });

  it('does not reopen for a call made before close() when its connection dies', async () => {
    tracker = trackConnections();
    const s = new IdbStorage(freshDbName());
    const pending = s.putBlob('w', 'glue', bytes(1)); // queued behind the open
    s.close();
    const restore = breakTransactions(1);
    let result: Awaited<ReturnType<typeof settle>>;
    try {
      result = await settle(pending);
    } finally {
      restore();
    }
    expect(result.ok).toBe(false);
    const err = (result as { error: unknown }).error;
    expect(err).toBeInstanceOf(SaveStorageError);
    expect((err as SaveStorageError).code).toBe('closed');
    expect(tracker.opened).toHaveLength(1); // only the original open, no reconnect
    expect(tracker.live).toBe(0);
  });

  it('gives up with a clear error when a fresh connection cannot start transactions either', async () => {
    const s = await IdbStorage.open(freshDbName());
    tracker = trackConnections();
    const restore = breakTransactions(2);
    let err: unknown;
    try {
      err = await s.putBlob('w', 'glue', bytes(1)).catch((e: unknown) => e);
    } finally {
      restore();
    }
    expect(err).toBeInstanceOf(SaveStorageError);
    expect((err as Error).message).toMatch(/cannot start a transaction/);
    expect(tracker.live).toBe(0); // both broken connections were dropped
    expect(await s.getBlob('w', 'glue')).toBeNull(); // and the next call works again
    s.close();
  });

  it('close() is idempotent and the storage stays usable', async () => {
    tracker = trackConnections();
    const s = new IdbStorage(freshDbName());
    s.close();
    s.close();
    await s.putBlob('w', 'glue', bytes(1));
    s.close();
    s.close();
    expect(await s.getBlob('w', 'glue')).toEqual(bytes(1));
    s.close();
    expect(tracker.opened).toHaveLength(2);
    expect(tracker.live).toBe(0);
  });
});

// ====================================================================== hostile environments

type GlobalWithIdb = { indexedDB?: unknown };
const g = globalThis as unknown as GlobalWithIdb;

/** A scripted IDBFactory whose open request is driven by the test. */
function scriptedFactory(onOpen: (req: Record<string, unknown>) => void): unknown {
  return {
    open() {
      const req: Record<string, unknown> = { result: undefined, error: null };
      queueMicrotask(() => onOpen(req));
      return req;
    },
    cmp: () => 0,
  };
}
const fire = (req: Record<string, unknown>, ev: string): void => (req[ev] as (() => void) | undefined)?.();
const reasonOf = (r: BestStorage): string | null => (r.persistent ? null : r.reason);

describe('openBestStorage', () => {
  let saved: PropertyDescriptor | undefined;
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, 'indexedDB', saved);
  });
  const setIdb = (desc: PropertyDescriptor): void => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, ...desc });
  };

  it('uses IndexedDB when it works', async () => {
    const r = await openBestStorage(freshDbName());
    const { storage, persistent } = r;
    expect(persistent).toBe(true);
    expect(storage).toBeInstanceOf(IdbStorage);
    expect('reason' in r).toBe(false);
    await storage.putBlob('w', 'glue', bytes(1));
    expect(await storage.getBlob('w', 'glue')).toEqual(bytes(1));
    (storage as IdbStorage).close();
  });

  it('falls back to memory when indexedDB is undefined', async () => {
    setIdb({ value: undefined, writable: true });
    const r = await openBestStorage();
    const { storage, persistent } = r;
    expect(persistent).toBe(false);
    expect(storage).toBeInstanceOf(MemoryStorage);
    if (r.persistent) throw new Error('unreachable');
    expect(r.reason).toBe('unavailable');
    expect(r.error).toBeInstanceOf(SaveStorageError);
    expect(r.error.code).toBe('unavailable');
    expect(r.error.message).toMatch(/not available/);
    await storage.putMeta(meta('m', 1));
    expect(await storage.listWorlds()).toHaveLength(1);
    await expect(IdbStorage.open(freshDbName())).rejects.toThrow(/not available/);
  });

  it('falls back when touching indexedDB throws (sandboxed iframe)', async () => {
    setIdb({
      get() {
        throw new Error('SecurityError: access is denied for this document');
      },
    });
    const r = await openBestStorage();
    expect(r.persistent).toBe(false);
    expect(r.storage).toBeInstanceOf(MemoryStorage);
    expect(reasonOf(r)).toBe('unavailable');
  });

  it('falls back when open() throws synchronously', async () => {
    setIdb({
      value: {
        open() {
          throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
        },
      },
      writable: true,
    });
    const r = await openBestStorage();
    expect(r.persistent).toBe(false);
    expect(reasonOf(r)).toBe('unavailable');
    await expect(IdbStorage.open('x')).rejects.toThrow(/storage access is not allowed/);
  });

  it('falls back when the open request fails (private window)', async () => {
    setIdb({
      value: scriptedFactory((req) => {
        req.error = Object.assign(new Error('A mutation operation was attempted on a database that did not allow mutations.'), {
          name: 'InvalidStateError',
        });
        fire(req, 'onerror');
      }),
      writable: true,
    });
    const r = await openBestStorage();
    expect(r.persistent).toBe(false);
    expect(reasonOf(r)).toBe('unavailable');
  });

  it('rejects a blocked open, and closes the connection if it arrives later', async () => {
    let closed = 0;
    let request: Record<string, unknown> | null = null;
    setIdb({
      value: scriptedFactory((req) => {
        request = req;
        fire(req, 'onblocked');
      }),
      writable: true,
    });
    await expect(IdbStorage.open('x')).rejects.toThrow(/blocked by another open Blocklands tab/);
    request!.result = { close: () => closed++, objectStoreNames: { contains: () => true } };
    fire(request!, 'onsuccess');
    expect(closed).toBe(1);
    const r = await openBestStorage('x');
    expect(r.persistent).toBe(false);
    expect(reasonOf(r)).toBe('blocked');
  });

  it('falls back when opening works but the first read fails, closing every connection', async () => {
    const connections: Array<{ closed: number }> = [];
    setIdb({
      value: scriptedFactory((req) => {
        const conn = { closed: 0 };
        connections.push(conn);
        req.result = {
          objectStoreNames: { contains: () => true },
          close: () => conn.closed++,
          transaction() {
            throw Object.assign(new Error('backend broken'), { name: 'UnknownError' });
          },
        };
        fire(req, 'onsuccess');
      }),
      writable: true,
    });
    const r = await openBestStorage();
    expect(r.persistent).toBe(false);
    expect(reasonOf(r)).toBe('failed');
    expect(connections.length).toBeGreaterThanOrEqual(1);
    for (const c of connections) expect(c.closed).toBeGreaterThanOrEqual(1);
    await expect(IdbStorage.open('x').then((s) => s.ping())).rejects.toThrow(/backend failed.*UnknownError: backend broken/);
  });

  it('gives up on an open request that never answers when the caller says so', async () => {
    let request: Record<string, unknown> | null = null;
    let closed = 0;
    setIdb({
      value: scriptedFactory((req) => {
        request = req; // never fires anything
      }),
      writable: true,
    });
    let stop!: () => void;
    const giveUp = new Promise<void>((resolve) => (stop = resolve));
    const pending = openBestStorage('x', { giveUp });
    await Promise.resolve();
    stop();
    const r = await pending;
    expect(r.persistent).toBe(false);
    expect(r.storage).toBeInstanceOf(MemoryStorage);
    expect(reasonOf(r)).toBe('timeout');
    // The connection finally opens after we gave up: it must be released, not leaked.
    request!.result = {
      objectStoreNames: { contains: () => true },
      close: () => closed++,
      transaction() {
        const tx: Record<string, unknown> = {
          objectStore: () => ({ count: () => ({}) }),
          abort() {},
        };
        queueMicrotask(() => fire(tx, 'oncomplete'));
        return tx;
      },
    };
    fire(request!, 'onsuccess');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  it('never rejects, whatever the global looks like', async () => {
    for (const value of [null, 0, 'idb', {}, { open: 5 }, { open: () => null }]) {
      setIdb({ value, writable: true });
      const r = await openBestStorage();
      expect(r.persistent).toBe(false);
      expect(typeof reasonOf(r)).toBe('string');
    }
    // A programming error (bad name) still resolves, as 'failed'.
    setIdb(saved!);
    expect(reasonOf(await openBestStorage(''))).toBe('failed');
  });

  it('tells a database from a newer build apart from unavailable storage', async () => {
    // The reviewer's repro: the database was upgraded by a newer build of the game.
    const name = freshDbName();
    const s = await IdbStorage.open(name);
    await s.putMeta(meta('w', 1));
    s.close();
    const newer = await rawOpen(name, 2);
    newer.close();
    const r = await openBestStorage(name);
    expect(r.persistent).toBe(false);
    expect(r.storage).toBeInstanceOf(MemoryStorage);
    if (r.persistent) throw new Error('unreachable');
    expect(r.reason).toBe('newer-version');
    expect(r.error.message).toMatch(/newer version of the game/);
    // Nothing was touched: the newer build still finds its world.
    const raw = await rawOpen(name);
    expect(raw.version).toBe(2);
    expect(await rawCount(raw, 'meta')).toBe(1);
    raw.close();
  });
});
