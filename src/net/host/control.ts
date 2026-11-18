/**
 * Host control messages (docs/NETCODE.md section 15): between the page that runs a server and
 * its own Worker, as structured-clone objects. They are not the game protocol: a guest can never
 * send them (it only has a game connection), and a Node dedicated server takes the same commands
 * from its console.
 *
 * Page -> host: create a world or load one, connect a client (one MessagePort per connection; the
 * page's own client is `local`, which makes it the host's connection), pause (single player:
 * only while the room is closed), save, open or close the room, shut down.
 * Host -> page: the world is ready, a save finished, status (measured TPS and players), errors,
 * closed.
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
  /** Measured ticks per second and players in the world; sent when it changes, at most once a second. */
  | { type: 'status'; tps: number; players: number }
  /** A command could not be carried out (`what` = the command, or 'tick' when the simulation threw). */
  | { type: 'error'; what: string; message: string }
  /** The server shut down. */
  | { type: 'closed' };

const TYPES: readonly string[] = Object.freeze(['create', 'load', 'connect', 'pause', 'save', 'openRoom', 'closeRoom', 'shutdown']);

/**
 * The page's message as a PageToHost, or null when it is not one (wrong type or fields). The
 * port of a connect is passed through unchecked (the caller knows what it expects).
 */
export function parsePageToHost(data: unknown): PageToHost<unknown> | null {
  if (data === null || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (typeof m.type !== 'string' || !TYPES.includes(m.type)) return null;
  switch (m.type) {
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
