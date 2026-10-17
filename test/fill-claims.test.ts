import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StructuralIndexResult } from '../src/product/fill-index.js';
import { anchoredFactsFromIndex, assembleClaims, createClaimSources, loadClaimsPrompt, parseFillKinds, persistClaimsOutput, persistTrainingScore, readPinnedGitHistory, recordUnattemptedLinks, renderClaimMarkdown, scoreTrainingExtraction, type ClaimsExtraction, type ExtractionMaterial } from '../src/product/fill-claims.js';

const registry = `contract: 1
stages:
  - id: build
    labels:
      en: Build
      ru: Build
kinds:
  - name: service
    labels:
      en: Service
      ru: Service
    prefix: SVC
    folder: docs/services
    stage: build
    hint: identify a running service
  - name: rule
    labels:
      en: Rule
      ru: Rule
    prefix: RUL
    folder: docs/rules
    stage: build
    hint: identify a business rule
`;
const materials: ExtractionMaterial[] = [
  { path: 'README.md', text: '# Guide\nSee https://example.test/public and https://example.test/login.\n', type: 'document' },
  { path: 'src/service.ts', text: 'export const service = true;\n', type: 'code' },
];
const stamp = '2026-10-17T12:00:00.000Z';

describe('registry-driven claims and provenance', () => {
  test('reads kinds and hints from the registry, and names invalid contract errors', () => {
    expect(parseFillKinds(registry).map(({ name, hint }) => [name, hint])).toEqual([['rule', 'identify a business rule'], ['service', 'identify a running service']]);
    expect(() => parseFillKinds('contract: 1\nstages: []\nkinds: []\n')).toThrow(/docs\/kinds.yaml:/);
  });

  test('converts the landed structural index result anchors without losing blob and byte provenance', () => {
    const index: StructuralIndexResult = { repository: '/checkout', commit: 'abc123', contentHash: 'hash', files: [{ path: 'src/a.ts', blob: 'blob-id', language: 'typescript', bytes: 20, startLine: 1, endLine: 2, startByte: 0, endByte: 20, symbols: [{ path: 'src/a.ts', blob: 'blob-id', startLine: 2, endLine: 2, startByte: 4, endByte: 10, name: 'charge', kind: 'function_declaration', exported: true }], imports: [], entryPoints: [], callEdges: [], comments: [{ path: 'src/a.ts', blob: 'blob-id', startLine: 1, endLine: 1, startByte: 0, endByte: 3, text: '//x' }], taskKeys: [] }] } as const;
    const facts = anchoredFactsFromIndex(index, (item) => 'name' in item && item.name === 'charge' ? { kind: 'service', text: `Symbol ${item.name}` } : undefined);
    expect(facts).toEqual([{ kind: 'service', text: 'Symbol charge', path: 'src/a.ts', anchor: 'lines:2-2', blob: 'blob-id', startByte: 4, endByte: 10 }]);
  });

  test('loads extraction prompts as data files rather than inline agent strings', async () => {
    const prompt = await loadClaimsPrompt('repository-claims');
    expect(prompt).toContain('assumed-meaning');
    expect(prompt).toContain('source id');
    expect(await loadClaimsPrompt('registry-kinds')).toContain('hint');
  });

  test('builds immutable source hashes, git version and line anchors', () => {
    const sources = createClaimSources('abc123', materials, stamp);
    expect(sources.map(({ address, version, anchor, readAt }) => ({ address, version, anchor, readAt }))).toEqual([
      { address: 'README.md', version: 'abc123', anchor: 'lines:1-2', readAt: stamp },
      { address: 'src/service.ts', version: 'abc123', anchor: 'lines:1-1', readAt: stamp },
    ]);
    expect(sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
    expect(() => createClaimSources('abc', [{ path: '../secret', text: 'x', type: 'code' }], stamp)).toThrow(/Invalid repository source path/);
    expect(() => createClaimSources('abc', materials, 'not-utc')).toThrow(/UTC ISO/);
  });

  test('requires known kinds and source-backed claims, marks assumed meaning unverified and asks about absent kinds', () => {
    const sources = createClaimSources('abc123', materials.map((material) => ({ ...material, ...(material.path === 'src/service.ts' ? { blob: 'blob-id' } : {}) })), stamp);
    const result = assembleClaims({ runId: 'run-1', unitId: 'claims-1', kinds: parseFillKinds(registry), sources, agentClaims: [
      { kind: 'service', text: 'A service runs.', layer: 'fact', confidence: 0.9, sourceIds: [sources.find((s) => s.address === 'src/service.ts')!.id] },
      { kind: 'service', text: 'This service supports checkout.', layer: 'assumed-meaning', confidence: 0.4, sourceIds: [sources.find((s) => s.address === 'src/service.ts')!.id] },
    ] });
    expect(result.claims).toHaveLength(2);
    expect(result.claims.find((claim) => claim.layer === 'assumed-meaning')?.verification).toBe('unverified');
    expect(result.claims.every((claim) => claim.sourceIds.length > 0 && claim.unitId === 'claims-1')).toBe(true);
    expect(result.questions).toEqual([{ id: expect.stringMatching(/^q-/), type: 'unverifiable', kind: 'rule', reason: 'No supported entity was found. Registry hint: identify a business rule' }]);
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources, agentClaims: [], anchoredFacts: [{ kind: 'service', text: 'fake', path: 'src/service.ts', anchor: 'lines:999-999', blob: 'blob-id', startByte: 999, endByte: 1000 }], sourceTexts: { [sources.find((item) => item.address === 'src/service.ts')!.id]: materials.find((item) => item.path === 'src/service.ts')!.text } })).toThrow(/source anchor|byte range/);
    const indexed = { kind: 'service', text: 'real', path: 'src/service.ts', anchor: 'lines:1-1', blob: 'wrong-blob', startByte: 0, endByte: 1 };
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources, agentClaims: [], anchoredFacts: [indexed], sourceTexts: { [sources.find((item) => item.address === 'src/service.ts')!.id]: materials.find((item) => item.path === 'src/service.ts')!.text } })).toThrow(/blob or byte range/);
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources, agentClaims: [], anchoredFacts: [{ ...indexed, blob: 'blob-id', startByte: 0, endByte: 100 }], sourceTexts: { [sources.find((item) => item.address === 'src/service.ts')!.id]: materials.find((item) => item.path === 'src/service.ts')!.text } })).toThrow(/blob or byte range/);
    const twoLineMaterial = { path: 'src/two.ts', text: 'first\nsecond\n', type: 'code' as const, blob: 'two-blob' };
    const twoLineSource = createClaimSources('abc123', [twoLineMaterial], stamp);
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources: twoLineSource, agentClaims: [], anchoredFacts: [{ kind: 'service', text: 'second', path: 'src/two.ts', anchor: 'lines:2-2', blob: 'two-blob', startByte: 0, endByte: 1 }], sourceTexts: { [twoLineSource[0]!.id]: twoLineMaterial.text } })).toThrow(/byte range does not match line anchor/);
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources, agentClaims: [{ kind: 'unknown', text: 'x', layer: 'fact', confidence: 1, sourceIds: [sources[0]!.id] }] })).toThrow(/Unknown registry kind/);
    expect(() => assembleClaims({ runId: 'r', unitId: 'u', kinds: parseFillKinds(registry), sources, agentClaims: [{ kind: 'service', text: 'x', layer: 'fact', confidence: 1, sourceIds: [] }] })).toThrow(/missing or unknown source/);
  });

  test('renders visible Unverified badge and source anchors, and persists claim/source JSON atomically', async () => {
    const sources = createClaimSources('abc123', materials, stamp);
    const source = sources.find((item) => item.address === 'README.md')!;
    const claim = { id: 'claim-1', kind: 'service', text: 'Maybe *important*.', layer: 'assumed-meaning' as const, confidence: 0.5, unitId: 'u-1', sourceIds: [source.id], verification: 'unverified' as const };
    expect(renderClaimMarkdown(claim, sources)).toContain('**Unverified**');
    expect(renderClaimMarkdown(claim, sources)).toContain('README.md#lines%3A1-2');
    const special = createClaimSources('abc123', [{ path: 'docs/a#b.md', text: 'x', type: 'document' }], stamp);
    expect(renderClaimMarkdown({ ...claim, sourceIds: [special[0]!.id] }, special)).toContain('docs/a%23b.md#lines%3A1-1');
    const parens = createClaimSources('abc123', [{ path: 'docs/a(b).md', text: 'x', type: 'document' }], stamp);
    expect(renderClaimMarkdown({ ...claim, sourceIds: [parens[0]!.id] }, parens)).toContain('docs/a%28b%29.md#lines%3A1-1');
    const bracket = createClaimSources('abc123', [{ path: 'docs/a]b.md', text: 'x', type: 'document' }], stamp);
    expect(renderClaimMarkdown({ ...claim, sourceIds: [bracket[0]!.id] }, bracket)).toContain('docs/a\\]b.md#lines:1-1');
    const markupPath = createClaimSources('abc123', [{ path: 'docs/<em>`note`</em>.md', text: 'x', type: 'document' }], stamp);
    const renderedMarkupPath = renderClaimMarkdown({ ...claim, sourceIds: [markupPath[0]!.id] }, markupPath);
    expect(renderedMarkupPath).toContain('docs/&lt;em&gt;\\`note\\`&lt;/em&gt;.md');
    const newlinePath = createClaimSources('abc123', [{ path: 'docs/a\nb.md', text: 'x', type: 'document' }], stamp);
    const newlineLabel = renderClaimMarkdown({ ...claim, sourceIds: [newlinePath[0]!.id], text: 'claim\n- injected' }, newlinePath);
    expect(newlineLabel).not.toContain('claim\n- injected');
    expect(newlineLabel).toContain('docs/a b.md');
    const dir = await mkdtemp(join(tmpdir(), 'madarch-claims-output-'));
    try {
      const extraction: ClaimsExtraction = { claims: [claim], sources, questions: [], inaccessibleLinks: [], usage: { elapsedMs: 4, inputTokens: 5, outputTokens: 6 } };
      await persistClaimsOutput(dir, extraction);
      expect(JSON.parse(await readFile(join(dir, 'claims.json'), 'utf8'))).toEqual([claim]);
      expect(JSON.parse(await readFile(join(dir, 'sources.json'), 'utf8'))).toEqual(sources);
      await expect(persistClaimsOutput(dir, { ...extraction, claims: [{ ...claim, sourceIds: ['missing'] }] })).rejects.toThrow(/source missing/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('records URL references without network fetch and ties them to source records', () => {
    const sources = createClaimSources('abc123', materials, stamp);
    expect(recordUnattemptedLinks(materials, sources)).toEqual([
      { url: 'https://example.test/login', status: 'not-attempted', sourceId: sources.find((s) => s.address === 'README.md')!.id },
      { url: 'https://example.test/public', status: 'not-attempted', sourceId: sources.find((s) => s.address === 'README.md')!.id },
    ]);
  });

  test('scores found, missed and invented claims deterministically without placing key in generated repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-claims-'));
    try {
      const generated = join(dir, 'generated'), privateData = join(dir, 'training-data');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(generated));
      const keyPath = join(privateData, 'answer-key.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(privateData));
      await writeFile(keyPath, JSON.stringify({ entities: [{ id: 'checkout' }], businessRules: [], stateMachine: { states: [], transitions: [] }, interactions: [], contradictions: [], undocumentedBehaviour: [], intentEvidence: [], terms: [] }));
      const extraction: ClaimsExtraction = { claims: [
        { id: '1', kind: 'service', text: 'entity checkout', layer: 'fact', confidence: 1, unitId: 'u', sourceIds: ['s'], verification: 'verified' },
        { id: '2', kind: 'service', text: 'unsupported extra', layer: 'assumed-meaning', confidence: 0.2, unitId: 'u', sourceIds: ['s'], verification: 'unverified' },
      ], sources: [], questions: [], inaccessibleLinks: [], usage: { elapsedMs: 7, inputTokens: 11, outputTokens: 13 } };
      const score = await scoreTrainingExtraction({ extraction, answerKeyPath: keyPath, generatedRepo: generated });
      expect(score.counts).toEqual({ expected: 1, found: 1, missed: 0, invented: 1 });
      expect(score.unitUsage).toEqual(extraction.usage);
      await expect(scoreTrainingExtraction({ extraction, answerKeyPath: join(generated, 'answer-key.json'), generatedRepo: generated })).rejects.toThrow(/outside the generated repository/);
      expect(await readFile(keyPath, 'utf8')).toContain('checkout');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('counts answer-key targets only when the claim text and cited source path support them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-score-grounding-'));
    try {
      const generated = join(dir, 'generated'), data = join(dir, 'data');
      const fs = await import('node:fs/promises'); await fs.mkdir(generated); await fs.mkdir(data);
      const keyPath = join(data, 'answer-key.json');
      await writeFile(keyPath, JSON.stringify({ entities: [{ id: 'orders', name: 'Orders service', file: 'services/orders.go', symbol: 'OrderService' }], businessRules: [], stateMachine: { file: 'services/orders.go', states: [], transitions: [] }, interactions: [], contradictions: [], undocumentedBehaviour: [], intentEvidence: [], terms: [] }));
      const source = { id: 'source-1', address: 'services/orders.go', version: 'abc', anchor: 'lines:1-3', readAt: stamp, sha256: '0'.repeat(64), mediaType: 'text/plain', byteLength: 30, blob: 'blob-id', type: 'code' as const };
      const extraction: ClaimsExtraction = { claims: [
        { id: 'supported', kind: 'service', text: 'Orders service provides order handling.', layer: 'fact', confidence: 1, unitId: 'u', sourceIds: [source.id], verification: 'verified' },
        { id: 'invented', kind: 'service', text: 'A mythical billing service exists.', layer: 'fact', confidence: 1, unitId: 'u', sourceIds: [source.id], verification: 'verified' },
      ], sources: [source], questions: [], inaccessibleLinks: [], usage: { elapsedMs: 1, inputTokens: 2, outputTokens: 3 } };
      const score = await scoreTrainingExtraction({ extraction, answerKeyPath: keyPath, generatedRepo: generated });
      expect(score.counts).toEqual({ expected: 1, found: 1, missed: 0, invented: 1 });
      expect(score.found).toEqual(['entity orders']);
      expect(score.invented).toEqual(['a mythical billing service exists']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('reads commit history from the pinned revision and persists a deterministic checkpoint record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-fill-history-'));
    try {
      const { execFileSync } = await import('node:child_process');
      const repo = join(dir, 'repo'); const fs = await import('node:fs/promises'); await fs.mkdir(repo);
      execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']); execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.test']);
      await writeFile(join(repo, 'README.md'), 'Pinned content\n'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '-m', 'TASK-1 add docs']);
      const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const history = readPinnedGitHistory(repo, commit);
      expect(history.type).toBe('git-history'); expect(history.path).toBe('git:history'); expect(history.text).toContain('TASK-1 add docs');
      const score = { found: ['entity:service'], missed: [], invented: [], counts: { expected: 1, found: 1, missed: 0, invented: 0 }, unitUsage: { elapsedMs: 9, inputTokens: 4, outputTokens: 3 } };
      const output = join(dir, 'checkpoint.json'); await persistTrainingScore(output, score);
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(score);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

});
