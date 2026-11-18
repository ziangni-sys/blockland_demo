/**
 * The server Worker's entry (docs/NETCODE.md sections 1, 15): a ServerHost driven by host control
 * messages from the page that started it. The only module that touches `self`, postMessage, the
 * timers and the clocks of the Worker.
 *
 * Page -> Worker: PageToHost<MessagePort> (control.ts); a `connect` carries a MessagePort in the
 * message (and in its transfer list), which becomes a PortTransport when ServerHost carries the
 * connect out, after every command posted before it; the port is not started before that, so the
 * messages the client sends meanwhile wait in it, in order. Worker -> page: HostToPage.
 * Storage: IndexedDB when this environment can open it (save/idb.ts openBestStorage); else the
 * storage of the page that started this server, through control messages (pagestorage.ts: the
 * page outlives this Worker, which goes with its world). `ready` tells the page whether the
 * world persists (control.ts). The page's answers to storage calls go straight to the
 * PageStorage, never behind the command that is waiting for them.
 *
 * startServerWorker() takes the scope and its dependencies, so the same entry can be driven from a
 * MessageChannel in Node (tests). Importing this module outside a Worker does nothing else.
 */
import { openBestStorage } from '../../save/idb';
import { parsePageMessage, type HostToPage } from './control';
import { ServerHost, type HostClock, type HostStorage, type ServerHostOptions } from './host';
import { PageStorage } from './pagestorage';
import { PortTransport, type PortLike } from './port';

/** Give up on IndexedDB after this long and save to the page's storage (save/idb.ts openBestStorage). */
const STORAGE_TIMEOUT_MS = 5000;

/** The parts of a worker global (or of one end of a MessageChannel) this entry uses. */
export interface ServerWorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(msg: unknown): void;
}

export interface ServerWorkerDeps {
  clock: HostClock;
  /** Opens the host's storage (once); `page` is the storage of the page that started this server. */
  openStorage(page: PageStorage): Promise<HostStorage>;
  /** Passed through to ServerHost (tests). */
  host?: Partial<Pick<ServerHostOptions, 'chunkBudget' | 'sinks' | 'rabbits'>>;
}

/** Run a ServerHost behind `scope`. Returns it (tests). */
export function startServerWorker(scope: ServerWorkerScope, deps: ServerWorkerDeps): ServerHost {
  const page = new PageStorage((msg) => scope.postMessage(msg));
  const host = new ServerHost({
    ...deps.host,
    clock: deps.clock,
    openStorage: () => deps.openStorage(page),
    report: (msg: HostToPage) => scope.postMessage(msg),
  });
  scope.onmessage = (ev) => {
    const msg = parsePageMessage(ev.data);
    if (msg === null) {
      scope.postMessage({ type: 'error', what: 'message', message: 'not a host control message' } satisfies HostToPage);
      return;
    }
    if (msg.type === 'storageResult') {
      page.answer(msg);
      return;
    }
    // The port is wrapped (and so started) only when the connect is carried out: until then it
    // keeps the client's Hello and whatever follows, however long earlier commands take.
    if (msg.type === 'connect') void host.control({ type: 'connect', port: () => new PortTransport(msg.port as PortLike), local: msg.local });
    else void host.control(msg);
  };
  return host;
}

/** The Worker's real clock, timers and storage. */
export function workerDeps(): ServerWorkerDeps {
  return {
    clock: {
      now: () => performance.now(),
      epochMs: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    openStorage: async (page) => {
      const giveUp = new Promise<void>((resolve) => setTimeout(resolve, STORAGE_TIMEOUT_MS));
      const best = await openBestStorage(undefined, { giveUp });
      // No IndexedDB here: a memory storage of this Worker would go with it when the world closes.
      return best.persistent ? { storage: best.storage, persistent: true } : page.open();
    },
  };
}

function inWorker(): boolean {
  const g = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
  return typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope;
}

if (inWorker()) startServerWorker(self as unknown as ServerWorkerScope, workerDeps());
