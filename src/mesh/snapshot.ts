/**
 * Snapshots: copy the cells (and light) a meshing job needs out of a live grid into a
 * self-contained MeshInput that can be posted to the mesh Worker.
 */
import { CHUNK_MASK, CHUNK_SHIFT, SECTION_SIZE, WORLD_HEIGHT } from '../core/constants';
import { AIR } from '../blocks/cell';
import type { StructureGrid } from '../voxel/sgrid';
import type { World } from '../voxel/world';
import type { MeshInput } from './types';

/** Padded edge of a section job: 16 interior cells plus a 1-cell margin on each side. */
const PADDED = SECTION_SIZE + 2;
/** Raw light byte for open sky: sky 15, block 0. */
const SKY_OPEN = 0xf0;

/**
 * Snapshot of the 16^3 section (cx, sy, cz) plus its 1-cell margin, cells and light.
 * Outside rules for margin cells:
 *  - above the world: AIR with sky light 15;
 *  - below the world: the cell World.getCell returns there (opaque deeprock) with light 0,
 *    so the bottom faces of the lowest layer are culled;
 *  - in an unloaded chunk: AIR with the light World.getLightRaw returns. The client only
 *    meshes sections whose neighbours are loaded (sectionNeighborsLoaded), so this only
 *    matters for callers that do not.
 */
export function snapshotSection(world: World, cx: number, sy: number, cz: number): MeshInput {
  const cells = new Uint16Array(PADDED * PADDED * PADDED);
  const light = new Uint8Array(PADDED * PADDED * PADDED);
  const ox = cx * SECTION_SIZE - 1;
  const oy = sy * SECTION_SIZE - 1;
  const oz = cz * SECTION_SIZE - 1;
  const layer = PADDED * PADDED;
  for (let z = 0; z < PADDED; z++) {
    const wz = oz + z;
    for (let x = 0; x < PADDED; x++) {
      const wx = ox + x;
      const chunk = world.getChunk(wx >> CHUNK_SHIFT, wz >> CHUNK_SHIFT);
      const column = (wx & CHUNK_MASK) | ((wz & CHUNK_MASK) << 4);
      let p = x + z * PADDED;
      for (let y = 0; y < PADDED; y++, p += layer) {
        const wy = oy + y;
        if (wy >= WORLD_HEIGHT) {
          cells[p] = AIR;
          light[p] = SKY_OPEN;
        } else if (wy < 0) {
          cells[p] = world.getCell(wx, wy, wz);
          light[p] = 0;
        } else if (chunk === undefined) {
          cells[p] = AIR;
          light[p] = world.getLightRaw(wx, wy, wz);
        } else {
          const i = column | (wy << 8);
          cells[p] = chunk.cells[i]!;
          light[p] = chunk.light[i]!;
        }
      }
    }
  }
  return { sx: SECTION_SIZE, sy: SECTION_SIZE, sz: SECTION_SIZE, cells, light };
}

/**
 * Snapshot of a whole structure: its tight cellBounds box plus an AIR margin, no voxel
 * light (structures are shaded by the renderer from the pose's light sample).
 * (ox, oy, oz) are the structure-local coordinates of interior cell (0,0,0); pass them to
 * RenderBackend.setStructureMesh. Returns null for an empty grid.
 */
export function snapshotStructure(grid: StructureGrid): { input: MeshInput; ox: number; oy: number; oz: number } | null {
  const b = grid.cellBounds();
  if (b === null) return null;
  const sx = b.maxX - b.minX;
  const sy = b.maxY - b.minY;
  const sz = b.maxZ - b.minZ;
  const px = sx + 2;
  const pz = sz + 2;
  const cells = new Uint16Array(px * (sy + 2) * pz);
  // cellBounds is computed from the dense storage, so the box lies inside it: copy rows.
  const src = grid.cells;
  const gsx = grid.sx;
  const gLayer = grid.sx * grid.sz;
  const x0 = b.minX - grid.ox;
  for (let y = 0; y < sy; y++) {
    const gy = b.minY + y - grid.oy;
    for (let z = 0; z < sz; z++) {
      const gz = b.minZ + z - grid.oz;
      const from = x0 + gz * gsx + gy * gLayer;
      cells.set(src.subarray(from, from + sx), 1 + (z + 1) * px + (y + 1) * px * pz);
    }
  }
  return { input: { sx, sy, sz, cells, light: null }, ox: b.minX, oy: b.minY, oz: b.minZ };
}

/**
 * True when chunk (cx, cz) and its 8 surrounding chunk columns are loaded: only then is
 * every margin cell of the chunk's sections real data, so the client meshes a section only
 * when this holds (otherwise border faces would be culled or exposed wrongly).
 */
export function sectionNeighborsLoaded(world: World, cx: number, cz: number): boolean {
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (world.getChunk(cx + dx, cz + dz) === undefined) return false;
    }
  }
  return true;
}
