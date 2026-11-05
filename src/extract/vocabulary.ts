/**
 * The extractors' vocabulary, gathered from the extractors themselves (decision 0033, item 7): each
 * extractor declares the node kinds and relation types it emits as data beside the code that emits them,
 * and this module reads those declarations, so nothing here is typed by hand and a kind an extractor starts
 * emitting is noticed by whoever reads this union — the catalog's mapping check does. The fill's static
 * stages write the same `code.*` schema, so their declaration (`src/extract/code/stage-vocabulary.ts`) is
 * read here too: a key either producer starts emitting is refused by the mapping check until it is tied.
 *
 * The keys stay the engine's own (`code.`); a product's kinds are the catalog's, and the product's mapping
 * ties one to the other.
 */
import { CODE_EDGE_TYPES, CODE_NODE_KINDS, CODE_PRODUCER, type CodeKind, type CodeRelation } from './code/keys.js';
import { CONTRACTS_EDGE_TYPES, CONTRACTS_NODE_KINDS, CONTRACTS_PRODUCER, type ContractsKind, type ContractsRelation } from './contracts/schema.js';
import { DATA_MODEL_EDGE_TYPES, DATA_MODEL_NODE_KINDS, DATA_MODEL_PRODUCER, type DataModelKind, type DataModelRelation } from './data-model/keys.js';
import { DRIVER_EDGE_TYPES, DRIVER_NODE_KINDS, DRIVER_PRODUCER, type DriverKind, type DriverRelation } from './driver/vocabulary.js';
import { HISTORY_EDGE_TYPES, HISTORY_NODE_KINDS, HISTORY_PRODUCER, type HistoryKind, type HistoryRelation } from './history/vocabulary.js';
import { OPERATIONS_EDGE_TYPES, OPERATIONS_NODE_KINDS, OPERATIONS_PRODUCER, type OperationsKind, type OperationsRelation } from './operations/vocabulary.js';
import { STAGE_EDGE_TYPES, STAGE_NODE_KINDS } from './code/stage-vocabulary.js';

/**
 * Every node kind the extractors can emit: the union of the six declarations. A node record's kind is one of
 * these, so an extractor that emits a key its declaration does not hold fails the type check at the emission
 * site — the vocabulary cannot fall behind the code it describes.
 */
export type EmittedKind = CodeKind | ContractsKind | DataModelKind | DriverKind | HistoryKind | OperationsKind;

/** Every relation type the extractors can emit: the union of the six declarations, enforced the same way. */
export type EmittedRelation = CodeRelation | ContractsRelation | DataModelRelation | DriverRelation | HistoryRelation | OperationsRelation;

/** What one extractor declares it emits: its producer id, its node kinds and its relation types. */
interface ExtractorVocabulary {
  readonly extractor: string;
  readonly kinds: readonly string[];
  readonly relations: readonly string[];
}

/**
 * Every producer that writes the extractor schema into the graph, with what it declares it emits: the six
 * extractors, and the fill's static stages, which publish the same `code.*` schema from one file's bytes
 * (`src/extract/code/stage-vocabulary.ts`) rather than from the extract driver.
 */
const EXTRACTOR_VOCABULARY: readonly ExtractorVocabulary[] = [
  { extractor: CODE_PRODUCER, kinds: CODE_NODE_KINDS, relations: CODE_EDGE_TYPES },
  { extractor: CONTRACTS_PRODUCER, kinds: CONTRACTS_NODE_KINDS, relations: CONTRACTS_EDGE_TYPES },
  { extractor: DATA_MODEL_PRODUCER, kinds: DATA_MODEL_NODE_KINDS, relations: DATA_MODEL_EDGE_TYPES },
  { extractor: DRIVER_PRODUCER, kinds: DRIVER_NODE_KINDS, relations: DRIVER_EDGE_TYPES },
  { extractor: HISTORY_PRODUCER, kinds: HISTORY_NODE_KINDS, relations: HISTORY_EDGE_TYPES },
  { extractor: OPERATIONS_PRODUCER, kinds: OPERATIONS_NODE_KINDS, relations: OPERATIONS_EDGE_TYPES },
  { extractor: 'fill.stages', kinds: STAGE_NODE_KINDS, relations: STAGE_EDGE_TYPES.map((relation) => relation.key) },
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

/**
 * Every node kind the extractors and the fill's static stages emit, in code point order, with the producers
 * that declare it: what the catalog's mapping must tie.
 */
export const EXTRACTOR_KINDS: ReadonlyMap<string, readonly string[]> = extractorsOf('kinds');

/** Every relation type the extractors and the fill's static stages emit, in code point order, with the producers that declare it. */
export const EXTRACTOR_RELATIONS: ReadonlyMap<string, readonly string[]> = extractorsOf('relations');
