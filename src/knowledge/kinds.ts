/**
 * The product's entity kinds (decision 0029, "Manifests and templates live in
 * the product repository"): `madarch/kinds.yaml` in the product repository
 * declares which kinds the wiki shows, where each kind's entities come from
 * (the graph, or Markdown files in the product repository) and the template
 * that shows them. The engine holds no kind of its own: nothing here names a
 * kind, a folder or a template, and a product without the file has no pages.
 *
 * ```yaml
 * kinds:
 *   domain:  { template: templates/domain.md, source: markdown, folder: docs/domains }
 *   product: { template: templates/product.md, source: markdown, file: docs/product.md }
 *   code.service:
 *     template: templates/service.md
 *     source: graph
 *     title: label                 # the attribute that names a page; `label` by default
 *     attributes: [language]       # optional: the attributes a template may name
 *     labels:                      # optional: the kind's name per interface language
 *       en: { one: Service, many: Services }
 *       ru: { one: Сервис, many: Сервисы }
 *     relations:                   # optional: edges the product declares between kinds
 *       - { type: code.contains, to: "code.package:services/{label}" }
 * ```
 *
 * Every problem is a finding with the file and the line; a kind with a
 * problem is left out and the others still stand, so one bad line never blanks
 * the wiki and never passes unseen.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath } from '../model/yaml-position.js';
import { BLOCK_NAMES } from './template.js';

/** The manifest's place in the product repository. */
export const KINDS_FILE = 'madarch/kinds.yaml';

/** One problem in a product file the wiki reads: where it is and what it is. */
export interface Finding {
  file: string;
  line: number;
  message: string;
}

/** An edge the product declares between an entity of a kind and the entity at a key (decision 0029: the manifests hold the relations). */
export interface DeclaredRelation {
  /** The relation type the edge is shown as. */
  type: string;
  /** The key of the other end, with `{attribute}` standing for the entity's own attribute. */
  to: string;
  line: number;
}

/** How a kind's entities came to be: written by the agent, written by a person, read from the code, read from the history. */
export type Origin = 'agent' | 'person' | 'code' | 'history';
export const ORIGINS: readonly Origin[] = ['agent', 'person', 'code', 'history'];

/** A group of kinds in the navigation and the catalogue (`groups:` in the manifest). */
export interface GroupDecl {
  name: string;
  /** The group's name per interface language. */
  labels: Readonly<Record<string, string>>;
  line: number;
}

export interface KindDecl {
  name: string;
  /** The template's path in the product repository, `/`-separated. */
  template: string;
  /** `document`: the entities are identified sections of Markdown documents (use cases, rules, decisions, terms). */
  source: 'graph' | 'markdown' | 'document';
  /** The group the navigation and the catalogue put the kind in. */
  group?: string;
  /** How the kind's entities came to be, when it is not told by the entities themselves. */
  origin?: Origin;
  /** What the kind is, in plain words, per interface language. */
  descriptions?: Readonly<Record<string, string>>;
  /** Document kinds: the identifier prefixes (`UC` for `UC-2`) whose sections are entities of the kind; `*` is any other prefix. */
  identifier?: readonly string[];
  /** Document kinds: the documents (path patterns, `*` within a folder and `**` across folders) whose leading bold terms are entities of the kind. */
  terms?: readonly string[];
  /** Markdown kinds: the folder (many entities) or the file (one entity) the Markdown lives in. */
  folder?: string;
  file?: string;
  /** The attribute that names a page. */
  title: string;
  attributes?: readonly string[];
  relations: readonly DeclaredRelation[];
  /** The kind's name in each interface language: `one` for a badge, `many` for the navigation. */
  labels?: Readonly<Record<string, KindLabel>>;
  line: number;
}

/** A kind's name in one language, as a reader says it of one entity and of several. */
export interface KindLabel {
  one: string;
  many: string;
}

/** The renderers a diagram can open on (`diagram:` of the manifest). */
export const DIAGRAM_RENDERER_NAMES: readonly string[] = ['likec4', 'mermaid', 'archify'];

/** The languages the wiki's interface speaks; a label in another language is a finding. */
export const LABEL_LANGUAGES: readonly string[] = ['en', 'ru'];

