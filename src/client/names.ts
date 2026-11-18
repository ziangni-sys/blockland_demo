/**
 * The player's name (package 11; docs/NETCODE.md section 3 "玩家身份"): the rule of
 * net/names.ts cleanName, the same the server applies to Hello (invisible characters removed, the
 * ends trimmed, 1 to MAX_NAME_LENGTH code points with something visible). It is sent in Hello and
 * shown to the others.
 *
 * Asked once: until the player confirmed a name, none is stored and the page asks (the name
 * screen) before the first world or join; the field starts with a suggestion, a short original
 * name made from the player key (so it stays the same between visits until one is chosen). Kept
 * in localStorage beside the identity: `playerName`, or `playerName:<slot>` for a `?slot=` page,
 * so two pages of one browser can carry two names.
 */
import { cleanName } from '../net/names';
import type { Language } from '../ui/model';
import type { KeyValueStore } from './settings';

/** The localStorage key of the name (and `${PLAYER_NAME_STORAGE}:<slot>` for a slot). */
export const PLAYER_NAME_STORAGE = 'playerName';

const WORDS: Readonly<Record<Language, { first: readonly string[]; second: readonly string[]; join: string }>> = {
  zh: {
    first: ['琥珀', '松木', '黄铜', '晨雾', '北风', '青石', '白帆', '赤陶', '雪松', '海盐', '橡木', '铁锚', '灯塔', '芦苇', '石英', '云杉'],
    second: ['水手', '木匠', '舵手', '桅工', '铆工', '绘图员', '帆匠', '渡客', '学徒', '领航员', '石匠', '瞭望员', '船匠', '摆渡人', '测量员', '风车匠'],
    join: '',
  },
  en: {
    first: ['Amber', 'Pine', 'Brass', 'Misty', 'North', 'Slate', 'Linen', 'Clay', 'Cedar', 'Salt', 'Oak', 'Anchor', 'Beacon', 'Reed', 'Quartz', 'Spruce'],
    second: ['Rigger', 'Joiner', 'Helmsman', 'Riveter', 'Drafter', 'Sailmaker', 'Ferrier', 'Apprentice', 'Pilot', 'Mason', 'Lookout', 'Shipwright', 'Boatman', 'Surveyor', 'Millwright', 'Deckhand'],
    join: ' ',
  },
};

/** FNV-1a of `s` (a stable pick from the player key; not a secret). */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The suggested name for `playerKey` in `lang`: two words picked by the key (same key, same name). */
export function suggestedName(playerKey: string, lang: Language): string {
  const w = WORDS[lang];
  const h = hash(playerKey);
  return `${w.first[h % w.first.length]!}${w.join}${w.second[(h >>> 8) % w.second.length]!}`;
}

function storageKey(slot: string | null): string {
  return slot === null ? PLAYER_NAME_STORAGE : `${PLAYER_NAME_STORAGE}:${slot}`;
}

/** The name the player chose for `slot`, or null when none is stored (or the stored one breaks the rules). */
export function storedName(store: KeyValueStore | null, slot: string | null): string | null {
  let v: string | null;
  try {
    v = store?.getItem(storageKey(slot)) ?? null;
  } catch {
    return null;
  }
  return v === null ? null : cleanName(v);
}

/** Keep `name` (already clean) for `slot`; false when the browser would not store it (then it lasts as long as the page). */
export function storeName(store: KeyValueStore | null, slot: string | null, name: string): boolean {
  try {
    if (store === null) return false;
    store.setItem(storageKey(slot), name);
    return true;
  } catch {
    return false;
  }
}
