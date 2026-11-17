import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_CSS } from '../../src/ui/styles';

const UI_DIR = join(__dirname, '../../src/ui');
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

/** The first `.bl-ui {` rule (where every design token is declared) and everything else. */
function splitRoot(css: string): { root: string; rest: string } {
  const start = css.indexOf('.bl-ui {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return { root: css.slice(start, end), rest: css.slice(0, start) + css.slice(end) };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Component-local custom properties: declared by a component rule (--s per slot, --k per
 * toast kind, --cs for the held stack, --toast-dx per toast lane) or written inline by the
 * views (--t lever position, --p slider fill, --banner-dx / --banner-dy / --toasts-dy from the
 * HUD layout). Everything else must be a token on the root.
 */
const LOCAL_PROPS = ['--s', '--k', '--cs', '--toast-dx', '--t', '--p', '--banner-dx', '--banner-dy', '--toasts-dy'];

describe('ui stylesheet', () => {
  it('declares every design token on the UI root', () => {
    const { root } = splitRoot(UI_CSS);
    const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    const local = new Set(LOCAL_PROPS);
    for (const m of UI_CSS.matchAll(/var\((--[\w-]+)/g)) {
      const name = m[1]!;
      if (!local.has(name)) expect(defined.has(name), `${name} is not declared on .bl-ui`).toBe(true);
    }
    expect(defined.size).toBeGreaterThan(100);
  });

  it('gives every component-local property a source (a component rule or an inline write)', () => {
    const { rest } = splitRoot(UI_CSS);
    const src = sourceFiles(UI_DIR)
      .filter((f) => !f.endsWith('styles.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const name of LOCAL_PROPS) {
      const declared = new RegExp(`${name}\\s*:`).test(rest);
      const inline = src.includes(`'${name}'`);
      expect(declared || inline, name).toBe(true);
    }
  });

  it('has no colour literal outside the token block', () => {
    const { rest } = splitRoot(UI_CSS);
    const literals = rest.match(COLOUR_LITERAL) ?? [];
    expect(literals, `hard-coded colours: ${[...new Set(literals)].join(', ')}`).toEqual([]);
  });

  it('has no colour literal in the views or inline SVG markup either', () => {
    // icons.ts is exempt: its placeholder tile is raster image content generated per item hue,
    // like the procedural item art the provider normally supplies, not interface styling.
    for (const f of sourceFiles(UI_DIR)) {
      if (f.endsWith('styles.ts') || f.endsWith('icons.ts')) continue;
      const found = readFileSync(f, 'utf8').match(COLOUR_LITERAL) ?? [];
      expect(found, f).toEqual([]);
    }
  });

  it('defines both names of every retriggered animation', () => {
    for (const name of ['bl-name-flash', 'bl-name-still', 'bl-hit']) {
      expect(UI_CSS, name).toContain(`@keyframes ${name}-a {`);
      expect(UI_CSS, name).toContain(`@keyframes ${name}-b {`);
    }
    expect(UI_CSS).toMatch(/\.is-flash-a \{ animation-name: bl-name-flash-a; \}/);
    expect(UI_CSS).toMatch(/\.is-hit-b \{ animation: bl-hit-b /);
  });

  it('exposes the helm layout tokens the layout pass reads', () => {
    const { root } = splitRoot(UI_CSS);
    for (const t of ['--helm-base', '--helm-margin', '--ui-zoom']) expect(root, t).toMatch(new RegExp(`${t}:`));
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
    expect(splitRoot(UI_CSS).root).toMatch(/pointer-events: none/);
  });

  it('uses the CJK-aware font stack', () => {
    const { root } = splitRoot(UI_CSS);
    for (const f of ['"Noto Sans SC"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif']) expect(root.includes(f), f).toBe(true);
  });
});
