/**
 * The block table. Ids are stable (they are written to saves): never renumber, only append.
 *
 * Tile conventions (the `tiles` array of a block, by shape / stateKind):
 *   cube + 'none'   : 6 tiles in face order [+X, -X, +Y, -Y, +Z, -Z]
 *   cube + 'axis'   : [side, end]            (end = the two faces perpendicular to the axis)
 *   bearing         : [front, back, side]    (front = facing dir)
 *   propeller       : [hub, blade, back]
 *   helm            : [base, wheel]
 *   cross / torch / layers : [tile]
 *   cactus          : [side, top, bottom]
 *   liquid          : [still, flow]
 */
import { PX } from '../core/dirs';
import { facingState, makeCell } from './cell';
import { LIQUID_LAVA, LIQUID_WATER, registerBlock, tileId, type BlockDef, type BlockInit } from './registry';

const all = (t: string): string[] => [t, t, t, t, t, t];
const tsb = (top: string, side: string, bottom: string): string[] => [side, side, top, bottom, side, side];

/** Natural terrain: never auto-sticks (docs/DESIGN.md "地形名单不自动粘"). */
const terrain = (init: BlockInit): BlockInit => ({ stick: 'none', ...init });
/** Non-colliding decoration. */
const soft = (init: BlockInit): BlockInit => ({
  solid: false,
  opaque: false,
  lightOpacity: 0,
  stick: 'none',
  hardness: 0,
  density: 0.1,
  blastResistance: 0,
  layer: 'cutout',
  ...init,
});

function reg(id: number, key: string, zh: string, en: string, init: BlockInit): BlockDef {
  return registerBlock(id, key, { nameZh: zh, nameEn: en, ...init });
}

// id 0 — air
reg(0, 'air', '空气', 'Air', {
  solid: false,
  opaque: false,
  lightOpacity: 0,
  replaceable: true,
  hardness: 0,
  density: 0,
  stick: 'none',
  shape: 'none',
  drop: null,
  blastResistance: 0,
  tiles: [],
});

// ---------------------------------------------------------------- terrain
reg(1, 'stone', '岩石', 'Stone', terrain({ hardness: 1.5, density: 2.6, blastResistance: 6, tiles: all('stone'), drop: { item: 2, count: 1 } }));
reg(2, 'cobble', '碎岩', 'Rubble', terrain({ hardness: 2, density: 2.4, blastResistance: 6, tiles: all('cobble') }));
reg(3, 'dirt', '泥土', 'Dirt', terrain({ hardness: 0.5, density: 1.5, blastResistance: 1, tiles: all('dirt') }));
reg(4, 'turf', '草皮', 'Turf', terrain({ hardness: 0.6, density: 1.5, blastResistance: 1, tiles: tsb('turf_top', 'turf_side', 'dirt'), drop: { item: 3, count: 1 } }));
reg(5, 'sand', '沙', 'Sand', terrain({ hardness: 0.5, density: 1.6, gravity: true, blastResistance: 1, tiles: all('sand') }));
reg(6, 'gravel', '砾石', 'Gravel', terrain({ hardness: 0.6, density: 1.8, gravity: true, blastResistance: 1, tiles: all('gravel') }));
reg(7, 'deeprock', '界岩', 'Deeprock', terrain({ hardness: Infinity, unbreakable: true, density: 3, blastResistance: Infinity, tiles: all('deeprock') }));

// ---------------------------------------------------------------- wood
reg(8, 'log_oak', '阔叶原木', 'Broadleaf Log', { hardness: 2, density: 0.6, stick: 'log', stateKind: 'axis', tiles: ['log_oak_side', 'log_oak_end'] });
reg(9, 'log_pine', '针叶原木', 'Conifer Log', { hardness: 2, density: 0.55, stick: 'log', stateKind: 'axis', tiles: ['log_pine_side', 'log_pine_end'] });
reg(10, 'planks_oak', '阔叶木板', 'Broadleaf Planks', { hardness: 1.5, density: 0.5, stick: 'planks', tiles: all('planks_oak') });
reg(11, 'planks_pine', '针叶木板', 'Conifer Planks', { hardness: 1.5, density: 0.45, stick: 'planks', tiles: all('planks_pine') });
reg(12, 'leaves_oak', '阔叶树叶', 'Broadleaf Leaves', terrain({ hardness: 0.2, density: 0.15, opaque: false, lightOpacity: 1, layer: 'cutout', blastResistance: 0.2, tiles: all('leaves_oak'), drop: null }));
reg(13, 'leaves_pine', '针叶树叶', 'Conifer Leaves', terrain({ hardness: 0.2, density: 0.15, opaque: false, lightOpacity: 1, layer: 'cutout', blastResistance: 0.2, tiles: all('leaves_pine'), drop: null }));

