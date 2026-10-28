/**
 * The structure a use case, a rule and a decision carry (decision 0032, section 1; madarch-ztyq.5), over the
 * generated training repository: the units of the writer answer with the fields of their passage's kind, and
 * the page the core writes beside the person's document is the kind's own sections — a use case its actor,
 * goal, preconditions, main and alternative flows, the rules that govern it and what implements it; a rule its
 * statement, where it applies and its exceptions; a decision its status, context, decision and consequences.
 *
 * The scripted agent resolves every place through the writer's own tools (`find_nodes`, and the readers
 * `get_symbol` and `trace_flow` answer with): no model runs. What the test expects is the answer key's flows
 * and the generated repository's own declarations — the route `POST /orders`, its handler, `writes orders`,
 * `publishes orders.events` — never the writer's output. The person's documents are hashed before and after the
 * run: an enrichment stands beside them and never in them, and the engine draws a use case's sequence diagram
 * from the route the page relates (`:::sequence`, decision 0032, section 8).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { createPGliteDatabaseOwner, type DatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore, type GraphStore } from '../src/graph/index.js';
import type { RenderContext } from '../src/knowledge/blocks.js';
import { readDocEntities, type DocEntity } from '../src/knowledge/doc-entities.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { KINDS_FILE, readKinds, type KindsManifest } from '../src/knowledge/kinds.js';
import { readMarkdownEntities, type MarkdownEntity } from '../src/knowledge/markdown.js';
import type { Block, PageModel } from '../src/knowledge/model.js';
import { renderPage } from '../src/knowledge/render.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import type { ViewPayload } from '../src/knowledge/views.js';
import {
  GraphView, UnitTools, enrichmentPageId, enrichmentPath, fsSink, memorySink, renderStructuredBody, runWriter,
  structuredKindOf, type UnitAgent, type UnitRequest, type WriterReport,
} from '../src/writer/index.js';
import { DEFAULT_UNIT_BOUNDS, type PageSink } from '../src/writer/tools.js';
import { ROOT, generateTrainingRepository, makeProduct } from './knowledge-fixture.js';

const KEY = JSON.parse(readFileSync(join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as { snapshots: Record<string, string> };

// ---- the fixture: the training repository, a product beside it, and the graph of both ----------------

let scratch: string;
let repository: string;
let product: string;
let owner: DatabaseOwner;
let store: GraphStore;
let view: GraphView;
let entities: DocEntity[];
let report: WriterReport;
/** The bytes of every Markdown document of the person, before the writer ran. */
let documentsBefore: Map<string, string>;

/** The Markdown documents of a folder, `/`-separated, in code point order: the person's documents, never the product's pages. */
function markdownUnder(folder: string, root = folder): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (name === '.git' || name === 'node_modules' || name === 'repos') return [];
    if (statSync(path).isDirectory()) return markdownUnder(path, root);
    return /\.(md|markdown)$/i.test(name) ? [path.slice(root.length + 1).split('\\').join('/')] : [];
  }).sort();
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The product's manifest of kinds, which every page the writer writes is judged by; a product without one has no pages at all. */
function manifestOf(folder: string): KindsManifest {
  const read = readKinds(folder);
  if (!read.present) throw new Error(`${join(folder, KINDS_FILE)}:1: the product has no manifest of kinds (${read.file}), so the wiki shows no page`);
  return read.manifest;
}

/**
 * Gives the product the starter set and then declares the enrichment kind, which is what makes the writer run
 * its enrichment units at all (decision 0029: a page of a kind the manifest does not declare is a page no reader
 * could open). Its template draws the sequence diagram from the route the page relates — the engine's own path
 * (decision 0032, section 8), not a picture the writer concatenates into the page.
 */
function declareEnrichmentPages(folder: string): void {
  seedStarterSet(folder);
  const file = join(folder, KINDS_FILE);
  const manifest = parseDocument(readFileSync(file, 'utf8'));
  manifest.setIn(['kinds', 'enrichment'], {
    template: 'templates/enrichment.md', source: 'markdown', folder: 'docs/enrichment', origin: 'agent',
    labels: { en: { one: 'Enrichment', many: 'Enrichments' }, ru: { one: 'Обогащение', many: 'Обогащения' } },
  });
  writeFileSync(file, manifest.toString());
  writeFileSync(join(folder, 'templates/enrichment.md'), ':::body\n:::sequence\n');
  if (!manifestOf(folder).kinds.has('enrichment')) throw new Error(`${join(folder, KINDS_FILE)}:1: the fixture manifest does not declare the enrichment kind`);
}

