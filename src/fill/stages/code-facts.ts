/**
 * The code facts of one file, as a stage (decision 0033, items 5, 14 and 15;
 * madarch-8bdc.2.4): one unit per source file, the file's own bytes, the
 * grammar the syntax stage already loads, and the facts the readings of code
 * publish from — its expressions with their literal values, the bindings a
 * declaration makes, its call sites and its Go struct fields.
 *
 * **Why these facts and no others.** The extract driver hands one in-memory
 * object (`CodeFacts`) to the operations, contracts and data-model readings;
 * a static stage may not hold one (decision 0033, item 5). What those readings
 * ask of it, by reader, is what this stage publishes:
 *
 * - expressions, by the file and by id, with the syntax kind, the child and
 *   field links, the operator, the name of an identifier, the receiver, member
 *   and callee of a member or call expression, and the literal's raw text and
 *   decoded value: `operations/env.ts` (a configuration value read from the
 *   code), `operations/metrics.ts` (a metric's name and labels),
 *   `operations/route-facts.ts` (a route's verb, path and handler),
 *   `operations/symbol-sites.ts` (a callable's body and its calls),
 *   `operations/observability.ts` (a logger's construction),
 *   `contracts/ts-code.ts` and `contracts/go-code.ts` (a listener's port, a
 *   client's URL, a topic's name), `data-model/access.ts` (a SQL string and
 *   the call that holds it);
 * - bindings, by id and by initializer: the value a name holds
 *   (`operations/code-facts.ts`'s evaluation, `data-model/extract.ts`'s
 *   storage evidence, `contracts/outbox.ts`'s topic constant);
 * - call sites, by their call expression: `operations/metrics.ts`,
 *   `operations/observability.ts`, `data-model/go-calls.ts`'s roll-up;
 * - fields: `operations/route-facts.ts`'s Go struct proof and
 *   `data-model/go-calls.ts`'s receiver types;
 * - literals, as the decoded value of a string, number, boolean or null
 *   expression (in Go, an interpreted or raw string literal, an int or float,
 *   nil): every value the three readings publish is one of these, read at one
 *   place in one file.
 *
 * Nothing else is published: no symbols, no imports, no mentions and no
 * occurrences — the syntax and resolution stages publish those, and this stage
 * reads none of them.
 *
 * **Two facts the operations and contracts readings link by.** The same unit
 * publishes the unit the file belongs to (`code.service-unit`, from the nearest
 * `go.mod` or `package.json` above its folder, read one path at a time) and the
 * ports its code listens on (`code.listener-port`, by the one rule
 * `portsByService` is built with). An operation's `service` is then a read by
 * property of the file it stands in, and a contract server's service a read by
 * property of the port it names (madarch-8bdc.2.4's step 1). The manifest chain
 * the membership stands on is pinned in the file's coverage, and the product's
 * wiring names it among the unit's inputs: a manifest that moved re-reads every
 * file whose unit it declares, although the files' own blobs did not move.
 *
 * **The unit reads one file's code and no other's.** The bytes come from the
 * static context (one file below the size cap), the tree is walked inside the
 * unit and deleted with it, and every id is derived from the place the fact
 * stands at
 * (repository, path, byte span, syntax kind), so two runs of one commit write
 * the same ids. The facts are nodes whose `file` property names the file; a
 * binding, a call, the unit and its ports also hang from the file's node with
 * `code.declares`, so a reader can walk them. An expression is linked to its
 * children by their ids in its own `children` and `fields`, not by edges: a file
 * of a few hundred expressions would otherwise cost thousands of edges for a
 * tree one node already describes.
 *
 * **What a unit publishes when it cannot read.** A path the commit no longer
 * holds publishes nothing, and the publication retracts what the unit wrote. A
 * file above the static cap, bytes that are not UTF-8 and a tree the parser
 * could not read whole are named in the file's coverage — a gap, never a
 * silence, and never a file read as if it were what it is not.
 *
 * **A refill writes nothing.** The plan compares each source file's blob with
 * this stage's own coverage; a file it already read at the blob the pinned
 * commit holds is not planned again.
 */
import { Type } from 'typebox';
import { byCodePoint } from '../../model/order.js';
import { FACT_KINDS, makeNodeFact, type CoverageGap, type CoverageValue, type FactSource } from '../facts.js';
import type { SnapshotSource } from '../snapshot.js';
import {
  DEFAULT_STAGE_DEFAULTS,
  type FillStage, type StageContext, type StageDraftSet, type StageDraftWrite, type StageExecutionResult,
  type StageGraphReader, type StagePlan, type StageUnit,
} from '../stage.js';
import { evidenceAtPlace, refuseRow, rowRecord, unknownKeys } from './draft.js';
import { rolesFor } from './inventory.js';
import { readFileFindings, readSyntaxTree, spanFactory, syntaxLanguageOf, type ExtractedFileSyntax, type SyntaxLanguage } from './syntax-extract.js';
import { fileSymbolsOf } from './code-symbols.js';
import { listeningPortsOfTree } from './listening-ports.js';
import { folderOf, manifestChainOf, serviceMembershipOf, type ManifestEntry, type ManifestLookup, type ServiceMembership, type ServiceMembershipRead } from './service-membership.js';
import type { StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf, importCandidates } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const CODE_FACTS_STAGE_ID = 'code-facts';

/** The stage's own version, bumped when what it writes or plans changes. */
const CODE_FACTS_STAGE_VERSION = 5;

/** The fact kinds the stage produces, in code point order. */
const CODE_FACTS_STAGE_KINDS: readonly string[] = ['binding', 'callable', 'callsite', 'coverage', 'declares', 'export', 'expression', 'field', 'listener-port', 'service-unit'];

/** The node kinds the stage writes, in the extractors' vocabulary (decision 0033, item 7). */
const EXPRESSION_KIND = 'code.expression';
const BINDING_KIND = 'code.binding';
const CALL_KIND = 'code.call';
const FIELD_KIND = 'code.field';
const EXPORT_KIND = 'code.export';
/** The unit the file belongs to, and the ports its code listens on (madarch-8bdc.2.4's two facts). */
const SERVICE_UNIT_KIND = 'code.service-unit';
const LISTENER_PORT_KIND = 'code.listener-port';

/** The relation a file's bindings and calls hang from it by; the resolution stage reads `code.contains` as symbols. */
const DECLARES_RELATION = 'code.declares';

/** The reader every fact of this stage cites. */
const CODE_FACTS_SOURCE: FactSource = { system: 'madarch-code-facts', version: '1' };

/** The most bytes one file's facts may hold; the context's own cap, named here so a gap says what it was. */
const FILE_BYTE_LIMIT = 1_048_576;