/** The roles a reader can read as (decision 0031); "everything" is every role at once and needs no declaration. */
export const ROLE_NAMES = ['product', 'analyst', 'architect', 'developer', 'operations', 'tester'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** What a role changes on a page and in the navigation, as the manifest declares it (`roles:`). */
export interface RoleDecl {
  name: RoleName;
  /** The blocks of a template that stand open for the role (block names); the others stay on the page, collapsed. Absent: every block is open. */
  open?: readonly string[];
  /** The groups the navigation lists first for the role, in this order. */
  lead: readonly string[];
  line: number;
}

export interface KindsManifest {
  file: string;
  /** What each role changes; a role the manifest does not declare reads everything open in the manifest's order. */
  roles: ReadonlyMap<RoleName, RoleDecl>;
  /** The language the product's pages are written in (`language:` at the top of the manifest); absent means English. */
  language?: string;
  /** The renderer the diagrams open on (`diagram:` at the top of the manifest: likec4, mermaid or archify); absent means the environment's, else LikeC4. */
  diagram?: string;
  kinds: ReadonlyMap<string, KindDecl>;
  /** The groups of kinds, in the manifest's order. */
  groups: ReadonlyMap<string, GroupDecl>;
  /** Markdown documents the wiki does not list as documents (harness files, say), as path patterns. */
  excludeDocuments: readonly string[];
  findings: readonly Finding[];
  /** The manifest could not be read as a whole (not YAML, not a mapping, no `kinds` mapping): no kind is known, which is not the same as every kind having a finding. */
  unreadable?: true;
}

export type KindsRead =
  | { present: false; file: string }
  | { present: true; manifest: KindsManifest };

const KIND_KEYS = new Set(['template', 'source', 'folder', 'file', 'title', 'attributes', 'relations', 'labels', 'group', 'origin', 'description', 'identifier', 'terms']);

/** Whether a repository-relative path stays inside the folder: no climbing, not absolute. */
export function insideFolder(folder: string, path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0')) return false;
  const from = relative(resolve(folder), resolve(folder, path));
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}

function nothing(file: string, findings: Finding[]): KindsManifest {
  return { file, roles: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], findings, unreadable: true };
}

/** Reads `madarch/kinds.yaml` of a product folder; absent when the product holds none. */
export function readKinds(productFolder: string): KindsRead {
  const file = join(productFolder, KINDS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { present: false, file };
    return { present: true, manifest: nothing(file, [{ file, line: 1, message: `the file cannot be read: ${(error as Error).message}` }]) };
  }
  return { present: true, manifest: parseKinds(text, file, productFolder) };
}

