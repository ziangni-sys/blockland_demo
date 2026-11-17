/**
 * Reusable widgets: item slots, buttons, segmented controls, switches, key-cap tables and
 * the logotype. Browser-only.
 */
import { CONTROLS, isKeyRef, type ControlRow, type KeyToken } from '../controls';
import type { UiContext } from '../context';
import { formatCount } from '../format';
import type { StringKey } from '../i18n';
import type { Language, SlotView } from '../model';
import { itemName } from '../palette';
import { h, setAttr, svg, TextSlot } from '../dom';

// ------------------------------------------------------------------ inline icons
// Authored here (no external assets). Stroke styling comes from the stylesheet.

export const ICON_SLIDERS =
  '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';
export const ICON_TRASH =
  '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5.5M13.5 10.5v5.5"/></svg>';
export const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
export const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>';
export const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>';
export const ICON_BACK = '<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>';
export const ICON_RESUME = ICON_PLAY;
export const ICON_SAVE = '<svg viewBox="0 0 24 24"><path d="M6 4h10l3 3v13H5V4zM8 4v5h7V4M8 20v-6h8v6"/></svg>';
export const ICON_RESPAWN = '<svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 0 2.2-5.1M5 4.5V9h4.5"/></svg>';

/**
 * Logomark: an isometric block in brass with a four-sail rotor on its right face — the
 * game's thesis (blocks that move) in one glyph. Construction lines extend from the edges
 * like a drafting sketch.
 */
const logoMark = (id: string): string => `
<svg viewBox="0 0 64 64">
  <defs>
    <linearGradient id="${id}-top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1c9"/><stop offset="1" stop-color="#e2bb6b"/></linearGradient>
    <linearGradient id="${id}-left" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c99a45"/><stop offset="1" stop-color="#8c6829"/></linearGradient>
    <linearGradient id="${id}-right" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a5d8c"/><stop offset="1" stop-color="#172b47"/></linearGradient>
  </defs>
  <g fill="none" stroke="#9cc8f0" stroke-width="0.5" stroke-dasharray="1.5 1.5" opacity="0.6">
    <path d="M32 6 L32 0.5 M8 19 L1.5 15.5 M56 19 L62.5 15.5 M32 58 L32 63.5"/>
  </g>
  <path d="M32 6 L56 19 L32 32 L8 19 Z" fill="url(#${id}-top)"/>
  <path d="M8 19 L32 32 L32 58 L8 45 Z" fill="url(#${id}-left)"/>
  <path d="M32 32 L56 19 L56 45 L32 58 Z" fill="url(#${id}-right)"/>
  <path d="M32 6 L56 19 L56 45 L32 58 L8 45 L8 19 Z M8 19 L32 32 L56 19 M32 32 L32 58" fill="none" stroke="#fff1c9" stroke-width="1" stroke-linejoin="round"/>
  <path d="M14 22.3 L26 28.8 M20 16 L44 3.1" fill="none" stroke="#5b431a" stroke-width="0.6" opacity="0.5"/>
  <g fill="#f2e7cf" stroke="#d5a957" stroke-width="0.5" stroke-linejoin="round">
    <path d="M44 36.5 L44 27.5 L47.1 25.8 L47.1 34.8 Z"/>
    <path d="M45.8 37.5 L53.7 33.3 L53.7 36.8 L45.8 41 Z"/>
    <path d="M44 40.5 L44 49.5 L40.9 51.2 L40.9 42.2 Z"/>
    <path d="M42.2 39.5 L34.3 43.7 L34.3 40.2 L42.2 36 Z"/>
  </g>
  <circle cx="44" cy="38.5" r="1.9" fill="#ebc77a" stroke="#5b431a" stroke-width="0.6"/>
</svg>`;

/** Logotype: mark + "BLOCKLANDS" + 方块大陆 set as a drafting dimension line. */
export function buildLogo(ctx: UiContext, small = false): HTMLElement {
  const d = ctx.doc;
  const word = h(d, 'h1', 'bl-logo-word');
  ctx.text(word, 'brand.name');
  const zh = h(d, 'span');
  ctx.text(zh, 'brand.nameZh');
  return h(d, 'div', small ? 'bl-logo bl-logo--sm' : 'bl-logo', { role: 'img', 'aria-label': 'Blocklands 方块大陆' }, [
    // Gradient ids must be unique per instance: a url(#id) that resolves into a hidden
    // (display:none) copy of the mark renders nothing in Chromium.
    svg(d, logoMark(ctx.id('logo')), 'bl-logo-mark'),
    h(d, 'div', 'bl-logo-text', null, [word, h(d, 'div', 'bl-logo-dim', null, [h(d, 'i'), zh, h(d, 'i')])]),
  ]);
}

// ------------------------------------------------------------------ buttons

export interface ButtonOpts {
  variant?: 'primary' | 'ghost' | 'danger' | 'solid-danger' | 'plain';
  icon?: string;
  /** Label string key; omitted for icon-only buttons (give `aria` then). */
  label?: StringKey;
  aria?: StringKey;
  cls?: string;
  onClick: (e: MouseEvent) => void;
}

