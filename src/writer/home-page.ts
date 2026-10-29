/**
 * The shape of the home page (decision 0032, sections 1, 7 and 11; madarch-ztyq.7): the eight sections a reader
 * opens the wiki by, what the unit gives each of them, and what each section says when it has nothing.
 *
 * The page is a one-minute overview of the whole product: what it is and for whom, its main scenarios, how the
 * system is put together, its domains, the rules and decisions that matter, its technology and size, how complete
 * the wiki is, and what is not connected. Every section points at the page that says it in full — a document
 * section, a domain page, a part of the graph — instead of restating it, so the reader follows one link and reads
 * the whole thing.
 *
 * Three things are fixed here rather than left to a model's prose:
 *
 * - **the sections.** The eight sections are the page's structure, in the order a reader reads them; a unit fills
 *   their parts and does not choose the sections, and a part the unit leaves empty is said rather than left as an
 *   empty heading.
 * - **the links.** A part of the page that points at a page is a place with a sentence about it: the link first,
 *   then what the reader finds there. Every place is resolved when the page is written, and one that does not
 *   resolve is a refusal, never a link no reader can follow.
 * - **the identities.** A section is named by the id of this declaration, never by a line of a template, and its
 *   heading is the id's words in the product's language, so a page written in English and one written in Russian
 *   carry one structure and the same places.
 *
 * This is not the LiquidJS template path of decision 0032, section 8 (madarch-u3vw.1): the body is built from the
 * declarations below, and the section ids recorded here are the identities they take when it lands.
 */
import { byCodePoint } from '../model/order.js';
import { PageWriter, labelOf, targetOf, type GroundedStatement, type StructuredLanguage } from './structured.js';

/** The ids of the sections of a home page: its stable identities, never a line of a template. */
export type HomeSectionId = 'what-it-is' | 'scenarios' | 'system' | 'domains' | 'rules' | 'technology' | 'coverage' | 'not-connected';

/** The field of `HomeFields` a section is written from. */
export type HomeField = 'whatItIs' | 'scenarios' | 'system' | 'domains' | 'rules' | 'technology' | 'coverage' | 'notConnected';

/** How a section is written: the unit's sentences, or the places it names and the sentence it says about each. */
export type HomeShape = 'statements' | 'linked';

/** One section of the home page: its id, the field it is written from, its heading in each language, and its gap. */
export interface HomeSectionDecl {
  readonly id: HomeSectionId;
  readonly field: HomeField;
  readonly shape: HomeShape;
  readonly heading: Readonly<Record<StructuredLanguage, string>>;
  /** What the page states where the unit gave nothing: said of the documents and the graph, never of the world. */
  readonly gap?: Readonly<Record<StructuredLanguage, string>>;
}

/**
 * The sections of a home page, in the order a reader reads them, and what each says where the unit found nothing.
 * Every gap is a sentence about the documents and the graph this page stands on, because a missing edge is never
 * proof of absence (decision 0032, section 3).
 */
export const HOME_SECTIONS: readonly HomeSectionDecl[] = [
  { id: 'what-it-is', field: 'whatItIs', shape: 'statements', heading: { en: 'What the product is and for whom', ru: 'Что это за продукт и для кого' } },
  { id: 'scenarios', field: 'scenarios', shape: 'linked', heading: { en: 'Main scenarios', ru: 'Главные сценарии' }, gap: { en: 'The documents this page stands on name no main scenario of the product.', ru: 'Документы, на которых стоит эта страница, не называют главных сценариев продукта.' } },
  { id: 'system', field: 'system', shape: 'linked', heading: { en: 'How the system is put together', ru: 'Как устроена система' }, gap: { en: 'The graph this page stands on holds no part of the system to show.', ru: 'В графе, на котором стоит эта страница, нет частей системы, которые можно показать.' } },
  { id: 'domains', field: 'domains', shape: 'linked', heading: { en: 'Domains', ru: 'Домены' }, gap: { en: 'The product page names no domain of the product.', ru: 'Страница продукта не называет ни одного домена продукта.' } },
  { id: 'rules', field: 'rules', shape: 'linked', heading: { en: 'Key rules and decisions', ru: 'Главные правила и решения' }, gap: { en: 'The documents this page stands on name no rule and no decision of the product.', ru: 'Документы, на которых стоит эта страница, не называют правил и решений продукта.' } },
  { id: 'technology', field: 'technology', shape: 'statements', heading: { en: 'Technology and size', ru: 'Технологии и размер' }, gap: { en: 'The documents and the graph this page stands on say nothing about the technology.', ru: 'Документы и граф, на которых стоит эта страница, ничего не говорят о технологиях.' } },
  { id: 'coverage', field: 'coverage', shape: 'statements', heading: { en: 'How complete the wiki is', ru: 'Насколько полна вики' }, gap: { en: 'This page cannot yet say how much of the product the wiki covers.', ru: 'Эта страница пока не может сказать, насколько полно вики покрывает продукт.' } },
  { id: 'not-connected', field: 'notConnected', shape: 'statements', heading: { en: 'What is not connected', ru: 'Что не связано' }, gap: { en: 'The documents and the graph this page stands on leave nothing unconnected.', ru: 'В документах и графе, на которых стоит эта страница, не осталось ничего несвязанного.' } },
];