/** Where one fact stands in a file: the bytes a reader slices and the lines it counts, 1-based. */
interface SourceSpan {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** The read the plan makes of what this stage published, by the file. */
export const CODE_FACTS_PUBLISHED_READ = 'stage-code-facts-published';

/** The read of one repository's published code facts: one row per file this stage read. */
function publishedFactsRead(repository: string): string {
  return JSON.stringify({ read: CODE_FACTS_PUBLISHED_READ, repository });
}

/** One row of that read: one file this stage read, at the blob its bytes stood under. */
export interface PublishedCodeFactsRow {
  readonly kind: 'coverage';
  readonly file: string;
  readonly blob: string;
  /** The manifests the reading stood on, nearest first; absent where an earlier version wrote the row. */
  readonly unitChain?: readonly string[];
}

/** The keys a row of that read holds, and no others. */
const FACTS_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind', 'unitChain'];

/** The stage, built over the source that holds the run's pins. */
export function createCodeFactsStage(sources: SnapshotSource): FillStage {
  return {
    id: CODE_FACTS_STAGE_ID,
    version: CODE_FACTS_STAGE_VERSION,
    staticReading: true,
    // The file nodes stage 0 published are what a binding and a call hang from and what the
    // plan compares blobs against: a graph without them starves this stage by name.
    consumes: { required: [{ capability: 'file', scope: 'repository', freshness: 'current' }], optional: [] },
    produces: [
      { kind: 'binding', schemaVersion: 1, scope: 'file' },
      { kind: 'callable', schemaVersion: 1, scope: 'file' },
      { kind: 'callsite', schemaVersion: 1, scope: 'file' },
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'export', schemaVersion: 1, scope: 'file' },
      { kind: 'expression', schemaVersion: 1, scope: 'file' },
      { kind: 'field', schemaVersion: 1, scope: 'file' },
      { kind: 'listener-port', schemaVersion: 1, scope: 'file' },
      { kind: 'service-unit', schemaVersion: 1, scope: 'file' },
    ],
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: async (graph: StageGraphReader): Promise<StagePlan> => planCodeFacts(sources, graph),
    execute: async (unit: StageUnit, context: StageContext): Promise<StageExecutionResult> => executeCodeFactsUnit(unit, context),
    validate: (draft: StageDraftSet) => checkStaticGraphDraft(CODE_FACTS_STAGE_ID, CODE_FACTS_STAGE_KINDS, draft),
  };
}

// ---- planning ------------------------------------------------------------

/**
 * The units one run fills, in code point order of the unit ids: a unit per
 * source file this stage's own coverage does not name at the blob the pinned
 * commit holds, and one per published file the commit no longer holds, whose
 * unit publishes nothing and so retracts what an earlier run wrote there.
 */
async function planCodeFacts(sources: SnapshotSource, graph: StageGraphReader): Promise<StagePlan> {
  const pins = await sources.pins();
  const units: { id: string; scope: string }[] = [];
  let anySource = false;
  let blocked = false;
  for (const pin of pins) {
    const reader = await sources.open(pin.id);
    const treeRead = publishedTreeRead(pin.id);
    const tree = publishedTreeRows(await graph.query(treeRead), pin.id, treeRead);
    const factsRead = publishedFactsRead(pin.id);
    const own = publishedFactsRows(await graph.query(factsRead), pin.id, factsRead);
    const readState = new Map(own.map((row) => [row.file, row]));
    const mine = reader.files().filter((entry) => isFactPath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    // The manifest chain above a folder, read once per folder: the plan is the run's own reading
    // of the tree, and a manifest that moved moves every file under it (the unit's own walk is
    // path-scoped; this one answers the same chain from the same pinned tree).
    const chains = new Map<string, Promise<readonly string[]>>();
    const lookup = async (path: string): Promise<ManifestEntry | undefined> => {
      const entry = reader.entry(path);
      return entry === undefined || entry.form === 'commit' ? undefined : { path, blob: entry.id };
    };
    const chainAt = (folder: string): Promise<readonly string[]> => {
      const held = chains.get(folder);
      if (held !== undefined) return held;
      const made = manifestChainOf(folder, lookup);
      chains.set(folder, made);
      return made;
    };
    for (const entry of mine) {
      const held = readState.get(entry.path);
      const chain = await chainAt(folderOf(entry.path));
      if (held !== undefined && held.blob === entry.id && sameChain(held.unitChain, chain)) continue;
      if (!tree.files.has(entry.path)) {
        blocked = true;
        continue;
      }
      units.push({ id: fileUnitId(pin.id, entry.path), scope: `${pin.id}:${entry.path}` });
    }
    for (const row of own) {
      if (present.has(row.file)) continue;
      units.push({ id: fileUnitId(pin.id, row.file), scope: `${pin.id}:${row.file}` });
    }
  }
  if (blocked) return { units: [], coverage: 'nothing-found' };
  units.sort((left, right) => byCodePoint(left.id, right.id));
  return { units, coverage: anySource ? 'planned' : 'nothing-found' };
}

/** Whether a path is a file this stage reads: source the inventory read as code, in a grammar the syntax stage loads. */
function isFactPath(path: string): boolean {
  return rolesFor(path).includes('source') && (path.endsWith('.go') || /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path));
}

/** Whether two manifest chains are one reading: the same manifests at the same blobs, in the same order. */
function sameChain(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

// ---- the facts of one file ------------------------------------------------

/** One literal value as a fact holds it: the grammar's own token and the value it decodes to. */
interface LiteralFact {
  readonly kind: 'string' | 'number' | 'boolean' | 'null';
  readonly raw: string;
  readonly value?: string | number | boolean | null;
}

/** One expression the walk read: the place it stands at and everything a reader asks of it. */
interface ExpressionFact {
  readonly id: string;
  readonly syntaxKind: string;
  readonly span: SourceSpan;
  readonly parent?: string;
  readonly children: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly operator?: string;
  readonly name?: string;
  readonly receiver?: string;
  readonly member?: string;
  readonly callee?: string;
  readonly arguments?: readonly string[];
  readonly literal?: LiteralFact;
}

/** One binding a declaration makes, and — for an import — the name it binds to which file. */
interface BindingFact {
  readonly id: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver' | 'type';
  readonly span: SourceSpan;
  readonly scope: SourceSpan;
  readonly initializer?: string;
  /** The import fact an import binding names, which is the binding it stands at. */
  readonly importId?: string;
  /** An import's specifier as written (`./logging/logger.js`, `pino`). */
  readonly specifier?: string;
  /** The form the import binds by, and the name it imports under that form. */
  readonly form?: 'default' | 'namespace' | 'named';
  readonly importedName?: string;
  /** The file of this repository the specifier answers, where one does. */
  readonly targetPath?: string;
  /** The declaration a binding is made in, from its statement's first byte to its initializer's last. */
  readonly declarationSpan?: SourceSpan;
}

/** One call site: the invocation and the callee and arguments it names. */
interface CallFact {
  readonly id: string;
  readonly expression: string;
  readonly span: SourceSpan;
  /** The invocation's own prefix: from the call's first byte to the argument list's opening bracket. */
  readonly invocationSpan?: SourceSpan;
  readonly callee?: string;
  readonly arguments: readonly string[];
  readonly construct: boolean;
}

/** One Go struct field: the name it is declared under and the type it holds. */
interface FieldFact {
  readonly id: string;
  readonly name: string;
  readonly ownerTypeName: string;
  readonly span: SourceSpan;
  readonly typeExpression?: string;
}

/** One name a file exports, and the binding the file declares it under. */
interface ExportFact {
  readonly id: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly localBinding?: string;
}

/** The body one declaration node holds, by the node's own byte span: where the code of a callable begins and what it is. */
interface BodyFact {
  readonly startByte: number;
  readonly endByte: number;
  readonly bodyStartByte: number;
  readonly bodyEndByte: number;
  readonly bodyStartLine: number;
  readonly bodyEndLine: number;
  readonly bodySyntaxKind: string;
}

/** Everything one file's walk read. */
interface FileFacts {
  readonly expressions: readonly ExpressionFact[];
  readonly bindings: readonly BindingFact[];
  readonly calls: readonly CallFact[];
  readonly fields: readonly FieldFact[];
  readonly exports: readonly ExportFact[];
  /** The body of every node that holds one, by the node's own span: what a callable's body stands over. */
  readonly bodies: readonly BodyFact[];
}

/** The node types whose text is the name a reader sees, by the grammar's own spelling. */
const NAME_KINDS: ReadonlySet<string> = new Set(['field_identifier', 'identifier', 'package_identifier', 'property_identifier', 'type_identifier']);

/** The node types that hold a literal, by the two grammars' spellings, and the kind of value each holds. */
const LITERAL_KINDS: ReadonlyMap<string, LiteralFact['kind']> = new Map([
  ['false', 'boolean'], ['float_literal', 'number'], ['imaginary_literal', 'number'], ['int_literal', 'number'],
  ['nil', 'null'], ['null', 'null'], ['number', 'number'], ['raw_string_literal', 'string'],
  ['interpreted_string_literal', 'string'], ['rune_literal', 'string'], ['string', 'string'],
  ['template_string', 'string'], ['true', 'boolean'], ['undefined', 'null'],
]);

/** The statements that hold a declaration of a name: where a binding's declaration stands. */
const DECLARATION_STATEMENTS: ReadonlySet<string> = new Set([
  'const_declaration', 'lexical_declaration', 'var_declaration', 'variable_declaration',
]);

/** The node types that declare a name in TypeScript and JavaScript. */
const TS_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['variable_declarator']);

