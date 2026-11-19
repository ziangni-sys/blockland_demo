/**
 * Buoyancy and water damping of hulls with partial cells (docs/SHAPES.md 12.5): the half-cube
 * submerged height against hand-computed values, draught by volume for slab and stair rafts, the
 * waterplane of upright slabs in the damping estimate, and no energy gain while bobbing.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { BLOCKS } from '../../src/blocks/registry';
import { PX } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import type { Body } from '../../src/structures/physics/body';
import { applyBuoyancy } from '../../src/structures/physics/buoyancy';
import { DEFAULT_OPTIONS } from '../../src/structures/physics';
import type { Ship } from '../../src/structures/structure';
import type { World } from '../../src/voxel/world';
import { LOWER, slab, stairFill, UPPER, WEST } from '../shapes';
import { columnSurface, finite, launch, makeSea, mechanicalEnergy, newShip, rotateShip, run, setup, SURFACE, tilt, worldOf } from './helpers';
import { fillGrid } from './shapes-helpers';

type Dyn = ReturnType<typeof setup>['dyn'];

function bodyOf(dyn: Dyn, s: Ship): Body {
  return (dyn as unknown as { bodyMap: WeakMap<Ship, Body> }).bodyMap.get(s)!;
}

/** Submerged volume the buoyancy computes for the ship at its current pose (one evaluation, no motion). */
function submergedNow(world: World, dyn: Dyn, s: Ship): number {
  const b = bodyOf(dyn, s);
  b.loadPose();
  b.patch.fill(world, Math.floor(b.minX) - 3, Math.floor(b.minY) - 3, Math.floor(b.minZ) - 3, Math.floor(b.maxX) + 3, Math.floor(b.maxY) + 3, Math.floor(b.maxZ) + 3);
  applyBuoyancy(b, 0, 0);
  return b.submerged;
}

describe('half cubes: the submerged height (12.5)', () => {
  /** One lower planks slab in cell (0, 47, 0): 4 half cubes with their bottom at world y = y0. */
  function slabAt(world: World, dyn: Dyn, y0: number): Ship {
    const s = newShip(world, 1);
    s.grid.setCell(0, 47, 0, slab(B.PLANKS_OAK, LOWER));
    launch(s, dyn);
    s.grid.position.y += y0 - 47;
    return s;
  }

  // water up to y 48 (exclusive): cell 47 is the top water cell, filled to 1 - 2/16; cell 46 is full
  const cases: Array<[number, number, string]> = [
    [47.0, 0.5, 'whole half cube in the top water cell'],
    [47.25, 0.5, 'its top at 47.75, still under the surface at 47.875'],
    [47.5, 0.375, 'cut by the surface: 47.875 - 47.5'],
    [47.75, 0.125, 'cut by the surface: 47.875 - 47.75'],
    [47.875, 0, 'its bottom on the surface'],
    [48.25, 0, 'above the water'],
    [46.75, 0.5, 'across two cells: 0.25 in the full cell, 0.25 in the top cell'],
    [46.5, 0.5, 'in the full cell'],
  ];
  for (const [y0, wet, what] of cases) {
    it(`bottom at ${y0}: wet height ${wet} (${what})`, () => {
      const world = makeSea();
      const { dyn } = setup(world);
      const s = slabAt(world, dyn, y0);
      expect(bodyOf(dyn, s).shape.halfCount).toBe(4);
      expect(bodyOf(dyn, s).shape.dispCount).toBe(0);
      // 4 half cubes of base 1/4: submerged volume = wet height
      expect(submergedNow(world, dyn, s)).toBeCloseTo(wet, 12);
    });
  }

  it('a column whose top water cell is lower (cell 46 the top one, filled to 14/16): 46.875 - y0 above it, nothing from the air cell', () => {
    const world = makeSea();
    world.setCell(0, 47, 0, 0);
    const { dyn } = setup(world);
    for (const [y0, wet] of [
      [46.5, 0.375],
      [46.25, 0.5],
      [46.75, 0.125],
      [46.875, 0],
      [45.75, 0.5],
    ] as const) {
      const s = slabAt(world, dyn, y0);
      expect(submergedNow(world, dyn, s)).toBeCloseTo(wet, 12);
    }
  });

  it('is continuous in y (no jump where a half cube crosses a cell boundary or the surface)', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    let prev = -1;
    for (let k = 0; k <= 400; k++) {
      const y0 = 45.5 + k * 0.01;
      const v = submergedNow(world, dyn, slabAt(world, dyn, y0));
      if (prev >= 0) expect(Math.abs(v - prev)).toBeLessThan(0.0101);
      prev = v;
    }
  });
});

