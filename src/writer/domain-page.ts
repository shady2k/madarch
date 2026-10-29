/**
 * The shape of a domain page (decision 0032, sections 1, 2 and 6; madarch-ztyq.6): the six sections a reader
 * opens, what the unit gives each of them, and where the boundary between the business and the code stands.
 *
 * Three things are fixed here rather than left to a model's prose:
 *
 * - **the sections.** A domain page carries who takes part, how it goes, the rules that govern it, what can go
 *   wrong, what is open, and one section for the developer, in that order. A unit fills the parts; it does not
 *   choose the sections, and a part the documents leave empty is said rather than left as an empty heading.
 * - **the boundary.** The business sections say what the domain is for, in words a reader needs no code to
 *   follow: they stand on document sections and on the services the product is made of. A route, a function, a
 *   table or a channel is the developer section's, where each is a key the graph held when the page was written
 *   and where the status codes, headers and timeouts are stated. A business field that names one is refused.
 * - **the identities.** A section is named by the id of this declaration, never by a line of a template, and its
 *   heading is the id's words in the product's language, so a page written in English and one written in Russian
 *   carry one structure and the same places.
 *
 * This is not yet the LiquidJS template path of decision 0032, section 8 (madarch-u3vw.1): the body is built from
 * the declarations below, and the section ids recorded here are the identities they take when it lands.
 */
import { byCodePoint } from '../model/order.js';
import { PageWriter, labelOf, targetOf, type GroundedStatement, type NamedPlace, type StructuredLanguage } from './structured.js';

/** The sections of a domain page: the business first, the developer's last. */
export type DomainSectionId = 'participants' | 'main-scenario' | 'rules' | 'what-can-go-wrong' | 'open-points' | 'for-the-developer';

/** One section of a domain page: its id, its heading in each language, and what it says where the unit gave nothing. */
export interface DomainSectionDecl {
  readonly id: DomainSectionId;
  readonly heading: Readonly<Record<StructuredLanguage, string>>;
  /** What the page states where the documents or the graph settle nothing for this section: said of them, never of the world. */
  readonly gap?: Readonly<Record<StructuredLanguage, string>>;
}

/**
 * The sections of a domain page, in the order a reader reads them, and what each says where the unit found
 * nothing. Every gap is a sentence about the documents or the graph, because a missing edge is never proof of
 * absence (decision 0032, section 3).
 */
export const DOMAIN_SECTIONS: readonly DomainSectionDecl[] = [
  { id: 'participants', heading: { en: 'Participants', ru: 'Участники' }, gap: { en: 'The documents name no participant of this domain.', ru: 'Документы не называют участников этого домена.' } },
  { id: 'main-scenario', heading: { en: 'The main scenario, step by step', ru: 'Основной сценарий по шагам' }, gap: { en: 'The documents tell no main scenario for this domain.', ru: 'Документы не описывают основного сценария этого домена.' } },
  { id: 'rules', heading: { en: 'Rules that govern it', ru: 'Правила, которые действуют' }, gap: { en: 'The documents name no rule that governs this domain.', ru: 'Документы не называют правил, которые действуют в этом домене.' } },
  { id: 'what-can-go-wrong', heading: { en: 'What can go wrong', ru: 'Что может пойти не так' }, gap: { en: 'The documents and the graph say nothing about what can go wrong here.', ru: 'Документы и граф ничего не говорят о том, что здесь может пойти не так.' } },
  { id: 'open-points', heading: { en: 'Open points', ru: 'Открытые вопросы' }, gap: { en: 'The documents and the graph settle every point this page would leave open.', ru: 'Документы и граф решают все вопросы, которые эта страница могла бы оставить открытыми.' } },
  { id: 'for-the-developer', heading: { en: 'For the developer', ru: 'Для разработчика' }, gap: { en: 'The graph holds no route, function, table or event for this domain.', ru: 'В графе нет ни маршрута, ни функции, ни таблицы, ни события этого домена.' } },
];

