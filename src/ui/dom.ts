/**
 * Small DOM helpers shared by the views. Browser-only (never imported by tests).
 */

type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;
type Child = Node | string | null | undefined | false;

/**
 * Create an element. `cls` is the class list; `attrs` become attributes (`true` -> present,
 * false/null/undefined -> omitted); children may be nodes or strings.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string | null,
  attrs?: Attrs | null,
  children?: readonly Child[],
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (attrs) applyAttrs(el, attrs);
  if (children) append(el, children);
  return el;
}

export function applyAttrs(el: Element, attrs: Attrs): void {
  for (const name in attrs) {
    const v = attrs[name];
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(name, v === true ? '' : String(v));
  }
}

export function append(el: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? el.ownerDocument!.createTextNode(c) : c);
  }
}

/**
 * Parse a static SVG snippet (trusted, authored in this module) into an element. Using the
 * HTML parser via a <template> keeps the markup readable and correctly namespaced.
 */
export function svg(doc: Document, markup: string, cls?: string): SVGSVGElement {
  const tpl = doc.createElement('template');
  tpl.innerHTML = markup.trim();
  const el = tpl.content.firstElementChild as SVGSVGElement;
  if (cls) el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  return el;
}

/** Text node wrapper that writes the DOM only when the string actually changes. */
export class TextSlot {
  readonly node: Text;
  private value: string;

  constructor(doc: Document, initial = '') {
    this.value = initial;
    this.node = doc.createTextNode(initial);
  }
  set(v: string): void {
    if (v === this.value) return;
    this.value = v;
    this.node.data = v;
  }
  get(): string {
    return this.value;
  }
}

/** Set an attribute only when its value changes (null removes it). */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

/** Toggle the `hidden` attribute without touching the DOM when it is already right. */
export function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** Restart a CSS animation bound to `cls` (forces one style flush; call on change only). */
export function restartAnimation(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
