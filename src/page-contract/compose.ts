/**
 * The page composer (decision 0036, sections 6 and 9): a bootstrap, an address and the product's templates become one
 * GraphQL operation, its variables and the section each alias answers.
 *
 * One page view is one operation: every section is one aliased root field — a subject section reads the page's entity
 * through `entity(id: $id)` and its inline fragment, a root section is the root field it writes — and the operation
 * declares `$id`, `$lang`, `$role`, the template's variables and the paging variables its sections use, and no other.
 * The server validates a product's templates with this module before it serves; the app composes each page with it, so
 * a page's shape has one implementation.
 */
import { typeNameOf } from '../graphql/names.js';
import { byCodePoint } from '../model/order.js';
import { sectionShownFor, readTemplate, resolveTemplate, type LocalizedText, type PageSection, type TemplateFile, type TemplateVariable } from './template.js';
import type { TemplateFinding } from './validate.js';

/** The bootstrap the app reads once (section 1): the home, the templates, what opens each page and the roles. */
export interface Bootstrap {
  readonly structureRevision: string;
  readonly home: { readonly id: string; readonly kind: string; readonly template: string } | null;
  readonly catalogueTemplate: string;
  readonly templates: readonly { readonly name: string; readonly body: string }[];
  readonly recordTemplates: readonly { readonly kind: string; readonly template: string }[];
  readonly ownTemplates: readonly { readonly id: string; readonly template: string }[];
  readonly roles: readonly string[];
}

/** Where a page is opened: an entity's kind and id, or a template bound to no entity, and the address's own parameters. */
export interface PageAddress {
  /** The entity's kind as the graph answers it (`catalogue` for a catalogue entity). */
  readonly kind?: string;
  readonly id?: string;
  /** `/p/<template>`: a template bound to no entity. */
  readonly template?: string;
  /** `/`: the page is the bootstrap's home entity. */
  readonly home?: boolean;
  readonly params?: Readonly<Record<string, string>>;
  readonly lang?: string;
  readonly role?: string;
}

/** One section of a composed page: the template's section, the alias its data answers under, and what it shows. */
export interface ComposedSection extends PageSection {
  readonly alias: string;
}

/** A page's composition: the template it opens, one operation, its variables and its sections; findings refuse it. */
export interface PageComposition {
  readonly template: string;
  readonly operation: string;
  readonly variables: Record<string, unknown>;
  readonly sections: readonly ComposedSection[];
  readonly findings: readonly TemplateFinding[];
}

/** The alias one section's data answers under. */
export function aliasOf(sectionId: string): string {
  return `s_${sectionId}`;
}

/** The template a page opens with (section 6): its own, else its kind's record template, else `entity`. */
export function templateFor(bootstrap: Bootstrap, address: PageAddress): string {
  if (address.template !== undefined) return address.template;
  // The home page opens the home entity's template; a product whose graph holds no home entity still opens `home`.
  if (address.home === true) return bootstrap.home?.template ?? (bootstrap.templates.some((one) => one.name === 'home') ? 'home' : 'entity');
  const own = address.id === undefined ? undefined : bootstrap.ownTemplates.find((one) => one.id === address.id);
  if (own !== undefined) return own.template;
  if (address.kind === CATALOGUE_KIND) return bootstrap.catalogueTemplate;
  const record = address.kind === undefined ? undefined : bootstrap.recordTemplates.find((one) => one.kind === address.kind);
  if (record !== undefined) return record.template;
  return 'entity';
}

/** The kind the graph answers for a catalogue entry (section 3): its page is the catalogue template's. */
export const CATALOGUE_KIND = 'catalogue';

/** Every template of a bootstrap, read; a template the product's files could not be read as is a finding. */
export function templatesOf(bootstrap: Bootstrap): { templates: Map<string, TemplateFile>; findings: TemplateFinding[] } {
  const templates = new Map<string, TemplateFile>();
  const findings: TemplateFinding[] = [];
  for (const held of bootstrap.templates) {
    const read = readTemplate(held.body, { name: held.name });
    findings.push(...read.findings);
    if (read.template !== undefined) templates.set(held.name, read.template);
  }
  return { templates, findings };
}

