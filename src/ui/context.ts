/**
 * Per-UI-instance services shared by every view: actions, icon cache, translation with
 * automatic re-localization of static text, and id generation. One instance per createUi
 * call; nothing here is module-level.
 */
import { t, type Params, type StringKey } from './i18n';
import type { IconCache } from './icons';
import type { Language, UiActions } from './model';

interface TextBinding {
  el: Element;
  key: StringKey;
  /** null = textContent, otherwise the attribute name. */
  attr: string | null;
  params: Params | undefined;
}

/**
 * Key of the id counter kept on the Document object itself. Ids must be unique per document,
 * not per UI instance: two instances in one page (HMR without dispose, a second overlay)
 * would otherwise both mint `bl-logo-1`, so instance 2's <label for> would point at instance
 * 1's inputs and its logo's url(#gradient) references would resolve into instance 1's hidden
 * copy and paint nothing. Storing the counter on the document keeps it out of module state.
 */
const ID_SEQ = Symbol.for('blocklands.ui.idSeq');

export class UiContext {
  lang: Language = 'zh';
  /**
   * Backing-store edge of item icons in px (accounts for devicePixelRatio). Changes when the
   * page moves to a screen with another pixel ratio or is zoomed; views then repaint.
   */
  iconSize: number;
  private readonly bindings: TextBinding[] = [];

  constructor(
    readonly doc: Document,
    readonly actions: UiActions,
    readonly icons: IconCache,
    iconSize: number,
    private readonly reducedMotionQuery: MediaQueryList | null,
  ) {
    this.iconSize = iconSize;
  }

  get reducedMotion(): boolean {
    return this.reducedMotionQuery ? this.reducedMotionQuery.matches : false;
  }

  t(key: StringKey, params?: Params): string {
    return t(this.lang, key, params);
  }

  /** Set an element's text from the table and keep it translated on language changes. */
  text<E extends Element>(el: E, key: StringKey, params?: Params): E {
    el.textContent = t(this.lang, key, params);
    this.bindings.push({ el, key, attr: null, params });
    return el;
  }

  /** Same as text() for an attribute (placeholder, aria-label, title ...). */
  attr<E extends Element>(el: E, name: string, key: StringKey, params?: Params): E {
    el.setAttribute(name, t(this.lang, key, params));
    this.bindings.push({ el, key, attr: name, params });
    return el;
  }

  /** Re-apply every bound string after `lang` changed. */
  relocalize(): void {
    for (const b of this.bindings) {
      const v = t(this.lang, b.key, b.params);
      if (b.attr === null) {
        if (b.el.textContent !== v) b.el.textContent = v;
      } else if (b.el.getAttribute(b.attr) !== v) {
        b.el.setAttribute(b.attr, v);
      }
    }
  }

  /** Id for label / aria / SVG-reference wiring, unique within the document. */
  id(prefix: string): string {
    const holder = this.doc as unknown as Record<symbol, number | undefined>;
    const n = (holder[ID_SEQ] ?? 0) + 1;
    holder[ID_SEQ] = n;
    return `bl-${prefix}-${n.toString(36)}`;
  }
}
