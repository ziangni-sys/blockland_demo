/**
 * Mesh Worker entry: answers MeshRequest with MeshResponse, transferring the geometry
 * buffers (zero-copy). One long-lived Mesher per Worker reuses its scratch between jobs.
 *
 * Create it from the client with
 *   new Worker(new URL('../mesh/worker.ts', import.meta.url), { type: 'module' })
 */
import { Mesher } from './mesher';
import { meshTransferables, type MeshData, type MeshRequest, type MeshResponse } from './types';

/** The part of the dedicated-worker global scope this entry uses. */
export interface MeshWorkerScope {
  onmessage: ((e: { data: MeshRequest }) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

/**
 * Reply to a job that threw. It is still a `type: 'mesh'` response for the same id, so a
 * client that tracks jobs in flight is released, but `error` is set and `data` is empty:
 * the client must KEEP the mesh it already shows for that section / structure instead of
 * installing the empty data (which would punch a hole in the world or hide a ship).
 * Valid inputs never throw; this only fires on a client bug (e.g. arrays that do not match
 * the box dimensions), and `error` says what was wrong.
 *
 * Clients test `'error' in res` and import this type with `import type` only: a value
 * import of this file from the main thread would bundle the whole mesher into it.
 */
export interface MeshErrorResponse extends MeshResponse {
  error: string;
}

/**
 * Install the request handler on a worker scope. Exported so tests can drive the
 * protocol with a fake scope. Every request is answered exactly once, in order.
 */
export function serveMeshRequests(scope: MeshWorkerScope): void {
  const mesher = new Mesher();
  scope.onmessage = (e) => {
    const req = e.data;
    if (req === null || typeof req !== 'object' || req.type !== 'mesh') return;
    let data: MeshData;
    try {
      data = mesher.build(req.input);
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[mesh worker] job ${req.id} failed: ${error}`);
      const res: MeshErrorResponse = { type: 'mesh', id: req.id, data: { opaque: null, cutout: null, translucent: null }, error };
      scope.postMessage(res, []);
      return;
    }
    const res: MeshResponse = { type: 'mesh', id: req.id, data };
    scope.postMessage(res, meshTransferables(data));
  };
}

// Bind only inside a real worker: Node (where tests import this file) has no worker scope,
// and on a page's main thread `self` is the window, which must not be hijacked.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  const ctx = self as unknown as MeshWorkerScope;
  serveMeshRequests(ctx);
}
