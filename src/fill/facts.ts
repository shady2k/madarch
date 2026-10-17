/**
 * The fill's code-fact schema (decision 0026): every node and edge kind the
 * deterministic stages 0–7 and the agent stages 8–13 write into the product
 * graph, with the provenance, the layer and the status decision 0005 asks of
 * every assertion, and the content-addressed id a fact is known by.
 *
 * This module is pure: types and pure functions only. Nothing here reads the
 * clock, the file system, the network or a database, and nothing writes — the
 * graph's storage, a unit's draft set and its publication come later
 * (madarch-tzte.19.1 and after), and a unit's writes are checked by the write
 * path, which calls `checkFact` here and adds the checks only it can make (the
 * cited bytes read at the pinned commit, the referenced nodes existing, the
 * write inside the unit's scope).
 *
 * Four rules hold everywhere below.
 *
 * 1. The kinds are the fill's own namespace, never the product registry's
 *    (`src/product/contract.ts`): a fact kind is one lower-case kebab token
 *    (`environment-variable`, `api-endpoint`), a registry kind is a name the
 *    product declares and its documents carry an id prefix (`API-3`). The two
 *    vocabularies are joined only by `REGISTRY_KIND_MAPPINGS`, each entry an
 *    explicit mapping of one fact kind to the registry storage forms (0021's
 *    amendment) whose documents it serves and the role it plays for them.
 * 2. A fact's id is the SHA-256 digest of the parts that make up the fact's
 *    own identity — the same repository, the same place in it, the same
 *    structural answer — and of nothing else: not its commit, not the
 *    extractor's version, not its layer or status, and never a run, a unit, an
 *    attempt or a timestamp. The same fact extracted twice, on two machines,
 *    in two runs, has one id; a value that changes without changing the
 *    identity (a file's byte count, a call's count) keeps its id.
 * 3. A fact never holds a machine path. Every path is a repository path: the
 *    file's path from the repository's root, `/`-separated, with no `.` or
 *    `..` leg. `repositoryPath`/`repositoryPathIn` are the only ways to make
 *    one, so the checkout's own directory cannot reach an id.
 * 4. Provenance, layer and status are required of every fact, and the place is
 *    required of every kind that stands at one. A fact accepted by a person is
 *    an acceptance record beside the fact, not a rewritten one (0005), so only
 *    a `declared` fact may carry a status other than `proposed`.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import { ID_PATTERN } from '../model/schema.js';

// ---- the schema's version ------------------------------------------------

/**
 * The version of this schema: the set of kinds, their identities and the fact
 * envelope. The version a kind's own value shape carries is the kind's
 * `version` in `FACT_KINDS` (decision 0027 has a stage declare it per produced
 * kind); every kind starts at this version, and a kind whose value changes
 * moves alone.
 */
export const FACTS_SCHEMA_VERSION = 1;

/** One refusal of the schema, naming the field path it stands at. */
export class FactSchemaError extends Error {
  /** The path from the fact's top, like `value.path`; empty when the refusal is about the fact itself. */
  readonly path: string;
  /** The refusal's words without the path in front of them, for a caller that reports the path itself. */
  readonly detail: string;

  constructor(path: string, message: string) {
    super(path === '' ? message : `${path}: ${message}`);
    this.name = 'FactSchemaError';
    this.path = path;
    this.detail = message;
  }
}

/** A kind's or a layer's name with the article it takes: "a file", "an occurrence". */
function withArticle(word: string): string {
  return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
}

