/**
 * Keyboard-activation guard. Pure (no DOM) so the rule is unit-tested in Node; ui.ts applies
 * it to every keydown inside the UI.
 *
 * Why: browsers activate a focused button from the keyboard — Enter on keydown (and again on
 * every auto-repeat), Space on keyup after a keydown that made the button :active. Space is
 * the jump / swim-up / fly-up key and players are usually holding it when a screen appears
 * (drowning, dying mid-jump), and Enter held on one dialog's button keeps repeating into the
 * button that receives focus on the next dialog. An auto-repeated keydown is never a
 * deliberate press of the control that has focus now, so the UI cancels its default action:
 * a repeated Enter then fires nothing, and a repeated Space never makes the button :active,
 * so its keyup fires nothing either. A fresh press (repeat === false) still works.
 */

/** How a focused element reacts to Enter / Space. */
export type KeyTargetKind =
  /** Buttons, radios, switches, links: Enter / Space activate them. */
  | 'activator'
  /** Single-line text inputs: Enter submits the form, Space types. */
  | 'field'
  /** Multi-line editors: Enter and Space are both text. */
  | 'multiline'
  /** Anything else (dialog containers, the page). */
  | 'other';

/** ARIA roles whose elements activate on Enter / Space. */
export const ACTIVATOR_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'radio', 'switch', 'checkbox', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'option',
]);

/**
 * True when the default action of this keydown must be cancelled: an auto-repeated Enter on a
 * control or a text field, or an auto-repeated Space on a control. IME composition keys are
 * never touched (Enter commits a CJK candidate).
 */
export function blocksRepeatActivation(key: string, repeat: boolean, composing: boolean, kind: KeyTargetKind): boolean {
  if (!repeat || composing) return false;
  if (key === 'Enter') return kind === 'activator' || kind === 'field';
  if (key === ' ' || key === 'Spacebar') return kind === 'activator';
  return false;
}
