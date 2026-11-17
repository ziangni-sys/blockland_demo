/**
 * Storage adapters: where save blobs live. The SaveStorage interface is deliberately dumb —
 * opaque byte records keyed by world — so the codecs stay pure and the backend can be
 * swapped (IndexedDB in browsers, memory in tests or when IndexedDB is unavailable).
 *
 * Shared contract of every adapter (tests run one behavioural suite against all of them):
 *  - Every method returns a Promise and reports failures by REJECTING it, never by throwing
 *    synchronously. Invalid arguments reject with TypeError; corrupted stored records with
 *    SaveFormatError; backend failures with SaveStorageError.
 *  - Bytes are snapshotted when the call is made: mutating the caller's array afterwards —
 *    even before the promise settles — does not change what is stored. Returned arrays are
 *    fresh copies the caller owns.
 *  - Writes are upserts. putAll in particular commits exactly the records passed (meta,
 *    modified chunks, blobs) atomically and leaves the world's other records alone.
 */
import { isUint8Array } from './bytes';
import { META_MAX_ID_LENGTH, copyMeta, validateMeta, type WorldMeta } from './codec';

export interface SaveStorage {
  /** All worlds, newest lastPlayed first. */
  listWorlds(): Promise<WorldMeta[]>;
  getMeta(worldId: string): Promise<WorldMeta | null>;
  putMeta(meta: WorldMeta): Promise<void>;
  /** Removes meta, chunks and blobs of that world only. Deleting an unknown world is a no-op. */
  deleteWorld(worldId: string): Promise<void>;
  /** key = chunkKey(cx, cz). */
  getChunk(worldId: string, key: number): Promise<Uint8Array | null>;
  /** Same order as keys; null for chunks never saved. */
  getChunks(worldId: string, keys: readonly number[]): Promise<Array<Uint8Array | null>>;
  putChunks(worldId: string, entries: ReadonlyArray<readonly [number, Uint8Array]>): Promise<void>;
  /** Named binary blobs: 'structures', 'glue', 'entities', 'ticks', 'player' ... */
  getBlob(worldId: string, name: string): Promise<Uint8Array | null>;
  putBlob(worldId: string, name: string, bytes: Uint8Array): Promise<void>;
  /** One atomic commit of everything (all or nothing). meta.id must equal worldId. */
  putAll(
    worldId: string,
    meta: WorldMeta,
    chunks: ReadonlyArray<readonly [number, Uint8Array]>,
    blobs: ReadonlyArray<readonly [string, Uint8Array]>,
  ): Promise<void>;
}

/** A storage backend failed (quota, connection closed, blocked upgrade, aborted transaction ...). */
export class SaveStorageError extends Error {
  override readonly name = 'SaveStorageError';
}

export const BLOB_NAME_MAX_LENGTH = 128;

// ====================================================================== shared helpers

/** Newest lastPlayed first; ties by newest createdAt, then id, so the order is total. */
export function compareWorldsByRecency(a: WorldMeta, b: WorldMeta): number {
  return b.lastPlayed - a.lastPlayed || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function checkWorldId(worldId: unknown, op: string): asserts worldId is string {
  if (typeof worldId !== 'string' || worldId.length < 1 || worldId.length > META_MAX_ID_LENGTH) {
    throw new TypeError(`${op}: world id must be a string of 1..${META_MAX_ID_LENGTH} characters`);
  }
}

export function checkChunkKey(key: unknown, op: string): asserts key is number {
  if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0) {
    throw new TypeError(`${op}: chunk key must be a non-negative safe integer (chunkKey(cx, cz)), got ${String(key)}`);
  }
}

export function checkBlobName(name: unknown, op: string): asserts name is string {
  if (typeof name !== 'string' || name.length < 1 || name.length > BLOB_NAME_MAX_LENGTH) {
    throw new TypeError(`${op}: blob name must be a string of 1..${BLOB_NAME_MAX_LENGTH} characters`);
  }
}

/**
 * Validate and snapshot bytes. `new Uint8Array(view)` always allocates a tight, plain copy:
 * no aliasing with the caller, no oversized backing buffer from a subarray, and no
 * subclass (Buffer) whose slice() would alias.
 */
export function snapshotBytes(bytes: unknown, op: string, what: string): Uint8Array {
  if (!isUint8Array(bytes)) throw new TypeError(`${op}: ${what} must be a Uint8Array`);
  return new Uint8Array(bytes);
}

/** Validate and snapshot (key, bytes) chunk entries. */
export function snapshotChunks(
  entries: ReadonlyArray<readonly [number, Uint8Array]>,
  op: string,
): Array<[number, Uint8Array]> {
  if (!Array.isArray(entries)) throw new TypeError(`${op}: chunks must be an array of [key, bytes] pairs`);
  const out: Array<[number, Uint8Array]> = new Array<[number, Uint8Array]>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e: unknown = entries[i];
    if (!Array.isArray(e) || e.length !== 2) throw new TypeError(`${op}: chunk entry ${i} must be a [key, bytes] pair`);
    checkChunkKey(e[0], `${op}: chunk entry ${i}`);
    out[i] = [e[0], snapshotBytes(e[1], op, `chunk entry ${i} bytes`)];
  }
  return out;
}

