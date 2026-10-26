import { describe, expect, test } from 'bun:test';
import { GUIDE_SCHEMA, GUIDE_RECEIPT_SCHEMA, type GuideDocument, type GuideReceipt, type GuideValidationHost } from '../src/writer/guides/model.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideBodyMarkdown, renderGuideMarkdown } from '../src/writer/guides/render.js';
import { guideWalkStatus, type GuideWalkHost } from '../src/writer/guides/receipts.js';
import { parseGuideArtifact, renderGuideArtifact } from '../src/writer/guides/artifact.js';
import { sourceAddress } from '../src/knowledge/resolve.js';

// Boundary fixtures, not live walkthrough evidence. The independent evidence store is host-only.
const COMMIT = 'a'.repeat(40);
const COMMAND = 'make up';
const OBSERVATION = 'The local services are healthy.';
const CONTEXT = { valid: '2026-06-01T00:00:00Z', known: '2026-06-02T00:00:00Z', state: 'accepted', repositories: [{ name: 'example', commit: COMMIT }] };
const SECRET = 'private-fixture-value';
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function fixture(): Mutable<GuideDocument> {
  return {
    schema: GUIDE_SCHEMA, id: 'administrator', kind: 'administrator-guide', locale: 'en', title: 'Administrator guide',
    context: structuredClone(CONTEXT), unitVersion: '1', inputDigest: guideDigest({ source: COMMIT }),
    prerequisites: ['Use an isolated environment.'], gaps: ['No recovery procedure is evidenced.'],
    procedures: [{ id: 'local-start', title: 'Start locally', goal: 'Start the services.', role: 'Administrator', prerequisites: ['Containers are available.'],
      steps: [{ id: 'start', title: 'Start services', cwd: '.', environment: 'isolated-container-environment', inputs: [], instruction: { kind: 'command', content: COMMAND }, expected: { status: 0, observation: OBSERVATION },
        grounds: [{ repository: 'example', commit: COMMIT, path: 'Makefile', line: 1, endLine: 3 }] }] }],
  };
}
function sourceHost(guide: GuideDocument): GuideValidationHost {
  return {
    file: '/product/docs/guides/administrator.md', expectedContext: CONTEXT,
    expectedInputDigest: guide.inputDigest, expectedUnitVersion: '1', containsSecret: (text) => text.includes(SECRET),
    verifyStep: async (step) => step.instruction.content === COMMAND && step.expected.status === 0 && step.expected.observation === OBSERVATION && step.grounds.length === 1 && step.grounds[0]!.path === 'Makefile' && step.grounds[0]!.line === 1 && step.grounds[0]!.endLine === 3 ? [] : ['The held source does not support this instruction and expectation.'],
  };
}
async function checked(guide = fixture()): Promise<GuideDocument> {
  const result = await validateGuide(guide, sourceHost(guide));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.guide;
}
function receiptFor(guide: GuideDocument): GuideReceipt {
  const procedure = guide.procedures[0]!; const step = procedure.steps[0]!;
  return { schema: GUIDE_RECEIPT_SCHEMA, guide: guide.id, procedure: procedure.id, step: step.id,
    context: guide.context, unitVersion: guide.unitVersion, inputDigest: guide.inputDigest,
    commandDigest: guideStepDigest(guide, procedure.id, step), environment: step.environment,
    prerequisitesDigest: guideDigest({ guide: guide.prerequisites, procedure: procedure.prerequisites }),
    cwd: step.cwd, at: '2026-06-02T01:00:00Z', evidence: 'docs/guide-walks/run-1.md', actualStatus: 0, observed: OBSERVATION };
}
function executionHost(evidence: readonly GuideReceipt[]): GuideWalkHost {
  const independentlyRetained = new Map(evidence.map((receipt) => [receipt.evidence, structuredClone(receipt)]));
  return {
    file: '/product/docs/guide-walks/run-1.md', containsSecret: (text) => text.includes(SECRET),
    verifyExecution: async (receipt, step) => {
      const actual = independentlyRetained.get(receipt.evidence);
      if (actual === undefined || guideDigest(actual) !== guideDigest(receipt)) return { kind: 'unverified', reason: 'No matching independent execution evidence.' };
      return { kind: 'verified', observationMatches: receipt.observed === step.expected.observation };
    },
  };
}

