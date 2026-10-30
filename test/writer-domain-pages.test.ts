/**
 * The domain page explains the business (decision 0032, sections 1, 2 and 6; madarch-ztyq.6), over the generated
 * training repository: a domain unit answers with the fields of its six sections, and the core writes the page —
 * who takes part, the main scenario in numbered steps, the rules that govern the domain, what can go wrong and what
 * is open, then one section for the developer where the code stands.
 *
 * What the test expects is the page's own structure and its grounds, never the writer's wording: the sections in
 * their order, the scenario numbered, every business sentence standing on a document or a container and never on a
 * route, a function, a table or a channel, and the places of the developer section resolved in the graph and named
 * in the page's `relates`. No model runs: the unit is answered by the test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import { readDocEntities } from '../src/knowledge/doc-entities.js';
import { KINDS_FILE, readKinds, type KindsManifest } from '../src/knowledge/kinds.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import {
  DOMAIN_SECTIONS, GraphView, UnitTools, memorySink, renderDomainPage, type DomainSectionDecl, type PageSink, type UnitSpec,
} from '../src/writer/index.js';
import { domainPrompt } from '../src/writer/prompts.js';
import { DEFAULT_UNIT_BOUNDS, type UnitExtras } from '../src/writer/tools.js';
import { ROOT, generateTrainingRepository, makeProduct } from './knowledge-fixture.js';

const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as { snapshots: Record<string, string> };

let scratch: string;
let repository: string;
let product: string;
let owner: DatabaseOwner;
let store: GraphStore;
let view: GraphView;

const ORDERS = 'code.service:orders';
const PAYMENTS = 'code.service:payments';
// The grounds the fixture's own graph holds: the sections its documents carry, and the code the domain is carried
// out by, each read from the graph rather than guessed (a key the graph does not hold is a refusal, not a test).
let ROUTE = '';
let HANDLER = '';
let TABLE = '';
let UC1 = '';
let BR1 = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'madarch-domain-pages-'));
  repository = generateTrainingRepository(join(scratch, 'repository'));
  mkdirSync(join(scratch, 'home'));
  product = makeProduct(join(scratch, 'home'), 'training-shop', repository);
  seedStarterSet(product);
  if (!readKinds(product).present) throw new Error(`${join(product, KINDS_FILE)}:1: the fixture product has no manifest of kinds`);
  owner = createPGliteDatabaseOwner({ btreeGist: true, path: join(scratch, 'store') });
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: KEY.snapshots });
  view = await GraphView.open(owner, store);
  // The page's grounds, as the fixture's own graph holds them. The business stands on the documents the product's
  // people wrote — the containers a reader opens (a file), not on a section number this test would have to guess —
  // and the code on the keys its tools answer. A key the graph does not hold is a refusal, so none is guessed here.
  const documents = markdownOf(repository);
  const entities = readDocEntities(documents, manifestOf(product)).entities;
  const fileOf = (identifier: string): string => {
    const entity = entities.find((candidate) => candidate.identifier === identifier);
    if (entity === undefined) throw new Error(`${join(repository, 'docs/requirements.md')}:1: the fixture's documents hold no ${identifier}`);
    return entity.path;
  };
  const requirements = fileOf('UC-1');
  const rules = fileOf('BR-1');
  if (requirements !== rules) throw new Error(`${join(repository, 'docs')}:1: the fixture keeps its use case and its rule in different documents (${requirements}, ${rules}), and this test stands on one`);
  UC1 = `code.file:${requirements}`;
  BR1 = UC1;
  const finder = new UnitTools(view, { kind: 'validation', id: 'validation:probe', path: 'docs/validation-probe.md', name: 'Training shop' }, memorySink(), [], DEFAULT_UNIT_BOUNDS, [], {});
  const keyOf = async (kind: string, text: string, endsWith: string): Promise<string> => {
    const answer = await finder.call('find_nodes', { kind, text, limit: 40 });
    const nodes = (answer.answer as { nodes: { key: string }[] }).nodes;
    const found = nodes.find((node) => node.key.endsWith(endsWith) && !/\s/.test(node.key));
    if (found === undefined) throw new Error(`${join(repository, 'docs')}:1: the fixture's graph holds no ${kind} whose key ends with ${endsWith}`);
    return found.key;
  };
  ROUTE = await keyOf('code.route', 'POST:/orders', 'POST:/orders');
  HANDLER = await keyOf('code.symbol', 'OrderHandlers.Create', 'OrderHandlers.Create');
  TABLE = await keyOf('code.table', 'orders', 'orders');
}, 1_800_000);

/** The Markdown documents of the fixture's repository: what the person wrote, which the page stands on. */
function markdownOf(folder: string, root = folder): { repo: string; path: string; text: string }[] {
  const out: { repo: string; path: string; text: string }[] = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (name === '.git' || name === 'node_modules') continue;
    if (statSync(path).isDirectory()) out.push(...markdownOf(path, root));
    else if (name.endsWith('.md')) out.push({ repo: 'training', path: path.slice(root.length + 1).split('\\').join('/'), text: readFileSync(path, 'utf8') });
  }
  return out;
}

