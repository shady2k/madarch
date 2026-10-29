/**
 * Graph verdicts (madarch-mwhd.1): every current node and edge of a filled
 * product is `valid`, `invalid` or `unreviewed`, with one line saying why.
 *
 * The deterministic rules in `graph-verdict-rules.ts` run first. An item a rule
 * cannot decide goes to a judge in batches of at most 50. The chain is jev,
 * then classification, then analysis: each tier reads what the last left
 * `unsure`, and what analysis still cannot decide leaves it for a person.
 * A judge that could not run leaves its items unjudged, never valid.
 *
 * Every row carries an evidence hash. An unchanged neighbourhood and an
 * unchanged validator version reuse the verdict; a changed node or edge
 * revalidates itself and its incident edges, and nothing else. The cache and
 * the two budgets live beside the product's store, not in the graph.
 */
import { createHash } from 'node:crypto';
import type { ModelPair, ModelRole, ModelRoleView } from './model-roles.js';
import { roleOf } from './model-roles.js';
import { edgeRuleFor, nodeRuleFor, type GraphEdgeRule, type GraphNodeRule, type SpanPolicy } from './graph-verdict-rules.js';

export const GRAPH_VERDICT_VALIDATOR_VERSION = '1';
export const JUDGE_BATCH_SIZE = 50;

export interface GraphVerdictBudgets {
  /** Items a single run admits to judging; the rest are reported unreviewed. */
  readonly itemsPerRun: number;
  /** Judge calls a single run may make; each batch of up to 50 items is one call. */
  readonly modelCallsPerRun: number;
}

export const DEFAULT_GRAPH_VERDICT_BUDGETS: GraphVerdictBudgets = { itemsPerRun: 400, modelCallsPerRun: 4 };

export type GraphVerdict = 'valid' | 'invalid' | 'unreviewed';
export type GraphVerdictRole = 'node' | 'edge';
export type GraphVerdictSource = 'rule' | 'jev' | 'classification' | 'analysis' | 'person' | 'none' | 'budget' | 'judge-failed';

export interface GraphNodeItem {
  readonly id: string;
  readonly versionId?: string;
  readonly kind: string;
  readonly label: string;
  readonly properties: unknown;
}

export interface GraphEdgeItem {
  readonly id: string;
  readonly versionId?: string;
  readonly kind: string;
  readonly label?: string;
  readonly from: string;
  readonly to: string;
  readonly discriminator?: string;
  readonly position?: { readonly start: number; readonly end: number };
  readonly properties: unknown;
}

export interface GraphSnapshot {
  readonly nodes: readonly GraphNodeItem[];
  readonly edges: readonly GraphEdgeItem[];
}

export interface GraphEvidenceFile {
  readonly path: string;
  readonly lines: number;
  readonly sha256?: string;
}

export interface GraphVerdictRow {
  readonly role: GraphVerdictRole;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly verdict: GraphVerdict;
  readonly reason: string;
  /** The rule that decided it, or the tier that judged it. */
  readonly rule: string;
  readonly source: GraphVerdictSource;
  readonly tier?: string;
}

export interface GraphVerdictKindReport {
  readonly role: GraphVerdictRole;
  readonly kind: string;
  readonly total: number;
  readonly valid: number;
  readonly invalid: number;
  readonly unreviewed: number;
}

export interface GraphVerdictReasonReport {
  readonly reason: string;
  readonly count: number;
}

export interface GraphVerdictReport {
  readonly generatedAt: string;
  readonly validatorVersion: string;
  readonly budgets: GraphVerdictBudgets;
  readonly totals: {
    readonly items: number;
    readonly nodes: number;
    readonly edges: number;
    readonly valid: number;
    readonly invalid: number;
    readonly unreviewed: number;
  };
  readonly byKind: readonly GraphVerdictKindReport[];
  readonly sources: readonly { readonly source: GraphVerdictSource; readonly count: number }[];
  /** Distinct reasons for items that are not valid, most frequent first. */
  readonly reasons: readonly GraphVerdictReasonReport[];
}

export interface GraphVerdictCacheEntry extends GraphVerdictRow {
  readonly evidenceHash: string;
  readonly configHash: string;
}

export interface GraphVerdictCache {
  readonly validatorVersion: string;
  readonly generatedAt: string;
  readonly fingerprint: string;
  readonly budgets: GraphVerdictBudgets;
  readonly entries: Record<string, GraphVerdictCacheEntry>;
}

