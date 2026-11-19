/**
 * Replication of partial blocks end to end (docs/SHAPES.md 4.5, 13, 14.1, 16.3):
 *  - Replicator on a real Simulation (rig.ts: digests over every layer compared after every tick):
 *    chunk deltas (one per holes-only and second-part-only change), snapshots of a loaded modified
 *    column and of a stashed one, structure spawn records and structure deltas;
 *  - the host command SetCell (section 14.1): written when it passes, refused with a toast and no
 *    change by each of its four checks;
 *  - the server takes a Target.cell that is layout-valid garbage without throwing;
 *  - the transition (16.3) through a real client: aiming at and mining a two-part cell and a holed
 *    cell throws nowhere and leaves replica and server equal.
 */
import { describe, expect, it } from 'vitest';
import { facingState, makeCell, PACK_SCALE } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { canonCell } from '../../src/blocks/shapes';
import { PY, PZ } from '../../src/core/dirs';
import { Simulation } from '../../src/sim/simulation';
import { getPacked } from '../../src/voxel/parts';
import { FlatGenerator } from '../../src/worldgen/generator';
import { NetHarness } from './harness';
import { Rig } from './rig';
import { LOWER, slab, UPPER, WEST, EAST } from '../shapes';

/** Flat world: first air y = 35. */
const T = 35;
const SLAB = slab(B.PLANKS_OAK, LOWER);
const TWO = canonCell(slab(B.STONE, LOWER), slab(B.PLANKS_OAK, UPPER));
const NOTCH = canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.PLANKS_OAK, UPPER)); // TWO with only the first part's holes changed
const GLASS = canonCell(slab(B.STONE, LOWER & 0xfe), slab(B.GLASS, UPPER)); // NOTCH with only the second part changed

function flatRig(): Rig {
  return new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn: { x: 0.5, y: T, z: 4.5 } }));
}

