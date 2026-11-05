/**
 * The vocabulary the fill's static stages publish into the graph (decision 0033,
 * items 7 and 14): the per-file stages write the same `code.*` namespace the
 * extractors do, from one file's bytes and bounded graph reads instead of the
 * extract driver, and the closed vocabulary (`src/extract/vocabulary.ts`) reads
 * this list as one more producer, so the catalog's mapping ties every key the
 * graph can hold.
 *
 * The store registers this list before a static stage's first publication
 * (`CODE_GRAPH_VOCABULARY`, `src/fill/stages/static-graph.ts`): one declaration,
 * read by the check and by the store.
 */

/** Every node kind the fill's static stages write. */
export const STAGE_NODE_KINDS: readonly string[] = [
  'code.binding',
  'code.call',
  // The data model's own records (madarch-8bdc.2.4): a database, its migrations, tables, columns and
  // indexes, and the per-file readings the aggregate stage assembles them from.
  'code.column',
  'code.database',
  'code.index',
  'code.migration',
  'code.schema-reading',
  'code.storage-evidence',
  'code.table',
  'code.comment',
  'code.commit',
  'code.compose-service',
  'code.coverage',
  'code.dependency',
  'code.deploy-unit',
  'code.directory',
  'code.dockerfile',
  'code.document',
  'code.document-section',
  'code.entry-point',
  'code.env-var',
  'code.export',
  'code.expression',
  'code.field',
  'code.file',
  'code.link-target',
  // The names a file mentions, as the file pass writes them (decision 0033, item 14;
  // `mention-graph.ts`), beside the symbols they may name.
  'code.mention',
  'code.module',
  'code.package',
  'code.rank',
  'code.repository',
  // The service node the operations reading owns: the data-model aggregate stage joins it, and opens
  // it with this key where the graph holds none yet (madarch-8bdc.2.4).
  'code.service',
  // The unit a file belongs to and the ports its code listens on (the code-facts stage;
  // madarch-8bdc.2.4), read by the operations and contracts stages as properties.
  'code.service-unit',
  'code.listener-port',
  // The state machines a file writes down (the state-machines stage): the table, its states and
  // the moves between them (decision 0026's diagrams; decision 0033, item 14).
  'code.state',
  'code.state-machine',
  'code.symbol',
  'code.task',
  'code.test',
];

/**
 * Every relation type the fill's static stages write, with `positioned` where the
 * edge carries the byte span it was read at.
 */
export const STAGE_EDGE_TYPES: readonly { readonly key: string; readonly positioned?: boolean; readonly discriminated?: boolean }[] = [
  { key: 'code.consumes' },
  { key: 'code.contains' },
  // What a file declares beside its symbols (the code-facts and state-machines stages).
  { key: 'code.declares' },
  { key: 'code.dependency' },
  { key: 'code.document-link' },
  { key: 'code.imports' },
  { key: 'code.mentions' },
  { key: 'code.occurrence', positioned: true },
  // What the resolution stage folds a mention into (decision 0026's stage 4).
  { key: 'code.references' },
  // The task keys a commit or a document names (stages 6 and 7; madarch-8bdc.2.3).
  { key: 'code.tasks' },
  // What a state enters (the state-machines stage).
  { key: 'code.transitions' },
  // The data model's own relations (madarch-8bdc.2.4). Each carries a discriminator: one function can
  // reach one table through two helpers, and a foreign key's constraint tells two keys of one table apart.
  { key: 'code.alters', discriminated: true },
  { key: 'code.covers', discriminated: true },
  { key: 'code.creates', discriminated: true },
  { key: 'code.foreign-key', discriminated: true },
  { key: 'code.holds', discriminated: true },
  { key: 'code.logical-reference', discriminated: true },
  { key: 'code.reads-table', discriminated: true },
  { key: 'code.uses-database', discriminated: true },
  { key: 'code.writes-table', discriminated: true },
  // What a manifest declares: one edge from the manifest's file to the dependency it names
  // (`src/extract/operations/dependencies.ts`).
  { key: 'code.uses-dependency' },
];
