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
import { isSemanticKind, SEMANTIC_KINDS, type SemanticKind } from './semantics.js';
import { BLOCK_NAMES } from './template.js';
import { PREDICATES } from '../problems/rules.js';
import { DEFAULT_THRESHOLDS, PROBLEM_SEVERITIES, SONAR_KINDS, type ProblemSettings, type RuleParams, type RuleSetting } from '../problems/types.js';

/** The manifest's place in the product repository. */
export const KINDS_FILE = 'madarch/kinds.yaml';

/** One problem in a product file the wiki reads: where it is and what it is. */
/** What kind of problem a finding is, for the Problems page: a file that cannot be read, or a passage no reader decided. */
export type FindingKind = 'unreadable-file' | 'unread-passage';

export interface Finding {
  /** Where the problem stands, as the reader knows it: the product's path, or `repos/<repository>/<path>` in a code repository. */
  file: string;
  line: number;
  message: string;
  /** The kind of problem; a file that cannot be read when the finding does not say. */
  kind?: FindingKind;
  /**
   * The file's place on disk, when the reader knows it: a diagnostic names both the identity a reader navigates by
   * (`file`) and the absolute path a person opens (madarch-ztyq.3, the review of finding 8). A finding whose place is
   * not a file of this machine — a manifest's entry, say — has none.
   */
  source?: string;
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
  /**
   * The group this one is a sub-area of, when it is one: the navigation and the
   * catalogue draw it under that group, one level deep. A group without a
   * parent is a top-level group.
   */
  parent?: string;
  /**
   * Whether the navigation opens this group by itself, before a reader touches
   * it (`open: true`). A group without the field is closed until opened.
   */
  open?: boolean;
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
  /**
   * Document kinds: the headings whose sections are entities of the kind — each list item under one,
   * or each paragraph when it holds no list. The product writes its own headings here, so the wiki
   * reads an unnumbered `## Qualities` as well as a numbered `UC-2` (madarch-ztyq.3).
   */
  headings?: readonly string[];
  /**
   * Document kinds: the general kind a passage of this kind means (`scenario`, `actor`, `rule`,
   * `quality`, `decision`, `procedure`, `term`). The classifier's answer is shown as this kind, and
   * a passage of a general kind no kind names is said to be unshown, never dropped silently.
   */
  semantics?: SemanticKind;
  /**
   * Document kinds: the sections a section of this kind holds (`Status`, `Context`, `Decision`,
   * `Consequences`): the structure pass reads them, as a heading or as a paragraph that opens with
   * the name and a colon, and a missing one is a finding on the section.
   */
  structure?: readonly string[];
  /** Markdown kinds: the folder (many entities) or the file (one entity) the Markdown lives in. */
  folder?: string;
  file?: string;
  /** The attribute that names a page. */
  title: string;
  attributes?: readonly string[];
  relations: readonly DeclaredRelation[];
  /** The kind's name in each interface language: `one` for a badge, `many` for the navigation. */
  labels?: Readonly<Record<string, KindLabel>>;
  /** The properties a page of this kind shows, in this order: keys of the manifest's `properties` map. */
  details?: readonly string[];
  /** The kind is a member of another entity's page and has no catalogue page of its own. */
  member?: MemberDecl;
  line: number;
}

/** A kind's name in one language, as a reader says it of one entity and of several. */
export interface KindLabel {
  one: string;
  many: string;
}

/** How a property's value is written for a reader: a list, commands, ports, a date, a plain word. */
export const PROPERTY_FORMATS = ['text', 'list', 'commands', 'ports', 'boolean', 'number', 'date', 'path', 'code', 'build', 'scripts'] as const;
export type PropertyFormat = (typeof PROPERTY_FORMATS)[number];

/** A property the product names in its manifest: its reader-facing label in each language and how its value is written. */
export interface PropertyDecl {
  name: string;
  labels: Readonly<Record<string, string>>;
  format: PropertyFormat;
  line: number;
  /** The keys of a value that is an object (a build's context, a Dockerfile): their labels, declared as data. */
  fields?: ReadonlyMap<string, PropertyDecl>;
}

/**
 * A kind whose entities are members of another entity's page rather than pages of their own (madarch-m38l.21):
 * a field of a class, a facet of a file. The relation names the edge to the parent; `property` is the fallback when
 * the graph holds no edge.
 */
