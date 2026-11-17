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
 * Install the request handler on a worker scope. Exported so tests can drive the
 * protocol with a fake scope. A job that throws (malformed input) is answered with an
 * empty MeshData so the client never waits forever on a lost id; the error is logged.
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
      console.error(`[mesh worker] job ${req.id} failed:`, err);
      data = { opaque: null, cutout: null, translucent: null };
    }
    const res: MeshResponse = { type: 'mesh', id: req.id, data };
    scope.postMessage(res, meshTransferables(data));
  };
}

// Only bind when actually running as a worker (Node, where tests import this file, has no `self`).
if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  const ctx = self as unknown as MeshWorkerScope;
  serveMeshRequests(ctx);
}
