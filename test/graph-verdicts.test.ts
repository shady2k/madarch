/**
 * Graph verdicts (madarch-mwhd.1). Every judge here is a fake; no test starts a
 * model. The repository fixtures are texts the tests hold, read at the fill's
 * commit by the injected reader: a file the pin does not hold, bytes that
 * contradict a digest, and a database whose evidence never names it stay
 * unreviewed, never valid. These prove deterministic rules, neighbourhood
 * anomalies escalating instead of passing on a span check, exact batches of
 * 50, cache reuse keyed by evidence and configuration, requeueing of deferred
 * and failed work, both budgets, and that a judge can never make unresolved
 * evidence valid.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  DEFAULT_GRAPH_VERDICT_BUDGETS,
  GRAPH_VERDICT_JUDGE_VERSION,
  JUDGE_BATCH_SIZE,
  runGraphVerdicts,
  type GraphEdgeItem,
  type GraphEvidenceReader,
  type GraphJudge,
  type GraphJudgeAnswer,
  type GraphJudgeItem,
  type GraphNodeItem,
  type GraphSnapshot,
  type GraphVerdict,
} from '../src/knowledge/graph-verdicts.js';
import { GRAPH_RULES } from '../src/knowledge/graph-verdict-rules.js';
import { JudgeExecutionError } from '../src/knowledge/answer-key-judge.js';
import { emptyModelAssignments, resolveModelRoles, type ModelPair, type ModelRoleView } from '../src/knowledge/model-roles.js';

const COMMIT = 'b'.repeat(40);
const span = (path: string, lineStart = 1, lineEnd = 2) => ({ path, lineStart, lineEnd });
const linesOf = (count: number): string => `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`;
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The pinned bytes: what a fill's commit held, as the reader gives them to the engine. */
const TEXTS: Record<string, string> = {
  'src/a.ts': `${linesOf(8)}export const a = 1;\n`,
  'src/b.ts': `${linesOf(8)}export const b = 1;\n`,
  'src/gone.ts': 'export const gone = 1;\n',
  'db/schema.sql': '-- database db-a\ncreate table orders (id text);\n',
  'deploy/app.yaml': 'kind: Deployment\nimage: shop:1\n',
  'routes.ts': 'app.get("/orders", handler);\n',
};
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

/** Reads the fixture texts; `overrides` replaces or removes one path (`null`) for one test. */
const reader = (overrides: Record<string, string | null> = {}): GraphEvidenceReader => async (path) => {
  const held = path in overrides ? overrides[path] : TEXTS[path];
  return held === undefined || held === null ? undefined : { text: held, commit: COMMIT };
};
const noReader = async (): Promise<undefined> => undefined;

function node(id: string, kind: string, properties: unknown, label = id): GraphNodeItem {
  return { id, versionId: `${id}-v1`, kind, label, properties };
}

/** A code.file node whose declared bytes are the fixture's own. */
const file = (id = 'file-a', path = 'src/a.ts', text?: string): GraphNodeItem => {
  const held = text ?? TEXTS[path] ?? '';
  return node(id, 'code.file', {
    path, lines: lineCount(held), sha256: sha(held), recordKey: `code.file:${path}`, span: span(path, 1, held.split('\n').length),
  });
};
const symbol = (id = 'symbol-a', path = 'src/a.ts', name = 'a'): GraphNodeItem => node(id, 'code.symbol', {
  path, name, recordKey: `code.symbol:${path}#${name}`, span: span(path, 2, 3),
});
const database = (id = 'db-a', properties: unknown = {}): GraphNodeItem => node(id, 'code.database', {
  path: 'db/schema.sql', span: span('db/schema.sql', 1, 2), evidenceKind: 'schema',
  evidence: [{ kind: 'schema', path: 'db/schema.sql', line: 1 }], ...properties as object,
});
const table = (id = 'table-a', properties: unknown = {}): GraphNodeItem => node(id, 'code.table', {
  database: 'db-a', schema: 'public', span: span('db/schema.sql', 1, 2), ...properties as object,
});
const column = (id = 'column-a', properties: unknown = {}): GraphNodeItem => node(id, 'code.column', {
  type: 'text', span: span('db/schema.sql', 1, 2), ...properties as object,
});
const route = (id = 'route-a', properties: unknown = {}): GraphNodeItem => node(id, 'code.route', {
  method: 'GET', path: '/orders', span: span('routes.ts', 1, 1), ...properties as object,
});

function edge(id: string, kind: string, from: string, to: string, properties: unknown = {}, position?: { start: number; end: number }, label?: string): GraphEdgeItem {
  return { id, versionId: `${id}-v1`, kind, from, to, ...(label === undefined ? {} : { label }), ...(position === undefined ? {} : { position }), properties };
}

