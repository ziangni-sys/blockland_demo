/**
 * Host control messages (docs/NETCODE.md section 15): between the page that runs a server and
 * its own Worker, as structured-clone objects. They are not the game protocol: a guest can never
 * send them (it only has a game connection), and a Node dedicated server takes the same commands
 * from its console.
 *
 * Page -> host: create a world or load one, connect a client (one MessagePort per connection; the
 * page's own client is `local`, which makes it the host's connection), pause (single player:
 * only while the room is closed), save, open or close the room, shut down.
 * Host -> page: the world is ready, a save finished, status (measured TPS, players, and each
 * guest's bytes a second, backlog and round trip), the time the ticks take (for the page's debug
 * overlay), errors, closed.
 *
 * THE PAGE'S STORAGE. A server Worker that cannot open IndexedDB itself saves into the storage of
 * the page that started it (pagestorage.ts), which outlives the Worker: the page starts a new
 * server for each world, and a world kept in memory stays in the page's world list until the page
 * closes. The host asks with `storage { id, call }`; the page answers each with
 * `storageResult { id, ... }` (StorageResult), in the order asked. Answers are not commands: they
 * never wait behind the command that asked (a load reading the world).
 *
 * `PageToHost` is generic in what a connection is: a MessagePort on the way into the Worker, a
 * TransportOpener inside (ServerHost.control calls it when it carries the connect out, worker.ts
 * then wraps the port in a PortTransport).
 *
 * ORDER. Commands are carried out one after the other, in the order posted. A page may post a
 * connect right behind any command, even one still running (a load, a save): the connection's
 * messages that arrive before the connect is carried out are kept in order and handed to it then.
 */
import type { WorldMeta } from '../../save/codec';
import type { GeneratorSpec } from '../protocol';

/** How a new world is made. */
export interface CreateOptions {
  /** The generator; default: terrain of meta.seedHash. */
  generator?: GeneratorSpec;
  /** Stamp the example windmill boat near the spawn (default true). */
  exampleShip?: boolean;
}

export type PageToHost<P> =
  | { type: 'create'; meta: WorldMeta; options: CreateOptions }
  | { type: 'load'; worldId: string }
  | { type: 'connect'; port: P; local: boolean }
  | { type: 'pause'; paused: boolean }
  | { type: 'save' }
  | { type: 'openRoom' }
  | { type: 'closeRoom' }
  | { type: 'shutdown'; save: boolean };

export type HostToPage =
  /**
   * create or load finished: the world runs (its clock starts at the first accepted Hello).
   * `persistent` false: the Worker saves to memory (IndexedDB failed there; `reason` is
   * openBestStorage's code) and the world is lost with the page: the page tells the player, as M1
   * does. Saves still report ok.
   */
  | { type: 'ready'; meta: WorldMeta; persistent: boolean; reason: string | null }
  /** A save finished; `code` is the storage error code when it failed ('quota', 'newer-version' ...). */
  | { type: 'saved'; ok: boolean; code: string | null }
  /**
   * Measured ticks per second, players in the world and every guest's connection; sent when the
   * TPS or the players change, and every second while guests are in (their numbers move), at most
   * once a second.
   */
  | { type: 'status'; tps: number; players: number; guests: GuestTraffic[] }
  /** Mean and longest milliseconds of the host's clock one tick took since the last report; about once a second while ticks run. */
  | { type: 'tickTime'; meanMs: number; maxMs: number }
  /** A command could not be carried out (`what` = the command, or 'tick' when the simulation threw). */
  | { type: 'error'; what: string; message: string }
  /** The server shut down. */
  | { type: 'closed' }
  /** A call on the page's storage (see the file comment); answered by a StorageResult with the same id. */
  | { type: 'storage'; id: number; call: StorageCall };

/** One guest's connection as the host page shows it to whoever debugs a room (package 13). */
export interface GuestTraffic {
  /** The guest's player (the player table's entity id) and name. */
  entityId: number;
  name: string;
  /** Bytes the server sent it per second since the last status (batches and samples, without headers). */
  bytesPerSec: number;
  /** Bytes waiting to go out to it, both channels (the server's estimate from the forwarder's reports). */
  backlogBytes: number;
  /** Its round trip as its client measured it, ms (0 until it reported one). */
  rttMs: number;
}

/**
 * What the host asks of the page's storage: whether it persists (`open`), and the SaveStorage
 * calls a host makes (save/storage.ts; ServerHost reads a world and writes saves with these).
 */
export type StorageCall =
  | { op: 'open' }
  | { op: 'getMeta'; worldId: string }
  | { op: 'listChunkKeys'; worldId: string }
  | { op: 'getChunks'; worldId: string; keys: number[] }
  | { op: 'getBlob'; worldId: string; name: string }
  | {
      op: 'putAll';
      worldId: string;
      meta: WorldMeta;
      chunks: ReadonlyArray<readonly [number, Uint8Array]>;
      blobs: ReadonlyArray<readonly [string, Uint8Array]>;
    };

/** What `open` answers: whether the page's storage outlives the page, and why not (save/idb.ts openBestStorage's code). */
export interface PageStorageInfo {
  persistent: boolean;
  reason: string | null;
}

/**
 * The page's answer to a storage call: the call's result, or how it failed (`code`: the
 * SaveStorageError code, null for any other error).
 */
export type StorageResult =
  | { type: 'storageResult'; id: number; ok: true; value: unknown }
  | { type: 'storageResult'; id: number; ok: false; code: string | null; message: string };

const TYPES: readonly string[] = Object.freeze(['create', 'load', 'connect', 'pause', 'save', 'openRoom', 'closeRoom', 'shutdown', 'storageResult']);

/**
 * The page's message as a PageToHost or a StorageResult, or null when it is neither (wrong type
 * or fields). The port of a connect is passed through unchecked (the caller knows what it
 * expects), and so is a storage result's value (the caller knows what it asked).
 */
export function parsePageMessage(data: unknown): PageToHost<unknown> | StorageResult | null {
  if (data === null || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (typeof m.type !== 'string' || !TYPES.includes(m.type)) return null;
  switch (m.type) {
    case 'storageResult':
      if (typeof m.id !== 'number' || typeof m.ok !== 'boolean') return null;
      return m.ok || (typeof m.message === 'string' && (m.code === null || typeof m.code === 'string')) ? (data as StorageResult) : null;
    case 'create':
      return m.meta !== null && typeof m.meta === 'object' && m.options !== null && typeof m.options === 'object' ? (data as PageToHost<unknown>) : null;
    case 'load':
      return typeof m.worldId === 'string' ? (data as PageToHost<unknown>) : null;
    case 'connect':
      return typeof m.local === 'boolean' && m.port !== undefined && m.port !== null ? (data as PageToHost<unknown>) : null;
    case 'pause':
      return typeof m.paused === 'boolean' ? (data as PageToHost<unknown>) : null;
    case 'shutdown':
      return typeof m.save === 'boolean' ? (data as PageToHost<unknown>) : null;
    default:
      return data as PageToHost<unknown>;
  }
}
