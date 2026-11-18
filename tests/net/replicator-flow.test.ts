/**
 * Package 4: what the Replicator sends when (NETCODE sections 2, 5, 9, 11, 12, 13): must-send
 * versus may-defer under back-pressure and over budget, interest per client, privacy, the
 * private section and the globals, removal order, must-send content over the batch limits, the
 * idle cost with many entities, and a self-test of the digest comparison.
 */
import { describe, expect, it } from 'vitest';
import { cellState, facingState, makeCell, stateFacing } from '../../src/blocks/cell';
import { B } from '../../src/blocks/defs';
import { NZ, PX, PY, PZ, type Dir } from '../../src/core/dirs';
import { Replicator } from '../../src/net/server/replicator';
import { BEARING_V, DECK_Y, exampleShipCell, MAST_TOP_Y, placeExampleShip } from '../../src/sim/exampleShip';
import { encodeSnapshotPiece } from '../../src/net/codec';
import { MAX_BACKLOG, SECTION, SNAPSHOT_BUDGET } from '../../src/net/protocol';
import { circleOffsets, structureInterest, StructureSpheres } from '../../src/net/server/interest';
import { RELIABLE, UNRELIABLE } from '../../src/net/transport';
import { Simulation } from '../../src/sim/simulation';
import { chunkKey } from '../../src/voxel/chunk';
import { FlatGenerator, TerrainGenerator } from '../../src/worldgen/generator';
import { compareReplica, replicaDigest, serverDigest } from './digest';
import { Rig } from './rig';

const T = 35;

function flatRig(spawn = { x: 0.5, y: T, z: 0.5 }): Rig {
  return new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn }));
}

function set(sim: Simulation, x: number, y: number, z: number, id: number, state = 0): void {
  sim.world.setCell(x, y, z, makeCell(id, state));
}

