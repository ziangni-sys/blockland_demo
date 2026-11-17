/**
 * In-game HUD: crosshair, context hint, hotbar with the fading item name, survival gauges,
 * helm instrument, debug overlay and the click-to-play veil.
 *
 * Only the hotbar slots are interactive, and only in drag-to-look mode (where clicks reach
 * the DOM); everything else lets pointer events fall through to the 3D view.
 */
import type { UiContext } from '../context';
import { HOTBAR_SIZE, type UiState } from '../model';
import { itemName } from '../palette';
import { h, restartAnimation, setHidden, svg, TextSlot } from '../dom';
import { DebugOverlay } from './debug';
import { BreathGauge, VitalGauge } from './gauges';
import { HelmInstrument } from './helm';
import { SlotWidget } from './widgets';

const CROSSHAIR =
  '<svg viewBox="-13 -13 26 26"><path class="bl-cross-tick" d="M0 -10V-5M0 5V10M-10 0H-5M5 0H10"/><circle class="bl-cross-dot" r="1.5"/></svg>';

const VEIL_MOUSE =
  '<svg viewBox="0 0 42 42"><rect x="13" y="6" width="16" height="26" rx="8"/><path d="M21 6v9M13 15h16"/><rect class="bl-fill" x="13.8" y="6.8" width="6.4" height="7.4" rx="3"/><path d="M33 34l4 4M35 31.5h4.5M30.5 36.5v4.5"/></svg>';
const VEIL_DRAG =
  '<svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="5"/><path d="M21 4v8M21 30v8M4 21h8M30 21h8M17.5 7.5L21 4l3.5 3.5M17.5 34.5L21 38l3.5-3.5M7.5 17.5L4 21l3.5 3.5M34.5 17.5L38 21l-3.5 3.5"/></svg>';

export class Hud {
  readonly el: HTMLElement;
  private readonly hotbarEl: HTMLElement;
  private readonly slots: SlotWidget[] = [];
  private readonly nameEl: HTMLElement;
  private readonly name: TextSlot;
  private readonly hintEl: HTMLElement;
  private readonly hint: TextSlot;
  private readonly gaugesEl: HTMLElement;
  private readonly vital: VitalGauge;
  private readonly breath: BreathGauge;
  private readonly helm: HelmInstrument;
  private readonly debug: DebugOverlay;
  private readonly veil: HTMLElement;
  private readonly veilMouse: SVGSVGElement;
  private readonly veilDrag: SVGSVGElement;
  private readonly veilTitle: HTMLElement;
  private readonly veilSub: HTMLElement;

  private play: boolean | null = null;
  private selected = -1;
  /** Item in the selected slot at the last update; undefined before the first update. */
  private selectedItem: number | undefined = undefined;
  private nameLang: string | null = null;
  private survival: boolean | null = null;
  private hintText: string | null | undefined = undefined;
  private veilShown: boolean | null = null;
  private veilDragMode: boolean | null = null;

  constructor(private readonly ctx: UiContext) {
    const d = ctx.doc;
    this.debug = new DebugOverlay(d);

    this.hint = new TextSlot(d);
    this.hintEl = h(d, 'div', 'bl-hint bl-play', { 'data-show': '0', 'aria-live': 'polite' });
    this.hintEl.appendChild(this.hint.node);

    this.name = new TextSlot(d);
    this.nameEl = h(d, 'div', 'bl-itemname', { 'aria-hidden': 'true' });
    this.nameEl.appendChild(this.name.node);

    this.vital = new VitalGauge(ctx);
    this.breath = new BreathGauge(ctx);
    this.gaugesEl = h(d, 'div', 'bl-gauges', null, [this.vital.el, this.breath.el]);

    this.hotbarEl = h(d, 'div', 'bl-hotbar', { role: 'toolbar' });
    ctx.attr(this.hotbarEl, 'aria-label', 'hud.hotbar');
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      // Not in the tab order: during play the hotbar is driven by 1-9 / wheel, and a focused
      // button would swallow Space (jump) as a click.
      const slot = new SlotWidget(ctx, String(i + 1), { tabindex: '-1', 'data-index': String(i) });
      slot.el.addEventListener('mousedown', (e) => e.preventDefault());
      slot.el.addEventListener('click', () => ctx.actions.selectHotbar(i));
      this.slots.push(slot);
      this.hotbarEl.appendChild(slot.el);
    }

    this.helm = new HelmInstrument(ctx);

