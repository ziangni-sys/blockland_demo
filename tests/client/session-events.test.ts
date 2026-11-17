/**
 * The client plays one player of a simulation (WorldSession.me): world events and the events
 * addressed to that player reach it; events addressed to other players do not.
 */
import { describe, expect, it } from 'vitest';
import { WorldSession } from '../../src/client/session';
import type { RenderBackend } from '../../src/render/backend';
import { Simulation } from '../../src/sim/simulation';
import type { SimEvent } from '../../src/sim/view';
import { FlatGenerator } from '../../src/worldgen/generator';

function nullBackend(): RenderBackend {
  const noop = (): void => undefined;
  return {
    init: async () => ({ api: 'webgl2', detail: 'fake' }),
    setTiles: noop,
    setSectionMesh: noop,
    setStructureMesh: noop,
    setStructurePose: noop,
    setStructureDryVolume: noop,
    setEntities: noop,
    setCamera: noop,
    setEnvironment: noop,
    setOverlays: noop,
    resize: noop,
    render: noop,
    stats: () => ({ drawCalls: 0, triangles: 0, sections: 0, structures: 0 }),
    dispose: noop,
  };
}

describe('WorldSession events', () => {
  it('forwards world events and the events addressed to its own player only', () => {
    const gen = new FlatGenerator();
    const sim = new Simulation({ seed: 1, mode: 'survival', generator: gen, syncChunks: true, loadRadius: 1, rabbits: false });
    const me = sim.join('me');
    sim.join('other');
    const got: SimEvent[] = [];
    const s = new WorldSession(sim, me, { id: 'x', name: 'x', seed: '', seedHash: 1, mode: 'survival', createdAt: 0, lastPlayed: 0, version: 1, time: 0 }, gen, true, {
      backend: nullBackend(),
      genPool: null,
      meshPool: null,
      now: () => 0,
      onError: () => undefined,
      onEvent: (ev) => got.push(ev),
    });
    const sent: SimEvent[] = [
      { type: 'toast', player: 'me', message: { key: 'toast.glue.added' }, kind: 'info' },
      { type: 'toast', player: 'other', message: { key: 'toast.glue.added' }, kind: 'info' },
      { type: 'playerHurt', player: 'other', amount: 2, cause: 'fall' },
      { type: 'playerHurt', player: 'me', amount: 3, cause: 'fall' },
      { type: 'sound', name: 'fuse', x: 1, y: 2, z: 3 },
      { type: 'playerPickup', player: 'other', item: 1, count: 1 },
    ];
    for (const ev of sent) sim.events.emit(ev);
    expect(got).toEqual([sent[0], sent[3], sent[4]]);
    s.dispose();
  });
});
