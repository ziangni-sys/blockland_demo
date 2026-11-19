/**
 * Several players in one headless Simulation (M2.1 package 1): the registry (join / leave /
 * rejoin), per-player hands and views, addressed events, world rules versus per-player modes,
 * pickups, rabbits and chunk anchors around every player, saving offline players, determinism.
 */
import { describe, expect, it, vi } from 'vitest';
import { facingState, makeCell } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { isCellFace } from '../../src/blocks/shapes';
import { I } from '../../src/blocks/items';
import { BLOCKS } from '../../src/blocks/registry';
import { CHUNK_SHIFT } from '../../src/core/constants';
import { NY, NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { vec3 } from '../../src/core/math';
import { CRUSH_DAMAGE, PLAYER_MAX_HEALTH, RABBIT_CRUSH_LIMIT } from '../../src/entities/constants';
import { ItemEntity, Player, type Rabbit } from '../../src/entities/entity';
import type { EntityEvent } from '../../src/entities/host';
import { dropItemOf } from '../../src/sim/drops';
import { explode } from '../../src/sim/explosion';
import { exportSave, importSave } from '../../src/sim/persist';
import { MAX_VIEW_RADIUS, type PlayerControl } from '../../src/sim/players';
import { RABBIT_CAP, RABBIT_DESPAWN_DISTANCE } from '../../src/sim/rabbits';
import { Simulation, type GameMode } from '../../src/sim/simulation';
import { eventPlayer, type SimEvent } from '../../src/sim/view';
import { worldRulesFor } from '../../src/sim/rules';
import type { Rotor, Ship } from '../../src/structures/structure';
import { EventLog, FLAT_TOP, SEA_TOP, fill, flatOpts, idAt, seaOpts, type WorldOpts } from './helpers';

const T = FLAT_TOP;

/** A world (flat by default) with the given players joined in this order. */
function world(keys: readonly string[], o: WorldOpts = {}, sea = false): { sim: Simulation; ps: PlayerControl[] } {
  const sim = new Simulation(sea ? seaOpts(o) : flatOpts(o));
  return { sim, ps: keys.map((k) => sim.join(k)) };
}

/** Live item drops of `item` within `r` blocks (horizontally) of (x, z). */
function dropsNear(sim: Simulation, x: number, z: number, r: number, item?: number): number {
  let n = 0;
  for (const e of sim.entities.all()) {
    if (e.removed || !(e instanceof ItemEntity)) continue;
    if (item !== undefined && e.stack.item !== item) continue;
    if (Math.hypot(e.pos.x - x, e.pos.z - z) <= r) n += e.stack.count;
  }
  return n;
}

function aimMine(c: PlayerControl, x: number, y: number, z: number, face: Dir): void {
  c.lookAtCell(x, y, z, face);
  expect(c.mineTargetCell()).toEqual({ gridId: 0, x, y, z, face, octant: expect.any(Number) });
  expect(isCellFace(c.mineTargetCell()!.octant, face), 'the octant hit lies behind the face entered').toBe(true);
}

function rabbits(sim: Simulation): Rabbit[] {
  return sim.entities.all().filter((e): e is Rabbit => e.kind === 'rabbit' && !e.removed);
}

/** Records the entities module's crush events (no SimEvent exists for a crush). */
function watchCrushes(sim: Simulation): EntityEvent[] {
  const list: EntityEvent[] = [];
  const it = sim.interaction;
  const orig = it.onEntityEvent.bind(it);
  vi.spyOn(it, 'onEntityEvent').mockImplementation((ev: EntityEvent) => {
    if (ev.type === 'crush') list.push(ev);
    orig(ev);
  });
  return list;
}

// =====================================================================================

describe('player registry', () => {
  it('a world starts empty; join spawns a new player at the world spawn in the default mode', () => {
    const sim = new Simulation(flatOpts({ mode: 'survival', spawn: { x: 3.5, y: T, z: -2.5 } }));
    expect(sim.players.online()).toEqual([]);
    expect(sim.entities.all().length).toBe(0);
    const a = sim.join('alice');
    expect(a.player.mode).toBe('survival');
    expect(a.player.pos).toEqual({ x: 3.5, y: T, z: -2.5 });
    expect(a.player.spawn).toEqual({ x: 3.5, y: T, z: -2.5 });
    expect(a.player.inventory.count(B.STONE)).toBe(0);
    expect(sim.world.isLoaded(3, -3)).toBe(true); // the ground under the new player
    expect(() => sim.join('alice')).toThrow(/already joined/);
    expect(() => sim.leave('bob')).toThrow(/not joined/);
    expect(() => sim.join('')).toThrow(RangeError);
  });

  it('leave keeps the record; a later join restores position, look, inventory with the off-hand, health, air, mode, spawn and the entity id', () => {
    const { sim, ps } = world(['alice', 'bob'], { mode: 'survival' });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    a.teleport(5.5, T, 3.5);
    b.teleport(-6.5, T, 0.5);
    sim.advance(5);
    a.hold(I.GLUE, 6);
    a.swapHands();
    sim.tick();
    a.hold(B.PLANKS_OAK, 20);
    a.giveItem(B.COBBLE, 40);
    a.lookAt(9, T + 3, -4);
    sim.tick();
    const p = a.player;
    p.health = 13;
    p.air = 120;
    p.spawn.x = 7.5;
    a.setMode('creative');
    const id = p.id;
    const snap = {
      pos: { ...p.pos },
      yaw: p.yaw,
      pitch: p.pitch,
      hotbar: structuredClone(p.inventory.hotbar),
      main: structuredClone(p.inventory.main),
      offhand: structuredClone(p.inventory.offhand),
      selected: p.inventory.selected,
      health: p.health,
      air: p.air,
      mode: p.mode,
      spawn: { ...p.spawn },
    };
    expect(snap.offhand).toEqual({ item: I.GLUE, count: 6 });

    sim.leave('alice');
    expect(a.online).toBe(false);
    expect(() => a.player).toThrow(/has left/);
    expect(() => a.use()).toThrow(/has left/);
    expect(sim.players.online().map((c) => c.key)).toEqual(['bob']);
    expect(sim.players.keys()).toEqual(['alice', 'bob']);
    expect(sim.entities.all().filter((e) => e instanceof Player)).toEqual([b.player]);
    sim.advance(30); // the world goes on without her

    const a2 = sim.join('alice');
    expect(a2).not.toBe(a);
    const q = a2.player;
    expect(q.id).toBe(id);
    expect({
      pos: { ...q.pos },
      yaw: q.yaw,
      pitch: q.pitch,
      hotbar: q.inventory.hotbar,
      main: q.inventory.main,
      offhand: q.inventory.offhand,
      selected: q.inventory.selected,
      health: q.health,
      air: q.air,
      mode: q.mode,
      spawn: { ...q.spawn },
    }).toEqual(snap);
    expect(q.input.yaw).toBe(snap.yaw); // the look is seeded, not snapped to 0
    // Order of first join: alice (id 1) acts before bob again.
    expect(sim.players.online().map((c) => c.key)).toEqual(['alice', 'bob']);
    expect(sim.entities.all().filter((e) => e instanceof Player)).toEqual([q, b.player]);
    // A new key starts fresh, after both.
    const c = sim.join('carol');
    expect(c.player.id).toBeGreaterThan(b.player.id);
    expect(c.player.mode).toBe('survival');
    expect(c.player.inventory.count(B.COBBLE)).toBe(0);
  });

  it('leaving at the wheel lets go (addressed event); the record keeps the carrier: a rejoin is back aboard, not at the wheel', () => {
    const { sim, ps } = world(['a', 'b'], { spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }, true);
    const [a] = ps as [PlayerControl, PlayerControl];
    raft(sim, 0);
    sim.advance(2);
    a.lookAtCell(2, SEA_TOP, 4, PZ);
    a.use();
    sim.tick();
    a.use();
    sim.tick();
    const ship = sim.structures.ships()[0]!;
    expect(a.player.steeringShipId).toBe(ship.id);
    const log = new EventLog(sim);
    sim.leave('a');
    expect(log.of('helmReleased')).toEqual([{ type: 'helmReleased', player: 'a', cause: 'removed' }]);
    expect(ship.helmsmanId).toBe(0);
    const back = sim.join('a').player;
    expect(back.steeringShipId).toBe(0);
    expect(back.carrierId).toBe(ship.id);
  });
});

// =====================================================================================

describe('per-player hands', () => {
  it('two players mine different blocks in the same ticks, each with their own progress and drop', () => {
    const { sim, ps } = world(['a', 'b'], { mode: 'survival' });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    a.teleport(0.5, T, 0.5);
    b.teleport(8.5, T, 0.5);
    sim.advance(3);
    for (const c of [a, b]) c.emptyHand();
    aimMine(a, 0, T - 1, -2, PY);
    aimMine(b, 8, T - 1, -2, PY);
    for (const c of [a, b]) {
      c.attack();
      c.player.input.attack = true;
    }
    const hardness = BLOCKS[B.TURF]!.hardness;
    let ticks = 0;
    while (idAt(sim.world, 0, T - 1, -2) === B.TURF && ticks < 400) {
      sim.tick();
      ticks++;
      if (idAt(sim.world, 0, T - 1, -2) === B.TURF) {
        // Both crack at the same pace, each on its own block.
        expect(a.view.mining!.progress).toBeGreaterThan(0);
        expect(b.view.mining!.progress).toBe(a.view.mining!.progress);
        expect(a.view.target).toMatchObject({ x: 0, z: -2 });
        expect(b.view.target).toMatchObject({ x: 8, z: -2 });
      }
    }
    // Broken in the same tick.
    expect(idAt(sim.world, 0, T - 1, -2)).toBe(B.AIR);
    expect(idAt(sim.world, 8, T - 1, -2)).toBe(B.AIR);
    expect(ticks).toBe(Math.ceil(hardness / 0.05 - 1e-9));
    for (const c of [a, b]) c.player.input.attack = false;
    sim.advance(40);
    // each block dropped its own item (in the hole in front of each player)
    const item = dropItemOf(makeCell(B.TURF));
    expect(dropsNear(sim, 0.5, -1.5, 1.5, item) + a.player.inventory.count(item)).toBe(1);
    expect(dropsNear(sim, 8.5, -1.5, 1.5, item) + b.player.inventory.count(item)).toBe(1);
  });

  it('two players preview different helms at once; a world change makes both previews stale; the second assembly in a tick sees the first', () => {
    const { sim, ps } = world(['a', 'b'], { spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }, true);
    const [a, b] = ps as [PlayerControl, PlayerControl];
    raft(sim, 0);
    raft(sim, 20);
    b.teleport(22.5, SEA_TOP, 7.5);
    sim.advance(3);
    const log = new EventLog(sim);
    const aimBoth = (): void => {
      a.lookAtCell(2, SEA_TOP, 4, PZ);
      b.lookAtCell(22, SEA_TOP, 4, PZ);
    };
    aimBoth();
    a.use();
    b.use();
    sim.tick();
    const xs = (c: PlayerControl): number[] => {
      const cells = c.view.preview!.cells;
      const out: number[] = [];
      for (let i = 0; i < cells.length; i += 3) out.push(cells[i]!);
      return out;
    };
    expect(a.view.preview?.kind).toBe('ship');
    expect(b.view.preview?.kind).toBe('ship');
    expect(xs(a).every((x) => x >= 0 && x <= 4)).toBe(true);
    expect(xs(b).every((x) => x >= 20 && x <= 24)).toBe(true);
    expect(a.view.hint?.key).toBe('hint.helm.assemble');
    expect(b.view.hint?.key).toBe('hint.helm.assemble');

    // Any block change marks every preview stale.
    sim.world.setCell(10, SEA_TOP + 3, 30, makeCell(B.STONE));
    sim.tick();
    expect(a.view.preview).toBeNull();
    expect(b.view.preview).toBeNull();

    // Preview again, then both confirm in the same tick: a (lower id) assembles; b's preview was
    // made stale by a's assembly, so b's click previews again instead.
    aimBoth();
    a.use();
    b.use();
    sim.tick();
    aimBoth();
    a.use();
    b.use();
    sim.tick();
    expect(sim.structures.ships().length).toBe(1);
    expect(a.player.steeringShipId).toBe(sim.structures.ships()[0]!.id);
    expect(b.view.preview?.kind).toBe('ship');
    b.lookAtCell(22, SEA_TOP, 4, PZ);
    b.use();
    sim.tick();
    const ships = sim.structures.ships();
    expect(ships.length).toBe(2);
    expect(b.player.steeringShipId).not.toBe(0);
    expect(b.player.steeringShipId).not.toBe(a.player.steeringShipId);
    for (const s of ships) expect([a.player.id, b.player.id]).toContain(s.helmsmanId);
    const assembled = log.of('toast').filter((t) => t.message.key === 'toast.ship.assembled');
    expect(assembled.map((t) => t.player)).toEqual(['a', 'b']);
  });

  it('two players placing onto the same face in one tick: the lower id places first, the second acts on the world it left', () => {
    const run = (order: readonly string[]): { id: number; second: number } => {
      const { sim } = world(order, { mode: 'survival' });
      const a = sim.players.get('a')!;
      const b = sim.players.get('b')!;
      a.teleport(0.5, T, 1.5);
      b.teleport(1.5, T, 1.5);
      sim.advance(3);
      sim.world.setCell(0, T, -2, makeCell(B.STONE));
      a.hold(B.PLANKS_OAK, 5);
      b.hold(B.COBBLE, 5);
      a.lookAtCell(0, T, -2, PY);
      b.lookAtCell(0, T, -2, PY);
      a.use();
      b.use();
      sim.tick();
      // The second player's ray, cast in its own turn, meets the first player's new block and
      // puts its block against that one instead (somewhere else, never into the same cell).
      const id = idAt(sim.world, 0, T + 1, -2);
      const other = id === B.PLANKS_OAK ? B.COBBLE : B.PLANKS_OAK;
      let second = 0;
      for (let y = T; y <= T + 3; y++) for (let z = -4; z <= 0; z++) for (let x = -2; x <= 2; x++) if (idAt(sim.world, x, y, z) === other) second++;
      return { id, second };
    };
    expect(run(['a', 'b'])).toEqual({ id: B.PLANKS_OAK, second: 1 });
    expect(run(['b', 'a'])).toEqual({ id: B.COBBLE, second: 1 });
  });
});

// =====================================================================================

describe('ships with several players', () => {
  it('one steers, a second walks on the deck and is carried, a third on the shore stays put', () => {
    const { sim, ps } = world(['helmsman', 'deckhand', 'shore'], { spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }, true);
    const [h, d, s] = ps as [PlayerControl, PlayerControl, PlayerControl];
    raft(sim, 0);
    s.teleport(3.5, SEA_TOP, 7.5);
    sim.advance(3);
    h.lookAtCell(2, SEA_TOP, 4, PZ);
    h.use();
    sim.tick();
    h.use();
    sim.tick();
    const ship = sim.structures.ships()[0] as Ship;
    expect(h.player.steeringShipId).toBe(ship.id);
    d.teleport(1.5, SEA_TOP, 1.5);
    sim.advance(5);
    expect(d.player.carrierId).toBe(ship.id);
    const ship0 = { ...ship.grid.position };
    const d0 = { ...d.player.pos };
    const s0 = { ...s.player.pos };
    h.player.input.forward = 1;
    d.player.input.forward = 0;
    sim.advance(80);
    const moved = ship0.z - ship.grid.position.z;
    expect(moved).toBeGreaterThan(1);
    expect(h.helmView()?.throttle).toBe(1);
    expect(d.helmView()).toBeNull();
    // carried along with the deck
    expect(d.player.carrierId).toBe(ship.id);
    expect(d0.z - d.player.pos.z).toBeCloseTo(moved, 0);
    expect(Math.abs(d.player.pos.x - d0.x)).toBeLessThan(0.3);
    // the shore does not move
    expect(s.player.carrierId).toBe(0);
    expect(s.player.pos.x).toBeCloseTo(s0.x, 6);
    expect(s.player.pos.z).toBeCloseTo(s0.z, 6);
  });
});

// =====================================================================================

describe('pickups with several players', () => {
  function scene(order: readonly string[], itemX: number): { sim: Simulation; a: PlayerControl; b: PlayerControl; log: EventLog } {
    const { sim } = world(order);
    const a = sim.players.get('a')!;
    const b = sim.players.get('b')!;
    a.teleport(0.5, T, 0.5);
    b.teleport(2.5, T, 0.5);
    sim.advance(3);
    const log = new EventLog(sim);
    const e = sim.entities.spawnItem(itemX, T + 0.2, 0.5, B.STONE, 5, vec3());
    e.pickupDelay = 0;
    return { sim, a, b, log };
  }

  it('a drop both can reach goes to the nearer player', () => {
    const { sim, a, b, log } = scene(['a', 'b'], 1.3);
    sim.tick();
    expect(a.player.inventory.count(B.STONE)).toBe(5);
    expect(b.player.inventory.count(B.STONE)).toBe(0);
    expect(log.of('playerPickup')).toEqual([{ type: 'playerPickup', player: 'a', item: B.STONE, count: 5 }]);
    const near = scene(['a', 'b'], 1.7);
    near.sim.tick();
    expect(near.b.player.inventory.count(B.STONE)).toBe(5);
  });

  it('an exact tie goes to the lower entity id (the player who joined the world first)', () => {
    const first = scene(['a', 'b'], 1.5);
    first.sim.tick();
    expect(first.a.player.inventory.count(B.STONE)).toBe(5);
    const flipped = scene(['b', 'a'], 1.5);
    flipped.sim.tick();
    expect(flipped.b.player.inventory.count(B.STONE)).toBe(5);
  });

  it('what does not fit into the nearer player goes to the next one', () => {
    const { sim, a, b } = scene(['a', 'b'], 1.3);
    a.giveItem(B.DIRT, 64 * 36);
    a.player.inventory.offhand = { item: B.DIRT, count: 64 };
    sim.tick();
    expect(a.player.inventory.count(B.STONE)).toBe(0);
    expect(b.player.inventory.count(B.STONE)).toBe(5);
  });
});

// =====================================================================================

describe('rabbits and chunks around every player', () => {
  it('rabbits spawn around two distant players and vanish only when far from every player', () => {
    const { sim, ps } = world(['a', 'b'], { rabbits: true, loadRadius: 3, seed: 31 });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    b.teleport(300.5, T, 0.5);
    sim.advance(800);
    const near = (c: PlayerControl): Rabbit[] =>
      rabbits(sim).filter((r) => Math.hypot(r.pos.x - c.player.pos.x, r.pos.z - c.player.pos.z) <= RABBIT_DESPAWN_DISTANCE);
    expect(near(a).length).toBeGreaterThan(0);
    expect(near(b).length).toBeGreaterThan(0);
    expect(near(a).length).toBeLessThanOrEqual(RABBIT_CAP);
    expect(near(b).length).toBeLessThanOrEqual(RABBIT_CAP);
    expect(near(a).length + near(b).length).toBe(rabbits(sim).length);
    const aroundA = near(a);
    sim.rabbits.enabled = false;
    sim.leave('b');
    sim.advance(80);
    // b's rabbits are gone; a's are still there.
    for (const r of rabbits(sim)) expect(Math.hypot(r.pos.x - a.player.pos.x, r.pos.z - a.player.pos.z)).toBeLessThanOrEqual(RABBIT_DESPAWN_DISTANCE + 10);
    expect(rabbits(sim).filter((r) => aroundA.includes(r)).length).toBeGreaterThan(0);
  });

  it('chunks load around two distant players, each with its own view radius, and unload when one leaves', () => {
    const { sim, ps } = world(['a', 'b'], { loadRadius: 2 });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    b.teleport(400.5, T, 0.5);
    b.viewRadius = 3;
    sim.advance(40);
    const loadedAround = (x: number, z: number, r: number): boolean => {
      const cx = Math.floor(x) >> CHUNK_SHIFT;
      const cz = Math.floor(z) >> CHUNK_SHIFT;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r + r && !sim.world.getChunk(cx + dx, cz + dz)) return false;
      return true;
    };
    expect(loadedAround(a.player.pos.x, a.player.pos.z, 2)).toBe(true);
    expect(loadedAround(b.player.pos.x, b.player.pos.z, 3)).toBe(true);
    expect(loadedAround(a.player.pos.x, a.player.pos.z, 3)).toBe(false); // a's own radius is 2
    expect(b.player.onGround).toBe(true);
    b.viewRadius = 1000;
    expect(b.viewRadius).toBe(MAX_VIEW_RADIUS);
    b.viewRadius = 3;
    sim.leave('b');
    sim.advance(300);
    for (const c of sim.world.chunks.values()) expect(Math.abs(c.cx)).toBeLessThanOrEqual(2 + sim.chunks.unloadMargin);
    expect(loadedAround(a.player.pos.x, a.player.pos.z, 2)).toBe(true);
  });
});

