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

export class UiContext {
  lang: Language = 'zh';
  private readonly bindings: TextBinding[] = [];
  private idSeq = 0;

  constructor(
    readonly doc: Document,
    readonly actions: UiActions,
    readonly icons: IconCache,
    /** Backing-store edge of item icons in px (accounts for devicePixelRatio). */
    readonly iconSize: number,
    private readonly reducedMotionQuery: MediaQueryList | null,
  ) {}

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

  /** Unique id for label / aria wiring within this UI instance. */
  id(prefix: string): string {
    this.idSeq++;
    return `bl-${prefix}-${this.idSeq.toString(36)}`;
  }
}
