/** The producer id every record of the history extractor carries. */
export const HISTORY_PRODUCER = 'code.extract.history';

/**
 * The history extractor's vocabulary, as data (decision 0030; decision 0033, item 7): the commits, authors,
 * tasks and landmarks it reads from Git, and the relation types between them, named once here and used by
 * the code that emits them.
 */

export const KIND_COMMIT = 'code.commit';
export const KIND_AUTHOR = 'code.author';
export const KIND_TASK = 'code.task';
export const KIND_SNAPSHOT = 'code.snapshot';
export const KIND_FILE = 'code.file';

export const REL_PARENT = 'code.parent';
export const REL_AUTHORED = 'code.authored';
export const REL_TASKS = 'code.tasks';
export const REL_HELD = 'code.held';
export const REL_TOUCHED = 'code.touched';
export const REL_RENAMED_TO = 'code.renamed-to';
export const REL_CHANGED_WITH = 'code.changed-with';

/** Every node kind this extractor emits, declared as data the code names and the mapping ties (0033, item 7). */
export const HISTORY_NODE_KINDS = [KIND_COMMIT, KIND_AUTHOR, KIND_TASK, KIND_SNAPSHOT, KIND_FILE] as const;

/** Every relation type this extractor emits, declared as data the code names and the mapping ties (0033, item 7). */
export const HISTORY_EDGE_TYPES = [REL_PARENT, REL_AUTHORED, REL_TASKS, REL_HELD, REL_TOUCHED, REL_RENAMED_TO, REL_CHANGED_WITH] as const;

/** The union of the node kinds this extractor declares: an emitted kind is one of them, and tsc refuses any other. */
export type HistoryKind = (typeof HISTORY_NODE_KINDS)[number];

/** The union of the relation types this extractor declares: an emitted relation is one of them. */
export type HistoryRelation = (typeof HISTORY_EDGE_TYPES)[number];
