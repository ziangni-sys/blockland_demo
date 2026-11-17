/**
 * Review (correctness lens): the brief requires "a single dark theme with every colour set
 * explicitly (define colours as CSS custom properties on the UI root)". The existing
 * styles.test.ts only checks that every var(--x) is defined *somewhere* (its
 * `definedAnywhere` fallback makes the "on the UI root" claim untested) and never looks for
 * literal colours, so it passes while the rules below hard-code ~90 colours.
 */
import { describe, expect, it } from 'vitest';
import { UI_CSS } from '../../src/ui/styles';

function splitRoot(css: string): { root: string; rest: string } {
  const start = css.indexOf('.bl-ui {');
  const end = css.indexOf('}', start);
  return { root: css.slice(start, end), rest: css.slice(0, start) + css.slice(end) };
}

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

describe('review: colours live in custom properties on the UI root', () => {
  it('no colour literal appears outside the .bl-ui token block', () => {
    const { rest } = splitRoot(UI_CSS);
    const literals = rest.match(COLOUR_LITERAL) ?? [];
    // e.g. ".bl-inv .bl-slot:hover .bl-slot-well { ... #29497a ... }", ".bl-debug { color: #d7e6f5 }",
    // ".bl-btn--solid-danger { color: #fff6f2; background: linear-gradient(180deg, #ef8473, #c4483a) }"
    expect(literals, `hard-coded colours: ${[...new Set(literals)].slice(0, 12).join(', ')} ...`).toEqual([]);
  });
});
