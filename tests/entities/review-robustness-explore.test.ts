import { describe, it } from 'vitest';
import { vec3 } from '../../src/core/math';
import { ByteReader, ByteWriter } from '../../src/save/bytes';
import { B, Bench, deck, fill, qfromYaw, TICK_DT } from './harness';

const DT = TICK_DT;

describe('explore 4', () => {
  it('syncCarried twice within a tick', () => {
    const b = new Bench();
    const ship = b.ship(1, deck(-5, -5, 5, 5, 60), vec3(0.5, 60.5, 0.5));
    b.drive(ship, (t) => ({ p: vec3(0.5 + 5 * t * DT, 60.5, 0.5), q: qfromYaw(0) }));
    const p = b.entities.createPlayer('survival', 0.5, 61, 0.5);
    b.tick(20);
    const l0 = ship.grid.toLocal(p.pos, vec3());
    // one tick done by hand with a duplicate syncCarried
    b.world.time++;
    for (const s of b.host.list) s.grid.snapshotPose();
    for (const m of b.motions) m(++b.ticks);
    b.entities.syncCarried();
    b.entities.syncCarried();
    b.entities.update();
    b.tick(10);
    const l1 = ship.grid.toLocal(p.pos, vec3());
    console.log('twice within tick', l0.x.toFixed(3), '->', l1.x.toFixed(3));
  });

  it('non-atomic deserialize', () => {
    const b = new Bench();
    fill(b.world, -10, 59, -10, 10, 59, 10, B.STONE);
    const p = b.entities.createPlayer('survival', 0.5, 60, 0.5);
    b.entities.spawnItem(2.5, 60.2, 2.5, B.STONE, 3, vec3());
    b.tick(3);
    const w = new ByteWriter();
    b.entities.serialize(w);
    const bytes = w.finish();
    // truncated save
    const cut = bytes.slice(0, bytes.length - 5);
    const b2 = new Bench();
    b2.entities.createPlayer('creative', 1.5, 60, 1.5);
    b2.entities.spawnRabbit(3.5, 60, 3.5);
    try {
      b2.entities.deserialize(new ByteReader(cut));
    } catch (err) {
      console.log('threw', (err as Error).message);
    }
    console.log('after failed load: entities', b2.entities.all().length, 'player', b2.entities.player?.mode, b2.entities.all().map((e) => e.kind).join(','));
  });
});
