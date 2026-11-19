/**
 * Package 8: the server Worker's entry (net/host/worker.ts) driven through a MessageChannel in
 * Node: the page side creates a world, connects a real NetClient over a PortTransport on a second
 * MessageChannel, joins and applies the tick batches that real timers produce; then shuts the
 * server down. (scripts/e2e-server-worker.mjs does the same in a real browser with both builds.)
 */
import { describe, expect, it } from 'vitest';
import { NetClient, type NetStatus } from '../../src/net/client/netclient';
import type { HostToPage } from '../../src/net/host/control';
import { PortTransport } from '../../src/net/host/port';
import { startServerWorker, workerDeps, type ServerWorkerScope } from '../../src/net/host/worker';
import { MemoryStorage } from '../../src/save/storage';
import { ServerHost } from '../../src/net/host/host';
import { generatorFromSpec } from '../../src/worldgen/generator';
import { FLAT, syncSource, testMeta } from './harness';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A storage whose reads of a world's meta and whose writes take `ms` each (a busy IndexedDB). */
class SlowStorage extends MemoryStorage {
  constructor(private readonly ms: number) {
    super();
  }
  override async getMeta(id: string): ReturnType<MemoryStorage['getMeta']> {
    await sleep(this.ms);
    return super.getMeta(id);
  }
  override async putAll(...a: Parameters<MemoryStorage['putAll']>): Promise<void> {
    await sleep(this.ms);
    return super.putAll(...a);
  }
}

interface PageClient {
  nc: NetClient;
  /** Ticks of the applied batches. */
  ticks: number[];
  statuses: NetStatus[];
  stop(): void;
}

/**
 * The page's end of a connection: a NetClient on a PortTransport, started at once (its Hello goes
 * out right behind the connect), framed and heartbeaten from real timers.
 */
function pageClient(pageSide: MessagePort, local: boolean, key: string): PageClient {
  const conn = new MessageChannel();
  pageSide.postMessage({ type: 'connect', port: conn.port2, local }, [conn.port2]);
  const nc = new NetClient({
    openTransport: (ready) => ready(new PortTransport(conn.port1)),
    now: () => performance.now(),
    chunkSource: (spec) => syncSource(generatorFromSpec(spec)),
    playerKey: key,
    name: key,
    viewRadius: 2,
  });
  const ticks: number[] = [];
  const statuses: NetStatus[] = [];
  nc.onBatch = (b) => ticks.push(b.tick);
  nc.onStatus = (s) => statuses.push(s);
  nc.start();
  const frames = setInterval(() => nc.frame(performance.now()), 16);
  const beats = setInterval(() => nc.heartbeat(performance.now()), 1000);
  return {
    nc,
    ticks,
    statuses,
    stop: () => {
      clearInterval(frames);
      clearInterval(beats);
    },
  };
}

