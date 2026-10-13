/**
 * Builds the product's stage view from its manifest and files. Stage order,
 * names, kinds and expected records come from the product registry. External
 * completeness findings are read from the committed product snapshot; this
 * module does not infer missing records from current content.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join as joinPath, relative, sep } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { REGISTRY_FILE, readProductRegistry, registryKit, type RegistryKit } from '../product/registry.js';
import { readRegistryServing } from '../product-wiki/registry.js';
import { readProductCompleteness, type CompletenessRead } from '../product/completeness.js';

/** One product-document artifact a stage holds, pointing at the page that shows it. */
export interface StageArtifact {
  /** The document's path within the product. */
  readonly path: string;
  /** The document's title: its identity line's title, else its first heading, else the file name. */
  readonly title: string;
  /** The kind of the product's registry this document carries, by the registry's own word; the index reads no kind of its own. */
  readonly kind: string;
  /**
   * Whether the wiki's page reader serves this path (every Markdown under
   * `docs/` and the root `README.md` — nothing else). A record kept outside
   * those places is named as text on the stage page, never linked.
   */
  readonly served: boolean;
}

/**
 * One feature's tasks are grouped by: the set's features and
 * stages are tracker epics, and a task hangs under one by a `parent-child`
 * dependency whose `depends_on_id` names the parent — so an issue's parent is
 * read from its own `dependencies`, never from the parent's row. Issues with
 * no parent row form the group without a feature.
 */
export interface TaskFeature {
  /** The epic's tracker id, or `none` when the tasks name no parent. */
  readonly id: string;
  /** The epic's title, or the empty string when the row itself is absent. */
  readonly title: string;
  readonly open: number;
  readonly inProgress: number;
  readonly done: number;
  /** The tasks of this group, epic first, then in code point order of their ids. */
  readonly tasks: readonly TaskEntry[];
}

/** One task record as the stage index reads it. */
export interface TaskEntry {
  readonly id: string;
  readonly title: string;
  readonly status: 'open' | 'in_progress' | 'done';
}

/** Another feature's section the stage navigates to, never duplicates: the Architecture section is feature E's, the Repositories section is feature D's. */
export interface StageSectionLink {
  readonly kind: 'architecture' | 'repositories';
  /** Whether the product holds what the section reads — a `model/` for the views, declared or cloned repositories for the list. */
  readonly present: boolean;
}

/**
 * A tracker row mended or left out, surfaced at its full
 * path and line: a recognized status the stages do not group (deferred,
 * blocked), an issue with no status, a repeated id whose later row was
 * dropped, a dependency edge that is not an object. Notes never refuse the
 * groups — a damaged export's problem is what refuses them — but nothing a
 * tracker export holds disappears from this index in silence.
 */
export interface StageNote {
  readonly where: string;
  readonly line: number;
  readonly message: string;
}

/** One stage as one ask of the index found it. */
export interface StageSection {
  /** The stage's id from the registry. */
  readonly id: string;
  /** The stage's name from the registry, when supplied. */
  readonly name?: string;
  /**
   * What the stage holds, read from the real files: document artifacts with
   * their page paths, and the mechanism's own material among them.
   */
  readonly artifacts: readonly StageArtifact[];
  readonly findings?: readonly string[];
  /** Task records grouped by feature when the manifest assigns the task expectation. */
  readonly tasks?: readonly TaskFeature[];
  /** The tracker export's mended and dropped rows, each at its full path and line; other stages hold none. */
  readonly notes?: readonly StageNote[];
  /** The other features' sections this stage navigates to; absent when the stage names none. */
  readonly sections?: readonly StageSectionLink[];
}

/** The whole index: manifest stages in order, plus any read problems. */
export interface StagesIndex {
  readonly stages: readonly StageSection[];
  readonly completeness?: { computedAt: string; sourceRevision: string };
  /** How reads went: unreadable inputs are named here, never dropped in silence. */
  readonly problems: readonly { where: string; message: string }[];
}

/** The tracker export read when a stage declares task records. */
const TRACKER_EXPORT = '.beads/issues.jsonl';

/** The folder a described repository's derived documents are written under (the describing step's own layout). */
const REPOSITORY_DOCS = 'docs/repositories';

/**
 * A product folder's stage index, read from its real files now. Errors of
 * reading are answers, never throws: a folder that holds no tracker export has
 * no tasks; an export that exists but cannot be parsed is a problem named with
 * its full path, and the rest of the index stands.
 */