/** The fields a domain page is written from: the business first, and one section for the developer. */
export interface DomainFields {
  /** The page's title in the wiki's language; absent, the domain's own title. */
  readonly title?: string;
  /** Who takes part: a role a person plays or a system the product talks to, one statement each. */
  readonly participants: readonly GroundedStatement[];
  /** How it goes, step by step, in the order a person lives them. */
  readonly mainScenario: readonly GroundedStatement[];
  /** The rules that govern the domain, each grounded on the section of the document that states it. */
  readonly rules: readonly GroundedStatement[];
  /** What can go wrong, as a reader would meet it. */
  readonly whatCanGoWrong: readonly GroundedStatement[];
  /** What the documents and the graph leave open, each a statement about what is not settled. */
  readonly openPoints: readonly GroundedStatement[];
  /** The code: the places the domain is carried out by, and the sentences that state its codes, headers and timeouts. */
  readonly developer: DeveloperFields;
}

/** The places a domain's code is carried out by, each a key of the graph, and the statements about them. */
export interface DeveloperFields {
  readonly routes?: readonly NamedPlace[];
  readonly functions?: readonly NamedPlace[];
  readonly tables?: readonly NamedPlace[];
  readonly events?: readonly NamedPlace[];
  /** How the code behaves where a developer asks: status codes, headers, timeouts, each grounded on those keys. */
  readonly notes: readonly GroundedStatement[];
}

/** The business fields of a domain page: what stands on documents and services, never on the places of the code. */
export const BUSINESS_FIELDS = ['participants', 'mainScenario', 'rules', 'whatCanGoWrong', 'openPoints'] as const;

/** The developer's place fields, the graph kind each holds and the words a reader sees under it. */
export const DEVELOPER_PLACE_FIELDS: readonly { readonly field: 'routes' | 'functions' | 'tables' | 'events'; readonly nodeKind: string; readonly heading: Readonly<Record<StructuredLanguage, string>> }[] = [
  { field: 'routes', nodeKind: 'code.route', heading: { en: 'Routes', ru: 'Маршруты' } },
  { field: 'functions', nodeKind: 'code.symbol', heading: { en: 'Functions', ru: 'Функции' } },
  { field: 'tables', nodeKind: 'code.table', heading: { en: 'Tables', ru: 'Таблицы' } },
  { field: 'events', nodeKind: 'code.channel', heading: { en: 'Events', ru: 'События' } },
];

/**
 * Whether a ground is a business ground: a section of a document, an answered question or a correction the people
 * decided, or a container the product is made of — a service, a module, a file. What a reader needs code to follow
 * is not one: a route, a function, a table and a channel are the developer section's.
 */
export function isBusinessGround(target: string): boolean {
  return target.startsWith('doc:') || target.startsWith('question:') || target.startsWith('correction:')
    || target.startsWith('code.service:') || target.startsWith('code.module:') || target.startsWith('code.file:');
}

/**
 * The grounds of the business fields that are not business grounds, each with the field it stands in: the code
 * detail a unit put in the business part, which belongs to the section for the developer.
 */
export function businessDetail(fields: DomainFields): readonly { readonly field: string; readonly target: string }[] {
  const out: { field: string; target: string }[] = [];
  const lists: readonly [string, readonly GroundedStatement[]][] = [
    ['participants', fields.participants], ['mainScenario', fields.mainScenario], ['rules', fields.rules],
    ['whatCanGoWrong', fields.whatCanGoWrong], ['openPoints', fields.openPoints],
  ];
  for (const [field, list] of lists) {
    for (const [index, statement] of list.entries()) for (const ground of statement.grounds) if (!isBusinessGround(ground)) out.push({ field: `${field}[${index}]`, target: ground });
  }
  return out;
}

/** The places of the developer section, in code point order of their field and their key. */
export function developerPlaces(fields: DomainFields): readonly (NamedPlace & { readonly field: string; readonly nodeKind: string })[] {
  const out: (NamedPlace & { field: string; nodeKind: string })[] = [];
  for (const place of DEVELOPER_PLACE_FIELDS) {
    for (const named of [...(fields.developer[place.field] ?? [])].sort((left, right) => byCodePoint(left.target, right.target))) out.push({ ...named, field: place.field, nodeKind: place.nodeKind });
  }
  return out;
}

