import { describe, expect, it } from 'vitest';
import { CHUNK_VOLUME } from '../../src/core/constants';
import { TerrainGenerator } from '../../src/worldgen/generator';
import { GenService, MAX_GENERATORS, type GenRequest } from '../../src/worldgen/protocol';
import { startGenWorker, type GenWorkerScope } from '../../src/worldgen/worker';
import { chunkHash } from './helpers';

describe('generation worker protocol', () => {
  it('serves chunks identical to direct generation, one generator per seed', () => {
    const service = new GenService();
    const res = service.handle({ type: 'gen', id: 7, seed: 42, cx: 2, cz: -3 });
    expect(res.type).toBe('gen');
    if (res.type !== 'gen') return;
    expect(res.id).toBe(7);
    expect(res.cx).toBe(2);
    expect(res.cz).toBe(-3);
    expect(res.cells.length).toBe(CHUNK_VOLUME);
    expect(chunkHash(res.cells)).toBe(chunkHash(new TerrainGenerator(42).generate(2, -3)));
    expect(service.generator(42)).toBe(service.generator(42));
    expect(service.generator(43)).not.toBe(service.generator(42));
  });

  it('evicts the least recently used seed and stays bounded', () => {
    expect(MAX_GENERATORS).toBe(4);
    const service = new GenService();
    const gens = new Map<number, TerrainGenerator>();
    for (let s = 1; s <= 4; s++) gens.set(s, service.generator(s));
    expect(service.size).toBe(4);
    expect(service.generator(1)).toBe(gens.get(1)); // touch 1: recency is now 2, 3, 4, 1
    service.generator(5); // evicts 2, the least recently used
    expect(service.size).toBe(4);
    // Recency is now 3, 4, 1, 5. Checking 3, 4 and 1 refreshes them in that order...
    expect(service.generator(3)).toBe(gens.get(3));
    expect(service.generator(4)).toBe(gens.get(4));
    expect(service.generator(1)).toBe(gens.get(1));
    expect(service.size).toBe(4);
    // ...so 2 comes back as a NEW generator (it was evicted), which in turn evicts 5.
    const two = service.generator(2);
    expect(two).not.toBe(gens.get(2));
    expect(two.seed).toBe(2);
    expect(service.size).toBe(4);
    expect(service.generator(3)).toBe(gens.get(3));
    expect(service.generator(4)).toBe(gens.get(4));
    expect(service.generator(1)).toBe(gens.get(1));
    expect(service.generator(2)).toBe(two);
    for (let s = 10; s < 30; s++) service.generator(s);
    expect(service.size).toBe(MAX_GENERATORS);
  });

  it('reports malformed requests instead of throwing', () => {
    const service = new GenService();
    const res = service.handle({ type: 'gen', id: 1, seed: 1, cx: 0.5, cz: 0 } as GenRequest);
    expect(res.type).toBe('gen-error');
  });

  it('worker entry replies and transfers the cell buffer', () => {
    const posted: Array<{ msg: unknown; transfer?: Transferable[] }> = [];
    const scope: GenWorkerScope = {
      onmessage: null,
      postMessage(msg, transfer) {
        posted.push({ msg, transfer });
      },
    };
    startGenWorker(scope);
    expect(scope.onmessage).toBeTypeOf('function');
    scope.onmessage!({ data: { type: 'other' } });
    expect(posted.length).toBe(0);
    scope.onmessage!({ data: { type: 'gen', id: 3, seed: 9, cx: 0, cz: 0 } satisfies GenRequest });
    expect(posted.length).toBe(1);
    const { msg, transfer } = posted[0]!;
    const res = msg as { type: string; id: number; cells: Uint16Array };
    expect(res.type).toBe('gen');
    expect(res.id).toBe(3);
    expect(transfer).toEqual([res.cells.buffer]);
  });
});