/**
 * A place the page points at, and the sentence it says about it: the section's own form of "this is said in
 * full there". The target is a page (`domain:<slug>`), a document section (`doc:<path>#<anchor>`) or a key of
 * the graph, and the grounds show the sentence the unit says about it.
 */
export interface HomeLink {
  readonly target: string;
  /** The words a reader sees for the place; absent, the graph's or the document's own name. */
  readonly label?: string;
  readonly text: string;
  readonly grounds: readonly string[];
}

/** The fields a home page is written from: the eight sections of the page, in the order they are read. */
export interface HomeFields {
  /** The page's title in the wiki's language; absent, the product's name. */
  readonly title?: string;
  /** What the product is and for whom: the page's first section and the only one it cannot be written without. */
  readonly whatItIs: readonly GroundedStatement[];
  /** The main scenarios, each pointing at the section of the document that tells it. */
  readonly scenarios: readonly HomeLink[];
  /** How the system is put together: the parts of the graph the product is made of, each with its page. */
  readonly system: readonly HomeLink[];
  /** The domains of the product, each pointing at its own page. */
  readonly domains: readonly HomeLink[];
  /** The rules and decisions that matter to a reader of the product, each pointing at the section that states it. */
  readonly rules: readonly HomeLink[];
  /** The technology and the size of the product. */
  readonly technology: readonly GroundedStatement[];
  /** How complete the wiki is: what it holds and what it does not hold yet. */
  readonly coverage: readonly GroundedStatement[];
  /** What is not connected: a part with no frontend, a document the product lacks. */
  readonly notConnected: readonly GroundedStatement[];
}

/** The statements of a section, whatever shape the section is written in. */
export function homeStatements(fields: HomeFields): readonly GroundedStatement[] {
  return [
    ...fields.whatItIs, ...fields.technology, ...fields.coverage, ...fields.notConnected,
    ...homeLinks(fields).map((row) => ({ text: row.text, grounds: row.grounds })),
  ];
}

/** The places the page points at, in the order the sections name them. */
export function homeLinks(fields: HomeFields): readonly HomeLink[] {
  return [...fields.scenarios, ...fields.system, ...fields.domains, ...fields.rules];
}

/** Every ground of the page, in the order it appears: what the writer resolves before a byte is written. */
export function homeGrounds(fields: HomeFields): readonly string[] {
  return [...new Set([
    ...homeStatements(fields).flatMap((statement) => statement.grounds),
    ...homeLinks(fields).map((row) => row.target),
  ])];
}

/** The keys the page's `relates` says: the graph keys it stands on, without the files and modules that hold everything. */
export function homeRelates(fields: HomeFields): readonly string[] {
  return [...new Set([
    ...homeStatements(fields).flatMap((statement) => statement.grounds),
    ...homeLinks(fields).map((row) => row.target),
  ].filter((target) => target.startsWith('code.') && !target.startsWith('code.file:') && !target.startsWith('code.module:')))].sort(byCodePoint);
}

/** The documents a page stands on, in code point order: the sources its front matter names. */
export function homeSources(fields: HomeFields): readonly string[] {
  const targets = [...homeStatements(fields).flatMap((statement) => statement.grounds), ...homeLinks(fields).map((row) => row.target)];
  return [...new Set(targets.filter((target) => target.startsWith('doc:')).map((target) => target.slice('doc:'.length).split('#')[0]!).filter((path) => path !== ''))].sort(byCodePoint);
}

