/**
 * Contact-sheet tool for the procedural art (NOT a test). Writes PNGs for visual review:
 *   tiles_N.png    every TILE_NAMES tile scaled x8 over a checkerboard, labelled
 *   seams_N.png    4x4 tilings of the repeating materials (seam check), x3
 *   distance.png   8x8 tilings at x1 (how calm large surfaces look from afar)
 *   icons_N.png    every item icon at 64, 32 and 16 px on a UI-slot background
 *   scene.png      a small z-buffered voxel diorama (materials side by side)
 *
 * Run: ART_SHEET_OUT=<dir> npx vitest run tests/art/tools
 * (vite-node is not installed, so a guarded vitest file drives this module.)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allItems, type ItemDef } from '../../../src/blocks/items';
import { TILE_NAMES } from '../../../src/blocks/registry';
import { TILE_SIZE } from '../../../src/core/constants';
import { renderItemIcon } from '../../../src/art/icons';
import { paintTile, tileAlphaMode } from '../../../src/art/tiles';
import { Image, textWidth } from './image';
import { encodePng } from './png';
import { buildDiorama } from './scene';

const T = TILE_SIZE;

/** Materials that repeat across large surfaces (frames / sprites / overlays excluded). */
export const SEAM_TILES: readonly string[] = [
  'stone', 'cobble', 'dirt', 'turf_top', 'turf_side', 'sand', 'gravel', 'deeprock',
  'log_oak_side', 'log_pine_side', 'planks_oak', 'planks_pine', 'leaves_oak', 'leaves_pine',
  'stone_bricks', 'bricks', 'sandstone_side', 'sandstone_top', 'obsidian', 'coal_ore', 'iron_ore', 'copper_ore',
  'iron_block', 'lamp', 'snow', 'ice', 'clay', 'water_still', 'water_flow', 'lava_still', 'lava_flow',
  'wool_white', 'wool_red', 'wool_orange', 'wool_yellow', 'wool_green', 'wool_blue', 'wool_purple', 'wool_black',
  'canvas', 'cactus_side', 'helm_base',
];

function save(dir: string, name: string, img: Image): string {
  const path = join(dir, name);
  writeFileSync(path, encodePng(img.w, img.h, img.data));
  return path;
}

function chunks<V>(list: readonly V[], n: number): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

function tileSheets(dir: string): string[] {
  const scale = 8;
  const cols = 6;
  const cellW = T * scale + 16;
  const cellH = T * scale + 24;
  return chunks(TILE_NAMES, 24).map((names, page) => {
    const rows = Math.ceil(names.length / cols);
    const img = new Image(cols * cellW, rows * cellH);
    names.forEach((name, i) => {
      const x = (i % cols) * cellW + 8;
      const y = Math.floor(i / cols) * cellH + 4;
      img.checker(x, y, T * scale, T * scale, 16);
      img.blit(paintTile(name), T, T, x, y, scale);
      const label = `${name} ${tileAlphaMode(name)[0]}`;
      img.text(label, x + Math.max(0, (T * scale - textWidth(label, 2)) / 2), y + T * scale + 5, 2);
    });
    return save(dir, `tiles_${page + 1}.png`, img);
  });
}

function seamSheets(dir: string): string[] {
  const scale = 3;
  const reps = 4;
  const cols = 5;
  const span = T * scale * reps;
  const cellW = span + 12;
  const cellH = span + 22;
  return chunks(SEAM_TILES, 15).map((names, page) => {
    const rows = Math.ceil(names.length / cols);
    const img = new Image(cols * cellW, rows * cellH);
    names.forEach((name, i) => {
      const x = (i % cols) * cellW + 6;
      const y = Math.floor(i / cols) * cellH + 4;
      const px = paintTile(name);
      img.checker(x, y, span, span, 12);
      for (let ry = 0; ry < reps; ry++) for (let rx = 0; rx < reps; rx++) img.blit(px, T, T, x + rx * T * scale, y + ry * T * scale, scale);
      img.text(name, x, y + span + 5, 2);
    });
    return save(dir, `seams_${page + 1}.png`, img);
  });
}

function distanceSheet(dir: string): string {
  const reps = 8;
  const cols = 8;
  const span = T * reps;
  const cellW = span + 10;
  const cellH = span + 16;
  const rows = Math.ceil(SEAM_TILES.length / cols);
  const img = new Image(cols * cellW, rows * cellH);
  SEAM_TILES.forEach((name, i) => {
    const x = (i % cols) * cellW + 5;
    const y = Math.floor(i / cols) * cellH + 3;
    const px = paintTile(name);
    for (let ry = 0; ry < reps; ry++) for (let rx = 0; rx < reps; rx++) img.blit(px, T, T, x + rx * T, y + ry * T, 1);
    img.text(name, x, y + span + 4, 1);
  });
  return save(dir, 'distance.png', img);
}

function iconSheets(dir: string): string[] {
  const sizes = [64, 32, 16];
  const cols = 5;
  const cellW = 64 + 32 + 16 + 4 * 8 + 16;
  const cellH = 64 + 26;
  return chunks(allItems(), 30).map((items: ItemDef[], page) => {
    const rows = Math.ceil(items.length / cols);
    const img = new Image(cols * cellW, rows * cellH, [44, 46, 54]);
    items.forEach((it, i) => {
      let x = (i % cols) * cellW + 8;
      const y = Math.floor(i / cols) * cellH + 6;
      for (const s of sizes) {
        // Slot backdrop similar to a UI slot: dark inset square.
        img.rect(x - 2, y - 2 + (64 - s), s + 4, s + 4, [28, 29, 35]);
        img.blit(renderItemIcon(it.id, s), s, s, x, y + (64 - s), 1);
        x += s + 8;
      }
      img.text(it.key, (i % cols) * cellW + 8, y + 64 + 8, 1);
    });
    return save(dir, `icons_${page + 1}.png`, img);
  });
}

/** Compound-shape icons at 48 px, magnified x4, to inspect edges and overlaps pixel by pixel. */
function iconZoomSheet(dir: string): string {
  const ids = [50, 51, 52, 70, 74, 14, 12, 60, 8, 61];
  const s = 48;
  const z = 4;
  const cols = 5;
  const cell = s * z + 12;
  const img = new Image(cols * cell, Math.ceil(ids.length / cols) * (cell + 12), [44, 46, 54]);
  ids.forEach((id, i) => {
    const x = (i % cols) * cell + 6;
    const y = Math.floor(i / cols) * (cell + 12) + 6;
    img.checker(x, y, s * z, s * z, 16);
    img.blit(renderItemIcon(id, s), s, s, x, y, z);
    img.text(String(id), x, y + s * z + 3, 2);
  });
  return save(dir, 'icons_zoom.png', img);
}

/** A z-buffered voxel diorama: how the materials sit next to each other in the world. */
function sceneSheet(dir: string): string {
  const img = buildDiorama().render(48, [150, 190, 206]);
  return save(dir, 'scene.png', img);
}

/** Writes every sheet into `dir` and returns the file paths. */
export function writeContactSheets(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  return [...tileSheets(dir), ...seamSheets(dir), distanceSheet(dir), ...iconSheets(dir), iconZoomSheet(dir), sceneSheet(dir)];
}
