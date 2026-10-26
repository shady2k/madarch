import { describe, expect, test } from 'bun:test';
import { GUIDE_SCHEMA, GUIDE_RECEIPT_SCHEMA, type GuideDocument, type GuideValidationHost, type GuideReceipt } from '../src/writer/guides/model.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { renderGuideArtifact } from '../src/writer/guides/artifact.js';
import { guideDigest, guideStepDigest } from '../src/writer/guides/digest.js';
import { guideWalkStatus } from '../src/writer/guides/receipts.js';
import { readGuidePage, guidePageMarkdown } from '../src/writer/guides/read.js';
import type { GuideHost } from '../src/writer/guides/host.js';

const FILE = '/product/docs/guides/administrator.md';
function example(): GuideDocument {
  return { schema: GUIDE_SCHEMA, id: 'administrator-guide:main', kind: 'administrator-guide', locale: 'en', title: 'Administrator guide', context: { valid: '2026-01-01T00:00:00Z', known: '2026-01-02T00:00:00Z', state: 'prepared-input', repositories: [{ name: 'sample', commit: 'a'.repeat(40) }] }, unitVersion: '1', inputDigest: 'b'.repeat(64), prerequisites: [], gaps: [], procedures: [{ id: 'inspect', title: 'Inspect', goal: 'Read status', role: 'Operator', prerequisites: [], steps: [{ id: 'status', title: 'Read status', cwd: '.', environment: 'isolated', inputs: [], instruction: { kind: 'command', content: 'example status' }, expected: { status: 0, observation: 'ready' }, grounds: [{ repository: 'sample', commit: 'a'.repeat(40), path: 'docs/start.md', line: 1, endLine: 2 }] }] }] };
}
function validation(guide: GuideDocument): GuideValidationHost {
  return { file: FILE, expectedContext: guide.context, expectedInputDigest: guide.inputDigest, expectedUnitVersion: guide.unitVersion, containsSecret: (text) => text.includes('private-value'), verifyStep: async () => [] };
}
function receipt(guide: GuideDocument): GuideReceipt {
  const procedure = guide.procedures[0]!; const step = procedure.steps[0]!;
  return { schema: GUIDE_RECEIPT_SCHEMA, guide: guide.id, procedure: procedure.id, step: step.id, context: guide.context, unitVersion: guide.unitVersion, inputDigest: guide.inputDigest, commandDigest: guideStepDigest(guide, procedure.id, step), environment: step.environment, prerequisitesDigest: guideDigest({ guide: guide.prerequisites, procedure: procedure.prerequisites }), cwd: step.cwd, at: '2026-01-03T00:00:00Z', evidence: 'docs/guide-walks/run/step.json', actualStatus: 0, observed: 'ready' };
}
async function checked(guide: GuideDocument): Promise<GuideDocument> {
  const result = await validateGuide(guide, validation(guide));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.guide;
}

