/**
 * What a writer unit is told (decision 0026, "Agent input"): a fixed part
 * (role, rules, the page format with an example, the tools) and a per-unit
 * packet assembled from the graph without an agent. No file content is
 * pasted: the agent reads files through `read_file`. The same graph and the
 * same declarations always give the same prompt, byte for byte.
 */
import type { Question } from '../loop/entities.js';
import { editPart, type EditBrief } from './edit.js';
import type { DomainDeclaration, UnitSpec } from './tools.js';
import { FILE_LINES, FIND_LIMIT } from './tools.js';
import type { GraphView } from './view.js';

export const PROMPT_VERSION = 'writer@5';

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

export function fixedPart(language = 'en'): string {
  return [
    'You are one unit of madarch\'s knowledge writer. You write ONE Markdown page about a product, from what the product\'s graph and documents say, and nothing else.',
    '',
    '## How you work',
    `- You have no access to the repository, the disk or the web. You read only through this session's tools: overview, find_nodes, get_node, neighbors, read_file (${FILE_LINES} lines per call). Every answer is bounded; a page of ${FIND_LIMIT} says "next" when more follow. Another tool, ask_question, asks the people (see below).`,
    '- You write only through write_page. It checks the whole page and writes it, or writes nothing and lists every problem with its line. Fix the problems and call it again; your attempts are bounded.',
    '- Stop when write_page answers written: true. Do not write anything else.',
    '',
    '## Look for disagreement, and ask',
    '- Read the root README.md and the README of each service you describe (read_file) besides the requirements and architecture documents, before you write. Look for places where what a document says and what the code does disagree (a number, a rule, a promised behaviour, a timing), for a term the documents use for two things, and for behaviour the code has that no document describes.',
    '- When you find one, call ask_question with what each source says and the grounds that show it. A decision already asked is not asked again. The tool first returns all fresh open and answered candidates when comparison is needed: compare what each asks a person to decide by meaning, then retry with a comparison entry (id, same, reason) for EVERY candidate. Same entities or title are not proof; different decisions on one entity stay separate. A match returns its existing id, and an answered match returns the answer: use it and ground the sentence on that question id, even when a previous page already used it.',
    '- A question never takes a fact off the page. Where a contradiction is open, keep BOTH sides on the page, each as its own grounded sentence and each grounded on its own source: what the code does (grounded on the code) and what the document says (grounded on the document), then a localized question link at the end of the sentence it qualifies, e.g. `[→ вопрос: Срок хранения](madarch:question:retention)` or `[→ question: Retention](madarch:question:retention)`. Never use a reference-only heading or a raw question id. Do not leave out the code\'s number, rule or timing because a document disagrees with it; write_page refuses a page that drops a side of a contradiction you asked.',
    '- Compare how neighbouring operations of a domain handle failure: for each operation that calls another service or a store (a payment, a refund, a capture, a lookup), read what it does on a timeout, a retry, an error answer and a repeat of the same request, and say where one operation has protection that its neighbour lacks (for example a pay call with a timeout and a retry beside a refund call with neither). A difference like that is a finding: state it as a grounded sentence, and ask a question when no document says whether it is intended.',
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
  ].join('\n');
}

async function servicesText(view: GraphView): Promise<string> {
  const services = await view.find({ kind: 'code.service', limit: FIND_LIMIT });
  if (services.nodes.length === 0) return '(the graph holds no code.service node)';
  return services.nodes
    .map((n) => {
      const p = n.properties;
      const list = (value: unknown): string => (Array.isArray(value) && value.length > 0 ? value.join(', ') : 'none');
      return `- ${n.key}: language ${String(p['language'] ?? 'unknown')}; frameworks ${list(p['frameworks'])}; infrastructure ${list(p['infrastructure'])}`;
    })
    .join('\n');
}

async function overviewText(view: GraphView): Promise<string> {
  const o = await view.overview();
  return [
    `Graph at the last filled commit (${view.at}).`,
    'Node kinds: ' + o.kinds.map((k) => `${k.kind} ${k.count}`).join(', ') + '.',
    'Documents:',
    ...(o.documents.length === 0 ? ['(none)'] : o.documents.map((d) => `- ${d}`)),
    'Services:',
    await servicesText(view),
  ].join('\n');
}

/** What a unit is told beside the graph: the edit it is asked to make, and the questions asked about its page. */
export interface UnitContext {
  readonly brief?: EditBrief;
  readonly questions?: readonly Question[];
  /** The domains as the product page declares them now (product unit editing a page that exists). */
  readonly declared?: readonly DomainDeclaration[];
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
    '## What the graph holds',
    await overviewText(view),
  ].join('\n');
}

function domainText(d: DomainDeclaration): string {
  return `- ${d.slug}: ${d.title}. ${d.summary} Evidence: ${d.evidence.join(', ')}.`;
}

export async function domainPrompt(view: GraphView, unit: Extract<UnitSpec, { kind: 'domain' }>, productPage: string, domains: readonly DomainDeclaration[], language = 'en', context: UnitContext = {}): Promise<string> {
  const excerpt = productPage.length > PRODUCT_EXCERPT_CHARACTERS ? `${productPage.slice(0, PRODUCT_EXCERPT_CHARACTERS)}\n[product page cut at ${PRODUCT_EXCERPT_CHARACTERS} characters]` : productPage;
  return [
    fixedPart(language),
    '',
    '## Your unit',
    `You write the domain page ${unit.path} for the domain "${unit.domain.title}". Its id is \`${unit.id}\`, its kind is \`domain\`.`,
    `Explain how the domain works: which services, modules and functions take part, its main scenario step by step, and its related requirements and use cases. Keep the page under ${DOMAIN_PAGE_WORDS} words. Go from the services down to the functions that do the work, and link each of them.`,
    '',
    `The product unit declared this domain: ${unit.domain.summary}`,
    `Its evidence: ${unit.domain.evidence.join(', ')}.`,
    '',
    'All domains of the product (you may link them as `[name](madarch:domain:<slug>)`):',
    ...domains.map(domainText),
    '',
    ...questionsPart(unit.id, context.questions),
    ...otherQuestionsPart(unit.id, context.questions),
    ...(context.brief === undefined ? [] : editPart(context.brief, CONTENT_LANGUAGES[language]?.name ?? language)),
    '## The product page, for context',
    excerpt,
    '',
    '## What the graph holds',
    await overviewText(view),
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
