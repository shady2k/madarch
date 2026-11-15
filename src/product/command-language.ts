/**
 * The language a command speaks before a product exists to name one (madarch-64o5.84): `MADARCH_LANG` when a person set
 * it, else the language the person chose on this machine — kept in the madarch home's `settings.json`, the same file the
 * wiki's reading role lives in — else the machine's own locale. The wiki's own language setting belongs to the product.
 */
import { readLanguage } from '../knowledge/settings.js';

export type CommandLanguage = 'en' | 'ru';

/** The language the machine remembers, when it remembers one. */
export function rememberedLanguage(env: Readonly<Record<string, string | undefined>> = process.env): CommandLanguage | undefined {
  try {
    return readLanguage(env);
  } catch {
    return undefined;
  }
}

export function commandLanguage(env: Readonly<Record<string, string | undefined>> = process.env): CommandLanguage {
  const named = env['MADARCH_LANG'];
  if (named !== undefined && named.trim() !== '') return named.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const remembered = rememberedLanguage(env);
  if (remembered !== undefined) return remembered;
  const chosen = (env['LC_ALL'] ?? env['LC_MESSAGES'] ?? env['LANG'] ?? '').toLowerCase();
  return chosen.startsWith('ru') ? 'ru' : 'en';
}
