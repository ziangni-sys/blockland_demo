import { describe, expect, it } from 'vitest';
import { B } from '../../src/blocks/defs';
import { allItems, I, itemDef } from '../../src/blocks/items';
import {
  groupItems,
  hashId,
  itemAltName,
  itemInitials,
  itemName,
  matchesQuery,
  normalizeQuery,
  PALETTE_GROUP_ORDER,
  paletteGroupOf,
  placeholderHue,
  searchText,
} from '../../src/ui/palette';

describe('item names', () => {
  it('localizes from the item table', () => {
    expect(itemName(B.CANVAS, 'zh')).toBe('帆布');
    expect(itemName(B.CANVAS, 'en')).toBe('Canvas');
    expect(itemAltName(B.CANVAS, 'zh')).toBe('Canvas');
    expect(itemAltName(B.CANVAS, 'en')).toBe('帆布');
    expect(itemName(I.GLUE, 'en')).toBe('Superglue');
  });

  it('falls back gracefully for unknown ids', () => {
    expect(itemName(9999, 'en')).toBe('Unknown item #9999');
    expect(itemName(9999, 'zh')).toBe('未知物品 #9999');
    expect(itemAltName(9999, 'en')).toBe('');
  });
});

describe('creative palette grouping', () => {
  const items = allItems();
  const groups = groupItems(items);

  it('places every item in exactly one group', () => {
    const seen = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(seen.length).toBe(items.length);
    expect(new Set(seen).size).toBe(items.length);
  });

  it('keeps the declared group order and drops empty groups', () => {
    const order = groups.map((g) => g.id);
    const expected = PALETTE_GROUP_ORDER.filter((id) => order.includes(id));
    expect(order).toEqual(expected);
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
  });

  it('groups sensibly', () => {
    const group = (id: number): string => paletteGroupOf(itemDef(id));
    for (const id of [B.HELM, B.BEARING, B.PROPELLER, I.GLUE]) expect(group(id)).toBe('mechanisms');
    for (const id of [B.WOOL_WHITE, B.WOOL_BLACK, B.CANVAS]) expect(group(id)).toBe('cloth');
    for (const id of [B.PLANKS_OAK, B.LOG_PINE, B.GLASS, B.STONE_BRICKS, B.LAMP, B.IRON_BLOCK]) expect(group(id)).toBe('building');
    for (const id of [B.STONE, B.DIRT, B.SAND, B.IRON_ORE, B.LEAVES_OAK, B.OBSIDIAN]) expect(group(id)).toBe('terrain');
    for (const id of [B.FLOWER_RED, B.TALL_GRASS, B.SNOW_LAYER]) expect(group(id)).toBe('nature');
    for (const id of [B.TORCH, B.TNT, I.BUCKET, I.BUCKET_WATER]) expect(group(id)).toBe('utility');
  });

  it('keeps registry order inside a group', () => {
    const cloth = groups.find((g) => g.id === 'cloth')!;
    const ids = cloth.items.map((i) => i.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe('palette search', () => {
  const canvas = searchText(itemDef(B.CANVAS));
  const planks = searchText(itemDef(B.PLANKS_OAK));

  it('normalizes queries', () => {
    expect(normalizeQuery('  Broadleaf   PLANKS ')).toBe('broadleaf planks');
    expect(normalizeQuery('')).toBe('');
  });

  it('matches either language and the stable key, case-insensitively', () => {
    expect(matchesQuery(canvas, normalizeQuery('帆'))).toBe(true);
    expect(matchesQuery(canvas, normalizeQuery('CAN'))).toBe(true);
    expect(matchesQuery(planks, normalizeQuery('planks oak'))).toBe(true);
    expect(matchesQuery(planks, normalizeQuery('木板'))).toBe(true);
  });

  it('requires every token', () => {
    expect(matchesQuery(planks, normalizeQuery('planks pine'))).toBe(false);
    expect(matchesQuery(canvas, normalizeQuery('felt'))).toBe(false);
  });

  it('empty query matches everything', () => {
    expect(matchesQuery(canvas, '')).toBe(true);
  });
});

describe('placeholder icons', () => {
  it('derives initials from the English name', () => {
    expect(itemInitials(B.STONE)).toBe('St');
    expect(itemInitials(B.LOG_OAK)).toBe('BL');
    expect(itemInitials(I.BUCKET_WATER)).toBe('WB');
    expect(itemInitials(9999)).toBe('#9');
  });

  it('hashes deterministically to a hue in range', () => {
    expect(hashId(42)).toBe(hashId(42));
    expect(hashId(42)).not.toBe(hashId(43));
    for (const it of allItems()) {
      const hue = placeholderHue(it.id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