// ---------------------------------------------------------------- building
reg(14, 'glass', '玻璃', 'Glass', { hardness: 0.3, density: 0.9, opaque: false, lightOpacity: 0, layer: 'cutout', blastResistance: 0.3, tiles: all('glass') });
reg(15, 'stone_bricks', '石砖', 'Stone Bricks', { hardness: 1.5, density: 2.5, blastResistance: 6, tiles: all('stone_bricks') });
reg(16, 'bricks', '红砖', 'Bricks', { hardness: 2, density: 2, blastResistance: 6, tiles: all('bricks') });
reg(17, 'sandstone', '砂岩砖', 'Sandstone', { hardness: 0.8, density: 2.2, blastResistance: 4, tiles: tsb('sandstone_top', 'sandstone_side', 'sandstone_top') });
reg(18, 'obsidian', '黑曜岩', 'Obsidian', terrain({ hardness: 10, density: 2.6, blastResistance: 1200, tiles: all('obsidian') }));
reg(19, 'coal_ore', '煤矿石', 'Coal Ore', terrain({ hardness: 3, density: 2.2, blastResistance: 3, tiles: all('coal_ore') }));
reg(20, 'iron_ore', '铁矿石', 'Iron Ore', terrain({ hardness: 3, density: 3.5, blastResistance: 3, tiles: all('iron_ore') }));
reg(21, 'copper_ore', '铜矿石', 'Copper Ore', terrain({ hardness: 3, density: 3.2, blastResistance: 3, tiles: all('copper_ore') }));
reg(22, 'iron_block', '铁块', 'Iron Block', { hardness: 5, density: 7.8, blastResistance: 6, tiles: all('iron_block') });
reg(23, 'lamp', '晶石灯', 'Crystal Lamp', { hardness: 0.3, density: 1, emit: 15, blastResistance: 0.3, tiles: all('lamp') });
reg(24, 'snow_block', '积雪', 'Packed Snow', terrain({ hardness: 0.2, density: 0.4, blastResistance: 0.2, tiles: all('snow') }));
reg(25, 'ice', '冰', 'Ice', terrain({ hardness: 0.5, density: 0.92, opaque: false, lightOpacity: 2, layer: 'translucent', blastResistance: 0.5, tiles: all('ice') }));
reg(26, 'clay', '黏土', 'Clay', terrain({ hardness: 0.6, density: 1.8, blastResistance: 1, tiles: all('clay') }));

// ---------------------------------------------------------------- liquids
reg(30, 'water', '水', 'Water', {
  solid: false, opaque: false, lightOpacity: 2, liquid: LIQUID_WATER, replaceable: true,
  hardness: Infinity, density: 1, stick: 'none', stateKind: 'liquid', shape: 'liquid',
  layer: 'translucent', drop: null, blastResistance: Infinity, tiles: ['water_still', 'water_flow'],
});
reg(31, 'lava', '熔岩', 'Lava', {
  solid: false, opaque: false, lightOpacity: 2, emit: 15, liquid: LIQUID_LAVA, replaceable: true,
  hardness: Infinity, density: 3, stick: 'none', stateKind: 'liquid', shape: 'liquid',
  layer: 'opaque', drop: null, blastResistance: Infinity, tiles: ['lava_still', 'lava_flow'],
});