/** The node types that declare a name in Go. */
const GO_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['const_spec', 'short_var_declaration', 'var_spec']);

/** The grammar's callable nodes, by both spellings: the nodes whose `body` field is a callable's body. */
const CALLABLE_NODES: ReadonlySet<string> = new Set([
  'arrow_function', 'func_literal', 'function', 'function_declaration', 'function_expression', 'generator_function',
  'generator_function_declaration', 'method_declaration', 'method_definition',
]);

/** The node types that declare a parameter, by both grammars' spellings. */
const PARAMETER_KINDS: ReadonlySet<string> = new Set(['optional_parameter', 'parameter_declaration', 'required_parameter', 'variadic_parameter_declaration']);

/** One unit: the source file the unit names, read at the pinned commit, and the facts its bytes hold. */
async function executeCodeFactsUnit(unit: StageUnit, context: StageContext): Promise<StageExecutionResult> {
  refuseWhenCancelled(unit, context);
  const planned = plannedUnit(unit.id);
  const stage = staticSourceOf(unit, context);
  const source = stage.repository;
  const entry = await source.entry(planned.path);
  if (entry === undefined) {
    context.progress(`${planned.path} is not in the tree of ${planned.repository} at ${source.commit}: this unit publishes nothing, and what an earlier run wrote there is retracted`, 1);
    return { outcome: 'draft' };
  }
  const file = await source.file(planned.path);
  if (file === undefined || file.unread !== undefined) {
    const reason = file === undefined ? 'inaccessible' : file.unread === 'too-large' ? 'too-large' : 'unsupported';
    const coverage: CoverageValue = {
      repository: planned.repository,
      scope: planned.path,
      complete: false,
      read: [],
      unread: [{ what: `${planned.path} at ${String(CODE_FACTS_SOURCE.system)} ${CODE_FACTS_SOURCE.version}`, reason }],
    };
    writeCoverage(context, source, planned.path, coverage, entry.id, await manifestChainAt(source, planned.path));
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? `above the static reading cap of ${String(FILE_BYTE_LIMIT)} bytes` : 'not a source text this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  refuseWhenCancelled(unit, context);
  const bytes = file.content!;
  const gaps: CoverageGap[] = [];
  let facts: FileFacts = { expressions: [], bindings: [], calls: [], fields: [], bodies: [], exports: [] };
  let ports: readonly string[] = [];
  let findings: ExtractedFileSyntax | undefined;
  let callables: readonly CallableFact[] = [];
  let parsed = false;
  try {
    const read = await readSyntaxTree(planned.path, bytes, (tree) => {
      const held = collectFileFacts(planned.repository, planned.path, tree.text, tree.root, tree.language);
      // The syntax pass's own findings give the file's declarations and the callables it proves
      // by span; the symbols the extract readings name are made from them by the driver's own
      // reader, so a static stage and the driver name one declaration by one key.
      const findings = readFileFindings(tree);
      try {
        return { facts: held, ports: listeningPortsOfTree(planned.path, tree.root, tree.language), findings };
      } catch (error) {
        // A ports reading that fails costs the file's ports and not its facts: the gap names the file.
        return { facts: held, ports: [] as readonly string[], portsGap: gapWhatOf(error, planned.path), findings };
      }
    });
    if (!read.read) {
      gaps.push({ what: `${planned.path} at ${String(CODE_FACTS_SOURCE.system)} ${CODE_FACTS_SOURCE.version}`, reason: read.unread[0]?.reason ?? 'error' });
    } else {
      facts = read.value.facts;
      ports = read.value.ports;
      findings = read.value.findings;
      parsed = true;
      if ('portsGap' in read.value && read.value.portsGap !== undefined) gaps.push({ what: read.value.portsGap, reason: 'error' });
      if (read.complete === false) gaps.push({ what: `${planned.path} is read with syntax errors`, reason: 'error' });
    }
  } catch (error) {
    gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
  }
  // The unit the file belongs to, read from the manifests above its folder one path at a time:
  // the walk names a gap where a manifest's declaration could not be read.
  let membership: ServiceMembershipRead = { chain: [], gaps: [] };
  try {
    membership = await serviceMembershipOf(planned.path, manifestLookup(source));
  } catch (error) {
    gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
  }
  for (const gap of membership.gaps) gaps.push({ what: gap, reason: 'unsupported' });
  if (findings !== undefined) {
    try {
      callables = await callablesOfFile(planned.path, bytes, findings, facts.bodies);
    } catch (error) {
      gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
    }
  }
  // An import's specifier is tied to the file it answers through a path-scoped lookup of the
  // pinned tree, one candidate at a time: no list of the repository's files is read for it.
  if (facts.bindings.some((binding) => binding.kind === 'import' && binding.targetPath === undefined)) {
    const resolved: BindingFact[] = [];
    for (const binding of facts.bindings) {
      if (binding.kind !== 'import' || binding.specifier === undefined || binding.targetPath !== undefined) {
        resolved.push(binding);
        continue;
      }
      let targetPath: string | undefined;
      for (const candidate of importCandidates(planned.path, binding.specifier)) {
        if ((await source.entry(candidate)) !== undefined) {
          targetPath = candidate;
          break;
        }
      }
      resolved.push(targetPath === undefined ? binding : { ...binding, targetPath });
    }
    facts = { ...facts, bindings: resolved.sort((left, right) => byCodePoint(left.id, right.id)) };
  }
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const write of factWrites({
    repository: planned.repository, path: planned.path, commit: source.commit, fileKey, facts, evidence, callables,
    ports, ...(membership.unit === undefined ? {} : { membership: membership.unit }),
  })) {
    context.draft.write(write);
  }
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: parsed ? [planned.path] : [],
    unread: gaps,
  };
  writeCoverage(context, source, planned.path, coverage, entry.id, membership.chain);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(facts.expressions.length)} ${facts.expressions.length === 1 ? 'expression' : 'expressions'}, ${String(facts.bindings.length)} ${facts.bindings.length === 1 ? 'binding' : 'bindings'}, ${String(facts.calls.length)} ${facts.calls.length === 1 ? 'call' : 'calls'}, ${String(facts.fields.length)} ${facts.fields.length === 1 ? 'field' : 'fields'}, ${String(ports.length)} ${ports.length === 1 ? 'port' : 'ports'}, ${membership.unit === undefined ? 'no service unit' : `the service unit ${membership.unit.name}`}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
}


