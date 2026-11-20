/**
 * End to end with partial blocks (docs/SHAPES.md 16.2 P10; NETCODE section 5 "为什么方块不会重复或
 * 消失", scenario 34): parts are conserved on every client while a raft with two-part cells is
 * assembled, sailed, mined from and docked. The host's own client (survival) does everything with
 * its hands; three guests, one on each of the three links, watch.
 *
 * What is counted: the parts of each block id involved (two-part cells count both parts) in the
 * world cells of the area, in every structure, and in the item stacks lying around; for the server
 * and for the host also the host's inventory (a client sees no one else's).
 *  - The server's count never changes.
 *  - The host's count (its replica plus the inventory it shows) never changes at any frame: no
 *    frame shows a part twice (in the ship and in the world, or lying and in the inventory) or not
 *    at all.
 *  - A guest's count equals the total until the mined part is picked up into the host's inventory,
 *    then the total less that one part, and never anything else.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { NZ, PZ } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { Ship } from '../../src/structures/structure';
import { getPacked } from '../../src/voxel/parts';
import { NetHarness, testMeta, type HeadlessClient } from './harness';
import { LINKS, SEA, SEA_TOP } from './e2e-scenes';
import { partialRaft, replicaParts, serverParts, type Box } from './e2e-shapes-scenes';

const IDS = [B.PLANKS_OAK, B.PLANKS_PINE, B.STONE, B.WOOL_RED];
const BOX: Box = [-40, SEA_TOP - 3, -40, 40, SEA_TOP + 4, 40];

/** Add an inventory's counts of IDS to a count (as countParts returns it). */
function plusInventory(count: readonly string[], inv: { count(item: number): number }): string[] {
  return count.map((s) => {
    const [id, n] = s.split(':').map(Number) as [number, number];
    return `${id}:${n + inv.count(id)}`;
  });
}

describe('conservation of parts end to end', () => {
  it('a raft with two-part cells: assembled, sailed, a part mined off it and picked up, docked; every frame of every client holds every part once', async () => {
    const h = new NetHarness({ starterItems: false });
    await h.create(testMeta('w1', 'survival'), { generator: SEA, exampleShip: false });
    const sim = h.sim;
    const helm = partialRaft(sim, -2, -3);
    const host = h.addClient('host', {}, { local: true, viewRadius: 4 });
    h.runUntil(() => host.ready);
    const hostCtrl = sim.players.get('host')!;
    const toasts: string[] = [];
    sim.events.on((e) => {
      if (e.type === 'toast') toasts.push(e.message.key);
    });
    const total = serverParts(sim, BOX, IDS);
    expect(total).toEqual([`${B.PLANKS_OAK}:${30 + 5}`, `${B.PLANKS_PINE}:1`, `${B.STONE}:1`, `${B.WOOL_RED}:1`]);
    const less = total.map((s) => (s.startsWith(`${B.PLANKS_PINE}:`) ? `${B.PLANKS_PINE}:0` : s));

    await h.host.control({ type: 'openRoom' });
    const guests = LINKS.map((l, i) => h.addClient(`g${i}`, l.make(70 + 2 * i), { viewRadius: 4 }));
    const clients: HeadlessClient[] = [host, ...guests];
    for (const c of clients) h.track(c);
    const counted = new Map<HeadlessClient, number>();
    const pickedUpSeen = new Map<HeadlessClient, boolean>();
    const wrong: string[] = [];
    for (const c of clients) {
      counted.set(c, 0);
      pickedUpSeen.set(c, false);
      c.onFrame = () => {
        const n = replicaParts(c, BOX, IDS);
        if (n === null) return;
        counted.set(c, counted.get(c)! + 1);
        const got = c === host ? plusInventory(n, c.inventory) : n;
        const text = JSON.stringify(got);
        let ok: boolean;
        if (c === host) ok = text === JSON.stringify(total);
        else if (text === JSON.stringify(less)) {
          pickedUpSeen.set(c, true);
          ok = true;
        } else ok = !pickedUpSeen.get(c) && text === JSON.stringify(total);
        if (!ok && wrong.length < 10) wrong.push(`${c.key} at frame ${c.frames} (tick ${c.state!.tick}): ${got.join(' ')}`);
      };
    }
    let serverWrong = 0;
    const serverLog: string[] = [];
    h.onTick = () => {
      const got = plusInventory(serverParts(sim, BOX, IDS), hostCtrl.player.inventory);
      if (JSON.stringify(got) !== JSON.stringify(total)) {
        serverWrong++;
        if (serverLog.length < 3) serverLog.push(`tick ${sim.ticks}: ${got.join(' ')} toasts ${toasts.join(',')}`);
      }
    };
    h.runUntil(() => guests.every((g) => g.ready && replicaParts(g, BOX, IDS) !== null), 60_000);

    // The host assembles the raft at its helm (preview, assemble: takes the wheel) and sails it.
    host.emptyHand();
    host.teleport(helm.x + 0.5, SEA_TOP, helm.z + 1.5);
    expect(host.useOn(helm.x, helm.y, helm.z, PZ)).toBe(true);
    expect(host.useOn(helm.x, helm.y, helm.z, PZ)).toBe(true);
    const ship = sim.structures.ships()[0];
    expect(ship).toBeInstanceOf(Ship);
    host.input.forward = 1;
    h.run(2000);
    host.input.forward = 0;
    h.run(2000);
    // It lets go of the wheel, steps toward the bow and mines the pine half of the lower/upper
    // two-part cell (ship-local (0, SEA_TOP, -3)) by hand; the planks half stays. The pine drop
    // lands on the deck beside the host, who picks it up.
    host.use();
    h.run(500);
    const stand = ship!.grid.toWorld(vec3(0.5, SEA_TOP + 0.05, -1.5));
    host.teleport(stand.x, stand.y, stand.z);
    h.run(500);
    expect(host.mine(0, SEA_TOP, -3, PZ, ship!.id, 30_000, 6)).toBe(true);
    expect(getPacked(ship!.grid, 0, SEA_TOP, -3) & 0x3ff).toBe(B.PLANKS_OAK);
    h.runUntil(() => hostCtrl.player.inventory.count(B.PLANKS_PINE) === 1, 10_000);
    h.run(1000);
    expect(host.inventory.count(B.PLANKS_PINE)).toBe(1);
    // The pickup went into the selected (empty) slot: the host selects an empty one, then docks
    // from the helm's north face (sneak + right-click).
    host.emptyHand();
    h.run(200);
    host.input.sneak = true;
    expect(host.useOn(helm.x, helm.y, helm.z, NZ, ship!.id)).toBe(true);
    host.input.sneak = false;
    expect(ship!.removed, JSON.stringify(toasts)).toBe(true);
    h.run(3000);

    expect(serverWrong, serverLog.join(' | ')).toBe(0);
    expect(wrong).toEqual([]);
    for (const c of clients) {
      expect(counted.get(c), c.key).toBeGreaterThan(300);
      expect(c.mismatches.slice(0, 5), c.key).toEqual([]);
      if (c !== host) expect(pickedUpSeen.get(c), `${c.key} saw the pickup`).toBe(true);
    }
    h.quiesce();
    for (const c of clients) expect(h.compareNow(c), c.key).toEqual([]);
  }, 180_000);
});
