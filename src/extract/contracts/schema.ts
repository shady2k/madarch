/**
 * The contracts extractor's own vocabulary of the extractor schema (decision
 * 0028): every kind and relation type stands under `code.`, and every key is
 * built from stable parts of the bytes it was read from -- never from a run, a
 * database id or a time. The schema is the engine's, so a product registry
 * never names these.
 */

/** The producer id every record of this extractor carries. */
export const CONTRACTS_PRODUCER = 'code.extract.contracts' as const;

// ---- node kinds -----------------------------------------------------------

export const KIND_CONTRACT = 'code.contract';
export const KIND_OPERATION = 'code.operation';
export const KIND_CHANNEL = 'code.channel';
export const KIND_MESSAGE = 'code.message';
export const KIND_ROUTE = 'code.route';
export const KIND_ENTRY_POINT = 'code.entry-point';
export const KIND_INPUT = 'code.input';
export const KIND_SQL_BUILD = 'code.sql-build';
export const KIND_SQL_SINK = 'code.sql-sink';

/** A contract contains the operations, channels and messages it declares. */
export const EDGE_DECLARES = 'code.declares';
/** A channel carries a message. */
export const EDGE_CARRIES = 'code.carries';
/** A route is handled by the symbol that serves it. */
export const EDGE_HANDLED_BY = 'code.handled-by';
/** A process entry point belongs to the service of its file. */
export const EDGE_BELONGS_TO = 'code.belongs-to';
/** A declaration mentions another symbol (a callback registration, say). */
export const EDGE_REFERENCES = 'code.references';
/** A file contains a node the extractor read from it. */
export const EDGE_CONTAINS = 'code.contains';
/** An endpoint is served by a route, a file or a handler. */
export const EDGE_SERVED_BY = 'code.served-by';

// ---- relation types -------------------------------------------------------

/** A route or a server handler implements a contract operation. */
export const REL_SERVES = 'code.serves';
/** A client call site calls a contract operation (or, with no contract, the serving route). */
export const REL_CALLS_REMOTE = 'code.calls-remote';
/** A site sends messages to an AsyncAPI channel. */
export const REL_PUBLISHES = 'code.publishes';
/** A site reads messages of an AsyncAPI channel. */
export const REL_CONSUMES = 'code.consumes';
/** An untrusted input reaches a SQL string builder or a SQL execution sink. */
export const REL_FLOWS_INTO = 'code.flows-into';

// ---- the vocabulary, as data ---------------------------------------------

/** Every node kind this extractor emits, declared as data the code names and the catalog's mapping ties (0033, item 7). */
export const CONTRACTS_NODE_KINDS = [KIND_CONTRACT, KIND_OPERATION, KIND_CHANNEL, KIND_MESSAGE, KIND_ROUTE, KIND_ENTRY_POINT, KIND_INPUT, KIND_SQL_BUILD, KIND_SQL_SINK] as const;

/** Every relation type this extractor emits, declared as data the code names and the mapping ties (0033, item 7). */
export const CONTRACTS_EDGE_TYPES = [REL_SERVES, REL_CALLS_REMOTE, REL_PUBLISHES, REL_CONSUMES, REL_FLOWS_INTO, EDGE_DECLARES, EDGE_CARRIES, EDGE_HANDLED_BY, EDGE_BELONGS_TO, EDGE_REFERENCES, EDGE_CONTAINS, EDGE_SERVED_BY] as const;

// ---- key builders ---------------------------------------------------------

/** `code.contract:<path>` -- one contract document. */
export const contractKey = (path: string): string => `${KIND_CONTRACT}:${path}`;

/** `code.operation:<path>#<METHOD>:<template>` (HTTP) or `<path>#<package>.<Service>/<Rpc>` (proto). */
export const operationKey = (path: string, operation: string): string => `${KIND_OPERATION}:${path}#${operation}`;

/** `code.channel:<name>` -- one AsyncAPI channel (a Kafka topic, for this schema's use). */
export const channelKey = (name: string): string => `${KIND_CHANNEL}:${name}`;

/** `code.message:<path>#<Name>` -- one message a contract declares. */
export const messageKey = (path: string, name: string): string => `${KIND_MESSAGE}:${path}#${name}`;

/** `code.route:<file>#<METHOD>:<path>` -- one route registered in code. */
export const routeKey = (file: string, method: string, routePath: string): string => `${KIND_ROUTE}:${file}#${method}:${routePath}`;

/** `code.entry-point:<file>#<symbol>` -- one process entry point. */
export const entryPointKey = (file: string, symbol: string): string => `${KIND_ENTRY_POINT}:${file}#${symbol}`;

/** `code.input:<file>#<source>.<name>` -- one read of untrusted input. */
export const inputKey = (file: string, source: string, name: string): string => `${KIND_INPUT}:${file}#${source}.${name}`;

/** `code.sql-build:<file>#<function>` -- a function that splices values into SQL text. */
export const sqlBuildKey = (file: string, fn: string): string => `${KIND_SQL_BUILD}:${file}#${fn}`;

/** `code.sql-sink:<file>#<callee>` -- one SQL execution sink. */
export const sqlSinkKey = (file: string, callee: string): string => `${KIND_SQL_SINK}:${file}#${callee}`;

/** `code.file:<path>` -- the file node another extractor owns; edges of this extractor reference it. */
export const fileKey = (path: string): string => `code.file:${path}`;