export interface MemberDecl {
  relation: string;
  direction: 'out' | 'in';
  parentKind?: string;
  property?: string;
  line: number;
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

/** A kind the product's documents are expected to hold, and the manifest's line that says so. */
export interface ExpectedKind {
  readonly kind: string;
  readonly line: number;
}

export interface KindsManifest {
  file: string;
  /** What each role changes; a role the manifest does not declare reads everything open in the manifest's order. */
  roles: ReadonlyMap<RoleName, RoleDecl>;
  /** The language the product's pages are written in (`language:` at the top of the manifest); absent means English. */
  language?: string;
  /** The renderer the diagrams open on (`diagram:` at the top of the manifest: likec4, mermaid or archify); absent means the environment's, else LikeC4. */
  diagram?: string;
  /** The reader-facing labels and value formats of the properties the kinds show. */
  properties: ReadonlyMap<string, PropertyDecl>;
  kinds: ReadonlyMap<string, KindDecl>;
  /** The groups of kinds, in the manifest's order. */
  groups: ReadonlyMap<string, GroupDecl>;
  /** Markdown documents the wiki does not list as documents (harness files, say), as path patterns. */
  excludeDocuments: readonly string[];
  /** Block kinds a document may hold without a page, named by the product: a fence, an html comment. */
  ignoreBlocks: readonly string[];
  /**
   * The kinds the product expects its documents to hold (`documents.expect`). A kind that no
   * document section is read as is a finding naming the manifest's line: the wiki says what the
   * documents lack instead of showing a smaller result (decision 0032 section 4).
   */
  expect?: readonly ExpectedKind[];
  /**
   * The Problems page's rules and thresholds (`problems:`): which rules run, the severity each starts
   * with, and the sizes a file is judged large by. Absent declares no rule: the page lists the starter
   * rules only where the manifest writes them (`problems.rules`), and says so instead of guessing them.
   */
  problems?: ProblemSettings;
  findings: readonly Finding[];
  /** The manifest could not be read as a whole (not YAML, not a mapping, no `kinds` mapping): no kind is known, which is not the same as every kind having a finding. */
  unreadable?: true;
}

export type KindsRead =
  | { present: false; file: string }
  | { present: true; manifest: KindsManifest };

const KIND_KEYS = new Set(['template', 'source', 'folder', 'file', 'title', 'attributes', 'relations', 'labels', 'group', 'origin', 'description', 'identifier', 'terms', 'headings', 'semantics', 'structure', 'details', 'member']);

/** Whether a repository-relative path stays inside the folder: no climbing, not absolute. */
export function insideFolder(folder: string, path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0')) return false;
  const from = relative(resolve(folder), resolve(folder, path));
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}


/** The fields a declared rule holds. */
const RULE_FIELDS = ['predicate', 'kind', 'sonar', 'severity', 'section', 'action', 'label', 'params', 'enabled'] as const;
const PROBLEM_SECTIONS = ['code', 'documents', 'wiki'] as const;
const RULE_ACTIONS = ['task', 'none'] as const;

/** A mapping, not a list and not null. */
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A rule's parameters: named values a predicate reads, each a string, a number, a boolean or a list of strings. */
function readParams(value: unknown, file: string, line: number, id: string, findings: Finding[]): RuleParams | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    findings.push({ file, line, message: `rule "${id}": "params" maps a parameter name to a string, a number, a boolean or a list of strings` });
    return undefined;
  }
  const params: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [name, held] of Object.entries(value)) {
    // The YAML line counter has no finer position inside a flow mapping; the parameter is named in the message.
    if (typeof held === 'string' || typeof held === 'boolean' || (typeof held === 'number' && Number.isFinite(held))) params[name] = held;
    else if (Array.isArray(held) && held.every((entry) => typeof entry === 'string')) params[name] = held as string[];
    else findings.push({ file, line, message: `rule "${id}": the parameter "${name}" is a string, a number, a boolean or a list of strings, got ${JSON.stringify(held)}` });
  }
  return params;
}

/**
 * The `problems:` mapping: every rule the page runs — its predicate, kind, Sonar kind, severity,
 * section, action, label and parameters — and the thresholds the size rules read. The engine keeps
 * only the predicates, so a rule this manifest does not declare is not run, and a declaration that
 * misses a field is a finding at its line rather than a rule running with a guessed value.
 */
/**
 * The keys of an object-valued property (a build's context and its Dockerfile), each declared as { en, ru, format? }.
 * The engine names no key of a product's value: a key it reads is a key the manifest declares here (madarch-m38l.21).
 */
