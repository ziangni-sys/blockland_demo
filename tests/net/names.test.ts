/**
 * The rule of a player name (net/names.ts, package 11): what the server keeps from a Hello and what
 * the page lets a player type. Invisible characters (bidi controls, zero-width characters, fillers)
 * are removed so no name can reverse or hide the text around it; a name must keep something visible.
 */
import { describe, expect, it } from 'vitest';
import { cleanName } from '../../src/net/names';
import { NetHarness } from './harness';

describe('player names (net/names.ts)', () => {
  it('control characters go, the ends are trimmed, 1 to 24 code points remain', () => {
    expect(cleanName('  Ada  ')).toBe('Ada');
    expect(cleanName('A\u0007d\u009fa\n')).toBe('Ada');
    expect(cleanName('Al\u0000ice\u001b')).toBe('Alice');
    expect(cleanName('')).toBeNull();
    expect(cleanName(' \t\n ')).toBeNull();
    expect(cleanName('x'.repeat(24))).toBe('x'.repeat(24));
    expect(cleanName('x'.repeat(25))).toBeNull();
    expect(cleanName('船长'.repeat(12))).toBe('船长'.repeat(12));
    expect(cleanName('😀'.repeat(24))).toBe('😀'.repeat(24)); // code points, not UTF-16 units
    expect(cleanName('😀'.repeat(25))).toBeNull();
  });

  it('bidi overrides, embeddings and isolates are removed: a name cannot reverse what follows it', () => {
    expect(cleanName('‮evil‬ RLO')).toBe('evil RLO');
    expect(cleanName('‮live')).toBe('live');
    expect(cleanName('a⁦b⁧c⁨d⁩e')).toBe('abcde');
    expect(cleanName('a‪b‫c‭d‎e‏f؜g')).toBe('abcdefg');
  });

  it('zero-width and other invisible characters are removed; a name with nothing visible is refused', () => {
    expect(cleanName('A​d‌a﻿­⁠')).toBe('Ada');
    expect(cleanName('​')).toBeNull();
    expect(cleanName('​ ⁧')).toBeNull();
    expect(cleanName('ㅤᅟﾠ')).toBeNull(); // Hangul fillers draw nothing
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('　  ')).toBeNull(); // wide and non-breaking spaces only
    expect(cleanName('́́')).toBeNull(); // combining marks only
    expect(cleanName('a b c')).toBe('abc');
    expect(cleanName('Ann Lee')).toBe('Ann Lee'); // a visible name may hold any space inside
  });

  it('emoji sequences keep their joiners and the emoji variation selector', () => {
    const family = '\u{1F469}‍\u{1F467}'; // woman ZWJ girl
    expect(cleanName(family)).toBe(family);
    expect(cleanName('❤️ crew')).toBe('❤️ crew');
    const thumbs = '\u{1F44D}\u{1F3FD}‍\u{1F525}';
    expect(cleanName(thumbs)).toBe(thumbs);
    // ... but not between letters, nor a selector after a letter.
    expect(cleanName('a‍b')).toBe('ab');
    expect(cleanName('a️')).toBe('a');
    expect(cleanName('\u{1F600}‍')).toBe('\u{1F600}');
  });

  it('what the rule keeps passes it again unchanged', () => {
    for (const t of ['Ada', '琥珀水手', 'Brass Helmsman', ' x ', '🚢 Skipper 🚢', 'a\u0000b', '‮evil', '\u{1F469}‍\u{1F467} x']) {
      const c = cleanName(t);
      expect(c).not.toBeNull();
      expect(cleanName(c!)).toBe(c);
    }
  });

  it('the server keeps the cleaned name and refuses a Hello whose name shows nothing', async () => {
    const h = new NetHarness({});
    await h.create();
    await h.host.control({ type: 'openRoom' });
    for (const [i, name] of ['   ', '\u200B \u2067', '\u3164', '\u202E\u202C'].entries()) {
      const c = h.addRawClient(`bad-${i}`, {}, { hello: false });
      c.hello({ name });
      h.run(20);
      expect(c.refuse?.reason, JSON.stringify(name)).toBe('bad_hello');
    }
    const g = h.addClient('guest', {}, { name: '\u202Eevil\u202C RLO' });
    h.run(100);
    expect(g.welcome).not.toBeNull();
    expect(g.welcome!.players.map((p) => p.name)).toEqual(['evil RLO']);
  });
});