/**
 * The file nodes every cited path needs, a table under each database and a
 * column under each table, so a fixture that is meant to be anomalous is
 * anomalous for one reason and not because it has no edge at all.
 */
const withFiles = (...nodes: GraphNodeItem[]): GraphSnapshot => {
  const held = [...nodes];
  const edges: GraphEdgeItem[] = [];
  const fileFor = (path: string): GraphNodeItem => {
    const at = held.findIndex((one) => one.kind === 'code.file' && (one.properties as { path?: string }).path === path);
    if (at !== -1) return held[at]!;
    const made = file(`file:${path}`, path);
    held.push(made);
    return made;
  };
  // The extractor files every node under the file its span names: the file and its nodes stand together, so a fixture
  // that is meant to be anomalous is anomalous for one reason and not for want of any edge at all.
  for (const one of [...held]) {
    if (one.kind === 'code.file') continue;
    const props = one.properties as { span?: { path?: string; lineStart?: number; lineEnd?: number }; path?: string };
    const path = props.span?.path ?? (one.kind === 'code.database' ? props.path : undefined);
    if (typeof path !== 'string' || path === '') continue;
    const place = props.span === undefined ? span(path, 1, 1) : span(path, props.span.lineStart ?? 1, props.span.lineEnd ?? 1);
    edges.push(edge(`${one.id}-in-file`, 'code.contains', fileFor(path).id, one.id, { span: place }));
  }
  for (const db of held.filter((one) => one.kind === 'code.database')) {
    if (held.some((one) => one.id === `${db.id}-table`)) continue;
    const heldTable = table(`${db.id}-table`, { database: db.label });
    const heldColumn = column(`${db.id}-column`);
    held.push(heldTable, heldColumn);
    edges.push(edge(`${db.id}-has-table`, 'code.contains', db.id, heldTable.id, { span: span('db/schema.sql', 1, 2) }));
    edges.push(edge(`${db.id}-table-has-column`, 'code.contains', heldTable.id, heldColumn.id, { span: span('db/schema.sql', 1, 2) }));
  }
  return { nodes: held, edges };
};

const NO_ROLES = resolveModelRoles(emptyModelAssignments());
const TWO_ROLES = resolveModelRoles({ writing: { agent: 'writer' }, classification: { agent: 'classifier' }, analysis: { agent: 'analyst' } });
const pairOf = (view: ModelRoleView, agent: string): ModelPair => view.roles.find((role) => role.pair?.agent === agent)?.pair ?? { agent };

class FakeJudge implements GraphJudge {
  readonly calls: GraphJudgeItem[][] = [];
  constructor(private readonly answer: (item: GraphJudgeItem, call: number) => GraphJudgeAnswer | undefined) {}
  async judge(items: readonly GraphJudgeItem[]): Promise<readonly GraphJudgeAnswer[]> {
    const call = this.calls.length;
    this.calls.push([...items]);
    return items.flatMap((item) => {
      const answer = this.answer(item, call);
      return answer === undefined ? [] : [answer];
    });
  }
}

const factory = (held: Partial<Record<'classification' | 'analysis', GraphJudge>>) => (pair: ModelPair, role: 'classification' | 'analysis'): GraphJudge => {
  const judge = held[role];
  if (judge === undefined) throw new Error(`no ${role} judge for ${pair.agent}`);
  return judge;
};

const unknownNodes = (count: number): GraphNodeItem[] => Array.from({ length: count }, (_, index) => node(`x-${index}`, 'x.widget', {}));

const rowOf = (result: Awaited<ReturnType<typeof runGraphVerdicts>>, id: string) => result.rows.find((row) => row.id === id);
const reasons = (result: Awaited<ReturnType<typeof runGraphVerdicts>>) => result.rows.map((row) => row.reason).join('\n');