export interface GraphJudgeEvidence {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface GraphJudgeItem {
  readonly id: string;
  readonly role: GraphVerdictRole;
  readonly kind: string;
  readonly label: string;
  readonly reason: string;
  readonly evidence: readonly GraphJudgeEvidence[];
  readonly properties: unknown;
  readonly from?: { readonly id: string; readonly kind: string; readonly label: string };
  readonly to?: { readonly id: string; readonly kind: string; readonly label: string };
}

export interface GraphJudgeAnswer {
  readonly id: string;
  readonly verdict: 'valid' | 'invalid' | 'unsure';
  readonly reason: string;
}

export interface GraphJudge {
  judge(items: readonly GraphJudgeItem[]): Promise<readonly GraphJudgeAnswer[]>;
  close?(): Promise<void>;
}

export type GraphJudgeFactory = (pair: ModelPair, role: 'classification' | 'analysis') => GraphJudge | { readonly error: string };

export interface GraphVerdictRunOptions {
  readonly snapshot: GraphSnapshot;
  readonly roles: ModelRoleView;
  readonly previous?: GraphVerdictCache;
  readonly budgets?: Partial<GraphVerdictBudgets>;
  readonly validatorVersion?: string;
  readonly jev?: GraphJudge | null;
  /** Starts a role's judge on demand. Absent means no role judge can be started. */
  readonly judgeFor?: GraphJudgeFactory;
  readonly now?: () => Date;
}

/** The rows a cache holds, for a no-op rerun that must still answer with the report. */
export function graphVerdictRows(cache: GraphVerdictCache): GraphVerdictRow[] {
  return Object.values(cache.entries)
    .map((entry): GraphVerdictRow => ({
      role: entry.role, id: entry.id, kind: entry.kind, label: entry.label,
      verdict: entry.verdict, reason: entry.reason, rule: entry.rule,
      source: entry.source, ...(entry.tier === undefined ? {} : { tier: entry.tier }),
    }))
    .sort((a, b) => a.role === b.role ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.role === 'node' ? -1 : 1));
}

export interface GraphVerdictMetrics {
  /** Items whose evidence changed and was decided in this run. */
  readonly checked: number;
  /** Items whose saved verdict was used unchanged. */
  readonly reused: number;
  /** Items actually sent to a judge; admitted items with no judge stay zero. */
  readonly judgeItems: number;
  /** Judge calls this run attempted. */
  readonly modelCalls: number;
}

export interface GraphVerdictResult {
  readonly rows: readonly GraphVerdictRow[];
  readonly report: GraphVerdictReport;
  readonly cache: GraphVerdictCache;
  readonly metrics: GraphVerdictMetrics;
}

type Span = { path: string; lineStart?: number; lineEnd?: number };
type Props = Record<string, unknown>;

const isObject = (value: unknown): value is Props => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A judge's reason is stored as one line, whatever whitespace it used. */
const oneLine = (text: string): string => text.trim().replace(/\s+/g, ' ');
const propsOf = (value: unknown): Props => isObject(value) ? value : {};
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
const isHex = (text: string): boolean => text.length > 0 && [...text].every((character) => (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  const held: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const one = value[key];
    if (one !== undefined) held[key] = stable(one);
  }
  return held;
};
const canonical = (value: unknown): string => JSON.stringify(stable(value));
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

const spanOf = (properties: unknown): Span | undefined => {
  const props = propsOf(properties);
  const span = isObject(props.span) ? props.span : undefined;
  if (span === undefined || typeof span.path !== 'string' || span.path === '') return undefined;
  return {
    path: span.path,
    ...(typeof span.lineStart === 'number' ? { lineStart: span.lineStart } : {}),
    ...(typeof span.lineEnd === 'number' ? { lineEnd: span.lineEnd } : {}),
  };
};

const pathOf = (properties: unknown): string | undefined => {
  const props = propsOf(properties);
  const direct = props.path;
  if (typeof direct === 'string' && direct !== '') return direct;
  const span = spanOf(properties);
  if (span !== undefined) return span.path;
  const origins = props.origins;
  if (Array.isArray(origins)) {
    for (const origin of origins) {
      const source = isObject(origin) ? origin.sourceSpan : undefined;
      const path = isObject(source) ? source.path : undefined;
      if (typeof path === 'string' && path !== '') return path;
    }
  }
  const origin = isObject(props.origin) ? props.origin : undefined;
  const importSpan = origin === undefined ? undefined : origin.importSpan;
  const path = isObject(importSpan) ? importSpan.path : undefined;
  return typeof path === 'string' && path !== '' ? path : undefined;
};