function propertyFields(
  property: string,
  raw: unknown,
  at: (path: (string | number)[]) => number,
  findings: Finding[],
  file: string,
): Map<string, PropertyDecl> {
  const fields = new Map<string, PropertyDecl>();
  if (raw === undefined) return fields;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    findings.push({ file, line: at(['properties', property, 'fields']), message: `property "${property}": "fields" maps a key of the value to { en, ru, format? }` });
    return fields;
  }
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const line = at(['properties', property, 'fields', key]);
    if (key.trim() === '') { findings.push({ file, line, message: `property "${property}": a field name is a name, not the empty string` }); continue; }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { findings.push({ file, line, message: `property "${property}" field "${key}": the declaration is { en, ru, format? }` }); continue; }
    const body = entry as Record<string, unknown>;
    for (const inner of Object.keys(body)) if (inner !== 'en' && inner !== 'ru' && inner !== 'format') findings.push({ file, line: at(['properties', property, 'fields', key, inner]), message: `property "${property}" field "${key}": "${inner}" is not a field of a field: the fields are en, ru and format` });
    const labels: Record<string, string> = {};
    for (const language of LABEL_LANGUAGES) {
      const text = body[language];
      // The word a missing language lacks has no line of its own: the finding names the field's declaration.
      if (typeof text !== 'string' || text.trim() === '') findings.push({ file, line, message: `property "${property}" field "${key}": "${language}" is the word a reader sees` });
      else labels[language] = text;
    }
    const format = body['format'] ?? 'text';
    if (typeof format !== 'string' || !(PROPERTY_FORMATS as readonly string[]).includes(format)) findings.push({ file, line, message: `property "${property}" field "${key}": "format" is one of ${PROPERTY_FORMATS.join(', ')}, got ${JSON.stringify(format)}` });
    if (Object.keys(labels).length === LABEL_LANGUAGES.length && typeof format === 'string' && (PROPERTY_FORMATS as readonly string[]).includes(format)) fields.set(key, { name: key, labels, format: format as PropertyFormat, line });
  }
  return fields;
}

