/**
 * The structure a use case, a rule and a decision carry (decision 0032, section 1; madarch-ztyq.5): the
 * fields the rules-and-decisions and scenarios units produce, the sections those fields are written as, and
 * what a page says where a field holds nothing.
 *
 * Three things are fixed here rather than left to a model's prose:
 *
 * - **the fields of each kind.** A use case is its actor, its goal, its preconditions, its main flow, its
 *   alternative flows, the rules that govern it and what implements it. A rule is its statement, where it
 *   applies, its exceptions and what implements it. A decision is its status, its context, the decision,
 *   its consequences and what implements it. A unit fills those fields; it does not choose the sections.
 * - **the sections' identities.** A section is named by the id of this declaration (`main-flow`,
 *   `consequences`), never by a line of a template, and its heading is the id's words in the product's
 *   language, so the same page written in English and in Russian keeps one structure.
 * - **what an empty field says.** A field a person's document does not settle is a statement about the
 *   document or about the graph, grounded on the passage the page enriches — `The document names no
 *   precondition for this use case.` — never a silent absence and never a guess. The same holds for a place
 *   the graph does not hold: a route that reaches no function is stated, not drawn as if it did.
 *
 * The places a page names (a route, a function, a table, a channel, a rule's section) are the unit's, and
 * each is resolved against the graph before the page is written (`src/writer/tools.ts`): the fields carry
 * keys, never a description of a key. The keys the implementation names are also the page's `relates`, so
 * the engine itself draws the use case's sequence diagram from the route the page relates (`:::sequence`,
 * decision 0032, section 8) — the writer states the structure and the graph, and the page's template draws.
 *
 * This is not yet the LiquidJS template path of decision 0032, section 8 (madarch-u3vw.1): a page's body is
 * built from the declarations below, with each section keeping its id, and the diagrams are left to the
 * engine's own template blocks. When the Liquid engine lands these sections become blocks of a kind
 * template, and the identities they carry here are the identities they take there.
 */
import { byCodePoint } from '../model/order.js';

/** The kinds of passage whose page carries a structure of its own: the unit table's rules, decisions and scenarios. */
export type StructuredKind = 'scenario' | 'rule' | 'decision';

/** The kinds a document reader may read a passage as. */
export function structuredKindOf(semantics: string): StructuredKind | undefined {
  return semantics === 'scenario' || semantics === 'rule' || semantics === 'decision' ? semantics : undefined;
}

/** The language a page's structure is written in: the wiki's two. */
export type StructuredLanguage = 'en' | 'ru';

export function structuredLanguage(language: string | undefined): StructuredLanguage {
  return language === 'ru' ? 'ru' : 'en';
}

/**
 * A statement of the page: the unit's sentence and the grounds that show it. The grounds are graph keys,
 * document sections (`doc:<path>#<anchor>`) or answered questions; each is resolved when the page is
 * written, and one that does not resolve is a refusal, never a sentence that stands alone.
 */
export interface GroundedStatement {
  readonly text: string;
  readonly grounds: readonly string[];
}

/** A place the unit names: a graph key or a document section, and the words a reader sees for it. */
export interface NamedPlace {
  readonly target: string;
  /** The words the page shows; absent, the graph's own name for the place. */
  readonly label?: string;
}

/** What implements a use case, a rule or a decision: the places in the code, each a key of the graph. */
export interface ImplementationFields {
  readonly routes?: readonly NamedPlace[];
  readonly functions?: readonly NamedPlace[];
  readonly tables?: readonly NamedPlace[];
  readonly events?: readonly NamedPlace[];
}

/** One alternative flow of a use case: what happens instead, and what happens then. */
export interface AlternativeFlow {
  readonly when: GroundedStatement;
  readonly steps: readonly GroundedStatement[];
}

export interface ScenarioFields {
  readonly title?: string;
  readonly actor: GroundedStatement;
  readonly goal: GroundedStatement;
  readonly preconditions: readonly GroundedStatement[];
  readonly mainFlow: readonly GroundedStatement[];
  readonly alternativeFlows: readonly AlternativeFlow[];
  /** The rules that govern the use case, each a document section of a rule. */
  readonly rules: readonly NamedPlace[];
  readonly implementation: ImplementationFields;
}

