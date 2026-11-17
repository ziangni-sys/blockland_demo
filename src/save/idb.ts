/**
 * IndexedDB SaveStorage for browsers.
 *
 * Schema (database version 1):
 *   meta    keyPath 'id'                 -> WorldMeta objects (plain, inspectable in devtools)
 *   chunks  out-of-line [worldId, key]   -> Uint8Array (encodeChunk output)
 *   blobs   out-of-line [worldId, name]  -> Uint8Array (structures, glue, entities, ticks ...)
 *
 * Robustness rules:
 *  - Every operation settles. Requests and transactions are wired for success, error and
 *    abort; opening also handles `blocked`. A failure rejects with SaveStorageError (backend),
 *    TypeError (bad argument) or SaveFormatError (a stored record is not what we wrote).
 *  - When another tab upgrades or deletes the database we close our connection at once so we
 *    never block it, and transparently reconnect on the next call (which fails with a clear
 *    message if the database is now from a newer game version).
 *  - All arguments are validated and all bytes snapshotted before the first await, so a
 *    rejected call has written nothing and later mutation of the caller's arrays is harmless.
 *  - One call = one transaction, so every method is atomic; putAll spans all three stores.
 *
 * Only the `indexedDB` global is touched (through globalThis). Key ranges would need the
 * separate IDBKeyRange global, so per-world deletion walks a key cursor instead (it jumps
 * straight to the world's first key, so it never scans other worlds).
 */
import { SaveFormatError, isUint8Array } from './bytes';
import { copyMeta, metaProblem, type WorldMeta } from './codec';
import {
  MemoryStorage,
  SaveStorageError,
  checkBlobName,
  checkChunkKey,
  checkWorldId,
  compareWorldsByRecency,
  snapshotBlobs,
  snapshotBytes,
  snapshotChunks,
  snapshotMeta,
  type SaveStorage,
} from './storage';

export const DEFAULT_DB_NAME = 'blocklands';
const DB_VERSION = 1;
const META = 'meta';
const CHUNKS = 'chunks';
const BLOBS = 'blobs';
const ALL_STORES: string[] = [META, CHUNKS, BLOBS];

