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
 * **The unit reads one file and no other.** The bytes come from the static
 * context (one file below the size cap), the tree is walked inside the unit and
 * deleted with it, and every id is derived from the place the fact stands at
 * (repository, path, byte span, syntax kind), so two runs of one commit write
 * the same ids. The facts are nodes whose `file` property names the file; a
 * binding and a call also hang from the file's node with `code.declares`, so a
 * reader can walk them. An expression is linked to its children by their ids in
 * its own `children` and `fields`, not by edges: a file of a few hundred
 * expressions would otherwise cost thousands of edges for a tree one node
 * already describes.
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
import { readSyntaxTree, spanFactory, type SyntaxLanguage } from './syntax-extract.js';
import type { StaticStageContext, StaticStageSource } from './static-context.js';
import { checkStaticGraphDraft, graphWritesOf } from './static-graph.js';
import { fileFactIdOf } from './syntax-facts.js';
import { fileUnitId, plannedUnit } from './syntax.js';
import { publishedTreeRead, publishedTreeRows } from './tree-rows.js';

/** The stage's id, as it is registered and as its units are named. */
export const CODE_FACTS_STAGE_ID = 'code-facts';

/** The stage's own version, bumped when what it writes or plans changes. */
const CODE_FACTS_STAGE_VERSION = 1;

/** The fact kinds the stage produces, in code point order. */
const CODE_FACTS_STAGE_KINDS: readonly string[] = ['binding', 'callsite', 'coverage', 'declares', 'expression', 'field'];

/** The node kinds the stage writes, in the extractors' vocabulary (decision 0033, item 7). */
const EXPRESSION_KIND = 'code.expression';
const BINDING_KIND = 'code.binding';
const CALL_KIND = 'code.call';
const FIELD_KIND = 'code.field';

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
}

