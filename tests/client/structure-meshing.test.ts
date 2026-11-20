/**
 * Where client/structures.ts meshes a structure (docs/SHAPES.md 8.5): on the main thread while its
 * padded snapshot is small, so a freshly assembled raft appears in the frame its blocks leave the
 * world; in the mesh worker pool above that. The limit is 24^3 padded cells for a snapshot of
 * whole blocks, as it always was, and 12^3 for a snapshot that carries a holes or second-part layer
 * (partial cells give two to three times the quads per cell). The padded snapshot is the
 * structure's tight cell box grown by one cell on every side.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { quat, vec3 } from '../../src/core/math';
import { StructureRenderer } from '../../src/client/structures';
import type { WorkerPool } from '../../src/client/workers';
import type { MeshResponse } from '../../src/mesh/types';
import type { ClientReplica } from '../../src/net/client/replica';
import type { RenderBackend } from '../../src/render/backend';
import type { Structure } from '../../src/structures/structure';
import { StructureGrid } from '../../src/voxel/sgrid';
import { LOWER, UPPER, slab } from '../shapes';
import { emptyWorld } from '../voxel/helpers';

const PLANKS = makeCell(B.PLANKS_OAK);

/** A renderer with a recording backend and a pool that accepts every job (and answers none). */
function rig(pool: 'working' | 'failed' | 'none' = 'working') {
  const meshed: number[] = [];
  const jobs: number[] = [];
  const backend = {
    setStructureMesh: (id: number, _ox: number, _oy: number, _oz: number, mesh: unknown) => {
      if (mesh !== null) meshed.push(id);
    },
    setStructurePose: () => undefined,
    setStructureDryVolume: () => undefined,
  } as unknown as RenderBackend;
  let nextJob = 1;
  const workers = {
    failed: pool === 'failed',
    submit: (build: (id: number) => unknown) => {
      const req = build(nextJob++) as { input: { cells: Uint16Array } };
      jobs.push(req.input.cells.length);
      return true;
    },
  } as unknown as WorkerPool<MeshResponse>;
  const errors: string[] = [];
  const renderer = new StructureRenderer(backend, pool === 'none' ? null : workers, (what) => errors.push(what));
  const world = emptyWorld(0, 0);
  const list: Structure[] = [];
  const replica = { world, structures: () => list } as unknown as ClientReplica;
  return { renderer, replica, list, meshed, jobs, errors };
}

/** A structure whose tight box is sx x sy x sz: `corner` at its low corner and planks at the opposite one. */
function structure(id: number, sx: number, sy: number, sz: number, corner: number): Structure {
  const g = new StructureGrid(id, emptyWorld(0, 0));
  g.setPoseImmediate(vec3(8, 40, 8), quat());
  g.setCell(0, 0, 0, corner);
  g.setCell(sx - 1, sy - 1, sz - 1, PLANKS);
  return { id, grid: g } as unknown as Structure;
}

/** Where `s` was meshed: 'main' (installed at once), 'worker' (a job of that many padded cells submitted). */
function placeOf(s: Structure, pool: 'working' | 'failed' | 'none' = 'working'): { where: 'main' | 'worker'; cells: number } {
  const r = rig(pool);
  r.list.push(s);
  r.renderer.update(r.replica, 0.05);
  expect(r.errors).toEqual([]);
  if (r.jobs.length > 0) {
    expect(r.meshed).toEqual([]);
    return { where: 'worker', cells: r.jobs[0]! };
  }
  expect(r.meshed).toEqual([s.id]);
  return { where: 'main', cells: -1 };
}

const SLAB = slab(B.PLANKS_OAK, LOWER);
const TWO_PART = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));

describe('structures are meshed on the main thread up to a padded size, in the mesh worker above it', () => {
  it('whole blocks: 24^3 padded cells (a 22^3 box) on the main thread, one layer more in the worker', () => {
    expect(placeOf(structure(1, 22, 22, 22, PLANKS))).toEqual({ where: 'main', cells: -1 });
    expect(placeOf(structure(2, 22, 23, 22, PLANKS))).toEqual({ where: 'worker', cells: 24 * 25 * 24 });
  });

  it('with a holes layer (a half slab) or a second-part layer (a two-part cell): 12^3 padded cells (a 10^3 box) on the main thread, one layer more in the worker', () => {
    for (const [k, corner] of [SLAB, TWO_PART].entries()) {
      expect(placeOf(structure(10 + k, 10, 10, 10, corner))).toEqual({ where: 'main', cells: -1 });
      expect(placeOf(structure(20 + k, 10, 11, 10, corner))).toEqual({ where: 'worker', cells: 12 * 13 * 12 });
      // Well under the whole-block limit, still the worker.
      expect(placeOf(structure(30 + k, 22, 22, 22, corner))).toEqual({ where: 'worker', cells: 24 * 24 * 24 });
    }
  });

  it('the snapshot decides, not the grid: a grid whose last partial cell became a whole block keeps its layers but meshes like whole blocks', () => {
    const s = structure(40, 14, 14, 14, SLAB);
    expect(placeOf(s)).toEqual({ where: 'worker', cells: 16 * 16 * 16 });
    s.grid.setCell(0, 0, 0, PLANKS);
    expect(s.grid.layered).toBe(true); // layers are never dropped (docs/SHAPES.md 4.1) ...
    expect(placeOf(s)).toEqual({ where: 'main', cells: -1 }); // ... but the snapshot carries none
  });

  it('without a working pool everything is meshed on the main thread', () => {
    expect(placeOf(structure(50, 22, 23, 22, PLANKS), 'none')).toEqual({ where: 'main', cells: -1 });
    expect(placeOf(structure(51, 14, 14, 14, SLAB), 'failed')).toEqual({ where: 'main', cells: -1 });
  });
});
