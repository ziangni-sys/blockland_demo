/**
 * The page's side of its own game server (docs/NETCODE.md sections 1, 12 and 15): a ServerHost in
 * a Worker, driven by host control messages, with the page's client connected to it through a
 * MessagePort (PortTransport, so single player goes through the whole protocol).
 *
 * STARTING. start(command) starts the server one way after the other (client/workerfactory.ts:
 * a module Worker from a blob URL; the same from a data: URL, which opaque-origin sandboxes allow;
 * the same ServerHost on the main thread behind a MessageChannel, still exchanging bytes) and posts
 * the first command (create or load) to it. A way that cannot be constructed, whose Worker reports
 * an error before its first message (the script was refused or did not load), or that stays
 * silent for firstReplyTimeoutMs, is given up (terminated) and the next one gets the same
 * command. The first report of the way that works ('ready', or 'error' when the world could not
 * be made or read) is start()'s result; every later report goes to onReport, and an error event
 * after that is a crash (onCrash).
 *
 * One LocalServer runs one world: a ServerHost that shut down is closed for good, so the page
 * starts a new one for the next world (terminate() the old one).
 *
 * THE PAGE'S STORAGE. A server that cannot open IndexedDB itself saves into the page's storage
 * (net/host/pagestorage.ts): its `storage` calls are carried out on `pageStorage` and answered,
 * from the first command on, and never reach onReport. So a world kept in memory (the sandboxed
 * single-file build) lives in the page, outlives its server and stays in the world list.
 */
import type { CreateOptions, HostToPage, PageToHost, StorageCall, StorageResult } from '../net/host/control';
import { PortTransport } from '../net/host/port';
import type { Transport } from '../net/transport';
import type { WorldMeta } from '../save/codec';
import { SaveStorageError, type SaveStorage } from '../save/storage';
import type { WorkerLike } from './workers';

/** How the server runs. */
export type ServerMode = 'worker' | 'worker (data URL)' | 'main thread';

/** One way of starting the server (client/workerfactory.ts). */
export interface ServerWay {
  readonly mode: ServerMode;
  create(): Promise<WorkerLike>;
}

/** The first command: what the server opens. */
export type OpenCommand = { type: 'create'; meta: WorldMeta; options: CreateOptions } | { type: 'load'; worldId: string };

/** The page's storage as the server may use it: the storage, and whether it outlives the page (and why not). */
export interface PageStorageOption {
  storage: SaveStorage;
  persistent: boolean;
  /** save/idb.ts openBestStorage's code when not persistent. */
  reason: string;
}

export interface LocalServerOptions {
  ways: readonly ServerWay[];
  /** The page's storage: the server's when it cannot open IndexedDB itself. */
  pageStorage: PageStorageOption;
  /** A way whose server answers nothing this long after the first command is given up (ms). */
  firstReplyTimeoutMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Every report after start()'s result. */
  onReport(msg: HostToPage): void;
  /** The running server failed (an error event after it answered). */
  onCrash(): void;
}

interface Waiter {
  pick: (m: HostToPage) => boolean;
  resolve: (m: HostToPage | null) => void;
  timer: unknown;
}

export class LocalServer {
  private worker: WorkerLike | null = null;
  private modeValue: ServerMode | null = null;
  private dead = false;
  private readonly waiters: Waiter[] = [];
  /** Why each way that was tried failed. */
  readonly failures: string[] = [];

  constructor(private readonly o: LocalServerOptions) {}

  /** How the server runs (null before start() succeeded). */
  get mode(): ServerMode | null {
    return this.modeValue;
  }