describe('deterministic graph rules read the pinned bytes', () => {
  test('a code.file and a database whose schema names it are valid without a judge', async () => {
    const result = await runGraphVerdicts({ snapshot: withFiles(database()), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(result.metrics.judgeItems).toBe(0);
    expect(rowOf(result, 'file:db/schema.sql')?.verdict).toBe('valid');
    expect(rowOf(result, 'db-a')?.verdict).toBe('valid');
  });

  test('a file present at the fill commit is valid from its own span, digest and record key', async () => {
    const gone = file('file-gone', 'src/gone.ts');
    const heldSymbol = node('symbol-gone', 'code.symbol', { path: 'src/gone.ts', name: 'gone', recordKey: 'code.symbol:src/gone.ts#gone', span: span('src/gone.ts', 1, 1) });
    const result = await runGraphVerdicts({ snapshot: withFiles(gone, heldSymbol), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(result, 'file-gone')).toMatchObject({ verdict: 'valid', source: 'rule', rule: 'node-file' });
  });

  test('a file the fill commit does not hold is unreviewed, never valid, and the reason names it', async () => {
    const held = node('file-gone', 'code.file', { path: 'src/gone.ts', lines: 1, sha256: sha(TEXTS['src/gone.ts']!), recordKey: 'code.file:src/gone.ts', span: span('src/gone.ts', 1, 2) });
    const result = await runGraphVerdicts({ snapshot: { nodes: [held], edges: [] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader({ 'src/gone.ts': null }) });
    expect(rowOf(result, 'file-gone')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'file-gone')?.reason).toContain('src/gone.ts');
    expect(rowOf(result, 'file-gone')?.reason).toContain("fill's commit");
  });

  test('with no pinned reader nothing with evidence is valid, and the reason says why', async () => {
    const result = await runGraphVerdicts({ snapshot: withFiles(database()), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(rowOf(result, 'file:db/schema.sql')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'db-a')?.verdict).toBe('unreviewed');
    expect(reasons(result)).toContain('no pinned repository reader was configured');
  });

  test('bytes that contradict the recorded digest or line count are unreviewed, naming the path and the pinned bytes', async () => {
    const stale = file('file-a');
    const wrongDigest = node('file-sha', 'code.file', { ...(stale.properties as object), recordKey: 'code.file:src/a.ts', sha256: 'c'.repeat(64) });
    const first = await runGraphVerdicts({ snapshot: { nodes: [wrongDigest], edges: [] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(first, 'file-sha')?.verdict).toBe('unreviewed');
    expect(rowOf(first, 'file-sha')?.reason).toContain('sha256');
    expect(rowOf(first, 'file-sha')?.reason).toContain('src/a.ts');
    const wrongLines = node('file-lines', 'code.file', { ...(stale.properties as object), recordKey: 'code.file:src/a.ts', lines: 11 });
    const second = await runGraphVerdicts({ snapshot: { nodes: [wrongLines], edges: [] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(second, 'file-lines')?.verdict).toBe('unreviewed');
    expect(rowOf(second, 'file-lines')?.reason).toContain('11 lines');
  });

  test('a span outside the pinned file is unreviewed with the path and lines in the reason', async () => {
    const valid = symbol('symbol-wrong', 'src/a.ts');
    const first = await runGraphVerdicts({ snapshot: withFiles(valid), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(first, 'symbol-wrong')?.verdict).toBe('valid');
    const outside = node('outside', 'code.symbol', { path: 'src/a.ts', name: 'outside', recordKey: 'code.symbol:src/a.ts#outside', span: span('src/a.ts', 9, 20) });
    const second = await runGraphVerdicts({ snapshot: withFiles(outside), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(second, 'outside')?.verdict).toBe('unreviewed');
    expect(rowOf(second, 'outside')?.reason).toContain('src/a.ts:9-20');
    expect(rowOf(second, 'outside')?.reason).toContain('10 lines');
  });

  test('a database whose cited schema never names it is unreviewed, never valid', async () => {
    const invented = database('db-a', { label: 'db-b' });
    const named = node('db-b', 'code.database', { ...(invented.properties as object), label: 'db-b' }, 'db-b');
    const result = await runGraphVerdicts({ snapshot: withFiles(named), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(result, 'db-b')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'db-b')?.reason).toContain('db-b');
    expect(rowOf(result, 'db-b')?.reason).toContain('no evidence place naming it');
  });

  test('a database whose evidence names a path the pinned repository does not hold is unreviewed', async () => {
    const invented = database('db-invented', {
      path: 'migrations/9999-invented.sql', span: span('migrations/9999-invented.sql', 1, 2),
      evidence: [{ kind: 'schema', path: 'migrations/9999-invented.sql', line: 1 }],
    });
    const result = await runGraphVerdicts({ snapshot: withFiles(invented), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(rowOf(result, 'db-invented')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'db-invented')?.reason).toContain('migrations/9999-invented.sql');
  });
});

describe('a valid shape with an anomalous neighbourhood goes to the judge', () => {
  const judged = async (nodes: GraphNodeItem[], edges: GraphEdgeItem[], answer: 'valid' | 'unsure' = 'unsure') => {
    const judge = new FakeJudge((item) => ({ id: item.id, verdict: answer, reason: `read ${item.kind}` }));
    const second = new FakeJudge((item) => ({ id: item.id, verdict: answer, reason: `read ${item.kind} again` }));
    const result = await runGraphVerdicts({
      snapshot: { nodes, edges }, roles: TWO_ROLES, budgets: { itemsPerRun: 20, modelCallsPerRun: 3 },
      readEvidence: reader(), judgeFor: factory({ classification: judge, analysis: second }),
    });
    return { result, judge };
  };

  test('a database with no table, migration or use is sent to the judge instead of passing on its span', async () => {
    const held = database();
    const { result, judge } = await judged([held], []);
    expect(rowOf(result, 'db-a')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'db-a')?.reason).toContain('database with no table');
    expect(judge.calls.flat().some((item) => item.id === 'node:db-a')).toBe(true);
  });

  test('a route with no registered handler is sent to the judge', async () => {
    const operation = node('op-a', 'code.operation', { method: 'get', path: '/orders' });
    const held = route();
    const { result, judge } = await judged([held, operation, file('file-r', 'routes.ts')], [edge('serves-a', 'code.serves', 'route-a', 'op-a', {})]);
    expect(rowOf(result, 'route-a')?.reason).toContain('route with no registered handler');
    expect(judge.calls.flat().some((item) => item.id === 'node:route-a')).toBe(true);
  });

  test('a table nobody reads or writes is sent to the judge', async () => {
    const heldTable = table();
    const { result } = await judged([heldTable, column()], [edge('table-column', 'code.contains', 'table-a', 'column-a', { span: span('db/schema.sql', 1, 1) })]);
    expect(rowOf(result, 'table-a')?.reason).toContain('table nobody reads or writes');
  });

  test('an environment variable read but defined nowhere is sent to the judge', async () => {
    const envVar = node('env-var-a', 'code.env-var', { name: 'SHOP_URL', span: span('src/a.ts', 1, 1) });
    const readerNode = node('reads-a', 'code.service', { span: span('src/a.ts', 2, 2) });
    const { result } = await judged([envVar, readerNode], [edge('reads-a', 'code.reads-env', 'reads-a', 'env-var-a', { span: span('src/a.ts', 2, 2) })]);
    expect(rowOf(result, 'env-var-a')?.reason).toContain('defined nowhere');
  });

  test('an environment variable defined but never read is sent to the judge', async () => {
    const definition = node('env-def-a', 'code.env-definition', { name: 'SHOP_URL', span: span('src/a.ts', 1, 1) });
    const envVar = node('env-var-a', 'code.env-var', { name: 'SHOP_URL' });
    const { result } = await judged([definition, envVar, file()], [edge('defines-a', 'code.defines', 'env-def-a', 'env-var-a', { span: span('src/a.ts', 1, 1) })]);
    expect(rowOf(result, 'env-def-a')?.reason).toContain('defined but never read');
  });

  test('a deployment with no image is sent to the judge', async () => {
    const deployment = node('deploy-a', 'code.k8s-deployment', { replicas: 1, span: span('deploy/app.yaml', 1, 2) }, 'shop');
    const broker = node('broker-a', 'code.channel', { protocol: 'kafka' }, 'orders');
    const { result } = await judged([deployment, broker], [edge('runs-a', 'code.runs', 'deploy-a', 'broker-a', {})]);
    expect(rowOf(result, 'deploy-a')?.reason).toContain('deployment with no image');
  });

  test('a contract operation no route serves is sent to the judge', async () => {
    const operation = node('op-a', 'code.operation', { method: 'get', path: '/orders', span: span('src/a.ts', 1, 1) });
    const { result, judge } = await judged([operation, file()], []);
    expect(rowOf(result, 'op-a')?.reason).toContain('contract operation no route serves');
    expect(judge.calls.flat().some((item) => item.id === 'node:op-a')).toBe(true);
  });

  test('a channel with no consumer is sent to the judge', async () => {
    const channel = node('chan-a', 'code.channel', { protocol: 'kafka', topic: 'orders', span: span('src/a.ts', 1, 1) });
    const { result, judge } = await judged([channel, file()], []);
    expect(rowOf(result, 'chan-a')?.reason).toContain('channel with no consumer');
    expect(judge.calls.flat().some((item) => item.id === 'node:chan-a')).toBe(true);
  });

  test('an interface with no implementation or reference is sent to the judge', async () => {
    const held = node('shape-a', 'code.symbol', {
      path: 'src/a.ts', name: 'Shape', symbolKind: 'interface', recordKey: 'code.symbol:src/a.ts#Shape', span: span('src/a.ts', 2, 3),
    });
    const { result, judge } = await judged([held, file()], []);
    expect(rowOf(result, 'shape-a')?.reason).toContain('interface with no implementation or reference');
    expect(judge.calls.flat().some((item) => item.id === 'node:shape-a')).toBe(true);
  });

  test('a test that tests nothing is sent to the judge', async () => {
    const held = node('test-a', 'code.test-case', { name: 'tests a', span: span('src/a.ts', 1, 1) });
    const { result, judge } = await judged([held, file()], []);
    expect(rowOf(result, 'test-a')?.reason).toContain('test that tests nothing');
    expect(judge.calls.flat().some((item) => item.id === 'node:test-a')).toBe(true);
  });

  test('a node of a kind with no narrower rule and no edge is sent to the judge', async () => {
    const held = node('fn-a', 'code.symbol', { path: 'src/a.ts', name: 'fn', recordKey: 'code.symbol:src/a.ts#fn', span: span('src/a.ts', 1, 1) });
    const { result, judge } = await judged([held, file()], []);
    expect(rowOf(result, 'fn-a')?.reason).toContain('node with no edge');
    expect(judge.calls.flat().some((item) => item.id === 'node:fn-a')).toBe(true);
  });

  test('a judge may decide an anomalous item from the neighbourhood facts it is shown', async () => {
    const held = database();
    const judge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'the schema is this database' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: [held, file('file-db', 'db/schema.sql')], edges: [] }, roles: TWO_ROLES,
      budgets: { itemsPerRun: 5, modelCallsPerRun: 1 }, readEvidence: reader(), judgeFor: factory({ classification: judge }),
    });
    const seen = judge.calls.flat().find((item) => item.id === 'node:db-a');
    expect(seen?.reason).toContain('database with no table');
    expect(seen?.evidence[0]?.excerpt).toContain('database db-a');
    expect(seen?.evidenceResolved).toBe(true);
    expect(rowOf(result, 'db-a')).toMatchObject({ verdict: 'valid', source: 'classification' });
  });
});

describe('an unresolved verdict is never made valid', () => {
  test('a judge that says valid about unresolved evidence leaves the item unreviewed', async () => {
    const judge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'looks fine' }));
    const gone = node('file-gone', 'code.file', { path: 'src/gone.ts', lines: 1, sha256: sha(TEXTS['src/gone.ts']!), recordKey: 'code.file:src/gone.ts', span: span('src/gone.ts', 1, 2) });
    const result = await runGraphVerdicts({
      snapshot: { nodes: [gone], edges: [] }, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      readEvidence: reader({ 'src/gone.ts': null }), judgeFor: factory({ classification: judge }),
    });
    const seen = judge.calls.flat()[0];
    expect(seen?.evidenceResolved).toBe(false);
    expect(seen?.unresolved).toContain('src/gone.ts');
    expect(rowOf(result, 'file-gone')?.verdict).toBe('unreviewed');
    expect(rowOf(result, 'file-gone')?.source).toBe('unresolved');
    expect(rowOf(result, 'file-gone')?.reason).toContain('the cited evidence is unresolved');
  });

  test('a valid answer about an item with no evidence to resolve still stands', async () => {
    const judge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'the shape is consistent' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] }, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      judgeFor: factory({ classification: judge }),
    });
    expect(rowOf(result, 'x-0')).toMatchObject({ verdict: 'valid', source: 'classification' });
  });
});

