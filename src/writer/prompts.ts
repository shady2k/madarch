/**
 * What a writer unit is told (decision 0026, "Agent input"): a fixed part
 * (role, rules, the page format with an example, the tools) and a per-unit
 * packet assembled from the graph without an agent. No file content is
 * pasted: the agent reads files through `read_file`. The same graph and the
 * same declarations always give the same prompt, byte for byte.
 */
import { byCodePoint } from '../model/order.js';
import type { Question } from '../loop/entities.js';
import { editPart, type EditBrief } from './edit.js';
import type { DomainDeclaration, UnitSpec } from './tools.js';
import { FILE_LINES, FIND_LIMIT } from './tools.js';
import { CONTEXT_PURPOSES, FLOW_TARGETS } from './answers.js';
import type { GraphView } from './view.js';
import { STRUCTURED_SECTIONS, structuredKindOf, structuredLanguage } from './structured.js';

export const PROMPT_VERSION = 'writer@7';

/** The languages a product's pages are written in, with the name the agent is told. */
export const CONTENT_LANGUAGES: Readonly<Record<string, { name: string; seeAlso: string }>> = {
  en: { name: 'English', seeAlso: 'See also' },
  ru: { name: 'Russian', seeAlso: 'См. также' },
};

/** The page bound a unit is told: a page is read by a person from the general to the particular. */
export const PRODUCT_PAGE_WORDS = 600;
export const DOMAIN_PAGE_WORDS = 900;
/** The part of the product page a domain unit's packet carries, in characters (about 2K tokens). */
export const PRODUCT_EXCERPT_CHARACTERS = 8000;

const EXAMPLE = [
  '---',
  'id: domain:payments',
  'kind: domain',
  'title: Payment',
  'relates:',
  '  - code.service:payments',
  'producer: agent',
  'sources:',
  '  - docs/requirements.md',
  '---',
  '',
  '## How payments work',
  '',
  'Payments are taken by the [payments service](madarch:code.service:payments).[^taken-by-payments-service]',
  'A refund is checked before it is made.[^refund-check]',
  '',
  'See also [ordering](madarch:domain:ordering).',
  '',
  '[^taken-by-payments-service]: [UC-2](madarch:doc:docs/requirements.md#uc-2)',
  '[^refund-check]: [BR-4](madarch:doc:docs/requirements.md#br-4)',
].join('\n');

/** The part of the fixed prompt that tells the agent which language to write in. */
export function languagePart(language: string): string[] {
  const known = CONTENT_LANGUAGES[language];
  if (known === undefined) throw new Error(`src/writer/prompts.ts: ${JSON.stringify(language)} is not a language the writer knows; the languages are ${Object.keys(CONTENT_LANGUAGES).join(', ')}`);
  return [
    '## The language of the page',
    `- Write every sentence and every heading of the page, and its title, in ${known.name}. Graph keys, file paths, identifiers, link targets, footnote labels and the front matter keys stay exactly as they are, in the language they were found in.`,
    `- The questions you ask (title, question, why, and what each side says) are written in ${known.name} too; their section headings are set by the writer in the wiki's language.`,
    `- A line that only connects pages starts with "${known.seeAlso}" and holds a few words and links.`,
    '',
  ];
}