const checkSpan = (properties: unknown, files: ReadonlyMap<string, GraphEvidenceFile>, role: GraphVerdictRole, namesSelf = false): string | undefined => {
  const span = spanOf(properties);
  if (span === undefined) return `${role} has no source span`;
  const file = files.get(span.path);
  if (file === undefined && !(namesSelf && pathOf(properties) === span.path)) return `${role} span names ${JSON.stringify(span.path)}, which is not a code.file in this graph`;
  if (span.lineStart === undefined || span.lineEnd === undefined) return `${role} span in ${JSON.stringify(span.path)} has no line range`;
  if (!Number.isInteger(span.lineStart) || !Number.isInteger(span.lineEnd)) return `${role} span in ${JSON.stringify(span.path)} does not name whole lines`;
  if (span.lineStart < 1 || span.lineEnd < span.lineStart) return `${role} span in ${JSON.stringify(span.path)} has the line range ${span.lineStart}-${span.lineEnd}`;
  if (file !== undefined && (span.lineStart > file.lines || span.lineEnd > file.lines + 1)) return `${role} span ${span.path}:${span.lineStart}-${span.lineEnd} is outside the file, which has ${file.lines} lines`;
  return undefined;
};

const checkSpanPolicy = (policy: SpanPolicy, properties: unknown, files: ReadonlyMap<string, GraphEvidenceFile>, role: GraphVerdictRole, namesSelf = false): string | undefined => {
  if (policy === 'optional' && spanOf(properties) === undefined) return undefined;
  if (policy === 'if-present' && spanOf(properties) === undefined) return undefined;
  return checkSpan(properties, files, role, namesSelf);
};

const missingProperty = (properties: unknown, names: readonly string[], role: GraphVerdictRole): string | undefined => {
  const props = propsOf(properties);
  for (const name of names) if (!present(props[name])) return `${role} has no ${JSON.stringify(name)}`;
  return undefined;
};

const evidenceKinds = (properties: unknown): string[] => {
  const props = propsOf(properties);
  const kinds: string[] = [];
  if (typeof props.evidenceKind === 'string') kinds.push(props.evidenceKind);
  if (Array.isArray(props.evidence)) for (const entry of props.evidence) {
    const kind = isObject(entry) ? entry.kind : undefined;
    if (typeof kind === 'string') kinds.push(kind);
  }
  return kinds;
};

const nodeProblems = (item: GraphNodeItem, rule: GraphNodeRule, files: ReadonlyMap<string, GraphEvidenceFile>): string | undefined => {
  const missing = missingProperty(item.properties, rule.requireProperties ?? [], 'node');
  if (missing !== undefined) return missing;
  if (rule.requireOneOfProperties !== undefined && rule.requireOneOfProperties.length > 0) {
    const props = propsOf(item.properties);
    if (!rule.requireOneOfProperties.some((name) => present(props[name]))) return `node has none of ${rule.requireOneOfProperties.map((name) => JSON.stringify(name)).join(', ')}`;
  }
  if (rule.recordKeyPrefix !== undefined || rule.recordKeyHexLength !== undefined) {
    const recordKey = propsOf(item.properties).recordKey;
    if (typeof recordKey !== 'string') return 'node has no "recordKey"';
    if (rule.recordKeyPrefix !== undefined && !recordKey.startsWith(rule.recordKeyPrefix)) return `node recordKey ${JSON.stringify(recordKey)} does not start with ${JSON.stringify(rule.recordKeyPrefix)}`;
    if (rule.recordKeyHexLength !== undefined) {
      const suffix = recordKey.slice(rule.recordKeyPrefix?.length ?? 0);
      if (suffix.length !== rule.recordKeyHexLength || !isHex(suffix)) return `node recordKey ${JSON.stringify(recordKey)} does not end in ${rule.recordKeyHexLength} lowercase hex characters`;
    }
  }
  for (const name of rule.requireHexProperties ?? []) {
    const value = propsOf(item.properties)[name];
    if (typeof value !== 'string' || value.length !== 40 || !isHex(value)) return `node property ${JSON.stringify(name)} is not a 40-character commit id`;
  }
  if (rule.requireEvidenceKinds !== undefined) {
    const seen = evidenceKinds(item.properties);
    if (!rule.requireEvidenceKinds.some((kind) => seen.includes(kind))) return `node has no schema or connection evidence (${rule.requireEvidenceKinds.join(', ')}); an invented database has none`;
  }
  if (rule.checkEvidenceLines === true) {
    const evidence = propsOf(item.properties).evidence;
    if (!Array.isArray(evidence)) return 'node evidence is not a list of source places';
    for (const entry of evidence) {
      const held = propsOf(entry);
      const path = held.path;
      const line = held.line;
      if (typeof path !== 'string' || path === '') return 'node evidence names no path';
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return `node evidence in ${JSON.stringify(path)} names no whole line`;
      const file = files.get(path);
      if (file === undefined) return `node evidence names ${JSON.stringify(path)}, which is not a code.file in this graph`;
      if (line > file.lines) return `node evidence ${path}:${line} is outside the file, which has ${file.lines} lines`;
    }
  }
  return checkSpanPolicy(rule.span, item.properties, files, 'node', rule.spanNamesSelf === true);
};

