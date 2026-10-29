/**
 * Graph verdicts (madarch-mwhd.1): every current node and edge of a filled
 * product is `valid`, `invalid` or `unreviewed`, with one line saying why.
 *
 * The deterministic rules in `graph-verdict-rules.ts` run first, as data the
 * engine reads. A rule decides only what it can check: the item's own shape,
 * and the bytes the item cites, read at the commit the fill pinned. Evidence
 * that cannot be resolved (no pinned reader, a file the commit does not hold,
 * a digest or line range the bytes contradict) stays unreviewed and is never
 * valid. A structurally sound item whose neighbourhood is anomalous (a
 * database with no edge, a route with no handler, a table nobody reads) goes
 * to a judge instead of passing on its span check alone.
 *
 * An item a rule cannot decide goes to a judge in batches of at most 50. The
 * chain is jev, then classification, then analysis: each tier reads what the
 * last left `unsure`, and what analysis still cannot decide leaves it for a
 * person. A judge that could not run leaves its items unjudged, never valid.
 * Budget-deferred items and retryable judge failures are not cached as a
 * disposition: the next run takes them up again.
 *
 * Every row carries an evidence hash and a configuration hash. An unchanged
 * neighbourhood under an unchanged rule set and judge identity reuses the
 * verdict; a changed node or edge revalidates itself and its incident edges,
 * and nothing else. The two budgets are not part of the configuration: a
 * larger budget reuses what a smaller one decided. The cache and the budgets
 * live beside the product's store, not in the graph.
 */
import { createHash } from 'node:crypto';
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';
import type { ModelPair, ModelRoleView, ResolvedModelRole } from './model-roles.js';
import { roleOf } from './model-roles.js';
import {
  GRAPH_RULES,
  edgeRuleFor,
  escalationsForNode,
  graphConditionHolds,
  graphVerdictRulesHash,
  nodeRuleFor,
  type GraphConditionSubject,
  type GraphEdgeRule,
  type GraphNeighbourQuery,
  type GraphNodeRule,
  type GraphRuleSet,
  type SpanPolicy,
} from './graph-verdict-rules.js';

export const GRAPH_VERDICT_VALIDATOR_VERSION = '1';
/** The judge protocol's version; a change invalidates every judged verdict. */
export const GRAPH_VERDICT_JUDGE_VERSION = '1';
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
export type GraphVerdictSource = 'rule' | 'jev' | 'classification' | 'analysis' | 'person' | 'none' | 'unresolved' | 'budget' | 'judge-failed';

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

/** One file as the graph declares it: the line count and digest it recorded. */
export interface GraphEvidenceFile {
  readonly path: string;
  readonly lines: number;
  readonly sha256?: string;
}

/** The bytes of one cited file at the fill's commit, as the host reads them. */
export interface GraphEvidenceContent {
  readonly text: string;
  /** The digest the host measured; the engine measures the text when it is absent. */
  readonly sha256?: string;
  readonly repository?: string;
  readonly commit?: string;
}

/** Reads a repository-relative path at a pinned commit; `undefined` when that commit has no such file. */
export type GraphEvidenceReader = (path: string) => Promise<GraphEvidenceContent | undefined>;

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

/** A cited place, with the pinned bytes the judge may read for itself. */
export interface GraphJudgeEvidence {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  /** The cited lines, or a note that they could not be read at the fill's commit. */
  readonly excerpt?: string;
  readonly unresolved?: string;
}

export interface GraphJudgeItem {
  /** `(role, id)`, unique across a batch of nodes and edges. */
  readonly id: string;
  readonly role: GraphVerdictRole;
  readonly kind: string;
  readonly label: string;
  readonly reason: string;
  readonly evidence: readonly GraphJudgeEvidence[];
  /** False when the cited evidence could not be resolved; a valid answer is then refused. */
  readonly evidenceResolved: boolean;
  /** Why the evidence is unresolved, when it is. */
  readonly unresolved?: string;
  /** Facts across the item's edges, so the judge sees the shape the rule found odd. */
  readonly neighbourhood: readonly string[];
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
  /** The host's name for the jev adapter's version; part of every cache key while jev is used. */
  readonly jevVersion?: string;
  /** Starts a role's judge on demand. Absent means no role judge can be started. */
  readonly judgeFor?: GraphJudgeFactory;
  /** Reads a cited file at the fill's commit. Absent means no evidence can be resolved. */
  readonly readEvidence?: GraphEvidenceReader;
  /** The rule set; the default is the manifest of rules in `graph-verdict-rules.ts`. */
  readonly rules?: GraphRuleSet;
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
    .sort((a, b) => a.role === b.role ? byCodePoint(a.id, b.id) : (a.role === 'node' ? -1 : 1));
}

