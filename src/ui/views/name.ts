/**
 * The player's name (package 11), asked once before the first world or join: a short line on
 * where it shows, the field (filled with the client's suggestion) and Continue. A name the
 * client's rule refuses (nothing visible, or more than 24 characters: code points, so no maxlength,
 * which counts UTF-16 units) is refused here with the rule shown.
 */
import type { UiContext } from '../context';
import type { Screen, UiState } from '../model';
import { h, setHidden } from '../dom';
import { focusInto, type ScreenView } from './screen';

export class NameView implements ScreenView {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLElement;

  /** `nameOk`: whether a text is an acceptable name (the client's rule, client/names.ts, given by the root). */
  constructor(
    private readonly ctx: UiContext,
    private readonly nameOk: (text: string) => boolean,
  ) {
    const d = ctx.doc;
    const titleId = ctx.id('name');
    const fieldId = ctx.id('namefield');
    this.input = h(d, 'input', 'bl-input bl-name-input', { id: fieldId, type: 'text', autocomplete: 'off', spellcheck: 'false', 'data-field': 'name' });
    this.input.addEventListener('input', () => setHidden(this.error, true));
    this.error = ctx.text(h(d, 'p', 'bl-room-error', { role: 'alert', hidden: true }), 'name.invalid');
    const submit = h(d, 'button', 'bl-btn bl-btn--primary', { type: 'submit', 'data-act': 'name' });
    ctx.text(submit, 'name.continue');
    const form = h(d, 'form', 'bl-name-form', { novalidate: true }, [
      ctx.text(h(d, 'label', 'bl-form-label', { for: fieldId }), 'name.label'),
      this.input,
      this.error,
      h(d, 'div', 'bl-actions', null, [submit]),
    ]);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    const panel = h(d, 'div', 'bl-panel bl-panel-modal bl-name-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'name.title'),
      ctx.text(h(d, 'p', 'bl-name-text'), 'name.text'),
      form,
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--opaque bl-name', { hidden: true, 'data-screen': 'name' }, [panel]);
  }

  update(_s: UiState): void {}

  onShow(s: UiState, _from: Screen | null): void {
    this.input.value = s.online.playerName;
    setHidden(this.error, true);
    focusInto(this.input);
    this.input.select();
  }

  onHide(): void {}
  relocalize(): void {}
  dispose(): void {
    this.el.remove();
  }

  private submit(): void {
    const v = this.input.value;
    if (!this.nameOk(v)) {
      setHidden(this.error, false);
      return;
    }
    this.input.blur();
    this.ctx.actions.setPlayerName(v);
  }
}
