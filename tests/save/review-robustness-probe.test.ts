import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage, openBestStorage } from '../../src/save/idb';
import { MemoryStorage } from '../../src/save/storage';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';

let n = 0;
const fresh = (): string => `probe-${++n}`;
const meta = (id: string): WorldMeta => ({
  id,
  name: id,
  seed: 's',
  seedHash: 1,
  mode: 'creative',
  createdAt: 1,
  lastPlayed: 1,
  version: SAVE_VERSION,
  time: 0,
});

describe('probe', () => {
  it('call issued after close() during initial open', async () => {
    const s = new IdbStorage(fresh());
    const first = s.getMeta('w');
    s.close();
    const second = s.getMeta('w');
    const r1 = await first.then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, e: e.message }),
    );
    const r2 = await second.then(
      (v) => ({ ok: true, v }),
      (e: Error) => ({ ok: false, e: e.message }),
    );
    console.log('first', r1, 'second', r2);
  });

  it('close() right after a call on an open connection', async () => {
    const s = await IdbStorage.open(fresh());
    const p = s.putMeta(meta('w'));
    s.close();
    const r = await p.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    console.log('put after close', r, 'db reopened?', (s as unknown as { db: unknown }).db !== null);
  });

  it('openBestStorage with empty dbName', async () => {
    const r = await openBestStorage('');
    console.log('empty name ->', r.persistent, r.storage instanceof MemoryStorage);
  });
});
