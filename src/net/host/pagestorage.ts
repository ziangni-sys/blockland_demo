/**
 * The storage of the page that started this server, reached through host control messages
 * (control.ts `storage` / `storageResult`; docs/NETCODE.md section 18, package 9).
 *
 * A server Worker that cannot open IndexedDB itself (the sandboxed single-file build, where
 * neither the page nor its Workers have it) must not keep the world in a memory storage of its
 * own: the page starts a new server for each world and terminates it when the world closes, so the
 * world would go with it. The page's storage outlives every server of the page session, and the
 * page reads its world list from it. worker.ts routes the page's answers to answer(); everything
 * else here is plain promises.
 */
import type { WorldMeta } from '../../save/codec';
import { SaveStorageError, type SaveStorageErrorCode } from '../../save/storage';
import type { HostToPage, PageStorageInfo, StorageCall, StorageResult } from './control';
import type { HostStorage, WorldStore } from './host';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class PageStorage implements WorldStore {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  /** `post` sends a control message to the page. */
  constructor(private readonly post: (msg: HostToPage) => void) {}

  /** This storage as the host's storage: persistent when the page's is (the page says). */
  async open(): Promise<HostStorage> {
    const info = (await this.call({ op: 'open' })) as PageStorageInfo;
    return info.persistent ? { storage: this, persistent: true } : { storage: this, persistent: false, reason: info.reason ?? 'unavailable' };
  }

  getMeta(worldId: string): Promise<WorldMeta | null> {
    return this.call({ op: 'getMeta', worldId }) as Promise<WorldMeta | null>;
  }
  listChunkKeys(worldId: string): Promise<number[]> {
    return this.call({ op: 'listChunkKeys', worldId }) as Promise<number[]>;
  }
  getChunks(worldId: string, keys: readonly number[]): Promise<Array<Uint8Array | null>> {
    return this.call({ op: 'getChunks', worldId, keys: [...keys] }) as Promise<Array<Uint8Array | null>>;
  }
  getBlob(worldId: string, name: string): Promise<Uint8Array | null> {
    return this.call({ op: 'getBlob', worldId, name }) as Promise<Uint8Array | null>;
  }
  async putAll(
    worldId: string,
    meta: WorldMeta,
    chunks: ReadonlyArray<readonly [number, Uint8Array]>,
    blobs: ReadonlyArray<readonly [string, Uint8Array]>,
  ): Promise<void> {
    await this.call({ op: 'putAll', worldId, meta, chunks, blobs });
  }

  /** The page's answer to one of the calls (an unknown id is ignored). */
  answer(m: StorageResult): void {
    const p = this.pending.get(m.id);
    if (p === undefined) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    // The storage error's code reaches the host (a full disk is a 'quota' save failure).
    else p.reject(m.code === null ? new Error(m.message) : new SaveStorageError(m.message, { code: m.code as SaveStorageErrorCode }));
  }

  private call(call: StorageCall): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.post({ type: 'storage', id, call });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}