/** The product's manifest of kinds: the fixture's own, which decides what a document section is. */
function manifestOf(folder: string): KindsManifest {
  const read = readKinds(folder);
  if (!read.present) throw new Error(`${join(folder, KINDS_FILE)}:1: the fixture product has no manifest of kinds`);
  return read.manifest;
}

afterAll(async () => {
  await owner?.close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}, 120_000);

/** The tools of one domain unit over the fixture's graph, writing into a sink of its own. */
function toolsOf(slug = 'ordering', extras: UnitExtras = {}): { tools: UnitTools; sink: PageSink & { pages: Map<string, string> } } {
  const sink = memorySink();
  const spec: UnitSpec = { kind: 'domain', id: `domain:${slug}`, path: `docs/domains/${slug}.md`, domain: { slug, title: slug === 'ordering' ? 'Ordering' : 'Payments', summary: `The ${slug} domain.`, evidence: [slug === 'ordering' ? ORDERS : PAYMENTS] }, productId: 'product:training-shop' };
  return { sink, tools: new UnitTools(view, spec, sink, [], DEFAULT_UNIT_BOUNDS, [], extras) };
}

/** The fields of the ordering domain: the business first, in the words a reader needs, and the code at the end. */
const fieldsOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Ordering',
  participants: [
    { text: 'A shopper places an order and waits for it to be paid.', grounds: [UC1] },
    { text: 'The orders service takes the order in and keeps it.', grounds: [ORDERS] },
  ],
  mainScenario: [
    { text: 'The shopper submits the cart.', grounds: [UC1] },
    { text: 'The orders service keeps the order until it is paid.', grounds: [UC1, ORDERS] },
  ],
  rules: [{ text: 'An order is paid before it is shipped.', grounds: [BR1] }],
  whatCanGoWrong: [{ text: 'A card can be declined, and then the order waits unpaid.', grounds: [UC1] }],
  openPoints: [{ text: 'The documents do not say how long an unpaid order waits.', grounds: [BR1] }],
  developer: { routes: [{ target: ROUTE }], functions: [{ target: HANDLER }], tables: [{ target: TABLE }], notes: [{ text: 'The route answers 201 when the order is placed.', grounds: [ROUTE] }] },
  ...overrides,
});

/** The page's words without the core's mention links: a writer test judges the sentence it wrote, not the links. */
function plain(text: string): string {
  return text.replace(/\[([^\]]+)\]\(madarch:[^)]+\)/g, '$1');
}

/** One section of a page: its heading and the lines under it, up to the next heading of the same level. */
function sectionOf(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n');
  const at = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => /^#{2,6}\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** The headings of the page's own sections, in the order they stand. */
function headingsOf(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
}

/** The front matter of a written page, parsed. */
function frontOf(markdown: string): Record<string, unknown> {
  return parseYaml(markdown.split('---')[1] ?? '') as Record<string, unknown>;
}

/** Every `madarch:` target a piece of the page links, in the order they appear. */
function targetsIn(markdown: string): string[] {
  const out: string[] = [];
  for (const match of markdown.matchAll(/\]\(madarch:([^)]+)\)/g)) out.push(match[1]!);
  return out;
}

const english = (section: DomainSectionDecl): string => section.heading.en;
const russian = (section: DomainSectionDecl): string => section.heading.ru;