export function readStagesIndex(productFolder: string): StagesIndex {
  const problems: { where: string; message: string }[] = [];
  // The product registry: the stage list and the kinds the document
  // artifacts are read through. A registry file that stands but does not
  // read keeps the plain reading and names the contract's refusals as the
  // index's problems, the file and the line each one stands on.
  const registry = readProductRegistry(productFolder);
  if (registry.present && 'refused' in registry) {
    for (const error of registry.refused) {
      problems.push({
        where: error.file,
        message: (error.line === 0 ? '' : `line ${String(error.line)}: `) + (error.path === '' ? '' : `${error.path}: `) + error.message,
      });
    }
  }
  const kit = registryKit(registry);
  const list: { id: string; name?: string }[] = kit?.stages.map((stage) => ({ id: stage.id, name: stage.name })) ?? [];
  const stageOf = new Map<string, StageSectionBuilder>();
  for (const stage of list) stageOf.set(stage.id, { id: stage.id, name: stage.name, artifacts: [] });
  // Task records belong to the stage whose manifest expectations declare them.nd where it
  // names none the stage page skips that material.
  const holderOf = (id: string): StageSectionBuilder | undefined => stageOf.get(id);
  const taskStage = kit?.stages.find((stage) => stage.expected?.includes('task'));
  const build = taskStage === undefined ? undefined : holderOf(taskStage.id);
  if (build !== undefined) build.tasks = [];
  // The sections other features own: the stage named design navigates to
  // the Architecture section when the product holds a model/ for it to
  // compile; the stage named build navigates to the Repositories section
  // when the manifest declares repositories or a repos/ folder stands in
  // the product. The stages name them; whether the serving app holds those
  // sections is that app's build, so the index carries `present` and the
  // app decides between a link and the named placeholder.
  const design = holderOf('design');
  const modelFolder = joinPath(productFolder, 'model');
  if (design !== undefined) {
    if (existsSync(modelFolder) && lstatSync(modelFolder).isDirectory()) {
      design.sections = [{ kind: 'architecture', present: true }];
    } else {
      design.sections = [];
      // Recorded as the section's own flag: the final pass fills `missing`
      // from the artifacts, and the architecture views are missing only then.
      design.wantsArchitecture = true;
    }
  }
  const manifestText = readManifestText(productFolder);
  const reposDeclared = manifestText !== undefined && /(^|\n)repos:/.test(manifestText);
  const reposFolder = joinPath(productFolder, 'repos');
  if (reposDeclared || (existsSync(reposFolder) && lstatSync(reposFolder).isDirectory())) {
    if (build !== undefined) build.sections = [{ kind: 'repositories', present: true }];
  }

  // The document kinds: every kind's folder the registry names, its one
  // file or the documents inside its folder, under the kind the registry
  // gives it. With no registry there are no document kinds at all — the
  // product's pages are plain pages, and the stage pages show the
  // mechanism's own material beside the generic hints.
  if (kit !== undefined) {
    for (const kind of kit.kinds) {
      const kindHolder = stageOf.get(kind.stage);
      if (kindHolder === undefined) continue;
      const full = joinPath(productFolder, ...kind.folder.split('/'));
      if (kind.folder.endsWith('.md')) {
        for (const artifact of documentsOf(full, kind.name, false, problems)) kindHolder.artifacts.push(artifact);
        continue;
      }
      // A kind's folder holds the kind's documents at any depth: the walk
      // is the reading shell's own (fences and dot-folders the pages walk
      // skips), so a record kept a level down is still the kind's.
      for (const artifact of documentsUnder(full, kind.name, productFolder, problems)) kindHolder.artifacts.push(artifact);
    }

    // The described repositories (the describing step's own layout):
    // what that step derived from each repository's code stands
    // under docs/repositories/<name>/ in the same kind folders the
    // registry names for the product, and the described repository's
    // architecture page beside them. Those are the kinds' stages' material
    // as much as the product's own documents — the stages read them too,
    // named by their full path, which the page reader serves.
    const reposDocs = joinPath(productFolder, ...REPOSITORY_DOCS.split('/'));
    for (const name of fileNames(reposDocs, undefined, problems)) {
      const repoFolder = joinPath(reposDocs, name);
      const architecturePage = joinPath(repoFolder, 'architecture.md');
      const architectureHolder = stageOf.get('design');
      if (architectureHolder !== undefined && existsSync(architecturePage)) {
        try {
          architectureHolder.artifacts.push({
            path: `${REPOSITORY_DOCS}/${name}/architecture.md`,
            title: titleOf(readFileSync(architecturePage, 'utf8'), name),
            kind: 'repository architecture',
            served: true,
          });
        } catch (error) {
          problems.push({ where: architecturePage, message: (error as Error).message });
        }
      }
      for (const kind of kit.kinds) {
        if (!kind.folder.startsWith('docs/') || kind.folder.endsWith('.md')) continue;
        const within = kind.folder.slice('docs/'.length);
        const kindFolder = joinPath(repoFolder, ...within.split('/'));
        if (!existsSync(kindFolder) || !lstatSync(kindFolder).isDirectory()) continue;
        const kindHolder = stageOf.get(kind.stage);
        if (kindHolder === undefined) continue;
        for (const artifact of documentsOf(kindFolder, kind.name, true, problems)) kindHolder.artifacts.push(artifact);
      }
    }

    // The identity sweep: a document of a prefix the registry names is its
    // id, wherever it sits. Every page under docs/ the kind folders did
    // not already claim is read for its identity line, and a shape the
    // registry's prefixes carry puts it on its kind's stage — a derived
    // document the describing step left in any folder still stands on its
    // kind's stage. Duplicate paths are impossible (the sweep skips every
    // path the folders already claimed); the artifacts are deduplicated by
    // path at the end.
    const claimed = new Set<string>([...stageOf.values()].flatMap((builder) => builder.artifacts.map((artifact) => artifact.path)));
    for (const page of markdownPagesUnder(joinPath(productFolder, 'docs'), problems)) {
      if (claimed.has(page.path)) continue;
      let text: string;
      try {
        text = readFileSync(joinPath(productFolder, ...page.path.split('/')), 'utf8');
      } catch (error) {
        problems.push({ where: joinPath(productFolder, ...page.path.split('/')), message: (error as Error).message });
        continue;
      }
      const identity = /^#\s+(\S+)\b/.exec(text);
      if (identity === null || !kit.idShape.test(identity[1]!)) continue;
      const word = identity[1]!;
      const kind = kit.byPrefix.get(word.slice(0, word.indexOf('-')));
      if (kind === undefined) continue;
      const kindHolder = stageOf.get(kind.stage);
      if (kindHolder === undefined) continue;
      kindHolder.artifacts.push({ path: page.path, title: titleOf(text, page.path.split('/').pop()!), kind: kind.name, served: true });
    }
    for (const builder of stageOf.values()) {
      const seen = new Set<string>();
      builder.artifacts = builder.artifacts.filter((artifact) => (seen.has(artifact.path) ? false : seen.add(artifact.path)));
    }
  }

  // Task records: read-only from the export the tracker writes.
  let exported = false;
  const trackerFull = joinPath(productFolder, TRACKER_EXPORT);
  if (build !== undefined && existsSync(trackerFull)) {
    exported = true;
    const read = readTasks(trackerFull);
    if (read.ok) {
      build.tasks = read.groups;
      build.notes = read.notes;
    } else {
      build.tasks = [];
      problems.push({ where: trackerFull, message: read.message });
    }
  }

  // Completeness is supplied by the product's committed snapshot. The engine
  // does not infer missing records from current files.
  const completeness: CompletenessRead = readProductCompleteness(productFolder);
  if (completeness.present && 'problem' in completeness) {
    problems.push({ where: 'docs/completeness.json', message: completeness.problem });
  }
  const snapshot = completeness.present && 'snapshot' in completeness ? completeness.snapshot : undefined;

  const stages = list.map((stage) => {
    const builder = stageOf.get(stage.id)!;
    builder.artifacts.sort((a, b) => byCodePoint(a.path, b.path));
    builder.findings = snapshot?.findings.filter((finding) => finding.stage === stage.id).map((finding) => finding.message) ?? [];
    // A product with no export at all carries no tasks table; where an
    // export stands but holds no grouped task, the empty table stays so
    // the app can say the tracker holds none.
    if (builder.tasks !== undefined && builder.tasks.length === 0 && !exported) {
      delete builder.tasks;
    }
    return buildSection(builder);
  });
  return { stages, problems, ...(snapshot === undefined ? {} : { completeness: { computedAt: snapshot.computedAt, sourceRevision: snapshot.sourceRevision } }) };
}

