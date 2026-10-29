/**
 * Graph verdicts (madarch-mwhd.1). Every judge here is a fake; no test starts a
 * model. These prove deterministic rules, exact batches of 50, cache reuse,
 * incremental revalidation, both budgets, validator-version invalidation, and
 * that a failed or unassigned item stays unreviewed rather than becoming valid.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GRAPH_VERDICT_BUDGETS,
  JUDGE_BATCH_SIZE,
  runGraphVerdicts,
  type GraphEdgeItem,
  type GraphJudge,
  type GraphJudgeAnswer,
  type GraphJudgeItem,
  type GraphNodeItem,
  type GraphSnapshot,
  type GraphVerdict,
} from '../src/knowledge/graph-verdicts.js';
import { JudgeExecutionError } from '../src/knowledge/answer-key-judge.js';
import { emptyModelAssignments, resolveModelRoles, type ModelPair, type ModelRoleView } from '../src/knowledge/model-roles.js';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const span = (path: string, lineStart = 1, lineEnd = 2) => ({ path, lineStart, lineEnd });

function node(id: string, kind: string, properties: unknown, label = id): GraphNodeItem {
  return { id, versionId: `${id}-v1`, kind, label, properties };
}

const file = (id = 'file-a', path = 'src/a.ts', lines = 10): GraphNodeItem => node(id, 'code.file', {
  path, lines, sha256: SHA, recordKey: `code.file:${id}`, span: span(path, 1, lines),
});
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

function edge(id: string, kind: string, from: string, to: string, properties: unknown = {}, position?: { start: number; end: number }, label?: string): GraphEdgeItem {
  return { id, versionId: `${id}-v1`, kind, from, to, ...(label === undefined ? {} : { label }), ...(position === undefined ? {} : { position }), properties };
}

const withFiles = (...nodes: GraphNodeItem[]): GraphSnapshot => {
  const held = [...nodes];
  if (!held.some((one) => one.kind === 'code.file' && (one.properties as { path?: string }).path === 'db/schema.sql')) held.push(file('file-db', 'db/schema.sql', 10));
  if (!held.some((one) => one.kind === 'code.file' && (one.properties as { path?: string }).path === 'src/a.ts')) held.push(file());
  return { nodes: held, edges: [] };
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

describe('deterministic graph rules', () => {
  test('a code.file and a database with schema evidence are valid without a judge', async () => {
    const held = withFiles(database());
    const result = await runGraphVerdicts({ snapshot: { ...held, nodes: [...held.nodes, ...unknownNodes(1)] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(result.metrics.judgeItems).toBe(0);
    expect(rowOf(result, 'file-a')?.verdict).toBe('valid');
    expect(rowOf(result, 'db-a')?.verdict).toBe('valid');
  });

  test('a file path the history no longer holds is valid from its own span and record key', async () => {
    const gone = node('file-gone', 'code.file', { recordKey: 'code.file:src/gone.ts', span: span('src/gone.ts', 1, 1), authors: [], commitCount: 2 });
    const result = await runGraphVerdicts({ snapshot: withFiles(gone), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(rowOf(result, 'file-gone')).toMatchObject({ verdict: 'valid', source: 'rule', rule: 'node-file' });
  });

  test('a planted database whose evidence resolves to no code.file is invalid by rule, never valid', async () => {
    const invented = database('db-invented', {
      path: 'migrations/9999-invented.sql',
      span: span('migrations/9999-invented.sql', 1, 2),
      evidence: [{ kind: 'schema', path: 'migrations/9999-invented.sql', line: 1 }],
    });
    const result = await runGraphVerdicts({ snapshot: withFiles(invented), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    const row = rowOf(result, 'db-invented');
    expect(row?.verdict).toBe('invalid');
    expect(row?.source).toBe('rule');
    expect(row?.reason).toContain('not a code.file');
    expect(result.metrics.judgeItems).toBe(0);
  });

  test('a span outside its code.file is invalid with the path and lines in the reason', async () => {
    const wrong = symbol('symbol-wrong', 'src/a.ts');
    const result = await runGraphVerdicts({ snapshot: withFiles(wrong), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(rowOf(result, 'symbol-wrong')?.verdict).toBe('valid');
    const outside = node('outside', 'code.symbol', { path: 'src/a.ts', name: 'outside', recordKey: 'code.symbol:src/a.ts#outside', span: span('src/a.ts', 9, 12) });
    const second = await runGraphVerdicts({ snapshot: withFiles(outside), roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(rowOf(second, 'outside')?.verdict).toBe('invalid');
    expect(rowOf(second, 'outside')?.reason).toContain('src/a.ts:9-12');
    expect(rowOf(second, 'outside')?.reason).toContain('10 lines');
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
    const first = await runGraphVerdicts({
      snapshot: withFiles(file(), node('x-1', 'x.widget', {})),
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 10, modelCallsPerRun: 2 },
      judgeFor: factory({ classification: firstJudge }),
    });
    expect(first.metrics.judgeItems).toBe(1);
    const second = await runGraphVerdicts({
      snapshot: withFiles(file(), node('x-1', 'x.widget', {})),
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 10, modelCallsPerRun: 2 },
      previous: first.cache,
      judgeFor: () => { throw new Error('the judge must not start'); },
    });
    expect(second.metrics.reused).toBe(first.rows.length);
    expect(second.metrics.modelCalls).toBe(0);
    expect(second.rows.map((row) => [row.id, row.verdict])).toEqual(first.rows.map((row) => [row.id, row.verdict]));
  });

  test('a changed file revalidates only itself, and the validator version invalidates everything', async () => {
    const firstSnapshot: GraphSnapshot = {
      nodes: [file('file-a', 'src/a.ts', 10), symbol('symbol-a'), file('file-b', 'src/b.ts', 10), node('file-thing', 'code.file', { path: 'src/b.ts', lines: 10, sha256: SHA, recordKey: 'code.file:thing', span: span('src/b.ts', 1, 10) })],
      edges: [edge('edge-a', 'code.contains', 'file-a', 'symbol-a', { span: span('src/a.ts', 2, 3) })],
    };
    const first = await runGraphVerdicts({ snapshot: firstSnapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    const changed: GraphSnapshot = {
      nodes: firstSnapshot.nodes.map((one) => one.id === 'file-b' ? { ...one, properties: { ...(one.properties as object), lines: 11, span: span('src/b.ts', 1, 11) } } : one),
      edges: firstSnapshot.edges,
    };
    const second = await runGraphVerdicts({ snapshot: changed, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, previous: first.cache });
    expect(second.metrics.checked).toBe(1);
    expect(second.metrics.reused).toBe(first.rows.length - 1);
    const third = await runGraphVerdicts({ snapshot: changed, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, previous: second.cache, validatorVersion: '2' });
    expect(third.metrics.reused).toBe(0);
    expect(third.metrics.checked).toBe(third.rows.length);
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
    const jev = new FakeJudge((item) => item.id === 'x-1'
      ? { id: item.id, verdict: 'unsure', reason: 'jev cannot tell' }
      : { id: item.id, verdict: 'invalid', reason: 'jev says no' });
    const classification = new FakeJudge((item) => ({ id: item.id, verdict: 'valid', reason: 'classification sees it' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(2), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 2, modelCallsPerRun: 2 },
      jev,
      judgeFor: factory({ classification }),
    });
    expect(rowOf(result, 'x-0')?.verdict).toBe('invalid');
    expect(rowOf(result, 'x-0')?.source).toBe('jev');
    expect(rowOf(result, 'x-1')?.verdict).toBe('valid');
    expect(rowOf(result, 'x-1')?.source).toBe('classification');
    expect(classification.calls.map((call) => call.map((item) => item.id))).toEqual([['x-1']]);
    expect(result.metrics.modelCalls).toBe(2);
  });

  test('with jev present, what it leaves unsure goes through classification and analysis to a person', async () => {
    const jev = new FakeJudge((item) => item.id === 'x-0'
      ? { id: item.id, verdict: 'valid', reason: 'jev read it' }
      : { id: item.id, verdict: 'unsure', reason: `jev cannot tell ${item.id}` });
    const classification = new FakeJudge((item) => item.id === 'x-1'
      ? { id: item.id, verdict: 'valid', reason: 'classification sees it' }
      : { id: item.id, verdict: 'unsure', reason: 'classification cannot tell' });
    const analysis = new FakeJudge((item) => ({ id: item.id, verdict: 'unsure', reason: 'analysis cannot tell' }));
    const result = await runGraphVerdicts({
      snapshot: { nodes: unknownNodes(3), edges: [] },
      roles: TWO_ROLES,
      budgets: { itemsPerRun: 3, modelCallsPerRun: 3 },
      jev,
      judgeFor: factory({ classification, analysis }),
    });
    expect(jev.calls.map((call) => call.map((item) => item.id))).toEqual([['x-0', 'x-1', 'x-2']]);
    expect(classification.calls.map((call) => call.map((item) => item.id))).toEqual([['x-1', 'x-2']]);
    expect(analysis.calls.map((call) => call.map((item) => item.id))).toEqual([['x-2']]);
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
    const classification = new FakeJudge((item) => item.id === 'x-0'
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
    expect(analysis.calls[0]?.map((item) => item.id)).toEqual(['x-1']);
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

  test('an invented answer id is ignored and an unknown verdict is never stored as valid', async () => {
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
  });
});

describe('the report', () => {
  test('counts every node and edge in the report, with one line per kind', async () => {
    const held = withFiles(database());
    const result = await runGraphVerdicts({ snapshot: { ...held, nodes: [...held.nodes, ...unknownNodes(1)] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
    expect(result.report.totals.items).toBe(result.rows.length);
    expect(result.report.totals.nodes + result.report.totals.edges).toBe(result.report.totals.items);
    expect(result.report.byKind.every((kind) => kind.total === kind.valid + kind.invalid + kind.unreviewed)).toBe(true);
    expect(result.report.byKind.some((kind) => kind.kind === 'code.database')).toBe(true);
    expect(result.report.reasons.every((one) => result.rows.some((row) => row.verdict !== 'valid' && row.reason === one.reason))).toBe(true);
    expect(result.report.reasons.some((one) => one.reason.includes('at most 0'))).toBe(true);
  });
});
