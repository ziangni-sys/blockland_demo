/**
 * Item presentation logic: localized names, creative-palette grouping, search matching and
 * the deterministic placeholder icon parameters. Pure (no DOM); tested in Node.
 */
import { BLOCKS } from '../blocks/registry';
import { I, isItem, itemDef, type ItemDef } from '../blocks/items';
import { t, type StringKey } from './i18n';
import type { Language } from './model';

/** Localized item name; unknown ids get a readable fallback instead of throwing mid-frame. */
export function itemName(id: number, lang: Language): string {
  if (!isItem(id)) return t(lang, 'item.unknown', { id });
  const def = itemDef(id);
  return lang === 'en' ? def.nameEn : def.nameZh;
}

/** The other language's name, shown as a muted second line in tooltips. */
export function itemAltName(id: number, lang: Language): string {
  if (!isItem(id)) return '';
  const def = itemDef(id);
  return lang === 'en' ? def.nameZh : def.nameEn;
}

export type PaletteGroupId = 'mechanisms' | 'cloth' | 'building' | 'terrain' | 'nature' | 'utility';

/** Display order of the palette groups: the structure-building kit first. */
export const PALETTE_GROUP_ORDER: readonly PaletteGroupId[] = ['mechanisms', 'cloth', 'building', 'terrain', 'nature', 'utility'];

export const PALETTE_GROUP_LABEL: Readonly<Record<PaletteGroupId, StringKey>> = {
  mechanisms: 'group.mechanisms',
  cloth: 'group.cloth',
  building: 'group.building',
  terrain: 'group.terrain',
  nature: 'group.nature',
  utility: 'group.utility',
};

/**
 * Which palette group an item belongs to. Derived from block properties rather than a
 * hand-kept list, so blocks appended to defs.ts land somewhere sensible automatically.
 */
export function paletteGroupOf(item: ItemDef): PaletteGroupId {
  if (item.block < 0) {
    // Glue is the structure-building tool, so it sits with the helm and bearing.
    return item.id === I.GLUE ? 'mechanisms' : 'utility';
  }
  const b = BLOCKS[item.block];
  if (!b) return 'utility';
  if (b.func !== 'none') return 'mechanisms';
  if (b.sail || b.stick === 'cloth') return 'cloth';
  if (b.explosive) return 'utility';
  if (!b.solid) return b.emit > 0 ? 'utility' : 'nature';
  if (b.stick === 'none') return 'terrain';
  return 'building';
}

export interface PaletteGroup {
  id: PaletteGroupId;
  label: StringKey;
  items: ItemDef[];
}

/** Group items for the creative palette, keeping each group in the input (registry) order. */
export function groupItems(items: readonly ItemDef[]): PaletteGroup[] {
  const buckets = new Map<PaletteGroupId, ItemDef[]>();
  for (const id of PALETTE_GROUP_ORDER) buckets.set(id, []);
  for (const it of items) buckets.get(paletteGroupOf(it))!.push(it);
  const out: PaletteGroup[] = [];
  for (const id of PALETTE_GROUP_ORDER) {
    const list = buckets.get(id)!;
    if (list.length > 0) out.push({ id, label: PALETTE_GROUP_LABEL[id], items: list });
  }
  return out;
}

/** Lower-cased, whitespace-collapsed search text. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Everything an item can be found by: both names and its stable key (with spaces for `_`). */
export function searchText(item: ItemDef): string {
  return `${item.nameZh} ${item.nameEn} ${item.key.replace(/_/g, ' ')}`.toLowerCase();
}

/**
 * True when every whitespace-separated token of the (normalized) query occurs in the item's
 * search text. Both languages always match, whatever the UI language, so a bilingual player
 * can type either.
 */
export function matchesQuery(haystack: string, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;
  for (const token of normalizedQuery.split(' ')) if (!haystack.includes(token)) return false;
  return true;
}

/**
 * Up to two letters for the placeholder icon: initials of the first two words of the English
 * name ("Broadleaf Log" -> "BL"), or the first two letters of a single word ("Stone" -> "St").
 */
export function itemInitials(id: number): string {
  const name = isItem(id) ? itemDef(id).nameEn : `#${id}`;
  const words = name.split(/[\s_-]+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const w = words[0]!;
    return w.length === 1 ? w.toUpperCase() : w[0]!.toUpperCase() + w[1]!.toLowerCase();
  }
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** 32-bit integer hash (lowbias32): well-spread hues for consecutive ids. */
export function hashId(id: number): number {
  let x = id | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic placeholder colour for an item: hue from the id hash, fixed sat/lightness. */
export function placeholderHue(id: number): number {
  return hashId(id) % 360;
}