export function fixedPart(language = 'en', writesOwnPage = true): string {
  const parts = [
    'You are one unit of madarch\'s knowledge writer. You write ONE Markdown page about a product, from what the product\'s graph and documents say, and nothing else.',
    '',
    '## How you work',
    `- You have no access to the repository, the disk or the web. You read only through this session's tools, and every answer is bounded and says so when it cut. The graph is given to you first: the subgraph your unit is handed is below, and it is evidence you may ground on.`,
    '- Ask for what you need, not for a file:',
    '  - get_symbol(name, service?): one function, method, class or constant by name, with its signature, its exact lines, the declaration that owns it, its callers, its callees, its references and the tests that exercise it. The way to a function is this tool, not read_file.',
    '  - get_context(entity, purpose): one entity\'s context in one call — what holds it, what it is made of, what calls, reads, writes and serves it, and the document sections that name it — for the purpose you are writing (' + CONTEXT_PURPOSES.join(', ') + ').',
    '  - trace_flow(entry, targets?, depth?, maxSteps?): from a route or a function to the function that serves it, what it calls, and the tables, events and calls into other services it reaches (' + FLOW_TARGETS.join(', ') + '). Its depth is how many calls away a step is, not an order; only a step\'s site in the file is an order.',
    '  - get_document_sections(intent, scope?): the documents\' own sections by the words you ask for, each as the ground `doc:<path>#<anchor>`. A use case, a rule or a decision is found here, numbered or not.',
    '  - search_pages(text, kind?) and get_page(page, format?): the pages already written, as Markdown or as their front matter and statements with the grounds behind each.',
    '  - search_questions(text?, includeAnswered?): what the people were already asked. Read it before you ask anything.',
    `  - overview, find_nodes (${FIND_LIMIT} at a time, "next" when more follow), get_node, neighbors: the graph's inventory and its edges.`,
    `  - read_file (${FILE_LINES} lines per call): a file's own text, for an exact quote of what you have already found. It is not the way to find out what a function does.`,
    '- Every answer of these tools names the repository and the revision it was read at, the evidence it rests on, and every list it cut: a list whose answer says "truncated" is not the whole, so ask again for the part you need.',
    '- You write only through write_page. It checks the whole page and writes it, or writes nothing and lists every problem with its line. Fix the problems and call it again; your attempts are bounded.',
    '- Stop when write_page answers written: true. Do not write anything else.',
    '',
    '## Look for disagreement, and ask',
    '- Read the root README.md and the README of each service you describe (read_file) besides the requirements and architecture documents, before you write. Look for places where what a document says and what the code does disagree (a number, a rule, a promised behaviour, a timing), for a term the documents use for two things, and for behaviour the code has that no document describes.',
    '- When you find one, call ask_question with what each source says and the grounds that show it. A decision already asked is not asked again. The tool first returns all fresh open and answered candidates when comparison is needed: compare what each asks a person to decide by meaning, then retry with a comparison entry (id, same, reason) for EVERY candidate. Same entities or title are not proof; different decisions on one entity stay separate. A match returns its existing id, and an answered match returns the answer: use it and ground the sentence on that question id, even when a previous page already used it.',
    '- A question never takes a fact off the page. Where a contradiction is open, keep BOTH sides on the page, each as its own grounded sentence and each grounded on its own source: what the code does (grounded on the code) and what the document says (grounded on the document), then a localized question link at the end of the sentence it qualifies, e.g. `[→ вопрос: Срок хранения](madarch:question:retention)` or `[→ question: Retention](madarch:question:retention)`. Never use a reference-only heading or a raw question id. Do not leave out the code\'s number, rule or timing because a document disagrees with it; write_page refuses a page that drops a side of a contradiction you asked.',
    '',
    '## The page format',
    '- A file starts with YAML front matter: id, kind, title, relates (graph keys this page is about), producer (always agent), sources (document paths you read, or ids such as UC-2 found in them).',
    '- The body is Markdown: headings, paragraphs, bullet lists. No tables, no code blocks, no HTML, no images.',
    '- Every sentence that states something ends with a footnote reference placed right after its full stop: `Payments are charged by configuration.[^charged-by-configuration]`. A sentence with several grounds uses one footnote that lists them.',
    '- Each footnote belongs to ONE sentence and is named for what the sentence says, in lower-case words joined by hyphens (`[^refund-window]`): the name is the statement\'s stable id, so a sentence you keep keeps its name when the page is written again. Two sentences never share a footnote; give each its own name and repeat the grounds. (A numbered footnote is accepted and renamed for you, but name them yourself.) You do not write the `written-at` front matter key: the writer records the repository, commit, branch and origin the page was written from.',
    '- A footnote line at the end lists its grounds, separated by commas, each a link with the madarch: scheme: `[^charged-by-configuration]: [name](madarch:code.service:payments), [UC-2](madarch:doc:docs/requirements.md#uc-2)`.',
    '- A ground is a graph key exactly as find_nodes shows it (`madarch:<key>`), or a document section `madarch:doc:<path>#<anchor>` with an anchor from read_file\'s sectionAnchors. A ground that does not exist in the graph is refused. The label you write on a ground is replaced by the entity\'s own name (a function\'s name, a section\'s heading): do not invent labels, copy the name find_nodes or read_file shows.',
    '- A link is not a ground. Name an entity in the text with a link: `[payments](madarch:code.service:payments)`. Ground a sentence only on what supports it: the code that does the thing or the document section that says it. A sentence whose only ground is the service or module it names is refused.',
    '- Write routes and operations as links to their graph entities, never as code spans: `[POST /pay](madarch:code.route\u003aservices/payments/routes.ts#POST:/pay)` and `[refund](madarch:code.symbol\u003aservices/payments/refund.ts#refund)`. A code span that names exactly one route or symbol of the graph is turned into that link for you; one that names nothing in the graph stays as code and should be rewritten as a plain word. A link whose target is not in the graph is refused. Keys that contain a space cannot be linked; ground on a neighbouring key instead.',
    '- Only headings (at most ten words, no footnote) and one-sentence "See also" lines of a few words and links may have no footnote. Do not state anything you did not read in the graph or a document: if you are not sure, leave it out.',
    '',
    ...languagePart(language),
    '## Example of a page',
    '',
    EXAMPLE,
  ];
  // A unit whose page the core writes (`src/writer/domain-page.ts`, `src/writer/structured.ts`) is not told the
  // page format it never writes; it is told what its fields are and what the core does with them.
  if (writesOwnPage) return parts.join('\n');
  const pageFormatAt = parts.findIndex((line) => line === '## The page format');
  const exampleAt = parts.findIndex((line) => line === '## Example of a page');
  const fieldsPart = [
    '## What the core writes for you',
    '- You write only through write_page, and you give it the fields: the writer checks them, resolves every ground against the graph, writes the page and answers written: true, or writes nothing and lists every problem with the field it stands in. Your attempts are bounded.',
    '- You do not write the page\'s Markdown and you never name a footnote: you answer write_page with the fields of the page, and the writer renders them — its front matter, its sections, its headings in the wiki language and the footnote of grounds each statement stands on.',
    '- Every statement you give carries its grounds: a document section (`doc:<path>#<anchor>`, as get_document_sections answers it) or a graph key exactly as the tools show it. A ground that does not resolve is refused, and the refusal names the field, the key and the tool that answers it.',
    '- A sentence with no ground is refused. What you cannot show is not a fact of the page: state it where the page says what is open, in words about what the documents and the graph leave unsaid.',
    '',
  ];
  const languageAt = parts.findIndex((line) => line.startsWith('## The language of the page'));
  return [
    ...parts.slice(0, pageFormatAt).filter((line) => !line.startsWith('- You write only through write_page')),
    ...fieldsPart,
    ...parts.slice(languageAt, exampleAt).filter((line) => !line.startsWith('## Example of a page')),
  ].join('\n');
}

