import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { AXIS_X, AXIS_Y } from '../../src/core/dirs';
import { cellId, cellState, stateAxis } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { stampTrees, TREE_BROADLEAF, TREE_CONIFER, TreeList, type TreeSpec } from '../../src/worldgen/trees';

const at = (x: number, y: number, z: number): number => x | (z << 4) | (y << 8);

/** A large broadleaf at (5, 8) whose lobes point +x and -x (lobe bits of hash 0), and a pine 2 cells east. */
function pair(order: 'oak-first' | 'pine-first'): { list: TreeList; oak: TreeSpec; pine: TreeSpec } {
  const oak: TreeSpec = { x: 5, z: 8, ground: 50, kind: TREE_BROADLEAF, trunk: 7, radius: 3.2, hash: 0 };
  const pine: TreeSpec = { x: 7, z: 8, ground: 50, kind: TREE_CONIFER, trunk: 9, radius: 2.4, hash: 0x1234 };
  const list = new TreeList();
  for (const t of order === 'oak-first' ? [oak, pine] : [pine, oak]) Object.assign(list.push(), t);
  return { list, oak, pine };
}

describe('tree stamping', () => {
  for (const order of ['oak-first', 'pine-first'] as const) {
    it(`a branch never takes a cell of a neighbouring trunk (${order})`, () => {
      // The oak's +x branch reaches 2 cells, exactly to the pine's trunk column, at
      // y = ground + trunk - 2. Trunks are stamped (for all trees) before any branch.
      const { list, oak, pine } = pair(order);
      const cells = new Uint16Array(CHUNK_VOLUME);
      stampTrees(cells, 0, 0, list);
      for (let k = 1; k <= pine.trunk; k++) {
        const c = cells[at(pine.x, pine.ground + k, pine.z)]!;
        expect(cellId(c), `pine trunk at y=${pine.ground + k}`).toBe(B.LOG_PINE);
        expect(stateAxis(cellState(c))).toBe(AXIS_Y);
      }
      for (let k = 1; k <= oak.trunk; k++) expect(cellId(cells[at(oak.x, oak.ground + k, oak.z)]!)).toBe(B.LOG_OAK);
      // The branch itself is still there and joins its trunk.
      const branch = cells[at(oak.x + 1, oak.ground + oak.trunk - 2, oak.z)]!;
      expect(cellId(branch)).toBe(B.LOG_OAK);
      expect(stateAxis(cellState(branch))).toBe(AXIS_X);
      expect(cellId(cells[at(oak.x - 2, oak.ground + oak.trunk - 2, oak.z)]!)).toBe(B.LOG_OAK);
    });
  }

  it('stamps identical cells whatever the tree order', () => {
    const a = new Uint16Array(CHUNK_VOLUME);
    const b = new Uint16Array(CHUNK_VOLUME);
    stampTrees(a, 0, 0, pair('oak-first').list);
    stampTrees(b, 0, 0, pair('pine-first').list);
    expect(b).toEqual(a);
  });

  it('only fills air and leaves: terrain and other logs are kept', () => {
    const { list, oak } = pair('oak-first');
    const cells = new Uint16Array(CHUNK_VOLUME);
    const rock = B.STONE;
    // A rock pillar where the oak's -x branch would go.
    for (let y = 0; y < 128; y++) cells[at(oak.x - 2, y, oak.z)] = rock;
    stampTrees(cells, 0, 0, list);
    expect(cells[at(oak.x - 2, oak.ground + oak.trunk - 2, oak.z)]).toBe(rock);
    expect(cellId(cells[at(oak.x - 1, oak.ground + oak.trunk - 2, oak.z)]!)).toBe(B.LOG_OAK);
  });
});
