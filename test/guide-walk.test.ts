import { describe, expect, test } from 'bun:test';
import { CAPABILITY_PROBE, assertStatus, canonical, digest, exportGuideExecution, matchesCapturedEvidence,
  parseOptions, redact, redactStructured, compareJsonFields, assertReadOnlySelectAst, parseReadOnlyOracle, readOnlyOracleCommand, requireGuidePair, resolveGuideCwd, safeOutputRoot, type WalkEvidence, type WalkInvocation } from '../scripts/guide-walk.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { GUIDE_SCHEMA, type GuideDocument } from '../src/writer/guides/model.js';

// Pure operator-boundary tests only. They start no server/container or heavy fixture.
const invocation: WalkInvocation = { kind: 'command', content: '"tool" "inspect"', cwd: 'repos/example', environment: 'isolated-example', physicalCwd: '/scratch/repository', repository: 'example', deployment: 'guidewalk-example', commit: 'a'.repeat(40) };
function captured(overrides: Partial<WalkEvidence> = {}): WalkEvidence {
  const fields = { schema: 'madarch.operator-guide-evidence@1' as const, run: 'example-run', sequence: 1, action: 'inspect-example',
    invocation, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', actualStatus: 0,
    expectedStatus: 0, observed: 'one actual row', checks: [{ name: 'actual-row-count', passed: true }],
    passed: true, evidence: 'evidence/001.txt',
    guideBinding: { product: 'example-product', guide: 'user-guide:main', procedure: 'inspect', step: 'one', commandDigest: guideStepDigest(document(), 'inspect', document().procedures[0]!.steps[0]!), prerequisitesDigest: guideDigest({ guide: document().prerequisites, procedure: document().procedures[0]!.prerequisites }), expectedDigest: guideDigest(document().procedures[0]!.steps[0]!.expected), oracle: { kind: 'json-fields' as const, fields: { rowCount: 1 } } }, ...overrides };
  return { ...fields, digest: digest({ ...fields, digest: undefined }) };
}
function document(observation = 'one actual row'): GuideDocument {
  return { schema: GUIDE_SCHEMA, id: 'user-guide:main', kind: 'user-guide', locale: 'en', title: 'Example',
    context: { valid: '2026-01-01T00:00:00Z', known: '2026-01-01T00:00:00Z', state: 'main', repositories: [{ name: 'example', commit: 'a'.repeat(40) }] },
    unitVersion: '1', inputDigest: 'b'.repeat(64), prerequisites: ['isolated environment'], gaps: [],
    procedures: [{ id: 'inspect', title: 'Inspect', goal: 'Read actual state', role: 'operator', prerequisites: ['tool installed'],
      steps: [{ id: 'one', title: 'Read one row', cwd: invocation.cwd, environment: invocation.environment, inputs: [],
        instruction: { kind: invocation.kind, content: invocation.content }, expected: { status: 0, observation },
        grounds: [{ repository: 'example', commit: 'a'.repeat(40), path: 'README.md', line: 1, endLine: 1 }] }] }] };
}
function binding(guide = document()) { return { product: 'example-product', guide, procedure: 'inspect', step: 'one', invocation }; }