/** The product's own pages, as the two units that write them would leave them: the enrichments are this test's subject. */
const PRODUCT_PAGE = [
  '---', 'id: product:training-shop', 'kind: product', 'title: Training shop', 'relates:', '  - code.service:orders', '  - code.service:payments',
  'producer: agent', 'sources: [docs/requirements.md]', '---', '',
  'The training shop takes orders from shoppers and charges their cards.[^1]', '',
  '## Domains', '',
  '- [Ordering](madarch:domain:ordering)[^2]', '- [Payments](madarch:domain:payments)[^3]', '',
  '[^1]: [orders](madarch:code.service:orders), [payments](madarch:code.service:payments)',
  '[^2]: [orders](madarch:code.service:orders)',
  '[^3]: [payments](madarch:code.service:payments)',
].join('\n');

const domainPage = (slug: string, title: string, service: string, statement: string): string => [
  '---', `id: domain:${slug}`, 'kind: domain', `title: ${title}`, 'relates:', `  - ${service}`, 'producer: agent', 'sources: [docs/requirements.md]', '---', '',
  `${statement}[^1]`, '', `[^1]: [${service.replace('code.service:', '')}](madarch:${service})`,
].join('\n');

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'madarch-writer-structured-'));
  repository = generateTrainingRepository(join(scratch, 'repository'));
  mkdirSync(join(scratch, 'home'));
  product = makeProduct(join(scratch, 'home'), 'training-shop', repository);
  declareEnrichmentPages(product);
  mkdirSync(join(product, 'docs', 'domains'), { recursive: true });
  writeFileSync(join(product, 'docs/product.md'), PRODUCT_PAGE);
  writeFileSync(join(product, 'docs/domains/ordering.md'), domainPage('ordering', 'Ordering', 'code.service:orders', 'Orders are placed by a signed-in shopper.'));
  writeFileSync(join(product, 'docs/domains/payments.md'), domainPage('payments', 'Payments', 'code.service:payments', 'Payments are taken through a provider chosen by configuration.'));
  // The person's documents are the repository's own: they are read as entities, and nothing the writer does may change a byte.
  documentsBefore = new Map(markdownUnder(repository).map((path) => [path, readFileSync(join(repository, path), 'utf8')]));
  owner = createPGliteDatabaseOwner({ btreeGist: true, path: join(scratch, 'store') });
  store = createGraphStore(owner);
  await owner.ready;
  await store.createSchema();
  await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: KEY.snapshots });
  view = await GraphView.open(owner, store);
  const manifest = manifestOf(product);
  entities = readDocEntities([...documentsBefore].map(([path, text]) => ({ repo: 'training', path, text })), manifest).entities;
}, 1_800_000);

afterAll(async () => {
  await owner?.close();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
}, 120_000);

// ---- the scripted agent ------------------------------------------------------------------------------

/**
 * A place a unit names: the graph kind it is, and the searches that find it — a search text and the end of the
 * key it must have, tried in order, so a key shape this test did not guess costs a second search rather than a
 * whole run. Nothing is guessed: a place no search finds fails the run loudly.
 */
interface Place { readonly field: 'routes' | 'functions' | 'tables' | 'events'; readonly kind: string; readonly attempts: readonly { readonly search: string; readonly endsWith: string }[] }
/** What one passage of the documents is implemented by, and the rules that govern it: the training repository's own facts. */
interface Plan { readonly places: readonly Place[]; readonly rules?: readonly string[] }

const place = (field: Place['field'], kind: string, name: string, ...attempts: { search: string; endsWith: string }[]): Place => ({ field, kind, attempts: attempts.length === 0 ? [{ search: name, endsWith: name }] : attempts });
/** A route: its registered form `POST /path`, and the tail a mounted registration may be composed to. */
const route = (path: string): Place => place('routes', 'code.route', `POST:${path}`, { search: `POST:${path}`, endsWith: `POST:${path}` }, { search: path, endsWith: path });
/** A function or a method of the code, by its qualified name. */
const fn = (name: string): Place => place('functions', 'code.symbol', name, { search: name, endsWith: `#${name}` }, { search: name.slice(name.lastIndexOf('.') + 1), endsWith: `.${name}` });
const table = (name: string): Place => place('tables', 'code.table', name);
const event = (topic: string): Place => place('events', 'code.channel', topic);

const PLANS: Readonly<Record<string, Plan>> = {
  'UC-1': { places: [route('/orders'), fn('OrderHandlers.Create'), fn('Service.Place'), fn('OrderRepository.Create'), table('public.orders'), event('orders.events')], rules: ['br-1', 'br-2', 'br-3'] },
  'UC-2': { places: [route('/payments'), fn('PaymentService.pay'), fn('capture'), table('public.payments'), event('payments.events')], rules: ['br-3'] },
  'UC-3': { places: [route('/refunds'), fn('PaymentService.refund'), fn('checkRefund'), table('public.refunds')], rules: ['br-4'] },
  'UC-4': { places: [route('/internal/apply'), fn('clamp')], rules: ['br-5'] },
  'BR-1': { places: [fn('Discount'), fn('discountFor')] },
  'BR-2': { places: [fn('Tax'), fn('previewTotal')] },
  'BR-3': { places: [fn('PaymentService.pay')] },
  'BR-4': { places: [fn('checkRefund'), fn('PaymentService.refund')] },
  'BR-5': { places: [fn('clamp')] },
  'ADR-0001': { places: [fn('KafkaPublisher.Publish'), fn('Relay.Flush'), table('public.outbox'), event('orders.events')] },
  'ADR-0002': { places: [fn('OutboxWriter.Write'), fn('OrderRepository.Create'), table('public.outbox')] },
};

