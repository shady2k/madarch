/**
 * The narrative page's own text and its outbox (madarch-tzte.25.1; decision 0026,
 * "Pages", 0027's "Git commits of pages are a separate idempotent outbox step",
 * 0017/0023's product git as the truth of authored content).
 *
 * The expected bytes come from the decisions and the task, never from the code: a
 * page is Markdown with the front matter that says what it is about, that it is
 * `proposed`, and that the fill wrote it; one line a sentence, each ending with the
 * comment that names the fact ids the sentence stands on. The outbox commits such a
 * page into the product's git, does nothing when the same bytes stand there, and
 * never writes over a file a person wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { makeNodeFact, type Fact } from '../src/fill/facts.js';
import {
  NARRATIVE_PAGE_DIR,
  NARRATIVE_PAGE_STATUS,
  NARRATIVE_PAGE_WRITER,
  narrativeDigest,
  narrativePagePath,
  parseNarrativePage,
  renderNarrativePage,
} from '../src/fill/narrative-text.js';
import { commitNarrativePages } from '../src/fill/narrative-outbox.js';
import { createOrchestratorSchema } from '../src/fill/orchestrator-store.js';
import { createUnit } from '../src/fill/state-store.js';
import { repositoryPath, type NarrativeValue } from '../src/fill/facts.js';
import { createFillStateSchema } from '../src/fill/state-store.js';

const NOW = 1_700_000_000_000;
const PRODUCT = 'fixture-product';
const REPOSITORY = 'acme-shop';
const COMMIT = 'a'.repeat(40);
const MODULE = `module:${'9'.repeat(64)}`;
const FILE = `file:${'8'.repeat(64)}`;

const PAGE: NarrativeValue = {
  about: MODULE,
  sentences: [
    { text: 'The checkout validates the cart before payment.', facts: [FILE] },
    { text: 'An order is placed once.', facts: [FILE, MODULE].sort() },
  ],
};

let root: string | undefined;
let owner: DatabaseOwner | undefined;
let repo: string | undefined;
let seedGeneration = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** One narrative fact, as a pages unit publishes it, held by one unit of one product. */
function narrativeFact(value: NarrativeValue): Fact {
  return makeNodeFact({
    kind: 'narrative',
    value,
    provenance: {
      source: { system: 'madarch-fill-agent', version: 'test' },
      repository: { id: REPOSITORY, commit: COMMIT },
      place: { file: repositoryPath('src/checkout.ts'), range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 12 } },
    },
    layer: 'inferred',
  });
}

/**
 * Publishes one narrative fact, as a unit's publication does. Two products fill the
 * same code here: their pages are facts of one id, and what the step carries is the
 * product it is asked for, never every page in the store.
 */
async function publish(value: NarrativeValue, product = PRODUCT): Promise<void> {
  const unitId = `narrative/${product}/${value.about}`;
  const generation = product === PRODUCT ? seedGeneration + 1 : 1;
  if (product === PRODUCT) seedGeneration = generation;
  await createUnit(owner!, { unitId, product, runId: `run-${product}`, stageId: 'narrative', scopeKey: value.about, inputsDigest: 'inputs-1', retries: 0, at: NOW });
  await owner!.transaction('write', async (executor) => await applyPublishedFacts({
    executor,
    unit: { unitId, generation } as Parameters<typeof applyPublishedFacts>[0]['unit'],
    plan: { unitId, generation, runId: `run-${product}`, stageId: 'narrative', stageUnitId: value.about, scope: REPOSITORY, stagePosition: 0, planPosition: 0, plannedAt: NOW },
    digest: `publication-${product}-${String(generation)}`,
    writes: [{ kind: 'fact' as const, evidence: `${REPOSITORY}@${COMMIT}:src/checkout.ts`, value: narrativeFact(value) }],
  }));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-narrative-pages-'));
  repo = join(root!, REPOSITORY);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# acme shop\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'one');
  owner = createPGliteDatabaseOwner();
  await createFillStateSchema(owner);
  await createOrchestratorSchema(owner);
  await createFactStoreSchema(owner);
});

