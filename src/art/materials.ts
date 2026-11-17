/**
 * The Blocklands palette: one place for every material ramp, so related materials stay
 * cohesive (turf side reuses the dirt ramp, ores sit on the stone ramp, ...).
 *
 * Art direction: slightly desaturated earth tones, teal-leaning water, warm amber woods,
 * hue-shifted shading (see color.ts). Ramps are darkest-first; `base` index noted per ramp.
 * These are immutable lookup tables (frozen), not shared mutable state.
 */
import { hex, ramp, rampOf, type Ramp, type RGB } from './color';

// ---------------------------------------------------------------- terrain
/** base index 2 */
export const STONE = ramp('#87857e', { step: 0.062, tint: 0.007 });
export const RUBBLE = ramp('#8e8a81', { step: 0.072, tint: 0.008 });
export const RUBBLE_MORTAR = rampOf('#2f2b33', '#403a41', '#4f4a4e');
export const DIRT = ramp('#7c5a3d', { step: 0.06, hueShift: 6 });
export const GRASS = ramp('#688c42', { step: 0.056, hueShift: 6, satShift: 0.05 });
export const SAND = ramp('#d3bd8b', { step: 0.042, hueShift: 6 });
export const GRAVEL_GAP: RGB = hex('#3a3434');
export const GRAVEL_KINDS: readonly Ramp[] = Object.freeze([
  ramp('#8b8984', { n: 4, baseIndex: 2, step: 0.075 }), // grey
  ramp('#8c7562', { n: 4, baseIndex: 2, step: 0.07 }), // brown
  ramp('#77818b', { n: 4, baseIndex: 2, step: 0.075 }), // blue-grey
  ramp('#a8957a', { n: 4, baseIndex: 2, step: 0.07 }), // tan
  ramp('#66625f', { n: 4, baseIndex: 2, step: 0.07 }), // dark
]);
export const DEEPROCK = ramp('#3d3b47', { step: 0.05, tint: 0.008 });
export const DEEPROCK_VEIN = rampOf('#4a3a63', '#6a4f8e', '#8c6db3');
export const OBSIDIAN = ramp('#221b30', { baseIndex: 1, step: 0.045, tint: 0.01 });
export const OBSIDIAN_GLOSS = rampOf('#3b3266', '#5c4fa3', '#8d80dc', '#cfc8f6');
export const SNOW = ramp('#e3eaf1', { baseIndex: 3, step: 0.04, hueShift: 4, tint: 0.008 });
export const ICE = ramp('#a3d4e2', { step: 0.05, hueShift: 4 });
export const CLAY = ramp('#8e99a7', { step: 0.042 });

// ---------------------------------------------------------------- ores
export const COAL = rampOf('#17161b', '#25242b', '#36353e', '#5d5f6c');
export const IRON_NUGGET = rampOf('#6e3f2c', '#9d6544', '#c79a72', '#e6d0a9');
export const COPPER_NUGGET = rampOf('#6f3519', '#b05a26', '#df873b', '#f5b86c');
export const PATINA = rampOf('#3f8a76', '#69b79b');

// ---------------------------------------------------------------- liquids
export const WATER = ramp('#2e7a8c', { step: 0.065, hueShift: 6, satShift: 0.03 });
/** Crust, cooling red, molten orange, amber, white-hot yellow. */
export const LAVA = rampOf('#3a1410', '#8a2a14', '#d8551b', '#f6a038', '#ffe17c');

// ---------------------------------------------------------------- wood
export const OAK_BARK = ramp('#6c4b31', { step: 0.06, hueShift: 7 });
export const PINE_BARK = ramp('#66382a', { step: 0.058, hueShift: 7 });
export const OAK_END = ramp('#b98c57', { baseIndex: 2, step: 0.055, hueShift: 6 });
export const PINE_END = ramp('#b98458', { baseIndex: 2, step: 0.055, hueShift: 6 });
export const PLANKS_OAK = ramp('#b6854a', { step: 0.058, hueShift: 7 });
export const PLANKS_PINE = ramp('#d5bb88', { step: 0.052, hueShift: 6 });
export const LEAVES_OAK = ramp('#4e7f36', { step: 0.068, hueShift: 10 });
export const LEAVES_PINE = ramp('#2f5a4b', { step: 0.062, hueShift: 8 });

