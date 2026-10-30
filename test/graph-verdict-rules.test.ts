/**
 * One test per graph rule (madarch-mwhd.1), all deterministic: no judge and no
 * model. A valid fixture is `valid` under its own rule once its evidence
 * resolves at the fill's commit and its neighbourhood has no anomaly; a broken
 * fixture is `invalid` under that same rule, never left valid. The escalation
 * cases live in `graph-verdicts.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GRAPH_EDGE_RULES, GRAPH_NODE_RULES, edgeRuleFor, nodeRuleFor } from '../src/knowledge/graph-verdict-rules.js';
import { runGraphVerdicts, type GraphEdgeItem, type GraphEvidenceReader, type GraphNodeItem, type GraphSnapshot } from '../src/knowledge/graph-verdicts.js';
import { emptyModelAssignments, resolveModelRoles } from '../src/knowledge/model-roles.js';

const COMMIT = 'b'.repeat(40);
const SHA = 'a'.repeat(64);
const span = (path: string, lineStart = 1, lineEnd = 3) => ({ path, lineStart, lineEnd });
const NO_ROLES = resolveModelRoles(emptyModelAssignments());

/** Ten lines, no closing newline, so the declared count is the span's last line. */
const TEN = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
const TEXTS: Record<string, string> = { 'src/a.ts': TEN, 'db/schema.sql': '-- database db\ncreate table t (id text);\n', 'routes.ts': 'app.get("/orders", handler);\n', 'deploy/app.yaml': 'kind: Deployment\nimage: shop:1\n' };
const read: GraphEvidenceReader = async (path) => TEXTS[path] === undefined ? undefined : { text: TEXTS[path]!, commit: COMMIT };
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

const node = (id: string, kind: string, properties: unknown): GraphNodeItem => ({ id, kind, label: id, properties });
const FILE_ID = 'file:src/a.ts';
const file = (path = 'src/a.ts', id = `file:${path}`): GraphNodeItem => node(id, 'code.file', {
  path, lines: lineCount(TEXTS[path] ?? ''), sha256: sha(TEXTS[path] ?? ''), recordKey: `code.file:${path}`, span: span(path, 1, (TEXTS[path] ?? '').split('\n').length),
});
const symbol = (id = 'symbol'): GraphNodeItem => node(id, 'code.symbol', { path: 'src/a.ts', name: id, recordKey: `code.symbol:src/a.ts#${id}`, span: span('src/a.ts', 2, 3) });
const database = (): GraphNodeItem => node('db', 'code.database', { path: 'db/schema.sql', span: span('db/schema.sql', 1, 2), evidenceKind: 'schema', evidence: [{ kind: 'schema', path: 'db/schema.sql', line: 1 }] });
const table = (): GraphNodeItem => node('table', 'code.table', { database: 'db', schema: 'public', span: span('db/schema.sql', 1, 2) });
const column = (): GraphNodeItem => node('column', 'code.column', { type: 'text', span: span('db/schema.sql', 1, 2) });
const anchor = (target: string): GraphEdgeItem => ({ id: 'anchor', kind: 'code.contains', from: FILE_ID, to: target, properties: { span: span('src/a.ts', 1, 1) } });
const rel = (id: string, kind: string, from: string, to: string, properties: unknown = {}): GraphEdgeItem => ({ id, kind, from, to, properties });

interface Fixture { readonly node: GraphNodeItem; readonly nodes?: readonly GraphNodeItem[]; readonly edges?: readonly GraphEdgeItem[] }

