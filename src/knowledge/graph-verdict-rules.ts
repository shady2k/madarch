/**
 * The deterministic rules for graph verdicts (madarch-mwhd.1), as data the
 * engine reads. Every node and every edge kind is matched by exactly one rule:
 * an exact kind, then the longest kind prefix, then the fallback. A rule may
 * require properties, a record key, a source span, evidence lines, or endpoint
 * kinds; the engine alone turns those requirements into a verdict.
 *
 * The rules are shape checks, not product knowledge: they name graph kinds and
 * generic property names, never a file, a symbol, a page or a model.
 */

export type SpanPolicy = 'required' | 'optional' | 'if-present';

export interface GraphNodeRule {
  readonly id: string;
  readonly kind?: string;
  readonly kindPrefix?: string;
  readonly span: SpanPolicy;
  readonly requireProperties?: readonly string[];
  readonly requireOneOfProperties?: readonly string[];
  readonly recordKeyPrefix?: string;
  readonly recordKeyHexLength?: number;
  readonly requireHexProperties?: readonly string[];
  /** Evidence kinds accepted from `properties.evidenceKind` or `properties.evidence[].kind`. */
  readonly requireEvidenceKinds?: readonly string[];
  /** The span names the item itself, as a `code.file` node's span names its own path. */
  readonly spanNamesSelf?: boolean;
  /** When evidence entries name a path and line, the path must be a `code.file` and the line inside it. */
  readonly checkEvidenceLines?: boolean;
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

export const GRAPH_NODE_RULES: readonly GraphNodeRule[] = [
  // A path the history no longer holds has a span and a record key but no bytes, line count or digest.
  { id: 'node-file', kind: 'code.file', span: 'required', spanNamesSelf: true, recordKeyPrefix: 'code.file:' },
  { id: 'node-symbol', kind: 'code.symbol', span: 'required', requireProperties: ['path', 'name'], recordKeyPrefix: 'code.symbol:' },
  { id: 'node-database', kind: 'code.database', span: 'required', requireProperties: ['path'], requireEvidenceKinds: ['schema', 'connection', 'deployment-connection', 'driver'], checkEvidenceLines: true },
  { id: 'node-table', kind: 'code.table', span: 'required', requireProperties: ['database', 'schema'] },
  { id: 'node-column', kind: 'code.column', span: 'required', requireProperties: ['type'] },
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

export const nodeRuleFor = (kind: string): GraphNodeRule => match(GRAPH_NODE_RULES, kind);
export const edgeRuleFor = (kind: string): GraphEdgeRule => match(GRAPH_EDGE_RULES, kind);
