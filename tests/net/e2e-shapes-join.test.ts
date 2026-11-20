/**
 * End to end with partial blocks (docs/SHAPES.md 16.2 P10; NETCODE section 16, scenario 34): a guest
 * joins midway through the real stack on each of the three links, while
 *  - the world's columns hold partial and two-part cells (a showcase row of every kind on an island),
 *  - a raft with two-part cells, a stair and a slab sails in circles under a server-driven bot,
 *  - a dam that just broke floods past half slabs (liquid replication beside partial cells),
 *  - and a walled room under a roof of lower slabs stands on the island.
 * From "ready" on, every applied batch's digest equals the server's at that tick (section 13.4: the
 * digest covers both extra layers; tests/net/digest.ts). The guest's replica light under the slab
 * roof is dark, and once a slab of it is taken out, full sky light reaches the floor under the gap:
 * scenario 44 read from the replica of a guest on a lossy link (the server has no light).
 * After quiesce() everything is equal, poses included.
 */
import { describe, expect, it } from 'vitest';
import { makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { LIQUID } from '../../src/blocks/registry';
import { canonCell } from '../../src/blocks/shapes';
import { PX } from '../../src/core/dirs';
import { getPacked } from '../../src/voxel/parts';
import { LOWER, partLabels, slab, stairFill, UPPER, WEST } from '../shapes';
import { NetHarness, testMeta } from './harness';
import { dam, island, LINKS, SEA, SEA_TOP, untilShipsRest, useOn } from './e2e-scenes';
import { boxLabels, partialRaft, placeRow, SHOWCASE } from './e2e-shapes-scenes';

const IX = 20;
/** The flood's way east of the dam's +X wall (x IX + 9): partial cells on the island's top. */
const FLOOD_PARTS: ReadonlyArray<readonly [number, number, number]> = [
  [IX + 11, -8, slab(B.STONE, LOWER)],
  [IX + 11, -6, slab(B.GLASS, UPPER)],
  [IX + 12, -7, canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER))],
  [IX + 13, -5, slab(B.BRICKS, stairFill(PX))],
  [IX + 13, -8, slab(B.STONE, WEST)],
];
/** The room under the slab roof: walls x ROOM.x0..x1, z ROOM.z0..z1, y SEA_TOP..ROOF. */
const ROOM = { x0: IX + 14, x1: IX + 18, z0: 2, z1: 6 };
const ROOF = SEA_TOP + 3;