const edgeProblems = (item: GraphEdgeItem, rule: GraphEdgeRule, nodes: ReadonlyMap<string, GraphNodeItem>, files: ReadonlyMap<string, GraphEvidenceFile>): string | undefined => {
  const from = nodes.get(item.from);
  const to = nodes.get(item.to);
  if (from === undefined) return `edge endpoint ${JSON.stringify(item.from)} is not a node in this graph`;
  if (to === undefined) return `edge endpoint ${JSON.stringify(item.to)} is not a node in this graph`;
  if (rule.fromKinds !== undefined && !rule.fromKinds.includes(from.kind)) return `edge starts at a ${from.kind}, and ${rule.id} starts at ${rule.fromKinds.join(' or ')}`;
  if (rule.toKinds !== undefined && !rule.toKinds.includes(to.kind)) return `edge ends at a ${to.kind}, and ${rule.id} ends at ${rule.toKinds.join(' or ')}`;
  const missing = missingProperty(item.properties, rule.requireProperties ?? [], 'edge');
  if (missing !== undefined) return missing;
  const span = spanOf(item.properties);
  if (span !== undefined) return checkSpan(item.properties, files, 'edge');
  if (rule.span === 'required') return 'edge has no source span';
  if (rule.structuralKinds?.includes(item.kind) === true) return undefined;
  if (rule.permitPosition === true && item.position !== undefined && pathOf(item.properties) !== undefined) return undefined;
  return undefined;
};

const decided = (reason: string | undefined, undecided: string): { verdict: GraphVerdict; reason: string } => reason === undefined
  ? { verdict: 'valid', reason: 'the rule found its required source evidence' }
  : { verdict: 'invalid', reason };

const isUndecidedNode = (item: GraphNodeItem, rule: GraphNodeRule, files: ReadonlyMap<string, GraphEvidenceFile>): boolean => {
  if (rule.id !== 'node-fallback') return false;
  return spanOf(item.properties) === undefined;
};
const isUndecidedEdge = (item: GraphEdgeItem, rule: GraphEdgeRule, nodes: ReadonlyMap<string, GraphNodeItem>, files: ReadonlyMap<string, GraphEvidenceFile>): boolean => {
  if (rule.id !== 'edge-fallback') return false;
  if (spanOf(item.properties) !== undefined || rule.structuralKinds?.includes(item.kind) === true) return false;
  if (rule.permitPosition === true && item.position !== undefined && pathOf(item.properties) !== undefined) return false;
  return nodes.has(item.from) && nodes.has(item.to);
};

const sourceRank: readonly GraphVerdictSource[] = ['rule', 'jev', 'classification', 'analysis', 'person', 'none', 'budget', 'judge-failed'];

export function graphVerdictReport(rows: readonly GraphVerdictRow[], budgets: GraphVerdictBudgets, validatorVersion: string, generatedAt: string): GraphVerdictReport {
  const byKind = new Map<string, GraphVerdictKindReport>();
  const sources = new Map<GraphVerdictSource, number>();
  const reasons = new Map<string, number>();
  let nodes = 0;
  let edges = 0;
  let valid = 0;
  let invalid = 0;
  let unreviewed = 0;
  for (const row of rows) {
    if (row.role === 'node') nodes += 1; else edges += 1;
    if (row.verdict === 'valid') valid += 1;
    else if (row.verdict === 'invalid') invalid += 1;
    else unreviewed += 1;
    const key = `${row.role}\u0000${row.kind}`;
    const held = byKind.get(key) ?? { role: row.role, kind: row.kind, total: 0, valid: 0, invalid: 0, unreviewed: 0 };
    byKind.set(key, {
      ...held,
      total: held.total + 1,
      valid: held.valid + (row.verdict === 'valid' ? 1 : 0),
      invalid: held.invalid + (row.verdict === 'invalid' ? 1 : 0),
      unreviewed: held.unreviewed + (row.verdict === 'unreviewed' ? 1 : 0),
    });
    sources.set(row.source, (sources.get(row.source) ?? 0) + 1);
    if (row.verdict !== 'valid') reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
  }
  return {
    generatedAt,
    validatorVersion,
    budgets,
    totals: { items: rows.length, nodes, edges, valid, invalid, unreviewed },
    byKind: [...byKind.values()].sort((a, b) => a.role === b.role ? (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) : (a.role === 'node' ? -1 : 1)),
    sources: sourceRank.filter((source) => (sources.get(source) ?? 0) > 0).map((source) => ({ source, count: sources.get(source)! })),
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
  };
}

