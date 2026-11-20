/**
 * End to end with partial blocks (docs/SHAPES.md 6.2, 6.3, 16.2 P10; scenario 33 with parts): two
 * players act on the two parts of one cell at once, through the real stack (HeadlessClients on
 * loopback links, ServerHost), in survival:
 *  - both mine their own half of a two-part cell, starting in the same frame on equal links: both
 *    parts break in the same server tick, each returns one block, nothing is lost or doubled;
 *  - a guest on a lossy link mines one part while the host changes it (its debug command, a
 *    stand-in for the M2.4 chisel): chisels an octant off it, or replaces it with stone. The mining
 *    that was under way does not carry over to the new part (it takes the full time of its
 *    material, and the drop is that material's);
 *  - the mirror case: a guest on a lossy link mines one part while the host mines the OTHER part
 *    of the same cell. The guest's mining goes on where it was (its part did not change).
 * The guest cases run on both lossy links of the end-to-end tests (e2e-scenes.ts LINKS); mining
 * progress is read on the server, once per tick, so that the links' delays do not enter the checks.
 * Every applied batch's digest equals the server's (NetHarness.track); after quiesce() the replicas
 * equal the server in full.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { NX, PX } from '../../src/core/dirs';
import { ItemEntity } from '../../src/entities/entity';
import type { Simulation } from '../../src/sim/simulation';
import { getPacked } from '../../src/voxel/parts';
import { EAST, slab, WEST } from '../shapes';
import type { HeadlessClient, NetHarness } from './harness';
import { LINKS } from './e2e-scenes';
import { LAND, LAND_TOP, ownWorld } from './own-scenes';

const T = LAND_TOP;

/** The blockBroken events from now on: the server tick and the part broken. */
function breaks(sim: Simulation): Array<{ tick: number; part: number }> {
  const out: Array<{ tick: number; part: number }> = [];
  sim.events.on((e) => {
    if (e.type === 'blockBroken') out.push({ tick: sim.ticks, part: e.cell });
  });
  return out;
}

/** Items of `item`: in the server's inventories of the given players plus lying in the world. */
function owned(sim: Simulation, item: number, players: readonly string[]): number {
  let n = 0;
  for (const k of players) n += sim.players.get(k)!.player.inventory.count(item);
  for (const e of sim.entities.all()) if (!e.removed && e instanceof ItemEntity && e.stack.item === item) n += e.stack.count;
  return n;
}

/**
 * The server's view of one player's mining, sampled once per server tick while runWatching runs:
 * the progress (null when not mining). rate() is the largest progress made in one tick (the speed
 * of the material being mined; a tick lost to the link only makes a step smaller, never larger).
 */
interface MiningWatch {
  readonly samples: Array<{ tick: number; progress: number | null }>;
  sample(): void;
  rate(): number;
  clear(): void;
}

function miningOf(sim: Simulation, key: string): MiningWatch {
  const samples: Array<{ tick: number; progress: number | null }> = [];
  return {
    samples,
    sample() {
      if (samples.length > 0 && samples[samples.length - 1]!.tick === sim.ticks) return;
      samples.push({ tick: sim.ticks, progress: sim.players.get(key)!.view.mining?.progress ?? null });
    },
    rate() {
      let r = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1]!;
        const b = samples[i]!;
        if (b.tick === a.tick + 1 && a.progress !== null && b.progress !== null) r = Math.max(r, b.progress - a.progress);
      }
      return r;
    },
    clear() {
      samples.length = 0;
    },
  };
}

/** NetHarness.runUntil, sampling `w` on the way (the condition is checked several times a tick). */
function runWatching(h: NetHarness, w: MiningWatch, cond: () => boolean, maxMs: number): void {
  h.runUntil(() => {
    w.sample();
    return cond();
  }, maxMs);
}

/** Run until client `c`'s replica holds `cell` at (x, y, z) (a lossy link can take a while). */
function seen(h: NetHarness, c: HeadlessClient, x: number, y: number, z: number, cell: number): void {
  h.runUntil(() => c.replica !== null && getPacked(c.replica.world, x, y, z) === cell, 30_000);
}

/** Hold the left button on octant `octant` of the cell (aim kept every frame). */
function press(c: HeadlessClient, x: number, y: number, z: number, face: number, octant: number): void {
  if (!c.aimAt(x, y, z, face as 0, 0, true, octant)) throw new Error(`${c.key} cannot aim at octant ${octant} of ${x},${y},${z}`);
  c.emptyHand();
  c.holdAim({ x, y, z, face: face as 0, gridId: 0, octant });
  c.pressAttack();
}

function release(c: HeadlessClient): void {
  c.holdAim(null);
  if (c.intents?.attackHeld) c.releaseAttack();
}

