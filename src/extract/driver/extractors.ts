/**
 * The extractors the driver runs (the brief's list): every tree extractor that
 * has landed under src/extract, and the history extractor, which reads the
 * repository itself. A new extractor is added here when it lands; the driver
 * needs no other change.
 */
import { CODE_PRODUCER, extractCode } from '../code/index.js';
import { extractContracts } from '../contracts/index.js';
import { extractDataModel } from '../data-model/extract.js';
import { extractHistory } from '../history/index.js';
import { extractOperations, OPERATIONS_PRODUCER } from '../operations/index.js';
import { extractFiles, FILES_PRODUCER } from './files.js';
import type { HistoryExtractor, TreeExtractor } from './index.js';

/** Every tree extractor, in the order the driver runs them per commit. */
const TREE_READERS = [
 {name:'extractFiles',version:2,extractor:extractFiles},
 {name:'extractCode',version:7,extractor:extractCode},
 {name:'extractOperations',version:6,extractor:extractOperations},
 {name:'extractContracts',version:6,extractor:extractContracts},
 {name:'extractDataModel',version:4,extractor:extractDataModel},
] as const;
export const TREE_EXTRACTORS: readonly TreeExtractor[] = TREE_READERS.map((entry)=>entry.extractor);

/** The history extractor, published once at the last commit under its own producer. */
export const HISTORY_EXTRACTOR: HistoryExtractor = (repository) => extractHistory({ repository: repository.path, snapshots: repository.snapshots });

/**
 * Node ownership: one preferred owning producer per kind. Cross-producer
 * relations publish last, so this order is not a dependency order. The tree lister owns files; the code extractor
 * (`code.extract.code`) owns symbols; the operations extractor owns services,
 * because it is the one that reads them from their manifests — without the
 * entry, the data model's `code.service:` edge opened a stub node of its own
 * and one service stood in the graph twice (madarch-m38l.16).
 */
export const OWNERS: Readonly<Record<string, string>> = { 'code.file': FILES_PRODUCER, 'code.symbol': CODE_PRODUCER, 'code.service': OPERATIONS_PRODUCER, 'code.channel': 'code.extract.contracts', 'code.dependency': OPERATIONS_PRODUCER };

/** The persistent index is rebuilt when any named reader's interpretation changes. */
export const EXTRACTOR_VERSIONS = [
 ...TREE_READERS.map(({name,version})=>({name,version})), {name:'extractHistory',version:1},
 {name:'driver-and-link-normalization',version:6},
] as const;
