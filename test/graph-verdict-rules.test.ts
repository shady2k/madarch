/**
 * One test per graph rule (madarch-mwhd.1), all deterministic: no judge and no
 * model. A valid fixture must be `valid` under its own rule; a broken fixture
 * must be `invalid` under that same rule, never left valid.
 */
import { describe, expect, test } from 'bun:test';
import { GRAPH_EDGE_RULES, GRAPH_NODE_RULES, edgeRuleFor, nodeRuleFor } from '../src/knowledge/graph-verdict-rules.js';
import { runGraphVerdicts, type GraphEdgeItem, type GraphNodeItem, type GraphSnapshot } from '../src/knowledge/graph-verdicts.js';
import { emptyModelAssignments, resolveModelRoles } from '../src/knowledge/model-roles.js';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const span = (path: string, lineStart = 1, lineEnd = 3) => ({ path, lineStart, lineEnd });
const NO_ROLES = resolveModelRoles(emptyModelAssignments());

const node = (id: string, kind: string, properties: unknown): GraphNodeItem => ({ id, kind, label: id, properties });
const file = (path = 'src/a.ts', id = `file-${path}`): GraphNodeItem => node(id, 'code.file', { path, lines: 10, sha256: SHA, recordKey: `code.file:${id}`, span: span(path, 1, 10) });
const database = (): GraphNodeItem => node('db', 'code.database', { path: 'db/schema.sql', span: span('db/schema.sql', 1, 2), evidenceKind: 'schema', evidence: [{ kind: 'schema', path: 'db/schema.sql', line: 1 }] });
const table = (): GraphNodeItem => node('table', 'code.table', { database: 'db', schema: 'public', span: span('db/schema.sql', 1, 2) });
const column = (): GraphNodeItem => node('column', 'code.column', { type: 'text', span: span('db/schema.sql', 1, 2) });

const validNode = (ruleId: string): GraphNodeItem => {
  switch (ruleId) {
    case 'node-file': return file();
    case 'node-symbol': return node('symbol', 'code.symbol', { path: 'src/a.ts', name: 'a', recordKey: 'code.symbol:src/a.ts#a', span: span('src/a.ts', 2, 3) });
    case 'node-database': return database();
    case 'node-table': return table();
    case 'node-column': return column();
    case 'node-commit': return node('commit', 'code.commit', { recordKey: `code.commit:${COMMIT}`, committedAt: '2026-01-01T00:00:00Z' });
    case 'node-snapshot': return node('snapshot', 'code.snapshot', { recordKey: 'code.snapshot:one', commit: COMMIT });
    case 'node-task': return node('task', 'code.task', { recordKey: 'code.task:one' });
    case 'node-author': return node('author', 'code.author', { recordKey: 'code.author:one' });
    case 'node-repository': return node('repository', 'code.repository', { path: '/' });
    case 'node-code-other': return node('widget', 'code.widget', { span: span('src/a.ts', 1, 2) });
    case 'node-knowledge-page': return node('page', 'knowledge:page', { file: 'docs/page.md', digest: SHA });
    case 'node-knowledge-section': return node('section', 'knowledge:section', { path: 'docs/page.md', anchor: 'one' });
    case 'node-knowledge-statement': return node('statement', 'knowledge:statement', { page: 'page', line: 1, text: 'one' });
    case 'node-knowledge-product': return node('product', 'knowledge:product', { key: 'knowledge' });
    case 'node-knowledge-other': return node('concept', 'knowledge:concept', {});
    case 'node-engine': return node('engine', 'engine:menu', {});
    case 'node-fallback': return node('custom', 'x.widget', { span: span('src/a.ts', 1, 2) });
    default: throw new Error(`no valid fixture for ${ruleId}`);
  }
};