describe('the Replicator carries both parts', () => {
  it('chunk deltas: one per change, a holes-only and a second-part-only change included; the replica matches every tick', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 3 });
    rig.tick(10);
    const deltaCells = (): Array<[number, number]> => a.batches.at(-1)!.batch.chunkDeltas.flatMap((d) => d.cells);
    sim.world.setCell(2, T, 2, SLAB);
    sim.world.setCell(3, T, 2, TWO);
    rig.tick();
    expect(deltaCells().map(([, c]) => c).sort()).toEqual([SLAB, TWO].sort());
    sim.world.setCell(3, T, 2, NOTCH);
    rig.tick();
    expect(deltaCells().map(([, c]) => c)).toEqual([NOTCH]);
    sim.world.setCell(3, T, 2, GLASS);
    rig.tick();
    expect(deltaCells().map(([, c]) => c)).toEqual([GLASS]);
    expect(getPacked(a.state.world, 3, T, 2)).toBe(GLASS);
    expect(getPacked(a.state.world, 2, T, 2)).toBe(SLAB);
    rig.check('full');
  });

  it('a client joining later gets the modified column with its parts in a snapshot', () => {
    const rig = flatRig();
    const sim = rig.sim;
    rig.join('a', { viewRadius: 3 });
    rig.tick(10);
    sim.world.setCell(-5, T, 6, TWO);
    sim.world.setCell(-6, T, 6, canonCell(slab(B.PLANKS_OAK, LOWER), slab(B.PLANKS_OAK, UPPER)));
    rig.tick(2);
    const b = rig.join('b', { viewRadius: 3 });
    rig.tick(20);
    const snap = b.batches.flatMap((x) => x.batch.snapshots).find((s) => s.cx === -1 && s.cz === 0)!;
    expect(snap.cells).not.toBe('pristine');
    expect(snap.cells !== 'pristine' && snap.cells.part2).not.toBeNull();
    expect(getPacked(b.state.world, -5, T, 6)).toBe(TWO);
    rig.check('full');
  });

  it('a stashed (modified, unloaded) column is answered from the stash with its parts', () => {
    const rig = flatRig();
    const sim = rig.sim;
    rig.join('a', { viewRadius: 3 });
    rig.tick(5);
    // Column 7,0 lies beyond the simulation's load radius (3): load it by hand, edit it, let it unload.
    sim.chunks.loadColumn(sim.generator, 7, 0);
    sim.world.setCell(7 * 16 + 1, T, 1, TWO);
    sim.world.setCell(7 * 16 + 2, T, 1, SLAB);
    rig.tick(); // the client does not subscribe to it (radius 3)
    sim.chunks.unloadFar(100);
    expect(sim.world.getChunk(7, 0)).toBeUndefined();
    const stashed = sim.chunks.stashedCells(7, 0)!;
    expect(stashed.part2).not.toBeNull();
    // A client whose view reaches it subscribes to a column the server does not load.
    const b = rig.join('b', { viewRadius: 9 });
    rig.checkEveryTick = false;
    rig.tick(80);
    expect(sim.world.getChunk(7, 0)).toBeUndefined();
    expect(getPacked(b.state.world, 7 * 16 + 1, T, 1)).toBe(TWO);
    expect(getPacked(b.state.world, 7 * 16 + 2, T, 1)).toBe(SLAB);
    rig.check('full');
  });

  it('a ship with parts: the spawn record and later structure deltas carry them', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 3 });
    rig.tick(5);
    for (let x = -2; x <= 2; x++) for (let z = 6; z <= 8; z++) sim.world.setCell(x, T + 3, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(0, T + 4, 7, makeCell(B.HELM, 5));
    sim.world.setCell(1, T + 4, 7, SLAB);
    sim.world.setCell(-1, T + 4, 7, canonCell(slab(B.PLANKS_OAK, WEST), slab(B.STONE, EAST)));
    rig.tick();
    const r = sim.structures.assembleShip(0, T + 4, 7);
    expect(r.ok).toBe(true);
    rig.tick();
    const id = (r as { structure: { id: number } }).structure.id;
    const rec = a.batches.at(-1)!.batch.structureSpawns.find((s) => s.id === id)!;
    expect(rec.cells.holes).not.toBeNull();
    expect(rec.cells.part2).not.toBeNull();
    const g = a.state.structures.get(id)!.structure.grid;
    expect(getPacked(g, 1, T + 4, 7)).toBe(SLAB);
    // A holes-only change on the ship: a structure delta.
    const ship = sim.structures.get(id)!;
    ship.grid.setCell(1, T + 4, 7, slab(B.PLANKS_OAK, LOWER & 0xfe));
    rig.tick();
    expect(a.batches.at(-1)!.batch.structureDeltas.find((d) => d.id === id)!.cells).toEqual([[1, T + 4, 7, slab(B.PLANKS_OAK, LOWER & 0xfe)]]);
    expect(getPacked(g, 1, T + 4, 7)).toBe(slab(B.PLANKS_OAK, LOWER & 0xfe));
    rig.check('full');
  });
});