/** Every Markdown page under one folder, at any depth, in code point order of their paths. */
function markdownPagesUnder(folder: string, problems: { where: string; message: string }[]): { path: string }[] {
  const pages: { path: string }[] = [];
  const walk = (current: string, within: string): void => {
    for (const name of fileNames(current, '.md', problems)) {
      pages.push({ path: within === '' ? name : `${within}/${name}` });
    }
    for (const name of fileNames(current, undefined, problems)) {
      walk(joinPath(current, name), within === '' ? name : `${within}/${name}`);
    }
  };
  if (!existsSync(folder)) return pages;
  walk(folder, 'docs');
  return pages;
}

/** The artifact list of one stage's builder, for the repository-subtree reads. */
function builderOf(stageOf: Map<string, StageSectionBuilder>, id: string): StageArtifact[] {
  return stageOf.get(id)!.artifacts;
}

/** Every task in the manifest-assigned task groups. */
function countTasks(groups: readonly TaskFeature[]): number {
  return groups.reduce((n, group) => n + group.tasks.length, 0);
}

/** A stage section under construction. */
interface StageSectionBuilder {
  id: string;
  /** The stage's own name from the registry, when the registry names one. */
  name?: string;
  artifacts: StageArtifact[];
  findings?: string[];
  tasks?: TaskFeature[];
  notes?: StageNote[];
  sections?: StageSectionLink[];
  /** The product holds no model/: the Design stage's missing lines name the views. */
  wantsArchitecture?: boolean;
}