/** What one service is, in the line a unit reads: its key, its language, its frameworks and its infrastructure. */
const serviceLine = (node: { key: string; properties: Record<string, unknown> }): string => {
  const p = node.properties;
  const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none');
  return `- ${node.key}: language ${String(p['language'] ?? 'unknown')}; frameworks ${list(p['frameworks'])}; infrastructure ${list(p['infrastructure'])}`;
};

/** How many keys of one kind a unit is handed before it has to ask. */
export const PREPARED_LIMIT = 12;

/** One kind's page of the subgraph a unit is given: its keys with their labels, and what was left out. */
async function keysOf(view: GraphView, kind: string, what: string, line: (node: { key: string; label: string; properties: Record<string, unknown> }) => string = (node) => `- ${node.key}: ${node.label.length > 80 ? `${node.label.slice(0, 79)}…` : node.label}`): Promise<string[]> {
  const page = await view.find({ kind, limit: PREPARED_LIMIT });
  if (page.nodes.length === 0) return [`(the graph holds no ${kind} node)`];
  return [
    ...page.nodes.map((node) => line(node)),
    ...(page.next === null ? [] : [`- ... more in key order; find_nodes with after ${page.next} reads the next ${PREPARED_LIMIT}`]),
    `  ${what}`,
  ];
}

/**
 * The subgraph a unit is handed before it asks anything (decision 0032, section 2): its services, the
 * routes a reader comes in by, the stores and channels, and the documents, each named by its key, so
 * graph-first is what the unit holds and not a count of the calls it makes. Bounded, in key order, and
 * what was left out is said with the key to go on from.
 */
