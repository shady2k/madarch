import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './knowledge-fixture.js';
import { ONCE_QUESTIONS, EXPECTED_FIRST_QUESTIONS, onceFirstScript, onceRefillScript, onceRefreshScript, validateOnceKey } from './questions-once-script.js';
import { questionSlug } from './loop-agent-script.js';

const KEYS = ['open.access', 'open.assumption', 'open.behavior', 'open.contradiction', 'open.meaning', 'open.rationale', 'open.term', 'open.unverifiable'];
describe('questions-once reader fixture is bound to the actual answer key', () => {
  test('eight authored decisions are exactly the eight open.* key cases, not numeric padding', () => {
    const key = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8'));
    expect(key.items.filter((item: any) => item.id.startsWith('open.')).map((item: any) => item.id).sort()).toEqual(KEYS);
    expect(ONCE_QUESTIONS.map((question) => question.item).sort()).toEqual(KEYS);
    expect(EXPECTED_FIRST_QUESTIONS).toBe(8);
    expect(() => validateOnceKey()).not.toThrow();
    for (const language of ['en', 'ru'] as const) expect(new Set(ONCE_QUESTIONS.map((question) => questionSlug(question, language))).size).toBe(8);
  });
  test('every first-fill comparison explicitly covers all eight authored meanings; paraphrases span units', () => {
    const script = onceFirstScript();
    for (const language of ['en', 'ru'] as const) {
      const expected = ONCE_QUESTIONS.map((question) => question.text[language].question).sort();
      const selected = script.byPrompt.filter((entry) => entry.matches?.includes(language === 'en' ? 'Ordering is what' : 'Заказы:') || entry.matches?.includes(language === 'en' ? 'Payments is what' : 'Платежи:'));
      expect(selected).toHaveLength(2);
      const asks = selected.flatMap((entry) => entry.steps).filter((step: any) => step.call?.tool === 'ask_question') as any[];
      expect(asks).toHaveLength(10); // eight distinct decisions + two paraphrases, never ten files
      for (const step of asks) {
        expect(step.call.compareQuestions.map((decision: any) => decision.question).sort()).toEqual(expected);
        expect(step.call.compareQuestions.filter((decision: any) => decision.same)).toHaveLength(1);
        expect(step.call.compareQuestions.every((decision: any) => decision.reason.trim().length > 0)).toBe(true);
      }
      expect(asks.filter((step) => step.call.compareQuestions.find((decision: any) => decision.same)?.question === ONCE_QUESTIONS[0]!.text[language].question)).toHaveLength(3);
    }
  });
  test('both units that reuse the open contradiction write each retained side with its sources', () => {
    const script = onceFirstScript();
    const decision = ONCE_QUESTIONS.find((question) => question.item === 'open.contradiction')!;
    for (const language of ['en', 'ru'] as const) {
      const selected = script.byPrompt.filter((entry) => entry.matches?.includes(language === 'en' ? 'Ordering is what' : 'Заказы:') || entry.matches?.includes(language === 'en' ? 'Payments is what' : 'Платежи:'));
      expect(selected).toHaveLength(2);
      for (const entry of selected) {
        const written = entry.steps.find((step: any) => step.call?.tool === 'write_page') as any;
        for (const claim of decision.text[language].claims) expect(written.call.arguments.markdown).toContain(claim);
        for (const ground of decision.sides.flat()) expect(written.call.arguments.markdown).toContain(`](madarch:${ground})`);
      }
    }
  });
  test('refresh and refill explicitly ask only the retained term answer and ground the payment statement', () => {
    for (const language of ['en', 'ru'] as const) for (const script of [onceRefreshScript(language), onceRefillScript(language)]) {
      const steps = script.byPrompt.flatMap((entry): any[] => entry.steps) as any[];
      const asks = steps.filter((step) => step.call?.tool === 'ask_question');
      expect(asks).toHaveLength(1);
      const term = ONCE_QUESTIONS.find((question) => question.item === 'open.term')!;
      expect(asks[0].call.arguments.question).toBe(term.text[language].question);
      expect(steps.some((step) => step.call?.tool === 'write_page' && step.call.arguments.markdown.includes(`[^payment-token-means-cardtoken]: [the answer](madarch:question:${questionSlug(term, language)})`))).toBe(true);
    }
  });
});


