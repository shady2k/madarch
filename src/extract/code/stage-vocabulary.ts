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
  // The contracts reading's records (the contracts stages; madarch-8bdc.2.4): the contract documents a
  // repository's `contracts/` folder declares, the routes and entry points its code registers, and the
  // untrusted input and SQL path a code file carries. They are the extractors' own names
  // (`src/extract/contracts/schema.ts`), so the catalog's mapping ties them already.
  'code.contract',
  'code.input',
  'code.message',
  'code.operation',
  'code.route',
  'code.sql-build',
  'code.sql-sink',
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
  // The registration a code file makes and the exposition it writes: the reading's own facts,
  // joined by the links stage into the endpoints and their edges (madarch-8bdc.2.4).
  'code.http-route',
  'code.image',
  'code.k8s-deployment',
  'code.k8s-service',
  'code.lockfile',
  'code.logger',
  // The use of a logger, which the links stage joins to the declaration another file publishes.
  'code.logger-use',
  'code.make-target',
  'code.manifest',
  'code.metric',
  'code.metric-exposition',
  'code.metrics-endpoint',
  'code.newcomer-command',
  'code.newcomer-failure',
  'code.newcomer-prerequisites',
  'code.port',
  'code.probe',
  'code.process',
  'code.service',
  // The middleware names one file registers and the router mounts it declares (the contracts-code
  // stage; madarch-8bdc.2.4): per-file facts the routes stage reads, internal to the fill's readings.
  'code.middleware-chain',
  'code.router-mount',
  // What one Go file's folder and package names answer, so an entry point's `starts` is resolved
  // from the package's per-file facts (the contracts-code stage; madarch-8bdc.2.4).
  'code.go-package',
  // The Kafka sites one Go file states, and the names its package answers a consumer's handler
  // with, from which the contracts reading links a channel to the code that consumes it.
  'code.kafka-site',
  'code.go-consumer',
  // One publication site a file states, which the links stage joins to a channel, and the
  // constant strings and type unions another file's edge names.
  'code.publisher-site',
  'code.file-names',
  // One remote call site a file states, which the links stage joins to the operation it calls.
  'code.remote-call-site',
];

/**
 * Every relation type the fill's static stages write, with `positioned` where the
 * edge carries the byte span it was read at.
 *
 * Every relation here is declared discriminated, as the extract driver declares
 * the relations it emits (`src/extract/driver/index.ts`): a record that lands once
 * per site — a logger use, a metric update, a broker setting — carries its site as
 * the discriminator, and a store that held such a relation as one would lose every
 * occurrence after the first. The three relations the graph's own schema already
 * declares (`code.contains`, `code.imports`, `code.occurrence`) keep that
 * declaration: an encoding is never redeclared (decision 0028).
 */
export const STAGE_EDGE_TYPES: readonly { readonly key: string; readonly positioned?: boolean; readonly discriminated?: boolean }[] = [
  { key: 'code.consumes', discriminated: true },
  // The engine's own declaration: containment is one edge between two records.
  { key: 'code.contains' },
  // What a file declares beside its symbols (the code-facts and state-machines stages).
  { key: 'code.declares', discriminated: true },
  { key: 'code.dependency', discriminated: true },
  { key: 'code.document-link', discriminated: true },
  { key: 'code.imports' },
  { key: 'code.mentions', discriminated: true },
  { key: 'code.occurrence', positioned: true },
  // What the resolution stage folds a mention into (decision 0026's stage 4).
  { key: 'code.references', discriminated: true },
  // The task keys a commit or a document names (stages 6 and 7; madarch-8bdc.2.3).
  { key: 'code.tasks', discriminated: true },
  // What a state enters (the state-machines stage).
  { key: 'code.transitions', discriminated: true },
  // What a manifest declares: one edge from the manifest's file to the dependency it names
  // (`src/extract/operations/dependencies.ts`).
  { key: 'code.uses-dependency', discriminated: true },
  // What the operations reading declares about how the software is built and run (the operations
  // stage; madarch-8bdc.2.4): the same relation types the extractors' operations reader emits.
  // What the contracts reading links across files (madarch-8bdc.2.4): a route that serves a contract
  // operation, a client that calls one, a site that publishes or consumes a channel's topic, the
  // handler a route is handled by, the service an entry point belongs to, what an entry point starts,
  // and the untrusted input's way to a SQL sink.
  { key: 'code.backed-by', discriminated: true },
  { key: 'code.belongs-to', discriminated: true },
  { key: 'code.builds', discriminated: true },
  { key: 'code.built-by', discriminated: true },
  { key: 'code.calls-remote', discriminated: true },
  { key: 'code.carries', discriminated: true },
  { key: 'code.configured-by', discriminated: true },
  { key: 'code.connects-to', discriminated: true },
  { key: 'code.contains-job', discriminated: true },
  { key: 'code.declares-dependency', discriminated: true },
  { key: 'code.defined-in', discriminated: true },
  { key: 'code.defines', discriminated: true },
  { key: 'code.depends-on', discriminated: true },
  { key: 'code.exposes', discriminated: true },
  { key: 'code.exposes-metric', discriminated: true },
  { key: 'code.flows-into', discriminated: true },
  { key: 'code.handled-by', discriminated: true },
  { key: 'code.hosts-channel', discriminated: true },
  { key: 'code.listens-on', discriminated: true },
  { key: 'code.manifest-of', discriminated: true },
  { key: 'code.probes', discriminated: true },
  { key: 'code.publishes', discriminated: true },
  { key: 'code.reads-env', discriminated: true },
  { key: 'code.resolves', discriminated: true },
  { key: 'code.runs', discriminated: true },
  { key: 'code.served-by', discriminated: true },
  { key: 'code.serves', discriminated: true },
  { key: 'code.starts', discriminated: true },
  { key: 'code.targets', discriminated: true },
  { key: 'code.updates-metric', discriminated: true },
  { key: 'code.uses-logger', discriminated: true },
];