/** The text of a value a refusal or a message names, JSON's own way, never `[object Object]`. */
function shown(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'nothing';
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

// ---- repository paths ----------------------------------------------------

declare const repositoryPathBrand: unique symbol;

/**
 * A path from the repository's root: `/`-separated whatever the machine's
 * separator, no leading `/`, no `.` or `..` leg, no empty leg, no trailing
 * `/`. The brand is not decorative: `repositoryPath` and `repositoryPathIn`
 * are the only constructors, so a path that carries a machine's directory
 * cannot be written into a fact by accident. A value read from JSON (an
 * agent's write, a stored row) is put through `repositoryPath` again, which
 * refuses what is not already in this form.
 */
export type RepositoryPath = string & { readonly [repositoryPathBrand]: 'repository-path' };

/** The refusal for a value that is not a repository path: what is wrong with it, in the message's own words. */
function repositoryPathProblem(value: string): string | undefined {
  if (value === '') return 'a repository path is empty: a file has a path from the repository\'s root';
  if (value.startsWith('/')) return `${shown(value)} is an absolute path: a repository path starts at the repository's root`;
  if (/^[A-Za-z]:[\\/]/.test(value)) return `${shown(value)} is a path of a machine's drive: a repository path starts at the repository's root`;
  const legs = value.split('/');
  if (legs.at(-1) === '') return `${shown(value)} ends with a separator: a repository path names a file or a folder`;
  for (const leg of legs) {
    if (leg === '') return `${shown(value)} holds an empty leg: a repository path names one folder after another`;
    if (leg === '.') return `${shown(value)} holds a "." leg: a repository path stands relative to the repository's root already`;
    if (leg === '..') return `${shown(value)} climbs out of the repository: a repository path never goes above the root`;
  }
  return undefined;
}

/**
 * Reads a repository path, refusing what is not in the portable form. A
 * machine separator is folded to `/` first, so `src\a.ts` read on a machine
 * whose tools write separators that way names the same file; nothing else is
 * changed — no case folding, no Unicode normalization, because the path's
 * bytes are the repository's own.
 */
export function repositoryPath(value: string): RepositoryPath {
  const folded = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const problem = repositoryPathProblem(folded);
  if (problem !== undefined) throw new FactSchemaError('', problem);
  return folded as RepositoryPath;
}

/**
 * A repository path as one identity part names it. The refusal keeps the
 * constructor's words and takes the value's own field as its path, so a fact
 * refused for a machine path says `value.path` and not just "path".
 */
function identityPath(field: string, value: string): RepositoryPath {
  try {
    return repositoryPath(value);
  } catch (error) {
    if (error instanceof FactSchemaError) throw new FactSchemaError(`value.${field}`, error.detail);
    throw error;
  }
}

/** Whether a value is a repository path, without throwing: the write path's cheap pre-check. */
export function isRepositoryPath(value: string): value is RepositoryPath {
  return repositoryPathProblem(value.replace(/\\/g, '/').replace(/^\.\//, '')) === undefined;
}

/**
 * The repository path of a file or folder the extractor found at
 * `location`, relative to the repository's root `root`. Both are machine
 * paths of this checkout and neither reaches the fact: only the relative
 * path between them does. A location outside the root is refused, naming
 * both, because a fact about another repository's file is not this
 * repository's fact.
 */
export function repositoryPathIn(root: string, location: string): RepositoryPath {
  const normalize = (value: string): string[] => value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter((leg) => leg !== '' && leg !== '.');
  const rootLegs = normalize(root);
  const locationLegs = normalize(location);
  if (rootLegs.length === 0) throw new FactSchemaError('', `${shown(root)} is no repository root: name the folder the repository is checked out at`);
  for (let index = 0; index < rootLegs.length; index += 1) {
    if (locationLegs[index] !== rootLegs[index]) {
      throw new FactSchemaError('', `${shown(location)} is not inside the repository root ${shown(root)}: a fact names a path from the repository's root`);
    }
  }
  const relative = locationLegs.slice(rootLegs.length).join('/');
  if (relative === '') throw new FactSchemaError('', `${shown(location)} is the repository root itself, not a file or folder inside it`);
  return repositoryPath(relative);
}

// ---- provenance ----------------------------------------------------------

/** The source a fact came from and its version (0004: "plugin@version"). */
export interface FactSource {
  /** The system that read the fact: a tool (`tree-sitter`), an external indexer (`scip-typescript`), or an agent stage (`fill-stage-12`). */
  readonly system: string;
  /** The source's own version — the one its facts' precision stands on. */
  readonly version: string;
}

/** The repository a fact is about, and the commit it was read at (0004: "repository@ref"). */
export interface RepositoryRef {
  /**
   * The product's own name for the repository (the folder under its `repos/`,
   * decision 0021), never a machine path, a URL or a branch name.
   */
  readonly id: string;
  /** The commit the fact was read at: 40 lower-case hexadecimal digits. */
  readonly commit: string;
}

/**
 * A half-open range in a file: `[start, end)`. Lines are 1-based, as a reader
 * counts them and as every refusal in this project names them; columns are
 * 0-based UTF-16 code units within their line, the encoding SCIP and the
 * language servers count in by default. A producer whose tool counts UTF-8
 * bytes converts at the edge, so one fact means one range on every machine.
 */
export interface FactRange {
  /** The range's first line, 1-based. */
  readonly startLine: number;
  /** The first character's offset in `startLine`, 0-based. */
  readonly startColumn: number;
  /** The range's last line, 1-based; never before `startLine`. */
  readonly endLine: number;
  /** The offset just past the last character in `endLine`, 0-based; equal to `startColumn` when the range is empty. */
  readonly endColumn: number;
}

/** Where in a repository a fact was read: the file, and the range inside it. */
export interface FactPlace {
  readonly file: RepositoryPath;
  readonly range: FactRange;
}

/**
 * Every fact's provenance (0004): who read it, at which version, in which
 * repository and commit, and at which place. `place` is required exactly for
 * the kinds `FACT_KINDS` marks (`required` and `identity`), and is not
 * identity unless the kind says so — a fact's commit is what it was read at,
 * not what it is.
 *
 * The valid and recorded times of decision 0009 are the fact log's, not the
 * fact's: a fact carries no clock reading, which is what keeps an id the same
 * across runs.
 */
export interface FactProvenance {
  readonly source: FactSource;
  readonly repository: RepositoryRef;
  readonly place?: FactPlace;
}

// ---- layers and statuses (decision 0005) ---------------------------------

/**
 * How a fact was obtained (0005): `declared` by a person in the product's own
 * authored words (the intended model, a document's own statements),
 * `extracted` by a deterministic reader of code, `inferred` by an agent's
 * interpretation, `observed` from runtime traffic. The fill writes no
 * `observed` fact today (no stage watches a running system), and the kind
 * table does not admit the layer where that is so.
 */
export type FactLayer = 'declared' | 'extracted' | 'inferred' | 'observed';

/** Whether a fact is accepted (0005), kept apart from how it was obtained. */
export type FactStatus = 'proposed' | 'accepted' | 'rejected';

/**
 * The statuses a fact of a layer may carry. A person's acceptance is an
 * acceptance record beside the fact (0005: "acceptance adds a record without
 * rewriting the origin"), so an extracted, inferred or observed fact is
 * always written `proposed`; only a declaration of the product's own words
 * stands as `accepted`, and a person may record it `rejected`.
 */
export function statusesOfLayer(layer: FactLayer): readonly FactStatus[] {
  return layer === 'declared' ? ['proposed', 'accepted', 'rejected'] : ['proposed'];
}

// ---- the stages of the fill (decision 0026) ------------------------------

/** The fill's stages, decision 0026's own order: 0–7 deterministic, 8–13 agent. */
export const FACT_STAGES = [
  '0-snapshot',
  '1-inventory',
  '2-build-and-configuration',
  '3-syntax',
  '4-resolution',
  '5-modules',
  '6-documents',
  '7-history',
  '8-overview',
  '9-boundaries',
  '10-intent-documents',
  '11-intent-history',
  '12-understanding',
  '13-recovery',
] as const;
export type FactStage = (typeof FACT_STAGES)[number];

/** The agent stages, 8 to 13: every fact they write is `inferred` (0005). */
export const AGENT_STAGES: readonly FactStage[] = ['8-overview', '9-boundaries', '10-intent-documents', '11-intent-history', '12-understanding', '13-recovery'];

// ---- the kinds -----------------------------------------------------------

/** Every node kind. A node is one thing the graph holds: a file, a symbol, a module, a claim. */
export const FACT_NODE_KINDS = [
  // stages 0–7
  'snapshot',
  'repository',
  'directory',
  'file',
  'package',
  'deploy-unit',
  'api-endpoint',
  'table',
  'column',
  'environment-variable',
  'symbol',
  'occurrence',
  'entry-point',
  'comment',
  'test',
  'module',
  'document',
  'section',
  'commit',
  // agent stages
  'claim',
  'entity-proposal',
  'rule',
  'state',
  'coverage',
  'question',
] as const;
export type FactNodeKind = (typeof FACT_NODE_KINDS)[number];

/** Every edge kind. An edge joins two nodes of any kind the edge's own value names. */
export const FACT_EDGE_KINDS = [
  // stages 1–7
  'contains',
  'defines',
  'import',
  'dependency',
  'call',
  'reference',
  // 0004's atoms that code and configuration carry
  'provides',
  'consumes',
  'binds',
  'resolves',
  // documents and history
  'document-link',
  'task-key',
  // agent stages
  'transition',
  'interaction',
] as const;
export type FactEdgeKind = (typeof FACT_EDGE_KINDS)[number];

export type FactKind = FactNodeKind | FactEdgeKind;

/** Every kind, nodes first, each list in code point order. */
export const FACT_KINDS_IN_ORDER: readonly FactKind[] = [...[...FACT_NODE_KINDS].sort(byCodePoint), ...[...FACT_EDGE_KINDS].sort(byCodePoint)];

/** Whether a value is one of the schema's kinds; the check the write path makes on an unchecked write. */
export function isFactKind(value: unknown): value is FactKind {
  return typeof value === 'string' && (FACT_KINDS_IN_ORDER as readonly string[]).includes(value);
}

/** A fact's id, as it is written and stored: the kind, a colon, and the SHA-256 digest of the fact's identity. */
export const FACT_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*:[0-9a-f]{64}$/;

/** Whether a value has the shape of a fact id. */
export function isFactId(value: unknown): value is string {
  return typeof value === 'string' && FACT_ID_PATTERN.test(value);
}

/** A fact kind's name: one lower-case kebab token, so a namespace of its own and never a registry kind's phrase. */
export const FACT_KIND_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The role a file plays (stages 1 and 3): a file may play several at once, each named once, in code point order. */
export type FileRole = 'asset' | 'build' | 'config' | 'document' | 'fixture' | 'generated' | 'migration' | 'schema' | 'source' | 'test' | 'vendor';

/** The form a package node is (stage 2): a package, a build target, or a workspace holding both. */
export type PackageForm = 'build-target' | 'package' | 'workspace';

/** The form a deploy unit is (stage 2). */
export type DeployForm = 'chart' | 'container' | 'function' | 'job' | 'service' | 'stack';

/** What kind of way into the code an entry point is (stage 3). */
export type EntryPointForm = 'cli-command' | 'http-route' | 'job' | 'library-export' | 'main';

/** How a module or cluster came to be (stage 5): seeded from a package or build target, or a cluster of one. */
export type ModuleSeed = 'build-target' | 'cluster' | 'package';

/** The shapes a business rule takes (agent stages). */
export type RuleForm = 'constraint' | 'invariant' | 'policy' | 'validation';

/** What a dependency edge stands on (stage 2). */
export type DependencyBasis = 'build' | 'import' | 'manifest';

/** How one element interacts with another (agent stages). */
export type InteractionForm = 'call' | 'event' | 'http' | 'message' | 'sql';

/**
 * What a name in the code does at its position: SCIP's `SymbolRole` bitset as
 * a list (a position may both define and write), so the roles a reader sees
 * are named instead of numbered.
 */
export type OccurrenceRole = 'definition' | 'forward-definition' | 'generated' | 'import' | 'read-access' | 'test' | 'write-access';

/**
 * A symbol's coarse kind. Stage 4's resolver reports SCIP's fine-grained
 * `Kind` (87 values, most of them one language's); this list is the graph's
 * own, and the resolver folds a finer kind into the closest of these (an
 * `AbstractMethod`, a `StaticMethod` and a `Getter` are all a `method`) while
 * the producer's own name is kept in `SymbolValue.scipKind` so nothing is
 * lost.
 */
export type SymbolKind =
  | 'class'
  | 'constant'
  | 'constructor'
  | 'enum'
  | 'enum-member'
  | 'event'
  | 'field'
  | 'function'
  | 'interface'
  | 'macro'
  | 'method'
  | 'module'
  | 'namespace'
  | 'object'
  | 'operator'
  | 'other'
  | 'package'
  | 'parameter'
  | 'property'
  | 'struct'
  | 'trait'
  | 'type'
  | 'type-alias'
  | 'type-parameter'
  | 'variable';

/** Why a scope could not be read completely (0004's `coverage`): what a scope's coverage says it could not read. */
export type CoverageGapReason = 'budget' | 'error' | 'inaccessible' | 'too-large' | 'unsupported';

/** One thing a scope's coverage could not read, and why: a missing coverage is "not enough data", never absence (0005). */
export interface CoverageGap {
  /** What was not read: a path, a kind of file, or a question the reader could not answer. */
  readonly what: string;
  readonly reason: CoverageGapReason;
}

/**
 * One end of an assertion that is not a node of the graph: an address outside
 * the repositories (a URL a document links to) or a literal (the value a
 * claim states). A claim's subject and object and a document link's target
 * are these, so a fact always says which of the three it names.
 */
export type FactTerm =
  | { readonly form: 'node'; readonly id: string }
  | { readonly form: 'external'; readonly url: string }
  | { readonly form: 'literal'; readonly text: string };

/**
 * A value an environment binds a variable to (0004's `binds`). A value read
 * from a manifest is kept either as written (`literal`) or, where the
 * extractor judges the text to be a secret, only as the digest of the bytes
 * it read (`digest`) — the extents of that judgement are the stage's own, and
 * a later policy may narrow it without changing this shape.
 */
export type BindingValue =
  | { readonly form: 'literal'; readonly text: string }
  | { readonly form: 'digest'; readonly sha256: string };

// ---- the value of each kind ----------------------------------------------
//
// A value holds what a reader of the graph shows: the fields that make up the
// fact's identity (repeated here, because an id is an opaque digest) and the
// attributes that may change without changing what the fact is about. Fields
// the identity does not name never reach the id.

/** Stage 0: one repository pinned at one commit, with the tree it read. */
export interface SnapshotValue {
  /** The repository's own name, as `RepositoryRef.id` carries it. */
  readonly repository: string;
  /** The commit that was pinned: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The git tree id of that commit: 40 lower-case hexadecimal digits. */
  readonly tree: string;
  readonly fileCount: number;
  readonly byteCount: number;
}

/** Stage 0: a repository the product holds, one node per repository across commits. */
export interface RepositoryValue {
  readonly repository: string;
  /** A code repository, or the product repository itself (decision 0021). */
  readonly form: 'code' | 'product';
  /** The branch the repository was read on, when the price of a pin is not yet paid. */
  readonly defaultBranch?: string;
}

/** Stage 1: a folder of a repository. */
export interface DirectoryValue {
  readonly repository: string;
  readonly path: RepositoryPath;
}

/** Stage 1: one file, with the roles read for it and the language its bytes are in. */
export interface FileValue {
  readonly repository: string;
  readonly path: RepositoryPath;
  /**
   * What the file is, one or more roles in code point order, each once: a
   * test file is `source` and `test`, a fixture under the tests is
   * `fixture`. A file the inventory cannot place carries the one role
   * `source` only when it read it as code; otherwise it names what it found.
   */
  readonly roles: readonly FileRole[];
  /** The language the file is written in, as stage 3's parser names it (`typescript`, `go`). */
  readonly language?: string;
  readonly bytes?: number;
}

/** Stage 2: a package, a build target or a workspace (0026's clustering seeds). */
export interface PackageValue {
  readonly repository: string;
  /** The ecosystem's own name (`@acme/orders`, `orders-service`, `//src/app:app`), never a path. */
  readonly name: string;
  readonly form: PackageForm;
  /** The package manager or build system that declares it (`npm`, `cargo`, `go`, `bazel`). */
  readonly ecosystem?: string;
  readonly version?: string;
  /** The file that declares it, when the extractor read it from one. */
  readonly manifest?: RepositoryPath;
}

/** Stage 2: something that is deployed — a container, a chart, a job, a function. */
export interface DeployUnitValue {
  readonly repository: string;
  readonly name: string;
  readonly form: DeployForm;
  /** The manifest or chart that declares it (a Dockerfile, a values file, a compose file). */
  readonly manifest?: RepositoryPath;
}

/**
 * Stages 2 and 4: an API endpoint, by its normalized contract id (decision
 * 0003's rendezvous point: `http::GET::/api/orders/{}`,
 * `grpc::orders.v1.OrderService/Create`, `topic::order-placed`,
 * `data::orders`). The contract id is the identity, so the endpoint one
 * repository provides and another calls is one node.
 */
export interface ApiEndpointValue {
  /** The normalized contract id, in 0003's form: `<protocol>::<rest>`. */
  readonly contract: string;
  /** The framework that declares or calls it (`express`, `grpc-go`), when a stage read one. */
  readonly framework?: string;
}

/** Stage 2: a table of a store, by the name the store knows it by. */
export interface TableValue {
  readonly repository: string;
  /** The table's name as the store knows it, schema-qualified where the store is (`public.orders`). */
  readonly name: string;
  readonly engine?: string;
}

/** Stage 2: a column of a table. */
export interface ColumnValue {
  readonly repository: string;
  /** The table's name, as `TableValue.name` carries it. */
  readonly table: string;
  readonly name: string;
  readonly dataType?: string;
}

/**
 * Stage 2: an environment variable. Decision 0006 makes the variable's name
 * the rendezvous point, so the name alone is the identity and a variable one
 * repository provides is the variable another consumes.
 */
export interface EnvironmentVariableValue {
  /** The variable's name, exactly as the code and the manifests spell it (`ORDERS_TOPIC`). */
  readonly name: string;
}

/** Stages 3 and 4: one symbol a resolver named, at its definition. */
export interface SymbolValue {
  readonly repository: string;
  /** The file the symbol is defined in. */
  readonly file: RepositoryPath;
  /** The symbol's qualified name inside the file (`OrderService.create`); an overload is told apart by `disambiguator`. */
  readonly qualifiedName: string;
  readonly symbolKind: SymbolKind;
  /** What tells two same-named symbols of one file apart: SCIP's descriptor disambiguator, when a resolver names one. */
  readonly disambiguator?: string;
  /** The producer's own SCIP `Kind` name when it is finer than `symbolKind` (`AbstractMethod`), so the fold loses nothing. */
  readonly scipKind?: string;
  /** The name a reader sees (`create`), where the qualified name reads worse. */
  readonly displayName?: string;
  /** The signature as the resolver rendered it (`create(order: Order): Promise<void>`). */
  readonly signature?: string;
}

/**
 * Stages 3 and 4: one position where a name appears, tied to the symbol it
 * names. The occurrence's identity is its place (and the symbol it names): a
 * symbol keeps its id when the file around it moves, a mention does not.
 */
export interface OccurrenceValue {
  /** The symbol fact's id, `factId` of a `symbol` fact; empty never. */
  readonly symbol: string;
  /** What the name does here, in code point order, each once (SCIP's roles). */
  readonly roles: readonly OccurrenceRole[];
}

/** Stage 3: a way into the code — a command, a route, a job, an export, a main. */
export interface EntryPointValue {
  readonly repository: string;
  readonly file: RepositoryPath;
  /** The name a caller knows it by (`madarch serve`, `GET /products`); the form says which. */
  readonly name: string;
  readonly form: EntryPointForm;
}

/** Stage 3: a comment, with the text a later agent stage reads intent from. */
export interface CommentValue {
  /** The comment's text without its markers, as written. */
  readonly text: string;
  readonly form: 'block' | 'doc' | 'line';
}

/** Stage 3: a test, by the name the test runner knows: one test case, not its file. */
export interface TestValue {
  readonly repository: string;
  readonly file: RepositoryPath;
  /** The test's own name (`places an order`), as its framework reports it. */
  readonly name: string;
  readonly framework?: string;
  /** The symbol facts the test exercises, by id, in code point order. */
  readonly covers?: readonly string[];
}

/**
 * Stage 5: a module — a cluster of files and symbols, seeded from a package
 * or build target and split until each fits a unit (0026's scale rule), or
 * refined by an agent at stage 9.
 */
export interface ModuleValue {
  readonly repository: string;
  /** The module's name inside its parent (`checkout-payment`), or the seed's own name at the top. */
  readonly name: string;
  /** The parent module's fact id; absent at the top of the tree. */
  readonly parent?: string;
  readonly seed: ModuleSeed;
  /** How many files and symbols the cluster holds, as stage 5 counted them. */
  readonly members?: number;
  /** What stage 5's PageRank made of it, in [0, 1]; the priority a run admits its units by. */
  readonly importance?: number;
}

/** Stage 6: a document of the product or of a repository. */
export interface DocumentValue {
  readonly repository: string;
  readonly path: RepositoryPath;
  readonly mediaType: string;
  readonly title?: string;
}

/** Stage 6: a section of a document, by the anchor a reader's link names. */
export interface SectionValue {
  readonly repository: string;
  /** The document the section lives in, by its path. */
  readonly document: RepositoryPath;
  /** The anchor a link names (`requirement-strict-yaml`), unique within its document. */
  readonly anchor: string;
  /** The heading a reader sees, without its markers. */
  readonly heading: string;
  /** The heading's depth, 1 for `#`. */
  readonly level: number;
}

/** Stage 7: one commit of a repository, with what a reader sees of it. */
export interface CommitValue {
  readonly repository: string;
  /** The commit: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The commit's own time, ISO 8601 with `Z`, as git recorded it — a value, never the clock this run read. */
  readonly committedAt: string;
  /** The commit's subject line. */
  readonly subject: string;
  readonly author?: string;
}

/**
 * Agent stages: one assertion about the graph, in the shape 0026's checked
 * writes ask of an agent: a subject, a predicate, an object, the span it
 * stands on (its place, which is identity) and the confidence the agent
 * placed in it. The layer says how it was obtained, the status whether anyone
 * accepted it, and the evidence is the place: an agent's claim cites bytes
 * that madarch read itself at the pinned commit.
 */
export interface ClaimValue {
  /** What the claim is about: a node of the graph. */
  readonly subject: FactTerm;
  /** What it says about the subject, one lower-case kebab token (`is-implemented-by`, `contradicts`, `states`). */
  readonly predicate: string;
  /** What it says: another node, an address outside the repositories, or a literal. */
  readonly object: FactTerm;
  /** The claim's own words, for a reader of the page. */
  readonly text?: string;
  /** The agent's own confidence, in [0, 1]. */
  readonly confidence?: number;
}

/**
 * Agent stages: a candidate for a registry document or for a concept of the
 * domain (RepoDoc's Concept Entity), proposed rather than written: what
 * madarch's `propose_entity` answers with is the similar existing ones, and a
 * person decides whether a document of the product's own kind follows.
 */
export interface EntityProposalValue {
  readonly repository: string;
  /** A concept of the domain, or an entity a document of the product could be about. */
  readonly proposed: 'concept' | 'entity';
  /** The name proposed, as the agent wrote it (trimmed, inner whitespace collapsed). */
  readonly name: string;
  readonly summary?: string;
  /** Other names the agent found for it, in code point order, each once. */
  readonly aliases?: readonly string[];
}

/** Agent stages: a rule of the domain, recovered from code or comments (a business rule, a validation invariant). */
export interface RuleValue {
  /** The rule's statement, as one sentence. */
  readonly statement: string;
  /** The node the rule is about, by fact id, when the agent named one. */
  readonly subject?: string;
  readonly form: RuleForm;
}

/** Agent stages: one state of a state machine the code carries or an agent recovered. */
export interface StateValue {
  /** The repository whose code carries the machine: the same name in two repositories is two machines. */
  readonly repository: string;
  /** The machine's name as the code spells it (`OrderStatus`, `checkout`), the identity's other half. */
  readonly machine: string;
  readonly name: string;
  readonly initial?: boolean;
  readonly final?: boolean;
}

/**
 * Every stage: what a stage's reader read in one scope, and what it could not
 * read and why (0004's `coverage`). A scope with no gap is complete; a scope
 * with a gap is "not enough data", never absence (0005).
 */
export interface CoverageValue {
  readonly repository: string;
  /** The scope read, in the graph's own terms: `product`, a module or repository fact id, or a place's path. */
  readonly scope: string;
  /** Whether the reader read the whole scope; a complete coverage is the only ground for a claim of absence. */
  readonly complete: boolean;
  /** What was read, in code point order, each once: paths, kinds of file, or the questions the reader answered. */
  readonly read: readonly string[];
  /** What could not be read, each once, in code point order of `what`. */
  readonly unread: readonly CoverageGap[];
}

/** Agent stages: a question the fill raises for a person — the open question a page shows and a person answers. */
export interface QuestionValue {
  readonly repository: string;
  /** The kind of question, one lower-case kebab token (`assumption-check`, `contradiction`, `unverifiable`). */
  readonly type: string;
  /** What it is about: a fact id or a scope, when the question names one. */
  readonly about?: string;
  /** The question as a person reads it, one sentence. */
  readonly prompt: string;
}

// ---- the value of each edge ----------------------------------------------

/** Stage 1: a folder, a repository or a module holds a file, a folder or a symbol. */
export interface ContainsEdgeValue {
  readonly from: string;
  readonly to: string;
}

/** Stages 3 and 4: a file defines a symbol. */
export interface DefinesEdgeValue {
  readonly from: string;
  readonly to: string;
}

/**
 * Stage 3: a file imports another file, package or module. An import the
 * resolver could not tie to a node (an unresolved specifier, a package
 * outside the repositories) is not an edge with an invented end: it is the
 * scope's coverage gap, so the graph's edges are always between nodes that
 * exist (0026's checked writes).
 */
export interface ImportEdgeValue {
  readonly from: string;
  readonly to: string;
  /** The specifier as written (`../model/order.js`), for a reader of the page. */
  readonly specifier: string;
}

/** Stage 2: one package, build target or module depends on another, on the named basis. */
export interface DependencyEdgeValue {
  readonly from: string;
  readonly to: string;
  readonly basis: DependencyBasis;
}

/**
 * Stage 4: one symbol calls another. Calls are aggregated per pair of
 * symbols (not one edge per call site, which on a large repository is the
 * same answer many times), and the aggregation's provenance is the
 * code-point-smallest call site, so the edge's evidence is deterministic.
 */
export interface CallEdgeValue {
  readonly from: string;
  readonly to: string;
  /** How many call sites were folded into the edge. */
  readonly count?: number;
}

/** Stage 3: one symbol mentions another without calling it (a type, a value, a constant). */
export interface ReferenceEdgeValue {
  readonly from: string;
  readonly to: string;
  /** How many mentions were folded into the edge. */
  readonly count?: number;
}

/** Stage 2: an element provides a contract id (0004's `provides`). */
export interface ProvidesEdgeValue {
  /** The providing element's fact id: a deploy unit, a package or a module. */
  readonly from: string;
  /** The normalized contract id, as `ApiEndpointValue.contract` carries it. */
  readonly contract: string;
}

/** Stage 2: a symbol, file or package uses an interface through an environment variable (0004's `consumes`). */
export interface ConsumesEdgeValue {
  readonly from: string;
  /** The environment variable node's fact id. */
  readonly variable: string;
}

/** Stage 2: in an environment, a variable has a value (0004's `binds`). */
export interface BindsEdgeValue {
  /** The environment variable node's fact id. */
  readonly variable: string;
  /** The environment's name as the product spells it (`production`, `local`). */
  readonly environment: string;
  readonly value: BindingValue;
}

/** Stage 2: an endpoint belongs to a deploy unit instance (0004's `resolves`). */
export interface ResolvesEdgeValue {
  /** The API endpoint's fact id. */
  readonly from: string;
  /** The deploy unit's fact id. */
  readonly to: string;
}

/** Stage 6: a document or a section names something — another node, or an address outside the repositories. */
export interface DocumentLinkEdgeValue {
  /** The document or section the link stands in, by fact id. */
  readonly from: string;
  readonly to: FactTerm;
}

/** Stage 7: a commit names a task of the tracker (`Task: madarch-tzte.20.1`). */
export interface TaskKeyEdgeValue {
  /** The commit's fact id. */
  readonly from: string;
  /** The task key as the commit wrote it, case kept. */
  readonly key: string;
}

/** Agent stages: one state machine goes from a state to another on an event. */
export interface TransitionEdgeValue {
  /** The state's fact id. */
  readonly from: string;
  readonly to: string;
  /** What makes the machine move (`payment-declined`), one token or a few words as the code names it. */
  readonly event: string;
}

/** Agent stages: one element uses another through an interface — a call, a message, an HTTP request, an SQL statement. */
export interface InteractionEdgeValue {
  /** The caller's fact id. */
  readonly caller: string;
  /** The callee's fact id. */
  readonly callee: string;
  readonly form: InteractionForm;
  /** What carries it, when the agent names one (`orders-topic`, `POST /api/orders`). */
  readonly via?: string;
}

/** The value type of one node kind, by the kind's own name. */
export interface FactNodeValues {
  'snapshot': SnapshotValue;
  'repository': RepositoryValue;
  'directory': DirectoryValue;
  'file': FileValue;
  'package': PackageValue;
  'deploy-unit': DeployUnitValue;
  'api-endpoint': ApiEndpointValue;
  'table': TableValue;
  'column': ColumnValue;
  'environment-variable': EnvironmentVariableValue;
  'symbol': SymbolValue;
  'occurrence': OccurrenceValue;
  'entry-point': EntryPointValue;
  'comment': CommentValue;
  'test': TestValue;
  'module': ModuleValue;
  'document': DocumentValue;
  'section': SectionValue;
  'commit': CommitValue;
  'claim': ClaimValue;
  'entity-proposal': EntityProposalValue;
  'rule': RuleValue;
  'state': StateValue;
  'coverage': CoverageValue;
  'question': QuestionValue;
}

/** The value type of one edge kind, by the kind's own name. */
export interface FactEdgeValues {
  'contains': ContainsEdgeValue;
  'defines': DefinesEdgeValue;
  'import': ImportEdgeValue;
  'dependency': DependencyEdgeValue;
  'call': CallEdgeValue;
  'reference': ReferenceEdgeValue;
  'provides': ProvidesEdgeValue;
  'consumes': ConsumesEdgeValue;
  'binds': BindsEdgeValue;
  'resolves': ResolvesEdgeValue;
  'document-link': DocumentLinkEdgeValue;
  'task-key': TaskKeyEdgeValue;
  'transition': TransitionEdgeValue;
  'interaction': InteractionEdgeValue;
}

/** The value of a fact of the kind: `FactValueOf<'file'>` is `FileValue`. */
export type FactValueOf<K extends FactKind> = K extends FactNodeKind ? FactNodeValues[K] : K extends FactEdgeKind ? FactEdgeValues[K] : never;

// ---- identity ------------------------------------------------------------

/** One part of a fact's identity: the name it carries in the digest and its value. */
export type IdentityPart = readonly [field: string, value: unknown];

/**
 * How a fact's place stands toward its identity:
 * - `required`: the fact stands at a place and must cite it, but the place is
 *   not what the fact is about (a symbol's definition moves with the code and
 *   keeps its id through `qualifiedName`).
 * - `optional`: the fact may cite the place it was read at, and is the same
 *   fact without one (a package read from a manifest is the package).
 * - `identity`: the fact is one assertion at one position (a comment, an
 *   occurrence, a claim, an interaction), so the place is part of what it is.
 */
export type FactPlaceRule = 'identity' | 'optional' | 'required';

/** One kind as the schema declares it. */
export interface FactKindDefinition<K extends FactKind = FactKind> {
  readonly kind: K;
  readonly shape: 'edge' | 'node';
  /** The stages whose facts carry the kind, in 0026's stage order; a kind every stage writes names every stage. */
  readonly stages: readonly FactStage[];
  readonly place: FactPlaceRule;
  /** The layers a fact of the kind may be written in (0005); `statusesOfLayer` decides the statuses over them. */
  readonly layers: readonly FactLayer[];
  /** The version of the kind's value shape, as decision 0027's `produces` reads it. */
  readonly version: number;
  /**
   * What the fact is, as the parts its id is the digest of: never a commit,
   * an extractor's version, a layer, a status, a run, a unit, an attempt or a
   * time. Two facts with the same parts are one fact.
   */
  readonly identity: (value: FactValueOf<K>, provenance: FactProvenance) => readonly IdentityPart[];
}

/** A name as identity sees it: trimmed, inner whitespace collapsed to one space; case and characters kept. */
function identityName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** A range as identity sees it, one string, so the four numbers are read as one part. */
function identityRange(range: FactRange): string {
  return `${range.startLine}:${range.startColumn}-${range.endLine}:${range.endColumn}`;
}

/**
 * The parts a place contributes to an identity: the repository, the file and
 * the range. A kind whose place is identity names this entry through it, so
 * two repositories' files at one relative path are never one fact.
 */
function identityPlace(provenance: FactProvenance): readonly IdentityPart[] {
  const place = provenance.place;
  if (place === undefined) {
    throw new FactSchemaError('provenance.place', 'the fact has no place: this kind is one assertion at one position, so it cites the file and range it stands on');
  }
  return [
    ['repository', provenance.repository.id],
    ['file', identityPath('place.file', place.file)],
    ['range', identityRange(place.range)],
  ];
}

/** The stages that write the agent kinds: 9 to 13, the stages that interpret rather than read. */
const AGENT_FACT_STAGES: readonly FactStage[] = ['9-boundaries', '10-intent-documents', '11-intent-history', '12-understanding', '13-recovery'];

/**
 * The schema's table: every kind, what it is made of, which stages write it,
 * what layer it may be written in and where its place must stand. The table
 * is the one place a kind is declared; `factId` and `checkFact` read it and
 * nothing else.
 */
export const FACT_KINDS: { readonly [K in FactKind]: FactKindDefinition<K> } = {
  // ---- stages 0 to 7: what the deterministic readers find -----------------
  'snapshot': {
    kind: 'snapshot',
    shape: 'node',
    stages: ['0-snapshot'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['commit', value.commit]],
  },
  'repository': {
    kind: 'repository',
    shape: 'node',
    stages: ['0-snapshot'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository]],
  },
  'directory': {
    kind: 'directory',
    shape: 'node',
    stages: ['1-inventory'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['path', identityPath('path', value.path)]],
  },
  'file': {
    kind: 'file',
    shape: 'node',
    stages: ['1-inventory'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['path', identityPath('path', value.path)]],
  },
  'package': {
    kind: 'package',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['form', value.form], ['name', identityName(value.name)]],
  },
  'deploy-unit': {
    kind: 'deploy-unit',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['form', value.form], ['name', identityName(value.name)]],
  },
  'api-endpoint': {
    kind: 'api-endpoint',
    shape: 'node',
    stages: ['2-build-and-configuration', '4-resolution'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['contract', identityName(value.contract)]],
  },
  'table': {
    kind: 'table',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['name', identityName(value.name)]],
  },
  'column': {
    kind: 'column',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['table', identityName(value.table)], ['name', identityName(value.name)]],
  },
  'environment-variable': {
    kind: 'environment-variable',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['name', value.name]],
  },
  'symbol': {
    kind: 'symbol',
    shape: 'node',
    stages: ['3-syntax', '4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [
      ['repository', value.repository],
      ['file', identityPath('file', value.file)],
      ['qualifiedName', value.qualifiedName],
      ['symbolKind', value.symbolKind],
      ['disambiguator', value.disambiguator ?? ''],
    ],
  },
  'occurrence': {
    kind: 'occurrence',
    shape: 'node',
    stages: ['3-syntax', '4-resolution'],
    place: 'identity',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value, provenance) => [['symbol', value.symbol], ...identityPlace(provenance)],
  },
  'entry-point': {
    kind: 'entry-point',
    shape: 'node',
    stages: ['3-syntax'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [
      ['repository', value.repository],
      ['file', identityPath('file', value.file)],
      ['form', value.form],
      ['name', identityName(value.name)],
    ],
  },
  'comment': {
    kind: 'comment',
    shape: 'node',
    stages: ['3-syntax'],
    place: 'identity',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (_value, provenance) => identityPlace(provenance),
  },
  'test': {
    kind: 'test',
    shape: 'node',
    stages: ['3-syntax'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['file', identityPath('file', value.file)], ['name', identityName(value.name)]],
  },
  'module': {
    kind: 'module',
    shape: 'node',
    stages: ['5-modules'],
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['parent', value.parent ?? ''], ['name', identityName(value.name)]],
  },
  'document': {
    kind: 'document',
    shape: 'node',
    stages: ['6-documents'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['path', identityPath('path', value.path)]],
  },
  'section': {
    kind: 'section',
    shape: 'node',
    stages: ['6-documents'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['document', identityPath('document', value.document)], ['anchor', value.anchor]],
  },
  'commit': {
    kind: 'commit',
    shape: 'node',
    stages: ['7-history'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['commit', value.commit]],
  },

  // ---- agent stages: what an agent read and proposed ----------------------
  'claim': {
    kind: 'claim',
    shape: 'node',
    stages: ['8-overview', '10-intent-documents', '11-intent-history', '12-understanding', '13-recovery'],
    place: 'identity',
    layers: ['declared', 'extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value, provenance) => [['subject', value.subject], ['predicate', value.predicate], ['object', value.object], ...identityPlace(provenance)],
  },
  'entity-proposal': {
    kind: 'entity-proposal',
    shape: 'node',
    stages: ['12-understanding', '13-recovery'],
    place: 'optional',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['proposed', value.proposed], ['name', identityName(value.name)]],
  },
  'rule': {
    kind: 'rule',
    shape: 'node',
    stages: ['11-intent-history', '12-understanding'],
    place: 'identity',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value, provenance) => [['subject', value.subject ?? ''], ['statement', identityName(value.statement)], ...identityPlace(provenance)],
  },
  'state': {
    kind: 'state',
    shape: 'node',
    stages: ['12-understanding'],
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['machine', identityName(value.machine)], ['name', identityName(value.name)]],
  },
  'coverage': {
    kind: 'coverage',
    shape: 'node',
    stages: FACT_STAGES,
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value, provenance) => [['repository', value.repository], ['scope', value.scope], ['reader', provenance.source.system]],
  },
  'question': {
    kind: 'question',
    shape: 'node',
    stages: AGENT_FACT_STAGES,
    place: 'optional',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['repository', value.repository], ['type', value.type], ['about', value.about ?? ''], ['prompt', identityName(value.prompt)]],
  },

  // ---- edges -------------------------------------------------------------
  'contains': {
    kind: 'contains',
    shape: 'edge',
    stages: ['1-inventory', '5-modules', '6-documents'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'defines': {
    kind: 'defines',
    shape: 'edge',
    stages: ['3-syntax', '4-resolution'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'import': {
    kind: 'import',
    shape: 'edge',
    stages: ['3-syntax', '4-resolution'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'dependency': {
    kind: 'dependency',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to], ['basis', value.basis]],
  },
  'call': {
    kind: 'call',
    shape: 'edge',
    stages: ['4-resolution'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'reference': {
    kind: 'reference',
    shape: 'edge',
    stages: ['4-resolution'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'provides': {
    kind: 'provides',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['contract', identityName(value.contract)]],
  },
  'consumes': {
    kind: 'consumes',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['variable', value.variable]],
  },
  'binds': {
    kind: 'binds',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['variable', value.variable], ['environment', identityName(value.environment)]],
  },
  'resolves': {
    kind: 'resolves',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'document-link': {
    kind: 'document-link',
    shape: 'edge',
    stages: ['6-documents'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to]],
  },
  'task-key': {
    kind: 'task-key',
    shape: 'edge',
    stages: ['7-history'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['key', value.key]],
  },
  'transition': {
    kind: 'transition',
    shape: 'edge',
    stages: ['12-understanding'],
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value) => [['from', value.from], ['to', value.to], ['event', identityName(value.event)]],
  },
  'interaction': {
    kind: 'interaction',
    shape: 'edge',
    stages: ['12-understanding', '13-recovery'],
    place: 'identity',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identity: (value, provenance) => [['caller', value.caller], ['callee', value.callee], ['form', value.form], ['via', identityName(value.via ?? '')], ...identityPlace(provenance)],
  },
};

// ---- the id --------------------------------------------------------------

/**
 * The id of a fact: the kind, a colon, and the SHA-256 digest of the fact's
 * identity parts as canonical JSON (keys in code point order, no whitespace).
 * The same fact — the same repository, the same place, the same structural
 * answer — digests to the same id in every run, on every machine, at every
 * commit; a fact whose value changes without changing its identity keeps its
 * id, and a different fact never takes another's.
 *
 * Refuses (with `FactSchemaError`, at the field's own path) an identity part
 * that is missing or named twice, and a place that is not a repository path:
 * an id is never computed from what a machine happens to be reading.
 */
export function factId<K extends FactKind>(fact: {
  readonly kind: K;
  readonly value: FactValueOf<K>;
  readonly provenance: FactProvenance;
}): string {
  const definition = FACT_KINDS[fact.kind] as FactKindDefinition<K>;
  const parts = definition.identity(fact.value, fact.provenance);
  const identity: Record<string, unknown> = {};
  for (const [field, part] of parts) {
    if (Object.hasOwn(identity, field)) {
      throw new FactSchemaError('value', `the identity of ${withArticle(fact.kind)} fact names "${field}" twice: each part of an identity is named once`);
    }
    if (part === undefined) {
      throw new FactSchemaError(`value.${field}`, `the ${fact.kind} fact has no value for the identity field "${field}": an id is its identity's digest, so every part is required`);
    }
    if (field === '') throw new FactSchemaError('value', `the identity of ${withArticle(fact.kind)} fact names an unnamed part: each part carries the field it is`);
    identity[field] = part;
  }
  return `${fact.kind}:${canonicalJsonDigest({ kind: fact.kind, identity })}`;
}

// ---- the fact ------------------------------------------------------------

/** One fact as the graph holds it: the kind, the schema's version, the id, its provenance, layer and status, and the kind's own value. */
export interface FactEnvelope<K extends FactKind, V> {
  readonly kind: K;
  /** The version of the kind's value shape (decision 0027's `produces`), `FACT_KINDS[kind].version`. */
  readonly schemaVersion: number;
  /** The content-addressed id: `factId` of the kind, the value and the provenance. */
  readonly id: string;
  readonly provenance: FactProvenance;
  readonly layer: FactLayer;
  readonly status: FactStatus;
  readonly value: V;
}

/** Any node fact, discriminated by `kind`, so a reader narrows the value by the kind it read. */
export type NodeFact = { [K in FactNodeKind]: FactEnvelope<K, FactNodeValues[K]> }[FactNodeKind];

/** Any edge fact, discriminated by `kind`. */
export type EdgeFact = { [K in FactEdgeKind]: FactEnvelope<K, FactEdgeValues[K]> }[FactEdgeKind];

/** Any fact of the schema. */
export type Fact = NodeFact | EdgeFact;

/** What a writer hands the schema: the kind, the value, the provenance, the layer, and the status (proposed unless a declaration says otherwise). */
export interface FactInput<K extends FactKind> {
  readonly kind: K;
  readonly value: FactValueOf<K>;
  readonly provenance: FactProvenance;
  readonly layer: FactLayer;
  /** Left out, the fact is a proposal (0005): a person's acceptance is a record beside the fact, never a rewrite of it. */
  readonly status?: FactStatus;
}

/** Builds one node fact of a kind, computing its id and refusing a fact the schema does not read. */
export function makeNodeFact<K extends FactNodeKind>(input: FactInput<K>): FactEnvelope<K, FactNodeValues[K]> {
  return makeFact(input);
}

/** Builds one edge fact of a kind, computing its id and refusing a fact the schema does not read. */
export function makeEdgeFact<K extends FactEdgeKind>(input: FactInput<K>): FactEnvelope<K, FactEdgeValues[K]> {
  return makeFact(input);
}

/**
 * The one constructor: the id is the identity's digest, the version is the
 * kind's, the status defaults to `proposed`, and the result is checked with
 * `checkFact` — a fact this function returns is one the schema reads.
 */
function makeFact<K extends FactKind>(input: FactInput<K>): FactEnvelope<K, FactValueOf<K>> {
  const definition = FACT_KINDS[input.kind] as FactKindDefinition<K>;
  const fact: FactEnvelope<K, FactValueOf<K>> = {
    kind: input.kind,
    schemaVersion: definition.version,
    id: factId(input),
    provenance: input.provenance,
    layer: input.layer,
    status: input.status ?? 'proposed',
    value: input.value,
  };
  const problems = checkFact(fact);
  const first = problems[0];
  if (first !== undefined) {
    const rest = problems.slice(1).map((problem) => (problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`));
    throw new FactSchemaError(first.path, [first.message, ...rest].join('; '));
  }
  return fact;
}

/** One reason a fact is not one the schema reads, at the path it stands at and, where the fact cites one, at its file and line. */
export interface FactProblem {
  /** The path from the fact's top, like `provenance.source.version`; empty when the refusal is about the fact itself. */
  readonly path: string;
  /** The file the fact cites, when its provenance names one. */
  readonly file?: string;
  /** The line the fact cites, when its provenance names one: the place's first line. */
  readonly line?: number;
  readonly message: string;
}

/** A commit's own form: 40 lower-case hexadecimal digits, as git writes them. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** A field holding a repository path, by the names the schema's values give them. */
const PATH_FIELDS: readonly string[] = ['document', 'file', 'manifest', 'path'];

/** A field holding one of the fill's own tokens (a claim's predicate, a question's type): one lower-case kebab word, never a phrase. */
const TOKEN_FIELDS: readonly string[] = ['predicate', 'type'];

/** The kinds that stand at their own file, with the value's field naming it: a place that names another file is a defect. */
const SELF_PLACE_FIELDS: Readonly<Record<string, string>> = {
  'document': 'path',
  'entry-point': 'file',
  'file': 'path',
  'section': 'document',
  'symbol': 'file',
  'test': 'file',
};

/** One end of an assertion, in the three forms the schema gives it; the refusal's words, or `undefined` when it reads. */
function termProblem(term: unknown): string | undefined {
  if (typeof term !== 'object' || term === null || Array.isArray(term)) {
    return `${shown(term)} is no end of an assertion: a node of the graph, an address outside the repositories, or a literal`;
  }
  const record = term as Record<string, unknown>;
  switch (record['form']) {
    case 'node': {
      const id = record['id'];
      return typeof id === 'string' && FACT_ID_PATTERN.test(id) ? undefined : `${shown(id)} is no fact id: a node's end names a fact of the graph`;
    }
    case 'external': {
      const url = record['url'];
      return typeof url === 'string' && url.trim() !== '' ? undefined : `${shown(url)} is no address: an address outside the repositories names a URL`;
    }
    case 'literal': {
      const text = record['text'];
      return typeof text === 'string' ? undefined : `${shown(text)} is no literal: a literal's end names its text`;
    }
    default:
      return `${shown(record['form'])} is no form: an end of an assertion is a node, an external address or a literal`;
  }
}

/** A value an environment binds a variable to: the text as written, or the digest of the bytes read. */
function bindingProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${shown(value)} is no binding value: a variable is bound to its text or to the digest of the text`;
  }
  const record = value as Record<string, unknown>;
  switch (record['form']) {
    case 'literal':
      return typeof record['text'] === 'string' ? undefined : `${shown(record['text'])} is no text: a literal binding names what the manifest wrote`;
    case 'digest': {
      const sha256 = record['sha256'];
      return typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? undefined : `${shown(sha256)} is no digest: a digest is 64 lower-case hexadecimal digits`;
    }
    default:
      return `${shown(record['form'])} is no form: a binding value is a literal or a digest`;
  }
}

/**
 * Whether a place reads as the schema's own: a repository path and a range of
 * whole lines and offsets that ascend. Returns the refusal's words, or
 * `undefined` when the place reads.
 */
function placeProblem(place: unknown): { path: string; message: string } | undefined {
  if (typeof place !== 'object' || place === null || Array.isArray(place)) {
    return { path: 'provenance.place', message: `a place is an object with a file and a range, not ${shown(place)}` };
  }
  const record = place as Record<string, unknown>;
  const file = record['file'];
  if (typeof file !== 'string') {
    return { path: 'provenance.place.file', message: `a place names its file as a repository path, not ${shown(file)}` };
  }
  const fileProblem = repositoryPathProblem(file.replace(/\\/g, '/').replace(/^\.\//, ''));
  if (fileProblem !== undefined) return { path: 'provenance.place.file', message: fileProblem };
  const range = record['range'];
  if (typeof range !== 'object' || range === null || Array.isArray(range)) {
    return { path: 'provenance.place.range', message: `a place names its range as an object, not ${shown(range)}` };
  }
  const fields = range as Record<string, unknown>;
  const numbers: Record<string, number> = {};
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn']) {
    const value = fields[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { path: `provenance.place.range.${field}`, message: `${shown(value)} is no line or column: a range's ${field} is a whole number` };
    }
    numbers[field] = value;
  }
  const startLine = numbers['startLine'] as number;
  const startColumn = numbers['startColumn'] as number;
  const endLine = numbers['endLine'] as number;
  const endColumn = numbers['endColumn'] as number;
  if (startLine < 1 || endLine < 1) return { path: 'provenance.place.range.startLine', message: 'a range starts at line 1 or later: lines are counted from one' };
  if (startColumn < 0 || endColumn < 0) return { path: 'provenance.place.range.startColumn', message: 'a column is 0 or later: columns are counted from the start of their line' };
  if (endLine < startLine) return { path: 'provenance.place.range.endLine', message: `${endLine} ends the range before line ${startLine} starts it` };
  if (endLine === startLine && endColumn < startColumn) {
    return { path: 'provenance.place.range.endColumn', message: `${endColumn} ends the range before column ${startColumn} starts it` };
  }
  return undefined;
}

/**
 * Reads a fact the schema may have been handed by anything — an agent's
 * write, a stored row, a test's fixture — and names every reason it is not one
 * the schema reads: the envelope's version, the kind, the provenance, the
 * place and the layer over the status.
 *
 * The checks a write needs beyond this one are the write path's, and only it
 * can make them (0026): that the cited bytes exist and are read by madarch at
 * the pinned commit, that the referenced nodes exist, and that the write
 * stands inside the unit's scope. The kind's value is checked as far as this
 * schema can without running the stage: every identity part the kind declares
 * is present, every path is a repository path, every list of names is in code
 * point order without a repeat, and the id is the identity's own digest.
 */
export function checkFact(fact: unknown): FactProblem[] {
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
    return [{ path: '', message: `a fact is an object with kind, schemaVersion, id, provenance, layer, status and value, not ${shown(fact)}` }];
  }
  const record = fact as Record<string, unknown>;
  const problems: FactProblem[] = [];

  // The place's file and line ride on every problem of a fact that cites one,
  // so a refusal about a write names where the write stands.
  const citedPlace = record['provenance'] !== null && typeof record['provenance'] === 'object'
    ? (record['provenance'] as Record<string, unknown>)['place']
    : undefined;
  const citedFile = citedPlace !== null && typeof citedPlace === 'object' && typeof (citedPlace as Record<string, unknown>)['file'] === 'string'
    ? (citedPlace as Record<string, string>)['file']
    : undefined;
  const citedRange = citedPlace !== null && typeof citedPlace === 'object' ? (citedPlace as Record<string, unknown>)['range'] : undefined;
  const citedLine = citedRange !== null && typeof citedRange === 'object' && typeof (citedRange as Record<string, unknown>)['startLine'] === 'number'
    ? (citedRange as Record<string, number>)['startLine']
    : undefined;
  const add = (path: string, message: string): void => {
    problems.push({ path, message, ...(citedFile === undefined ? {} : { file: citedFile }), ...(citedLine === undefined ? {} : { line: citedLine }) });
  };

  const kind = record['kind'];
  if (!isFactKind(kind)) {
    add('kind', `${shown(kind)} is not a fact kind: the schema's kinds are ${FACT_KINDS_IN_ORDER.join(', ')}`);
    return problems;
  }
  const definition = FACT_KINDS[kind] as FactKindDefinition;

  if (record['schemaVersion'] !== definition.version) {
    add('schemaVersion', `${shown(record['schemaVersion'])} is not the version of ${withArticle(kind)} fact: this schema writes version ${definition.version}`);
  }

  const id = record['id'];
  if (typeof id !== 'string' || !FACT_ID_PATTERN.test(id)) {
    add('id', `${shown(id)} is no fact id: an id is the kind, a colon and the SHA-256 digest of the fact's identity`);
  }

  // The layer over the status (0005): how a fact was obtained decides which
  // statuses it may carry, and only a declaration stands accepted.
  const layer = record['layer'];
  const layers: readonly FactLayer[] = ['declared', 'extracted', 'inferred', 'observed'];
  if (typeof layer !== 'string' || !(layers as readonly string[]).includes(layer)) {
    add('layer', `${shown(layer)} is no layer: a fact is declared, extracted, inferred or observed`);
  } else if (!definition.layers.includes(layer as FactLayer)) {
    add('layer', `${withArticle(kind)} fact is ${definition.layers.join(' or ')}, not ${layer}: the stages that write the kind obtain it no other way`);
  }
  const status = record['status'];
  const statuses: readonly FactStatus[] = ['accepted', 'proposed', 'rejected'];
  if (typeof status !== 'string' || !(statuses as readonly string[]).includes(status)) {
    add('status', `${shown(status)} is no status: a fact is proposed, accepted or rejected`);
  } else if (typeof layer === 'string' && (layers as readonly string[]).includes(layer)) {
    const allowed = statusesOfLayer(layer as FactLayer);
    if (!allowed.includes(status as FactStatus)) {
      add('status', `${withArticle(layer)} fact is ${allowed.join(' or ')}, not ${status}: a person's acceptance is a record beside the fact, never a rewrite of it`);
    }
  }

  // The provenance every fact carries.
  const provenance = record['provenance'];
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    add('provenance', `a fact cites its provenance — the source and its version, the repository and commit, and for this kind ${definition.place === 'optional' ? 'a place when it has one' : 'the place it stands on'} — not ${shown(provenance)}`);
  } else {
    const cited = provenance as Record<string, unknown>;
    const source = cited['source'];
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      add('provenance.source', `a fact names the system that read it, not ${shown(source)}`);
    } else {
      const sourceRecord = source as Record<string, unknown>;
      for (const field of ['system', 'version']) {
        const value = sourceRecord[field];
        if (typeof value !== 'string' || value.trim() === '') add(`provenance.source.${field}`, `a fact names its source's ${field}, and ${shown(value)} is empty`);
      }
    }
    const repository = cited['repository'];
    if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) {
      add('provenance.repository', `a fact names the repository it is about, not ${shown(repository)}`);
    } else {
      const repositoryRecord = repository as Record<string, unknown>;
      const repositoryId = repositoryRecord['id'];
      if (typeof repositoryId !== 'string' || !ID_PATTERN.test(repositoryId)) {
        add('provenance.repository.id', `${shown(repositoryId)} is no repository name: the product's own name for the repository, like "orders-api", never a path or a URL`);
      }
      const commit = repositoryRecord['commit'];
      if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
        add('provenance.repository.commit', `${shown(commit)} is no commit: 40 lower-case hexadecimal digits, the commit the fact was read at`);
      }
    }
    if (cited['place'] !== undefined) {
      const problem = placeProblem(cited['place']);
      if (problem !== undefined) add(problem.path, problem.message);
    } else if (definition.place !== 'optional') {
      add('provenance.place', `${withArticle(kind)} fact stands at a place: name the file and the range it was read at`);
    }
  }

  // The value: as far as the schema can read it without running the stage.
  const value = record['value'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add('value', `a fact holds its kind's own value as an object, not ${shown(value)}`);
  } else {
    for (const [field, held] of Object.entries(value as Record<string, unknown>)) {
      if (PATH_FIELDS.includes(field) && typeof held === 'string') {
        const problem = repositoryPathProblem(held.replace(/\\/g, '/').replace(/^\.\//, ''));
        if (problem !== undefined) add(`value.${field}`, problem);
      }
      if (TOKEN_FIELDS.includes(field) && typeof held === 'string' && !FACT_KIND_NAME_PATTERN.test(held)) {
        add(`value.${field}`, `${shown(held)} is no token: the fill writes one lower-case word of letters, digits and dashes, like "is-implemented-by"`);
      }
      if (Array.isArray(held)) {
        if (held.every((entry) => typeof entry === 'string')) {
          for (let index = 1; index < held.length; index += 1) {
            const previous = held[index - 1] as string;
            const current = held[index] as string;
            const order = byCodePoint(previous, current);
            if (order > 0) add(`value.${field}[${index}]`, `${shown(current)} stands after ${shown(previous)}: a list of names is in code point order`);
            else if (order === 0) add(`value.${field}[${index}]`, `${shown(current)} is named twice: a list of names names each once`);
          }
        } else {
          const seen = new Map<string, number>();
          held.forEach((entry, index) => {
            if (typeof entry !== 'object' || entry === null) {
              add(`value.${field}[${index}]`, `a list of a fact holds objects or names, not ${shown(entry)}`);
              return;
            }
            const digest = canonicalJsonDigest(entry);
            const first = seen.get(digest);
            if (first !== undefined) add(`value.${field}[${index}]`, `the record here repeats the one at ${field}[${first}]: a list of records holds each once`);
            else seen.set(digest, index);
          });
        }
      }
    }
    // The ends of an assertion, and a binding's value: the two places where a
    // fact carries a closed form inside its value.
    const terms: readonly string[] = kind === 'claim' ? ['subject', 'object'] : kind === 'document-link' ? ['to'] : [];
    for (const field of terms) {
      const message = termProblem((value as Record<string, unknown>)[field]);
      if (message !== undefined) add(`value.${field}`, message);
    }
    if (kind === 'binds') {
      const message = bindingProblem((value as Record<string, unknown>)['value']);
      if (message !== undefined) add('value.value', message);
    }
    // A kind that stands at its own file: the place names that file, and no other.
    const selfField = SELF_PLACE_FIELDS[kind];
    const ownFile = selfField === undefined ? undefined : (value as Record<string, unknown>)[selfField];
    if (typeof ownFile === 'string' && citedFile !== undefined) {
      const normalized = ownFile.replace(/\\/g, '/').replace(/^\.\//, '');
      // A path the value already failed on is reported there, once: a
      // comparison against a path nobody could read says nothing.
      if (repositoryPathProblem(normalized) === undefined) {
        const placeFile = citedFile.replace(/\\/g, '/').replace(/^\.\//, '');
        if (normalized !== placeFile) add('provenance.place.file', `the place names ${shown(placeFile)} but the ${kind} is ${shown(normalized)}: ${withArticle(kind)} fact stands at its own file`);
      }
    }
  }

  // The id: the identity's own digest. Checked once the rest reads, since an
  // unreadable fact has no identity to digest.
  if (problems.length === 0) {
    try {
      const recomputed = factId({ kind, value: value as FactValueOf<FactKind>, provenance: provenance as FactProvenance });
      if (recomputed !== id) {
        add('id', `${shown(id)} is not the id of this fact: its identity digests to ${shown(recomputed)}, and an id is never written but computed`);
      }
    } catch (error) {
      if (error instanceof FactSchemaError) add(error.path, error.detail);
      else throw error;
    }
  }
  return problems;
}

// ---- the bridge to the product registry's kinds --------------------------

/**
 * How a registry kind is kept in the product (the 0021 amendment, as
 * `src/product/schema.ts` declares it): a markdown document, a task of the
 * tracker, an element of the intended model, a component, or a fact read from
 * another system. A registry kind names one of these; the reference product's
 * kinds are all `document` or `task` today.
 */
export type RegistryStorageForm = 'component' | 'document' | 'fact' | 'model-element' | 'task';

/** The storage forms, in code point order. */
export const REGISTRY_STORAGE_FORMS: readonly RegistryStorageForm[] = ['component', 'document', 'fact', 'model-element', 'task'];

/**
 * The role a code fact plays for a document of a registry kind. Nothing else
 * joins the two vocabularies: a fact kind is never renamed into a registry
 * kind, and a registry kind is never read out of a fact kind's name.
 */
export type FactRegistryRelation =
  /**
   * The fact is where a document of the kind lives: the file, the section. A
   * document kind's own place in the repository, found by stage 1 and 6.
   */
  | 'place'
  /** The fact is what a claim about such a document cites as its evidence: the code or document bytes behind it. */
  | 'evidence'
  /** The fact is a node such a document may be about (a module, a package, an endpoint), and so a claim's subject. */
  | 'subject';

/** One explicit mapping: a fact kind, the registry storage forms whose documents it serves, and the role it plays for them. */
export interface RegistryKindMapping {
  readonly factKind: FactKind;
  readonly registryForms: readonly RegistryStorageForm[];
  readonly relation: FactRegistryRelation;
}

/**
 * The mapping of every fact kind onto the registry's kinds, by storage form
 * and role. It is a table and not a rule: the fill never derives one
 * vocabulary from the other, so a product whose registry names its kinds
 * differently maps the same way.
 */
export const REGISTRY_KIND_MAPPINGS: { readonly [K in FactKind]: RegistryKindMapping } = {
  'snapshot': { factKind: 'snapshot', registryForms: REGISTRY_STORAGE_FORMS, relation: 'evidence' },
  'repository': { factKind: 'repository', registryForms: ['component', 'document', 'fact', 'model-element'], relation: 'subject' },
  'directory': { factKind: 'directory', registryForms: ['component', 'document', 'fact', 'model-element'], relation: 'evidence' },
  'file': { factKind: 'file', registryForms: ['component', 'document', 'fact', 'model-element'], relation: 'place' },
  'package': { factKind: 'package', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'deploy-unit': { factKind: 'deploy-unit', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'api-endpoint': { factKind: 'api-endpoint', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'table': { factKind: 'table', registryForms: ['fact', 'model-element'], relation: 'subject' },
  'column': { factKind: 'column', registryForms: ['fact', 'model-element'], relation: 'subject' },
  'environment-variable': { factKind: 'environment-variable', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'symbol': { factKind: 'symbol', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'occurrence': { factKind: 'occurrence', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'entry-point': { factKind: 'entry-point', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'comment': { factKind: 'comment', registryForms: ['document', 'fact', 'task'], relation: 'evidence' },
  'test': { factKind: 'test', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'module': { factKind: 'module', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'document': { factKind: 'document', registryForms: ['document', 'fact', 'task'], relation: 'place' },
  'section': { factKind: 'section', registryForms: ['document', 'fact', 'task'], relation: 'place' },
  'commit': { factKind: 'commit', registryForms: REGISTRY_STORAGE_FORMS, relation: 'evidence' },
  'claim': { factKind: 'claim', registryForms: REGISTRY_STORAGE_FORMS, relation: 'evidence' },
  'entity-proposal': { factKind: 'entity-proposal', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'rule': { factKind: 'rule', registryForms: ['component', 'document', 'fact', 'model-element'], relation: 'subject' },
  'state': { factKind: 'state', registryForms: ['component', 'fact', 'model-element'], relation: 'subject' },
  'coverage': { factKind: 'coverage', registryForms: REGISTRY_STORAGE_FORMS, relation: 'evidence' },
  'question': { factKind: 'question', registryForms: ['document', 'fact', 'task'], relation: 'subject' },
  'contains': { factKind: 'contains', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'defines': { factKind: 'defines', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'import': { factKind: 'import', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'dependency': { factKind: 'dependency', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'call': { factKind: 'call', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'reference': { factKind: 'reference', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'provides': { factKind: 'provides', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'consumes': { factKind: 'consumes', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'binds': { factKind: 'binds', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'resolves': { factKind: 'resolves', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'document-link': { factKind: 'document-link', registryForms: ['document', 'fact', 'task'], relation: 'evidence' },
  'task-key': { factKind: 'task-key', registryForms: REGISTRY_STORAGE_FORMS, relation: 'evidence' },
  'transition': { factKind: 'transition', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
  'interaction': { factKind: 'interaction', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
};

/**
 * The fact kinds that serve a registry kind kept in the named storage form,
 * in code point order: what the fill may cite behind a document of that kind.
 */
export function factKindsForRegistryForm(form: RegistryStorageForm): readonly FactKind[] {
  return FACT_KINDS_IN_ORDER.filter((kind) => REGISTRY_KIND_MAPPINGS[kind].registryForms.includes(form)).sort(byCodePoint);
}
