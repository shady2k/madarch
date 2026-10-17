import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySynthesisPages, buildCodeMap, codeMapUnitPlan, loadSynthesisPrompt, persistCodeMap, synthesisUnitPlans, synthesizePages, type CodeMap, type SynthesisClaim } from '../src/product/fill-synthesis.js';
import type { RegistryKind } from '../src/product/contract.js';
import type { StructuralIndexResult } from '../src/product/fill-index.js';
import type { ClaimSource } from '../src/product/fill-claims.js';

const kinds: RegistryKind[] = [
  { name: 'Components', prefix: 'CMP', folder: 'docs/components', stage: 'design', hint: 'describe components' },
  { name: 'Overview', prefix: 'OV', folder: 'docs/overview', stage: 'idea', hint: 'explain this product' },
];
const sources: ClaimSource[] = [
  { id: 'src-code', address: 'src/order.ts', version: 'commit-1', anchor: 'lines:1-4', readAt: '2026-10-17T00:00:00.000Z', sha256: 'hash', mediaType: 'text/typescript', byteLength: 50, blob: 'blob-1', type: 'code' },
  { id: 'src-doc', address: 'README.md', version: 'commit-1', anchor: 'lines:1-2', readAt: '2026-10-17T00:00:00.000Z', sha256: 'hash2', mediaType: 'text/markdown', byteLength: 20, type: 'document' },
];
const claims: SynthesisClaim[] = [
  { id: 'claim-fact', kind: 'Overview', text: 'Orders are validated before payment.', layer: 'fact', confidence: 1, unitId: 'claims-1', sourceIds: ['src-code'], verification: 'verified' },
  { id: 'claim-assumption', kind: 'Components', text: 'This flow may reduce failed orders.', layer: 'assumed-meaning', confidence: 0.4, unitId: 'claims-1', sourceIds: ['src-doc'], verification: 'unverified' },
];
const index: StructuralIndexResult = { repository: '/code', commit: 'commit-1', contentHash: 'idx-hash', files: [{ path: 'src/order.ts', blob: 'blob-1', language: 'typescript', bytes: 50, startLine: 1, endLine: 4, startByte: 0, endByte: 50,
  symbols: [{ path: 'src/order.ts', blob: 'blob-1', startLine: 1, endLine: 2, startByte: 0, endByte: 24, name: 'placeOrder', kind: 'function_declaration', exported: true }],
  imports: [{ path: 'src/order.ts', blob: 'blob-1', startLine: 1, endLine: 1, startByte: 0, endByte: 10, source: 'src/order.ts', target: './payment', kind: 'import' }], entryPoints: ['placeOrder'],
  callEdges: [{ path: 'src/order.ts', blob: 'blob-1', startLine: 3, endLine: 3, startByte: 28, endByte: 40, source: 'src/order.ts', target: 'charge', kind: 'call' }],
  comments: [{ path: 'src/order.ts', blob: 'blob-1', startLine: 4, endLine: 4, startByte: 41, endByte: 49, text: '// state transition from pending to paid; must pay' }], taskKeys: [] }] };

