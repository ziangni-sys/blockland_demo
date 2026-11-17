/** Common shape of a full-screen view (menu, pause, inventory ...). */
import type { Screen, UiState } from '../model';

export interface ScreenView {
  readonly el: HTMLElement;
  /** Render `s`. Only called while this screen is the active one. */
  update(s: UiState): void;
  /** The screen just became active (after its first update). `from` is the previous screen. */
  onShow(s: UiState, from: Screen | null): void;
  /** The screen is being hidden. */
  onHide(): void;
  /** Language changed: refresh dynamic, language-dependent content. */
  relocalize(): void;
  dispose(): void;
}

/** Move focus into a freshly shown screen without scrolling the page. */
export function focusInto(el: HTMLElement | null | undefined): void {
  if (el) el.focus({ preventScroll: true });
}
