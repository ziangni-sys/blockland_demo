/**
 * Items. Every placeable block is an item with the same numeric id as its block.
 * Non-block items start at 1024.
 */
import { MAX_BLOCK_ID } from './cell';
import { B } from './defs';
import { BLOCKS, type BlockDef } from './registry';

export interface ItemDef {
  id: number;
  key: string;
  nameZh: string;
  nameEn: string;
  maxStack: number;
  /** Block id placed by this item, or -1. */
  block: number;
  /** Tile name used as a flat icon; null for block items (icon is drawn from the block). */
  icon: string | null;
}

export interface ItemStack {
  item: number;
  count: number;
}

export const I = {
  GLUE: 1024,
  BUCKET: 1025,
  BUCKET_WATER: 1026,
  BUCKET_LAVA: 1027,
} as const;

const EXTRA: ItemDef[] = [
  { id: I.GLUE, key: 'glue', nameZh: '强力胶', nameEn: 'Superglue', maxStack: 64, block: -1, icon: 'item_glue' },
  { id: I.BUCKET, key: 'bucket', nameZh: '桶', nameEn: 'Bucket', maxStack: 16, block: -1, icon: 'item_bucket' },
  { id: I.BUCKET_WATER, key: 'bucket_water', nameZh: '水桶', nameEn: 'Water Bucket', maxStack: 1, block: -1, icon: 'item_bucket_water' },
  { id: I.BUCKET_LAVA, key: 'bucket_lava', nameZh: '熔岩桶', nameEn: 'Lava Bucket', maxStack: 1, block: -1, icon: 'item_bucket_lava' },
];

/** Blocks that are never items (cannot be held or placed directly). */
const NOT_ITEMS = new Set<number>([B.AIR, B.WATER, B.LAVA, B.UNLOADED]);

const ITEMS = new Map<number, ItemDef>();
for (const def of BLOCKS) {
  if (!def || NOT_ITEMS.has(def.id)) continue;
  ITEMS.set(def.id, blockItem(def));
}
for (const it of EXTRA) ITEMS.set(it.id, it);

function blockItem(def: BlockDef): ItemDef {
  return { id: def.id, key: def.key, nameZh: def.nameZh, nameEn: def.nameEn, maxStack: 64, block: def.id, icon: null };
}

export function itemDef(id: number): ItemDef {
  const it = ITEMS.get(id);
  if (!it) throw new Error(`unknown item id ${id}`);
  return it;
}
export function isItem(id: number): boolean {
  return ITEMS.has(id);
}
export function isBlockItem(id: number): boolean {
  return id >= 0 && id <= MAX_BLOCK_ID && ITEMS.has(id);
}
/** All items in creative-palette order. */
export function allItems(): ItemDef[] {
  return [...ITEMS.values()];
}
