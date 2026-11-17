/**
 * Worker constructors. `?worker&inline` makes Vite bundle each worker entry into a string
 * that is started from a blob URL in every build mode (the single-file artifact has no other
 * files to load), and from a plain module URL in the dev server.
 *
 * Kept in its own module so nothing else in the client (and no unit test) pulls the worker
 * bundles in.
 */
import GenWorker from '../worldgen/worker?worker&inline';
import MeshWorker from '../mesh/worker?worker&inline';
import type { WorkerLike } from './workers';

export function createGenWorker(): WorkerLike {
  return new GenWorker({ name: 'blocklands-terrain' });
}

export function createMeshWorker(): WorkerLike {
  return new MeshWorker({ name: 'blocklands-mesh' });
}
