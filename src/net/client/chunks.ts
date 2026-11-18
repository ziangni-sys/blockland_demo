/**
 * The client's chunk loading (docs/NETCODE.md sections 5 and 6): which columns the server has
 * subscribed this client to, the cells of each, and the pristine columns being generated.
 *
 * The client never decides itself which columns to load or unload: every column arrives as a
 * snapshot in a TickBatch and leaves with an unsubscription. applyBatch (apply.ts) hands the cell
 * parts of the chunk sections here (ReplicaColumns); the world glue stays with the batch applier.
 *
 * SUBSCRIPTION TABLE. Every subscribed column has an entry: present (its Chunk is in the World) or
 * generating (a pristine snapshot whose cells the ChunkSource is still building). Every snapshot
 * gives its column a new generation number, which the generation request carries; a result whose
 * number is not the column's current one is dropped (staleResults). So:
 *  - a delta for a generating column is queued in arrival order and applied to the generated cells
 *    before the Chunk is inserted (the column is not drawn and takes no part in collisions until
 *    then, so nobody sees the gap);
 *  - an unsubscription drops the entry with its queue: an in-flight generation is then stale;
 *  - any snapshot, a resend included, replaces everything the column had pending.
 * Otherwise "pristine snapshot, unsubscribe, edit, resubscribe (cells snapshot), the old generation
 * finishes" would lay the generated cells and the old deltas over the new snapshot for good.
 *
 * INSERTION. A column's Chunk goes into the World as soon as its cells are complete (at once for a
 * cells snapshot, when the generation finishes for a pristine one, possibly inside the ChunkSource's
 * callback), and `onInsert` runs right after World.addChunk (the replica lights it there:
 * LightEngine.initChunk). Removing a column is only World.removeChunk: the light engine notices
 * missing chunks itself (light/engine.ts "WHICH CHUNKS EXIST").
 */
import { CHUNK_SIZE } from '../../core/constants';
import { Chunk, chunkKey } from '../../voxel/chunk';
import { World } from '../../voxel/world';
import type { Cell } from '../protocol';
import type { ReplicaColumns } from './apply';

/**
 * Builds pristine columns (the generator named by Welcome's GeneratorSpec): the terrain worker pool
 * in the browser, a synchronous generator in tests. `done` must be called exactly once, now or
 * later, with the column's cells (CHUNK_VOLUME, index lx | lz<<4 | y<<8), which the caller then
 * owns. The source deals with its own failures (retry, main-thread fallback, an empty column as the
 * last resort): a column it never answers stays out of the world.
 */
export interface ChunkSource {
  generate(cx: number, cz: number, done: (cells: Uint16Array) => void): void;
}

interface ColumnEntry {
  readonly cx: number;
  readonly cz: number;
  /** The generation number of the column's latest snapshot. */
  readonly gen: number;
  /** Its Chunk is in the World (else a pristine column still generating). */
  present: boolean;
  /** Deltas that arrived while generating, in order. */
  readonly queue: Array<ReadonlyArray<readonly [number, Cell]>>;
}

export class ClientChunks implements ReplicaColumns {
  readonly world = new World();
  private readonly columns = new Map<number, ColumnEntry>();
  private nextGen = 0;
  private generatingCount = 0;
  /** Generation results dropped because their column was unsubscribed or snapshotted again meanwhile. */
  staleResults = 0;

  constructor(
    private readonly source: ChunkSource,
    /** Runs right after a column's Chunk was added to the World (light it here). */
    private readonly onInsert: (chunk: Chunk) => void,
  ) {}

  /** Subscribed (snapshot applied, perhaps still generating). */
  has(cx: number, cz: number): boolean {
    return this.columns.has(chunkKey(cx, cz));
  }

  /** Subscribed and in the World. */
  present(cx: number, cz: number): boolean {
    return this.columns.get(chunkKey(cx, cz))?.present === true;
  }

  /** Subscribed columns whose pristine cells are still being generated. */
  get generating(): number {
    return this.generatingCount;
  }

  /** Subscribed columns. */
  get size(): number {
    return this.columns.size;
  }

  /** Deltas waiting for the generation of their column (all columns). */
  queuedDeltas(): number {
    let n = 0;
    for (const e of this.columns.values()) n += e.queue.length;
    return n;
  }

  unsubscribe(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const e = this.columns.get(key);
    if (e === undefined) return;
    this.drop(key, e);
  }

  /** Replace the column with a snapshot: its cells (the caller hands them over) or 'pristine'. */
  snapshot(cx: number, cz: number, cells: 'pristine' | Uint16Array): void {
    const key = chunkKey(cx, cz);
    const old = this.columns.get(key);
    if (old !== undefined) this.drop(key, old);
    const e: ColumnEntry = { cx, cz, gen: ++this.nextGen, present: false, queue: [] };
    this.columns.set(key, e);
    if (cells !== 'pristine') {
      this.insert(e, cells);
      return;
    }
    this.generatingCount++;
    const gen = e.gen;
    this.source.generate(cx, cz, (generated) => this.generated(key, gen, generated));
  }

  /** Cells of a delta ([index, cell], index ascending); queued while the column generates. */
  delta(cx: number, cz: number, cells: ReadonlyArray<readonly [number, Cell]>): void {
    const e = this.columns.get(chunkKey(cx, cz));
    if (e === undefined) throw new Error(`ClientChunks: delta for column ${cx},${cz}, which is not subscribed`);
    if (!e.present) {
      e.queue.push(cells);
      return;
    }
    const world = this.world;
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    for (const [i, cell] of cells) world.setCell(x0 + (i & 15), i >> 8, z0 + ((i >> 4) & 15), cell);
  }

  private generated(key: number, gen: number, cells: Uint16Array): void {
    const e = this.columns.get(key);
    if (e === undefined || e.gen !== gen || e.present) {
      this.staleResults++;
      return;
    }
    this.generatingCount--;
    for (const d of e.queue) for (const [i, cell] of d) cells[i] = cell;
    e.queue.length = 0;
    this.insert(e, cells);
  }

  private insert(e: ColumnEntry, cells: Uint16Array): void {
    const chunk = new Chunk(e.cx, e.cz, cells);
    this.world.addChunk(chunk);
    e.present = true;
    this.onInsert(chunk);
  }

  private drop(key: number, e: ColumnEntry): void {
    this.columns.delete(key);
    if (e.present) this.world.removeChunk(e.cx, e.cz);
    else this.generatingCount--;
  }
}
