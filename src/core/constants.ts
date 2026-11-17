/** Global constants shared by simulation, meshing and client. */

/** Fixed simulation rate. Rendering interpolates between ticks. */
export const TPS = 20;
export const TICK_DT = 1 / TPS;

/** Chunk columns are CHUNK_SIZE x WORLD_HEIGHT x CHUNK_SIZE. */
export const CHUNK_SIZE = 16;
export const CHUNK_SHIFT = 4;
export const CHUNK_MASK = 15;
export const WORLD_HEIGHT = 128;
/** Meshing granularity: a chunk column is meshed as stacked 16^3 sections. */
export const SECTION_SIZE = 16;
export const SECTIONS_PER_CHUNK = WORLD_HEIGHT / SECTION_SIZE;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

/** Water fills cells with y < SEA_LEVEL in oceans (top water cell is SEA_LEVEL - 1). */
export const SEA_LEVEL = 48;

/** Light levels are 0..15 for both sky light and block light. */
export const MAX_LIGHT = 15;

/** Pixel size of one block texture tile. */
export const TILE_SIZE = 16;

/** Length of a full day in ticks (20 min real time). */
export const DAY_TICKS = 24000;

/** Assembly limits (docs/DESIGN.md). */
export const SHIP_MAX_CELLS = 4000;
export const ROTOR_MAX_CELLS = 400;
export const ROTOR_MIN_SAILS = 4;