const invalidNode = (ruleId: string): GraphNodeItem => {
  switch (ruleId) {
    case 'node-file': return node('file-a', 'code.file', { path: 'src/a.ts', lines: 10, sha256: SHA, recordKey: 'code.file:a' });
    case 'node-symbol': return node('symbol', 'code.symbol', { path: 'src/a.ts', name: 'a', recordKey: 'code.symbol:src/a.ts#a' });
    case 'node-database': return node('db', 'code.database', { path: 'db/schema.sql', span: span('db/schema.sql', 1, 2), evidenceKind: 'schema' });
    case 'node-table': return node('table', 'code.table', { schema: 'public', span: span('db/schema.sql', 1, 2) });
    case 'node-column': return node('column', 'code.column', { span: span('db/schema.sql', 1, 2) });
    case 'node-commit': return node('commit', 'code.commit', { committedAt: '2026-01-01T00:00:00Z' });
    case 'node-snapshot': return node('snapshot', 'code.snapshot', { recordKey: 'code.snapshot:one', commit: 'short' });
    case 'node-task': return node('task', 'code.task', {});
    case 'node-author': return node('author', 'code.author', {});
    case 'node-repository': return node('repository', 'code.repository', {});
    case 'node-knowledge-page': return node('page', 'knowledge:page', { digest: SHA });
    case 'node-knowledge-section': return node('section', 'knowledge:section', { path: 'docs/page.md' });
    case 'node-knowledge-statement': return node('statement', 'knowledge:statement', { page: 'page', text: 'one' });
    case 'node-knowledge-product': return node('product', 'knowledge:product', {});
    case 'node-code-other': return node('widget', 'code.widget', { span: { path: 'missing.ts', lineStart: 1, lineEnd: 2 } });
    default: return node('bad', ruleId === 'node-engine' ? 'engine:menu' : ruleId === 'node-knowledge-other' ? 'knowledge:concept' : 'x.widget', { span: { path: 'missing.ts', lineStart: 1, lineEnd: 2 } });
  }
};

