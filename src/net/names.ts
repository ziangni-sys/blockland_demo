/**
 * The rule of a player name (docs/NETCODE.md section 3 "玩家身份", section 18 package 11): the
 * server applies it to every Hello (net/host/netserver.ts) and the client to what the player types
 * (client/names.ts), so a name the page accepts is never refused.
 *
 * Removed: control characters (C0, DEL, C1), format characters (bidi overrides, embeddings and
 * isolates, zero-width spaces and joiners, the BOM, the soft hyphen ...), other default-ignorable
 * code points (fillers that draw nothing), line and paragraph separators and lone surrogates. A
 * zero-width joiner between two pictographs and the emoji variation selector after one stay, so
 * emoji sequences keep their look. Then the ends are trimmed. The name must keep at least one
 * character that draws something (not only spaces or combining marks) and at most
 * MAX_NAME_LENGTH code points. Without format characters no name can reverse or hide the text
 * around it in a list, a toast or a name tag.
 */
import { MAX_NAME_LENGTH } from './protocol';

const INVISIBLE = /[\p{Cc}\p{Cf}\p{DI}\p{Zl}\p{Zp}\p{Cs}]/gu;
/** A pictograph, possibly with a skin-tone modifier or the emoji variation selector, just before a position. */
const PICTOGRAPH_BEFORE = /\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\u{FE0F}]?$/u;
const PICTOGRAPH_AFTER = /^\p{Extended_Pictographic}/u;
const VISIBLE = /[^\s\p{Z}\p{M}]/u;

/** `name` cleaned by the rule above, or null when it breaks it. */
export function cleanName(name: string): string | null {
  const clean = name
    .replace(INVISIBLE, (ch: string, at: number, all: string) => {
      const before = PICTOGRAPH_BEFORE.test(all.slice(Math.max(0, at - 4), at));
      if (ch === '\u{FE0F}') return before ? ch : '';
      if (ch === '\u{200D}') return before && PICTOGRAPH_AFTER.test(all.slice(at + 1, at + 3)) ? ch : '';
      return '';
    })
    .trim();
  const n = [...clean].length;
  return n >= 1 && n <= MAX_NAME_LENGTH && VISIBLE.test(clean) ? clean : null;
}