/** True when a cache still holds work another run may take up: budget-deferred items and failed judges. */
export function graphVerdictsRunnable(cache: GraphVerdictCache | undefined): boolean {
  if (cache === undefined) return false;
  return Object.values(cache.entries).some((entry) => entry.source === 'budget' || entry.source === 'judge-failed');
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

/** A problem the rules found, and whether the cited evidence could be resolved at all. */
interface Problem {
  readonly verdict: 'invalid' | 'unreviewed';
  readonly reason: string;
  readonly resolved: boolean;
}

/** A cited file as the fill pinned it, with what the pinned bytes say. */
interface ResolvedFile {
  readonly path: string;
  readonly lines?: number;
  readonly sha256?: string;
  /** The size a reader is shown: the last non-empty line. */
  readonly actualLines?: number;
  /** The lines the span may name: a closing newline opens one more. */
  readonly readLines?: number;
  readonly actualSha256?: string;
  readonly text?: string;
  readonly repository?: string;
  readonly commit?: string;
  /** Set when the cited file cannot be verified: no reader, no such file, or bytes that contradict the graph. */
  readonly problem?: string;
}

const isObject = (value: unknown): value is Props => typeof value === 'object' && value !== null && !Array.isArray(value);

const isSpace = (character: string): boolean => character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f' || character === '\v';

/** A judge's reason is stored as one line, whatever whitespace it used (no expression over the words). */
const oneLine = (text: string): string => {
  const words: string[] = [];
  let held = '';
  for (const character of text.trim()) {
    if (!isSpace(character)) { held += character; continue; }
    if (held !== '') { words.push(held); held = ''; }
  }
  if (held !== '') words.push(held);
  return words.join(' ');
};
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
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

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

/** The line a one-based line number names, without its carriage return. */
const lineAt = (text: string, line: number): string | undefined => {
  const lines = text.split('\n');
  const held = lines[line - 1];
  if (held === undefined) return undefined;
  return held.endsWith('\r') ? held.slice(0, -1) : held;
};

/** The cited lines, capped so one item cannot carry a whole file into a prompt. */
const excerptAt = (text: string, lineStart: number | undefined, lineEnd: number | undefined): string => {
  const from = lineStart ?? 1;
  const to = Math.min(lineEnd ?? from, from + 5);
  const held: string[] = [];
  for (let line = from; line <= to; line += 1) {
    const one = lineAt(text, line);
    if (one === undefined) break;
    held.push(one);
  }
  const joined = held.join('\n');
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
};

const checkSpan = (properties: unknown, files: ReadonlyMap<string, ResolvedFile>, role: GraphVerdictRole, namesSelf = false): Problem | undefined => {
  const span = spanOf(properties);
  if (span === undefined) return { verdict: 'unreviewed', reason: `${role} has no source span`, resolved: false };
  if (namesSelf) {
    const named = pathOf(properties);
    if (named !== undefined && named !== span.path) return { verdict: 'invalid', reason: `${role} span names ${JSON.stringify(span.path)} but its path is ${JSON.stringify(named)}`, resolved: true };
  }
  if (span.lineStart === undefined || span.lineEnd === undefined) return { verdict: 'invalid', reason: `${role} span in ${JSON.stringify(span.path)} has no line range`, resolved: true };
  if (!Number.isInteger(span.lineStart) || !Number.isInteger(span.lineEnd)) return { verdict: 'invalid', reason: `${role} span in ${JSON.stringify(span.path)} does not name whole lines`, resolved: true };
  if (span.lineStart < 1 || span.lineEnd < span.lineStart) return { verdict: 'invalid', reason: `${role} span in ${JSON.stringify(span.path)} has the line range ${span.lineStart}-${span.lineEnd}`, resolved: true };
  const file = files.get(span.path);
  if (file === undefined) return { verdict: 'unreviewed', reason: `${role} span names ${JSON.stringify(span.path)}, which the pinned repository does not hold`, resolved: false };
  if (file.problem !== undefined) return { verdict: 'unreviewed', reason: `${role} span ${span.path}:${span.lineStart}-${span.lineEnd} cannot be verified: ${file.problem}`, resolved: false };
  const lines = file.readLines ?? file.actualLines ?? file.lines;
  if (lines === undefined) return { verdict: 'unreviewed', reason: `${role} span ${span.path}:${span.lineStart}-${span.lineEnd} has no known line count`, resolved: false };
  if (span.lineEnd > lines) return { verdict: 'unreviewed', reason: `${role} span ${span.path}:${span.lineStart}-${span.lineEnd} is outside the pinned file, which has ${lines} lines`, resolved: false };
  return undefined;
};

const checkSpanPolicy = (policy: SpanPolicy, properties: unknown, files: ReadonlyMap<string, ResolvedFile>, role: GraphVerdictRole, namesSelf = false): Problem | undefined => {
  if ((policy === 'optional' || policy === 'if-present') && spanOf(properties) === undefined) return undefined;
  return checkSpan(properties, files, role, namesSelf);
};

const missingProperty = (properties: unknown, names: readonly string[], role: GraphVerdictRole): Problem | undefined => {
  const props = propsOf(properties);
  for (const name of names) if (!present(props[name])) return { verdict: 'invalid', reason: `${role} has no ${JSON.stringify(name)}`, resolved: true };
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

const checkEvidenceLines = (properties: unknown, files: ReadonlyMap<string, ResolvedFile>): Problem | undefined => {
  const evidence = propsOf(properties).evidence;
  if (!Array.isArray(evidence)) return { verdict: 'invalid', reason: 'node evidence is not a list of source places', resolved: true };
  for (const entry of evidence) {
    const held = propsOf(entry);
    const path = held.path;
    const line = held.line;
    if (typeof path !== 'string' || path === '') return { verdict: 'invalid', reason: 'node evidence names no path', resolved: true };
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return { verdict: 'invalid', reason: `node evidence in ${JSON.stringify(path)} names no whole line`, resolved: true };
    const file = files.get(path);
    if (file === undefined) return { verdict: 'unreviewed', reason: `node evidence names ${JSON.stringify(path)}, which the pinned repository does not hold`, resolved: false };
    if (file.problem !== undefined) return { verdict: 'unreviewed', reason: `node evidence ${path}:${line} cannot be verified: ${file.problem}`, resolved: false };
    const lines = file.actualLines ?? file.lines;
    if (lines === undefined) return { verdict: 'unreviewed', reason: `node evidence ${path}:${line} has no known line count`, resolved: false };
    if (line > lines) return { verdict: 'unreviewed', reason: `node evidence ${path}:${line} is outside the pinned file, which has ${lines} lines`, resolved: false };
  }
  return undefined;
};

/** The database's own bytes (or paths) must name the database the graph claims it is. */
const checkEvidenceNamesLabel = (label: string, properties: unknown, files: ReadonlyMap<string, ResolvedFile>): Problem | undefined => {
  const evidence = propsOf(properties).evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) return { verdict: 'unreviewed', reason: `the database ${JSON.stringify(label)} has no evidence place to name it`, resolved: false };
  const wanted = label.toLowerCase();
  for (const entry of evidence) {
    const held = propsOf(entry);
    const path = held.path;
    const line = held.line;
    if (typeof path !== 'string' || typeof line !== 'number') continue;
    const file = files.get(path);
    if (file?.problem !== undefined || file?.text === undefined) continue;
    if (path.toLowerCase().includes(wanted)) return undefined;
    const text = lineAt(file.text, line);
    if (text !== undefined && text.toLowerCase().includes(wanted)) return undefined;
  }
  return { verdict: 'unreviewed', reason: `the database ${JSON.stringify(label)} has no evidence place naming it`, resolved: false };
};

const nodeProblems = (item: GraphNodeItem, rule: GraphNodeRule, files: ReadonlyMap<string, ResolvedFile>): Problem | undefined => {
  const missing = missingProperty(item.properties, rule.requireProperties ?? [], 'node');
  if (missing !== undefined) return missing;
  for (const name of rule.requireWholeProperties ?? []) {
    const value = propsOf(item.properties)[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return { verdict: 'invalid', reason: `node property ${JSON.stringify(name)} is ${JSON.stringify(value)}, not a whole count`, resolved: true };
  }
  if (rule.requireOneOfProperties !== undefined && rule.requireOneOfProperties.length > 0) {
    const props = propsOf(item.properties);
    if (!rule.requireOneOfProperties.some((name) => present(props[name]))) return { verdict: 'invalid', reason: `node has none of ${rule.requireOneOfProperties.map((name) => JSON.stringify(name)).join(', ')}`, resolved: true };
  }
  if (rule.recordKeyPrefix !== undefined || rule.recordKeyHexLength !== undefined) {
    const recordKey = propsOf(item.properties).recordKey;
    if (typeof recordKey !== 'string') return { verdict: 'invalid', reason: 'node has no "recordKey"', resolved: true };
    if (rule.recordKeyPrefix !== undefined && !recordKey.startsWith(rule.recordKeyPrefix)) return { verdict: 'invalid', reason: `node recordKey ${JSON.stringify(recordKey)} does not start with ${JSON.stringify(rule.recordKeyPrefix)}`, resolved: true };
    if (rule.recordKeyHexLength !== undefined) {
      const suffix = recordKey.slice(rule.recordKeyPrefix?.length ?? 0);
      if (suffix.length !== rule.recordKeyHexLength || !isHex(suffix)) return { verdict: 'invalid', reason: `node recordKey ${JSON.stringify(recordKey)} does not end in ${rule.recordKeyHexLength} lowercase hex characters`, resolved: true };
    }
  }
  for (const name of rule.requireHexProperties ?? []) {
    const value = propsOf(item.properties)[name];
    if (typeof value !== 'string' || value.length !== 40 || !isHex(value)) return { verdict: 'invalid', reason: `node property ${JSON.stringify(name)} is not a 40-character commit id`, resolved: true };
  }
  if (rule.requireEvidenceKinds !== undefined) {
    const seen = evidenceKinds(item.properties);
    if (!rule.requireEvidenceKinds.some((kind) => seen.includes(kind))) return { verdict: 'invalid', reason: `node has no accepted evidence kind (${rule.requireEvidenceKinds.join(', ')}); an invented database has none`, resolved: true };
  }
  if (rule.checkEvidenceLines === true) {
    const problem = checkEvidenceLines(item.properties, files);
    if (problem !== undefined) return problem;
  }
  if (rule.evidenceNamesLabel === true) {
    const problem = checkEvidenceNamesLabel(item.label, item.properties, files);
    if (problem !== undefined) return problem;
  }
  return checkSpanPolicy(rule.span, item.properties, files, 'node', rule.spanNamesSelf === true);
};

const edgeProblems = (item: GraphEdgeItem, rule: GraphEdgeRule, nodes: ReadonlyMap<string, GraphNodeItem>, files: ReadonlyMap<string, ResolvedFile>): Problem | undefined => {
  const from = nodes.get(item.from);
  const to = nodes.get(item.to);
  if (from === undefined) return { verdict: 'invalid', reason: `edge endpoint ${JSON.stringify(item.from)} is not a node in this graph`, resolved: true };
  if (to === undefined) return { verdict: 'invalid', reason: `edge endpoint ${JSON.stringify(item.to)} is not a node in this graph`, resolved: true };
  if (rule.fromKinds !== undefined && !rule.fromKinds.includes(from.kind)) return { verdict: 'invalid', reason: `edge starts at a ${from.kind}, and ${rule.id} starts at ${rule.fromKinds.join(' or ')}`, resolved: true };
  if (rule.toKinds !== undefined && !rule.toKinds.includes(to.kind)) return { verdict: 'invalid', reason: `edge ends at a ${to.kind}, and ${rule.id} ends at ${rule.toKinds.join(' or ')}`, resolved: true };
  const missing = missingProperty(item.properties, rule.requireProperties ?? [], 'edge');
  if (missing !== undefined) return missing;
  const span = spanOf(item.properties);
  if (span !== undefined) return checkSpan(item.properties, files, 'edge');
  if (rule.span === 'required') return { verdict: 'unreviewed', reason: 'edge has no source span', resolved: false };
  if (rule.structuralKinds?.includes(item.kind) === true) return undefined;
  if (rule.permitPosition === true && item.position !== undefined && pathOf(item.properties) !== undefined) return undefined;
  return undefined;
};

/** A fallback item with no source span has nothing for the rules to check; a judge reads it. */
const isUndecidedNode = (item: GraphNodeItem, rule: GraphNodeRule): boolean => rule.id === 'node-fallback' && spanOf(item.properties) === undefined;
const isUndecidedEdge = (item: GraphEdgeItem, rule: GraphEdgeRule, nodes: ReadonlyMap<string, GraphNodeItem>): boolean => {
  if (rule.id !== 'edge-fallback') return false;
  if (spanOf(item.properties) !== undefined || rule.structuralKinds?.includes(item.kind) === true) return false;
  if (rule.permitPosition === true && item.position !== undefined && pathOf(item.properties) !== undefined) return false;
  return nodes.has(item.from) && nodes.has(item.to);
};

const sourceRank: readonly GraphVerdictSource[] = ['rule', 'jev', 'classification', 'analysis', 'person', 'none', 'unresolved', 'budget', 'judge-failed'];

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
    byKind: [...byKind.values()].sort((a, b) => a.role === b.role ? byCodePoint(a.kind, b.kind) : (a.role === 'node' ? -1 : 1)),
    sources: sourceRank.filter((source) => (sources.get(source) ?? 0) > 0).map((source) => ({ source, count: sources.get(source)! })),
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || byCodePoint(a.reason, b.reason)),
  };
}