describe('draught by volume (scenario 43, 12.5)', () => {
  it('a raft floored with lower slabs floats with its submerged volume = mass / rho (within 3 %), at the predicted draught', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -3, 47, -4, 3, 47, 4, slab(B.PLANKS_OAK, LOWER)); // 63 slabs of 1/2 cell, density 0.5
    launch(raft, dyn);
    expect(raft.mass).toBeCloseTo(63 * 0.25, 12);
    run(dyn, [raft], 300);
    expect(Math.abs(submergedNow(world, dyn, raft) - raft.mass) / raft.mass).toBeLessThan(0.03);
    // 15.75 cells over 63 cells of area: 0.25 under the surface
    const draught = SURFACE - worldOf(raft, -3, 47, -4).y;
    expect(Math.abs(draught - 0.25) / 0.25).toBeLessThan(0.03);
    expect(tilt(raft)).toBeLessThan(0.01);
    expect(finite(raft)).toBe(true);
  });

  it('a raft of stairs floats at the draught of its volume (6/8 of a cell each)', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -3, 47, -3, 3, 47, 3, slab(B.PLANKS_PINE, stairFill(PX)));
    launch(raft, dyn);
    const m = 49 * BLOCKS[B.PLANKS_PINE]!.density * 0.75;
    expect(raft.mass).toBeCloseTo(m, 10);
    run(dyn, [raft], 300);
    expect(Math.abs(submergedNow(world, dyn, raft) - m) / m).toBeLessThan(0.03);
    // m / 49 = 0.3375 < 0.5: the waterline is in the full lower half of the stairs
    const draught = SURFACE - worldOf(raft, 0, 47, 0).y;
    expect(Math.abs(draught - m / 49) / (m / 49)).toBeLessThan(0.03);
    expect(tilt(raft)).toBeLessThan(0.02);
  });

  it('a hold whose rim is a course of lower slabs floats on the half-cell bilge (a heavy brick boat that needs it)', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = newShip(world, 1);
    // 16 x 16 brick hull (density 2): floor y 44, walls y 45..46, rim of lower brick slabs at y 47
    for (let y = 44; y <= 47; y++) {
      for (let z = -8; z <= 7; z++) {
        for (let x = -8; x <= 7; x++) {
          const wall = y === 44 || x === -8 || z === -8 || x === 7 || z === 7;
          if (!wall) continue;
          boat.grid.setCell(x, y, z, y === 47 ? slab(B.BRICKS, LOWER) : makeCell(B.BRICKS));
        }
      }
    }
    launch(boat, dyn);
    const h = boat.hull!;
    // the bilge includes the lower half of the rim layer: 196 * (2 + 1/2) cells; without that half
    // the boat (812) would be heavier than its displacement (896 - 98)
    expect(h.bilgeVolume).toBe(196 * 2.5);
    expect(boat.mass).toBeCloseTo(376 * 2 + 60, 10);
    expect(h.maxDisplacement).toBe(376 + 30 + 490);
    expect(h.floats).toBe(true);
    expect(boat.mass).toBeGreaterThan(h.maxDisplacement - 98);
    run(dyn, [boat], 400);
    expect(Math.abs(submergedNow(world, dyn, boat) - boat.mass) / boat.mass).toBeLessThan(0.03);
    expect(tilt(boat)).toBeLessThan(0.02);
    expect(boat.removed).toBe(false);
  });

  it('bobbing slab boats never gain mechanical energy (half cubes included in the potential)', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const boat = newShip(world, 1);
    for (let y = 46; y <= 48; y++) {
      for (let z = -3; z <= 3; z++) {
        for (let x = -2; x <= 2; x++) {
          const wall = y === 46 || x === -2 || z === -3 || x === 2 || z === 3;
          if (!wall) continue;
          boat.grid.setCell(x, y, z, y === 48 ? slab(B.PLANKS_OAK, LOWER) : y === 46 ? slab(B.PLANKS_OAK, UPPER) : makeCell(B.PLANKS_OAK));
        }
      }
    }
    launch(boat, dyn);
    boat.grid.position.y += 1.2; // dropped into the water
    const surface = columnSurface(world);
    let e0 = mechanicalEnergy(boat, surface);
    let rises = 0;
    for (let t = 0; t < 200; t++) {
      run(dyn, [boat], 1);
      const e = mechanicalEnergy(boat, surface);
      if (e > e0 + 1e-6 * Math.max(1, Math.abs(e0))) rises++;
      e0 = Math.min(e0, e);
    }
    expect(rises).toBe(0);
    expect(finite(boat)).toBe(true);
  });
});

