/**
 * A check that the server Worker runs in this page (scripts/e2e-server-worker.mjs calls it through
 * window.__blocklands.serverProbe): start the Worker, create a small flat world in it, connect a
 * PortTransport as the host's own client, complete the handshake, apply the TickBatches that
 * arrive for `ms` milliseconds to a replica, then shut the server down. The browser game does
 * not run on the server yet (NETCODE package 9); this is the only page code that starts it.
 *
 * The world is written to this browser's storage like any new world (id 'server-probe-<time>');
 * the probe deletes it again at the end (after the Worker is gone), so the main menu's world list
 * keeps no trace of it. `fromDataUrl` starts the Worker from a data: URL (opaque-origin sandboxes,
 * client/workerfactory.ts).
 */
import { applyBatch, applyWelcome, ReplicaState } from '../net/client/apply';
import { decodeServerMessage, encodeClientMessage } from '../net/codec';
import type { HostToPage, PageToHost } from '../net/host/control';
import { PortTransport } from '../net/host/port';
import { BUILD_ID } from '../net/protocol';
import { RELIABLE } from '../net/transport';
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
  /** TickBatches received and applied. */
  batches: number;
  firstTick: number;
  lastTick: number;
  /** Every batch was the tick after the one before. */
  contiguous: boolean;
  /** The ready flag arrived. */
  ready: boolean;
  /** Columns in the replica at the end. */
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
  const now = Date.now();
  const worldId = `server-probe-${now}`;
  try {
    const meta: WorldMeta = { id: worldId, name: 'Server probe', seed: 'probe', seedHash: 1, mode: 'creative', createdAt: now, lastPlayed: now, version: SAVE_VERSION, time: 0 };
    post({ type: 'create', meta, options: { generator: { kind: 'flat', seed: 1, layers: [{ cell: 1, thickness: 4 }] }, exampleShip: false } });
    if (!(await until(() => out.worldReady || out.errors.length > 0, 20_000))) out.errors.push('no ready from the server Worker');
    if (!out.worldReady) return out;
    const channel = new MessageChannel();
    post({ type: 'connect', port: channel.port2, local: true }, [channel.port2]);
    const transport = new PortTransport(channel.port1);
    let replica: ReplicaState | null = null;
    transport.onMessage = (ch, bytes) => {
      try {
        const m = decodeServerMessage(bytes, ch);
        if (m.type === 'welcome') {
          out.welcome = true;
          out.isHost = m.isHost;
          const gen = generatorFromSpec(m.generator);
          replica = new ReplicaState({ generate: (cx, cz) => gen.generate(cx, cz) });
          applyWelcome(replica, m);
        } else if (m.type === 'tickBatch') {
          if (replica === null) throw new Error('a batch before Welcome');
          applyBatch(replica, m);
          if (out.lastTick >= 0 && m.tick !== out.lastTick + 1) out.contiguous = false;
          if (out.firstTick < 0) out.firstTick = m.tick;
          out.lastTick = m.tick;
          out.batches++;
          if (replica.ready) out.ready = true;
          out.columns = replica.world.chunks.size;
        } else if (m.type === 'kick') out.kick = m.reason;
        else if (m.type === 'refuse') out.errors.push(`refused: ${m.reason}`);
      } catch (e) {
        out.errors.push(e instanceof Error ? e.message : String(e));
      }
    };
    transport.send(RELIABLE, encodeClientMessage({ type: 'hello', build: BUILD_ID, playerKey: 'server-probe', name: 'Probe', viewRadius: 3 }));
    await delay(ms);
    post({ type: 'shutdown', save: false });
    await until(() => out.closed && out.kick !== null, 5000);
    return out;
  } finally {
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
