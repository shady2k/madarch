/** madarch-m38l.22's touched-reader-surface scripted acceptance walk. SOURCE ONLY until explicitly run on the granted pod.
 * bun scripts/loop-shots.ts --questions-once --out <NEW empty folder> [--work <NEW folder>] [--first-fill-minutes <PLAN estimate>]
 * Walks the touched surfaces in en/ru x light/dark x 1150/390. No whole-wiki inventory is run.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { resolveBrowserExecutable } from './chromium.js';
import { OnceEvidence, assertOnceManifest, inventory, requireWalk, compareCodePoint, deadline, hashFiles, assertHashes, resetMissingTargets, resetRepositoryDocument, assertResetStoreRemoved, missingMessage, OwnedTree, HTTP_MS, type ShotPlan, type QuestionDOM, type ResetAbsence, type InputHash } from './questions-once-evidence.js';
import { ONCE_QUESTIONS, EXPECTED_FIRST_QUESTIONS, onceFirstScript, onceQuestionIds, onceRefillScript, onceRefreshScript, ONCE_KEY_MAPPING, validateOnceKey } from '../test/questions-once-script.js';
import { ANSWER_TEXT, ORDERING_CORRECTED, questionSlug } from '../test/loop-agent-script.js';
import { TEXT } from '../test/knowledge-agent-script.js';
import { SAMPLE_IDENTITY, generateTrainingRepository, makeProduct } from '../test/knowledge-fixture.js';
import { gitEnv } from '../test/git-env.js';
import { readKnowledgePages } from '../src/knowledge/index/index.js';
import { parseQuestion, parseCorrection } from '../src/loop/entities.js';
import { readBody, splitFrontMatter, parseTarget } from '../src/knowledge/markdown.js';
import { noEntityMessage } from '../src/knowledge/resolve.js';
import { parse as parseYaml } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { STARTER_FILES, starterManifest } from '../src/knowledge/seed.js';

function argument(name: string, fallback: string): string { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1] ?? fallback; }
const out = resolve(argument('out', 'shots-questions-once'));
const work = resolve(argument('work', `/tmp/madarch-questions-once-${Date.now()}`));
// Never delete previous evidence or work. A failed run is retained, including every raw failure response.
requireWalk(!existsSync(out) || readdirSync(out).length === 0, `${out}: output must be new or empty`);
requireWalk(!existsSync(work), `${work}: work must not exist`);
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const fillMinutes = Number(argument('first-fill-minutes', '25'));
requireWalk(Number.isFinite(fillMinutes) && fillMinutes > 0, '--first-fill-minutes must be positive; this is a PLAN estimate, not measured runtime');
const plan: ShotPlan[] = [];
const languages = ['en', 'ru'] as const;
function add(language: 'en' | 'ru', stage: string, route: string, ready: string, dialog?: { removed: number; retained: number }): void {
  for (const theme of ['light', 'dark'] as const) for (const width of [1150, 390] as const) {
    const key = `${language}-${stage}-${theme}-${width}`;
    requireWalk(!plan.some((shot) => shot.key === key), `duplicate planned observation ${key}`);
    const entity = route.includes('/k/e/') ? decodeURIComponent(route.split('/k/e/')[1]!) : stage.endsWith('-home') && !stage.startsWith('empty-') ? 'product:training-shop' : undefined;
    const question = route.includes('/k/questions/') ? decodeURIComponent(route.split('/k/questions/')[1]!) : undefined;
    plan.push(Object.freeze({ key, language, stage, route, ready, theme, width, entity, question, ...(dialog === undefined ? {} : { dialog: true, ...dialog }) }));
  }
}
for (const language of languages) {
  const base = '/products/training-shop';
  const term = ONCE_QUESTIONS.find((question) => question.item === 'open.term')!;
  const contradiction = ONCE_QUESTIONS.find((question) => question.item === 'open.contradiction')!;
  add(language, 'prefill-zero-counts', `${base}/k/settings`, '[data-testid=danger-fresh-open]', { removed: 0, retained: 0 });
  add(language, 'first-questions', `${base}/k/questions`, '[data-testid=question-row]');
  for (const question of [contradiction, term]) add(language, `first-question-${questionSlug(question, language)}`, `${base}/k/questions/${questionSlug(question, language)}`, '[data-testid=question-page]');
  add(language, 'first-page-domain-ordering', `${base}/k/e/domain%3Aordering`, '[data-testid=entity-page]');
  for (const stage of ['answered', 'closed']) {
    add(language, `${stage}-questions`, `${base}/k/questions`, '[data-testid=question-row]');
    add(language, `${stage}-question-${questionSlug(term, language)}`, `${base}/k/questions/${questionSlug(term, language)}`, '[data-testid=question-page]');
    add(language, `${stage}-page-domain-payments`, `${base}/k/e/domain%3Apayments`, '[data-testid=entity-page]');
  }
  add(language, 'correction-applied-page', `${base}/k/e/domain%3Aordering`, '[data-testid=entity-page]');
  add(language, 'reset-nonzero-counts', `${base}/k/settings`, '[data-testid=danger-fresh-open]', { removed: 7, retained: 1 });
  add(language, 'empty-questions', `${base}/k/questions`, '[data-testid=question-row]');
  add(language, 'empty-answer', `${base}/k/questions/${questionSlug(term, language)}`, '[data-testid=question-page]');
  add(language, 'empty-zero-removed-counts', `${base}/k/settings`, '[data-testid=danger-fresh-open]', { removed: 0, retained: 1 });
  add(language, 'refilled-questions', `${base}/k/questions`, '[data-testid=question-row]');
  add(language, `refilled-question-${questionSlug(term, language)}`, `${base}/k/questions/${questionSlug(term, language)}`, '[data-testid=question-page]');
  add(language, 'refilled-page-domain-payments', `${base}/k/e/domain%3Apayments`, '[data-testid=entity-page]');
}
requireWalk(plan.length === 152, `touched-page matrix requires 152 planned screenshots, got ${plan.length}`);
validateOnceKey();
const root = resolve(import.meta.dir, '..');
const runGit = (folder: string, ...args: string[]): string => execFileSync('git', args, { cwd: folder, encoding: 'utf8', timeout: 10_000 }).trim();
const sourceSnapshot = (): readonly InputHash[] => hashFiles(runGit(root, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter((path) => path && !path.startsWith('.worker-') && ![out, work].some((folder) => join(root, path) === folder || join(root, path).startsWith(`${folder}/`))).map((path) => join(root, path)));
const appFolder = resolve(import.meta.dir, '../wiki/app/dist');
requireWalk(existsSync(appFolder), `${appFolder}: build is required BEFORE this walk`);
const folderSnapshot = (folder: string): readonly InputHash[] => hashFiles(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).slice(folder.length + 1).split('/').includes('.git')).map((entry) => join(entry.parentPath, entry.name)));
const inputs = Object.freeze({ head: runGit(root, 'rev-parse', 'HEAD'), sources: sourceSnapshot(), app: folderSnapshot(appFolder), answerKeyMapping: ONCE_KEY_MAPPING, runtime: process.version });
const manifestFile = process.env.MADARCH_QUESTIONS_MANIFEST;
requireWalk(manifestFile !== undefined, 'frozen touched-page manifest is required before capture');
const expected = JSON.parse(readFileSync(manifestFile, 'utf8'));
const sourceIdentity = { head: inputs.head, sourceSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex') };
assertOnceManifest(expected, plan, sourceIdentity);
const evidence = new OnceEvidence(out, Object.freeze(plan), inputs);
evidence.immutable('runtime-manifest-crossmatch.json', { provided: true, matched: true, ...sourceIdentity, count: plan.length, beforeCapture: true });
evidence.observe('runtime-bound-plan', { fillMinutes, basis: 'PLAN first estimate only; no measured duration is claimed. Outer runs.mjs exec uses recognized command history when present.', sourceOnlyCheckpoint: false });
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let serverTree: OwnedTree | undefined; let browserTree: OwnedTree | undefined;
let failure: unknown; let cleaned = false; let ownershipFailed = false;
const inputChecks: (() => void)[] = [];
const stopServer = async (): Promise<void> => {
  if (!server) return;
  const child = server; const tree = serverTree; requireWalk(tree, 'server process tree was not registered');
  try { await tree.stop(async () => { child.kill('SIGTERM'); await child.exited; }); }
  catch (error) { ownershipFailed = true; throw error; }
  finally { server = undefined; serverTree = undefined; }
};
try {
  browser = await deadline('launch browser', 60_000, () => puppeteer.launch({ executablePath: resolveBrowserExecutable(), headless: true, timeout: 45_000, args: ['--no-sandbox'] }));
  const browserPID = browser.process()?.pid; requireWalk(browserPID, 'browser has no owned PID');
  browserTree = new OwnedTree(browserPID, (value) => evidence.observe('browser-tree-cleanup', value));
  for (const language of languages) {
    const folder = join(work, language); mkdirSync(folder);
    const repository = generateTrainingRepository(join(folder, 'repo'));
    const repositoryBefore = Object.freeze({ head: runGit(repository, 'rev-parse', 'HEAD'), status: runGit(repository, 'status', '--porcelain=v1', '--untracked-files=all'), files: folderSnapshot(repository) });
    evidence.immutable(`${language}-repository-before.json`, repositoryBefore);
    inputChecks.push(() => {
      const after = { head: runGit(repository, 'rev-parse', 'HEAD'), status: runGit(repository, 'status', '--porcelain=v1', '--untracked-files=all'), files: folderSnapshot(repository) };
      evidence.immutable(`${language}-repository-after.json`, after);
      requireWalk(JSON.stringify(after) === JSON.stringify(repositoryBefore), `${repository}: generated repository HEAD/worktree changed during walk`);
    });
    const products = join(folder, 'products'); mkdirSync(products);
    const product = makeProduct(products, 'training-shop', repository);
    const home = join(folder, 'madarch-home'); mkdirSync(home);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ role: 'everything', roleAsked: true }));
    const user = join(folder, 'user'); mkdirSync(user);
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: product, env: gitEnv(SAMPLE_IDENTITY), encoding: 'utf8', timeout: 10_000 }).trim();
    git('config', 'user.name', 'Ada Reader'); git('config', 'user.email', 'ada@example.test');
    const bin = join(folder, 'bin'); mkdirSync(bin);
    const scriptFile = join(folder, 'script.json');
    let scriptHashes: readonly InputHash[] | undefined;
    const setScript = (script: unknown): void => {
      const before = existsSync(scriptFile) ? hashFiles([scriptFile]) : undefined;
      if (scriptHashes) assertHashes(scriptHashes, before!, scriptFile);
      writeFileSync(scriptFile, JSON.stringify(script)); scriptHashes = hashFiles([scriptFile]);
      evidence.observe('intentional-script-transition', { language, before, after: scriptHashes, script });
    };
    inputChecks.push(() => { const after = hashFiles([scriptFile]); evidence.immutable(`${language}-script-after.json`, after); assertHashes(scriptHashes!, after, scriptFile); });
    setScript(onceFirstScript());
    const adapter = join(bin, 'claude-agent-acp');
    writeFileSync(adapter, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(import.meta.dir, '../test/fixtures/acp-fake-agent/acp-fake-agent.ts'))} --scenario script --script ${JSON.stringify(scriptFile)} --record ${JSON.stringify(join(out, `${language}-acp-requests.jsonl`))}\n`);
    chmodSync(adapter, 0o755);
    evidence.observe('fixture-inputs-before-server', { language, settings: readFileSync(join(home, 'settings.json'), 'utf8'), scriptSha256: createHash('sha256').update(readFileSync(scriptFile)).digest('hex'), adapterSha256: createHash('sha256').update(readFileSync(adapter)).digest('hex'), manifestSha256: createHash('sha256').update(readFileSync(join(product, 'workspace.yaml'))).digest('hex'), kindsSha256: createHash('sha256').update(readFileSync(join(product, 'madarch/kinds.yaml'))).digest('hex') });
    const port = Number(argument('port', '4323'));
    const origin = `http://127.0.0.1:${port}`; const base = `${origin}/products/training-shop`;
    const stablePaths = [join(home, 'settings.json'), adapter, join(product, 'workspace.yaml')];
    const stableBefore = hashFiles(stablePaths); evidence.immutable(`${language}-controlled-before.json`, stableBefore);
    inputChecks.push(() => { const after = hashFiles(stablePaths); evidence.immutable(`${language}-controlled-after.json`, after); assertHashes(stableBefore, after, `${language}: controlled inputs`); });
    server = Bun.spawn(['setsid', 'bun', resolve(import.meta.dir, 'madarch.ts'), 'daemon-serve', '--home', products, '--port', String(port)], {
      env: { ...process.env, HOME: user, MADARCH_HOME: home, MADARCH_OWN_WIKI: 'off', PATH: `${bin}:${process.env.PATH ?? ''}`, MADARCH_APP_DIST: resolve(import.meta.dir, '../wiki/app/dist') },
      stdout: Bun.file(join(out, `${language}-server.stdout`)), stderr: Bun.file(join(out, `${language}-server.stderr`)),
    });
    serverTree = new OwnedTree(server.pid, (value) => evidence.observe('server-tree-cleanup', value));
    let listening = false;
    const listenUntil = performance.now() + 60_000;
    for (let attempt = 0; attempt < 120 && performance.now() < listenUntil; attempt += 1) {
      try { await evidence.json(`${base}/api/k/status`, undefined, Math.max(1, Math.min(5_000, listenUntil - performance.now()))); listening = true; break; } catch { if (server.exitCode !== null) throw new Error(`${product}: daemon exited ${server.exitCode}`); }
      await new Promise((done) => setTimeout(done, 500));
    }
    requireWalk(listening, `${product}: server did not listen`);
    const get = (path: string): Promise<any> => evidence.json(`${base}${path}`);
    const post = (path: string, body: unknown): Promise<any> => evidence.json(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let expectedQuestions: readonly QuestionDOM[] = [];
    const capture = async (prefix: string): Promise<void> => {
      for (const shot of plan.filter((entry) => entry.language === language && entry.stage.startsWith(prefix))) await evidence.shot(browser!, origin, shot, expectedQuestions);
    };
    const settled = async (start: any, what: string): Promise<any> => {
      let seen = start.fill?.state === 'running'; const began = performance.now();
      while (performance.now() - began < fillMinutes * 60_000) {
        const status = await evidence.json(`${base}/api/k/status`, undefined, Math.max(1, Math.min(HTTP_MS, fillMinutes * 60_000 - (performance.now() - began))));
        const active = status.fill.state === 'running' || ['running', 'waiting'].includes(status.writer.state);
        seen ||= active;
        requireWalk(status.fill.state !== 'failed' && status.writer.state !== 'failed', `${product}: ${what} failed: ${JSON.stringify(status)}`);
        if (seen && !active) { evidence.observe('fill-completed', { language, what, milliseconds: performance.now() - began, status }); return status; }
        await new Promise((done) => setTimeout(done, 1000));
      }
      throw new Error(`${product}: ${what} exceeded PLAN first estimate ${fillMinutes} minutes; incomplete, never silently smaller`);
    };
    const checkQuestions = async (ids: readonly string[], counts: [number, number, number]): Promise<any> => {
      const listing = await get('/api/k/questions');
      requireWalk(Array.isArray(listing.problems) && Array.isArray(listing.rows) && [listing.open, listing.answered, listing.closed].every((count) => Number.isInteger(count) && count >= 0), `${product}/docs/questions: unknown listing schema`);
      requireWalk(listing.problems.length === 0 && listing.rows.length === new Set(listing.rows.map((row: any) => row.id)).size, `${product}/docs/questions: unreadable/duplicate questions`);
      requireWalk(JSON.stringify(listing.rows.map((row: any) => row.id).sort(compareCodePoint)) === JSON.stringify([...ids].sort(compareCodePoint)), `${product}/docs/questions: expected exact question set ${JSON.stringify(ids)}, got ${JSON.stringify(listing)}`);
      requireWalk(JSON.stringify([listing.open, listing.answered, listing.closed]) === JSON.stringify(counts), `${product}/docs/questions: wrong state counts ${JSON.stringify(listing)}`);
      requireWalk(JSON.stringify((existsSync(join(product, 'docs/questions')) ? readdirSync(join(product, 'docs/questions')).sort(compareCodePoint) : [])) === JSON.stringify(ids.map((id) => `${id.slice('question:'.length)}.md`).sort(compareCodePoint)), `${product}/docs/questions: unexpected question file`);
      expectedQuestions = Object.freeze(ids.map((id) => Object.freeze({ slug: id.slice('question:'.length), state: id === keptId && counts[1] === 1 ? 'answered' : id === keptId && counts[2] === 1 ? 'closed' : 'open' })));
      requireWalk(listing.rows.every((row: any) => row.id === `question:${row.slug}` && expectedQuestions.some((expected) => expected.slug === row.slug && expected.state === row.state)), `${product}: exact API question IDs/states differ from authored stage`);
      return listing;
    };
    const allIds = onceQuestionIds(language); const pageIds = ['product:training-shop', 'domain:ordering', 'domain:payments'];
    const payment = ONCE_QUESTIONS.find((q) => q.item === 'open.term')!; const slug = questionSlug(payment, language); const keptId = `question:${slug}`;
    const kindsFile = join(product, 'madarch/kinds.yaml');
    const kindsBefore = hashFiles([kindsFile]); const kindsValueBefore = parseYaml(readFileSync(kindsFile, 'utf8'));
    await post('/api/k/product-settings', { language });
    const kindsValueAfter = parseYaml(readFileSync(kindsFile, 'utf8'));
    requireWalk(isDeepStrictEqual({ ...kindsValueBefore, language }, kindsValueAfter), `${kindsFile}: language action changed unexpected manifest fields`);
    let kindsExpected = hashFiles([kindsFile]);
    const templatePaths = STARTER_FILES.filter((entry) => entry.path !== 'madarch/kinds.yaml').map((entry) => join(product, entry.path));
    const templatesBefore = hashFiles(templatePaths); evidence.immutable(`${language}-templates-before.json`, templatesBefore);
    inputChecks.push(() => { const after = hashFiles(templatePaths); evidence.immutable(`${language}-templates-after.json`, after); assertHashes(templatesBefore, after, `${language}: held templates`); }); evidence.observe('intentional-kinds-language-transition', { language, before: kindsBefore, after: kindsExpected });
    inputChecks.push(() => { const after = hashFiles([kindsFile]); evidence.immutable(`${language}-kinds-after.json`, after); assertHashes(kindsExpected, after, kindsFile); });
    await capture('prefill-');
    await post('/api/k/agent', { agent: 'claude-code', install: false });
    const first = await settled(await post('/api/k/fill', { agent: 'claude-code', language }), 'first fill');
    requireWalk(first.writer.state === 'done' && first.writer.asked === EXPECTED_FIRST_QUESTIONS, `${product}: first fill must ask exactly eight distinct questions`);
    requireWalk(first.writer.units.filter((unit: any) => /^(product|domain):/.test(unit.unit)).length === 3 && first.writer.units.filter((unit: any) => /^(product|domain):/.test(unit.unit)).every((unit: any) => unit.state === 'written'), `${product}: every product/domain unit must be written, not partial`);
    await checkQuestions(allIds, [8, 0, 0]);
    // The three retention asks span ordering/payments; a separate schedule question remains distinct.
    const retention = ONCE_QUESTIONS.find((q) => q.item === 'open.contradiction')!;
    const retainedDetail = await get(`/api/k/question?id=${questionSlug(retention, language)}`);
    requireWalk(['domain:ordering', 'domain:payments'].every((id) => retainedDetail.about.includes(id)), `${product}: retention paraphrases lost cross-unit association`);
await capture('first-');
    await post('/api/k/answer', { question: slug, text: ANSWER_TEXT[language] });
    await checkQuestions(allIds, [7, 1, 0]);
await capture('answered-');
    const bodyBytes = (file: string): Buffer => { const bytes = readFileSync(file); const marker = Buffer.from('\n---\n'); const at = bytes.indexOf(marker, 3); requireWalk(at >= 0, `${file}: missing frontmatter terminator`); return bytes.subarray(at + marker.length); };
    const answerFile = join(product, `docs/questions/${slug}.md`);
    const answerBody = bodyBytes(answerFile); const answer = parseQuestion(answerFile, readFileSync(answerFile, 'utf8')).answer;
    evidence.immutable(`${language}-human-answer-before.bin.json`, { file: answerFile, bodyBase64: answerBody.toString('base64'), answer });
    const assertAnswer = (): void => { requireWalk(bodyBytes(answerFile).equals(answerBody), `${answerFile}: human answer body bytes changed`); requireWalk(JSON.stringify(parseQuestion(answerFile, readFileSync(answerFile, 'utf8')).answer) === JSON.stringify(answer), `${answerFile}: human answer authorship/text/time changed`); };
    setScript(onceRefreshScript(language));
    const refreshed = await settled(await post('/api/k/fill', { agent: 'claude-code' }), 'answered reuse refresh');
    requireWalk(refreshed.writer.state === 'done' && refreshed.writer.asked === 0, `${product}: answer reuse must create zero questions`);
    requireWalk(readFileSync(join(product, 'docs/domains/payments.md'), 'utf8').includes(`[^payment-token-means-cardtoken]: [the answer](madarch:question:${slug})`), `${product}/docs/domains/payments.md: rewritten statement has no retained-answer ground`);
    assertAnswer(); await checkQuestions(allIds, [7, 0, 1]);
await capture('closed-');
    const ordering = readKnowledgePages(product).pages.find((page) => page.id === 'domain:ordering');
    requireWalk(ordering?.statements[0], `${product}/docs/domains/ordering.md: no statement to correct`);
    const corrected = await post('/api/k/correction', { statement: `domain:ordering#${ordering.statements[0].id}`, reason: language === 'ru' ? 'Отклонённый платёж ещё и отменяет заказ, а в предложении этого нет.' : 'A declined payment also cancels the order; the sentence leaves it out.' });
    const correctionSlug = String(corrected.id).replace(/^correction:/, ''); const correctionFile = join(product, `docs/corrections/${correctionSlug}.md`);
    const correctionBody = bodyBytes(correctionFile); const correction = parseCorrection(correctionFile, readFileSync(correctionFile, 'utf8'));
    requireWalk(correction.status === 'open' && correction.resolvedBy.length === 0 && correction.resolvedAt === null, `${correctionFile}: new correction is not pending`);
    evidence.immutable(`${language}-human-correction-before.json`, { file: correctionFile, bodyBase64: correctionBody.toString('base64'), correction });
    const orderingFile = join(product, 'docs/domains/ordering.md');
    const orderingBefore = readFileSync(orderingFile, 'utf8');
    const correctionLabel = ordering.statements[0].id;
    const originalSentence = `${TEXT[language].orderingStatement}[^${correctionLabel}]`;
    const correctedSentence = `${ORDERING_CORRECTED[language]}[^${correctionLabel}]`;
    requireWalk(orderingBefore.split(originalSentence).length === 2, `${orderingFile}: correction fixture must replace exactly the original grounded sentence`);
    const definition = orderingBefore.split('\n').find((line) => line.startsWith(`[^${correctionLabel}]:`));
    requireWalk(definition, `${orderingFile}: corrected live statement has no exact footnote definition`);
    const orderingAfter = orderingBefore.replace(originalSentence, correctedSentence).replace(definition, `${definition}, [the correction](madarch:correction:${correctionSlug})`);
    requireWalk(orderingAfter.includes(`[the correction](madarch:correction:${correctionSlug})`), `${orderingFile}: scripted correction has no correction ground`);
    setScript({ byPrompt: [{ matches: `(madarch:correction:${correctionSlug})`, steps: [{ call: { tool: 'write_page', arguments: { markdown: orderingAfter } } }, { end: { stopReason: 'end_turn' } }] }], steps: [{ end: { stopReason: 'end_turn' } }] });
    const applied = await settled(await post('/api/k/fill', { agent: 'claude-code' }), 'apply reader correction before reset');
    requireWalk(applied.writer.state === 'done' && applied.writer.asked === 0 && JSON.stringify(applied.writer.plan.pages.map((page: any) => page.path)) === JSON.stringify(['docs/domains/ordering.md']), `${product}: correction must rewrite exactly ordering and ask zero questions`);
    requireWalk(readFileSync(orderingFile, 'utf8').includes(correctedSentence), `${orderingFile}: correction rewrite did not contain the exact corrected sentence`);
    const appliedCorrection = parseCorrection(correctionFile, readFileSync(correctionFile, 'utf8'));
    requireWalk(appliedCorrection.status === 'applied' && JSON.stringify(appliedCorrection.resolvedBy) === JSON.stringify(['domain:ordering']) && appliedCorrection.resolvedAt !== null, `${correctionFile}: scripted correction was not applied/resolved to ordering before reset`);
    evidence.immutable(`${language}-human-correction-applied.json`, { correction: appliedCorrection, correctedSentence, beforeSha256: createHash('sha256').update(orderingBefore).digest('hex'), afterSha256: createHash('sha256').update(readFileSync(orderingFile)).digest('hex') });
    await checkQuestions(allIds, [7, 0, 1]);
    await capture('correction-applied-');

    const assertHumans = (): void => { assertAnswer(); requireWalk(bodyBytes(correctionFile).equals(correctionBody), `${correctionFile}: correction body bytes changed`); const after = parseCorrection(correctionFile, readFileSync(correctionFile, 'utf8')); requireWalk(JSON.stringify([after.reason, after.statement, after.by, after.at]) === JSON.stringify([correction.reason, correction.statement, correction.by, correction.at]), `${correctionFile}: correction human fields changed`); };
    const preview = await get('/api/k/reset');
    requireWalk(preview.unansweredQuestions.length === 7 && preview.keptAnswers.length === 1 && preview.agentPages.length === 3, `${product}: nonzero reset preview counts disagree`);
    await capture('reset-');
    // Freeze exact reset-derived exceptions BEFORE deleting the graph/pages. No empty-stage exemption.
    const removedPages = preview.agentPages.map((file: string) => ({ file, id: parseYaml(splitFrontMatter(readFileSync(join(product, file), 'utf8')).front!).id as string }));
    const documentProofs: { target: string; repo: string; path: string; sha256: string }[] = [];
    const documentHashes: InputHash[] = [];
    const documentSources = (resolutions: Record<string, any>) => Object.entries(resolutions).flatMap(([target, value]) => {
      const parsed = parseTarget(target.startsWith('madarch:') ? target : `madarch:${target}`);
      if (parsed.kind !== 'doc' || value.state !== 'ok') return [];
      const href = new URL(value.href, 'http://fixture.test');
      const repo = href.pathname === '/k/doc' ? href.searchParams.get('repo') : typeof value.entity === 'string' ? /^doc:@([^/]+)\//.exec(value.entity)?.[1] : undefined;
      if (!repo) return [];
      requireWalk(!parsed.path.split('/').includes('..') && !repo.includes('/') && !repo.includes('..'), `invalid document proof path: ${target}`);
      const hash = resetRepositoryDocument(product, repo, parsed.path); documentHashes.push(hash);
      const proof = { target, repo, path: parsed.path, sha256: hash.sha256 }; documentProofs.push(proof); return [proof];
    });
    const absence: Record<string, ResetAbsence[string]> = {};
    for (const [id, file] of [[keptId, answerFile], [`correction:${correctionSlug}`, correctionFile]]) {
      const pageBefore = await get(`/api/k/page?${new URLSearchParams({ id: id!, lang: language, full: '1' })}`);
      requireWalk(pageBefore.id === id && Array.isArray(pageBefore.findings) && pageBefore.findings.length === 0, `${file}: pre-reset page is not clean/exact`);
      const resolutions = [...resetMissingTargets(preview, removedPages, pageBefore.resolutions, documentSources(pageBefore.resolutions))];
      if (id === keptId) {
        const detailBefore = await get(`/api/k/question?id=${slug}`);
        resolutions.push(...resetMissingTargets(preview, removedPages, detailBefore.resolutions, documentSources(detailBefore.resolutions)));
      }
      absence[id!] = Object.freeze({ resolutions: Object.freeze(resolutions), findings: Object.freeze([]) });
    }
    evidence.immutable(`${language}-reset-expected-missing.json`, { preview, removedPages, retained: absence, documentProofs, documentHashes });
    const reset = await post('/api/k/reset', { preview });
    requireWalk(JSON.stringify(reset) === JSON.stringify(preview), `${product}: reset result differs from preview`);
    assertResetStoreRemoved(preview.store);
    for (const path of [...preview.agentPages, ...preview.unansweredQuestions]) requireWalk(!existsSync(join(product, path)), `${join(product, path)}: reset did not remove planned file`);
    assertHashes(documentHashes, documentHashes.map((row) => hashFiles([row.path])[0]!), 'retained code-repository documents after reset');
    assertHumans();
    const keptQuestion = parseQuestion(answerFile, readFileSync(answerFile, 'utf8'));
    const keptCorrection = parseCorrection(correctionFile, readFileSync(correctionFile, 'utf8'));
    requireWalk(keptCorrection.resolvedBy.length === 0 && keptCorrection.resolvedAt === null && keptCorrection.status === 'open', `${correctionFile}: correction resolution metadata was not cleared`);
    requireWalk(keptQuestion.resolvedBy.length === 0 && keptQuestion.resolvedAt === null, `${answerFile}: removed-page resolutions survived reset`);
    // Reset removes frontmatter resolution fields, so body line offsets must come from retained AFTER bytes.
    // The allowed targets remain the immutable pre-reset set, never inferred from a failing response.
    for (const [id, file] of [[keptId, answerFile], [`correction:${correctionSlug}`, correctionFile]]) {
      const source = splitFrontMatter(readFileSync(file!, 'utf8')); const relative = file!.slice(product.length + 1);
      const body = readBody(source.body, relative, source.bodyLine);
      requireWalk(body.findings.length === 0, `${file}: retained document has malformed body after reset`);
      const resolutions = absence[id!]!.resolutions;
      const findings = body.links.flatMap((link) => {
        const target = resolutions.find((row) => row.target === link.url);
        return target ? [{ file: relative, line: link.line, message: `${link.ground ? 'a ground' : 'a link'} does not resolve: ${missingMessage(target)}` }] : [];
      });
      absence[id!] = Object.freeze({ resolutions, findings: Object.freeze(findings) });
    }
    evidence.immutable(`${language}-reset-expected-findings-after-metadata.json`, absence);
    await checkQuestions([keptId], [0, 1, 0]);
await capture('empty-');
    setScript(onceRefillScript(language, { slug: correctionSlug, statement: correctionLabel }));
    // Exercise the settings confirmation itself after the separate reset made the empty state observable without a race.
    const starterPaths = STARTER_FILES.map((entry) => join(product, entry.path));
    assertHashes(kindsExpected, hashFiles([kindsFile]), kindsFile); assertHashes(templatesBefore, hashFiles(templatePaths), `${language}: templates before reset`);
    const starterBefore = hashFiles(starterPaths);
    const page = await deadline('settings page creation', HTTP_MS, () => browser!.newPage()); evidence.watch(page); await evidence.stream(page);
    const confirmation = await deadline('complete settings browser confirmation', 240_000, async () => {
      await page.evaluateOnNewDocument((value) => localStorage.setItem('madarch-wiki-language', value), language);
      await page.goto(`${base}/k/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=danger-fresh-open]', { timeout: 120_000 }); await page.click('[data-testid=danger-fresh-open]');
      await page.waitForSelector('[data-testid=danger-confirm]', { timeout: 60_000 });
      const response = page.waitForResponse((reply) => reply.url().endsWith('/api/k/start-fresh') && reply.request().method() === 'POST', { timeout: HTTP_MS });
      await page.click('[data-testid=danger-confirm]'); const confirmed = await response;
      requireWalk(confirmed.ok(), `${product}: settings confirmation refused HTTP ${confirmed.status()}`);
      const confirmation = await deadline('settings confirmation HTTP body', HTTP_MS, () => confirmed.json()); requireWalk(confirmation.ok === true && confirmation.plan?.unansweredQuestions?.length === 0 && confirmation.plan?.keptAnswers?.length === 1, `${product}: settings confirmation result shape/count mismatch`); evidence.observe('settings-confirmed', { language, confirmation });
      return confirmation;
    }, () => { void evidence.closePage(page).catch((error) => evidence.observe('settings-timeout-close-failed', { error: String(error) })); });
    for (const entry of STARTER_FILES) requireWalk(readFileSync(join(product, entry.path), 'utf8') === (entry.path === 'madarch/kinds.yaml' ? starterManifest(language) : entry.content), `${join(product, entry.path)}: fresh reset did not produce exact held starter content`);
    const starterAfter = hashFiles(starterPaths); evidence.observe('intentional-starter-reset-transition', { language, before: starterBefore, after: starterAfter, changed: confirmation.starter });
    kindsExpected = hashFiles([kindsFile]);
    inputChecks.push(() => { const after = hashFiles(starterPaths); evidence.immutable(`${language}-starter-after.json`, after); assertHashes(starterAfter, after, `${language}: starter reset inputs`); });
    const refill = await settled(confirmation, 'fresh refill'); await evidence.closePage(page);
    requireWalk(refill.writer.state === 'done' && refill.writer.asked === 0 && refill.writer.units.filter((unit: any) => /^(product|domain):/.test(unit.unit)).length === 3 && refill.writer.units.filter((unit: any) => /^(product|domain):/.test(unit.unit)).every((unit: any) => unit.state === 'written'), `${product}: refill must write all three pages and ask zero questions`);
    assertHumans(); await checkQuestions([keptId], [0, 0, 1]);
    const refilledOrdering = readKnowledgePages(product).pages.find((page) => page.id === 'domain:ordering');
    const refilledCorrection = refilledOrdering?.statements.find((statement) => statement.id === correctionLabel);
    requireWalk(refilledCorrection?.text === ORDERING_CORRECTED[language] && refilledCorrection.grounds.includes(`correction:${correctionSlug}`), `${orderingFile}: refill lost the corrected sentence or its retained correction ground`);
    const correctionAfterRefill = parseCorrection(correctionFile, readFileSync(correctionFile, 'utf8'));
    requireWalk(correctionAfterRefill.status === 'applied' && JSON.stringify(correctionAfterRefill.resolvedBy) === JSON.stringify(['domain:ordering']) && correctionAfterRefill.resolvedAt !== null, `${correctionFile}: refill did not apply the retained correction to recreated ordering`);
    requireWalk(readFileSync(join(product, 'docs/domains/payments.md'), 'utf8').includes(`[^payment-token-means-cardtoken]: [the answer](madarch:question:${slug})`), `${product}/docs/domains/payments.md: refill lost retained-answer ground`);
await capture('refilled-');
    await evidence.flush(); await stopServer();
  }
} catch (error) { failure = error; evidence.observe('walk-failed', { error: String(error), stack: error instanceof Error ? error.stack : undefined }); }
finally {
  let cleanupFailed = false;
  try { await stopServer(); } catch (error) { cleanupFailed = true; failure ??= error; evidence.observe('server-cleanup-failed', { error: String(error) }); }
  try { await evidence.closePages(); } catch (error) { cleanupFailed = true; failure ??= error; evidence.observe('page-cleanup-failed', { error: String(error) }); }
  try {
    if (browser && browserTree) { const ownedBrowser = browser; await browserTree.stop(() => ownedBrowser.close()); }
  } catch (error) { cleanupFailed = true; failure ??= error; evidence.observe('browser-cleanup-failed', { error: String(error) }); }
  finally { browser = undefined; browserTree = undefined; }
  try { await evidence.flush(); } catch (error) { cleanupFailed = true; failure ??= error; evidence.observe('drain-failed', { error: String(error) }); }
  let inputFailed = false;
  // Independent checks all run after cleanup, even when an earlier snapshot differs.
  for (const check of inputChecks) { try { check(); } catch (error) { inputFailed = true; failure ??= error; evidence.observe('input-verification-failed', { error: String(error) }); } }
  try {
    const after = { head: runGit(root, 'rev-parse', 'HEAD'), sources: sourceSnapshot(), app: folderSnapshot(appFolder) };
    evidence.immutable('inputs-after.json', after);
    requireWalk(after.head === inputs.head, `${root}: HEAD changed during walk`);
    assertHashes(inputs.sources, after.sources, 'engine/harness/fixture sources'); assertHashes(inputs.app, after.app, 'built app files');
  } catch (error) { inputFailed = true; failure ??= error; evidence.observe('input-verification-failed', { error: String(error) }); }
  if (!inputFailed) evidence.verifyInputs();
  cleaned = !ownershipFailed && !cleanupFailed && server === undefined && browser === undefined;
  if (!evidence.finish(cleaned, failure)) failure ??= new Error(`${out}/result.json: evidence is incomplete; see retained errors and missing observations`);
}
if (failure !== undefined) throw failure;
console.log(`Evidence: ${out}; visual review remains pending. Read result.json for completeness AFTER cleanup.`);
