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
 *    abort; opening also handles `blocked`. A failure rejects with SaveStorageError (backend,
 *    with a `code`), TypeError (bad argument) or SaveFormatError (a stored record is not what
 *    we wrote).
 *  - All arguments are validated and all bytes snapshotted before the first await, so a
 *    rejected call has written nothing and later mutation of the caller's arrays is harmless.
 *  - One call = one transaction, so every method is atomic; putAll spans all three stores.
 *    Writes first read the world's meta in the same transaction and abort if they would
 *    downgrade a world saved by a newer build (the SaveStorage downgrade guard).
 *
 * Connection lifecycle:
 *  - The connection opens lazily on the first call (or with IdbStorage.open). Calls made while
 *    it opens queue behind the open; queued and later calls create their transactions in the
 *    order they were made, so their effects apply in call order.
 *  - When the connection is open and nothing is queued, a call creates its transaction
 *    synchronously, inside the call itself. Nothing can slip in between, in particular not a
 *    close() made right after the call.
 *  - close() is like IDBDatabase.close(): calls already made still complete (the connection
 *    closes once the last of them has started its transaction, and IndexedDB lets started
 *    transactions finish); calls made after close() open a fresh connection. A call made before
 *    close() never reopens the database, and a call made after it never inherits the old one.
 *  - When another tab upgrades or deletes the database we close our connection at once so we
 *    never block it, and the next call reconnects (and fails with code 'newer-version' if the
 *    database now belongs to a newer build). Same when the browser closes the connection.
 *
 * Only the `indexedDB` global is touched (through globalThis). Key ranges would need the
 * separate IDBKeyRange global, so per-world scans walk a key cursor instead; it jumps
 * straight to the world's first key, so it never scans other worlds.
 */