describe('checked guide boundary', () => {
  test('a guide with no evidenced procedure requires an explicit gap and never claims a passed walk', async () => {
    const raw = fixture(); raw.procedures = []; raw.gaps = ['No source-backed startup workflow is available.'];
    const result = await validateGuide(raw, { ...sourceHost(raw), verifyStep: async () => { throw new Error('No invented step may reach the verifier.'); } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.guide.procedures).toEqual([]);
      const walk = await guideWalkStatus(result.guide, [], executionHost([]));
      expect(walk.status).toBe('not-walked');
      expect(renderGuideMarkdown(result.guide, walk)).toContain('No source' + String.fromCharCode(92) + '-backed startup workflow is available');
      expect(renderGuideMarkdown(result.guide, walk)).toContain('## Known gaps');
      expect(renderGuideMarkdown(result.guide, walk)).toContain('Walkthrough status: Not walked');
      expect(renderGuideMarkdown(result.guide, walk)).not.toContain('Walkthrough status: Passed');
      expect((await parseGuideArtifact('/product/docs/guides/administrator.md', renderGuideArtifact(result.guide), sourceHost(raw))).ok).toBe(true);
    }
    for (const gaps of [[], [''], [SECRET]]) {
      expect((await validateGuide({ ...raw, gaps }, sourceHost(raw))).ok).toBe(false);
    }
  });

  test('only exact source-backed steps render; the checked artifact is immutable', async () => {
    const raw = fixture(); const guide = await checked(raw);
    expect(Object.isFrozen(guide)).toBe(true);
    expect(Object.isFrozen(guide.procedures[0]!.steps[0]!)).toBe(true);
    raw.procedures[0]!.steps[0]!.instruction = { kind: 'command', content: 'not the checked command' };
    expect(renderGuideMarkdown(guide)).toContain('make up');
    expect(renderGuideMarkdown(guide)).toContain('Not walked');
    expect(renderGuideMarkdown(guide)).toContain('No recovery procedure');
    expect(() => renderGuideMarkdown(fixture())).toThrow('source verification');
  });

  test('invented commands or expected responses are refused even with resolving grounds', async () => {
    for (const field of ['instruction', 'expected'] as const) {
      const guide = fixture();
      if (field === 'instruction') guide.procedures[0]!.steps[0]!.instruction = { kind: 'command', content: 'make imaginary-operation' };
      else guide.procedures[0]!.steps[0]!.expected = { status: 0, observation: 'An unsupported guarantee.' };
      const result = await validateGuide(guide, sourceHost(guide));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'unsupported-instruction')).toBe(true);
    }
  });

  test('host verification missing, throwing, or returning no result fails closed', async () => {
    const guide = fixture();
    const unavailable = { ...sourceHost(guide), verifyStep: undefined } as unknown as GuideValidationHost;
    expect((await validateGuide(guide, unavailable)).ok).toBe(false);
    expect((await validateGuide(guide, { ...sourceHost(guide), verifyStep: async () => { throw new Error('unavailable'); } })).ok).toBe(false);
    expect((await validateGuide(guide, { ...sourceHost(guide), containsSecret: () => { throw new Error('unavailable'); } })).ok).toBe(false);
  });

  test('full temporal context and named repository pins cannot be replaced', async () => {
    for (const key of ['valid', 'known', 'state'] as const) {
      const guide = fixture();
      const context = { ...guide.context, [key]: key === 'state' ? 'other' : '2026-07-01T00:00:00Z' };
      const result = await validateGuide({ ...guide, context }, sourceHost(guide));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'stale-context')).toBe(true);
    }
    const guide = fixture();
    const ground = { ...guide.procedures[0]!.steps[0]!.grounds[0]!, commit: 'b'.repeat(40) };
    const changed = { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [{ ...guide.procedures[0]!.steps[0]!, grounds: [ground] }] }] };
    expect((await validateGuide(changed, sourceHost(guide))).ok).toBe(false);
  });

  test('status is mandatory and discriminates HTTP from command, with explicit paths', async () => {
    const guide = fixture();
    const step = guide.procedures[0]!.steps[0]!;
    const bad = { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [{ ...step, instruction: { kind: 'http', content: 'GET /healthz' }, expected: { status: 0, observation: 'healthy' } }] }] };
    const result = await validateGuide(bad, sourceHost(guide));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]!.message).toContain('/product/docs/guides/administrator.md:1:');
      expect(result.diagnostics.some((d) => d.path === '$.procedures[0].steps[0].expected.status')).toBe(true);
    }
  });

  test('unsafe paths, unknown fields, secrets and empty procedures are refused', async () => {
    const guide = fixture();
    for (const bad of [{ ...guide, procedures: [], gaps: [] }, { ...guide, passed: true }, { ...guide, title: SECRET }, { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [{ ...guide.procedures[0]!.steps[0]!, cwd: '../outside' }] }] }]) {
      expect((await validateGuide(bad, sourceHost(guide))).ok).toBe(false);
    }
  });
});