/** The key of a place, searched in the graph the way a unit searches it: nothing is written where no search finds it. */
async function findPlace(request: UnitRequest, place: Place): Promise<string> {
  const answered: string[] = [];
  for (const attempt of place.attempts) {
    const answer = await request.tools.call('find_nodes', { kind: place.kind, text: attempt.search, limit: 40 });
    const nodes = (answer.answer as { nodes: { key: string; label: string }[] }).nodes;
    answered.push(...nodes.map((node) => node.key));
    const hit = nodes.find((node) => node.key.endsWith(attempt.endsWith));
    if (hit !== undefined) return hit.key;
  }
  throw new Error(`the graph of the training fixture holds no ${place.kind} whose key ends with ${JSON.stringify(place.attempts.map((attempt) => attempt.endsWith))}; find_nodes answered: ${answered.join(', ') || 'nothing'}`);
}

/** The English fields of a scenario of the training repository's requirements, one per use case. */
const SCENARIO_TEXT: Readonly<Record<string, { actor: string; goal: string; preconditions: readonly string[]; mainFlow: readonly string[]; alternativeFlows: readonly { when: string; steps: readonly string[] }[] }>> = {
  'UC-1': {
    actor: 'A shopper who is signed in places an order.', goal: 'The shopper has an order they can pay for.',
    preconditions: ['The shopper is signed in.'],
    mainFlow: ['The shopper submits the cart.', 'The order is stored with the status pending payment.'],
    alternativeFlows: [{ when: 'The same request id is sent again.', steps: ['The order placed first is returned.'] }],
  },
  'UC-2': {
    actor: 'Checkout asks for the money when the order is placed.', goal: 'The card is charged for the order and the payment says so.',
    preconditions: ['The order is placed and its total is known.'],
    mainFlow: ['Checkout asks the payment service to authorize the card.', 'A captured payment confirms the order.'],
    alternativeFlows: [{ when: 'The provider declines the card.', steps: ['The order is cancelled and the shopper is told why.'] }],
  },
  'UC-3': {
    actor: 'A support agent refunds a payment.', goal: 'The money goes back to the card of the shopper.',
    preconditions: ['The payment was captured.'],
    mainFlow: ['The agent asks for a refund of a part or of all of the payment.', 'The refund is recorded against the payment.'],
    alternativeFlows: [{ when: 'The refund brings the refunded total up to the captured amount.', steps: ['The order is marked as refunded.'] }],
  },
  'UC-4': {
    actor: 'A shopper applies a promotion code.', goal: 'The discount the code gives is taken off the order before the payment.',
    preconditions: [],
    mainFlow: ['The shopper enters the code.', 'The discount the code gives is taken off the order.'],
    alternativeFlows: [],
  },
};

/** The English fields of a rule of the requirements, one per rule. */
const RULE_TEXT: Readonly<Record<string, { statement: string; applies: readonly string[]; exceptions: readonly string[] }>> = {
  'BR-1': { statement: 'A discount is a percentage the caller chooses, taken off every line of the order.', applies: ['The orders service applies the percentage it is given and chooses none itself.'], exceptions: [] },
  'BR-2': { statement: 'Sales tax is eight per cent of a line after its discount, rounded to the cent.', applies: ['Every line of an order is taxed unless it is zero-rated.'], exceptions: ['A zero-rated line pays no tax.'] },
  'BR-3': { statement: 'A payment made with an idempotency key that was used before returns the first payment.', applies: ['The card is charged once for one key.'], exceptions: [] },
  'BR-4': { statement: 'Only a captured payment is refunded, for a positive amount, within thirty days and never beyond what was captured.', applies: ['A refund of a payment is checked before it is made.'], exceptions: ['A payment that was not captured is not refunded.'] },
  'BR-5': { statement: 'A promotion never takes off more than the subtotal of the order.', applies: ['The discount of a promotion is clamped to the subtotal.'], exceptions: [] },
};

/** The English fields of a decision of the repository's architecture records, one per record. */
const DECISION_TEXT: Readonly<Record<string, { status: string; context: readonly string[]; decision: readonly string[]; consequences: readonly string[] }>> = {
  'ADR-0001': {
    status: 'The record says the decision is accepted.', context: ['Orders and payments tell each other what happened without calling each other.'],
    decision: ['Both services publish to their own Kafka topic.'],
    consequences: ['A consumer must tolerate a message delivered twice.'],
  },
  'ADR-0002': {
    status: 'The record says the decision is accepted.', context: ['A change of an order and its message must not part company.'],
    decision: ['The message is written to the outbox in the same transaction as the change of the order.'],
    consequences: ['A separate process publishes what the outbox holds.'],
  },
};

