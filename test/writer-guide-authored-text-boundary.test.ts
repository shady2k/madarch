import { describe, expect, test } from 'bun:test';
import { validateGuide } from '../src/writer/guides/validate.js';
import { GUIDE_SCHEMA, type GuideValidationHost } from '../src/writer/guides/model.js';

const file = '/product/docs/guides/user.md';
const marker = 'private-runtime-key';
function fixture() {
  return { schema: GUIDE_SCHEMA, id: 'user-guide:main', kind: 'user-guide', locale: 'en', title: 'Read readiness',
    context: { valid: '2026-04-01T00:00:00Z', known: '2026-04-02T00:00:00Z', state: '0', repositories: [{ name: 'sample', commit: 'a'.repeat(40) }] },
    unitVersion: 'guide-writer@1', inputDigest: 'b'.repeat(64), prerequisites: ['Use a fixture'], gaps: ['Other workflows are not evidenced'],
    procedures: [{ id: 'readiness', title: 'Read readiness', goal: 'Observe the result', role: 'Reader', prerequisites: ['Start a fixture'], steps: [
      { id: 'read', title: 'Read result', cwd: '.', environment: 'isolated', inputs: [{ name: 'TOKEN', description: 'Supply locally', secret: true }],
        instruction: { kind: 'command', content: 'node -e "console.log(7)"' }, expected: { status: 0, observation: '7' },
        grounds: [{ repository: 'sample', commit: 'a'.repeat(40), path: 'docs/readiness.md', line: 1, endLine: 3 }] },
    ] }],
  };
}
function host(source: ReturnType<typeof fixture>, check: (text: string) => boolean, verify: () => void): GuideValidationHost {
  return { file, expectedContext: source.context, expectedInputDigest: source.inputDigest, expectedUnitVersion: source.unitVersion,
    containsSecret: check, verifyStep: async () => { verify(); return []; } };
}
type Segment = string | number;
function assign(value: unknown, path: readonly Segment[], replacement: unknown): void {
  let held = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) held = held[key] as Record<string | number, unknown>;
  held[path.at(-1)!] = replacement;
}

describe('authored guide text versus typed host-bound proof metadata', () => {
  test('numeric state, pins, digests, enums and fixed schema keys are not authored prose', async () => {
    const source = fixture(); let verified = 0;
    const metadata = new Set([source.schema, source.kind, source.locale, source.unitVersion, source.inputDigest,
      source.context.valid, source.context.known, source.context.state, source.context.repositories[0]!.name,
      source.context.repositories[0]!.commit, 'command', 'schema', 'kind', 'locale', 'title', 'context', 'state',
      'repositories', 'commit', 'procedures', 'steps', 'instruction', 'content', 'expected', 'grounds', 'path', 'name']);
    const result = await validateGuide(source, host(source, (text) => metadata.has(text), () => { verified++; }));
    expect(result.ok).toBe(true); expect(verified).toBe(1);
  });

  const authored: readonly (readonly Segment[])[] = [
    ['id'], ['title'], ['prerequisites', 0], ['gaps', 0], ['procedures', 0, 'id'], ['procedures', 0, 'title'],
    ['procedures', 0, 'goal'], ['procedures', 0, 'role'], ['procedures', 0, 'prerequisites', 0],
    ['procedures', 0, 'steps', 0, 'id'], ['procedures', 0, 'steps', 0, 'title'], ['procedures', 0, 'steps', 0, 'cwd'],
    ['procedures', 0, 'steps', 0, 'environment'], ['procedures', 0, 'steps', 0, 'inputs', 0, 'name'],
    ['procedures', 0, 'steps', 0, 'inputs', 0, 'description'], ['procedures', 0, 'steps', 0, 'instruction', 'content'],
    ['procedures', 0, 'steps', 0, 'expected', 'observation'], ['procedures', 0, 'steps', 0, 'grounds', 0, 'path'],
  ];
  for (const path of authored) test(`authored field remains checked before any verifier: ${JSON.stringify(path)}`, async () => {
    const source = fixture(); const authority = fixture(); assign(source, path, marker); let verified = 0;
    const result = await validateGuide(source, host(authority, (text) => text.includes(marker), () => { verified++; }));
    expect(result.ok).toBe(false); expect(verified).toBe(0);
    if (result.ok) throw new Error('private authored text was accepted');
    expect(result.diagnostics.some((entry) => entry.code === 'secret')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test('a clean exact instruction still requires source proof and is never blindly exempt', async () => {
    const source = fixture(); let verified = 0;
    const refused = await validateGuide(source, host(source, (text) => text === source.procedures[0]!.steps[0]!.instruction.content, () => { verified++; }));
    expect(refused.ok).toBe(false); expect(verified).toBe(0);
    const unsupported = await validateGuide(source, { ...host(source, () => false, () => { verified++; }), verifyStep: async () => { verified++; return ['source does not support the proposed instruction']; } });
    expect(unsupported.ok).toBe(false); expect(verified).toBe(1);
  });

  test('typed paths do not exempt authored values or keys at another location', async () => {
    const source = fixture(); source.title = source.context.state; let verified = 0;
    const result = await validateGuide(source, host(source, (text) => text === '0', () => { verified++; }));
    expect(result.ok).toBe(false); expect(verified).toBe(0);
    if (result.ok) throw new Error('state-valued prose was exempted');
    expect(result.diagnostics.some((entry) => entry.path === '$.title' && entry.code === 'secret')).toBe(true);
    const unknown = fixture() as unknown as Record<string, unknown>;
    unknown['extra'] = { title: 'ordinary', [marker]: 'ordinary' };
    const extra = await validateGuide(unknown, host(fixture(), (text) => text === 'title' || text.includes(marker), () => { verified++; }));
    expect(extra.ok).toBe(false); expect(verified).toBe(0);
    expect(JSON.stringify(extra)).not.toContain(marker);
  });

  test('forged proof metadata is not host-bound and cannot use the metadata exclusion', async () => {
    for (const path of [['inputDigest'], ['unitVersion'], ['context', 'state'], ['context', 'valid'], ['context', 'repositories', 0, 'name'], ['context', 'repositories', 0, 'commit']] as const) {
      const source = fixture(); assign(source, path, marker); let verified = 0;
      const result = await validateGuide(source, host(fixture(), (text) => text.includes(marker), () => { verified++; }));
      expect(result.ok).toBe(false); expect(verified).toBe(0);
      if (result.ok) throw new Error('forged metadata was accepted');
      expect(result.diagnostics.some((entry) => entry.code === 'secret')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});