export function button(ctx: UiContext, opts: ButtonOpts): HTMLButtonElement {
  const d = ctx.doc;
  const variant = opts.variant ?? 'plain';
  let cls = 'bl-btn';
  if (variant !== 'plain') cls += ` bl-btn--${variant}`;
  if (!opts.label) cls += ' bl-btn--icon';
  if (opts.cls) cls += ` ${opts.cls}`;
  const b = h(d, 'button', cls, { type: 'button' });
  if (opts.icon) b.appendChild(svg(d, opts.icon));
  if (opts.label) b.appendChild(ctx.text(h(d, 'span', 'bl-btn-label'), opts.label));
  if (opts.aria) ctx.attr(b, 'aria-label', opts.aria);
  b.addEventListener('click', opts.onClick);
  return b;
}

// ------------------------------------------------------------------ segmented control

export interface SegOption<T extends string> {
  value: T;
  /** Translated label, or a literal (language names are never translated). */
  label: StringKey | { literal: string };
}

/** Radio-group of buttons; arrow keys move the choice, as for native radios. */
export class Segmented<T extends string> {
  readonly el: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private value: T | null = null;

  constructor(
    ctx: UiContext,
    private readonly options: ReadonlyArray<SegOption<T>>,
    labelKey: StringKey,
    private readonly onPick: (v: T) => void,
  ) {
    const d = ctx.doc;
    this.el = h(d, 'div', 'bl-seg-ctl', { role: 'radiogroup' });
    ctx.attr(this.el, 'aria-label', labelKey);
    for (const opt of options) {
      const b = h(d, 'button', null, { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-value': opt.value });
      if (typeof opt.label === 'string') ctx.text(b, opt.label);
      else b.textContent = opt.label.literal;
      b.addEventListener('click', () => this.pick(opt.value, false));
      this.buttons.push(b);
      this.el.appendChild(b);
    }
    this.el.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (dir === 0) return;
      e.preventDefault();
      const cur = Math.max(0, this.options.findIndex((o) => o.value === this.value));
      const next = (cur + dir + this.options.length) % this.options.length;
      this.pick(this.options[next]!.value, true);
    });
  }

  private pick(v: T, focus: boolean): void {
    this.set(v);
    if (focus) this.buttons[this.options.findIndex((o) => o.value === v)]?.focus();
    this.onPick(v);
  }

  /** Reflect the current value (no callback). */
  set(v: T): void {
    if (v === this.value) return;
    this.value = v;
    for (let i = 0; i < this.buttons.length; i++) {
      const on = this.options[i]!.value === v;
      const b = this.buttons[i]!;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      // Roving tabindex: only the checked option is in the tab order.
      b.tabIndex = on ? 0 : -1;
    }
  }

  get(): T | null {
    return this.value;
  }
}

// ------------------------------------------------------------------ switch

export class Switch {
  readonly el: HTMLButtonElement;
  private readonly text: HTMLElement;
  private checked: boolean | null = null;

  constructor(
    private readonly ctx: UiContext,
    labelledBy: string,
    private readonly onToggle: (v: boolean) => void,
  ) {
    const d = ctx.doc;
    this.text = h(d, 'span', 'bl-switch-text');
    this.el = h(d, 'button', 'bl-switch bl-field-ctl', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': labelledBy }, [
      h(d, 'span', 'bl-switch-track'),
      this.text,
    ]);
    this.el.addEventListener('click', () => {
      const v = !this.checked;
      this.set(v);
      this.onToggle(v);
    });
  }

  set(v: boolean, force = false): void {
    if (v === this.checked && !force) return;
    this.checked = v;
    this.el.setAttribute('aria-checked', v ? 'true' : 'false');
    this.text.textContent = this.ctx.t(v ? 'settings.on' : 'settings.off');
  }

  relocalize(): void {
    if (this.checked !== null) this.set(this.checked, true);
  }
}

// ------------------------------------------------------------------ key-cap tables

/**
 * Mouse buttons are drawn as a tiny mouse with the button lit, not spelled out: the same
 * compact cap in both languages ("Right click" would otherwise be the widest key in every
 * table). The caption stays available to screen readers and as a tooltip.
 */
const MOUSE_CAPS: Readonly<Record<string, 'l' | 'r' | 'w'>> = { 'key.leftClick': 'l', 'key.rightClick': 'r', 'key.wheel': 'w' };

function mouseGlyph(which: 'l' | 'r' | 'w'): string {
  const on = (b: 'l' | 'r' | 'w'): string => (b === which ? ' is-on' : '');
  return `<svg viewBox="0 0 14 18">
    <path class="bl-m-btn${on('l')}" d="M7 2v5.5H2V7a5 5 0 0 1 5-5z"/>
    <path class="bl-m-btn${on('r')}" d="M7 2v5.5h5V7a5 5 0 0 0-5-5z"/>
    <rect class="bl-m-body" x="2" y="2" width="10" height="14" rx="5"/>
    <path class="bl-m-body" d="M7 2v5.5M2 7.5h10"/>
    ${which === 'w' ? '<rect class="bl-m-wheel" x="5.6" y="3" width="2.8" height="4" rx="1.4"/>' : ''}
  </svg>`;
}