describe('independent walkthrough evidence', () => {
  test('an authenticated execution with the expected exit but a different observation fails', async () => {
    const guide = await checked();
    const receipt = { ...receiptFor(guide), observed: 'The command exited successfully but the services are unavailable.' };
    const result = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(result.status).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(renderGuideMarkdown(guide, result)).toContain('Walkthrough status: Failed');
    expect((await guideWalkStatus(guide, [receipt], executionHost([receiptFor(guide)]))).status).toBe('not-walked');
  });

  test('a host-confirmed actual execution passes, absent receipts never do', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    const passed = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(passed.status).toBe('passed');
    expect(renderGuideMarkdown(guide, passed)).toContain('Walkthrough status: Passed');
    expect((await guideWalkStatus(guide, [], executionHost([]))).status).toBe('not-walked');
  });

  test('self-attested author, status flag or invented observed result cannot certify a walk', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    for (const forged of [{ ...receipt, author: 'trusted-operator' }, { ...receipt, passed: true }, { ...receipt, observed: 'the agent says success' }]) {
      const result = await guideWalkStatus(guide, [forged], executionHost([receipt]));
      expect(result.status).toBe('not-walked');
    }
    expect((await guideWalkStatus(guide, [receipt], executionHost([]))).status).toBe('not-walked');
    expect(() => renderGuideMarkdown(guide, { guide: guide.id, status: 'passed', steps: [], diagnostics: [] })).toThrow('independent execution verification');
  });

  test('real failed status is failed, including when the recorded text claims success', async () => {
    const guide = await checked(); const receipt = { ...receiptFor(guide), actualStatus: 1, observed: 'container start failed' };
    const result = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(result.status).toBe('failed');
    expect(renderGuideMarkdown(guide, result)).toContain('Walkthrough status: Failed');
  });

  test('command, context, prerequisites, environment, evidence and status mutations reject replay', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    const host = executionHost([receipt]);
    for (const changed of [
      { ...receipt, commandDigest: '0'.repeat(64) },
      { ...receipt, context: { ...receipt.context, known: '2026-08-01T00:00:00Z' } },
      { ...receipt, prerequisitesDigest: '0'.repeat(64) },
      { ...receipt, inputDigest: '0'.repeat(64) },
      { ...receipt, environment: 'different-run' },
      { ...receipt, evidence: 'docs/guide-walks/another-run.md' },
      { ...receipt, actualStatus: 1 },
    ]) expect((await guideWalkStatus(guide, [changed], host)).status).toBe('not-walked');
    const raw = fixture(); raw.prerequisites.push('A new prerequisite.');
    const changedGuide = await checked(raw);
    expect((await guideWalkStatus(changedGuide, [receipt], host)).status).toBe('not-walked');
  });

  test('cross-guide, unknown and duplicate receipts cannot produce a complete pass', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    const host = executionHost([receipt]);
    for (const receipts of [[{ ...receipt, guide: 'another-guide' }], [{ ...receipt, step: 'unknown-step' }], [receipt, receipt]]) {
      expect((await guideWalkStatus(guide, receipts, host)).status).toBe('not-walked');
    }
  });

  test('unavailable execution verifier and secret-bearing receipts fail closed', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    expect((await guideWalkStatus(guide, [receipt], { ...executionHost([receipt]), verifyExecution: async () => { throw new Error('offline'); } })).status).toBe('not-walked');
    expect((await guideWalkStatus(guide, [{ ...receipt, observed: SECRET }], executionHost([receipt]))).status).toBe('not-walked');
    expect((await guideWalkStatus(fixture(), [receipt], executionHost([receipt]))).status).toBe('not-walked');
  });
});

