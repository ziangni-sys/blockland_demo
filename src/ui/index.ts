/**
 * Public entry of the UI module.
 *
 *   const ui = createUi(document.getElementById('ui')!, actions, { iconProvider: renderItemIcon });
 *   // every frame (cheap when nothing changed):
 *   ui.update(state);
 *   // in the key handler (window, bubble phase):
 *   if (ui.wantsKeyboard()) return;
 *
 * Keyboard contract for the client:
 *  - While a UI text field has focus, wantsKeyboard() is true and the client ignores game keys.
 *    Esc in the creative search clears a non-empty query and stops the event; on an empty query
 *    it moves focus back to the dialog and lets the same Esc through (wantsKeyboard() is false
 *    by the time a window listener sees it), so Esc always closes the inventory in at most two
 *    presses. Esc inside the main menu's delete-confirm row is consumed (cancels the delete).
 *  - Auto-repeated Enter / Space keydowns on UI controls get preventDefault() (a key held
 *    through a screen change must not press the button that receives focus); they still
 *    propagate. The death screen never focuses a button; Enter (a fresh press) respawns.
 */
import type { UiActions, UiHandle } from './model';
import { UiRoot, type UiOptions } from './ui';

export type { UiOptions } from './ui';
export type { IconProvider } from './icons';

/**
 * Mount the UI inside `root` (it renders as a fixed, full-viewport overlay) and return its
 * handle. Injects one <style> element per document (shared across instances), and starts
 * rendering every item icon in idle time so later icon paints are plain blits.
 */
export function createUi(root: HTMLElement, actions: UiActions, opts?: UiOptions): UiHandle {
  return new UiRoot(root, actions, opts);
}
