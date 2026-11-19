/**
 * Section meshing with partial cells (docs/SHAPES.md 8.1): a buried section with one chiselled
 * octant is not "all opaque", goes through the mesher and shows its hole; the SectionMesher's
 * main-thread path installs it.
 */
import { describe, expect, it } from 'vitest';
import { makeCell, makePart } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { SectionMesher, isTriviallyEmpty } from '../../src/client/meshing';
import { buildMesh } from '../../src/mesh/mesher';
import { snapshotSection } from '../../src/mesh/snapshot';
import { sectionKey } from '../../src/voxel/chunk';
import { FLAT_TOP, RecordingBackend, flatWorld } from './rig';

const noErrors = (what: string, err: unknown): void => {
  throw new Error(`${what}: ${String(err)}`);
};

describe('isTriviallyEmpty with partial cells', () => {
  it('a buried stone section with one chiselled octant is not trivially empty, and meshes its hole', () => {
    const world = flatWorld(1);
    const before = snapshotSection(world, 0, 0, 0);
    expect(isTriviallyEmpty(before)).toBe(true);
    // Chisel octant 7 out of a buried stone cell: its three faces toward the hole and the three
    // neighbour quarter faces around it become visible.
    world.setCell(5, 8, 5, makePart(B.STONE, 0, 0x80));
    const after = snapshotSection(world, 0, 0, 0);
    expect(after.holes).not.toBeNull();
    expect(isTriviallyEmpty(after)).toBe(false);
    const m = buildMesh(after);
    expect(m.opaque).not.toBeNull();
    expect(m.opaque!.vertexCount / 4).toBe(6);
    // Filling it back in: the section is all opaque again (the holes layer stays allocated and all zero).
    world.setCell(5, 8, 5, makeCell(B.STONE));
    expect(isTriviallyEmpty(snapshotSection(world, 0, 0, 0))).toBe(true);
  });

  it('a two-part cell (glass set into a stone wall) also disqualifies the shortcut', () => {
    const world = flatWorld(1);
    world.setCell(5, 8, 5, canonCell(makePart(B.STONE, 0, 0x0f), makePart(B.GLASS, 0, 0xf0)));
    const s = snapshotSection(world, 0, 0, 0);
    expect(s.part2).not.toBeNull();
    expect(isTriviallyEmpty(s)).toBe(false);
    // Glass in a stone wall: the stone around it shows its faces toward the glass.
    expect(buildMesh(s).opaque).not.toBeNull();
  });

  it('the SectionMesher installs a mesh for the buried section once a hole is chiselled', () => {
    const world = flatWorld(2);
    const backend = new RecordingBackend();
    const m = new SectionMesher(world, backend, null, () => 0, noErrors);
    const settle = (): void => {
      for (let i = 0; i < 400; i++) m.update(0, 1e9, 0.5, FLAT_TOP, 0.5, 0, -1);
    };
    settle();
    expect(backend.sections.has(sectionKey(0, 0, 0))).toBe(false);
    world.setCell(5, 8, 5, makePart(B.STONE, 0, 0x80));
    settle();
    expect(backend.sections.has(sectionKey(0, 0, 0))).toBe(true);
  });
});
