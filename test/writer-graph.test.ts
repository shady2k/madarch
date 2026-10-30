/**
 * The writer as a graph of units (decision 0032, section 1; madarch-ztyq.4): the kinds, the order
 * derived from their declared reads and writes, what each unit is handed of what the earlier ones
 * wrote, resumability on the fill's own unit state, and the enrichment of a person's document stored
 * apart from it and never over it.
 *
 * The graph is a fixture this test holds: a repository with one requirements document and one source
 * file, filled into a test store by the extract driver; the documents are read as entities of that
 * document, and the agent is scripted — no model, no network, no outside checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseDocument } from 'yaml';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import type { DocEntity } from '../src/knowledge/doc-entities.js';
import {
  enrichmentPath, enrichmentPageId, fsSink, GraphView, memorySink, memoryWriterState, runWriter, UnitTools, writerGraphProblems,
  writerPageFamily, writerUnitOrder, WRITER_UNIT_KINDS,
  type PageSink, type UnitAgent, type UnitRequest, type WriterReport,
} from '../src/writer/index.js';
import { fillWriterState } from '../src/writer/graph-state.js';
import { memoryJournal } from '../src/writer/journal.js';
import { gitEnv } from './git-env.js';
import { KINDS_FILE, readKinds } from '../src/knowledge/kinds.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { structuredKindOf } from '../src/writer/structured.js';

// ---------------------------------------------------------------------------------------------
// The fixture: one repository, one document, one source file
// ---------------------------------------------------------------------------------------------

const REQUIREMENTS = [
  '# Requirements',
  '',
  '## UC-1 Place an order',
  '',
  'A shopper places an order and pays for it.',
  '',
  '## BR-4 Refunds are checked',
  '',
  'A refund is checked before it is made.',
  '',
  '## Qualities',
  '',
  'An order is placed in under a second.',
  '',
].join('\n');

const SOURCE = 'export const refund = (amount: number): number => amount;\n';

let owner: DatabaseOwner;
let store: GraphStore;
let repository: string;
let scratch: string;
let product: string;

/** The passages of the fixture's document, as the fill's own reader mints them: a scenario and a rule. */
const entities: DocEntity[] = [
  {
    id: 'doc:docs/requirements.md#doc-section:1', kind: 'doc.requirement', title: 'UC-1 Place an order', identifier: 'UC-1', repo: null,
    path: 'docs/requirements.md', anchor: 'uc-1', aliases: ['uc-1'], line: 3, endLine: 5, text: 'A shopper places an order and pays for it.',
    stableId: 'doc-section:1', semantics: 'scenario', pass: 'classifier', headingPath: ['Requirements'],
  },
  {
    id: 'doc:docs/requirements.md#doc-section:2', kind: 'doc.rule', title: 'BR-4 Refunds are checked', identifier: 'BR-4', repo: null,
    path: 'docs/requirements.md', anchor: 'br-4', aliases: ['br-4'], line: 7, endLine: 9, text: 'A refund is checked before it is made.',
    stableId: 'doc-section:2', semantics: 'rule', pass: 'metadata', headingPath: ['Requirements'],
  },
  // A passage no pass decided: this is the one the document-interpretation kind reads.
  {
    id: 'doc:docs/requirements.md#doc-section:3', kind: 'doc.passage', title: 'Qualities', identifier: null, repo: null,
    path: 'docs/requirements.md', anchor: 'qualities', aliases: ['qualities'], line: 11, endLine: 13, text: 'An order is placed in under a second.',
    stableId: 'doc-section:3', semantics: 'other', pass: 'classifier', headingPath: ['Requirements'],
  },
];

const UC1 = 'doc:docs/requirements.md#uc-1';
const BR4 = 'doc:docs/requirements.md#br-4';

/**
 * Gives a product folder the starter set and then declares the three page kinds this change writes beside the product
 * and domain pages: the manifest says which kinds the wiki shows (decision 0029), and a kind it does not declare is a
 * page no reader could open, so the writer writes none (`pageKindGate`, `src/writer/run.ts`).
 */