const PAGING_TYPES: Readonly<Record<string, string>> = { first: 'Int', after: 'String' };

/** A value read at a dot path: `a.0.b`, `.` and the empty string stand for the value itself. */
export function valueAt(value: unknown, path: string): unknown {
  if (path === '' || path === '.') return value;
  let held: unknown = value;
  for (const part of path.split('.')) {
    if (part === '') continue;
    if (held === null || held === undefined) return undefined;
    if (Array.isArray(held)) {
      const at = Number(part);
      held = Number.isInteger(at) ? held[at] : undefined;
      continue;
    }
    if (typeof held !== 'object') return undefined;
    held = (held as Record<string, unknown>)[part];
  }
  return held;
}

/** The address parameters coerced to a declared variable's type, or a finding naming the value it could not read. */
function coerced(value: string, type: string): { value: unknown } | { refusal: string } {
  const list = type.startsWith('[');
  if (list || type === 'JSON') {
    try {
      return { value: JSON.parse(value) as unknown };
    } catch {
      return { refusal: `${JSON.stringify(value)} is not JSON, and the variable is ${type}` };
    }
  }
  if (type === 'Int' || type === 'Float') {
    const number = Number(value);
    return Number.isFinite(number) ? { value: type === 'Int' ? Math.trunc(number) : number } : { refusal: `${JSON.stringify(value)} is not a number, and the variable is ${type}` };
  }
  if (type === 'Boolean') {
    if (value === 'true') return { value: true };
    if (value === 'false') return { value: false };
    return { refusal: `${JSON.stringify(value)} is neither true nor false, and the variable is Boolean` };
  }
  return { value };
}

/** Every variable a text uses, by name. */
function variablesUsed(text: string): Set<string> {
  const used = new Set<string>();
  for (const match of text.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/gu)) used.add(match[1]!);
  return used;
}

/**
 * One page's composition: the template its address opens, the sections its role shows, and the one operation they ask.
 * A page that cannot be composed answers its findings instead of an operation: a template the product does not hold, a
 * variable the address cannot bind, or a section whose query uses a variable nobody declares.
 */