/** The passage a page stands on, as the writer's own documents name it. */
const passageOf = (entity: DocEntity): string => `doc:${entity.path}#${entity.anchor}`;

/**
 * The fields of a passage this test planned, or the plain ones of a passage it did not: a document entity the
 * fixture holds that the plan does not name still gets a page, and the page says of its own passage what the
 * document does not settle. Nothing is left unanswered, so no unit of the run ends without its page.
 */
async function fieldsOf(request: UnitRequest, entity: DocEntity): Promise<Record<string, unknown>> {
  const passage = passageOf(entity);
  const plan = PLANS[entity.identifier ?? ''];
  if (plan === undefined) {
    const grounded = (text: string): Record<string, unknown> => ({ text, grounds: [passage] });
    if (entity.semantics === 'scenario') return { title: entity.title, actor: grounded('The document does not say who does this.'), goal: grounded('The document does not say what this is for.'), mainFlow: [grounded('The document describes this passage and the graph names nothing it reaches.')] };
    if (entity.semantics === 'rule') return { title: entity.title, statement: grounded('The document states this passage as a rule.') };
    return { title: entity.title, status: grounded('The document gives this record no status the reader can act on.'), decision: [grounded('The document states this passage as a decision.')] };
  }
  const grounded = (text: string): Record<string, unknown> => ({ text, grounds: [passage] });
  const implementation: Record<string, unknown> = {};
  for (const place of plan.places) {
    const key = await findPlace(request, place);
    const held = (implementation[place.field] ?? []) as unknown[];
    implementation[place.field] = [...held, { target: key }];
  }
  if (entity.semantics === 'scenario') {
    const text = SCENARIO_TEXT[entity.identifier!];
    if (text === undefined) throw new Error(`the scripted agent has no scenario text for ${entity.identifier}`);
    return {
      title: entity.title,
      actor: grounded(text.actor),
      goal: grounded(text.goal),
      preconditions: text.preconditions.map(grounded),
      mainFlow: text.mainFlow.map(grounded),
      alternativeFlows: text.alternativeFlows.map((flow) => ({ when: grounded(flow.when), steps: flow.steps.map(grounded) })),
      rules: (plan.rules ?? []).map((id) => ({ target: `doc:docs/requirements.md#${id}` })),
      implementation,
    };
  }
  if (entity.semantics === 'rule') {
    const text = RULE_TEXT[entity.identifier!];
    if (text === undefined) throw new Error(`the scripted agent has no rule text for ${entity.identifier}`);
    return { title: entity.title, statement: grounded(text.statement), applies: text.applies.map(grounded), exceptions: text.exceptions.map(grounded), implementation };
  }
  const text = DECISION_TEXT[entity.identifier!];
  if (text === undefined) throw new Error(`the scripted agent has no decision text for ${entity.identifier}`);
  return { title: entity.title, status: grounded(text.status), context: text.context.map(grounded), decision: text.decision.map(grounded), consequences: text.consequences.map(grounded), implementation };
}

/** An agent that answers every enrichment unit with its passage's fields and refuses one it has no plan for. */
function scripted(): UnitAgent {
  return {
    run: async (request) => {
      const entity = entities.find((candidate) => `enrichment:${candidate.id}` === request.id);
      if (entity === undefined) throw new Error(`the scripted agent was asked for ${request.id}, which is no enrichment of the documents`);
      const written = await request.tools.call('write_enrichment', await fieldsOf(request, entity));
      expect(written.isError, `${request.id}: ${JSON.stringify(written.answer)}`).toBe(false);
    },
  };
}

/** The product's manifest and its Markdown pages, read once: what the engine renders a page from. */
let rendered: { manifest: KindsManifest; markdown: Map<string, MarkdownEntity>; context: RenderContext } | undefined;

/**
 * Renders one of the writer's pages the way the wiki renders it: the product's manifest, its templates and its
 * Markdown pages over the same graph the units read. The sequence diagram of a page is the engine's own block,
 * drawn from the routes the page relates — nothing the writer wrote is drawn as a picture by the writer itself.
 */
async function renderModel(id: string): Promise<PageModel> {
  if (rendered === undefined) {
    const manifest = manifestOf(product);
    const documents = [...documentsBefore].map(([path, text]) => ({ repo: 'training', path, text }));
    const docs = readDocEntities(documents, manifest);
    const markdown = new Map<string, MarkdownEntity>(readMarkdownEntities(product, manifest).entities.map((entity) => [entity.id, entity]));
    const graph = new GraphReader(owner, () => view.at);
    const resolver = new Resolver({
      graph,
      markdown,
      declared: (kind) => manifest.kinds.has(kind),
      readDocument: async (repo, path) => (repo === null ? undefined : documents.find((document) => document.path === path)?.text),
      repositories: () => ['training'],
      locate: () => undefined,
      documentEntity: (repo, path, line) => docs.entities.find((entity) => entity.repo === repo && entity.path === path && entity.line === line),
    });
    const context: RenderContext = {
      productFolder: product, manifest, graph, markdown,
      docEntities: new Map(docs.entities.map((entity) => [entity.id, entity])),
      localizedSources: new Map(), language: 'en', documents, repositories: ['training'],
      commitOf: () => null, resolver, repoOfScope: () => 'training',
      readSource: async (repo, path) => (repo === null ? undefined : documents.find((document) => document.path === path)?.text),
    };
    rendered = { manifest, markdown, context };
  }
  const result = await renderPage(rendered.context, id);
  if (!result.ok) throw new Error(`no page for ${id}: ${result.message}`);
  return result.page;
}

