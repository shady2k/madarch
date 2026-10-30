/**
 * The deterministic rules for graph verdicts (madarch-mwhd.1), as data the
 * engine reads. Every node and every edge kind is matched by exactly one rule:
 * an exact kind, then the longest kind prefix, then the fallback. A rule may
 * require properties, a record key, a source span, evidence lines, or endpoint
 * kinds; the engine alone turns those requirements into a verdict.
 *
 * A rule may also carry escalation policies: neighbourhood predicates that
 * say a shape check alone is not enough (a database with no table, a route
 * with no handler, a table nobody reads or writes, an environment variable
 * read but defined nowhere, a deployment with no image, a test that tests
 * nothing). Those items go to a judge; a missing edge is a question, never
 * proof of absence. `GRAPH_NODE_ESCALATIONS` holds the policies that apply to
 * every kind. The rules are shape checks, not product knowledge: they name
 * graph kinds and generic property names, never a file, a symbol, a page or a
 * model.
 *
 * Three contract anomalies are not expressible from the graph the extractor
 * records, so no rule invents them: an unused import or export (symbols carry
 * no `exported` property and no `code.calls` edges exist), a handler no route
 * registers (a symbol carries no handler marker; only the route's
 * `handlerKey` names one), and a reference nobody makes. They stay with the
 * extractor until the graph records the fact.
 */
import { canonicalJsonDigest } from '../model/canonical.js';

export type SpanPolicy = 'required' | 'optional' | 'if-present';

export type GraphDirection = 'in' | 'out' | 'both';

/** A query over the edges incident to one item; `atLeast` is the count that satisfies it. */
export interface GraphNeighbourQuery {
  readonly direction: GraphDirection;
  /** Edge kinds the query counts; absent counts every kind. */
  readonly kinds?: readonly string[];
  /** Kinds of the item at the other end; absent accepts every kind. */
  readonly otherKinds?: readonly string[];
  readonly atLeast: number;
}

/**
 * A predicate over one item's neighbourhood. Conditions are data: `all`,
 * `any`, `not` and `target` compose them, and the engine only evaluates them.
 */
export type GraphCondition =
  | { readonly type: 'neighbours'; readonly query: GraphNeighbourQuery }
  | { readonly type: 'property'; readonly name: string; readonly equals?: string }
  | { readonly type: 'not'; readonly of: GraphCondition }
  | { readonly type: 'all'; readonly of: readonly GraphCondition[] }
  | { readonly type: 'any'; readonly of: readonly GraphCondition[] }
  /** At least one incident edge matching `query` whose other end satisfies `then`. */
  | { readonly type: 'target'; readonly query: GraphNeighbourQuery; readonly then: GraphCondition };

/** Why an item whose shape check passed still goes to a judge. */
export interface GraphEscalation {
  readonly id: string;
  readonly reason: string;
  readonly when: GraphCondition;
}

/** An escalation that applies to the kinds its selector names, before the rule's own list. */
export interface GraphKindEscalation extends GraphEscalation {
  readonly kind?: string;
  readonly kindPrefix?: string;
}

export interface GraphNodeRule {
  readonly id: string;
  readonly kind?: string;
  readonly kindPrefix?: string;
  readonly span: SpanPolicy;
  readonly requireProperties?: readonly string[];
  readonly requireOneOfProperties?: readonly string[];
  /** Properties that, when present, must name a whole count, 0 or more (a file's declared line count). */
  readonly requireWholeProperties?: readonly string[];
  readonly recordKeyPrefix?: string;
  readonly recordKeyHexLength?: number;
  readonly requireHexProperties?: readonly string[];
  /** Evidence kinds accepted from `properties.evidenceKind` or `properties.evidence[].kind`. */
  readonly requireEvidenceKinds?: readonly string[];
  /** The span names the item itself, as a `code.file` node's span names its own path. */
  readonly spanNamesSelf?: boolean;
  /** When evidence entries name a path and line, the path is read at the fill's commit and the line must be inside it. */
  readonly checkEvidenceLines?: boolean;
  /** Supporting facts the rule asks the engine to verify when the evidence resolves. */
  readonly evidenceNamesLabel?: boolean;
  /** Shapes that send a structurally valid item to a judge instead of passing it. */
  readonly escalate?: readonly GraphEscalation[];
}

