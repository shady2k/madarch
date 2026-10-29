/**
 * Bringing a product made by an earlier madarch to the current starter set
 * (madarch-m38l.11). The manifest and the templates are the product's own
 * files (decision 0029), so a product made by madarch 0.1 keeps the kinds,
 * groups, roles and blocks of that version for ever unless something moves
 * it on. The rule, from the owner's walk of 0.2.2:
 *
 * - A file only madarch ever wrote (no person edited it) is brought to the
 *   current starter set silently. "Only madarch wrote it" is judged by what
 *   can be shown: the file is what the current set holds; or its content is
 *   one this machine recorded when madarch wrote it; or git tracks it, every
 *   commit that touched it is madarch's own (the draft's creation), and the working copy is the committed one or differs from it
 *   only by what madarch itself adds (the page language, the question and
 *   correction kinds of `ensureLoopKinds`).
 * - A file a person edited, or one whose history cannot be shown, is never
 *   rewritten. What the starter set holds and the manifest lacks is offered
 *   instead (`StarterOffer`), item by item, for the Problems page to add.
 * - A template that is absent is written: nobody has edited what is not there.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LineCounter, parseDocument, type Document } from 'yaml';
import { GIT_LEAKS } from '../product/git.js';
import { KINDS_FILE, LABEL_LANGUAGES } from './kinds.js';
import { DETAILS, DOCUMENT_EXCLUDES, GROUPS, PROPERTY_LABELS, ROLES, STARTER_FILES, STARTER_KINDS, STARTER_PROBLEM_RULES, TEMPLATES, kindLines, starterManifest, type StarterKind } from './seed.js';

/** The subjects of the commits madarch itself makes in a product's manifest and templates. */
export const MADARCH_COMMIT_SUBJECTS: readonly string[] = ['Create the draft product'];

export type Provenance = 'absent' | 'current' | 'madarch' | 'person';

/** One thing the starter set holds and the product's manifest lacks, offered for the Problems page to add. */
export interface StarterOffer {
  /** `group:<name>`, `roles`, `role:<name>`, `documents`, `kind:<name>`, `fields:<kind>` or `rule:<id>`. */
  readonly id: string;
  readonly type: 'group' | 'roles' | 'role' | 'documents' | 'kind' | 'fields' | 'rule';
  readonly name: string;
  /** The kind's or group's name in each interface language. */
  readonly labels?: { readonly en: string; readonly ru: string };
  /** What a kind is, per interface language. */
  readonly description?: { readonly en: string; readonly ru: string };
  /** The group a kind belongs to. */
  readonly group?: string;
  /** For `fields`: the fields of the kind the manifest lacks. */
  readonly fields?: readonly string[];
}

export interface UpgradeReport {
  /** Files brought to the current set, relative to the product repository. */
  readonly rewritten: string[];
  /** Absent templates that were written. */
  readonly written: string[];
  /** Files left as they are because a person edited them (or because nothing shows madarch alone wrote them). */
  readonly kept: string[];
  /**
   * The kinds whose template is still an old Markdown one a person edited: the manifest of 0032 names Liquid
   * templates, and a kind whose `templates/<name>.md` a person wrote keeps that reference, so the page a person
   * shaped is the page the wiki draws (madarch-u3vw.1).
   */
  readonly keptReferences: { kind: string; template: string }[];
  /** What the set holds and the product's manifest lacks. */
  readonly offers: StarterOffer[];
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** `git` in the product folder; the standard output as it is, or undefined when git failed. */
function git(folder: string, args: readonly string[]): string | undefined {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !GIT_LEAKS.includes(name)) env[name] = value;
  const run = spawnSync('git', args, { cwd: folder, encoding: 'utf8', env, maxBuffer: 1 << 24 });
  return run.error !== undefined || run.status !== 0 ? undefined : run.stdout;
}

type Record_ = Record<string, string[]>;

function readRecord(file: string): Record_ {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${file}: the record of what madarch wrote into this product cannot be read: ${(error as Error).message}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('it is not a JSON object');
    return value as Record_;
  } catch (error) {
    // A record that cannot be read proves nothing: every file is then judged by its history alone, never by a guess.
    throw new Error(`${file}:1: the record of what madarch wrote into this product is not valid JSON (${(error as Error).message}); delete the file and the files are judged by their git history alone`);
  }
}

function writeRecord(file: string, record: Record_): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`${file}: the record of what madarch wrote into this product could not be written: ${(error as Error).message}`);
  }
}

