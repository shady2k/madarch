import type { CatalogKindView } from './types.js';

/** Producer names are declarations, never inferred from a plugin category. */
export function pluginNames(kind: CatalogKindView): readonly string[] {
  return kind.plugins ?? [];
}