// ---- the run -----------------------------------------------------------------------------------------

beforeAll(async () => {
  report = await runWriter({
    owner, store, repository, output: product, productName: 'Training shop', agent: scripted(),
    documentEntities: entities, sink: fsSink(product), language: 'en',
  });
}, 900_000);

/** The page of an entity's enrichment, as it was written. */
const pageOf = (entity: DocEntity): string => readFileSync(join(product, enrichmentPath(entity)), 'utf8');

/** The front matter of a page, as the reader parses it: what the page says about itself. */
function frontOf(page: string): Record<string, unknown> {
  const end = page.indexOf('\n---', 4);
  const raw = page.startsWith('---\n') && end > 0 ? page.slice(4, end) : '';
  const parsed: unknown = parseYaml(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`the page has no front matter: ${page.slice(0, 80)}`);
  return parsed as Record<string, unknown>;
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

const useCases = (): DocEntity[] => entities.filter((entity) => entity.semantics === 'scenario');
const rules = (): DocEntity[] => entities.filter((entity) => entity.semantics === 'rule');
const decisions = (): DocEntity[] => entities.filter((entity) => entity.semantics === 'decision');
/** The passages this test planned: the product's own use cases, rules and records, whose places the plan names. */
const planned = (list: readonly DocEntity[]): DocEntity[] => list.filter((entity) => PLANS[entity.identifier ?? ''] !== undefined);

describe('the structure of every use case of the training product', () => {
  test('each use case has a page of its own, beside the document and keyed by the passage it enriches', () => {
    expect(useCases().map((entity) => entity.identifier ?? '').filter((identifier) => identifier !== '')).toEqual(expect.arrayContaining(['UC-1', 'UC-2', 'UC-3', 'UC-4']));
    for (const entity of planned(useCases())) {
      const page = pageOf(entity);
      const front = frontOf(page);
      expect(front['id']).toBe(enrichmentPageId(entity));
      expect(front['enriches']).toBe(entity.id);
      // The document is the repository's, and the page says where it stands: the document's own path inside its repository.
      expect(front['source-document']).toBe(entity.repo === null ? entity.path : `repos/${entity.repo}/${entity.path}`);
      expect(front['producer']).toBe('agent');
      expect(front['source-line']).toBe(entity.line);
      expect(page).not.toContain(entity.text.trim());
    }
  });

  test('a use case carries its actor, goal, preconditions, main flow, alternative flows, its rules and its implementation', () => {
    for (const entity of planned(useCases())) {
      const page = pageOf(entity);
      for (const heading of ['Actor', 'Goal', 'Preconditions', 'Main flow', 'Alternative flows', 'Rules that govern it', 'Implementation']) {
        expect({ useCase: entity.identifier, heading, section: sectionOf(page, heading) === undefined ? 'missing' : 'there' }).toEqual({ useCase: entity.identifier, heading, section: 'there' });
      }
      // The sections stand in the order of the kind's declaration, and each holds a grounded statement.
      const order = ['Actor', 'Goal', 'Preconditions', 'Main flow', 'Alternative flows', 'Rules that govern it', 'Implementation'].map((heading) => page.indexOf(`## ${heading}`));
      expect(order).toEqual([...order].sort((left, right) => left - right));
      expect(sectionOf(page, 'Actor')).toMatch(/\[\^[A-Za-z0-9_-]+\]$/m);
      // A use case whose document names no precondition or no alternative flow says so, rather than holding an empty heading.
      if (entity.identifier === 'UC-4') {
        expect(sectionOf(page, 'Preconditions')).toContain('The document names no precondition for this use case.');
        expect(sectionOf(page, 'Alternative flows')).toContain('The document describes no alternative flow for this use case.');
      }
    }
  });

  test('every use case links its route, its functions, the tables and events it reaches, and the rules that govern it', async () => {
    for (const entity of planned(useCases())) {
      const plan = PLANS[entity.identifier!]!;
      const page = pageOf(entity);
      const links = [...page.matchAll(/\]\(madarch:([^)\s]+)\)/g)].map((match) => match[1]!);
      for (const place of plan.places) {
        const wanted = links.some((target) => target.startsWith(`${place.kind}:`) && place.attempts.some((attempt) => target.endsWith(attempt.endsWith)));
        const named = place.attempts.map((attempt) => attempt.endsWith).join(' | ');
        expect({ useCase: entity.identifier, place: named, found: wanted }).toEqual({ useCase: entity.identifier, place: named, found: true });
      }
      for (const rule of plan.rules ?? []) {
        expect({ useCase: entity.identifier, rule, linked: links.includes(`doc:docs/requirements.md#${rule}`) }).toEqual({ useCase: entity.identifier, rule, linked: true });
        // The rule's section is a place of the graph the link resolves against, not a name the agent wrote.
        expect(await view.docSection('docs/requirements.md', rule)).toBe(true);
      }
      // Every link of the page is a place the graph holds: nothing the agent named went unchecked.
      for (const target of links) {
        if (target.startsWith('doc:')) {
          const [path, anchor] = [target.slice('doc:'.length).split('#')[0]!, target.split('#')[1]!];
          expect({ target, resolves: await view.docSection(path!, anchor) }).toEqual({ target, resolves: true });
        } else if (target !== enrichmentPageId(entity)) {
          expect({ target, resolves: await view.graphKey(target) }).toEqual({ target, resolves: true });
        }
      }
    }
  });

  test('every use case carries a sequence diagram the engine draws from the route it relates', async () => {
    for (const entity of planned(useCases())) {
      const page = pageOf(entity);
      const front = parseYaml(page.split('---')[1]!) as { relates?: string[] };
      const routeKey = (front.relates ?? []).find((key) => key.startsWith('code.route:'));
      expect({ useCase: entity.identifier, route: routeKey === undefined ? 'none related' : 'related' }).toEqual({ useCase: entity.identifier, route: 'related' });
      const model = await renderModel(enrichmentPageId(entity));
      const sequences = model.blocks.flatMap((block) => (block.type === 'diagrams' ? block.views : [])).filter((candidate: ViewPayload) => candidate.spec.type === 'sequence');
      expect({ useCase: entity.identifier, diagrams: sequences.length > 0 }).toEqual({ useCase: entity.identifier, diagrams: true });
      const drawn = sequences.find((candidate: ViewPayload) => candidate.spec.entry === routeKey)!;
      // The chain starts at the route, reaches the handler and what it calls, and writes or publishes what the graph says.
      const steps = drawn.edges.map((edge) => edge.label);
      expect(steps[0]).toBe(routeKey!.slice(routeKey!.indexOf('#') + 1).replace(':', ' '));
      expect(steps.length).toBeGreaterThan(1);
      if (entity.identifier === 'UC-1') {
        // The answer key's flow of POST /orders: the handler, the use case, the table it writes and the topic it publishes.
        const reaches = (step: string): boolean => steps.some((label) => label === step || label.endsWith(`.${step}`));
        for (const step of ['OrderHandlers.Create', 'Service.Place', 'writes orders', 'publishes orders.events']) expect({ step, reaches: reaches(step) }).toEqual({ step, reaches: true });
        // The diagram writes a table and publishes a topic: the chain's own step kinds, not words of the writer.
        expect(drawn.edges.some((edge) => edge.kind === 'write')).toBe(true);
        expect(drawn.edges.some((edge) => edge.kind === 'publish')).toBe(true);
      }
    }
  }, 240_000);
});