function startWorker(storage: MemoryStorage, persistent = true): { pageSide: MessagePort; reports: HostToPage[]; host: ServerHost } {
  const { port1: workerSide, port2: pageSide } = new MessageChannel();
  const openStorage = async () => (persistent ? { storage, persistent: true as const } : { storage, persistent: false as const, reason: 'unavailable' });
  const host = startServerWorker(workerSide as unknown as ServerWorkerScope, { ...workerDeps(), openStorage, host: { rabbits: false } });
  const reports: HostToPage[] = [];
  pageSide.onmessage = (ev) => reports.push(ev.data as HostToPage);
  return { pageSide, reports, host };
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (cond()) resolve();
      else if (Date.now() > end) reject(new Error('timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

describe('the server Worker entry (package 8)', () => {
  it('through a MessageChannel: create, connect, Hello, Welcome, batches from real timers, shutdown', async () => {
    const { port1: workerSide, port2: pageSide } = new MessageChannel();
    const storage = new MemoryStorage();
    const deps = { ...workerDeps(), openStorage: async () => ({ storage, persistent: true as const }), host: { rabbits: false } };
    startServerWorker(workerSide as unknown as ServerWorkerScope, deps);
    const reports: HostToPage[] = [];
    pageSide.onmessage = (ev) => reports.push(ev.data as HostToPage);
    pageSide.postMessage({ type: 'nonsense' });
    pageSide.postMessage({ type: 'create', meta: testMeta('wk'), options: { generator: FLAT, exampleShip: false } });
    await waitFor(() => reports.some((r) => r.type === 'ready'), 5000);
    expect(reports[0]).toMatchObject({ type: 'error', what: 'message' });

    const page = pageClient(pageSide, true, 'page');
    await waitFor(() => page.ticks.length >= 20 && page.nc.status === 'ready', 5000);
    expect(page.statuses).toEqual(['connecting', 'joining', 'ready']);
    for (let i = 1; i < page.ticks.length; i++) expect(page.ticks[i]).toBe(page.ticks[i - 1]! + 1);
    expect(page.nc.welcome!.isHost).toBe(true);
    expect(page.nc.replica!.state.ready).toBe(true);

    pageSide.postMessage({ type: 'shutdown', save: true });
    await waitFor(() => reports.some((r) => r.type === 'closed') && page.nc.status === 'kicked', 5000);
    expect(page.nc.kick?.reason).toBe('shutdown');
    expect(reports.filter((r) => r.type === 'saved').every((r) => r.type === 'saved' && r.ok)).toBe(true);
    expect((await storage.getMeta('wk'))?.time).toBeGreaterThan(960);
    page.stop();
    pageSide.close();
  });

  it('a connect posted right behind a load that is still reading: the Hello sent at once is kept, Welcome and batches arrive', async () => {
    const storage = new SlowStorage(60);
    const maker = new ServerHost({ clock: workerDeps().clock, openStorage: async () => ({ storage, persistent: true }), report: () => {}, rabbits: false });
    await maker.create(testMeta('w'), { generator: FLAT, exampleShip: false });
    expect(await maker.shutdown(true)).toBe(true);

    const { pageSide, reports } = startWorker(storage);
    pageSide.postMessage({ type: 'load', worldId: 'w' });
    const c = pageClient(pageSide, true, 'page');
    await waitFor(() => c.ticks.length >= 5, 5000);
    expect(reports[0]).toMatchObject({ type: 'ready', persistent: true, reason: null });
    expect(c.nc.welcome?.isHost).toBe(true);
    pageSide.postMessage({ type: 'shutdown', save: false });
    await waitFor(() => c.nc.status === 'kicked', 5000);
    c.stop();
    pageSide.close();
  });

  it('a guest connects while the page\'s save is being written: its Hello is kept and it joins; one that closes meanwhile never joins', async () => {
    const storage = new SlowStorage(150);
    const { pageSide, reports, host } = startWorker(storage);
    pageSide.postMessage({ type: 'create', meta: testMeta('w'), options: { generator: FLAT, exampleShip: false } });
    const me = pageClient(pageSide, true, 'page');
    await waitFor(() => me.ticks.length > 0 && reports.some((r) => r.type === 'saved'), 5000);
    pageSide.postMessage({ type: 'openRoom' });
    pageSide.postMessage({ type: 'save' });
    const guest = pageClient(pageSide, false, 'guest');
    const gone = pageClient(pageSide, false, 'gone');
    gone.nc.leave(); // Hello sent, then closed before the connect is carried out
    gone.stop();
    await waitFor(() => guest.ticks.length >= 5, 5000);
    expect(guest.nc.welcome?.isHost).toBe(false);
    expect(reports.filter((r) => r.type === 'saved').length).toBe(2);
    expect(host.sim.players.get('gone')).toBeUndefined();
    expect(host.netServer.connections().map((c) => c.key).sort()).toEqual(['guest', 'page']);
    pageSide.postMessage({ type: 'shutdown', save: false });
    await waitFor(() => guest.nc.status === 'kicked' && me.nc.status === 'kicked', 5000);
    guest.stop();
    me.stop();
    pageSide.close();
  });

  it('a Worker whose storage is memory only says so in ready (persistent false and the reason); saves still report ok', async () => {
    const { pageSide, reports } = startWorker(new MemoryStorage(), false);
    pageSide.postMessage({ type: 'create', meta: testMeta('m'), options: { generator: FLAT, exampleShip: false } });
    await waitFor(() => reports.some((r) => r.type === 'saved'), 5000);
    expect(reports[0]).toMatchObject({ type: 'ready', meta: { id: 'm' }, persistent: false, reason: 'unavailable' });
    expect(reports[1]).toMatchObject({ type: 'saved', ok: true });
    pageSide.postMessage({ type: 'shutdown', save: false });
    await waitFor(() => reports.some((r) => r.type === 'closed'), 5000);
    pageSide.close();
  });
});
