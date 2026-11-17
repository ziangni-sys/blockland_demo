/**
 * Change capture for the replication (docs/NETCODE.md sections 5 to 8, 11): what changed in a
 * Simulation since the last take(), collected continuously, between ticks as well as during one.
 *
 *  - WORLD CELLS (world.onCellChange) and WORLD GLUE (worldGlue.onChange), by column: the final
 *    value of every changed cell index and the final state of every changed glue face. A cell
 *    that changes several times keeps only its last value; a face glued and unglued ends
 *    "removed". Cells that arrive with a chunk (generation, restore) do not pass through setCell
 *    and are not changes: the column's content is what it was (section 6). Every change also
 *    bumps the column's version, which keys the shared snapshot bytes.
 *  - STRUCTURES. sync() compares structures.all() with what it saw last (the reference first,
 *    then identity, like Simulation.syncStructures) and hooks grid.onCellChange and glue.onChange
 *    of every structure that appeared, unhooking the ones that went. A structure that appears is
 *    sent whole (a spawn record of its state at the end of the tick), so the changes it had before
 *    it was hooked are not needed; one that appears and disappears between two syncs is never
 *    seen, and nothing is sent about it (its world cell changes are captured as usual).
 *  - ENTITIES. sync() compares the entity list with the last one by id and identity (a player who
 *    rejoins under its kept id is a new entity object): appeared, and the ids that went (an id
 *    whose object was replaced is only reported as appeared). No allocation per entity.
 *  - EVENTS (sim.events), in order, except structureAdded / structureRemoved (section 11: the
 *    spawns and removals stand for them).
 *
 * Changes are collected per hook call; nothing is read back from the grids, so a column unloaded
 * after a change, or a structure emptied in the same tick, still reports the right final values.
 * The hooks are copy-on-write emitters, so the capture never disturbs a dispatch in progress.
 */
import { CHUNK_MASK, CHUNK_SHIFT, WORLD_HEIGHT } from '../../core/constants';
import type { Axis } from '../../core/dirs';
import type { Entity } from '../../entities/entity';
import type { Simulation } from '../../sim/simulation';
import type { SimEvent } from '../../sim/view';
import type { Structure } from '../../structures/structure';
import { chunkKey } from '../../voxel/chunk';

/** What changed in one column since the last take. */
export interface ColumnChanges {
  readonly cx: number;
  readonly cz: number;
  /** Chunk cell index (lx | lz<<4 | y<<8) -> its final cell. */
  readonly cells: Map<number, number>;
  /** Chunk glue face (lx | lz<<4 | y<<8 | axis<<15, canonical end in the column) -> glued at the end. */
  readonly glue: Map<number, boolean>;
}

/** What changed in one structure since the last take (local cells). */
export interface StructureChanges {
  /** "x,y,z" -> [x, y, z, final cell]. */
  readonly cells: Map<string, [number, number, number, number]>;
  /** "x,y,z,axis" -> [x, y, z, axis, glued at the end] (canonical end cell). */
  readonly glue: Map<string, [number, number, number, Axis, boolean]>;
}

/** Everything collected since the last take. */
export interface CaptureTake {
  /** By chunk key. */
  readonly columns: Map<number, ColumnChanges>;
  /** By structure id, for the structures hooked during the whole interval. */
  readonly structures: Map<number, StructureChanges>;
  /** In emission order, without structureAdded / structureRemoved. */
  readonly events: SimEvent[];
}

/** Result of sync(): what appeared and what went since the last sync. */
export interface SyncResult {
  readonly appearedStructures: ReadonlySet<Structure>;
  readonly appearedEntities: readonly Entity[];
  /** Ids of entities that are no longer in the simulation. */
  readonly goneEntities: readonly number[];
}

interface SeenEntity {
  e: Entity;
  /** Number of the last sync() that saw it. */
  seen: number;
}

interface Hooked {
  readonly s: Structure;
  readonly off: () => void;
}

export class ChangeCapture {
  private columns = new Map<number, ColumnChanges>();
  private structureChanges = new Map<number, StructureChanges>();
  private events: SimEvent[] = [];
  /** Column versions: bumped by every cell or glue change in the column. Never reset. */
  private readonly versions = new Map<number, number>();