    this.veilMouse = svg(d, VEIL_MOUSE, 'bl-veil-icon');
    this.veilDrag = svg(d, VEIL_DRAG, 'bl-veil-icon');
    this.veilTitle = h(d, 'div', 'bl-veil-title');
    this.veilSub = h(d, 'div', 'bl-veil-sub');
    this.veil = h(d, 'div', 'bl-veil bl-play', { 'data-show': '0', 'data-drag': '0' }, [
      h(d, 'div', 'bl-veil-card', null, [this.veilMouse, this.veilDrag, h(d, 'div', null, null, [this.veilTitle, this.veilSub])]),
    ]);

    this.el = h(d, 'div', 'bl-hud', { 'data-play': '0', 'data-drag': '0' }, [
      this.debug.el,
      svg(d, CROSSHAIR, 'bl-crosshair bl-play'),
      this.hintEl,
      h(d, 'div', 'bl-bottom bl-play', null, [this.nameEl, this.gaugesEl, this.hotbarEl]),
      this.helm.el,
      this.veil,
    ]);
  }

  /**
   * @param inGame false on the main menu / loading screen (HUD hidden, nothing to do)
   * @param play   true while no screen is open (the play-only widgets are visible)
   */
  update(s: UiState, inGame: boolean, play: boolean): void {
    if (!inGame) return;
    this.debug.update(s.debug);
    if (play !== this.play) {
      this.play = play;
      this.el.dataset.play = play ? '1' : '0';
    }
    if (!play) return;

    const hotbar = s.hotbar;
    for (let i = 0; i < HOTBAR_SIZE; i++) this.slots[i]!.set(hotbar[i]);
    const sel = Math.min(HOTBAR_SIZE - 1, Math.max(0, s.selected | 0));
    if (sel !== this.selected) {
      if (this.selected >= 0) this.slots[this.selected]!.setSelected(false);
      this.slots[sel]!.setSelected(true);
      this.selected = sel;
    }
    this.updateItemName(s, sel);

    const survival = s.mode === 'survival';
    if (survival !== this.survival) {
      this.survival = survival;
      setHidden(this.gaugesEl, !survival);
    }
    if (survival) {
      this.vital.update(s.health, s.maxHealth);
      this.breath.update(s.air, s.maxAir);
    }

    if (s.hint !== this.hintText) {
      this.hintText = s.hint;
      // Keep the old text while fading out so the pill does not collapse mid-fade.
      if (s.hint) this.hint.set(s.hint);
      this.hintEl.dataset.show = s.hint ? '1' : '0';
    }

    this.helm.update(s.helm);
    this.updateVeil(!s.pointerLocked, s.dragLook);
  }

  private updateItemName(s: UiState, sel: number): void {
    const slot = s.hotbar[sel];
    const item = slot && slot.count > 0 ? slot.item : -1;
    const first = this.selectedItem === undefined;
    if (item === this.selectedItem && this.nameLang === this.ctx.lang) return;
    const changed = item !== this.selectedItem;
    this.selectedItem = item;
    this.nameLang = this.ctx.lang;
    if (item < 0) {
      this.nameEl.classList.remove('is-flash');
      return;
    }
    this.name.set(itemName(item, this.ctx.lang));
    // Flash only on a real change of the held item (not on the first frame, not on a
    // language switch, which just re-labels whatever is showing).
    if (changed && !first) restartAnimation(this.nameEl, 'is-flash');
  }

  private updateVeil(show: boolean, drag: boolean): void {
    if (show !== this.veilShown) {
      this.veilShown = show;
      this.veil.dataset.show = show ? '1' : '0';
    }
    if (drag !== this.veilDragMode) {
      this.veilDragMode = drag;
      this.el.dataset.drag = drag ? '1' : '0';
      this.veil.dataset.drag = drag ? '1' : '0';
      // SVG elements have no `hidden` property; toggle the attribute the stylesheet keys on.
      this.veilMouse.toggleAttribute('hidden', drag);
      this.veilDrag.toggleAttribute('hidden', !drag);
      this.veilTitle.textContent = this.ctx.t(drag ? 'hud.dragLook' : 'hud.clickToPlay');
      this.veilSub.textContent = this.ctx.t(drag ? 'hud.dragLookSub' : 'hud.clickToPlaySub');
    }
  }

  /** Called after a language change: re-render language-dependent dynamic text. */
  relocalize(): void {
    const drag = this.veilDragMode;
    this.veilDragMode = null;
    if (drag !== null) this.updateVeil(this.veilShown ?? false, drag);
  }
}