/** A 3 x 3 plank deck with a helm on it at (x, T, z) .. (x + 2, T, z + 2): assembled at once. */
function landShip(rig: Rig, x: number, z: number): number {
  const sim = rig.sim;
  for (let dx = 0; dx <= 2; dx++) for (let dz = 0; dz <= 2; dz++) set(sim, x + dx, T, z + dz, B.PLANKS_OAK);
  set(sim, x + 1, T + 1, z + 1, B.HELM, facingState(PX));
  const r = sim.structures.assembleShip(x + 1, T + 1, z + 1);
  expect(r.ok).toBe(true);
  return (r as { structure: { id: number } }).structure.id;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('interest (package 4)', () => {
  it('the subscription circle is ChunkManager\'s, nearest first', () => {
    const c = circleOffsets(9);
    expect(c.length / 2).toBe(Array.from({ length: 19 * 19 }, (_, i) => [(i % 19) - 9, Math.floor(i / 19) - 9]).filter(([dx, dz]) => dx! * dx! + dz! * dz! <= 90).length);
    expect([c[0], c[1]]).toEqual([0, 0]);
    const d2 = (i: number): number => c[i * 2]! ** 2 + c[i * 2 + 1]! ** 2;
    for (let i = 1; i < c.length / 2; i++) expect(d2(i)).toBeGreaterThanOrEqual(d2(i - 1));
  });

  it('structure spheres enter at (r + 4) * 16 and leave beyond (r + 6) * 16', () => {
    const rig = flatRig();
    rig.sim.join('x');
    rig.sim.advance(5);
    const id = landShip(rig, 0, 0);
    const spheres = new StructureSpheres();
    spheres.update(rig.sim.structures.all());
    const s = spheres.get(id)!;
    expect(s.radius).toBeGreaterThan(1.5);
    // Player column cx such that the gap is between the two thresholds (r = 2).
    const gapAt = (cx: number): number => Math.hypot(s.x - (cx + 0.5) * 16, s.z - 8) - s.radius;
    let cx = 0;
    while (gapAt(cx) <= 7 * 16) cx++;
    expect(gapAt(cx)).toBeLessThanOrEqual(8 * 16);
    expect(structureInterest(s, cx, 0, 2, false)).toBe(false);
    expect(structureInterest(s, cx, 0, 2, true)).toBe(true);
    expect(structureInterest(s, cx + 3, 0, 2, true)).toBe(false);
    expect(structureInterest(s, 0, 0, 2, false)).toBe(true);
  });
});

describe('must-send and may-defer (package 4)', () => {
  it('under back-pressure: must-send sections still arrive, new interest waits and then comes with its then-current state', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(10);
    expect(a.state.ready).toBe(true);
    const known = new Set(rig.rep.clientView('a')!.columns);
    // The link backs up.
    a.sink.backlog[RELIABLE] = 1 << 20;
    // The player moves five columns east: new columns enter the interest but must wait.
    rig.ctrl('a').player.flying = true;
    rig.ctrl('a').teleport(80.5, T + 4, 0.5);
    rig.tick(8);
    const view = rig.rep.clientView('a')!;
    expect(view.pendingColumns).toBeGreaterThan(0);
    const pendingKey = chunkKey(4, 0);
    expect(view.columns.has(pendingKey)).toBe(false);
    for (const b of a.batches.slice(-8)) expect(b.batch.snapshots.length).toBe(0);
    // Changes in a column the client has arrive (must-send); in a waiting column nothing is sent.
    const knownCol = chunkKey(1, 0);
    expect(rig.rep.clientView('a')!.columns.has(knownCol)).toBe(true);
    set(sim, 18, T, 2, B.GLASS);
    set(sim, 66, T, 2, B.GLASS); // column (4, 0): waiting
    rig.tick();
    const last = a.batches.at(-1)!.batch;
    expect(last.chunkDeltas.map((d) => chunkKey(d.cx, d.cz))).toEqual([knownCol]);
    // A ship assembled inside the interest is sent at once (new this tick), back-pressure or not.
    const shipId = landShip(rig, 20, 6);
    rig.tick();
    expect(a.batches.at(-1)!.batch.structureSpawns.map((s) => s.id)).toEqual([shipId]);
    expect(a.state.structures.has(shipId)).toBe(true);
    // Private state is must-send too.
    rig.ctrl('a').giveItem(B.STONE, 3);
    rig.tick();
    expect(a.batches.at(-1)!.batch.private?.inventory).toBeDefined();
    // The link drains: the waiting columns arrive with the glass in them.
    a.sink.backlog[RELIABLE] = 0;
    rig.tick(10);
    expect(rig.rep.clientView('a')!.columns.has(pendingKey)).toBe(true);
    expect(a.state.world.getCell(66, T, 2)).toBe(sim.world.getCell(66, T, 2));
    expect([...known].some((k) => !rig.rep.clientView('a')!.columns.has(k))).toBe(true); // the west edge was let go
    rig.check('full');
  });

  it('a reliable backlog above max(8 KiB, 0.1 s of the send rate) defers; the unreliable backlog stops samples; MAX_BACKLOG for 10 s marks the client too slow', () => {
    const rig = flatRig();
    const a = rig.join('a', { viewRadius: 2 });
    rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(3.5, T, 3.5);
    rig.tick(10);
    // 'b' walks: its samples go to 'a' ...
    const walk = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const p = rig.ctrl('b').player;
        rig.ctrl('b').teleport(p.pos.x + 0.1, T, p.pos.z);
        rig.tick();
      }
    };
    let before = a.samples.length;
    walk(5);
    expect(a.samples.length).toBeGreaterThan(before);
    // ... unless the unreliable channel is backed up.
    a.sink.backlog[UNRELIABLE] = 100_000;
    before = a.samples.length;
    rig.checkPoses = false;
    walk(5);
    expect(a.samples.length).toBe(before);
    a.sink.backlog[UNRELIABLE] = 0;
    walk(3);
    rig.checkPoses = true;
    walk(1);
    rig.check('full');
    // Too slow: 200 ticks above MAX_BACKLOG.
    a.sink.backlog[RELIABLE] = MAX_BACKLOG + 1;
    rig.tick(199);
    expect(rig.rep.tooSlow()).toEqual([]);
    rig.tick(1);
    expect(rig.rep.tooSlow()).toEqual(['a']);
    a.sink.backlog[RELIABLE] = 0;
    rig.tick(1);
    expect(rig.rep.tooSlow()).toEqual([]);
  });

  it('over budget: snapshots are spread over ticks, nearest first, each batch within SNAPSHOT_BUDGET plus one snapshot; one encoding per column version, shared', () => {
    const sim = new Simulation({ seed: 7, mode: 'creative', generator: new TerrainGenerator(7), syncChunks: true, rabbits: false, loadRadius: 5, spawn: { x: 8.5, y: 90, z: 8.5 } });
    const rig = new Rig(sim);
    rig.sim.join('builder');
    rig.ctrl('builder').player.flying = true;
    rig.checkEveryTick = false;
    rig.tick(40); // the server loads radius 5
    // Touch every loaded column so its snapshot carries cells (about 2.5 KB each).
    for (const chunk of sim.world.chunks.values()) sim.world.setCell(chunk.cx * 16 + 3, 100, chunk.cz * 16 + 3, makeCell(B.GLASS));
    rig.checkEveryTick = true;
    const a = rig.join('a', { viewRadius: 5, join: true });
    const b = rig.join('b', { viewRadius: 5, join: true });
    rig.ctrl('a').player.flying = true;
    rig.ctrl('b').player.flying = true;
    rig.tick(40);
    const snapSizes: number[] = [];
    for (const chunk of sim.world.chunks.values()) snapSizes.push(encodeSnapshotPiece({ cx: chunk.cx, cz: chunk.cz, cells: chunk.cells, glue: [] }).bytes.length);
    snapSizes.sort((p, q) => p - q);
    const maxSnap = snapSizes.at(-1)!;
    const perBatch = a.batches.filter((x) => x.batch.snapshots.length > 0).map((x) => x.bytes);
    console.log(
      `[sizes] lightly modified terrain columns: snapshot median ${snapSizes[snapSizes.length >> 1]} B, p90 ${snapSizes[Math.floor(snapSizes.length * 0.9)]} B, max ${maxSnap} B; join of radius 5 in ${perBatch.length} batches of at most ${Math.max(...perBatch)} B (${(perBatch.reduce((n, x) => n + x, 0) / 1024).toFixed(1)} KB)`,
    );
    let withSnapshots = 0;
    let order: number[] = [];
    for (const bl of a.batches) {
      const s = bl.batch.snapshots;
      if (s.length === 0) continue;
      withSnapshots++;
      // Section bytes of this batch: re-encode the snapshots.
      const bytes = s.reduce((n, x) => n + encodeSnapshotPiece(x).bytes.length, 0);
      expect(bytes).toBeLessThanOrEqual(SNAPSHOT_BUDGET + maxSnap);
      order = order.concat(s.map((x) => Math.hypot(x.cx, x.cz)));
    }
    expect(withSnapshots).toBeGreaterThan(3);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]! - 1e-9);
    expect(a.state.ready).toBe(true);
    // The same column bytes went to both clients (shared encoding): identical snapshot sections.
    const sa = a.batches.flatMap((x) => x.batch.snapshots.map((s) => `${s.cx},${s.cz}`));
    const sb = b.batches.flatMap((x) => x.batch.snapshots.map((s) => `${s.cx},${s.cz}`));
    expect(sa).toEqual(sb);
    expect(rig.rep.stats('a')!.sectionBytes[SECTION.snapshots]).toBe(rig.rep.stats('b')!.sectionBytes[SECTION.snapshots]);
    rig.check('full');
  }, 120_000);
});

