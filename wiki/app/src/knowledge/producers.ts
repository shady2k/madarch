/**
 * Who fills one catalogue entity (madarch-stm0.6). The engine states this in `fillWith`; a fixture or an older answer
 * that leaves it out is read the same way the engine reads the manifest: the plugins a kind's fields bind and the
 * built-in code, documents and history passes are its own producers, a person's page is the person's, and everything
 * else is the general agent plugin's. No list of kinds stands here.
 */
import type { CatalogKindView } from './types.js';

export type FillWith = 'own' | 'agent' | 'person';

export function fillWithOf(kind: CatalogKindView): FillWith {
  if (kind.fillWith !== undefined) return kind.fillWith;
  if ((kind.plugins ?? []).length > 0) return 'own';
  if (kind.producer === 'extract' || kind.producer === 'documents' || kind.producer === 'history') return 'own';
  if (kind.producer === 'person') return 'person';
  return 'agent';
}
