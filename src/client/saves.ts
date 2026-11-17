/**
 * Saved worlds through a SaveStorage: listing, creating metadata, loading a SaveBundle and
 * writing one. Saves are serialized: a save requested while another runs is coalesced into
 * one follow-up save with the newest state, so two writes never race.
 */
import { SAVE_VERSION, isNewerSave, type WorldMeta } from '../save/codec';
import { SaveStorageError, type SaveStorage } from '../save/storage';
import type { SaveBundle } from '../sim/persist';
import type { GameMode, WorldSummary } from '../ui/model';

/** Blob names written by exportSave (src/sim/persist.ts). */
export const SAVE_BLOBS = ['sim', 'ticks', 'glue', 'structures', 'entities'] as const;

export function toSummary(m: WorldMeta): WorldSummary {
  return { id: m.id, name: m.name, seed: m.seed, mode: m.mode, lastPlayed: m.lastPlayed };
}

/** A world id that is unique enough for one browser profile: time + randomness. */
export function makeWorldId(nowMs: number, random: () => number): string {
  const r = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `w${Math.floor(nowMs).toString(36)}${r}`;
}

export function newWorldMeta(id: string, name: string, seedText: string, seedHash: number, mode: GameMode, nowMs: number): WorldMeta {
  return { id, name, seed: seedText, seedHash: seedHash >>> 0, mode, createdAt: Math.floor(nowMs), lastPlayed: Math.floor(nowMs), version: SAVE_VERSION, time: 0 };
}

export type LoadResult =
  | { ok: true; meta: WorldMeta; bundle: SaveBundle }
  | { ok: false; reason: 'missing' | 'newer' | 'error'; error?: unknown };

type Snapshot = () => { meta: WorldMeta; bundle: SaveBundle } | null;

interface QueuedSave {
  snapshot: Snapshot;
  promise: Promise<void>;
}

export class SaveManager {
  /** Tail of the serialized save chain (never rejects). */
  private chain: Promise<void> = Promise.resolve();
  /** A save waiting for the running one to finish (coalesces further requests). */
  private queued: QueuedSave | null = null;
  private active = false;

  constructor(readonly storage: SaveStorage) {}

  /** Every readable world, newest first. */
  async list(): Promise<WorldSummary[]> {
    const metas = await this.storage.listWorlds();
    return metas.map(toSummary);
  }

  async delete(id: string): Promise<void> {
    await this.storage.deleteWorld(id);
  }

  /** Read everything needed to rebuild a Simulation (chunks, blobs) for `id`. */
  async load(id: string): Promise<LoadResult> {
    try {
      const meta = await this.storage.getMeta(id);
      if (!meta) return { ok: false, reason: 'missing' };
      if (isNewerSave(meta)) return { ok: false, reason: 'newer' };
      const keys = await this.storage.listChunkKeys(id);
      const data = keys.length > 0 ? await this.storage.getChunks(id, keys) : [];
      const chunks: Array<[number, Uint8Array]> = [];
      for (let i = 0; i < keys.length; i++) {
        const bytes = data[i];
        if (bytes) chunks.push([keys[i]!, bytes]);
      }
      const blobs: Array<[string, Uint8Array]> = [];
      for (const name of SAVE_BLOBS) {
        const b = await this.storage.getBlob(id, name);
        if (b) blobs.push([name, b]);
      }
      return { ok: true, meta, bundle: { chunks, blobs } };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    }
  }

  /** True while a save is being written or waiting to be. */
  get busy(): boolean {
    return this.active || this.queued !== null;
  }

  /**
   * Write a save. `snapshot()` runs when the write actually starts (so a request that waited
   * behind a running save captures the newest state) and may return null to skip. Requests
   * made while one is already waiting share it (the latest snapshot function wins). Resolves
   * once the data is committed; rejects with the storage error.
   */
  save(snapshot: Snapshot): Promise<void> {
    const waiting = this.queued;
    if (waiting) {
      waiting.snapshot = snapshot;
      return waiting.promise;
    }
    const entry: QueuedSave = { snapshot, promise: Promise.resolve() };
    entry.promise = this.chain
      .then(() => {
        if (this.queued === entry) this.queued = null;
        this.active = true;
        return this.write(entry.snapshot);
      })
      .finally(() => {
        this.active = false;
      });
    this.queued = entry;
    this.chain = entry.promise.catch(() => undefined);
    return entry.promise;
  }

  /** Resolves once no save is running or waiting. Never rejects. */
  async idle(): Promise<void> {
    while (this.busy) await this.chain;
  }

  private async write(snapshot: Snapshot): Promise<void> {
    const s = snapshot();
    if (!s) return;
    await this.storage.putAll(s.meta.id, s.meta, s.bundle.chunks, s.bundle.blobs);
  }
}

/** Storage error code, if any ('quota', 'newer-version' ...). */
export function storageErrorCode(e: unknown): string | null {
  return e instanceof SaveStorageError ? e.code : null;
}