// =====================================================================================

describe('addressed events', () => {
  it('a toast and a hurt reach only their player; world events name nobody', () => {
    const { sim, ps } = world(['a', 'b'], { mode: 'survival' });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    a.setMode('creative');
    a.teleport(0.5, T, 0.5);
    sim.advance(3);
    const log = new EventLog(sim);
    sim.world.setCell(0, T, -2, makeCell(B.STONE));
    a.hold(I.GLUE, 4);
    expect(a.useOn(0, T, -2, PZ)).toBe(true);
    b.teleport(10.5, T + 10, 0.5);
    a.teleport(-10.5, T + 10, 0.5);
    sim.advance(40);
    const toasts = log.of('toast');
    expect(toasts.map((t) => [t.player, t.message.key])).toEqual([['a', 'toast.glue.added']]);
    const hurts = log.of('playerHurt');
    expect(hurts.length).toBe(1);
    expect(hurts[0]).toMatchObject({ player: 'b', cause: 'fall' });
    expect(b.player.health).toBeLessThan(PLAYER_MAX_HEALTH);
    expect(a.player.health).toBe(PLAYER_MAX_HEALTH);
    for (const ev of log.list) {
      if (ev.type === 'sound' || ev.type === 'blockPlaced' || ev.type === 'blockBroken') expect(eventPlayer(ev)).toBeNull();
    }
    expect(eventPlayer(toasts[0]!)).toBe('a');
  });

  it('death is addressed to the player who died', () => {
    const { sim, ps } = world(['a', 'b'], { mode: 'survival' });
    const [, b] = ps as [PlayerControl, PlayerControl];
    const log = new EventLog(sim);
    sim.entities.kill(b.player, 'test');
    expect(log.of('playerDied')).toEqual([{ type: 'playerDied', player: 'b', cause: 'test' }]);
  });
});