describe('interest and privacy between clients (package 4)', () => {
  it('two clients with different interest get different batches; addressed events and private state reach only their player; no key is ever sent', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const KA = 'key-alpha-7f3c2a9b1d';
    const KB = 'key-bravo-0e8d4c6f5a';
    const a = rig.join(KA, { viewRadius: 2, name: 'Alice' });
    const b = rig.join(KB, { viewRadius: 2, name: 'Bob' });
    rig.ctrl(KB).player.flying = true;
    rig.ctrl(KB).teleport(200.5, T + 5, 200.5);
    rig.tick(20);
    expect(a.state.players.size).toBe(2);
    expect([...b.state.players.values()].map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    const colsA = rig.rep.clientView(KA)!.columns;
    const colsB = rig.rep.clientView(KB)!.columns;
    expect([...colsA].some((k) => colsB.has(k))).toBe(false);
    // A block placed near A: an event and a delta for A only.
    rig.ctrl(KA).hold(B.PLANKS_OAK);
    rig.useOn(KA, 2, T - 1, 2, PY);
    const ba = a.batches.at(-1)!.batch;
    const bb = b.batches.at(-1)!.batch;
    expect(ba.events.some((e) => e.type === 'blockPlaced')).toBe(true);
    expect(ba.chunkDeltas.length).toBe(1);
    expect(bb.events).toEqual([]);
    expect(bb.chunkDeltas).toEqual([]);
    // An addressed toast for A.
    sim.events.emit({ type: 'toast', player: KA, message: { key: 'toast.secret.for.alice' }, kind: 'info' });
    rig.tick();
    expect(a.batches.at(-1)!.batch.private?.events?.[0]).toEqual({ type: 'toast', message: { key: 'toast.secret.for.alice' }, kind: 'info' });
    expect(b.batches.at(-1)!.batch.private?.events).toBeUndefined();
    // A's inventory never goes to B.
    rig.ctrl(KA).giveItem(B.GLASS, 7);
    rig.tick();
    expect(a.state.private.inventory).not.toEqual(b.state.private.inventory);
    for (const c of [a, b]) {
      for (const raw of c.raw) {
        expect(contains(raw, utf8(KA)), `${c.key} received key A`).toBe(false);
        expect(contains(raw, utf8(KB)), `${c.key} received key B`).toBe(false);
      }
    }
    expect(b.raw.some((r) => contains(r, utf8('toast.secret.for.alice')))).toBe(false);
    // A leaves: B's table drops A.
    const ida = rig.ctrl(KA).entityId;
    rig.leave(KA);
    rig.tick();
    expect(b.state.players.has(ida)).toBe(false);
    expect(b.batches.at(-1)!.batch.globals?.players).toEqual([{ op: 'leave', entityId: ida }]);
  });

  it('a player sees the others as entities but never itself; flags and the held item follow', () => {
    const rig = flatRig();
    const a = rig.join('a', { viewRadius: 2 });
    const b = rig.join('b', { viewRadius: 2 });
    rig.ctrl('b').teleport(4.5, T, 4.5);
    rig.tick(10);
    const ia = rig.ctrl('a').entityId;
    const ib = rig.ctrl('b').entityId;
    expect(a.state.entities.has(ia)).toBe(false);
    expect(a.state.entities.has(ib)).toBe(true);
    expect(b.state.entities.has(ia)).toBe(true);
    rig.ctrl('b').hold(B.COBBLE);
    rig.ctrl('b').player.input.sneak = true;
    rig.tick(2);
    expect(a.state.entities.get(ib)!.player).toEqual({ flags: expect.objectContaining({ sneaking: true }), steeringShipId: 0, heldItem: B.COBBLE });
    rig.check('full');
  });
});

