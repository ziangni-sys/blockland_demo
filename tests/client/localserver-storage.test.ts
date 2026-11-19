/**
 * The page's storage as its server's (client/server.ts LocalServer, net/host/pagestorage.ts): a
 * server that cannot open IndexedDB (here: none in Node) saves into the storage of the page that
 * started it, so a world kept in memory outlives its server (the sandboxed single-file build). The
 * server is the real Worker entry (net/host/worker.ts, real workerDeps) behind a MessageChannel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import type { HostToPage } from '../../src/net/host/control';
import type { ServerHost } from '../../src/net/host/host';
import { startServerWorker, workerDeps, type ServerWorkerScope } from '../../src/net/host/worker';
import { MemoryStorage, SaveStorageError, type SaveStorage } from '../../src/save/storage';
import { LocalServer, type OpenCommand } from '../../src/client/server';
import type { WorkerLike } from '../../src/client/workers';
import { FLAT, testMeta } from '../net/harness';

const servers: LocalServer[] = [];

/** A LocalServer whose one way is the Worker entry on a MessageChannel; `host()` is its ServerHost. */
function localServer(storage: SaveStorage, persistent: boolean, reports: HostToPage[]): { server: LocalServer; host: () => ServerHost } {
  let host: ServerHost | null = null;
  const way = async (): Promise<WorkerLike> => {
    const { port1: page, port2: worker } = new MessageChannel();
    host = startServerWorker(worker as unknown as ServerWorkerScope, { ...workerDeps(), host: { rabbits: false } });
    return {
      postMessage: (msg, transfer) => page.postMessage(msg, transfer),
      addEventListener: (type, fn) => {
        if (type !== 'message') return;
        page.addEventListener('message', fn as never);
        page.start();
      },
      terminate: () => {
        void host?.shutdown(false);
        page.close();
      },
    };
  };
  const server = new LocalServer({
    ways: [{ mode: 'main thread', create: way }],
    pageStorage: { storage, persistent, reason: persistent ? '' : 'unavailable' },
    firstReplyTimeoutMs: 5000,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onReport: (m) => reports.push(m),
    onCrash: () => undefined,
  });
  servers.push(server);
  return { server, host: () => host! };
}

const create = (id: string): OpenCommand => ({ type: 'create', meta: testMeta(id), options: { generator: FLAT, exampleShip: false } });

beforeEach(() => {
  // The real Worker entry tries IndexedDB first: there is none.
  vi.stubGlobal('indexedDB', undefined);
});
afterEach(() => {
  for (const s of servers.splice(0)) s.terminate();
  vi.unstubAllGlobals();
});

describe("the page's storage as its server's (no IndexedDB in the server)", { timeout: 20_000 }, () => {
  it('a world saved by one server is read back by the next one from the page storage; storage calls never reach the reports', async () => {
    const page = new MemoryStorage();
    const reports: HostToPage[] = [];
    const a = localServer(page, false, reports);
    const first = await a.server.start(create('mem'));
    expect(first).toMatchObject({ type: 'ready', persistent: false, reason: 'unavailable' });
    expect(await a.server.waitFor((m) => m.type === 'saved', 5000)).toMatchObject({ type: 'saved', ok: true });
    expect((await page.getMeta('mem'))?.id).toBe('mem');
    const simA = a.host().sim;
    simA.chunks.loadColumn(simA.generator, 0, 0); // no player: nothing is loaded yet
    simA.world.setCell(3, 9, 4, makeCell(B.BRICKS));
    const closed = a.server.waitFor((m) => m.type === 'closed', 5000);
    a.server.post({ type: 'shutdown', save: true });
    expect(await closed).toEqual({ type: 'closed' });
    a.server.terminate();
    expect(reports.some((m) => (m as { type: string }).type === 'storage')).toBe(false);

    const b = localServer(page, false, []);
    expect(await b.server.start({ type: 'load', worldId: 'mem' })).toMatchObject({ type: 'ready', meta: { id: 'mem' }, persistent: false });
    const simB = b.host().sim;
    simB.chunks.loadColumn(simB.generator, 0, 0);
    expect(simB.world.getCell(3, 9, 4)).toBe(makeCell(B.BRICKS));
  });

  it('a page storage that persists makes the world persistent', async () => {
    const { server } = localServer(new MemoryStorage(), true, []);
    expect(await server.start(create('p'))).toMatchObject({ type: 'ready', persistent: true, reason: null });
  });

  it("a write the page's storage refuses reaches the host with its code (a full disk is a 'quota' save failure); a read failure fails the load", async () => {
    const page = new MemoryStorage();
    page.putAll = () => Promise.reject(new SaveStorageError('QuotaExceededError (simulated)', { code: 'quota' }));
    const { server } = localServer(page, false, []);
    await server.start(create('q'));
    expect(await server.waitFor((m) => m.type === 'saved', 5000)).toEqual({ type: 'saved', ok: false, code: 'quota' });

    const broken = new MemoryStorage();
    broken.getMeta = () => Promise.reject(new Error('the page storage broke'));
    const other = localServer(broken, false, []);
    expect(await other.server.start({ type: 'load', worldId: 'x' })).toEqual({ type: 'error', what: 'load', message: 'the page storage broke' });
  });
});
