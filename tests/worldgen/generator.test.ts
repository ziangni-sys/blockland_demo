import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL, WORLD_HEIGHT } from '../../src/core/constants';
import { AXIS_Y } from '../../src/core/dirs';
import { Rng } from '../../src/core/rng';
import { cellId, cellState, stateAxis, stateLayers } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS, GRAVITY_BLOCK, LIQUID, SOLID } from '../../src/blocks/registry';
import { BIOME_NAMES, type Biome } from '../../src/worldgen/biome';
import { LAVA_MAX_Y, MIN_CAVE_Y } from '../../src/worldgen/caves';
import { FlatGenerator, TerrainGenerator, VoidGenerator } from '../../src/worldgen/generator';
import { createColumnSample, MAX_TERRAIN_Y, MIN_TERRAIN_Y } from '../../src/worldgen/terrain';
import { TREE_REACH } from '../../src/worldgen/trees';
import { ChunkArea, chunkHash } from './helpers';

const LEAVES = new Set<number>([B.LEAVES_OAK, B.LEAVES_PINE]);
const LOGS = new Set<number>([B.LOG_OAK, B.LOG_PINE]);
/** Blocks that sit on top of the terrain (not part of heightAt). */
const DECOR = new Set<number>([
  B.AIR,
  B.WATER,
  B.LEAVES_OAK,
  B.LEAVES_PINE,
  B.LOG_OAK,
  B.LOG_PINE,
  B.TALL_GRASS,
  B.FLOWER_RED,
  B.FLOWER_YELLOW,
  B.CACTUS,
  B.SNOW_LAYER,
]);

/** Highest terrain cell of a column in an area (skipping decoration and water). */
function terrainTop(area: ChunkArea, x: number, z: number): number {
  for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (!DECOR.has(cellId(area.get(x, y, z)))) return y;
  return -1;
}

/** Chunk coordinate of the spawn, for areas that are sure to contain land and trees. */
function spawnChunk(gen: TerrainGenerator): { cx: number; cz: number } {
  const s = gen.spawnPoint();
  return { cx: Math.floor(s.x / CHUNK_SIZE), cz: Math.floor(s.z / CHUNK_SIZE) };
}

describe('TerrainGenerator: determinism', () => {
  it('returns identical, fresh arrays for the same chunk', () => {
    const gen = new TerrainGenerator(1234);
    const a = gen.generate(3, -2);
    const b = gen.generate(3, -2);
    expect(a.length).toBe(CHUNK_VOLUME);
    expect(a).not.toBe(b);
    expect(chunkHash(a)).toBe(chunkHash(b));
    a.fill(0);
    expect(chunkHash(gen.generate(3, -2))).toBe(chunkHash(b));
  });

  it('does not depend on call order or on the instance', () => {
    const coords = [
      [0, 0],
      [1, 0],
      [-7, 12],
      [40, -33],
      [0, 1],
    ] as const;
    const g1 = new TerrainGenerator(99);
    const first = coords.map(([cx, cz]) => chunkHash(g1.generate(cx, cz)));
    const g2 = new TerrainGenerator(99);
    g2.spawnPoint(); // unrelated work first
    g2.heightAt(500, -500);
    const reversed = [...coords].reverse().map(([cx, cz]) => chunkHash(g2.generate(cx, cz)));
    expect(reversed.reverse()).toEqual(first);
    // Different seeds produce different worlds.
    const g3 = new TerrainGenerator(100);
    expect(chunkHash(g3.generate(0, 0))).not.toBe(first[0]);
  });

  it('spawnPoint is deterministic across instances and calls', () => {
    const a = new TerrainGenerator(5).spawnPoint();
    const g = new TerrainGenerator(5);
    expect(g.spawnPoint()).toEqual(a);
    const again = g.spawnPoint();
    again.x = 1e9; // callers get a copy
    expect(g.spawnPoint()).toEqual(a);
  });

  it('matches the golden output (worlds are stable across versions)', () => {
    // Unmodified chunks are not saved: they are re-generated from the seed on load. Any
    // change to these hashes changes every existing world, so update them only on purpose.
    const gen = new TerrainGenerator(12345);
    expect(chunkHash(gen.generate(0, 0)).toString(16)).toBe('7353bb3');
    expect(chunkHash(gen.generate(-3, 7)).toString(16)).toBe('f830bcce');
    expect(chunkHash(gen.generate(25, -40)).toString(16)).toBe('d48d4278');
    expect(gen.spawnPoint()).toEqual({ x: 7.5, y: 52, z: -216.5 });
  });
});

