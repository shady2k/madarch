/** The producer id every record of the operations extractor carries. */
export const OPERATIONS_PRODUCER = 'code.extract.operations';

/**
 * The operations extractor's vocabulary, as data (decision 0028, "Tables"; decision 0033, item 7): every
 * node kind and relation type this extractor emits, named once here and used by the code that emits them.
 * The catalog's mapping ties these keys to the product's kinds and relations, and the mapping check refuses
 * a key that is emitted and not declared here.
 */

// ---- node kinds -----------------------------------------------------------

export const KIND_SERVICE = 'code.service';
export const KIND_PORT = 'code.port';
export const KIND_METRIC = 'code.metric';
export const KIND_HEALTH_ENDPOINT = 'code.health-endpoint';
export const KIND_METRICS_ENDPOINT = 'code.metrics-endpoint';
export const KIND_PROBE = 'code.probe';
export const KIND_HEALTHCHECK = 'code.healthcheck';
export const KIND_ENV_VAR = 'code.env-var';
export const KIND_ENV_DEFINITION = 'code.env-definition';
export const KIND_DEPENDENCY = 'code.dependency';
export const KIND_MANIFEST = 'code.manifest';
export const KIND_LOCKFILE = 'code.lockfile';
export const KIND_DOCKERFILE = 'code.dockerfile';
export const KIND_IMAGE = 'code.image';
export const KIND_COMPOSE_SERVICE = 'code.compose-service';
export const KIND_K8S_DEPLOYMENT = 'code.k8s-deployment';
export const KIND_K8S_SERVICE = 'code.k8s-service';
export const KIND_CI_WORKFLOW = 'code.ci-workflow';
export const KIND_CI_JOB = 'code.ci-job';
export const KIND_MAKE_TARGET = 'code.make-target';
export const KIND_PROCESS = 'code.process';
export const KIND_BROKER = 'code.broker';
export const KIND_LOGGER = 'code.logger';
export const KIND_NEWCOMER_COMMAND = 'code.newcomer-command';
export const KIND_NEWCOMER_PREREQUISITES = 'code.newcomer-prerequisites';
export const KIND_NEWCOMER_FAILURE = 'code.newcomer-failure';

// ---- relation types -------------------------------------------------------

export const REL_CONTAINS = 'code.contains';
export const REL_REFERENCES = 'code.references';
export const REL_CONTAINS_JOB = 'code.contains-job';
export const REL_DECLARES_DEPENDENCY = 'code.declares-dependency';
export const REL_RESOLVES = 'code.resolves';
export const REL_USES_DEPENDENCY = 'code.uses-dependency';
export const REL_EXPOSES = 'code.exposes';
export const REL_CONFIGURED_BY = 'code.configured-by';
export const REL_PUBLISHES = 'code.publishes';
export const REL_DEPENDS_ON = 'code.depends-on';
export const REL_BUILDS = 'code.builds';
export const REL_PROBES = 'code.probes';
export const REL_TARGETS = 'code.targets';
export const REL_RUNS = 'code.runs';
export const REL_BUILT_BY = 'code.built-by';
export const REL_STARTS = 'code.starts';
export const REL_LISTENS_ON = 'code.listens-on';
export const REL_READS_ENV = 'code.reads-env';
export const REL_DEFINES = 'code.defines';
export const REL_DEFINED_IN = 'code.defined-in';
export const REL_CONNECTS_TO = 'code.connects-to';
export const REL_HOSTS_CHANNEL = 'code.hosts-channel';
export const REL_UPDATES_METRIC = 'code.updates-metric';
export const REL_SERVED_BY = 'code.served-by';
export const REL_EXPOSES_METRIC = 'code.exposes-metric';
export const REL_USES_LOGGER = 'code.uses-logger';
export const REL_BACKED_BY = 'code.backed-by';
export const REL_MANIFEST_OF = 'code.manifest-of';

/** Every node kind this extractor emits, declared as data the code names and the mapping ties (0033, item 7). */
export const OPERATIONS_NODE_KINDS = [
  KIND_SERVICE, KIND_PORT, KIND_METRIC, KIND_HEALTH_ENDPOINT, KIND_METRICS_ENDPOINT, KIND_PROBE, KIND_HEALTHCHECK,
  KIND_ENV_VAR, KIND_ENV_DEFINITION, KIND_DEPENDENCY, KIND_MANIFEST, KIND_LOCKFILE, KIND_DOCKERFILE, KIND_IMAGE,
  KIND_COMPOSE_SERVICE, KIND_K8S_DEPLOYMENT, KIND_K8S_SERVICE, KIND_CI_WORKFLOW, KIND_CI_JOB, KIND_MAKE_TARGET,
  KIND_PROCESS, KIND_BROKER, KIND_LOGGER, KIND_NEWCOMER_COMMAND, KIND_NEWCOMER_PREREQUISITES, KIND_NEWCOMER_FAILURE,
] as const;

/** Every relation type this extractor emits, declared as data the code names and the mapping ties (0033, item 7). */
export const OPERATIONS_EDGE_TYPES = [
  REL_CONTAINS, REL_REFERENCES, REL_CONTAINS_JOB, REL_DECLARES_DEPENDENCY, REL_RESOLVES, REL_USES_DEPENDENCY,
  REL_EXPOSES, REL_CONFIGURED_BY, REL_PUBLISHES, REL_DEPENDS_ON, REL_BUILDS, REL_PROBES, REL_TARGETS, REL_RUNS,
  REL_BUILT_BY, REL_STARTS, REL_LISTENS_ON, REL_READS_ENV, REL_DEFINES, REL_DEFINED_IN, REL_CONNECTS_TO,
  REL_HOSTS_CHANNEL, REL_UPDATES_METRIC, REL_SERVED_BY, REL_EXPOSES_METRIC, REL_USES_LOGGER, REL_BACKED_BY,
  REL_MANIFEST_OF,
] as const;

/** The union of the node kinds this extractor declares: an emitted kind is one of them, and tsc refuses any other. */
export type OperationsKind = (typeof OPERATIONS_NODE_KINDS)[number];

/** The union of the relation types this extractor declares: an emitted relation is one of them. */
export type OperationsRelation = (typeof OPERATIONS_EDGE_TYPES)[number];