function buildSection(builder: StageSectionBuilder): StageSection {
  return {
    id: builder.id,
    ...(builder.name !== undefined ? { name: builder.name } : {}),
    artifacts: builder.artifacts,
    ...(builder.findings !== undefined ? { findings: builder.findings } : {}),
    ...(builder.tasks !== undefined ? { tasks: builder.tasks } : {}),
    ...(builder.notes !== undefined ? { notes: builder.notes } : {}),
    ...(builder.sections !== undefined ? { sections: builder.sections } : {}),
  };
}

/** The path within the product a document sits at: the folder's own relative part plus the file name. */
function relativeDocsPath(folder: string, name: string): string | undefined {
  const marker = `${'docs'}/`;
  const at = folder.lastIndexOf(marker);
  if (at < 0) return undefined;
  return `${folder.slice(at)}${folder.endsWith('/') ? '' : '/'}${name}`;
}

/** The path within the product of a single file given whole. */
function relativeDocsPathOf(full: string): string | undefined {
  const marker = `${'docs'}/`;
  const at = full.lastIndexOf(marker);
  if (at < 0) return undefined;
  return full.slice(at);
}

/**
 * The documents of one kind: one file, or every Markdown file directly
 * inside the kind's folder. The folder walk and the file reads report
 * their failures into `problems` — a folder that exists but cannot be
 * read, a document that cannot be read — never a silently smaller stage.
 */
function documentsOf(full: string, kind: string, plural: boolean, problems: { where: string; message: string }[]): StageArtifact[] {
  const artifacts: StageArtifact[] = [];
  if (!plural) {
    if (!existsSync(full)) return artifacts;
    const within = relativeDocsPathOf(full);
    if (within === undefined) return artifacts;
    try {
      const text = readFileSync(full, 'utf8');
      artifacts.push({ path: within, title: titleOf(text, within.split('/').pop()!), kind, served: true });
    } catch (error) {
      problems.push({ where: full, message: (error as Error).message });
    }
    return artifacts;
  }
  for (const name of fileNames(full, '.md', problems)) {
    const file = joinPath(full, name);
    const within = relativeDocsPath(full, name);
    if (within === undefined) continue;
    try {
      const text = readFileSync(file, 'utf8');
      artifacts.push({ path: within, title: titleOf(text, within.split('/').pop()!), kind, served: true });
    } catch (error) {
      problems.push({ where: file, message: (error as Error).message });
    }
  }
  return artifacts;
}
/**
 * The documents of one kind's folder, at any depth, each named by its path
 * within the product. The walk skips dot-folders and never leaves the
 * folder; a folder or a file it cannot read is a problem named with its
 * full path, never a silently smaller stage.
 */
