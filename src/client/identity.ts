/**
 * The player's identity in this browser (docs/NETCODE.md section 3 "玩家身份"): a random 128-bit
 * key (32 hex characters) kept in localStorage, sent only to the server in Hello. Single player
 * uses it too, so a world opened to guests later keeps the host's own record. The address
 * parameter `?slot=<name>` picks another identity (stored under `playerKey:<name>`), for a second
 * page in the same browser and the two-page tests (package 14).
 *
 * Without localStorage (an opaque-origin sandbox, blocked site data) the key lives as long as the
 * page: such a page cannot save its worlds either.
 */
import type { KeyValueStore } from './settings';

/** The localStorage key of the identity (and `${PLAYER_KEY_STORAGE}:<slot>` for a slot). */
export const PLAYER_KEY_STORAGE = 'playerKey';
/** The name sent in Hello until names can be chosen (package 11). */
export const DEFAULT_PLAYER_NAME = 'Player';
/** Slot names: what a person would type in the address, kept short. */
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_RE = /^[0-9a-f]{32}$/;

/** The slot named by the page address (`?slot=<name>`), or null. */
export function slotFromSearch(search: string | undefined | null): string | null {
  if (!search) return null;
  let slot: string | null;
  try {
    slot = new URLSearchParams(search).get('slot');
  } catch {
    return null;
  }
  return slot !== null && SLOT_RE.test(slot) ? slot : null;
}

/** 32 random hex characters from `random` (it fills a byte array). */
export function newPlayerKey(random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const bytes = new Uint8Array(16);
  random(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * The player key of this browser for `slot` (null = the default identity): the stored one, or a
 * new one, stored when `store` can keep it.
 */
export function playerKeyFor(store: KeyValueStore | null, slot: string | null, random: (bytes: Uint8Array<ArrayBuffer>) => void): string {
  const name = slot === null ? PLAYER_KEY_STORAGE : `${PLAYER_KEY_STORAGE}:${slot}`;
  let stored: string | null = null;
  try {
    stored = store?.getItem(name) ?? null;
  } catch {
    stored = null;
  }
  if (stored !== null && KEY_RE.test(stored)) return stored;
  const key = newPlayerKey(random);
  try {
    store?.setItem(name, key);
  } catch {
    // not kept: a new identity next time
  }
  return key;
}

/** Random bytes from the page's crypto, or Math.random where there is none. */
export function pageRandom(win: Window): (bytes: Uint8Array<ArrayBuffer>) => void {
  const c = (win as Window & { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') return (bytes) => void c.getRandomValues(bytes);
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  };
}
