/**
 * Inventory: backpack (27) + hotbar (9) slots, the stack held by the cursor following the
 * pointer, item-name tooltips, and in creative mode a searchable, grouped palette of every
 * item. Clicking outside the panel while holding a stack drops it.
 *
 * Slot clicks map to UiActions.slotClick: left click (or Enter/Space) = button 0, right click
 * (or the context-menu key) = button 2, Shift held = shift.
 */
import { allItems } from '../../blocks/items';
import type { UiContext } from '../context';
import { slotEq } from '../diff';
import { formatCount } from '../format';
import { HOTBAR_SIZE, INVENTORY_SIZE, type SlotView, type UiState } from '../model';
import { groupItems, itemAltName, itemName, matchesQuery, normalizeQuery, searchText } from '../palette';
import { h, setHidden, svg, TextSlot } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { button, ICON_CLOSE, ICON_SEARCH, SlotWidget } from './widgets';

interface PaletteEntry {
  btn: HTMLButtonElement;
  item: number;
  haystack: string;
  group: HTMLElement;
}

export class InventoryView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly paletteEl: HTMLElement;
  private readonly paletteScroll: HTMLElement;
  private readonly paletteEmpty: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly shiftHint: HTMLElement;
  private readonly bag: SlotWidget[] = [];
  private readonly hot: SlotWidget[] = [];
  private readonly cursorEl: HTMLElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly cursorCount: TextSlot;
  private readonly tip: HTMLElement;
  private readonly tipName: HTMLElement;
  private readonly tipAlt: HTMLElement;

  private palette: PaletteEntry[] | null = null;
  private groups: HTMLElement[] = [];
  private query = '';
  private creative: boolean | null = null;
  private selected = -1;
  private cursor: SlotView | null = null;
  private shown = false;

  // Pointer / tooltip tracking. Coordinates are viewport px.
  private px = -1;
  private py = -1;
  private hoverEl: HTMLElement | null = null;
  private tipItem = -1;
  private tipW = 0;
  private tipH = 0;
  private tipLang: string | null = null;
  /** Half the held stack's edge in px, measured when it appears (avoids per-move layout reads). */
  private cursorHalf = 0;

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.px = e.clientX;
    this.py = e.clientY;
    this.placeFloaters();
  };

  constructor(
    private readonly ctx: UiContext,
    overlayHost: HTMLElement,
  ) {
    const d = ctx.doc;
    const a = ctx.actions;

    // ---- palette (contents built lazily the first time creative mode is shown)
    this.search = h(d, 'input', 'bl-input', { type: 'search', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    ctx.attr(this.search, 'placeholder', 'inv.searchPlaceholder');
    ctx.attr(this.search, 'aria-label', 'inv.search');
    this.search.addEventListener('input', () => this.applySearch());
    this.paletteEmpty = h(d, 'p', 'bl-palette-empty', { hidden: true });
    ctx.text(this.paletteEmpty, 'inv.noResults');
    this.paletteScroll = h(d, 'div', 'bl-palette-scroll', null, [this.paletteEmpty]);
    this.paletteScroll.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLElement>('.bl-pitem');
      if (btn) a.creativePick(Number(btn.dataset.item), e.shiftKey);
    });
    this.paletteScroll.addEventListener('keydown', (e) => this.gridKeyNav(e, '.bl-pitem'));
    const palTitle = ctx.id('palette');
    this.paletteEl = h(d, 'section', 'bl-palette', { 'aria-labelledby': palTitle }, [
      ctx.text(h(d, 'h3', 'bl-subtitle', { id: palTitle }), 'inv.palette'),
      h(d, 'label', 'bl-search', null, [svg(d, ICON_SEARCH), this.search]),
      this.paletteScroll,
    ]);

    // ---- slots
    const bagGrid = h(d, 'div', 'bl-slotgrid bl-slotgrid--bag', { role: 'group' });
    ctx.attr(bagGrid, 'aria-label', 'inv.backpack');
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = new SlotWidget(ctx, null, { 'data-area': 'inventory', 'data-index': String(i) });
      this.bag.push(s);
      bagGrid.appendChild(s.el);
    }
    const hotGrid = h(d, 'div', 'bl-slotgrid bl-slotgrid--hot', { role: 'group' });
    ctx.attr(hotGrid, 'aria-label', 'inv.hotbar');
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = new SlotWidget(ctx, null, { 'data-area': 'hotbar', 'data-index': String(i) });
      this.hot.push(s);
      hotGrid.appendChild(s.el);
    }
    this.shiftHint = ctx.text(h(d, 'span'), 'inv.shiftHint');
    const slotsEl = h(d, 'section', 'bl-inv-slots', null, [
      ctx.text(h(d, 'h3', 'bl-subtitle'), 'inv.backpack'),
      bagGrid,
      ctx.text(h(d, 'h3', 'bl-subtitle'), 'inv.hotbar'),
      hotGrid,
      h(d, 'p', 'bl-inv-hint', null, [ctx.text(h(d, 'span'), 'inv.dropHint'), this.shiftHint]),
    ]);
    slotsEl.addEventListener('click', (e) => this.onSlotEvent(e, 0));
    slotsEl.addEventListener('contextmenu', (e) => this.onSlotEvent(e, 2));
    slotsEl.addEventListener('keydown', (e) => this.gridKeyNav(e, '.bl-slot'));

    // ---- panel + backdrop
    const titleId = ctx.id('inv');
    const close = button(ctx, { variant: 'ghost', icon: ICON_CLOSE, aria: 'inv.close', cls: 'bl-inv-close', onClick: () => a.closeScreen() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-inv-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h(d, 'header', 'bl-inv-head', null, [ctx.text(h(d, 'h2', 'bl-panel-title', { id: titleId }), 'inv.title'), close]),
      h(d, 'div', 'bl-inv-body', null, [this.paletteEl, slotsEl]),
    ]);
    this.panel.addEventListener('pointerover', (e) => this.onHover(e));
    this.panel.addEventListener('pointerout', (e) => this.onHoverOut(e));
    this.panel.addEventListener('focusin', (e) => this.onFocusIn(e));
    this.panel.addEventListener('focusout', () => {
      if (this.hoverEl && this.hoverEl === this.ctx.doc.activeElement) return;
      this.hideTip();
    });

    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-inv', { hidden: true, 'data-screen': 'inventory', 'data-creative': '0' }, [this.panel]);
    this.el.addEventListener('click', (e) => {
      // Backdrop only (not the panel): throw away the held stack.
      if (e.target === this.el && this.cursor) a.dropCursor();
    });
    this.el.addEventListener('contextmenu', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      if (e.target === this.el && this.cursor) a.dropCursor();
    });

    // ---- floaters (live at the UI root so they stack above every panel)
    this.cursorCanvas = h(d, 'canvas', null, { width: ctx.iconSize, height: ctx.iconSize });
    this.cursorCount = new TextSlot(d);
    this.cursorEl = h(d, 'div', 'bl-cursor', { hidden: true, 'aria-hidden': 'true' }, [this.cursorCanvas, h(d, 'span', 'bl-slot-count', null, [this.cursorCount.node])]);
    this.tipName = h(d, 'div', 'bl-tooltip-name');
    this.tipAlt = h(d, 'div', 'bl-tooltip-alt');
    this.tip = h(d, 'div', 'bl-tooltip', { hidden: true, role: 'tooltip' }, [this.tipName, this.tipAlt]);
    overlayHost.append(this.tip, this.cursorEl);
  }

  update(s: UiState): void {
    const creative = s.mode === 'creative';
    if (creative !== this.creative) {
      this.creative = creative;
      this.el.dataset.creative = creative ? '1' : '0';
      setHidden(this.shiftHint, !creative);
      if (creative && !this.palette) this.buildPalette();
    }
    for (let i = 0; i < INVENTORY_SIZE; i++) this.bag[i]!.set(s.inventory[i]);
    for (let i = 0; i < HOTBAR_SIZE; i++) this.hot[i]!.set(s.hotbar[i]);
    const sel = Math.min(HOTBAR_SIZE - 1, Math.max(0, s.selected | 0));
    if (sel !== this.selected) {
      if (this.selected >= 0) this.hot[this.selected]!.setSelected(false);
      this.hot[sel]!.setSelected(true);
      this.selected = sel;
    }
    if (!slotEq(this.cursor, s.cursor)) this.setCursor(s.cursor);
    // The slot under the pointer may have changed contents (we just clicked it).
    if (this.hoverEl) this.refreshTip(false);
  }

  onShow(): void {
    this.shown = true;
    this.ctx.doc.addEventListener('pointermove', this.onPointerMove, { passive: true });
    focusInto(this.panel);
    // update() ran while hidden; place a held stack now that positions mean something.
    if (this.cursor) {
      this.cursorHalf = this.cursorEl.offsetWidth / 2;
      this.placeFloaters();
    }
  }

  onHide(): void {
    this.shown = false;
    this.ctx.doc.removeEventListener('pointermove', this.onPointerMove);
    this.hideTip();
    setHidden(this.cursorEl, true);
    this.cursor = null;
  }

  relocalize(): void {
    if (this.palette) for (const p of this.palette) p.btn.setAttribute('aria-label', itemName(p.item, this.ctx.lang));
    if (this.hoverEl) this.refreshTip(true);
  }

  dispose(): void {
    this.ctx.doc.removeEventListener('pointermove', this.onPointerMove);
    this.tip.remove();
    this.cursorEl.remove();
    this.el.remove();
  }

  // ------------------------------------------------------------------ palette

  private buildPalette(): void {
    const ctx = this.ctx;
    const d = ctx.doc;
    const entries: PaletteEntry[] = [];
    const frag = d.createDocumentFragment();
    for (const g of groupItems(allItems())) {
      const grid = h(d, 'div', 'bl-pgrid');
      const titleId = ctx.id('pg');
      const section = h(d, 'section', 'bl-pgroup', { 'aria-labelledby': titleId }, [ctx.text(h(d, 'h3', null, { id: titleId }), g.label), grid]);
      for (const it of g.items) {
        const canvas = h(d, 'canvas', null, { width: ctx.iconSize, height: ctx.iconSize, 'aria-hidden': 'true' });
        ctx.icons.paint(canvas, it.id, ctx.iconSize);
        const btn = h(d, 'button', 'bl-pitem', { type: 'button', 'data-item': String(it.id), 'aria-label': itemName(it.id, ctx.lang) }, [canvas]);
        grid.appendChild(btn);
        entries.push({ btn, item: it.id, haystack: searchText(it), group: section });
      }
      this.groups.push(section);
      frag.appendChild(section);
    }
    this.paletteScroll.insertBefore(frag, this.paletteEmpty);
    this.palette = entries;
    if (this.query !== '') this.applySearch();
  }

  private applySearch(): void {
    this.query = normalizeQuery(this.search.value);
    if (!this.palette) return;
    const visible = new Set<HTMLElement>();
    for (const p of this.palette) {
      const ok = matchesQuery(p.haystack, this.query);
      setHidden(p.btn, !ok);
      if (ok) visible.add(p.group);
    }
    for (const g of this.groups) setHidden(g, !visible.has(g));
    setHidden(this.paletteEmpty, visible.size > 0);
    this.paletteScroll.scrollTop = 0;
  }

  // ------------------------------------------------------------------ slots & keyboard

  private onSlotEvent(e: MouseEvent, button: 0 | 2): void {
    const slot = (e.target as Element).closest<HTMLElement>('.bl-slot');
    if (button === 2) e.preventDefault();
    if (!slot) return;
    const area = slot.dataset.area === 'hotbar' ? 'hotbar' : 'inventory';
    this.ctx.actions.slotClick(area, Number(slot.dataset.index), button, e.shiftKey);
  }

  /** Arrow keys move focus within a grid of buttons (row width read from the layout). */
  private gridKeyNav(e: KeyboardEvent, selector: string): void {
    const k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;
    const cur = (e.target as Element).closest<HTMLElement>(selector);
    const grid = cur?.parentElement;
    if (!cur || !grid) return;
    const items = [...grid.querySelectorAll<HTMLElement>(`:scope > ${selector}:not([hidden])`)];
    const i = items.indexOf(cur);
    if (i < 0) return;
    let cols = 1;
    while (cols < items.length && items[cols]!.offsetTop === items[0]!.offsetTop) cols++;
    const step = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -cols : cols;
    const next = items[i + step];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  // ------------------------------------------------------------------ cursor stack

  private setCursor(c: SlotView | null): void {
    const prevItem = this.cursor ? this.cursor.item : -1;
    this.cursor = c && c.count > 0 ? { item: c.item, count: c.count } : null;
    if (!this.cursor) {
      setHidden(this.cursorEl, true);
      return;
    }
    if (this.cursor.item !== prevItem) this.ctx.icons.paint(this.cursorCanvas, this.cursor.item, this.ctx.iconSize);
    this.cursorCount.set(formatCount(this.cursor.count));
    if (this.cursorEl.hidden) {
      setHidden(this.cursorEl, false);
      this.cursorHalf = this.cursorEl.offsetWidth / 2;
    }
    this.placeFloaters();
  }

  /** Viewport position the floaters follow: the pointer, else the focused control, else centre. */
  private anchor(): { x: number; y: number } {
    if (this.px >= 0) return { x: this.px, y: this.py };
    const win = this.ctx.doc.defaultView;
    const f = this.ctx.doc.activeElement;
    if (f instanceof HTMLElement && f !== this.panel && this.panel.contains(f)) {
      const r = f.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { x: (win?.innerWidth ?? 0) / 2, y: (win?.innerHeight ?? 0) / 2 };
  }

  private placeFloaters(): void {
    if (!this.shown) return;
    const { x, y } = this.anchor();
    if (this.cursor) this.cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (!this.tip.hidden) this.placeTip(x, y);
  }

  // ------------------------------------------------------------------ tooltip

  private onHover(e: PointerEvent): void {
    const el = (e.target as Element).closest<HTMLElement>('[data-item], .bl-slot');
    if (el === this.hoverEl) return;
    this.hoverEl = el;
    this.px = e.clientX;
    this.py = e.clientY;
    this.refreshTip(false);
  }

  private onHoverOut(e: PointerEvent): void {
    const to = e.relatedTarget as Element | null;
    if (to && this.hoverEl && this.hoverEl.contains(to)) return;
    const next = to ? to.closest<HTMLElement>('[data-item], .bl-slot') : null;
    if (next && this.panel.contains(next)) return; // pointerover on `next` handles it
    this.hoverEl = null;
    this.hideTip();
  }

  private onFocusIn(e: FocusEvent): void {
    const el = (e.target as Element).closest<HTMLElement>('[data-item], .bl-slot');
    if (!el || el === this.panel) return;
    // Keyboard navigation: anchor the floaters to the focused control instead of a stale pointer.
    if (!el.matches(':hover')) {
      this.px = -1;
      this.py = -1;
    }
    this.hoverEl = el;
    this.refreshTip(false);
  }

  private refreshTip(force: boolean): void {
    const el = this.hoverEl;
    const item = el && el.dataset.item !== undefined ? Number(el.dataset.item) : -1;
    if (item < 0) {
      this.hideTip();
      return;
    }
    if (item !== this.tipItem || force || this.tipLang !== this.ctx.lang) {
      this.tipItem = item;
      this.tipLang = this.ctx.lang;
      this.tipName.textContent = itemName(item, this.ctx.lang);
      this.tipAlt.textContent = itemAltName(item, this.ctx.lang);
      setHidden(this.tip, false);
      // Measure once per content change; following the pointer then needs no layout reads.
      this.tipW = this.tip.offsetWidth;
      this.tipH = this.tip.offsetHeight;
    }
    setHidden(this.tip, false);
    this.placeFloaters();
  }

  private placeTip(x: number, y: number): void {
    const win = this.ctx.doc.defaultView;
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    // Sit beside the held stack when there is one, otherwise just off the pointer.
    const off = this.cursor ? this.cursorHalf + 8 : 16;
    let tx = x + off;
    let ty = y + off;
    if (tx + this.tipW > vw - 6) tx = x - off - this.tipW;
    if (ty + this.tipH > vh - 6) ty = y - off - this.tipH;
    tx = Math.max(6, tx);
    ty = Math.max(6, ty);
    this.tip.style.transform = `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
  }

  private hideTip(): void {
    this.tipItem = -1;
    setHidden(this.tip, true);
  }
}