function remember(recordFile: string, entries: Readonly<Record<string, string>>): void {
  const record = readRecord(recordFile);
  for (const [path, text] of Object.entries(entries)) {
    const known = record[path] ?? [];
    const digest = sha(text);
    if (!known.includes(digest)) record[path] = [...known, digest];
  }
  writeRecord(recordFile, record);
}

/** The declaration of a starter kind as the data the manifest holds, with or without its group. */
function starterDeclaration(kind: StarterKind, group: boolean): unknown {
  return (parseDocument(`kinds:\n${kindLines(kind, { group }).join('\n')}\n`).getIn(['kinds', kind.name]) as { toJSON(): unknown }).toJSON();
}

/**
 * Whether the working manifest is the committed one plus what madarch itself adds, to the byte: the page language
 * (`setKindsLanguage`) and the loop's two kinds (`ensureLoopKinds`) are written by the same YAML library that reads the
 * file, so the committed text with those two additions made is the working text exactly. A comment, a reordering or any
 * other line a person added makes the texts differ, and the file is the person's.
 */
function onlyMadarchAdditions(working: string, committed: string): boolean {
  const w = parseDocument(working);
  const c = parseDocument(committed);
  if (w.errors.length > 0 || c.errors.length > 0) return false;
  const data = w.toJS() as { kinds?: Record<string, Record<string, unknown>>; language?: unknown } | null;
  if (data === null || typeof data !== 'object') return false;
  for (const kind of STARTER_KINDS.filter((candidate) => candidate.name === 'question' || candidate.name === 'correction')) {
    const decl = data.kinds?.[kind.name];
    if (decl === undefined || c.hasIn(['kinds', kind.name])) continue;
    // The kind madarch added is the starter's declaration whole, with or without its group; any edit inside it is a person's.
    // Madarch's own rename of a template is not an edit: a declaration naming `templates/<kind>.md` is the one 0.2 wrote
    // before decision 0032 made the templates Liquid (`templates/<kind>.liquid`), and nothing else of it differs.
    const asWritten = [starterDeclaration(kind, true), starterDeclaration(kind, false)];
    const beforeLiquid = asWritten.map((declaration) => ({ ...(declaration as Record<string, unknown>), template: String((declaration as { template: string }).template).replace(/\.liquid$/, '.md') }));
    if (![...asWritten, ...beforeLiquid].some((declaration) => isDeepStrictEqual(decl, declaration))) return false;
    c.setIn(['kinds', kind.name], c.createNode(decl));
  }
  if (typeof data.language === 'string') c.set('language', data.language);
  return c.toString() === working;
}

/** Who wrote a starter file as the product holds it now. */
export function provenanceOf(productFolder: string, path: string, starter: string, record: Record_, observedText?: string): Provenance {
  const file = join(productFolder, path);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return 'absent';
  // A link is somebody else's file, wherever it points: it is never rewritten.
  if (!stat.isFile()) return 'person';
  let text: string;
  try {
    text = observedText ?? readFileSync(file, 'utf8');
  } catch {
    return 'person';
  }
  if (text === starter) return 'current';
  if ((record[path] ?? []).includes(sha(text))) return 'madarch';
  if (git(productFolder, ['ls-files', '--error-unmatch', '--', path]) === undefined) return 'person';
  const subjects = (git(productFolder, ['log', '--format=%s', '--', path]) ?? '').split('\n').filter((line) => line !== '');
  if (subjects.length === 0 || !subjects.every((subject) => MADARCH_COMMIT_SUBJECTS.includes(subject))) return 'person';
  const committed = git(productFolder, ['show', `HEAD:${path}`]);
  if (committed === undefined) return 'person';
  if (committed === text) return 'madarch';
  return path === KINDS_FILE && onlyMadarchAdditions(text, committed) ? 'madarch' : 'person';
}

/** The folder of the product and every folder on the way to `target` stand inside it: a link out is not the engine's to write through. */
function assertInside(productFolder: string, target: string): void {
  const root = realpathSync(productFolder);
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const real = realpathSync(ancestor);
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Error(`src/knowledge/starter-upgrade.ts: ${ancestor} is a link to ${real}, outside the product ${productFolder}: ${target} was not written`);
  }
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`src/knowledge/starter-upgrade.ts: ${target} is a link, so it is not rewritten; the product ${productFolder} keeps it as it is`);
}