function declareWriterPages(folder: string): void {
  seedStarterSet(folder);
  const file = join(folder, KINDS_FILE);
  const manifest = parseDocument(readFileSync(file, 'utf8'));
  for (const [kind, page] of [['validation', 'docs/validation.md'], ['overview', 'docs/overview.md'], ['editorial', 'docs/editorial.md']] as const) {
    manifest.setIn(['kinds', kind], { template: 'templates/product.liquid', source: 'markdown', file: page, origin: 'agent', labels: { en: { one: 'Report', many: 'Reports' } } });
  }
  // The enrichment of a passage is a kind of the wiki too: its pages stand beside the documents, so a product shows them
  // only when its manifest declares the kind (decision 0029).
  manifest.setIn(['kinds', 'enrichment'], { template: 'templates/product.liquid', source: 'markdown', folder: 'docs/enrichment', origin: 'agent', labels: { en: { one: 'Enrichment', many: 'Enrichments' } } });
  writeFileSync(file, manifest.toString());
  const read = readKinds(folder);
  if (!read.present || !read.manifest.kinds.has('validation')) throw new Error(`the fixture manifest of ${folder} does not declare the validation kind: ${JSON.stringify(read.present ? read.manifest.findings : 'no manifest')}`);
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-'));
  repository = join(scratch, 'code');
  product = join(scratch, 'product');
  mkdirSync(join(repository, 'docs'), { recursive: true });
  mkdirSync(join(repository, 'src'), { recursive: true });
  mkdirSync(join(product, 'docs'), { recursive: true });
  writeFileSync(join(repository, 'docs/requirements.md'), REQUIREMENTS);
  writeFileSync(join(repository, 'src/app.ts'), SOURCE);
  // The product is a product of its own: the starter set, with the three page kinds this change writes declared, then
  // a person's own document, which nothing this test runs may change a byte of.
  declareWriterPages(product);
  writeFileSync(join(product, 'docs/requirements.md'), REQUIREMENTS);
  const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Record the sources');
  owner = createPGliteDatabaseOwner({ btreeGist: true });
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  await fillGraph({ owner, store, repository, extractors: [extractFiles] });
}, 120_000);

afterAll(async () => {
  await owner?.close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}, 60_000);

// ---------------------------------------------------------------------------------------------
// The scripted agent: one valid page per kind, and the prompts it was handed
// ---------------------------------------------------------------------------------------------

const page = (id: string, kind: string, title: string, body: string): string => [
  '---', `id: ${id}`, `kind: ${kind}`, `title: ${title}`, 'relates: []', 'producer: agent', 'sources: []', '---', '', body, '', `[^what-it-is]: [UC-1](madarch:${UC1})`,
].join('\n');

const productPage = page('product:tiny-shop', 'product', 'Tiny shop',
  ['## What the product is', '', 'A shopper places an order.[^what-it-is]', '', '## Domains', '', '- The [ordering domain](madarch:domain:ordering) is where orders are placed.[^what-it-is]'].join('\n'));
const domainPage = page('domain:ordering', 'domain', 'Ordering', '## How ordering works\n\nA shopper places an order.[^what-it-is]');
const validationPage = page('graph-validation:tiny-shop', 'validation', 'Graph verdicts', '## What was inspected\n\nA shopper places an order.[^what-it-is]');
const overviewPage = page('overview:tiny-shop', 'overview', 'Tiny shop', '## What the product is\n\nA shopper places an order.[^what-it-is]');
const editorialPage = page('editorial:tiny-shop', 'editorial', 'A newcomer reading', '## What was read\n\nThe ordering page says what it is for.[^what-it-is]');

/** The fields a domain unit answers with (madarch-ztyq.6): the business first, grounded on its passage. */
const domainFields = {
  title: 'Ordering',
  participants: [{ text: 'A shopper places an order.', grounds: [UC1] }],
  mainScenario: [{ text: 'The shopper submits the cart.', grounds: [UC1] }],
  developer: { notes: [] },
};

/** The write a unit's page asks for, by the kind of page that unit writes: the page itself, or its fields. */
function pageOf(request: UnitRequest): { markdown?: string; fields?: unknown; domains?: unknown[] } {
  if (request.id === 'product:tiny-shop') return { markdown: productPage, domains: [{ slug: 'ordering', title: 'Ordering', summary: 'Orders are placed.', evidence: [UC1] }] };
  if (request.id === 'domain:ordering') return { fields: domainFields };
  if (request.id === 'graph-validation:tiny-shop') return { markdown: validationPage };
  if (request.id === 'overview:tiny-shop') return { markdown: overviewPage };
  if (request.id === 'editorial:tiny-shop') return { markdown: editorialPage };
  return { markdown: '' };
}

/**
 * The fields a scripted agent gives the passage of one kind (decision 0032, section 1; `src/writer/structured.ts`):
 * a use case its actor, goal and one step, a rule its statement, each grounded on the passage it enriches.
 */
