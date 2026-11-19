/**
 * The protocol and the server's checks for parts (docs/SHAPES.md 6.3, 13.2; NETCODE section 14):
 *  - the codec validates Target.sub (the octant hit, 0..7), Use.flags (bit 0 sneak, bits 1..3 the
 *    slab mode 0..6) and the private view's mining.sub (bits 0..2 the octant, bit 3 "one octant",
 *    bits 4..7 zero) and gluing.sub (0), on both ends: RangeError when encoding, ProtocolError when
 *    decoding;
 *  - the server takes `sub` into the claimed aim and checks the PART at that octant (net/server/
 *    intents.ts check 1): a part replaced meanwhile is no target, a change of the other part is not;
 *    Use writes its slab mode into PlayerInput.slabMode; an Attack mines the part aimed at.
 */
import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { canonCell, withoutOctant } from '../../src/blocks/shapes';
import { PY, PZ, type Dir } from '../../src/core/dirs';
import { emptyReport, type MoveReport } from '../../src/entities/drive';
import { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage, ProtocolError } from '../../src/net/codec';
import { emptyTickBatch, type ClientMessage, type IntentMessage, type Target, type TickBatchMsg } from '../../src/net/protocol';
import { IntentQueue } from '../../src/net/server/intents';
import { MoveQueue } from '../../src/net/server/moves';
import { Replicator } from '../../src/net/server/replicator';
import { RELIABLE } from '../../src/net/transport';
import type { PlayerControl } from '../../src/sim/players';
import { Simulation } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import { getPacked } from '../../src/voxel/parts';
import { FlatGenerator } from '../../src/worldgen/generator';
import { LOWER, slab, UPPER } from '../shapes';

const TOP = 35;
const PLANKS_LOW = slab(B.PLANKS_OAK, LOWER);
const STONE_UP = slab(B.STONE, UPPER);
const TWO = canonCell(PLANKS_LOW, STONE_UP);

// ====================================================================== the codec

/** The first byte where two encodings of the same message differ (they differ in one u8 field). */
function differingByte(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  throw new Error('the encodings are the same');
}

function decodesAsError(decode: () => unknown): boolean {
  try {
    decode();
    return false;
  } catch (e) {
    return e instanceof ProtocolError;
  }
}

const target = (sub: number): Target => ({ gridId: 3, x: 10, y: 20, z: -30, face: PZ, sub, cell: TWO });

describe('the codec validates the new fields on both ends', () => {
  it('Target.sub is the octant hit: 0..7; anything else is a RangeError to encode and a ProtocolError to decode', () => {
    for (let sub = 0; sub < 8; sub++) {
      const m: ClientMessage = { type: 'pickBlock', seq: 5, moveSeq: 4, target: target(sub) };
      expect(decodeClientMessage(encodeClientMessage(m), RELIABLE)).toEqual(m);
    }
    for (const bad of [8, 15, 255, -1, 0.5]) expect(() => encodeClientMessage({ type: 'pickBlock', seq: 5, moveSeq: 4, target: target(bad) }), `sub ${bad}`).toThrow(RangeError);
    const six = encodeClientMessage({ type: 'pickBlock', seq: 5, moveSeq: 4, target: target(6) });
    const at = differingByte(six, encodeClientMessage({ type: 'pickBlock', seq: 5, moveSeq: 4, target: target(7) }));
    for (const bad of [8, 0x10, 0x86, 0xff]) {
      const bytes = six.slice();
      bytes[at] = bad;
      expect(decodesAsError(() => decodeClientMessage(bytes, RELIABLE)), `sub byte ${bad}`).toBe(true);
    }
    // The same check inside Aim, Use and Attack (OptTarget).
    expect(() => encodeClientMessage({ type: 'aim', seq: 1, moveSeq: 1, use: target(9), mine: null })).toThrow(RangeError);
    expect(() => encodeClientMessage({ type: 'attack', seq: 1, moveSeq: 1, slot: 0, target: target(9) })).toThrow(RangeError);
  });

  it('Use.flags: bit 0 sneak, bits 1..3 the slab mode 0..6; 7 there or a higher bit is an error', () => {
    const use = (slabMode: number, sneak = true): ClientMessage => ({ type: 'use', seq: 7, moveSeq: 6, slot: 2, sneak, slabMode, target: target(1) });
    for (let mode = 0; mode <= 6; mode++) {
      expect(decodeClientMessage(encodeClientMessage(use(mode)), RELIABLE)).toEqual(use(mode));
      expect(decodeClientMessage(encodeClientMessage(use(mode, false)), RELIABLE)).toEqual(use(mode, false));
    }
    for (const bad of [7, 8, -1, 2.5]) expect(() => encodeClientMessage(use(bad)), `slab mode ${bad}`).toThrow(RangeError);
    const base = encodeClientMessage(use(0, false));
    const at = differingByte(base, encodeClientMessage(use(0, true)));
    expect(base[at]).toBe(0);
    expect(encodeClientMessage(use(3, true))[at]).toBe(1 | (3 << 1));
    for (const bad of [7 << 1, (7 << 1) | 1, 0x10, 0x20, 0x80]) {
      const bytes = base.slice();
      bytes[at] = bad;
      expect(decodesAsError(() => decodeClientMessage(bytes, RELIABLE)), `flags 0x${bad.toString(16)}`).toBe(true);
    }
  });

  it('the private view: mining.sub bits 0..3 (octant, one-octant flag), gluing.sub 0; anything else is an error on both ends', () => {
    const mining = (sub: number): TickBatchMsg => ({ ...emptyTickBatch(9), private: { view: { mining: { gridId: 2, x: 4, y: 5, z: 6, sub, progress: 128 / 255 } } } });
    const gluing = (sub: number, progress = 128 / 255): TickBatchMsg => ({
      ...emptyTickBatch(9),
      private: { view: { gluing: { gridId: 2, x: 4, y: 5, z: 6, face: PY, sub, progress } } },
    });
    for (let sub = 0; sub < 16; sub++) expect(decodeServerMessage(encodeServerMessage(mining(sub)), RELIABLE)).toEqual(mining(sub));
    expect(decodeServerMessage(encodeServerMessage(gluing(0)), RELIABLE)).toEqual(gluing(0));
    for (const bad of [16, 0x80, -1, 1.5]) expect(() => encodeServerMessage(mining(bad)), `mining sub ${bad}`).toThrow(RangeError);
    for (const bad of [1, 7, 8]) expect(() => encodeServerMessage(gluing(bad)), `gluing sub ${bad}`).toThrow(RangeError);
    // Decoding: patch the sub byte of a valid encoding.
    const m = encodeServerMessage(mining(0x0e));
    const mAt = differingByte(m, encodeServerMessage(mining(0x0f)));
    for (const bad of [0x10, 0x1f, 0xf0]) {
      const bytes = m.slice();
      bytes[mAt] = bad;
      expect(decodesAsError(() => decodeServerMessage(bytes, RELIABLE)), `mining sub byte ${bad}`).toBe(true);
    }
    // The gluing sub is the byte before its progress.
    const g = encodeServerMessage(gluing(0, 100 / 255));
    const gAt = differingByte(g, encodeServerMessage(gluing(0, 101 / 255))) - 1;
    expect(g[gAt]).toBe(0);
    for (const bad of [1, 8, 0x10]) {
      const bytes = g.slice();
      bytes[gAt] = bad;
      expect(decodesAsError(() => decodeServerMessage(bytes, RELIABLE)), `gluing sub byte ${bad}`).toBe(true);
    }
  });
});

