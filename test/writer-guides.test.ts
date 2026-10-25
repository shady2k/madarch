import { describe, expect, test } from 'bun:test';
import { GUIDE_SCHEMA, GUIDE_RECEIPT_SCHEMA, type GuideDocument, type GuideReceipt, type GuideValidationHost } from '../src/writer/guides/model.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideMarkdown } from '../src/writer/guides/render.js';
import { guideWalkStatus, type GuideWalkHost } from '../src/writer/guides/receipts.js';

// Boundary fixtures, not live walkthrough evidence. The independent evidence store is host-only.
const COMMIT = 'a'.repeat(40);
const COMMAND = 'make up';
const OBSERVATION = 'The local services are healthy.';
const CONTEXT = { valid: '2026-06-01T00:00:00Z', known: '2026-06-02T00:00:00Z', state: 'accepted', repositories: [{ name: 'training', commit: COMMIT }] };
const SECRET = 'private-fixture-value';
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function fixture(): Mutable<GuideDocument> {
  return {
    schema: GUIDE_SCHEMA, id: 'administrator', kind: 'administrator-guide', locale: 'en', title: 'Administrator guide',
    context: structuredClone(CONTEXT), unitVersion: '1', inputDigest: guideDigest({ source: COMMIT }),
    prerequisites: ['Use an isolated environment.'], gaps: ['No recovery procedure is evidenced.'],
    procedures: [{ id: 'local-start', title: 'Start locally', goal: 'Start the services.', role: 'Administrator', prerequisites: ['Containers are available.'],
      steps: [{ id: 'start', title: 'Start services', cwd: '.', environment: 'isolated-container-environment', inputs: [], instruction: { kind: 'command', content: COMMAND }, expected: { status: 0, observation: OBSERVATION },
        grounds: [{ repository: 'training', commit: COMMIT, path: 'Makefile', line: 1, endLine: 3 }] }] }],
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
    commandDigest: guideStepDigest(guide, procedure.id, step), environment: 'isolated-acceptance-run-1',
    prerequisitesDigest: guideDigest({ guide: guide.prerequisites, procedure: procedure.prerequisites }),
    cwd: step.cwd, at: '2026-06-02T01:00:00Z', evidence: 'docs/guide-walks/run-1.md', actualStatus: 0, observed: OBSERVATION };
}
function executionHost(evidence: readonly GuideReceipt[]): GuideWalkHost {
  const independentlyRetained = new Map(evidence.map((receipt) => [receipt.evidence, structuredClone(receipt)]));
  return {
    file: '/product/docs/guide-walks/run-1.md', containsSecret: (text) => text.includes(SECRET),
    verifyExecution: async (receipt, step) => {
      const actual = independentlyRetained.get(receipt.evidence);
      return actual !== undefined && guideDigest(actual) === guideDigest(receipt) &&
        (receipt.actualStatus !== step.expected.status || receipt.observed === step.expected.observation);
    },
  };
}

describe('checked guide boundary', () => {
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
    for (const bad of [{ ...guide, procedures: [] }, { ...guide, passed: true }, { ...guide, title: SECRET }, { ...guide, procedures: [{ ...guide.procedures[0]!, steps: [{ ...guide.procedures[0]!.steps[0]!, cwd: '../outside' }] }] }]) {
      expect((await validateGuide(bad, sourceHost(guide))).ok).toBe(false);
    }
  });
});

describe('independent walkthrough evidence', () => {
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
