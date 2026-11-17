/**
 * How a block or item looks when it is drawn by the renderer itself rather than by the
 * mesher: dropped items, falling blocks, primed blast crates. Pure (imports only the block
 * tables; no three.js) and unit-tested.
 *
 * Face order everywhere is the Dir order [+X, -X, +Y, -Y, +Z, -Z].
 */
import { AXIS_Y, type Dir } from '../../core/dirs';
import { axisState, cellId, cellState, makeCell, stateAxis, stateFacing } from '../../blocks/cell';
import { B } from '../../blocks/defs';
import { isBlockItem, isItem, itemDef } from '../../blocks/items';
import { BLOCKS, TILE_NAMES, type RenderLayer } from '../../blocks/registry';

/** A cube with one tile per face. */
export interface CubeVisual {
  kind: 'cube';
  tiles: [number, number, number, number, number, number];
  layer: RenderLayer;
  emissive: boolean;
}
/** A flat double-sided icon quad. */
export interface IconVisual {
  kind: 'icon';
  tile: number;
}
export interface NoVisual {
  kind: 'none';
}
export type ItemVisual = CubeVisual | IconVisual | NoVisual;

const NONE: NoVisual = Object.freeze({ kind: 'none' }) as NoVisual;

/**
 * Tiles of the 6 faces of a full cube showing `cell` (id + state), or null when the block
 * has no cube-like appearance (air, plants, torches, helms, propellers ...).
 */
export function cubeTilesForCell(cell: number): CubeVisual | null {
  const def = BLOCKS[cellId(cell)];
  if (!def || def.tileIds.length === 0) return null;
  const t = def.tileIds;
  const state = cellState(cell);
  const out: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  switch (def.shape) {
    case 'cube': {
      if (def.stateKind === 'axis') {
        const axis = stateAxis(state);
        for (let f = 0; f < 6; f++) out[f] = (f >> 1) === axis ? t[1] ?? t[0]! : t[0]!;
      } else if (t.length >= 6) {
        for (let f = 0; f < 6; f++) out[f] = t[f]!;
      } else {
        out.fill(t[0]!);
      }
      break;
    }
    case 'bearing': {
      const front: Dir = stateFacing(state);
      const back = front ^ 1;
      for (let f = 0; f < 6; f++) out[f] = f === front ? t[0]! : f === back ? t[1] ?? t[0]! : t[2] ?? t[0]!;
      break;
    }
    case 'cactus': {
      out.fill(t[0]!);
      out[2] = t[1] ?? t[0]!;
      out[3] = t[2] ?? t[0]!;
      break;
    }
    case 'liquid':
    case 'layers':
      out.fill(t[0]!);
      break;
    default:
      return null;
  }
  return { kind: 'cube', tiles: out, layer: def.layer, emissive: def.emit > 0 };
}

/** Tile shown as a flat icon for a block that is not cube-like. */
function blockIconTile(id: number): number {
  const def = BLOCKS[id];
  if (!def || def.tileIds.length === 0) return -1;
  // Helms show their wheel, propellers their blade: the recognisable part.
  if (def.shape === 'helm' || def.shape === 'propeller') return def.tileIds[1] ?? def.tileIds[0]!;
  return def.tileIds[0]!;
}

/** Appearance of a dropped item stack. */
export function itemVisual(itemId: number): ItemVisual {
  if (!isItem(itemId)) return NONE;
  if (isBlockItem(itemId)) {
    const def = BLOCKS[itemId]!;
    // Logs lie on their side by default (state 0 = x axis); a dropped log reads better upright.
    const state = def.stateKind === 'axis' ? axisState(AXIS_Y) : 0;
    const cube = cubeTilesForCell(makeCell(itemId, state));
    if (cube) return cube;
    const tile = blockIconTile(itemId);
    return tile >= 0 ? { kind: 'icon', tile } : NONE;
  }
  const icon = itemDef(itemId).icon;
  if (icon === null) return NONE;
  const tile = TILE_NAMES.indexOf(icon);
  return tile >= 0 ? { kind: 'icon', tile } : NONE;
}

/** The blast crate's look (top / side / bottom tiles). */
export function blastCrateVisual(): CubeVisual {
  return cubeTilesForCell(B.TNT)!;
}

/** Texture layer of the n-th mining crack stage (0..7), or -1 when the tiles are missing. */
export function crackLayer(stage: number): number {
  const base = TILE_NAMES.indexOf('crack_0');
  if (base < 0) return -1;
  const s = stage < 0 ? 0 : stage > 7 ? 7 : stage | 0;
  return base + s;
}

/** Crack stage for a break progress 0..1; -1 = draw no cracks. */
export function crackStage(progress: number): number {
  if (!(progress > 0)) return -1;
  const s = Math.floor(progress * 8);
  return s > 7 ? 7 : s;
}

/** Texture layer of a named tile, -1 when unknown. */
export function tileLayer(name: string): number {
  return TILE_NAMES.indexOf(name);
}