function parseProblems(
  raw: unknown,
  at: (path: (string | number)[]) => number,
  findings: Finding[],
  file: string,
): ProblemSettings | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    findings.push({ file, line: at(['problems']), message: '"problems" is { rules: { <rule id>: { predicate, kind, sonar, severity, section, action, label, params?, enabled? } }, thresholds: { largeFileLines: 600 } }' });
    return undefined;
  }
  const body = raw;
  for (const key of Object.keys(body)) if (key !== 'rules' && key !== 'thresholds') findings.push({ file, line: at(['problems', key]), message: `"${key}" is not a field of "problems": the fields are "rules" and "thresholds"` });
  const rules: Record<string, RuleSetting> = {};
  const kinds = new Map<string, string>();
  const rawRules = body['rules'];
  if (rawRules !== undefined) {
    if (!isRecord(rawRules)) findings.push({ file, line: at(['problems', 'rules']), message: '"rules" maps a rule id to { predicate, kind, sonar, severity, section, action, label, params?, enabled? }' });
    else {
      for (const [id, entry] of Object.entries(rawRules)) {
        const line = at(['problems', 'rules', id]);
        if (id === '') { findings.push({ file, line, message: 'a rule id is a name, not the empty string' }); continue; }
        if (!isRecord(entry)) { findings.push({ file, line, message: `rule "${id}": the rule is { predicate, kind, sonar, severity, section, action, label, params?, enabled? }` }); continue; }
        const setting = entry;
        for (const key of Object.keys(setting)) if (!(RULE_FIELDS as readonly string[]).includes(key)) findings.push({ file, line: at(['problems', 'rules', id, key]), message: `rule "${id}": "${key}" is not a field of the rule: the fields are ${RULE_FIELDS.join(', ')}` });
        let sound = true;
        const predicate = setting['predicate'];
        if (typeof predicate !== 'string' || !PREDICATES.includes(predicate)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'predicate']), message: `rule "${id}": "predicate" is one the engine implements (${PREDICATES.join(', ')}), got ${JSON.stringify(predicate)}` });
          sound = false;
        }
        const kind = setting['kind'];
        if (typeof kind !== 'string' || kind.trim() === '') {
          findings.push({ file, line: at(['problems', 'rules', id, 'kind']), message: `rule "${id}": "kind" is the kind of finding the rule makes, a word or words` });
          sound = false;
        } else if (kinds.has(kind)) {
          findings.push({ file, line, message: `rule "${id}": the kind ${JSON.stringify(kind)} is already declared by the rule "${kinds.get(kind)}": a finding kind names one rule` });
          sound = false;
        }
        const sonar = setting['sonar'];
        if (typeof sonar !== 'string' || !SONAR_KINDS.includes(sonar as never)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'sonar']), message: `rule "${id}": "sonar" is one of ${SONAR_KINDS.join(', ')}` });
          sound = false;
        }
        const severity = setting['severity'];
        if (typeof severity !== 'string' || !PROBLEM_SEVERITIES.includes(severity as never)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'severity']), message: `rule "${id}": "severity" is one of ${PROBLEM_SEVERITIES.join(', ')}` });
          sound = false;
        }
        const section = setting['section'];
        if (typeof section !== 'string' || !(PROBLEM_SECTIONS as readonly string[]).includes(section)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'section']), message: `rule "${id}": "section" is one of ${PROBLEM_SECTIONS.join(', ')}` });
          sound = false;
        }
        const action = setting['action'];
        if (typeof action !== 'string' || !(RULE_ACTIONS as readonly string[]).includes(action)) {
          findings.push({ file, line: at(['problems', 'rules', id, 'action']), message: `rule "${id}": "action" is one of ${RULE_ACTIONS.join(', ')}` });
          sound = false;
        }
        const label = setting['label'];
        const labelSound = isRecord(label) && typeof label['en'] === 'string' && label['en'].trim() !== '' && typeof label['ru'] === 'string' && label['ru'].trim() !== '' && Object.keys(label).every((key) => key === 'en' || key === 'ru');
        if (!labelSound) {
          findings.push({ file, line: at(['problems', 'rules', id, 'label']), message: `rule "${id}": "label" is { en: <words>, ru: <words> }` });
          sound = false;
        }
        const enabled = setting['enabled'];
        if (enabled !== undefined && typeof enabled !== 'boolean') {
          findings.push({ file, line: at(['problems', 'rules', id, 'enabled']), message: `rule "${id}": "enabled" is true or false` });
          sound = false;
        }
        const params = readParams(setting['params'], file, at(['problems', 'rules', id, 'params']), id, findings);
        if (setting['params'] !== undefined && params === undefined) sound = false;
        if (!sound) continue;
        kinds.set(kind as string, id);
        rules[id] = {
          predicate: predicate as string,
          kind: kind as string,
          sonar: sonar as never,
          severity: severity as never,
          section: section as never,
          action: action as never,
          label: { en: (label as Record<string, string>)['en']!, ru: (label as Record<string, string>)['ru']! },
          ...(params === undefined ? {} : { params }),
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        };
      }
    }
  }
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const rawThresholds = body['thresholds'];
  if (rawThresholds !== undefined) {
    if (!isRecord(rawThresholds)) findings.push({ file, line: at(['problems', 'thresholds']), message: '"thresholds" maps a threshold name to a positive whole number' });
    else {
      for (const [key, value] of Object.entries(rawThresholds)) {
        if (!(key in DEFAULT_THRESHOLDS)) { findings.push({ file, line: at(['problems', 'thresholds', key]), message: `"${key}" is not a threshold: the thresholds are ${Object.keys(DEFAULT_THRESHOLDS).join(', ')}` }); continue; }
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) findings.push({ file, line: at(['problems', 'thresholds', key]), message: `"${key}" is a positive whole number, got ${JSON.stringify(value)}` });
        else (thresholds as Record<string, number>)[key] = value;
      }
    }
  }
  return { rules, thresholds };
}