describe('private state and globals (package 4)', () => {
  it('the first batch has the correction, the whole inventory, the vitals; the acks of the feed; view, rules, day offset, tps, roomOpen', () => {
    const rig = flatRig();
    const sim = rig.sim;
    sim.join('a');
    rig.ctrl('a').setDrive('client');
    let ack: number | null = null;
    let moveAck: number | null = null;
    const a = rig.join('a', { viewRadius: 2, join: false, feed: { intentAck: () => ack, moveAck: () => moveAck } });
    rig.tick();
    const first = a.batches[0]!.batch;
    expect(first.private?.correction?.cause).toBe('drive');
    expect(first.private?.inventory?.hotbar.length).toBe(9);
    expect(first.private?.vitals?.mode).toBe('creative');
    expect(first.private?.ack).toBeUndefined();
    ack = 4;
    moveAck = 17;
    rig.tick();
    expect(a.batches.at(-1)!.batch.private).toMatchObject({ ack: 4, moveAck: 17 });
    rig.tick();
    expect(a.batches.at(-1)!.batch.private).toBeNull();
    // Globals.
    sim.setDayTime(0.5);
    sim.setRules({ defaultMode: 'survival', dropsEnabled: true });
    rig.rep.roomOpen = true;
    rig.rep.tps = 19.43;
    rig.tick();
    const g = a.batches.at(-1)!.batch.globals!;
    expect(g.dayOffset).toBe(sim.dayOffset);
    expect(g.rules).toEqual({ defaultMode: 'survival', dropsEnabled: true });
    expect(g.roomOpen).toBe(true);
    expect(g.tps).toBe(19.4);
    rig.rep.tps = 12;
    rig.tick();
    expect(a.batches.at(-1)!.batch.globals?.tps).toBe(12); // every change (ServerHost gives one at most once a second)
    rig.tick();
    expect(a.batches.at(-1)!.batch.globals?.tps).toBeUndefined();
    rig.tick(19);
    expect(a.state.tps).toBe(12);
    expect(a.state.rules.defaultMode).toBe('survival');
    // The view: a preview of a helm.
    set(sim, 3, T, 0, B.PLANKS_OAK);
    set(sim, 3, T + 1, 0, B.HELM, facingState(PX));
    rig.ctrl('a').setDrive('server');
    rig.ctrl('a').emptyHand();
    rig.tick();
    rig.useOn('a', 3, T + 1, 0);
    expect(a.state.private.view.preview?.kind).toBe('ship');
    expect(a.state.private.view.hint).toEqual(rig.ctrl('a').view.hint);
  });

  it('setViewRadius shrinks the subscription at the next tick; removeClient stops the batches', () => {
    const rig = flatRig();
    const a = rig.join('a', { viewRadius: 4 });
    rig.tick(20);
    const n4 = a.state.world.chunks.size;
    rig.setViewRadius('a', 1);
    rig.tick();
    expect(a.batches.at(-1)!.batch.unsubscribe.length).toBeGreaterThan(0);
    expect(a.state.world.chunks.size).toBeLessThan(n4);
    expect(a.state.world.chunks.size).toBe(circleOffsets(3).length / 2); // r + 2 kept
    rig.check('full');
  });
});