/** Validate and snapshot (name, bytes) blob entries. */
export function snapshotBlobs(
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
  op: string,
): Array<[string, Uint8Array]> {
  if (!Array.isArray(entries)) throw new TypeError(`${op}: blobs must be an array of [name, bytes] pairs`);
  const out: Array<[string, Uint8Array]> = new Array<[string, Uint8Array]>(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e: unknown = entries[i];
    if (!Array.isArray(e) || e.length !== 2) throw new TypeError(`${op}: blob entry ${i} must be a [name, bytes] pair`);
    checkBlobName(e[0], `${op}: blob entry ${i}`);
    out[i] = [e[0], snapshotBytes(e[1], op, `blob entry ${i} bytes`)];
  }
  return out;
}

/** Validate meta and return a normalised copy (exactly the WorldMeta fields). */
export function snapshotMeta(meta: unknown, op: string): WorldMeta {
  try {
    validateMeta(meta);
  } catch (e) {
    throw new TypeError(`${op}: ${(e as Error).message}`);
  }
  return copyMeta(meta);
}

// ====================================================================== memory adapter

/**
 * In-memory SaveStorage: used by headless tests and as the fallback when IndexedDB is not
 * available (nothing survives a reload). Bytes are copied on the way in AND out, so a
 * caller that wrongly relies on aliasing — mutating after a put, or mutating a returned
 * array and expecting it to be saved — fails in tests exactly as it would with IndexedDB.
 */
export class MemoryStorage implements SaveStorage {
  private readonly metas = new Map<string, WorldMeta>();
  private readonly chunks = new Map<string, Map<number, Uint8Array>>();
  private readonly blobs = new Map<string, Map<string, Uint8Array>>();

  // Methods are `async` so argument errors become rejections, and so callers cannot come
  // to depend on synchronous completion. All copying happens before the first await.

  async listWorlds(): Promise<WorldMeta[]> {
    const out: WorldMeta[] = [];
    for (const m of this.metas.values()) out.push(copyMeta(m));
    return out.sort(compareWorldsByRecency);
  }

  async getMeta(worldId: string): Promise<WorldMeta | null> {
    checkWorldId(worldId, 'getMeta');
    const m = this.metas.get(worldId);
    return m ? copyMeta(m) : null;
  }

  async putMeta(meta: WorldMeta): Promise<void> {
    const m = snapshotMeta(meta, 'putMeta');
    this.metas.set(m.id, m);
  }

  async deleteWorld(worldId: string): Promise<void> {
    checkWorldId(worldId, 'deleteWorld');
    this.metas.delete(worldId);
    this.chunks.delete(worldId);
    this.blobs.delete(worldId);
  }

  async getChunk(worldId: string, key: number): Promise<Uint8Array | null> {
    checkWorldId(worldId, 'getChunk');
    checkChunkKey(key, 'getChunk');
    const b = this.chunks.get(worldId)?.get(key);
    return b ? new Uint8Array(b) : null;
  }

  async getChunks(worldId: string, keys: readonly number[]): Promise<Array<Uint8Array | null>> {
    checkWorldId(worldId, 'getChunks');
    if (!Array.isArray(keys)) throw new TypeError('getChunks: keys must be an array');
    for (let i = 0; i < keys.length; i++) checkChunkKey(keys[i], 'getChunks');
    const world = this.chunks.get(worldId);
    return keys.map((k) => {
      const b = world?.get(k);
      return b ? new Uint8Array(b) : null;
    });
  }

  async putChunks(worldId: string, entries: ReadonlyArray<readonly [number, Uint8Array]>): Promise<void> {
    checkWorldId(worldId, 'putChunks');
    const copies = snapshotChunks(entries, 'putChunks');
    if (copies.length > 0) this.writeChunks(worldId, copies);
  }

  async getBlob(worldId: string, name: string): Promise<Uint8Array | null> {
    checkWorldId(worldId, 'getBlob');
    checkBlobName(name, 'getBlob');
    const b = this.blobs.get(worldId)?.get(name);
    return b ? new Uint8Array(b) : null;
  }

  async putBlob(worldId: string, name: string, bytes: Uint8Array): Promise<void> {
    checkWorldId(worldId, 'putBlob');
    checkBlobName(name, 'putBlob');
    this.writeBlobs(worldId, [[name, snapshotBytes(bytes, 'putBlob', 'bytes')]]);
  }

  async putAll(
    worldId: string,
    meta: WorldMeta,
    chunks: ReadonlyArray<readonly [number, Uint8Array]>,
    blobs: ReadonlyArray<readonly [string, Uint8Array]>,
  ): Promise<void> {
    // Validate and copy everything first; mutate only once nothing can fail any more.
    checkWorldId(worldId, 'putAll');
    const m = snapshotMeta(meta, 'putAll');
    if (m.id !== worldId) throw new TypeError(`putAll: meta.id "${m.id}" does not match world id "${worldId}"`);
    const chunkCopies = snapshotChunks(chunks, 'putAll');
    const blobCopies = snapshotBlobs(blobs, 'putAll');
    this.metas.set(worldId, m);
    if (chunkCopies.length > 0) this.writeChunks(worldId, chunkCopies);
    if (blobCopies.length > 0) this.writeBlobs(worldId, blobCopies);
  }

  private writeChunks(worldId: string, entries: ReadonlyArray<readonly [number, Uint8Array]>): void {
    let world = this.chunks.get(worldId);
    if (!world) {
      world = new Map();
      this.chunks.set(worldId, world);
    }
    for (const [k, b] of entries) world.set(k, b);
  }

  private writeBlobs(worldId: string, entries: ReadonlyArray<readonly [string, Uint8Array]>): void {
    let world = this.blobs.get(worldId);
    if (!world) {
      world = new Map();
      this.blobs.set(worldId, world);
    }
    for (const [n, b] of entries) world.set(n, b);
  }
}