/** A valid item of the rule's kind, with the one edge (or escalated condition) that keeps it out of the anomaly set. */
const validFixture = (ruleId: string): Fixture => {
  switch (ruleId) {
    case 'node-file': return { node: file(), nodes: [symbol()], edges: [rel('contains', 'code.contains', FILE_ID, 'symbol', { span: span('src/a.ts', 2, 3) })] };
    case 'node-symbol': return { node: symbol(), edges: [anchor('symbol')] };
    case 'node-database': return { node: database(), edges: [anchor('db')] };
    case 'node-table': return { node: table(), nodes: [symbol()], edges: [anchor('table'), rel('reads', 'code.reads-table', 'symbol', 'table', { span: span('src/a.ts', 2, 3) })] };
    case 'node-column': return { node: column(), edges: [anchor('column')] };
    case 'node-route': {
      const held = node('route', 'code.route', { method: 'GET', path: '/orders', span: span('routes.ts', 1, 1) });
      return { node: held, nodes: [symbol()], edges: [anchor('route'), rel('handled', 'code.handled-by', 'route', 'symbol', {})] };
    }
    case 'node-operation': {
      const held = node('op', 'code.operation', { method: 'get', path: '/orders', span: span('routes.ts', 1, 1) });
      const route = node('route', 'code.route', { method: 'GET', path: '/orders', span: span('routes.ts', 1, 1) });
      return { node: held, nodes: [route], edges: [anchor('op'), rel('serves', 'code.serves', 'route', 'op', {})] };
    }
    case 'node-channel': {
      const held = node('channel', 'code.channel', { span: span('routes.ts', 1, 1) });
      const consumer = node('consumer', 'code.k8s-deployment', { span: span('deploy/app.yaml', 1, 2) });
      return { node: held, nodes: [consumer], edges: [anchor('channel'), rel('consumes', 'code.consumes', 'consumer', 'channel', {})] };
    }
    case 'node-k8s-deployment': {
      const held = node('deploy', 'code.k8s-deployment', { span: span('deploy/app.yaml', 1, 2) });
      const image = node('image', 'code.image', {});
      return { node: held, nodes: [image], edges: [anchor('deploy'), rel('runs', 'code.runs', 'deploy', 'image', {})] };
    }
    case 'node-test-case': {
      const held = node('test-case', 'code.test-case', { suite: 'a', name: 'one', span: span('src/a.ts', 1, 2) });
      return { node: held, nodes: [symbol()], edges: [anchor('test-case'), rel('tests', 'code.tests', 'test-case', 'symbol', {})] };
    }
    case 'node-env-var': {
      const held = node('env-var', 'code.env-var', { name: 'URL', span: span('src/a.ts', 1, 1) });
      const definition = node('definition', 'code.env-definition', { name: 'URL', span: span('src/a.ts', 2, 2) });
      return { node: held, nodes: [definition], edges: [anchor('env-var'), rel('defines', 'code.defines', 'definition', 'env-var', {})] };
    }
    case 'node-env-definition': {
      const held = node('definition', 'code.env-definition', { name: 'URL', span: span('src/a.ts', 1, 1) });
      const envVar = node('env-var', 'code.env-var', { name: 'URL', span: span('src/a.ts', 2, 2) });
      return { node: held, nodes: [envVar], edges: [anchor('definition'), rel('defines', 'code.defines', 'definition', 'env-var', {}), rel('reads', 'code.reads-env', FILE_ID, 'env-var', { span: span('src/a.ts', 3, 3) })] };
    }
    case 'node-commit': return { node: node('commit', 'code.commit', { recordKey: `code.commit:${COMMIT}`, committedAt: '2026-01-01T00:00:00Z' }), edges: [anchor('commit')] };
    case 'node-snapshot': return { node: node('snapshot', 'code.snapshot', { recordKey: 'code.snapshot:one', commit: COMMIT }), edges: [anchor('snapshot')] };
    case 'node-task': return { node: node('task', 'code.task', { recordKey: 'code.task:one' }), edges: [anchor('task')] };
    case 'node-author': return { node: node('author', 'code.author', { recordKey: 'code.author:one' }), edges: [anchor('author')] };
    case 'node-repository': return { node: node('repository', 'code.repository', { path: '/' }), edges: [anchor('repository')] };
    case 'node-code-other': { const held = node('widget', 'code.widget', { span: span('src/a.ts', 1, 2) }); return { node: held, edges: [anchor('widget')] }; }
    case 'node-knowledge-page': return { node: node('page', 'knowledge:page', { file: 'docs/page.md', digest: SHA }), edges: [anchor('page')] };
    case 'node-knowledge-section': return { node: node('section', 'knowledge:section', { path: 'docs/page.md', anchor: 'one' }), edges: [anchor('section')] };
    case 'node-knowledge-statement': return { node: node('statement', 'knowledge:statement', { page: 'page', line: 1, text: 'one' }), edges: [anchor('statement')] };
    case 'node-knowledge-product': return { node: node('product', 'knowledge:product', { key: 'knowledge' }), edges: [anchor('product')] };
    case 'node-knowledge-other': return { node: node('concept', 'knowledge:concept', {}), edges: [anchor('concept')] };
    case 'node-engine': return { node: node('engine', 'engine:menu', {}), edges: [anchor('engine')] };
    case 'node-fallback': { const held = node('custom', 'x.widget', { span: span('src/a.ts', 1, 2) }); return { node: held, edges: [anchor('custom')] }; }
    default: throw new Error(`no valid fixture for ${ruleId}`);
  }
};