/** The node kind of a callable site: one node per callable a file declares or writes as an argument. */
const CALLABLE_KIND = 'code.callable';

/** One callable a file declares: what the extract readings call it, where it stands and where its body is. */
interface CallableFact {
  /** The key the extract readings name this callable by (`code.symbol:<path>#<qualified name>`). */
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: true;
  readonly span: SourceSpan;
  readonly bodySpan?: SourceSpan;
  readonly bodySyntaxKind?: string;
}

/**
 * The callables one file declares, named as the extract readings name them: the
 * driver's own symbol reader (`fileSymbolsOf`) over the syntax pass's findings,
 * with each callable's body matched from the walk by the node's own span. A
 * callable written as an argument — a route handler, a store callback — is named
 * by the callable it stands in and the place it starts at, which is the key the
 * extract driver gives it.
 */
export async function callablesOfFile(path: string, bytes: Uint8Array, findings: ExtractedFileSyntax, bodies: readonly BodyFact[]): Promise<readonly CallableFact[]> {
  const language = syntaxLanguageOf(path);
  if (language === undefined) return [];
  const held = fileSymbolsOf({ path, bytes, language: language === 'go' ? 'go' : 'typescript' }, findings);
  // The driver matches a callable node to the symbol that owns it by the nearest start of a
  // symbol that starts before the node and ends where it ends (`bodies.ts`): a symbol's body
  // is the innermost callable node it owns.
  const bodiesByEnd = new Map<number, readonly BodyFact[]>();
  for (const body of bodies) bodiesByEnd.set(body.endByte, [...(bodiesByEnd.get(body.endByte) ?? []), body]);
  const callables: CallableFact[] = [];
  for (const symbol of held.symbols) {
    if (!symbol.functionLike || symbol.local) continue;
    const candidates = (bodiesByEnd.get(symbol.span.endByte) ?? []).filter((body) => body.startByte >= symbol.span.startByte);
    const nearest = Math.min(...candidates.map((body) => body.startByte), Number.POSITIVE_INFINITY);
    const body = candidates.filter((candidate) => candidate.startByte === nearest)[0];
    callables.push({
      key: `code.symbol:${path}#${symbol.qualifiedName}`,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      symbolKind: symbol.symbolKind,
      callable: true,
      span: spanOf(path, symbol.span.startByte, symbol.span.endByte, symbol.span.startLine, symbol.span.endLine),
      ...(body === undefined ? {} : {
        bodySpan: spanOf(path, body.bodyStartByte, body.bodyEndByte, body.bodyStartLine, body.bodyEndLine),
        bodySyntaxKind: body.bodySyntaxKind,
      }),
    });
  }
  // Two declarations of one name in two scopes are two callables, and the extract reading names
  // both `code.symbol:<path>#<name>`. A key that repeats takes its own place in the file, so one
  // draft names one node by one key; a name written once keeps the reading's key unchanged.
  const counts = new Map<string, number>();
  for (const callable of callables) counts.set(callable.qualifiedName, (counts.get(callable.qualifiedName) ?? 0) + 1);
  const keyed = callables.map((callable) => (counts.get(callable.qualifiedName) ?? 0) > 1
    ? { ...callable, key: `code.symbol:${path}#${callable.qualifiedName}#${String(callable.span.byteStart)}` }
    : callable);
  return keyed.sort((left, right) => byCodePoint(left.key, right.key));
}

/** One syntax span as the graph's own span. */
function spanOf(path: string, byteStart: number, byteEnd: number, lineStart: number, lineEnd: number): SourceSpan {
  return { path, byteStart, byteEnd, lineStart, lineEnd };
}