export function composePage(bootstrap: Bootstrap, address: PageAddress): PageComposition {
  const read = templatesOf(bootstrap);
  const findings: TemplateFinding[] = [...read.findings];
  const template = templateFor(bootstrap, address);
  const resolved = resolveTemplate(template, read.templates);
  findings.push(...resolved.findings);
  const empty: PageComposition = { template, operation: '', variables: {}, sections: [], findings };
  if (resolved.resolved === undefined) return empty;
  const role = address.role ?? 'all';
  const lang = address.lang;
  const sections = resolved.resolved.sections.filter((section) => sectionShownFor(section, role));
  const subjectSections = sections.filter((section) => section.on === 'subject' && (section.query ?? '').trim() !== '');
  if (subjectSections.length > 0 && address.id === undefined) {
    return { ...empty, findings: [...findings, { file: 'templates', line: 1, path: '', message: `the page's sections read its entity, and the address names none (${subjectSections.map((one) => one.id).join(', ')})` }] };
  }
  const typeName = address.kind === undefined ? undefined : address.kind === CATALOGUE_KIND ? 'CatalogueEntity' : typeNameOf(address.kind);
  const declarations = new Map<string, string>();
  const values: Record<string, unknown> = {};
  const parts: string[] = [];
  const composed: ComposedSection[] = [];
  for (const section of sections) {
    const alias = aliasOf(section.id);
    const query = section.query ?? '';
    // A section that asks the graph nothing (`tabs`, `search`) is drawn by the page alone: it has no part in the operation.
    if (query.trim() === '') {
      composed.push({ ...section, alias });
      continue;
    }
    for (const used of variablesUsed(query)) {
      if (used === 'id') {
        declarations.set('id', 'ID!');
        values['id'] = address.id;
        continue;
      }
      if (used === 'lang') {
        declarations.set('lang', 'String');
        if (lang !== undefined) values['lang'] = lang;
        continue;
      }
      if (used === 'role') {
        declarations.set('role', 'String');
        values['role'] = role;
        continue;
      }
      const paging = /^(.+)_(first|after)$/u.exec(used);
      if (paging !== null && paging[1] === section.id) {
        const pagingType = PAGING_TYPES[paging[2]!]!;
        declarations.set(used, pagingType);
        if (paging[2] === 'after') continue;
        const pageSize = section.params['pageSize'];
        values[used] = typeof pageSize === 'number' ? pageSize : 50;
        continue;
      }
      const declared: TemplateVariable | undefined = resolved.resolved.variables[used];
      if (declared === undefined) {
        findings.push({ file: 'templates', line: section.line, path: `sections.${section.id}.query`, message: `the query of "${section.id}" uses $${used}, and the template declares no such variable (it declares $id, $lang, $role and its own $${section.id}_first and $${section.id}_after)` });
        continue;
      }
      declarations.set(used, declared.type);
      const bound = address.params?.[used];
      if (bound !== undefined) {
        const boundValue = coerced(bound, declared.type);
        if ('refusal' in boundValue) findings.push({ file: 'templates', line: section.line, path: `sections.${section.id}.query`, message: `$${used}: ${boundValue.refusal}` });
        else values[used] = boundValue.value;
      } else if (declared.default !== undefined) {
        values[used] = declared.default;
      } else if (declared.required === true) {
        findings.push({ file: 'templates', line: section.line, path: `sections.${section.id}.query`, message: `$${used} is required, and the address binds none: give ?${used}=<value>` });
      }
    }
    if (section.on === 'root') {
      parts.push(`  ${alias}: ${indentAfterFirstLine(query)}`);
    } else {
      declarations.set('id', 'ID!');
      declarations.set('lang', 'String');
      values['id'] = address.id;
      if (lang !== undefined) values['lang'] = lang;
      const fragment = typeName === undefined ? query : `... on ${typeName} {\n${indent(query, 4)}\n    }`;
      parts.push(`  ${alias}: entity(id: $id, lang: $lang) {\n    ${fragment}\n  }`);
    }
    composed.push({ ...section, alias });
  }
  if (findings.length > 0) return { ...empty, sections: composed, findings };
  const declared = [...declarations.entries()].sort(([left], [right]) => byCodePoint(left, right));
  const operation = declared.length === 0
    ? `{\n${parts.join('\n')}\n}`
    : `query Page(${declared.map(([name, type]) => `$${name}: ${type}`).join(', ')}) {\n${parts.join('\n')}\n}`;
  return { template, operation, variables: values, sections: composed, findings };
}

/** A root section's query, its continuation lines aligned under the alias it answers. */
function indentAfterFirstLine(query: string): string {
  const lines = query.trim().split('\n');
  return lines.map((line, at) => (at === 0 ? line : `  ${line}`)).join('\n');
}

/** A selection indented for the fragment it stands in. */
function indent(text: string, by: number): string {
  const pad = ' '.repeat(by);
  return text.trim().split('\n').map((line) => `${pad}${line}`).join('\n');
}

/** Each section's data out of one answer, keyed by the section's id. */
export function splitResponse(composition: PageComposition, data: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const section of composition.sections) out[section.id] = data?.[section.alias] ?? null;
  return out;
}

/** The title of a section in the reader's language, else English, else any language it holds. */
export function titleIn(title: LocalizedText | undefined, language: string): string | undefined {
  if (title === undefined) return undefined;
  return title[language] ?? title['en'] ?? Object.values(title).find((one) => typeof one === 'string' && one !== '');
}