/** A malformed span is a contradiction, not an unresolved file: every item is `invalid` under its own rule. */
const badSpan = { path: 'src/a.ts', lineStart: 1.5, lineEnd: 2 };
const invalidNode = (ruleId: string): GraphNodeItem => {
  switch (ruleId) {
    case 'node-file': return node('file-a', 'code.file', { path: 'src/a.ts', lines: 10, sha256: SHA, recordKey: 'not-a-file-key' });
    case 'node-symbol': return node('symbol', 'code.symbol', { path: 'src/a.ts', name: 'a', recordKey: 'not-a-symbol-key' });
    case 'node-database': return node('db', 'code.database', { path: 'db/schema.sql', span: span('db/schema.sql', 1, 2), evidenceKind: 'schema' });
    case 'node-table': return node('table', 'code.table', { schema: 'public', span: span('db/schema.sql', 1, 2) });
    case 'node-column': return node('column', 'code.column', { span: span('db/schema.sql', 1, 2) });
    case 'node-route': return node('route', 'code.route', { path: '/orders', span: span('routes.ts', 1, 1) });
    case 'node-channel': return node('channel', 'code.channel', { span: badSpan });
    case 'node-k8s-deployment': return node('deploy', 'code.k8s-deployment', { span: badSpan });
    case 'node-test-case': return node('test-case', 'code.test-case', { span: badSpan });
    case 'node-env-var': return node('env-var', 'code.env-var', { span: badSpan });
    case 'node-env-definition': return node('definition', 'code.env-definition', { span: badSpan });
    case 'node-operation': return node('op', 'code.operation', { path: '/orders', span: span('routes.ts', 1, 1) });
    case 'node-commit': return node('commit', 'code.commit', { recordKey: 'not-a-commit-key', committedAt: '2026-01-01T00:00:00Z' });
    case 'node-snapshot': return node('snapshot', 'code.snapshot', { recordKey: 'code.snapshot:one', commit: 'short' });
    case 'node-task': return node('task', 'code.task', {});
    case 'node-author': return node('author', 'code.author', {});
    case 'node-repository': return node('repository', 'code.repository', {});
    case 'node-knowledge-page': return node('page', 'knowledge:page', { digest: SHA });
    case 'node-knowledge-section': return node('section', 'knowledge:section', { path: 'docs/page.md' });
    case 'node-knowledge-statement': return node('statement', 'knowledge:statement', { page: 'page', text: 'one' });
    case 'node-knowledge-product': return node('product', 'knowledge:product', {});
    case 'node-code-other': return node('widget', 'code.widget', { span: badSpan });
    case 'node-fallback': return node('custom', 'x.widget', { span: badSpan });
    default: return node('bad', ruleId === 'node-engine' ? 'engine:menu' : ruleId === 'node-knowledge-other' ? 'knowledge:concept' : 'code.widget', { span: badSpan });
  }
};

const run = (snapshot: GraphSnapshot) => runGraphVerdicts({ snapshot, roles: NO_ROLES, budgets: { itemsPerRun: 0, modelCallsPerRun: 0 }, readEvidence: read });

