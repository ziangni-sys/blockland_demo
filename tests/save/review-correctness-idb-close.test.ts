/**
 * Adversarial review (correctness): IdbStorage.close() while the first open is still in
 * flight.
 *
 * idb.ts documents close() as "the next operation reopens the database". But close() only
 * bumps `generation` and leaves `this.connecting` pointing at the stale open. Any call made
 * AFTER close() but before that stale open settles awaits the same promise, and is rejected
 * with "storage was closed while opening", although it was issued after the close.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStorage } from '../../src/save/idb';

let n = 0;
const freshName = (): string => `blocklands-review-close-${++n}`;

describe('review: IdbStorage.close() during the initial open', () => {
  it('a call issued after close() reopens instead of inheriting the cancelled open', async () => {
    const s = new IdbStorage(freshName());
    const before = s.getMeta('w'); // starts the lazy open
    s.close(); // cancels that open
    const after = s.getMeta('w'); // issued after close(): must open a fresh connection
    await expect(before).rejects.toThrow(/closed while opening/);
    await expect(after).resolves.toBeNull(); // FAILS: rejects with "closed while opening"
    s.close();
  });

  it('an abandoned warm-up call followed by close() does not poison the next write', async () => {
    const s = new IdbStorage(freshName());
    void s.ping().catch(() => undefined); // e.g. a warm-up ping the caller abandons
    s.close();
    await expect(s.putBlob('w', 'glue', Uint8Array.of(1))).resolves.toBeUndefined(); // FAILS
    expect(await s.getBlob('w', 'glue')).toEqual(Uint8Array.of(1));
    s.close();
  });
});