/** The keys the page's `relates` says: the places of the developer section, the code its notes stand on, and the services the business part names. */
export function domainRelates(fields: DomainFields): readonly string[] {
  const business = BUSINESS_FIELDS.flatMap((field) => fields[field].flatMap((statement) => statement.grounds)).filter((target) => target.startsWith('code.service:'));
  const noted = fields.developer.notes.flatMap((statement) => statement.grounds).filter((target) => target.startsWith('code.') && !target.startsWith('code.file:') && !target.startsWith('code.module:'));
  return [...new Set([...developerPlaces(fields).map((place) => place.target), ...noted, ...business])].sort(byCodePoint);
}

/** The document a page stands on, in code point order: the sources its front matter names. */
export function domainSources(fields: DomainFields): readonly string[] {
  const targets = [
    ...BUSINESS_FIELDS.flatMap((field) => fields[field].flatMap((statement) => statement.grounds)),
    ...fields.developer.notes.flatMap((statement) => statement.grounds),
  ];
  const paths = targets.filter((target) => target.startsWith('doc:')).map((target) => target.slice('doc:'.length).split('#')[0]!).filter((path) => path !== '');
  return [...new Set(paths)].sort(byCodePoint);
}

/** Every ground of the page, in the order it appears: what the writer resolves before a byte is written. */
export function domainGrounds(fields: DomainFields): readonly string[] {
  return [
    ...BUSINESS_FIELDS.flatMap((field) => fields[field].flatMap((statement) => statement.grounds)),
    ...developerPlaces(fields).map((place) => place.target),
    ...fields.developer.notes.flatMap((statement) => statement.grounds),
  ];
}

/** A problem of one page's fields: the rule, the sentence a unit acts on, and where it lands (line 1: nothing is written yet). */
export interface DomainFieldProblem {
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/**
 * The fields of one domain page, read from what a unit wrote: each field checked, every statement with its
 * grounds, and each problem naming the field it stands in. Every field is parsed before the page is judged, so a
 * field that is invalid is a problem of its own and never a part that vanishes.
 */
export function parseDomainFields(value: unknown): { readonly ok: true; readonly fields: DomainFields } | { readonly ok: false; readonly problems: readonly DomainFieldProblem[] } {
  const problems: DomainFieldProblem[] = [];
  const problem = (rule: string, message: string): void => { problems.push({ line: 1, rule, message }); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: [{ line: 1, rule: 'fields', message: `the fields of a domain page are a mapping: ${['title', ...BUSINESS_FIELDS, 'developer'].join(', ')}` }] };
  }
  const record = value as Record<string, unknown>;
  const statement = (name: string, field: unknown): GroundedStatement | undefined => {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) { problem('field', `"${name}" is a statement: an object with "text" (one sentence) and "grounds" (the places that show it)`); return undefined; }
    const held = field as Record<string, unknown>;
    const written = text(held['text']);
    if (written === undefined) { problem('field', `"${name}.text" is the sentence this part of the page states`); return undefined; }
    const grounds = Array.isArray(held['grounds']) ? held['grounds'].map((entry) => text(entry)).filter((entry): entry is string => entry !== undefined) : [];
    if (grounds.length === 0) { problem('field-ungrounded', `"${name}" holds no ground: every statement of a page stands on at least one document section or service (get_document_sections answers the section, find_nodes the service key)`); return undefined; }
    return { text: written, grounds: grounds.map(targetOf) };
  };
  const statements = (name: string, field: unknown): GroundedStatement[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of statements, one per part of the page it says`); return []; }
    return field.map((entry, index) => statement(`${name}[${index}]`, entry)).filter((entry): entry is GroundedStatement => entry !== undefined);
  };
  const places = (name: string, field: unknown): NamedPlace[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of places, each an object with "target" (a graph key) and, when the graph's name is long, "label"`); return []; }
    return field.flatMap((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problem('field', `"${name}[${index}]" is a place: an object with "target" and an optional "label"`); return []; }
      const held = entry as Record<string, unknown>;
      const target = text(held['target']);
      if (target === undefined) { problem('field', `"${name}[${index}].target" is the graph key of the place`); return []; }
      const label = text(held['label']);
      return [{ target: targetOf(target), ...(label === undefined ? {} : { label }) }];
    });
  };
  const developer = (field: unknown): DeveloperFields => {
    if (field === undefined) return { notes: [] };
    if (typeof field !== 'object' || field === null || Array.isArray(field)) { problem('field', '"developer" is an object with the places that carry this domain out (routes, functions, tables, events) and "notes"'); return { notes: [] }; }
    const held = field as Record<string, unknown>;
    for (const name of Object.keys(held)) {
      if (name !== 'notes' && !DEVELOPER_PLACE_FIELDS.some((place) => place.field === name)) problem('field', `"developer.${name}" names nothing: the places are ${[...DEVELOPER_PLACE_FIELDS.map((place) => place.field), 'notes'].sort(byCodePoint).join(', ')}`);
    }
    return {
      ...(held['routes'] === undefined ? {} : { routes: places('developer.routes', held['routes']) }),
      ...(held['functions'] === undefined ? {} : { functions: places('developer.functions', held['functions']) }),
      ...(held['tables'] === undefined ? {} : { tables: places('developer.tables', held['tables']) }),
      ...(held['events'] === undefined ? {} : { events: places('developer.events', held['events']) }),
      notes: statements('developer.notes', held['notes']),
    };
  };
  const title = text(record['title']);
  // Every field is parsed before the page is judged: a field whose statement carries no ground is a problem of
  // its own, never a part that vanishes and lets the page say the documents settle nothing.
  const participants = statements('participants', record['participants']);
  const mainScenario = statements('mainScenario', record['mainScenario']);
  const rules = statements('rules', record['rules']);
  const whatCanGoWrong = statements('whatCanGoWrong', record['whatCanGoWrong']);
  const openPoints = statements('openPoints', record['openPoints']);
  const carried = developer(record['developer']);
  const fields: DomainFields = { ...(title === undefined ? {} : { title }), participants, mainScenario, rules, whatCanGoWrong, openPoints, developer: carried };
  for (const detail of businessDetail(fields)) {
    problem('business-detail', `"${detail.field}" stands on ${JSON.stringify(detail.target)}, which is a place of the code: the business sections say what the domain is for in plain words, and a route, a function, a table or a channel belongs in "developer"`);
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, fields };
}