/** What one unreadable file says in its coverage: the reader's own words, or the path and the failure where it named none. */
function gapWhatOf(error: unknown, path: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${path}:`) ? message : `${path}:1: ${message}`;
}

/**
 * One file's facts, walked from its syntax tree: every named node as an
 * expression with its place, its parent, its named children by field, its
 * operator, its name and — where it holds one — its literal value; every
 * declaration's names as bindings, with the initializer the declaration writes;
 * every call as a call site; every Go struct field by its declaration.
 *
 * The walk is one pass in source order with a stack of scopes, so a binding is
 * recorded under the scope it stands in and an initializer by the expression
 * the declaration names. It reads no other file and keeps no syntax node: the
 * tree is gone when the unit returns.
 */
export function collectFileFacts(repository: string, path: string, text: string, root: SyntaxNodeLike, language: SyntaxLanguage | null): FileFacts {
  const spanOf = spanFactory(text);
  const expressions: ExpressionFact[] = [];
  const bindings: BindingFact[] = [];
  const calls: CallFact[] = [];
  const fields: FieldFact[] = [];
  const exports: ExportFact[] = [];
  const scopeSpans: SourceSpan[] = [toSpan(path, spanOf(root as never))];
  /** The names each scope binds, innermost last: what an identifier expression resolves to. */
  const scopeBindings: Map<string, string>[] = [new Map()];
  const resolveBinding = (name: string): string | undefined => {
    for (let index = scopeBindings.length - 1; index >= 0; index -= 1) {
      const held = scopeBindings[index]!.get(name);
      if (held !== undefined) return held;
    }
    return undefined;
  };

  const idOf = (syntaxKind: string, span: SourceSpan): string => `${EXPRESSION_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}:${syntaxKind}`;
  const spanOfNode = (node: SyntaxNodeLike): SourceSpan => toSpan(path, spanOf(node as never));

  /** The id of a node, computed once for the walk and reused by its parent, its fields and its own fact. */
  const idOfNode = (node: SyntaxNodeLike): string => idOf(node.type, spanOfNode(node));

  /** The text a name node holds, without its quotes: a name is written as written. */
  const nameOf = (node: SyntaxNodeLike): string => node.text;

  /** The binding an identifier's name resolves to, in the scopes the walk has entered. */
  const bindingOfName = (name: string): string | undefined => resolveBinding(name);

  /** The id a declaration's name node binds under: the place it stands at, as every binding id is. */
  const bindingIdOfName = (nameNode: SyntaxNodeLike): string => {
    const span = spanOfNode(nameNode);
    return `${BINDING_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}:binding`;
  };

  /** The literal a node holds, decoded where the decoder proves one and raw where it does not. */
  const literalOf = (node: SyntaxNodeLike, kind: LiteralFact['kind']): LiteralFact => {
    const raw = node.text;
    if (kind === 'boolean') return { kind, raw, value: raw === 'true' };
    if (kind === 'null') return { kind, raw, value: null };
    if (kind === 'number') {
      const value = Number(raw);
      return Number.isFinite(value) ? { kind, raw, value } : { kind, raw };
    }
    const quoted = raw.startsWith('`') && raw.endsWith('`') && node.type === 'template_string' ? raw.slice(1, -1) : undefined;
    // A template with an interpolation holds code, not one value: its raw text stands and no value is claimed.
    if (node.type === 'template_string' && node.namedChildren.some((child) => child !== null && child.type !== 'string_fragment')) return { kind, raw };
    const decoded = quoted === undefined ? decodeQuoted(raw) : storeText(quoted);
    return decoded === undefined ? { kind, raw } : { kind, raw, value: decoded };
  };

  /** The names one declaration binds: a name node, a pattern's names, or a Go identifier list. */
  const declaredNames = (node: SyntaxNodeLike): { readonly name: string; readonly node: SyntaxNodeLike; readonly initializer?: SyntaxNodeLike }[] => {
    const found: { name: string; node: SyntaxNodeLike; initializer?: SyntaxNodeLike }[] = [];
    const visitPattern = (pattern: SyntaxNodeLike | null): void => {
      if (pattern === null) return;
      if (NAME_KINDS.has(pattern.type)) {
        found.push({ name: pattern.text, node: pattern });
        return;
      }
      if (pattern.type === 'object_pattern' || pattern.type === 'array_pattern' || pattern.type === 'expression_list' || pattern.type === 'parenthesized_expression') {
        for (const child of pattern.namedChildren) visitPattern(child);
        return;
      }
      if (pattern.type === 'pair_pattern' || pattern.type === 'shorthand_property_identifier_pattern') {
        const value = pattern.type === 'pair_pattern' ? pattern.childForFieldName('value') : null;
        if (value !== null) visitPattern(value);
        return;
      }
      if (pattern.type === 'rest_pattern' || pattern.type === 'assignment_pattern') {
        visitPattern(pattern.namedChildren[0] ?? null);
      }
    };
    const initializer = node.childForFieldName('value') ?? node.childForFieldName('right') ?? undefined;
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('left') ?? null;
    if (nameNode !== null) visitPattern(nameNode);
    else if (node.type === 'short_var_declaration') {
      const left = node.childForFieldName('left');
      if (left !== null) visitPattern(left);
    }
    if (node.type === 'parameter_declaration' || node.type === 'required_parameter' || node.type === 'optional_parameter' || node.type === 'variadic_parameter_declaration') {
      const pattern = node.childForFieldName('pattern') ?? node.childForFieldName('name');
      if (pattern !== null) {
        found.length = 0;
        visitPattern(pattern);
        // A Go parameter declares one or more names before its type: each is a parameter.
        if (found.length === 0) {
          const name = node.childForFieldName('name');
          if (name !== null) found.push({ name: name.text, node: name });
        }
        return found.map((entry) => ({ ...entry, initializer: undefined }));
      }
      return [];
    }
    return found.map((entry) => ({ ...entry, ...(initializer === undefined ? {} : { initializer }) }));
  };

  const bodies: BodyFact[] = [];
  /** The declaration statements the walk stands inside, innermost last: where a binding's declaration starts. */
  const declarationStarts: SourceSpan[] = [];
  const visit = (node: SyntaxNodeLike, parentId: string | undefined): void => {
    if (!node.isNamed) return;
    if (node.type === 'comment') return;
    const span = spanOfNode(node);
    let invocationSpan: SourceSpan | undefined;
    if (DECLARATION_STATEMENTS.has(node.type)) declarationStarts.push(span);
    const bodyNode = CALLABLE_NODES.has(node.type) ? node.childForFieldName('body') : null;
    if (bodyNode !== null) {
      const bodySpan = spanOfNode(bodyNode);
      bodies.push({
        startByte: span.byteStart, endByte: span.byteEnd, bodyStartByte: bodySpan.byteStart, bodyEndByte: bodySpan.byteEnd,
        bodyStartLine: bodySpan.lineStart, bodyEndLine: bodySpan.lineEnd, bodySyntaxKind: bodyNode.type,
      });
    }
    const id = idOf(node.type, span);
    const children: string[] = [];
    // A grammar's field names are words a file writes (`constructor` is the field of a
    // `new_expression`), and a plain object inherits `constructor` from Object.prototype: the
    // record is built without a prototype, so a field name can never reach an inherited member.
    const fieldLinks: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    const argumentNodes: SyntaxNodeLike[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child === null || !child.isNamed) continue;
      if (child.type === 'comment') continue;
      const childId = idOfNode(child);
      children.push(childId);
      const fieldName = node.fieldNameForChild(index);
      if (fieldName !== null && fieldName !== '') (fieldLinks[fieldName] ??= []).push(childId);
      if (node.type === 'call_expression' || node.type === 'new_expression') {
        const args = node.childForFieldName('arguments') ?? node.childForFieldName('arguments_list');
        if (args !== null && args.id === child.id) {
          argumentNodes.push(...args.namedChildren.filter((entry): entry is SyntaxNodeLike => entry !== null));
          // The invocation's prefix ends at the opening bracket, which the grammar names as a child.
          for (let inner = 0; inner < args.childCount; inner += 1) {
            const bracket = args.child(inner);
            if (bracket === null || bracket.type !== '(') continue;
            const bracketSpan = spanOfNode(bracket);
            invocationSpan = { path, byteStart: span.byteStart, byteEnd: bracketSpan.byteEnd, lineStart: span.lineStart, lineEnd: bracketSpan.lineEnd };
            break;
          }
        }
      }
    }
    const operatorNode = operatorOf(node);
    const literalKind = LITERAL_KINDS.get(node.type);
    const nameNode = NAME_KINDS.has(node.type) ? node : null;
    const member = node.type === 'member_expression' || node.type === 'selector_expression' ? node.childForFieldName('property') ?? node.childForFieldName('field') : null;
    const object = node.type === 'member_expression' || node.type === 'selector_expression' ? node.childForFieldName('object') ?? node.childForFieldName('operand') : null;
    const callee = node.type === 'call_expression' || node.type === 'new_expression' ? node.childForFieldName('function') ?? node.childForFieldName('constructor') : null;
    const literal = literalKind === undefined ? undefined : literalOf(node, literalKind);
    expressions.push({
      id,
      syntaxKind: node.type,
      span,
      ...(parentId === undefined ? {} : { parent: parentId }),
      children,
      fields: fieldLinks,
      ...(operatorNode === null ? {} : { operator: operatorNode.text }),
      ...(nameNode === null ? {} : { name: nameOf(nameNode) }),
      ...(object === null ? {} : { receiver: object === undefined || object === null ? undefined : idOfNode(object) }),
      ...(member === null || member === undefined ? {} : { member: member.text }),
      ...(callee === null || callee === undefined ? {} : { callee: idOfNode(callee) }),
      ...(argumentNodes.length === 0 ? {} : { arguments: [...new Set(argumentNodes.map((entry) => idOfNode(entry)))] }),
      ...(node.type !== 'identifier' ? {} : bindingOfName(node.text) === undefined ? {} : { bindingId: bindingOfName(node.text)! }),
      ...(literal === undefined ? {} : { literal }),
    } as ExpressionFact);

    const declares = TS_BINDING_DECLARATIONS.has(node.type) || GO_BINDING_DECLARATIONS.has(node.type) || PARAMETER_KINDS.has(node.type);
    if (declares) {
      for (const entry of declaredNames(node)) {
        // A parameter is a parameter; a Go `const_spec` declares a constant, a TypeScript
        // `variable_declarator` whatever `const`/`let`/`var` its parent says.
        const kind: BindingFact['kind'] = PARAMETER_KINDS.has(node.type) ? 'parameter' : constantDeclaration(node) ? 'local' : 'local';
        const bindingId = `${BINDING_KIND}:${repository}:${path}@${String(spanOfNode(entry.node).byteStart)}:${String(spanOfNode(entry.node).byteEnd)}:binding`;
        const initializer = entry.initializer === undefined ? undefined : spanOfNode(entry.initializer);
        const start = declarationStarts[declarationStarts.length - 1] ?? spanOfNode(entry.node);
        bindings.push({
          id: bindingId,
          name: entry.name,
          kind,
          span: spanOfNode(entry.node),
          scope: scopeSpans[scopeSpans.length - 1]!,
          ...(entry.initializer === undefined ? {} : { initializer: idOfNode(entry.initializer) }),
          ...(initializer === undefined ? {} : {
            declarationSpan: { path, byteStart: start.byteStart, byteEnd: initializer.byteEnd, lineStart: start.lineStart, lineEnd: initializer.lineEnd },
          }),
        });
        scopeBindings[scopeBindings.length - 1]!.set(entry.name, bindingId);
      }
    }
    for (const exported of exportNamesOf(node, bindingIdOfName)) {
      exports.push({
        // One name can be exported twice in one file (a merged type and value), so the id names
        // the place the export stands at as well as the name: one draft names one node by one key.
        id: `${EXPORT_KIND}:${repository}:${path}#${exported.name}@${String(spanOfNode(exported.nameNode).byteStart)}`,
        name: exported.name,
        span: spanOfNode(exported.nameNode),
        ...(exported.localBinding === undefined ? {} : { localBinding: exported.localBinding }),
      });
    }
    for (const imported of importDeclarationsOf(node)) {
      const nameId = `${BINDING_KIND}:${repository}:${path}@${String(spanOfNode(imported.nameNode).byteStart)}:${String(spanOfNode(imported.nameNode).byteEnd)}:binding`;
      bindings.push({
        id: nameId,
        name: imported.local,
        kind: 'import',
        span: spanOfNode(imported.nameNode),
        scope: scopeSpans[0]!,
        specifier: imported.specifier,
        form: imported.form,
        // The import fact and the binding are one record here: its id is the import the
        // evaluator chains, and `importId` names it the way the code pass's binding does.
        importId: nameId,
        ...(imported.importedName === undefined ? {} : { importedName: imported.importedName }),
      });
      scopeBindings[0]!.set(imported.local, nameId);
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      calls.push({
        id: `${CALL_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}`,
        expression: id,
        span,
        ...(invocationSpan === undefined ? {} : { invocationSpan }),
        ...(callee === null || callee === undefined ? {} : { callee: idOfNode(callee) }),
        arguments: [...new Set(argumentNodes.map((entry) => idOfNode(entry)))],
        construct: node.type === 'new_expression',
      });
    }
    if (language === 'go' && node.type === 'field_declaration') {
      const nameNode = node.childForFieldName('name');
      const typeNode = node.childForFieldName('type');
      if (nameNode !== null) {
        fields.push({
          id: `${FIELD_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}`,
          name: nameNode.text,
          ownerTypeName: ownerTypeNameOf(node),
          span,
          ...(typeNode === null ? {} : { typeExpression: idOfNode(typeNode) }),
        });
      }
    }
    // A node that opens a scope binds its own names for its body: the block, the
    // function, the class and the loop each stand as one scope here.
    const opensScope = ['block', 'statement_block', 'function_declaration', 'method_definition', 'arrow_function', 'class_declaration', 'for_statement', 'function', 'func_literal', 'method_declaration'].includes(node.type);
    if (opensScope) {
      scopeSpans.push(span);
      scopeBindings.push(new Map());
    }
    for (const child of node.namedChildren) if (child !== null) visit(child, id);
    if (DECLARATION_STATEMENTS.has(node.type)) declarationStarts.pop();
    if (opensScope) {
      scopeSpans.pop();
      scopeBindings.pop();
    }
  };

  visit(root, undefined);
  // The walk is in source order already; the sort is the one a reader relies on when a
  // grammar hands its children in another order, and it is a code point order of ids.
  expressions.sort((left, right) => (left.span.byteStart - right.span.byteStart) || (left.span.byteEnd - right.span.byteEnd) || byCodePoint(left.id, right.id));
  bindings.sort((left, right) => byCodePoint(left.id, right.id));
  calls.sort((left, right) => byCodePoint(left.id, right.id));
  fields.sort((left, right) => byCodePoint(left.id, right.id));
  return {
    expressions,
    bindings,
    calls,
    fields,
    bodies,
    exports: [...new Map(exports.map((entry) => [`${entry.name}\u0000${String(entry.span.byteStart)}`, entry])).values()].sort((left, right) => byCodePoint(left.id, right.id)),
  };
}

