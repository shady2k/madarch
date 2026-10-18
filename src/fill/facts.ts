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
import type { StorageForm } from '../product/schema.js';

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
  // A value that is not JSON — a BigInt, a circular record — is still named,
  // not thrown out of: the check reads rows it did not make.
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
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
  if (typeof value !== 'string') throw new FactSchemaError('', `${shown(value)} is no path: a repository path is text`);
  const folded = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const problem = repositoryPathProblem(folded);
  if (problem !== undefined) throw new FactSchemaError('', problem);
  return folded as RepositoryPath;
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

/**
 * Every node kind. A node is one thing the graph holds: a file, a symbol, a
 * module, a claim. The list is grouped by the stages that write it — the
 * deterministic ones, then the agent ones — which is the fill's own order and
 * not the alphabet's; `FACT_KINDS_IN_ORDER` is the one code point order.
 */
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

/**
 * Every edge kind. An edge joins two nodes of any kind the edge's own value
 * names (`EDGE_END_KINDS`). The list is grouped by subject — the edges of the
 * tree, of the code, of 0004's atoms, of documents and history, of the agent
 * stages — and not sorted: `FACT_KINDS_IN_ORDER` is the one code point order.
 */
export const FACT_EDGE_KINDS = [
  // stages 1–7
  'contains',
  'defines',
  'import',
  'dependency',
  'call',
  'reference',
  'inherits',
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

/** Every kind in the schema's one code point order: the node kinds sorted, then the edge kinds sorted. */
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

/**
 * The role a file plays (stages 1 and 3): a file may play several at once,
 * each named once, in code point order. The list is the one declaration of the
 * union: the type is derived from it and `checkFact` reads a value against it,
 * so a role the schema stops knowing is refused rather than digested.
 */
export const FILE_ROLES = ['asset', 'build', 'config', 'document', 'fixture', 'generated', 'migration', 'schema', 'source', 'test', 'vendor'] as const;
export type FileRole = (typeof FILE_ROLES)[number];

/** The form a package node is (stage 2): a package, a build target, or a workspace holding both. */
export const PACKAGE_FORMS = ['build-target', 'package', 'workspace'] as const;
export type PackageForm = (typeof PACKAGE_FORMS)[number];

/** The form a deploy unit is (stage 2). */
export const DEPLOY_FORMS = ['chart', 'container', 'function', 'job', 'service', 'stack'] as const;
export type DeployForm = (typeof DEPLOY_FORMS)[number];

/** What kind of way into the code an entry point is (stage 3). */
export const ENTRY_POINT_FORMS = ['cli-command', 'http-route', 'job', 'library-export', 'main'] as const;
export type EntryPointForm = (typeof ENTRY_POINT_FORMS)[number];

/** How a module or cluster came to be (stage 5): seeded from a package or build target, or a cluster of one. */
export const MODULE_SEEDS = ['build-target', 'cluster', 'package'] as const;
export type ModuleSeed = (typeof MODULE_SEEDS)[number];

/** The shapes a business rule takes (agent stages). */
export const RULE_FORMS = ['constraint', 'invariant', 'policy', 'validation'] as const;
export type RuleForm = (typeof RULE_FORMS)[number];

/** What a dependency edge stands on (stage 2). */
export const DEPENDENCY_BASES = ['build', 'import', 'manifest'] as const;
export type DependencyBasis = (typeof DEPENDENCY_BASES)[number];

/** How one element interacts with another (agent stages). */
export const INTERACTION_FORMS = ['call', 'event', 'http', 'message', 'sql'] as const;
export type InteractionForm = (typeof INTERACTION_FORMS)[number];

/** The form a repository fact is: a code repository, or the product repository itself (0021). */
export const REPOSITORY_FORMS = ['code', 'product'] as const;
export type RepositoryForm = (typeof REPOSITORY_FORMS)[number];

/** The form a comment is written in. */
export const COMMENT_FORMS = ['block', 'doc', 'line'] as const;
export type CommentForm = (typeof COMMENT_FORMS)[number];

/** The form of a proposal: a concept of the domain, or an entity a document of the product may be about. */
export const ENTITY_PROPOSAL_FORMS = ['concept', 'entity'] as const;
export type EntityProposalForm = (typeof ENTITY_PROPOSAL_FORMS)[number];

/** The relation a type inherits another by, as SCIP reports both and RepoDoc keeps them apart. */
export const INHERITS_FORMS = ['extends', 'implements'] as const;
export type InheritsForm = (typeof INHERITS_FORMS)[number];

/**
 * What a name in the code does at its position: SCIP's `SymbolRole` bitset as
 * a list (a position may both define and write), so the roles a reader sees
 * are named instead of numbered.
 */
export const OCCURRENCE_ROLES = ['definition', 'forward-definition', 'generated', 'import', 'read-access', 'test', 'write-access'] as const;
export type OccurrenceRole = (typeof OCCURRENCE_ROLES)[number];

/**
 * A symbol's coarse kind. Stage 4's resolver reports SCIP's fine-grained
 * `Kind` (87 values, most of them one language's); this list is the graph's
 * own, and the resolver folds a finer kind into the closest of these (an
 * `AbstractMethod`, a `StaticMethod` and a `Getter` are all a `method`) while
 * the producer's own name is kept in `SymbolValue.scipKind` so nothing is
 * lost.
 */
export const SYMBOL_KINDS = [
  'class',
  'constant',
  'constructor',
  'enum',
  'enum-member',
  'event',
  'field',
  'function',
  'interface',
  'macro',
  'method',
  'module',
  'namespace',
  'object',
  'operator',
  'other',
  'package',
  'parameter',
  'property',
  'struct',
  'trait',
  'type',
  'type-alias',
  'type-parameter',
  'variable',
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** Why a scope could not be read completely (0004's `coverage`): what a scope's coverage says it could not read. */
export const COVERAGE_GAP_REASONS = ['budget', 'error', 'inaccessible', 'too-large', 'unsupported'] as const;
export type CoverageGapReason = (typeof COVERAGE_GAP_REASONS)[number];

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
  readonly form: RepositoryForm;
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
  /**
   * The git blob the file's bytes stand under at the fact's commit: 40
   * lower-case hexadecimal digits, as git writes them (a symbolic link's blob
   * holds the path it points at). The blob is not part of what the file is —
   * a file whose bytes changed is the same file with the same id — and it is
   * what tells one reading of it from the next: stage 3 and stage 6 read a
   * file again exactly when this moved (0026: a file whose blob id did not
   * change is not re-planned).
   */
  readonly blob?: string;
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
  readonly form: CommentForm;
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

/**
 * Stage 6: a document of the product or of a repository, with the spans of the
 * bytes a reader of the graph shows: the document's whole extent in bytes
 * (`bytes`, so the byte span is `[0, bytes)`) and, in the fact's own place, the
 * lines it stands at. `blob` is the git blob the document's bytes stand under,
 * for the reason `FileValue.blob` gives: stage 6 reads a document again exactly
 * when it moved, and the graph's own last reading is what the comparison reads.
 */
export interface DocumentValue {
  readonly repository: string;
  readonly path: RepositoryPath;
  readonly mediaType: string;
  readonly title?: string;
  /** The document's size in bytes at the fact's commit: the whole of its byte span, `[0, bytes)`. */
  readonly bytes?: number;
  /** The git blob the document's bytes stand under at the fact's commit: 40 lower-case hexadecimal digits. */
  readonly blob?: string;
}

/**
 * Stage 6: a section of a document, by the anchor a reader's link names. The
 * heading tree is these facts: the document they stand in, the heading's depth
 * and their order say which section holds which. The section's line span is the
 * fact's own place (the document's path and the range inside it) and its byte
 * span is `startByte` up to `endByte`.
 */
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
  /** The offset of the section's first byte in the document's bytes. */
  readonly startByte?: number;
  /** The offset just past the section's last byte in the document's bytes; never before `startByte`. */
  readonly endByte?: number;
}

/** Stage 7: one commit of a repository, with what a reader sees of it. */
export interface CommitValue {
  readonly repository: string;
  /** The commit: 40 lower-case hexadecimal digits. */
  readonly commit: string;
  /** The commit's own time — git's committer time — ISO 8601 with `Z`, as git recorded it: a value, never the clock this run read. */
  readonly committedAt: string;
  /**
   * The time the commit was authored, ISO 8601 with `Z`: git keeps the two
   * times apart (a rebase, an amend or a cherry-pick writes a new committer
   * time over an author time that stays), so a reader that means "when this
   * work was written" reads this one.
   */
  readonly authoredAt: string;
  /** The commit's subject line. */
  readonly subject: string;
  /** The name the commit was authored under, as git records it. */
  readonly author?: string;
  /**
   * The commit's parents, in git's own order — the first parent first, a
   * merge's several as it records them — because that order is a fact of the
   * commit (which line of history the merge is on) and is not sorted; empty at
   * a root, and empty too where the parent's own object is not in this
   * checkout, which the read reports as a coverage gap.
   */
  readonly parents: readonly string[];
  /**
   * The paths the commit changed, from the repository's root, in code point
   * order, each once; a merge's are what it changed against its first parent,
   * and a rename is the path it left and the path it took.
   */
  readonly files: readonly RepositoryPath[];
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
  readonly proposed: EntityProposalForm;
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

/**
 * Stage 4: one type extends or implements another. SCIP reports both as its
 * `Relationship.is_implementation` (what "find implementations" follows), and
 * RepoDoc's RepoKG keeps them as two relations; the schema keeps one edge kind
 * with the form that tells them apart, so a reader asks for either.
 */
export interface InheritsEdgeValue {
  /** The symbol that extends or implements, by fact id. */
  readonly from: string;
  /** The symbol it extends or implements, by fact id. */
  readonly to: string;
  readonly form: InheritsForm;
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
  'inherits': InheritsEdgeValue;
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
  /**
   * The layers the kind's stages obtain it in (0005): `extracted` where a
   * deterministic stage of 0026 writes it, `inferred` where an agent stage
   * does, both where the kind has one of each (`module`, `coverage`). A claim
   * also stands `declared`, because a person's own words may be a claim
   * rather than an agent's reading. `statusesOfLayer` decides the statuses
   * over these.
   */
  readonly layers: readonly FactLayer[];
  /** The version of the kind's value shape, as decision 0027's `produces` reads it. */
  readonly version: number;
  /**
   * What the fact is, as the parts its id is the digest of: never a commit,
   * an extractor's version, a layer, a status, a run, a unit, an attempt or a
   * time. Two facts with the same parts are one fact.
   *
   * These are the parts the fact's own value carries, and only those: a kind
   * whose place is identity adds the place's parts through `identityOfKind`,
   * so the check can read the value's parts even when the place does not read.
   */
  readonly identityValue: (value: FactValueOf<K>, provenance: FactProvenance) => readonly IdentityPart[];
  /**
   * The parts of `identityValue` that come from the provenance rather than
   * from the value (a coverage's reader): the check reads them where it reads
   * the provenance, never at a value field.
   */
  readonly provenanceParts?: readonly string[];
}

/** A name as identity sees it: trimmed, inner whitespace collapsed to one space; case and characters kept. */
function identityName(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : value;
}

/**
 * An optional name as identity sees it: a fact that carries none contributes
 * `null` — an absent part, never an empty one — and a name it does carry is
 * read as `identityName` reads it.
 */
function identityNameOrNull(value: unknown): unknown {
  return value === null || value === undefined ? null : identityName(value);
}

/** A range as identity sees it, one string, so the four numbers are read as one part. */
function identityRange(range: FactRange): string {
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const value = range?.[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new FactSchemaError('provenance.place.range', `${shown(value)} is no line or column: a range's ${field} is a whole number`);
    }
  }
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
    ['file', place.file],
    ['range', identityRange(place.range)],
  ];
}

/**
 * Every part of a fact's identity: the parts its value carries, then the
 * place's when the kind's place is identity. `factId` digests exactly this.
 */
function identityOfKind<K extends FactKind>(definition: FactKindDefinition<K>, value: FactValueOf<K>, provenance: FactProvenance): readonly IdentityPart[] {
  const parts = [...definition.identityValue(value, provenance)];
  if (definition.place === 'identity') parts.push(...identityPlace(provenance));
  return parts;
}

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
    identityValue: (value) => [['repository', value.repository], ['commit', value.commit]],
  },
  'repository': {
    kind: 'repository',
    shape: 'node',
    stages: ['0-snapshot'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository]],
  },
  'directory': {
    kind: 'directory',
    shape: 'node',
    stages: ['1-inventory'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['path', value.path]],
  },
  'file': {
    kind: 'file',
    shape: 'node',
    stages: ['1-inventory'],
    place: 'required',
    layers: ['extracted'],
    // 1: the file's path, roles and language. 2: the blob its bytes stand
    // under at the commit (its own move, per FACTS_SCHEMA_VERSION above).
    version: 2,
    identityValue: (value) => [['repository', value.repository], ['path', value.path]],
  },
  'package': {
    kind: 'package',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['form', value.form], ['name', identityName(value.name)]],
  },
  'deploy-unit': {
    kind: 'deploy-unit',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['form', value.form], ['name', identityName(value.name)]],
  },
  'api-endpoint': {
    kind: 'api-endpoint',
    shape: 'node',
    stages: ['2-build-and-configuration', '4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['contract', identityName(value.contract)]],
  },
  'table': {
    kind: 'table',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['name', identityName(value.name)]],
  },
  'column': {
    kind: 'column',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['table', identityName(value.table)], ['name', identityName(value.name)]],
  },
  'environment-variable': {
    kind: 'environment-variable',
    shape: 'node',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['name', identityName(value.name)]],
  },
  'symbol': {
    kind: 'symbol',
    shape: 'node',
    stages: ['3-syntax', '4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [
      ['repository', value.repository],
      ['file', value.file],
      ['qualifiedName', identityName(value.qualifiedName)],
      ['symbolKind', value.symbolKind],
      ['disambiguator', identityNameOrNull(value.disambiguator)],
    ],
  },
  'occurrence': {
    kind: 'occurrence',
    shape: 'node',
    stages: ['3-syntax', '4-resolution'],
    place: 'identity',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value, provenance) => [['symbol', value.symbol]],
  },
  'entry-point': {
    kind: 'entry-point',
    shape: 'node',
    stages: ['3-syntax'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [
      ['repository', value.repository],
      ['file', value.file],
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
    identityValue: () => [],
  },
  'test': {
    kind: 'test',
    shape: 'node',
    stages: ['3-syntax'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['file', value.file], ['name', identityName(value.name)]],
  },
  'module': {
    kind: 'module',
    shape: 'node',
    stages: ['5-modules', '9-boundaries'],
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['parent', value.parent ?? null], ['name', identityName(value.name)]],
  },
  'document': {
    kind: 'document',
    shape: 'node',
    stages: ['6-documents'],
    place: 'required',
    layers: ['extracted'],
    // 1: the path, the media type and the title. 2: the byte count and the blob
    // the bytes stand under (its own move, per FACTS_SCHEMA_VERSION above).
    version: 2,
    identityValue: (value) => [['repository', value.repository], ['path', value.path]],
  },
  'section': {
    kind: 'section',
    shape: 'node',
    stages: ['6-documents'],
    place: 'required',
    layers: ['extracted'],
    // 1: the document, the anchor, the heading and its depth. 2: the byte span
    // the section covers (its own move, per FACTS_SCHEMA_VERSION above).
    version: 2,
    identityValue: (value) => [['repository', value.repository], ['document', value.document], ['anchor', identityName(value.anchor)]],
  },
  'commit': {
    kind: 'commit',
    shape: 'node',
    stages: ['7-history'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['commit', value.commit]],
  },

  // ---- agent stages: what an agent read and proposed ----------------------
  // `declared` here is the product's own words written as a claim, which a
  // person accepts as it stands; an agent's reading of the same kind is
  // `inferred` and stays proposed until a person accepts it (0005). A declared
  // claim is the one fact no stage of this registry writes: it is a person's
  // words, recorded by the acceptance path, and it is the sole exception to
  // "a kind's layers are the layers its stages obtain it in".
  'claim': {
    kind: 'claim',
    shape: 'node',
    stages: ['8-overview', '10-intent-documents', '11-intent-history', '12-understanding', '13-recovery'],
    place: 'identity',
    layers: ['declared', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value, provenance) => [['subject', value.subject], ['predicate', value.predicate], ['object', value.object]],
  },
  'entity-proposal': {
    kind: 'entity-proposal',
    shape: 'node',
    stages: ['12-understanding', '13-recovery'],
    place: 'optional',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['proposed', value.proposed], ['name', identityName(value.name)]],
  },
  'rule': {
    kind: 'rule',
    shape: 'node',
    stages: ['11-intent-history', '12-understanding'],
    place: 'identity',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value, provenance) => [['subject', value.subject ?? null], ['statement', identityName(value.statement)]],
  },
  'state': {
    kind: 'state',
    shape: 'node',
    stages: ['12-understanding'],
    place: 'required',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['machine', identityName(value.machine)], ['name', identityName(value.name)]],
  },
  'coverage': {
    kind: 'coverage',
    shape: 'node',
    stages: FACT_STAGES,
    place: 'optional',
    layers: ['extracted', 'inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value, provenance) => [['repository', value.repository], ['scope', value.scope], ['reader', identityName(provenance.source.system)]],
    provenanceParts: ['reader'],
  },
  'question': {
    kind: 'question',
    shape: 'node',
    stages: AGENT_STAGES,
    place: 'optional',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['repository', value.repository], ['type', value.type], ['about', value.about ?? null], ['prompt', identityName(value.prompt)]],
  },

  // ---- edges -------------------------------------------------------------
  'contains': {
    kind: 'contains',
    shape: 'edge',
    stages: ['1-inventory', '5-modules', '6-documents'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'defines': {
    kind: 'defines',
    shape: 'edge',
    stages: ['3-syntax', '4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'import': {
    kind: 'import',
    shape: 'edge',
    // A file imports a file or a package at stages 3 and 4; the rollup onto the
    // module that holds them is stage 5's, so the kind is written there too.
    stages: ['3-syntax', '4-resolution', '5-modules'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'dependency': {
    kind: 'dependency',
    shape: 'edge',
    // A manifest's dependency is stage 2's; a dependency between the modules
    // stage 5 clusters is that stage's, so the kind names both.
    stages: ['2-build-and-configuration', '5-modules'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to], ['basis', value.basis]],
  },
  'call': {
    kind: 'call',
    shape: 'edge',
    stages: ['4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'reference': {
    kind: 'reference',
    shape: 'edge',
    stages: ['4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'inherits': {
    kind: 'inherits',
    shape: 'edge',
    stages: ['4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to], ['form', value.form]],
  },
  'provides': {
    kind: 'provides',
    shape: 'edge',
    // The providing end may be a package or deploy unit (stage 2) or the module
    // stage 5 clusters: a stage writes only what exists by then (0027).
    stages: ['2-build-and-configuration', '5-modules'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['contract', identityName(value.contract)]],
  },
  'consumes': {
    kind: 'consumes',
    shape: 'edge',
    // A manifest consumes a variable at stage 2; the symbol that reads it in
    // code is stage 4's, so the kind names both.
    stages: ['2-build-and-configuration', '4-resolution'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['variable', value.variable]],
  },
  'binds': {
    kind: 'binds',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['variable', value.variable], ['environment', identityName(value.environment)]],
  },
  'resolves': {
    kind: 'resolves',
    shape: 'edge',
    stages: ['2-build-and-configuration'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'document-link': {
    kind: 'document-link',
    shape: 'edge',
    stages: ['6-documents'],
    place: 'required',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to]],
  },
  'task-key': {
    kind: 'task-key',
    shape: 'edge',
    // Stage 7 reads the keys a commit message names and stage 6 the keys a
    // document names. The kind is one and the key is written as the tracker
    // writes it; the two readers differ in what they read a marker from — a
    // commit message's `Task:` line is a key list and nothing else, while a
    // document's line carries the sentence the marker stands in — so each
    // stage's own rule says which tokens of its text are keys (see
    // `src/fill/stages/history.ts` and `src/fill/stages/document-index.ts`).
    stages: ['6-documents', '7-history'],
    place: 'optional',
    layers: ['extracted'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['key', value.key]],
  },
  'transition': {
    kind: 'transition',
    shape: 'edge',
    stages: ['12-understanding'],
    place: 'required',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value) => [['from', value.from], ['to', value.to], ['event', identityName(value.event)]],
  },
  'interaction': {
    kind: 'interaction',
    shape: 'edge',
    stages: ['12-understanding', '13-recovery'],
    place: 'identity',
    layers: ['inferred'],
    version: FACTS_SCHEMA_VERSION,
    identityValue: (value, provenance) => [['caller', value.caller], ['callee', value.callee], ['form', value.form], ['via', identityNameOrNull(value.via)]],
  },
};

/**
 * The kinds each edge kind's ends may name: a `dependency` joins packages or
 * modules, an `interaction` joins symbols and deploy units. A write's
 * "referenced nodes exist" check reads this table (0026), and a stage can
 * write an edge only once both its ends exist, so every stage a kind names is
 * at or after the first stage that writes each of its ends (`to: 'term'` is an
 * end that is no node of the graph — an address, a literal, a name).
 */
export const EDGE_END_KINDS: { readonly [K in FactEdgeKind]: { readonly from: readonly FactKind[]; readonly to: readonly FactKind[] | 'term' } } = {
  'contains': { from: ['directory', 'module', 'repository'], to: ['directory', 'file', 'symbol'] },
  'defines': { from: ['file'], to: ['symbol'] },
  'import': { from: ['file'], to: ['file', 'module', 'package'] },
  'dependency': { from: ['module', 'package'], to: ['module', 'package'] },
  'call': { from: ['symbol'], to: ['symbol'] },
  'reference': { from: ['symbol'], to: ['symbol'] },
  'inherits': { from: ['symbol'], to: ['symbol'] },
  'provides': { from: ['deploy-unit', 'module', 'package'], to: ['api-endpoint'] },
  'consumes': { from: ['file', 'package', 'symbol'], to: ['environment-variable'] },
  'binds': { from: ['environment-variable'], to: 'term' },
  'resolves': { from: ['api-endpoint'], to: ['deploy-unit'] },
  'document-link': { from: ['document', 'section'], to: 'term' },
  // A task key stands in a commit message or in a document (stage 7 and stage 6).
  'task-key': { from: ['commit', 'document', 'section'], to: 'term' },
  'transition': { from: ['state'], to: ['state'] },
  'interaction': { from: ['deploy-unit', 'symbol'], to: ['deploy-unit', 'symbol'] },
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
 * that is missing, named twice or not of the form its kind gives it, and a
 * place that is not a repository path: an id is never computed from what a
 * machine happens to be reading, nor from a part the graph cannot join. The
 * forms are `IDENTITY_PART_FORMS`, the same table `checkFact` reads, so a part
 * is refused by one declaration in both places.
 */
export function factId<K extends FactKind>(fact: {
  readonly kind: K;
  readonly value: FactValueOf<K>;
  readonly provenance: FactProvenance;
}): string {
  const definition = FACT_KINDS[fact.kind] as FactKindDefinition<K>;
  const parts = identityOfKind(definition, fact.value, fact.provenance);
  const identity: Record<string, unknown> = {};
  for (const [field, part] of parts) {
    if (Object.hasOwn(identity, field)) {
      throw new FactSchemaError('value', `the identity of ${withArticle(fact.kind)} fact names "${field}" twice: each part of an identity is named once`);
    }
    if (part === undefined) {
      throw new FactSchemaError(`value.${field}`, `the ${fact.kind} fact has no value for the identity field "${field}": an id is its identity's digest, so every part is required`);
    }
    if (typeof part === 'string' && part.trim() === '') {
      throw new FactSchemaError(`value.${field}`, `the ${fact.kind} fact has an empty "${field}": an empty part names a node nothing can join or show`);
    }
    if (field === '') throw new FactSchemaError('value', `the identity of ${withArticle(fact.kind)} fact names an unnamed part: each part carries the field it is`);
    const formProblem = IDENTITY_PART_FORMS[`${fact.kind}.${field}`]?.(part);
    if (formProblem !== undefined) throw new FactSchemaError(`value.${field}`, formProblem);
    identity[field] = part;
  }
  let digest: string;
  try {
    digest = canonicalJsonDigest({ kind: fact.kind, identity });
  } catch (error) {
    // A part that is not JSON — an `undefined` inside a record, a circular
    // value — has no digest: it is refused at the fact's value, never thrown
    // out of.
    throw new FactSchemaError('value', `the identity of ${withArticle(fact.kind)} fact is not JSON, so it has no digest: ${(error as Error).message}`);
  }
  return `${fact.kind}:${digest}`;
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
// ---- what a fact is read against -----------------------------------------

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

/** A repository path as an identity part reads it: relative, `/`-separated, with no `.` or `..` leg. */
function repositoryPathPart(part: unknown): string | undefined {
  if (typeof part !== 'string') return `${shown(part)} is no path: a repository path is text`;
  return repositoryPathProblem(part.replace(/\\/g, '/').replace(/^\.\//, ''));
}

/** A commit's own form: 40 lower-case hexadecimal digits, as git writes them. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The keys a fact's envelope holds, and no others: a run's own fields — an id,
 * a unit, an attempt, a generation, a session — never ride on a fact (0026:
 * "ids are stable and never contain a run id"), so a row carrying one is
 * refused at the key rather than stored whole.
 */
const ENVELOPE_FIELDS: readonly string[] = ['id', 'kind', 'layer', 'provenance', 'schemaVersion', 'status', 'value'];

/** A field holding a repository path, by the names the schema's values give them. */
const PATH_FIELDS: readonly string[] = ['document', 'file', 'manifest', 'path'];

/** A field holding one of the fill's own tokens (a claim's predicate, a question's type): one lower-case kebab word, never a phrase. */
const TOKEN_FIELDS: readonly string[] = ['predicate', 'type'];

/** A fact id, as an identity part names one; the refusal's words, or `undefined` when it reads. */
function factIdPart(part: unknown): string | undefined {
  return typeof part === 'string' && FACT_ID_PATTERN.test(part)
    ? undefined
    : `${shown(part)} is no fact id: this part of an identity names another fact of the graph, by the id its own identity digests to`;
}

/** A name of the fill's own: one lower-case word of letters, digits and dashes. */
function tokenPart(part: unknown): string | undefined {
  return typeof part === 'string' && FACT_KIND_NAME_PATTERN.test(part)
    ? undefined
    : `${shown(part)} is no token: the fill writes one lower-case word of letters, digits and dashes, like "is-implemented-by"`;
}

/** Text an identity joins on: a string with something in it. */
function textPart(part: unknown): string | undefined {
  return typeof part === 'string' && part.trim() !== '' ? undefined : `${shown(part)} is no text: this part of an identity is text a reader can see`;
}

/** One of a closed list of forms, as a value or an identity part reads; the refusal's words, or `undefined` when it reads. */
function partIn(values: readonly string[], what: string): (part: unknown) => string | undefined {
  return (part) =>
    typeof part === 'string' && (values as readonly string[]).includes(part)
      ? undefined
      : `${shown(part)} is no ${what}: this reads as one of ${values.join(', ')}`;
}

/** An absent part, which is `null` and no defect, or a part that reads by the given form. */
function orAbsent(form: (part: unknown) => string | undefined): (part: unknown) => string | undefined {
  return (part) => (part === null || part === undefined ? undefined : form(part));
}

/** A repository, by the product's own name for it. */
function repositoryNamePart(part: unknown): string | undefined {
  return typeof part === 'string' && ID_PATTERN.test(part)
    ? undefined
    : `${shown(part)} is no repository name: the product's own name for the repository, like "orders-api", never a path or a URL`;
}

/** The commit a fact is about, as git writes it. */
function commitPart(part: unknown): string | undefined {
  return typeof part === 'string' && COMMIT_PATTERN.test(part)
    ? undefined
    : `${shown(part)} is no commit: 40 lower-case hexadecimal digits, the commit the fact is about`;
}

/** The kinds whose value names the repository it is about, which is identity for each of them. */
const REPOSITORY_NAMED_KINDS: readonly string[] = [
  'snapshot', 'repository', 'directory', 'file', 'package', 'deploy-unit', 'table', 'column', 'symbol',
  'entry-point', 'test', 'module', 'document', 'section', 'commit', 'entity-proposal', 'state', 'coverage', 'question',
];

/**
 * The identity parts that name another fact, required: an edge's ends, the
 * symbol an occurrence names, the caller and callee of an interaction. A
 * `document-link`'s end and a claim's subject and object are ends of an
 * assertion instead, read by `termProblem`.
 */
const FACT_ID_PARTS: readonly string[] = [
  'contains.from', 'contains.to', 'defines.from', 'defines.to', 'import.from', 'import.to',
  'dependency.from', 'dependency.to', 'call.from', 'call.to', 'reference.from', 'reference.to',
  'inherits.from', 'inherits.to', 'provides.from', 'consumes.from', 'consumes.variable',
  'binds.variable', 'resolves.from', 'resolves.to', 'task-key.from', 'transition.from',
  'transition.to', 'interaction.caller', 'interaction.callee', 'occurrence.symbol', 'document-link.from',
];

/** The identity parts that name another fact when the fact carries one, and are `null` when it carries none. */
const ABSENT_FACT_ID_PARTS: readonly string[] = ['module.parent', 'rule.subject'];

/** An end of an assertion, as an identity part reads it: a node, an address outside the repositories, or a literal. */
function termPart(part: unknown): string | undefined {
  return termProblem(part);
}

/**
 * The form an identity part is read as, by the kind and the field's own name,
 * so an identity is a digest of parts the graph can join: a repository is a
 * product's name for it and never a machine path, a commit is a commit, an
 * end of an edge is a fact id, a name of the fill's own is one token, and a
 * part the kind closes to a list of forms is one of them. A field this table
 * does not name is text, and the place's own parts are read with the place.
 */
const IDENTITY_PART_FORMS: Readonly<Record<string, (part: unknown) => string | undefined>> = {
  ...Object.fromEntries(REPOSITORY_NAMED_KINDS.map((kind) => [`${kind}.repository`, repositoryNamePart])),
  ...Object.fromEntries(['snapshot', 'commit'].map((kind) => [`${kind}.commit`, commitPart])),
  ...Object.fromEntries(FACT_ID_PARTS.map((part) => [part, factIdPart])),
  ...Object.fromEntries(ABSENT_FACT_ID_PARTS.map((part) => [part, orAbsent(factIdPart)])),
  // The parts a kind's value names a file or a folder by: a repository path,
  // never the machine's.
  ...Object.fromEntries([
    'directory.path', 'document.path', 'entry-point.file', 'file.path', 'section.document', 'symbol.file', 'test.file',
  ].map((part) => [part, repositoryPathPart])),
  'claim.object': termPart,
  'claim.subject': termPart,
  'claim.predicate': tokenPart,
  'document-link.to': termPart,
  'question.type': tokenPart,
  'environment-variable.name': textPart,
  'symbol.qualifiedName': textPart,
  'symbol.disambiguator': orAbsent(textPart),
  // An interaction names the carrier it goes through only when the agent saw one: the part is `null`
  // when it names none (madarch-tzte.20.4 — the write path could not write an interaction at all while
  // this form was missing, since the absent part read as text and was refused).
  'interaction.via': orAbsent(textPart),
  'section.anchor': textPart,
  'task-key.key': textPart,
  'coverage.scope': textPart,
  'question.about': orAbsent(textPart),
  // The parts whose kind closes them to a list of forms: a value outside the
  // list names nothing the graph can join, so it is refused before any id is
  // computed from it.
  'package.form': partIn(PACKAGE_FORMS, 'form a package node is'),
  'deploy-unit.form': partIn(DEPLOY_FORMS, 'form a deploy unit is'),
  'symbol.symbolKind': partIn(SYMBOL_KINDS, 'kind of symbol'),
  'entry-point.form': partIn(ENTRY_POINT_FORMS, 'kind of entry point'),
  'entity-proposal.proposed': partIn(ENTITY_PROPOSAL_FORMS, 'form of a proposal'),
  'dependency.basis': partIn(DEPENDENCY_BASES, 'basis a dependency stands on'),
  'inherits.form': partIn(INHERITS_FORMS, 'form of inheritance'),
  'interaction.form': partIn(INTERACTION_FORMS, 'form of interaction'),
};

/**
 * The closed unions a value carries outside its identity, by the kind and the
 * field's own name: a value (or a list of values) the schema names, so a role,
 * a form or a reason a reader does not know is refused rather than published.
 */
const CLOSED_VALUE_FORMS: Readonly<Record<string, { readonly values: readonly string[]; readonly what: string; readonly many: boolean; readonly atLeastOne?: boolean }>> = {
  'comment.form': { values: COMMENT_FORMS, what: 'form a comment is written in', many: false },
  'file.roles': { values: FILE_ROLES, what: 'role a file plays', many: true, atLeastOne: true },
  'module.seed': { values: MODULE_SEEDS, what: 'seed a module came from', many: false },
  'occurrence.roles': { values: OCCURRENCE_ROLES, what: 'role a name plays at its position', many: true, atLeastOne: true },
  'repository.form': { values: REPOSITORY_FORMS, what: 'form a repository is', many: false },
  'rule.form': { values: RULE_FORMS, what: 'form a business rule takes', many: false },
};

const GAP_FIELDS: readonly string[] = ['reason', 'what'];

/**
 * The lists of records whose documented order and uniqueness are read by one
 * field of each record, by the kind and the field's own name, with the closed
 * forms the records themselves carry: a coverage's gaps are in code point
 * order of `what`, each `what` once, so two readers' gaps add up to a set
 * rather than to a repeat (0004's `coverage`), and each gap's reason is one
 * the schema names.
 */
const RECORD_LIST_FIELDS: Readonly<Record<string, { readonly key: string; readonly fields: readonly string[]; readonly closed: Readonly<Record<string, { readonly values: readonly string[]; readonly what: string }>> }>> = {
  'coverage.unread': { key: 'what', fields: GAP_FIELDS, closed: { reason: { values: COVERAGE_GAP_REASONS, what: 'reason a gap was left' } } },
};

/**
 * The fields each kind's value holds, and no others: the value's own reader
 * writes these, so a key this table does not name — a run id, a unit, an
 * attempt, a misspelling — is refused at the key rather than stored whole.
 */
const VALUE_FIELDS: { readonly [K in FactKind]: readonly (keyof FactValueOf<K> & string)[] } = {
  'snapshot': ['repository', 'commit', 'tree', 'fileCount', 'byteCount'],
  'repository': ['repository', 'form', 'defaultBranch'],
  'directory': ['repository', 'path'],
  'file': ['repository', 'path', 'roles', 'language', 'bytes', 'blob'],
  'package': ['repository', 'name', 'form', 'ecosystem', 'version', 'manifest'],
  'deploy-unit': ['repository', 'name', 'form', 'manifest'],
  'api-endpoint': ['contract', 'framework'],
  'table': ['repository', 'name', 'engine'],
  'column': ['repository', 'table', 'name', 'dataType'],
  'environment-variable': ['name'],
  'symbol': ['repository', 'file', 'qualifiedName', 'symbolKind', 'disambiguator', 'scipKind', 'displayName', 'signature'],
  'occurrence': ['symbol', 'roles'],
  'entry-point': ['repository', 'file', 'name', 'form'],
  'comment': ['text', 'form'],
  'test': ['repository', 'file', 'name', 'framework', 'covers'],
  'module': ['repository', 'name', 'parent', 'seed', 'members', 'importance'],
  'document': ['repository', 'path', 'mediaType', 'title', 'bytes', 'blob'],
  'section': ['repository', 'document', 'anchor', 'heading', 'level', 'startByte', 'endByte'],
  'commit': ['repository', 'commit', 'committedAt', 'authoredAt', 'subject', 'author', 'parents', 'files'],
  'claim': ['subject', 'predicate', 'object', 'text', 'confidence'],
  'entity-proposal': ['repository', 'proposed', 'name', 'summary', 'aliases'],
  'rule': ['statement', 'subject', 'form'],
  'state': ['repository', 'machine', 'name', 'initial', 'final'],
  'coverage': ['repository', 'scope', 'complete', 'read', 'unread'],
  'question': ['repository', 'type', 'about', 'prompt'],
  'contains': ['from', 'to'],
  'defines': ['from', 'to'],
  'import': ['from', 'to', 'specifier'],
  'dependency': ['from', 'to', 'basis'],
  'call': ['from', 'to', 'count'],
  'reference': ['from', 'to', 'count'],
  'inherits': ['from', 'to', 'form'],
  'provides': ['from', 'contract'],
  'consumes': ['from', 'variable'],
  'binds': ['variable', 'environment', 'value'],
  'resolves': ['from', 'to'],
  'document-link': ['from', 'to'],
  'task-key': ['from', 'key'],
  'transition': ['from', 'to', 'event'],
  'interaction': ['caller', 'callee', 'form', 'via'],
};

/** The keys each record shape holds, and no others: an unnamed key is refused wherever a record stands. */
const PROVENANCE_FIELDS: readonly string[] = ['place', 'repository', 'source'];
const SOURCE_FIELDS: readonly string[] = ['system', 'version'];
const REPOSITORY_FIELDS: readonly string[] = ['commit', 'id'];
const PLACE_FIELDS: readonly string[] = ['file', 'range'];
const RANGE_FIELDS: readonly string[] = ['endColumn', 'endLine', 'startColumn', 'startLine'];
const TERM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  external: ['form', 'url'],
  literal: ['form', 'text'],
  node: ['form', 'id'],
};
const BINDING_FIELDS: Readonly<Record<string, readonly string[]>> = {
  digest: ['form', 'sha256'],
  literal: ['form', 'text'],
};

/**
 * The fields a kind's value holds as a list of names, and no other shape: a
 * list the shape names is refused when it is not a list at all, rather than
 * skipped (a coverage whose `read` is one string is not a coverage).
 */
const NAME_LIST_FIELDS: readonly string[] = ['commit.files', 'coverage.read', 'entity-proposal.aliases', 'test.covers'];

/**
 * The fields a kind's value holds as a list of names in the order its reader
 * read them, not sorted: a commit's parents are git's own order, the first
 * parent first, and that order carries which line of history a merge continues.
 * A repeat is a defect there like anywhere else; the order is the reader's.
 */
const OWN_ORDER_LIST_FIELDS: readonly string[] = ['commit.parents'];

/**
 * The fields a kind's value holds as a list of parts the schema itself gives a
 * form to, by the kind and the field's own name: every entry of such a list is
 * read by the part's own checker — the same one its identity's parts are read
 * with — so a commit's changed paths are repository paths and its parents are
 * commits, and a list can never carry a machine's path or a name the graph
 * cannot join.
 */
const PART_LIST_FIELDS: Readonly<Record<string, (entry: unknown) => string | undefined>> = {
  'commit.files': repositoryPathPart,
  'commit.parents': commitPart,
};

/** Every key of a record its shape does not name, in code point order. */
function unknownKeys(record: Record<string, unknown>, fields: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !fields.includes(key)).sort(byCodePoint);
}

/** One reason a record holds a key its shape does not name, or `undefined` when it holds none. */
function unknownKeyProblem(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  const unknown = unknownKeys(record, fields);
  return unknown.length === 0 ? undefined : `${unknown.map((key) => shown(key)).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} no part of this record: it holds ${fields.join(', ')}, and a run, a unit, an attempt or a session is none of them`;
}

/** The kinds that stand at their own file, with the value's field naming it: a place that names another file is a defect. */
const SELF_PLACE_FIELDS: Readonly<Record<string, string>> = {
  'deploy-unit': 'manifest',
  'document': 'path',
  'entry-point': 'file',
  'file': 'path',
  'package': 'manifest',
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
 * Every reason a place is not one the schema reads: not an object, a file that
 * is no repository path, a range whose parts are not whole numbers, and a
 * range that does not ascend. Each reason is reported at its own field, and a
 * field that did not read takes no part in a comparison that would compare it.
 */
function placeProblemsOf(place: unknown): FactProblem[] {
  if (typeof place !== 'object' || place === null || Array.isArray(place)) {
    return [{ path: 'provenance.place', message: `a place is an object with a file and a range, not ${shown(place)}` }];
  }
  const problems: FactProblem[] = [];
  const record = place as Record<string, unknown>;
  const unknownPlace = unknownKeyProblem(record, PLACE_FIELDS);
  if (unknownPlace !== undefined) problems.push({ path: 'provenance.place', message: unknownPlace });
  const file = record['file'];
  if (typeof file !== 'string') {
    problems.push({ path: 'provenance.place.file', message: `a place names its file as a repository path, not ${shown(file)}` });
  } else {
    const fileProblem = repositoryPathProblem(file.replace(/\\/g, '/').replace(/^\.\//, ''));
    if (fileProblem !== undefined) problems.push({ path: 'provenance.place.file', message: fileProblem });
  }
  const range = record['range'];
  if (typeof range !== 'object' || range === null || Array.isArray(range)) {
    problems.push({ path: 'provenance.place.range', message: `a place names its range as an object, not ${shown(range)}` });
    return problems;
  }
  const fields = range as Record<string, unknown>;
  const unknownRange = unknownKeyProblem(fields, RANGE_FIELDS);
  if (unknownRange !== undefined) problems.push({ path: 'provenance.place.range', message: unknownRange });
  const numbers: Partial<Record<'startLine' | 'startColumn' | 'endLine' | 'endColumn', number>> = {};
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const value = fields[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      problems.push({ path: `provenance.place.range.${field}`, message: `${shown(value)} is no line or column: a range's ${field} is a whole number` });
    } else {
      numbers[field] = value;
    }
  }
  const startLine = numbers.startLine;
  const startColumn = numbers.startColumn;
  const endLine = numbers.endLine;
  const endColumn = numbers.endColumn;
  if (startLine !== undefined && startLine < 1) {
    problems.push({ path: 'provenance.place.range.startLine', message: `${startLine} starts the range before line 1: lines are counted from one` });
  }
  if (startColumn !== undefined && startColumn < 0) {
    problems.push({ path: 'provenance.place.range.startColumn', message: `${startColumn} starts the range before the line's first character: columns are counted from zero` });
  }
  if (endLine !== undefined && endLine < 1) {
    problems.push({ path: 'provenance.place.range.endLine', message: `${endLine} ends the range before line 1: lines are counted from one` });
  }
  if (endColumn !== undefined && endColumn < 0) {
    problems.push({ path: 'provenance.place.range.endColumn', message: `${endColumn} ends the range before the line's first character: columns are counted from zero` });
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    problems.push({ path: 'provenance.place.range.endLine', message: `${endLine} ends the range before line ${startLine} starts it` });
  }
  if (startLine !== undefined && startColumn !== undefined && endLine !== undefined && endColumn !== undefined && endLine === startLine && endColumn < startColumn) {
    problems.push({ path: 'provenance.place.range.endColumn', message: `${endColumn} ends the range before column ${startColumn} starts it` });
  }
  return problems;
}

/**
 * Reads a fact the schema may have been handed by anything — an agent's
 * write, a stored row, a test's fixture — and names every reason it is not one
 * the schema reads: the envelope's own keys, its version, the kind, the id,
 * the provenance, the place, the layer over the status, the value's own
 * fields, every path, every closed form, every list's order and repeats, the
 * two places a fact carries a closed form inside its value (an assertion's
 * ends and a binding's value), every identity part the kind declares with the
 * form it reads as, and finally the id against the identity's own digest.
 *
 * Every reason is reported: a fact with four defects gives four problems, each
 * at its own path and, where the fact cites a place, with that place's file
 * and line. Only the digest comparison waits for the identity's parts to read,
 * since an id computed from a part the check already refused would say
 * nothing.
 *
 * The checks a write needs beyond this one are the write path's, and only it
 * can make them (0026): that the cited bytes exist and are read by madarch at
 * the pinned commit, that the referenced nodes exist, and that the write
 * stands inside the unit's scope. A value field this schema does not read —
 * a comment's text, a symbol's signature — is refused when it is not a field
 * of the kind's value, and its own type is the write path's, which has it.
 */
export function checkFact(fact: unknown): FactProblem[] {
  if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
    return [{ path: '', message: `a fact is an object with kind, schemaVersion, id, provenance, layer, status and value, not ${shown(fact)}` }];
  }
  const record = fact as Record<string, unknown>;
  const problems: FactProblem[] = [];
  const reported = new Set<string>();

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
    const seen = `${path}\u0000${message}`;
    if (reported.has(seen)) return;
    reported.add(seen);
    problems.push({ path, message, ...(citedFile === undefined ? {} : { file: citedFile }), ...(citedLine === undefined ? {} : { line: citedLine }) });
  };

  // The envelope holds its own keys and no others: a run, a unit, an attempt or
  // a session never rides on a fact (0026).
  for (const field of Object.keys(record).sort(byCodePoint)) {
    if (!ENVELOPE_FIELDS.includes(field)) {
      add(field, `${shown(field)} is no part of a fact: a fact is ${ENVELOPE_FIELDS.join(', ')}, and a run, a unit, an attempt or a session is the orchestrator's, never the fact's`);
    }
  }

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
  const idReads = typeof id === 'string' && FACT_ID_PATTERN.test(id);
  if (!idReads) {
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

  // The provenance every fact carries, and the place the kind asks of it.
  const provenance = record['provenance'];
  let sourceIsRead = false;
  let repositoryIsRead = false;
  let citedRepositoryId: string | undefined;
  let citedCommit: string | undefined;
  let provenanceReads = false;
  let placeReads = false;
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    add('provenance', `a fact cites its provenance — the source and its version, the repository and commit, and for this kind ${definition.place === 'optional' ? 'a place when it has one' : 'the place it stands on'} — not ${shown(provenance)}`);
  } else {
    const cited = provenance as Record<string, unknown>;
    const unknownProvenance = unknownKeyProblem(cited, PROVENANCE_FIELDS);
    if (unknownProvenance !== undefined) add('provenance', unknownProvenance);
    const source = cited['source'];
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      add('provenance.source', `a fact names the system that read it, not ${shown(source)}`);
    } else {
      const sourceRecord = source as Record<string, unknown>;
      const unknownSource = unknownKeyProblem(sourceRecord, SOURCE_FIELDS);
      if (unknownSource !== undefined) add('provenance.source', unknownSource);
      let sourceReads = true;
      for (const field of ['system', 'version']) {
        const value = sourceRecord[field];
        if (typeof value !== 'string' || value.trim() === '') {
          sourceReads = false;
          add(`provenance.source.${field}`, `a fact names its source's ${field}, and ${shown(value)} is empty`);
        }
      }
      sourceIsRead = sourceReads;
    }
    const repository = cited['repository'];
    if (typeof repository !== 'object' || repository === null || Array.isArray(repository)) {
      add('provenance.repository', `a fact names the repository it is about, not ${shown(repository)}`);
    } else {
      const repositoryRecord = repository as Record<string, unknown>;
      const unknownRepository = unknownKeyProblem(repositoryRecord, REPOSITORY_FIELDS);
      if (unknownRepository !== undefined) add('provenance.repository', unknownRepository);
      let repositoryReads = true;
      const repositoryId = repositoryRecord['id'];
      if (typeof repositoryId === 'string' && ID_PATTERN.test(repositoryId)) citedRepositoryId = repositoryId;
      if (typeof repositoryId !== 'string' || !ID_PATTERN.test(repositoryId)) {
        repositoryReads = false;
        add('provenance.repository.id', `${shown(repositoryId)} is no repository name: the product's own name for the repository, like "orders-api", never a path or a URL`);
      }
      const commit = repositoryRecord['commit'];
      if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
        repositoryReads = false;
        add('provenance.repository.commit', `${shown(commit)} is no commit: 40 lower-case hexadecimal digits, the commit the fact was read at`);
      } else {
        citedCommit = commit;
      }
      repositoryIsRead = repositoryReads;
    }
    provenanceReads = sourceIsRead && repositoryIsRead;
    if (cited['place'] !== undefined) {
      const placeProblems = placeProblemsOf(cited['place']);
      for (const problem of placeProblems) add(problem.path, problem.message);
      placeReads = placeProblems.length === 0;
    } else if (definition.place !== 'optional') {
      add('provenance.place', `${withArticle(kind)} fact stands at a place: name the file and the range it was read at`);
    } else {
      placeReads = true;
    }
  }

  // The value: its own fields, every path, every closed form, every list's
  // order and repeats, and the two closed forms a fact carries inside it.
  const value = record['value'];
  let valueReads = false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    add('value', `a fact holds its kind's own value as an object, not ${shown(value)}`);
  } else {
    valueReads = true;
    const valueRecord = value as Record<string, unknown>;
    const fields = VALUE_FIELDS[kind] as readonly string[];
    for (const field of Object.keys(valueRecord).sort(byCodePoint)) {
      if (!fields.includes(field)) {
        add(`value.${field}`, `${shown(field)} is no field of ${withArticle(kind)} fact: its value holds ${fields.join(', ')}, and a run, a unit, an attempt or a session is none of them`);
      }
    }
    for (const [field, held] of Object.entries(valueRecord)) {
      if (PATH_FIELDS.includes(field) && typeof held === 'string') {
        const problem = repositoryPathProblem(held.replace(/\\/g, '/').replace(/^\.\//, ''));
        if (problem !== undefined) add(`value.${field}`, problem);
      }
      if (TOKEN_FIELDS.includes(field) && typeof held === 'string' && !FACT_KIND_NAME_PATTERN.test(held)) {
        add(`value.${field}`, `${shown(held)} is no token: the fill writes one lower-case word of letters, digits and dashes, like "is-implemented-by"`);
      }
      const closed = CLOSED_VALUE_FORMS[`${kind}.${field}`];
      const recordKey = RECORD_LIST_FIELDS[`${kind}.${field}`];
      if (closed !== undefined && !closed.many) {
        // One value the kind closes to a list of forms: a list where one belongs
        // is a defect, and so is a value outside the list.
        if (Array.isArray(held)) {
          add(`value.${field}`, `${shown(held)} is one ${closed.what}, not a list of them`);
        } else {
          const message = partIn(closed.values, closed.what)(held);
          if (message !== undefined) add(`value.${field}`, message);
        }
        continue;
      }
      // The shape decides the branch, never the content: a name list is read as
      // names even when one entry is not one, and a list of records as records.
      const nameList = closed?.many === true || NAME_LIST_FIELDS.includes(`${kind}.${field}`) || OWN_ORDER_LIST_FIELDS.includes(`${kind}.${field}`);
      // A list in its reader's own order (a commit's parents) is kept as read,
      // so only a repeat is a defect there; every other list of names is sorted.
      const ownOrder = OWN_ORDER_LIST_FIELDS.includes(`${kind}.${field}`);
      if (nameList) {
        if (!Array.isArray(held)) {
          add(`value.${field}`, `${shown(held)} is no list of names: this field holds the names the fact carries, ${ownOrder ? 'in the order the reader read them' : 'in code point order'}, each once`);
          continue;
        }
        if (closed?.atLeastOne === true && held.length === 0) {
          add(`value.${field}`, `a list of ${closed.what}s holds at least one: a fact that names none leaves the field out`);
        }
        // The names this list has already read, so a repeat is found wherever it
        // stands in an own-order list, not only beside its twin.
        const seenNames = new Map<string, number>();
        for (let index = 0; index < held.length; index += 1) {
          const current = held[index];
          if (typeof current !== 'string') {
            add(`value.${field}[${index}]`, `${shown(current)} is no name: this list holds names`);
            continue;
          }
          const partProblem = PART_LIST_FIELDS[`${kind}.${field}`]?.(current);
          if (partProblem !== undefined) add(`value.${field}[${index}]`, partProblem);
          if (closed !== undefined) {
            const message = partIn(closed.values, closed.what)(current);
            if (message !== undefined) add(`value.${field}[${index}]`, message);
          }
          if (ownOrder) {
            // A list in its reader's own order may repeat nowhere, and a repeat
            // there is found by name rather than by neighbouring entries: two
            // equal names have no order between them to stand next to each
            // other by.
            const first = seenNames.get(current);
            if (first !== undefined) add(`value.${field}[${index}]`, `${shown(current)} is named twice (first at value.${field}[${first}]): a list of names names each once`);
            else seenNames.set(current, index);
            continue;
          }
          const previous = index === 0 ? undefined : held[index - 1];
          if (typeof previous !== 'string') continue;
          const order = byCodePoint(previous, current);
          if (order > 0) add(`value.${field}[${index}]`, `${shown(current)} stands after ${shown(previous)}: a list of names is in code point order`);
          else if (order === 0) add(`value.${field}[${index}]`, `${shown(current)} is named twice: a list of names names each once`);
        }
        continue;
      }
      if (!Array.isArray(held)) {
        if (recordKey !== undefined) add(`value.${field}`, `${shown(held)} is no list of records: this field holds the records the fact carries`);
        continue;
      }
      const seenKeys = new Map<string, number>();
      held.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          add(`value.${field}[${index}]`, `a record of this list is an object, not ${shown(entry)}`);
          return;
        }
        const recordFields = entry as Record<string, unknown>;
        try {
          canonicalJsonDigest(entry);
        } catch (error) {
          add(`value.${field}[${index}]`, `the record here is no JSON: ${(error as Error).message}`);
          return;
        }
        if (recordKey !== undefined) {
          const unknownRecord = unknownKeyProblem(recordFields, recordKey.fields);
          if (unknownRecord !== undefined) add(`value.${field}[${index}]`, unknownRecord);
          for (const [closedField, closed] of Object.entries(recordKey.closed)) {
            const message = partIn(closed.values, closed.what)(recordFields[closedField]);
            if (message !== undefined) add(`value.${field}[${index}].${closedField}`, message);
          }
          const key = recordFields[recordKey.key];
          if (typeof key !== 'string') {
            add(`value.${field}[${index}].${recordKey.key}`, `${shown(key)} is no ${recordKey.key}: each record of this list names one, and the list is ordered by it`);
            return;
          }
          const previous = index === 0 ? undefined : (held[index - 1] as Record<string, unknown> | null)?.[recordKey.key];
          const previousKey = typeof previous === 'string' ? previous : undefined;
          const order = previousKey === undefined ? 0 : byCodePoint(previousKey, key);
          if (order > 0) add(`value.${field}[${index}].${recordKey.key}`, `${shown(key)} stands after ${shown(previousKey)}: this list is in code point order of ${recordKey.key}`);
          const first = seenKeys.get(key);
          if (first !== undefined) add(`value.${field}[${index}].${recordKey.key}`, `${shown(key)} is named twice (first at ${field}[${first}]): a record of this list is named once`);
          else seenKeys.set(key, index);
          return;
        }
        const digest = canonicalJsonDigest(entry);
        const first = seenKeys.get(digest);
        if (first !== undefined) add(`value.${field}[${index}]`, `the record here repeats the one at ${field}[${first}]: a list of records holds each once`);
        else seenKeys.set(digest, index);
      });
    }
    // The ends of an assertion, and a binding's value: the two places where a
    // fact carries a closed form inside its value.
    const terms: readonly string[] = kind === 'claim' ? ['subject', 'object'] : kind === 'document-link' ? ['to'] : [];
    for (const field of terms) {
      const term = (value as Record<string, unknown>)[field];
      const message = termProblem(term);
      if (message !== undefined) add(`value.${field}`, message);
      if (typeof term === 'object' && term !== null && !Array.isArray(term)) {
        const record = term as Record<string, unknown>;
        const shape = TERM_FIELDS[String(record['form'])];
        if (shape !== undefined) {
          const unknown = unknownKeyProblem(record, shape);
          if (unknown !== undefined) add(`value.${field}`, unknown);
        }
      }
    }
    if (kind === 'binds') {
      const binding = (value as Record<string, unknown>)['value'];
      const message = bindingProblem(binding);
      if (message !== undefined) add('value.value', message);
      if (typeof binding === 'object' && binding !== null && !Array.isArray(binding)) {
        const record = binding as Record<string, unknown>;
        const shape = BINDING_FIELDS[String(record['form'])];
        if (shape !== undefined) {
          const unknown = unknownKeyProblem(record, shape);
          if (unknown !== undefined) add('value.value', unknown);
        }
      }
    }
    // A fact names one repository and one commit, in its value and in its
    // provenance: a file read from one repository is never filed under another.
    const namedRepository = (value as Record<string, unknown>)['repository'];
    if (typeof namedRepository === 'string' && ID_PATTERN.test(namedRepository) && citedRepositoryId !== undefined && namedRepository !== citedRepositoryId) {
      add('value.repository', `the value names ${shown(namedRepository)} but the fact was read from ${shown(citedRepositoryId)}: one fact is one repository`);
    }
    const namedCommit = (value as Record<string, unknown>)['commit'];
    if ((kind === 'commit' || kind === 'snapshot') && typeof namedCommit === 'string' && COMMIT_PATTERN.test(namedCommit) && citedCommit !== undefined && namedCommit !== citedCommit) {
      add('value.commit', `the value names commit ${shown(namedCommit)} but the fact was read at ${shown(citedCommit)}: ${withArticle(kind)} fact is one commit`);
    }
    // A kind that stands at its own file: the place names that file, and no other.
    const selfField = SELF_PLACE_FIELDS[kind];
    const ownFile = selfField === undefined ? undefined : (value as Record<string, unknown>)[selfField];
    if (typeof ownFile === 'string' && citedFile !== undefined) {
      const normalized = ownFile.replace(/\\/g, '/').replace(/^\.\//, '');
      const placeFile = citedFile.replace(/\\/g, '/').replace(/^\.\//, '');
      // A path that did not read is reported where it stands, once: a comparison
      // against a path nobody could read says nothing.
      if (repositoryPathProblem(normalized) === undefined && repositoryPathProblem(placeFile) === undefined && normalized !== placeFile) {
        add('provenance.place.file', `the place names ${shown(placeFile)} but the ${kind} is ${shown(normalized)}: ${withArticle(kind)} fact stands at its own file`);
      }
    }
  }

  // The identity's parts and the id they give. The value's own parts are read
  // whenever the value read, so a part the graph cannot join is named beside
  // every other reason — a provenance that did not read costs the provenance's
  // reasons and never a value's. The digest is compared only once every part
  // read: an id computed from a refused part, or from a provenance this check
  // refused, says nothing.
  if (valueReads) {
    const readProvenance: FactProvenance = provenanceReads
      ? (provenance as FactProvenance)
      : { source: { system: '', version: '' }, repository: { id: '', commit: '' } };
    let partsRead = true;
    for (const [field, part] of definition.identityValue(value as FactValueOf<FactKind>, readProvenance)) {
      if (definition.provenanceParts?.includes(field) === true) continue;
      // A part the table does not name is text — a name, a statement, a key —
      // which is what every part that is not a path, a fact id, a token, a
      // commit or one of the kind's closed forms is.
      const message = (IDENTITY_PART_FORMS[`${kind}.${field}`] ?? textPart)(part);
      if (message !== undefined) {
        partsRead = false;
        add(`value.${field}`, message);
      }
    }
    // The digest waits only for the provenance records the identity itself
    // reads: the place's for a kind whose place is identity, the source's for a
    // kind whose reader is part of it, and nothing else — a commit or a source
    // version a fact was read at is no part of what the fact is.
    const identityProvenanceReads = (definition.place === 'identity' ? repositoryIsRead && placeReads : true)
      && (definition.provenanceParts === undefined ? true : sourceIsRead);
    if (partsRead && identityProvenanceReads && idReads) {
      let recomputed: string | undefined;
      try {
        recomputed = factId({ kind, value: value as FactValueOf<FactKind>, provenance: provenance as FactProvenance });
      } catch (error) {
        if (!(error instanceof FactSchemaError)) throw error;
        add(error.path, error.detail);
      }
      if (recomputed !== undefined && recomputed !== id) {
        add('id', `${shown(id)} is not the id of this fact: its identity digests to ${shown(recomputed)}, and an id is never written but computed`);
      }
    }
  }
  return problems;
}

// ---- the bridge to the product registry's kinds --------------------------

/**
 * How a registry kind is kept in the product: the 0021 amendment's storage
 * forms, and the product schema's own `StorageForm` — the one declaration of
 * them, imported rather than restated, so a form this engine adds reaches the
 * mapping instead of leaving it behind.
 */
export type RegistryStorageForm = StorageForm;

/** The storage forms, in code point order; `test/fill-facts.test.ts` checks the list against the schema's union. */
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
  'inherits': { factKind: 'inherits', registryForms: ['component', 'fact', 'model-element'], relation: 'evidence' },
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