describe('explicit operator CLI', () => {
  test('requires separate probe/walk modes and an explicit output folder', () => {
    expect(parseOptions(['--probe-only', '--out', '/tmp/operator-example', '--source-manifest', '/tmp/source.json'])).toEqual({ mode: 'probe', out: '/tmp/operator-example', source: '/tmp/source.json' });
    expect(parseOptions(['--out', '/tmp/operator-example', '--walk', '--source-manifest', '/tmp/source.json']).mode).toBe('walk');
    for (const args of [[], ['--walk'], ['--walk', '--out', '--probe-only'], ['--walk', '--probe-only', '--out', '/tmp/example'],
      ['--walk', '--out', '/tmp/example', '--install'], ['--walk', '--out', '/tmp/a', '--out', '/tmp/b']]) expect(() => parseOptions(args)).toThrow();
  });
  test('probe reads actual daemon/Compose capability and never provisions a fallback', () => {
    expect(CAPABILITY_PROBE).toContain('timeout 15s docker info');
    expect(CAPABILITY_PROBE).toContain('timeout 10s docker compose version');
    expect(CAPABILITY_PROBE).toContain('daemon=%s compose=%s');
    expect(CAPABILITY_PROBE).not.toMatch(/(?:sudo|apt-get|systemctl|docker run|kubectl|--privileged)/);
  });
  test('refuses output inside checkout rather than deleting a preexisting fixture', () => {
    expect(() => safeOutputRoot('/work/project', '/work/project')).toThrow();
    expect(() => safeOutputRoot('/work/project', '/work/project/tmp/example')).toThrow();
    expect(safeOutputRoot('/work/project', '/work/project-neighbor/run')).toBe('/work/project-neighbor/run');
  });
});
describe('actual evidence is distinct from execution authority', () => {
  test('canonical digest uses code-point key ordering and stable nested data', () => {
    expect(canonical({ z: 1, a: { b: 2, A: 3 } })).toBe('{"a":{"A":3,"b":2},"z":1}');
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });
  test('compares captured evidence bytes, exact invocation, statuses and time', () => {
    const event = captured();
    expect(matchesCapturedEvidence(event, 'one actual row', invocation)).toBe(true);
    expect(matchesCapturedEvidence(event, 'different row', invocation)).toBe(false);
    expect(matchesCapturedEvidence({ ...event, actualStatus: 99 }, event.observed, invocation)).toBe(false);
    expect(matchesCapturedEvidence(event, event.observed, { ...invocation, cwd: 'elsewhere' })).toBe(false);
    expect(matchesCapturedEvidence(event, event.observed, { ...invocation, environment: 'another-run' })).toBe(false);
    expect(matchesCapturedEvidence(captured({ finishedAt: '2025-01-01T00:00:00Z' }), event.observed, invocation)).toBe(false);
  });
  test('expected failure HTTP status can pass, unexpected status and wrong state cannot', () => {
    expect(assertStatus(401, 401, [{ name: 'unauthenticated', passed: true }])).toBe(true);
    expect(assertStatus(500, 401, [{ name: 'unauthenticated', passed: true }])).toBe(false);
    expect(assertStatus(200, 200, [{ name: 'wrong database state', passed: false }])).toBe(false);
  });
  test('matching capture exports untrusted facts, not host authority or source verification', () => {
    const result = exportGuideExecution(captured(), 'one actual row', binding());
    expect(result.envelope.schema).toBe('madarch.guide-execution@1');
    expect(result.envelope.observationMatches).toBe(true);
    expect(result.receipt.actualStatus).toBe(0);
    expect(result.receipt.evidence).toBe('evidence/example-run/1.json');
    expect(result.envelope).not.toHaveProperty('verified');
    expect(result.envelope).not.toHaveProperty('signature');
    expect(result.envelope).not.toHaveProperty('passed');
    expect(result.envelope.evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test('actual wrong observation remains observable failed comparison', () => {
    const event = captured({ actualStatus: 500, observed: 'actual server error', checks: [{ name: 'state', passed: false }], passed: false });
    const result = exportGuideExecution(event, event.observed, binding());
    expect(result.envelope.actualStatus).toBe(500);
    expect(result.envelope.observed).toBe('actual server error');
    expect(result.envelope.observationMatches).toBe(false);
    expect(result.receipt.actualStatus).toBe(500);
    // A new English expectation requires a new explicit typed operator binding.
    expect(() => exportGuideExecution(captured(), 'one actual row', binding(document('different expected sentence')))).toThrow('expected-result binding');
  });
  test('does not alias a successful action to arbitrary guide prose/cwd/environment', () => {
    for (const field of ['instruction', 'cwd', 'environment'] as const) {
      const guide = structuredClone(document()); const step = guide.procedures[0]!.steps[0]!;
      const changed = field === 'instruction' ? { ...step, instruction: { ...step.instruction, content: 'invented command' } }
        : { ...step, [field]: 'changed' };
      const other = { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [changed] }] };
      expect(() => exportGuideExecution(captured(), 'one actual row', binding(other))).toThrow('actual invocation differs');
    }
    expect(() => exportGuideExecution(captured(), 'one actual row', { ...binding(), step: 'missing' })).toThrow();
    expect(() => exportGuideExecution(captured(), 'forged', binding())).toThrow('capture differs');
  });
  test('language/context/unit/input/prerequisite changes change receipt bindings', () => {
    const original = exportGuideExecution(captured(), 'one actual row', binding());
    const guide = document();
    const changed = { ...guide, locale: 'ru' as const, unitVersion: '2', inputDigest: 'c'.repeat(64),
      context: { ...guide.context, state: 'older' }, prerequisites: ['different prerequisite'] };
    expect(() => exportGuideExecution(captured(), 'one actual row', binding(changed))).toThrow('expected-result binding');
    expect(original.envelope).not.toHaveProperty('verified');
  });
});
describe('secret-safe operator handoff', () => {
  test('removes known literal values and structurally parses URLs/JSON; no text heuristic guarantee', () => {
    const token = 'issued-opaque-token'; const secret = 'not-for-evidence';
    const raw = `Authorization: Bearer ${token}\nJWT_SECRET=${secret} vault-123`;
    const safe = redact(raw, [token, secret, 'vault-123']);
    for (const value of [token, secret, 'vault-123']) expect(safe).not.toContain(value);
    expect(safe).toContain('[REDACTED]');
    expect(redact('unknown raw text')).toBe('unknown raw text'); // caller must withhold it
    const structured = redactStructured({ url: 'postgres://user:password@localhost/db', nested: [secret] }, [secret]);
    const serialized = JSON.stringify(structured);
    expect(serialized).not.toContain('password'); expect(serialized).not.toContain(secret);
    expect(redact('public row count: 1')).toBe('public row count: 1');
  });
});

describe('native guide mapping and typed observations', () => {
  test('requires administrator then user rather than a partial or mutated standalone prewalk', () => {
    expect(() => requireGuidePair(['administrator-guide', 'user-guide'])).not.toThrow();
    for (const kinds of [[], ['administrator-guide'], ['user-guide'], ['user-guide', 'administrator-guide'], ['administrator-guide', 'administrator-guide'], ['administrator-guide', 'user-guide', 'user-guide']]) expect(() => requireGuidePair(kinds)).toThrow('partial');
  });
  test('maps logical source cwd to the actual generated repository without aliases', () => {
    expect(resolveGuideCwd('/scratch/fixture', 'example', 'repos/example')).toBe('/scratch/fixture');
    expect(resolveGuideCwd('/scratch/fixture', 'example', 'repos/example/services/api')).toBe('/scratch/fixture/services/api');
    for (const cwd of ['.', '/scratch/fixture', 'repos/other', 'repos/example/../owner', 'repos/example//api']) expect(() => resolveGuideCwd('/scratch/fixture', 'example', cwd)).toThrow();
  });
  test('compares structured fields rather than expected prose or a response substring', () => {
    expect(compareJsonFields({ status: 'confirmed', count: 1 }, { status: 'confirmed' })).toBe(true);
    expect(compareJsonFields({ status: 'pending', detail: 'confirmed' }, { status: 'confirmed' })).toBe(false);
    expect(compareJsonFields({ count: '1' }, { count: 1 })).toBe(false);
    expect(compareJsonFields({ status: 'confirmed' }, {})).toBe(false);
    expect(compareJsonFields(null, { status: 'confirmed' })).toBe(false);
  });
});

describe('database read-only oracle defense', () => {
  test('sets READ ONLY inside one fail-fast transaction without transaction tags in observed rows', () => {
    const argv = readOnlyOracleCommand('orders', 'SELECT 1 AS value');
    expect(argv).toContain('--single-transaction');
    expect(argv).toContain('--quiet');
    expect(argv).toContain('ON_ERROR_STOP=1');
    expect(argv.slice(-4)).toEqual(['-c', 'SET TRANSACTION READ ONLY', '-c', 'SELECT 1 AS value']);
  });
});

describe('real PostgreSQL parser SQL oracle admission', () => {
  test('allows a single read-only query, comments/literals, nested query and CTE', async () => {
    const queries = [
      'SELECT 1 AS value',
      'SELECT * FROM orders',
      "SELECT 'INTO ; DELETE FOR UPDATE' AS value; -- words are literal data",
      'SELECT count(*) AS count FROM orders WHERE status = \'confirmed\'',
      'WITH rows AS (SELECT 1 AS value) SELECT value FROM rows;',
      'WITH RECURSIVE rows AS (SELECT 1 AS value UNION ALL SELECT value + 1 FROM rows WHERE value < 3) SELECT value FROM rows',
      'SELECT value FROM (SELECT 1 AS value) AS rows ORDER BY value',
    ];
    for (const query of queries) expect(await parseReadOnlyOracle(query)).toBe(query);
  }, 20_000);
  test('rejects actual PostgreSQL INTO, locking, mutation CTEs and multiple statements', async () => {
    const queries = [
      'SELECT 1 AS value INTO guide_probe',
      'SELECT * INTO TEMP guide_probe FROM orders',
      'SELECT * FROM orders FOR UPDATE',
      'SELECT * FROM orders FOR SHARE',
      'SELECT * FROM orders FOR KEY SHARE',
      'SELECT * FROM orders FOR NO KEY UPDATE',
      'WITH rows AS (SELECT * FROM orders FOR UPDATE) SELECT * FROM rows',
      'WITH changed AS (DELETE FROM orders RETURNING id) SELECT id FROM changed',
      "WITH changed AS (UPDATE orders SET status = 'cancelled' RETURNING id) SELECT id FROM changed",
      "WITH changed AS (INSERT INTO orders (id) VALUES ('probe') RETURNING id) SELECT id FROM changed",
      'SELECT 1; SELECT 2', 'BEGIN; SELECT 1; COMMIT', 'DELETE FROM orders', '', 'not SQL',
    ];
    for (const query of queries) await expect(parseReadOnlyOracle(query)).rejects.toThrow();
  }, 20_000);
  test('unknown nodes, unknown fields and malformed known AST structures fail closed', async () => {
    const { parsePostgres } = await import('../src/parsers/postgres.js');
    const actual = await parsePostgres('SELECT 1 AS value');
    expect(() => assertReadOnlySelectAst(actual)).not.toThrow();
    const root = actual as unknown as { stmts: { stmt: { SelectStmt: Record<string, unknown> } }[] };
    const select = root.stmts[0]!.stmt.SelectStmt;
    for (const invalid of [
      { ...actual, futureRootField: true },
      { version: 180004, stmts: [{ stmt: { UnknownStmt: {} } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, futureSelectField: true } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, whereClause: { UnknownExpr: {} } } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, targetList: 'not an array' } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, whereClause: { A_Const: {}, ColumnRef: {} } } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: {} } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, targetList: [{ ResTarget: { val: { A_Star: { is_slice: true } } } }] } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, whereClause: { ColumnRef: {} } } } }] },
      { version: 180004, stmts: [{ stmt: { SelectStmt: { ...select, whereClause: { ColumnRef: { fields: [{ String: { sval: 'id' } }], unknown: true } } } } }] },
      { version: 180004, stmts: [] },
      { version: 180004, stmts: [root.stmts[0], root.stmts[0]] },
    ]) expect(() => assertReadOnlySelectAst(invalid)).toThrow();
  }, 20_000);
  test('real parser syntax failures propagate before any database command', async () => {
    await expect(parseReadOnlyOracle('SELECT FROM (')).rejects.toThrow();
    let received = '';
    await expect(parseReadOnlyOracle('actual input', async (query) => { received = query; throw new Error('native parser failure'); })).rejects.toThrow('native parser failure');
    expect(received).toBe('actual input');
  });
});