/** The syntax node shape the walk reads: the web-tree-sitter node's own members, named once for this module. */
interface SyntaxNodeLike {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly childCount: number;
  readonly namedChildren: readonly (SyntaxNodeLike | null)[];
  readonly id: number;
  child(index: number): SyntaxNodeLike | null;
  childForFieldName(name: string): SyntaxNodeLike | null;
  fieldNameForChild(index: number): string | null;
}

/**
 * The names an export declaration exports, with the binding the file declares
 * each under: `export const x`, `export function f`, `export class C`, and the
 * names an `export { a, b as c }` clause lists. A binding's id is the place its
 * name stands at, so the export and the binding are one record seen twice.
 */
function exportNamesOf(node: SyntaxNodeLike, bindingAt: (nameNode: SyntaxNodeLike) => string): readonly { readonly name: string; readonly nameNode: SyntaxNodeLike; readonly localBinding?: string }[] {
  if (node.type !== 'export_statement') return [];
  const found: { name: string; nameNode: SyntaxNodeLike; localBinding?: string }[] = [];
  const declaration = node.childForFieldName('declaration');
  if (declaration !== null) {
    if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren) {
        if (declarator === null || declarator.type !== 'variable_declarator') continue;
        const name = declarator.childForFieldName('name');
        if (name !== null && NAME_KINDS.has(name.type)) found.push({ name: name.text, nameNode: name, localBinding: bindingAt(name) });
      }
    } else {
      const name = declaration.childForFieldName('name');
      if (name !== null && NAME_KINDS.has(name.type)) found.push({ name: name.text, nameNode: name, localBinding: bindingAt(name) });
    }
  }
  for (const child of node.namedChildren) {
    if (child === null || child.type !== 'export_clause') continue;
    for (const specifier of child.namedChildren) {
      if (specifier === null || specifier.type !== 'export_specifier') continue;
      const name = specifier.childForFieldName('name');
      const alias = specifier.childForFieldName('alias');
      if (name === null) continue;
      found.push({ name: (alias ?? name).text, nameNode: alias ?? name });
    }
  }
  return found;
}