describe('the digest comparison (self-test)', () => {
  it('catches a wrong cell, glue face, structure cell and entity, and a missing entity', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(10);
    landShip(rig, 2, 2);
    sim.entities.spawnItem(6.5, T + 1, 6.5, B.STONE, 3);
    rig.tick(20);
    const view = rig.rep.clientView('a')!;
    const diff = (): string[] => compareReplica(serverDigest(rig.ctx, sim, { columns: view.columns, structures: view.structures, entities: view.entities }), replicaDigest(a.state));
    expect(diff()).toEqual([]);
    a.state.world.setCell(0, T + 3, 0, makeCell(B.GLASS));
    expect(diff().some((d) => d.includes('cells differ'))).toBe(true);
    a.state.world.setCell(0, T + 3, 0, 0);
    a.state.worldGlue.add(0, T - 1, 0, PY);
    expect(diff().some((d) => d.includes('glue'))).toBe(true);
    a.state.worldGlue.remove(0, T - 1, 0, PY);
    const rs = [...a.state.structures.values()][0]!;
    rs.structure.grid.setCell(2, T, 2, makeCell(B.GLASS));
    expect(diff().some((d) => d.includes('structure'))).toBe(true);
    rs.structure.grid.setCell(2, T, 2, makeCell(B.PLANKS_OAK));
    const e = [...a.state.entities.values()].find((x) => x.kind === 'item')!;
    e.count = 99;
    expect(diff().some((d) => d.includes('entity'))).toBe(true);
    e.count = 3;
    expect(diff()).toEqual([]);
    a.state.entities.delete(e.id);
    expect(diff().some((d) => d.includes('missing on the client'))).toBe(true);
  });
});