export interface GraphEdgeRule {
  readonly id: string;
  readonly kind?: string;
  readonly kindPrefix?: string;
  readonly span: SpanPolicy;
  readonly fromKinds?: readonly string[];
  readonly toKinds?: readonly string[];
  readonly requireProperties?: readonly string[];
  /** A no-span edge of one of these kinds is valid when both endpoints are seen. */
  readonly structuralKinds?: readonly string[];
  /** A no-span edge with a byte position and a path in its properties is valid. */
  readonly permitPosition?: boolean;
}

/** The rules one run reads; a test may pass another set, and its digest is part of every cache key. */
export interface GraphRuleSet {
  readonly nodes: readonly GraphNodeRule[];
  readonly edges: readonly GraphEdgeRule[];
  readonly escalations: readonly GraphKindEscalation[];
}

/** The edge kinds whose meaning is the relation itself: both endpoints, no source text. */
export const SPANLESS_EDGE_KINDS: readonly string[] = [
  'code.authored',
  'code.backed-by',
  'code.carries',
  'code.changed-with',
  'code.cycle-member',
  'code.declares',
  'code.describes-file',
  'code.facet-of',
  'code.flows-into',
  'code.held',
  'code.parent',
  'code.renamed-to',
  'code.resolves',
  'code.tasks',
  'code.tests',
  'code.touched',
  'knowledge:grounded-by',
  'knowledge:mentions',
  'knowledge:relates',
  'knowledge:statement-of',
];

/** No incident edge at all: the owner's «если нет связей, это повод дать узел агенту». */
const NO_EDGE: GraphCondition = { type: 'not', of: { type: 'neighbours', query: { direction: 'both', atLeast: 1 } } };
const noEdge = (direction: GraphDirection, kinds: readonly string[], otherKinds?: readonly string[]): GraphCondition => ({
  type: 'not', of: { type: 'neighbours', query: { direction, kinds, ...(otherKinds === undefined ? {} : { otherKinds }), atLeast: 1 } },
});

/** Policies that apply to every node kind. A node with no edge is asked about, not silently valid. */
export const GRAPH_NODE_ESCALATIONS: readonly GraphKindEscalation[] = [
  { id: 'node-without-edge', kindPrefix: '', reason: 'a node with no edge', when: NO_EDGE },
];

