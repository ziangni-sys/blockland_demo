/**
 * Inventory: backpack (27) + hotbar (9) slots, the off-hand slot (DESIGN 副手), the stack held
 * by the cursor following the pointer, item-name tooltips, and in creative mode a searchable,
 * grouped palette of every item.
 *
 * Slot clicks map to UiActions.slotClick: left click (or Enter/Space) = button 0, right click
 * (or the context-menu key) = button 2, Shift held = shift. Pressing on one slot and releasing
 * on another (empty cursor, left button) moves the stack: slotClick(from) then slotClick(to).
 *
 * Dropping (UiActions.dropCursor): a click outside the slots while holding a stack — on the
 * backdrop, the panel's empty areas, headings and hints — where both the press and the release
 * happened outside the slots. The slot grids themselves (gaps between slots included), the
 * palette grids, buttons and the search field never drop, so a slightly missed slot click or
 * a drag that ends off a slot does not throw the stack away.
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
  canvas: HTMLCanvasElement;
  item: number;
  haystack: string;
  group: HTMLElement;
}

/** Inside the inventory screen, clicks on these never drop the held stack. */
const KEEP_STACK = '.bl-slot, .bl-slotgrid, .bl-pitem, .bl-pgrid, button, input, label, .bl-search';

/** A press that may turn into a slot-to-slot drag or a drop. */
interface Press {
  target: Element;
  /** Where the matching release happened (null until then: contextmenu may fire on press). */
  release: Element | null;
  slot: HTMLElement | null;
  button: number;
  /** The cursor was empty at the press (a drag then moves the pressed stack). */
  emptyCursor: boolean;
}