/** The IndexedDB factory, or null when it is missing or merely reading the global throws. */
function indexedDBFactory(): IDBFactory | null {
  try {
    const f = (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
    if (f && typeof (f as IDBFactory).open === 'function') return f as IDBFactory;
  } catch {
    // Sandboxed iframes / opaque origins throw SecurityError on access.
  }
  return null;
}

const HINTS: Readonly<Record<string, string>> = Object.freeze({
  QuotaExceededError: 'storage quota exceeded (free disk space or delete old worlds)',
  VersionError: 'the save database was created by a newer version of the game',
  InvalidStateError: 'the database connection is closed',
  UnknownError: "the browser's storage backend failed",
  SecurityError: 'storage access is not allowed in this context',
  AbortError: 'the operation was aborted',
});

/** "hint (Name: message)" for DOMExceptions and errors, String(e) for anything else. */
function explain(e: unknown): string {
  if (e && typeof e === 'object') {
    const { name, message } = e as { name?: unknown; message?: unknown };
    if (typeof name === 'string') {
      const detail = typeof message === 'string' && message ? `${name}: ${message}` : name;
      const hint = HINTS[name];
      return hint ? `${hint} (${detail})` : detail;
    }
  }
  return String(e ?? 'unknown error');
}

/** Stored chunk/blob value -> bytes. IndexedDB returns a fresh clone, so no copy is needed. */
function storedBytes(value: unknown, what: string): Uint8Array | null {
  if (value === undefined) return null;
  if (isUint8Array(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new SaveFormatError(`${what}: stored record is not binary data`);
}

/**
 * Delete every key [worldId, ...] of `store` with a key cursor. Keys of one world are
 * contiguous (arrays compare element-wise), so jump to [worldId] and stop at the first key
 * of another world.
 */
function deleteWorldKeys(store: IDBObjectStore, worldId: string, factory: IDBFactory): void {
  const first: IDBValidKey = [worldId];
  const req = store.openKeyCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const key = cursor.key;
    if (Array.isArray(key) && key[0] === worldId) {
      store.delete(cursor.primaryKey);
      cursor.continue();
    } else if (factory.cmp(key, first) < 0) {
      cursor.continue(first);
    }
    // Otherwise we are past this world's keys: issue nothing and the transaction completes.
  };
}

export class IdbStorage implements SaveStorage {
  readonly dbName: string;
  private db: IDBDatabase | null = null;
  private factory: IDBFactory | null = null;
  private connecting: Promise<IDBDatabase> | null = null;
  /** Bumped by close(); a connection that finishes opening for an older generation is discarded. */
  private generation = 0;
  /** Why the previous connection was dropped (added to the next connection error). */
  private lostReason: string | null = null;

  /** Cheap: nothing is opened until the first operation (or use IdbStorage.open). */
  constructor(dbName: string = DEFAULT_DB_NAME) {
    if (typeof dbName !== 'string' || dbName.length === 0) throw new TypeError('IdbStorage: dbName must be a non-empty string');
    this.dbName = dbName;
  }

  /** Open (creating or upgrading the schema) and return a ready storage. Rejects on failure. */
  static async open(dbName: string = DEFAULT_DB_NAME): Promise<IdbStorage> {
    const storage = new IdbStorage(dbName);
    await storage.connection();
    return storage;
  }

  /**
   * Close the connection. Transactions already started still finish; the next operation
   * reopens the database.
   */
  close(): void {
    this.generation++;
    const db = this.db;
    this.db = null;
    this.lostReason = null;
    db?.close();
  }

  /** A tiny read transaction: resolves when the database is actually usable. */
  async ping(): Promise<void> {
    await this.run('ping', [META], 'readonly', (tx) => {
      tx.objectStore(META).count();
      return () => undefined;
    });
  }

  // ------------------------------------------------------------ SaveStorage

  async listWorlds(): Promise<WorldMeta[]> {
    return this.run('listWorlds', [META], 'readonly', (tx) => {
      const req = tx.objectStore(META).getAll();
      return () => {
        const out: WorldMeta[] = [];
        // A corrupted record must not hide every other world: skip it here; getMeta on its
        // id reports the problem.
        for (const rec of req.result as unknown[]) if (metaProblem(rec) === null) out.push(copyMeta(rec as WorldMeta));
        return out.sort(compareWorldsByRecency);
      };
    });
  }

  async getMeta(worldId: string): Promise<WorldMeta | null> {
    checkWorldId(worldId, 'getMeta');
    return this.run(`getMeta("${worldId}")`, [META], 'readonly', (tx) => {
      const req = tx.objectStore(META).get(worldId);
      return () => {
        const rec: unknown = req.result;
        if (rec === undefined) return null;
        const problem = metaProblem(rec);
        if (problem) throw new SaveFormatError(`world meta "${worldId}": stored record is invalid: ${problem}`);
        return copyMeta(rec as WorldMeta);
      };
    });
  }

  async putMeta(meta: WorldMeta): Promise<void> {
    const m = snapshotMeta(meta, 'putMeta');
    await this.run(`putMeta("${m.id}")`, [META], 'readwrite', (tx) => {
      tx.objectStore(META).put(m);
      return () => undefined;
    });
  }

  async deleteWorld(worldId: string): Promise<void> {
    checkWorldId(worldId, 'deleteWorld');
    await this.run(`deleteWorld("${worldId}")`, ALL_STORES, 'readwrite', (tx, factory) => {
      tx.objectStore(META).delete(worldId);
      deleteWorldKeys(tx.objectStore(CHUNKS), worldId, factory);
      deleteWorldKeys(tx.objectStore(BLOBS), worldId, factory);
      return () => undefined;
    });
  }

  async getChunk(worldId: string, key: number): Promise<Uint8Array | null> {
    checkWorldId(worldId, 'getChunk');
    checkChunkKey(key, 'getChunk');
    const op = `getChunk("${worldId}", ${key})`;
    return this.run(op, [CHUNKS], 'readonly', (tx) => {
      const req = tx.objectStore(CHUNKS).get([worldId, key]);
      return () => storedBytes(req.result, op);
    });
  }

  async getChunks(worldId: string, keys: readonly number[]): Promise<Array<Uint8Array | null>> {
    checkWorldId(worldId, 'getChunks');
    if (!Array.isArray(keys)) throw new TypeError('getChunks: keys must be an array');
    for (let i = 0; i < keys.length; i++) checkChunkKey(keys[i], 'getChunks');
    if (keys.length === 0) return [];
    const op = `getChunks("${worldId}")`;
    const wanted = keys.slice(); // the caller may mutate its array while we wait
    return this.run(op, [CHUNKS], 'readonly', (tx) => {
      const store = tx.objectStore(CHUNKS);
      const reqs = wanted.map((k) => store.get([worldId, k]));
      return () => reqs.map((r, i) => storedBytes(r.result, `${op} key ${wanted[i]}`));
    });
  }

  async putChunks(worldId: string, entries: ReadonlyArray<readonly [number, Uint8Array]>): Promise<void> {
    checkWorldId(worldId, 'putChunks');
    const copies = snapshotChunks(entries, 'putChunks');
    if (copies.length === 0) return;
    await this.run(`putChunks("${worldId}")`, [CHUNKS], 'readwrite', (tx) => {
      const store = tx.objectStore(CHUNKS);
      for (const [k, b] of copies) store.put(b, [worldId, k]);
      return () => undefined;
    });
  }

  async getBlob(worldId: string, name: string): Promise<Uint8Array | null> {
    checkWorldId(worldId, 'getBlob');
    checkBlobName(name, 'getBlob');
    const op = `getBlob("${worldId}", "${name}")`;
    return this.run(op, [BLOBS], 'readonly', (tx) => {
      const req = tx.objectStore(BLOBS).get([worldId, name]);
      return () => storedBytes(req.result, op);
    });
  }

  async putBlob(worldId: string, name: string, bytes: Uint8Array): Promise<void> {
    checkWorldId(worldId, 'putBlob');
    checkBlobName(name, 'putBlob');
    const copy = snapshotBytes(bytes, 'putBlob', 'bytes');
    await this.run(`putBlob("${worldId}", "${name}")`, [BLOBS], 'readwrite', (tx) => {
      tx.objectStore(BLOBS).put(copy, [worldId, name]);
      return () => undefined;
    });
  }

  async putAll(
    worldId: string,
    meta: WorldMeta,
    chunks: ReadonlyArray<readonly [number, Uint8Array]>,
    blobs: ReadonlyArray<readonly [string, Uint8Array]>,
  ): Promise<void> {
    checkWorldId(worldId, 'putAll');
    const m = snapshotMeta(meta, 'putAll');
    if (m.id !== worldId) throw new TypeError(`putAll: meta.id "${m.id}" does not match world id "${worldId}"`);
    const chunkCopies = snapshotChunks(chunks, 'putAll');
    const blobCopies = snapshotBlobs(blobs, 'putAll');
    // 'strict' durability: this is the save commit, it should survive a power cut once resolved.
    await this.run(
      `putAll("${worldId}")`,
      ALL_STORES,
      'readwrite',
      (tx) => {
        tx.objectStore(META).put(m);
        const cs = tx.objectStore(CHUNKS);
        for (const [k, b] of chunkCopies) cs.put(b, [worldId, k]);
        const bs = tx.objectStore(BLOBS);
        for (const [n, b] of blobCopies) bs.put(b, [worldId, n]);
        return () => undefined;
      },
      { durability: 'strict' },
    );
  }

  // ------------------------------------------------------------ internals

  private where(op: string): string {
    return `IndexedDB "${this.dbName}" ${op}`;
  }

  /** The open connection, opening (and upgrading) the database when needed. */
  private connection(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (!this.connecting) {
      const gen = this.generation;
      const lost = this.lostReason;
      this.connecting = this.openDatabase(lost).then(
        ({ db, factory }) => {
          this.connecting = null;
          if (gen !== this.generation) {
            db.close();
            throw new SaveStorageError(`${this.where('open')}: storage was closed while opening`);
          }
          this.attach(db, factory);
          return db;
        },
        (err: unknown) => {
          this.connecting = null;
          throw err;
        },
      );
    }
    return this.connecting;
  }

  private attach(db: IDBDatabase, factory: IDBFactory): void {
    this.db = db;
    this.factory = factory;
    this.lostReason = null;
    // Another tab wants to upgrade or delete the database: step aside immediately, otherwise
    // its request stays blocked. The next operation here reconnects.
    db.onversionchange = () => {
      db.close();
      if (this.db === db) {
        this.db = null;
        this.lostReason = 'another tab upgraded or deleted the save database';
      }
    };
    // The browser can close connections itself (site data cleared, storage failure).
    db.onclose = () => {
      if (this.db === db) {
        this.db = null;
        this.lostReason = 'the browser closed the database connection';
      }
    };
  }

  private openDatabase(lostReason: string | null): Promise<{ db: IDBDatabase; factory: IDBFactory }> {
    const where = this.where('open');
    const context = lostReason ? ` after ${lostReason}` : '';
    return new Promise((resolve, reject) => {
      const factory = indexedDBFactory();
      if (!factory) {
        reject(new SaveStorageError(`${where}: IndexedDB is not available in this environment`));
        return;
      }
      let settled = false;
      const fail = (message: string, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        reject(new SaveStorageError(`${where}${context}: ${message}`, { cause }));
      };
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(this.dbName, DB_VERSION);
      } catch (e) {
        fail(`cannot open the database: ${explain(e)}`, e);
        return;
      }
      req.onupgradeneeded = () => {
        // Runs inside the versionchange transaction; a throw here aborts the upgrade and the
        // open request then fails through onerror.
        const db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) {
          // We already gave up (blocked); do not leak a connection that would block others.
          db.close();
          return;
        }
        for (const name of ALL_STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.close();
            fail(`the database exists but has no "${name}" store (not a Blocklands save database?)`);
            return;
          }
        }
        settled = true;
        resolve({ db, factory });
      };
      req.onerror = () => {
        let err: unknown = null;
        try {
          err = req.error;
        } catch {
          // reading .error can itself throw on a broken request
        }
        fail(`cannot open the database: ${explain(err)}`, err);
      };
      req.onblocked = () => {
        fail('the database upgrade is blocked by another open Blocklands tab; close it and retry');
      };
    });
  }

  /**
   * Run one transaction. `body` must issue all its requests synchronously and returns a
   * function that builds the result once the transaction has COMMITTED (request results are
   * still readable then). Resolves only on `complete`, so a resolved write is durable as far
   * as IndexedDB promises; rejects on error/abort (all writes of the transaction undone).
   */
  private async run<T>(
    op: string,
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction, factory: IDBFactory) => () => T,
    options?: IDBTransactionOptions,
  ): Promise<T> {
    let db = await this.connection();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode, options);
    } catch (first) {
      // The connection may have been closed under us between calls; retry once on a fresh one.
      if (this.db === db) {
        this.db = null;
        this.lostReason = `the connection failed (${explain(first)})`;
      }
      try {
        db.close(); // release it either way (closing twice is harmless)
      } catch {
        // already closed
      }
      db = await this.connection();
      try {
        tx = db.transaction(stores, mode, options);
      } catch (e) {
        throw new SaveStorageError(`${this.where(op)}: cannot start a transaction: ${explain(e)}`, { cause: e });
      }
    }
    const factory = this.factory!;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let firstError: unknown = null;
      let finish: (() => T) | null = null;
      tx.oncomplete = () => {
        if (done) return;
        done = true;
        try {
          resolve(finish!());
        } catch (e) {
          reject(e);
        }
      };
      tx.onerror = (ev: Event) => {
        if (firstError === null) firstError = (ev.target as IDBRequest | null)?.error ?? null;
      };
      tx.onabort = () => {
        if (done) return;
        done = true;
        const cause: unknown = tx.error ?? firstError;
        reject(new SaveStorageError(`${this.where(op)}: transaction aborted: ${explain(cause ?? 'no reason given')}`, { cause }));
      };
      try {
        finish = body(tx, factory);
      } catch (e) {
        // A request threw synchronously (bad key, uncloneable value ...): abort so that the
        // requests already issued in this transaction are rolled back too.
        try {
          tx.abort();
        } catch {
          // already finished
        }
        if (!done) {
          done = true;
          reject(
            e instanceof SaveFormatError || e instanceof TypeError
              ? e
              : new SaveStorageError(`${this.where(op)}: ${explain(e)}`, { cause: e }),
          );
        }
      }
    });
  }
}

