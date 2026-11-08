/**
 * The general kinds a passage of a document can be (madarch-ztyq.3, decision 0032 section 4).
 *
 * This module holds the vocabulary alone: the reader of the product's documents at request time is deleted, and the
 * stage of the fill that reads them comes back with its classifier and the stored readings it used.
 */

/** The general kinds a passage of a document can be. */
export type SemanticKind = 'scenario' | 'actor' | 'rule' | 'quality' | 'decision' | 'procedure' | 'term' | 'other';

/** Every general kind, in the order the decision names them. */
export const SEMANTIC_KINDS: readonly SemanticKind[] = ['scenario', 'actor', 'rule', 'quality', 'decision', 'procedure', 'term', 'other'];

/** Whether a text names a general kind. */
export function isSemanticKind(value: string): value is SemanticKind {
  return (SEMANTIC_KINDS as readonly string[]).includes(value);
}