afterAll(async () => {
  if (owner !== undefined) await owner.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('the narrative page\'s own text', () => {
  test('a page\'s path is the node it is about, under the product repository\'s docs', () => {
    expect(String(narrativePagePath(MODULE))).toBe(`${NARRATIVE_PAGE_DIR}/module-${'9'.repeat(64)}.md`);
    expect(() => narrativePagePath('module')).toThrow(/no fact id/);
    expect(() => narrativePagePath('module:zz')).toThrow(/no fact id/);
  });

  test('a page is Markdown: front matter that names the node, proposed, the fill\'s writer; one sentence a line with its facts', () => {
    const text = renderNarrativePage(PAGE);
    const lines = text.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines).toContain(`about: "${MODULE}"`);
    expect(lines).toContain(`status: ${NARRATIVE_PAGE_STATUS}`);
    expect(lines).toContain(`writer: ${NARRATIVE_PAGE_WRITER}`);
    expect(text).toContain('The checkout validates the cart before payment.');
    expect(text).toContain(`<!-- facts: ${FILE} -->`);
    // The second sentence names both its facts, in code point order, whatever order it held.
    expect(text).toContain(`<!-- facts: ${[FILE, MODULE].sort().join(' ')} -->`);
    // The same page renders the same bytes: a reader compares a file against the page by them.
    expect(renderNarrativePage(PAGE)).toBe(text);
    expect(narrativeDigest(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the fill\'s own page reads back whole, and a person\'s file reads as not the fill\'s', () => {
    const read = parseNarrativePage(renderNarrativePage(PAGE));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.about).toBe(MODULE);
    expect(read.status).toBe('proposed');
    expect(read.writer).toBe(NARRATIVE_PAGE_WRITER);
    expect(read.sentences).toEqual(PAGE.sentences);
    const person = parseNarrativePage('# my own notes\n\nWritten by hand.\n');
    expect(person.ok).toBe(false);
    const foreign = parseNarrativePage(renderNarrativePage(PAGE).replace(`writer: ${NARRATIVE_PAGE_WRITER}`, 'writer: someone-else'));
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(foreign.writer).toBe('someone-else');
  });
});

describe('the pages outbox', () => {
  test('a published page is committed into the product\'s git as proposed, by the fill, once', async () => {
    await publish(PAGE);
    const first = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW });
    const path = narrativePagePath(MODULE);
    expect(first.committed.map((page) => page.path)).toEqual([path]);
    expect(first.unchanged).toEqual([]);
    expect(first.kept).toEqual([]);
    // The file stands at HEAD, byte for byte the page the fact holds (git's own output trims the last newline).
    expect(git(repo!, 'show', `HEAD:${path}`)).toBe(renderNarrativePage(PAGE).trimEnd());
    // The commit names the fill as its author, at the clock the caller gave.
    expect(git(repo!, 'log', '-1', '--format=%an|%ae')).toBe('madarch fill|madarch@localhost.invalid');
    // Git records whole seconds; the clock's own moment is what the commit carries.
    expect(git(repo!, 'log', '-1', '--format=%cI')).toBe(new Date(NOW).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    // Only the page was committed: the person's own work in the checkout is not.
    const head = git(repo!, 'rev-parse', 'HEAD');
    const second = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 1_000 });
    expect(second.committed).toEqual([]);
    expect(second.unchanged).toEqual([path]);
    expect(second.kept).toEqual([]);
    expect(git(repo!, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('a person\'s words in the page\'s file win: the outbox keeps them and names what it did', async () => {
    const path = narrativePagePath(MODULE);
    const person = '# checkout\n\nWritten by a person, kept.\n';
    writeFileSync(join(repo!, path), person, 'utf8');
    git(repo!, 'add', '--', path);
    git(repo!, 'commit', '-qm', 'a person edits the page');
    const head = git(repo!, 'rev-parse', 'HEAD');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_000 });
    expect(result.committed).toEqual([]);
    expect(result.kept.map((page) => page.path)).toEqual([path]);
    // The reason names the hand that last committed the page: this one is no page of the fill's at all.
    expect(result.kept[0]?.reason).toContain('the last commit that touched the page');
    // The person's file stands, untouched.
    expect(git(repo!, 'show', `HEAD:${path}`)).toBe(person.trimEnd());
    expect(git(repo!, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('a person who edits the fill\'s committed page keeps their words, front matter and all', async () => {
    const path = narrativePagePath(MODULE);
    // The natural edit: the person changes a sentence and keeps the page's front matter.
    const edited = renderNarrativePage(PAGE).replace('The checkout validates the cart before payment.', 'The checkout validates the cart, twice, by hand.');
    writeFileSync(join(repo!, path), edited, 'utf8');
    const head = git(repo!, 'rev-parse', 'HEAD');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_100 });
    expect(result.committed).toEqual([]);
    expect(result.kept.map((page) => page.path)).toEqual([path]);
    // The person's words stand, untouched, in the working tree and at HEAD.
    expect(readFileSync(join(repo!, path), 'utf8')).toBe(edited);
    expect(git(repo!, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('a person who commits their edit of the fill\'s page keeps it: the last hand on the page is theirs', async () => {
    const path = narrativePagePath(MODULE);
    const person = renderNarrativePage(PAGE).replace('The checkout validates the cart before payment.', 'The checkout validates the cart, by a person.');
    writeFileSync(join(repo!, path), person, 'utf8');
    git(repo!, 'add', '--', path);
    git(repo!, 'commit', '-qm', 'a person edits the page, front matter kept');
    const head = git(repo!, 'rev-parse', 'HEAD');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_200 });
    expect(result.committed).toEqual([]);
    expect(result.kept.map((page) => page.path)).toEqual([path]);
    expect(git(repo!, 'show', `HEAD:${path}`)).toBe(person.trimEnd());
    expect(git(repo!, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('a step that crashed between its write and its commit finds the commit still owed', async () => {
    // The crash state: the page's bytes stand in the checkout, HEAD holds the older page.
    const mine = `module:${'4'.repeat(64)}`;
    const first: NarrativeValue = { about: mine, sentences: [{ text: 'The first words the fill wrote.', facts: [FILE] }] };
    await publish(first);
    await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_300 });
    const revised: NarrativeValue = { about: mine, sentences: [{ text: 'The words a crashed step had written.', facts: [FILE] }] };
    await publish(revised);
    const before = git(repo!, 'rev-parse', 'HEAD');
    // Simulate the crash: the new page's bytes are on disk, uncommitted.
    writeFileSync(join(repo!, narrativePagePath(mine)), renderNarrativePage(revised), 'utf8');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_400 });
    const path = narrativePagePath(mine);
    expect(result.committed.map((page) => page.path)).toEqual([path]);
    expect(git(repo!, 'show', `HEAD:${path}`)).toBe(renderNarrativePage(revised).trimEnd());
    expect(git(repo!, 'rev-parse', 'HEAD')).not.toBe(before);
  });

  test('a page the fill wrote before is replaced by the newer one, and the change is one commit', async () => {
    // Its own node: the page of the test before it is a person's now, and a person's file stands.
    const mine = `module:${'6'.repeat(64)}`;
    const first: NarrativeValue = { about: mine, sentences: [{ text: 'The checkout totals the cart before payment.', facts: [FILE] }] };
    await publish(first);
    await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 2_500 });
    const revised: NarrativeValue = { about: mine, sentences: [{ text: 'The checkout validates the cart, and an order is placed once.', facts: [FILE] }] };
    await publish(revised);
    const before = git(repo!, 'rev-parse', 'HEAD');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 3_000 });
    const path = narrativePagePath(mine);
    expect(result.committed.map((page) => page.path)).toEqual([path]);
    // The older page was the fill's own, so the newer one replaces it — one commit for the change.
    expect(git(repo!, 'show', `HEAD:${path}`)).toBe(renderNarrativePage(revised).trimEnd());
    expect(git(repo!, 'rev-parse', 'HEAD')).not.toBe(before);
    // The checkout is clean: the outbox leaves no uncommitted work behind.
    expect(git(repo!, 'status', '--porcelain')).toBe('');
  });

  test('another product\'s pages are not this checkout\'s: the step carries only the product it is asked for', async () => {
    // What this checkout carries is the product it was asked for, never another product's page.
    const other: NarrativeValue = { about: `module:${'5'.repeat(64)}`, sentences: [{ text: 'Another product\'s reading of the code.', facts: [FILE] }] };
    await publish(other, 'another-product');
    const result = await commitNarrativePages({ database: owner!, folder: repo!, product: PRODUCT, clock: () => NOW + 4_000 });
    expect(result.committed).toEqual([]);
    // The other product's page is carried when the step is asked for it: its own page, this same checkout.
    const theirs = await commitNarrativePages({ database: owner!, folder: repo!, product: 'another-product', clock: () => NOW + 4_000 });
    expect(theirs.committed.map((page) => page.path)).toEqual([narrativePagePath(other.about)]);
  });
});