export interface RuleFields {
  readonly title?: string;
  readonly statement: GroundedStatement;
  readonly applies: readonly GroundedStatement[];
  readonly exceptions: readonly GroundedStatement[];
  readonly implementation: ImplementationFields;
}

export interface DecisionFields {
  readonly title?: string;
  readonly status: GroundedStatement;
  readonly context: readonly GroundedStatement[];
  readonly decision: readonly GroundedStatement[];
  readonly consequences: readonly GroundedStatement[];
  readonly implementation: ImplementationFields;
}

export type StructuredFields = ScenarioFields | RuleFields | DecisionFields;

/** One kind of place an implementation names, and the graph kind of node a key of it must be. */
export interface PlaceField {
  /** The field's name in `write_enrichment`, and the word the refusal uses. */
  readonly field: 'routes' | 'functions' | 'tables' | 'events';
  /** The graph kind a key of this field is: a route is a `code.route`, never a table. */
  readonly nodeKind: string;
  /** The section the field is written in. */
  readonly section: SectionId;
}

/**
 * The kinds of place a structured page names, in the order a reader reads them: the way in, what does the
 * work, what is stored, what is told. Each field holds one graph kind of node, so a table in `routes` is
 * refused rather than written.
 */
export const PLACE_FIELDS: readonly PlaceField[] = [
  { field: 'routes', nodeKind: 'code.route', section: 'implementation' },
  { field: 'functions', nodeKind: 'code.symbol', section: 'implementation' },
  { field: 'tables', nodeKind: 'code.table', section: 'implementation' },
  { field: 'events', nodeKind: 'code.channel', section: 'implementation' },
];

/** The ids of the sections a structured page is made of: its stable identities, never a line of a template. */
export type SectionId =
  | 'actor' | 'goal' | 'preconditions' | 'main-flow' | 'alternative-flows' | 'rules'
  | 'statement' | 'applies' | 'exceptions'
  | 'status' | 'context' | 'decision' | 'consequences'
  | 'implementation';

/** One section of a page: its id, the heading in each language, and what the page says where the field is empty. */
export interface SectionDecl {
  readonly id: SectionId;
  readonly heading: Readonly<Record<StructuredLanguage, string>>;
  /** What the page states where a person's document settles nothing for this section: said of the document, never of the world. */
  readonly gap?: Readonly<Record<StructuredLanguage, string>>;
}

/**
 * The sections of each kind, in the order a reader reads them. A use case ends with what implements it, a
 * rule and a decision too: the implementation is the last thing a reader needs and the first thing a
 * developer looks for.
 */
export const STRUCTURED_SECTIONS: Readonly<Record<StructuredKind, readonly SectionDecl[]>> = {
  scenario: [
    { id: 'actor', heading: { en: 'Actor', ru: 'Актор' } },
    { id: 'goal', heading: { en: 'Goal', ru: 'Цель' } },
    { id: 'preconditions', heading: { en: 'Preconditions', ru: 'Предусловия' }, gap: { en: 'The document names no precondition for this use case.', ru: 'Документ не называет предусловий этого сценария.' } },
    { id: 'main-flow', heading: { en: 'Main flow', ru: 'Основной поток' } },
    { id: 'alternative-flows', heading: { en: 'Alternative flows', ru: 'Альтернативные потоки' }, gap: { en: 'The document describes no alternative flow for this use case.', ru: 'Документ не описывает альтернативных потоков этого сценария.' } },
    { id: 'rules', heading: { en: 'Rules that govern it', ru: 'Правила, которые действуют' }, gap: { en: 'The document names no rule that governs this use case.', ru: 'Документ не называет правил, которые действуют в этом сценарии.' } },
    { id: 'implementation', heading: { en: 'Implementation', ru: 'Реализация' }, gap: { en: 'The graph holds no route and no function for this use case.', ru: 'В графе нет ни маршрута, ни функции для этого сценария.' } },
  ],
  rule: [
    { id: 'statement', heading: { en: 'Statement', ru: 'Формулировка' } },
    { id: 'applies', heading: { en: 'Where it applies', ru: 'Где действует' }, gap: { en: 'The document does not say where this rule applies.', ru: 'Документ не говорит, где действует это правило.' } },
    { id: 'exceptions', heading: { en: 'Exceptions', ru: 'Исключения' }, gap: { en: 'The document names no exception to this rule.', ru: 'Документ не называет исключений этого правила.' } },
    { id: 'implementation', heading: { en: 'Implementation', ru: 'Реализация' }, gap: { en: 'The graph holds no function that implements this rule.', ru: 'В графе нет функции, которая реализует это правило.' } },
  ],
  decision: [
    { id: 'status', heading: { en: 'Status', ru: 'Статус' } },
    { id: 'context', heading: { en: 'Context', ru: 'Контекст' }, gap: { en: 'The document states no context for this decision.', ru: 'Документ не называет контекста этого решения.' } },
    { id: 'decision', heading: { en: 'Decision', ru: 'Решение' } },
    { id: 'consequences', heading: { en: 'Consequences', ru: 'Последствия' }, gap: { en: 'The document names no consequence of this decision.', ru: 'Документ не называет последствий этого решения.' } },
    { id: 'implementation', heading: { en: 'Implementation', ru: 'Реализация' }, gap: { en: 'The graph holds no code that carries this decision out.', ru: 'В графе нет кода, который выполняет это решение.' } },
  ],
};

