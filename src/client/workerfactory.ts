/**
 * Worker constructors. `?worker&inline` makes Vite bundle each worker entry into a string
 * that is started from a blob URL in every build mode (the single-file artifact has no other
 * files to load), and from a plain module URL in the dev server.
 *
 * Opaque-origin sandboxes (an iframe with `sandbox="allow-scripts"`) refuse MODULE workers
 * from blob URLs — asynchronously, through an error event — but run the same code from a
 * data: URL. Vite's wrapper falls back to a data: URL only when creating the blob URL throws,
 * so the `...FromDataUrl` variants make URL.createObjectURL throw for the duration of the
 * constructor call. The worker pool tries them when the blob-URL workers fail to start.
 *
 * Kept in its own module so nothing else in the client (and no unit test) pulls the worker
 * bundles in.
 */
import GenWorker from '../worldgen/worker?worker&inline';
import MeshWorker from '../mesh/worker?worker&inline';
import type { WorkerLike } from './workers';

type WorkerCtor = new (options?: { name?: string }) => Worker;

function withoutBlobUrls(Ctor: WorkerCtor, name: string): WorkerLike {
  const urlApi = URL as unknown as { createObjectURL: (obj: Blob) => string };
  const original = urlApi.createObjectURL;
  urlApi.createObjectURL = () => {
    throw new Error('blob URLs disabled for this worker');
  };
  try {
    return new Ctor({ name });
  } finally {
    urlApi.createObjectURL = original;
  }
}

export function createGenWorker(): WorkerLike {
  return new GenWorker({ name: 'blocklands-terrain' });
}

export function createGenWorkerFromDataUrl(): WorkerLike {
  return withoutBlobUrls(GenWorker, 'blocklands-terrain');
}

export function createMeshWorker(): WorkerLike {
  return new MeshWorker({ name: 'blocklands-mesh' });
}

export function createMeshWorkerFromDataUrl(): WorkerLike {
  return withoutBlobUrls(MeshWorker, 'blocklands-mesh');
}

/**
 * The game server (net/host/worker.ts: a ServerHost driven by host control messages). Its bundle
 * is loaded on the first call (a chunk of its own in the normal build), so the page does not
 * carry it before it starts a server. The browser game does not run on it yet (NETCODE package
 * 9); window.__blocklands.serverProbe starts one (client/serverprobe.ts).
 */
export async function createServerWorker(): Promise<WorkerLike> {
  return new (await serverWorkerCtor())({ name: 'blocklands-server' });
}

/** createServerWorker from a data: URL, for opaque-origin sandboxes (see the file comment). */
export async function createServerWorkerFromDataUrl(): Promise<WorkerLike> {
  return withoutBlobUrls(await serverWorkerCtor(), 'blocklands-server');
}

async function serverWorkerCtor(): Promise<WorkerCtor> {
  return (await import('../net/host/worker?worker&inline')).default;
}