describe('the host command SetCell (section 14.1)', () => {
  async function world(): Promise<{ h: NetHarness; c: ReturnType<NetHarness['addClient']>; toasts: () => string[] }> {
    const h = new NetHarness();
    await h.create();
    const c = h.addClient('host', {}, { local: true, viewRadius: 3 });
    h.track(c);
    h.runUntil(() => c.ready && c.own !== null && c.intents !== null, 60_000);
    const keys: string[] = [];
    h.sim.events.on((e) => {
      if (e.type === 'toast') keys.push(e.message.key);
    });
    return { h, c, toasts: () => keys };
  }
  const T5 = 5; // first air of the harness's flat world

  it('writes a valid cell into the world and into a ship; the replica follows', async () => {
    const { h, c, toasts } = await world();
    c.hostCommand({ kind: 'setCell', gridId: 0, x: 2, y: T5, z: 2, cell: TWO });
    h.run(300);
    expect(getPacked(h.sim.world, 2, T5, 2)).toBe(TWO);
    expect(getPacked(c.replica!.world, 2, T5, 2)).toBe(TWO);
    expect(toasts()).toEqual([]);
    expect(c.mismatches).toEqual([]);
  });

  it('refuses, with toast.host.setCell and no change, each check: invalid cell, unknown grid, functional block, unloaded column or out of range, a spinning rotor, a block that cannot join a structure, a write past the structure limits', async () => {
    const { h, c, toasts } = await world();
    const sim = h.sim;
    // A small ship (helm on a deck) and a world rotor, for the structure cases.
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) sim.world.setCell(x, T5 + 3, z, makeCell(B.PLANKS_OAK));
    sim.world.setCell(5, T5 + 4, 5, makeCell(B.HELM, 5));
    const ship = sim.structures.assembleShip(5, T5 + 4, 5);
    expect(ship.ok).toBe(true);
    const shipId = (ship as { structure: { id: number } }).structure.id;
    // A windmill: a bearing on a stone pillar facing +Z, wool in the plane in front of it.
    const [wx, wz] = [-8, -8];
    const wy = T5 + 4;
    for (let y = T5; y < wy; y++) sim.world.setCell(wx, y, wz, makeCell(B.STONE));
    sim.world.setCell(wx, wy, wz, makeCell(B.BEARING, facingState(PZ)));
    sim.world.setCell(wx, wy, wz + 1, makeCell(B.WOOL_YELLOW));
    for (const [du, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
      sim.world.setCell(wx + du, wy + dy, wz + 1, makeCell(B.WOOL_WHITE));
      sim.world.setCell(wx + 2 * du, wy + 2 * dy, wz + 1, makeCell(B.WOOL_RED));
      sim.world.setCell(wx + 2 * du + dy, wy + 2 * dy - du, wz + 1, makeCell(B.WOOL_RED));
    }
    sim.worldGlue.add(wx, wy, wz, PZ);
    const rotor = sim.structures.startRotor(sim.world, wx, wy, wz);
    expect(rotor.ok).toBe(true);
    const rotorId = (rotor as { structure: { id: number } }).structure.id;
    sim.world.setCell(1, T5, 1, makeCell(B.HELM, 5));
    h.run(300);
    const before = h.compareNow(c, false);
    expect(before).toEqual([]);
    const refused: Array<[string, { gridId: number; x: number; y: number; z: number; cell: number }]> = [
      ['an invalid cell (overlapping parts)', { gridId: 0, x: 2, y: T5, z: 2, cell: (slab(B.STONE, LOWER) | (1 << 24)) + slab(B.DIRT, LOWER) * PACK_SCALE }],
      ['an unregistered id', { gridId: 0, x: 2, y: T5, z: 2, cell: makeCell(999) }],
      ['a grid that does not exist', { gridId: 777, x: 0, y: 0, z: 0, cell: TWO }],
      ['writing over a helm', { gridId: 0, x: 1, y: T5, z: 1, cell: TWO }],
      ['writing a helm', { gridId: 0, x: 3, y: T5, z: 3, cell: makeCell(B.HELM, 5) }],
      ['a column that is not loaded', { gridId: 0, x: 4000, y: T5, z: 4000, cell: TWO }],
      ['above the world', { gridId: 0, x: 2, y: 128, z: 2, cell: TWO }],
      ['below the world', { gridId: 0, x: 2, y: -1, z: 2, cell: TWO }],
      ['a spinning rotor', { gridId: rotorId, x: wx + 1, y: wy, z: wz + 1, cell: SLAB }],
      ['water onto a ship (it cannot join a structure)', { gridId: shipId, x: 4, y: T5 + 4, z: 4, cell: makeCell(B.WATER) }],
      ['deeprock over a deck plank', { gridId: shipId, x: 4, y: T5 + 3, z: 4, cell: makeCell(B.DEEPROCK) }],
      ['the unloaded reading as a content', { gridId: 0, x: 2, y: T5, z: 2, cell: makeCell(B.UNLOADED) }],
      ['far from the ship (past the box limit)', { gridId: shipId, x: 5 + 1500, y: T5 + 3, z: 5 + 1500, cell: SLAB }],
    ];
    for (const [why, cmd] of refused) {
      const n = toasts().length;
      const grid = sim.structures.gridById(cmd.gridId);
      const was = grid !== undefined ? getPacked(grid, cmd.x, cmd.y, cmd.z) : 0;
      const s = sim.structures.get(cmd.gridId);
      const box = s !== undefined ? s.grid.storage().layers.base.length : 0;
      c.hostCommand({ kind: 'setCell', ...cmd });
      h.run(200);
      expect(toasts().slice(n), why).toEqual(['toast.host.setCell']);
      if (grid !== undefined) expect(getPacked(grid, cmd.x, cmd.y, cmd.z), why).toBe(was);
      if (s !== undefined) expect(s.grid.storage().layers.base.length, `${why}: the storage did not grow`).toBe(box);
    }
    // The ship's cell limit: a full ship refuses one more cell, even a near one.
    const g = sim.structures.get(shipId)!.grid;
    (sim as { shipMaxCells: number }).shipMaxCells = g.count;
    const n = toasts().length;
    c.hostCommand({ kind: 'setCell', gridId: shipId, x: 6, y: T5 + 4, z: 4, cell: SLAB });
    h.run(200);
    expect(toasts().slice(n)).toEqual(['toast.host.setCell']);
    expect(getPacked(g, 6, T5 + 4, 4)).toBe(0);
    // Editing an existing cell of a full ship is allowed (no new cell).
    c.hostCommand({ kind: 'setCell', gridId: shipId, x: 4, y: T5 + 3, z: 4, cell: SLAB });
    h.run(200);
    expect(getPacked(g, 4, T5 + 3, 4)).toBe(SLAB);
    h.quiesce();
    expect(h.compareNow(c, false)).toEqual([]);
  });

  it('a guest is refused (toast.host.only)', async () => {
    const { h, toasts } = await world();
    h.host.setRoomOpen(true);
    const guest = h.addClient('guest', {}, { viewRadius: 2 });
    h.runUntil(() => guest.ready && guest.intents !== null, 60_000);
    guest.hostCommand({ kind: 'setCell', gridId: 0, x: 2, y: T5, z: 2, cell: TWO });
    h.run(300);
    expect(toasts()).toContain('toast.host.only');
    expect(getPacked(h.sim.world, 2, T5, 2)).toBe(0);
  });
});