export class InventoryView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly paletteEl: HTMLElement;
  private readonly paletteScroll: HTMLElement;
  private readonly paletteEmpty: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly slotsEl: HTMLElement;
  private readonly shiftHint: HTMLElement;
  private readonly bag: SlotWidget[] = [];
  private readonly hot: SlotWidget[] = [];
  private readonly off: SlotWidget;
  private readonly cursorEl: HTMLElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly cursorCount: TextSlot;
  private readonly tip: HTMLElement;
  private readonly tipName: HTMLElement;
  private readonly tipAlt: HTMLElement;

  private palette: PaletteEntry[] | null = null;
  private groups: HTMLElement[] = [];
  /** Pending idle callback that builds the palette ahead of the first creative open. */
  private idleBuild = 0;
  private idleBuildIsTimeout = false;
  private query = '';
  private creative: boolean | null = null;
  private selected = -1;
  private cursor: SlotView | null = null;
  private shown = false;
  private press: Press | null = null;

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

    // ---- palette (contents built in idle time, or on the first creative show if that comes first)
    this.search = h(d, 'input', 'bl-input', { type: 'search', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    ctx.attr(this.search, 'placeholder', 'inv.searchPlaceholder');
    ctx.attr(this.search, 'aria-label', 'inv.search');
    this.search.addEventListener('input', () => this.applySearch());
    this.search.addEventListener('keydown', (e) => this.onSearchKey(e));
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
    this.off = new SlotWidget(ctx, null, { 'data-area': 'offhand', 'data-index': '0' });
    const offTitle = ctx.id('off');
    const offRow = h(d, 'div', 'bl-inv-offhand', { role: 'group', 'aria-labelledby': offTitle }, [
      this.off.el,
      h(d, 'span', 'bl-inv-offhand-label', null, [ctx.text(h(d, 'span', null, { id: offTitle }), 'inv.offhand'), h(d, 'kbd', null, null, ['F'])]),
    ]);
    this.shiftHint = ctx.text(h(d, 'span'), 'inv.shiftHint');
    this.slotsEl = h(d, 'section', 'bl-inv-slots', null, [
      ctx.text(h(d, 'h3', 'bl-subtitle'), 'inv.backpack'),
      bagGrid,
      ctx.text(h(d, 'h3', 'bl-subtitle'), 'inv.hotbar'),
      hotGrid,
      offRow,
      h(d, 'p', 'bl-inv-hint', null, [ctx.text(h(d, 'span'), 'inv.dropHint'), this.shiftHint]),
    ]);
    this.slotsEl.addEventListener('click', (e) => this.onSlotEvent(e, 0));
    this.slotsEl.addEventListener('contextmenu', (e) => this.onSlotEvent(e, 2));
    this.slotsEl.addEventListener('keydown', (e) => this.gridKeyNav(e, '.bl-slot'));

    // ---- panel + backdrop
    const titleId = ctx.id('inv');
    const close = button(ctx, { variant: 'ghost', icon: ICON_CLOSE, aria: 'inv.close', cls: 'bl-inv-close', onClick: () => a.closeScreen() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-inv-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h(d, 'header', 'bl-inv-head', null, [ctx.text(h(d, 'h2', 'bl-panel-title', { id: titleId }), 'inv.title'), close]),
      h(d, 'div', 'bl-inv-body', null, [this.paletteEl, this.slotsEl]),
    ]);
    this.panel.addEventListener('pointerover', (e) => this.onHover(e));
    this.panel.addEventListener('pointerout', (e) => this.onHoverOut(e));
    this.panel.addEventListener('focusin', (e) => this.onFocusIn(e));
    this.panel.addEventListener('focusout', () => {
      if (this.hoverEl && this.hoverEl === this.ctx.doc.activeElement) return;
      this.hideTip();
    });

    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-inv', { hidden: true, 'data-screen': 'inventory', 'data-creative': '0' }, [this.panel]);
    this.el.addEventListener('pointerdown', (e) => this.onPress(e));
    this.el.addEventListener('pointerup', (e) => this.onRelease(e));
    this.el.addEventListener('pointercancel', () => (this.press = null));
    this.el.addEventListener('click', (e) => {
      if (e.button === 0) this.maybeDrop(e);
    });
    this.el.addEventListener('contextmenu', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      this.maybeDrop(e);
    });

    // ---- floaters (live at the UI root so they stack above every panel)
    this.cursorCanvas = h(d, 'canvas', null, { width: ctx.iconSize, height: ctx.iconSize });
    this.cursorCount = new TextSlot(d);
    this.cursorEl = h(d, 'div', 'bl-cursor', { hidden: true, 'aria-hidden': 'true' }, [this.cursorCanvas, h(d, 'span', 'bl-slot-count', null, [this.cursorCount.node])]);
    this.tipName = h(d, 'div', 'bl-tooltip-name');
    this.tipAlt = h(d, 'div', 'bl-tooltip-alt');
    this.tip = h(d, 'div', 'bl-tooltip', { hidden: true, role: 'tooltip' }, [this.tipName, this.tipAlt]);
    overlayHost.append(this.tip, this.cursorEl);

    // Build the palette (every item, ~50 buttons) in idle time so the first creative open only
    // pays for layout; update() still builds it on demand if that open comes first.
    const win = d.defaultView;
    if (win) {
      const run = (): void => {
        this.idleBuild = 0;
        if (!this.palette) this.buildPalette(true);
      };
      if (typeof win.requestIdleCallback === 'function') this.idleBuild = win.requestIdleCallback(run, { timeout: 4000 });
      else {
        this.idleBuildIsTimeout = true;
        this.idleBuild = win.setTimeout(run, 500);
      }
    }
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
    this.off.set(s.offhand);
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
    this.press = null;
    this.ctx.doc.removeEventListener('pointermove', this.onPointerMove);
    this.hideTip();
    setHidden(this.cursorEl, true);
    this.cursor = null;
  }

  relocalize(): void {
    if (this.palette) for (const p of this.palette) p.btn.setAttribute('aria-label', itemName(p.item, this.ctx.lang));
    if (this.hoverEl) this.refreshTip(true);
  }

  /** Re-render every icon at the context's current icon size (after a devicePixelRatio change). */
  repaintIcons(): void {
    const size = this.ctx.iconSize;
    for (const s of this.bag) s.repaint();
    for (const s of this.hot) s.repaint();
    this.off.repaint();
    if (this.palette) for (const p of this.palette) this.ctx.icons.paint(p.canvas, p.item, size);
    if (this.cursor) this.ctx.icons.paint(this.cursorCanvas, this.cursor.item, size);
  }

  dispose(): void {
    const win = this.ctx.doc.defaultView;
    if (win && this.idleBuild) {
      if (this.idleBuildIsTimeout) win.clearTimeout(this.idleBuild);
      else win.cancelIdleCallback(this.idleBuild);
    }
    this.idleBuild = 0;
    this.ctx.doc.removeEventListener('pointermove', this.onPointerMove);
    this.tip.remove();
    this.cursorEl.remove();
    this.el.remove();
  }

  // ------------------------------------------------------------------ palette

  /** @param deferIcons render no icon synchronously (idle-time prebuild). */
  private buildPalette(deferIcons = false): void {
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
        // Budgeted: icons not rendered yet (prewarm still running) arrive over the next frames
        // instead of stalling this one for every item at once.
        ctx.icons.paint(canvas, it.id, ctx.iconSize, deferIcons);
        const btn = h(d, 'button', 'bl-pitem', { type: 'button', 'data-item': String(it.id), 'aria-label': itemName(it.id, ctx.lang) }, [canvas]);
        grid.appendChild(btn);
        entries.push({ btn, canvas, item: it.id, haystack: searchText(it), group: section });
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

  /**
   * Esc in the search field: the first press clears the query (and stops there, so the client
   * does not also close the screen); with an empty query it hands focus back to the dialog and
   * lets the key through, so the same press closes the inventory as anywhere else. Without
   * this the field would keep wantsKeyboard() true and keyboard players could never leave.
   * ArrowDown jumps into the results.
   */
  private onSearchKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      if (this.search.value !== '') {
        e.preventDefault();
        e.stopPropagation();
        this.search.value = '';
        this.applySearch();
      } else {
        focusInto(this.panel);
      }
    } else if (e.key === 'ArrowDown' && this.palette) {
      const first = this.palette.find((p) => !p.btn.hidden);
      if (first) {
        e.preventDefault();
        first.btn.focus();
      }
    }
  }

  // ------------------------------------------------------------------ slots & keyboard

  private onSlotEvent(e: MouseEvent, button: 0 | 2): void {
    const slot = (e.target as Element).closest<HTMLElement>('.bl-slot');
    if (button === 2) e.preventDefault();
    if (!slot) return;
    this.clickSlot(slot, button, e.shiftKey);
  }

  private clickSlot(slot: HTMLElement, button: 0 | 2, shift: boolean): void {
    const area = slot.dataset.area === 'hotbar' ? 'hotbar' : slot.dataset.area === 'offhand' ? 'offhand' : 'inventory';
    this.ctx.actions.slotClick(area, Number(slot.dataset.index), button, shift);
  }

  private onPress(e: PointerEvent): void {
    const target = e.target as Element;
    const slot = target.closest<HTMLElement>('.bl-slot');
    this.press = { target, release: null, slot: slot && this.slotsEl.contains(slot) ? slot : null, button: e.button, emptyCursor: !this.cursor };
  }

  /**
   * Press on one slot, release on another: the browser sends the click to their common
   * ancestor (no slot), so the gesture is translated here into a pick-up and a put-down.
   */
  private onRelease(e: PointerEvent): void {
    const p = this.press;
    if (p) p.release = e.target as Element;
    if (!p || !p.slot || p.button !== 0 || e.button !== 0 || !p.emptyCursor) return;
    const to = (e.target as Element).closest<HTMLElement>('.bl-slot');
    if (!to || to === p.slot || !this.slotsEl.contains(to) || p.slot.dataset.empty === '1') return;
    this.clickSlot(p.slot, 0, e.shiftKey);
    this.clickSlot(to, 0, e.shiftKey);
  }

  /** dropCursor for a click outside the slots, pressed and released outside them. */
  private maybeDrop(e: MouseEvent): void {
    const p = this.press;
    if (e.type === 'click') this.press = null;
    if (!this.cursor) return;
    const target = e.target as Element;
    if (!this.isDropTarget(target)) return;
    // Pointer clicks: the press and the release must both have been outside the slots too (a
    // press on a slot that ends on the backdrop is a slipped drag, not a throw, and the click
    // of a press-outside / release-on-slot lands on their common ancestor). Keyboard clicks
    // have no press.
    if (p) {
      if (p.button !== (e.type === 'click' ? 0 : 2) || !this.isDropTarget(p.target)) return;
      if (p.release && !this.isDropTarget(p.release)) return;
    }
    // A click on an element's own scrollbar (the scrolling screen or palette) is not a drop.
    if (target instanceof HTMLElement && e.offsetX >= target.clientWidth && target.scrollHeight > target.clientHeight) return;
    this.ctx.actions.dropCursor();
  }

  private isDropTarget(el: Element): boolean {
    return this.el.contains(el) && !el.closest(KEEP_STACK);
  }

  /**
   * Arrow keys move focus spatially among the buttons of a section (both slot grids form one
   * 4-row block; the palette groups chain into one list), so keyboard play never dead-ends at
   * a grid edge. Layout is read only on key presses.
   */
  private gridKeyNav(e: KeyboardEvent, selector: string): void {
    const k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;
    const cur = (e.target as Element).closest<HTMLElement>(selector);
    const scope = e.currentTarget as HTMLElement | null;
    if (!cur || !scope) return;
    const items = [...scope.querySelectorAll<HTMLElement>(`${selector}:not([hidden])`)].filter((el) => !el.closest('[hidden]'));
    const i = items.indexOf(cur);
    if (i < 0) return;
    let next: HTMLElement | undefined;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      next = items[i + (k === 'ArrowLeft' ? -1 : 1)];
    } else {
      const r = cur.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const down = k === 'ArrowDown';
      // Nearest row in the requested direction, then the closest column within it.
      let rowTop = down ? Infinity : -Infinity;
      const rects = items.map((el) => el.getBoundingClientRect());
      for (const q of rects) {
        if (down ? q.top > r.top + 1 && q.top < rowTop : q.top < r.top - 1 && q.top > rowTop) rowTop = q.top;
      }
      if (Number.isFinite(rowTop)) {
        let best = Infinity;
        rects.forEach((q, j) => {
          if (Math.abs(q.top - rowTop) > 1) return;
          const dx = Math.abs(q.left + q.width / 2 - cx);
          if (dx < best) {
            best = dx;
            next = items[j];
          }
        });
      }
    }
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
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
    const changed = item !== this.tipItem || force || this.tipLang !== this.ctx.lang;
    if (changed) {
      this.tipItem = item;
      this.tipLang = this.ctx.lang;
      this.tipName.textContent = itemName(item, this.ctx.lang);
      this.tipAlt.textContent = itemAltName(item, this.ctx.lang);
      setHidden(this.tip, false);
      // Measure once per content change; following the pointer then needs no layout reads.
      this.tipW = this.tip.offsetWidth;
      this.tipH = this.tip.offsetHeight;
      this.placeFloaters();
    } else if (this.tip.hidden) {
      setHidden(this.tip, false);
      this.placeFloaters();
    }
    // Otherwise nothing to do: update() calls this every frame while hovering.
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