describe('judging', () => {
  test('sends exactly 50, 50 and 20 items to classification, then only its unsure items to analysis', async () => {
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: `classification unsure ${item.id}` }));
    const analysis = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: `analysis unsure ${item.id}` }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(120), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 200, modelCallsPerRun: 10 },
      judgeFor: factory({ classification, analysis }),
    });
    expect(classification.calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(analysis.calls.map((call) => call.length)).toEqual([50, 50, 20]);
    expect(result.metrics.modelCalls).toBe(6);
    expect(result.rows).toHaveLength(120);
    expect(result.rows.every((row) => row.verdict === 'unreviewed' && row.source === 'person')).toBe(true);
  });

  test('reuses every unchanged verdict on the second run and starts no judge', async () => {
    const firstJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'the place exists' }));
    const snapshot = withFiles(file(), symbol(), node('x-1', 'x.widget', {}));
    const first = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 10, modelCallsPerRun: 2 },
      readEvidence: reader(), judgeFor: factory({ classification: firstJudge }),
    });
    expect(first.metrics.judgeItems).toBe(1);
    const second = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 10, modelCallsPerRun: 2 }, readEvidence: reader(),
      previous: first.cache,
      judgeFor: () => { throw new Error('the judge must not start'); },
    });
    expect(second.metrics.reused).toBe(first.rows.length);
    expect(second.metrics.modelCalls).toBe(0);
    expect(second.rows.map((row) => [row.id, row.verdict])).toEqual(first.rows.map((row) => [row.id, row.verdict]));
  });

  test('a changed file revalidates only itself, and the validator version invalidates everything', async () => {
    const firstSnapshot: GraphSnapshot = {
      nodes: [file('file-a', 'src/a.ts'), symbol('symbol-a'), file('file-b', 'src/b.ts')],
      edges: [edge('edge-a', 'code.contains', 'file-a', 'symbol-a', { span: span('src/a.ts', 2, 3) })],
    };
    const first = await runGraphVerdicts({ snapshot: firstSnapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    const changed: GraphSnapshot = {
      nodes: firstSnapshot.nodes.map((one) => one.id === 'file-b' ? { ...one, properties: { ...(one.properties as object), lines: 11, sha256: sha(TEXTS['src/b.ts']!), span: span('src/b.ts', 1, 11) } } : one),
      edges: firstSnapshot.edges,
    };
    const second = await runGraphVerdicts({ snapshot: changed, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader(), previous: first.cache });
    expect(second.metrics.checked).toBe(1);
    expect(second.metrics.reused).toBe(first.rows.length - 1);
    const third = await runGraphVerdicts({ snapshot: changed, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader(), previous: second.cache, validatorVersion: '2' });
    expect(third.metrics.reused).toBe(0);
    expect(third.metrics.checked).toBe(third.rows.length);
  });

  test('a changed rule set or judge identity invalidates verdicts a judge had resolved', async () => {
    const snapshot = { nodes: unknownNodes(1), edges: [] };
    const firstJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'classification sees it' }));
    const first = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      judgeFor: factory({ classification: firstJudge }),
    });
    expect(rowOf(first, 'x-0')?.source).toBe('classification');
    const secondJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'another classifier sees it' }));
    const otherRoles = resolveModelRoles({ writing: { agent: 'writer' }, classification: { agent: 'other-classifier' }, analysis: { agent: 'analyst' } });
    const second = await runGraphVerdicts({
      snapshot, roles: otherRoles, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 }, previous: first.cache,
      judgeFor: factory({ classification: secondJudge }),
    });
    expect(second.metrics.reused).toBe(0);
    expect(second.metrics.modelCalls).toBe(1);
    expect(secondJudge.calls).toHaveLength(1);
    const editedRules = { ...GRAPH_RULES, nodes: GRAPH_RULES.nodes.map((rule) => rule.id === 'node-fallback' ? { ...rule, kindPrefix: 'x.' } : rule) };
    const thirdJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'a third read' }));
    const third = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 }, previous: first.cache, rules: editedRules,
      judgeFor: factory({ classification: thirdJudge }),
    });
    expect(third.metrics.reused).toBe(0);
    expect(rowOf(third, 'x-0')?.verdict).toBe('valid');
    expect(thirdJudge.calls).toHaveLength(1);
  });

  test('a budget deferral is taken up by the next run even when the snapshot, rules and judge are unchanged', async () => {
    const snapshot = { nodes: unknownNodes(5), edges: [] };
    const firstJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'seen' }));
    const first = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 2, modelCallsPerRun: 1 }, judgeFor: factory({ classification: firstJudge }),
    });
    expect(first.rows.filter((row) => row.source === 'budget')).toHaveLength(3);
    const secondJudge = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'seen now' }));
    const second = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 2, modelCallsPerRun: 1 }, previous: first.cache,
      judgeFor: factory({ classification: secondJudge }),
    });
    expect(second.metrics.checked).toBeGreaterThan(0);
    expect(secondJudge.calls.flat()).toHaveLength(2);
    expect(second.rows.filter((row) => row.source === 'budget')).toHaveLength(1);
  });

  test('a judge that failed is retried by the next run, not reused', async () => {
    const snapshot = { nodes: unknownNodes(1), edges: [] };
    const dead: GraphJudge = { async judge() { throw new JudgeExecutionError('the classifier did not start: the adapter is not installed'); } };
    const first = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 }, judgeFor: factory({ classification: dead }),
    });
    expect(rowOf(first, 'x-0')?.source).toBe('judge-failed');
    const alive = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'seen now' }));
    const second = await runGraphVerdicts({
      snapshot, roles: TWO_ROLES, budgets: { itemsPerRun: 1, modelCallsPerRun: 1 }, previous: first.cache,
      judgeFor: factory({ classification: alive }),
    });
    expect(alive.calls).toHaveLength(1);
    expect(rowOf(second, 'x-0')).toMatchObject({ verdict: 'valid', source: 'classification' });
  });

  test('honours itemsPerRun and modelCallsPerRun, leaving the rest unreviewed with a budget reason', async () => {
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'seen' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(10), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 3, modelCallsPerRun: 1 },
      judgeFor: factory({ classification }),
    });
    expect(result.rows.filter((row) => row.verdict === 'valid')).toHaveLength(3);
    expect(result.rows.filter((row) => row.source === 'budget')).toHaveLength(7);
    expect(result.rows.filter((row) => row.source === 'budget').every((row) => row.reason.includes('at most 3'))).toBe(true);
    expect(result.metrics.modelCalls).toBe(1);
  });

  test('modelCallsPerRun zero leaves admitted items unreviewed and starts no judge', async () => {
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(2), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 2, modelCallsPerRun: 0 },
      judgeFor: () => { throw new Error('the judge must not start'); },
    });
    expect(result.rows.every((row) => row.verdict === 'unreviewed' && row.source === 'budget')).toBe(true);
    expect(result.rows[0]?.reason).toContain('allows 0 judge calls');
  });

  test('with no roles and no jev nothing is judged and the reason says where to assign roles', async () => {
    const result = await runGraphVerdicts({ snapshot: { nodes: unknownNodes(2), edges: [] }, roles: NO_ROLES, budgets: DEFAULT_GRAPH_VERDICT_BUDGETS });
    expect(result.metrics.modelCalls).toBe(0);
    expect(result.rows.every((row) => row.verdict === 'unreviewed' && row.source === 'none')).toBe(true);
    expect(result.rows[0]?.reason).toContain('/k/settings');
    expect(result.rows[0]?.reason).toContain('Model roles');
  });

  test('jev judges first; only its unsure item goes on to classification', async () => {
    const jev = new FakeJudge((item) => item.id === 'node:x-1'
      ? { id: item.id, verdict: 'unsure', reason: 'jev cannot tell' }
      : { id: item.id, verdict: 'invalid', reason: 'jev says no' });
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'classification sees it' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(2), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 2, modelCallsPerRun: 2 },
      jev,
      jevVersion: 'test-jev-1',
      judgeFor: factory({ classification }),
    });
    expect(rowOf(result, 'x-0')?.verdict).toBe('invalid');
    expect(rowOf(result, 'x-0')?.source).toBe('jev');
    expect(rowOf(result, 'x-1')?.verdict).toBe('valid');
    expect(rowOf(result, 'x-1')?.source).toBe('classification');
    expect(classification.calls.map((call) => call.map((item) => item.id))).toEqual([['node:x-1']]);
    expect(result.metrics.modelCalls).toBe(2);
  });

  test('with jev present, what it leaves unsure goes through classification and analysis to a person', async () => {
    const jev = new FakeJudge((item) => item.id === 'node:x-0'
      ? { id: item.id, verdict: 'valid', reason: 'jev read it' }
      : { id: item.id, verdict: 'unsure', reason: `jev cannot tell ${item.id}` });
    const classification = new FakeJudge((item) => item.id === 'node:x-1'
      ? { id: item.id, verdict: 'valid', reason: 'classification sees it' }
      : { id: item.id, verdict: 'unsure', reason: 'classification cannot tell' });
    const analysis = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: 'analysis cannot tell' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(3), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 3, modelCallsPerRun: 3 },
      jev,
      jevVersion: 'test-jev-1',
      judgeFor: factory({ classification, analysis }),
    });
    expect(jev.calls.map((call) => call.map((item) => item.id))).toEqual([['node:x-0', 'node:x-1', 'node:x-2']]);
    expect(classification.calls.map((call) => call.map((item) => item.id))).toEqual([['node:x-1', 'node:x-2']]);
    expect(analysis.calls.map((call) => call.map((item) => item.id))).toEqual([['node:x-2']]);
    expect(rowOf(result, 'x-0')?.source).toBe('jev');
    expect(rowOf(result, 'x-1')?.source).toBe('classification');
    expect(rowOf(result, 'x-2')?.source).toBe('person');
    expect(rowOf(result, 'x-2')?.reason).toContain('both judges stayed unsure');
    expect(result.metrics.modelCalls).toBe(3);
  });

  test('with jev and no model role, what jev leaves unsure reaches a person', async () => {
    const jev = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: 'jev cannot tell' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: NO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      jev,
      judgeFor: () => { throw new Error('no model role may start'); },
    });
    expect(rowOf(result, 'x-0')?.source).toBe('person');
    expect(rowOf(result, 'x-0')?.reason).toContain('jev cannot tell');
    expect(result.metrics.modelCalls).toBe(1);
  });

  test('classification unsure with no analysis role reaches a person, not an unjudged failure', async () => {
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: 'classification cannot tell' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: resolveModelRoles({ ...emptyModelAssignments(), classification: { agent: 'classifier' } }),
      budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      judgeFor: factory({ classification }),
    });
    expect(rowOf(result, 'x-0')?.source).toBe('person');
    expect(rowOf(result, 'x-0')?.reason).toContain('analysis is unassigned');
  });

  test('classification reads every unsure item and only its unsure reaches analysis', async () => {
    const classification = new FakeJudge((item) => item.id === 'node:x-0'
      ? { id: item.id, verdict: 'valid', reason: 'classification sees it' }
      : { id: item.id, verdict: 'unsure', reason: 'classification unsure' });
    const analysis = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'analysis sees it' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(2), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 2, modelCallsPerRun: 2 },
      judgeFor: factory({ classification, analysis }),
    });
    expect(analysis.calls).toHaveLength(1);
    expect(analysis.calls[0]?.map((item) => item.id)).toEqual(['node:x-1']);
    expect(rowOf(result, 'x-0')?.source).toBe('classification');
    expect(rowOf(result, 'x-1')?.source).toBe('analysis');
  });

  test('a judge reason is stored on one line', async () => {
    const chatty = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'first line\n\tsecond line' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      judgeFor: factory({ classification: chatty }),
    });
    expect(result.rows[0]?.reason).toBe('first line second line');
  });

  test('a judge that could not run leaves every item unjudged, never valid', async () => {
    const dead: GraphJudge = {
      async judge() { throw new JudgeExecutionError('the classifier did not start: the adapter is not installed'); },
    };
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(2), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 2, modelCallsPerRun: 2 },
      judgeFor: factory({ classification: dead }),
    });
    expect(result.rows.every((row) => row.verdict === 'unreviewed' && row.source === 'judge-failed')).toBe(true);
    expect(result.rows[0]?.reason).toContain('did not start');
    expect(result.rows[0]?.reason).not.toContain('unsure');
  });

  test('an analysis that fails keeps its failure reason, not a claim that both judges were unsure', async () => {
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: 'classification cannot tell' }));
    const analysis = new FakeJudge(() => undefined);
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 2 },
      judgeFor: factory({ classification, analysis }),
    });
    expect(result.rows[0]?.verdict).toBe('unreviewed');
    expect(result.rows[0]?.source).toBe('judge-failed');
    expect(result.rows[0]?.reason).toContain('the analysis judge returned no verdict');
    expect(result.rows[0]?.reason).not.toContain('both judges stayed unsure');
  });

  test('a judge that answers no item leaves it unreviewed, never valid', async () => {
    const empty = new FakeJudge(() => undefined);
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 2 },
      judgeFor: factory({ classification: empty }),
    });
    expect(result.rows[0]?.verdict).toBe('unreviewed');
    expect(result.rows[0]?.source).toBe('judge-failed');
    expect(result.rows[0]?.reason).toContain('returned no verdict');
  });

  test('an invented answer id is ignored, a base id is not accepted, and an unknown verdict is never stored as valid', async () => {
    const lying = new FakeJudge((item, call) => call === 0
      ? { id: 'invented-id', verdict: 'valid', reason: 'nope' } as GraphJudgeAnswer
      : { id: item.id, verdict: 'maybe' as GraphVerdict as 'valid', reason: 'nope' });
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 1 },
      judgeFor: factory({ classification: lying }),
    });
    expect(result.rows[0]?.verdict).toBe('unreviewed');
    expect(result.rows[0]?.source).toBe('judge-failed');
    // The judge's answer id names the role: `x-0` alone is not the id of any item.
    const base = new FakeJudge(() => ({ id: 'x-0', verdict: 'valid', reason: 'a base id' }));
    const second = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(1), edges: [] }, roles: TWO_ROLES,
      budgets: { itemsPerRun: 1, modelCallsPerRun: 1 }, judgeFor: factory({ classification: base }),
    });
    expect(second.rows[0]?.verdict).toBe('unreviewed');
  });
});

describe('the report', () => {
  test('counts every node and edge in the report, with one line per kind', async () => {
    const result = await runGraphVerdicts({ snapshot: withFiles(database()), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: reader() });
    expect(result.report.totals.items).toBe(result.rows.length);
    expect(result.report.totals.nodes + result.report.totals.edges).toBe(result.report.totals.items);
    expect(result.report.byKind.every((kind) => kind.total === kind.valid + kind.invalid + kind.unreviewed)).toBe(true);
    expect(result.report.byKind.some((kind) => kind.kind === 'code.database')).toBe(true);
    expect(result.report.reasons.every((one) => result.rows.some((row) => row.verdict !== 'valid' && row.reason === one.reason))).toBe(true);
    expect(GRAPH_VERDICT_JUDGE_VERSION).toBe('1');
    expect(JUDGE_BATCH_SIZE).toBe(50);
  });
});
