/**
 * Controls reference as data (rendered by the pause menu and, abridged, by the main menu).
 * Pure; the i18n test checks every referenced key exists.
 */
import type { StringKey } from './i18n';

/**
 * One token of a key combination:
 *  - { k } a key cap; `k` is a literal label ("W", "Esc") or a 'key.*' string key
 *  - { sep } a separator printed between caps: '+' (together), '/' (either), '→' (then)
 *  - { word } a translated word printed as plain text (e.g. "again")
 */
export type KeyToken = { k: string } | { sep: '+' | '/' | '→' } | { word: StringKey };

export interface ControlRow {
  keys: readonly KeyToken[];
  desc: StringKey;
}

export interface ControlSection {
  title: StringKey;
  rows: readonly ControlRow[];
}

const k = (label: string): KeyToken => ({ k: label });
const PLUS: KeyToken = { sep: '+' };
const OR: KeyToken = { sep: '/' };
const THEN: KeyToken = { sep: '→' };
const RC = k('key.rightClick');

/** Full reference, in the order the pause menu shows it. */
export const CONTROLS: readonly ControlSection[] = [
  {
    title: 'ctl.sec.move',
    rows: [
      { keys: [k('W'), k('A'), k('S'), k('D')], desc: 'ctl.move' },
      { keys: [k('key.space')], desc: 'ctl.jump' },
      { keys: [k('key.spaceTwice')], desc: 'ctl.fly' },
      { keys: [k('key.space'), OR, k('key.shift')], desc: 'ctl.flyUpDown' },
      { keys: [k('key.shift')], desc: 'ctl.sneak' },
    ],
  },
  {
    title: 'ctl.sec.build',
    rows: [
      { keys: [k('key.leftClick')], desc: 'ctl.mine' },
      { keys: [RC], desc: 'ctl.place' },
      { keys: [k('1–9'), OR, k('key.wheel')], desc: 'ctl.select' },
      { keys: [k('key.middleClick')], desc: 'ctl.pick' },
      { keys: [k('F')], desc: 'ctl.swapHands' },
    ],
  },
  {
    title: 'ctl.sec.ui',
    rows: [
      { keys: [k('E')], desc: 'ctl.inventory' },
      { keys: [k('Esc')], desc: 'ctl.pause' },
      { keys: [k('F5')], desc: 'ctl.view' },
      { keys: [k('F3')], desc: 'ctl.debug' },
    ],
  },
  {
    title: 'ctl.sec.helm',
    rows: [
      { keys: [RC], desc: 'ctl.helmPreview' },
      { keys: [RC, { word: 'key.again' }], desc: 'ctl.helmAssemble' },
      { keys: [k('W'), OR, k('S')], desc: 'ctl.helmThrottle' },
      { keys: [k('A'), OR, k('D')], desc: 'ctl.helmRudder' },
      { keys: [RC, { word: 'key.again' }], desc: 'ctl.helmRelease' },
      { keys: [k('key.shift'), PLUS, RC], desc: 'ctl.helmDock' },
    ],
  },
  {
    title: 'ctl.sec.bearing',
    rows: [
      { keys: [RC], desc: 'ctl.bearingPreview' },
      { keys: [RC, { word: 'key.again' }], desc: 'ctl.bearingStart' },
      { keys: [RC], desc: 'ctl.bearingStop' },
    ],
  },
  {
    title: 'ctl.sec.glue',
    rows: [
      { keys: [RC], desc: 'ctl.glueApply' },
      { keys: [k('key.shift'), PLUS, RC], desc: 'ctl.glueRemove' },
      { keys: [k('F')], desc: 'ctl.glueOffhand' },
    ],
  },
];

/** Abridged cheat-sheet for the main menu: the essentials plus one line per mechanism. */
export const CHEAT_SHEET: readonly ControlRow[] = [
  { keys: [k('W'), k('A'), k('S'), k('D')], desc: 'ctl.move' },
  { keys: [k('key.space')], desc: 'ctl.jump' },
  { keys: [k('key.leftClick')], desc: 'ctl.mine' },
  { keys: [RC], desc: 'ctl.place' },
  { keys: [k('E')], desc: 'ctl.inventory' },
  { keys: [k('Esc')], desc: 'ctl.pause' },
  { keys: [RC, THEN, RC], desc: 'cheat.helm' },
  { keys: [RC, THEN, RC], desc: 'cheat.bearing' },
  { keys: [RC], desc: 'cheat.glue' },
  { keys: [k('F')], desc: 'ctl.swapHands' },
];

/** True when a key-cap label is a string-table key rather than a literal. */
export function isKeyRef(label: string): label is StringKey {
  return label.startsWith('key.');
}
