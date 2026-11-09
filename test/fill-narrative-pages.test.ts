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
import { type DatabaseOwner } from '../src/adapters/database-owner.js';
import { applyPublishedFacts, createFactStoreSchema } from '../src/fill/fact-store.js';
import { makeNodeFact, type Fact } from '../src/fill/facts.js';
import { NARRATIVE_PAGE_DIR, NARRATIVE_PAGE_STATUS, NARRATIVE_PAGE_WRITER, narrativePagePath, parseNarrativePage, renderNarrativePage } from '../src/fill/narrative-text.js';

import { createOrchestratorSchema } from '../src/fill/orchestrator-store.js';
import { createUnit } from '../src/fill/state-store.js';
import { repositoryPath, type NarrativeValue } from '../src/fill/facts.js';
import { createFillStateSchema } from '../src/fill/state-store.js';
import { createTestDatabaseOwner } from './test-database.js';

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
  owner = await createTestDatabaseOwner();
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
  
  
  
  
  
  
  });
