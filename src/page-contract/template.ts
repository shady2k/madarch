/**
 * A product's page templates as files (decision 0036, section 6): every file under the product's `templates/`, its
 * sections, and the resolution of `extends` into one ordered page whose sections carry the component they name.
 *
 * The file's name is the template's name (`templates/entity.yaml` is `entity`), the YAML is judged against the schema
 * of section 6, and a section's parameters are judged by its component's schema of section 7 — every refusal names the
 * file and the line. Inheritance is resolved here once, so the server (which validates at start) and the app (which
 * composes a page) order a page's sections by one rule.
 */
import { isMap, isScalar, isSeq, parseDocument, type Node, type Pair } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { COMPONENT_SCHEMAS, TEMPLATE_SCHEMA, parametersSchema, type ComponentName } from './schema.js';
import { validateNode, type TemplateFinding } from './validate.js';

/** A text a template states in the interface languages. */
export interface LocalizedText {
  readonly [language: string]: string | undefined;
}

/** One section of a template file, as read. */
export interface PageSection {
  readonly id: string;
  readonly component: ComponentName;
  readonly on: 'subject' | 'root';
  readonly title?: LocalizedText;
  readonly roles?: { readonly show?: readonly string[]; readonly open?: readonly string[] };
  readonly after?: string;
  readonly replace: boolean;
  readonly query?: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The 1-based line the section starts on, for a refusal that names the section. */
  readonly line: number;
}

/** A variable a template declares (section 6). */
export interface TemplateVariable {
  readonly type: string;
  readonly required?: boolean;
  readonly default?: unknown;
}

/** One template file, as read from the product. */
export interface TemplateFile {
  readonly name: string;
  readonly file: string;
  readonly extends?: string;
  /** The kinds whose records open this template (the bootstrap's `recordTemplates`). */
  readonly records: readonly string[];
  /** The entities that open this template by their own id (the bootstrap's `ownTemplates`). */
  readonly entities: readonly string[];
  readonly variables: Readonly<Record<string, TemplateVariable>>;
  readonly sections: readonly PageSection[];
}

/** A template file read whole, or the findings that refuse it. */
export interface TemplateRead {
  readonly template?: TemplateFile;
  readonly findings: readonly TemplateFinding[];
}

/** The names a section's `roles.show` may hold when it holds none: every role, and the reader with none chosen. */
export const EVERY_ROLE = 'all';

function asRecord(node: unknown): Pair<unknown, unknown>[] {
  return isMap(node as Node) ? ((node as { items: Pair<unknown, unknown>[] }).items) : [];
}

function nodeValue(node: Node | null | undefined): unknown {
  if (node === null || node === undefined) return undefined;
  return (node as { toJSON?: () => unknown }).toJSON?.() ?? (isScalar(node) ? node.value : undefined);
}

function childOf(node: unknown, key: string): Node | undefined {
  for (const pair of asRecord(node)) {
    if (isScalar(pair.key) && String((pair.key as { value: unknown }).value) === key) return (pair.value ?? undefined) as Node | undefined;
  }
  return undefined;
}

/** The 1-based line a node starts on. */
function lineOfText(text: string, node: Node | null | undefined): number {
  let line = 1;
  const limit = node?.range?.[0] ?? 0;
  for (let at = 0; at < limit && at < text.length; at += 1) if (text.charCodeAt(at) === 10) line += 1;
  return line;
}

function stringsOf(node: unknown): string[] {
  return Array.isArray(node) ? node.filter((one): one is string => typeof one === 'string') : [];
}

/**
 * Reads one template's text. `name` is the first finding's name and the template's own when the file states none; the
 * file's name decides the template (`templates/code.file.yaml` is the template `code.file`).
 */