describe('the structure of every rule and every decision', () => {
  test('a rule carries its statement, where it applies and its exceptions', () => {
    expect(rules().map((entity) => entity.identifier ?? '').filter((identifier) => identifier !== '')).toEqual(expect.arrayContaining(['BR-1', 'BR-2', 'BR-3', 'BR-4', 'BR-5']));
    for (const entity of planned(rules())) {
      const page = pageOf(entity);
      for (const heading of ['Statement', 'Where it applies', 'Exceptions', 'Implementation']) expect({ rule: entity.identifier, heading, section: sectionOf(page, heading) === undefined ? 'missing' : 'there' }).toEqual({ rule: entity.identifier, heading, section: 'there' });
      expect(sectionOf(page, 'Statement')).toMatch(/\[\^[A-Za-z0-9_-]+\]$/m);
      // A rule the document gives no exception for says so.
      if (entity.identifier === 'BR-1' || entity.identifier === 'BR-3' || entity.identifier === 'BR-5') expect(sectionOf(page, 'Exceptions')).toContain('The document names no exception to this rule.');
    }
  });

  test('both architecture records keep Status, Context, Decision and Consequences, and link what carries them out', async () => {
    expect(decisions().map((entity) => entity.identifier ?? '').filter((identifier) => identifier !== '')).toEqual(expect.arrayContaining(['ADR-0001', 'ADR-0002']));
    for (const entity of planned(decisions())) {
      const page = pageOf(entity);
      for (const heading of ['Status', 'Context', 'Decision', 'Consequences', 'Implementation']) expect({ record: entity.identifier, heading, section: sectionOf(page, heading) === undefined ? 'missing' : 'there' }).toEqual({ record: entity.identifier, heading, section: 'there' });
      const links = [...page.matchAll(/\]\(madarch:([^)\s]+)\)/g)].map((match) => match[1]!);
      expect(links.some((target) => target.startsWith('code.symbol:'))).toBe(true);
      for (const target of links) {
        if (target.startsWith('code.')) expect({ record: entity.identifier, target, resolves: await view.graphKey(target) }).toEqual({ record: entity.identifier, target, resolves: true });
      }
      // The person's own record is still the record: its Status, Context, Decision and Consequences are its own text, untouched.
      const document = documentsBefore.get(entity.path)!;
      for (const heading of ['Status:', '## Context', '## Decision', '## Consequences']) expect(document).toContain(heading);
      expect(readFileSync(join(repository, entity.path), 'utf8')).toBe(document);
    }
  });

  test('the pages of a rule and of a decision are keyed by their passage and store no copy of the person\'s words', () => {
    for (const entity of [...rules(), ...decisions()]) {
      const page = pageOf(entity);
      expect(frontOf(page)['id']).toBe(enrichmentPageId(entity));
      expect(frontOf(page)['enriches']).toBe(entity.id);
      expect(page).not.toContain(entity.text.trim());
    }
  });
});

