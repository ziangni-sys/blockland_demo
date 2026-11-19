/**
 * Fingerprints of voxel contents, for comparing two copies of a world (a client's replica with
 * another page's, or with the server: window.__blocklands.game.debug.digest and serverProbe, used
 * by the browser scripts). Pure functions over the cells.
 */
import type { StructureGrid } from './sgrid';

/** FNV-1a over a column's cells (Chunk.cells, in storage order). */
export function columnHash(cells: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cells.length; i++) h = Math.imul(h ^ cells[i]!, 0x01000193) >>> 0;
  return h;
}

/**
 * A structure's cells whatever its storage box: the sum (mod 2^32) of an FNV-1a over each
 * non-empty cell's local x, y, z and value, so the order the grid lists them in does not matter.
 */
export function gridHash(grid: StructureGrid): number {
  let sum = 0;
  grid.forEachCell((x, y, z, cell) => {
    let h = 0x811c9dc5;
    for (const v of [x, y, z, cell]) {
      h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
      h = Math.imul(h ^ (v >>> 16), 0x01000193) >>> 0;
    }
    sum = (sum + h) >>> 0;
  });
  return sum;
}
