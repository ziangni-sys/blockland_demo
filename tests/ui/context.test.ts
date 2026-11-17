/**
 * UiContext ids: unique per document, not per UI instance. Two createUi() instances in one
 * page (HMR without dispose, a second overlay) must not both mint `bl-logo-1`: instance 2's
 * <label for> would point at instance 1's inputs and its logo's url(#gradient) references
 * would resolve into instance 1's hidden copy (review finding). UiContext touches the
 * document only as an object to keep the counter on, so this runs in Node.
 */
import { describe, expect, it } from 'vitest';
import { UiContext } from '../../src/ui/context';
import type { IconCache } from '../../src/ui/icons';
import type { UiActions } from '../../src/ui/model';

function makeCtx(doc: Document): UiContext {
  return new UiContext(doc, {} as UiActions, {} as IconCache, 64, null);
}

describe('UiContext.id', () => {
  it('never repeats an id between two UI instances sharing a document', () => {
    const doc = {} as Document;
    const a = makeCtx(doc);
    const b = makeCtx(doc);
    const prefixes = ['logo', 'worlds', 'wname', 'wseed'];
    const idsA = prefixes.map((p) => a.id(p));
    const idsB = prefixes.map((p) => b.id(p));
    for (const id of idsB) expect(idsA).not.toContain(id);
    expect(new Set([...idsA, ...idsB]).size).toBe(8);
  });

  it('keeps separate documents independent and readable', () => {
    const a = makeCtx({} as Document);
    const b = makeCtx({} as Document);
    expect(a.id('logo')).toBe('bl-logo-1');
    expect(b.id('logo')).toBe('bl-logo-1');
    expect(a.id('worlds')).toBe('bl-worlds-2');
  });
});
