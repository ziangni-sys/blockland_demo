/**
 * Adversarial review (robustness): IdbStorage.close() is silently undone by a call that was
 * issued just before it.
 *
 * run() awaits connection() (already resolved) before calling db.transaction(). If close()
 * runs in between — i.e. in the same synchronous block as the call — db.transaction() throws
 * InvalidStateError, and run()'s "connection was closed under us, retry once" path opens a
 * BRAND NEW connection and stores it in `this.db`. The storage is open again although close()
 * was the last thing the caller did, and the reconnect even bypasses the close() generation
 * check. close() is documented as "Close the connection. Transactions already started still
 * finish; the next operation reopens the database" — a call issued *before* close() is not
 * "the next operation".
 *
 * Typical trigger: `void storage.putAll(...)` (fire-and-forget save on quit) followed by
 * `storage.close()`, or openBestStorage's give-up path closing a storage while a caller still
 * has a request in flight.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IdbStorage } from '../../src/save/idb';
import { SAVE_VERSION, type WorldMeta } from '../../src/save/codec';

let n = 0;
const freshName = (): string => `blocklands-review-robust-close-${++n}`;
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

/** Count IDBFactory.open() calls made through the global factory. */
function countOpens(): { readonly count: number; restore(): void } {
  const factory = indexedDB as IDBFactory & { open: IDBFactory['open'] };
  const real = factory.open;
  let count = 0;
  factory.open = function (this: IDBFactory, name: string, version?: number) {
    count++;
    return real.call(this, name, version);
  } as IDBFactory['open'];
  return {
    get count() {
      return count;
    },
    restore() {
      factory.open = real;
    },
  };
}

describe('review: IdbStorage.close() right after issuing a call', () => {
  let opens: ReturnType<typeof countOpens> | null = null;
  afterEach(() => opens?.restore());

  it('does not reopen the database for a call issued before close()', async () => {
    const s = await IdbStorage.open(freshName());
    opens = countOpens();
    const pending = s.putMeta(meta('w')); // issued BEFORE close()
    s.close();
    await pending.catch(() => undefined); // completing or rejecting are both acceptable
    // FAILS: run() caught InvalidStateError and silently opened a fresh connection, so the
    // storage holds an open connection again after close().
    expect(opens.count).toBe(0);
    s.close();
  });
});