function nothing(file: string, findings: Finding[]): KindsManifest {
  return { file, roles: new Map(), properties: new Map(), kinds: new Map(), groups: new Map(), excludeDocuments: [], ignoreBlocks: [], expect: [], findings, unreadable: true };
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
    } else if (key !== 'kinds' && key !== 'groups' && key !== 'documents' && key !== 'roles' && key !== 'problems' && key !== 'properties') findings.push({ file, line: at([key]), message: `"${key}" is not a field of the manifest: the manifest holds "kinds", "groups", "documents", "roles", "problems", "properties", "language" and "diagram"` });
  }
  const properties = new Map<string, PropertyDecl>();
  const rawProperties = top['properties'];
  if (rawProperties !== undefined) {
    if (rawProperties === null || typeof rawProperties !== 'object' || Array.isArray(rawProperties)) {
      findings.push({ file, line: at(['properties']), message: '"properties" maps a property name to { en, ru, format? }' });
    } else {
      for (const [name, entry] of Object.entries(rawProperties as Record<string, unknown>)) {
        const line = at(['properties', name]);
        if (name.trim() === '') { findings.push({ file, line, message: 'a property name is a name, not the empty string' }); continue; }
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { findings.push({ file, line, message: `property "${name}": the declaration is { en, ru, format? }` }); continue; }
        const body = entry as Record<string, unknown>;
        for (const key of Object.keys(body)) if (key !== 'en' && key !== 'ru' && key !== 'format' && key !== 'fields') findings.push({ file, line: at(['properties', name, key]), message: `property "${name}": "${key}" is not a field of a property: the fields are en, ru and format` });
        const labels: Record<string, string> = {};
        for (const language of LABEL_LANGUAGES) {
          const text = body[language];
          if (typeof text !== 'string' || text.trim() === '') findings.push({ file, line: at(['properties', name, language]), message: `property "${name}": "${language}" is the word a reader sees` });
          else labels[language] = text;
        }
        const format = body['format'] ?? 'text';
        if (typeof format !== 'string' || !(PROPERTY_FORMATS as readonly string[]).includes(format)) findings.push({ file, line: at(['properties', name, 'format']), message: `property "${name}": "format" is one of ${PROPERTY_FORMATS.join(', ')}, got ${JSON.stringify(format)}` });
        const fields = propertyFields(name, body['fields'], at, findings, file);
        if (Object.keys(labels).length === LABEL_LANGUAGES.length && typeof format === 'string' && (PROPERTY_FORMATS as readonly string[]).includes(format)) {
          properties.set(name, { name, labels, format: format as PropertyFormat, line, ...(fields.size === 0 ? {} : { fields }) });
        }
      }
    }
  }
  const problems = parseProblems(top['problems'], at, findings, file);
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
        let parent: string | undefined;
        let open: boolean | undefined;
        let bad = false;
        for (const [language, label] of Object.entries(body)) {
          if (language === 'open') {
            if (typeof label !== 'boolean') findings.push({ file, line: at(['groups', name, 'open']), message: `group "${name}": "open" is true or absent` });
            else open = label;
          } else if (language === 'parent') {
            if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, 'parent']), message: `group "${name}": "parent" is the name of a group of "groups"` }); bad = true; }
            else parent = label;
          } else if (!LABEL_LANGUAGES.includes(language)) { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": "${language}" is not a language of the wiki: the languages are ${LABEL_LANGUAGES.join(', ')}` }); bad = true; }
          else if (typeof label !== 'string' || label.trim() === '') { findings.push({ file, line: at(['groups', name, language]), message: `group "${name}": the name in "${language}" is a text` }); bad = true; }
          else labels[language] = label;
        }
        if (!bad) groups.set(name, { name, labels, line, ...(parent === undefined ? {} : { parent }), ...(open === undefined ? {} : { open }) });
      }
      // A sub-area names a group that stands beside it. Two levels would hide the
      // catalogue's shape, so a group whose parent is itself a sub-area is a finding.
      // Every invalid edge is also discarded: the app draws top-level groups by a
      // parent that is absent, so a kept edge would hide the group from the
      // navigation while the finding names it (madarch-m38l.24, the review). A
      // cycle — a names b and b names a — fails at both edges and both stand at
      // the top level; the check reads the edges as they were written, so neither
      // edge can make the other look valid while they are discarded one by one.
      const invalidParents = new Map<string, { line: number; message: string }>();
      for (const group of groups.values()) {
        if (group.parent === undefined) continue;
        const line = at(['groups', group.name, 'parent']);
        if (group.parent === group.name) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" cannot name the group itself` });
          continue;
        }
        const parent = groups.get(group.parent);
        if (parent === undefined) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" names a group of "groups" (${[...groups.keys()].join(', ') || 'none is declared'}), got ${JSON.stringify(group.parent)}` });
        } else if (parent.parent !== undefined) {
          invalidParents.set(group.name, { line, message: `group "${group.name}": "parent" names "${parent.name}", which is itself a sub-area: sub-areas are one level deep` });
        }
      }
      for (const [name, invalid] of invalidParents) {
        findings.push({ file, line: invalid.line, message: invalid.message });
        delete groups.get(name)!.parent;
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
  // Block kinds the product says hold no meaning of their own: a fence or an html comment is furniture, and the manifest
  // names it rather than the reader guessing (the review of the eighth pass, finding 1).
  const ignoredBlocks: string[] = [];
  const expected: ExpectedKind[] = [];
  const rawDocuments = top['documents'];
  if (rawDocuments !== undefined) {
    const body = rawDocuments as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) findings.push({ file, line: at(['documents']), message: '"documents" is { exclude: [<path pattern>, ...], expect: [<kind>, ...] }' });
    else {
      for (const key of Object.keys(body)) if (key !== 'exclude' && key !== 'expect' && key !== 'ignore') findings.push({ file, line: at(['documents', key]), message: `"${key}" is not a field of "documents": the fields are "exclude", "expect" and "ignore"` });
      const ignore = body['ignore'];
      if (ignore !== undefined) {
        if (!Array.isArray(ignore) || ignore.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'ignore']), message: '"ignore" is a list of block kinds a document may hold without a page, such as "code" or "html"' });
        else ignoredBlocks.push(...(ignore as string[]));
      }
      const exclude = body['exclude'];
      if (exclude !== undefined) {
        if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'exclude']), message: '"exclude" is a list of path patterns of documents the wiki does not list, such as "AGENTS.md" or "**/CHANGELOG.md"' });
        else excludeDocuments.push(...(exclude as string[]));
      }
      // The general kinds the documents are expected to hold: one that no section is read as is a finding, never a smaller wiki.
      const expect = body['expect'];
      if (expect !== undefined) {
        if (!Array.isArray(expect) || expect.some((entry) => typeof entry !== 'string' || entry.trim() === '')) findings.push({ file, line: at(['documents', 'expect']), message: '"expect" is a list of the kinds of "kinds" the documents must hold, such as "doc.use-case" or "doc.quality"' });
        else (expect as string[]).forEach((kind, index) => expected.push({ kind, line: at(['documents', 'expect', index]) }));
      }
    }
  }
  const declared = top['kinds'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    findings.push({ file, line: at(['kinds']), message: '"kinds" is a mapping of kind names to their declarations' });
    return { ...nothing(file, findings), groups, roles, excludeDocuments, ignoreBlocks: ignoredBlocks };
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
    const named = decl['template'];
    let template = named;
    if (typeof template !== 'string' || template.trim() === '') problem(['template'], '"template" names the template file in the product repository');
    else if (!insideFolder(productFolder, template)) problem(['template'], `the template "${template}" is not a path inside the product repository`);
    else if (!existsSync(join(productFolder, template)) || !statSync(join(productFolder, template)).isFile()) {
      // A kind that names a Markdown template of 0029 and a product that holds the Liquid template of the same name (the
      // starter set of 0032 was written beside the old files) is drawn by that one: the rename is madarch's, and a
      // product need not edit its manifest for it (madarch-u3vw.1).
      const liquid = typeof template === 'string' && template.endsWith('.md') ? `${template.slice(0, -'.md'.length)}.liquid` : undefined;
      if (liquid !== undefined && existsSync(join(productFolder, liquid)) && statSync(join(productFolder, liquid)).isFile()) template = liquid;
      else problem(['template'], `the template "${String(named)}" does not exist in the product repository`);
    }
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
    const headings = decl['headings'];
    const names2 = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
    if (headings !== undefined && !names2(headings)) problem(['headings'], '"headings" is a list of the headings whose sections are entities of the kind, such as [Use cases, Qualities]');
    const semantics = decl['semantics'];
    if (semantics !== undefined && (typeof semantics !== 'string' || !isSemanticKind(semantics))) problem(['semantics'], `"semantics" is the general kind of the sections: ${SEMANTIC_KINDS.join(', ')}`);
    const structure = decl['structure'];
    if (structure !== undefined && !names2(structure)) problem(['structure'], '"structure" is a list of the sections a section of the kind holds, such as [Status, Context, Decision, Consequences]');
    if (source === 'document' && identifier === undefined && terms === undefined && headings === undefined && semantics === undefined) problem([], 'a document kind names "identifier" (the sections that open with an identifier), "headings" (the headings whose sections are entities of the kind), "terms" (the documents whose bold terms are entities) or "semantics" (the passages the classifier reads of a general kind)');
    if (source !== 'document' && (identifier !== undefined || terms !== undefined || headings !== undefined || structure !== undefined || semantics !== undefined)) {
      const field = identifier !== undefined ? 'identifier' : terms !== undefined ? 'terms' : headings !== undefined ? 'headings' : structure !== undefined ? 'structure' : 'semantics';
      problem([field], `"${field}" belongs to a document kind`);
    }
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
    const details: string[] = [];
    const rawDetails = decl['details'];
    if (rawDetails !== undefined) {
      if (!Array.isArray(rawDetails) || rawDetails.some((entry) => typeof entry !== 'string' || entry.trim() === '')) problem(['details'], '"details" is a list of the property names the page shows, in their order');
      else for (const name of rawDetails as string[]) {
        if (!properties.has(name)) problem(['details'], `"details" names the property ${JSON.stringify(name)}, and "properties" does not declare it`);
        else details.push(name);
      }
    }
    let member: MemberDecl | undefined;
    const rawMember = decl['member'];
    if (rawMember !== undefined) {
      if (rawMember === null || typeof rawMember !== 'object' || Array.isArray(rawMember)) problem(['member'], '"member" is { relation, direction, parentKind?, property? }');
      else {
        const body = rawMember as Record<string, unknown>;
        for (const key of Object.keys(body)) if (key !== 'relation' && key !== 'direction' && key !== 'parentKind' && key !== 'property') problem(['member', key], `"${key}" is not a field of "member": the fields are relation, direction, parentKind and property`);
        const relation = body['relation'];
        const direction = body['direction'];
        const parentKind = body['parentKind'];
        const property = body['property'];
        if (typeof relation !== 'string' || relation.trim() === '') problem(['member', 'relation'], '"relation" is the edge from a member to the entity whose page it belongs to');
        if (direction !== 'out' && direction !== 'in') problem(['member', 'direction'], '"direction" is "out" (the member names the parent) or "in" (the parent contains the member)');
        if (parentKind !== undefined && (typeof parentKind !== 'string' || parentKind.trim() === '')) problem(['member', 'parentKind'], '"parentKind" is the kind of the parent entity');
        if (property !== undefined && (typeof property !== 'string' || property.trim() === '')) problem(['member', 'property'], '"property" names the member property that holds the parent key, when the graph holds no edge');
        if (typeof relation === 'string' && relation.trim() !== '' && (direction === 'out' || direction === 'in')) member = { relation, direction, ...(typeof parentKind === 'string' && parentKind.trim() !== '' ? { parentKind } : {}), ...(typeof property === 'string' && property.trim() !== '' ? { property } : {}), line: at(['kinds', name, 'member']) };
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
      ...(names2(headings) ? { headings: headings as string[] } : {}),
      ...(typeof semantics === 'string' && isSemanticKind(semantics) ? { semantics } : {}),
      ...(names2(structure) ? { structure: structure as string[] } : {}),
      ...(typeof folder === 'string' ? { folder } : {}),
      ...(typeof single === 'string' ? { file: single } : {}),
      title: typeof title === 'string' ? title : 'label',
      ...(Array.isArray(attributes) ? { attributes: attributes as string[] } : {}),
      ...(details.length > 0 ? { details } : {}),
      ...(member === undefined ? {} : { member }),
      relations,
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      line,
    });
  }
  // A kind named in "expect" that the manifest does not declare is a finding at its own line.
  const wanted = expected.filter((entry) => {
    const kind = kinds.get(entry.kind);
    if (kind === undefined) {
      findings.push({ file, line: entry.line, message: `"documents.expect" names the kind ${JSON.stringify(entry.kind)}, and the manifest declares no such kind: the kinds are ${[...kinds.keys()].join(', ') || 'none'}` });
      return false;
    }
    if (kind.source !== 'document') {
      findings.push({ file, line: entry.line, message: `"documents.expect" names the kind ${JSON.stringify(entry.kind)}, which is a ${kind.source} kind: it names the kinds a document section is read as` });
      return false;
    }
    return true;
  });
  return { file, roles, properties, kinds, groups, excludeDocuments, ignoreBlocks: ignoredBlocks, expect: wanted, ...(problems === undefined ? {} : { problems }), findings, ...(language === undefined ? {} : { language }), ...(diagram === undefined ? {} : { diagram }) };
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