/** Everything that makes one run's verdicts comparable: the snapshot, the rules, the judge identity and the budgets. */
export interface GraphVerdictFingerprintOptions {
  readonly snapshot: GraphSnapshot;
  readonly roles: ModelRoleView;
  readonly budgets: GraphVerdictBudgets;
  readonly validatorVersion?: string;
  readonly hasJev?: boolean;
  readonly hasJudge?: boolean;
  readonly jevVersion?: string;
  readonly rules?: GraphRuleSet;
}

export function graphVerdictFingerprint(options: GraphVerdictFingerprintOptions): string {
  const validatorVersion = options.validatorVersion ?? GRAPH_VERDICT_VALIDATOR_VERSION;
  const hasJev = options.hasJev === true;
  return digest({
    validatorVersion,
    budgets: options.budgets,
    rulesHash: graphVerdictRulesHash(options.rules ?? GRAPH_RULES),
    judgeHash: judgeHashOf(options.roles, hasJev, options.hasJev === true || options.hasJudge === true, options.jevVersion),
    nodes: options.snapshot.nodes.map((node) => ({ id: node.id, versionId: node.versionId, kind: node.kind, label: node.label, properties: node.properties })).sort((a, b) => byCodePoint(a.id, b.id)),
    edges: options.snapshot.edges.map((edge) => ({ id: edge.id, versionId: edge.versionId, kind: edge.kind, from: edge.from, to: edge.to, discriminator: edge.discriminator, position: edge.position, properties: edge.properties })).sort((a, b) => byCodePoint(a.id, b.id)),
  });
}