describe('node rules', () => {
  for (const rule of GRAPH_NODE_RULES) {
    test(`${rule.id}: a matching item is valid and a broken one is invalid`, async () => {
      const good = validFixture(rule.id);
      const goodSnapshot: GraphSnapshot = { nodes: [file(), ...(good.nodes ?? []), good.node], edges: [...(good.edges ?? [])] };
      const goodResult = await run(goodSnapshot);
      const goodRow = goodResult.rows.find((row) => row.id === good.node.id);
      expect(goodRow?.verdict).toBe('valid');
      expect(goodRow?.rule).toBe(rule.id);
      expect(goodRow?.source).toBe('rule');

      const bad = invalidNode(rule.id);
      const wrong = await run({ nodes: [file(), bad], edges: [anchor(bad.id)] });
      const badRow = wrong.rows.find((row) => row.id === bad.id);
      expect(badRow?.verdict).toBe('invalid');
      expect(badRow?.rule).toBe(rule.id);
      expect(badRow?.source).toBe('rule');
    });
  }

  test('every node kind picks the rule the table names', () => {
    expect(nodeRuleFor('code.file').id).toBe('node-file');
    expect(nodeRuleFor('code.unknown').id).toBe('node-code-other');
    expect(nodeRuleFor('knowledge:concept').id).toBe('node-knowledge-other');
    expect(nodeRuleFor('x.widget').id).toBe('node-fallback');
  });
});

const validEdge = (ruleId: string): { nodes: GraphNodeItem[]; edge: GraphEdgeItem } => {
  const service = node('service', 'code.service', { span: span('src/a.ts', 1, 2) });
  const heldSymbol = symbol();
  const migration = node('migration', 'code.migration', { span: span('src/a.ts', 1, 2) });
  const index = node('index', 'code.index', { span: span('src/a.ts', 1, 2) });
  const knowledgeA = node('knowledge-a', 'knowledge:page', { file: 'docs/a.md', digest: SHA });
  const knowledgeB = node('knowledge-b', 'knowledge:page', { file: 'docs/b.md', digest: SHA });
  switch (ruleId) {
    case 'edge-uses-database': return { nodes: [service, database()], edge: rel('edge', 'code.uses-database', 'service', 'db') };
    case 'edge-reads-table': return { nodes: [heldSymbol, table()], edge: rel('edge', 'code.reads-table', 'symbol', 'table', { span: span('src/a.ts', 2, 3) }) };
    case 'edge-writes-table': return { nodes: [heldSymbol, table()], edge: rel('edge', 'code.writes-table', 'symbol', 'table', { span: span('src/a.ts', 2, 3) }) };
    case 'edge-foreign-key': return { nodes: [table(), node('table-b', 'code.table', { database: 'db', schema: 'public', span: span('db/schema.sql', 1, 2) })], edge: rel('edge', 'code.foreign-key', 'table', 'table-b', { column: 'a', targetColumn: 'b' }) };
    case 'edge-alters': return { nodes: [migration, column()], edge: rel('edge', 'code.alters', 'migration', 'column', { object: 'x' }) };
    case 'edge-covers': return { nodes: [index, column()], edge: rel('edge', 'code.covers', 'index', 'column') };
    case 'edge-occurrence': return { nodes: [heldSymbol, file('src/a.ts', 'file-a')], edge: { ...rel('edge', 'code.occurrence', 'symbol', 'file-a', { path: 'src/a.ts' }), position: { start: 1, end: 2 } } };
    case 'edge-knowledge': return { nodes: [knowledgeA, knowledgeB], edge: rel('edge', 'knowledge:relates', 'knowledge-a', 'knowledge-b') };
    case 'edge-fallback': return { nodes: [node('x-a', 'x.widget', { span: span('src/a.ts', 1, 2) }), node('x-b', 'x.widget', { span: span('src/a.ts', 2, 3) })], edge: rel('edge', 'x.rel', 'x-a', 'x-b', { span: span('src/a.ts', 1, 2) }) };
    default: throw new Error(`no valid fixture for ${ruleId}`);
  }
};

describe('edge rules', () => {
  for (const rule of GRAPH_EDGE_RULES) {
    test(`${rule.id}: matching endpoints are valid and a missing endpoint is invalid`, async () => {
      const good = validEdge(rule.id);
      const goodSnapshot: GraphSnapshot = { nodes: [file(), ...good.nodes], edges: [good.edge] };
      const result = await run(goodSnapshot);
      const row = result.rows.find((one) => one.id === 'edge');
      expect(row?.verdict).toBe('valid');
      expect(row?.rule).toBe(rule.id);
      expect(row?.source).toBe('rule');

      const broken = { ...good.edge, to: 'missing' };
      const wrong = await run({ nodes: goodSnapshot.nodes, edges: [broken] });
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

void SHA;