export const GRAPH_NODE_RULES: readonly GraphNodeRule[] = [
  // A path the history no longer holds has a span and a record key; the pinned bytes decide it.
  { id: 'node-file', kind: 'code.file', span: 'required', spanNamesSelf: true, requireWholeProperties: ['lines'], recordKeyPrefix: 'code.file:' },
  {
    id: 'node-symbol', kind: 'code.symbol', span: 'required', requireProperties: ['path', 'name'], recordKeyPrefix: 'code.symbol:',
    escalate: [{ id: 'interface-without-implementation', reason: 'an interface with no implementation or reference', when: { type: 'all', of: [
      { type: 'property', name: 'symbolKind', equals: 'interface' },
      noEdge('in', ['code.implements', 'code.inherits', 'code.uses-type', 'code.references']),
    ] } }],
  },
  {
    id: 'node-database', kind: 'code.database', span: 'required', requireProperties: ['path'],
    requireEvidenceKinds: ['schema', 'connection', 'deployment-connection', 'driver'], checkEvidenceLines: true, evidenceNamesLabel: true,
    escalate: [{ id: 'database-without-table', reason: 'a database with no table, migration or use', when: NO_EDGE }],
  },
  {
    id: 'node-table', kind: 'code.table', span: 'required', requireProperties: ['database', 'schema'],
    escalate: [{ id: 'table-without-reader-or-writer', reason: 'a table nobody reads or writes', when: noEdge('in', ['code.reads-table', 'code.writes-table']) }],
  },
  { id: 'node-column', kind: 'code.column', span: 'required', requireProperties: ['type'] },
  {
    id: 'node-route', kind: 'code.route', span: 'required', requireProperties: ['method', 'path'],
    escalate: [{ id: 'route-without-handler', reason: 'a route with no registered handler', when: noEdge('out', ['code.handled-by']) }],
  },
  {
    id: 'node-operation', kind: 'code.operation', span: 'required', requireOneOfProperties: ['method', 'rpc'],
    escalate: [{ id: 'operation-without-route', reason: 'a contract operation no route serves', when: noEdge('in', ['code.serves']) }],
  },
  {
    id: 'node-channel', kind: 'code.channel', span: 'required',
    escalate: [{ id: 'channel-without-consumer', reason: 'a channel with no consumer', when: noEdge('in', ['code.consumes']) }],
  },
  {
    id: 'node-k8s-deployment', kind: 'code.k8s-deployment', span: 'required',
    escalate: [{ id: 'deployment-without-image', reason: 'a deployment with no image', when: { type: 'not', of: {
      type: 'neighbours', query: { direction: 'out', kinds: ['code.runs'], otherKinds: ['code.image'], atLeast: 1 } } } }],
  },
  {
    id: 'node-test-case', kind: 'code.test-case', span: 'required',
    escalate: [{ id: 'test-without-subject', reason: 'a test that tests nothing', when: noEdge('out', ['code.tests']) }],
  },
  {
    id: 'node-env-var', kind: 'code.env-var', span: 'required',
    escalate: [{ id: 'env-var-without-definition', reason: 'an environment variable read but defined nowhere', when: noEdge('in', ['code.defines']) }],
  },
  {
    id: 'node-env-definition', kind: 'code.env-definition', span: 'required',
    escalate: [{ id: 'env-definition-without-reader', reason: 'an environment variable defined but never read', when: { type: 'not', of: { type: 'target',
      query: { direction: 'out', kinds: ['code.defines'], atLeast: 1 },
      then: { type: 'neighbours', query: { direction: 'in', kinds: ['code.reads-env'], atLeast: 1 } } } } }],
  },
  { id: 'node-commit', kind: 'code.commit', span: 'optional', requireProperties: ['committedAt'], recordKeyPrefix: 'code.commit:', recordKeyHexLength: 40 },
  { id: 'node-snapshot', kind: 'code.snapshot', span: 'optional', requireProperties: ['commit'], requireHexProperties: ['commit'], recordKeyPrefix: 'code.snapshot:' },
  { id: 'node-task', kind: 'code.task', span: 'optional', recordKeyPrefix: 'code.task:' },
  { id: 'node-author', kind: 'code.author', span: 'optional', recordKeyPrefix: 'code.author:' },
  { id: 'node-repository', kind: 'code.repository', span: 'optional', requireProperties: ['path'] },
  { id: 'node-code-other', kindPrefix: 'code.', span: 'required' },
  { id: 'node-knowledge-page', kind: 'knowledge:page', span: 'optional', requireProperties: ['file', 'digest'] },
  { id: 'node-knowledge-section', kind: 'knowledge:section', span: 'optional', requireProperties: ['path', 'anchor'] },
  { id: 'node-knowledge-statement', kind: 'knowledge:statement', span: 'optional', requireProperties: ['page', 'line', 'text'] },
  { id: 'node-knowledge-product', kind: 'knowledge:product', span: 'optional', requireProperties: ['key'] },
  { id: 'node-knowledge-other', kindPrefix: 'knowledge:', span: 'optional' },
  { id: 'node-engine', kindPrefix: 'engine:', span: 'optional' },
  { id: 'node-fallback', kindPrefix: '', span: 'if-present' },
];

export const GRAPH_EDGE_RULES: readonly GraphEdgeRule[] = [
  { id: 'edge-uses-database', kind: 'code.uses-database', span: 'if-present', fromKinds: ['code.service'], toKinds: ['code.database'] },
  { id: 'edge-reads-table', kind: 'code.reads-table', span: 'if-present', fromKinds: ['code.symbol'], toKinds: ['code.table'] },
  { id: 'edge-writes-table', kind: 'code.writes-table', span: 'if-present', fromKinds: ['code.file', 'code.symbol'], toKinds: ['code.table'] },
  { id: 'edge-foreign-key', kind: 'code.foreign-key', span: 'if-present', fromKinds: ['code.table'], toKinds: ['code.table'], requireProperties: ['column', 'targetColumn'] },
  { id: 'edge-alters', kind: 'code.alters', span: 'if-present', fromKinds: ['code.migration'], toKinds: ['code.column', 'code.table'], requireProperties: ['object'] },
  { id: 'edge-covers', kind: 'code.covers', span: 'if-present', fromKinds: ['code.index'], toKinds: ['code.column'] },
  { id: 'edge-occurrence', kind: 'code.occurrence', span: 'optional', permitPosition: true },
  { id: 'edge-knowledge', kindPrefix: 'knowledge:', span: 'optional', structuralKinds: SPANLESS_EDGE_KINDS },
  { id: 'edge-fallback', kindPrefix: '', span: 'if-present', structuralKinds: SPANLESS_EDGE_KINDS, permitPosition: true },
];

