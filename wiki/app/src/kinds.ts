/**
 * The set's document kinds, on the app's side: the order the sidebar groups
 * by. It mirrors the server's own reading (src/product-wiki/documents.ts,
 * KIND_ORDER, where the order and its reason stand); the repo's tests hold
 * this list to the server's, so the two cannot drift. The labels live in
 * the i18n catalogues under `kinds.`.
 */
export const KIND_ORDER: readonly string[] = [
  'vision',
  'roadmap',
  'milestone',
  'sources',
  'hypotheses',
  'stories',
  'use-cases',
  'requirements',
  'decisions',
  'design',
  'architecture',
  'capability',
  'change',
  'exploration',
  'questions',
  'prototypes',
  'results',
  'practices',
  'practices-retired',
];