describe('literal guide rendering', () => {
  test('host source links change only the read projection and keep authored labels literal', async () => {
    const raw = fixture(); raw.procedures[0]!.steps[0]!.grounds[0]!.path = 'docs/a [b](c)&d.md';
    const result = await validateGuide(raw, { ...sourceHost(raw), verifyStep: async () => [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const guide = result.guide;
    const canonical = renderGuideMarkdown(guide);
    const artifact = renderGuideArtifact(guide);
    const body = renderGuideBodyMarkdown(guide);
    const options = { groundHref: (ground: GuideDocument['procedures'][number]['steps'][number]['grounds'][number]) => sourceAddress(ground.repository, ground.path, ground.line) };
    const linked = renderGuideBodyMarkdown(guide, undefined, options);
    expect(renderGuideMarkdown(guide, undefined, {})).toBe(canonical);
    expect(renderGuideBodyMarkdown(guide, undefined, {})).toBe(body);
    expect(renderGuideBodyMarkdown(guide, undefined, { groundHref: () => undefined })).toBe(body);
    expect(renderGuideArtifact(guide)).toBe(artifact);
    expect(body).not.toContain('](/k/src?');
    expect(linked).toContain('](/k/src?repo=example&path=docs%2Fa+%5Bb%5D%28c%29%26d.md&line=1)');
    expect(linked).toContain('docs/a ' + String.fromCharCode(92) + '[b' + String.fromCharCode(92) + ']' + String.fromCharCode(92) + '(c' + String.fromCharCode(92) + ')&amp;d' + String.fromCharCode(92) + '.md');
    const rendered = renderGuideMarkdown(guide, undefined, options);
    expect(linked).toBe(rendered.slice(rendered.indexOf('\n---\n', 4) + 5));
    for (const href of ['javascript:alert(1)', '//outside.example/source', '/k/doc?path=another', '/k/src?path=bad\\outside', '/k/src?path=bad)\n[bad](https://outside.example)', '/k/src?path=bad source']) {
      expect(() => renderGuideBodyMarkdown(guide, undefined, { groundHref: () => href })).toThrow('safe encoded relative URL');
    }
  });

  test('the reader body preserves canonical Markdown without exposing generated YAML', async () => {
    const guide = await checked();
    const full = renderGuideMarkdown(guide);
    const body = renderGuideBodyMarkdown(guide);
    expect(body).toBe(full.slice(full.indexOf('\n---\n', 4) + 5));
    expect(body).toStartWith('\n# Administrator guide\n');
    expect(body).not.toContain('wiki-language:');
    const receipt = receiptFor(guide);
    const walk = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(renderGuideBodyMarkdown(guide, walk)).toContain('Walkthrough status: Passed');
    const artifact = renderGuideArtifact(guide);
    expect(artifact.slice(artifact.indexOf('\n---\n', 4) + 5)).toBe(body);
  });

  test('literal prose preserves every escaped character, CRLF, lone CR and Unicode exactly', async () => {
    const raw = fixture();
    raw.title = 'A &<> ' + String.fromCharCode(92) + '`*_{}[]()#+.!|~-' + '\r\nB\nC\rD 😀';
    const markdown = renderGuideMarkdown(await checked(raw));
    const body = markdown.slice(markdown.indexOf('\n---\n', 4) + 5);
    const escapedPunctuation = [String.fromCharCode(92), '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '.', '!', '|', '~', '-'].map((character) => String.fromCharCode(92) + character).join('');
    expect(body.split('\n')[1]).toBe('# A &amp;&lt;&gt; ' + escapedPunctuation + ' B C\rD 😀');
  });

  test('the longest contiguous backtick run chooses the complete literal fence', async () => {
    for (const run of [0, 1, 2, 3, 12]) {
      const raw = fixture();
      const content = `first${'`'.repeat(run)}second\nthird${'`'.repeat(Math.max(0, run - 1))}end`;
      raw.procedures[0]!.steps[0]!.instruction = { kind: 'command', content };
      const result = await validateGuide(raw, { ...sourceHost(raw), verifyStep: async (step) => step.instruction.content === content ? [] : ['different'] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fence = '`'.repeat(Math.max(2, run) + 1);
        expect(renderGuideMarkdown(result.guide)).toContain(`${fence}text\n${content}\n${fence}`);
      }
    }
  });

  test('English/Russian labels and dangerous Markdown/HTML are literal, not executable', async () => {
    const raw = fixture(); raw.title = '<script>alert(1)</script> [click](javascript:alert(1))';
    raw.procedures[0]!.steps[0]!.title = 'A dangerous ` title';
    const guide = await checked(raw);
    const markdown = renderGuideMarkdown(guide);
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown.split('---\n').slice(2).join('---\n')).not.toContain('<script>');
    expect(markdown).toContain('\\[click\\]');
    const ru = fixture(); ru.locale = 'ru';
    expect(renderGuideMarkdown(await checked(ru))).toContain('Не пройдено');
    expect(renderGuideMarkdown(await checked(ru))).toContain('Ожидаемый результат');
  });

  test('long literal commands and nested fences remain complete in one escaped block', async () => {
    const raw = fixture(); const content = `printf '${'x'.repeat(800)}'\n\`\`\`\n<script>not executed</script>`;
    raw.procedures[0]!.steps[0]!.instruction = { kind: 'command', content };
    const result = await validateGuide(raw, { ...sourceHost(raw), verifyStep: async (step) => step.instruction.content === content ? [] : ['different'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const markdown = renderGuideMarkdown(result.guide);
      expect(markdown).toContain('````text\n');
      expect(markdown).toContain(content);
      expect(markdown).toContain('\n````');
    }
  });
});

describe('bounded and pinned guide inputs', () => {
  test('structural token boundaries keep guide identities, digests, commits and inputs exact', async () => {
    const validIds = ['a', 'a0', 'a-b0', 'administrator-guide:main'];
    for (const id of validIds) {
      const raw = fixture(); raw.id = id;
      expect((await validateGuide(raw, sourceHost(raw))).ok).toBe(true);
    }
    for (const id of ['', 'A', '0a', '-a', 'a-', 'a--b', 'a_b', 'a:b', 'user-guide:main']) {
      const raw = fixture(); raw.id = id;
      const result = await validateGuide(raw, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.id' && item.code === 'identity')).toBe(true);
    }
    for (const digest of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
      const raw = fixture(); raw.inputDigest = digest;
      const result = await validateGuide(raw, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.inputDigest' && item.code === 'digest')).toBe(true);
    }
    for (const length of [40, 64]) {
      const raw = fixture(); const commit = 'a'.repeat(length);
      raw.context.repositories[0]!.commit = commit;
      raw.procedures[0]!.steps[0]!.grounds[0]!.commit = commit;
      expect((await validateGuide(raw, { ...sourceHost(raw), expectedContext: raw.context })).ok).toBe(true);
    }
    for (const commit of ['a'.repeat(39), 'a'.repeat(65), 'A'.repeat(40), 'g'.repeat(40)]) {
      const raw = fixture(); raw.context.repositories[0]!.commit = commit;
      const result = await validateGuide(raw, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.context.repositories[0].commit' && item.code === 'commit')).toBe(true);
    }
    for (const name of ['A', 'A0_B', 'Z_']) {
      const raw = fixture(); raw.procedures[0]!.steps[0]!.inputs = [{ name, description: 'Supply a local value.', secret: false }];
      expect((await validateGuide(raw, sourceHost(raw))).ok).toBe(true);
    }
    for (const name of ['', 'a', '0A', '_A', 'A-B', 'Å']) {
      const raw = fixture(); raw.procedures[0]!.steps[0]!.inputs = [{ name, description: 'Supply a local value.', secret: false }];
      const result = await validateGuide(raw, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.procedures[0].steps[0].inputs[0].name' && item.code === 'input-name')).toBe(true);
    }
  });

  test('plain text and UTC token boundaries preserve allowed whitespace and reject control bytes', async () => {
    for (const text of ['A\tB', 'A\nB', 'A\rB', 'A😀B']) {
      const raw = fixture(); raw.title = text;
      expect((await validateGuide(raw, sourceHost(raw))).ok).toBe(true);
    }
    for (const code of [0, 8, 11, 12, 14, 31]) {
      const raw = fixture(); raw.title = `A${String.fromCharCode(code)}B`;
      const result = await validateGuide(raw, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.title' && item.code === 'text')).toBe(true);
    }
    for (const valid of ['2026-06-01T00:00:00Z', '2026-06-01T00:00:00.123Z']) {
      const raw = fixture(); raw.context.valid = valid;
      expect((await validateGuide(raw, { ...sourceHost(raw), expectedContext: raw.context })).ok).toBe(true);
    }
    for (const valid of ['2026-06-01', '2026-06-01t00:00:00Z', '2026-06-01T00:00:00z', '2026-06-01T00:00:00+00:00', '2026-13-01T00:00:00Z', '２０２６-06-01T00:00:00Z']) {
      const raw = fixture(); raw.context.valid = valid;
      const result = await validateGuide(raw, { ...sourceHost(raw), expectedContext: raw.context });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((item) => item.path === '$.context.valid' && item.code === 'instant')).toBe(true);
    }
  });

  test('invalid temporal fields, unknown repositories and repeated identities refuse', async () => {
    const guide = fixture();
    const duplicate = { ...guide, procedures: [guide.procedures[0]!, guide.procedures[0]!] };
    const repeatedSteps = { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [guide.procedures[0]!.steps[0]!, guide.procedures[0]!.steps[0]!] }] };
    const unknownRepo = fixture(); unknownRepo.procedures[0]!.steps[0]!.grounds[0]!.repository = 'not-pinned';
    for (const bad of [duplicate, repeatedSteps, unknownRepo, { ...guide, context: { ...guide.context, valid: 'yesterday' } }]) {
      expect((await validateGuide(bad, sourceHost(guide))).ok).toBe(false);
    }
  });

  test('whole guide bound and control characters are enforced before host verification', async () => {
    const guide = fixture();
    const huge = { ...guide, gaps: Array.from({ length: 20 }, () => 'x'.repeat(15000)) };
    const control = fixture(); control.procedures[0]!.steps[0]!.instruction.content = 'make up\u0001';
    for (const bad of [huge, control]) expect((await validateGuide(bad, sourceHost(guide))).ok).toBe(false);
  });

  test('a serialized checked guide or walk result must be revalidated on reload', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    const result = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(() => renderGuideMarkdown(JSON.parse(JSON.stringify(guide)) as GuideDocument)).toThrow('source verification');
    expect(() => renderGuideMarkdown(guide, JSON.parse(JSON.stringify(result)) as typeof result)).toThrow('independent execution verification');
  });

  test('receipt observed-result swaps cannot reuse independent evidence', async () => {
    const guide = await checked(); const receipt = receiptFor(guide);
    const swapped = { ...receipt, observed: 'Different procedure completed.' };
    expect((await guideWalkStatus(guide, [swapped], executionHost([receipt]))).status).toBe('not-walked');
  });
});

describe('canonical generated guide artifact', () => {
  const FILE = '/product/docs/guides/administrator.md';
  test('nested and multi-digit field diagnostics keep the exact YAML source line', async () => {
    const raw = fixture();
    raw.procedures = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(raw.procedures[0]!), id: `procedure-${index}` }));
    const artifact = renderGuideArtifact(await checked(raw));
    let occurrence = 0;
    const lines = artifact.split('\n');
    const index = lines.findIndex((line) => line.trim() === 'status: 0' && ++occurrence === 12);
    expect(index).toBeGreaterThan(0);
    lines[index] = lines[index]!.slice(0, lines[index]!.indexOf('status:')) + 'status: 999';
    const result = await parseGuideArtifact(FILE, lines.join('\n'), sourceHost(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostic = result.diagnostics.find((item) => item.path === '$.guide.procedures[11].steps[0].expected.status');
      expect(diagnostic?.code).toBe('status');
      expect(diagnostic?.line).toBe(index + 1);
      expect(diagnostic?.message).toContain(`${FILE}:${index + 1}: $.guide.procedures[11].steps[0].expected.status:`);
    }
  });

  test('en and ru render/parse roundtrip exact payload, instruction bytes and locale', async () => {
    for (const locale of ['en', 'ru'] as const) {
      const raw = fixture(); raw.locale = locale;
      const guide = await checked(raw);
      const artifact = renderGuideArtifact(guide);
      const parsed = await parseGuideArtifact(FILE, artifact, sourceHost(raw));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.guide).toEqual(guide);
        expect(renderGuideArtifact(parsed.guide)).toBe(artifact);
      }
      expect(artifact).toContain(locale === 'ru' ? 'Не пройдено' : 'Not walked');
      expect(artifact).toContain(`wiki-language: ${locale}`);
    }
  });

  test('ordinary Markdown and agent claims do not become checked guide artifacts', async () => {
    const raw = fixture(); const host = sourceHost(raw);
    for (const source of ['# Ordinary guide\n\nmake up\n', '---\nproducer: agent\n---\n# Not checked\n', '---\nschema: madarch.product-guide@1\n---\n']) {
      expect((await parseGuideArtifact(FILE, source, host)).ok).toBe(false);
    }
  });

  test('mirrored metadata, unknown fields and body tampering are refused, not overwritten', async () => {
    const raw = fixture(); const guide = await checked(raw); const artifact = renderGuideArtifact(guide);
    for (const changed of [
      artifact.replace('id: administrator\n', 'id: another-guide\n'),
      artifact.replace('wiki-language: en\n', 'wiki-language: ru\n'),
      artifact.replace('producer: agent\n', 'producer: agent\npassed: true\n'),
      artifact.replace('# Administrator guide', '# Human-authored replacement'),
      artifact.replace('**Walkthrough status: Not walked**', '**Walkthrough status: Passed**'),
      `${artifact}\nAn authored addition.\n`,
    ]) {
      const result = await parseGuideArtifact(FILE, changed, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) for (const diagnostic of result.diagnostics) {
        expect(diagnostic.file).toBe(FILE);
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.message).toContain(`${FILE}:${diagnostic.line}:`);
        expect(diagnostic.path).toStartWith('$.');
      }
    }
  });

  test('unique-key and strict-YAML refusal precedes alias materialization', async () => {
    const raw = fixture(); const artifact = renderGuideArtifact(await checked(raw));
    for (const changed of [
      artifact.replace('schema: madarch.product-guide@1\n', 'schema: madarch.product-guide@1\nschema: other\n'),
      artifact.replace('title: Administrator guide\n', 'title: &shared Administrator guide\n'),
      artifact.replace('title: Administrator guide\n', 'title: !!str Administrator guide\n'),
    ]) {
      const result = await parseGuideArtifact(FILE, changed, sourceHost(raw));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.some((d) => d.code === 'strict-yaml')).toBe(true);
    }
  });

  test('supported metadata/body does not replace source verification or input freshness', async () => {
    const raw = fixture(); const artifact = renderGuideArtifact(await checked(raw));
    expect((await parseGuideArtifact(FILE, artifact, { ...sourceHost(raw), verifyStep: async () => ['unsupported expectation'] })).ok).toBe(false);
    expect((await parseGuideArtifact(FILE, artifact, { ...sourceHost(raw), expectedInputDigest: '0'.repeat(64) })).ok).toBe(false);
  });

  test('durable artifact never persists a passed overlay and parsing never grants write ownership', async () => {
    const raw = fixture(); const guide = await checked(raw); const receipt = receiptFor(guide);
    const walk = await guideWalkStatus(guide, [receipt], executionHost([receipt]));
    expect(renderGuideMarkdown(guide, walk)).toContain('Walkthrough status: Passed');
    const artifact = renderGuideArtifact(guide);
    expect(artifact).toContain('Walkthrough status: Not walked');
    const parsed = await parseGuideArtifact(FILE, artifact, sourceHost(raw));
    expect(parsed.ok).toBe(true);
    // There is intentionally no overwrite/write capability on the read result.
    if (parsed.ok) expect(Object.keys(parsed).sort()).toEqual(['guide', 'ok']);
  });
});