// ---------------------------------------------------------------- building
export const GLASS_FRAME = rampOf('#9fbfc6', '#c4dfe3', '#e4f4f4', '#f8fefd');
export const STONE_BRICK = ramp('#8e8f8b', { step: 0.064, tint: 0.008 });
export const STONE_BRICK_MORTAR: RGB = hex('#45424a');
export const CLAY_BRICK = ramp('#9d4f3f', { step: 0.064, hueShift: 8 });
export const BRICK_MORTAR = rampOf('#9d968c', '#bdb5a7', '#d4ccbd');
export const SANDSTONE = ramp('#cdb07b', { step: 0.048, hueShift: 6 });
export const STEEL = ramp('#959ea6', { step: 0.075, hueShift: 6, tint: 0.006 });
export const BRASS = ramp('#b8913c', { step: 0.08, hueShift: 8 });
export const LAMP_GLOW = rampOf('#c0652a', '#e9953a', '#ffc35a', '#ffe7a0', '#fffbe8');
export const LAMP_FRAME = rampOf('#3e2a1e', '#5f402a', '#86603a');

/** Felt colours, keyed like WOOL_COLORS in blocks/defs.ts. */
export const WOOL: Readonly<Record<string, Ramp>> = Object.freeze({
  white: ramp('#e4ded2', { baseIndex: 3, step: 0.042, tint: 0.009 }),
  red: ramp('#a9403a', { step: 0.05, hueShift: 8 }),
  orange: ramp('#cf7834', { step: 0.05, hueShift: 7 }),
  yellow: ramp('#d8b54a', { step: 0.048, hueShift: 6 }),
  green: ramp('#5b8a3d', { step: 0.05, hueShift: 8 }),
  blue: ramp('#3e68a6', { step: 0.05, hueShift: 7 }),
  purple: ramp('#7a4999', { step: 0.05, hueShift: 7 }),
  black: ramp('#2e2b34', { baseIndex: 1, step: 0.045, tint: 0.01 }),
});
export const CANVAS_CLOTH = ramp('#dcd1b9', { baseIndex: 3, step: 0.042, tint: 0.007 });

// ---------------------------------------------------------------- functional / misc
export const HELM_WOOD = ramp('#7a5031', { step: 0.065, hueShift: 8 });
export const CRATE_WOOD = ramp('#a9794a', { step: 0.06, hueShift: 7 });
export const WARNING_RED = ramp('#b3372c', { step: 0.07, hueShift: 8 });
export const FUSE = rampOf('#2c2624', '#4d433d', '#7a6c60', '#a8988a');
export const CACTUS = ramp('#4c7b3a', { step: 0.064, hueShift: 9 });
export const CACTUS_FLESH = rampOf('#6f8a45', '#9fb36c', '#c4cf92');
export const SPINE: RGB = hex('#ece3bd');
export const STEM = rampOf('#2f5527', '#457a33', '#64a043');
export const RED_PETAL = ramp('#c53b33', { step: 0.075, hueShift: 10 });
export const YELLOW_PETAL = ramp('#e6be3c', { step: 0.07, hueShift: 8 });
export const TORCH_STICK = rampOf('#3a2a20', '#6f4b2e', '#9c7047');
export const FLAME = rampOf('#c2401c', '#f07a24', '#ffc046', '#fff3b8');
export const GLUE = rampOf('#7a4a12', '#b8741c', '#e3a032', '#f6cd6c', '#fff0bf');
export const CRACK: RGB = hex('#1b1720');
/** Light edge of a crack (fresh fracture surface catching the light). */
export const CRACK_CHIP: RGB = hex('#d6cfc2');