export function graphVerdictFingerprint(snapshot: GraphSnapshot, roles: ModelRoleView, budgets: GraphVerdictBudgets, validatorVersion = GRAPH_VERDICT_VALIDATOR_VERSION, hasJev = false, hasJudge = hasJev): string {
  return digest({
    validatorVersion,
    budgets,
    hasJev,
    hasJudge,
    roles: roles.roles.map((role) => ({ role: role.role, pair: role.pair })),
    nodes: snapshot.nodes.map((node) => ({ id: node.id, versionId: node.versionId, kind: node.kind, label: node.label, properties: node.properties })).sort((a, b) => a.id < b.id ? -1 : 1),
    edges: snapshot.edges.map((edge) => ({ id: edge.id, versionId: edge.versionId, kind: edge.kind, from: edge.from, to: edge.to, discriminator: edge.discriminator, position: edge.position, properties: edge.properties })).sort((a, b) => a.id < b.id ? -1 : 1),
  });
}

function filesOf(snapshot: GraphSnapshot): Map<string, GraphEvidenceFile> {
  const files = new Map<string, GraphEvidenceFile>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'code.file') continue;
    const props = propsOf(node.properties);
    const path = props.path;
    const lines = props.lines;
    if (typeof path !== 'string' || path === '' || typeof lines !== 'number' || !Number.isInteger(lines) || lines < 0) continue;
    files.set(path, { path, lines, ...(typeof props.sha256 === 'string' ? { sha256: props.sha256 } : {}) });
  }
  return files;
}

function referencedPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const walk = (held: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(held)) { for (const one of held) walk(one, depth + 1); return; }
    if (!isObject(held)) return;
    if (typeof held.path === 'string' && held.path !== '') paths.add(held.path);
    for (const key of ['span', 'sourceSpan', 'importSpan', 'origins', 'evidence']) walk(held[key], depth + 1);
  };
  walk(value, 0);
  return [...paths].sort();
}

function itemHash(value: unknown, paths: readonly string[], files: ReadonlyMap<string, GraphEvidenceFile>, validatorVersion: string): string {
  return digest({
    validatorVersion,
    item: value,
    files: paths.map((path) => files.get(path) ?? { path, missing: true }),
  });
}

