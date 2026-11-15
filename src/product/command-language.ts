/**
 * The language a command speaks before a product exists to name one: `MADARCH_LANG` when a person set it, else the
 * machine's own locale. The wiki's own language setting belongs to the product, and there is none yet at init time.
 */
export type CommandLanguage = 'en' | 'ru';

export function commandLanguage(env: Readonly<Record<string, string | undefined>> = process.env): CommandLanguage {
  const chosen = (env['MADARCH_LANG'] ?? env['LC_ALL'] ?? env['LC_MESSAGES'] ?? env['LANG'] ?? '').toLowerCase();
  return chosen.startsWith('ru') ? 'ru' : 'en';
}