function enrichmentFields(kind: 'scenario' | 'rule' | 'decision', entity: DocEntity): Record<string, unknown> {
  const ground = `doc:${entity.path}#${entity.anchor}`;
  const statement = (text: string): { text: string; grounds: string[] } => ({ text, grounds: [ground] });
  if (kind === 'scenario') return { actor: statement('A shopper places an order.'), goal: statement('The shopper has an order to pay for.'), mainFlow: [statement('The shopper submits the cart.')] };
  if (kind === 'rule') return { statement: statement('A refund is checked before the money goes back.') };
  return { status: statement('The record says the decision is accepted.'), decision: [statement('A refund is checked before the money goes back.')] };
}

interface Scripted {
  readonly seen: string[];
  readonly prompts: Map<string, string>;
  readonly agent: UnitAgent;
}

/** An agent that answers every unit with its page, and refuses to answer one it was not told about. */
function scripted(options: { readonly failAt?: string; readonly silentFor?: string } = {}): Scripted {
  const seen: string[] = [];
  const prompts = new Map<string, string>();
  const agent: UnitAgent = {
    run: async (request) => {
      seen.push(request.id);
      prompts.set(request.id, request.prompt);
      if (options.failAt !== undefined && request.id === options.failAt) throw new Error('the agent process died');
      if (options.silentFor !== undefined && request.id === options.silentFor) return;
      if (request.id.startsWith('enrichment:')) {
        // A use case and a rule carry the fields of their kind (madarch-ztyq.5) and the core writes their sections; a
        // passage whose reading is still open writes its own body, since nothing decides what it is.
        const entity = entities.find((candidate) => `enrichment:${candidate.id}` === request.id);
        if (entity === undefined) throw new Error(`the scripted agent was asked for ${request.id}, which is no enrichment of the fixture's document`);
        const kind = structuredKindOf(entity.semantics);
        if (kind === undefined) {
          const written = await request.tools.call('write_enrichment', { body: `## What this passage says\n\nA shopper places an order.[^what-it-is]\n\n[^what-it-is]: [UC-1](madarch:${UC1})` });
          expect(written.isError, JSON.stringify(written.answer)).toBe(false);
          return;
        }
        const written = await request.tools.call('write_enrichment', enrichmentFields(kind, entity));
        expect(written.isError, JSON.stringify(written.answer)).toBe(false);
        return;
      }
      const settled = pageOf(request);
      expect(settled.markdown ?? settled.fields, `the scripted agent has no page for ${request.id}`).toBeDefined();
      const written = settled.fields !== undefined
        ? await request.tools.call('write_page', { fields: settled.fields })
        : settled.domains === undefined
          ? await request.tools.call('write_page', { markdown: settled.markdown })
          : await request.tools.call('write_page', { markdown: settled.markdown, domains: settled.domains });
      expect(written.isError, `${request.id}: ${JSON.stringify(written.answer)}`).toBe(false);
    },
  };
  return { seen, prompts, agent };
}

// ---------------------------------------------------------------------------------------------
// The order: derived from the declarations, never a list
// ---------------------------------------------------------------------------------------------

describe('the unit graph', () => {
  test('the order is the topological order of the declared reads and writes, ties in code point order', () => {
    expect([...writerUnitOrder().order]).toEqual([
      'document-interpretation', 'graph-validation', 'product', 'rules-and-decisions', 'scenarios', 'domains', 'guides', 'overview', 'editorial',
    ]);
    // A declaration decides where a kind stands: reading an artifact moves it after the kind that writes it.
    const moved = WRITER_UNIT_KINDS.map((kind) => kind.kind === 'graph-validation' ? { ...kind, reads: [{ artifact: 'domain-pages' as const, required: false }] } : kind);
    expect([...writerUnitOrder(moved).order]).toEqual([
      'document-interpretation', 'product', 'rules-and-decisions', 'scenarios', 'domains', 'graph-validation', 'guides', 'overview', 'editorial',
    ]);
  });

  test('a read nobody writes, one artifact with two producers and a cycle are refused, each naming its declaration', () => {
    const orphan = WRITER_UNIT_KINDS.map((kind) => kind.kind === 'guides' ? { ...kind, reads: [{ artifact: 'editorial-findings' as const, required: false }] } : kind).filter((kind) => kind.kind !== 'editorial');
    expect(writerGraphProblems(orphan).some((problem) => problem.includes('src/writer/graph.ts: kinds[') && problem.includes('"editorial-findings", which no kind writes'))).toBe(true);
    const twin = WRITER_UNIT_KINDS.map((kind) => kind.kind === 'overview' ? { ...kind, writes: ['domain-pages' as const] } : kind);
    expect(writerGraphProblems(twin).some((problem) => problem.includes('one artifact has one producer') && problem.includes('"domains"') && problem.includes('"overview"'))).toBe(true);
    const cycle = WRITER_UNIT_KINDS.map((kind) => kind.kind === 'product' ? { ...kind, reads: [{ artifact: 'domain-pages' as const, required: false }] } : kind);
    const refused = writerUnitOrder(cycle);
    expect(refused.order).toEqual([]);
    expect(refused.problems[0]).toContain('have no order');
    expect(refused.problems[0]).toContain('"product"');
  });
});

