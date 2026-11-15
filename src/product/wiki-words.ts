/**
 * The wiki's own words for the buttons and pages the init steps quote, read from the wiki app's locale files so the
 * steps cannot drift from the interface they describe (madarch-64o5.84). One source of each name: the app's
 * `locales/en.json` and `locales/ru.json`, imported as data.
 */
import en from '../../wiki/app/src/locales/en.json';
import ru from '../../wiki/app/src/locales/ru.json';
import type { CommandLanguage } from './command-language.js';

/** The names the steps quote, as the wiki writes them in one language. */
export interface WikiWords {
  /** "Which role do you read as?" — the card a first visit shows. */
  readonly roleQuestion: string;
  /** "Fill…" — the button that opens what to fill. */
  readonly fill: string;
  /** "Entity catalogue" — the page where the kinds are picked. */
  readonly catalogue: string;
  /** "Preparing the fill" — the page where the run is set up. */
  readonly prepare: string;
  /** "Only plugins" — the preparation's plain choice. */
  readonly pluginsOnly: string;
  /** "Start the fill" — the preparation's own button. */
  readonly start: string;
}

/** The wiki's words in the reader's language, from the app's locale files. */
export function wikiWords(language: CommandLanguage): WikiWords {
  const held = (language === 'ru' ? ru : en) as { knowledge: { roles: { cardTitle: string }; fillRun: { open: string }; catalogue: string }; navigation: { catalogue: string }; prepare: { title: string; pluginsOnly: string; run: string } };
  return {
    roleQuestion: held.knowledge.roles.cardTitle,
    fill: held.knowledge.fillRun.open,
    catalogue: held.navigation.catalogue,
    prepare: held.prepare.title,
    pluginsOnly: held.prepare.pluginsOnly,
    start: held.prepare.run,
  };
}
