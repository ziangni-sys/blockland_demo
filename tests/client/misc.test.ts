import { describe, expect, it } from 'vitest';
import { ToastList, MAX_TOASTS, TOAST_LIFE_ERROR_MS, TOAST_LIFE_MS } from '../../src/client/toasts';
import { describeError, Faults, type FaultRecord } from '../../src/client/faults';
import { clientText } from '../../src/client/strings';
import { UiStateBuilder, type UiInputs } from '../../src/client/uistate';
import { Inventory } from '../../src/entities/inventory';
import { DEFAULT_SETTINGS } from '../../src/ui/model';
import { B } from '../../src/blocks/defs';

describe('ToastList', () => {
  it('adds, expires and keeps the list identity until something changes', () => {
    const t = new ToastList();
    const empty = t.list;
    t.push('a', 'info', 0);
    const one = t.list;
    expect(one).not.toBe(empty);
    expect(one.map((x) => x.text)).toEqual(['a']);
    expect(t.update(TOAST_LIFE_MS - 1)).toBe(false);
    expect(t.list).toBe(one);
    expect(t.update(TOAST_LIFE_MS)).toBe(true);
    expect(t.list).toEqual([]);
  });

  it('errors live longer; repeats refresh instead of stacking', () => {
    const t = new ToastList();
    t.push('x', 'error', 0);
    t.push('x', 'error', 5000);
    expect(t.list.length).toBe(1);
    t.update(TOAST_LIFE_ERROR_MS + 100);
    expect(t.list.length).toBe(1);
    t.update(5000 + TOAST_LIFE_ERROR_MS);
    expect(t.list.length).toBe(0);
  });

  it('caps the number of toasts and gives unique ids', () => {
    const t = new ToastList();
    for (let i = 0; i < 10; i++) t.push(`m${i}`, 'info', i);
    expect(t.list.length).toBe(MAX_TOASTS);
    expect(t.list[t.list.length - 1]!.text).toBe('m9');
    expect(new Set(t.list.map((x) => x.id)).size).toBe(MAX_TOASTS);
  });
});

describe('Faults', () => {
  it('reports each distinct fault once and counts repeats', () => {
    const first: FaultRecord[] = [];
    const logs: string[] = [];
    const f = new Faults(
      (r) => first.push(r),
      (m) => logs.push(m),
    );
    f.report('meshing', new Error('bad'));
    f.report('meshing', new Error('bad'));
    f.report('meshing', new Error('worse'));
    f.report('render', 'oops');
    expect(first.map((r) => `${r.what}:${r.message}`)).toEqual(['meshing:Error: bad', 'meshing:Error: worse', 'render:oops']);
    expect(logs.length).toBe(3);
    expect(f.total).toBe(4);
    expect(f.recent[0]!.count).toBe(2);
  });

  it('never throws from a broken reporter', () => {
    const f = new Faults(() => {
      throw new Error('reporter broke');
    });
    expect(() => f.report('x', 1)).not.toThrow();
  });

  it('describes anything thrown', () => {
    expect(describeError(new TypeError('t'))).toBe('TypeError: t');
    expect(describeError('s')).toBe('s');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeError(cyclic)).toBe('[object Object]');
  });
});

describe('clientText', () => {
  it('fills placeholders in both languages', () => {
    expect(clientText('en', 'loading.terrain', { done: 3, total: 49 })).toBe('Generating terrain 3/49');
    expect(clientText('zh', 'loading.terrain', { done: 3, total: 49 })).toBe('正在生成地形 3/49');
    expect(clientText('en', 'save.failed')).toBe('Saving failed: {msg}');
  });
});

const WORLDS: UiInputs['worlds'] = [];

function inputs(inv: Inventory | null, over: Partial<UiInputs> = {}): UiInputs {
  return {
    screen: 'none',
    settingsReturn: 'mainMenu',
    mode: 'creative',
    inventory: inv,
    selected: 0,
    health: 20,
    maxHealth: 20,
    air: 300,
    maxAir: 300,
    hint: null,
    toasts: [],
    debug: null,
    helm: null,
    worlds: WORLDS,
    settings: DEFAULT_SETTINGS,
    loading: null,
    pointerLocked: true,
    dragLook: false,
    renderer: 'WebGL2',
    version: '0.1.0',
    ...over,
  };
}

describe('UiStateBuilder', () => {
  it('returns the same object while nothing changed', () => {
    const b = new UiStateBuilder();
    const inv = new Inventory();
    const toasts: never[] = [];
    const a = b.build(inputs(inv, { toasts }));
    const c = b.build(inputs(inv, { toasts, debug: null, helm: null }));
    expect(c).toBe(a);
  });

  it('rebuilds only the parts that changed and reuses unchanged slot views', () => {
    const b = new UiStateBuilder();
    const inv = new Inventory();
    inv.add(B.STONE, 10);
    inv.main[3] = { item: B.SAND, count: 5 };
    const toasts: never[] = [];
    const s1 = b.build(inputs(inv, { toasts }));
    expect(s1.hotbar[0]).toEqual({ item: B.STONE, count: 10 });
    expect(s1.inventory[3]).toEqual({ item: B.SAND, count: 5 });
    inv.hotbar[0]!.count = 9;
    const s2 = b.build(inputs(inv, { toasts }));
    expect(s2).not.toBe(s1);
    expect(s2.hotbar).not.toBe(s1.hotbar);
    expect(s2.hotbar[0]).toEqual({ item: B.STONE, count: 9 });
    expect(s2.inventory).toBe(s1.inventory);
    const s3 = b.build(inputs(inv, { toasts, selected: 4 }));
    expect(s3.selected).toBe(4);
    expect(s3.hotbar).toBe(s2.hotbar);
  });

  it('compares debug lines and the helm read-out by value', () => {
    const b = new UiStateBuilder();
    const toasts: never[] = [];
    const s1 = b.build(inputs(null, { toasts, debug: ['a', 'b'], helm: { throttle: 0.5, rudder: 0, speed: 1, sails: 4 } }));
    const s2 = b.build(inputs(null, { toasts, debug: ['a', 'b'], helm: { throttle: 0.501, rudder: 0, speed: 1.001, sails: 4 } }));
    expect(s2).toBe(s1);
    const s3 = b.build(inputs(null, { toasts, debug: ['a', 'c'], helm: { throttle: 0.5, rudder: 0, speed: 1, sails: 4 } }));
    expect(s3).not.toBe(s1);
    expect(s3.helm).toBe(s1.helm);
  });

  it('shows empty slots without a world and ignores empty stacks', () => {
    const b = new UiStateBuilder();
    const s = b.build(inputs(null));
    expect(s.hotbar.length).toBe(9);
    expect(s.inventory.length).toBe(27);
    expect(s.hotbar.every((x) => x === null)).toBe(true);
    const inv = new Inventory();
    inv.hotbar[2] = { item: B.DIRT, count: 0 };
    expect(b.build(inputs(inv)).hotbar[2]).toBeNull();
  });
});