describe('TerrainGenerator: seams', () => {
  for (const seed of [11, 2024]) {
    it(`terrain and trees are continuous across chunk borders (seed ${seed})`, () => {
      const gen = new TerrainGenerator(seed);
      const { cx, cz } = spawnChunk(gen);
      const area = new ChunkArea(gen, cx - 2, cz - 2, 5);
      const ix0 = area.x0 + CHUNK_SIZE; // central 3x3 chunks
      const ix1 = area.x0 + 4 * CHUNK_SIZE;
      const iz0 = area.z0 + CHUNK_SIZE;
      const iz1 = area.z0 + 4 * CHUNK_SIZE;

      // 1. Heights: generated terrain matches the 2D model, and border steps look like
      //    interior steps.
      let matches = 0;
      let columns = 0;
      let borderSum = 0;
      let borderN = 0;
      let borderMax = 0;
      let innerSum = 0;
      let innerN = 0;
      let innerMax = 0;
      for (let z = iz0; z < iz1; z++) {
        for (let x = ix0; x < ix1; x++) {
          const h = terrainTop(area, x, z);
          columns++;
          if (h === gen.heightAt(x, z)) matches++;
          const d = Math.abs(h - terrainTop(area, x + 1, z));
          if (((x + 1) & 15) === 0) {
            borderSum += d;
            borderN++;
            borderMax = Math.max(borderMax, d);
          } else {
            innerSum += d;
            innerN++;
            innerMax = Math.max(innerMax, d);
          }
        }
      }
      // heightAt is exact, cave mouths included.
      expect(matches).toBe(columns);
      expect(borderSum / borderN).toBeLessThan((innerSum / innerN) * 1.6 + 0.3);
      expect(borderMax).toBeLessThanOrEqual(innerMax + 1);

      // 2. Every leaf has a log within tree reach: no crown is cut off from its trunk.
      let leaves = 0;
      for (let z = iz0; z < iz1; z++) {
        for (let x = ix0; x < ix1; x++) {
          for (let y = SEA_LEVEL; y < WORLD_HEIGHT; y++) {
            if (!LEAVES.has(cellId(area.get(x, y, z)))) continue;
            leaves++;
            let found = false;
            for (let dy = -4; dy <= 4 && !found; dy++) {
              for (let dz = -TREE_REACH; dz <= TREE_REACH && !found; dz++) {
                for (let dx = -TREE_REACH; dx <= TREE_REACH && !found; dx++) {
                  if (LOGS.has(cellId(area.get(x + dx, y + dy, z + dz)))) found = true;
                }
              }
            }
            if (!found) throw new Error(`orphan leaf at ${x},${y},${z}`);
          }
        }
      }
      expect(leaves).toBeGreaterThan(100);

      // 3. Every trunk top carries a crown, including trunks right next to a chunk border
      //    (whose crowns were stamped by the neighbouring chunk).
      let trunks = 0;
      let borderTrunks = 0;
      for (let z = iz0; z < iz1; z++) {
        for (let x = ix0; x < ix1; x++) {
          for (let y = SEA_LEVEL; y < WORLD_HEIGHT - 1; y++) {
            const c = area.get(x, y, z);
            if (!LOGS.has(cellId(c)) || stateAxis(cellState(c)) !== AXIS_Y) continue;
            if (LOGS.has(cellId(area.get(x, y + 1, z)))) continue;
            trunks++;
            const lx = x & 15;
            const lz = z & 15;
            if (lx < TREE_REACH || lx >= 16 - TREE_REACH || lz < TREE_REACH || lz >= 16 - TREE_REACH) borderTrunks++;
            let crown = 0;
            for (let dy = -3; dy <= 3; dy++) {
              for (let dz = -TREE_REACH; dz <= TREE_REACH; dz++) {
                for (let dx = -TREE_REACH; dx <= TREE_REACH; dx++) {
                  if (LEAVES.has(cellId(area.get(x + dx, y + dy, z + dz)))) crown++;
                }
              }
            }
            expect(crown, `crown of trunk at ${x},${y},${z}`).toBeGreaterThanOrEqual(8);
          }
        }
      }
      expect(trunks).toBeGreaterThan(5);
      expect(borderTrunks).toBeGreaterThan(0);
    });
  }
});