describe('the person\'s documents and the run', () => {
  test('every unit ran and wrote, and none of them changed a document of the person', () => {
    expect(report.ok, JSON.stringify({ graph: report.graph, loopProblems: report.loopProblems, stateProblems: report.stateProblems })).toBe(true);
    expect(report.graph.map((kind) => `${kind.kind} ${kind.state}`)).toEqual(expect.arrayContaining(['rules-and-decisions ran', 'scenarios ran']));
    for (const [path, text] of documentsBefore) expect({ path, sha: sha(readFileSync(join(repository, path), 'utf8')) }).toEqual({ path, sha: sha(text) });
    // Every passage with a structure of its own has its page, stored apart from the documents, under the folder the writer owns.
    const structured = entities.filter((entity) => structuredKindOf(entity.semantics) !== undefined);
    expect(structured.length).toBeGreaterThanOrEqual(planned(useCases()).length + planned(rules()).length + planned(decisions()).length);
    for (const entity of structured) {
      expect({ entity: entity.id, written: report.enrichments.some((outcome) => outcome.path === enrichmentPath(entity) && outcome.status === 'written') }).toEqual({ entity: entity.id, written: true });
    }
    for (const outcome of report.enrichments) expect({ path: outcome.path, apart: outcome.path.startsWith('docs/enrichment/') }).toEqual({ path: outcome.path, apart: true });
  });

  test('no page of the writer stands in the path of a document', () => {
    for (const [path] of documentsBefore) expect({ path, page: report.enrichments.some((outcome) => outcome.path === path) }).toEqual({ path, page: false });
  });
});

// ---- the page a unit writes, without a run of the writer --------------------------------------------

/** One scenario's entities, as the writer's tools see them: a use case of the training repository. */
const uc1 = (): DocEntity => {
  const found = entities.find((entity) => entity.identifier === 'UC-1');
  if (found === undefined) throw new Error('the documents of the training repository hold no UC-1');
  return found;
};

/** The tools of one enrichment unit over the fixture's graph, writing into a sink of its own. */
async function toolsOf(entity: DocEntity, extras: { language?: string; output?: string } = {}): Promise<{ tools: UnitTools; sink: PageSink & { pages: Map<string, string> } }> {
  const sink = memorySink();
  const tools = new UnitTools(
    view,
    { kind: 'enrichment', id: `enrichment:${entity.id}`, path: enrichmentPath(entity), entity, task: 'report what the passage is' },
    sink, [], DEFAULT_UNIT_BOUNDS, [], extras,
  );
  return { tools, sink };
}

const grounded = (text: string, ground: string): Record<string, unknown> => ({ text, grounds: [ground] });

describe('a page in the wiki\'s language', () => {
  test('the sections and the title are written in Russian for a Russian wiki, from the same fields', async () => {
    const entity = uc1();
    const passage = passageOf(entity);
    const { tools, sink } = await toolsOf(entity, { language: 'ru' });
    const answer = await tools.call('write_enrichment', {
      title: 'UC-1 Оформление заказа',
      actor: grounded('Покупатель с активной сессией оформляет заказ.', passage),
      goal: grounded('Покупатель получает заказ, который может оплатить.', passage),
      preconditions: [grounded('Покупатель вошёл в систему.', passage)],
      mainFlow: [grounded('Покупатель отправляет корзину.', passage)],
      alternativeFlows: [{ when: grounded('Тот же идентификатор запроса приходит снова.', passage), steps: [grounded('Возвращается первый заказ.', passage)] }],
      rules: [{ target: 'doc:docs/requirements.md#br-3' }],
      implementation: { routes: [{ target: 'code.route:services/orders/internal/api/router.go#POST:/orders' }] },
    });
    expect(answer.isError, JSON.stringify(answer.answer)).toBe(false);
    const page = sink.pages.get(enrichmentPath(entity))!;
    const front = parseYaml(page.split('---')[1]!) as { title: string };
    expect(front.title).toBe('UC-1 Оформление заказа');
    for (const heading of ['Актор', 'Цель', 'Предусловия', 'Основной поток', 'Альтернативные потоки', 'Правила, которые действуют', 'Реализация']) expect({ heading, section: sectionOf(page, heading) === undefined ? 'missing' : 'there' }).toEqual({ heading, section: 'there' });
    // The places are shown by the graph's own names, whatever language the page is written in.
    expect(page).toContain('(madarch:code.route:services/orders/internal/api/router.go#POST:/orders)');
    expect(page).toContain('(madarch:doc:docs/requirements.md#br-3)');
  });
});

