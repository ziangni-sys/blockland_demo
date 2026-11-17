import { describe, expect, it } from 'vitest';
import { UI_CSS } from '../../src/ui/styles';

/** Body of the first `.bl-ui {` rule: where every design token is declared. */
function rootBlock(css: string): string {
  const start = css.indexOf('.bl-ui {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('ui stylesheet', () => {
  it('defines every custom property it uses (on the UI root)', () => {
    const root = rootBlock(UI_CSS);
    const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    // Properties set inline by the views (per-element values) are allowed to be undeclared.
    const inline = new Set(['--t', '--p', '--k', '--s']);
    const definedAnywhere = new Set([...UI_CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    for (const m of UI_CSS.matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1]!;
      if (inline.has(name)) continue;
      expect(defined.has(name) || definedAnywhere.has(name), name).toBe(true);
    }
    expect(defined.size).toBeGreaterThan(40);
  });

  it('has balanced braces', () => {
    let depth = 0;
    for (const ch of UI_CSS) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('loads nothing from outside the module', () => {
    expect(UI_CSS).not.toMatch(/@import/);
    expect(UI_CSS).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
    expect(UI_CSS).not.toMatch(/@font-face/);
  });

  it('honours reduced motion and shows a visible focus ring', () => {
    expect(UI_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(UI_CSS).toMatch(/:focus-visible\s*\{\s*outline: 2px solid var\(--focus\)/);
  });

  it('keeps the root transparent to pointer events', () => {
    expect(rootBlock(UI_CSS)).toMatch(/pointer-events: none/);
  });

  it('uses the CJK-aware font stack', () => {
    const root = rootBlock(UI_CSS);
    for (const f of ['"Noto Sans SC"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif']) expect(root.includes(f), f).toBe(true);
  });
});