// ---------------------------------------------------------------------------------------------
// A fill: every kind in the derived order, each unit handed what the earlier ones wrote
// ---------------------------------------------------------------------------------------------

describe('a run of the writer', () => {
  let report: WriterReport;
  let script: Scripted;

  beforeAll(async () => {
    script = scripted();
    report = await runWriter({
      owner, store, repository, output: product, productName: 'Tiny shop', agent: script.agent,
      documentEntities: entities, state: memoryWriterState(), sink: fsSink(product),
    });
  }, 120_000);

  test('runs every kind in the order, and only the kinds whose inputs hold something', () => {
    expect([...report.order]).toEqual([...writerUnitOrder().order]);
    expect(report.graph.map((kind) => `${kind.position} ${kind.kind} ${kind.state}`)).toEqual([
      '0 document-interpretation ran',
      '1 graph-validation ran',
      '2 product ran',
      '3 rules-and-decisions ran',
      '4 scenarios ran',
      '5 domains ran',
      '6 guides nothing-found',
      '7 overview ran',
      '8 editorial ran',
    ]);
    // The kind that ran no unit says what it looked for: nothing is skipped in silence.
    expect(report.graph.find((kind) => kind.kind === 'guides')!.reason).toContain('no checked guide production');
    expect(script.seen).toEqual([
      'enrichment:doc:docs/requirements.md#doc-section:3',
      'graph-validation:tiny-shop', 'product:tiny-shop',
      'enrichment:doc:docs/requirements.md#doc-section:2', 'enrichment:doc:docs/requirements.md#doc-section:1',
      'domain:ordering', 'overview:tiny-shop', 'editorial:tiny-shop',
    ]);
    expect(report.ok).toBe(true);
    expect(report.units).toBe(8);
    // The writer's own state recorded every unit and refused none: a state that could not be written is told, never
    // swallowed, and it never fails a run whose pages stand.
    expect(report.stateProblems).toEqual([]);
  });

  test('each unit is handed what the earlier ones produced: the scenario its rules, the domain its scenarios, the overview its domains', () => {
    // The rule was enriched before the scenario that stands on it, and the scenario's prompt carries the rule's page.
    expect(script.prompts.get('enrichment:doc:docs/requirements.md#doc-section:1')).toContain(enrichmentPath(entities[0]!));
    // The domain page is handed the enriched scenario and the enriched rule of its product.
    const domain = script.prompts.get('domain:ordering')!;
    expect(domain).toContain('## What the units before you wrote');
    expect(domain).toContain(enrichmentPath(entities[0]!));
    expect(domain).toContain(enrichmentPath(entities[1]!));
    expect(domain).toContain('scenario-enrichments');
    // The product page is handed the reading of the passage whose meaning was open, and the home page the pages published.
    expect(script.prompts.get('product:tiny-shop')).toContain('document-readings');
    expect(script.prompts.get('product:tiny-shop')).toContain(enrichmentPath(entities[2]!));
    expect(script.prompts.get('overview:tiny-shop')).toContain('domain:ordering');
    expect(script.prompts.get('overview:tiny-shop')).toContain('domain-pages');
    // The validation unit stands on the graph alone: it is handed no page of this run.
    expect(script.prompts.get('graph-validation:tiny-shop')).not.toContain('## What the units before you wrote');
  });

  test('the home page is written last of the pages a reader opens first, and the editorial pass after it', () => {
    const positions = Object.fromEntries(report.graph.map((kind) => [kind.kind, kind.position]));
    expect(positions['overview']!).toBeGreaterThan(positions['domains']!);
    expect(positions['editorial']!).toBeGreaterThan(positions['overview']!);
    expect(existsSync(join(product, 'docs/overview.md'))).toBe(true);
    expect(existsSync(join(product, 'docs/validation.md'))).toBe(true);
    expect(existsSync(join(product, 'docs/editorial.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// An attempt that never ended: recovered, published once, and nothing else redone
// ---------------------------------------------------------------------------------------------

describe('a worker killed mid-unit', () => {
  test('its page is published by the next run, not written again, and no other unit is redone', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-killed-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      declareWriterPages(folder);
      const state = memoryWriterState();
      const killed = scripted();
      // The run dies inside the overview unit, after its page was written and before it was published: exactly what a
      // killed worker leaves. The unit's generation stays running, and no sweep ever comes for a writer unit.
      const failure = await runWriter({
        owner, store, repository, output: folder, productName: 'Tiny shop', agent: killed.agent, documentEntities: entities, state, sink: fsSink(folder),
        onUnit: (outcome) => { if (outcome.unit === 'overview:tiny-shop') throw new Error('the worker was killed'); },
      }).then(() => undefined, (error: Error) => error);
      expect((failure as Error).message).toBe('the worker was killed');
      expect(state.publishedUnits.has('overview:tiny-shop')).toBe(false);
      const pageAfterKill = readFileSync(join(folder, 'docs/overview.md'), 'utf8');

      const resumed = scripted();
      const report = await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: resumed.agent, documentEntities: entities, state, sink: fsSink(folder) });
      // The unit the kill left is published once, from the page it had written: the agent is not asked for it again.
      expect(resumed.seen).toEqual(['editorial:tiny-shop']);
      expect(state.publishedUnits.has('overview:tiny-shop')).toBe(true);
      expect(readFileSync(join(folder, 'docs/overview.md'), 'utf8')).toBe(pageAfterKill);
      expect(report.graph.find((kind) => kind.kind === 'overview')!.units).toEqual([{ unit: 'overview:tiny-shop', kind: 'overview', path: 'docs/overview.md', status: 'written' }]);
      expect(report.stateProblems).toEqual([]);
      // And a third run writes nothing at all.
      const third = scripted();
      await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: third.agent, documentEntities: entities, state, sink: fsSink(folder) });
      expect(third.seen).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// The digests a unit is resumed by: the pinned inputs and the upstream content, not only the ids
// ---------------------------------------------------------------------------------------------

describe('what a unit\'s inputs digest holds', () => {
  test('an upstream enrichment rewritten by hand reaches the unit that stands on it', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-upstream-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      declareWriterPages(folder);
      const state = memoryWriterState();
      await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: scripted().agent, documentEntities: entities, state, sink: fsSink(folder) });
      // The rule's enrichment — the input the scenario unit reads — says something else now.
      const rulePage = enrichmentPath(entities[1]!);
      // The rule's page says what a person made of it now: the page is the unit that stands on it was written from.
      const rewritten = readFileSync(join(folder, rulePage), 'utf8').replace('## Statement', '## What a person found here');
      writeFileSync(join(folder, rulePage), rewritten);
      const second = scripted();
      await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: second.agent, documentEntities: entities, state, sink: fsSink(folder) });
      // The scenario unit stands on that page, so its inputs moved and it runs; the rule's own unit and the product page
      // did not move, and the editorial pass reads the pages by content, so it sees the change too.
      expect(second.seen).toContain('enrichment:doc:docs/requirements.md#doc-section:1');
      expect(second.seen).not.toContain('enrichment:doc:docs/requirements.md#doc-section:2');
      expect(second.seen).not.toContain('product:tiny-shop');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 240_000);

  test('a moved pin is a new input, even when the passage reads the same', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-pin-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      declareWriterPages(folder);
      const state = memoryWriterState();
      await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: scripted().agent, documentEntities: entities, state, sink: fsSink(folder) });
      // The pin the pages record moves: the enrichments were written against another revision of the code.
      const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
      writeFileSync(join(repository, 'src/app.ts'), `${SOURCE}export const refunded = (amount: number): number => refund(amount);\n`);
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-am', 'Change the refund implementation'], { cwd: repository, env, encoding: 'utf8' });
      const second = scripted();
      const report = await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: second.agent, documentEntities: entities, state, sink: fsSink(folder) });
      expect(second.seen).toContain('enrichment:doc:docs/requirements.md#doc-section:2');
      expect(report.ok).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// A prompt is a bounded list, never a lost input: every produced artifact is reachable
// ---------------------------------------------------------------------------------------------

describe('the artifacts a run produced', () => {
  test('search_pages with all names every one of them, and get_page reads the page a prompt cut', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-list-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      declareWriterPages(folder);
      const answers: Record<string, unknown> = {};
      const agent: UnitAgent = {
        run: async (request) => {
          if (request.id === 'domain:ordering') {
            answers['list'] = (await request.tools.call('search_pages', { all: true })).answer;
            const listed = (answers['list'] as { pages: { path: string }[] }).pages;
            const enrichment = listed.find((page) => page.path.startsWith('docs/enrichment/'))!;
            answers['page'] = (await request.tools.call('get_page', { page: enrichment.path })).answer;
          }
          await scripted().agent.run(request);
        },
      };
      // The scripted agent above answers as the fixture's agent does after recording the two answers.
      const report = await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent, documentEntities: entities, state: memoryWriterState(), sink: fsSink(folder) });
      expect(report.ok).toBe(true);
      const listed = answers['list'] as { pages: { path: string; artifact: string }[]; total: number; artifacts: string[] };
      const paths = listed.pages.map((page) => page.path);
      for (const entity of entities) expect(paths).toContain(enrichmentPath(entity));
      expect(listed.artifacts).toEqual(expect.arrayContaining(['document-readings', 'rule-enrichments', 'product-page']));
      expect(listed.total).toBe(listed.pages.length);
      // The page a unit's prompt did not carry is read whole from its path.
      expect(JSON.stringify(answers['page'])).toContain('enrichment:doc:docs/requirements.md#doc-section');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// Enrichment of a person's document: apart from it, keyed by its identity, never over it
// ---------------------------------------------------------------------------------------------

describe('the enrichment of a person’s document', () => {
  test('it is stored beside the document, under the entity’s identity and not its heading', () => {
    for (const entity of entities) {
      const path = enrichmentPath(entity);
      expect(path).toMatch(/^docs\/enrichment\/[A-Za-z0-9._-]+\/[0-9a-f]{64}\.md$/);
      expect(writerPageFamily(path)).toBe(undefined);
      const written = readFileSync(join(product, path), 'utf8');
      // The page is keyed by the durable identity the document reader minted, which a renumbering keeps.
      expect(written).toContain(`id: ${enrichmentPageId(entity)}`);
      expect(written).toContain(`enriches: "${entity.id}"`);
      expect(written).toContain(`source-line: ${entity.line}`);
      expect(written).not.toContain(entity.text);
    }
    // Two passages of one document never share a file.
    expect(enrichmentPath(entities[0]!)).not.toBe(enrichmentPath(entities[1]!));
  });

  test('a file a person left at an enrichment’s place is refused, with its path and line, and never replaced', async () => {
    const sink = fsSink(product);
    const entity = entities[0]!;
    const path = `docs/enrichment/doc.other/${'a'.repeat(64)}.md`;
    mkdirSync(join(product, 'docs/enrichment/doc.other'), { recursive: true });
    writeFileSync(join(product, path), '# A note a person wrote about UC-1\n');
    // A page the writer did not write is not replaced, whatever family it stands in.
    await expect(sink.write(path, page('enrichment:doc:docs/requirements.md#doc-section:1', 'enrichment', 'UC-1', 'A shopper places an order.[^what-it-is]'))).rejects.toThrow(/does not overwrite a page it did not write/);
    expect(readFileSync(join(product, path), 'utf8')).toBe('# A note a person wrote about UC-1\n');
    // An agent page of another entity is refused too: an enrichment is replaced only by its own entity's page.
    const other = page('enrichment:doc:docs/requirements.md#doc-section:2', 'enrichment', 'Other', 'A refund is checked.[^what-it-is]');
    writeFileSync(join(product, path), other);
    await expect(sink.write(path, page('enrichment:doc:docs/requirements.md#doc-section:1', 'enrichment', 'UC-1', 'A shopper places an order.[^what-it-is]'))).rejects.toThrow(/replaced only by the page of the same entity/);
    expect(readFileSync(join(product, path), 'utf8')).toBe(other);
    // The writer's state guard is not what says this: the entity's own tool refuses it before a byte is written.
    const entityPath = enrichmentPath(entity);
    writeFileSync(join(product, entityPath), 'A person wrote this at the entity\'s own place.\n');
    const tools = new UnitTools(await GraphView.open(owner, store), { kind: 'enrichment', id: `enrichment:${entity.id}`, path: entityPath, entity, task: 'State the scenario.' }, sink);
    const refused = await tools.call('write_enrichment', enrichmentFields('scenario', entity));
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.answer)).toContain('enrichment-ownership');
    expect(readFileSync(join(product, entityPath), 'utf8')).toBe('A person wrote this at the entity\'s own place.\n');
  });

  test('the person’s own document is not touched, and the writer refuses to write over it', async () => {
    expect(readFileSync(join(product, 'docs/requirements.md'), 'utf8')).toBe(REQUIREMENTS);
    const sink = fsSink(product);
    await expect(sink.write('docs/requirements.md', productPage)).rejects.toThrow(/the writer may not write this path/);
    // A free page the writer may write is still refused when its text is a person's: no producer "agent".
    mkdirSync(join(product, 'docs/domains'), { recursive: true });
    const handWritten = join(product, 'docs/domains/handwritten.md');
    writeFileSync(handWritten, '# What a person wrote\n');
    await expect(sink.write('docs/domains/handwritten.md', domainPage)).rejects.toThrow(/docs\/domains\/handwritten\.md:1: the writer does not overwrite a page it did not write/);
    expect(readFileSync(handWritten, 'utf8')).toBe('# What a person wrote\n');
  });
});

