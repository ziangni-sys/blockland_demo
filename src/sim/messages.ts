/**
 * Localised text for messages the simulation emits (hints under the crosshair, toasts).
 * The simulation only ever produces a Message { key, params }; the client renders it with
 * formatMessage(). Every key must exist in both languages.
 */
import type { Message } from './view';

export type Lang = 'zh' | 'en';

export const MESSAGES: Record<Lang, Record<string, string>> = {
  zh: {
    'generic.unknown': '{key}',
  },
  en: {
    'generic.unknown': '{key}',
  },
};

/** Render a message in a language; unknown keys render as the key itself. `{name}` placeholders are filled from params. */
export function formatMessage(lang: Lang, msg: Message): string {
  const template = MESSAGES[lang][msg.key] ?? MESSAGES.en[msg.key] ?? msg.key;
  const params = msg.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