/**
 * The names an import declaration binds, by the form it binds them in: a
 * TypeScript `import`'s default, namespace and named specifiers, and a Go
 * `import_spec`'s name (the package's own last segment where it writes none).
 * The specifier is the text the file wrote, and a file it answers is another
 * file's business: the unit fills `targetPath` from the pinned tree.
 */
function importDeclarationsOf(node: SyntaxNodeLike): readonly { readonly local: string; readonly nameNode: SyntaxNodeLike; readonly specifier: string; readonly form: 'default' | 'namespace' | 'named'; readonly importedName?: string }[] {
  if (node.type !== 'import_statement' && node.type !== 'import_spec') return [];
  const source = node.childForFieldName('source') ?? node.childForFieldName('path');
  if (source === null) return [];
  const specifier = source.text.replace(/^["'`]|["'`]$/g, '');
  if (node.type === 'import_spec') {
    // A Go import binds the package as a whole, under its own last segment or the name the file
    // writes: the library models name that binding form a namespace, and a Go package's member is
    // its export (`slog.New`), never a named import.
    const name = node.childForFieldName('name');
    const local = name === null ? (specifier.slice(specifier.lastIndexOf('/') + 1)) : name.text;
    return [{ local, nameNode: name ?? source, specifier, form: 'namespace' }];
  }
  const found: { local: string; nameNode: SyntaxNodeLike; specifier: string; form: 'default' | 'namespace' | 'named'; importedName?: string }[] = [];
  const visitClause = (clause: SyntaxNodeLike | null): void => {
    if (clause === null) return;
    if (clause.type === 'import_specifier') {
      const name = clause.childForFieldName('name');
      const alias = clause.childForFieldName('alias');
      if (name === null) return;
      found.push({ local: (alias ?? name).text, nameNode: alias ?? name, specifier, form: 'named', importedName: name.text });
      return;
    }
    if (clause.type === 'namespace_import') {
      const name = clause.namedChildren.find((child): child is SyntaxNodeLike => child !== null && child.isNamed) ?? null;
      if (name !== null) found.push({ local: name.text, nameNode: name, specifier, form: 'namespace' });
      return;
    }
    if (clause.type === 'identifier') {
      found.push({ local: clause.text, nameNode: clause, specifier, form: 'default', importedName: 'default' });
      return;
    }
    for (const child of clause.namedChildren) if (child !== null) visitClause(child);
  };
  for (const child of node.namedChildren) {
    if (child === null || child.type === 'string') continue;
    visitClause(child);
  }
  return found;
}

/** The operator a binary, unary or update expression holds, from the field the grammar names it by. */
function operatorOf(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.fieldNameForChild(index) === 'operator') return node.child(index);
  }
  return null;
}

/** Whether a declaration writes a constant; kept for the binding's kind where a reader asks. */
function constantDeclaration(node: SyntaxNodeLike): boolean {
  return node.type === 'const_spec' || node.type === 'const_declaration';
}

/** The type a Go struct field belongs to: the struct type's declaration name, where the walk stands inside one. */
function ownerTypeNameOf(node: SyntaxNodeLike): string {
  // The grammar gives no parent link in this binding's public shape, so the walk records the
  // field with the type name its enclosing shape names where it has one; an unnamed struct
  // holds none, and the field keeps the empty name a reader sees as unknown.
  const owner = (node as unknown as { parent?: SyntaxNodeLike | null }).parent;
  let held: SyntaxNodeLike | null | undefined = owner ?? null;
  while (held !== null && held !== undefined) {
    if (held.type === 'type_declaration' || held.type === 'type_spec') {
      const name = held.childForFieldName('name');
      if (name !== null) return name.text;
    }
    held = (held as unknown as { parent?: SyntaxNodeLike | null }).parent ?? null;
  }
  return '';
}

/** One node's span: the bytes and lines a reader counts. */
function toSpan(path: string, span: { readonly startByte: number; readonly endByte: number; readonly startLine: number; readonly endLine: number }): SourceSpan {
  return { path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine };
}

/**
 * The text a quoted string token holds, decoded: the escapes a reader can see and
 * a value can hold. A token whose escape this decoder does not know answers
 * `undefined`, and the fact keeps the raw text without claiming a value.
 */
function decodeQuoted(raw: string): string | undefined {
  if (raw.length < 2) return undefined;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || raw[raw.length - 1] !== quote) return undefined;
  const body = raw.slice(1, -1);
  let out = '';
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]!;
    if (char !== '\\') { out += char; continue; }
    const next = body[at + 1];
    if (next === undefined) return undefined;
    at += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'v') out += '\v';
    else if (next === '0') out += '\u0000';
    else if (next === 'x') {
      const hex = body.slice(at + 1, at + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      at += 2;
    } else if (next === 'u') {
      const hex = body.slice(at + 1, at + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      at += 4;
    } else if (next === 'u{') {
      const end = body.indexOf('}', at + 2);
      if (end < 0) return undefined;
      const hex = body.slice(at + 2, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return undefined;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      at = end;
    } else if (next === '\n') { /* a line continuation holds nothing */ }
    else out += next;
  }
  return storeText(out);
}

/**
 * The text a fact can hold: a JSON string and PostgreSQL's text cannot carry
 * U+0000 or a lone surrogate, so each is kept as the escape a reader sees
 * written (`\u0000`, `\ud800`) instead of disappearing or failing the
 * publication. The source's own escape stays visible, and the fact keeps its
 * place in the graph.
 */
function storeText(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === 0) { out += '\\u0000'; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += text[at]! + text[at + 1]!; at += 1; continue; }
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += text[at]!;
  }
  return out;
}