// ---------------------------------------------------------------------------------------------
// Resumability: an interrupt leaves the finished units finished
// ---------------------------------------------------------------------------------------------

describe('an interrupted run', () => {
  test('leaves the finished units published, and the run after it writes only what is left', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-interrupted-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      declareWriterPages(folder);
      writeFileSync(join(folder, 'docs/requirements.md'), REQUIREMENTS);
      const state = memoryWriterState();
      const interrupted = scripted();
      const failure = await runWriter({
        owner, store, repository, output: folder, productName: 'Tiny shop', agent: interrupted.agent, documentEntities: entities, state, sink: fsSink(folder),
        onUnit: (outcome) => {
          // The reader stops the run once the first domain page is written: every unit before it stands finished.
          if (outcome.unit === 'domain:ordering') throw new Error('the run was interrupted');
        },
      }).then(() => undefined, (error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('the run was interrupted');
      expect([...state.publishedUnits.keys()].sort()).toEqual([
        'enrichment:doc:docs/requirements.md#doc-section:1',
        'enrichment:doc:docs/requirements.md#doc-section:2',
        'enrichment:doc:docs/requirements.md#doc-section:3',
        'graph-validation:tiny-shop',
        'product:tiny-shop',
      ]);
      const before = readFileSync(join(folder, 'docs/product.md'), 'utf8');

      const resumed = scripted();
      const report = await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: resumed.agent, documentEntities: entities, state, sink: fsSink(folder) });
      // Only what the interrupt left: the domain unit's page was written before the stop and stays, and the home
      // page and the editorial pass had not run at all.
      expect(resumed.seen).toEqual(['overview:tiny-shop', 'editorial:tiny-shop']);
      expect(report.ok).toBe(true);
      // The pages the interrupted run finished are the same bytes: nothing was written twice.
      expect(readFileSync(join(folder, 'docs/product.md'), 'utf8')).toBe(before);
      expect(readFileSync(join(folder, 'docs/requirements.md'), 'utf8')).toBe(REQUIREMENTS);
      const kept = report.graph.flatMap((kind) => kind.units).filter((unit) => unit.status === 'kept').map((unit) => unit.unit).sort();
      expect(kept).toEqual([
        'domain:ordering',
        'enrichment:doc:docs/requirements.md#doc-section:1',
        'enrichment:doc:docs/requirements.md#doc-section:2',
        'enrichment:doc:docs/requirements.md#doc-section:3',
        'graph-validation:tiny-shop',
        'product:tiny-shop',
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 240_000);

  test('the state of the fill’s own unit tables keeps a unit’s publication and opens a generation when its inputs move', async () => {
    const first = fillWriterState(owner, { product: 'tiny-shop', runId: 'writer:test:1' });
    const record = { unit: 'product:tiny-shop', kind: 'product' as const, scope: 'tiny-shop', digest: 'a'.repeat(8) };
    await first.begin(record, Date.now());
    await first.publish(record, Date.now());
    const readBack = await fillWriterState(owner, { product: 'tiny-shop', runId: 'writer:test:2' }).published();
    expect([...readBack.values()]).toEqual([record]);
    // Another digest is another input set: the published generation goes stale and its replacement is published.
    const moved = { ...record, digest: 'b'.repeat(8) };
    const second = fillWriterState(owner, { product: 'tiny-shop', runId: 'writer:test:3' });
    await second.begin(moved, Date.now());
    await second.publish(moved, Date.now());
    expect([...(await second.published()).values()]).toEqual([moved]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// A unit that cannot run is reported, never skipped quietly
// ---------------------------------------------------------------------------------------------

describe('a unit that cannot run', () => {
  test('a product page that was not written blocks the domain pages, with the artifact it requires named', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-empty-'));
    try {
      declareWriterPages(empty);
      // Nothing is there and nothing is written: the product unit ends without its page.
      const silent = scripted({ silentFor: 'product:tiny-shop' });
      const report = await runWriter({ owner, store, repository, output: empty, productName: 'Tiny shop', agent: silent.agent, documentEntities: entities, state: memoryWriterState(), sink: memorySink() });
      expect(report.product.status).not.toBe('written');
      const domains = report.graph.find((kind) => kind.kind === 'domains')!;
      expect(domains.state).toBe('blocked');
      expect(domains.reason).toContain('"product-page"');
      expect(domains.reason).toContain('"product"');
      expect(domains.units).toEqual([]);
      // The kinds that do not need the product page still ran, and the run is not ok.
      expect(report.graph.find((kind) => kind.kind === 'overview')!.state).toBe('ran');
      expect(report.ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 120_000);

  test('a page kind the product does not declare is not written, and its absence alone does not fail the run', async () => {
    // The manifest says which kinds the wiki shows (decision 0029): a page of a kind it does not declare is a page no
    // reader could open, so the run writes none, says so, and stays whole.
    const folder = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-undeclared-'));
    try {
      mkdirSync(join(folder, 'docs'), { recursive: true });
      const report = await runWriter({ owner, store, repository, output: folder, productName: 'Tiny shop', agent: scripted().agent, documentEntities: entities, state: memoryWriterState(), sink: fsSink(folder) });
      for (const kind of ['graph-validation', 'overview', 'editorial']) {
        const record = report.graph.find((entry) => entry.kind === kind)!;
        expect(`${kind} ${record.state}`).toBe(`${kind} nothing-found`);
        expect(record.reason).toContain('declares no');
        expect(record.units).toEqual([]);
      }
      expect(existsSync(join(folder, 'docs/validation.md'))).toBe(false);
      expect(existsSync(join(folder, 'docs/overview.md'))).toBe(false);
      // What the manifest does declare is written, and the run is whole.
      expect(existsSync(join(folder, 'docs/product.md'))).toBe(true);
      expect(report.ok).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 120_000);

  test('a unit whose page the agent never wrote is named with its reason and is not counted as written', async () => {
    const silent = scripted({ silentFor: 'graph-validation:tiny-shop' });
    const scratchProduct = mkdtempSync(join(tmpdir(), 'madarch-writer-graph-quiet-'));
    try {
      mkdirSync(join(scratchProduct, 'docs'), { recursive: true });
      declareWriterPages(scratchProduct);
      const report = await runWriter({ owner, store, repository, output: scratchProduct, productName: 'Tiny shop', agent: silent.agent, documentEntities: entities, state: memoryWriterState(), sink: memorySink() });
      const validation = report.graph.find((kind) => kind.kind === 'graph-validation')!;
      expect(validation.units.map((unit) => `${unit.unit} ${unit.status}`)).toEqual(['graph-validation:tiny-shop not-written']);
      expect(validation.units[0]!.reason).toContain('the unit ended without writing its page');
      expect(report.ok).toBe(false);
    } finally {
      rmSync(scratchProduct, { recursive: true, force: true });
    }
  }, 120_000);
});


// ---------------------------------------------------------------------------------------------
// The editorial pass in a run (madarch-ztyq.9): after the page batch and after the overview
// ---------------------------------------------------------------------------------------------

describe('the editorial pass in a writer run', () => {
  let report: WriterReport;
  let calls = 0;
  let journal: ReturnType<typeof memoryJournal>;

  beforeAll(async () => {
    const output = join(scratch, 'editorial-product');
    mkdirSync(join(output, 'docs'), { recursive: true });
    declareWriterPages(output);
    writeFileSync(join(output, 'docs/requirements.md'), REQUIREMENTS);
    journal = memoryJournal('run-editorial-wiring');
    report = await runWriter({
      owner, store, repository, output, productName: 'Tiny shop', agent: scripted().agent,
      documentEntities: entities, state: memoryWriterState(), sink: fsSink(output),
      editorial: {
        maxRequestsPerPage: 1,
        journal,
        judge: {
          async judge(pack) {
            calls += 1;
            expect(pack.maxPerPage).toBe(1);
            return { requests: [] };
          },
        },
      },
    });
  }, 120_000);

  test('it reads the page batch before the guides, and the complete set once the overview stands', () => {
    expect(report.editorialPasses.map((pass) => pass.point)).toEqual(['batch', 'overview']);
    const batch = report.editorialPasses[0]!;
    const final = report.editorialPasses[1]!;
    expect(batch.pages).toContain('docs/product.md');
    expect(batch.pages.some((page) => page.startsWith('docs/domains/'))).toBe(true);
    expect(batch.pages).not.toContain('docs/overview.md');
    expect(final.pages).toContain('docs/overview.md');
    expect(final.pages).toEqual(expect.arrayContaining([...batch.pages]));
    expect(calls).toBe(2);
    expect(report.editorialProblems).toEqual([]);
  });

  test('the pass itself leaves every page in place; the run’s pages are what the writer wrote', () => {
    // No editorial request was made in this fixture, so the writer wrote each page once; the pass added no write.
    expect(report.ok).toBe(true);
    expect(report.revisionRequests).toEqual([]);
    expect(journal.records.filter((record) => record.kind === 'revision-request')).toEqual([]);
  });
});
