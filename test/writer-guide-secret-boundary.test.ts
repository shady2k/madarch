/** Known-value boundary before source verification. Tests use only neutral held data, never execution attestation. */
import { expect, test } from 'bun:test';
import { validateGuide } from '../src/writer/guides/validate.js';
import { GUIDE_SCHEMA, type GuideValidationHost } from '../src/writer/guides/model.js';

const FILE = '/product/docs/manual/reader.md';
const SECRET = 'private-runtime-key';
function fixture() {
  return { schema: GUIDE_SCHEMA, id: 'user-guide:main', kind: 'user-guide', locale: 'en', title: 'Read status',
    context: { valid: '2026-04-01T00:00:00Z', known: '2026-04-02T00:00:00Z', state: '0', repositories: [{ name: 'sample', commit: 'a'.repeat(40) }] },
    unitVersion: 'guide-writer@1', inputDigest: 'b'.repeat(64), prerequisites: ['Use an isolated fixture'], gaps: ['Only status is evidenced'],
    procedures: [{ id: 'read-status', title: 'Read status', goal: 'Observe readiness', role: 'Reader', prerequisites: ['Start the isolated fixture'], steps: [
      { id: 'first', title: 'First status', cwd: '.', environment: 'isolated', inputs: [{ name: 'TOKEN', description: 'Supply a token without recording its value', secret: true }], instruction: { kind: 'http', content: 'GET /status' }, expected: { status: 200, observation: 'Ready' }, grounds: [{ repository: 'sample', commit: 'a'.repeat(40), path: 'docs/status.md', line: 1, endLine: 3 }] },
      { id: 'second', title: 'Second status', cwd: 'repos/sample', environment: 'isolated', inputs: [], instruction: { kind: 'http', content: 'GET /status' }, expected: { status: 200, observation: 'Ready' }, grounds: [{ repository: 'sample', commit: 'a'.repeat(40), path: 'docs/status.md', line: 1, endLine: 3 }] },
    ] }],
  };
}
type Segment = string | number;
function strings(value: unknown, path: Segment[] = []): Segment[][] {
  if (typeof value === 'string') return [path];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => strings(item, [...path, Array.isArray(value) ? Number(key) : key]));
}
function assign(value: unknown, path: Segment[], replacement: unknown): void {
  let held = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) held = held[key] as Record<string | number, unknown>;
  held[path.at(-1)!] = replacement;
}
const fieldPath = (path: Segment[]) => '$' + path.map((part) => typeof part === 'number' ? `[${part}]` : `.${part}`).join('');
function host(check: (text: string) => boolean, reached: () => void): GuideValidationHost {
  const source = fixture();
  return { file: FILE, expectedContext: source.context, expectedInputDigest: source.inputDigest, expectedUnitVersion: source.unitVersion, containsSecret: check, verifyStep: async () => { reached(); return []; } };
}

test('known secret in safe relative cwd never reaches even the first verifier call', async () => {
  const source = fixture(); source.procedures[0]!.steps[1]!.cwd = `repos/sample/${SECRET}`;
  let calls = 0;
  const result = await validateGuide(source, host((text) => text.includes(SECRET), () => { calls++; }));
  expect(calls).toBe(0); expect(result.ok).toBe(false);
  if (result.ok) throw new Error('sensitive metadata accepted');
  expect(result.diagnostics.some((problem) => problem.path === '$.procedures[0].steps[1].cwd' && problem.code === 'secret')).toBe(true);
  expect(result.diagnostics.every((problem) => problem.file === FILE && problem.line === 1)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

for (const path of strings(fixture())) {
  test(`every parsed string is checked before any verifier: ${fieldPath(path)}`, async () => {
    const source = fixture(); assign(source, path, SECRET);
    let calls = 0;
    const result = await validateGuide(source, host((text) => text.includes(SECRET), () => { calls++; }));
    expect(calls).toBe(0); expect(result.ok).toBe(false);
    if (result.ok) throw new Error('sensitive field accepted');
    expect(result.diagnostics.some((problem) => problem.path === fieldPath(path) && problem.code === 'secret')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
}

for (const path of [[], ['context'], ['procedures', 0], ['procedures', 0, 'steps', 0], ['procedures', 0, 'steps', 1, 'instruction'], ['procedures', 0, 'steps', 0, 'grounds', 0]] satisfies Segment[][]) {
  test(`sensitive nested member names are refused without echoing them: ${fieldPath(path)}`, async () => {
    const source = fixture();
    let object = source as unknown as Record<string | number, unknown>;
    for (const key of path) object = object[key] as Record<string | number, unknown>;
    object[SECRET] = { [SECRET]: SECRET };
    let calls = 0;
    const result = await validateGuide(source, host((text) => text.includes(SECRET), () => { calls++; }));
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    if (result.ok) throw new Error('sensitive member name accepted');
    expect(result.diagnostics.some((problem) => problem.path.startsWith(`${fieldPath(path)}.$keys[`) && problem.code === 'secret')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
}

test('unknown authored member names never become diagnostic path segments', async () => {
  const source = fixture() as unknown as Record<string, unknown>;
  source['arbitraryAuthoredMember'] = { nestedAuthoredMember: SECRET };
  let calls = 0;
  const result = await validateGuide(source, host((text) => text.includes(SECRET), () => { calls++; }));
  expect(result.ok).toBe(false); expect(calls).toBe(0);
  expect(JSON.stringify(result)).not.toContain('arbitraryAuthoredMember');
  expect(JSON.stringify(result)).not.toContain('nestedAuthoredMember');
  expect(JSON.stringify(result)).not.toContain(SECRET);
  const ordinaryUnknown = await validateGuide({ ...fixture(), arbitraryAuthoredMember: 'ordinary' }, host(() => false, () => { calls++; }));
  expect(ordinaryUnknown.ok).toBe(false);
  expect(JSON.stringify(ordinaryUnknown)).not.toContain('arbitraryAuthoredMember');
});

test('parsed escaped strings are checked as actual values, not JSON byte fragments', async () => {
  for (const secret of ['private"credential', 'private\\credential', 'private\ncredential']) {
    const source = fixture(); source.procedures[0]!.steps[0]!.cwd = secret;
    let calls = 0;
    const result = await validateGuide(source, host((text) => text.includes(secret), () => { calls++; }));
    expect(result.ok).toBe(false); expect(calls).toBe(0); expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
});

test('unavailable, throwing or invalid secret checks fail closed before source verification', async () => {
  for (const check of [undefined, (() => { throw new Error(SECRET); }), (() => undefined)]) {
    let calls = 0;
    const authority = host(() => false, () => { calls++; });
    const result = await validateGuide(fixture(), { ...authority, containsSecret: check } as unknown as GuideValidationHost);
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    if (result.ok) throw new Error('missing secret authority accepted');
    expect(result.diagnostics.some((problem) => problem.code === 'verification-unavailable')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }
});

test('safe complete guide retains source verification and checked output', async () => {
  let calls = 0;
  const result = await validateGuide(fixture(), host((text) => text.includes(SECRET), () => { calls++; }));
  expect(result.ok).toBe(true); expect(calls).toBe(2);
});