/** Options for openBestStorage. */
export interface OpenBestStorageOptions {
  /**
   * Settles when the caller stops waiting for IndexedDB, e.g. a timeout promise made by the
   * client (this module has no timers). A few embedded browsers never answer an open
   * request; with this the game falls back to memory instead of waiting forever. A
   * connection that opens after giving up is closed.
   */
  giveUp?: PromiseLike<unknown>;
}

/**
 * The best storage this environment offers: IdbStorage when IndexedDB exists and opening
 * plus a tiny read succeed, otherwise MemoryStorage with persistent = false (sandboxed
 * iframes, privacy modes, broken storage). Never rejects.
 */
export async function openBestStorage(
  dbName: string = DEFAULT_DB_NAME,
  options: OpenBestStorageOptions = {},
): Promise<{ storage: SaveStorage; persistent: boolean }> {
  try {
    if (indexedDBFactory()) {
      const attempt = (async () => {
        const storage = await IdbStorage.open(dbName);
        try {
          await storage.ping();
        } catch (e) {
          storage.close();
          throw e;
        }
        return storage;
      })();
      const giveUp = options.giveUp;
      try {
        const storage = giveUp ? await raceGiveUp(attempt, giveUp) : await attempt;
        return { storage, persistent: true };
      } catch {
        // If the attempt still succeeds later, release that connection.
        attempt.then(
          (s) => s.close(),
          () => undefined,
        );
      }
    }
  } catch {
    // Anything unexpected (hostile globals, exotic environments): fall back below.
  }
  return { storage: new MemoryStorage(), persistent: false };
}

function raceGiveUp<T>(p: Promise<T>, giveUp: PromiseLike<unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject);
    const stop = (): void => reject(new SaveStorageError('gave up waiting for IndexedDB'));
    giveUp.then(stop, stop);
  });
}