// =====================================================================================

describe('world rules and per-player modes', () => {
  it('mining drops follow the mining player: a creative and a survival player in one world', () => {
    for (const mode of ['survival', 'creative'] as const) {
      const { sim, ps } = world(['c', 's'], { mode });
      const [c, s] = ps as [PlayerControl, PlayerControl];
      c.setMode('creative');
      s.setMode('survival');
      c.teleport(0.5, T, 0.5);
      s.teleport(8.5, T, 0.5);
      sim.advance(3);
      c.emptyHand();
      s.emptyHand();
      // keep both out of pickup reach of their own drop: mine two blocks ahead
      expect(c.mine(0, T - 1, -3, PY)).toBe(true);
      expect(s.mine(8, T - 1, -3, PY)).toBe(true);
      expect(dropsNear(sim, 0.5, -2.5, 2)).toBe(0);
      expect(dropsNear(sim, 8.5, -2.5, 2)).toBe(1);
    }
  });

  it('damage follows the hurt player: one blast hurts the survival player only; rabbits are hurt only in a survival world', () => {
    for (const mode of ['survival', 'creative'] as const) {
      const { sim, ps } = world(['c', 's'], { mode, seed: 5 });
      const [c, s] = ps as [PlayerControl, PlayerControl];
      c.setMode('creative');
      s.setMode('survival');
      c.teleport(-2.5, T, 0.5);
      s.teleport(3.5, T, 0.5);
      sim.advance(3);
      const rabbit = sim.entities.spawnRabbit(0.5, T, 3.5);
      explode(sim, 0.5, T + 0.5, 0.5, 3, null);
      expect(c.player.health).toBe(PLAYER_MAX_HEALTH);
      expect(s.player.health).toBeLessThan(PLAYER_MAX_HEALTH);
      expect(rabbit.removed).toBe(mode === 'survival');
    }
  });

  it('a blade crushes a caged survival player (damage) and a caged creative player (moved only) in the same world', () => {
    const { sim, ps } = world(['c', 's'], { mode: 'creative', spawn: { x: 0.5, y: T, z: 3.5 } });
    const [c, s] = ps as [PlayerControl, PlayerControl];
    c.setMode('creative');
    s.setMode('survival');
    s.teleport(0.5, T, -2.5);
    landPaddle(sim);
    sim.advance(2);
    startRotor(sim, c, [0, T + 2, 0], PZ);
    cage(sim, 3);
    cage(sim, -3);
    const events: SimEvent[] = [];
    sim.events.on((e) => events.push(e));
    const crushes = watchCrushes(sim);
    const before = { c: { ...c.player.pos }, s: { ...s.player.pos } };
    for (let i = 0; i < 400 && new Set(crushes.map((e) => e.entity)).size < 2; i++) sim.tick();
    const crushed = new Set(crushes.map((e) => e.entity));
    expect(crushed.has(c.player)).toBe(true);
    expect(crushed.has(s.player)).toBe(true);
    expect(c.player.health).toBe(PLAYER_MAX_HEALTH);
    expect(s.player.health).toBe(PLAYER_MAX_HEALTH - CRUSH_DAMAGE);
    expect(Math.hypot(c.player.pos.x - before.c.x, c.player.pos.z - before.c.z)).toBeGreaterThan(0.5);
    expect(events.filter((e) => e.type === 'playerHurt')).toEqual([{ type: 'playerHurt', player: 's', amount: CRUSH_DAMAGE, cause: 'crush' }]);
  });

  it('the rabbit crush limit follows the world, not the players in it', () => {
    const run = (worldMode: GameMode, playerMode: GameMode): { crushes: number; removed: boolean } => {
      const { sim, ps } = world(['p', 'q'], { mode: worldMode, spawn: { x: 0.5, y: T + 4, z: 1.6 } });
      const [p, q] = ps as [PlayerControl, PlayerControl];
      p.setMode(playerMode);
      q.setMode(playerMode);
      q.teleport(10.5, T, -10.5);
      landPaddle(sim);
      fill(sim.world, -4, T, 1, 4, T + 3, 7, B.STONE);
      fill(sim.world, -1, T, 4, 1, T, 4, 0);
      sim.advance(2);
      const rabbit = sim.entities.spawnRabbit(1.5, T, 4.5);
      const crushes = watchCrushes(sim);
      startRotor(sim, p, [0, T + 2, 0], PY);
      for (let i = 0; i < 900 && !rabbit.removed; i++) sim.tick();
      return { crushes: crushes.filter((e) => e.entity === rabbit).length, removed: rabbit.removed };
    };
    const creativeWorld = run('creative', 'survival');
    expect(creativeWorld.crushes).toBeGreaterThan(RABBIT_CRUSH_LIMIT);
    expect(creativeWorld.removed).toBe(false);
    const survivalWorld = run('survival', 'creative');
    expect(survivalWorld.removed).toBe(true);
    expect(survivalWorld.crushes).toBe(RABBIT_CRUSH_LIMIT);
  });

  it('a new world created as survival drops, one created as creative does not', () => {
    expect(new Simulation(flatOpts({ mode: 'survival' })).rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(new Simulation(flatOpts({ mode: 'creative' })).rules).toEqual({ defaultMode: 'creative', dropsEnabled: false });
  });

  it('blockify drops follow dropsEnabled, whatever mode the player who stops the windmill is in', () => {
    for (const [drops, mode] of [
      [true, 'creative'],
      [false, 'survival'],
    ] as const) {
      const { sim, ps } = world(['p', 'other'], { mode: drops ? 'creative' : 'survival', spawn: { x: 2.5, y: T, z: -1.5 } });
      sim.rules.dropsEnabled = drops;
      const [p] = ps as [PlayerControl, PlayerControl];
      p.setMode(mode);
      sim.players.get('other')!.teleport(-20.5, T, -20.5);
      const Y = T + 4;
      const Z = -4;
      fill(sim.world, -1, T, Z, -1, Y, Z, B.STONE_BRICKS);
      sim.world.setCell(0, Y, Z, makeCell(B.BEARING, facingState(PX)));
      for (const dy of [0, 1, 2, -1]) sim.world.setCell(1, Y + dy, Z, makeCell(B.CANVAS));
      sim.advance(2);
      p.emptyHand();
      const rotor = startRotor(sim, p, [0, Y, Z], PZ);
      for (let i = 0; i < 2000 && !(rotor.angle >= Math.PI - 0.25 && rotor.angle < Math.PI - 0.15); i++) sim.tick();
      sim.world.setCell(1, Y - 2, Z, makeCell(B.STONE)); // the tip of the up arm lands in it
      sim.tick();
      expect(p.useOn(0, Y, Z, PZ)).toBe(true);
      expect(rotor.removed).toBe(true);
      expect(dropsNear(sim, 1.5, Z + 0.5, 4, B.CANVAS)).toBe(drops ? 1 : 0);
    }
  });

  it('explosion and popped-off drops follow dropsEnabled; a survival miner still gets the block, not the torch on it, in a creative world', () => {
    for (const drops of [true, false]) {
      const { sim, ps } = world(['s'], { mode: drops ? 'survival' : 'creative', seed: 9 });
      const [s] = ps as [PlayerControl];
      s.setMode('survival');
      s.teleport(30.5, T, 30.5);
      sim.advance(3);
      explode(sim, 0.5, T - 2.5, 0.5, 4, null);
      expect(dropsNear(sim, 0.5, 0.5, 12) > 0).toBe(drops);
    }
    const { sim, ps } = world(['s'], { mode: 'creative' });
    const [s] = ps as [PlayerControl];
    s.setMode('survival');
    s.teleport(0.5, T, 0.5);
    sim.advance(3);
    sim.world.setCell(0, T, -3, makeCell(B.STONE));
    sim.world.setCell(0, T + 1, -3, makeCell(B.TORCH));
    s.emptyHand();
    expect(s.mine(0, T, -3, PZ)).toBe(true);
    sim.advance(3);
    expect(idAt(sim.world, 0, T + 1, -3)).toBe(B.AIR); // the torch popped off
    expect(dropsNear(sim, 0.5, -2.5, 3, B.TORCH) + s.player.inventory.count(B.TORCH)).toBe(0);
    expect(dropsNear(sim, 0.5, -2.5, 3, dropItemOf(makeCell(B.STONE))) + s.player.inventory.count(dropItemOf(makeCell(B.STONE)))).toBe(1);
  });
});

// =====================================================================================

describe('changing the world rules', () => {
  it('setRules switches world drops and creature harm from then on; players keep their modes', () => {
    const { sim, ps } = world(['s'], { mode: 'creative' });
    const [s] = ps as [PlayerControl];
    s.setMode('survival');
    s.teleport(30.5, T, 30.5);
    sim.advance(3);
    explode(sim, 0.5, T - 2.5, 0.5, 4, null);
    expect(dropsNear(sim, 0.5, 0.5, 12)).toBe(0);
    sim.setRules(worldRulesFor('survival'));
    expect(sim.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(s.player.mode).toBe('survival');
    explode(sim, 20.5, T - 2.5, 0.5, 4, null);
    expect(dropsNear(sim, 20.5, 0.5, 12)).toBeGreaterThan(0);
    sim.setRules(worldRulesFor('creative'));
    expect(sim.rules).toEqual({ defaultMode: 'creative', dropsEnabled: false });
    expect(s.player.mode).toBe('survival');
  });
});

// =====================================================================================

describe('saving several players', () => {
  it('a save holds every player by key, the offline one included, and the world rules', () => {
    const { sim, ps } = world(['a', 'b'], { mode: 'survival' });
    const [a, b] = ps as [PlayerControl, PlayerControl];
    a.teleport(4.5, T, 4.5);
    b.teleport(-5.5, T, 2.5);
    sim.advance(5);
    b.giveItem(B.COBBLE, 33);
    b.hold(I.GLUE, 3);
    b.swapHands();
    sim.tick();
    const bPos = { ...b.player.pos };
    const bId = b.player.id;
    sim.leave('b');
    a.giveItem(B.SAND, 7);
    sim.advance(10);
    const aPos = { ...a.player.pos };
    sim.rules.dropsEnabled = false;
    const bundle = exportSave(sim);

    const loaded = new Simulation(flatOpts({ mode: 'creative' }));
    importSave(loaded, bundle);
    expect(loaded.rules).toEqual({ defaultMode: 'survival', dropsEnabled: false });
    expect(loaded.players.online()).toEqual([]);
    expect(loaded.players.keys()).toEqual(['a', 'b']);
    expect(loaded.entities.all().some((e) => e instanceof Player)).toBe(false);
    const b2 = loaded.join('b');
    expect(b2.player.id).toBe(bId);
    expect(b2.player.pos).toEqual(bPos);
    expect(b2.player.inventory.count(B.COBBLE)).toBe(33);
    expect(b2.player.inventory.offhand).toEqual({ item: I.GLUE, count: 3 });
    const a2 = loaded.join('a');
    expect(a2.player.pos).toEqual(aPos);
    expect(a2.player.inventory.count(B.SAND)).toBe(7);
    // a joined first in this world: a acts first again, whatever the rejoin order
    expect(loaded.players.online().map((c) => c.key)).toEqual(['a', 'b']);
    // A new player joins in the saved default mode, not the mode the loader was built with.
    expect(loaded.join('c').player.mode).toBe('survival');
  });

  /** a takes the raft's wheel at full throttle, b stands on shore; returns the save. */
  function saveWithHelmsman(): ReturnType<typeof exportSave> {
    const spawn = { x: 2.5, y: SEA_TOP, z: 7.5 };
    const { sim, ps } = world(['a', 'b'], { spawn }, true);
    const [a] = ps as [PlayerControl, PlayerControl];
    raft(sim, 0);
    sim.advance(3);
    a.lookAtCell(2, SEA_TOP, 4, PZ);
    a.use();
    sim.tick();
    a.use();
    sim.tick();
    expect(a.player.steeringShipId).not.toBe(0);
    a.player.input.forward = 1;
    sim.advance(10);
    expect(sim.structures.ships()[0]!.throttle).toBeGreaterThan(0);
    return exportSave(sim);
  }

  it('a helmsman saved while joined who is absent at the first tick after loading lets go: the ship stops and a later join is aboard, not at the wheel', () => {
    const bundle = saveWithHelmsman();
    const loaded = new Simulation(seaOpts({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }));
    importSave(loaded, bundle);
    loaded.join('b');
    loaded.tick();
    const ship = loaded.structures.ships()[0]!;
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(ship.rudder).toBe(0);
    loaded.advance(300);
    const z0 = ship.grid.position.z;
    loaded.advance(300);
    expect(Math.abs(ship.grid.position.z - z0)).toBeLessThan(0.05);
    const a2 = loaded.join('a');
    loaded.advance(3);
    expect(a2.player.steeringShipId).toBe(0);
    expect(a2.player.carrierId).toBe(ship.id); // the record kept its carrier
    expect(ship.helmsmanId).toBe(0);
    expect(ship.throttle).toBe(0);
    // A save made now no longer has anyone at the wheel either.
    loaded.leave('a');
    const again = new Simulation(seaOpts({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }));
    importSave(again, exportSave(loaded));
    expect(again.join('a').player.steeringShipId).toBe(0);
  });

  it('a helmsman who joins the loaded world before it first ticks keeps the wheel (the single-player reload)', () => {
    const bundle = saveWithHelmsman();
    const loaded = new Simulation(seaOpts({ spawn: { x: 2.5, y: SEA_TOP, z: 7.5 } }));
    importSave(loaded, bundle);
    const a2 = loaded.join('a');
    a2.player.input.forward = 1; // the client still holds the key
    loaded.advance(3);
    const ship = loaded.structures.ships()[0]!;
    expect(a2.player.steeringShipId).toBe(ship.id);
    expect(a2.player.carrierId).toBe(ship.id);
    expect(ship.helmsmanId).toBe(a2.player.id);
    expect(ship.throttle).toBeGreaterThan(0);
  });

  it('a corrupt players blob fails the load and changes nothing', () => {
    const { sim } = world(['a']);
    const bundle = exportSave(sim);
    const blobs = bundle.blobs.map(([n, b]): [string, Uint8Array] => [n, n === 'players' ? b.slice(0, b.length - 3) : b]);
    const loaded = new Simulation(flatOpts());
    expect(() => importSave(loaded, { chunks: bundle.chunks, blobs })).toThrow();
    expect(loaded.players.keys()).toEqual([]);
  });

  it('a save cannot be loaded into a world that players have joined', () => {
    const { sim } = world(['a']);
    const bundle = exportSave(sim);
    expect(() => importSave(sim, bundle)).toThrow(/before any player joins/);
  });
});

// =====================================================================================

describe('determinism with several players', () => {
  /** Two players each mine a block, build a little and walk; returns the world and each player by key. */
  function play(order: readonly string[], rabbitsOn = false): { cells: string; players: Record<string, string>; bytes: Uint8Array } {
    const { sim } = world(order, { mode: 'survival', rabbits: rabbitsOn, loadRadius: 3, seed: 11 });
    const a = sim.players.get('a')!;
    const b = sim.players.get('b')!;
    a.teleport(0.5, T, 0.5);
    b.teleport(12.5, T, 0.5);
    sim.advance(3);
    a.emptyHand();
    b.emptyHand();
    a.mine(0, T - 1, -2, PY);
    b.mine(12, T - 1, -2, PY);
    sim.advance(30);
    a.hold(B.PLANKS_OAK, 10);
    b.hold(B.COBBLE, 10);
    for (let i = 0; i < 3; i++) {
      a.lookAtCell(-1 + i, T - 1, -3, PY);
      b.lookAtCell(11 + i, T - 1, -3, PY);
      a.use();
      b.use();
      sim.tick();
    }
    a.player.input.forward = 1;
    b.player.input.strafe = 1;
    sim.advance(40);
    let cells = '';
    for (let y = T - 2; y <= T + 1; y++) for (let z = -6; z <= 3; z++) for (let x = -4; x <= 16; x++) cells += `${idAt(sim.world, x, y, z)},`;
    const players: Record<string, string> = {};
    for (const k of ['a', 'b']) {
      const p = sim.players.get(k)!.player;
      players[k] = JSON.stringify([p.pos, p.inventory.hotbar, p.inventory.main, p.health]);
    }
    return { cells, players, bytes: exportSave(sim).blobs.find(([n]) => n === 'players')![1] };
  }

  it('the same inputs for the same players give the same world, bit for bit (rabbits included)', () => {
    const r1 = play(['a', 'b'], true);
    const r2 = play(['a', 'b'], true);
    expect(r2.cells).toBe(r1.cells);
    expect(r2.players).toEqual(r1.players);
    expect(r2.bytes).toEqual(r1.bytes);
  });

  it('players who do not interact give the same world whatever the join order', () => {
    const ab = play(['a', 'b']);
    const ba = play(['b', 'a']);
    expect(ba.cells).toBe(ab.cells);
    expect(ba.players).toEqual(ab.players);
  });
});

// ------------------------------------------------------------------ scenes

/** A 5x6 plank raft at the sea surface (x0..x0+4, z 0..5) with a helm facing north, and a rubble dock south of it. */
function raft(sim: Simulation, x0: number): void {
  const w = sim.world;
  fill(w, x0, 20, 6, x0 + 4, SEA_TOP - 1, 8, B.COBBLE);
  fill(w, x0, SEA_TOP - 1, 0, x0 + 4, SEA_TOP - 1, 5, B.PLANKS_OAK);
  w.setCell(x0 + 2, SEA_TOP, 4, makeCell(B.HELM, facingState(NZ)));
}

/** A windmill whose bearing at (0, T+2, 0) faces down: a 7-long canvas paddle sweeps the ground at y T..T+1. */
function landPaddle(sim: Simulation): void {
  const w = sim.world;
  w.setCell(0, T + 2, 0, makeCell(B.BEARING, facingState(NY)));
  w.setCell(0, T + 1, 0, makeCell(B.CANVAS));
  w.setCell(0, T, 0, makeCell(B.CANVAS));
  for (let x = 1; x <= 6; x++) {
    w.setCell(x, T, 0, makeCell(B.CANVAS));
    w.setCell(x, T + 1, 0, makeCell(B.CANVAS));
  }
}

/** A 1x2 stone cage with a roof around cell (0, T, z), in the paddle's sweep. */
function cage(sim: Simulation, z: number): void {
  for (const [x, dz] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    fill(sim.world, x, T, z + dz, x, T + 1, z + dz, B.STONE);
  }
  fill(sim.world, -1, T + 2, z - 1, 1, T + 2, z + 1, B.STONE);
}

/** Start the windmill at `bearing` by two right-clicks of player `c` (each click is one tick of the world). */
function startRotor(sim: Simulation, c: PlayerControl, bearing: readonly [number, number, number], face: Dir): Rotor {
  const before = new Set(sim.structures.rotors());
  const [x, y, z] = bearing;
  expect(c.useOn(x, y, z, face)).toBe(true);
  expect(c.view.preview?.kind).toBe('rotor');
  expect(c.useOn(x, y, z, face)).toBe(true);
  const fresh = sim.structures.rotors().filter((r) => !before.has(r));
  expect(fresh.length).toBe(1);
  return fresh[0]!;
}