import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Page } from 'puppeteer';
import { OnceEvidence, assertFindings, assertHashes, assertQuestionDOM, assertRouteIdentity, assertResolution, assertVisibility, deadline, hashFiles, ownedPIDs, resetMissingTargets, resetRepositoryDocument, assertResetStoreRemoved, type OwnedPID, type ShotPlan, type VisibilityMeasurement } from '../scripts/questions-once-evidence.js';
import { noEntityMessage } from '../src/knowledge/resolve.js';
import { readBody, splitFrontMatter } from '../src/knowledge/markdown.js';

describe('questions-once harness rejects incomplete evidence', () => {
  const plan = { store: ['/fixture/graph'], agentPages: ['docs/domains/payments.md'] };
  const removed = [{ file: 'docs/domains/payments.md', id: 'domain:payments' }];
  const good = (target: string, entity: string) => ({ state: 'ok', target: `madarch:${target}`, entity });
  const missing = (target: string, key = target) => ({ state: 'broken', target: `madarch:${target}`, why: { code: 'no-entity', key }, reason: noEntityMessage(key) });
  test('only pre-resolved retained targets removed by the exact reset may be missing, generic and detail alike', () => {
    const allowed = resetMissingTargets(plan, removed, {
      'madarch:code.file:src/pay.ts': good('code.file:src/pay.ts', 'code.file:src/pay.ts'),
      'domain:payments': good('domain:payments', 'domain:payments'),
      'doc:guide.md': good('doc:guide.md', 'document:guide'),
      'question:kept': good('question:kept', 'question:kept'),
    });
    expect(allowed).toEqual([{ target: 'madarch:code.file:src/pay.ts', key: 'code.file:src/pay.ts' }, { target: 'domain:payments', key: 'domain:payments' }]);
    expect(() => assertResolution('madarch:code.file:src/pay.ts', missing('code.file:src/pay.ts'), allowed)).not.toThrow();
    expect(() => assertResolution('domain:payments', missing('domain:payments'), allowed)).not.toThrow();
    for (const target of ['code.file:unknown.ts', 'doc:guide.md', 'question:kept', '']) expect(() => assertResolution(target, missing(target), allowed)).toThrow('unexpected missing');
    expect(() => assertResolution('domain:payments', { ...missing('domain:payments'), why: { code: 'no-document', path: 'payments' } }, allowed)).toThrow();
    expect(() => assertResolution('domain:payments', missing('domain:payments', 'domain:ordering'), allowed)).toThrow();
    expect(() => assertResolution('domain:payments', good('domain:payments', 'domain:payments'), allowed)).toThrow();
    expect(resetMissingTargets({ ...plan, store: [] }, removed, { 'code.file:src/pay.ts': good('code.file:src/pay.ts', 'code.file:src/pay.ts') })).toEqual([]);
    expect(() => resetMissingTargets(plan, [], {})).toThrow('exact agent-page plan');
    expect(() => resetMissingTargets(plan, removed, { 'domain:payments': missing('domain:payments') })).toThrow('pre-reset');
  });
  test('reset document proof allows a held repository symlink but refuses traversal and escaping file links, and every store path must be gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'questions-reset-source-'));
    try {
      const product = join(root, 'product'); const repository = join(root, 'held');
      mkdirSync(join(product, 'repos'), { recursive: true }); mkdirSync(join(repository, 'docs'), { recursive: true });
      writeFileSync(join(repository, 'docs/guide.md'), 'A held source.'); symlinkSync(repository, join(product, 'repos/training'));
      expect(resetRepositoryDocument(product, 'training', 'docs/guide.md').sha256).toBe(hashFiles([join(repository, 'docs/guide.md')])[0]!.sha256);
      writeFileSync(join(root, 'outside.md'), 'Outside.'); symlinkSync(join(root, 'outside.md'), join(repository, 'docs/escape.md'));
      expect(() => resetRepositoryDocument(product, 'training', 'docs/escape.md')).toThrow('outside');
      expect(() => resetRepositoryDocument(product, 'training', '../outside.md')).toThrow('invalid');
      expect(() => resetRepositoryDocument(product, '../held', 'docs/guide.md')).toThrow('invalid');
      const store = join(root, 'graph'); mkdirSync(store); expect(() => assertResetStoreRemoved([store])).toThrow('did not remove');
      rmSync(store, { recursive: true }); expect(() => assertResetStoreRemoved([store])).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('only pre-resolved repository documents with exact source proof become no-document after graph reset', () => {
    const target = 'madarch:doc:docs/architecture.md#flow';
    const value = { state: 'ok', target, kind: 'document', href: '/k/doc?repo=training&path=docs%2Farchitecture.md#flow' };
    const proof = { target, repo: 'training', path: 'docs/architecture.md', sha256: 'a'.repeat(64) };
    const allowed = resetMissingTargets(plan, removed, { [target]: value }, [proof]);
    const broken = { state: 'broken', target, why: { code: 'no-document', path: proof.path }, reason: `no document "${proof.path}" in the product repository or its code repositories` };
    expect(() => assertResolution(target, broken, allowed)).not.toThrow();
    for (const wrong of [{ ...proof, repo: 'other' }, { ...proof, path: 'docs/other.md' }, { ...proof, sha256: '' }]) expect(() => resetMissingTargets(plan, removed, { [target]: value }, [wrong])).toThrow();
    expect(resetMissingTargets({ ...plan, store: [] }, removed, { [target]: value }, [proof])).toEqual([]);
    expect(resetMissingTargets(plan, removed, { [target]: value })).toEqual([]);
    for (const wrong of [{ ...broken, reason: 'another reason' }, { ...broken, why: { code: 'no-document', path: 'docs/other.md' } }, { ...broken, why: { code: 'no-entity', key: proof.path } }]) expect(() => assertResolution(target, wrong, allowed)).toThrow();
    expect(() => assertResolution('madarch:doc:docs/unplanned.md', { ...broken, target: 'madarch:doc:docs/unplanned.md' }, allowed)).toThrow();
    const glossary = 'madarch:doc:docs/glossary.md#term';
    expect(resetMissingTargets(plan, removed, { [glossary]: { state: 'ok', target: glossary, kind: 'doc.term', href: '/k/e/doc%3A%40training%2Fdocs%2Fglossary.md%23term', entity: 'doc:@training/docs/glossary.md#term' } }, [{ ...proof, target: glossary, path: 'docs/glossary.md' }])).toEqual([{ target: glossary, key: 'docs/glossary.md', documentPath: 'docs/glossary.md' }]);
  });

  test('expected missing body findings match exact file, line, message and multiplicity', () => {
    const finding = { file: 'docs/questions/kept.md', line: 24, message: `a ground does not resolve: ${noEntityMessage('code.file:src/pay.ts')}` };
    expect(() => assertFindings([finding], [finding])).not.toThrow();
    expect(() => assertFindings([{ ...finding, line: 25 }], [finding])).toThrow();
    expect(() => assertFindings([{ ...finding, file: 'docs/questions/other.md' }], [finding])).toThrow();
    expect(() => assertFindings([finding, finding], [finding])).toThrow();
    expect(() => assertFindings([], [finding])).toThrow();
    expect(() => assertFindings([finding])).toThrow();
  });
  test('reset finding lines follow retained body offsets after metadata removal, without changing allowed targets', () => {
    const before = '---\nid: question:kept\nresolved-by: [domain:payments]\nresolved-at: yesterday\n---\nGround.[^one]\n\n[^one]: [file](madarch:code.file:src/pay.ts)\n';
    const after = before.replace('resolved-by: [domain:payments]\nresolved-at: yesterday\n', '');
    const links = (source: string) => { const body = splitFrontMatter(source); return readBody(body.body, 'docs/questions/kept.md', body.bodyLine).links; };
    expect(links(after)[0]!.url).toBe(links(before)[0]!.url);
    expect(links(after)[0]!.line).toBe(links(before)[0]!.line - 2);
  });
  test('HTTP deadline includes an indefinitely unfinished body and writes terminal incomplete evidence', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'questions-harness-http-'));
    const saved = globalThis.fetch; let aborted = false;
    try {
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        init.signal!.addEventListener('abort', () => { aborted = true; });
        return { status: 200, headers: new Headers(), arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) };
      }) as unknown as typeof fetch;
      const evidence = new OnceEvidence(folder, [], {});
      const began = performance.now();
      await expect(evidence.json('http://fixture.test/stalled', undefined, 20)).rejects.toThrow('finite HTTP body');
      expect(performance.now() - began).toBeLessThan(1000); expect(aborted).toBe(true);
      expect(evidence.finish(true)).toBe(false); // no immutable after-verification
      const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
      expect(result.complete).toBe(false); expect(result.inputsVerified).toBe(false);
      expect(readFileSync(join(folder, 'raw/0000001.error.json'), 'utf8')).toContain('exceeded 20ms');
    } finally { globalThis.fetch = saved; rmSync(folder, { recursive: true, force: true }); }
  });
  test('generic deadlines cancel and page cleanup drains before close, then flushes terminal evidence', async () => {
    let cancelled = false;
    await expect(deadline('stuck operation', 10, () => new Promise(() => {}), () => { cancelled = true; })).rejects.toThrow('exceeded');
    expect(cancelled).toBe(true);
    const folder = mkdtempSync(join(tmpdir(), 'questions-harness-close-')); const order: string[] = [];
    try {
      const evidence = new OnceEvidence(folder, [], {});
      evidence.flush = async () => { order.push('drain'); };
      const page = { isClosed: () => false, close: async () => { order.push('close'); } } as unknown as Page;
      await evidence.closePage(page); expect(order).toEqual(['drain', 'close', 'drain']);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  test('drain failure still closes the page and produces an incomplete terminal record', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'questions-harness-drain-')); let closed = false;
    try {
      const evidence = new OnceEvidence(folder, [], {});
      evidence.flush = async () => { throw new Error('bounded drain failed'); };
      const page = { isClosed: () => false, close: async () => { closed = true; } } as unknown as Page;
      await expect(evidence.closePage(page)).rejects.toThrow('bounded drain failed'); expect(closed).toBe(true);
      evidence.verifyInputs(); expect(evidence.finish(false, new Error('bounded drain failed'))).toBe(false);
      const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
      expect(result.complete).toBe(false); expect(result.cleaned).toBe(false); expect(result.failure.message).toContain('bounded drain failed');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  test('input snapshots are frozen and detect edits, additions and removals', () => {
    const folder = mkdtempSync(join(tmpdir(), 'questions-harness-hash-'));
    try {
      const file = join(folder, 'input'); writeFileSync(file, 'before'); const before = hashFiles([file]);
      expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before[0])).toBe(true);
      expect(() => assertHashes(before, hashFiles([file]), 'fixture')).not.toThrow();
      writeFileSync(file, 'after'); expect(() => assertHashes(before, hashFiles([file]), 'fixture')).toThrow('input paths/bytes changed');
      expect(() => assertHashes(before, [], 'fixture')).toThrow();
      expect(() => assertHashes([], before, 'fixture')).toThrow();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  test('DOM rows cannot duplicate, omit, substitute or misstate an API question', () => {
    const expected = [{ slug: 'one', state: 'open' }, { slug: 'two', state: 'answered' }];
    expect(() => assertQuestionDOM([...expected].reverse(), expected, 'route')).not.toThrow();
    for (const actual of [[expected[0]!, expected[0]!], [expected[0]!], [{ slug: 'other', state: 'open' }, expected[1]!], [expected[0]!, { slug: 'two', state: 'closed' }]]) expect(() => assertQuestionDOM(actual, expected, 'route')).toThrow('exact DOM');
  });
  test('route identity and home readiness cannot be satisfied by the toolbar shell', () => {
    const identity = { rows: [], overviewReady: false, settingsReady: false, entity: 'product:shop', question: 'one', state: 'answered' };
    const shot: ShotPlan = { key: 'route', language: 'en', stage: 'first-home', route: '/products/shop/k', ready: '[data-testid=entity-page]', theme: 'light', width: 390, entity: 'product:shop' };
    expect(() => assertRouteIdentity(shot.route, identity, shot, [])).not.toThrow();
    expect(() => assertRouteIdentity('/products/shop/k/settings', identity, shot, [])).toThrow('browser route');
    expect(() => assertRouteIdentity(shot.route, { ...identity, entity: 'domain:other' }, shot, [])).toThrow('expected entity');
    expect(() => assertRouteIdentity(shot.route, identity, { ...shot, stage: 'empty-home', entity: undefined }, [])).toThrow('overview content');
    expect(() => assertRouteIdentity(shot.route, identity, { ...shot, entity: undefined, question: 'one' }, [{ slug: 'one', state: 'closed' }])).toThrow('detail identity/state');
  });
  test('visible pixels require no ancestor/own clipping, readable labels, no overlap and actual theme/language/fonts', () => {
    const shot = { key: 'fixture', width: 390 as const, theme: 'dark' as const, language: 'ru' as const };
    const label = { x: 20, width: 300, height: 24, hidden: false, fontSize: 18, clips: [], ownClip: false, special: true };
    const measure: VisibilityMeasurement = { labels: [label], overlaps: [], documentWidth: 390, fonts: 'loaded', interLoaded: true, dark: true, surface: '#292929', language: 'ru', homeLabel: 'Главная' };
    expect(() => assertVisibility(measure, shot)).not.toThrow();
    for (const surface of ['#fff', '#FFF', '#ffffff']) expect(() => assertVisibility({ ...measure, dark: false, surface }, { ...shot, theme: 'light' })).not.toThrow();
    for (const surface of ['#ffe', '#fefefe', '#000', 'white']) expect(() => assertVisibility({ ...measure, dark: false, surface }, { ...shot, theme: 'light' })).toThrow('actual font/theme');
    for (const change of [{ hidden: true }, { width: 0 }, { height: 0 }, { fontSize: 13 }, { clips: ['hidden ancestor'] }, { ownClip: true }, { x: 200 }]) expect(() => assertVisibility({ ...measure, labels: [{ ...label, ...change }] }, shot)).toThrow();
    for (const change of [{ overlaps: ['one'] }, { documentWidth: 500 }, { fonts: 'loading' }, { interLoaded: false }, { dark: false }, { surface: '#ffffff' }, { language: 'en' }, { homeLabel: 'Home' }]) expect(() => assertVisibility({ ...measure, ...change }, shot)).toThrow();
  });
  test('finite requests must finish even beside an open EventSource, and failures remain errors', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'questions-harness-finite-'));
    try {
      const handlers = new Map<string, ((value: any) => void)[]>();
      const page = { on: (event: string, handler: (value: any) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, url: () => 'http://example.test/k' } as unknown as Page;
      const emit = (event: string, value: unknown): void => { for (const handler of handlers.get(event) ?? []) handler(value); };
      const request = (url: string, type = 'fetch') => ({ url: () => url, method: () => 'GET', resourceType: () => type, failure: () => ({ errorText: 'net::ERR_ABORTED' }) });
      const evidence = new OnceEvidence(folder, [], {}); evidence.watch(page);
      const stream = request('http://example.test/api/events', 'eventsource'); emit('request', stream);
      const finite = request('http://example.test/api/k/block?id=product%3Ashop'); emit('request', finite);
      await expect(evidence.waitFinite(page, 20)).rejects.toThrow('unfinished finite requests');
      const diagnostic = readdirSync(join(folder, 'observations')).map((file) => readFileSync(join(folder, 'observations', file), 'utf8')).join('\n');
      expect(diagnostic).toContain('http://example.test/api/k/block?id=product%3Ashop'); expect(diagnostic).toContain('GET'); expect(diagnostic).toContain('fetch');
      emit('requestfinished', finite);
      const late = request('http://example.test/api/k/late', 'other');
      const started = performance.now();
      const lateStart = setTimeout(() => emit('request', late), 100);
      const lateFinish = setTimeout(() => emit('requestfinished', late), 200);
      try { await evidence.waitFinite(page, 1500); } finally { clearTimeout(lateStart); clearTimeout(lateFinish); }
      expect(performance.now() - started).toBeGreaterThanOrEqual(650);
      const failed = request('http://example.test/api/k/glossary'); emit('request', failed); emit('requestfailed', failed);
      await evidence.waitFinite(page, 1000); evidence.verifyInputs(); expect(evidence.finish(true)).toBe(false);
      const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
      expect(result.errors.join('\n')).toContain('net::ERR_ABORTED'); expect(result.errors.join('\n')).toContain('glossary');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  test('ownership follows the private session and observed reparented children, not an unrelated reused PID', () => {
    const row = (pid: number, parent: number, session: number, born = '10', state = 'S'): OwnedPID => ({ pid, parent, session, born, state });
    const rows = [row(100, 1, 100), row(101, 100, 100), row(102, 101, 102), row(103, 1, 103), row(104, 1, 104, '20'), row(200, 1, 200), row(105, 100, 100, '10', 'Z')];
    expect(ownedPIDs(rows, 100, new Map([[103, '10'], [104, '10']])).map((one) => one.pid)).toEqual([100, 101, 102, 103]);
    expect(ownedPIDs(rows.filter((one) => one.pid !== 100 && one.pid !== 101), 100, new Map([[102, '10']])).map((one) => one.pid)).toEqual([102]);
  });
});