/** The keys a row of that read holds, and no others. */
const FACTS_ROW_FIELDS: readonly string[] = ['blob', 'file', 'kind'];

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
      { kind: 'callsite', schemaVersion: 1, scope: 'file' },
      { kind: 'declares', schemaVersion: 1, scope: 'file' },
      { kind: 'coverage', schemaVersion: FACT_KINDS['coverage'].version, scope: 'file' },
      { kind: 'expression', schemaVersion: 1, scope: 'file' },
      { kind: 'field', schemaVersion: 1, scope: 'file' },
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
    const readBlobs = new Map<string, string>(own.map((row) => [row.file, row.blob]));
    const mine = reader.files().filter((entry) => isFactPath(entry.path));
    anySource = anySource || mine.length > 0;
    const present = new Set<string>(mine.map((entry) => entry.path));
    for (const entry of mine) {
      if (readBlobs.get(entry.path) === entry.id) continue;
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

/** One binding a declaration makes. */
interface BindingFact {
  readonly id: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver' | 'type';
  readonly span: SourceSpan;
  readonly scope: SourceSpan;
  readonly initializer?: string;
}

/** One call site: the invocation and the callee and arguments it names. */
interface CallFact {
  readonly id: string;
  readonly expression: string;
  readonly span: SourceSpan;
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

/** Everything one file's walk read. */
interface FileFacts {
  readonly expressions: readonly ExpressionFact[];
  readonly bindings: readonly BindingFact[];
  readonly calls: readonly CallFact[];
  readonly fields: readonly FieldFact[];
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

/** The node types that declare a name in TypeScript and JavaScript. */
const TS_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['variable_declarator']);

/** The node types that declare a name in Go. */
const GO_BINDING_DECLARATIONS: ReadonlySet<string> = new Set(['const_spec', 'short_var_declaration', 'var_spec']);

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
    writeCoverage(context, source, planned.path, coverage, entry.id);
    context.progress(`${planned.path} of ${planned.repository} is ${reason === 'too-large' ? `above the static reading cap of ${String(FILE_BYTE_LIMIT)} bytes` : 'not a source text this stage reads'}: the file is published as a ${reason} coverage gap`, 1);
    return { outcome: 'draft' };
  }
  refuseWhenCancelled(unit, context);
  const bytes = file.content!;
  const gaps: CoverageGap[] = [];
  let facts: FileFacts = { expressions: [], bindings: [], calls: [], fields: [] };
  let parsed = false;
  try {
    const read = await readSyntaxTree(planned.path, bytes, (tree) => collectFileFacts(planned.repository, planned.path, tree.text, tree.root, tree.language));
    if (!read.read) {
      gaps.push({ what: `${planned.path} at ${String(CODE_FACTS_SOURCE.system)} ${CODE_FACTS_SOURCE.version}`, reason: read.unread[0]?.reason ?? 'error' });
    } else {
      facts = read.value;
      parsed = true;
      if (read.complete === false) gaps.push({ what: `${planned.path} is read with syntax errors`, reason: 'error' });
    }
  } catch (error) {
    gaps.push({ what: gapWhatOf(error, planned.path), reason: 'error' });
  }
  const evidence = evidenceAtPlace(source, planned.path);
  const fileKey = fileFactIdOf(planned.repository, planned.path);
  for (const write of factWrites({ repository: planned.repository, path: planned.path, commit: source.commit, fileKey, facts, evidence })) {
    context.draft.write(write);
  }
  const coverage: CoverageValue = {
    repository: planned.repository,
    scope: planned.path,
    complete: gaps.length === 0,
    read: parsed ? [planned.path] : [],
    unread: gaps,
  };
  writeCoverage(context, source, planned.path, coverage, entry.id);
  context.progress(
    `read ${planned.path} of ${planned.repository} at ${source.commit}: ${String(facts.expressions.length)} ${facts.expressions.length === 1 ? 'expression' : 'expressions'}, ${String(facts.bindings.length)} ${facts.bindings.length === 1 ? 'binding' : 'bindings'}, ${String(facts.calls.length)} ${facts.calls.length === 1 ? 'call' : 'calls'}, ${String(facts.fields.length)} ${facts.fields.length === 1 ? 'field' : 'fields'}, ${String(gaps.length)} ${gaps.length === 1 ? 'gap' : 'gaps'}`,
    1,
  );
  return { outcome: 'draft' };
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
  const scopeSpans: SourceSpan[] = [toSpan(path, spanOf(root as never))];

  const idOf = (syntaxKind: string, span: SourceSpan): string => `${EXPRESSION_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}:${syntaxKind}`;
  const spanOfNode = (node: SyntaxNodeLike): SourceSpan => toSpan(path, spanOf(node as never));

  /** The id of a node, computed once for the walk and reused by its parent, its fields and its own fact. */
  const idOfNode = (node: SyntaxNodeLike): string => idOf(node.type, spanOfNode(node));

  /** The text a name node holds, without its quotes: a name is written as written. */
  const nameOf = (node: SyntaxNodeLike): string => node.text;

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
    const decoded = quoted ?? decodeQuoted(raw);
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

  const visit = (node: SyntaxNodeLike, parentId: string | undefined): void => {
    if (!node.isNamed) return;
    if (node.type === 'comment') return;
    const span = spanOfNode(node);
    const id = idOf(node.type, span);
    const children: string[] = [];
    const fieldLinks: Record<string, string[]> = {};
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
        if (args !== null && args.id === child.id) argumentNodes.push(...args.namedChildren.filter((entry): entry is SyntaxNodeLike => entry !== null));
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
      ...(literal === undefined ? {} : { literal }),
    } as ExpressionFact);

    const declares = TS_BINDING_DECLARATIONS.has(node.type) || GO_BINDING_DECLARATIONS.has(node.type) || PARAMETER_KINDS.has(node.type);
    if (declares) {
      for (const entry of declaredNames(node)) {
        // A parameter is a parameter; a Go `const_spec` declares a constant, a TypeScript
        // `variable_declarator` whatever `const`/`let`/`var` its parent says.
        const kind: BindingFact['kind'] = PARAMETER_KINDS.has(node.type) ? 'parameter' : constantDeclaration(node) ? 'local' : 'local';
        const bindingId = `${BINDING_KIND}:${repository}:${path}@${String(spanOfNode(entry.node).byteStart)}:${String(spanOfNode(entry.node).byteEnd)}:binding`;
        bindings.push({
          id: bindingId,
          name: entry.name,
          kind,
          span: spanOfNode(entry.node),
          scope: scopeSpans[scopeSpans.length - 1]!,
          ...(entry.initializer === undefined ? {} : { initializer: idOfNode(entry.initializer) }),
        });
      }
    }
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      calls.push({
        id: `${CALL_KIND}:${repository}:${path}@${String(span.byteStart)}:${String(span.byteEnd)}`,
        expression: id,
        span,
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
    if (opensScope) scopeSpans.push(span);
    for (const child of node.namedChildren) if (child !== null) visit(child, id);
    if (opensScope) scopeSpans.pop();
  };

  visit(root, undefined);
  // The walk is in source order already; the sort is the one a reader relies on when a
  // grammar hands its children in another order, and it is a code point order of ids.
  expressions.sort((left, right) => (left.span.byteStart - right.span.byteStart) || (left.span.byteEnd - right.span.byteEnd) || byCodePoint(left.id, right.id));
  bindings.sort((left, right) => byCodePoint(left.id, right.id));
  calls.sort((left, right) => byCodePoint(left.id, right.id));
  fields.sort((left, right) => byCodePoint(left.id, right.id));
  return { expressions, bindings, calls, fields };
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
          globalName: `${input.repository}:${input.path}#${binding.name}`,
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(binding.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: binding.id }, properties: { factKind: 'declares', repository: input.repository } } });
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
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(call.span) } },
        },
      },
    });
    writes.push({ kind: 'edge', evidence: input.evidence, value: { relation: DECLARES_RELATION, from: { key: input.fileKey }, to: { key: call.id }, properties: { factKind: 'declares', repository: input.repository } } });
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
          provenance: { ...provenance, place: { file: input.path, range: rangeOf(field.span) } },
        },
      },
    });
  }
  return writes;
}

/** The line range a fact's place carries: the syntax stage's own shape for a node's provenance. */
function rangeOf(span: SourceSpan): { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } {
  return { startLine: span.lineStart, startColumn: 0, endLine: span.lineEnd, endColumn: 0 };
}

/** One file's coverage: what was read, every place this stage could not read, and the blob the bytes stood under. */
function writeCoverage(context: StageContext, source: StaticStageSource, path: string, coverage: CoverageValue, blob: string): void {
  const fact = makeNodeFact({
    kind: 'coverage',
    layer: 'extracted',
    provenance: { source: CODE_FACTS_SOURCE, repository: { id: coverage.repository, commit: source.commit } },
    value: coverage,
  });
  const evidence = evidenceAtPlace(source, path);
  for (const write of graphWritesOf(fact, evidence)) {
    context.draft.write(write.kind === 'node'
      ? { ...write, value: { ...write.value, properties: { ...write.value.properties, blob } } }
      : write);
  }
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
    return { kind: 'coverage', file, blob };
  });
}
