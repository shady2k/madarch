/**
 * A kind's name in the reader's language. The manifest names each kind in the
 * interface languages (`labels` in `madarch/kinds.yaml`); the app draws that
 * name and, for a kind whose manifest gives none, the kind's key made readable.
 * The labels come in the wiki's status, so the context is the status's kinds.
 */
import { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { kindPlural, kindWord } from './routes.js';
import type { KindSummary } from './types.js';

export const KindLabels = createContext<readonly KindSummary[]>([]);

/** The name of a kind for `language`: the manifest's label, else its English one, else the key made readable. */
export function kindNameOf(kinds: readonly KindSummary[], kind: string, form: 'one' | 'many', language: string): string {
  const labels = kinds.find((entry) => entry.kind === kind)?.labels;
  const label = labels?.[language.startsWith('ru') ? 'ru' : 'en'] ?? labels?.['en'];
  if (label !== undefined) return label[form];
  return form === 'one' ? kindWord(kind) : kindPlural(kind);
}

/** The naming function for the language the interface speaks now. */
export function useKindName(): (kind: string, form: 'one' | 'many') => string {
  const kinds = useContext(KindLabels);
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  return (kind, form) => kindNameOf(kinds, kind, form, language);
}
