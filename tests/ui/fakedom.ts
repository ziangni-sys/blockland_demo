/**
 * A very small DOM for rendering UI views in Node (package 11's view tests): elements with
 * attributes, classes, dataset, children and text, events (click, input, keydown, submit), focus,
 * form values, `closest` / `querySelectorAll` for the simple selectors the views use ('[attr]',
 * '[attr="v"]', '.class', 'tag'), and <template> holding opaque SVG. No layout, no styles beyond
 * what is written. visibleText() reads what a player would see: text outside `hidden` subtrees.
 */

type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: FakeElement | null = null;
  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

export class FakeNode {
  parentNode: FakeElement | null = null;
  readonly childNodes: FakeNode[] = [];
  constructor(readonly ownerDocument: FakeDocument) {}
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes.length = 0;
    if (v !== '') this.appendChild(this.ownerDocument.createTextNode(v));
  }
  appendChild<T extends FakeNode>(n: T): T {
    n.parentNode?.removeChild(n);
    n.parentNode = this as unknown as FakeElement;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n: FakeNode): void {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
  }
  insertBefore(n: FakeNode, ref: FakeNode | null): void {
    if (ref === null) {
      this.appendChild(n);
      return;
    }
    n.parentNode?.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    n.parentNode = this as unknown as FakeElement;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n);
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
  }
  prepend(...nodes: Array<FakeNode | string>): void {
    const list = nodes.map((n) => (typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n));
    for (let i = list.length - 1; i >= 0; i--) this.insertBefore(list[i]!, this.childNodes[0] ?? null);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  contains(n: FakeNode | null): boolean {
    for (let x: FakeNode | null = n; x !== null; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
}

export class FakeText extends FakeNode {
  constructor(
    doc: FakeDocument,
    public data: string,
  ) {
    super(doc);
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = v;
  }
}

function camelToData(k: string): string {
  return `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void };
  readonly dataset: Record<string, string | undefined>;
  value = '';
  disabled = false;
  tabIndex = 0;
  /** <template>: its content. */
  content: { firstElementChild: FakeElement | null } = { firstElementChild: null };

  constructor(doc: FakeDocument, tag: string) {
    super(doc);
    this.tagName = tag.toUpperCase();
    const style = {} as Record<string, string> & { setProperty(k: string, v: string): void };
    Object.defineProperty(style, 'setProperty', {
      value: (k: string, v: string): void => {
        style[k] = v;
      },
      enumerable: false,
    });
    this.style = style;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k) => (typeof k === 'string' ? (this.attrs.get(camelToData(k)) ?? undefined) : undefined),
      set: (_t, k, v) => {
        if (typeof k === 'string') this.attrs.set(camelToData(k), String(v));
        return true;
      },
      deleteProperty: (_t, k) => {
        if (typeof k === 'string') this.attrs.delete(camelToData(k));
        return true;
      },
    });
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  toggleAttribute(k: string, on?: boolean): boolean {
    const v = on ?? !this.attrs.has(k);
    if (v) this.attrs.set(k, '');
    else this.attrs.delete(k);
    return v;
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  get className(): string {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get classList(): { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, on?: boolean): boolean; contains(c: string): boolean } {
    const get = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const put = (l: string[]): void => {
      this.className = l.join(' ');
    };
    return {
      add: (...c) => put([...new Set([...get(), ...c])]),
      remove: (...c) => put(get().filter((x) => !c.includes(x))),
      toggle: (c, on) => {
        const has = get().includes(c);
        const want = on ?? !has;
        if (want && !has) put([...get(), c]);
        if (!want && has) put(get().filter((x) => x !== c));
        return want;
      },
      contains: (c) => get().includes(c),
    };
  }
  get hidden(): boolean {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    this.toggleAttribute('hidden', v);
  }
  set innerHTML(markup: string) {
    // Only <template> with trusted SVG markup: one opaque element named by the first tag.
    const tag = /<([a-zA-Z][\w-]*)/.exec(markup)?.[1] ?? 'span';
    const el = new FakeElement(this.ownerDocument, tag);
    this.content = { firstElementChild: el };
  }
  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type);
    if (l) l.splice(l.indexOf(fn) >>> 0, 1);
  }
  /** Bubbles to the ancestors (like the real events the views use). */
  dispatchEvent(e: FakeEvent): boolean {
    e.target ??= this;
    for (let x: FakeElement | null = this; x !== null && !e.propagationStopped; x = x.parentNode) {
      for (const fn of [...(x.listeners.get(e.type) ?? [])]) fn(e);
    }
    return !e.defaultPrevented;
  }
  /** A click: a submit button also submits its form (no navigation here). */
  click(): void {
    if (this.disabled) return;
    const e = new FakeEvent('click');
    this.dispatchEvent(e);
    if (!e.defaultPrevented && this.tagName === 'BUTTON' && this.getAttribute('type') === 'submit') {
      let f: FakeElement | null = this.parentNode;
      while (f !== null && f.tagName !== 'FORM') f = f.parentNode;
      f?.dispatchEvent(new FakeEvent('submit'));
    }
  }
  /** Type `text` into a field: sets the value and fires 'input'. */
  type(text: string): void {
    this.value = text;
    this.dispatchEvent(new FakeEvent('input'));
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  select(): void {}
  matches(sel: string): boolean {
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attr) return this.attrs.has(attr[1]!) && (attr[2] === undefined || this.attrs.get(attr[1]!) === attr[2]);
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest<E = FakeElement>(sel: string): E | null {
    for (let x: FakeElement | null = this; x !== null; x = x.parentNode) if (x.matches(sel)) return x as unknown as E;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly defaultView = null;
  copied: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** A key pressed with the focus nowhere in particular (the document's listeners hear it). */
  key(key: string, init: Record<string, unknown> = {}): FakeEvent {
    const e = new FakeEvent('keydown', { key, repeat: false, ...init });
    for (const fn of [...(this.listeners.get('keydown') ?? [])]) fn(e);
    return e;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }
  execCommand(cmd: string): boolean {
    if (cmd !== 'copy') return false;
    const a = this.activeElement;
    if (a) this.copied.push(a.value);
    return a !== null;
  }
}

/**
 * The text a player sees in `n` (a screen's root counts as shown: the UI root reveals the active
 * one): text nodes outside hidden subtrees and the values of fields, whitespace collapsed.
 */
export function visibleText(n: FakeNode): string {
  const parts: string[] = [];
  const walk = (x: FakeNode): void => {
    if (x instanceof FakeText) parts.push(x.data);
    else if (x instanceof FakeElement) {
      if (x.hidden && x !== n) return;
      for (const c of x.childNodes) walk(c);
      if (x.tagName === 'INPUT' || x.tagName === 'TEXTAREA') parts.push(` [${x.value}] `);
    }
  };
  walk(n);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Whether `el` and every ancestor below `root` are shown (`root` itself counts as shown). */
export function shown(el: FakeElement, root: FakeElement): boolean {
  for (let x: FakeElement | null = el; x !== null; x = x.parentNode) {
    if (x === root) return true;
    if (x.hidden) return false;
  }
  return true;
}
