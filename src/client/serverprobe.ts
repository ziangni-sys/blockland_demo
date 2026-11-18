/**
 * A check that the server Worker runs in this page (scripts/e2e-server-worker.mjs calls it through
 * window.__blocklands.serverProbe): start the Worker, create a small flat world in it, connect a
 * NetClient over a PortTransport as the host's own client, let it join and apply the TickBatches
 * that arrive for `ms` milliseconds (frames and heartbeats from timers), then shut the server
 * down. The browser game does not run on the server yet (NETCODE package 9); this is the only
 * page code that starts it.
 *
 * The world is written to this browser's storage like any new world (id 'server-probe-<time>');
 * the probe deletes it again at the end (after the Worker is gone), so the main menu's world list
 * keeps no trace of it. `fromDataUrl` starts the Worker from a data: URL (opaque-origin sandboxes,
 * client/workerfactory.ts).
 */
import { NetClient } from '../net/client/netclient';
import type { HostToPage, PageToHost } from '../net/host/control';
import { PortTransport } from '../net/host/port';
import { SAVE_VERSION, type WorldMeta } from '../save/codec';
import { openBestStorage } from '../save/idb';
import { generatorFromSpec } from '../worldgen/generator';
import { createServerWorker, createServerWorkerFromDataUrl } from './workerfactory';

export interface ServerProbeResult {
  /** The Worker reported `ready` for the new world. */
  worldReady: boolean;
  /** What `ready` said about the Worker's storage (null before ready). */
  persistent: boolean | null;
  storageReason: string | null;
  /** The probe's world is still in this browser's storage at the end (it should not be). */
  worldLeft: boolean;
  welcome: boolean;
  isHost: boolean;
  /** NetClient's statuses in order (expected: connecting, joining, ready, kicked). */
  statuses: string[];
  /** TickBatches received and applied. */
  batches: number;
  firstTick: number;
  lastTick: number;
  /** Every batch was the tick after the one before. */
  contiguous: boolean;
  /** NetClient became ready (Welcome, the ready flag, the ready zone in the replica). */
  ready: boolean;
  /** Columns in the replica when the server shut down. */
  columns: number;
  /** The Kick that ended the connection (expected: 'shutdown'). */
  kick: string | null;
  /** The Worker reported `closed`. */
  closed: boolean;
  /** Host reports in order (their types). */
  reports: string[];
  errors: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) return false;
    await delay(20);
  }
  return true;
}

export async function runServerProbe(ms: number, opts: { fromDataUrl?: boolean } = {}): Promise<ServerProbeResult> {
  const out: ServerProbeResult = {
    worldReady: false,
    persistent: null,
    storageReason: null,
    worldLeft: false,
    welcome: false,
    isHost: false,
    statuses: [],
    batches: 0,
    firstTick: -1,
    lastTick: -1,
    contiguous: true,
    ready: false,
    columns: 0,
    kick: null,
    closed: false,
    reports: [],
    errors: [],
  };
  const worker = await (opts.fromDataUrl === true ? createServerWorkerFromDataUrl() : createServerWorker());
  const post = (m: PageToHost<MessagePort>, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);
  worker.addEventListener('message', (e) => {
    const r = e.data as HostToPage;
    out.reports.push(r.type);
    if (r.type === 'ready') {
      out.worldReady = true;
      out.persistent = r.persistent;
      out.storageReason = r.reason;
    }
    else if (r.type === 'closed') out.closed = true;
    else if (r.type === 'error') out.errors.push(`${r.what}: ${r.message}`);
  });
  worker.addEventListener('error', () => out.errors.push('the server Worker failed'));
  const timers: ReturnType<typeof setInterval>[] = [];
  const now = Date.now();
  const worldId = `server-probe-${now}`;
  try {
    const meta: WorldMeta = { id: worldId, name: 'Server probe', seed: 'probe', seedHash: 1, mode: 'creative', createdAt: now, lastPlayed: now, version: SAVE_VERSION, time: 0 };
    post({ type: 'create', meta, options: { generator: { kind: 'flat', seed: 1, layers: [{ cell: 1, thickness: 4 }] }, exampleShip: false } });
    if (!(await until(() => out.worldReady || out.errors.length > 0, 20_000))) out.errors.push('no ready from the server Worker');
    if (!out.worldReady) return out;
    const channel = new MessageChannel();
    post({ type: 'connect', port: channel.port2, local: true }, [channel.port2]);
    const client = new NetClient({
      openTransport: (ready) => ready(new PortTransport(channel.port1)),
      now: () => performance.now(),
      chunkSource: (spec) => {
        const gen = generatorFromSpec(spec);
        return { generate: (cx, cz, done) => done(gen.generate(cx, cz)) };
      },
      playerKey: 'server-probe',
      name: 'Probe',
      viewRadius: 3,
    });
    client.onStatus = (s) => {
      out.statuses.push(s);
      if (s === 'joining') {
        out.welcome = true;
        out.isHost = client.welcome!.isHost;
      } else if (s === 'ready') out.ready = true;
      else if (s === 'kicked') out.kick = client.kick!.reason;
      else if (s === 'refused') out.errors.push(`refused: ${client.refusal!.reason}`);
      else if (s === 'failed') out.errors.push(client.failure ?? 'the connection failed');
    };
    client.onBatch = (b, replica) => {
      if (out.lastTick >= 0 && b.tick !== out.lastTick + 1) out.contiguous = false;
      if (out.firstTick < 0) out.firstTick = b.tick;
      out.lastTick = b.tick;
      out.batches++;
      out.columns = replica.world.chunks.size;
    };
    client.start();
    timers.push(setInterval(() => client.frame(performance.now()), 16));
    timers.push(setInterval(() => client.heartbeat(performance.now()), 1000));
    await delay(ms);
    post({ type: 'shutdown', save: false });
    await until(() => out.closed && out.kick !== null, 5000);
    return out;
  } finally {
    for (const t of timers) clearInterval(t);
    worker.terminate();
    if (out.persistent === true) await removeWorld(worldId, out);
  }
}

/** Delete the probe's world from this page's storage (the Worker's database) and check it is gone. */
async function removeWorld(worldId: string, out: ServerProbeResult): Promise<void> {
  const best = await openBestStorage(undefined, { giveUp: delay(5000) });
  if (!best.persistent) {
    out.errors.push(`the page cannot open the storage to remove its world: ${best.reason}`);
    out.worldLeft = true;
    return;
  }
  try {
    await best.storage.deleteWorld(worldId);
    out.worldLeft = (await best.storage.listWorldIds()).includes(worldId);
  } catch (e) {
    out.errors.push(`removing the probe's world failed: ${e instanceof Error ? e.message : String(e)}`);
    out.worldLeft = true;
  } finally {
    best.storage.close();
  }
}
