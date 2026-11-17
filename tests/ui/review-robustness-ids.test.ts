/**
 * Review (robustness): element ids must be unique per document, not just per UI instance.
 *
 * The views wire <label for>, aria-labelledby and — critically — the logo's SVG gradient
 * url(#id) references through UiContext.id(). The counter lives on each UiContext, so two
 * createUi() instances in one document (HMR without dispose, a second overlay, tests that
 * mount twice) produce identical ids: instance 2's labels then point at instance 1's inputs
 * and its logo gradients resolve into instance 1's hidden copy, rendering empty faces.
 *
 * UiContext never touches the document in its constructor or in id(), so this runs in Node.
 */
import { describe, expect, it } from 'vitest';
import { UiContext } from '../../src/ui/context';
import type { IconCache } from '../../src/ui/icons';
import type { UiActions } from '../../src/ui/model';

function makeCtx(doc: Document): UiContext {
  return new UiContext(doc, {} as UiActions, {} as IconCache, 64, null);
}

describe('UiContext.id across instances (review)', () => {
  it('two UI instances sharing one document never generate the same id', () => {
    const doc = {} as Document; // the same document for both instances
    const a = makeCtx(doc);
    const b = makeCtx(doc);
    const idsA = ['logo', 'worlds', 'wname', 'wseed'].map((p) => a.id(p));
    const idsB = ['logo', 'worlds', 'wname', 'wseed'].map((p) => b.id(p));
    for (const id of idsB) expect(idsA).not.toContain(id);
  });
});