describe('the transition (16.3) through a real client', () => {
  it('aiming at and mining a two-part cell and a holed cell: nothing throws, replica and server stay equal, events carry the first part', async () => {
    const h = new NetHarness();
    await h.create();
    const c = h.addClient('p', {}, { local: true, viewRadius: 3 });
    h.track(c);
    h.runUntil(() => c.ready && c.own !== null && c.intents !== null, 60_000);
    const broken: number[] = [];
    h.sim.events.on((e) => {
      if (e.type === 'blockBroken') broken.push(e.cell);
    });
    const p = h.sim.players.get('p')!.player;
    const T5 = Math.floor(p.pos.y); // the player's feet: the cells' top faces are below the eyes
    const px = Math.floor(p.pos.x);
    const pz = Math.floor(p.pos.z);
    h.sim.world.setCell(px + 2, T5, pz, TWO);
    h.sim.world.setCell(px - 2, T5, pz, SLAB);
    h.run(300);
    expect(c.mine(px + 2, T5, pz, PY)).toBe(true);
    expect(c.mine(px - 2, T5, pz, PY)).toBe(true);
    h.run(300);
    expect(getPacked(h.sim.world, px + 2, T5, pz)).toBe(0);
    expect(getPacked(h.sim.world, px - 2, T5, pz)).toBe(0);
    expect(broken).toEqual([slab(B.STONE, LOWER), SLAB]);
    h.quiesce();
    expect(h.compareNow(c, false)).toEqual([]);
    expect(c.mismatches).toEqual([]);
  });

  it('a claimed target whose cell is layout-valid garbage is no target: no throw, nothing mined', async () => {
    const h = new NetHarness();
    await h.create();
    const c = h.addClient('p', {}, { local: true, viewRadius: 3 });
    h.runUntil(() => c.ready && c.own !== null && c.intents !== null, 60_000);
    const p = h.sim.players.get('p')!.player;
    const T5 = Math.floor(p.pos.y);
    const px = Math.floor(p.pos.x);
    const pz = Math.floor(p.pos.z);
    h.sim.world.setCell(px + 2, T5, pz, makeCell(B.STONE));
    h.run(300);
    let seq = 900_000;
    for (const garbage of [(slab(B.DIRT, LOWER) | (1 << 24)) + slab(B.DIRT, LOWER) * PACK_SCALE, makeCell(999)]) {
      c.net.send({ type: 'attack', seq: ++seq, moveSeq: 0, slot: 0, target: { gridId: 0, x: px + 2, y: T5, z: pz, face: PY, sub: 0, cell: garbage } });
      h.run(300);
      expect(getPacked(h.sim.world, px + 2, T5, pz)).toBe(makeCell(B.STONE));
    }
    expect(h.intentStats('p')!.failed.cell).toBeGreaterThan(0);
  });
});
