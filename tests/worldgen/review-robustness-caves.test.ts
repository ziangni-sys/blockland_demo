/**
 * Review (robustness lens): cave interpolation artefacts.
 *
 * CaveCarver folds the tunnel / chamber fields into ONE signed density (min of
 * a^2 + b^2 - w^2 ...) and interpolates that folded value trilinearly from a 4-block
 * lattice. The tunnels are only ~2-5 blocks thick, i.e. thinner than the lattice spacing,
 * and the fold (min, squares) is not smooth, so the interpolation cannot represent them:
 *
 *  - where a single lattice point (or a lattice edge) is barely negative, the interpolated
 *    field is negative ONLY on that lattice plane / line, which produces perfectly straight,
 *    axis-aligned 1-block cracks (x % 4 == 0 or z % 4 == 0), 1-block-high slits at y % 4 == 0
 *    and 1x1 vertical shafts on x % 4 == 0 && z % 4 == 0 columns (some open at the surface:
 *    seed 475241565 has one diagonally next to its spawn point);
 *  - most of the intended tunnel volume is lost and the networks fall apart into pockets
 *    (measured: 30-40 % of the volume the same density gives per cell).
 *
 * Interpolating the smooth component fields (a, b, c, d, w, chamber fBm) on the lattice and
 * evaluating the tube / min per cell keeps the coarse-lattice cost without the artefacts.
 */
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../../src/core/constants';
import { cellId } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { SOLID } from '../../src/blocks/registry';
import { CaveCarver } from '../../src/worldgen/caves';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { ChunkArea } from './helpers';

const isCarved = (id: number): boolean => id === B.AIR || id === B.LAVA;

function spawnArea(seed: number, n: number): { gen: TerrainGenerator; area: ChunkArea } {
  const gen = new TerrainGenerator(seed);
  const s = gen.spawnPoint();
  const half = n >> 1;
  const area = new ChunkArea(gen, Math.floor(s.x / CHUNK_SIZE) - half, Math.floor(s.z / CHUNK_SIZE) - half, n);
  return { gen, area };
}

describe('review: caves are not shaped by the 4-block interpolation lattice', () => {
  for (const seed of [123, 9]) {
    it(`thin cave features are not aligned to lattice planes (seed ${seed})`, () => {
      const { gen, area } = spawnArea(seed, 6);
      let thinX = 0;
      let thinXLattice = 0;
      let thinZ = 0;
      let thinZLattice = 0;
      let slits = 0;
      let slitsLattice = 0;
      for (let z = area.z0 + 1; z < area.z0 + area.size - 1; z++) {
        for (let x = area.x0 + 1; x < area.x0 + area.size - 1; x++) {
          const h = gen.heightAt(x, z);
          for (let y = 6; y < h - 1; y++) {
            if (!isCarved(cellId(area.get(x, y, z)))) continue;
            // 1 block wide along x / along z, and 1 block high.
            if (SOLID[cellId(area.get(x - 1, y, z))] && SOLID[cellId(area.get(x + 1, y, z))]) {
              thinX++;
              if ((x & 3) === 0) thinXLattice++;
            }
            if (SOLID[cellId(area.get(x, y, z - 1))] && SOLID[cellId(area.get(x, y, z + 1))]) {
              thinZ++;
              if ((z & 3) === 0) thinZLattice++;
            }
            if (SOLID[cellId(area.get(x, y - 1, z))] && SOLID[cellId(area.get(x, y + 1, z))]) {
              slits++;
              if ((y & 3) === 0) slitsLattice++;
            }
          }
        }
      }
      expect(thinX + thinZ + slits).toBeGreaterThan(50); // the sample is not vacuous
      // An unbiased cave shape puts ~25 % of such cells on any one residue class mod 4.
      // Measured before the fix (this sample): 98-99 % for all three.
      expect(thinXLattice / thinX, '1-wide cracks on x % 4 == 0').toBeLessThan(0.5);
      expect(thinZLattice / thinZ, '1-wide cracks on z % 4 == 0').toBeLessThan(0.5);
      expect(slitsLattice / slits, '1-high slits on y % 4 == 0').toBeLessThan(0.5);
    });
  }

  it('no 1x1 shaft opens at the surface right next to the spawn (seed 475241565)', () => {
    const gen = new TerrainGenerator(475241565);
    const s = gen.spawnPoint();
    const x = Math.floor(s.x);
    const z = Math.floor(s.z);
    const area = new ChunkArea(gen, Math.floor(x / CHUNK_SIZE) - 1, Math.floor(z / CHUNK_SIZE) - 1, 3);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        let drop = 0;
        for (let y = s.y - 1; y > 0 && area.get(x + dx, y, z + dz) === B.AIR; y--) drop++;
        // Measured before the fix: a 1x1 shaft at (+1, +1) (world 8, *, 8), 8 cells deep.
        expect(drop, `open drop at spawn + (${dx}, ${dz})`).toBeLessThan(3);
      }
    }
  });

  it('keeps most of the cave volume its own density field describes (deep, dry columns)', () => {
    let generated = 0;
    let reference = 0;
    for (const seed of [123, 9]) {
      const { gen, area } = spawnArea(seed, 6);
      const carver = new CaveCarver(gen.seed);
      // heightAt of every column of the area, computed once (the dry test reads 7x7 of them).
      const heights = new Int16Array(area.size * area.size);
      for (let z = 0; z < area.size; z++) for (let x = 0; x < area.size; x++) heights[x + z * area.size] = gen.heightAt(area.x0 + x, area.z0 + z);
      const heightAt = (x: number, z: number): number => heights[x - area.x0 + (z - area.z0) * area.size]!;
      for (let z = area.z0 + 3; z < area.z0 + area.size - 3; z++) {
        for (let x = area.x0 + 3; x < area.x0 + area.size - 3; x++) {
          // Only columns where neither the surface taper (12 blocks) nor the water margin
          // (radius 2) applies between y = 8 and y = 29.
          if (heightAt(x, z) < 44) continue;
          let dry = true;
          for (let dz = -3; dz <= 3 && dry; dz++) {
            for (let dx = -3; dx <= 3 && dry; dx++) if (heightAt(x + dx, z + dz) < 47) dry = false;
          }
          if (!dry) continue;
          for (let y = 8; y < 30; y++) {
            if (isCarved(cellId(area.get(x, y, z)))) generated++;
            if (carver.density(x, y, z) < 0) reference++;
          }
        }
      }
    }
    expect(reference).toBeGreaterThan(2000);
    // Measured before the fix: 0.31 (seed 123) and 0.42 (seed 9).
    expect(generated / reference).toBeGreaterThan(0.6);
  });
});