describe('a domain page opens with the business', () => {
  test('the page carries the six sections of its kind, in the order a reader reads them', async () => {
    const { tools, sink } = toolsOf();
    const answer = await tools.call('write_page', { fields: fieldsOf() });
    expect(answer.isError, JSON.stringify(answer.answer)).toBe(false);
    const page = sink.pages.get('docs/domains/ordering.md')!;
    expect(headingsOf(page)).toEqual(DOMAIN_SECTIONS.map(english));
    // The developer section is the last one: the business comes first, the code at the end.
    expect(headingsOf(page).at(-1)).toBe('For the developer');
    const front = frontOf(page);
    expect(front['id']).toBe('domain:ordering');
    expect(front['kind']).toBe('domain');
  });

  test('participants are one bullet each, and the main scenario is numbered in the order the unit gave it', async () => {
    const { tools, sink } = toolsOf();
    expect((await tools.call('write_page', { fields: fieldsOf() })).isError).toBe(false);
    const page = sink.pages.get('docs/domains/ordering.md')!;
    const participants = sectionOf(page, 'Participants')!;
    expect(participants.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    const scenario = sectionOf(page, 'The main scenario, step by step')!;
    const steps = scenario.split('\n').filter((line) => line.startsWith('1. ') || line.startsWith('2. '));
    expect(steps.map((line) => line.slice(0, 3))).toEqual(['1. ', '2. ']);
    expect(steps[0]).toContain('The shopper submits the cart.');
    expect(plain(steps[1]!)).toContain('The orders service keeps the order until it is paid.');
  });

  test('a Russian page carries the Russian headings of the same six sections, and the same places', async () => {
    const rendered = renderDomainPage(
      { participants: [{ text: 'Покупатель оформляет заказ.', grounds: [UC1] }], mainScenario: [{ text: 'Покупатель отправляет корзину.', grounds: [UC1] }], rules: [], whatCanGoWrong: [], openPoints: [], developer: { routes: [{ target: ROUTE }], notes: [] } },
      { language: 'ru', labelOf: () => undefined, domain: { slug: 'ordering', title: 'Заказы' }, evidence: [ORDERS] },
    );
    expect(headingsOf(rendered.markdown)).toEqual(DOMAIN_SECTIONS.map(russian));
    expect(targetsIn(rendered.markdown)).toContain(ROUTE);
    expect(rendered.relates).toContain(ROUTE);
  });
});

describe('the business says what the domain is for, and the code stands in one section', () => {
  test('no route, function, table or channel stands outside the developer section, and each is a key of the graph', async () => {
    const { tools, sink } = toolsOf();
    expect((await tools.call('write_page', { fields: fieldsOf() })).isError).toBe(false);
    const page = sink.pages.get('docs/domains/ordering.md')!;
    const at = page.split('\n').findIndex((line) => line.trim() === '## For the developer');
    expect(at).toBeGreaterThan(0);
    const business = page.split('\n').slice(0, at).join('\n');
    const codeDetail = ['madarch:code.route:', 'madarch:code.symbol:', 'madarch:code.table:', 'madarch:code.channel:'];
    for (const kind of codeDetail) expect({ kind, held: business.includes(kind) }).toEqual({ kind, held: false });
    const developer = page.split('\n').slice(at).join('\n');
    for (const key of [ROUTE, HANDLER, TABLE]) expect(developer).toContain(`(madarch:${key})`);
    // The developer's places are the page's relates, and every one of them resolved at the write.
    const front = frontOf(page) as { relates: string[] };
    expect([...front.relates].sort()).toEqual([HANDLER, ORDERS, ROUTE, TABLE].sort());
    for (const key of front.relates) expect({ key, held: await view.graphKey(key) }).toEqual({ key, held: true });
  });

  test('a business field that names a place of the code is refused, with the field, the key and the section it belongs to', async () => {
    const { tools, sink } = toolsOf('ordering', { output: product });
    const answer = await tools.call('write_page', { fields: fieldsOf({ mainScenario: [{ text: 'The order is taken by the handler.', grounds: [ROUTE] }] }) });
    expect(answer.isError).toBe(true);
    const refused = (answer.answer as { refused: { rule: string; message: string }[] }).refused;
    expect(refused.map((entry) => entry.rule)).toEqual(['business-detail']);
    expect(refused[0]!.message).toContain('mainScenario[0]');
    expect(refused[0]!.message).toContain(ROUTE);
    expect(refused[0]!.message).toContain('developer');
    expect(sink.pages.size).toBe(0);
  });

  test('a place of the developer section that the graph does not hold is refused, with its key and the field', async () => {
    const { tools, sink } = toolsOf('ordering', { output: product });
    const answer = await tools.call('write_page', { fields: fieldsOf({ developer: { routes: [{ target: 'code.route:services/orders/internal/api/router.go#POST:/nowhere' }], notes: [] } }) });
    expect(answer.isError).toBe(true);
    expect((answer.answer as { refused: { rule: string }[] }).refused.map((entry) => entry.rule)).toEqual(['unresolved-place']);
    expect(sink.pages.size).toBe(0);
  });

  test('a place of another kind is refused: a function is not a route', async () => {
    const { tools } = toolsOf('ordering', { output: product });
    const answer = await tools.call('write_page', { fields: fieldsOf({ developer: { routes: [{ target: HANDLER }], notes: [] } }) });
    expect(answer.isError).toBe(true);
    expect((answer.answer as { refused: { rule: string }[] }).refused.map((entry) => entry.rule)).toEqual(['place-kind']);
  });
});

describe('what the documents leave unsaid is said, and never invented', () => {
  test('a statement with no ground is refused and nothing is written', async () => {
    const { tools, sink } = toolsOf('ordering', { output: product });
    const answer = await tools.call('write_page', { fields: fieldsOf({ participants: [{ text: 'A shopper places an order.', grounds: [] }] }) });
    expect(answer.isError).toBe(true);
    const refused = (answer.answer as { refused: { rule: string; message: string }[] }).refused;
    expect(refused.map((entry) => entry.rule)).toEqual(['field-ungrounded']);
    expect(refused[0]!.message).toContain('participants[0]');
    expect(sink.pages.size).toBe(0);
  });

  test('a section the documents settle nothing about says so, grounded on the domain evidence', async () => {
    const { tools, sink } = toolsOf();
    expect((await tools.call('write_page', { fields: fieldsOf({ rules: [], whatCanGoWrong: [], openPoints: [] }) })).isError).toBe(false);
    const page = sink.pages.get('docs/domains/ordering.md')!;
    expect(plain(sectionOf(page, 'Rules that govern it')!)).toContain('The documents name no rule that governs this domain.');
    expect(sectionOf(page, 'What can go wrong')).toContain('The documents and the graph say nothing about what can go wrong here.');
    expect(sectionOf(page, 'Open points')).toContain('The documents and the graph settle every point this page would leave open.');
    // Each gap is a statement: it ends in the footnote that lists the evidence it stands on.
    expect(sectionOf(page, 'Rules that govern it')).toMatch(/[.!?]\[\^[A-Za-z0-9_-]+\]$/);
  });

  test('a ground the documents do not hold is refused, whether a key or a section', async () => {
    const { tools } = toolsOf('ordering', { output: product });
    const missingSection = await tools.call('write_page', { fields: fieldsOf({ participants: [{ text: 'A shopper places an order.', grounds: ['code.file:docs/no-such-document.md'] }] }) });
    expect(missingSection.isError).toBe(true);
    expect((missingSection.answer as { refused: { rule: string }[] }).refused.map((entry) => entry.rule)).toEqual(['unresolved-ground']);
    const missingKey = await tools.call('write_page', { fields: fieldsOf({ participants: [{ text: 'A service takes the order.', grounds: ['code.service:nowhere'] }] }) });
    expect(missingKey.isError).toBe(true);
    expect((missingKey.answer as { refused: { rule: string }[] }).refused.map((entry) => entry.rule)).toEqual(['unresolved-ground']);
  });
});

describe('the domain unit writes from what the earlier units wrote', () => {
  test('the prompt hands the unit the enriched scenarios, rules and decisions it reads, and asks for the business first', async () => {
    const spec: Extract<UnitSpec, { kind: 'domain' }> = { kind: 'domain', id: 'domain:ordering', path: 'docs/domains/ordering.md', domain: { slug: 'ordering', title: 'Ordering', summary: 'Orders are placed by a shopper.', evidence: [ORDERS] } };
    const prompt = await domainPrompt(view, spec, 'The product page.', [{ slug: 'ordering', title: 'Ordering', summary: 'Orders are placed by a shopper.', evidence: [ORDERS] }], 'en', {
      reads: [
        { artifact: 'scenario-enrichments', kind: 'scenarios', path: 'docs/enrichment/uc-1.md', title: 'UC-1 A shopper places an order', text: '## Actor\n\nA shopper.[^1]\n' },
        { artifact: 'rule-enrichments', kind: 'rules-and-decisions', path: 'docs/enrichment/br-1.md', title: 'BR-1 An order is paid before it ships', text: '## Statement\n\nAn order is paid before it ships.[^1]\n' },
      ],
    });
    expect(prompt).toContain('UC-1 A shopper places an order');
    expect(prompt).toContain('BR-1 An order is paid before it ships');
    for (const field of ['participants', 'mainScenario', 'rules', 'whatCanGoWrong', 'openPoints', 'developer']) expect(prompt).toContain(field);
    // The page format the unit never writes is not in its prompt: the core writes the page from its fields.
    expect(prompt).not.toContain('## Example of a page');
    expect(prompt).toContain('## What the core writes for you');
  });
});