/** Parses the manifest's text; `productFolder` lets a template's existence be judged. */
export function parseKinds(text: string, file: string, productFolder: string): KindsManifest {
  const findings: Finding[] = [];
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => lineForPath(doc, lines, path);
  for (const problem of doc.errors) findings.push({ file, line: problem.linePos?.[0].line ?? 1, message: problem.message.split('\n')[0] ?? problem.message });
  if (doc.errors.length > 0) return nothing(file, findings);
  const root: unknown = doc.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return nothing(file, [{ file, line: 1, message: 'the manifest is a mapping with a "kinds" mapping in it' }]);
  }
  const top = root as Record<string, unknown>;
  let language: string | undefined;
  let diagram: string | undefined;
  for (const key of Object.keys(top)) {
    if (key === 'language') {
      const value = top['language'];
      if (typeof value !== 'string' || !LABEL_LANGUAGES.includes(value)) findings.push({ file, line: at(['language']), message: `"language" is ${JSON.stringify(value)}: the pages are written in ${LABEL_LANGUAGES.join(' or ')}` });
      else language = value;
    } else if (key === 'diagram') {
      const value = top['diagram'];
      if (typeof value !== 'string' || !DIAGRAM_RENDERER_NAMES.includes(value)) findings.push({ file, line: at(['diagram']), message: `"diagram" is ${JSON.stringify(value)}: the diagrams open on ${DIAGRAM_RENDERER_NAMES.join(', ')}` });
      else diagram = value;
    } else if (key !== 'kinds' && key !== 'groups' && key !== 'documents' && key !== 'roles') findings.push({ file, line: at([key]), message: `"${key}" is not a field of the manifest: the manifest holds "kinds", "groups", "documents", "roles", "language" and "diagram"` });
  }
  const groups = new Map<string, GroupDecl>();
  const rawGroups = top['groups'];
  if (rawGroups !== undefined) {
    if (rawGroups === null || typeof rawGroups !== 'object' || Array.isArray(rawGroups)) findings.push({ file, line: at(['groups']), message: '"groups" maps a group name to its name in each language (en, ru)' });
    else {
      for (const [name, entry] of Object.entries(rawGroups as Record<string, unknown>)) {
        const body = entry as Record<string, unknown> | null;
        const line = at(['groups', name]);
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
          findings.push({ file, line, message: `group "${name}": the group is { en: <its name>, ru: <its name> }` });
          continue;
        }
        const labels: Record<string, string> = {};
        let bad = false;
        for (const [language, label] of Object.entries(body)) {
          if (!LABEL_LANGUAGES.includes(language)) { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": "${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}` }); bad = true; }
          else if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": the name in "${language}" is a text` }); bad = true; }
          else labels[language] = label;
        }
        if (!bad) groups.set(name, { name, labels, line });
      }
    }
  }
  const roles = new Map<RoleName, RoleDecl>();
  const rawRoles = top['roles'];
  if (rawRoles !== undefined) {
    if (rawRoles === null || typeof rawRoles !== 'object' || Array.isArray(rawRoles)) findings.push({ file, line: at(['roles']), message: `"roles" maps a role (${ROLE_NAMES.join(', ')}) to { open: [<block>, ...], lead: [<group>, ...] }` });
    else {
      for (const [name, entry] of Object.entries(rawRoles as Record<string, unknown>)) {
        const line = at(['roles', name]);
        if (!(ROLE_NAMES as readonly string[]).includes(name)) { findings.push({ file, line, message: `role "${name}": the roles are ${ROLE_NAMES.join(', ')}; "everything" is every role at once and is not declared` }); continue; }
        const body = entry as Record<string, unknown> | null;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) { findings.push({ file, line, message: `role "${name}": the declaration is { open: [<block>, ...], lead: [<group>, ...] }` }); continue; }
        const before = findings.length;
        for (const key of Object.keys(body)) if (key !== 'open' && key !== 'lead') findings.push({ file, line: at(['roles', name, key]), message: `role "${name}": "${key}" is not a field of a role: the fields are "open" and "lead"` });
        const list = (field: 'open' | 'lead'): string[] | undefined => {
          const value = body[field];
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) { findings.push({ file, line: at(['roles', name, field]), message: `role "${name}": "${field}" is a list of ${field === 'open' ? 'blocks of the library' : 'groups of "groups"'}` }); return undefined; }
          return value as string[];
        };
        const open = list('open');
        const lead = list('lead');
        for (const block of open ?? []) if (!(BLOCK_NAMES as readonly string[]).includes(block)) findings.push({ file, line: at(['roles', name, 'open']), message: `role "${name}": "${block}" is not a block of the library (${BLOCK_NAMES.join(', ')})` });
        for (const group of lead ?? []) if (!groups.has(group)) findings.push({ file, line: at(['roles', name, 'lead']), message: `role "${name}": "${group}" is not a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'})` });
        if (findings.length === before) roles.set(name as RoleName, { name: name as RoleName, ...(open === undefined ? {} : { open }), lead: lead ?? [], line });
      }
    }
  }
  const excludeDocuments: string[] = [];
  const rawDocuments = top['documents'];
  if (rawDocuments !== undefined) {
    const body = rawDocuments as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) findings.push({ file, line: at(['documents']), message: '"documents" is { exclude: [<path pattern>, ...] }' });
    else {
      for (const key of Object.keys(body)) if (key !== 'exclude') findings.push({ file, line: at(['documents', key]), message: `"${key}" is not a field of "documents": the field is "exclude"` });
      const exclude = body['exclude'];
      if (exclude !== undefined) {
        if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'exclude']), message: '"exclude" is a list of path patterns of documents the wiki does not list, such as "AGENTS.md" or "**/CHANGELOG.md"' });
        else excludeDocuments.push(...(exclude as string[]));
      }
    }
  }
  const declared = top['kinds'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    findings.push({ file, line: at(['kinds']), message: '"kinds" is a mapping of kind names to their declarations' });
    return { ...nothing(file, findings), groups, roles, excludeDocuments };
  }
  const kinds = new Map<string, KindDecl>();
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    const line = at(['kinds', name]);
    const problem = (path: (string | number)[], message: string): void => {
      // A field that is absent has no line of its own: the problem stands at the kind.
      const written = path.length === 0 || (value !== null && typeof value === 'object' && String(path[0]) in (value as object));
      findings.push({ file, line: written ? at(['kinds', name, ...path]) : line, message: `kind "${name}": ${message}` });
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push({ file, line, message: `kind "${name}": the declaration is a mapping with a template and a source` });
      continue;
    }
    const decl = value as Record<string, unknown>;
    const before = findings.length;
    for (const key of Object.keys(decl)) if (!KIND_KEYS.has(key)) problem([key], `"${key}" is not a field of a kind: the fields are ${[...KIND_KEYS].join(', ')}`);
    const source = decl['source'];
    if (source !== 'graph' && source !== 'markdown' && source !== 'document') problem(['source'], `"source" is "graph", "markdown" or "document", got ${JSON.stringify(source)}`);
    const template = decl['template'];
    if (typeof template !== 'string' || template.trim() === '') problem(['template'], '"template" names the template file in the product repository');
    else if (!insideFolder(productFolder, template)) problem(['template'], `the template "${template}" is not a path inside the product repository`);
    else if (!existsSync(join(productFolder, template)) || !statSync(join(productFolder, template)).isFile()) problem(['template'], `the template "${template}" does not exist in the product repository`);
    const folder = decl['folder'];
    const single = decl['file'];
    if (source === 'markdown') {
      if ((folder === undefined) === (single === undefined)) problem([], 'a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)');
      for (const [field, path] of [['folder', folder], ['file', single]] as const) {
        if (path !== undefined && (typeof path !== 'string' || !insideFolder(productFolder, path))) problem([field], `"${field}" is a path inside the product repository`);
      }
    } else if ((source === 'graph' || source === 'document') && (folder !== undefined || single !== undefined)) {
      problem([folder !== undefined ? 'folder' : 'file'], `a ${source} kind has no "folder" or "file": its entities come from the ${source === 'graph' ? 'graph' : 'documents'}`);
    }
    const identifier = decl['identifier'];
    const terms = decl['terms'];
    const names = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    const identifiers = typeof identifier === 'string' ? [identifier] : identifier;
    if (identifier !== undefined && (!names(identifiers) || !identifiers.every((entry) => entry === '*' || /^[A-Za-z]+$/.test(entry)))) problem(['identifier'], '"identifier" is the letters an identifier opens with ("UC" for UC-2), a list of them, or "*" for any other');
    if (terms !== undefined && !names(terms)) problem(['terms'], '"terms" is a list of path patterns of the documents whose leading bold terms are entities, such as "**/glossary.md"');
    if (source === 'document' && identifier === undefined && terms === undefined) problem([], 'a document kind names "identifier" (the sections that open with an identifier) or "terms" (the documents whose bold terms are entities)');
    if (source !== 'document' && (identifier !== undefined || terms !== undefined)) problem([identifier !== undefined ? 'identifier' : 'terms'], `"${identifier !== undefined ? 'identifier' : 'terms'}" belongs to a document kind`);
    const group = decl['group'];
    if (group !== undefined && (typeof group !== 'string' || !groups.has(group))) problem(['group'], `"group" names a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'}), got ${JSON.stringify(group)}`);
    const origin = decl['origin'];
    if (origin !== undefined && !ORIGINS.includes(origin as Origin)) problem(['origin'], `"origin" is ${ORIGINS.join(', ')}; got ${JSON.stringify(origin)}`);
    const descriptions: Record<string, string> = {};
    const rawDescription = decl['description'];
    if (rawDescription !== undefined) {
      if (rawDescription === null || typeof rawDescription !== 'object' || Array.isArray(rawDescription)) problem(['description'], `"description" maps a language (${LABEL_LANGUAGES.join(', ')}) to a sentence saying what the kind is`);
      else {
        for (const [language, text] of Object.entries(rawDescription as Record<string, unknown>)) {
          if (!LABEL_LANGUAGES.includes(language)) problem(['description', language], `"${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}`);
          else if (typeof text !== 'string' || text.trim() === '') problem(['description', language], 'a description is a sentence');
          else descriptions[language] = text;
        }
      }
    }
    const title = decl['title'];
    if (title !== undefined && (typeof title !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(title))) problem(['title'], '"title" names an attribute');
    const attributes = decl['attributes'];
    if (attributes !== undefined && (!Array.isArray(attributes) || attributes.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(entry)))) problem(['attributes'], '"attributes" is a list of attribute names');
    const relations: DeclaredRelation[] = [];
    const rawRelations = decl['relations'];
    if (rawRelations !== undefined) {
      if (!Array.isArray(rawRelations)) problem(['relations'], '"relations" is a list of { type, to }');
      else {
        rawRelations.forEach((entry: unknown, index) => {
          const body = entry as Record<string, unknown> | null;
          if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['type'] !== 'string' || typeof body['to'] !== 'string' || body['type'] === '' || body['to'] === '') {
            problem(['relations', index], 'a relation is { type: <relation type>, to: <key of the other end> }');
            return;
          }
          const extra = Object.keys(body).filter((key) => key !== 'type' && key !== 'to');
          if (extra.length > 0) problem(['relations', index, extra[0]!], `"${extra[0]}" is not a field of a relation: the fields are type and to`);
          else relations.push({ type: body['type'], to: body['to'], line: at(['kinds', name, 'relations', index])});
        });
      }
    }
    const labels: Record<string, KindLabel> = {};
    const rawLabels = decl['labels'];
    if (rawLabels !== undefined) {
      if (rawLabels === null || typeof rawLabels !== 'object' || Array.isArray(rawLabels)) problem(['labels'], `"labels" maps a language (${LABEL_LANGUAGES.join(', ')}) to { one, many }`);
      else {
        for (const [language, entry] of Object.entries(rawLabels as Record<string, unknown>)) {
          const body = entry as Record<string, unknown> | null;
          if (!LABEL_LANGUAGES.includes(language)) problem(['labels', language], `"${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}`);
          else if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['one'] !== 'string' || typeof body['many'] !== 'string' || body['one'].trim() === '' || body['many'].trim() === '' || Object.keys(body).some((key) => key !== 'one' && key !== 'many')) {
            problem(['labels', language], 'a label is { one: <the name of one>, many: <the name of several> }');
          } else labels[language] = { one: body['one'], many: body['many'] };
        }
      }
    }
    if (findings.length > before) continue;
    kinds.set(name, {
      name,
      template: template as string,
      source: source as 'graph' | 'markdown' | 'document',
      ...(typeof group === 'string' ? { group } : {}),
      ...(typeof origin === 'string' ? { origin: origin as Origin } : {}),
      ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
      ...(identifiers !== undefined && names(identifiers) ? { identifier: identifiers } : {}),
      ...(Array.isArray(terms) ? { terms: terms as string[] } : {}),
      ...(typeof folder === 'string' ? { folder } : {}),
      ...(typeof single === 'string' ? { file: single } : {}),
      title: typeof title === 'string' ? title : 'label',
      ...(Array.isArray(attributes) ? { attributes: attributes as string[] } : {}),
      relations,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      line,
    });
  }
  return { file, roles, kinds, groups, excludeDocuments, findings, ...(language === undefined ? {} : { language }), ...(diagram === undefined ? {} : { diagram }) };
}

