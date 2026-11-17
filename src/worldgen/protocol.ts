/**
 * Chunk generation message protocol (main thread <-> generation Worker), and the
 * environment-independent service behind it so it can be tested without a Worker.
 */
import { TerrainGenerator } from './generator';

/** Main thread -> worker: generate chunk (cx, cz) of the world with this seed. */
export interface GenRequest {
  type: 'gen';
  /** Caller-chosen id echoed in the reply. */
  id: number;
  seed: number;
  cx: number;
  cz: number;
}

/** Worker -> main thread. `cells.buffer` is transferred (CHUNK_VOLUME cells, see voxel/chunk.ts). */
export interface GenResponse {
  type: 'gen';
  id: number;
  cx: number;
  cz: number;
  cells: Uint16Array;
}

/**
 * Worker -> main thread when a request could not be served (malformed request, or an
 * exception during generation). Not part of the original contract; see the report.
 */
export interface GenErrorResponse {
  type: 'gen-error';
  id: number;
  cx: number;
  cz: number;
  message: string;
}

/** How many seeds keep a live generator (a new world rarely comes back to an old seed). */
export const MAX_GENERATORS = 4;

/** Serves GenRequests, keeping one TerrainGenerator per seed (most recently used first). */
export class GenService {
  private readonly generators = new Map<number, TerrainGenerator>();

  /** Number of seeds with a live generator (at most MAX_GENERATORS). */
  get size(): number {
    return this.generators.size;
  }

  /** The generator for `seed`, created on first use. */
  generator(seed: number): TerrainGenerator {
    const key = seed >>> 0;
    let gen = this.generators.get(key);
    if (gen) {
      // Refresh recency (Map iteration order is insertion order).
      this.generators.delete(key);
    } else {
      gen = new TerrainGenerator(key);
      if (this.generators.size >= MAX_GENERATORS) {
        const oldest = this.generators.keys().next().value;
        if (oldest !== undefined) this.generators.delete(oldest);
      }
    }
    this.generators.set(key, gen);
    return gen;
  }

  handle(req: GenRequest): GenResponse | GenErrorResponse {
    const id = typeof req.id === 'number' ? req.id : -1;
    const cx = req.cx;
    const cz = req.cz;
    if (!Number.isInteger(cx) || !Number.isInteger(cz) || typeof req.seed !== 'number') {
      return { type: 'gen-error', id, cx, cz, message: 'malformed gen request' };
    }
    try {
      const cells = this.generator(req.seed).generate(cx, cz);
      return { type: 'gen', id, cx, cz, cells };
    } catch (err) {
      return { type: 'gen-error', id, cx, cz, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
