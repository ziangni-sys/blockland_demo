/**
 * Package 8: the server Worker's entry (net/host/worker.ts) driven through a MessageChannel in
 * Node: the page side creates a world, connects a PortTransport over a second MessageChannel,
 * completes the handshake and receives tick batches from real timers; then shuts the server down.
 * (scripts/e2e-server-worker.mjs does the same in a real browser with both builds.)
 */
import { describe, expect, it } from 'vitest';
import { applyBatch, applyWelcome, ReplicaState } from '../../src/net/client/apply';
import { decodeServerMessage, encodeClientMessage } from '../../src/net/codec';
import type { HostToPage } from '../../src/net/host/control';
import { PortTransport } from '../../src/net/host/port';
import { startServerWorker, workerDeps, type ServerWorkerScope } from '../../src/net/host/worker';
import { BUILD_ID, type ServerMessage } from '../../src/net/protocol';
import { RELIABLE } from '../../src/net/transport';
import { MemoryStorage } from '../../src/save/storage';
import { ServerHost } from '../../src/net/host/host';
import { generatorFromSpec } from '../../src/worldgen/generator';
import { FLAT, testMeta } from './harness';

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

/** The page's end of a connection: a PortTransport whose messages are decoded and kept. */
function pageConnection(pageSide: MessagePort, local: boolean): { t: PortTransport; got: ServerMessage[]; closed: () => string | null } {
  const conn = new MessageChannel();
  pageSide.postMessage({ type: 'connect', port: conn.port2, local }, [conn.port2]);
  const t = new PortTransport(conn.port1);
  const got: ServerMessage[] = [];
  let closedWith: string | null = null;
  t.onMessage = (channel, bytes) => got.push(decodeServerMessage(bytes, channel));
  t.onClose = (r) => (closedWith = r);
  return { t, got, closed: () => closedWith };
}

function hello(t: PortTransport, key: string): void {
  t.send(RELIABLE, encodeClientMessage({ type: 'hello', build: BUILD_ID, playerKey: key, name: key, viewRadius: 2 }));
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

    const conn = new MessageChannel();
    pageSide.postMessage({ type: 'connect', port: conn.port2, local: true }, [conn.port2]);
    const t = new PortTransport(conn.port1);
    const got: ServerMessage[] = [];
    let replica: ReplicaState | null = null;
    t.onMessage = (channel, bytes) => {
      const m = decodeServerMessage(bytes, channel);
      got.push(m);
      if (m.type === 'welcome') {
        const gen = generatorFromSpec(m.generator);
        replica = new ReplicaState({ generate: (cx, cz) => gen.generate(cx, cz) });
        applyWelcome(replica, m);
      } else if (m.type === 'tickBatch') applyBatch(replica!, m);
    };
    t.send(RELIABLE, encodeClientMessage({ type: 'hello', build: BUILD_ID, playerKey: 'page', name: 'Page', viewRadius: 2 }));
    await waitFor(() => got.filter((m) => m.type === 'tickBatch').length >= 20, 5000);
    expect(got[0]!.type).toBe('welcome');
    const ticks = got.flatMap((m) => (m.type === 'tickBatch' ? [m.tick] : []));
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBe(ticks[i - 1]! + 1);
    expect(replica!.ready).toBe(true);
    expect(replica!.isHost).toBe(true);

    let closedWith: string | null = null;
    t.onClose = (r) => (closedWith = r);
    pageSide.postMessage({ type: 'shutdown', save: true });
    await waitFor(() => reports.some((r) => r.type === 'closed') && closedWith !== null, 5000);
    expect(got.at(-1)).toMatchObject({ type: 'kick', reason: 'shutdown' });
    expect(reports.filter((r) => r.type === 'saved').every((r) => r.type === 'saved' && r.ok)).toBe(true);
    expect((await storage.getMeta('wk'))?.time).toBeGreaterThan(960);
    pageSide.close();
  });

  it('a connect posted right behind a load that is still reading: the Hello sent at once is kept, Welcome and batches arrive', async () => {
    const storage = new SlowStorage(60);
    const maker = new ServerHost({ clock: workerDeps().clock, openStorage: async () => ({ storage, persistent: true }), report: () => {}, rabbits: false });
    await maker.create(testMeta('w'), { generator: FLAT, exampleShip: false });
    expect(await maker.shutdown(true)).toBe(true);

    const { pageSide, reports } = startWorker(storage);
    pageSide.postMessage({ type: 'load', worldId: 'w' });
    const c = pageConnection(pageSide, true);
    hello(c.t, 'page');
    await waitFor(() => c.got.filter((m) => m.type === 'tickBatch').length >= 5, 5000);
    expect(reports[0]).toMatchObject({ type: 'ready', persistent: true, reason: null });
    expect(c.got[0]).toMatchObject({ type: 'welcome', isHost: true });
    pageSide.postMessage({ type: 'shutdown', save: false });
    await waitFor(() => c.closed() !== null, 5000);
    pageSide.close();
  });

  it('a guest connects while the page\'s save is being written: its Hello is kept and it joins; one that closes meanwhile never joins', async () => {
    const storage = new SlowStorage(150);
    const { pageSide, reports, host } = startWorker(storage);
    pageSide.postMessage({ type: 'create', meta: testMeta('w'), options: { generator: FLAT, exampleShip: false } });
    const me = pageConnection(pageSide, true);
    hello(me.t, 'page');
    await waitFor(() => me.got.some((m) => m.type === 'tickBatch') && reports.some((r) => r.type === 'saved'), 5000);
    pageSide.postMessage({ type: 'openRoom' });
    pageSide.postMessage({ type: 'save' });
    const guest = pageConnection(pageSide, false);
    hello(guest.t, 'guest');
    const gone = pageConnection(pageSide, false);
    hello(gone.t, 'gone');
    gone.t.close('changed my mind');
    await waitFor(() => guest.got.filter((m) => m.type === 'tickBatch').length >= 5, 5000);
    expect(guest.got[0]).toMatchObject({ type: 'welcome', isHost: false });
    expect(reports.filter((r) => r.type === 'saved').length).toBe(2);
    expect(host.sim.players.get('gone')).toBeUndefined();
    expect(host.netServer.connections().map((c) => c.key).sort()).toEqual(['guest', 'page']);
    pageSide.postMessage({ type: 'shutdown', save: false });
    await waitFor(() => guest.closed() !== null && me.closed() !== null, 5000);
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