function documentsUnder(full: string, kind: string, productFolder: string, problems: { where: string; message: string }[]): StageArtifact[] {
  const artifacts: StageArtifact[] = [];
  const walk = (folder: string): void => {
    for (const name of fileNames(folder, '.md', problems)) {
      const file = joinPath(folder, name);
      try {
        const text = readFileSync(file, 'utf8');
        const within = relative(productFolder, file).split(sep).join('/');
        artifacts.push({ path: within, title: titleOf(text, name), kind, served: true });
      } catch (error) {
        problems.push({ where: file, message: (error as Error).message });
      }
    }
    for (const name of fileNames(folder, undefined, problems)) walk(joinPath(folder, name));
  };
  walk(full);
  return artifacts;
}

/**
 * The Markdown files directly inside one folder, in code point order of
 * their names. A folder that is not there holds nothing; a folder that is
 * there but cannot be read is a problem naming it, never an empty list in
 * silence.
 */
function fileNames(folder: string, extension: string | undefined, problems: { where: string; message: string }[]): string[] {
  // Existence, type and the listing itself stand in one error path: a
  // permission, a wrong type or an I/O failure is a problem naming the
  // folder and the cause, never an empty list that reads as absence and
  // never a throw that escapes the sink.
  let entries: import('node:fs').Dirent[];
  try {
    if (!existsSync(folder)) return [];
    const kind = lstatSync(folder);
    if (!kind.isDirectory()) return [];
    entries = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    problems.push({ where: folder, message: `the folder could not be read: ${(error as Error).message}` });
    return [];
  }
  return entries
    .filter((entry) => (extension === undefined ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(extension)))
    .map((entry) => entry.name)
    .sort(byCodePoint);
}

/**
 * A document's title: its first level-one heading's text, with an
 * identity line's id out (`<ID> — The title` reads "The title"), else the
 * file's name. The heading rules are the page titles' own: the first `# `
 * line, nothing parsed inside fences.
 */
function titleOf(markdown: string, fallback: string): string {
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (fence) continue;
    const heading = /^#\s+(.*)$/.exec(line);
    if (heading !== null) {
      const identity = /^([A-Z]+-\d{3,})\s+—\s+(.*)$/.exec(heading[1]!.trim());
      return (identity !== null ? identity[2]! : heading[1]!.trim()).trim();
    }
  }
  return fallback.replace(/\.md$/, '');
}

/** The manifest's text, when the product holds one; a manifest that cannot be read is no declaration. */
function readManifestText(productFolder: string): string | undefined {
  const full = joinPath(productFolder, 'workspace.yaml');
  if (!existsSync(full)) return undefined;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}

/** A task's status as the stages view groups it: open, in progress, or done. */
function taskStatus(status: string): 'open' | 'in_progress' | 'done' | undefined {
  if (status === 'open' || status === 'in_progress') return status;
  if (status === 'closed' || status === 'done') return 'done';
  return undefined;
}

/**
 * The tracker export read into task groups. Two kinds of trouble, never a
 * silent smaller list:
 * - damage — a line that is not JSON, a row that is not an object, an issue
 *   with no id — refuses the groups whole: a partial list would read as the
 *   whole tracker. One problem names the export and every damaged line.
 * - mending and dropping — a repeated id whose later row cannot be shown, a
 *   row with no status, a recognized status the stages do not group
 *   (deferred, blocked), a dependency edge that is not an object — surfaces
 *   as a note at its full path and line, and the groups stand.
 */
