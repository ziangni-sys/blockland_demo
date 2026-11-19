/**
 * The page's view of the saved worlds (docs/NETCODE.md section 12). Saving and loading happen in
 * the game server (net/host/host.ts: the Worker writes and reads the same IndexedDB database, with
 * its own save queue); the main menu reads the world list from that database itself, deletes worlds
 * from it (no server runs while the menu is up), and checks a world before it asks a server to
 * load it, so a missing, newer or older world is refused with its own message.
 */
import { isNewerSave, isOlderSave, SAVE_VERSION, type WorldMeta } from '../save/codec';
import type { SaveStorage } from '../save/storage';
import type { GameMode, WorldSummary } from '../ui/model';

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

/** The meta of a new world (the server writes it with the world's first save). */
export function newWorldMeta(id: string, name: string, seedText: string, seedHash: number, mode: GameMode, nowMs: number): WorldMeta {
  return { id, name, seed: seedText, seedHash: seedHash >>> 0, mode, createdAt: Math.floor(nowMs), lastPlayed: Math.floor(nowMs), version: SAVE_VERSION, time: 0 };
}

/** Every readable world, newest first. */
export async function listWorlds(storage: SaveStorage): Promise<WorldSummary[]> {
  return (await storage.listWorlds()).map(toSummary);
}

/** Whether world `id` can be opened by this build ('error': the storage failed, see `error`). */
export type WorldCheck = { ok: true; meta: WorldMeta } | { ok: false; reason: 'missing' | 'newer' | 'older' | 'error'; error?: unknown };

/** Check world `id` before a server is asked to load it (no backward compatibility: an older world is refused). */
export async function checkWorld(storage: SaveStorage, id: string): Promise<WorldCheck> {
  try {
    const meta = await storage.getMeta(id);
    if (!meta) return { ok: false, reason: 'missing' };
    if (isNewerSave(meta)) return { ok: false, reason: 'newer' };
    if (isOlderSave(meta)) return { ok: false, reason: 'older' };
    return { ok: true, meta };
  } catch (error) {
    return { ok: false, reason: 'error', error };
  }
}
