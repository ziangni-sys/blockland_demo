/**
 * The test world of the acceptance tests (tests/acceptance/world.ts, scenario 30 of docs/NETCODE.md
 * section 16) runs the same ticks in both modes: every wait the network mode needs (READY, SYNC,
 * TELEPORT, the commands, HOLD, HELM) runs in direct mode too, so tick counts match. The same
 * script runs in a direct and a network world side by side and must leave both at the same tick
 * after every step. The parity of whole acceptance runs is checked by tests/acceptance/tick-parity.ts;
 * its comparison is tested here as well.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { makeCell } from '../../src/blocks/cell';
import { PY } from '../../src/core/dirs';
import { FlatGenerator } from '../../src/worldgen/generator';
import { tickMismatches } from '../acceptance/tick-parity';
import { finishWorlds, testWorld, type TestWorld, type WorldMode } from '../acceptance/world';

// Outside the acceptance projects: run the end checks of the worlds, log no tick counts.
afterEach(() => finishWorlds('test', false));

const T = 35;

function flat(mode: WorldMode): TestWorld {
  return testWorld({ seed: 3, mode: 'creative', generator: new FlatGenerator(), syncChunks: true, rabbits: false, loadRadius: 2, spawn: { x: 0.5, y: T, z: 0.5 } }, mode);
}

describe('TestWorld: the same ticks in both modes', () => {
  it('every wait (READY, SYNC, TELEPORT, the commands, HOLD, HELM) runs in both modes', () => {
    const worlds = [flat('direct'), flat('network')];
    const steps: Array<[string, (w: TestWorld) => void]> = [
      ['built', () => {}],
      ['read only', (w) => void w.me.player.pos.x],
      ['READY', (w) => void (w.me.input.forward = 0)],
      ['ticks', (w) => w.tick(3)],
      ['SYNC', (w) => {
        w.sim.world.setCell(2, T, 0, makeCell(B.STONE));
        expect(w.me.aimAt(2, T, 0, PY)).toBe(true);
      }],
      ['no SYNC without a change', (w) => void w.me.aimAt(2, T, 0, PY)],
      ['TELEPORT', (w) => w.me.teleport(0.5, T, 2.5)],
      ['Give', (w) => w.me.giveItem(B.PLANKS_OAK, 3)],
      ['SetPlayerMode', (w) => w.me.setMode('survival')],
      ['HOLD of an item in the hotbar', (w) => w.me.hold(B.PLANKS_OAK)],
      ['HOLD of an item not in it', (w) => w.me.hold(B.STONE, 1)],
      ['useOn', (w) => expect(w.me.useOn(2, T, 0, PY)).toBe(true)],
      ['HELM', (w) => {
        w.me.hold(B.HELM, 1);
        expect(w.me.useOn(0, T - 1, 4, PY)).toBe(true);
      }],
      ['Respawn', (w) => w.me.respawn()],
      ['ReleaseHelm', (w) => w.me.releaseHelm()],
    ];
    const t0 = worlds.map((w) => w.sim.ticks);
    const ticks: Record<string, number[]> = {};
    for (const [name, step] of steps) {
      for (const w of worlds) step(w);
      ticks[name] = worlds.map((w, i) => w.sim.ticks - t0[i]!);
    }
    for (const [name, [d, n]] of Object.entries(ticks)) expect(n, `${name}: network ${n} ticks, direct ${d}`).toBe(d);
    // and the waits really ran (in both modes)
    expect(ticks['built']![0]).toBe(0);
    expect(ticks['read only']![0]).toBe(0);
    expect(ticks['READY']![0]).toBe(2);
    expect(ticks['SYNC']![0]! - ticks['ticks']![0]!).toBe(1);
    expect(ticks['no SYNC without a change']![0]).toBe(ticks['SYNC']![0]);
    expect(ticks['TELEPORT']![0]! - ticks['no SYNC without a change']![0]!).toBe(2);
    expect(ticks['HOLD of an item in the hotbar']![0]).toBe(ticks['SetPlayerMode']![0]);
    expect(ticks['HOLD of an item not in it']![0]! - ticks['HOLD of an item in the hotbar']![0]!).toBe(1);
  });
});

describe('tick parity of the acceptance projects (tests/acceptance/tick-parity.ts)', () => {
  it('lists the worlds both projects logged with different tick counts, and only those', () => {
    const direct = new Map([
      ['a > t > world 0', 10],
      ['a > t > world 1', 4],
      ['a > only direct > world 0', 7],
    ]);
    const network = new Map([
      ['a > t > world 0', 10],
      ['a > t > world 1', 6],
      ['a > only network > world 0', 9],
    ]);
    expect(tickMismatches(direct, network)).toEqual(['a > t > world 1: direct 4 ticks, network 6']);
    expect(tickMismatches(direct, direct)).toEqual([]);
  });
});