function writeFile(productFolder: string, path: string, content: string): void {
  const target = join(productFolder, path);
  assertInside(productFolder, target);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`src/knowledge/starter-upgrade.ts: ${target} could not be written to bring the product to the current starter set: ${(error as Error).message}`);
  }
}

const LABELS = (kind: StarterKind): { en: string; ru: string } => ({ en: kind.en[0], ru: kind.ru[0] });

/** What the starter set holds and this manifest lacks. A manifest that cannot be read offers nothing: its findings say why. */
export function starterOffers(manifestText: string): StarterOffer[] {
  const document = parseDocument(manifestText);
  if (document.errors.length > 0) return [];
  const data = document.toJS() as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object') return [];
  const offers: StarterOffer[] = [];
  const declaredGroups = (data['groups'] !== null && typeof data['groups'] === 'object' ? data['groups'] : {}) as Record<string, unknown>;
  const kinds = (data['kinds'] !== null && typeof data['kinds'] === 'object' ? data['kinds'] : {}) as Record<string, unknown>;
  // A group some kind of the manifest names and the manifest does not declare is what makes that kind a finding.
  const usedGroups = new Set<string>();
  for (const value of Object.values(kinds)) {
    const group = (value as { group?: unknown } | null)?.group;
    if (typeof group === 'string') usedGroups.add(group);
  }
  for (const group of GROUPS) {
    if (usedGroups.has(group.name) && declaredGroups[group.name] === undefined) offers.push({ id: `group:${group.name}`, type: 'group', name: group.name, labels: { en: group.en, ru: group.ru } });
  }
  const roles = data['roles'];
  if (roles === undefined) offers.push({ id: 'roles', type: 'roles', name: 'roles' });
  else if (roles !== null && typeof roles === 'object') {
    for (const role of ROLES) if ((roles as Record<string, unknown>)[role.name] === undefined) offers.push({ id: `role:${role.name}`, type: 'role', name: role.name });
  }
  if (data['documents'] === undefined) offers.push({ id: 'documents', type: 'documents', name: 'documents' });
  for (const kind of STARTER_KINDS) {
    const present = kinds[kind.name];
    if (present === undefined) {
      offers.push({ id: `kind:${kind.name}`, type: 'kind', name: kind.name, labels: LABELS(kind), description: { en: kind.describe[0], ru: kind.describe[1] }, group: kind.group });
      continue;
    }
    if (present === null || typeof present !== 'object') continue;
    const fields = ['group', 'labels', 'description', ...(kind.origin === undefined ? [] : ['origin'])].filter((field) => (present as Record<string, unknown>)[field] === undefined);
    if (fields.length > 0) offers.push({ id: `fields:${kind.name}`, type: 'fields', name: kind.name, labels: LABELS(kind), group: kind.group, fields });
  }
  // A rule the manifest does not declare, or declares without the fields the engine needs, is offered whole or in
  // part. What the manifest already says — its enabled switch, a severity a person chose — is never replaced.
  const problems = data['problems'];
  const declaredRules = problems !== null && typeof problems === 'object' && !Array.isArray(problems) && (problems as Record<string, unknown>)['rules'] !== null && typeof (problems as Record<string, unknown>)['rules'] === 'object' && !Array.isArray((problems as Record<string, unknown>)['rules'])
    ? (problems as Record<string, unknown>)['rules'] as Record<string, unknown>
    : {};
  for (const rule of STARTER_PROBLEM_RULES) {
    const present = declaredRules[rule.id];
    if (present === undefined) { offers.push({ id: `rule:${rule.id}`, type: 'rule', name: rule.id, labels: rule.label }); continue; }
    if (present === null || typeof present !== 'object' || Array.isArray(present)) continue;
    const fields = ['predicate', 'kind', 'sonar', 'severity', 'section', 'action', 'label', ...(rule.params === undefined ? [] : ['params'])]
      .filter((field) => (present as Record<string, unknown>)[field] === undefined);
    if (fields.length > 0) offers.push({ id: `rule:${rule.id}`, type: 'rule', name: rule.id, labels: rule.label, fields });
  }
  return offers;
}

function starterGroupNode(document: Document, name: string): unknown {
  const group = GROUPS.find((candidate) => candidate.name === name)!;
  return document.createNode({ en: group.en, ru: group.ru, ...(group.parent === undefined ? {} : { parent: group.parent }), ...(group.open === undefined ? {} : { open: group.open }) });
}