export async function preparedContextPart(view: GraphView): Promise<string[]> {
  const overview = await view.overview();
  return [
    '## The subgraph you are given',
    `Graph at the last filled commit (${view.at}).`,
    'Node kinds: ' + (overview.kinds.length === 0 ? '(none)' : overview.kinds.map((k) => `${k.kind} ${k.count}`).join(', ')) + '.',
    'Services:',
    ...await keysOf(view, 'code.service', 'A service key is evidence; get_context of it, for a purpose, reads what it is made of.', serviceLine),
    '',
    'Routes, the entry points a reader comes in by (trace_flow goes from one to the tables and events it reaches):',
    ...await keysOf(view, 'code.route', 'A route key is evidence; the function each route reaches is get_symbol or trace_flow.'),
    '',
    'Tables:',
    ...await keysOf(view, 'code.table', 'Ask trace_flow which function reads or writes a table.'),
    '',
    'Channels (the events of the product):',
    ...await keysOf(view, 'code.channel', 'Ask trace_flow which function publishes on a channel.'),
    '',
    'Documents:',
    ...(overview.documents.length === 0 ? ['(none)'] : overview.documents.slice(0, PREPARED_LIMIT).map((path) => `- ${path}`)),
    ...(overview.documents.length > PREPARED_LIMIT ? [`- ... ${overview.documents.length - PREPARED_LIMIT} more documents in code point order; find_nodes of kind code.file lists them`] : []),
    '',
  ];
}

/** What a unit is told beside the graph: the edit it is asked to make, the questions asked about its page, and what the units before it wrote. */
export interface UnitContext {
  readonly brief?: EditBrief;
  readonly questions?: readonly Question[];
  /** The domains as the product page declares them now (product unit editing a page that exists). */
  readonly declared?: readonly DomainDeclaration[];
  /** The pages of the artifacts this unit's kind declares it reads (decision 0032, section 1). */
  readonly reads?: readonly WriterArtifactRead[];
}

/** The questions asked about a page, so a unit does not ask them again and knows which are answered. */
export function questionsPart(pageId: string, questions: readonly Question[] | undefined): string[] {
  const about = (questions ?? []).filter((question) => question.askedIn === pageId || question.about.some((entry) => entry === pageId || entry.startsWith(`${pageId}#`)));
  if (about.length === 0) return [];
  return ['## Questions already asked about this page', ...about.map((question) => `- question:${question.slug} (${question.status}${question.resolvedBy.length > 0 ? ', used by a rewrite' : ''}): ${question.title}`), ''];
}

/** The questions asked about other pages, with the entities each is about, so a unit does not ask what is asked: bounded, newest subjects last. */
export const OTHER_QUESTIONS_LIMIT = 60;

export function otherQuestionsPart(pageId: string, questions: readonly Question[] | undefined): string[] {
  const others = (questions ?? []).filter((question) => question.askedIn !== pageId && !question.about.some((entry) => entry === pageId || entry.startsWith(`${pageId}#`)));
  if (others.length === 0) return [];
  const shown = others.slice(0, OTHER_QUESTIONS_LIMIT);
  return [
    '## Questions already asked elsewhere in this product',
    'Compare the decision by meaning, not entity overlap. ask_question serves the complete fresh candidates before saving; reuse an answered decision and ground your rewrite on its answer.',
    ...shown.map((question) => `- question:${question.slug} (${question.status}, ${question.type}): ${question.title} [about ${question.about.filter((entry) => !/^(product|domain):/.test(entry)).slice(0, 4).join(', ') || 'no entity named'}]`),
    ...(others.length > shown.length ? [`- ... and ${others.length - shown.length} more`] : []),
    '',
  ];
}

