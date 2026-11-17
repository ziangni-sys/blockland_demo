/**
 * Public entry of the UI module.
 *
 *   const ui = createUi(document.getElementById('ui')!, actions, { iconProvider: renderItemIcon });
 *   // every frame (cheap when nothing changed):
 *   ui.update(state);
 *   // in the key handler:
 *   if (ui.wantsKeyboard()) return;
 */
import type { UiActions, UiHandle } from './model';
import { UiRoot, type UiOptions } from './ui';

export type { UiOptions } from './ui';
export type { IconProvider } from './icons';

/**
 * Mount the UI inside `root` (it renders as a fixed, full-viewport overlay) and return its
 * handle. Inject one <style> element per document (shared across instances).
 */
export function createUi(root: HTMLElement, actions: UiActions, opts?: UiOptions): UiHandle {
  return new UiRoot(root, actions, opts);
}
