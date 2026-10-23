/**
 * What a writer unit is told (decision 0026, "Agent input"): a fixed part
 * (role, rules, the page format with an example, the tools) and a per-unit
 * packet assembled from the graph without an agent. No file content is
 * pasted: the agent reads files through `read_file`. The same graph and the
 * same declarations always give the same prompt, byte for byte.
 */
import type { DomainDeclaration, UnitSpec } from './tools.js';
import { FILE_LINES, FIND_LIMIT } from './tools.js';
import type { GraphView } from './view.js';

export const PROMPT_VERSION = 'writer@1';

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
  '[^taken-by-payments-service]: [payments](madarch:code.service:payments), [UC-2](madarch:doc:docs/requirements.md#uc-2)',
  '[^refund-check]: [BR-4](madarch:doc:docs/requirements.md#br-4)',
].join('\n');

export function fixedPart(): string {
  return [
    'You are one unit of madarch\'s knowledge writer. You write ONE Markdown page about a product, from what the product\'s graph and documents say, and nothing else.',
    '',
    '## How you work',
    `- You have no access to the repository, the disk or the web. You read only through this session's tools: overview, find_nodes, get_node, neighbors, read_file (${FILE_LINES} lines per call). Every answer is bounded; a page of ${FIND_LIMIT} says "next" when more follow.`,
    '- You write only through write_page. It checks the whole page and writes it, or writes nothing and lists every problem with its line. Fix the problems and call it again; your attempts are bounded.',
    '- Stop when write_page answers written: true. Do not write anything else.',
    '',
    '## The page format',
    '- A file starts with YAML front matter: id, kind, title, relates (graph keys this page is about), producer (always agent), sources (document paths you read, or ids such as UC-2 found in them).',
    '- The body is Markdown: headings, paragraphs, bullet lists. No tables, no code blocks, no HTML, no images.',
    '- Every sentence that states something ends with a footnote reference placed right after its full stop: `Payments are charged by configuration.[^charged-by-configuration]`. A sentence with several grounds uses one footnote that lists them.',
    '- Each footnote belongs to ONE sentence and is named for what the sentence says, in lower-case words joined by hyphens (`[^refund-window]`): the name is the statement\'s stable id, so a sentence you keep keeps its name when the page is written again. Two sentences never share a footnote; give each its own name and repeat the grounds. (A numbered footnote is accepted and renamed for you, but name them yourself.) You do not write the `written-at` front matter key: the writer records the repository, commit, branch and origin the page was written from.',
    '- A footnote line at the end lists its grounds, separated by commas, each a link with the madarch: scheme: `[^charged-by-configuration]: [name](madarch:code.service:payments), [UC-2](madarch:doc:docs/requirements.md#uc-2)`.',
    '- A ground is a graph key exactly as find_nodes shows it (`madarch:<key>`), or a document section `madarch:doc:<path>#<anchor>` with an anchor from read_file\'s sectionAnchors. A ground that does not exist in the graph is refused.',
    '- Mention an entity in the text as a link: `[payments](madarch:code.service:payments)`. A link whose target is not in the graph is refused. Keys that contain a space cannot be linked; ground on a neighbouring key instead.',
    '- Only headings (at most ten words, no footnote) and one-sentence "See also" lines of a few words and links may have no footnote. Do not state anything you did not read in the graph or a document: if you are not sure, leave it out.',
    '',
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

export async function productPrompt(view: GraphView, unit: Extract<UnitSpec, { kind: 'product' }>): Promise<string> {
  return [
    fixedPart(),
    '',
    '## Your unit',
    `You write the product page ${unit.path}: what the product is, for whom, its domains and its architecture. Its id is \`${unit.id}\`, its kind is \`product\`, and its title is the product's name (${unit.name}).`,
    `Read the product's documents first (vision, requirements, architecture), then the graph, and keep the page under ${PRODUCT_PAGE_WORDS} words.`,
    '',
    'Find the product\'s domains: the bounded areas of what the product does, named for the reader (such as payments or ordering), not for a folder. Each domain you declare in write_page\'s "domains" needs a slug, a title, a one-sentence summary and evidence that resolves in the graph (service keys, symbols, document sections). Every declared domain must be linked from the page as `[name](madarch:domain:<slug>)` and described by at least one grounded sentence. Another unit will write each domain\'s page.',
    '',
    '## What the graph holds',
    await overviewText(view),
  ].join('\n');
}

function domainText(d: DomainDeclaration): string {
  return `- ${d.slug}: ${d.title}. ${d.summary} Evidence: ${d.evidence.join(', ')}.`;
}

export async function domainPrompt(view: GraphView, unit: Extract<UnitSpec, { kind: 'domain' }>, productPage: string, domains: readonly DomainDeclaration[]): Promise<string> {
  const excerpt = productPage.length > PRODUCT_EXCERPT_CHARACTERS ? `${productPage.slice(0, PRODUCT_EXCERPT_CHARACTERS)}\n[product page cut at ${PRODUCT_EXCERPT_CHARACTERS} characters]` : productPage;
  return [
    fixedPart(),
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
    '## The product page, for context',
    excerpt,
    '',
    '## What the graph holds',
    await overviewText(view),
  ].join('\n');
}