// ====================================================================== the server

interface World {
  sim: Simulation;
  moves: MoveQueue;
  q: IntentQueue;
  a: PlayerControl;
  events: SimEvent[];
  seq: number;
}

/** A flat world, player 'a' client-driven at (0.5, TOP, 0.5); the queues know it (as tests/net/intents.test.ts). */
function world(mode: 'creative' | 'survival' = 'creative'): World {
  const sim = new Simulation({ seed: 3, mode, generator: new FlatGenerator(), syncChunks: true, loadRadius: 2, rabbits: false });
  const a = sim.join('a');
  a.setDrive('client');
  a.takeCorrection();
  const moves = new MoveQueue(sim);
  const q = new IntentQueue(sim, moves, new Replicator(sim));
  moves.join('a', true);
  q.join('a', true);
  const events: SimEvent[] = [];
  sim.events.on((e) => events.push(e));
  const w: World = { sim, moves, q, a, events, seq: 0 };
  report(w);
  tick(w);
  return w;
}

function report(w: World): MoveReport {
  const r = emptyReport();
  r.seq = ++w.seq;
  r.epoch = w.a.player.remote!.epoch;
  r.viewTick = w.sim.ticks;
  r.pos.x = 0.5;
  r.pos.y = TOP;
  r.pos.z = 0.5;
  r.onGround = true;
  w.moves.receive('a', r);
  return r;
}

function tick(w: World, n = 1): void {
  for (let i = 0; i < n; i++) {
    w.moves.beforeTick(false);
    w.q.beforeTick();
    w.sim.tick();
  }
}

let intentSeq = 0;
type Unseq<M> = M extends unknown ? Omit<M, 'seq'> & { seq?: number } : never;
function send(w: World, m: Unseq<IntentMessage>): void {
  w.q.receive('a', { ...m, seq: m.seq ?? ++intentSeq } as IntentMessage);
}

/** The target a client sends for octant `sub` of world cell (x, y, z) entered through `face`, having seen `cell` there. */
function aimAt(x: number, y: number, z: number, sub: number, cell: number, face: Dir = PZ): Target {
  return { gridId: 0, x, y, z, face, sub, cell };
}