  /**
   * Start the server and send it `command`: resolves with its first report ('ready' or 'error');
   * rejects when no way of starting it works.
   */
  async start(command: OpenCommand): Promise<HostToPage> {
    for (const way of this.o.ways) {
      if (this.dead) break;
      let w: WorkerLike;
      try {
        w = await way.create();
      } catch (e) {
        this.failures.push(`${way.mode}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const first = await this.tryWay(w, command);
      if (first !== null && !this.dead) {
        this.worker = w;
        this.modeValue = way.mode;
        return first;
      }
      this.failures.push(`${way.mode}: ${first === null ? 'no answer' : 'stopped'}`);
      try {
        w.terminate();
      } catch {
        // already gone
      }
    }
    throw new Error(`the game server could not be started (${this.failures.join('; ') || 'stopped'})`);
  }

  /** Post a control message (`transfer`: the ports it carries). */
  post(msg: PageToHost<MessagePort>, transfer: Transferable[] = []): void {
    if (this.dead || this.worker === null) return;
    this.worker.postMessage(msg, transfer);
  }

  /** A new connection of the page's own client (the host's connection): its Transport. */
  connect(): Transport {
    const channel = new MessageChannel();
    this.post({ type: 'connect', port: channel.port2, local: true }, [channel.port2]);
    return new PortTransport(channel.port1);
  }

  /** The next report that passes `pick`, or null after `timeoutMs` (or when the server is terminated). */
  waitFor(pick: (m: HostToPage) => boolean, timeoutMs: number): Promise<HostToPage | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { pick, resolve, timer: null };
      waiter.timer = this.o.setTimer(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Stop the server at once (after a shutdown, or when the page gives up on it). */
  terminate(): void {
    if (this.dead) return;
    this.dead = true;
    const w = this.worker;
    this.worker = null;
    for (const waiter of this.waiters.splice(0)) {
      this.o.clearTimer(waiter.timer);
      waiter.resolve(null);
    }
    try {
      w?.terminate();
    } catch {
      // already gone
    }
  }

  /** Carry a storage call of the server out on the page's storage and answer it (in call order: SaveStorage keeps it). */
  private answerStorage(w: WorkerLike, id: number, call: StorageCall): void {
    void storageCall(this.o.pageStorage, call)
      .then(
        (value): StorageResult => ({ type: 'storageResult', id, ok: true, value }),
        (e: unknown): StorageResult => ({
          type: 'storageResult',
          id,
          ok: false,
          code: e instanceof SaveStorageError ? e.code : null,
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((answer) => {
        if (this.dead) return;
        try {
          w.postMessage(answer, []);
        } catch {
          // the server is gone
        }
      });
  }

  /** Send `command` to a started way: its first report, or null when it failed or stayed silent. */
  private tryWay(w: WorkerLike, command: OpenCommand): Promise<HostToPage | null> {
    return new Promise((resolve) => {
      let answered = false;
      let settled = false;
      const settle = (r: HostToPage | null): void => {
        if (settled) return;
        settled = true;
        this.o.clearTimer(timer);
        resolve(r);
      };
      const timer = this.o.setTimer(() => settle(null), this.o.firstReplyTimeoutMs);
      w.addEventListener('message', (e) => {
        const msg = e.data as HostToPage;
        if (msg.type === 'storage') {
          this.answerStorage(w, msg.id, msg.call);
          return;
        }
        if (!answered) {
          answered = true;
          settle(msg);
          return;
        }
        if (this.worker !== w || this.dead) return;
        this.o.onReport(msg);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const waiter = this.waiters[i]!;
          if (!waiter.pick(msg)) continue;
          this.waiters.splice(i, 1);
          this.o.clearTimer(waiter.timer);
          waiter.resolve(msg);
        }
      });
      w.addEventListener('error', () => {
        if (!answered) settle(null);
        else if (this.worker === w && !this.dead) this.o.onCrash();
      });
      try {
        w.postMessage(command, []);
      } catch {
        settle(null);
      }
    });
  }
}

function storageCall(page: PageStorageOption, call: StorageCall): Promise<unknown> {
  const s = page.storage;
  switch (call.op) {
    case 'open':
      return Promise.resolve({ persistent: page.persistent, reason: page.persistent ? null : page.reason });
    case 'getMeta':
      return s.getMeta(call.worldId);
    case 'listChunkKeys':
      return s.listChunkKeys(call.worldId);
    case 'getChunks':
      return s.getChunks(call.worldId, call.keys);
    case 'getBlob':
      return s.getBlob(call.worldId, call.name);
    case 'putAll':
      return s.putAll(call.worldId, call.meta, call.chunks, call.blobs);
    default:
      return Promise.reject(new Error(`unknown storage call ${String((call as { op?: unknown }).op)}`));
  }
}