describe('TerrainGenerator: world shape', () => {
  it('roughly half of the surface is sea (32x32 chunk samples, several seeds)', () => {
    for (const seed of [1, 2, 3, 4, 5, 77, 2024]) {
      const gen = new TerrainGenerator(seed);
      let sea = 0;
      let n = 0;
      for (let z = -256; z < 256; z += 2) {
        for (let x = -256; x < 256; x += 2) {
          if (gen.heightAt(x, z) < SEA_LEVEL - 1) sea++;
          n++;
        }
      }
      const f = sea / n;
      expect(f, `sea fraction of seed ${seed}`).toBeGreaterThanOrEqual(0.35);
      expect(f, `sea fraction of seed ${seed}`).toBeLessThanOrEqual(0.65);
    }
  });

  it('every 32x32-chunk window is 35-65 % sea, far from the origin too', () => {
    // Water floors are never carved, so the 2D model's height decides sea vs land. Without
    // the land balance about 2 % of random windows fell outside the band (27 of 1200).
    const rng = new Rng(4711);
    const s = createColumnSample();
    const fractions: number[] = [];
    for (let k = 0; k < 48; k++) {
      const gen = new TerrainGenerator(rng.nextU32());
      const x0 = rng.int(-150_000, 150_000) * CHUNK_SIZE;
      const z0 = rng.int(-150_000, 150_000) * CHUNK_SIZE;
      let sea = 0;
      let n = 0;
      for (let z = z0; z < z0 + 512; z += 8) {
        for (let x = x0; x < x0 + 512; x += 8) {
          if (gen.sampler.sample(x, z, s).height < SEA_LEVEL - 1) sea++;
          n++;
        }
      }
      fractions.push(sea / n);
    }
    expect(Math.min(...fractions)).toBeGreaterThanOrEqual(0.35);
    expect(Math.max(...fractions)).toBeLessThanOrEqual(0.65);
  });

  it('has varied biomes, mountains and deep water', () => {
    const union = new Set<Biome>();
    let maxTop = 0;
    let minTop = WORLD_HEIGHT;
    for (const seed of [1, 3, 5]) {
      const gen = new TerrainGenerator(seed);
      const seen = new Set<Biome>();
      for (let z = -384; z < 384; z += 4) {
        for (let x = -384; x < 384; x += 4) {
          const b = gen.biomeAt(x, z);
          seen.add(b);
          union.add(b);
          const h = gen.heightAt(x, z);
          maxTop = Math.max(maxTop, h);
          minTop = Math.min(minTop, h);
        }
      }
      expect(seen.size, `biomes of seed ${seed}`).toBeGreaterThanOrEqual(7);
    }
    expect([...union].sort()).toEqual([...BIOME_NAMES].sort());
    expect(maxTop).toBeGreaterThanOrEqual(100);
    expect(maxTop).toBeLessThanOrEqual(MAX_TERRAIN_Y);
    expect(minTop).toBeGreaterThanOrEqual(MIN_TERRAIN_Y);
    expect(minTop).toBeLessThan(30);
  });

  it('biome borders do not create height seams', () => {
    // Heights never read the biome label, so where the label changes for purely climatic
    // reasons the terrain must look like terrain anywhere else. (Labels that depend on
    // height — shore, peaks, highland, and conifer through the altitude lapse — sit on
    // slopes by definition and are left out.)
    const climate = new Set<Biome>(['meadow', 'broadleaf', 'scrub']);
    const border: number[] = [];
    const inner: number[] = [];
    for (const seed of [1, 3, 5]) {
      const gen = new TerrainGenerator(seed);
      for (let z = -384; z < 384; z += 3) {
        let prevH = gen.heightAt(-385, z);
        let prevB = gen.biomeAt(-385, z);
        for (let x = -384; x < 384; x++) {
          const h = gen.heightAt(x, z);
          const b = gen.biomeAt(x, z);
          const d = Math.abs(h - prevH);
          if (b !== prevB) {
            if (climate.has(b) && climate.has(prevB)) border.push(d);
          } else if (h >= SEA_LEVEL) {
            inner.push(d);
          }
          prevH = h;
          prevB = b;
        }
      }
    }
    const q = (a: number[], p: number): number => [...a].sort((u, v) => u - v)[Math.floor(a.length * p)]!;
    expect(border.length).toBeGreaterThan(300);
    expect(q(border, 0.95)).toBeLessThanOrEqual(q(inner, 0.95) + 3);
    expect(border.reduce((a, b) => Math.max(a, b), 0)).toBeLessThanOrEqual(inner.reduce((a, b) => Math.max(a, b), 0));
  });
});

