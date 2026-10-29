/**
 * The rules of the Problems page's code and documents sections
 * (madarch-m38l.19): every rule reads facts and says one reason, a place, an
 * entity and an evidence path. The facts here are the graph's own shapes, so
 * a rule is tested without an agent, a fill or a source file.
 */
import { describe, expect, test } from 'bun:test';
import type { GraphEntity, RelationEdge } from '../src/knowledge/graph-read.js';
import type { Resolution } from '../src/knowledge/resolve.js';
import type { Question } from '../src/loop/entities.js';
import { composeDefault, evaluateCode, type CodeSnapshot } from '../src/problems/code.js';
import { evaluateDocuments } from '../src/problems/documents.js';
import { openProblemsOf } from '../src/problems/index.js';
import { ruleForKind } from '../src/problems/rules.js';
import { STARTER_PROBLEM_RULES, starterProblemSettings } from '../src/knowledge/seed.js';
import { SONAR_KINDS, PROBLEM_SEVERITIES, problemId, type ProblemSettings, type RuleSetting } from '../src/problems/types.js';
import type { ProblemDraft } from '../src/problems/types.js';

const span = (path: string, line = 3) => ({ path, lineStart: line, lineEnd: line, byteStart: 0, byteEnd: 0 });
const entity = (key: string, label: string, properties: Record<string, unknown> = {}, at?: ReturnType<typeof span>): GraphEntity => ({
  key, kind: key.slice(0, key.indexOf(':')), label, properties, nodeIds: [key], scope: 'repo', ...(at === undefined ? {} : { span: at }),
});
const edge = (from: string, to: string): RelationEdge => ({
  from: { key: from, kind: from.slice(0, from.indexOf(':')), label: from },
  to: { key: to, kind: to.slice(0, to.indexOf(':')), label: to },
  properties: {},
});
const empty = (): CodeSnapshot => ({
  files: [], symbols: [], cycles: [], routes: [], operations: [], dependencies: [], packages: [],
  envVars: [], envDefinitions: [], inputs: [], builds: [], sinks: [], debts: [],
  flows: [], serves: [], defines: [], usesDependency: [], notes: [],
});
const snapshot = (patch: Partial<CodeSnapshot>): CodeSnapshot => ({ ...empty(), ...patch });
// The rules are the starter set's, as a product's manifest writes them; a test edits one field of one rule.
const settings = (patch: { thresholds?: ProblemSettings['thresholds']; rules?: Record<string, Partial<RuleSetting>> } = {}): ProblemSettings => {
  const base = starterProblemSettings();
  const rules: Record<string, RuleSetting> = { ...base.rules };
  for (const [id, setting] of Object.entries(patch.rules ?? {})) rules[id] = { ...(base.rules[id] ?? {}), ...setting } as RuleSetting;
  return { ...base, ...patch, rules };
};
const found = (problems: readonly ProblemDraft[], rule: string): ProblemDraft[] => problems.filter((problem) => problem.rule === rule);
const only = (problems: readonly ProblemDraft[], rule: string): ProblemDraft => {
  const rows = found(problems, rule);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('the code section', () => {
  test('a dependency cycle names the files, the ring and the lines of the first', () => {
    const problems = evaluateCode(snapshot({
      cycles: [entity('code.cycle:file:src/a.ts|src/b.ts', 'src/a.ts → src/b.ts → src/a.ts', {
        level: 'file', members: ['code.file:src/a.ts', 'code.file:src/b.ts'], edges: ['code.file:src/a.ts -> code.file:src/b.ts', 'code.file:src/b.ts -> code.file:src/a.ts'],
      }, span('src/a.ts', 7))],
    }), settings()).problems;
    const problem = only(problems, 'dependency.cycle');
    expect(problem).toMatchObject({ section: 'code', kind: 'dependency-cycle', sonar: 'bug', severity: 'major', fixer: 'person', file: 'src/a.ts', line: 7, scope: { type: 'file', path: 'src/a.ts' } });
    expect(problem.reason).toContain('a.ts and b.ts import one another in a cycle of 2 files');
    expect(problem.evidence.map((link) => link.key)).toEqual(['code.file:src/a.ts', 'code.file:src/b.ts']);
    expect(problem.place.href).toContain('code.file');
    expect(problem.entity?.key).toBe('code.cycle:file:src/a.ts|src/b.ts');
  });

  test('untrusted input into a string-built SQL statement gives the whole path input → builder → sink', () => {
    const problems = evaluateCode(snapshot({
      inputs: [entity('code.input:req.query.q', 'req.query.q', {}, span('src/orders.ts', 20))],
      builds: [entity('code.sql-build:src/orders.ts#30', 'selectOrders', {}, span('src/orders.ts', 30))],
      sinks: [entity('code.sql-sink:src/orders.ts#35', 'db.query', {}, span('src/orders.ts', 35))],
      flows: [edge('code.input:req.query.q', 'code.sql-build:src/orders.ts#30'), edge('code.sql-build:src/orders.ts#30', 'code.sql-sink:src/orders.ts#35')],
    }), settings()).problems;
    const problem = only(problems, 'security.sql-input');
    expect(problem).toMatchObject({ sonar: 'vulnerability', severity: 'blocker', file: 'src/orders.ts', line: 35, identity: 'code.sql-sink:src/orders.ts#35\u0000code.sql-build:src/orders.ts#30' });
    expect(problem.reason).toContain('req.query.q reach selectOrders');
    expect(problem.evidence.map((link) => link.label)).toEqual(['req.query.q', 'selectOrders', 'db.query']);
    expect(problem.scope).toEqual({ type: 'file', path: 'src/orders.ts' });
  });

  test('a route outside the auth group is a vulnerability only where the same service protects the same path root', () => {
    const problems = evaluateCode(snapshot({
      routes: [
        entity('code.route:GET /orders', 'GET /orders', { service: 'shop', path: '/orders', authGroup: true }, span('src/routes.ts', 4)),
        entity('code.route:GET /orders/export', 'GET /orders/export', { service: 'shop', path: '/orders/export', authGroup: false, handlerKey: 'code.symbol:src/routes.ts#exportOrders', handlerPath: 'src/routes.ts' }, span('src/routes.ts', 9)),
        entity('code.route:GET /healthz', 'GET /healthz', { service: 'shop', path: '/healthz', authGroup: false }, span('src/routes.ts', 14)),
        entity('code.route:GET /open', 'GET /open', { service: 'public', path: '/open', authGroup: false }, span('src/public.ts', 3)),
      ],
    }), settings()).problems;
    const problem = only(problems, 'security.export-route');
    expect(problem).toMatchObject({ sonar: 'vulnerability', severity: 'critical', file: 'src/routes.ts', line: 9, target: 'code.route:GET /orders/export' });
    expect(problem.reason).toContain('registered outside the auth group');
    expect(problem.evidence.map((link) => link.key)).toEqual(['code.route:GET /orders/export', 'code.symbol:src/routes.ts#exportOrders']);
  });

  test('a large file is over the manifest threshold, and a test file is left alone', () => {
    const base = {
      files: [
        entity('code.file:src/big.ts', 'src/big.ts', { path: 'src/big.ts', lines: 700, role: 'source' }),
        entity('code.file:src/big.test.ts', 'src/big.test.ts', { path: 'src/big.test.ts', lines: 900, role: 'test' }),
      ],
    };
    const problem = only(evaluateCode(snapshot(base), settings()).problems, 'large-file');
    expect(problem).toMatchObject({ file: 'src/big.ts', line: 1, sonar: 'code-smell', severity: 'minor' });
    expect(problem.reason).toContain('700 lines long, over the product\'s 600-line threshold');
    const raised = evaluateCode(snapshot(base), settings({ thresholds: { ...starterProblemSettings().thresholds, largeFileLines: 1000 } })).problems;
    expect(found(raised, 'large-file')).toEqual([]);
  });

  test('a hotspot is both large and often changed: size × churn over the manifest thresholds', () => {
    const problems = evaluateCode(snapshot({
      files: [
        entity('code.file:src/hot.ts', 'src/hot.ts', { path: 'src/hot.ts', lines: 300, commitCount: 50, role: 'source' }),
        entity('code.file:src/cold.ts', 'src/cold.ts', { path: 'src/cold.ts', lines: 300, commitCount: 2, role: 'source' }),
      ],
    }), settings()).problems;
    const problem = only(problems, 'hotspot');
    expect(problem).toMatchObject({ file: 'src/hot.ts', sonar: 'code-smell', severity: 'major' });
    expect(problem.reason).toContain('size × churn = 15000');
  });

  test('a dead export names the symbol and the file it is exported from', () => {
    const problem = only(evaluateCode(snapshot({
      symbols: [entity('code.symbol:src/a.ts#unused', 'unused', { deadExport: true }, span('src/a.ts', 12))],
    }), settings()).problems, 'dead-export');
    expect(problem).toMatchObject({ sonar: 'code-smell', severity: 'minor', scope: { type: 'symbol', key: 'code.symbol:src/a.ts#unused' } });
    expect(problem.reason).toContain('exported by src/a.ts and no code in this repository refers to it');
  });

  test('TODO and FIXME are two rules, each reading the marker the syntax tree put on a comment', () => {
    const debts = [
      entity('code.debt:src/a.ts#10', 'TODO: charge tax', { marker: 'TODO', text: 'charge tax', path: 'src/a.ts', line: 10 }, span('src/a.ts', 10)),
      entity('code.debt:src/a.ts#20', 'FIXME: retry twice', { marker: 'FIXME', text: 'retry twice', path: 'src/a.ts', line: 20 }, span('src/a.ts', 20)),
    ];
    const problems = evaluateCode(snapshot({ debts }), settings()).problems;
    expect(only(problems, 'debt.todo')).toMatchObject({ sonar: 'code-smell', severity: 'info', line: 10, reason: 'TODO in src/a.ts: charge tax' });
    expect(only(problems, 'debt.fixme')).toMatchObject({ sonar: 'code-smell', severity: 'minor', line: 20, reason: 'FIXME in src/a.ts: retry twice' });
  });

  test('the same literal in two files is not a secret: PORT=3000 is a setting, not a vulnerability', () => {
    const problems = evaluateCode(snapshot({
      envVars: [entity('code.env-var:shop/PORT', 'PORT', { name: 'PORT', required: true })],
      envDefinitions: [
        entity('code.env-definition:docker-compose.yml#5', 'PORT · shop · docker-compose.yml', { value: '3000' }, span('docker-compose.yml', 5)),
        entity('code.env-definition:.env.example#2', 'PORT · shop · .env.example', { value: '3000' }, span('.env.example', 2)),
      ],
      defines: [edge('code.env-definition:docker-compose.yml#5', 'code.env-var:shop/PORT'), edge('code.env-definition:.env.example#2', 'code.env-var:shop/PORT')],
    }), settings()).problems;
    expect(found(problems, 'config.required-dev-value')).toEqual([]);
  });

  test('a secret the manifest declares is a finding from one file, and PORT beside it is not', () => {
    const env = snapshot({
      envVars: [
        entity('code.env-var:shop/JWT_SECRET', 'JWT_SECRET', { name: 'JWT_SECRET', required: true }),
        entity('code.env-var:shop/PORT', 'PORT', { name: 'PORT', required: true }),
      ],
      envDefinitions: [
        entity('code.env-definition:docker-compose.yml#5', 'JWT_SECRET · shop · docker-compose.yml', { value: '${JWT_SECRET:-local-development-secret}' }, span('docker-compose.yml', 5)),
        entity('code.env-definition:docker-compose.yml#6', 'PORT · shop · docker-compose.yml', { value: '3000' }, span('docker-compose.yml', 6)),
      ],
      defines: [edge('code.env-definition:docker-compose.yml#5', 'code.env-var:shop/JWT_SECRET'), edge('code.env-definition:docker-compose.yml#6', 'code.env-var:shop/PORT')],
    });
    const policy = settings({ rules: { 'config.required-dev-value': { ...starterProblemSettings().rules['config.required-dev-value']!, params: { secrets: ['JWT_SECRET'], developmentValues: [] } } } });
    const problem = only(evaluateCode(env, policy).problems, 'config.required-dev-value');
    expect(problem).toMatchObject({ sonar: 'vulnerability', severity: 'critical', file: 'docker-compose.yml', line: 5, target: 'code.env-var:shop/JWT_SECRET' });
    expect(problem.reason).toContain('the manifest declares it a secret');
    expect(problem.reason).toContain('local-development-secret');
    // Without the policy the same file is quiet: the engine does not guess a secret.
    expect(found(evaluateCode(env, settings()).problems, 'config.required-dev-value')).toEqual([]);
    expect(composeDefault('${JWT_SECRET:-local-development-secret}')).toBe('local-development-secret');
    expect(composeDefault('${JWT_SECRET}')).toBe('');
  });

  test('a value a file declares a Secret is a finding by that fact alone, and a declared development value is a finding', () => {
    const explicit = only(evaluateCode(snapshot({
      envVars: [entity('code.env-var:shop/API_TOKEN', 'API_TOKEN', { name: 'API_TOKEN', required: false })],
      envDefinitions: [entity('code.env-definition:deploy/secret.yaml#3', 'API_TOKEN · deploy/secret.yaml', { value: 'c2VjcmV0', secret: true }, span('deploy/secret.yaml', 3))],
      defines: [edge('code.env-definition:deploy/secret.yaml#3', 'code.env-var:shop/API_TOKEN')],
    }), settings()).problems, 'config.required-dev-value');
    expect(explicit.reason).toContain('is declared a secret by deploy/secret.yaml');
    expect(explicit.evidence.map((link) => link.key)).toContain('code.file:deploy/secret.yaml');

    const devPolicy = settings({ rules: { 'config.required-dev-value': { ...starterProblemSettings().rules['config.required-dev-value']!, params: { secrets: [], developmentValues: ['local-development-secret'] } } } });
    const development = only(evaluateCode(snapshot({
      envVars: [entity('code.env-var:shop/JWT_SECRET', 'JWT_SECRET', { name: 'JWT_SECRET', required: true })],
      envDefinitions: [entity('code.env-definition:.env.example#2', 'JWT_SECRET · .env.example', { value: 'local-development-secret' }, span('.env.example', 2))],
      defines: [edge('code.env-definition:.env.example#2', 'code.env-var:shop/JWT_SECRET')],
    }), devPolicy).problems, 'config.required-dev-value');
    expect(development.reason).toContain('the development value ("local-development-secret")');
  });

  test('a direct dependency nobody imports is unused; a transitive one is not judged', () => {
    const problems = evaluateCode(snapshot({
      dependencies: [
        entity('code.dependency:lodash', 'lodash', { name: 'lodash', version: '4.17.21', scope: 'direct' }, span('package.json', 12)),
        entity('code.dependency:left-pad', 'left-pad', { name: 'left-pad', scope: 'transitive' }, span('package-lock.json', 3)),
      ],
    }), settings()).problems;
    const problem = only(problems, 'dependency.declared-unused');
    expect(problem).toMatchObject({ sonar: 'code-smell', severity: 'minor' });
    expect(problem.reason).toContain('lodash (4.17.21) is declared by package.json');
  });

  test('a third-party import no manifest declares is a bug; a declared or standard library import is not', () => {
    const problems = evaluateCode(snapshot({
      packages: [
        entity('code.package:left-pad', 'left-pad', { name: 'left-pad', external: true, standardLibrary: false, versionStatus: 'not-declared' }, span('src/a.ts', 1)),
        entity('code.package:zod', 'zod', { name: 'zod', external: true, standardLibrary: false, versionStatus: 'declared' }, span('src/a.ts', 2)),
        entity('code.package:node:fs', 'node:fs', { name: 'node:fs', external: true, standardLibrary: true, versionStatus: 'not-declared' }, span('src/a.ts', 3)),
      ],
    }), settings()).problems;
    const problem = only(problems, 'dependency.used-undeclared');
    expect(problem).toMatchObject({ sonar: 'bug', severity: 'major' });
    expect(problem.reason).toContain('left-pad is imported by src/a.ts');
  });

  test('a contract operation no route serves is a bug, with the operation page as its entity', () => {
    const problem = only(evaluateCode(snapshot({
      operations: [entity('code.operation:orders.read', 'orders.read', {}, span('openapi.yaml', 30))],
    }), settings()).problems, 'contract.operation-without-route');
    expect(problem).toMatchObject({ sonar: 'bug', severity: 'major', file: 'openapi.yaml', line: 30 });
    expect(problem.reason).toContain('no route implements it');
  });

  test('a route of a service the contract covers, which the contract does not declare, is a bug', () => {
    const problems = evaluateCode(snapshot({
      routes: [
        entity('code.route:GET /orders', 'GET /orders', { service: 'shop', path: '/orders' }, span('src/routes.ts', 4)),
        entity('code.route:GET /orders/export', 'GET /orders/export', { service: 'shop', path: '/orders/export' }, span('src/routes.ts', 9)),
      ],
      operations: [entity('code.operation:orders.read', 'orders.read')],
      serves: [edge('code.route:GET /orders', 'code.operation:orders.read')],
    }), settings()).problems;
    const problem = only(problems, 'contract.route-without-operation');
    expect(problem).toMatchObject({ sonar: 'bug', severity: 'minor', line: 9 });
    expect(problem.reason).toContain('the service\'s contract declares no such operation');
  });

  test('a service the contract owns is judged even when none of its routes matched an operation', () => {
    const problems = evaluateCode(snapshot({
      routes: [
        entity('code.route:GET /new', 'GET /new', { service: 'shop', path: '/new' }, span('src/routes.ts', 4)),
        entity('code.route:GET /elsewhere', 'GET /elsewhere', { service: 'other', path: '/elsewhere' }, span('src/other.ts', 4)),
      ],
      // The contract names the service it is for; no route of the service serves an operation, so no serves edge exists.
      operations: [entity('code.operation:contracts/openapi/shop.yaml#GET:/orders', 'GET /orders', { service: 'shop', path: '/orders' })],
    }), settings()).problems;
    expect(found(problems, 'contract.route-without-operation').map((problem) => problem.target)).toEqual(['code.route:GET /new']);
  });

  test('a route the contract serves with a secured operation is reported even under another path root; a public one is not', () => {
    const problems = evaluateCode(snapshot({
      routes: [
        entity('code.route:GET /orders', 'GET /orders', { service: 'shop', path: '/orders', authGroup: true }, span('src/routes.ts', 4)),
        entity('code.route:GET /export', 'GET /export', { service: 'shop', path: '/export' }, span('src/routes.ts', 6)),
        entity('code.route:GET /open', 'GET /open', { service: 'shop', path: '/open' }, span('src/routes.ts', 8)),
        entity('code.route:GET /healthz', 'GET /healthz', { service: 'shop', path: '/healthz' }, span('src/routes.ts', 10)),
      ],
      operations: [
        entity('code.operation:contracts/openapi/shop.yaml#GET:/export', 'GET /export', { service: 'shop', path: '/export', public: false }),
        entity('code.operation:contracts/openapi/shop.yaml#GET:/open', 'GET /open', { service: 'shop', path: '/open', public: true }),
      ],
      serves: [
        edge('code.route:GET /export', 'code.operation:contracts/openapi/shop.yaml#GET:/export'),
        edge('code.route:GET /open', 'code.operation:contracts/openapi/shop.yaml#GET:/open'),
      ],
    }), settings()).problems;
    const foundRoutes = found(problems, 'security.export-route');
    expect(foundRoutes.map((problem) => problem.target)).toEqual(['code.route:GET /export']);
    expect(foundRoutes[0]!.reason).toContain('requires a token');
    expect(foundRoutes[0]!.evidence.map((link) => link.key)).toContain('code.operation:contracts/openapi/shop.yaml#GET:/export');
  });

  test('the manifest switches a rule off and changes its severity without changing the engine', () => {
    const cycle = entity('code.cycle:file:src/a.ts', 'src/a.ts', { level: 'file', members: ['code.file:src/a.ts'] }, span('src/a.ts', 1));
    expect(evaluateCode(snapshot({ cycles: [cycle] }), settings({ rules: { 'dependency.cycle': { enabled: false } } })).problems).toEqual([]);
    const problem = only(evaluateCode(snapshot({ cycles: [cycle] }), settings({ rules: { 'dependency.cycle': { severity: 'blocker' } } })).problems, 'dependency.cycle');
    expect(problem.severity).toBe('blocker');
  });
});

describe('the documents section', () => {
  const resolveNothing = async (url: string): Promise<Resolution> => url.includes('README')
    ? { state: 'broken', target: 'doc:README.md#discounts', reason: 'the graph has no such ground' }
    : { state: 'ok', target: url.replace('madarch:', ''), kind: 'entity', label: url, href: null };
  const resolveAll = async (): Promise<Resolution> => ({ state: 'ok', target: 'doc:README.md#discounts', kind: 'doc.section', label: 'Discounts', href: null });
  const question = (patch: Partial<Question>): Question => ({
    slug: 'discount', id: 'question:discount', file: 'docs/questions/discount.md', title: 'Which discount?', type: 'contradiction', status: 'open',
    about: ['domain:orders'], askedIn: 'domain:orders', askedAt: '2026-10-23T10:00:00.000Z', question: 'Which?', why: 'The README and the code disagree.',
    sides: [{ claim: 'Ten percent.', grounds: ['doc:README.md#discounts'] }, { claim: 'Whatever the caller passes.', grounds: ['code.file\u003asrc/a.ts'] }],
    answer: null, resolvedBy: [], resolvedAt: null, writtenAt: [], ...patch,
  });
  const documents = (questions: Question[], patch: { rules?: Record<string, Partial<RuleSetting>> } = {}, resolve: (url: string) => Promise<Resolution> = resolveAll) => evaluateDocuments({ questions, resolve, settings: settings(patch) });

  test('a contradiction is a bug and carries both sides in one reason and the question in its evidence', async () => {
    const problem = only((await documents([question({})])).problems, 'document.contradiction');
    expect(problem).toMatchObject({ section: 'documents', sonar: 'bug', severity: 'major', file: 'docs/questions/discount.md', line: 1, entity: { key: 'question:discount' } });
    expect(problem.reason).toContain('Ten percent. / Whatever the caller passes.');
    expect(problem.evidence.map((link) => link.key)).toEqual(['question:discount', 'doc:README.md#discounts', 'code.file:src/a.ts', 'domain:orders']);
  });

  test('an ambiguous term is a code smell for a person to settle', async () => {
    const problem = only((await documents([question({ type: 'ambiguous-term', title: 'What is an order?' })])).problems, 'document.ambiguous-term');
    expect(problem).toMatchObject({ sonar: 'code-smell', severity: 'minor' });
    expect(problem.reason).toContain('the term has more than one meaning');
  });

  test('undocumented behaviour and a gap are the same rule, with the question\'s why as the reason', async () => {
    for (const type of ['undocumented', 'gap'] as const) {
      const problem = only((await documents([question({ type, why: 'No document says what happens after midnight.' })])).problems, 'document.undocumented');
      expect(problem).toMatchObject({ sonar: 'code-smell', severity: 'major' });
      expect(problem.reason).toContain('No document says what happens after midnight.');
    }
  });

  test('a ground that no longer resolves is a stale statement, beside whatever rule the question type feeds', async () => {
    const result = await documents([question({})], {}, resolveNothing);
    expect(found(result.problems, 'document.stale')).toHaveLength(1);
    expect(only(result.problems, 'document.stale').reason).toContain('doc:README.md#discounts no longer resolves: the graph has no such ground');
    expect(found(result.problems, 'document.contradiction')).toHaveLength(1);
  });

  test('a resolved question is no longer a problem, and a switched-off rule is not run', async () => {
    expect((await documents([question({ resolvedBy: ['domain:orders'] })])).problems).toEqual([]);
    expect(found((await documents([question({})], { rules: { 'document.contradiction': { enabled: false } } })).problems, 'document.contradiction')).toEqual([]);
    expect(found((await documents([question({})], { rules: { 'document.stale': { enabled: false } } }, resolveNothing)).problems, 'document.stale')).toEqual([]);
  });

  test('each problem has a stable id, not a position', async () => {
    const first = (await documents([question({})])).problems[0]!;
    const second = (await documents([question({ slug: 'other', id: 'question:other', title: 'Other', file: 'docs/questions/other.md' })])).problems[0]!;
    expect(first).not.toBe(second);
    expect(problemId('document.contradiction', 'question:discount\u0000document.contradiction')).toBe('document.contradiction\u0000question:discount\u0000document.contradiction');
  });
});


describe('a page badge', () => {
  test('counts the open problems of the entity and leaves closed ones to history', () => {
    const page = 'code.file:src/a.ts';
    const problems = [
      { entity: { key: page, label: 'a.ts', href: null } as const, closed: false },
      { entity: { key: page, label: 'a.ts', href: null } as const, closed: true },
      { entity: { key: 'code.file:src/b.ts', label: 'b.ts', href: null } as const, closed: false },
    ];
    expect(openProblemsOf(problems, page)).toBe(1);
    expect(openProblemsOf(problems, 'code.file:src/none.ts')).toBe(0);
  });
});

describe('the rule set as data', () => {
  test('the starter manifest declares every rule, each with its section, Sonar kind, severity, label and action', async () => {
    expect(STARTER_PROBLEM_RULES.length).toBeGreaterThan(20);
    for (const rule of STARTER_PROBLEM_RULES) {
      expect(rule.id).toBeTruthy();
      expect(['code', 'documents', 'wiki']).toContain(rule.section);
      expect(SONAR_KINDS).toContain(rule.sonar);
      expect(PROBLEM_SEVERITIES).toContain(rule.severity);
      expect(rule.label.en.length).toBeGreaterThan(0);
      expect(rule.label.ru.length).toBeGreaterThan(0);
      expect(['task', 'none']).toContain(rule.action);
      expect(rule.predicate.length).toBeGreaterThan(0);
    }
    expect(new Set(STARTER_PROBLEM_RULES.map((rule) => rule.id)).size).toBe(STARTER_PROBLEM_RULES.length);
    expect(new Set(STARTER_PROBLEM_RULES.map((rule) => rule.kind)).size).toBe(STARTER_PROBLEM_RULES.length);
  });

  test('the three sections have their rules, and every code and documents finding offers a task', () => {
    expect(STARTER_PROBLEM_RULES.filter((rule) => rule.section === 'code').length).toBe(13);
    expect(STARTER_PROBLEM_RULES.filter((rule) => rule.section === 'documents').length).toBe(4);
    expect(STARTER_PROBLEM_RULES.filter((rule) => rule.section === 'wiki').length).toBe(7);
    for (const rule of STARTER_PROBLEM_RULES) if (rule.section !== 'wiki') expect(rule.action).toBe('task');
  });

  test('a wiki finding kind is named by the rule the manifest declares, and a kind no rule declares is not guessed', () => {
    const manifest = starterProblemSettings();
    expect(ruleForKind(manifest, 'ground-removed')).toMatchObject({ id: 'wiki.ground-removed' });
    expect(ruleForKind(manifest, 'broken-link')).toMatchObject({ id: 'wiki.broken-link', sonar: 'bug', severity: 'major' });
    expect(ruleForKind(manifest, 'unread-passage')).toMatchObject({ id: 'wiki.unread-passage', sonar: 'code-smell', severity: 'minor' });
    expect(ruleForKind(manifest, 'an unknown kind')).toBeUndefined();
    // A severity is the rule's own field now: the manifest writes it, the engine reads it.
    const lowered = { ...manifest, rules: { ...manifest.rules, 'wiki.broken-link': { ...manifest.rules['wiki.broken-link']!, severity: 'info' as const } } };
    expect(ruleForKind(lowered, 'broken-link')!.severity).toBe('info');
  });
});