function readTasks(exportPath: string): { ok: true; groups: TaskFeature[]; notes: StageNote[] } | { ok: false; message: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(exportPath);
  } catch (error) {
    return { ok: false, message: `the tracker export ${exportPath} could not be read: ${(error as Error).message}` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return { ok: false, message: `the tracker export ${exportPath} is not UTF-8: ${(error as Error).message}` };
  }
  const lines = text.split('\n');
  interface Row {
    id: string;
    title: string;
    issueType: string;
    status: string;
    statusHeld: boolean;
    parents: string[];
    line: number;
  }
  const rows = new Map<string, Row>();
  const damage: string[] = [];
  const notes: StageNote[] = [];
  const note = (line: number, message: string): void => {
    notes.push({ where: exportPath, line, message });
  };
  for (let at = 0; at < lines.length; at++) {
    const number = at + 1;
    const line = lines[at]!.trim();
    if (line === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      damage.push(`line ${number} is not JSON (${(error as Error).message})`);
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      damage.push(`line ${number} is not a tracker issue object`);
      continue;
    }
    const record = row as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    if (id === undefined || id === '') {
      damage.push(`line ${number} holds an issue with no id`);
      continue;
    }
    if (rows.has(id)) {
      note(number, `the issue "${id}" is already held from line ${rows.get(id)!.line}: this row is dropped, not merged`);
      continue;
    }
    const status = record['status'];
    const statusHeld = typeof status === 'string' && status !== '';
    if (typeof status !== 'string' || status === '') {
      note(number, `the issue "${id}" holds no status: the stages group open, in-progress and done, so it is left out`);
    }
    const parents: string[] = [];
    const dependencies = record['dependencies'];
    if (Array.isArray(dependencies)) {
      for (const edge of dependencies) {
        if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
          note(number, `the issue "${id}" holds a dependency edge that is not an object: the edge is ignored`);
          continue;
        }
        const named = edge as Record<string, unknown>;
        if (named['type'] !== 'parent-child') continue;
        const parent = named['depends_on_id'];
        if (typeof parent === 'string') parents.push(parent);
        else note(number, `the issue "${id}" names a parent-child parent that is not an id: the edge is ignored`);
      }
    }
    rows.set(id, {
      id,
      title: typeof record['title'] === 'string' ? record['title'] : id,
      issueType: typeof record['issue_type'] === 'string' ? record['issue_type'] : '',
      status: statusHeld ? (status as string) : '',
      statusHeld,
      parents,
      line: number,
    });
  }

  const groups = new Map<string, { title: string; tasks: TaskEntry[] }>();
  for (const row of rows.values()) {
    if (row.issueType === 'epic') continue;
    if (!row.statusHeld) continue;
    const status = taskStatus(row.status);
    if (status === undefined) {
      note(row.line, `the issue "${row.id}" holds the status "${row.status}": the stages group open, in-progress and done, so it is left out`);
      continue;
    }
    let grouped = false;
    for (const parent of row.parents) {
      if (rows.get(parent)?.issueType !== 'epic') continue;
      if (!groups.has(parent)) groups.set(parent, { title: rows.get(parent)!.title, tasks: [] });
      groups.get(parent)!.tasks.push({ id: row.id, title: row.title, status });
      grouped = true;
    }
    if (!grouped) {
      if (!groups.has('none')) groups.set('none', { title: '', tasks: [] });
      groups.get('none')!.tasks.push({ id: row.id, title: row.title, status });
    }
  }
  // A damaged line refuses the groups whole: a smaller list would read as
  // the whole tracker. The rest of the stage index stands.
  if (damage.length > 0) {
    return { ok: false, message: damage.join('; ') };
  }
  const byFeatureThenNone = (a: string, b: string): number => {
    if (a === 'none') return 1;
    if (b === 'none') return -1;
    return byCodePoint(a, b);
  };
  const ordered: TaskFeature[] = [...groups.entries()]
    .sort(([a], [b]) => byFeatureThenNone(a, b))
    .map(([id, held]) => {
      const tasks = [...held.tasks].sort((a, b) => byCodePoint(a.id, b.id));
      return {
        id,
        title: held.title,
        open: tasks.filter((task) => task.status === 'open').length,
        inProgress: tasks.filter((task) => task.status === 'in_progress').length,
        done: tasks.filter((task) => task.status === 'done').length,
        tasks,
      };
    });
  return { ok: true, groups: ordered, notes };
}

/**
 * The digest of stage inputs beyond the wiki pages. Snapshot bytes, tracker
 * data, and the manifest affect the live revision; unreadable inputs hash as
 * unreadable so a place coming back is a change.
 */
export function stagesSourceDigest(productFolder: string): string {
  const hash = createHash('sha256');
  const file = (path: string): void => {
    hash.update(`${path}\u0000`);
    try {
      hash.update(readFileSync(path));
    } catch {
      hash.update('unreadable\u0000');
    }
    hash.update('\u0000');
  };
  file(joinPath(productFolder, TRACKER_EXPORT));
  file(joinPath(productFolder, 'workspace.yaml'));
  // The kinds registry is a stage input and a page input alike: a saved
  // registry is a wiki change the stream reports. Its bytes reach this
  // digest only through the serving gate (readRegistryServing), never a
  // direct read: the gate names a non-regular file instead of opening it,
  // and opening a FIFO or a device here would block the ask for good.
  const registryServing = readRegistryServing(productFolder);
  if (registryServing.contract.state !== 'absent') {
    hash.update(`${REGISTRY_FILE}\u0000${registryServing.digest}\u0000`);
  }
  const completeness = readProductCompleteness(productFolder);
  if (completeness.present) hash.update(JSON.stringify(completeness));
  return hash.digest('hex');
}