/** The rule set a run reads when no other set is given. */
export const GRAPH_RULES: GraphRuleSet = { nodes: GRAPH_NODE_RULES, edges: GRAPH_EDGE_RULES, escalations: GRAPH_NODE_ESCALATIONS };

/** The digest of a rule set: a rule edit changes every cache key even without a validator-version change. */
export const graphVerdictRulesHash = (rules: GraphRuleSet = GRAPH_RULES): string => canonicalJsonDigest({
  version: 1,
  nodes: rules.nodes,
  edges: rules.edges,
  escalations: rules.escalations,
});

/** What a condition may inspect: its own kind and properties, and the items across its edges. */
export interface GraphConditionSubject {
  readonly kind: string;
  readonly properties: unknown;
  neighbours(query: GraphNeighbourQuery): readonly GraphConditionSubject[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/** Evaluates one rule-data condition; the engine never interprets a predicate itself. */
export function graphConditionHolds(condition: GraphCondition, subject: GraphConditionSubject): boolean {
  switch (condition.type) {
    case 'neighbours':
      return subject.neighbours(condition.query).length >= condition.query.atLeast;
    case 'property': {
      const value = isObject(subject.properties) ? subject.properties[condition.name] : undefined;
      return present(value) && (condition.equals === undefined || value === condition.equals);
    }
    case 'not':
      return !graphConditionHolds(condition.of, subject);
    case 'all':
      return condition.of.every((one) => graphConditionHolds(one, subject));
    case 'any':
      return condition.of.some((one) => graphConditionHolds(one, subject));
    case 'target':
      return subject.neighbours(condition.query).some((other) => graphConditionHolds(condition.then, other));
  }
}

/** The escalations that apply to a node of this kind: the kind-wide ones and the matched rule's own. */
export function escalationsForNode(rules: GraphRuleSet, kind: string, rule: GraphNodeRule): readonly GraphEscalation[] {
  const wide = rules.escalations.filter((one) => one.kindPrefix === undefined || kind.startsWith(one.kindPrefix)).filter((one) => one.kind === undefined || one.kind === kind);
  // The rule's own reason is more precise than "no edge at all": a route with no handler is asked about as such.
  return [...(rule.escalate ?? []), ...wide];
}

const exact = <T extends { kind?: string; kindPrefix?: string }>(rules: readonly T[], kind: string): T | undefined => rules.find((rule) => rule.kind === kind);
const prefix = <T extends { kind?: string; kindPrefix?: string }>(rules: readonly T[], kind: string): T | undefined => {
  let found: T | undefined;
  for (const rule of rules) {
    if (rule.kindPrefix === undefined) continue;
    if (!kind.startsWith(rule.kindPrefix)) continue;
    if (found === undefined || (found.kindPrefix?.length ?? -1) < rule.kindPrefix.length) found = rule;
  }
  return found;
};
const match = <T extends { kind?: string; kindPrefix?: string }>(rules: readonly T[], kind: string): T => {
  const rule = exact(rules, kind) ?? prefix(rules, kind);
  if (rule === undefined) throw new Error(`src/knowledge/graph-verdict-rules.ts:1: no rule matches the graph kind ${JSON.stringify(kind)}; full path ${import.meta.dir}/graph-verdict-rules.ts`);
  return rule;
};

export const nodeRuleFor = (kind: string, rules: readonly GraphNodeRule[] = GRAPH_NODE_RULES): GraphNodeRule => match(rules, kind);
export const edgeRuleFor = (kind: string, rules: readonly GraphEdgeRule[] = GRAPH_EDGE_RULES): GraphEdgeRule => match(rules, kind);
