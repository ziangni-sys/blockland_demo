/**
 * Block registry: static properties of every block type, plus flat lookup tables for hot paths.
 * This file defines the SHAPE of block data; the actual table lives in defs.ts.
 */
import { ID_MASK, MAX_BLOCK_ID } from './cell';

/** How the 6 state bits are interpreted (see cell.ts). */
export type StateKind = 'none' | 'axis' | 'facing' | 'liquid' | 'layers';

/**
 * Auto-stick group (docs/DESIGN.md "连接"):
 *  - 'cloth'  : every wool colour + canvas stick to each other
 *  - 'planks' : every plank type sticks to each other
 *  - 'self'   : sticks only to the same block id
 *  - 'log'    : sticks only to the same log id with the same axis, and only ALONG that axis
 *  - 'none'   : never auto-sticks (terrain list, liquids, air, plants ...)
 */
export type StickGroup = 'cloth' | 'planks' | 'self' | 'log' | 'none';

/** Functional mounting face: which neighbour a functional block sticks to on its own. */
export type MountFace = 'none' | 'below' | 'back';

/** Functional (control / machine) block kinds. Never part of a rotor. */
export type FuncKind = 'none' | 'helm' | 'bearing' | 'propeller';

export type LiquidKind = 0 | 1 | 2; // 0 none, 1 water, 2 lava
export const LIQUID_NONE: LiquidKind = 0;
export const LIQUID_WATER: LiquidKind = 1;
export const LIQUID_LAVA: LiquidKind = 2;

/** Geometry family used by the mesher. */
export type RenderShape =
  | 'none' // air
  | 'cube' // full cube, 6 tiles
  | 'cross' // two crossed quads (plants)
  | 'liquid' // level-dependent surface
  | 'torch' // thin post standing on the floor
  | 'layers' // slab whose height depends on state (snow)
  | 'cactus' // inset cube
  | 'helm' // pedestal + wheel
  | 'bearing' // cube with a raised front plate
  | 'propeller'; // hub + blades

/** Which render pass the block's faces go to. */
export type RenderLayer = 'opaque' | 'cutout' | 'translucent';

/** What an item-drop the block yields when mined in survival. `null` = drops nothing. */
export interface DropSpec {
  item: number; // item id (block ids double as item ids)
  count: number;
}

export interface BlockDef {
  id: number;
  /** Stable string key, used in saves and code (`B.STONE` etc. are generated from it). */
  key: string;
  nameZh: string;
  nameEn: string;

  // ---- physics / classification
  /**
   * HARD block = full-cube collider. Everything else is SOFT (air, liquids, plants, torch,
   * snow layers): no collision, and structures overwrite it when they blockify.
   */
  solid: boolean;
  /** Fully opaque cube: hides neighbour faces and blocks all light. */
  opaque: boolean;
  /** How much light is lost passing through (0..15). Opaque blocks are 15. */
  lightOpacity: number;
  /** Block light emitted (0..15). */
  emit: number;
  liquid: LiquidKind;
  /** Can be overwritten by placing a block into it (air, liquids, tall grass, snow layer). */
  replaceable: boolean;
  /** Seconds to mine by hand in survival. Infinity = unbreakable. 0 = instant. */
  hardness: number;
  /** Cannot be mined, glued or assembled into a structure (docs/DESIGN.md "挖不动的方块"). */
  unbreakable: boolean;
  /** Mass of one block relative to one block of water (water = 1). Used for ship buoyancy. */
  density: number;
  /** Falls when unsupported (sand, gravel). */
  gravity: boolean;
  /**
   * Needs a supporting block directly below, else it pops off as a drop:
   *  'none' | 'solid' (any HARD block below) | 'sandOrSelf' (cactus).
   */
  support: 'none' | 'solid' | 'sandOrSelf';
  /** Explodes when triggered (TNT-like). */
  explosive: boolean;
  /** Blast resistance: explosion strength needed to destroy it. Infinity = immune. */
  blastResistance: number;

  // ---- connectivity
  stick: StickGroup;
  mount: MountFace;
  func: FuncKind;
  /** Counts as a sail for windmill power (wool + canvas). */
  sail: boolean;

  // ---- state
  stateKind: StateKind;

  // ---- drops
  /** undefined = drops itself; null = drops nothing. */
  drop?: DropSpec | null;

  // ---- rendering
  shape: RenderShape;
  layer: RenderLayer;
  /** Tile NAMES; meaning of each slot depends on shape/stateKind — see the table at the top of defs.ts. */
  tiles: string[];
  /** Resolved tile layer indices, same order as `tiles` (filled by the registry). */
  tileIds: number[];
}

