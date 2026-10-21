/**
 * The extractors the driver runs (the brief's list): every tree extractor that
 * has landed under src/extract, and the history extractor, which reads the
 * repository itself. A new extractor is added here when it lands; the driver
 * needs no other change.
 */
import { extractContracts } from '../contracts/index.js';
import { extractDataModel } from '../data-model/extract.js';
import { extractHistory } from '../history/index.js';
import { extractOperations } from '../operations/index.js';
import type { HistoryExtractor, TreeExtractor } from './index.js';

/** Every tree extractor, in the order the driver runs them per commit. */
export const TREE_EXTRACTORS: readonly TreeExtractor[] = [extractOperations, extractContracts, extractDataModel];

/** The history extractor, published once at the last commit under its own producer. */
export const HISTORY_EXTRACTOR: HistoryExtractor = (repository) => extractHistory({ repository: repository.path, snapshots: repository.snapshots });
