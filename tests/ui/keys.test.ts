/**
 * Keyboard-activation guard (review finding: holding Space or Enter through death — or Enter
 * on Settings > Back — activated the button that received focus next).
 */
import { describe, expect, it } from 'vitest';
import { ACTIVATOR_ROLES, blocksRepeatActivation } from '../../src/ui/keys';

describe('blocksRepeatActivation', () => {
  it('cancels auto-repeated Enter and Space on controls', () => {
    expect(blocksRepeatActivation('Enter', true, false, 'activator')).toBe(true);
    expect(blocksRepeatActivation(' ', true, false, 'activator')).toBe(true);
    expect(blocksRepeatActivation('Spacebar', true, false, 'activator')).toBe(true);
  });

  it('leaves fresh presses alone', () => {
    expect(blocksRepeatActivation('Enter', false, false, 'activator')).toBe(false);
    expect(blocksRepeatActivation(' ', false, false, 'activator')).toBe(false);
    expect(blocksRepeatActivation('Enter', false, false, 'field')).toBe(false);
  });

  it('stops a held Enter from re-submitting a form but lets Space type', () => {
    expect(blocksRepeatActivation('Enter', true, false, 'field')).toBe(true);
    expect(blocksRepeatActivation(' ', true, false, 'field')).toBe(false);
  });

  it('never touches multi-line text, plain containers, other keys or IME composition', () => {
    expect(blocksRepeatActivation('Enter', true, false, 'multiline')).toBe(false);
    expect(blocksRepeatActivation(' ', true, false, 'multiline')).toBe(false);
    expect(blocksRepeatActivation('Enter', true, false, 'other')).toBe(false);
    expect(blocksRepeatActivation(' ', true, false, 'other')).toBe(false);
    expect(blocksRepeatActivation('ArrowRight', true, false, 'activator')).toBe(false);
    expect(blocksRepeatActivation('Escape', true, false, 'activator')).toBe(false);
    expect(blocksRepeatActivation('Enter', true, true, 'field')).toBe(false);
  });

  it('treats the roles the UI uses for its controls as activators', () => {
    for (const r of ['button', 'radio', 'switch']) expect(ACTIVATOR_ROLES.has(r), r).toBe(true);
    expect(ACTIVATOR_ROLES.has('dialog')).toBe(false);
    expect(ACTIVATOR_ROLES.has('alertdialog')).toBe(false);
  });
});
