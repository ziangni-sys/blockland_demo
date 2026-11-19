/**
 * A fingerprint of the server's state at one moment, for the browser tests (debug tooling: host
 * control `probe`, window.__blocklands.game.debug.serverProbe): the players where the server has
 * them, the structures, and the columns near the players, hashed as the page's debug digest hashes
 * its replica (voxel/fingerprint.ts), so a script can compare each page with the server.
 */
import { CHUNK_SHIFT } from '../../core/constants';
import { vclone, vec3 } from '../../core/math';
import type { Simulation } from '../../sim/simulation';
import { chunkKey } from '../../voxel/chunk';
import { columnHash, gridHash } from '../../voxel/fingerprint';

export interface ServerProbePlayer {
  entityId: number;
  /** 0: not carried. */
  carrierId: number;
  steeringShipId: number;
  /** The feet, world. */
  x: number;
  y: number;
  z: number;
  /** The feet in the carrier's local frame (the world position when not carried). */
  lx: number;
  ly: number;
  lz: number;
}

export interface ServerProbe {
  /** The last tick run. */
  tick: number;
  players: ServerProbePlayer[];
  /** Every structure: its cells' gridHash, cell count and position (pivot in its parent's space). */
  structures: Array<{ id: number; kind: 'ship' | 'rotor'; parentId: number; cells: number; hash: number; x: number; y: number; z: number }>;
  /** columnHash of each loaded column within `radius` columns of a player, by "cx,cz". */
  columns: Record<string, number>;
}

export function probeServer(sim: Simulation, radius: number): ServerProbe {
  const players: ServerProbePlayer[] = [];
  const columns: Record<string, number> = {};
  for (const c of sim.players.online()) {
    const p = c.player;
    const carrier = p.carrierId !== 0 ? sim.structures.get(p.carrierId) : undefined;
    const local = carrier !== undefined ? carrier.grid.toLocal(p.pos, vec3()) : vclone(p.pos);
    players.push({ entityId: p.id, carrierId: carrier?.id ?? 0, steeringShipId: p.steeringShipId, x: p.pos.x, y: p.pos.y, z: p.pos.z, lx: local.x, ly: local.y, lz: local.z });
    const cx0 = Math.floor(p.pos.x) >> CHUNK_SHIFT;
    const cz0 = Math.floor(p.pos.z) >> CHUNK_SHIFT;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const chunk = sim.world.chunks.get(chunkKey(cx0 + dx, cz0 + dz));
        if (chunk !== undefined) columns[`${cx0 + dx},${cz0 + dz}`] = columnHash(chunk.cells);
      }
    }
  }
  const structures = sim.structures.all().map((s) => ({
    id: s.id,
    kind: s.kind,
    parentId: s.parent?.id ?? 0,
    cells: s.grid.count,
    hash: gridHash(s.grid),
    x: s.grid.position.x,
    y: s.grid.position.y,
    z: s.grid.position.z,
  }));
  return { tick: sim.ticks, players, structures, columns };
}