describe('TerrainGenerator: spawn', () => {
  it('spawns on a dry, standable shore near open water for 20 seeds', () => {
    for (let k = 1; k <= 20; k++) {
      const seed = Math.imul(k, 0x9e3779b1) >>> 0;
      const gen = new TerrainGenerator(seed);
      const s = gen.spawnPoint();
      expect(s.x - Math.floor(s.x)).toBe(0.5);
      expect(s.z - Math.floor(s.z)).toBe(0.5);
      expect(Number.isInteger(s.y)).toBe(true);
      const x = Math.floor(s.x);
      const z = Math.floor(s.z);
      const area = new ChunkArea(gen, Math.floor((x - 24) / 16), Math.floor((z - 24) / 16), 5);
      const ground = area.get(x, s.y - 1, z);
      expect(SOLID[cellId(ground)], `seed ${seed}: ground`).toBe(1);
      expect(LEAVES.has(cellId(ground))).toBe(false);
      expect(area.get(x, s.y, z), `seed ${seed}: feet`).toBe(B.AIR);
      expect(area.get(x, s.y + 1, z), `seed ${seed}: head`).toBe(B.AIR);
      expect(s.y - 1, `seed ${seed}: above sea level`).toBeGreaterThanOrEqual(SEA_LEVEL);
      let water = false;
      for (let dz = -24; dz <= 24 && !water; dz++) {
        for (let dx = -24; dx <= 24 && !water; dx++) {
          if (cellId(area.get(x + dx, SEA_LEVEL - 1, z + dz)) === B.WATER) water = true;
        }
      }
      expect(water, `seed ${seed}: water within 24 blocks`).toBe(true);
      // No pit by the feet: every column of the 5x5 patch has ground within 2 cells of the
      // feet level (a cave mouth there would show as a deeper open drop).
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          let y = s.y + 1;
          while (y > 0 && SOLID[cellId(area.get(x + dx, y, z + dz))] !== 1 && LIQUID[cellId(area.get(x + dx, y, z + dz))] === 0) y--;
          expect(s.y - 1 - y, `seed ${seed}: open drop at spawn + (${dx}, ${dz})`).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

describe('TerrainGenerator: physical sanity', () => {
  for (const seed of [1, 7, 42]) {
    it(`generated blocks are physically valid (seed ${seed})`, () => {
      const gen = new TerrainGenerator(seed);
      const { cx, cz } = spawnChunk(gen);
      const areas = [new ChunkArea(gen, cx - 3, cz - 3, 6), new ChunkArea(gen, 17, -23, 4)];
      let lava = 0;
      let carved = 0;
      let underground = 0;
      const ores = new Map<number, { lo: number; hi: number; n: number }>();
      for (const area of areas) {
        const heights = new Int16Array(area.size * area.size);
        for (let z = 0; z < area.size; z++) {
          for (let x = 0; x < area.size; x++) heights[x + z * area.size] = gen.heightAt(area.x0 + x, area.z0 + z);
        }
        const heightAt = (x: number, z: number): number => heights[x - area.x0 + (z - area.z0) * area.size]!;
        area.forEach((x, y, z, cell) => {
          const id = cellId(cell);
          const def = BLOCKS[id];
          if (!def || id === B.UNLOADED) throw new Error(`unknown block ${id} at ${x},${y},${z}`);
          if (y === 0 && id !== B.DEEPROCK) throw new Error(`no deeprock floor at ${x},${z}`);
          if (y < MIN_CAVE_Y && (id === B.AIR || LIQUID[id] !== 0)) throw new Error(`hole below y=${MIN_CAVE_Y}`);
          if (id === B.AIR) {
            if (y > 0 && y < heightAt(x, z) - 1) carved++;
            return;
          }
          if (y > 0 && y < heightAt(x, z) - 1) underground++;
          const below = y > 0 ? area.get(x, y - 1, z) : -1;
          const belowId = below < 0 ? -1 : cellId(below);

          if (GRAVITY_BLOCK[id] === 1 && SOLID[belowId] !== 1) throw new Error(`loose ${def.key} over air at ${x},${y},${z}`);
          if (def.support === 'solid' && SOLID[belowId] !== 1) throw new Error(`${def.key} without support at ${x},${y},${z}`);
          if (def.support === 'sandOrSelf' && belowId !== B.SAND && belowId !== id) throw new Error(`cactus not on sand at ${x},${y},${z}`);
          if (id === B.SNOW_LAYER) expect(stateLayers(cellState(cell))).toBeLessThanOrEqual(2);

          if (id === B.WATER) {
            expect(cellState(cell), 'water is a source').toBe(0);
            if (y >= SEA_LEVEL) throw new Error(`water above sea level at ${x},${y},${z}`);
            if (belowId === B.AIR) throw new Error(`water over a cave at ${x},${y},${z}`);
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const n = area.get(x + dx, y, z + dz);
              if (n === B.AIR) throw new Error(`water next to a cave at ${x},${y},${z}`);
              if (n >= 0 && cellId(n) === B.LAVA) throw new Error(`water next to lava at ${x},${y},${z}`);
            }
          }
          if (id === B.LAVA) {
            lava++;
            expect(cellState(cell), 'lava is a source').toBe(0);
            if (y > LAVA_MAX_Y) throw new Error(`lava above y=${LAVA_MAX_Y} at ${x},${y},${z}`);
            if (SOLID[belowId] !== 1 && belowId !== B.LAVA) throw new Error(`floating lava at ${x},${y},${z}`);
            // At rest: nothing beside it it could flow into (lava zone borders keep a rim).
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const n = area.get(x + dx, y, z + dz);
              if (n >= 0 && SOLID[cellId(n)] !== 1 && cellId(n) !== B.LAVA) {
                throw new Error(`lava beside ${BLOCKS[cellId(n)]!.key} at ${x},${y},${z}`);
              }
            }
          }
          if (id === B.CACTUS) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              if (cellId(area.get(x + dx, y, z + dz)) === B.CACTUS) throw new Error(`cacti side by side at ${x},${y},${z}`);
            }
          }
          if (LOGS.has(id)) {
            const axis = stateAxis(cellState(cell));
            if (axis === AXIS_Y) {
              // Trunks stand on logs or on solid, non-leaf ground, and a trunk is one species.
              if (!LOGS.has(belowId) && (SOLID[belowId] !== 1 || LEAVES.has(belowId))) {
                throw new Error(`floating trunk at ${x},${y},${z}`);
              }
              if (LOGS.has(belowId) && belowId !== id) throw new Error(`mixed trunk at ${x},${y},${z}`);
            } else {
              // A branch never takes a cell inside another tree's trunk.
              const up = area.get(x, y + 1, z);
              const vertical = (v: number): boolean => LOGS.has(cellId(v)) && stateAxis(cellState(v)) === AXIS_Y;
              if (vertical(below) && vertical(up)) throw new Error(`branch inside a trunk at ${x},${y},${z}`);
              // Branches touch a trunk or another branch log along their axis.
              const dx = axis === 0 ? 1 : 0;
              const dz = axis === 2 ? 1 : 0;
              const a = area.get(x + dx, y, z + dz);
              const b = area.get(x - dx, y, z - dz);
              if (a < 0 || b < 0) return; // neighbour outside the sampled area
              if (!LOGS.has(cellId(a)) && !LOGS.has(cellId(b))) {
                throw new Error(`detached branch at ${x},${y},${z}`);
              }
            }
          }
          if (id === B.COAL_ORE || id === B.IRON_ORE || id === B.COPPER_ORE) {
            const o = ores.get(id) ?? { lo: WORLD_HEIGHT, hi: 0, n: 0 };
            o.lo = Math.min(o.lo, y);
            o.hi = Math.max(o.hi, y);
            o.n++;
            ores.set(id, o);
          }
        });
      }
      // The checks above are not vacuous: there are caves, lava and every ore.
      expect(carved / (carved + underground)).toBeGreaterThan(0.01);
      expect(lava).toBeGreaterThan(0);
      const coal = ores.get(B.COAL_ORE)!;
      const iron = ores.get(B.IRON_ORE)!;
      const copper = ores.get(B.COPPER_ORE)!;
      // The brief's ranges, exactly: coal y 10-90, iron y 5-60, copper y 20-70.
      expect(coal.n).toBeGreaterThan(iron.n);
      expect(coal.lo).toBeGreaterThanOrEqual(10);
      expect(coal.hi).toBeLessThanOrEqual(90);
      expect(iron.lo).toBeGreaterThanOrEqual(5);
      expect(iron.hi).toBeLessThanOrEqual(60);
      expect(copper.lo).toBeGreaterThanOrEqual(20);
      expect(copper.hi).toBeLessThanOrEqual(70);
    });
  }

  it('turf has 3-4 dirt under it, deeprock is ragged only at y = 1..2', () => {
    const gen = new TerrainGenerator(8);
    const { cx, cz } = spawnChunk(gen);
    const area = new ChunkArea(gen, cx - 1, cz - 1, 3);
    let turf = 0;
    const deeprockAt = [0, 0, 0, 0];
    for (let z = area.z0; z < area.z0 + area.size; z++) {
      for (let x = area.x0; x < area.x0 + area.size; x++) {
        for (let y = 0; y <= 3; y++) if (cellId(area.get(x, y, z)) === B.DEEPROCK) deeprockAt[y]!++;
        const h = gen.heightAt(x, z);
        if (cellId(area.get(x, h, z)) !== B.TURF) continue;
        turf++;
        let dirt = 0;
        while (cellId(area.get(x, h - 1 - dirt, z)) === B.DIRT) dirt++;
        // Caves may cut the soil short; ores never replace dirt.
        const under = cellId(area.get(x, h - 1 - dirt, z));
        if (under !== B.AIR) expect(dirt === 3 || dirt === 4, `dirt at ${x},${z}: ${dirt}`).toBe(true);
      }
    }
    expect(turf).toBeGreaterThan(50);
    expect(deeprockAt[0]).toBe(area.size * area.size);
    expect(deeprockAt[1]).toBeGreaterThan(0);
    expect(deeprockAt[2]).toBeGreaterThan(0);
    expect(deeprockAt[2]).toBeLessThan(deeprockAt[1]!);
    expect(deeprockAt[3]).toBe(0);
  });
});

describe('TerrainGenerator: performance', () => {
  it('generates a chunk in well under 6 ms on average', () => {
    const gen = new TerrainGenerator(31337);
    for (let i = 0; i < 16; i++) gen.generate(i, -i); // JIT warm-up
    let best = Infinity;
    for (let round = 0; round < 3; round++) {
      const t0 = performance.now();
      const n = 48;
      for (let i = 0; i < n; i++) gen.generate(100 + (i % 8) + round * 8, 40 + Math.floor(i / 8));
      best = Math.min(best, (performance.now() - t0) / n);
    }
    console.log(`worldgen: ${best.toFixed(2)} ms per chunk`);
    expect(best).toBeLessThan(6);
  });
});

describe('FlatGenerator / VoidGenerator', () => {
  it('flat default layers: deeprock 1, stone 30, dirt 3, turf 1', () => {
    const gen = new FlatGenerator();
    for (const [cx, cz] of [
      [0, 0],
      [-5, 9],
    ] as const) {
      const c = gen.generate(cx, cz);
      for (let col = 0; col < 256; col++) {
        expect(c[col]).toBe(B.DEEPROCK);
        for (let y = 1; y <= 30; y++) expect(c[col | (y << 8)]).toBe(B.STONE);
        for (let y = 31; y <= 33; y++) expect(c[col | (y << 8)]).toBe(B.DIRT);
        expect(c[col | (34 << 8)]).toBe(B.TURF);
        for (let y = 35; y < WORLD_HEIGHT; y++) expect(c[col | (y << 8)]).toBe(B.AIR);
      }
    }
    expect(gen.spawnPoint()).toEqual({ x: 0.5, y: 35, z: 0.5 });
    expect(gen.seed).toBe(0);
  });

  it('flat custom layers and clamping', () => {
    const gen = new FlatGenerator(
      [
        { id: B.STONE, thickness: 2 },
        { id: B.SAND, thickness: 1 },
      ],
      9,
    );
    const c = gen.generate(1, 1);
    expect(c[0]).toBe(B.STONE);
    expect(c[1 << 8]).toBe(B.STONE);
    expect(c[2 << 8]).toBe(B.SAND);
    expect(c[3 << 8]).toBe(B.AIR);
    expect(gen.spawnPoint()).toEqual({ x: 0.5, y: 3, z: 0.5 });
    expect(gen.seed).toBe(9);
    const tall = new FlatGenerator([{ id: B.STONE, thickness: 500 }]);
    expect(tall.spawnPoint().y).toBe(WORLD_HEIGHT);
    expect(tall.generate(0, 0)[CHUNK_VOLUME - 1]).toBe(B.STONE);
  });

  it('void is all air', () => {
    const gen = new VoidGenerator(3);
    const c = gen.generate(4, -4);
    expect(c.length).toBe(CHUNK_VOLUME);
    expect(c.every((v) => v === 0)).toBe(true);
    expect(gen.seed).toBe(3);
    const s = gen.spawnPoint();
    expect(Number.isFinite(s.x + s.y + s.z)).toBe(true);
  });
});
