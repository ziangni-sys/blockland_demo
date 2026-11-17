/**
 * Chunk generation Worker entry.
 *
 * Protocol: receives GenRequest { type: 'gen', id, seed, cx, cz } and replies
 * GenResponse { type: 'gen', id, cx, cz, cells }, transferring cells.buffer. One generator
 * is kept per seed (see GenService).
 *
 * Importing this module outside a Worker (tests, or by accident from the main thread) does
 * nothing: the message handler is only installed inside a WorkerGlobalScope.
 */
import { GenService, type GenErrorResponse, type GenRequest, type GenResponse } from './protocol';

export type { GenErrorResponse, GenRequest, GenResponse };

/** The parts of the worker global this module uses. */
export interface GenWorkerScope {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

/** Install the generation handler on a worker scope. Returns the service (for tests). */
export function startGenWorker(ctx: GenWorkerScope): GenService {
  const service = new GenService();
  ctx.onmessage = (ev) => {
    const msg = ev.data as GenRequest | null;
    if (!msg || msg.type !== 'gen') return;
    const res = service.handle(msg);
    if (res.type === 'gen') ctx.postMessage(res, [res.cells.buffer]);
    else ctx.postMessage(res);
  };
  return service;
}

function inWorker(): boolean {
  const g = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
  return typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope;
}

if (inWorker()) startGenWorker(self as unknown as GenWorkerScope);