  private knownList: readonly Structure[] = [];
  private readonly hooked = new Map<Structure, Hooked>();
  private readonly entities = new Map<number, SeenEntity>();
  private syncs = 0;

  private readonly offs: Array<() => void> = [];

  constructor(private readonly sim: Simulation) {
    this.offs.push(
      sim.world.onCellChange((x, y, z, _old, cell) => {
        const col = this.column(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
        col.cells.set((x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8), cell);
      }),
      sim.worldGlue.onChange((added, x, y, z, axis) => {
        // The wire carries faces whose canonical end lies in the column's 128 layers (section 6);
        // the glue rules never keep a face with no glueable block, so none lies outside them.
        if (y < 0 || y >= WORLD_HEIGHT) return;
        const col = this.column(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
        col.glue.set((x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | (y << 8) | (axis << 15), added);
      }),
      sim.events.on((ev) => {
        if (ev.type !== 'structureAdded' && ev.type !== 'structureRemoved') this.events.push(ev);
      }),
    );
  }

  /** Version of a column's content (cells and world glue): changes whenever either does. */
  columnVersion(cx: number, cz: number): number {
    return this.versions.get(chunkKey(cx, cz)) ?? 0;
  }

  private column(cx: number, cz: number): ColumnChanges {
    const key = chunkKey(cx, cz);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    let col = this.columns.get(key);
    if (col === undefined) {
      col = { cx, cz, cells: new Map(), glue: new Map() };
      this.columns.set(key, col);
    }
    return col;
  }

  private changesOf(id: number): StructureChanges {
    let c = this.structureChanges.get(id);
    if (c === undefined) {
      c = { cells: new Map(), glue: new Map() };
      this.structureChanges.set(id, c);
    }
    return c;
  }

  /**
   * Catch up with the structures and entities of the simulation: hook the structures that
   * appeared, unhook the ones that went (dropping their uncollected changes), and report what
   * appeared since the last call.
   */
  sync(): SyncResult {
    const appearedStructures = new Set<Structure>();
    const cur = this.sim.structures.all();
    if (cur !== this.knownList) {
      this.knownList = cur;
      const now = new Set(cur);
      for (const [s, h] of this.hooked) {
        if (now.has(s)) continue;
        h.off();
        this.hooked.delete(s);
        this.structureChanges.delete(s.id);
      }
      for (const s of cur) {
        if (this.hooked.has(s)) continue;
        appearedStructures.add(s);
        this.structureChanges.delete(s.id);
        const id = s.id;
        const offCells = s.grid.onCellChange((x, y, z, _old, cell) => {
          this.changesOf(id).cells.set(`${x},${y},${z}`, [x, y, z, cell]);
        });
        const offGlue = s.glue.onChange((added, x, y, z, axis) => {
          this.changesOf(id).glue.set(`${x},${y},${z},${axis}`, [x, y, z, axis, added]);
        });
        this.hooked.set(s, {
          s,
          off: () => {
            offCells();
            offGlue();
          },
        });
      }
    }

    const appearedEntities: Entity[] = [];
    const goneEntities: number[] = [];
    const stamp = ++this.syncs;
    const list = this.sim.entities.all();
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.removed) continue;
      const known = this.entities.get(e.id);
      if (known === undefined) {
        this.entities.set(e.id, { e, seen: stamp });
        appearedEntities.push(e);
        continue;
      }
      known.seen = stamp;
      if (known.e !== e) {
        known.e = e;
        appearedEntities.push(e);
      }
    }
    for (const [id, known] of this.entities) {
      if (known.seen === stamp) continue;
      this.entities.delete(id);
      goneEntities.push(id);
    }
    return { appearedStructures, appearedEntities, goneEntities };
  }

  /** Everything collected since the last take, and start collecting afresh. */
  take(): CaptureTake {
    const out: CaptureTake = { columns: this.columns, structures: this.structureChanges, events: this.events };
    this.columns = new Map();
    this.structureChanges = new Map();
    this.events = [];
    return out;
  }

  /** Unhook everything. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const h of this.hooked.values()) h.off();
    this.hooked.clear();
  }
}