describe.each(LINKS)('joining a world with partial blocks over $name (end to end)', ({ make }) => {
  it('partial cells in the columns, a sailing raft with two-part cells, a flood past half slabs: digests every tick from ready; the replica is dark under a slab roof and lit under its gap', async () => {
    const h = new NetHarness({ history: true });
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    island(sim, IX, -12, IX + 20, 12);
    placeRow(sim.world, IX + 2, SEA_TOP, 8, SHOWCASE);
    placeRow(sim.world, IX + 2, SEA_TOP + 1, 8, [...SHOWCASE].reverse());
    const breakDam = dam(sim, IX + 2, -10);
    for (const [x, z, c] of FLOOD_PARTS) sim.world.setCell(x, SEA_TOP, z, c);
    for (let y = SEA_TOP; y <= ROOF; y++) {
      for (let x = ROOM.x0; x <= ROOM.x1; x++) {
        for (let z = ROOM.z0; z <= ROOM.z1; z++) {
          const edge = x === ROOM.x0 || x === ROOM.x1 || z === ROOM.z0 || z === ROOM.z1;
          if (edge) sim.world.setCell(x, y, z, makeCell(B.STONE));
          else if (y === ROOF) sim.world.setCell(x, y, z, slab(B.STONE, LOWER));
        }
      }
    }
    const helm = partialRaft(sim, -2, -3);
    const bot = sim.join('bot');
    const host = h.addClient('host', {}, { local: true, viewRadius: 5 });
    h.track(host);
    h.runUntil(() => host.ready);
    // The bot assembles the raft at its helm and sails it in circles.
    bot.emptyHand();
    bot.teleport(helm.x + 0.5, SEA_TOP, helm.z + 1.5);
    h.ticks(2);
    useOn(h, bot, helm.x, helm.y, helm.z);
    useOn(h, bot, helm.x, helm.y, helm.z);
    const ship = sim.structures.ships()[0]!;
    expect(ship).toBeDefined();
    let twoPart = 0;
    ship.grid.forEachCell((_x, _y, _z, p) => {
      if (p >= 2 ** 25) twoPart++;
    });
    expect(twoPart).toBe(3);
    bot.player.input.forward = 1;
    bot.player.input.strafe = 0.5;
    h.ticks(60);
    breakDam();
    h.ticks(5);
    let flowing = 0;
    sim.world.onCellChange(() => flowing++);

    await h.host.control({ type: 'openRoom' });
    const g = h.addClient('guest', make(37), { viewRadius: 5 });
    h.track(g);
    h.runUntil(() => g.ready, 30_000);
    const readyAt = g.checked;
    h.run(8_000);
    expect(flowing).toBeGreaterThan(50); // the water was still moving while the guest joined
    expect(g.mismatches.slice(0, 5)).toEqual([]);
    expect(host.mismatches.slice(0, 5)).toEqual([]);
    expect(g.checked - readyAt).toBeGreaterThan(100);

    // The flood went around the partial cells and into none (liquid replication beside them).
    for (const [x, z, c] of FLOOD_PARTS) expect(getPacked(sim.world, x, SEA_TOP, z)).toBe(c);
    expect(LIQUID[sim.world.getCell(IX + 10, SEA_TOP, -7) & 0x3ff], 'the flood got past the wall').toBe(1);
    const r = g.replica!;
    expect(boxLabels(r.world, IX + 9, SEA_TOP, -10, IX + 14, SEA_TOP, -3)).toEqual(boxLabels(sim.world, IX + 9, SEA_TOP, -10, IX + 14, SEA_TOP, -3));
    expect(boxLabels(r.world, IX + 2, SEA_TOP, 8, IX + 11, SEA_TOP + 1, 8)).toEqual(boxLabels(sim.world, IX + 2, SEA_TOP, 8, IX + 11, SEA_TOP + 1, 8));

    // Scenario 44 in the guest's replica: dark under the roof of lower slabs.
    const sky = (x: number, y: number, z: number): number => r.world.getSkyLight(x, y, z);
    expect(sky(ROOM.x1 + 2, SEA_TOP, ROOM.z0), '(premise) the open sky').toBe(15);
    for (let y = SEA_TOP; y < ROOF; y++) for (let x = ROOM.x0 + 1; x < ROOM.x1; x++) for (let z = ROOM.z0 + 1; z < ROOM.z1; z++) expect(sky(x, y, z), `${x},${y},${z}`).toBe(0);
    // A slab of the roof goes (on the server); the gap reaches the guest and its light comes in.
    const gx = ROOM.x0 + 2;
    const gz = ROOM.z0 + 2;
    sim.world.setCell(gx, ROOF, gz, 0);
    h.runUntil(() => getPacked(r.world, gx, ROOF, gz) === 0, 10_000);
    h.run(500);
    for (let y = SEA_TOP; y < ROOF; y++) expect(sky(gx, y, gz), `under the gap at y ${y}`).toBe(15);
    expect(sky(gx + 1, SEA_TOP, gz)).toBe(14);

    bot.player.input.forward = 0;
    bot.player.input.strafe = 0;
    untilShipsRest(h);
    h.quiesce();
    const rs = r.state.structures.get(ship.id);
    expect(rs).toBeDefined();
    const b = ship.grid.cellBounds()!;
    expect(partLabels(rs!.structure.grid, b)).toEqual(partLabels(ship.grid, b));
    expect(h.compareNow(g)).toEqual([]);
    expect(h.compareNow(host)).toEqual([]);
  }, 120_000);
});