describe('fill code map and synthesis', () => {
  test('prompts are data files', async () => {
    expect(await loadSynthesisPrompt('page-critic')).toContain('source-backed');
    expect(await loadSynthesisPrompt('page-synthesis')).toContain('unverified');
  });
  test('builds deterministic sourced bottom-up components, interactions and rules', () => {
    const first = buildCodeMap(index, sources);
    expect(buildCodeMap(index, sources)).toEqual(first);
    expect(first.components[0]?.text).toBe('Exported function declaration placeOrder');
    expect(first.components[0]?.relations.map((relation) => relation.type)).toEqual(['entry-point']);
    expect(first.components[0]?.relations.some((relation) => relation.target === 'charge')).toBe(false);
    expect(first.interactions.map((fact) => fact.text)).toEqual(['src/order.ts imports ./payment', 'src/order.ts calls charge']);
    expect(first.businessRules.some((fact) => fact.text.includes('must pay'))).toBe(true);
    expect(first.stateTransitions.some((fact) => fact.text.includes('pending to paid'))).toBe(true);
    expect(first.interactions.some((fact) => fact.kind === 'import')).toBe(true);
    expect(first.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => buildCodeMap(index, [])).toThrow(/index\/source mismatch/);
  });
  test('declares deterministic runtime plans that include all upstream and registry inputs', async () => {
    expect(codeMapUnitPlan('i')).toEqual({ id: 'code-map-repository', stage: 'code-map', inputHashes: { index: 'i' }, outputPaths: ['.madarch/fill/outputs/code-map-repository/code-map.json'], dependencies: [] });
    const plans = synthesisUnitPlans(kinds, 'map-hash', 'claims-hash', 'registry-hash');
    expect(plans.map((plan) => plan.id)).toEqual(['synthesis-a150ce2216025931', 'synthesis-d4b1ea5708dd5329']);
    expect(plans.every((plan) => plan.inputHashes.codeMap === 'map-hash' && plan.dependencies?.includes('code-map-repository'))).toBe(true);
  });
  test('writes code map beneath explicit output directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'madarch-code-map-'));
    try {
      const file = await persistCodeMap(dir, buildCodeMap(index, sources));
      expect(JSON.parse(await readFile(file, 'utf8')).commit).toBe('commit-1');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test('overview is first, registry kinds follow in registry order, source claims stay separated', async () => {
    const order: string[] = [];
    const componentClaim = { ...claims[0]!, id: 'component-claim', kind: 'Components', text: 'A component handles orders.' };
    const allClaims = [...claims, componentClaim];
    const pages = await synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'explain this product' }, kinds: [kinds[0]!], codeMap: buildCodeMap(index, sources), claims: allClaims, sources,
      generate: async ({ target, pass, priorDraft }) => { order.push(`${target.name}:${pass}`); if (pass === 1 && target.name === 'Overview') return { title: 'Product', body: 'An overview.', claims, segments: [{ text: 'Orders are validated before payment.', sourceIds: ['src-code'], layer: 'fact' }] };
        return { title: target.name, body: priorDraft ? `${priorDraft} revised` : 'Body.', claims: target.name === 'Overview' ? claims : [componentClaim], segments: target.name === 'Overview' ? [{ text: 'Orders are validated before payment.', sourceIds: ['src-code'], layer: 'fact' }] : [{ text: 'A component handles orders.', sourceIds: ['src-code'], layer: 'fact' }] }; },
      critique: (_page, pass) => pass === 1 ? { findings: ['Add supporting detail'] } : { findings: [] },
    });
    expect(pages.map((page) => page.kind)).toEqual(['Overview', 'Components']);
    expect(order).toEqual(['Overview:1', 'Overview:2', 'Components:1', 'Components:2']);
    expect(pages[0]?.critic).toEqual({ passes: 2, findings: [] });
    expect(pages[0]?.unverified).toBe(true);
    expect(pages[0]?.sourceIds).toEqual(['src-code', 'src-doc']);
    expect(pages[1]?.claims).toEqual([componentClaim]);
  });
  test('requires evidence-backed prose and supplies an absence question for empty registered kinds', async () => {
    const noClaims = async () => ({ title: 'Components', body: 'Invented behavior.', claims: [], segments: [{ text: 'Invented behavior.', sourceIds: ['src-code'], layer: 'fact' as const }] });
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [kinds[0]!], codeMap: buildCodeMap(index, sources), claims: [], sources, generate: noClaims, critique: () => ({ findings: [] }) })).rejects.toThrow(/missing a source|unsupported source attribution/);
    const noContent = async ({ target }: { target: { name: string } }) => ({ title: target.name, body: 'None found.', claims: [], segments: [] });
    const question = { id: 'q-components', type: 'unverifiable', reason: 'No component entity was found. Registry hint: describe components', kind: 'Components' };
    const overviewClaim = { ...claims[0]!, kind: 'Overview' };
    const result = await synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [kinds[0]!], codeMap: buildCodeMap(index, sources), claims: [overviewClaim], sources, generate: async ({ target }) => target.name === 'Overview' ? { title: 'Overview', body: 'Orders are validated before payment.', claims: [overviewClaim], segments: [{ text: 'Orders are validated before payment.', sourceIds: ['src-code'], layer: 'fact' as const }] } : { title: 'Components', body: 'No entities.', claims: [], segments: [] }, critique: () => ({ findings: [] }) });
    expect(result[1]?.questions).toEqual([{ id: expect.stringMatching(/^q-/), type: 'unverifiable', kind: 'Components', reason: 'No supported entity was found. Registry hint: describe components' }]);
    expect(result[1]?.body).toContain('No supported entity was found. Registry hint: describe components');
  });
  test('stops after bounded critic passes and refuses source-less or unknown citations', async () => {
    const generate = async () => ({ title: 'x', body: 'y', claims, segments: [{ text: 'Orders are validated before payment.', sourceIds: ['src-code'], layer: 'fact' as const }] });
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'explain this product' }, kinds: [], codeMap: buildCodeMap(index, sources), claims, sources, generate,
      critique: () => ({ findings: ['Unsupported claim'] }), maxRevisions: 1 })).rejects.toThrow(/after 2 bounded passes/);
    const invalid = [{ ...claims[0]!, sourceIds: ['missing'] }];
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'explain this product' }, kinds: [], codeMap: buildCodeMap(index, sources), claims: invalid, sources, generate,
      critique: () => ({ findings: [] }) })).rejects.toThrow(/unknown source/);
  });
  test('rejects generated claims that invent or alter source-backed input records', async () => {
    const generated = async () => ({ title: 'Product', body: 'A claim.', claims: [{ ...claims[0]!, text: 'Invented alternate text' }], segments: [{ text: 'Orders are validated.', sourceIds: ['src-code'], layer: 'fact' as const }] });
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'explain this product' }, kinds: [], codeMap: buildCodeMap(index, sources), claims, sources, generate: generated, critique: () => ({ findings: [] }) })).rejects.toThrow(/unsupported or altered claim/);
  });
  test('rejects unsafe source ids before composing source-card paths', async () => {
    const unsafe = [{ ...sources[0]!, id: '../outside' }];
    expect(() => buildCodeMap(index, unsafe)).toThrow(/Unsafe claim source id/);
    const claim = { ...claims[0]!, sourceIds: ['../outside'] };
    const generated = async () => ({ title: 'T', body: 'x', claims: [claim], segments: [{ text: claim.text, sourceIds: claim.sourceIds, layer: 'fact' as const }] });
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [], codeMap: buildCodeMap(index, sources), claims: [claim], sources: unsafe, generate: generated, critique: () => ({ findings: [] }) })).rejects.toThrow(/Unsafe claim source id/);
  });
  test('controlled apply writes only into distinct agent worktree and never overwrites authored pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'madarch-synthesis-'));
    const agent = join(root, 'agent'); const code = join(root, 'source');
    await mkdir(agent); await mkdir(code);
    for (const dir of [agent, code]) { execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir }); }
    execFileSync('git', ['checkout', '-qb', 'madarch/fill/run-1'], { cwd: agent });
    const page = { path: 'docs/overview/index.md', title: 'Product', kind: 'Overview', body: 'The service runs.', segments: [{ text: 'Orders are validated before payment.', sourceIds: ['src-code'], layer: 'fact' as const }], questions: [], claims, sourceIds: ['src-code', 'src-doc'], unverified: true, critic: { passes: 1, findings: [] } };
    try {
      const result = await applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-1', pages: [page], sources });
      expect(result).toContain(join(agent, page.path.replace(/\.md$/i, '.proposed.md')));
      expect(result).toContain(join(agent, 'docs/fill-sources/src-code.md'));
      const markdown = await readFile(join(agent, page.path.replace(/\.md$/i, '.proposed.md')), 'utf8');
      expect(markdown).toContain('Unverified');
      expect(await readFile(join(agent, 'docs/fill-sources/src-code.md'), 'utf8')).toContain('Version: `commit-1`');
      expect(markdown).toContain('../fill-sources/src-code.md');
      expect(await readFile(join(code, 'docs/overview/overview.md')).catch(() => '')).toBe('');
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-1', pages: [page], sources })).rejects.toThrow(/overwrite existing proposal/);
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/other-run', pages: [page], sources })).rejects.toThrow(/branch mismatch/);
      await writeFile(join(agent, 'docs/overview/outside-link.md'), 'authored');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test('refuses symlink escape and traversal paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'madarch-synthesis-safe-'));
    const agent = join(root, 'agent'); const code = join(root, 'source'); const outside = join(root, 'outside');
    await mkdir(agent); await mkdir(code); await mkdir(outside); await mkdir(join(agent, 'docs'));
    for (const dir of [agent, code]) { execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir }); }
    execFileSync('git', ['checkout', '-qb', 'madarch/fill/run-1'], { cwd: agent });
    try {
      await (await import('node:fs/promises')).symlink(outside, join(agent, 'docs', 'linked'));
      const base = { title: 'T', kind: 'Overview', body: 'Body', segments: [], questions: [], claims: [], sourceIds: [], unverified: false, critic: { passes: 1, findings: [] } };
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-1', pages: [{ ...base, path: 'docs/rejected.md', body: 'Invented behavior.', critic: { passes: 1, findings: ['Unsupported'] } }], sources })).rejects.toThrow(/has not passed its critic/);
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-1', pages: [{ ...base, path: 'docs/../outside.md' }], sources })).rejects.toThrow(/path outside docs/);
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-1', pages: [{ ...base, path: 'docs/linked/page.md', questions: [{ id: 'q', kind: 'Overview', type: 'unverifiable', reason: 'No entity found' }] }], sources })).rejects.toThrow(/symlink outside/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('a segment may paraphrase when it names the supplied claims it rests on', async () => {
    const page = await synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [], codeMap: buildCodeMap(index, sources), claims, sources,
      generate: async ({ target }) => ({ title: 'Overview', body: '', claims: [claims[0]!], segments: [{ text: 'The product validates each order before payment is taken.', sourceIds: ['src-code'], layer: 'fact' as const, claimIds: ['claim-fact'] }] }),
      critique: () => ({ findings: [] }) });
    expect(page[0]!.segments[0]!.claimIds).toEqual(['claim-fact']);
    expect(page[0]!.body).toBe('The product validates each order before payment is taken.');
  });
  test('a paraphrase still refuses invented or foreign claims and uncovered sources', async () => {
    const generate = (claimIds: string[], sourceIds: string[]) => async () => ({ title: 'T', body: 'x', claims: [claims[0]!], segments: [{ text: 'prose', sourceIds, layer: 'fact' as const, claimIds }] });
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [], codeMap: buildCodeMap(index, sources), claims, sources, generate: generate(['claim-foreign'], ['src-code']), critique: () => ({ findings: [] }) })).rejects.toThrow(/names claim claim-foreign that is not one of the selected claim records/);
    await expect(synthesizePages({ overview: { name: 'Overview', folder: 'docs/overview', hint: 'overview' }, kinds: [], codeMap: buildCodeMap(index, sources), claims, sources, generate: generate(['claim-fact'], ['src-doc']), critique: () => ({ findings: [] }) })).rejects.toThrow(/cited source "src-doc" is not covered by the named claims/);
  });
  test('the controlled apply path accepts named-claim paraphrase and rejects it when a claim is foreign', async () => {
    const root = await mkdtemp(join(tmpdir(), 'madarch-synthesis-paraphrase-'));
    const agent = join(root, 'agent'); const code = join(root, 'source');
    await mkdir(agent); await mkdir(code);
    for (const dir of [agent, code]) { execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: dir }); }
    execFileSync('git', ['checkout', '-qb', 'madarch/fill/run-2'], { cwd: agent });
    try {
      const paraphrased = { path: 'docs/overview/index.md', title: 'Product', kind: 'Overview', body: 'Orders go through validation first.', segments: [{ text: 'Orders go through validation first.', sourceIds: ['src-code'], layer: 'fact' as const, claimIds: ['claim-fact'] }], questions: [],
        claims, sourceIds: ['src-code', 'src-doc'], unverified: true, critic: { passes: 1, findings: [] } };
      const result = await applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-2', pages: [paraphrased], sources });
      const markdown = await readFile(String(result[0]), 'utf8');
      expect(markdown).toContain('Orders go through validation first.');
      expect(markdown).toContain('**Overview:** Orders are validated before payment.');
      const foreign = { ...paraphrased, segments: [{ ...paraphrased.segments[0]!, claimIds: ['claim-absent'] }] };
      await expect(applySynthesisPages({ agentWorktree: agent, sourceCheckout: code, expectedAgentBranch: 'madarch/fill/run-2', pages: [foreign], sources })).rejects.toThrow(/claim-absent/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
