/** Loading screen: small logotype, a ruler-ticked brass progress bar, status text and percent. */
import type { UiContext } from '../context';
import { formatPercent, quantize } from '../format';
import type { UiState } from '../model';
import { h, TextSlot } from '../dom';
import type { ScreenView } from './screen';
import { buildLogo } from './widgets';

export class LoadingView implements ScreenView {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly text: TextSlot;
  private readonly pct: TextSlot;
  private progress = -1;

  constructor(ctx: UiContext) {
    const d = ctx.doc;
    this.text = new TextSlot(d);
    this.pct = new TextSlot(d);
    this.fill = h(d, 'div', 'bl-progress-fill');
    this.bar = h(d, 'div', 'bl-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [this.fill, h(d, 'div', 'bl-progress-ticks')]);
    ctx.attr(this.bar, 'aria-label', 'loading.title');
    this.el = h(d, 'div', 'bl-screen bl-screen--opaque bl-loading', { hidden: true, 'data-screen': 'loading' }, [
      h(d, 'div', 'bl-loading-inner', null, [
        buildLogo(ctx, true),
        ctx.text(h(d, 'div', 'bl-loading-title'), 'loading.title'),
        this.bar,
        h(d, 'div', 'bl-loading-row', null, [
          h(d, 'span', 'bl-loading-text', { 'aria-live': 'polite' }, [this.text.node]),
          h(d, 'span', 'bl-loading-pct', null, [this.pct.node]),
        ]),
      ]),
    ]);
  }

  update(s: UiState): void {
    const l = s.loading;
    this.text.set(l ? l.text : '');
    const p = quantize(l ? l.progress : 0, 1000);
    if (p !== this.progress) {
      this.progress = p;
      this.fill.style.transform = `scaleX(${p})`;
      this.pct.set(formatPercent(p));
      this.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    }
  }

  onShow(): void {}
  onHide(): void {}
  relocalize(): void {}
  dispose(): void {
    this.el.remove();
  }
}