describe('righting torque of half cubes (12.5)', () => {
  // Every displacing octant of these rafts is a half cube (a slab cell never displaces as a whole),
  // so only the half-cube loop of applyBuoyancy can give the torque that rights them. Without its
  // lever arms (sumRx, sumRz) a heeled slab raft stays heeled.
  for (const [name, cell] of [
    ['lower slabs', slab(B.PLANKS_OAK, LOWER)],
    ['upright west slabs', slab(B.PLANKS_OAK, WEST)],
  ] as const) {
    it(`a raft of ${name} heeled by 0.3 rad rights itself`, () => {
      const world = makeSea();
      const { dyn } = setup(world);
      const raft = newShip(world, 1);
      fillGrid(raft.grid, -3, 47, -4, 3, 47, 4, cell);
      launch(raft, dyn);
      run(dyn, [raft], 100);
      rotateShip(raft, vec3(0, 0, 1), 0.3);
      dyn.wake(raft);
      expect(tilt(raft)).toBeGreaterThan(0.25);
      run(dyn, [raft], 400);
      expect(tilt(raft)).toBeLessThan(0.03);
      expect(finite(raft)).toBe(true);
    });
  }
});

describe('damping estimate with half cubes (12.5)', () => {
  it('a raft of upright slabs: the waterplane is 1/2 cell per column, not 1', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -3, 47, -4, 3, 47, 4, slab(B.PLANKS_OAK, WEST));
    launch(raft, dyn);
    const b = bodyOf(dyn, raft);
    const o = DEFAULT_OPTIONS;
    const g = o.gravity * o.waterDensity;
    const heave = (area: number): number => Math.min(25, Math.max(0.5, 2 * o.heaveDampingRatio * Math.sqrt((g * area) / raft.mass)));
    expect(b.shape.halfCount).toBe(63 * 4);
    expect(b.heaveDamping).toBeCloseTo(heave(63 / 2), 10);
    expect(Math.abs(b.heaveDamping - heave(63))).toBeGreaterThan(0.1);
    // roll: second moments of the waterline half cubes (area 1/4, own term 1/48 per unit area)
    let ix = 0;
    let iz = 0;
    for (let z = -4; z <= 4; z++) {
      for (let x = -3; x <= 3; x++) {
        for (const dz of [0.25, 0.75]) {
          const rz = z + dz - b.pivot.z;
          const rx = x + 0.25 - b.pivot.x;
          ix += (rz * rz + 1 / 48) / 4;
          iz += (rx * rx + 1 / 48) / 4;
        }
      }
    }
    const roll = (i: number, inertia: number): number => Math.min(25, Math.max(0.5, 2 * o.rollDampingRatio * Math.sqrt((g * i) / inertia)));
    // the raft is symmetric about its centre: its inertia tensor is diagonal
    expect(b.rollDampingX).toBeCloseTo(roll(ix, 1 / b.invIl[0]!), 6);
    expect(b.rollDampingZ).toBeCloseTo(roll(iz, 1 / b.invIl[8]!), 6);
  });

  it('a ship of full blocks keeps the M1 estimate (the half-layer path only runs with half cubes)', () => {
    const world = makeSea();
    const { dyn } = setup(world);
    const raft = newShip(world, 1);
    fillGrid(raft.grid, -3, 47, -4, 3, 47, 4, makeCell(B.PLANKS_OAK));
    launch(raft, dyn);
    const b = bodyOf(dyn, raft);
    const o = DEFAULT_OPTIONS;
    expect(b.shape.halfCount).toBe(0);
    expect(b.heaveDamping).toBeCloseTo(2 * o.heaveDampingRatio * Math.sqrt((o.gravity * o.waterDensity * 63) / raft.mass), 10);
  });
});