/** The words the page says about a place the graph does not carry through: a route that reaches no function. */
export const UNREACHED_ROUTE: Readonly<Record<StructuredLanguage, (route: string) => string>> = {
  en: (route) => `The route ${route} reaches no function of the graph.`,
  ru: (route) => `Маршрут ${route} не доходит ни до одной функции графа.`,
};

/** The id of the one section a kind's field belongs to, for a refusal that says where a value goes. */
export function sectionOf(kind: StructuredKind, id: SectionId): SectionDecl | undefined {
  return STRUCTURED_SECTIONS[kind].find((section) => section.id === id);
}

/** A place a page's section is about: what a refusal names when the field it came from is wrong. */
export interface FieldProblem {
  /** The line of the page the problem stands on; 1 before anything is written. */
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

/** The markdown label of a place: what a reader sees, with the characters that would break the link removed. */
export function labelOf(label: string): string {
  return label.replace(/[\[\]\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A ground or a place target as a page names it: `doc:<path>#<anchor>` or a graph key, without the scheme. */
export function targetOf(target: string): string {
  return target.startsWith('madarch:') ? target.slice('madarch:'.length) : target;
}

/**
 * The fields of one page, read from what a unit wrote: each field checked, and every problem returned at
 * once, with the section it belongs to, so a unit fixes its answer in one round. Nothing here resolves a
 * key: a key is checked against the graph by the caller, which is the only place that knows the graph.
 */
export function parseFields(kind: StructuredKind, value: unknown): { readonly ok: true; readonly fields: StructuredFields } | { readonly ok: false; readonly problems: readonly FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const problem = (rule: string, message: string): void => { problems.push({ line: 1, rule, message }); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: [{ line: 1, rule: 'fields', message: `the fields of this page are a mapping: ${STRUCTURED_SECTIONS[kind].map((section) => section.id).join(', ')}` }] };
  }
  const record = value as Record<string, unknown>;
  const statement = (name: string, field: unknown): GroundedStatement | undefined => {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) { problem('field', `"${name}" is a statement: an object with "text" (one sentence) and "grounds" (the places that show it)`); return undefined; }
    const held = field as Record<string, unknown>;
    const written = text(held['text']);
    if (written === undefined) { problem('field', `"${name}.text" is the sentence this part of the page states`); return undefined; }
    const grounds = Array.isArray(held['grounds']) ? held['grounds'].map((entry) => text(entry)).filter((entry): entry is string => entry !== undefined) : [];
    if (grounds.length === 0) { problem('field-ungrounded', `"${name}" holds no ground: every statement of a page stands on at least one graph key or document section (get_symbol, trace_flow or get_document_sections answers them)`); return undefined; }
    return { text: written, grounds: grounds.map(targetOf) };
  };
  const statements = (name: string, field: unknown): GroundedStatement[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of statements, one per part of the page it says`); return []; }
    return field.map((entry, index) => statement(`${name}[${index}]`, entry)).filter((entry): entry is GroundedStatement => entry !== undefined);
  };
  const places = (name: string, field: unknown): NamedPlace[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) { problem('field', `"${name}" is a list of places, each an object with "target" (a graph key or doc:<path>#<anchor>) and, when the graph's name is long, "label"`); return []; }
    return field.flatMap((entry, index) => {
      if (typeof entry === 'string') { const target = text(entry); if (target === undefined) { problem('field', `"${name}[${index}]" is an empty place`); return []; } return [{ target: targetOf(target) }]; }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problem('field', `"${name}[${index}]" is a place: a graph key or an object with "target" and an optional "label"`); return []; }
      const held = entry as Record<string, unknown>;
      const target = text(held['target']);
      if (target === undefined) { problem('field', `"${name}[${index}].target" is the graph key or doc:<path>#<anchor> of the place`); return []; }
      const label = text(held['label']);
      return [{ target: targetOf(target), ...(label === undefined ? {} : { label }) }];
    });
  };
  const implementation = (field: unknown): ImplementationFields => {
    if (field === undefined) return {};
    if (typeof field !== 'object' || field === null || Array.isArray(field)) { problem('field', '"implementation" is an object with the places that carry this out: routes, functions, tables and events, each a list of graph keys'); return {}; }
    const held = field as Record<string, unknown>;
    for (const name of Object.keys(held)) {
      if (!PLACE_FIELDS.some((place) => place.field === name)) problem('field', `"implementation.${name}" names nothing: the places are ${PLACE_FIELDS.map((place) => place.field).sort(byCodePoint).join(', ')}`);
    }
    return {
      ...(held['routes'] === undefined ? {} : { routes: places('implementation.routes', held['routes']) }),
      ...(held['functions'] === undefined ? {} : { functions: places('implementation.functions', held['functions']) }),
      ...(held['tables'] === undefined ? {} : { tables: places('implementation.tables', held['tables']) }),
      ...(held['events'] === undefined ? {} : { events: places('implementation.events', held['events']) }),
    };
  };
  const title = text(record['title']);
  const common = title === undefined ? {} : { title };
  if (kind === 'scenario') {
    const actor = statement('actor', record['actor']);
    const goal = statement('goal', record['goal']);
    const mainFlow = statements('mainFlow', record['mainFlow']);
    if (mainFlow.length === 0) problem('field', '"mainFlow" is the steps of the use case in the order the story tells them, one statement each');
    const flows = Array.isArray(record['alternativeFlows'])
      ? record['alternativeFlows'].flatMap((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problem('field', `"alternativeFlows[${index}]" is an object with "when" and "steps"`); return []; }
        const held = entry as Record<string, unknown>;
        const when = statement(`alternativeFlows[${index}].when`, held['when']);
        const steps = statements(`alternativeFlows[${index}].steps`, held['steps']);
        if (when === undefined) return [];
        if (steps.length === 0) problem('field', `"alternativeFlows[${index}].steps" is what happens instead, one statement each`);
        return [{ when, steps }];
      })
      : [];
    if (record['alternativeFlows'] !== undefined && !Array.isArray(record['alternativeFlows'])) problem('field', '"alternativeFlows" is a list of flows, each with "when" and "steps"');
    // Every field is parsed before the page is judged: a field whose statement carries no ground is a problem of
    // its own, never a part that vanishes and lets the page say the document names none (madarch-ztyq.5, review).
    const preconditions = statements('preconditions', record['preconditions']);
    const rules = places('rules', record['rules']);
    const carried = implementation(record['implementation']);
    if (problems.length > 0 || actor === undefined || goal === undefined) return { ok: false, problems };
    return { ok: true, fields: { ...common, actor, goal, preconditions, mainFlow, alternativeFlows: flows, rules, implementation: carried } };
  }
  if (kind === 'rule') {
    const written = statement('statement', record['statement']);
    const applies = statements('applies', record['applies']);
    const exceptions = statements('exceptions', record['exceptions']);
    const carried = implementation(record['implementation']);
    if (problems.length > 0 || written === undefined) return { ok: false, problems };
    return { ok: true, fields: { ...common, statement: written, applies, exceptions, implementation: carried } };
  }
  const status = statement('status', record['status']);
  const decision = statements('decision', record['decision']);
  if (decision.length === 0) problem('field', '"decision" is what was decided, one statement each');
  const context = statements('context', record['context']);
  const consequences = statements('consequences', record['consequences']);
  const carried = implementation(record['implementation']);
  if (problems.length > 0 || status === undefined) return { ok: false, problems };
  return { ok: true, fields: { ...common, status, context, decision, consequences, implementation: carried } };
}

/** The implementation's places of one page: the way in first, then what does the work, then what is stored and told. */
export function implementationPlaces(fields: StructuredFields): readonly (NamedPlace & { readonly field: PlaceField['field']; readonly nodeKind: string })[] {
  const out: (NamedPlace & { field: PlaceField['field']; nodeKind: string })[] = [];
  for (const place of PLACE_FIELDS) {
    for (const named of [...(fields.implementation[place.field] ?? [])].sort((left, right) => byCodePoint(left.target, right.target))) out.push({ ...named, field: place.field, nodeKind: place.nodeKind });
  }
  return out;
}

/** The keys the page's implementation names, in code point order: what its `relates` says and what the engine draws the flow from. */
export function relatesOf(fields: StructuredFields): readonly string[] {
  return [...new Set(implementationPlaces(fields).map((place) => place.target))].sort(byCodePoint);
}

/** How a page's section names a place in a sentence or in a bullet. */
export interface RenderContext {
  readonly language: StructuredLanguage;
  /** The graph's own name for a place, or the unit's label; undefined when the place is not in the graph. */
  readonly labelOf: (target: string) => string | undefined;
  /** The passage the page enriches: the ground of a statement about what the document settles. */
  readonly passage: string;
  /** The routes of a use case that reach no function of the graph, as the trace of the graph found them. */
  readonly unreachedRoutes: readonly string[];
}

/** The state one page's rendering carries: the footnote each statement gets, in order of appearance. */
export class PageWriter {
  private readonly lines: string[] = [];
  private readonly notes: string[] = [];
  private count = 0;