/** The identity that judged: each role's agent, model and reasoning, the protocol version, and the jev adapter's version. */
function judgeHashOf(roles: ModelRoleView, hasJev: boolean, hasJudge: boolean, jevVersion: string | undefined): string {
  return digest({
    version: GRAPH_VERDICT_JUDGE_VERSION,
    hasJudge,
    jev: hasJev ? (jevVersion ?? 'unversioned') : null,
    roles: roles.roles.map((role: ResolvedModelRole) => ({ role: role.role, pair: role.pair })),
  });
}

function declaredFiles(snapshot: GraphSnapshot): Map<string, GraphEvidenceFile> {
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

/** Paths an item cites as source evidence; a route's URL template is not one. */
function evidencePaths(value: unknown): string[] {
  const paths = new Set<string>();
  const walk = (held: unknown, depth: number): void => {
    if (depth > 4) return;
    if (Array.isArray(held)) { for (const one of held) walk(one, depth + 1); return; }
    if (!isObject(held)) return;
    for (const key of ['span', 'sourceSpan', 'importSpan']) {
      const span = held[key];
      const path = isObject(span) ? span.path : undefined;
      if (typeof path === 'string' && path !== '') paths.add(path);
    }
    if (Array.isArray(held['evidence'])) for (const entry of held['evidence']) {
      const path = isObject(entry) ? entry.path : undefined;
      if (typeof path === 'string' && path !== '') paths.add(path);
    }
    for (const key of ['origins', 'origin', 'evidence']) walk(held[key], depth + 1);
  };
  walk(value, 0);
  return [...paths].sort(byCodePoint);
}

/**
 * Reads every cited path once. A declared file whose bytes contradict its
 * digest or line count is a resolution problem, not an invalid item: the
 * pinned repository is what decides, and a graph that disagrees with it has
 * to be looked at, never confirmed by its own claim.
 */
async function resolveFiles(snapshot: GraphSnapshot, reader: GraphEvidenceReader | undefined): Promise<Map<string, ResolvedFile>> {
  const declared = declaredFiles(snapshot);
  const paths = new Set<string>(declared.keys());
  for (const node of snapshot.nodes) for (const path of evidencePaths(node.properties)) paths.add(path);
  for (const edge of snapshot.edges) for (const path of evidencePaths(edge.properties)) paths.add(path);
  const files = new Map<string, ResolvedFile>();
  for (const path of [...paths].sort(byCodePoint)) {
    const held = declared.get(path);
    if (reader === undefined) {
      files.set(path, { ...(held ?? { path }), problem: 'no pinned repository reader was configured, so the file was not read at the fill\'s commit' });
      continue;
    }
    let content: GraphEvidenceContent | undefined;
    try {
      content = await reader(path);
    } catch (error) {
      files.set(path, { ...(held ?? { path }), problem: `the pinned repository could not be read at ${JSON.stringify(path)}: ${oneLine(error instanceof Error ? error.message : String(error))}` });
      continue;
    }
    if (content === undefined) {
      files.set(path, { ...(held ?? { path }), problem: `the file ${JSON.stringify(path)} is not in the pinned repository at the fill's commit` });
      continue;
    }
    const actualSha256 = content.sha256 ?? sha256(content.text);
    const actualLines = content.text === '' ? 0 : content.text.split('\n').length - (content.text.endsWith('\n') ? 1 : 0);
    const readLines = content.text === '' ? 1 : content.text.split('\n').length;
    const where = content.repository === undefined ? '' : ` in ${content.repository}${content.commit === undefined ? '' : ` at ${content.commit}`}`;
    const problem = held?.lines !== undefined && held.lines !== actualLines
      ? `the graph says ${JSON.stringify(path)} has ${held.lines} lines, but the pinned bytes${where} have ${actualLines}`
      : held?.sha256 !== undefined && held.sha256 !== actualSha256
        ? `the graph's sha256 for ${JSON.stringify(path)} is ${held.sha256}, but the pinned bytes${where} digest to ${actualSha256}`
        : undefined;
    files.set(path, {
      path,
      ...(held ?? {}),
      actualLines,
      readLines,
      actualSha256,
      text: content.text,
      ...(content.repository === undefined ? {} : { repository: content.repository }),
      ...(content.commit === undefined ? {} : { commit: content.commit }),
      ...(problem === undefined ? {} : { problem }),
    });
  }
  return files;
}

/** The identity of an item across a batch of nodes and edges: the role, then the graph's own id. */
const judgeKey = (role: GraphVerdictRole, id: string): string => `${role}:${id}`;

const neighbourhoodOf = (subjectId: string, edgesByNode: ReadonlyMap<string, readonly GraphEdgeItem[]>, nodes: ReadonlyMap<string, GraphNodeItem>): string[] => {
  const facts: string[] = [];
  for (const edge of edgesByNode.get(subjectId) ?? []) {
    const out = edge.from === subjectId;
    const other = nodes.get(out ? edge.to : edge.from);
    const span = spanOf(edge.properties);
    const where = span === undefined ? '' : ` at ${span.path}${span.lineStart === undefined ? '' : `:${span.lineStart}`}`;
    facts.push(`${out ? 'out' : 'in'} ${edge.kind} → ${other?.kind ?? 'an unknown kind'} ${JSON.stringify(other?.label ?? '')}${where}`);
  }
  return facts.sort(byCodePoint);
};

/** The cited places of an item, with the pinned lines the judge may read. */
function judgeEvidence(properties: unknown, files: ReadonlyMap<string, ResolvedFile>): GraphJudgeEvidence[] {
  const props = propsOf(properties);
  const found: { path: string; lineStart?: number; lineEnd?: number }[] = [];
  const add = (value: unknown): void => {
    if (!isObject(value) || typeof value.path !== 'string' || value.path === '') return;
    found.push({ path: value.path, ...(typeof value.lineStart === 'number' ? { lineStart: value.lineStart } : {}), ...(typeof value.lineEnd === 'number' ? { lineEnd: value.lineEnd } : {}) });
  };
  add(props.span);
  add(props.sourceSpan);
  if (Array.isArray(props.evidence)) for (const one of props.evidence) {
    if (!isObject(one) || typeof one.path !== 'string' || one.path === '') continue;
    add({ ...one, ...(typeof one.line === 'number' ? { lineStart: one.line, lineEnd: one.line } : {}) });
  }
  if (Array.isArray(props.origins)) for (const one of props.origins) if (isObject(one)) add(one.sourceSpan);
  const resolved: GraphJudgeEvidence[] = [];
  for (const place of found) {
    const file = files.get(place.path);
    const lineStart = place.lineStart;
    const lineEnd = place.lineEnd ?? lineStart;
    if (file === undefined) { resolved.push({ ...place, unresolved: 'the pinned repository does not hold this path' }); continue; }
    if (file.problem !== undefined) { resolved.push({ ...place, unresolved: file.problem }); continue; }
    if (file.text === undefined) { resolved.push({ ...place, unresolved: 'the file bytes were not read' }); continue; }
    const excerpt = excerptAt(file.text, lineStart, lineEnd);
    resolved.push({ ...place, excerpt: excerpt === '' ? '(the cited lines are empty)' : excerpt });
  }
  return resolved;
}

/** The condition subject for one node: its kind and properties, and the items across its edges. */
function subjectFactory(
  edgesByNode: ReadonlyMap<string, readonly GraphEdgeItem[]>,
  nodes: ReadonlyMap<string, GraphNodeItem>,
  cache: Map<string, GraphConditionSubject>,
): (id: string) => GraphConditionSubject {
  const subject = (id: string): GraphConditionSubject => {
    const held = cache.get(id);
    if (held !== undefined) return held;
    const node = nodes.get(id);
    const made: GraphConditionSubject = {
      kind: node?.kind ?? '',
      properties: node?.properties,
      neighbours: (query: GraphNeighbourQuery) => {
        const found: GraphConditionSubject[] = [];
        for (const edge of edgesByNode.get(id) ?? []) {
          const out = edge.from === id;
          const inEdge = edge.to === id;
          if (query.direction === 'out' && !out) continue;
          if (query.direction === 'in' && !inEdge) continue;
          if (query.kinds !== undefined && !query.kinds.includes(edge.kind)) continue;
          const otherId = out ? edge.to : edge.from;
          const other = nodes.get(otherId);
          if (other === undefined) continue;
          if (query.otherKinds !== undefined && !query.otherKinds.includes(other.kind)) continue;
          found.push(subject(otherId));
        }
        return found;
      },
    };
    cache.set(id, made);
    return made;
  };
  return subject;
}

export async function runGraphVerdicts(options: GraphVerdictRunOptions): Promise<GraphVerdictResult> {
  const validatorVersion = options.validatorVersion ?? GRAPH_VERDICT_VALIDATOR_VERSION;
  const rules = options.rules ?? GRAPH_RULES;
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
  const files = await resolveFiles(snapshot, options.readEvidence);
  const edgesByNode = new Map<string, GraphEdgeItem[]>();
  for (const edge of snapshot.edges) {
    for (const id of new Set([edge.from, edge.to])) {
      const held = edgesByNode.get(id) ?? [];
      held.push(edge);
      edgesByNode.set(id, held);
    }
  }
  const subjects = new Map<string, GraphConditionSubject>();
  const subject = subjectFactory(edgesByNode, nodes, subjects);
  const nodeCore = (node: GraphNodeItem): unknown => ({ id: node.id, versionId: node.versionId, kind: node.kind, label: node.label, properties: node.properties });
  const edgeCore = (edge: GraphEdgeItem): unknown => ({ id: edge.id, versionId: edge.versionId, kind: edge.kind, from: edge.from, to: edge.to, discriminator: edge.discriminator, position: edge.position, properties: edge.properties });
  const hasJev = options.jev !== undefined && options.jev !== null;
  const hasJudge = hasJev || options.judgeFor !== undefined;
  const rulesHash = graphVerdictRulesHash(rules);
  const judgeHash = judgeHashOf(options.roles, hasJev, hasJudge, options.jevVersion);
  // Budgets are deliberately absent: a larger budget reuses what a smaller one decided. Rules and judge identity are present:
  // editing a rule or changing the classifier's model invalidates the verdicts it resolved, not only the undisposed ones.
  const configHash = digest({ validatorVersion, rulesHash, judgeHash });
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
  const reusable = (held: GraphVerdictCacheEntry | undefined, hash: string): held is GraphVerdictCacheEntry => held !== undefined
    && held.evidenceHash === hash
    && held.configHash === configHash
    // A budget deferral and a failed judge decided nothing: the next run takes them up again.
    && held.source !== 'budget'
    && held.source !== 'judge-failed';

  const itemHashOf = (value: unknown, paths: readonly string[]): string => digest({
    validatorVersion,
    rulesHash,
    item: value,
    files: paths.map((path) => {
      const held = files.get(path);
      return held === undefined ? { path, missing: true } : {
        path,
        ...(held.lines === undefined ? {} : { lines: held.lines }),
        ...(held.sha256 === undefined ? {} : { sha256: held.sha256 }),
        ...(held.actualLines === undefined ? {} : { actualLines: held.actualLines }),
        ...(held.actualSha256 === undefined ? {} : { actualSha256: held.actualSha256 }),
        ...(held.problem === undefined ? {} : { problem: held.problem }),
      };
    }),
  });

  const unresolvedOf = (evidence: readonly GraphJudgeEvidence[]): string | undefined => {
    const first = evidence.find((one) => one.unresolved !== undefined);
    return first === undefined ? undefined : `${first.path}${first.lineStart === undefined ? '' : `:${first.lineStart}`}: ${first.unresolved}`;
  };

  for (const node of snapshot.nodes) {
    const rule = nodeRuleFor(node.kind, rules.nodes);
    const hash = itemHashOf({ node: nodeCore(node), neighbourhood: (edgesByNode.get(node.id) ?? []).map((edge) => ({ edge: edgeCore(edge), other: nodes.get(edge.from === node.id ? edge.to : edge.from) })) }, evidencePaths(node.properties));
    const held = previousEntries[`node:${node.id}`];
    if (reusable(held, hash)) {
      remember(held);
      reused += 1;
      continue;
    }
    checked += 1;
    const undecided = isUndecidedNode(node, rule);
    if (undecided) {
      const evidence = judgeEvidence(node.properties, files);
      pending.push({
        base: { role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'unreviewed', reason: 'no rule decides this node', rule: rule.id, source: 'none' },
        hash,
        rule: rule.id,
        item: {
          id: judgeKey('node', node.id), role: 'node', kind: node.kind, label: node.label,
          reason: 'no rule decides this node', evidence, evidenceResolved: unresolvedOf(evidence) === undefined,
          ...(unresolvedOf(evidence) === undefined ? {} : { unresolved: unresolvedOf(evidence)! }),
          neighbourhood: neighbourhoodOf(node.id, edgesByNode, nodes), properties: node.properties,
        },
      });
      continue;
    }
    const problem = nodeProblems(node, rule, files);
    if (problem === undefined) {
      const escalation = escalationsForNode(rules, node.kind, rule).find((one) => graphConditionHolds(one.when, subject(node.id)));
      if (escalation === undefined) {
        remember({ role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'valid', reason: 'the rule found its required source evidence', rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
        continue;
      }
      const evidence = judgeEvidence(node.properties, files);
      pending.push({
        base: { role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'unreviewed', reason: escalation.reason, rule: rule.id, source: 'none' },
        hash,
        rule: rule.id,
        item: {
          id: judgeKey('node', node.id), role: 'node', kind: node.kind, label: node.label,
          reason: escalation.reason, evidence, evidenceResolved: unresolvedOf(evidence) === undefined,
          ...(unresolvedOf(evidence) === undefined ? {} : { unresolved: unresolvedOf(evidence)! }),
          neighbourhood: neighbourhoodOf(node.id, edgesByNode, nodes), properties: node.properties,
        },
      });
      continue;
    }
    if (problem.verdict === 'invalid') {
      remember({ role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'invalid', reason: problem.reason, rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
      continue;
    }
    // Unresolved evidence is not a verdict: a judge may read the item and the neighbourhood, but may never make it valid.
    const evidence = judgeEvidence(node.properties, files);
    pending.push({
      base: { role: 'node', id: node.id, kind: node.kind, label: node.label, verdict: 'unreviewed', reason: problem.reason, rule: rule.id, source: 'none' },
      hash,
      rule: rule.id,
      item: {
        id: judgeKey('node', node.id), role: 'node', kind: node.kind, label: node.label,
        reason: problem.reason, evidence, evidenceResolved: problem.resolved && unresolvedOf(evidence) === undefined,
        unresolved: unresolvedOf(evidence) ?? problem.reason,
        neighbourhood: neighbourhoodOf(node.id, edgesByNode, nodes), properties: node.properties,
      },
    });
  }

  for (const edge of snapshot.edges) {
    const rule = edgeRuleFor(edge.kind, rules.edges);
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const hash = itemHashOf({ edge: edgeCore(edge), from: from === undefined ? undefined : nodeCore(from), to: to === undefined ? undefined : nodeCore(to) }, evidencePaths([edge.properties, from?.properties, to?.properties]));
    const held = previousEntries[`edge:${edge.id}`];
    if (reusable(held, hash)) {
      remember(held);
      reused += 1;
      continue;
    }
    checked += 1;
    const baseEvidence = judgeEvidence(edge.properties, files);
    const itemOf = (reason: string): GraphJudgeItem => {
      const evidence = baseEvidence;
      return {
        id: judgeKey('edge', edge.id), role: 'edge', kind: edge.kind, label: edge.label ?? edge.id,
        reason, evidence, evidenceResolved: unresolvedOf(evidence) === undefined,
        ...(unresolvedOf(evidence) === undefined ? {} : { unresolved: unresolvedOf(evidence)! }),
        neighbourhood: [...neighbourhoodOf(edge.from, edgesByNode, nodes), ...neighbourhoodOf(edge.to, edgesByNode, nodes)].sort(byCodePoint),
        properties: edge.properties,
        ...(from === undefined ? {} : { from: { id: judgeKey('node', from.id), kind: from.kind, label: from.label } }),
        ...(to === undefined ? {} : { to: { id: judgeKey('node', to.id), kind: to.kind, label: to.label } }),
      };
    };
    if (isUndecidedEdge(edge, rule, nodes)) {
      pending.push({
        base: { role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, verdict: 'unreviewed', reason: 'no rule decides this edge', rule: rule.id, source: 'none' },
        hash, rule: rule.id, item: itemOf('no rule decides this edge'),
      });
      continue;
    }
    const problem = edgeProblems(edge, rule, nodes, files);
    if (problem === undefined) {
      remember({ role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, verdict: 'valid', reason: 'the rule found its required source evidence', rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
      continue;
    }
    if (problem.verdict === 'invalid') {
      remember({ role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, verdict: 'invalid', reason: problem.reason, rule: rule.id, source: 'rule', tier: 'rule', evidenceHash: hash, configHash });
      continue;
    }
    pending.push({
      base: { role: 'edge', id: edge.id, kind: edge.kind, label: edge.label ?? edge.id, verdict: 'unreviewed', reason: problem.reason, rule: rule.id, source: 'none' },
      hash, rule: rule.id, item: itemOf(problem.reason),
    });
  }

  const admitted = pending.slice(0, budgets.itemsPerRun);
  for (const waiting of pending.slice(budgets.itemsPerRun)) {
    remember({ ...waiting.base, reason: `${waiting.base.reason}; budget: ${pending.length - budgets.itemsPerRun} items are waiting; this run admits at most ${budgets.itemsPerRun} to judging`, source: 'budget', evidenceHash: waiting.hash, configHash });
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
      // A valid answer is gated by evidence the rules could resolve at the fill's commit.
      if (answer.verdict === 'valid' && !one.item.evidenceResolved) {
        return { ...one.base, verdict: 'unreviewed', reason: `the ${tier} judge said valid, but the cited evidence is unresolved: ${one.item.unresolved ?? 'the pinned repository does not hold it'}`, rule: one.rule, source: 'unresolved', tier };
      }
      return { ...one.base, verdict: answer.verdict === 'unsure' ? 'unreviewed' : answer.verdict, reason, rule: one.rule, source: answer.verdict === 'unsure' ? 'none' : tier, tier };
    });
  };

  const saveJudged = (row: GraphVerdictRow, hash: string): void => {
    remember({ ...row, evidenceHash: hash, configHash });
  };

  if (admitted.length > 0) {
    type Pending = (typeof admitted)[number];
    interface Unsure { readonly one: Pending; readonly row: GraphVerdictRow }
    const keyOf = (one: Pending): string => one.item.id;
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
          for (const one of items.slice(offset)) remember({ ...one.base, verdict: 'unreviewed', reason: `${one.base.reason}; ${reason}`, source: 'budget', evidenceHash: one.hash, configHash });
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
    // A person's row keeps the rule's own concern in front of the judges' reasons: the concern is why it was asked.
    const toPerson = (held: Unsure, reason: string): void => {
      remember({ ...held.row, reason: `${held.one.base.reason}; ${reason}`, source: 'person', evidenceHash: held.one.hash, configHash });
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
      for (const one of admitted) remember({ ...one.base, verdict: 'unreviewed', reason: `${one.base.reason}; no judge is assigned: assign Classification and Analysis in /k/settings (section Model roles)`, source: 'none', evidenceHash: one.hash, configHash });
      remaining = [];
    }

    if (remaining.length > 0 && !canCall()) {
      for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `${one.base.reason}; budget: this run allows ${budgets.modelCallsPerRun} judge calls; ${remaining.length} items were not judged`, source: 'budget', evidenceHash: one.hash, configHash });
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
          for (const one of remaining) remember({ ...one.base, verdict: 'unreviewed', reason: `${one.base.reason}; budget: this run allows ${budgets.modelCallsPerRun} judge calls; classification stayed unsure and ${remaining.length} items did not reach analysis`, source: 'budget', evidenceHash: one.hash, configHash });
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

  const ordered = [...rows].sort((a, b) => a.role === b.role ? byCodePoint(a.id, b.id) : (a.role === 'node' ? -1 : 1));
  const report = graphVerdictReport(ordered, budgets, validatorVersion, generatedAt);
  const fingerprint = graphVerdictFingerprint({
    snapshot, roles: options.roles, budgets, validatorVersion, hasJev, hasJudge,
    ...(options.jevVersion === undefined ? {} : { jevVersion: options.jevVersion }),
    rules,
  });
  return {
    rows: ordered,
    report,
    cache: { validatorVersion, generatedAt, fingerprint, budgets, entries },
    metrics: { checked, reused, judgeItems, modelCalls },
  };
}