describe('deferral rules pinned (package 4)', () => {
  it('under back-pressure, a drop and falling sand that appear in a column the client has are spawned in the same batch as the cells', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 2 });
    rig.tick(10);
    a.sink.backlog[RELIABLE] = 1 << 20;
    rig.tick(3);
    // A drop appears; sand loses its support and falls.
    set(sim, 4, T + 3, 4, B.SAND);
    set(sim, 4, T + 2, 4, B.STONE);
    rig.tick();
    const drop = sim.entities.spawnItem(6.5, T + 1, 6.5, B.COBBLE, 1);
    sim.world.setCell(4, T + 2, 4, 0);
    rig.tick();
    expect(a.batches.at(-1)!.batch.entitySpawns.map((e) => e.id)).toContain(drop.id);
    let falling = sim.entities.all().find((e) => e.kind === 'falling');
    for (let i = 0; i < 5 && falling === undefined; i++) {
      rig.tick();
      falling = sim.entities.all().find((e) => e.kind === 'falling');
    }
    expect(falling).toBeDefined();
    const b = a.batches.at(-1)!.batch;
    expect(b.entitySpawns.map((e) => e.id)).toContain(falling!.id);
    // The sand left its cell in the same batch.
    expect(b.chunkDeltas.flatMap((d) => d.cells.map(([i]) => i))).toContain(4 | (4 << 4) | ((T + 3) << 8));
    a.sink.backlog[RELIABLE] = 0;
    rig.tick(40);
    rig.check('full');
  });

  it('an entity that moves into a column the client has while deferral is blocked, and then lies still, is spawned once the link drains', () => {
    const rig = flatRig();
    const sim = rig.sim;
    const a = rig.join('a', { viewRadius: 1 });
    rig.tick(10);
    expect(a.state.ready).toBe(true);
    a.sink.backlog[RELIABLE] = 1 << 20;
    rig.tick();
    // Thrown from column (2, 0), which the client does not have, into column (1, 0), which it has.
    const drop = sim.entities.spawnItem(32.5, T + 2, 4.5, B.COBBLE, 1, { x: -9, y: 3, z: 0 });
    rig.tick(80);
    expect(Math.floor(drop.pos.x) >> 4).toBe(1);
    expect(a.state.entities.has(drop.id)).toBe(false);
    a.sink.backlog[RELIABLE] = 0;
    rig.tick(3);
    expect(a.state.entities.has(drop.id)).toBe(true);
    rig.check('full');
  });

  it('a ship sails out of the interest of a player who stays: removed with the drop lying on its deck, no column involved', () => {
    const sea = new Simulation({
      seed: 2,
      mode: 'creative',
      generator: new FlatGenerator([
        { id: B.DEEPROCK, thickness: 1 },
        { id: B.STONE, thickness: 19 },
        { id: B.WATER, thickness: 10 },
      ]),
      syncChunks: true,
      rabbits: false,
      loadRadius: 3,
      spawn: { x: 2.5, y: 30, z: 7.5 },
    });
    const rig = new Rig(sea);
    const sim = rig.sim;
    rig.join('b', { viewRadius: 3 });
    const a = rig.join('a', { viewRadius: 0 });
    for (let y = 20; y <= 29; y++) for (let x = 0; x <= 8; x++) for (let z = 6; z <= 10; z++) set(sim, x, y, z, B.COBBLE); // pier
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 5; z++) set(sim, x, 29, z, B.PLANKS_OAK);
    sim.world.setCell(2, 30, 4, makeCell(B.HELM, facingState(NZ)));
    const drop = sim.entities.spawnItem(1.5, 31, 1.5, B.COBBLE, 1);
    rig.tick(30);
    rig.ctrl('b').emptyHand();
    rig.useOn('b', 2, 30, 4, PZ);
    rig.useOn('b', 2, 30, 4, PZ);
    const ship = sim.structures.ships()[0]!;
    rig.ctrl('b').player.input.forward = 1;
    rig.checkPoses = false;
    let gone = -1;
    for (let i = 0; i < 3000 && gone < 0; i++) {
      rig.tick();
      if (!a.state.structures.has(ship.id)) gone = sim.ticks;
    }
    expect(gone).toBeGreaterThan(0);
    expect(drop.carrierId).toBe(ship.id);
    const b = a.batches.find((x) => x.tick === gone)!.batch;
    expect(b.unsubscribe).toEqual([]);
    expect(b.structureRemoves).toEqual([ship.id]);
    expect(b.entityDespawns).toContain(drop.id);
    rig.ctrl('b').player.input.forward = 0;
    rig.tick(300);
    rig.checkPoses = true;
    rig.check('full');
  }, 120_000);

  it('events on a structure go only to clients that had it before the batch: not with its deferred spawn, not with its spawn in the tick it appears', () => {
    const rig = flatRig({ x: 0.5, y: T, z: -4.5 });
    const a = rig.join('a', { viewRadius: 1 });
    const b = rig.join('b', { viewRadius: 1 });
    rig.ctrl('b').teleport(2.5, T, 0.5);
    rig.tick(10);
    const onShip = (bt: { events: Array<{ type: string } & Partial<{ gridId: number }>> }, id: number) => bt.events.filter((e) => e.gridId === id);
    // Assembled between two ticks, built on in the next one: the spawn record already has the block.
    const shipId = landShip(rig, 2, 2);
    rig.ctrl('b').hold(B.STONE);
    rig.useOn('b', 2, T, 2, PY, shipId);
    for (const c of [a, b]) {
      const bt = c.batches.at(-1)!.batch;
      expect(bt.structureSpawns.map((s) => s.id), c.key).toEqual([shipId]);
      expect(onShip(bt, shipId), c.key).toEqual([]);
      expect(c.state.structures.get(shipId)!.structure.grid.count, c.key).toBe(11);
    }
    rig.useOn('b', 3, T, 2, PY, shipId);
    expect(onShip(a.batches.at(-1)!.batch, shipId).map((e) => e.type)).toEqual(['blockPlaced']);
    // Deferred: 'a' comes back under back-pressure; the link drains in the tick 'b' builds on it.
    rig.ctrl('a').player.flying = true;
    rig.ctrl('a').teleport(600.5, T + 10, 0.5);
    rig.tick(5);
    expect(a.state.structures.has(shipId)).toBe(false);
    a.sink.backlog[RELIABLE] = 1 << 20;
    rig.ctrl('a').teleport(0.5, T + 10, -4.5);
    rig.tick(5);
    expect(a.state.structures.has(shipId)).toBe(false);
    a.sink.backlog[RELIABLE] = 0;
    rig.useOn('b', 4, T, 2, PY, shipId);
    const ba = a.batches.at(-1)!.batch;
    expect(ba.structureSpawns.map((s) => s.id)).toContain(shipId);
    expect(onShip(ba, shipId)).toEqual([]);
    expect(onShip(b.batches.at(-1)!.batch, shipId).map((e) => e.type)).toEqual(['blockPlaced']);
    rig.tick(10);
    rig.check('full');
  });

  it('a windmill ship leaving the interest: its rotor is removed before the ship, in one batch', () => {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new TerrainGenerator(1), syncChunks: true, loadRadius: 3, rabbits: false });
    const rig = new Rig(sim);
    rig.join('a', { viewRadius: 2 });
    const helm = placeExampleShip(sim)!;
    const bow = stateFacing(cellState(sim.world.getCell(helm.x, helm.y, helm.z))) as Dir;
    const at = (u: number, v: number, y: number): { x: number; y: number; z: number } => exampleShipCell(helm, bow, u, v, y);
    rig.tick(20);
    const stand = at(1, BEARING_V, DECK_Y);
    rig.ctrl('a').teleport(stand.x + 0.5, DECK_Y, stand.z + 0.5);
    rig.ctrl('a').emptyHand();
    rig.tick(2);
    const bearing = at(0, BEARING_V, MAST_TOP_Y);
    rig.useOn('a', bearing.x, bearing.y, bearing.z);
    rig.useOn('a', bearing.x, bearing.y, bearing.z);
    const front = at(0, 2, DECK_Y);
    rig.ctrl('a').teleport(front.x + 0.5, DECK_Y, front.z + 0.5);
    rig.tick(2);
    rig.useOn('a', helm.x, helm.y, helm.z);
    rig.useOn('a', helm.x, helm.y, helm.z);
    const ship = sim.structures.ships()[0]!;
    const rotor = sim.structures.rotors()[0]!;
    expect(rotor.parent).toBe(ship);
    rig.ctrl('a').releaseHelm();
    rig.tick(5);
    // Far away in one step.
    const a = rig.clients.get('a')!;
    rig.ctrl('a').player.flying = true;
    rig.ctrl('a').teleport(helm.x + 600.5, 90, helm.z + 0.5);
    rig.tick();
    expect(a.batches.at(-1)!.batch.structureRemoves).toEqual([rotor.id, ship.id]);
    expect(a.state.structures.size).toBe(0);
    rig.tick(10);
    rig.check('full');
  }, 120_000);

  it('must-send content over the batch limits: that client is marked too slow and gets nothing more, the others go on', () => {
    // Cells: a ship assembled in the interest of 'a' needs more cells than the limit allows.
    let rig = new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn: { x: 0.5, y: T, z: 0.5 } }), { cells: 10, bytes: 1 << 20 });
    rig.join('a', { viewRadius: 1 });
    const b = rig.join('b', { viewRadius: 1 });
    rig.ctrl('b').player.flying = true;
    rig.ctrl('b').teleport(800.5, T + 20, 0.5);
    rig.tick(10);
    landShip(rig, 2, 2); // 3 x 2 x 3 = 18 cells in its record
    rig.sim.tick();
    rig.rep.endTick();
    expect(rig.clients.get('a')!.sink.queue.length).toBe(0);
    expect(b.drain()).toBe(1);
    expect(rig.rep.tooSlow()).toEqual(['a']);
    rig.sim.tick();
    rig.rep.endTick();
    expect(rig.clients.get('a')!.sink.queue.length).toBe(0);
    expect(rig.rep.tooSlow()).toEqual(['a']);
    // Bytes: 1000 cells of a column the client has change in one tick (a delta of about 2 KB).
    rig = new Rig(new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 3, spawn: { x: 0.5, y: T, z: 0.5 } }), { cells: 1 << 25, bytes: 1000 });
    const a2 = rig.join('a', { viewRadius: 1 });
    rig.tick(10);
    expect(a2.state.ready).toBe(true);
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) for (let y = T; y < T + 10; y++) set(rig.sim, x, y, z, B.GLASS);
    rig.sim.tick();
    rig.rep.endTick();
    expect(a2.sink.queue.length).toBe(0);
    expect(rig.rep.tooSlow()).toEqual(['a']);
  });
});

