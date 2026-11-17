import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHEAT_SHEET, CONTROLS, isKeyRef, type ControlRow } from '../../src/ui/controls';
import { allStringKeys, LANGUAGE_NAMES, placeholdersOf, STRINGS, t, type StringKey } from '../../src/ui/i18n';
import { PALETTE_GROUP_LABEL, PALETTE_GROUP_ORDER } from '../../src/ui/palette';

const UI_DIR = join(__dirname, '../../src/ui');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function rowKeys(rows: readonly ControlRow[]): string[] {
  const keys: string[] = [];
  for (const r of rows) {
    keys.push(r.desc);
    for (const tok of r.keys) {
      if ('k' in tok && isKeyRef(tok.k)) keys.push(tok.k);
      if ('word' in tok) keys.push(tok.word);
    }
  }
  return keys;
}

describe('ui i18n table', () => {
  it('every key has a non-empty zh and en string', () => {
    const keys = allStringKeys();
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      const e = STRINGS[key];
      expect(e.zh.trim(), `${key}.zh`).not.toBe('');
      expect(e.en.trim(), `${key}.en`).not.toBe('');
    }
  });

  it('zh and en use the same placeholders', () => {
    for (const key of allStringKeys()) {
      const e = STRINGS[key];
      expect(placeholdersOf(e.zh), key).toEqual(placeholdersOf(e.en));
    }
  });

  it('English strings contain no CJK characters except the brand line', () => {
    const cjk = /[㐀-鿿]/;
    for (const key of allStringKeys()) {
      if (key === 'brand.nameZh') continue;
      expect(cjk.test(STRINGS[key].en), key).toBe(false);
    }
  });

  it('never borrows the Chinese title of a certain other block game', () => {
    for (const key of allStringKeys()) expect(STRINGS[key].zh.includes('我的世界'), key).toBe(false);
  });

  it('translates and substitutes parameters', () => {
    expect(t('zh', 'menu.play')).toBe('进入');
    expect(t('en', 'menu.play')).toBe('Play');
    expect(t('en', 'settings.chunks', { n: 12 })).toBe('12 chunks');
    expect(t('zh', 'menu.confirmDelete', { name: '港湾' })).toBe('删除“港湾”？此操作无法撤销。');
    // Repeated and numeric parameters.
    expect(t('en', 'inv.slotLabel', { name: 'Canvas', n: 64 })).toBe('Canvas ×64');
  });

  it('leaves a missing parameter visible rather than producing a half sentence', () => {
    expect(t('en', 'settings.chunks')).toBe('{n} chunks');
    expect(t('en', 'settings.chunks', {})).toBe('{n} chunks');
  });

  it('controls reference and cheat-sheet only reference existing keys', () => {
    const all = new Set<string>(allStringKeys());
    const used = [...CONTROLS.flatMap((s) => [s.title, ...rowKeys(s.rows)]), ...rowKeys(CHEAT_SHEET)];
    for (const k of used) expect(all.has(k), k).toBe(true);
  });

  it('controls reference covers the required bindings', () => {
    const descs = new Set(CONTROLS.flatMap((s) => s.rows.map((r) => r.desc)));
    for (const k of [
      'ctl.move', 'ctl.jump', 'ctl.fly', 'ctl.flyUpDown', 'ctl.sneak', 'ctl.mine', 'ctl.place', 'ctl.select',
      'ctl.inventory', 'ctl.pause', 'ctl.debug', 'ctl.helmPreview', 'ctl.helmAssemble', 'ctl.helmThrottle',
      'ctl.helmRudder', 'ctl.helmRelease', 'ctl.helmDock', 'ctl.bearingPreview', 'ctl.bearingStart',
      'ctl.bearingStop', 'ctl.glueApply', 'ctl.glueRemove', 'ctl.pick', 'ctl.view',
    ] satisfies StringKey[]) {
      expect(descs.has(k), k).toBe(true);
    }
  });

  it('palette group labels exist and cover every group', () => {
    for (const g of PALETTE_GROUP_ORDER) expect(STRINGS[PALETTE_GROUP_LABEL[g]]).toBeDefined();
  });

  it('every string is used somewhere in the UI sources (no dead entries)', () => {
    const src = sourceFiles(UI_DIR)
      .filter((f) => !f.endsWith('i18n.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const key of allStringKeys()) expect(src.includes(`'${key}'`), key).toBe(true);
  });

  it('names each language in its own language', () => {
    expect(LANGUAGE_NAMES).toEqual({ zh: '中文', en: 'English' });
  });
});