describe('what the page says where nothing was found, and what is refused', () => {
  test('a use case whose passage names no place states the gap on the passage, and links nothing it did not resolve', async () => {
    const entity = uc1();
    const passage = passageOf(entity);
    const { tools, sink } = await toolsOf(entity);
    const answer = await tools.call('write_enrichment', {
      actor: grounded('Покупатель оформляет заказ.', passage),
      goal: grounded('Покупатель получает заказ.', passage),
      mainFlow: [grounded('Покупатель отправляет корзину.', passage)],
    });
    expect(answer.isError, JSON.stringify(answer.answer)).toBe(false);
    const page = sink.pages.get(enrichmentPath(entity))!;
    expect(sectionOf(page, 'Preconditions')).toContain('The document names no precondition for this use case.');
    expect(sectionOf(page, 'Alternative flows')).toContain('The document describes no alternative flow for this use case.');
    expect(sectionOf(page, 'Rules that govern it')).toContain('The document names no rule that governs this use case.');
    expect(sectionOf(page, 'Implementation')).toContain('The graph holds no route and no function for this use case.');
    // Each gap stands on the passage: a gap is a statement, not a silence.
    expect(page).toContain('(madarch:doc:docs/requirements.md#uc-1)');
    expect(page).not.toContain('madarch:code.');
  });

  test('a place the graph does not hold is refused with its key and the tool that answers it, and nothing is written', async () => {
    const entity = uc1();
    const passage = passageOf(entity);
    const { tools, sink } = await toolsOf(entity, { output: product });
    const answer = await tools.call('write_enrichment', {
      actor: grounded('Покупатель оформляет заказ.', passage),
      goal: grounded('Покупатель получает заказ.', passage),
      mainFlow: [grounded('Покупатель отправляет корзину.', passage)],
      implementation: { routes: [{ target: 'code.route:services/orders/internal/api/router.go#POST:/nowhere' }] },
    });
    expect(answer.isError).toBe(true);
    const refused = (answer.answer as { refused: { rule: string; message: string }[] }).refused;
    expect(refused.map((entry) => entry.rule)).toEqual(['unresolved-place']);
    expect(refused[0]!.message).toContain('POST:/nowhere');
    expect(refused[0]!.message).toContain('trace_flow');
    // A rule is named by its section, never by a key: a place of another shape is refused with the way to the right one.
    const wrongRule = await tools.call('write_enrichment', {
      actor: grounded('Покупатель оформляет заказ.', passage),
      goal: grounded('Покупатель получает заказ.', passage),
      mainFlow: [grounded('Покупатель отправляет корзину.', passage)],
      rules: [{ target: 'code.symbol:services/orders/internal/pricing/pricing.go#Discount' }],
    });
    expect(wrongRule.isError).toBe(true);
    expect(JSON.stringify(wrongRule.answer)).toContain('doc:<path>#<anchor>');
    expect(sink.pages.size).toBe(0);
    expect(tools.outcome().status).toBe('failed');
  });

  test('the body says what a route reaches no function of, and the diagram is never drawn from what the graph does not state', () => {
    const entity = uc1();
    const fields = {
      actor: { text: 'A shopper places an order.', grounds: [passageOf(entity)] },
      goal: { text: 'The shopper has an order.', grounds: [passageOf(entity)] },
      mainFlow: [{ text: 'The shopper submits the cart.', grounds: [passageOf(entity)] }],
      preconditions: [], alternativeFlows: [], rules: [],
      implementation: { routes: [{ target: 'code.route:services/orders/internal/api/router.go#POST:/orders' }] },
    };
    const rendered = renderStructuredBody('scenario', fields, {
      language: 'en',
      labelOf: (target) => (target === 'code.route:services/orders/internal/api/router.go#POST:/orders' ? 'POST /orders' : undefined),
      passage: passageOf(entity),
      unreachedRoutes: ['code.route:services/orders/internal/api/router.go#POST:/orders'],
    });
    expect(rendered.body).toContain('The route [POST /orders](madarch:code.route:services/orders/internal/api/router.go#POST:/orders) reaches no function of the graph.');
    expect(rendered.relates).toEqual(['code.route:services/orders/internal/api/router.go#POST:/orders']);
  });
});