/** Sparse table indexed by block id. Unregistered ids are `undefined`. */
export const BLOCKS: Array<BlockDef | undefined> = new Array(MAX_BLOCK_ID + 1);
export const BLOCK_BY_KEY: Map<string, BlockDef> = new Map();

// ---- flat per-id tables (index with a block ID, or `cell & ID_MASK`)
export const SOLID = new Uint8Array(MAX_BLOCK_ID + 1);
export const OPAQUE = new Uint8Array(MAX_BLOCK_ID + 1);
export const LIGHT_OPACITY = new Uint8Array(MAX_BLOCK_ID + 1);
export const EMIT = new Uint8Array(MAX_BLOCK_ID + 1);
export const LIQUID = new Uint8Array(MAX_BLOCK_ID + 1);
export const REPLACEABLE = new Uint8Array(MAX_BLOCK_ID + 1);
export const GRAVITY_BLOCK = new Uint8Array(MAX_BLOCK_ID + 1);
export const UNBREAKABLE = new Uint8Array(MAX_BLOCK_ID + 1);

// ---- tile name registry (texture array layers)
export const TILE_NAMES: string[] = [];
const tileIndex = new Map<string, number>();

/** Layer index of a tile name, registering it on first use. */
export function tileId(name: string): number {
  let i = tileIndex.get(name);
  if (i === undefined) {
    i = TILE_NAMES.length;
    TILE_NAMES.push(name);
    tileIndex.set(name, i);
  }
  return i;
}

export type BlockInit = Partial<Omit<BlockDef, 'id' | 'key' | 'tileIds'>> & { tiles: string[] };

export function registerBlock(id: number, key: string, init: BlockInit): BlockDef {
  if (id < 0 || id > MAX_BLOCK_ID) throw new Error(`block id out of range: ${id}`);
  if (BLOCKS[id]) throw new Error(`duplicate block id ${id} (${key})`);
  if (BLOCK_BY_KEY.has(key)) throw new Error(`duplicate block key ${key}`);
  const solid = init.solid ?? true;
  const opaque = init.opaque ?? solid;
  const def: BlockDef = {
    id,
    key,
    nameZh: init.nameZh ?? key,
    nameEn: init.nameEn ?? key,
    solid,
    opaque,
    lightOpacity: init.lightOpacity ?? (opaque ? 15 : 0),
    emit: init.emit ?? 0,
    liquid: init.liquid ?? LIQUID_NONE,
    replaceable: init.replaceable ?? false,
    hardness: init.hardness ?? 1,
    unbreakable: init.unbreakable ?? false,
    density: init.density ?? 1,
    gravity: init.gravity ?? false,
    support: init.support ?? 'none',
    explosive: init.explosive ?? false,
    blastResistance: init.blastResistance ?? 3,
    stick: init.stick ?? 'self',
    mount: init.mount ?? 'none',
    func: init.func ?? 'none',
    sail: init.sail ?? false,
    stateKind: init.stateKind ?? 'none',
    drop: init.drop,
    shape: init.shape ?? 'cube',
    layer: init.layer ?? 'opaque',
    tiles: init.tiles,
    tileIds: init.tiles.map(tileId),
  };
  BLOCKS[id] = def;
  BLOCK_BY_KEY.set(key, def);
  SOLID[id] = def.solid ? 1 : 0;
  OPAQUE[id] = def.opaque ? 1 : 0;
  LIGHT_OPACITY[id] = def.lightOpacity;
  EMIT[id] = def.emit;
  LIQUID[id] = def.liquid;
  REPLACEABLE[id] = def.replaceable ? 1 : 0;
  GRAVITY_BLOCK[id] = def.gravity ? 1 : 0;
  UNBREAKABLE[id] = def.unbreakable ? 1 : 0;
  return def;
}

/** Definition for a cell or block id (state bits are ignored). Throws on unknown ids. */
export function blockDef(cellOrId: number): BlockDef {
  const def = BLOCKS[cellOrId & ID_MASK];
  if (!def) throw new Error(`unknown block id ${cellOrId & ID_MASK}`);
  return def;
}

/** True when the cell is a HARD (full-cube collider) block. */
export function isSolidCell(cell: number): boolean {
  return SOLID[cell & ID_MASK] === 1;
}
export function isOpaqueCell(cell: number): boolean {
  return OPAQUE[cell & ID_MASK] === 1;
}
export function isLiquidCell(cell: number): boolean {
  return LIQUID[cell & ID_MASK] !== 0;
}
