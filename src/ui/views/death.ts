/** Death screen: a message over a crimson vignette, Respawn (primary) and Save & quit. */
import type { UiContext } from '../context';
import type { UiState } from '../model';
import { h, svg } from '../dom';
import { focusInto, type ScreenView } from './screen';
import { button, ICON_RESPAWN, ICON_SAVE } from './widgets';

/** A listing hull going down between waves: loss, in the game's own vocabulary. */
const MARK =
  '<svg viewBox="0 0 64 64"><g transform="rotate(-20 32 36)"><path d="M13 36h38l-6 9H19z"/><path d="M32 36V12"/><path d="M32 14l12 16H32"/><path d="M30 18l-9 12h9"/></g><path d="M4 47c4-3 8-3 12 0s8 3 12 0 8-3 12 0 8 3 12 0 6-2 8-1"/><path d="M10 55c4-3 8-3 12 0s8 3 12 0 8-3 12 0 6 2 8 1"/></svg>';

export class DeathView implements ScreenView {
  readonly el: HTMLElement;
  private readonly card: HTMLElement;

  constructor(ctx: UiContext) {
    const d = ctx.doc;
    const a = ctx.actions;
    const titleId = ctx.id('death');
    const respawn = button(ctx, { variant: 'primary', icon: ICON_RESPAWN, label: 'death.respawn', onClick: () => a.respawn() });
    const quit = button(ctx, { variant: 'ghost', icon: ICON_SAVE, label: 'pause.saveQuit', onClick: () => a.saveAndQuit() });
    this.card = h(d, 'div', 'bl-death-card bl-panel-modal', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
      svg(d, MARK, 'bl-death-mark'),
      ctx.text(h(d, 'h2', 'bl-death-title', { id: titleId }), 'death.title'),
      ctx.text(h(d, 'p', 'bl-death-sub'), 'death.subtitle'),
      h(d, 'div', 'bl-actions', null, [respawn, quit]),
    ]);
    // Enter respawns, but only as a fresh press made while this screen is up: an auto-repeat
    // of a key held through the moment of death is not a choice.
    this.card.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing || e.target !== this.card) return;
      e.preventDefault();
      a.respawn();
    });
    this.el = h(d, 'div', 'bl-screen bl-death', { hidden: true, 'data-screen': 'death' }, [this.card]);
  }

  update(_s: UiState): void {}

  onShow(): void {
    // Focus the dialog, never the Respawn button: players die holding Space (swimming up,
    // jumping) or tapping it, and a focused button turns that Space into a click, skipping the
    // screen. Tab reaches Respawn first; Enter on the dialog respawns.
    focusInto(this.card);
  }
  onHide(): void {}
  relocalize(): void {}
  dispose(): void {
    this.el.remove();
  }
}
