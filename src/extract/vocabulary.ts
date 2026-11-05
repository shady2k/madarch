/**
 * The extractors' vocabulary, gathered from the extractors themselves (decision 0033, item 7): each
 * extractor declares the node kinds and relation types it emits as data beside the code that emits them,
 * and this module reads those declarations, so nothing here is typed by hand and a kind an extractor starts
 * emitting is noticed by whoever reads this union — the catalog's mapping check does.
 *
 * The keys stay the engine's own (`code.`); a product's kinds are the catalog's, and the product's mapping
 * ties one to the other.
 */
import { CODE_EDGE_TYPES, CODE_NODE_KINDS, CODE_PRODUCER } from './code/keys.js';
import { CONTRACTS_EDGE_TYPES, CONTRACTS_NODE_KINDS, CONTRACTS_PRODUCER } from './contracts/schema.js';
import { DATA_MODEL_EDGE_TYPES, DATA_MODEL_NODE_KINDS, DATA_MODEL_PRODUCER } from './data-model/keys.js';
import { DRIVER_EDGE_TYPES, DRIVER_NODE_KINDS, DRIVER_PRODUCER } from './driver/vocabulary.js';
import { HISTORY_EDGE_TYPES, HISTORY_NODE_KINDS, HISTORY_PRODUCER } from './history/vocabulary.js';
import { OPERATIONS_EDGE_TYPES, OPERATIONS_NODE_KINDS, OPERATIONS_PRODUCER } from './operations/vocabulary.js';

/** What one extractor declares it emits: its producer id, its node kinds and its relation types. */
interface ExtractorVocabulary {
  readonly extractor: string;
  readonly kinds: readonly string[];
  readonly relations: readonly string[];
}

/** Every extractor that writes the extractor schema into the graph, with what it declares it emits. */
const EXTRACTOR_VOCABULARY: readonly ExtractorVocabulary[] = [
  { extractor: CODE_PRODUCER, kinds: CODE_NODE_KINDS, relations: CODE_EDGE_TYPES },
  { extractor: CONTRACTS_PRODUCER, kinds: CONTRACTS_NODE_KINDS, relations: CONTRACTS_EDGE_TYPES },
  { extractor: DATA_MODEL_PRODUCER, kinds: DATA_MODEL_NODE_KINDS, relations: DATA_MODEL_EDGE_TYPES },
  { extractor: DRIVER_PRODUCER, kinds: DRIVER_NODE_KINDS, relations: DRIVER_EDGE_TYPES },
  { extractor: HISTORY_PRODUCER, kinds: HISTORY_NODE_KINDS, relations: HISTORY_EDGE_TYPES },
  { extractor: OPERATIONS_PRODUCER, kinds: OPERATIONS_NODE_KINDS, relations: OPERATIONS_EDGE_TYPES },
];

/** The code-point order two keys are listed in. */
const byCodePoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Which extractors declare one key of either namespace. */
function extractorsOf(field: 'kinds' | 'relations'): ReadonlyMap<string, readonly string[]> {
  const held = new Map<string, string[]>();
  for (const extractor of EXTRACTOR_VOCABULARY) {
    for (const key of extractor[field]) held.set(key, [...(held.get(key) ?? []), extractor.extractor]);
  }
  return new Map([...held.entries()].sort((left, right) => byCodePoint(left[0], right[0])).map(([key, names]) => [key, [...names].sort(byCodePoint)]));
}

/** Every node kind the extractors emit, in code point order, with the extractors that declare it. */
export const EXTRACTOR_KINDS: ReadonlyMap<string, readonly string[]> = extractorsOf('kinds');

/** Every relation type the extractors emit, in code point order, with the extractors that declare it. */
export const EXTRACTOR_RELATIONS: ReadonlyMap<string, readonly string[]> = extractorsOf('relations');