/** A problem of one page's fields: the rule, the sentence a unit acts on, and where it lands (line 1: nothing is written yet). */
export interface HomeFieldProblem {
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/**
 * The fields of one home page, read from what a unit wrote: each field checked, every statement with its grounds,
 * and a place with the sentence the page says about it. Every field is parsed before the page is judged, so a
 * field that is invalid is a problem of its own and never a part that vanishes.
 */
export function parseHomeFields(value: unknown): { readonly ok: true; readonly fields: HomeFields } | { readonly ok: false; readonly problems: readonly HomeFieldProblem[] } {
  const problems: HomeFieldProblem[] = [];
  const problem = (rule: string, message: string): void => { problems.push({ line: 1, rule, message }); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: [{ line: 1, rule: 'fields', message: `the fields of a home page are a mapping: ${['title', ...HOME_SECTIONS.map((section) => section.field)].join(', ')}` }] };
  }
  const record = value as Record<string, unknown>;
  const statement = (name: string, field: unknown): GroundedStatement | undefined => {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) { problem('field', `"${name}" is a statement: an object with "text" (one sentence) and "grounds" (the places that show it)`); return undefined; }
    const held = field as Record<string, unknown>;
    const written = text(held['text']);
    if (written === undefined) { problem('field', `"${name}.text" is the sentence this part of the page states`); return undefined; }
    const grounds = Array.isArray(held['grounds']) ? held['grounds'].map((entry) => text(entry)).filter((entry): entry is string => entry !== undefined) : [];
    if (grounds.length === 0) { problem('field-ungrounded', `"${name}" holds no ground: every statement of a page stands on at least one graph key or document section (get_symbol, find_nodes or get_document_sections answers them)`); return undefined; }
    return { text: written, grounds: grounds.map(targetOf) };
  };
  const statements = (name: string, field: unknown): GroundedStatement[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of statements, one per part of the page it says`); return []; }
    return field.map((entry, index) => statement(`${name}[${index}]`, entry)).filter((entry): entry is GroundedStatement => entry !== undefined);
  };
  const links = (name: string, field: unknown): HomeLink[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of places, each an object with "target" (a page, a doc:<path>#<anchor> or a graph key) and the sentence the page says about it`); return []; }
    return field.flatMap((entry, index) => {
      const where = `${name}[${index}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problem('field', `"${where}" is a place: an object with "target", the sentence "text" the page says about it, and its "grounds"`); return []; }
      const held = entry as Record<string, unknown>;
      const target = text(held['target']);
      const written = text(held['text']);
      if (target === undefined) { problem('field', `"${where}.target" is the page, the doc:<path>#<anchor> or the graph key the section points at`); return []; }
      if (written === undefined) { problem('field', `"${where}.text" is the one sentence the page says about that place`); return []; }
      const grounds = Array.isArray(held['grounds']) ? held['grounds'].map((entry2) => text(entry2)).filter((entry2): entry2 is string => entry2 !== undefined) : [];
      if (grounds.length === 0) { problem('field-ungrounded', `"${where}" holds no ground: the sentence about a place stands on the same evidence as any other, a graph key or a document section`); return []; }
      const label = text(held['label']);
      return [{ target: targetOf(target), ...(label === undefined ? {} : { label }), text: written, grounds: grounds.map(targetOf) }];
    });
  };
  for (const name of Object.keys(record)) {
    if (name !== 'title' && !HOME_SECTIONS.some((section) => section.field === name)) problem('field', `"${name}" names nothing: the fields are ${['title', ...HOME_SECTIONS.map((section) => section.field)].join(', ')}`);
  }
  const title = text(record['title']);
  // Every field is parsed before the page is judged: a field whose statement carries no ground is a problem of its
  // own, never a part that vanishes and lets the page say the unit found nothing.
  const given = record['whatItIs'];
  const whatItIs = statements('whatItIs', given);
  if (whatItIs.length === 0 && (given === undefined || (Array.isArray(given) && given.length === 0))) {
    problem('field', '"whatItIs" is at least one grounded sentence: what the product is and for whom it is, so the page says what it is about before it points anywhere');
  }
  const fields: HomeFields = {
    ...(title === undefined ? {} : { title }),
    whatItIs,
    scenarios: links('scenarios', record['scenarios']),
    system: links('system', record['system']),
    domains: links('domains', record['domains']),
    rules: links('rules', record['rules']),
    technology: statements('technology', record['technology']),
    coverage: statements('coverage', record['coverage']),
    notConnected: statements('notConnected', record['notConnected']),
  };
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, fields };
}

/** What a home page is rendered from: the wiki's language, the names the graph gives the places, and its own identity. */
export interface HomeRenderContext {
  readonly language: StructuredLanguage;
  /** The graph's own name for a place, or the unit's label; undefined when the graph does not name it. */
  readonly labelOf: (target: string) => string | undefined;
  /** The page itself: its id, its kind and the title it takes when the unit gave none. */
  readonly page: { readonly id: string; readonly kind: string; readonly title: string };
}

/** What one rendered home page is: the whole file, front matter included, and the keys its `relates` names. */
export interface RenderedHomePage {
  readonly markdown: string;
  readonly relates: readonly string[];
}

/**
 * The whole page: its front matter, then the eight sections in the order of the declaration, each from the unit's
 * fields, and each part that holds nothing said as a gap grounded on the page's own evidence.
 */