describe('cost with many resting entities (package 4)', () => {
  it('600 resting drops and 4 clients: the idle Replicator stays small next to the simulation tick', () => {
    const sim = new Simulation({ seed: 1, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, loadRadius: 9, rabbits: false, spawn: { x: 0.5, y: T, z: 0.5 } });
    const rep = rigless(sim, ['a', 'b', 'c', 'd'], 9);
    for (let i = 0; i < 100; i++) rep.step();
    for (let i = 0; i < 600; i++) sim.entities.spawnItem((i % 40) * 3 + 0.5 - 60, T + 1, Math.floor(i / 40) * 3 + 0.5 - 20, B.STONE, 1);
    for (let i = 0; i < 300; i++) rep.step();
    let tSim = 0;
    let tRep = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const t = rep.step();
      tSim += t.sim;
      tRep += t.rep;
    }
    const perSim = tSim / n;
    const perRep = tRep / n;
    console.log(`[cost] 600 resting drops, 4 clients: sim ${perSim.toFixed(3)} ms/tick, replicator ${perRep.toFixed(3)} ms/tick; last batch ${rep.lastBatch()} B`);
    expect(rep.lastBatch()).toBeLessThanOrEqual(6);
    expect(perRep).toBeLessThan(Math.max(0.1, perSim * 0.5));
  }, 120_000);
});

/** A Replicator on `sim` with clients whose sinks throw everything away (timing without decoding). */
function rigless(sim: Simulation, keys: string[], r: number): { step(): { sim: number; rep: number }; lastBatch(): number } {
  const rep = new Replicator(sim);
  for (const k of keys) {
    sim.join(k);
    rep.addClient({ key: k, name: k, host: false, viewRadius: r, sink: { send: () => {}, bufferedBytes: () => 0 } });
  }
  return {
    step() {
      let t = performance.now();
      sim.tick();
      const ts = performance.now() - t;
      t = performance.now();
      rep.endTick();
      return { sim: ts, rep: performance.now() - t };
    },
    lastBatch: () => rep.stats(keys[0]!)!.lastBatch,
  };
}
