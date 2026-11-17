/**
 * Host-environment shims for the UI DOM.
 *
 * Sandboxed iframes without `allow-forms` block form submission before the `submit` event is
 * even dispatched, so a UI form (the main menu's new-world form) would silently do nothing.
 * The shim takes over submit-button activation everywhere — including the implicit
 * submission triggered by Enter in a text field, which is delivered as a click on the
 * form's default button — cancels the native submission and dispatches a plain, cancelable
 * `submit` event on the form instead. The form's own submit listener then runs exactly once
 * in every environment, and no navigation is ever attempted.
 */

function submitterForm(target: EventTarget | null): HTMLFormElement | null {
  if (!(target instanceof Element)) return null;
  const btn = target.closest('button, input');
  if (btn instanceof HTMLButtonElement) return btn.type === 'submit' ? btn.form : null;
  if (btn instanceof HTMLInputElement) return btn.type === 'submit' || btn.type === 'image' ? btn.form : null;
  return null;
}

/** Install the shim on a UI root. Returns the uninstall function. */
export function installFormSubmitShim(root: HTMLElement): () => void {
  const onClick = (e: MouseEvent): void => {
    const form = submitterForm(e.target);
    if (!form || !root.contains(form)) return;
    e.preventDefault();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };
  root.addEventListener('click', onClick, true);
  return () => root.removeEventListener('click', onClick, true);
}