/** What a domain page is rendered from: the wiki's language, the graph's names, and the domain the page is about. */
export interface DomainRenderContext {
  readonly language: StructuredLanguage;
  /** The graph's own name for a place, or the unit's label; undefined when the graph does not name it. */
  readonly labelOf: (target: string) => string | undefined;
  /** The declared domain: its id, its slug and its title in the wiki's language. */
  readonly domain: { readonly slug: string; readonly title: string };
  /** The keys that show the domain exists, which a gap the documents leave stands on. */
  readonly evidence: readonly string[];
}

/** What one rendered domain page is: the whole file, front matter included, and the keys its `relates` names. */
export interface RenderedDomainPage {
  readonly markdown: string;
  readonly relates: readonly string[];
}

/**
 * The whole page: its front matter, then its sections in the order of the declaration, each from the unit's
 * fields, and each part that holds nothing said as a gap grounded on the domain's own evidence.
 */
export function renderDomainPage(fields: DomainFields, context: DomainRenderContext): RenderedDomainPage {
  const passage = context.evidence[0] ?? `domain:${context.domain.slug}`;
  const page = new PageWriter({ language: context.language, labelOf: context.labelOf, passage, unreachedRoutes: [] });
  for (const section of DOMAIN_SECTIONS) {
    page.heading(section);
    const gap = (): void => {
      if (section.gap === undefined) return;
      page.gap(section.gap[context.language]);
    };
    switch (section.id) {
      case 'participants': if (fields.participants.length === 0) gap(); else for (const one of fields.participants) page.bullet(one); break;
      case 'main-scenario': if (fields.mainScenario.length === 0) gap(); else for (const [index, step] of fields.mainScenario.entries()) page.statement(step, `${index + 1}. `); break;
      case 'rules': if (fields.rules.length === 0) gap(); else for (const one of fields.rules) page.bullet(one); break;
      case 'what-can-go-wrong': if (fields.whatCanGoWrong.length === 0) gap(); else for (const one of fields.whatCanGoWrong) page.bullet(one); break;
      case 'open-points': if (fields.openPoints.length === 0) gap(); else for (const one of fields.openPoints) page.bullet(one); break;
      case 'for-the-developer': developerSection(page, fields, gap); break;
      default: break;
    }
  }
  const relates = domainRelates(fields);
  const markdown = `${frontMatter(fields, context, relates)}
${page.body}`;
  return { markdown, relates };
}

