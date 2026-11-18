/**
 * "Join a room" (package 11), from the main menu: one field takes whatever the friend sent (the
 * invitation link, the room code, or a manual invitation code: the client tells them apart), a
 * Join button, a line on invitation codes (the answer code comes on the loading screen), the name
 * the others will see, and Back. A text the client cannot read is refused here with a message;
 * the join itself is the loading screen's. Esc is Back.
 */
import type { UiContext } from '../context';
import type { Screen, UiState } from '../model';
import { h, setHidden, TextSlot } from '../dom';
import { isolate } from '../format';
import { focusInto, type ScreenView } from './screen';
import { button, ICON_BACK } from './widgets';

export class JoinScreenView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly error: HTMLElement;
  private readonly as: TextSlot;
  private name = '';

  /** `parse` tells whether a text is something to join (the client's rule, given by the root). */
  constructor(
    private readonly ctx: UiContext,
    private readonly parse: (text: string) => boolean,
  ) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('join');
    const fieldId = ctx.id('joinfield');
    this.input = h(d, 'textarea', 'bl-input bl-join-input', { id: fieldId, rows: 3, spellcheck: 'false', autocomplete: 'off', 'data-field': 'join' });
    ctx.attr(this.input, 'placeholder', 'join.placeholder');
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => setHidden(this.error, true));
    this.error = ctx.text(h(d, 'p', 'bl-room-error', { role: 'alert', hidden: true }), 'join.invalid');
    this.as = new TextSlot(d);
    const go = button(ctx, { variant: 'primary', label: 'join.go', onClick: () => this.submit() });
    go.dataset.act = 'join';
    const back = button(ctx, { variant: 'ghost', icon: ICON_BACK, label: 'join.back', onClick: () => a.closeScreen() });
    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-join-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'join.title'),
      ctx.text(h(d, 'label', 'bl-form-label', { for: fieldId }), 'join.field'),
      this.input,
      this.error,
      ctx.text(h(d, 'p', 'bl-room-hint'), 'join.hint'),
      h(d, 'p', 'bl-join-as', null, [this.as.node]),
      h(d, 'div', 'bl-actions', null, [back, go]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--opaque bl-join', { hidden: true, 'data-screen': 'join' }, [this.panel]);
    // Esc goes back to the menu (the client's keys do not act outside a world).
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      a.closeScreen();
    });
  }

  update(s: UiState): void {
    this.name = s.online.playerName;
    this.as.set(this.ctx.t('join.as', { name: isolate(this.name) }));
  }

  onShow(_s: UiState, _from: Screen | null): void {
    setHidden(this.error, true);
    focusInto(this.input);
  }

  onHide(): void {}

  relocalize(): void {
    this.as.set(this.ctx.t('join.as', { name: isolate(this.name) }));
  }

  dispose(): void {
    this.el.remove();
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!this.parse(text)) {
      setHidden(this.error, false);
      return;
    }
    this.input.value = '';
    this.input.blur();
    this.ctx.actions.join(text);
  }
}