export function renderHomePage(fields: HomeFields, context: HomeRenderContext): RenderedHomePage {
  const evidence = fields.whatItIs[0]?.grounds[0];
  if (evidence === undefined) throw new Error('src/writer/home-page.ts: a home page is written from at least one grounded sentence of what the product is, and this one has none');
  const page = new PageWriter({ language: context.language, labelOf: context.labelOf, passage: evidence, unreachedRoutes: [] });
  for (const section of HOME_SECTIONS) {
    page.heading(section);
    const gap = (): void => {
      if (section.gap === undefined) return;
      page.gap(section.gap[context.language]);
    };
    if (section.shape === 'linked') {
      const rows = fields[section.field] as readonly HomeLink[];
      if (rows.length === 0) { gap(); continue; }
      for (const row of rows) {
        const shown = labelOf(row.label ?? context.labelOf(row.target) ?? row.target);
        // The link is where the reader reads the whole thing; the sentence stands on its own grounds, because a
        // link is not a ground (`src/writer/format.ts`, link-is-not-a-ground).
        page.bullet({ text: `[${shown}](madarch:${row.target}) — ${row.text}`, grounds: row.grounds });
      }
      continue;
    }
    const statements = fields[section.field] as readonly GroundedStatement[];
    if (statements.length === 0) { gap(); continue; }
    for (const statement of statements) page.bullet(statement);
  }
  const relates = homeRelates(fields);
  return { markdown: `${homeFrontMatter(fields, context, relates)}\n${page.body}`, relates };
}

/** The page's front matter: what it is, the keys it relates, and the documents it stands on. */
function homeFrontMatter(fields: HomeFields, context: HomeRenderContext, relates: readonly string[]): string {
  const lines = ['---', `id: ${context.page.id}`, `kind: ${context.page.kind}`, `title: ${quoteYaml(fields.title ?? context.page.title)}`, 'relates:'];
  if (relates.length === 0) lines[lines.length - 1] = 'relates: []';
  else for (const key of relates) lines.push(`  - ${quoteYaml(key)}`);
  lines.push('producer: agent');
  const sources = homeSources(fields);
  if (sources.length === 0) lines.push('sources: []');
  else { lines.push('sources:'); for (const path of sources) lines.push(`  - ${quoteYaml(path)}`); }
  lines.push('---', '');
  return lines.join('\n');
}

/** A YAML scalar that reads back exactly as the words it holds, whatever punctuation a title carries. */
function quoteYaml(value: string): string {
  return JSON.stringify(labelOf(value)).replace(/\\u([0-9a-fA-F]{4})/g, (_whole, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** The JSON schema a unit is answered with: the eight sections of the page, described in the words of a person reading it. */
export function homeSchema(): Record<string, unknown> {
  const groundSchema = { type: 'array', items: { type: 'string' }, description: 'The graph keys or doc:<path>#<anchor> sections that show this sentence; at least one.' };
  const statement = (description: string): Record<string, unknown> => ({
    type: 'object', additionalProperties: false, required: ['text', 'grounds'],
    properties: { text: { type: 'string', description: `${description} One sentence, in the wiki language, in your own words.` }, grounds: groundSchema },
  });
  const list = (description: string): Record<string, unknown> => ({ type: 'array', description, items: statement('One part of it.') });
  const places = (description: string): Record<string, unknown> => ({
    type: 'array', description,
    items: {
      type: 'object', additionalProperties: false, required: ['target', 'text', 'grounds'],
      properties: {
        target: { type: 'string', description: 'The page it points at: domain:<slug>, a doc:<path>#<anchor> section, or a graph key.' },
        label: { type: 'string', description: 'The words a reader sees, when the place has no name of its own.' },
        text: { type: 'string', description: 'One sentence, in the wiki language, saying what the reader finds there.' },
        grounds: groundSchema,
      },
    },
  });
  return {
    type: 'object', additionalProperties: false, required: ['whatItIs'],
    description: 'The eight sections of the home page, in the order a reader reads them.',
    properties: {
      title: { type: 'string', description: 'The page title, in the wiki language, in the reader\'s words.' },
      whatItIs: list('What the product is and for whom, in the reader\'s words: the first thing the page says.'),
      scenarios: places('The main scenarios of the product, each pointing at the section of the document that tells it.'),
      system: places('How the system is put together: its services, modules and stores, each pointing at the part of the graph that shows it.'),
      domains: places('The domains of the product, each pointing at its own page (domain:<slug>); every declared domain appears here.'),
      rules: places('The rules and decisions that matter to a reader of the product, each pointing at the document section that states it.'),
      technology: list('The technology and the size of the product: the language, the frameworks, the stores, how many parts and files.'),
      coverage: list('How complete the wiki is: what the documents and the graph hold, and which of it this wiki covers.'),
      notConnected: list('What is not connected: a part with no frontend, a document the product lacks, a place the graph does not join.'),
    },
  };
}
