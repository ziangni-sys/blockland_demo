/**
 * Saving and restoring a Simulation.
 *
 * A save is a SaveBundle: encoded modified chunks + named binary blobs. The storage layer
 * (src/save) only moves bytes; the client decides when to save and where to.
 *
 *   exportSave(sim)            -> SaveBundle (cheap enough to call every autosave)
 *   importSave(sim, bundle)    -> call right after `new Simulation(...)`, before the first tick
 *
 * Blob names: 'sim' (clock, rng, time-of-day offset), 'ticks' (pending block ticks: liquids
 * mid-flow, sand about to fall), 'glue' (world glue), 'structures' (nested ones included, with
 * their glue and rotor angles), 'entities' (incl. the player and inventory).
 * A loader finds the saved chunks with SaveStorage.listChunkKeys().
 *
 * Deliberately NOT saved: what the player's hands were doing (a pending glue step, an
 * assembly preview, mining progress, highlighted docking conflicts) — a reload starts with
 * empty hands.
 */
import { ByteReader, ByteWriter } from '../save/bytes';
import { decodeTicks, encodeTicks } from '../save/codec';
import { GlueStore } from '../structures/glue';
import type { Simulation } from './simulation';

export interface SaveBundle {
  /** [chunkKey, encoded chunk] for every chunk that differs from generator output. */
  chunks: Array<[number, Uint8Array]>;
  /** [name, bytes]. */
  blobs: Array<[string, Uint8Array]>;
}

/** 1: time + rng. 2: + time-of-day offset. */
const SIM_BLOB_VERSION = 2;

export function exportSave(sim: Simulation): SaveBundle {
  const chunks = sim.chunks.modifiedChunks();
  const blobs: Array<[string, Uint8Array]> = [];

  const w = new ByteWriter();
  w.varuint(SIM_BLOB_VERSION);
  w.varuint(sim.world.time);
  w.u32(sim.rng.state);
  w.varuint(Math.max(0, Math.floor(sim.dayOffset)));
  blobs.push(['sim', w.finish()]);

  blobs.push(['ticks', encodeTicks(sim.world.ticks.all(), sim.world.time)]);

  const g = new ByteWriter();
  g.i32Array(sim.worldGlue.toArray());
  blobs.push(['glue', g.finish()]);

  const s = new ByteWriter();
  sim.structures.serialize(s);
  blobs.push(['structures', s.finish()]);

  const e = new ByteWriter();
  sim.entities.serialize(e);
  blobs.push(['entities', e.finish()]);

  return { chunks, blobs };
}

export function importSave(sim: Simulation, bundle: SaveBundle): void {
  const blob = (name: string): Uint8Array | null => {
    for (const [n, b] of bundle.blobs) if (n === name) return b;
    return null;
  };

  // Chunks first: everything else refers to world cells.
  for (const chunk of [...sim.world.chunks.values()]) sim.world.removeChunk(chunk.cx, chunk.cz);
  sim.world.takeDirtySections();
  sim.chunks.setSaved(bundle.chunks);

  const simBlob = blob('sim');
  if (simBlob) {
    const r = new ByteReader(simBlob, 'sim');
    const version = r.varuint();
    if (version < 1 || version > SIM_BLOB_VERSION) r.fail(`unsupported sim blob version ${version}`);
    sim.world.time = r.varuint();
    sim.rng.state = r.u32();
    sim.dayOffset = version >= 2 ? r.varuint() : 0;
  }

  sim.world.ticks.clear();
  const ticks = blob('ticks');
  if (ticks) {
    for (const t of decodeTicks(ticks, sim.world.time)) sim.world.ticks.schedule(t.x, t.y, t.z, t.id, t.at);
  }

  sim.worldGlue.clear();
  const glue = blob('glue');
  if (glue) {
    const arr = new ByteReader(glue, 'glue').i32Array();
    const loaded = GlueStore.fromArray(arr);
    loaded.forEach((x, y, z, axis) => sim.worldGlue.add(x, y, z, (axis << 1) as 0 | 2 | 4));
  }

  const structures = blob('structures');
  sim.structures.clear();
  if (structures) sim.structures.deserialize(new ByteReader(structures, 'structures'));

  const entities = blob('entities');
  if (entities) sim.entities.deserialize(new ByteReader(entities, 'entities'));

  // Ground under the player must exist before the first tick. Loading a chunk reschedules
  // its restless liquid (Fluids.rescheduleChunk), so water saved mid-flow keeps flowing.
  const p = sim.player.pos;
  sim.chunks.loadAround(sim.generator, p.x, p.z, 1);
  sim.afterLoad();
}