import { SaveFormatError, isUint8Array } from './bytes';
import { SAVE_VERSION, copyMeta, metaProblem, type WorldMeta } from './codec';
import {
  MemoryStorage,
  SaveStorageError,
  checkBlobName,
  checkChunkKey,
  checkWorldId,
  compareWorldsByRecency,
  downgradeError,
  snapshotBlobs,
  snapshotBytes,
  snapshotChunks,
  snapshotMeta,
  type SaveStorage,
  type SaveStorageErrorCode,
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

function errorName(e: unknown): string | null {
  if (e && typeof e === 'object') {
    const name = (e as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return null;
}

/** "hint (Name: message)" for DOMExceptions and errors, String(e) for anything else. */
function explain(e: unknown): string {
  const name = errorName(e);
  if (name !== null) {
    const message = (e as { message?: unknown }).message;
    const detail = typeof message === 'string' && message ? `${name}: ${message}` : name;
    const hint = HINTS[name];
    return hint ? `${hint} (${detail})` : detail;
  }
  return String(e ?? 'unknown error');
}

/** SaveStorageError code for a DOMException raised by a request or transaction. */
function codeOf(e: unknown, fallback: SaveStorageErrorCode): SaveStorageErrorCode {
  switch (errorName(e)) {
    case 'VersionError':
      return 'newer-version';
    case 'QuotaExceededError':
      return 'quota';
    case 'SecurityError':
      return 'unavailable';
    default:
      return fallback;
  }
}

function closeQuietly(db: IDBDatabase): void {
  try {
    db.close(); // closing twice is harmless, but a hostile/broken object may throw
  } catch {
    // already closed
  }
}

/** Stored chunk/blob value -> bytes. IndexedDB returns a fresh clone, so no copy is needed. */
function storedBytes(value: unknown, what: string): Uint8Array | null {
  if (value === undefined) return null;
  if (isUint8Array(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new SaveFormatError(`${what}: stored record is not binary data`);
}

/**
 * Visit every key [worldId, ...] of `store`, in key order, with a key cursor. One world's keys
 * are contiguous (arrays compare element-wise), so jump to [worldId] and stop at the first
 * key of another world: other worlds are never scanned.
 */
function walkWorldKeys(
  store: IDBObjectStore,
  worldId: string,
  factory: IDBFactory,
  visit: (key: readonly unknown[], cursor: IDBCursor) => void,
): void {
  const first: IDBValidKey = [worldId];
  const req = store.openKeyCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const key = cursor.key;
    if (Array.isArray(key) && key[0] === worldId) {
      visit(key, cursor);
      cursor.continue();
    } else if (factory.cmp(key, first) < 0) {
      cursor.continue(first);
    }
    // Otherwise we are past this world's keys: issue nothing and the transaction completes.
  };
}

/** Add the world id of every key [worldId, ...] of `store`, visiting one key per world. */
function collectWorldIds(store: IDBObjectStore, factory: IDBFactory, ids: Set<string>): void {
  const req = store.openKeyCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const key = cursor.key;
    if (Array.isArray(key) && typeof key[0] === 'string') {
      ids.add(key[0]);
      // Arrays are the highest key type, so [id, []] sorts after every [id, number | string]
      // key we store: jumping there skips the rest of this world in one step.
      const next: IDBValidKey = [key[0], []];
      if (factory.cmp(next, key) > 0) {
        cursor.continue(next);
        return;
      }
    }
    cursor.continue();
  };
}

/** What a transaction body can use besides the transaction itself. */
interface TxContext {
  readonly factory: IDBFactory;
  /** Abort the transaction and reject the call with `error` instead of a generic message. */
  fail(error: Error): void;
}

/**
 * Issues a transaction's requests synchronously and returns a function that builds the
 * result once the transaction has COMMITTED (request results are still readable then).
 */
type TxBody<T> = (tx: IDBTransaction, ctx: TxContext) => () => T;

/**
 * Downgrade guard: read the world's meta first, and abort the whole transaction (rolling back
 * every write in it) if it is newer than `written`. Must be issued before the writes.
 */
function guardDowngrade(tx: IDBTransaction, ctx: TxContext, worldId: string, written: number, op: string): void {
  const req = tx.objectStore(META).get(worldId);
  req.onsuccess = () => {
    const error = downgradeError(req.result, written, worldId, op);
    if (error) ctx.fail(error);
  };
}

/** One open request and, once it succeeds, the connection it produced. */
class Connection {
  /** Settles with the open request: the database, or the open error. */
  ready!: Promise<IDBDatabase>;
  db: IDBDatabase | null = null;
  factory: IDBFactory | null = null;
  /** Calls waiting on `ready` that have not created their transaction yet. */
  waiting = 0;
  /** No new call may use this connection; it is closed as soon as nobody waits on it. */
  retired = false;
}

export class IdbStorage implements SaveStorage {
  readonly dbName: string;
  /** The connection new calls use (open or opening); null until needed or after close(). */
  private current: Connection | null = null;
  /** Bumped by close(): a call made before it must not reopen the database. */
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
    const conn = storage.connect();
    conn.waiting++;
    try {
      await conn.ready;
    } finally {
      conn.waiting--;
      storage.release(conn);
    }
    return storage;
  }

  /**
   * Stop using the current connection. Calls already made still complete on it (it closes
   * once they have started their transactions); the next call opens a fresh connection.
   * The one exception: if that old connection itself breaks before such a call could start,
   * the call rejects with code 'closed' instead of reopening the database. Idempotent.
   */
  close(): void {
    this.generation++;
    const conn = this.current;
    if (conn) this.retire(conn, null);
    this.lostReason = null;
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
        // id reports the problem, and listWorldIds still finds it.
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
    const op = `putMeta("${m.id}")`;
    await this.run(op, [META], 'readwrite', (tx, ctx) => {
      guardDowngrade(tx, ctx, m.id, m.version, this.where(op));
      tx.objectStore(META).put(m);
      return () => undefined;
    });
  }

  async deleteWorld(worldId: string): Promise<void> {
    checkWorldId(worldId, 'deleteWorld');
    await this.run(`deleteWorld("${worldId}")`, ALL_STORES, 'readwrite', (tx, { factory }) => {
      tx.objectStore(META).delete(worldId);
      for (const name of [CHUNKS, BLOBS]) {
        const store = tx.objectStore(name);
        // A key cursor has no cursor.delete() (that needs a value cursor): delete by key.
        walkWorldKeys(store, worldId, factory, (_key, cursor) => store.delete(cursor.primaryKey));
      }
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
    const op = `putChunks("${worldId}")`;
    await this.run(op, [META, CHUNKS], 'readwrite', (tx, ctx) => {
      guardDowngrade(tx, ctx, worldId, SAVE_VERSION, this.where(op));
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
    const op = `putBlob("${worldId}", "${name}")`;
    await this.run(op, [META, BLOBS], 'readwrite', (tx, ctx) => {
      guardDowngrade(tx, ctx, worldId, SAVE_VERSION, this.where(op));
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
    const op = `putAll("${worldId}")`;
    // 'strict' durability: this is the save commit, it should survive a power cut once resolved.
    await this.run(
      op,
      ALL_STORES,
      'readwrite',
      (tx, ctx) => {
        guardDowngrade(tx, ctx, worldId, m.version, this.where(op));
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

  async listChunkKeys(worldId: string): Promise<number[]> {
    checkWorldId(worldId, 'listChunkKeys');
    return this.run(`listChunkKeys("${worldId}")`, [CHUNKS], 'readonly', (tx, { factory }) => {
      const keys: number[] = [];
      walkWorldKeys(tx.objectStore(CHUNKS), worldId, factory, (key) => {
        // Only keys getChunk can address (we never write others; skip foreign junk).
        const k = key[1];
        if (key.length === 2 && typeof k === 'number' && Number.isSafeInteger(k) && k >= 0) keys.push(k);
      });
      return () => keys; // key order = ascending numbers
    });
  }

  async listWorldIds(): Promise<string[]> {
    return this.run('listWorldIds', ALL_STORES, 'readonly', (tx, { factory }) => {
      const ids = new Set<string>();
      const metaKeys = tx.objectStore(META).getAllKeys();
      metaKeys.onsuccess = () => {
        for (const k of metaKeys.result) if (typeof k === 'string') ids.add(k);
      };
      collectWorldIds(tx.objectStore(CHUNKS), factory, ids);
      collectWorldIds(tx.objectStore(BLOBS), factory, ids);
      return () => [...ids].sort();
    });
  }

  // ------------------------------------------------------------ internals

  private where(op: string): string {
    return `IndexedDB "${this.dbName}" ${op}`;
  }

  /** Start opening a new connection and make it the current one. */
  private connect(): Connection {
    const conn = new Connection();
    const lost = this.lostReason;
    conn.ready = this.openDatabase(lost).then(
      ({ db, factory }) => {
        conn.db = db;
        conn.factory = factory;
        if (this.current === conn) this.lostReason = null;
        // Another tab wants to upgrade or delete the database: step aside immediately,
        // otherwise its request stays blocked. The next call here reconnects.
        db.onversionchange = () => this.retire(conn, 'another tab upgraded or deleted the save database');
        // The browser can close connections itself (site data cleared, storage failure).
        db.onclose = () => this.retire(conn, 'the browser closed the database connection');
        // close() came while opening and no call is waiting for this connection.
        this.release(conn);
        return db;
      },
      (err: unknown) => {
        if (this.current === conn) this.current = null; // the next call retries the open
        throw err;
      },
    );
    // Every waiter handles the rejection; this only keeps an unobserved one from being
    // reported as unhandled.
    conn.ready.catch(() => undefined);
    this.current = conn;
    return conn;
  }

  /** No new call may use `conn`; close it as soon as nobody waits on it. */
  private retire(conn: Connection, reason: string | null): void {
    conn.retired = true;
    if (this.current === conn) {
      this.current = null;
      this.lostReason = reason;
    }
    this.release(conn);
  }

  /** Close a retired connection once the last call queued on it has started its transaction. */
  private release(conn: Connection): void {
    if (conn.retired && conn.waiting === 0 && conn.db) closeQuietly(conn.db);
  }

  private openDatabase(lostReason: string | null): Promise<{ db: IDBDatabase; factory: IDBFactory }> {
    const where = this.where('open');
    const context = lostReason ? ` after ${lostReason}` : '';
    return new Promise((resolve, reject) => {
      const factory = indexedDBFactory();
      if (!factory) {
        reject(new SaveStorageError(`${where}: IndexedDB is not available in this environment`, { code: 'unavailable' }));
        return;
      }
      let settled = false;
      const fail = (message: string, code: SaveStorageErrorCode, cause?: unknown): void => {
        if (settled) return;
        settled = true;
        reject(new SaveStorageError(`${where}${context}: ${message}`, { code, cause }));
      };
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(this.dbName, DB_VERSION);
      } catch (e) {
        // SecurityError in opaque origins; anything thrown here means "not usable here".
        fail(`cannot open the database: ${explain(e)}`, codeOf(e, 'unavailable'), e);
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
          closeQuietly(db);
          return;
        }
        for (const name of ALL_STORES) {
          if (!db.objectStoreNames.contains(name)) {
            closeQuietly(db);
            fail(`the database exists but has no "${name}" store (not a Blocklands save database?)`, 'incompatible');
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
        // Private modes report InvalidStateError/UnknownError here: storage is just not usable.
        fail(`cannot open the database: ${explain(err)}`, codeOf(err, 'unavailable'), err);
      };
      req.onblocked = () => {
        fail('the database upgrade is blocked by another open Blocklands tab; close it and retry', 'blocked');
      };
    });
  }

  /**
   * Run one transaction (see TxBody). Resolves only on `complete`, so a resolved write is
   * durable as far as IndexedDB promises; rejects on error/abort (all writes of the
   * transaction undone).
   */
  private async run<T>(
    op: string,
    stores: string[],
    mode: IDBTransactionMode,
    body: TxBody<T>,
    options?: IDBTransactionOptions,
  ): Promise<T> {
    const generation = this.generation;
    for (let attempt = 0; ; attempt++) {
      const conn = this.current ?? this.connect();
      // Queue behind the open, or behind calls already queued, so transactions are created
      // in call order. Otherwise start right now, synchronously (see the file comment).
      const queued = conn.db === null || conn.waiting > 0;
      let db: IDBDatabase;
      if (queued) {
        conn.waiting++;
        try {
          db = await conn.ready;
        } catch (e) {
          conn.waiting--;
          throw e;
        }
        conn.waiting--;
      } else {
        db = conn.db!;
      }
      try {
        // Returns as soon as the transaction exists; `finally` then releases the connection.
        return this.execute(db, conn.factory!, op, stores, mode, body, options);
      } catch (e) {
        // db.transaction() threw: this connection is dead (closed by the browser, broken
        // backend). Drop it and retry once on a fresh one — unless close() came after this
        // call was made: a call never reopens a storage that was closed after it.
        this.retire(conn, `the connection failed (${explain(e)})`);
        if (generation !== this.generation) {
          throw new SaveStorageError(`${this.where(op)}: the connection failed after the storage was closed: ${explain(e)}`, {
            code: 'closed',
            cause: e,
          });
        }
        if (attempt > 0) {
          throw new SaveStorageError(`${this.where(op)}: cannot start a transaction: ${explain(e)}`, {
            code: codeOf(e, 'failed'),
            cause: e,
          });
        }
      } finally {
        if (queued) this.release(conn);
      }
    }
  }

  /**
   * Create the transaction and issue its requests, all synchronously. Throws only when the
   * transaction cannot be created; every later failure rejects the returned promise.
   */
  private execute<T>(
    db: IDBDatabase,
    factory: IDBFactory,
    op: string,
    stores: string[],
    mode: IDBTransactionMode,
    body: TxBody<T>,
    options: IDBTransactionOptions | undefined,
  ): Promise<T> {
    const tx = db.transaction(stores, mode, options);
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let failure: Error | null = null;
      let firstError: unknown = null;
      let finish: (() => T) | null = null;
      tx.oncomplete = () => {
        if (done) return;
        done = true;
        if (failure) {
          reject(failure); // fail() came too late to abort; still report it
          return;
        }
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
        if (failure) {
          reject(failure);
          return;
        }
        const cause: unknown = tx.error ?? firstError;
        reject(
          new SaveStorageError(`${this.where(op)}: transaction aborted: ${explain(cause ?? 'no reason given')}`, {
            code: codeOf(cause, 'failed'),
            cause,
          }),
        );
      };
      const ctx: TxContext = {
        factory,
        fail(error: Error): void {
          if (failure === null) failure = error;
          try {
            tx.abort();
          } catch {
            // already finished
          }
        },
      };
      try {
        finish = body(tx, ctx);
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
            e instanceof SaveFormatError || e instanceof TypeError || e instanceof SaveStorageError
              ? e
              : new SaveStorageError(`${this.where(op)}: ${explain(e)}`, { code: codeOf(e, 'failed'), cause: e }),
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
   * client (this module has no timers). Strongly recommended (a few seconds): some embedded
   * and WebKit builds never answer an open request, and without this the game would wait
   * forever. A connection that opens after giving up is closed.
   */
  giveUp?: PromiseLike<unknown>;
}

/** Result of openBestStorage. When not persistent, `reason` says why (= error.code). */
export type BestStorage =
  | { storage: IdbStorage; persistent: true }
  | { storage: MemoryStorage; persistent: false; reason: SaveStorageErrorCode; error: SaveStorageError };

/**
 * The best storage this environment offers: IdbStorage when IndexedDB exists and opening
 * plus a tiny read succeed, otherwise a fresh MemoryStorage with persistent = false and the
 * reason (sandboxed iframes and privacy modes: 'unavailable'; a database from a newer build:
 * 'newer-version'; another tab blocking the upgrade: 'blocked'; giveUp first: 'timeout' ...).
 * The client must tell the player before letting them play on memory, and for
 * 'newer-version' should ask them to update rather than start a world. Never rejects.
 */
export async function openBestStorage(
  dbName: string = DEFAULT_DB_NAME,
  options: OpenBestStorageOptions = {},
): Promise<BestStorage> {
  let failure: unknown;
  try {
    if (!indexedDBFactory()) {
      failure = new SaveStorageError(`IndexedDB "${dbName}" open: IndexedDB is not available in this environment`, {
        code: 'unavailable',
      });
    } else {
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
        const storage = giveUp ? await raceGiveUp(attempt, giveUp, dbName) : await attempt;
        return { storage, persistent: true };
      } catch (e) {
        failure = e;
        // If the attempt still succeeds later, release that connection.
        attempt.then(
          (s) => s.close(),
          () => undefined,
        );
      }
    }
  } catch (e) {
    // Anything unexpected (hostile globals, a bad dbName, exotic environments).
    failure = e;
  }
  const error =
    failure instanceof SaveStorageError
      ? failure
      : new SaveStorageError(`IndexedDB "${String(dbName)}": ${explain(failure)}`, { code: 'failed', cause: failure });
  return { storage: new MemoryStorage(), persistent: false, reason: error.code, error };
}

function raceGiveUp<T>(p: Promise<T>, giveUp: PromiseLike<unknown>, dbName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    p.then(resolve, reject);
    const stop = (): void => reject(new SaveStorageError(`IndexedDB "${dbName}" open: gave up waiting`, { code: 'timeout' }));
    giveUp.then(stop, stop);
  });
}
