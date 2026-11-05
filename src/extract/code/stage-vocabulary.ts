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
  // The operations reading's records (the operations stage; madarch-8bdc.2.4): what a manifest,
  // a Dockerfile, a compose file, a Kubernetes file, a Makefile, a workflow or a code file
  // declares about how the software is built, deployed and run.
  'code.broker',
  'code.callable',
  'code.channel',
  'code.ci-job',
  'code.ci-workflow',
  'code.env-definition',
  'code.env-read',
  'code.healthcheck',
  'code.health-endpoint',
  'code.image',
  'code.k8s-deployment',
  'code.k8s-service',
  'code.lockfile',
  'code.logger',
  'code.make-target',
  'code.manifest',
  'code.metric',
  'code.metrics-endpoint',
  'code.newcomer-command',
  'code.newcomer-failure',
  'code.newcomer-prerequisites',
  'code.port',
  'code.probe',
  'code.process',
  'code.service',
];

/**
 * Every relation type the fill's static stages write, with `positioned` where the
 * edge carries the byte span it was read at.
 */
export const STAGE_EDGE_TYPES: readonly { readonly key: string; readonly positioned?: boolean }[] = [
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
  // What a manifest declares: one edge from the manifest's file to the dependency it names
  // (`src/extract/operations/dependencies.ts`).
  { key: 'code.uses-dependency' },
  // What the operations reading declares about how the software is built and run (the operations
  // stage; madarch-8bdc.2.4): the same relation types the extractors' operations reader emits.
  { key: 'code.backed-by' },
  { key: 'code.builds' },
  { key: 'code.built-by' },
  { key: 'code.configured-by' },
  { key: 'code.connects-to' },
  { key: 'code.contains-job' },
  { key: 'code.declares-dependency' },
  { key: 'code.defined-in' },
  { key: 'code.defines' },
  { key: 'code.depends-on' },
  { key: 'code.exposes' },
  { key: 'code.hosts-channel' },
  { key: 'code.listens-on' },
  { key: 'code.manifest-of' },
  { key: 'code.probes' },
  { key: 'code.publishes' },
  { key: 'code.reads-env' },
  { key: 'code.resolves' },
  { key: 'code.runs' },
  { key: 'code.starts' },
  { key: 'code.targets' },
];