describe('the server checks the part at the octant aimed at (check 1, docs/SHAPES.md 6.2 and 6.3)', () => {
  it('the part at `sub` must have the id of the part the client saw there; a change of the other part does not matter', () => {
    const w = world();
    const { sim, q } = w;
    sim.world.setCell(2, TOP, 0, TWO);
    expect(q.check('a', aimAt(2, TOP, 0, 6, TWO), 'plain', w.seq)).toBeNull();
    expect(q.check('a', aimAt(2, TOP, 0, 4, TWO), 'plain', w.seq)).toBeNull();
    // The client saw a full block of stone there: octant 6 is still stone (any shape, any state).
    expect(q.check('a', aimAt(2, TOP, 0, 6, makeCell(B.STONE)), 'plain', w.seq)).toBeNull();
    // ... but octant 4 is planks now.
    expect(q.check('a', aimAt(2, TOP, 0, 4, makeCell(B.STONE)), 'plain', w.seq)).toBe('cell');
    // Someone chisels the planks: the stone the client aims at stands.
    sim.world.setCell(2, TOP, 0, withoutOctant(TWO, 0));
    expect(q.check('a', aimAt(2, TOP, 0, 6, TWO), 'plain', w.seq)).toBeNull();
    // The stone replaced by glass: no target.
    sim.world.setCell(2, TOP, 0, canonCell(PLANKS_LOW, slab(B.GLASS, UPPER)));
    expect(q.check('a', aimAt(2, TOP, 0, 6, TWO), 'plain', w.seq)).toBe('cell');
    // The upper half gone: the octant is empty, no target.
    sim.world.setCell(2, TOP, 0, PLANKS_LOW);
    expect(q.check('a', aimAt(2, TOP, 0, 6, TWO), 'plain', w.seq)).toBe('cell');
    // The ray's predicate applies to the part: a torch is targetable, not for the glue ray.
    sim.world.setCell(3, TOP, 0, makeCell(B.TORCH));
    expect(q.check('a', aimAt(3, TOP, 0, 6, makeCell(B.TORCH)), 'plain', w.seq)).toBeNull();
    expect(q.check('a', aimAt(3, TOP, 0, 6, makeCell(B.TORCH)), 'glue', w.seq)).toBe('ray');
  });

  it('an Attack mines the part aimed at; one whose part was replaced meanwhile is no target and mines nothing', () => {
    const w = world();
    const { sim, q } = w;
    sim.world.setCell(2, TOP, 0, TWO);
    send(w, { type: 'attack', moveSeq: w.seq, slot: 0, target: aimAt(2, TOP, 0, 6, TWO) });
    send(w, { type: 'attackRelease' });
    tick(w, 2);
    expect(getPacked(sim.world, 2, TOP, 0)).toBe(PLANKS_LOW);
    expect(w.events.filter((e) => e.type === 'blockBroken').map((e) => (e as { cell: number }).cell)).toEqual([STONE_UP]);
    // A client that still sees the stone (its replica is behind) aims at it again: the octant is empty now.
    const failed = q.stats('a')!.failed.cell;
    send(w, { type: 'attack', moveSeq: w.seq, slot: 0, target: aimAt(2, TOP, 0, 6, TWO) });
    send(w, { type: 'attackRelease' });
    tick(w, 2);
    expect(q.stats('a')!.failed.cell).toBe(failed + 1);
    expect(getPacked(sim.world, 2, TOP, 0)).toBe(PLANKS_LOW);
    // The planks it saw at octant 4 are there: mined.
    send(w, { type: 'attack', moveSeq: w.seq, slot: 0, target: aimAt(2, TOP, 0, 4, TWO) });
    send(w, { type: 'attackRelease' });
    tick(w, 2);
    expect(getPacked(sim.world, 2, TOP, 0)).toBe(0);
  });

  it('the claimed aim carries the octant: the hands act on the part it names', () => {
    const w = world();
    const { sim, a } = w;
    sim.world.setCell(2, TOP, 0, TWO);
    send(w, { type: 'aim', moveSeq: w.seq, use: aimAt(2, TOP, 0, 6, TWO), mine: aimAt(2, TOP, 0, 4, TWO) });
    tick(w);
    const use = a.hands.raycast()!;
    const mine = a.hands.raycastMining()!;
    expect([use.octant, use.part, use.cell]).toEqual([6, STONE_UP, TWO]);
    expect([mine.octant, mine.part, mine.cell]).toEqual([4, PLANKS_LOW, TWO]);
    // Pick block names the part too.
    send(w, { type: 'pickBlock', moveSeq: w.seq, target: aimAt(2, TOP, 0, 6, TWO) });
    tick(w);
    expect(a.player.inventory.selectedStack()?.item).toBe(B.STONE);
    send(w, { type: 'pickBlock', moveSeq: w.seq, target: aimAt(2, TOP, 0, 4, TWO) });
    tick(w);
    expect(a.player.inventory.selectedStack()?.item).toBe(B.PLANKS_OAK);
  });

  it('Use writes its slab mode into PlayerInput.slabMode before the press', () => {
    const w = world();
    const { a } = w;
    expect(a.player.input.slabMode).toBe(0);
    send(w, { type: 'use', moveSeq: w.seq, slot: 0, sneak: false, slabMode: 4, target: null });
    send(w, { type: 'useRelease' });
    tick(w);
    expect(a.player.input.slabMode).toBe(4);
    send(w, { type: 'use', moveSeq: w.seq, slot: 0, sneak: false, slabMode: 0, target: null });
    tick(w, 2);
    expect(a.player.input.slabMode).toBe(0);
  });
});