describe('two players and the two parts of one cell (end to end)', () => {
  it('both mine their own half in the same frame on equal links: both parts break in the same tick; two planks come back, the replicas equal the server', async () => {
    const r = await ownWorld(LAND, 'survival', {});
    const { h, sim } = r;
    await h.host.control({ type: 'openRoom' });
    const a = r.c;
    const b = h.addClient('b', {}, { viewRadius: 3 });
    h.runUntil(() => b.ready && b.intents !== null, 30_000);
    const X = 4;
    const Z = 4;
    sim.world.setCell(X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.PLANKS_OAK, EAST)));
    sim.players.get('p')!.teleport(X - 1.5, T, Z + 0.5);
    sim.players.get('b')!.teleport(X + 2.5, T, Z + 0.5);
    h.run(1000);
    h.track(a);
    h.track(b);
    const log = breaks(sim);
    const planks0 = owned(sim, B.PLANKS_OAK, ['p', 'b']); // the starter kits
    // The west half from the west (octant 0, its -X face), the east half from the east (octant 1).
    press(a, X, T, Z, NX, 0);
    press(b, X, T, Z, PX, 1);
    h.runUntil(() => getPacked(sim.world, X, T, Z) === 0, 20_000);
    release(a);
    release(b);
    expect(log).toHaveLength(2);
    expect(log[0]!.tick).toBe(log[1]!.tick);
    expect(log.map((e) => e.part).sort()).toEqual([slab(B.PLANKS_OAK, WEST), slab(B.PLANKS_OAK, EAST)].sort());
    h.run(3000);
    expect(owned(sim, B.PLANKS_OAK, ['p', 'b']) - planks0).toBe(2);
    h.quiesce();
    expect(a.mismatches).toEqual([]);
    expect(b.mismatches).toEqual([]);
    expect(h.compareNow(a)).toEqual([]);
    expect(h.compareNow(b)).toEqual([]);
  }, 120_000);

  // Two ways the part under the guest's pick changes: the host chisels an octant off it (same
  // material: the claimed target still names planks, so only the progress rule of 6.2 resets the
  // mining), or replaces it with stone (the claimed target names another material: the server's
  // check of the claim drops it, 19.11). On the two lossy links of the end-to-end tests.
  describe.each(LINKS.slice(1))('a guest over $name', ({ make }) => {
    for (const [name, replaced, id, drop] of [
      ['chisels an octant off that half', canonCell(slab(B.PLANKS_OAK, WEST & ~0x40), slab(B.STONE, EAST)), B.PLANKS_OAK, B.PLANKS_OAK],
      ['replaces that half with stone', canonCell(slab(B.STONE, WEST), slab(B.STONE, EAST)), B.STONE, B.COBBLE],
    ] as const) {
      it(`mines the planks half while the host ${name}: no progress carries over; the new part takes its full time and drops its own item`, async () => {
        const r = await ownWorld(LAND, 'survival', {});
        const { h, sim } = r;
        await h.host.control({ type: 'openRoom' });
        const host = r.c;
        const g = h.addClient('g', make(81), { viewRadius: 3 });
        h.runUntil(() => g.ready && g.intents !== null, 60_000);
        const X = 4;
        const Z = 4;
        sim.players.get('g')!.teleport(X - 1.5, T, Z + 0.5);
        sim.players.get('p')!.teleport(X + 2.5, T, Z + 6.5);
        h.run(1500);
        h.track(host);
        h.track(g);
        const log = breaks(sim);
        const mining = miningOf(sim, 'g');
        // Control: the guest's mining speed on the new part's material, a west half on its own
        // (another cell), read on the server (progress per tick), so that the link's delay and
        // losses do not enter it.
        sim.world.setCell(X, T, Z - 1, slab(id, WEST));
        seen(h, g, X, T, Z - 1, slab(id, WEST));
        press(g, X, T, Z - 1, NX, 0);
        runWatching(h, mining, () => getPacked(sim.world, X, T, Z - 1) === 0, 60_000);
        release(g);
        const rate = mining.rate();
        expect(rate).toBeGreaterThan(0);
        const fullTicks = Math.ceil(1 / rate);
        expect(fullTicks).toBeGreaterThan(20);
        h.run(1500);
        // The race: planks west, stone east.
        const owned0 = owned(sim, drop, ['p', 'g']); // the starter kits and the control's drop
        sim.world.setCell(X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
        seen(h, g, X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
        mining.clear();
        press(g, X, T, Z, NX, 0);
        // About a third of the way through mining the planks half, the host changes it.
        runWatching(h, mining, () => (sim.players.get('g')!.view.mining?.progress ?? 0) >= 0.3, 30_000);
        const before = sim.players.get('g')!.view.mining!.progress;
        const replacedAt = sim.ticks;
        host.hostCommand({ kind: 'setCell', gridId: 0, x: X, y: T, z: Z, cell: replaced });
        runWatching(h, mining, () => log.length === 2, 60_000);
        release(g);
        const broke = log[1]!;
        expect(broke.part & 0x3ff).toBe(id);
        // The progress started again from nothing on the new part, and it took (about) its full time.
        const after = mining.samples.filter((m) => m.tick > replacedAt && m.tick < broke.tick && m.progress !== null);
        expect(after.length).toBeGreaterThan(0);
        expect(Math.min(...after.map((m) => m.progress!)), `progress was ${before.toFixed(2)} when the part changed`).toBeLessThanOrEqual(2 * rate + 1e-9);
        expect(broke.tick - replacedAt, 'the new part took (about) its full time').toBeGreaterThanOrEqual(fullTicks - 2);
        expect(getPacked(sim.world, X, T, Z)).toBe(slab(B.STONE, EAST));
        h.run(3000);
        expect(owned(sim, drop, ['p', 'g']) - owned0).toBe(1);
        h.quiesce();
        expect(host.mismatches).toEqual([]);
        expect(g.mismatches).toEqual([]);
        expect(h.compareNow(host)).toEqual([]);
        expect(h.compareNow(g)).toEqual([]);
      }, 180_000);
    }

    // The mirror case of 6.2: the OTHER part of the cell goes (the host mines it) while the guest
    // mines its own. The guest's claimed target still carries the cell as it was; the part it names
    // is unchanged, so neither the claim check nor the progress rule may reset the guest's mining.
    it('mines the stone half while the host mines the planks half of the same cell: the guest\'s mining goes on, it is not reset', async () => {
      const r = await ownWorld(LAND, 'survival', {});
      const { h, sim } = r;
      await h.host.control({ type: 'openRoom' });
      const host = r.c;
      const g = h.addClient('g', make(83), { viewRadius: 3 });
      h.runUntil(() => g.ready && g.intents !== null, 60_000);
      const X = 4;
      const Z = 4;
      sim.players.get('g')!.teleport(X + 2.5, T, Z + 0.5); // east of the cell: the stone half
      sim.players.get('p')!.teleport(X - 1.5, T, Z + 0.5); // west of it: the planks half
      h.run(1500);
      h.track(host);
      h.track(g);
      const log = breaks(sim);
      const mining = miningOf(sim, 'g');
      sim.world.setCell(X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
      seen(h, host, X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
      seen(h, g, X, T, Z, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
      // The host starts on the planks half; once it is a third of the way, the guest starts on the
      // stone half, so the planks half breaks while the guest is well into its own.
      press(host, X, T, Z, NX, 0);
      h.runUntil(() => (sim.players.get('p')!.view.mining?.progress ?? 0) >= 0.3, 30_000);
      press(g, X, T, Z, PX, 1);
      runWatching(h, mining, () => log.length >= 1, 60_000);
      release(host);
      const first = log[0]!;
      expect(first.part).toBe(slab(B.PLANKS_OAK, WEST));
      runWatching(h, mining, () => log.length >= 2, 60_000);
      release(g);
      const second = log[1]!;
      expect(second.part).toBe(slab(B.STONE, EAST));
      // The guest had made real progress when the other half went, and it never went back.
      const on = mining.samples.filter((m) => m.tick < second.tick && m.progress !== null);
      const at = on.filter((m) => m.tick <= first.tick);
      expect(at.length, 'the guest was mining when the planks half broke').toBeGreaterThan(0);
      const progressAtBreak = at[at.length - 1]!.progress!;
      expect(progressAtBreak).toBeGreaterThan(0.15);
      for (let i = 1; i < on.length; i++) expect(on[i]!.progress!, `tick ${on[i]!.tick}`).toBeGreaterThanOrEqual(on[i - 1]!.progress!);
      expect(mining.samples.some((m) => m.tick > first.tick && m.tick < second.tick && m.progress === null), 'the mining stopped in between').toBe(false);
      // So the rest took the remaining fraction of the stone's time, not a full one.
      const rate = mining.rate();
      expect(second.tick - first.tick).toBeLessThanOrEqual(Math.ceil((1 - progressAtBreak) / rate) + 2);
      expect(getPacked(sim.world, X, T, Z)).toBe(0);
      h.run(3000);
      h.quiesce();
      expect(host.mismatches).toEqual([]);
      expect(g.mismatches).toEqual([]);
      expect(h.compareNow(host)).toEqual([]);
      expect(h.compareNow(g)).toEqual([]);
    }, 180_000);
  });
});