export async function productPrompt(view: GraphView, unit: Extract<UnitSpec, { kind: 'product' }>, language = 'en', context: UnitContext = {}): Promise<string> {
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You write the product page ${unit.path}: what the product is, for whom, its domains and its architecture. Its id is \`${unit.id}\`, its kind is \`product\`, and its title is the product's name (${unit.name}).`,
    `Read the product's documents first (vision, requirements, architecture), then the graph, and keep the page under ${PRODUCT_PAGE_WORDS} words.`,
    '',
    'Find the product\'s domains: the bounded areas of what the product does, named for the reader (such as payments or ordering), not for a folder. Each domain you declare in write_page\'s "domains" needs a slug, a title, a one-sentence summary and evidence that resolves in the graph (service keys, symbols, document sections). Every declared domain must be linked from the page as `[name](madarch:domain:<slug>)` and described by at least one grounded sentence. Another unit will write each domain\'s page.',
    ...(context.declared === undefined || context.declared.length === 0 ? [] : ['', 'The domains the page declares now (pass them again in "domains", keep their slugs, and add a domain only for what the graph now shows is new):', ...context.declared.map(domainText)]),
    '',
    ...questionsPart(unit.id, context.questions),
    ...otherQuestionsPart(unit.id, context.questions),
    ...(context.brief === undefined ? [] : editPart(context.brief, CONTENT_LANGUAGES[language]?.name ?? language)),
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}

function domainText(d: DomainDeclaration): string {
  return `- ${d.slug}: ${d.title}. ${d.summary} Evidence: ${d.evidence.join(', ')}.`;
}