/**
 * Writes `language:` into the manifest of a product, keeping the rest of the file (comments included) as it is.
 * Answers a sentence naming the file when it cannot; nothing when it is done.
 */
export function setKindsLanguage(productFolder: string, language: string): string | undefined {
  const file = join(productFolder, KINDS_FILE);
  if (!LABEL_LANGUAGES.includes(language)) return `${file}: "${language}" is not a language of the wiki; the languages are ${LABEL_LANGUAGES.join(', ')}`;
  try {
    // A manifest that is a link out of the product is somebody else's file: it is not rewritten.
    if (lstatSync(file).isSymbolicLink()) {
      const real = realpathSync(file);
      const root = realpathSync(productFolder);
      if (!real.startsWith(`${root}/`) && !real.startsWith(`${root}\\`)) return `${file}: the manifest is a link to ${real}, outside the product ${productFolder}, so the language is not written into it`;
    }
    const document = parseDocument(readFileSync(file, 'utf8'));
    if (document.errors.length > 0) return `${file}: the manifest cannot be read, so the language is not written into it: ${document.errors[0]!.message.split('\n')[0]}`;
    document.set('language', language);
    writeFileSync(file, document.toString(), 'utf8');
    return undefined;
  } catch (error) {
    return `${file}: the language could not be written: ${(error as Error).message}`;
  }
}

/** The kind whose single file is the product's home: the first kind with a `file`, in the manifest's order. */
export function homeKind(manifest: KindsManifest): KindDecl | undefined {
  for (const decl of manifest.kinds.values()) if (decl.source === 'markdown' && decl.file !== undefined) return decl;
  return undefined;
}

/** A path pattern as a regular expression: `*` stays within a folder, `**` crosses folders, `?` is one character. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char === '*') {
      if (pattern[at + 1] === '*') {
        at += 1;
        if (pattern[at + 1] === '/') { at += 1; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a document path (`/`-separated) matches one of the patterns. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