  constructor(private readonly context: RenderContext) {}

  /** The language the page is written in, for the words the core adds. */
  get language(): StructuredLanguage {
    return this.context.language;
  }

  /** The link a place is shown as: its label, then the `madarch:` target. */
  linkOf(target: string): string {
    return this.linkTo({ target });
  }

  /**
   * A statement: its sentence, then the footnote that lists its grounds. The labels are numbers, which the writer
   * never keeps as a statement's name (`isNumbered`, `src/writer/names.ts`): it names each statement for what the
   * sentence says, and keeps the name a sentence had on the page this one replaces.
   */
  statement(statement: GroundedStatement, prefix = ''): void {
    this.count += 1;
    const label = String(this.count);
    this.lines.push(`${prefix}${withReference(statement.text, label)}`);
    this.notes.push(`[^${label}]: ${this.groundsOf(statement.grounds)}`);
  }

  /** A statement of the page about the document or the graph, grounded on the passage it enriches. */
  gap(sentence: string): void {
    this.statement({ text: sentence, grounds: [this.context.passage] });
  }

  /** A place the page names in a bullet of its own: the link, then a footnote on the place and on the passage. */
  place(place: NamedPlace): void {
    this.count += 1;
    const label = String(this.count);
    this.lines.push(`- ${this.linkTo(place)}[^${label}]`);
    this.notes.push(`[^${label}]: ${this.groundsOf([place.target, this.context.passage])}`);
  }