/**
 * Writes the group and, before it, the group it is a sub-area of. A manifest
 * gains the whole branch: a sub-area never stands without its parent.
 */
function ensureGroup(document: Document, name: string): void {
  if (document.hasIn(['groups', name])) return;
  const group = GROUPS.find((candidate) => candidate.name === name);
  if (group === undefined) return;
  if (group.parent !== undefined) ensureGroup(document, group.parent);
  document.setIn(['groups', name], starterGroupNode(document, name));
}

/** Adds the offered items to the manifest, its comments and the rest of it kept. Answers the paths it wrote. */
export function addStarterItems(productFolder: string, ids: readonly string[], recordFile: string): string[] {
  const file = join(productFolder, KINDS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}: the manifest cannot be read to add to it: ${(error as Error).message}`);
  }
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines });
  if (document.errors.length > 0) throw new Error(`${file}:${document.errors[0]!.linePos?.[0].line ?? 1}: the manifest cannot be read, so nothing is added: ${document.errors[0]!.message.split('\n')[0]}`);
  const written: string[] = [];
  const templates: Record<string, string> = {};
  const addTemplate = (kind: StarterKind): void => {
    const path = `templates/${kind.template}`;
    if (existsSync(join(productFolder, path))) return;
    writeFile(productFolder, path, TEMPLATES[kind.template]!);
    templates[path] = TEMPLATES[kind.template]!;
    written.push(path);
  };
  for (const id of [...new Set(ids)]) {
    if (id === 'roles' || id.startsWith('role:')) {
      for (const role of ROLES.filter((candidate) => id === 'roles' || id === `role:${candidate.name}`)) {
        if (!document.hasIn(['roles', role.name])) document.setIn(['roles', role.name], document.createNode({ lead: role.lead, open: role.open }));
      }
      for (const role of ROLES) for (const group of role.lead) if (id === 'roles' || id === `role:${role.name}`) ensureGroup(document, group);
    } else if (id === 'documents') {
      if (!document.hasIn(['documents'])) document.setIn(['documents'], document.createNode({ exclude: [...DOCUMENT_EXCLUDES] }));
    } else if (id.startsWith('group:')) {
      const name = id.slice('group:'.length);
      if (!GROUPS.some((candidate) => candidate.name === name)) throw new Error(`src/knowledge/starter-upgrade.ts: "${name}" is no group of the starter set (${GROUPS.map((candidate) => candidate.name).join(', ')})`);
      ensureGroup(document, name);
    } else if (id.startsWith('kind:') || id.startsWith('fields:')) {
      const name = id.slice(id.indexOf(':') + 1);
      const kind = STARTER_KINDS.find((candidate) => candidate.name === name);
      if (kind === undefined) throw new Error(`src/knowledge/starter-upgrade.ts: "${name}" is no kind of the starter set`);
      ensureGroup(document, kind.group);
      // The properties a page of this kind shows are added with it, so the manifest and its details agree (madarch-m38l.21).
      for (const detail of DETAILS[name] ?? []) {
        if (!document.hasIn(['properties', detail])) {
          const label = PROPERTY_LABELS[detail];
          if (label !== undefined) document.setIn(['properties', detail], document.createNode({ en: label.en, ru: label.ru, format: label.format ?? 'text' }));
        }
      }
      const declaration = starterDeclaration(kind, true) as Record<string, unknown>;
      if (id.startsWith('kind:')) {
        if (!document.hasIn(['kinds', name])) document.setIn(['kinds', name], document.createNode(declaration));
        addTemplate(kind);
      } else {
        for (const field of ['group', 'labels', 'description', 'origin']) {
          if (declaration[field] !== undefined && !document.hasIn(['kinds', name, field])) document.setIn(['kinds', name, field], document.createNode(declaration[field]));
        }
      }
    } else if (id.startsWith('rule:')) {
      const name = id.slice('rule:'.length);
      const rule = STARTER_PROBLEM_RULES.find((candidate) => candidate.id === name);
      if (rule === undefined) throw new Error(`src/knowledge/starter-upgrade.ts: "${name}" is no rule of the starter set (${STARTER_PROBLEM_RULES.map((candidate) => candidate.id).join(', ')})`);
      const declaration: Record<string, unknown> = {
        predicate: rule.predicate, kind: rule.kind, sonar: rule.sonar, severity: rule.severity, section: rule.section,
        action: rule.action, label: { en: rule.label.en, ru: rule.label.ru },
        ...(rule.params === undefined ? {} : { params: { ...rule.params } }),
      };
      if (!document.hasIn(['problems', 'rules', name])) {
        // A rule the manifest does not declare is added with the starter's enabled switch too.
        document.setIn(['problems', 'rules', name], document.createNode({ ...declaration, enabled: rule.enabled !== false }));
      } else {
        for (const [field, value] of Object.entries(declaration)) {
          if (!document.hasIn(['problems', 'rules', name, field])) document.setIn(['problems', 'rules', name, field], document.createNode(value));
        }
      }
    } else {
      throw new Error(`src/knowledge/starter-upgrade.ts: "${id}" is not an item of the starter set; the items are group:<name>, roles, role:<name>, documents, kind:<name>, fields:<kind> and rule:<id>`);
    }
  }
  const next = document.toString();
  if (next !== text) {
    assertInside(productFolder, file);
    writeFile(productFolder, KINDS_FILE, next);
    // Not recorded as madarch's: the manifest is a person's file with items added to it, and must never be replaced silently.
    written.push(KINDS_FILE);
  }
  if (Object.keys(templates).length > 0) remember(recordFile, templates);
  return written;
}

/** The page language a manifest declares, when it declares a valid one. */
function languageOf(text: string): string | undefined {
  const value = (parseDocument(text).toJS() as { language?: unknown } | null)?.language;
  return typeof value === 'string' && LABEL_LANGUAGES.includes(value) ? value : undefined;
}

/**
 * Brings the product's manifest and templates to the current starter set where no person edited them, writes the
 * templates that are absent, and answers what the set holds that an edited manifest lacks. Idempotent.
 */
export function rememberMadarchStarterFile(recordFile: string, path: string, text: string): void {
  remember(recordFile, { [path]: text });
}

/** Records a changed starter file only when its bytes before the change prove madarch already owned it. */
export function rememberChangedStarterFileIfOwned(productFolder: string, recordFile: string, path: string, previous: string, next: string): boolean {
  const starter = STARTER_FILES.find((entry) => entry.path === path);
  if (starter === undefined) return false;
  const record = readRecordSoftly(recordFile);
  const expected = path === KINDS_FILE ? starterManifest(languageOf(previous)) : starter.content;
  const previousOwnership = previous === starter.content || (record[path] ?? []).includes(sha(previous))
    ? 'madarch'
    : provenanceOf(productFolder, path, expected, record, previous);
  if (previousOwnership !== 'current' && previousOwnership !== 'madarch') return false;
  if (readFileSync(join(productFolder, path), 'utf8') !== next) return false;
  remember(recordFile, { [path]: next });
  return true;
}

export function upgradeStarterSet(productFolder: string, recordFile: string): UpgradeReport {
  const record = readRecordSoftly(recordFile);
  const report: UpgradeReport = { rewritten: [], written: [], kept: [], offers: [], keptReferences: [] };
  const remembered: Record<string, string> = {};
  for (const starter of STARTER_FILES) {
    const provenance = provenanceOf(productFolder, starter.path, starter.content, record);
    if (provenance === 'absent') {
      // The manifest itself is given whole by the seed, when the product has none.
      if (starter.path === KINDS_FILE) continue;
      writeFile(productFolder, starter.path, starter.content);
      report.written.push(starter.path);
      remembered[starter.path] = starter.content;
    } else if (provenance === 'madarch') {
      const current = readFileSync(join(productFolder, starter.path), 'utf8');
      const language = starter.path === KINDS_FILE ? languageOf(current) : undefined;
      const next = starter.path === KINDS_FILE ? starterManifest(language) : starter.content;
      // The manifest as it was written with the page language is the current set already.
      if (current === next) { remembered[starter.path] = next; continue; }
      writeFile(productFolder, starter.path, next);
      report.rewritten.push(starter.path);
      remembered[starter.path] = next;
    } else if (provenance === 'person') {
      report.kept.push(starter.path);
    }
  }
  if (Object.keys(remembered).length > 0) remember(recordFile, remembered);
  // A kind whose old Markdown template a person edited keeps being drawn by that template: the manifest the upgrade
  // wrote names the Liquid one, and a page a person shaped is not silently replaced by one nobody wrote.
  if (report.rewritten.includes(KINDS_FILE)) keepPersonTemplates(productFolder, report);
  if (report.kept.includes(KINDS_FILE)) {
    try {
      report.offers.push(...starterOffers(readFileSync(join(productFolder, KINDS_FILE), 'utf8')));
    } catch {
      // the manifest cannot be read: the wiki's findings say so
    }
  }
  return report;
}


/**
 * Whether an old template of the set of 0029 (a `.md` file) carries a person's edit: git tracks it, and either a commit
 * that is not madarch's touched it or the working copy differs from the committed one. A file nobody tracks shows no
 * edit (madarch's own `ensureLoopKinds` writes the question and correction templates into a working tree).
 */
function personEditedTemplate(productFolder: string, path: string): boolean {
  const stat = lstatSync(join(productFolder, path), { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return false;
  if (git(productFolder, ['ls-files', '--error-unmatch', '--', path]) === undefined) return false;
  const subjects = (git(productFolder, ['log', '--format=%s', '--', path]) ?? '').split('\n').filter((line) => line !== '');
  if (subjects.length === 0 || !subjects.every((subject) => MADARCH_COMMIT_SUBJECTS.includes(subject))) return true;
  const committed = git(productFolder, ['show', `HEAD:${path}`]);
  if (committed === undefined) return false;
  try {
    return readFileSync(join(productFolder, path), 'utf8') !== committed;
  } catch {
    return false;
  }
}

/** Points every kind whose old Markdown template a person edited back at it, and says so in the report. */
function keepPersonTemplates(productFolder: string, report: UpgradeReport): void {
  const file = join(productFolder, KINDS_FILE);
  let document: Document;
  try {
    document = parseDocument(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const kinds = document.getIn(['kinds']) as { items?: { key: { toJSON(): unknown }; value: { get(key: string): unknown } }[] } | undefined;
  const items = kinds?.items ?? [];
  let changed = false;
  for (const pair of items) {
    const name = String(pair.key.toJSON());
    const template = pair.value.get('template');
    if (typeof template !== 'string' || !template.endsWith('.liquid')) continue;
    const legacy = template.replace(/\.liquid$/, '.md');
    if (!personEditedTemplate(productFolder, legacy)) continue;
    document.setIn(['kinds', name, 'template'], legacy);
    report.keptReferences.push({ kind: name, template: legacy });
    changed = true;
  }
  if (changed) writeFile(productFolder, KINDS_FILE, document.toString());
}

/** A record that cannot be read proves nothing; the files are then judged by their history alone. */
function readRecordSoftly(recordFile: string): Record_ {
  try {
    return readRecord(recordFile);
  } catch {
    return {};
  }
}

/** The offers of a product now, without changing anything. */
export function currentOffers(productFolder: string, recordFile: string): StarterOffer[] {
  const record = readRecordSoftly(recordFile);
  const manifest = STARTER_FILES.find((starter) => starter.path === KINDS_FILE)!;
  const provenance = provenanceOf(productFolder, KINDS_FILE, manifest.content, record);
  if (provenance !== 'person') return [];
  try {
    return starterOffers(readFileSync(join(productFolder, KINDS_FILE), 'utf8'));
  } catch {
    return [];
  }
}

/** The starter files a start from nothing replaces that a person's edit would be lost in. */
export function filesAPersonEdited(productFolder: string, recordFile: string): string[] {
  const record = readRecordSoftly(recordFile);
  return STARTER_FILES.filter((starter) => provenanceOf(productFolder, starter.path, starter.content, record) === 'person').map((starter) => starter.path);
}

/**
 * Puts the manifest and every template at the current starter set, edited or not (the page language is kept).
 * Answers the paths it wrote.
 */
export function replaceWithStarterSet(productFolder: string, recordFile: string): string[] {
  const manifestPath = join(productFolder, KINDS_FILE);
  let language: string | undefined;
  try {
    language = languageOf(readFileSync(manifestPath, 'utf8'));
  } catch {
    language = undefined;
  }
  const written: string[] = [];
  const remembered: Record<string, string> = {};
  for (const starter of STARTER_FILES) {
    const next = starter.path === KINDS_FILE ? starterManifest(language) : starter.content;
    const target = join(productFolder, starter.path);
    if (existsSync(target) && readFileSync(target, 'utf8') === next) { remembered[starter.path] = next; continue; }
    writeFile(productFolder, starter.path, next);
    remembered[starter.path] = next;
    written.push(starter.path);
  }
  remember(recordFile, remembered);
  return written;
}
