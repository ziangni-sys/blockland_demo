/** Pause menu: resume, settings, creative/survival toggle, save & quit, full controls reference. */
import type { UiContext } from '../context';
import type { GameMode, Screen, UiState } from '../model';
import { h, setHidden } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { button, controlsReference, ICON_CLOSE, ICON_RESUME, ICON_SAVE, ICON_SLIDERS, Segmented } from './widgets';

export class PauseView implements ScreenView {
  readonly el: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly modeSeg: Segmented<GameMode>;
  /** Shown only after a failed "Save & quit": the notice and the explicit unsaved exit. */
  private readonly unsaved: HTMLElement;

  constructor(ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('pause');
    const modeLbl = ctx.id('pmode');
    const resume = button(ctx, { variant: 'primary', icon: ICON_RESUME, label: 'pause.resume', cls: 'bl-btn--wide', onClick: () => a.resume() });
    this.settingsBtn = button(ctx, { icon: ICON_SLIDERS, label: 'pause.settings', cls: 'bl-btn--wide', onClick: () => a.openSettings() });
    this.modeSeg = new Segmented<GameMode>(
      ctx,
      [
        { value: 'creative', label: 'mode.creative' },
        { value: 'survival', label: 'mode.survival' },
      ],
      'pause.mode',
      (m) => a.setMode(m),
      true, // the mode is the client's: show what it applied, not what was clicked
    );
    this.modeSeg.el.setAttribute('aria-labelledby', modeLbl);
    const quit = button(ctx, { variant: 'danger', icon: ICON_SAVE, label: 'pause.saveQuit', cls: 'bl-btn--wide', onClick: () => a.saveAndQuit() });
    const noSave = button(ctx, { variant: 'ghost', icon: ICON_CLOSE, label: 'pause.quitNoSave', cls: 'bl-btn--wide', onClick: () => a.quitWithoutSaving() });
    this.unsaved = h(d, 'div', 'bl-pause-unsaved', { hidden: true }, [ctx.text(h(d, 'p', 'bl-subtitle', { role: 'alert' }), 'pause.saveFailed'), noSave]);

    this.panel = h(d, 'div', 'bl-panel bl-panel-modal bl-pause-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      h(d, 'div', 'bl-pause-main', null, [
        ctx.text(h(d, 'h2', 'bl-panel-title bl-title-lg', { id: titleId }), 'pause.title'),
        resume,
        this.settingsBtn,
        h(d, 'div', 'bl-pause-mode', null, [ctx.text(h(d, 'span', 'bl-subtitle', { id: modeLbl }), 'pause.mode'), this.modeSeg.el]),
        h(d, 'div', 'bl-pause-quit', null, [quit, this.unsaved]),
      ]),
      h(d, 'div', 'bl-pause-ref', null, [ctx.text(h(d, 'h3', 'bl-subtitle'), 'pause.controls'), controlsReference(ctx)]),
    ]);
    this.el = h(d, 'div', 'bl-screen bl-screen--overlay bl-pause', { hidden: true, 'data-screen': 'pause' }, [this.panel]);
  }

  update(s: UiState): void {
    this.modeSeg.set(s.mode);
    setHidden(this.unsaved, s.quitUnsaved !== true);
  }

  onShow(_s: UiState, from: Screen | null): void {
    // Back from settings: return focus to the button that opened it (the root's key guard
    // keeps a held Enter from re-opening settings through it). Otherwise focus the dialog
    // itself so Tab starts at the top without painting a focus ring on open.
    focusInto(from === 'settings' ? this.settingsBtn : this.panel);
  }

  onHide(): void {}
  relocalize(): void {}
  dispose(): void {
    this.el.remove();
  }
}