export function readTemplate(text: string, options: { readonly name: string; readonly file?: string }): TemplateRead {
  const file = options.file ?? `templates/${options.name}.yaml`;
  const document = parseDocument(text, { keepSourceTokens: false });
  const findings: TemplateFinding[] = [];
  for (const error of document.errors) {
    const at = error.linePos?.[0];
    findings.push({ file, line: at?.line ?? 1, path: '', message: error.message });
  }
  if (findings.length > 0 || document.contents === null) {
    if (findings.length === 0) findings.push({ file, line: 1, path: '', message: 'the template file is empty' });
    return { findings };
  }
  const root = document.contents as Node;
  findings.push(...validateNode(text, root, TEMPLATE_SCHEMA, file));
  // The declared template's name is the file's: two spellings of one template would serve two pages.
  const stated = childOf(root, 'template');
  if (isScalar(stated) && String(stated.value) !== options.name) {
    findings.push({ file, line: lineOfText(text, stated), path: 'template', message: `the template names itself "${String(stated.value)}"; a template is its file's name, "${options.name}"` });
  }
  const sections: PageSection[] = [];
  const sectionNodes = childOf(root, 'sections');
  if (sectionNodes !== undefined && isSeq(sectionNodes)) {
    sectionNodes.items.forEach((item, at) => {
      const sectionNode = item as Node;
      const componentNode = childOf(sectionNode, 'component');
      const component = isScalar(componentNode) ? String(componentNode.value) : '';
      const idNode = childOf(sectionNode, 'id');
      const id = isScalar(idNode) ? String(idNode.value) : '';
      // The component's own parameters, judged at the node that holds them: a key the component does not take is a finding on that key.
      const paramsNode = childOf(sectionNode, 'params');
      if (paramsNode !== undefined && (Object.keys(COMPONENT_SCHEMAS) as string[]).includes(component)) {
        findings.push(...validateNode(text, paramsNode, parametersSchema(component as ComponentName), file, `sections.${id === '' ? String(at) : id}.params`));
      }
      const queryNode = childOf(sectionNode, 'query');
      if ((isScalar(queryNode) ? String(queryNode.value).trim() : '') === '' && component !== 'tabs' && component !== 'search') {
        findings.push({ file, line: lineOfText(text, sectionNode), path: `sections.${id === '' ? String(at) : id}`, message: `the section "${id}" draws the ${component} component and states no query: a section's data is the graph's answer to its query` });
      }
      const onNode = childOf(sectionNode, 'on');
      const on = isScalar(onNode) && onNode.value === 'root' ? 'root' : 'subject';
      const replaceNode = childOf(sectionNode, 'replace');
      const afterNode = childOf(sectionNode, 'after');
      const rolesNode = childOf(sectionNode, 'roles');
      const titleNode = childOf(sectionNode, 'title');
      sections.push({
        id,
        component: component as ComponentName,
        on,
        ...(titleNode === undefined ? {} : { title: nodeValue(titleNode) as LocalizedText }),
        ...(rolesNode === undefined ? {} : { roles: nodeValue(rolesNode) as { show?: string[]; open?: string[] } }),
        ...(isScalar(afterNode) ? { after: String(afterNode.value) } : {}),
        replace: isScalar(replaceNode) ? replaceNode.value === true : false,
        ...(isScalar(queryNode) ? { query: String(queryNode.value) } : {}),
        params: (nodeValue(paramsNode) ?? {}) as Record<string, unknown>,
        line: lineOfText(text, sectionNode),
      });
    });
  }
  if (findings.length > 0) return { findings };
  const variablesNode = childOf(root, 'variables');
  return {
    findings,
    template: {
      name: options.name,
      file,
      ...(isScalar(childOf(root, 'extends')) ? { extends: String((childOf(root, 'extends') as { value: unknown }).value) } : {}),
      records: stringsOf(nodeValue(childOf(root, 'records'))),
      entities: stringsOf(nodeValue(childOf(root, 'entities'))),
      variables: (nodeValue(variablesNode) ?? {}) as Record<string, TemplateVariable>,
      sections,
    },
  };
}

/** The template a page opens with and the sections it draws, after inheritance. */
export interface ResolvedTemplate {
  readonly name: string;
  readonly sections: readonly PageSection[];
  readonly variables: Readonly<Record<string, TemplateVariable>>;
}

/** Resolves a template's inheritance: the base's sections first, then `after` and `replace` as the section states them. */
export function resolveTemplate(name: string, templates: ReadonlyMap<string, TemplateFile>): { resolved?: ResolvedTemplate; findings: TemplateFinding[] } {
  const findings: TemplateFinding[] = [];
  const chain: TemplateFile[] = [];
  const seen = new Set<string>();
  let cursor: TemplateFile | undefined = templates.get(name);
  if (cursor === undefined) {
    return { findings: [{ file: 'templates', line: 1, path: '', message: `no template is called "${name}": the product's templates are ${[...templates.keys()].sort(byCodePoint).join(', ') || 'none'}` }] };
  }
  while (cursor !== undefined) {
    if (seen.has(cursor.name)) {
      findings.push({ file: cursor.file, line: 1, path: 'extends', message: `the templates ${[...seen, cursor.name].join(' extends ')} form a cycle` });
      return { findings };
    }
    seen.add(cursor.name);
    chain.unshift(cursor);
    if (cursor.extends === undefined) break;
    const base = templates.get(cursor.extends);
    if (base === undefined) {
      findings.push({ file: cursor.file, line: 1, path: 'extends', message: `${cursor.name} extends "${cursor.extends}", and the product holds no such template` });
      return { findings };
    }
    cursor = base;
  }
  let ordered: PageSection[] = [...chain[0]!.sections];
  let variables: Record<string, TemplateVariable> = { ...chain[0]!.variables };
  for (const template of chain.slice(1)) {
    variables = { ...variables, ...template.variables };
    for (const section of template.sections) {
      const at = ordered.findIndex((one) => one.id === section.id);
      if (section.replace) {
        if (at < 0) {
          findings.push({ file: template.file, line: section.line, path: `sections.${section.id}`, message: `the section "${section.id}" replaces an inherited section, and no template ${template.name} extends holds one` });
          continue;
        }
        ordered = [...ordered.slice(0, at), section, ...ordered.slice(at + 1)];
        continue;
      }
      if (section.after !== undefined) {
        const anchor = ordered.findIndex((one) => one.id === section.after);
        if (anchor < 0) {
          findings.push({ file: template.file, line: section.line, path: `sections.${section.id}`, message: `the section "${section.id}" is placed after "${section.after}", which the page does not hold` });
          continue;
        }
        ordered = [...ordered.slice(0, anchor + 1), section, ...ordered.slice(anchor + 1)];
        continue;
      }
      // A section with no `after` is appended to the page it inherits.
      ordered = [...ordered, section];
    }
  }
  const ids = new Map<string, PageSection>();
  for (const section of ordered) {
    const held = ids.get(section.id);
    if (held !== undefined) {
      findings.push({ file: templates.get(name)!.file, line: section.line, path: `sections.${section.id}`, message: `two sections are called "${section.id}": a page's section ids are unique after inheritance (the first stands at line ${String(held.line)})` });
      continue;
    }
    ids.set(section.id, section);
  }
  if (findings.length > 0) return { findings };
  return { findings, resolved: { name, sections: ordered, variables } };
}

/** A section shown to the asked role: its `roles.show` holds the role, `all`, or nothing at all. */
export function sectionShownFor(section: PageSection, role: string): boolean {
  const show = section.roles?.show;
  return show === undefined || show.length === 0 || show.includes(EVERY_ROLE) || show.includes(role);
}