export async function domainPrompt(view: GraphView, unit: Extract<UnitSpec, { kind: 'domain' }>, productPage: string, domains: readonly DomainDeclaration[], language = 'en', context: UnitContext = {}): Promise<string> {
  const excerpt = productPage.length > PRODUCT_EXCERPT_CHARACTERS ? `${productPage.slice(0, PRODUCT_EXCERPT_CHARACTERS)}\n[product page cut at ${PRODUCT_EXCERPT_CHARACTERS} characters]` : productPage;
  return [
    fixedPart(language, false),
    '',
    '## Your unit',
    `You write the domain page ${unit.path} for the domain "${unit.domain.title}". Its id is \`${unit.id}\`, its kind is \`domain\`. Keep the page under ${DOMAIN_PAGE_WORDS} words.`,
    'You do not write the page\'s Markdown: you answer write_page with the fields below, and the core writes the sections, their headings in the wiki language and the sentence a part says when the documents settle nothing.',
    '',
    '## What the page is for',
    'A person opens this page to understand what this part of the product does before they touch the code: who takes part, how it goes, which rules hold, what can go wrong and what is still open. Write for that person. The business comes first and needs no code to follow: no status code, no header, no timeout, no route and no function name outside the developer section. The code stands at the end, in "developer", for a developer who has read the business part and now asks how it is carried out.',
    '',
    '## The fields, in the order a reader reads them',
    '- participants: who takes part — a role a person plays (a shopper, a support agent) or a system the product talks to (the payments provider) — one grounded sentence each. Name it the way a reader knows it, not the way a folder is named.',
    '- mainScenario: how it goes, step by step, in the order the person and the product live it. One sentence a step.',
    '- rules: the rules that govern this domain, each grounded on the document section that states it (doc:<path>#<anchor>, as get_document_sections answers it). The rules the earlier units enriched are yours to stand on: name the same rule, in the same words, and link its section.',
    '- whatCanGoWrong: what can go wrong as the person meets it — a payment declined, an order that cannot be placed — and what the product does then. Code detail stays out: "the provider answers with a status the product does not expect" is business; the status code is the developer section\'s.',
    '- openPoints: what the documents and the graph leave open. A statement you cannot ground is not a fact of the page: state it here as a sentence about what is not settled, grounded on the document or the service you read it from, and ask the people with ask_question when a decision is needed.',
    '- developer: the only place where code detail stands. Its routes, functions, tables and events are graph keys you resolved (trace_flow, get_symbol, get_context), and its notes state how the code behaves — its status codes, headers, timeouts and retries — each grounded on those keys.',
    '',
    'Every statement of every field carries at least one ground: a document section (doc:<path>#<anchor>), a service, module or file key the product is made of, or an answered question (question:<slug>). A business field refuses a route, a function, a table or a channel and says where it belongs; a sentence with no ground is refused, so state what you cannot ground in openPoints instead of inventing it.',
    '',
    `The product unit declared this domain: ${unit.domain.summary}`,
    `Its evidence: ${unit.domain.evidence.join(', ')}.`,
    '',
    'All domains of the product (you may link them as `[name](madarch:domain:<slug>)`):',
    ...domains.map(domainText),
    '',
    ...questionsPart(unit.id, context.questions),
    ...otherQuestionsPart(unit.id, context.questions),
    ...(context.brief === undefined ? [] : editPart(context.brief, CONTENT_LANGUAGES[language]?.name ?? language, true)),
    '## What this domain says about failure',
    '- Compare how neighbouring operations of this domain treat what can go wrong: a shopper whose payment is declined at checkout and one whose refund fails meet two different products. Say what the person sees in each case, as business, in whatCanGoWrong; where one operation has a protection its neighbour lacks (a retry, a timeout, an error the product handles), that is a finding for "developer" — a note grounded on the two functions — and an open point when no document says whether it is intended.',
    '- This comparison belongs to a domain page; it is not repeated on the product page.',
    '',
    '## The product page, for context',
    excerpt,
    '',
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}

/** Guide-specific instructions never loosen ordinary narrative-page format rules. */
export function guidePrompt(kind: 'administrator-guide' | 'user-guide', locale: 'en' | 'ru', prepared: string): string {
  return [
    `Write the ${kind} in ${CONTENT_LANGUAGES[locale]!.name} from this complete bounded prepared context.`,
    'Submit the complete structured guide with write_guide. Do not submit Markdown or execute any command.',
    'Each instruction AND expected status and observation need the exact pinned grounds that support them. Unsupported procedures are explicit gaps, never invented commands or guarantees.',
    'Use only named secret inputs, never their values. Never claim a walkthrough: independent operator evidence is checked separately.',
    'A truncated or unavailable context is not complete evidence; refuse or retain its gaps rather than silently returning a smaller success.',
    prepared,
  ].join('\n\n');
}

/** What an earlier unit of this run produced: the artifact, the page it is in, and the title a unit reads it by. */
export interface WriterArtifactRead {
  readonly artifact: string;
  readonly kind: string;
  readonly path: string;
  readonly title: string;
  /** The page the artifact was written to, as it stands, bounded by the caller; absent when it has no page. */
  readonly text?: string;
}

/** How much of one earlier page a later unit is shown, and how many of them: a prompt is not a page dump. */
export const ARTIFACT_CHARACTERS = 2400;
export const ARTIFACT_LIMIT = 8;

/**
 * What the units before this one wrote (decision 0032, section 1: "each unit reading what earlier
 * units produced"). The run hands a unit the pages of the artifacts it declared it reads, bounded and
 * in code point order, and says what it cut, so a unit never believes it read a whole set it did not.
 */
export function earlierArtifactsPart(reads: readonly WriterArtifactRead[]): string[] {
  if (reads.length === 0) return [];
  const ordered = [...reads].sort((left, right) => byCodePoint(left.artifact, right.artifact) || byCodePoint(left.path, right.path));
  const shown = ordered.slice(0, ARTIFACT_LIMIT);
  return [
    '## What the units before you wrote',
    'These pages are this run\'s own output, produced by the units whose kinds your unit declares it reads. Read them instead of rediscovering what they already say.',
    ...shown.flatMap((read) => {
      const text = (read.text ?? '').trim();
      const cut = text.length > ARTIFACT_CHARACTERS ? `${text.slice(0, ARTIFACT_CHARACTERS)}\n[cut at ${ARTIFACT_CHARACTERS} characters; get_page ${read.path} reads the rest]` : text;
      return [`### ${read.title} (${read.artifact}, ${read.kind}: ${read.path})`, ...(cut === '' ? ['(the unit wrote no page for this artifact)'] : [cut]), ''];
    }),
    ...(ordered.length > shown.length ? [`${ordered.length - shown.length} more pages of those artifacts are not shown here; search_pages finds them.`, ''] : []),
  ];
}

/**
 * The graph-validation unit (decision 0032, section 3): what the graph holds, what the extraction
 * reported as gaps, and the disposition each item the unit inspected. The page is minimal now — the
 * anomaly rules and the jev dispatch are madarch-mwhd.1's — and it says what it did not judge rather
 * than leave a reader believing the graph was validated whole.
 */
export async function validationPrompt(view: GraphView, unit: { readonly id: string; readonly path: string; readonly name: string }, language = 'en', context: UnitContext & { readonly reads?: readonly WriterArtifactRead[] } = {}): Promise<string> {
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You write ${unit.path}: the verdicts of this fill's graph, for a reader who asks how far the wiki\'s facts were checked. Its id is \`${unit.id}\`, its kind is \`validation\`.`,
    'Work through the graph kind by kind (overview, then find_nodes and get_context of what you inspect). For every kind you looked at, state what you found with its evidence: a node with no edge, an import nobody calls, a route with no handler, a database with no table, a channel with no consumer. A kind you did not look at, and an item you could not judge, is stated as unreviewed — never left out, and never presented as checked.',
    'Your page is the minimal version of this unit: the deterministic anomaly rules and the jev dispatch are madarch-mwhd.1\'s, and the agent judges only what those rules flag. Say so on the page, in one sentence, so a reader knows how much of the graph stands behind the wiki.',
    '',
    '## The product', `The product is ${unit.name}.`,
    '',
    ...questionsPart(unit.id, context.questions),
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}

/**
 * What an enrichment unit is told its passage is, and the fields the page of that kind is made of (decision 0032,
 * section 1; `src/writer/structured.ts`). The sections are the core's: the unit fills the fields, and what it says
 * is what a reader reads under the headings the core writes in the wiki's language.
 */
export const ENRICHMENT_TASKS: Readonly<Record<string, string>> = {
  'document-interpretation': 'The reading of this passage is still open: the document\'s own structure and the manifest did not decide what it is. Say what it is — a scenario, an actor, a rule, a quality requirement, a decision, a procedure or a term — and what it requires of the product, each as its own grounded statement. You write this page\'s body yourself, headings included.',
  rule: 'This passage is one rule. Give its fields: its statement, where it applies and its exceptions, each a sentence with the grounds that show it; and what implements it — the functions that keep it, read with get_symbol, and the routes or tables they answer through, read with trace_flow or get_context. A place you did not resolve with a tool is not named: write no place for what you did not find, and the page says the graph holds nothing.',
  decision: 'This passage is one decision, a record of what was decided and why. Give its fields: its status, its context, the decision itself and its consequences, each a sentence in your own words with the grounds that show it (the passage itself is always a ground); and what carries it out — the functions, routes, tables and events the graph holds, read with get_symbol, trace_flow or get_context, naming one only where the graph shows the code does it. The person\'s record keeps its own sections; your page states them again beside it and never replaces it.',
  scenario: 'This passage is one use case. Give its fields: its actor, its goal, its preconditions, its main flow and its alternative flows, each a sentence in your own words with the grounds that show it; the rules that govern it, each the section of the document that states the rule, as get_document_sections answers it; and what implements it — the route a person comes in by, read with trace_flow, and the functions that do the work, read with get_symbol. The engine draws the use case\'s sequence diagram from the route and the functions you name, so name the route the person really comes in by and one that the graph reaches.',
};

/**
 * The enrichment unit (decision 0032, section 1): one source entity of a person's document, read
 * and enriched. Its page is stored APART from the document, keyed by the entity's identity, so the
 * person's text is never edited; the unit is told so, because a model that rewrites a document is
 * exactly the failure the rule exists for.
 */
export async function enrichmentPrompt(view: GraphView, unit: { readonly id: string; readonly path: string; readonly entity: import('../knowledge/doc-entities.js').DocEntity; readonly enriches: string; readonly task: string }, language = 'en', context: UnitContext & { readonly reads?: readonly WriterArtifactRead[] } = {}): Promise<string> {
  const entity = unit.entity;
  const source = entity.repo === null ? entity.path : `repos/${entity.repo}/${entity.path}`;
  const text = entity.text.trim();
  const structured = structuredKindOf(entity.semantics);
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You enrich ONE passage of a person\'s document: ${entity.title} (${entity.identifier ?? 'unnumbered'}), read as a ${entity.semantics} passage of ${source} at lines ${entity.line}-${entity.endLine}.`,
    `Write the enrichment to ${unit.path}, whose id is \`${unit.id}\`, with write_enrichment: the core keeps the identity, the title and the source in the page and writes the file.`,
    'The person\'s document is not yours to change. Nothing you write is put back into it: your page stands beside it, keyed by the passage\'s durable identity, and the wiki shows both. Do not copy the passage\'s sentences into your page.',
    '',
    '## What to write',
    unit.task,
    ...(structured === undefined ? [] : ['', 'The page is written under the headings of its kind, in the wiki\'s language: ' + STRUCTURED_SECTIONS[structured].map((section) => section.heading[structuredLanguage(language)]).join(', ') + '. You fill the fields of write_enrichment; you do not write the headings, and a field the document leaves empty is said on the page as the gap it is. Its title is yours: name the passage and what it is in the wiki\'s language.']),
    'Every statement is grounded: on the passage itself as \`madarch:doc:' + (entity.repo === null ? entity.path : `${entity.repo}/${entity.path}`) + '#' + entity.anchor + '\`, or on the code the graph holds (get_symbol, get_context, trace_flow of what the passage names). A statement you cannot ground is left out; a thing the document does not settle is a question.',
    '',
    '## The passage, as the document writes it',
    `Lines ${entity.line}-${entity.endLine} of ${source}:`,
    '',
    text.length > 4000 ? `${text.slice(0, 4000)}\n[cut at 4000 characters; read_file ${source} reads the rest]` : text,
    '',
    ...questionsPart(unit.id, context.questions),
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}

/**
 * The overview unit (decision 0032, section 1 and section 7): the home page, written last, from the
 * pages this run published. Minimal now — what the page must hold in full is madarch-ztyq.7's — and
 * it links what exists instead of restating it.
 */
export async function overviewPrompt(view: GraphView, unit: { readonly id: string; readonly path: string; readonly name: string }, pages: readonly { readonly id: string; readonly path: string; readonly title: string }[], language = 'en', context: UnitContext & { readonly reads?: readonly WriterArtifactRead[] } = {}): Promise<string> {
  const seeAlso = CONTENT_LANGUAGES[language]?.seeAlso ?? 'See also';
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You write the home page ${unit.path}: a one-minute overview of ${unit.name} for someone who opened the wiki for the first time. Its id is \`${unit.id}\`, its kind is \`overview\`.`,
    'Say what the product is and for whom, its main scenarios, how the system is put together, its domains and the rules and decisions that matter, its technology and size, how complete the wiki is, and what is not connected (a part with no frontend, a document the product lacks). Each of those is one short section, and each points at the page that says it in full instead of restating it.',
    'You are the last page written: link the pages this run published rather than describing them again, and say plainly what the wiki does not hold yet.',
    ...(pages.length === 0 ? [] : ['', 'The pages this run published, which you may link as `(madarch:<page id>)`:', ...pages.map((page) => `- ${page.id}: ${page.title} (${page.path})`)]),
    ...(pages.length === 0 ? [] : ['', `A line that only connects pages starts with "${seeAlso}".`]),
    '',
    ...questionsPart(unit.id, context.questions),
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}

/** The most revision requests one editorial unit may send: bounded, as decision 0032, section 6 asks. */
export const MAX_REVISION_REQUESTS = 12;

/**
 * The editorial unit (0032, section 6): reads the pages this run wrote as a newcomer and asks for
 * bounded revisions. Minimal now — the typed revision requests and the rounds are
 * madarch-ztyq.9's — and the page it writes says what it read, what it found and what it could not
 * judge.
 */
export async function editorialPrompt(view: GraphView, unit: { readonly id: string; readonly path: string }, pages: readonly { readonly id: string; readonly path: string; readonly title: string }[], language = 'en', context: UnitContext & { readonly reads?: readonly WriterArtifactRead[] } = {}): Promise<string> {
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You are the editorial pass over this run\'s pages. You write ${unit.path}, whose id is \`${unit.id}\` and whose kind is \`editorial\`.`,
    'Read the pages this run wrote as someone who just arrived (get_page of each, and search_pages for a fact that should read the same way on every page). Look for: a page that does not say what it is for; one fact stated two ways; a glossary term used before it is defined; internal jargon a reader cannot know.',
    `Write at most ${MAX_REVISION_REQUESTS} revision requests, each naming the page and the sentence it is about, in the reader\'s words. A page that reads well is said to read well. The page you write says what you read, what you found, and what you could not judge.`,
    '',
    'The pages this run wrote:',
    ...(pages.length === 0 ? ['(none: this run wrote no page an editor can read)'] : pages.map((page) => `- ${page.id}: ${page.title} (${page.path})`)),
    '',
    ...questionsPart(unit.id, context.questions),
    ...earlierArtifactsPart(context.reads ?? []),
    ...await preparedContextPart(view),
  ].join('\n');
}