function keyTokens(ctx: UiContext, tokens: readonly KeyToken[]): HTMLElement {
  const d = ctx.doc;
  const dt = h(d, 'dt');
  for (const tok of tokens) {
    if ('k' in tok) {
      const mouse = MOUSE_CAPS[tok.k];
      const kbd = h(d, 'kbd', mouse ? 'bl-kbd-mouse' : null);
      if (mouse && isKeyRef(tok.k)) {
        kbd.appendChild(svg(d, mouseGlyph(mouse)));
        kbd.appendChild(ctx.text(h(d, 'span', 'bl-sr'), tok.k));
        ctx.attr(kbd, 'title', tok.k);
      } else if (isKeyRef(tok.k)) {
        ctx.text(kbd, tok.k);
      } else {
        kbd.textContent = tok.k;
      }
      dt.appendChild(kbd);
    } else if ('sep' in tok) {
      dt.appendChild(h(d, 'span', 'bl-key-sep', { 'aria-hidden': 'true' }, [tok.sep]));
    } else {
      dt.appendChild(ctx.text(h(d, 'span', 'bl-key-word'), tok.word));
    }
  }
  return dt;
}

export function keyTable(ctx: UiContext, rows: readonly ControlRow[]): HTMLElement {
  const d = ctx.doc;
  const dl = h(d, 'dl', 'bl-keys');
  for (const row of rows) {
    dl.appendChild(h(d, 'div', 'bl-key-row', null, [keyTokens(ctx, row.keys), ctx.text(h(d, 'dd'), row.desc)]));
  }
  return dl;
}

/** Full controls reference, one titled block per section. */
export function controlsReference(ctx: UiContext): HTMLElement {
  const d = ctx.doc;
  const grid = h(d, 'div', 'bl-ref-grid');
  for (const sec of CONTROLS) {
    grid.appendChild(h(d, 'section', 'bl-ref-sec', null, [ctx.text(h(d, 'h4'), sec.title), keyTable(ctx, sec.rows)]));
  }
  return grid;
}

// ------------------------------------------------------------------ item slot

/**
 * One item slot (hotbar, backpack): a stamped brass plate with an icon well and a count.
 * Writes the DOM only when the item, count, selection or language changes.
 */
export class SlotWidget {
  readonly el: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly count: TextSlot;
  private item = -2;
  private n = -1;
  private selected: boolean | null = null;
  private labelLang: Language | null = null;

  constructor(
    private readonly ctx: UiContext,
    /** Engraved number shown in the corner (hotbar only). */
    private readonly num: string | null,
    attrs: Readonly<Record<string, string>>,
  ) {
    const d = ctx.doc;
    this.canvas = h(d, 'canvas', null, { width: ctx.iconSize, height: ctx.iconSize, 'aria-hidden': 'true' });
    this.count = new TextSlot(d);
    const countEl = h(d, 'span', 'bl-slot-count', { 'aria-hidden': 'true' });
    countEl.appendChild(this.count.node);
    this.el = h(d, 'button', 'bl-slot', { type: 'button', 'data-empty': '1', ...attrs }, [
      h(d, 'span', 'bl-slot-well', null, [this.canvas]),
      num !== null ? h(d, 'span', 'bl-slot-num', { 'aria-hidden': 'true' }, [num]) : null,
      countEl,
    ]);
  }

  set(slot: SlotView | null | undefined): void {
    const item = slot && slot.count > 0 ? slot.item : -1;
    const count = item >= 0 && slot ? slot.count : 0;
    let label = false;
    if (item !== this.item) {
      this.item = item;
      if (item < 0) {
        this.el.dataset.empty = '1';
        delete this.el.dataset.item;
        this.ctx.icons.clear(this.canvas);
      } else {
        this.el.dataset.empty = '0';
        this.el.dataset.item = String(item);
        this.ctx.icons.paint(this.canvas, item, this.ctx.iconSize);
      }
      label = true;
    }
    if (count !== this.n) {
      this.n = count;
      this.count.set(formatCount(count));
      label = true;
    }
    if (label || this.labelLang !== this.ctx.lang) {
      this.labelLang = this.ctx.lang;
      const name = item < 0 ? this.ctx.t('inv.slotEmpty') : count > 1 ? this.ctx.t('inv.slotLabel', { name: itemName(item, this.ctx.lang), n: count }) : itemName(item, this.ctx.lang);
      setAttr(this.el, 'aria-label', this.num !== null ? `${this.num} · ${name}` : name);
    }
  }

  setSelected(on: boolean): void {
    if (on === this.selected) return;
    this.selected = on;
    this.el.classList.toggle('is-selected', on);
    // The selected hotbar slot is the "current" item, not a pressed toggle.
    if (on) this.el.setAttribute('aria-current', 'true');
    else this.el.removeAttribute('aria-current');
  }

  /** Item id shown, -1 when empty. */
  get itemId(): number {
    return this.item;
  }
}