describe('fresh guide read assembly', () => {
  test('one checked object serves JSON and Markdown and evidence is reloaded every read', async () => {
    const guide = await checked(example()); const source = renderGuideArtifact(guide); const r = receipt(guide);
    let admitted = false; let reads = 0;
    const host: GuideHost = { validation: validation(guide), execution: { file: FILE, containsSecret: validation(guide).containsSecret, verifyExecution: async () => admitted ? { kind: 'verified', observationMatches: true } : { kind: 'unverified', reason: 'not admitted' } }, readReceipts: async () => { reads += 1; return { receipts: [r], diagnostics: [] }; } };
    const before = await readGuidePage({ file: FILE, source, kind: guide.kind, host });
    expect(before.ok && before.data.walk.status).toBe('not-walked');
    admitted = true;
    const after = await readGuidePage({ file: FILE, source, kind: guide.kind, host });
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('missing read');
    expect(after.data.walk.status).toBe('passed');
    const projected = guidePageMarkdown({ blocks: [{ type: 'guide', data: after.data }] });
    expect(projected.ok && projected.markdown).toBe(after.data.markdown);
    expect(JSON.parse(JSON.stringify(after.data)).walk.status).toBe('passed');
    expect(after.data.grounds[0]?.commit).toBe('a'.repeat(40));
    expect(after.data.grounds[0]?.href).toBe('/k/src?repo=sample&path=docs%2Fstart.md&line=1');
    expect(after.data.markdown.startsWith('---')).toBe(false);
    expect(after.data.markdown).toContain('](/k/src?repo=sample&path=docs%2Fstart.md&line=1)');
    admitted = false;
    const revoked = await readGuidePage({ file: FILE, source, kind: guide.kind, host });
    expect(revoked.ok && revoked.data.walk.status).toBe('not-walked');
    expect(reads).toBe(3);
    expect(source).toContain('Not walked');
  });

  test('authentic wrong observation is failed, unknown authority never passes, environment is bound', async () => {
    const guide = await checked(example()); const r = receipt(guide);
    const base = { file: FILE, containsSecret: validation(guide).containsSecret };
    expect((await guideWalkStatus(guide, [r], { ...base, verifyExecution: async () => ({ kind: 'verified', observationMatches: false }) })).status).toBe('failed');
    expect((await guideWalkStatus(guide, [r], { ...base, verifyExecution: async () => ({ kind: 'unverified', reason: 'unknown authority' }) })).status).toBe('not-walked');
    expect((await guideWalkStatus(guide, [{ ...r, environment: 'other' }], { ...base, verifyExecution: async () => ({ kind: 'verified', observationMatches: true }) })).status).toBe('not-walked');
  });

  test('receipt read failure preserves all diagnostics and cannot expose passed state', async () => {
    const guide = await checked(example()); const source = renderGuideArtifact(guide);
    const diagnostic = { file: '/product/docs/guide-walks/run.json', line: 7, path: '$.observed', code: 'invalid-evidence', message: '/product/docs/guide-walks/run.json:7: $.observed: invalid evidence' };
    const host: GuideHost = { validation: validation(guide), execution: { file: FILE, containsSecret: validation(guide).containsSecret, verifyExecution: async () => ({ kind: 'verified', observationMatches: true }) }, readReceipts: async () => ({ receipts: [receipt(guide)], diagnostics: [diagnostic] }) };
    const result = await readGuidePage({ file: FILE, source, kind: guide.kind, host });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('missing read');
    expect(result.data.walk.status).toBe('not-walked');
    expect(result.diagnostics).toContainEqual(diagnostic);
    expect(guidePageMarkdown({ blocks: [{ type: 'guide', data: result.data }, { type: 'problem' }] }).ok).toBe(false);
  });
  test('only the actual host product pin opens a current product view with a visible warning', async () => {
    const raw = example();
    const productGuide = { ...raw, context: { ...raw.context, repositories: [{ name: 'product', commit: 'a'.repeat(40) }] }, procedures: raw.procedures.map((procedure) => ({ ...procedure, steps: procedure.steps.map((step) => ({ ...step, grounds: step.grounds.map((ground) => ({ ...ground, repository: 'product' })) })) })) };
    const guide = await checked(productGuide);
    const host: GuideHost = { productRepositoryId: 'product', validation: validation(guide), execution: { file: FILE, containsSecret: validation(guide).containsSecret, verifyExecution: async () => ({ kind: 'unverified', reason: 'not admitted' }) }, readReceipts: async () => ({ receipts: [], diagnostics: [] }) };
    const result = await readGuidePage({ file: FILE, source: renderGuideArtifact(guide), kind: guide.kind, host });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('missing read');
    expect(result.data.grounds[0]?.href).toBe('/k/src?path=docs%2Fstart.md&line=1');
    expect(result.data.sourceViewWarning).toContain('not an immutable snapshot');
    expect(result.data.markdown).toContain('not an immutable snapshot');
    const noTypedProduct = await readGuidePage({ file: FILE, source: renderGuideArtifact(guide), kind: guide.kind, host: { ...host, productRepositoryId: undefined } });
    expect(noTypedProduct.ok && noTypedProduct.data.grounds[0]?.href).toContain('repo=product');
  });

});
