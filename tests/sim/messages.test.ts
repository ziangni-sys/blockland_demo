import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGES, MESSAGE_KEYS, failMessage, formatMessage, isMessageKey } from '../../src/sim/messages';

const SIM_DIR = join(__dirname, '../../src/sim');

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe('message table', () => {
  it('zh and en have exactly the same keys and the same placeholders', () => {
    const zh = Object.keys(MESSAGES.zh).sort();
    const en = Object.keys(MESSAGES.en).sort();
    expect(zh).toEqual(en);
    expect([...MESSAGE_KEYS].sort()).toEqual(en);
    for (const k of en) {
      expect(placeholders(MESSAGES.zh[k]!), k).toEqual(placeholders(MESSAGES.en[k]!));
      expect(MESSAGES.zh[k]!.length, k).toBeGreaterThan(0);
    }
  });

  it('every key the simulation code emits exists', () => {
    const files = readdirSync(SIM_DIR).filter((f) => f.endsWith('.ts'));
    const used = new Set<string>();
    for (const f of files) {
      if (f === 'messages.ts') continue;
      const src = readFileSync(join(SIM_DIR, f), 'utf8');
      for (const m of src.matchAll(/['"`]((?:hint|toast|fail|generic)\.[A-Za-z_.]+)['"`]/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(20);
    for (const k of used) expect(isMessageKey(k), k).toBe(true);
  });

  it('every assembly failure reason has its own message', () => {
    const ship = ['not_a_helm', 'too_big', 'unloaded'];
    const rotor = ['not_a_bearing', 'no_hub', 'too_big', 'not_enough_sails', 'unloaded', 'has_rotor', 'nested_rotor', 'not_world'];
    for (const r of ship) expect(failMessage('ship', r).key).toBe(`fail.ship.${r}`);
    for (const r of rotor) expect(failMessage('rotor', r).key).toBe(`fail.rotor.${r}`);
    // An unknown reason still renders readable text.
    const m = failMessage('rotor', 'brand_new_reason');
    expect(m.key).toBe('fail.rotor.other');
    expect(formatMessage('en', m)).toContain('brand_new_reason');
  });

  it('formats parameters in both languages; unknown keys render as themselves', () => {
    expect(formatMessage('en', { key: 'hint.helm.assemble', params: { count: 42 } })).toBe('Right-click again to assemble (42 blocks)');
    expect(formatMessage('zh', { key: 'hint.helm.assemble', params: { count: 42 } })).toBe('再次右键确认组装（42 格）');
    expect(formatMessage('zh', { key: 'no.such.key' })).toBe('no.such.key');
  });
});
