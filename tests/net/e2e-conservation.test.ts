/**
 * End to end (NETCODE section 5 "为什么方块不会重复或消失", scenario 34): three guests, one on each
 * of the three links, watch a raft and then a 3700-cell plank ship assemble from the world and dock
 * back into it. At every frame of every client, once the columns of the area are in its replica,
 * the planks in its world plus those in its structures equal the server's count, which never
 * changes: no frame shows a plank twice or not at all.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ } from '../../src/core/dirs';
import { Ship } from '../../src/structures/structure';
import { NetHarness, testMeta, type HeadlessClient } from './harness';
import { fill, island, loadArea, LINKS, replicaPlanks, SEA, SEA_TOP, serverPlanks, useOn, type Box } from './e2e-scenes';

const DECK = SEA_TOP - 1;

describe('conservation end to end', () => {
  it('a raft and a 3700-cell ship assemble and dock: every frame of every client holds the same number of planks', async () => {
    const h = new NetHarness();
    await h.create(testMeta(), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    // A pier, a 6 x 5 raft beside it, and a 37 x 100 plank deck further out, each with a helm.
    loadArea(sim, -20, -60, 90, 60);
    island(sim, -4, 8, 6, 14);
    fill(sim, -2, DECK, 2, 3, DECK, 6, B.PLANKS_OAK);
    sim.world.setCell(0, SEA_TOP, 3, makeCell(B.HELM, facingState(NZ)));
    const bigX = 30;
    fill(sim, bigX, DECK, -50, bigX + 36, DECK, 49, B.PLANKS_OAK);
    sim.world.setCell(bigX + 18, SEA_TOP, 40, makeCell(B.HELM, facingState(NZ)));
    const bot = sim.join('bot');
    bot.emptyHand();
    const box: Box = [-20, DECK - 2, -60, bigX + 50, SEA_TOP + 3, 60];
    const planks = serverPlanks(sim, box);
    expect(planks).toBe(30 + 3700);

    const host = h.addClient('host', {}, { local: true, viewRadius: 6 });
    h.runUntil(() => host.ready);
    await h.host.control({ type: 'openRoom' });
    const guests = LINKS.map((l, i) => h.addClient(`g${i}`, l.make(40 + 2 * i), { viewRadius: 7 }));
    const clients: HeadlessClient[] = [host, ...guests];
    for (const c of clients) h.track(c);
    const counted = new Map<HeadlessClient, number>();
    const wrong: string[] = [];
    for (const c of clients) {
      counted.set(c, 0);
      c.onFrame = () => {
        const n = replicaPlanks(c, box);
        if (n === null) return;
        counted.set(c, counted.get(c)! + 1);
        if (n !== planks && wrong.length < 10) wrong.push(`${c.key} at frame ${c.frames} (tick ${c.state!.tick}): ${n}`);
      };
    }
    let serverWrong = 0;
    h.onTick = () => {
      if (serverPlanks(sim, box) !== planks) serverWrong++;
    };
    h.runUntil(() => guests.every((g) => g.ready && replicaPlanks(g, box) !== null), 60_000);

    // The raft: preview, assemble (the bot takes the wheel), sail a little, dock.
    bot.teleport(0.5, SEA_TOP, 4.5);
    h.ticks(2);
    useOn(h, bot, 0, SEA_TOP, 3);
    useOn(h, bot, 0, SEA_TOP, 3);
    const raft = sim.structures.ships()[0];
    expect(raft).toBeInstanceOf(Ship);
    bot.player.input.forward = 1;
    h.ticks(40);
    bot.player.input.forward = 0;
    h.ticks(40);
    bot.player.input.sneak = true;
    bot.use();
    h.ticks(1);
    bot.player.input.sneak = false;
    expect(raft!.removed).toBe(true);
    h.run(3000);

    // The big ship: the same, from its helm.
    bot.teleport(bigX + 18.5, SEA_TOP, 41.5);
    h.ticks(2);
    useOn(h, bot, bigX + 18, SEA_TOP, 40);
    useOn(h, bot, bigX + 18, SEA_TOP, 40);
    const big = sim.structures.ships()[0];
    expect(big).toBeInstanceOf(Ship);
    let cells = 0;
    big!.grid.forEachCell(() => cells++);
    expect(cells).toBe(3701);
    bot.player.input.forward = 1;
    h.ticks(60);
    bot.player.input.forward = 0;
    h.ticks(60);
    bot.player.input.sneak = true;
    bot.use();
    h.ticks(1);
    bot.player.input.sneak = false;
    expect(big!.removed).toBe(true);
    h.run(3000);

    expect(serverWrong).toBe(0);
    expect(wrong).toEqual([]);
    for (const c of clients) {
      expect(counted.get(c), c.key).toBeGreaterThan(600);
      expect(c.mismatches.slice(0, 5), c.key).toEqual([]);
    }
    h.quiesce();
    for (const c of clients) expect(h.compareNow(c), c.key).toEqual([]);
  }, 180_000);
});