/** The developer's section: the places of each kind under their own sub-heading, then the sentences that state how the code behaves. */
function developerSection(page: PageWriter, fields: DomainFields, gap: () => void): void {
  let any = false;
  for (const place of DEVELOPER_PLACE_FIELDS) {
    const named = [...(fields.developer[place.field] ?? [])].sort((left, right) => byCodePoint(left.target, right.target));
    if (named.length === 0) continue;
    any = true;
    page.raw(`### ${place.heading[page.language]}`);
    page.empty();
    for (const one of named) page.place(one);
  }
  if (fields.developer.notes.length > 0) {
    if (any) { page.raw(`### ${page.language === 'ru' ? 'Как это работает' : 'How it behaves'}`); page.empty(); }
    any = true;
    for (const note of fields.developer.notes) page.bullet(note);
  }
  if (!any) gap();
}

/** The page's front matter: what it is, the keys it relates, and the documents it stands on. */
function frontMatter(fields: DomainFields, context: DomainRenderContext, relates: readonly string[]): string {
  const lines = ['---', `id: domain:${context.domain.slug}`, 'kind: domain', `title: ${quoteYaml(fields.title ?? context.domain.title)}`, 'relates:'];
  if (relates.length === 0) lines[lines.length - 1] = 'relates: []';
  else for (const key of relates) lines.push(`  - ${quoteYaml(key)}`);
  lines.push('producer: agent');
  const sources = domainSources(fields);
  if (sources.length === 0) lines.push('sources: []');
  else { lines.push('sources:'); for (const path of sources) lines.push(`  - ${quoteYaml(path)}`); }
  lines.push('---', '');
  return lines.join('\n');
}

/** A YAML scalar that reads back exactly as the words it holds, whatever punctuation a title carries. */
function quoteYaml(value: string): string {
  return JSON.stringify(labelOf(value)).replace(/\\u([0-9a-fA-F]{4})/g, (_whole, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** The JSON schema a unit is answered with: the fields of a domain page, described in the words of a person reading it. */
export function domainSchema(): Record<string, unknown> {
  const statement = (description: string): Record<string, unknown> => ({
    type: 'object', additionalProperties: false, required: ['text', 'grounds'],
    properties: {
      text: { type: 'string', description: `${description} One sentence, in the wiki language, in your own words, with no code, no status code, no header and no timeout.` },
      grounds: { type: 'array', items: { type: 'string' }, description: 'The document sections (doc:<path>#<anchor>), service keys (code.service:...) or answered questions (question:<slug>) that show this sentence; at least one.' },
    },
  });
  const list = (description: string): Record<string, unknown> => ({ type: 'array', description, items: statement('One part of it.') });
  const places = (description: string): Record<string, unknown> => ({
    type: 'array', description,
    items: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'string', description: 'A graph key as the tools give it.' }, label: { type: 'string', description: 'The words a reader sees, when the graph\'s own name says too little.' } } },
  });
  return {
    type: 'object', additionalProperties: false,
    required: ['participants', 'mainScenario'],
    description: 'The parts of one domain page: the business first, in plain words, and the code in "developer".',
    properties: {
      title: { type: 'string', description: 'The page title, in the wiki language, in the reader\'s words.' },
      participants: list('Who takes part: a role a person plays or a system the product talks to, one statement each.'),
      mainScenario: list('How it goes, step by step, in the order a person lives them.'),
      rules: list('The rules that govern this domain, each grounded on the section of the document that states it.'),
      whatCanGoWrong: list('What can go wrong, as a reader would meet it.'),
      openPoints: list('What the documents and the graph leave open, each a statement about what is not settled.'),
      developer: {
        type: 'object', additionalProperties: false,
        description: 'The code this domain is carried out by, and how it behaves. This is the only place where routes, functions, tables, events, status codes, headers and timeouts are named.',
        properties: {
          routes: places('The routes a reader comes in by (code.route keys).'),
          functions: places('The functions that do the work (code.symbol keys).'),
          tables: places('The tables it reads or writes (code.table keys).'),
          events: places('The events it publishes or consumes (code.channel keys).'),
          notes: list('How the code behaves: its status codes, headers, timeouts and retries, each grounded on the places above.'),
        },
      },
    },
  };
}