describe('node rules', () => {
  for (const rule of GRAPH_NODE_RULES) {
    test(`${rule.id}: a matching item is valid and a broken one is invalid`, async () => {
      const valid = validNode(rule.id);
      const goodSnapshot: GraphSnapshot = { nodes: [file(), file('db/schema.sql', 'file-db'), valid], edges: [] };
      const good = await runGraphVerdicts({ snapshot: goodSnapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
      const goodRow = good.rows.find((row) => row.id === valid.id);
      expect(goodRow?.verdict).toBe('valid');
      expect(goodRow?.rule).toBe(rule.id);
      expect(goodRow?.source).toBe('rule');

      const bad = invalidNode(rule.id);
      const badSnapshot: GraphSnapshot = { nodes: [file(), file('db/schema.sql', 'file-db'), bad], edges: [] };
      const wrong = await runGraphVerdicts({ snapshot: badSnapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
      const badRow = wrong.rows.find((row) => row.id === bad.id);
      expect(badRow?.verdict).toBe('invalid');
      expect(badRow?.rule).toBe(rule.id);
      expect(badRow?.source).toBe('rule');
    });
  }

  test('every node kind picks the rule the table names', () => {
    for (const rule of GRAPH_NODE_RULES) {
      const sample = rule.kind ?? (rule.kindPrefix === '' ? 'x.widget' : `${rule.kindPrefix}other`);
      if (rule.id === 'node-fallback') expect(nodeRuleFor(sample).id).toBe(rule.id);
    }
    expect(nodeRuleFor('code.file').id).toBe('node-file');
    expect(nodeRuleFor('code.unknown').id).toBe('node-code-other');
    expect(nodeRuleFor('knowledge:concept').id).toBe('node-knowledge-other');
    expect(nodeRuleFor('x.widget').id).toBe('node-fallback');
  });
});

const validEdge = (ruleId: string): { nodes: GraphNodeItem[]; edge: GraphEdgeItem } => {
  const service = node('service', 'code.service', { span: span('src/a.ts', 1, 2) });
  const symbol = node('symbol', 'code.symbol', { path: 'src/a.ts', name: 'a', recordKey: 'code.symbol:src/a.ts#a', span: span('src/a.ts', 2, 3) });
  const migration = node('migration', 'code.migration', { span: span('src/a.ts', 1, 2) });
  const index = node('index', 'code.index', { span: span('src/a.ts', 1, 2) });
  const knowledgeA = node('knowledge-a', 'knowledge:page', { file: 'docs/a.md', digest: SHA });
  const knowledgeB = node('knowledge-b', 'knowledge:page', { file: 'docs/b.md', digest: SHA });
  switch (ruleId) {
    case 'edge-uses-database': return { nodes: [service, database()], edge: { id: 'edge', kind: 'code.uses-database', from: 'service', to: 'db', properties: {} } };
    case 'edge-reads-table': return { nodes: [symbol, table()], edge: { id: 'edge', kind: 'code.reads-table', from: 'symbol', to: 'table', properties: { span: span('src/a.ts', 2, 3) } } };
    case 'edge-writes-table': return { nodes: [symbol, table()], edge: { id: 'edge', kind: 'code.writes-table', from: 'symbol', to: 'table', properties: { span: span('src/a.ts', 2, 3) } } };
    case 'edge-foreign-key': return { nodes: [table(), node('table-b', 'code.table', { database: 'db', schema: 'public', span: span('db/schema.sql', 1, 2) })], edge: { id: 'edge', kind: 'code.foreign-key', from: 'table', to: 'table-b', properties: { column: 'a', targetColumn: 'b' } } };
    case 'edge-alters': return { nodes: [migration, column()], edge: { id: 'edge', kind: 'code.alters', from: 'migration', to: 'column', properties: { object: 'x' } } };
    case 'edge-covers': return { nodes: [index, column()], edge: { id: 'edge', kind: 'code.covers', from: 'index', to: 'column', properties: {} } };
    case 'edge-occurrence': return { nodes: [symbol, file('src/a.ts', 'file-a')], edge: { id: 'edge', kind: 'code.occurrence', from: 'symbol', to: 'file-a', properties: { path: 'src/a.ts' }, position: { start: 1, end: 2 } } };
    case 'edge-knowledge': return { nodes: [knowledgeA, knowledgeB], edge: { id: 'edge', kind: 'knowledge:relates', from: 'knowledge-a', to: 'knowledge-b', properties: {} } };
    case 'edge-fallback': return { nodes: [node('x-a', 'x.widget', { span: span('src/a.ts', 1, 2) }), node('x-b', 'x.widget', { span: span('src/a.ts', 2, 3) })], edge: { id: 'edge', kind: 'x.rel', from: 'x-a', to: 'x-b', properties: { span: span('src/a.ts', 1, 2) } } };
    default: throw new Error(`no valid fixture for ${ruleId}`);
  }
};

describe('edge rules', () => {
  for (const rule of GRAPH_EDGE_RULES) {
    test(`${rule.id}: matching endpoints are valid and a missing endpoint is invalid`, async () => {
      const good = validEdge(rule.id);
      const goodSnapshot: GraphSnapshot = { nodes: [file(), file('db/schema.sql', 'file-db'), ...good.nodes], edges: [good.edge] };
      const result = await runGraphVerdicts({ snapshot: goodSnapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
      const row = result.rows.find((one) => one.id === 'edge');
      expect(row?.verdict).toBe('valid');
      expect(row?.rule).toBe(rule.id);
      expect(row?.source).toBe('rule');

      const broken = { ...good.edge, to: 'missing' };
      const wrong = await runGraphVerdicts({ snapshot: { nodes: goodSnapshot.nodes, edges: [broken] }, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 } });
      expect(wrong.rows.find((one) => one.id === 'edge')?.verdict).toBe('invalid');
    });
  }

  test('every edge kind picks the rule the table names', () => {
    expect(edgeRuleFor('code.uses-database').id).toBe('edge-uses-database');
    expect(edgeRuleFor('code.contains').id).toBe('edge-fallback');
    expect(edgeRuleFor('knowledge:relates').id).toBe('edge-knowledge');
    expect(edgeRuleFor('x.rel').id).toBe('edge-fallback');
  });
});
