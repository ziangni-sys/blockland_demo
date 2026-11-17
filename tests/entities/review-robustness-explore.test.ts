import { describe, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { ByteWriter } from '../../src/save/bytes';
import { B, Bench } from './harness';

describe('explore 8', () => {
  it('spawnItem garbage counts', () => {
    const b = new Bench();
    b.entities.createPlayer('survival', 0.5, 61, 0.5);
    const a = b.entities.spawnItem(3.5, 61, 0.5, B.STONE, 0, vec3());
    const c = b.entities.spawnItem(3.5, 61, 0.5, B.STONE, -5, vec3());
    const d = b.entities.spawnItem(3.5, 61, 0.5, B.STONE, NaN, vec3());
    console.log('counts', a.stack.count, c.stack.count, d.stack.count);
    try {
      b.entities.serialize(new ByteWriter());
      console.log('serialize ok');
    } catch (e) {
      console.log('serialize threw', (e as Error).message);
    }
  });
});