/** What one unit's draft writes: one node per fact, and the file's declaration of its bindings and calls. */
function factWrites(input: {
  readonly repository: string;
  readonly path: string;
  readonly commit: string;
  readonly fileKey: string;
  readonly facts: FileFacts;
  readonly evidence: string;
  /** The unit the file belongs to, where one declares it. */
  readonly membership?: ServiceMembership;
  /** The ports the file's code listens on, in code point order. */
  readonly ports: readonly string[];
  /** The callables the file declares, named as the extract readings name them. */
  readonly callables: readonly CallableFact[];
}): readonly StageDraftWrite[] {
  const writes: StageDraftWrite[] = [];
  const provenance = { source: CODE_FACTS_SOURCE, repository: { id: input.repository, commit: input.commit } };
  for (const expression of input.facts.expressions) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: expression.id,
        kind: EXPRESSION_KIND,
        label: expression.syntaxKind,
        properties: {
          ...expression,
          recordKey: expression.id,
          factKind: 'expression',
          repository: input.repository,
          file: input.path,
          path: input.path,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(expression.span) } },
        },
      },
    });
  }
  for (const binding of input.facts.bindings) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: binding.id,
        kind: BINDING_KIND,
        label: binding.name,
        properties: {
          ...binding,
          recordKey: binding.id,
          factKind: 'binding',
          repository: input.repository,
          file: input.path,
          path: input.path,
          globalName: `${input.repository}:${input.path}#${binding.name}`,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(binding.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: binding.id }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  for (const callable of input.callables) {
    // The callable's own key, with the reading's prefix replaced by this stage's: a name two scopes repeat
    // carries its start byte, so the two callables are two nodes.
    const id = callable.key.startsWith('code.symbol:')
      ? `${CALLABLE_KIND}:${input.repository}:${callable.key.slice('code.symbol:'.length)}`
      : `${CALLABLE_KIND}:${input.repository}:${input.path}#${callable.qualifiedName}`;
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: id,
        kind: CALLABLE_KIND,
        label: callable.qualifiedName,
        properties: {
          ...callable,
          recordKey: id,
          factKind: 'callable',
          repository: input.repository,
          file: input.path,
          path: input.path,
          symbolKey: callable.key,
          symbolGlobalName: `${input.repository}:${input.path}#${callable.qualifiedName}`,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(callable.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: id }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  for (const call of input.facts.calls) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: call.id,
        kind: CALL_KIND,
        label: 'call',
        properties: {
          ...call,
          recordKey: call.id,
          factKind: 'callsite',
          repository: input.repository,
          file: input.path,
          path: input.path,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(call.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: call.id }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  for (const exported of input.facts.exports) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: exported.id,
        kind: EXPORT_KIND,
        label: exported.name,
        properties: {
          ...exported,
          recordKey: exported.id,
          factKind: 'export',
          repository: input.repository,
          file: input.path,
          path: input.path,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(exported.span) } },
        },
      },
    });
  }
  for (const field of input.facts.fields) {
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: field.id,
        kind: FIELD_KIND,
        label: field.name,
        properties: {
          ...field,
          recordKey: field.id,
          factKind: 'field',
          repository: input.repository,
          file: input.path,
          path: input.path,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(field.span) } },
        },
      },
    });
  }
  // The unit the file belongs to: one node per file, so a later stage reads an operation's
  // service by the file it stands in (`byProperty('code.service-unit', 'file', path)`).
  if (input.membership !== undefined) {
    const unitKey = serviceUnitKeyOf(input.repository, input.path);
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: unitKey,
        kind: SERVICE_UNIT_KIND,
        label: input.membership.name,
        properties: {
          recordKey: unitKey,
          factKind: 'service-unit',
          repository: input.repository,
          file: input.path,
          path: input.path,
          name: input.membership.name,
          root: input.membership.root,
          manifestPath: input.membership.manifestPath,
          ecosystem: input.membership.ecosystem,
          declared: input.membership.declared,
          provenance,
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: unitKey }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  // The ports the file's code listens on: one node per port, carrying the unit it serves where one
  // declares it, so a contract's server is matched to its service by a read by property.
  for (const port of input.ports) {
    const portKey = listenerPortKeyOf(input.repository, input.path, port);
    writes.push({
      kind: 'node',
      evidence: input.evidence,
      value: {
        key: portKey,
        kind: LISTENER_PORT_KIND,
        label: port,
        properties: {
          recordKey: portKey,
          factKind: 'listener-port',
          repository: input.repository,
          file: input.path,
          path: input.path,
          port,
          ...(input.membership === undefined ? {} : { service: input.membership.name }),
          provenance,
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: portKey }, properties: { factKind: 'declares', repository: input.repository } } });
  }
  return writes;
}

/** The key of one file's service-unit node: the vocabulary's kind, the repository and the file. */
function serviceUnitKeyOf(repository: string, path: string): string {
  return `${SERVICE_UNIT_KIND}:${repository}:${path}`;
}

/** The key of one file's port node: the unit's own key shape, with the port it listens on. */
function listenerPortKeyOf(repository: string, path: string, port: string): string {
  return `${LISTENER_PORT_KIND}:${repository}:${path}#${port}`;
}

/** The line range a fact's place carries: the syntax stage's own shape for a node's provenance. */
function rangeOf(span: SourceSpan): { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } {
  return { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0 };
}

/** One file's coverage: what was read, every place this stage could not read, the blob the bytes stood under, and the manifests the membership stood on. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string, unitChain: readonly string[]): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: CODE_FACTS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob, unitChain: [...unitChain] } } }
      : write);
  }
}

/** How one unit reads a manifest above its file: one path at a time, its blob and, below the cap, its bytes. */
function manifestLookup(source: StaticStageSource): ManifestLookup {
  return async (path: string): Promise<ManifestEntry | undefined> => {
    const entry = await source.entry(path);
    if (entry === undefined || entry.form === 'commit') return undefined;
    if (entry.bytes !== undefined && entry.bytes > FILE_BYTE_LIMIT) return { path, blob: entry.id };
    const file = await source.file(path);
    return { path, blob: entry.id, ...(file?.content === undefined ? {} : { bytes: file.content }) };
  };
}

/** The manifest chain above one file, read from the pinned tree without reading a manifest's bytes. */
async function manifestChainAt(source: StaticStageSource, path: string): Promise<readonly string[]> {
  return await manifestChainOf(folderOf(path), async (candidate: string) => {
    const entry = await source.entry(candidate);
    return entry === undefined || entry.form === 'commit' ? undefined : { path: candidate, blob: entry.id };
  });
}

/** The unit's static repository, refused by name where the run handed none. */
function staticSourceOf(unit: StageUnit, context: StageContext): StaticStageContext {
  const held = context.static;
  if (held === undefined) {
    throw new Error(`the unit "${unit.id}" runs the code-facts stage's static reading, and its context holds no pinned repository: a run hands a static stage its repository's path-scoped answers (src/fill/stages/code-facts.ts, decision 0033)`);
  }
  return held;
}

/** A cancelled unit stops where it stands: a cancelled unit publishes nothing. */
function refuseWhenCancelled(unit: StageUnit, context: StageContext): void {
  if (context.signal.aborted) {
    throw new Error(`the unit "${unit.id}" was cancelled before it read the pinned file: a cancelled unit publishes nothing (src/fill/stages/code-facts.ts)`);
  }
}

// ---- reading a read's rows ------------------------------------------------

/**
 * The plan's own read, read: each row is one file this stage read and the blob
 * its bytes stood under. A row naming another kind, a file that is no
 * repository path, a blob that is no blob id, or a key this read does not
 * define is refused, naming the read, the row and the field.
 */
function publishedFactsRows(rows: readonly unknown[], repository: string, read: string): readonly PublishedCodeFactsRow[] {
  return rows.map((row, index) => {
    const held = rowRecord(row, read, index, repository, 'what a file\'s code facts read');
    unknownKeys(held, FACTS_ROW_FIELDS, read, index, repository);
    if (held['kind'] !== 'coverage') throw refuseRow(read, index, repository, `its kind is ${JSON.stringify(held['kind'])}, and this read answers "coverage" facts`);
    const file = held['file'];
    if (typeof file !== 'string' || file === '') {
      throw refuseRow(read, index, repository, `its file ${JSON.stringify(file)} is no repository path: a coverage stands for a file of the repository`);
    }
    const blob = held['blob'];
    if (typeof blob !== 'string' || !/^[0-9a-f]{40}$/.test(blob)) {
      throw refuseRow(read, index, repository, `its blob ${JSON.stringify(blob)} is no blob id: 40 lower-case hexadecimal digits`);
    }
    const unitChain = held['unitChain'];
    if (unitChain !== undefined && (!Array.isArray(unitChain) || unitChain.some((entry) => typeof entry !== 'string' || entry === ''))) {
      throw refuseRow(read, index, repository, `its unitChain ${JSON.stringify(unitChain)} is no list of manifest places: a place is a path and the blob it stood under`);
    }
    return { kind: 'coverage', file, blob, ...(unitChain === undefined ? {} : { unitChain: unitChain as readonly string[] }) };
  });
}
