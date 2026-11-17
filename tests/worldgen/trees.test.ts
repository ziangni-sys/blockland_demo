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

  it('stamps the same logs whatever the tree order', () => {
    // (Where two crowns overlap, the leaf species follows the list order, which is a world
    // order and the same in every chunk; logs must not depend on it at all.)
    const a = new Uint16Array(CHUNK_VOLUME);
    const b = new Uint16Array(CHUNK_VOLUME);
    stampTrees(a, 0, 0, pair('oak-first').list);
    stampTrees(b, 0, 0, pair('pine-first').list);
    let logs = 0;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const la = cellId(a[i]!) === B.LOG_OAK || cellId(a[i]!) === B.LOG_PINE;
      const lb = cellId(b[i]!) === B.LOG_OAK || cellId(b[i]!) === B.LOG_PINE;
      if (la || lb) {
        logs++;
        expect(b[i], `cell ${i}`).toBe(a[i]);
      }
    }
    expect(logs).toBe(7 + 9 + 3); // the oak's far +x branch cell is the pine's trunk
  });

  it('conifer cones have leaves beside the trunk on every tier (no bare trunk segments)', () => {
    // Narrow tiers near the tip used to shrink to the trunk cell alone, or lose all four
    // side cells to the ragged-edge hash, leaving bare trunk segments inside the cone.
    const list = new TreeList();
    for (let trunk = 6; trunk <= 10; trunk++) {
      for (let k = 0; k < 8; k++) {
        for (let h = 0; h < 64; h++) {
          list.clear();
          Object.assign(list.push(), {
            x: 8,
            z: 8,
            ground: 40,
            kind: TREE_CONIFER,
            trunk,
            radius: 2 + k * 0.16,
            hash: Math.imul(h + 1, 0x9e3779b1) | 0,
          } satisfies TreeSpec);
          const cells = new Uint16Array(CHUNK_VOLUME);
          stampTrees(cells, 0, 0, list);
          // The lowest tier starts at ground + 2..4; check from there to just under the tip.
          for (let y = 40 + 4; y <= 40 + trunk; y++) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              expect(cellId(cells[at(8 + dx, y, 8 + dz)]!), `trunk ${trunk} r ${k} hash ${h} y ${y}`).toBe(B.LEAVES_PINE);
            }
          }
          expect(cellId(cells[at(8, 40 + trunk + 1, 8)]!)).toBe(B.LEAVES_PINE); // tip
        }
      }
    }
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