  empty(): void { this.lines.push(''); }
  heading(section: { readonly heading: Readonly<Record<StructuredLanguage, string>> }): void {
    if (this.lines.length > 0) this.lines.push('');
    this.lines.push(`## ${section.heading[this.context.language]}`);
    this.lines.push('');
  }
  bullet(statement: GroundedStatement): void { this.statement(statement, '- '); }
  raw(line: string): void { this.lines.push(line); }

  get body(): string {
    return `${this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n\n${this.notes.join('\n')}\n`;
  }

  private linkTo(place: NamedPlace): string {
    const shown = labelOf(place.label ?? this.context.labelOf(place.target) ?? place.target);
    return `[${shown}](madarch:${place.target})`;
  }

  private groundsOf(grounds: readonly string[]): string {
    return [...new Set(grounds)].map((target) => `[${labelOf(this.context.labelOf(target) ?? target)}](madarch:${target})`).join(', ');
  }
}

/**
 * A sentence with its footnote reference where the format reads it: after the sentence's own punctuation, and before
 * a question link that closes it — the format takes such a link as the suffix of the sentence it concerns and allows
 * nothing after it (`question-link-position`, `src/writer/format.ts`).
 */
export function withReference(text: string, label: string): string {
  const sentence = text.replace(/\s+/g, ' ').trim();
  const at = closingQuestionLinkAt(sentence);
  if (at < 0) return `${sentence}[^${label}]`;
  return `${sentence.slice(0, at).trimEnd()}[^${label}] ${sentence.slice(at)}`;
}

/** Where the question link that closes a sentence starts, or -1 when the sentence ends in something else. */
function closingQuestionLinkAt(sentence: string): number {
  if (!sentence.endsWith(')')) return -1;
  const marker = '](madarch:question:';
  const target = sentence.lastIndexOf(marker);
  if (target < 0 || sentence.indexOf(')', target) !== sentence.length - 1) return -1;
  const start = sentence.lastIndexOf('[', target);
  return start < 0 ? -1 : start;
}

/** What one page's body is: the sections of its kind as Markdown, and the places it relates. */
export interface StructuredBody {
  readonly body: string;
  readonly relates: readonly string[];
}

/**
 * The body of a structured page: its sections in the kind's order, each from the unit's fields, and each
 * field that holds nothing said as a gap grounded on the passage the page enriches.
 */
export function renderStructuredBody(kind: StructuredKind, fields: StructuredFields, context: Omit<RenderContext, 'unreachedRoutes'> & { readonly unreachedRoutes?: readonly string[] }): StructuredBody {
  const page = new PageWriter({ ...context, unreachedRoutes: context.unreachedRoutes ?? [] });
  const language = context.language;
  for (const section of STRUCTURED_SECTIONS[kind]) {
    page.heading(section);
    const gap = (): void => {
      if (section.gap === undefined) return;
      page.gap(section.gap[language]);
    };
    if (kind === 'scenario') {
      const scenario = fields as ScenarioFields;
      switch (section.id) {
        case 'actor': page.statement(scenario.actor); break;
        case 'goal': page.statement(scenario.goal); break;
        case 'preconditions': if (scenario.preconditions.length === 0) gap(); else for (const one of scenario.preconditions) page.bullet(one); break;
        case 'main-flow': for (const step of scenario.mainFlow) page.bullet(step); break;
        case 'alternative-flows':
          if (scenario.alternativeFlows.length === 0) { gap(); break; }
          for (const flow of scenario.alternativeFlows) {
            page.bullet(flow.when);
            for (const step of flow.steps) page.statement(step, '  - ');
          }
          break;
        case 'rules': if (scenario.rules.length === 0) gap(); else for (const rule of scenario.rules) page.place(rule); break;
        case 'implementation': implementationSection(page, scenario.implementation, context.unreachedRoutes ?? [], gap); break;
        default: break;
      }
    } else if (kind === 'rule') {
      const rule = fields as RuleFields;
      switch (section.id) {
        case 'statement': page.statement(rule.statement); break;
        case 'applies': if (rule.applies.length === 0) gap(); else for (const one of rule.applies) page.bullet(one); break;
        case 'exceptions': if (rule.exceptions.length === 0) gap(); else for (const one of rule.exceptions) page.bullet(one); break;
        case 'implementation': implementationSection(page, rule.implementation, context.unreachedRoutes ?? [], gap); break;
        default: break;
      }
    } else {
      const decision = fields as DecisionFields;
      switch (section.id) {
        case 'status': page.statement(decision.status); break;
        case 'context': if (decision.context.length === 0) gap(); else for (const one of decision.context) page.bullet(one); break;
        case 'decision': for (const one of decision.decision) page.bullet(one); break;
        case 'consequences': if (decision.consequences.length === 0) gap(); else for (const one of decision.consequences) page.bullet(one); break;
        case 'implementation': implementationSection(page, decision.implementation, context.unreachedRoutes ?? [], gap); break;
        default: break;
      }
    }
  }
  return { body: page.body, relates: relatesOf(fields) };
}

/** The implementation section: the places that carry the page out, and what the graph does not carry through. */
function implementationSection(page: PageWriter, implementation: ImplementationFields, unreachedRoutes: readonly string[], gap: () => void): void {
  const places = PLACE_FIELDS.flatMap((field) => [...(implementation[field.field] ?? [])].sort((left, right) => byCodePoint(left.target, right.target)));
  if (places.length === 0) { gap(); return; }
  for (const place of places) page.place(place);
  for (const route of [...unreachedRoutes].sort(byCodePoint)) page.gap(UNREACHED_ROUTE[page.language](page.linkOf(route)));
}

/** The JSON schema of a page's fields, as `write_enrichment` declares them to a unit. */
export function structuredSchema(kind: StructuredKind): Record<string, unknown> {
  const groundSchema = { type: 'array', items: { type: 'string' }, description: 'The graph keys or doc:<path>#<anchor> sections that show this sentence; at least one.' };
  const statement = (description: string): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required: ['text', 'grounds'], properties: { text: { type: 'string', description: `${description} One sentence, in the wiki language, in your own words.` }, grounds: groundSchema } });
  const list = (description: string): Record<string, unknown> => ({ type: 'array', description, items: statement('One part of it.') });
  const places = (description: string): Record<string, unknown> => ({
    type: 'array',
    description,
    items: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'string', description: 'A graph key as the tools give it, or doc:<path>#<anchor> for a rule of the documents.' }, label: { type: 'string', description: 'The words a reader sees, when the graph\'s own name says too little.' } } },
  });
  const implementation = {
    type: 'object',
    additionalProperties: false,
    description: 'What carries this out, each a graph key you read with get_symbol, trace_flow or get_context. Leave a kind out when it carries nothing; name nothing you did not resolve.',
    properties: { routes: places('The routes this comes in by (code.route keys).'), functions: places('The functions that do the work (code.symbol keys).'), tables: places('The tables it reads or writes (code.table keys).'), events: places('The events it publishes or consumes (code.channel keys).') },
  };
  const title = { type: 'string', description: 'The page title, in the wiki language: the passage\'s own identifier and what it is, in the reader\'s words.' };
  if (kind === 'scenario') return {
    type: 'object', additionalProperties: false, required: ['actor', 'goal', 'mainFlow'], description: 'The parts of one use case.',
    properties: { title, actor: statement('Who does this, in the reader\'s words.'), goal: statement('What they want to be true when it is done.'), preconditions: list('What must hold before it starts; leave it out when the document names none.'), mainFlow: list('The steps of the story, in the order the document tells them.'), alternativeFlows: { type: 'array', description: 'What happens instead, one entry per branch the document describes.', items: { type: 'object', additionalProperties: false, required: ['when', 'steps'], properties: { when: statement('The condition the branch starts with.'), steps: list('What happens then.') } } }, rules: places('The rules that govern this use case, each the doc:<path>#<anchor> of the rule\'s section (get_document_sections answers it).'), implementation },
  };
  if (kind === 'rule') return {
    type: 'object', additionalProperties: false, required: ['statement'], description: 'The parts of one rule.',
    properties: { title, statement: statement('The rule itself, as a sentence a reader can check.'), applies: list('Where the rule applies; leave it out when the document does not say.'), exceptions: list('The exceptions the document names; leave it out when it names none.'), implementation },
  };
  return {
    type: 'object', additionalProperties: false, required: ['status', 'decision'], description: 'The parts of one decision, as an architecture decision record keeps them.',
    properties: { title, status: statement('Its status: accepted, proposed, replaced and the date the document gives.'), context: list('The situation that forced a decision; leave it out when the document states none.'), decision: list('What was decided, one statement per part of it.'), consequences: list('What follows from it; leave it out when the document names none.'), implementation },
  };
}