// ---------------------------------------------------------------- cloth (one stick group, all sails)
export const WOOL_COLORS = ['white', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'] as const;
const WOOL_ZH = ['白', '红', '橙', '黄', '绿', '蓝', '紫', '黑'];
WOOL_COLORS.forEach((c, i) => {
  reg(40 + i, `wool_${c}`, `${WOOL_ZH[i]}色绒布`, `${c[0]!.toUpperCase()}${c.slice(1)} Felt`, {
    hardness: 0.8, density: 0.25, stick: 'cloth', sail: true, blastResistance: 0.8, tiles: all(`wool_${c}`),
  });
});
reg(48, 'canvas', '帆布', 'Canvas', { hardness: 0.6, density: 0.15, stick: 'cloth', sail: true, blastResistance: 0.6, tiles: all('canvas') });

// ---------------------------------------------------------------- functional
reg(50, 'helm', '舵轮', 'Helm', {
  hardness: 1.5, density: 0.6, opaque: false, lightOpacity: 0, stick: 'none', mount: 'below', func: 'helm',
  stateKind: 'facing', shape: 'helm', tiles: ['helm_base', 'helm_wheel'],
});
reg(51, 'bearing', '轴承', 'Bearing', {
  hardness: 2, density: 1.5, stick: 'none', mount: 'back', func: 'bearing',
  stateKind: 'facing', shape: 'bearing', tiles: ['bearing_front', 'bearing_back', 'bearing_side'],
});
reg(52, 'propeller', '螺旋桨', 'Propeller', {
  hardness: 1.5, density: 1, opaque: false, lightOpacity: 0, stick: 'none', mount: 'back', func: 'propeller',
  stateKind: 'facing', shape: 'propeller', layer: 'cutout', tiles: ['propeller_hub', 'propeller_blade', 'propeller_back'],
});

// ---------------------------------------------------------------- utility
reg(60, 'torch', '火把', 'Torch', soft({ emit: 14, mount: 'below', support: 'solid', shape: 'torch', tiles: ['torch'] }));
reg(61, 'tnt', '爆破箱', 'Blast Crate', { hardness: 0.3, density: 1.2, explosive: true, blastResistance: 0, tiles: tsb('tnt_top', 'tnt_side', 'tnt_bottom') });

// ---------------------------------------------------------------- plants & cover
reg(70, 'cactus', '仙人掌', 'Cactus', terrain({ hardness: 0.4, density: 0.6, opaque: false, lightOpacity: 0, support: 'sandOrSelf', shape: 'cactus', layer: 'cutout', blastResistance: 0.4, tiles: ['cactus_side', 'cactus_top', 'cactus_bottom'] }));
reg(71, 'flower_red', '红绒花', 'Emberbloom', soft({ support: 'solid', shape: 'cross', tiles: ['flower_red'] }));
reg(72, 'flower_yellow', '金盏花', 'Sunpetal', soft({ support: 'solid', shape: 'cross', tiles: ['flower_yellow'] }));
reg(73, 'tall_grass', '草丛', 'Grass Tuft', soft({ support: 'solid', replaceable: true, shape: 'cross', tiles: ['tall_grass'], drop: null }));
reg(74, 'snow_layer', '雪层', 'Snow Cover', soft({ support: 'solid', replaceable: true, hardness: 0.1, stateKind: 'layers', shape: 'layers', layer: 'opaque', tiles: ['snow'], drop: null }));

// ---------------------------------------------------------------- sentinel
/**
 * Returned by World.getCell() for positions in chunks that are not loaded. Behaves as an
 * unbreakable solid so nothing flows / walks / assembles into the unknown. Structure
 * physics must additionally FREEZE near it (docs/LESSONS.md "船被弹飞").
 */
reg(1023, 'unloaded', '未加载', 'Unloaded', {
  hardness: Infinity, unbreakable: true, stick: 'none', shape: 'none', drop: null, blastResistance: Infinity, tiles: [],
});

// Extra tiles that are not block faces (UI icons, overlays). Registered here so the
// texture array contains them; the art module must be able to paint every TILE_NAMES entry.
export const EXTRA_TILES = [
  'item_glue', 'item_bucket', 'item_bucket_water', 'item_bucket_lava',
  'glue_face', // drawn on glued faces
  'crack_0', 'crack_1', 'crack_2', 'crack_3', 'crack_4', 'crack_5', 'crack_6', 'crack_7', // mining progress
] as const;
EXTRA_TILES.forEach(tileId);

/** Block ids by name. */
export const B = {
  AIR: 0,
  STONE: 1,
  COBBLE: 2,
  DIRT: 3,
  TURF: 4,
  SAND: 5,
  GRAVEL: 6,
  DEEPROCK: 7,
  LOG_OAK: 8,
  LOG_PINE: 9,
  PLANKS_OAK: 10,
  PLANKS_PINE: 11,
  LEAVES_OAK: 12,
  LEAVES_PINE: 13,
  GLASS: 14,
  STONE_BRICKS: 15,
  BRICKS: 16,
  SANDSTONE: 17,
  OBSIDIAN: 18,
  COAL_ORE: 19,
  IRON_ORE: 20,
  COPPER_ORE: 21,
  IRON_BLOCK: 22,
  LAMP: 23,
  SNOW_BLOCK: 24,
  ICE: 25,
  CLAY: 26,
  WATER: 30,
  LAVA: 31,
  WOOL_WHITE: 40,
  WOOL_RED: 41,
  WOOL_ORANGE: 42,
  WOOL_YELLOW: 43,
  WOOL_GREEN: 44,
  WOOL_BLUE: 45,
  WOOL_PURPLE: 46,
  WOOL_BLACK: 47,
  CANVAS: 48,
  HELM: 50,
  BEARING: 51,
  PROPELLER: 52,
  TORCH: 60,
  TNT: 61,
  CACTUS: 70,
  FLOWER_RED: 71,
  FLOWER_YELLOW: 72,
  TALL_GRASS: 73,
  SNOW_LAYER: 74,
  UNLOADED: 1023,
} as const;

/** Cell returned for unloaded positions. */
export const CELL_UNLOADED = makeCell(B.UNLOADED);
/** Cell used below the world (y < 0). */
export const CELL_BELOW_WORLD = makeCell(B.DEEPROCK);
/** Default state for a facing block placed without context. */
export const DEFAULT_FACING_STATE = facingState(PX);