export async function runGraphVerdicts(options: GraphVerdictRunOptions): Promise<GraphVerdictResult> {
  const validatorVersion = options.validatorVersion ?? GRAPH_VERDICT_VALIDATOR_VERSION;
  const budgets: GraphVerdictBudgets = {
    itemsPerRun: options.budgets?.itemsPerRun ?? DEFAULT_GRAPH_VERDICT_BUDGETS.itemsPerRun,
    modelCallsPerRun: options.budgets?.modelCallsPerRun ?? DEFAULT_GRAPH_VERDICT_BUDGETS.modelCallsPerRun,
  };
  if (!Number.isInteger(budgets.itemsPerRun) || budgets.itemsPerRun < 0) throw new Error(`src/knowledge/graph-verdicts.ts:1: itemsPerRun is ${budgets.itemsPerRun}; it is a whole number of items, 0 or more; full path ${import.meta.dir}/graph-verdicts.ts`);
  if (!Number.isInteger(budgets.modelCallsPerRun) || budgets.modelCallsPerRun < 0) throw new Error(`src/knowledge/graph-verdicts.ts:1: modelCallsPerRun is ${budgets.modelCallsPerRun}; it is a whole number of judge calls, 0 or more; full path ${import.meta.dir}/graph-verdicts.ts`);
  const now = options.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const snapshot = options.snapshot;
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const files = filesOf(snapshot);
  const edgesByNode = new Map<string, GraphEdgeItem[]>();
  for (const edge of snapshot.edges) {
    for (const id of new Set([edge.from, edge.to])) {
      const held = edgesByNode.get(id) ?? [];
      held.push(edge);
      edgesByNode.set(id, held);
    }
  }
  const nodeCore = (node: GraphNodeItem): unknown => ({ id: node.id, versionId: node.versionId, kind: node.kind, label: node.label, properties: node.properties });
  const edgeCore = (edge: GraphEdgeItem): unknown => ({ id: edge.id, versionId: edge.versionId, kind: edge.kind, from: edge.from, to: edge.to, discriminator: edge.discriminator, position: edge.position, properties: edge.properties });
  const hasJev = options.jev !== undefined && options.jev !== null;
  const hasJudge = hasJev || options.judgeFor !== undefined;
  const configHash = digest({ validatorVersion, budgets, hasJev, hasJudge, roles: options.roles.roles.map((role) => ({ role: role.role, pair: role.pair })) });
  const previous = options.previous;
  const previousEntries = previous !== undefined && previous.validatorVersion === validatorVersion ? previous.entries : {};
  const rows: GraphVerdictRow[] = [];
  const entries: Record<string, GraphVerdictCacheEntry> = {};
  const pending: { base: GraphVerdictRow; hash: string; item: GraphJudgeItem; rule: string }[] = [];
  let reused = 0;
  let checked = 0;

  const remember = (entry: GraphVerdictCacheEntry): void => {
    entries[`${entry.role}:${entry.id}`] = entry;
    const row: GraphVerdictRow = {
      role: entry.role, id: entry.id, kind: entry.kind, label: entry.label,
      verdict: entry.verdict, reason: entry.reason, rule: entry.rule,
      source: entry.source, ...(entry.tier === undefined ? {} : { tier: entry.tier }),
    };
    const at = rows.findIndex((held) => held.role === row.role && held.id === row.id);
    if (at === -1) rows.push(row); else rows[at] = row;
  };

  for (const node of snapshot.nodes) {
    const rule = nodeRuleFor(node.kind);
    const hash = itemHash({ node: nodeCore(node), neighbourhood: (edgesByNode.get(node.id) ?? []).map((edge) => ({ edge: edgeCore(edge), other: nodes.get(edge.from === node.id ? edge.to : edge.from) })) }, referencedPaths(node.properties), files, validatorVersion);
    const held = previousEntries[`node:${node.id}`];
    if (held !== undefined && held.evidenceHash === hash && (held.verdict !== 'unreviewed' || held.configHash === configHash)) {
      remember(held);
      reused += 1;
      continue;
    }
    checked += 1;
    const undecided = isUndecidedNode(node, rule, files);
    if (undecided) {
      pending.push({
        base: { role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'unreviewed', reason: 'no rule decides this node', rule: rule.id, source: 'none' },
        hash,
        rule: rule.id,
        item: { id: node.id, role: 'node', kind: node.kind, label: node.label, reason: 'no rule decides this node', evidence: evidenceOf(node.properties), properties: node.properties },
      });
      continue;
    }
    const answer = decided(nodeProblems(node, rule, files), 'no rule decides this node');
    remember({ role: 'node', id: node.id, kind: node.kind, label: node.label, ...answer, rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
  }

  for (const edge of snapshot.edges) {
    const rule = edgeRuleFor(edge.kind);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const hash = itemHash({ edge: edgeCore(edge), from: from === undefined ? undefined : nodeCore(from), to: to === undefined ? undefined : nodeCore(to) }, referencedPaths([edge.properties, from?.properties, to?.properties]), files, validatorVersion);
    const held = previousEntries[`edge:${edge.id}`];
    if (held !== undefined && held.evidenceHash === hash && (held.verdict !== 'unreviewed' || held.configHash === configHash)) {
      remember(held);
      reused += 1;
      continue;
    }
    checked += 1;
    const undecided = isUndecidedEdge(edge, rule, nodes, files);
    if (undecided) {
      pending.push({
        base: { role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, verdict: 'unreviewed', reason: 'no rule decides this edge', rule: rule.id, source: 'none' },
        hash,
        rule: rule.id,
        item: {
          id: edge.id, role: 'edge', kind: edge.kind, label: edge.label ?? edge.id,
          reason: 'no rule decides this edge', evidence: evidenceOf(edge.properties), properties: edge.properties,
          ...(from === undefined ? {} : { from: { id: from.id, kind: from.kind, label: from.label } }),
          ...(to === undefined ? {} : { to: { id: to.id, kind: to.kind, label: to.label } }),
        },
      });
      continue;
    }
    const answer = decided(edgeProblems(edge, rule, nodes, files), 'no rule decides this edge');
    remember({ role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, ...answer, rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
  }

  const admitted = pending.slice(0, budgets.itemsPerRun);
  for (const waiting of pending.slice(budgets.itemsPerRun)) {
    remember({ ...waiting.base, reason: `budget: ${pending.length - budgets.itemsPerRun} items are waiting; this run admits at most ${budgets.itemsPerRun} to judging`, source: 'budget', evidenceHash: waiting.hash, configHash });
  }

  const jev = options.jev ?? null;
  const classification = roleOf(options.roles, 'classification');
  const analysis = roleOf(options.roles, 'analysis');
  const created: GraphJudge[] = [];
  let modelCalls = 0;
  let judgeItems = 0;
  const newJudge = (pair: ModelPair, role: 'classification' | 'analysis'): GraphJudge | string => {
    if (options.judgeFor === undefined) return 'no judge factory is configured';
    const made = options.judgeFor(pair, role);
    if ('error' in made) return made.error;
    created.push(made);
    return made;
  };
  const canCall = (): boolean => modelCalls < budgets.modelCallsPerRun;

  const apply = async (judge: GraphJudge, batch: typeof admitted, tier: 'jev' | 'classification' | 'analysis'): Promise<GraphVerdictRow[]> => {
    modelCalls += 1;
    judgeItems += batch.length;
    let answers: readonly GraphJudgeAnswer[];
    try {
      answers = await judge.judge(batch.map((one) => one.item));
    } catch (error) {
      const message = oneLine(error instanceof Error ? error.message : String(error));
      return batch.map((one) => ({ ...one.base, verdict: 'unreviewed', reason: `the ${tier} judge failed: ${message}`, source: 'judge-failed' as const }));
    }
    const byId = new Map<string, GraphJudgeAnswer>();
    for (const answer of answers) if (!byId.has(answer.id)) byId.set(answer.id, answer);
    return batch.map((one): GraphVerdictRow => {
      const answer = byId.get(one.item.id);
      if (answer === undefined) return { ...one.base, verdict: 'unreviewed', reason: `the ${tier} judge returned no verdict for this ${one.base.role}`, source: 'judge-failed' };
      if (answer.verdict !== 'valid' && answer.verdict !== 'invalid' && answer.verdict !== 'unsure') return { ...one.base, verdict: 'unreviewed', reason: `the ${tier} judge answered ${JSON.stringify((answer as { verdict?: unknown }).verdict)}, which is not valid, invalid or unsure`, source: 'judge-failed' };
      const reason = typeof answer.reason === 'string' && answer.reason.trim() !== '' ? oneLine(answer.reason) : `the ${tier} judge gave no reason`;
      return { ...one.base, verdict: answer.verdict === 'unsure' ? 'unreviewed' : answer.verdict, reason, rule: one.rule, source: answer.verdict === 'unsure' ? 'none' : tier, tier };
    });
  };

  const saveJudged = (row: GraphVerdictRow, hash: string): void => {
    remember({ ...row, evidenceHash: hash, configHash });
  };

  if (admitted.length > 0) {
    type Pending = (typeof admitted)[number];
    interface Unsure { readonly one: Pending; readonly row: GraphVerdictRow }
    const keyOf = (one: Pending): string => `${one.base.role}\u0000${one.base.id}`;
    const unsureReason = new Map<string, string>();
    // Each tier reads only what the tier before it left unsure. An execution failure is saved as judge-failed and
    // is not handed on: nothing was read, so a later tier must not turn it into a verdict.
    const runTier = async (judge: GraphJudge, items: typeof admitted, tier: 'jev' | 'classification' | 'analysis'): Promise<Unsure[]> => {
      const unsure: Unsure[] = [];
      for (let offset = 0; offset < items.length; offset += JUDGE_BATCH_SIZE) {
        const batch = items.slice(offset, offset + JUDGE_BATCH_SIZE);
        if (!canCall()) {
          const waiting = items.length - offset;
          const reason = tier === 'analysis'
            ? `budget: this run allows ${budgets.modelCallsPerRun} judge calls; classification stayed unsure and ${waiting} items did not reach analysis`
            : `budget: this run allows ${budgets.modelCallsPerRun} judge calls; ${waiting} items were not judged`;
          for (const one of items.slice(offset)) remember({ ...one.base, verdict: 'unreviewed', reason, source: 'budget', evidenceHash: one.hash, configHash });
          break;
        }
        const answered = await apply(judge, batch, tier);
        for (let index = 0; index < batch.length; index += 1) {
          const one = batch[index]!;
          const row = answered[index]!;
          saveJudged(row, one.hash);
          if (row.verdict === 'unreviewed' && row.source === 'none' && row.tier === tier) {
            unsure.push({ one, row });
            unsureReason.set(keyOf(one), row.reason);
          }
        }
      }
      return unsure;
    };
    const toPerson = (held: Unsure, reason: string): void => {
      remember({ ...held.row, reason, source: 'person', evidenceHash: held.one.hash, configHash });
    };

    let remaining = admitted;
    let lastUnsure: Unsure[] = [];
    if (jev !== null) {
      lastUnsure = await runTier(jev, remaining, 'jev');
      remaining = lastUnsure.map((held) => held.one);
      if (remaining.length > 0 && classification.pair === null) {
        for (const held of lastUnsure) {
          toPerson(held, `${held.row.reason}; classification is unassigned and there is no default pair to fall back to, so a person reads this item`);
        }
        remaining = [];
        lastUnsure = [];
      }
    } else if (classification.pair === null) {
      for (const one of admitted) remember({ ...one.base, verdict: 'unreviewed', reason: 'no judge is assigned: assign Classification and Analysis in /k/settings (section Model roles)', source: 'none', evidenceHash: one.hash, configHash });
      remaining = [];
    }

    if (remaining.length > 0 && !canCall()) {
      for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `budget: this run allows ${budgets.modelCallsPerRun} judge calls; ${remaining.length} items were not judged`, source: 'budget', evidenceHash: one.hash, configHash });
      remaining = [];
      lastUnsure = [];
    } else if (remaining.length > 0) {
      const first = newJudge(classification.pair!, 'classification');
      if (typeof first === 'string') {
        for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `the classification judge could not start: ${oneLine(first)}`, source: 'judge-failed', evidenceHash: one.hash, configHash });
        remaining = [];
        lastUnsure = [];
      } else {
        lastUnsure = await runTier(first, remaining, 'classification');
        remaining = lastUnsure.map((held) => held.one);
      }
    }

    if (remaining.length > 0) {
      if (analysis.pair === null) {
        for (const held of lastUnsure) {
          toPerson(held, `${held.row.reason}; analysis is unassigned and there is no default pair to fall back to`);
        }
      } else {
        if (!canCall()) {
          for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `budget: this run allows ${budgets.modelCallsPerRun} judge calls; classification stayed unsure and ${remaining.length} items did not reach analysis`, source: 'budget', evidenceHash: one.hash, configHash });
        } else {
        const second = newJudge(analysis.pair, 'analysis');
        if (typeof second === 'string') {
          for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `the analysis judge could not start: ${oneLine(second)}`, source: 'judge-failed', evidenceHash: one.hash, configHash });
        } else {
          const still = await runTier(second, remaining, 'analysis');
          for (const held of still) {
            const classificationReason = unsureReason.get(keyOf(held.one)) ?? 'classification stayed unsure';
            toPerson(held, `both judges stayed unsure: ${classificationReason}; ${held.row.reason}`);
          }
        }
        }
      }
    }
  }

  for (const judge of created) await judge.close?.().catch(() => undefined);

  const ordered = [...rows].sort((a, b) => a.role === b.role ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.role === 'node' ? -1 : 1));
  const report = graphVerdictReport(ordered, budgets, validatorVersion, generatedAt);
  const fingerprint = graphVerdictFingerprint(snapshot, options.roles, budgets, validatorVersion, jev !== null, hasJudge);
  return {
    rows: ordered,
    report,
    cache: { validatorVersion, generatedAt, fingerprint, budgets, entries },
    metrics: { checked, reused, judgeItems, modelCalls },
  };
}

function evidenceOf(properties: unknown): GraphJudgeEvidence[] {
  const props = propsOf(properties);
  const found: GraphJudgeEvidence[] = [];
  const add = (value: unknown): void => {
    if (!isObject(value) || typeof value.path !== 'string' || value.path === '') return;
    found.push({ path: value.path, ...(typeof value.lineStart === 'number' ? { lineStart: value.lineStart } : {}), ...(typeof value.lineEnd === 'number' ? { lineEnd: value.lineEnd } : {}) });
  };
  add(props.span);
  add(props.sourceSpan);
  if (Array.isArray(props.evidence)) for (const one of props.evidence) add(one);
  if (Array.isArray(props.origins)) for (const one of props.origins) if (isObject(one)) add(one.sourceSpan);
  return found;
}
