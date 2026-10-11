/**
 * The SDLC stage index (docs/changes/wiki-sdlc/capabilities/product-wiki.md,
 * requirement `stages`): one computed view over the product folder that names,
 * for every stage of the skill set's life cycle, what the product holds there
 * now, what kind holds it, and — when the stage holds nothing — which skill of
 * the set fills it. The stages and the kinds they hold:
 *
 *   idea        vision, sources, hypotheses, open questions, prototypes, results
 *   requirements  user stories, use cases, product requirements (FR-…)
 *   design      the intended model's views (feature E's Architecture section;
 *               linked, not built here), decision records, design specs
 *   build       the code repositories (feature D's Repositories section) and
 *               the product's own tasks, read-only from .beads/issues.jsonl
 *   verify      acceptance records: `accepted:` / `implemented:` comments
 *   release     ship-release's release notes (docs/releases/, CHANGELOG)
 *   operate     handle-incident's incident records (docs/incidents/)
 *
 * Pure and deterministic over one reading of the product folder: the same
 * folder gives the same index, sorted by code point, never by locale; nothing
 * here reads the clock and nothing writes. The idea and requirements stages
 * hold document kinds the wiki already serves as pages, so their artifacts
 * carry the page paths the app navigates to — the stage sections navigate,
 * they never duplicate the pages.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { byCodePoint } from '../model/order.js';

/** The stages in the life cycle's own order (the set's lifecycle.md table). */
export const STAGE_IDS = ['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate'] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** One skill named as filling an empty stage, keyed by the stage it fills. */
export const STAGE_SKILLS: Record<StageId, string> = {
  idea: 'define-product',
  requirements: 'to-spec',
  design: 'to-design',
  build: 'take-task',
  verify: 'take-task',
  release: 'ship-release',
  operate: 'handle-incident',
};

/** One product-document artifact a stage holds, pointing at the page that shows it. */
export interface StageArtifact {
  /** The document's path within the product, like `docs/vision.md`. */
  readonly path: string;
  /** The document's title: its identity line's title, else its first heading, else the file name. */
  readonly title: string;
  /** The set's kind of this document, like `vision`, `hypothesis`, `story`, `requirement`, `use case`. */
  readonly kind: string;
}

/**
 * One feature the Build stage's tasks are grouped by: the set's features and
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

/** One task as the Build stage names it. */
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

/** One stage as one ask of the index found it. */
export interface StageSection {
  readonly id: StageId;
  /**
   * What the stage holds, read from the real files: document artifacts with
   * their page paths, and — on the Build stage — the tasks grouped by feature.
   */
  readonly artifacts: readonly StageArtifact[];
  /** The document kinds the stage holds nothing of, each with the skill that fills it. */
  readonly missing: readonly { kind: string; skill: string }[];
  /** The Build stage's tasks, grouped by feature; other stages hold none. */
  readonly tasks?: readonly TaskFeature[];
  /** The other features' sections this stage navigates to; absent when the stage names none. */
  readonly sections?: readonly StageSectionLink[];
  /** True when the stage holds nothing at all: the app then shows only the missing lines. */
  readonly empty: boolean;
}

/** The whole index: every stage, in the life cycle's order, plus what was refused reading. */
export interface StagesIndex {
  readonly stages: readonly StageSection[];
  /** How the reads went: a tracker export or records folder that exists but cannot be parsed is named here, never dropped in silence. */
  readonly problems: readonly { where: string; message: string }[];
}

/** The set's document kinds each stage holds, with the folder or file the kind lives in. */
const KIND_FOLDERS: ReadonlyArray<{ stage: StageId; kind: string; folder: string; plural: boolean }> = [
  { stage: 'idea', kind: 'vision', folder: 'docs/vision.md', plural: false },
  { stage: 'idea', kind: 'source', folder: 'docs/sources', plural: true },
  { stage: 'idea', kind: 'hypothesis', folder: 'docs/hypotheses', plural: true },
  { stage: 'idea', kind: 'open question', folder: 'docs/questions', plural: true },
  { stage: 'idea', kind: 'prototype', folder: 'docs/prototypes', plural: true },
  { stage: 'idea', kind: 'result', folder: 'docs/results', plural: true },
  { stage: 'requirements', kind: 'user story', folder: 'docs/stories', plural: true },
  { stage: 'requirements', kind: 'use case', folder: 'docs/use-cases', plural: true },
  { stage: 'requirements', kind: 'product requirement', folder: 'docs/requirements', plural: true },
  { stage: 'design', kind: 'decision', folder: 'docs/decisions', plural: true },
  { stage: 'design', kind: 'design spec', folder: 'docs/specs', plural: true },
];

/** The tracker export the Build stage reads its tasks from. */
const TRACKER_EXPORT = '.beads/issues.jsonl';

/** Where ship-release's records are looked for, in the order the form names them. */
const RELEASE_PLACES = ['docs/releases', 'CHANGELOG.md', 'docs/CHANGELOG.md'];

/** Where handle-incident's records are looked for. */
const INCIDENT_FOLDER = 'docs/incidents';

/** Where stage acceptance records are looked for: the set's records folder beside its checks. */
const RECORDS_FOLDER = '.shady2k/records';

/** The first line an acceptance record's evidence holds (`accepted:` or the older prose form). */
const ACCEPTED_MARK = 'accepted: {"base"';

/** The first line a record the set's gate calls implemented holds. */
const IMPLEMENTED_MARK = 'implemented: {"revision"';

/**
 * A product folder's stage index, read from its real files now. Errors of
 * reading are answers, never throws: a folder that holds no tracker export has
 * no tasks; an export that exists but cannot be parsed is a problem named with
 * its full path, and the rest of the index stands.
 */
export function readStagesIndex(productFolder: string): StagesIndex {
  const problems: { where: string; message: string }[] = [];
  const stageOf = new Map<StageId, StageSectionBuilder>();
  for (const id of STAGE_IDS) stageOf.set(id, { id, artifacts: [], missing: [] });
  // A stage's tasks field is set only where tasks are read, so the app never
  // waits for a tasks table a stage does not hold.
  stageOf.get('build')!.tasks = [];
  // The sections other features own: the Design stage navigates to the
  // Architecture section when the product holds a model/ for it to compile;
  // the Build stage navigates to the Repositories section when the manifest
  // declares repositories or a repos/ folder stands in the product. The
  // stages name and link them; neither compiles the model nor lists the
  // repositories here.
  const modelFolder = joinPath(productFolder, 'model');
  if (existsSync(modelFolder) && lstatSync(modelFolder).isDirectory()) {
    stageOf.get('design')!.sections = [{ kind: 'architecture', present: true }];
  } else {
    stageOf.get('design')!.sections = [];
    // Recorded as the builder's own flag: the final pass fills `missing`
    // from the artifacts, and the architecture views are missing only then.
    stageOf.get('design')!.wantsArchitecture = true;
  }
  const manifestText = readManifestText(productFolder);
  const reposDeclared = manifestText !== undefined && /(^|\n)repos:/.test(manifestText);
  const reposFolder = joinPath(productFolder, 'repos');
  if (reposDeclared || (existsSync(reposFolder) && lstatSync(reposFolder).isDirectory())) {
    stageOf.get('build')!.sections = [{ kind: 'repositories', present: true }];
  }

  // The document kinds: every set-form document under its kind's folder.
  for (const entry of KIND_FOLDERS) {
    const builder = stageOf.get(entry.stage)!;
    const full = joinPath(productFolder, ...entry.folder.split('/'));
    for (const artifact of documentsOf(full, entry.kind, entry.plural)) builder.artifacts.push(artifact);
  }

  // The Build stage's tasks: read-only from the same export the tracker writes.
  const build = stageOf.get('build')!;
  let exported = false;
  const trackerFull = joinPath(productFolder, TRACKER_EXPORT);
  if (existsSync(trackerFull)) {
    exported = true;
    const read = readTasks(trackerFull);
    build.tasks = read.ok ? read.groups : [];
    if (!read.ok) problems.push({ where: trackerFull, message: read.message });
  }

  // The Verify stage's acceptance records: files the set's records folder holds.
  const verify = stageOf.get('verify')!;
  const recordsFull = joinPath(productFolder, RECORDS_FOLDER);
  for (const name of fileNames(recordsFull, '.md')) {
    const full = joinPath(recordsFull, name);
    try {
      const text = readFileSync(full, 'utf8');
      const accepted = text.includes(ACCEPTED_MARK) || /Final: [0-9a-f]{7,}/.test(text);
      const implemented = text.includes(IMPLEMENTED_MARK);
      if (accepted || implemented) {
        verify.artifacts.push({ path: `${RECORDS_FOLDER}/${name}`, title: titleOf(text, name), kind: 'acceptance record' });
      }
    } catch (error) {
      problems.push({ where: full, message: (error as Error).message });
    }
  }

  // The Release stage: ship-release's records, wherever the project keeps them.
  const release = stageOf.get('release')!;
  for (const place of RELEASE_PLACES) {
    const full = joinPath(productFolder, ...place.split('/'));
    const kind = place.endsWith('.md') ? 'release notes' : 'release record';
    if (place.endsWith('.md')) {
      if (!existsSync(full)) continue;
      try {
        release.artifacts.push({ path: place, title: titleOf(readFileSync(full, 'utf8'), place.split('/').pop()!), kind });
      } catch (error) {
        problems.push({ where: full, message: (error as Error).message });
      }
    } else {
      for (const name of fileNames(full, '.md')) {
        const file = joinPath(full, name);
        try {
          release.artifacts.push({ path: `${place}/${name}`, title: titleOf(readFileSync(file, 'utf8'), name), kind });
        } catch (error) {
          problems.push({ where: file, message: (error as Error).message });
        }
      }
    }
  }

  // The Operate stage: handle-incident's records.
  const operate = stageOf.get('operate')!;
  const incidentsFull = joinPath(productFolder, INCIDENT_FOLDER);
  for (const name of fileNames(incidentsFull, '.md')) {
    const file = joinPath(incidentsFull, name);
    try {
      operate.artifacts.push({ path: `${INCIDENT_FOLDER}/${name}`, title: titleOf(readFileSync(file, 'utf8'), name), kind: 'incident record' });
    } catch (error) {
      problems.push({ where: file, message: (error as Error).message });
    }
  }

  const stages = STAGE_IDS.map((id) => {
    const builder = stageOf.get(id)!;
    builder.artifacts.sort((a, b) => byCodePoint(a.path, b.path));
    builder.missing = missingOf(id, builder.artifacts);
    if (builder.wantsArchitecture) {
      builder.missing.push({ kind: 'architecture views', skill: 'write-intended-model' });
    }
    // An empty tasks table is left only where an export stands but holds no
    // task: the app then says the tracker holds none, instead of hiding that
    // the export was there. A product with no export at all carries no table.
    // A product with no export at all carries no tasks table; where an export
    // stands but holds no grouped task, the empty table stays so the app can
    // say the tracker holds none.
    if (builder.tasks !== undefined && builder.tasks.length === 0 && !exported) {
      delete builder.tasks;
    }
    return buildSection(builder);
  });
  return { stages, problems };
}

/** A stage section under construction. */
interface StageSectionBuilder {
  id: StageId;
  artifacts: StageArtifact[];
  missing: { kind: string; skill: string }[];
  tasks?: TaskFeature[];
  sections?: StageSectionLink[];
  /** The product holds no model/: the Design stage's missing lines name the views. */
  wantsArchitecture?: boolean;
}

function buildSection(builder: StageSectionBuilder): StageSection {
  const empty = builder.artifacts.length === 0 && (builder.tasks === undefined || builder.tasks.length === 0);
  return {
    id: builder.id,
    artifacts: builder.artifacts,
    missing: builder.missing,
    ...(builder.tasks !== undefined ? { tasks: builder.tasks } : {}),
    ...(builder.sections !== undefined ? { sections: builder.sections } : {}),
    empty,
  };
}

function missingOf(id: StageId, artifacts: readonly StageArtifact[]): { kind: string; skill: string }[] {
  const held = new Set(artifacts.map((artifact) => artifact.kind));
  const missing: { kind: string; skill: string }[] = [];
  for (const entry of KIND_FOLDERS) {
    if (entry.stage !== id || held.has(entry.kind)) continue;
    if (missing.some((m) => m.kind === entry.kind)) continue;
    missing.push({ kind: entry.kind, skill: STAGE_SKILLS[id] });
  }
  if (id === 'verify' && !held.has('acceptance record')) missing.push({ kind: 'acceptance record', skill: STAGE_SKILLS[id] });
  if (id === 'release' && !held.has('release record') && !held.has('release notes')) missing.push({ kind: 'release record', skill: STAGE_SKILLS[id] });
  if (id === 'operate' && !held.has('incident record')) missing.push({ kind: 'incident record', skill: STAGE_SKILLS[id] });
  return missing;
}

/** The set-form documents one folder (or the one vision file) holds. */
function documentsOf(full: string, kind: string, plural: boolean): StageArtifact[] {
  const names = plural ? fileNames(full, '.md') : existsSync(full) && lstatSync(full).isFile() ? [full] : [];
  const artifacts: StageArtifact[] = [];
  for (const name of names) {
    const file = plural ? joinPath(full, name) : full;
    const within = plural ? relativeDocsPath(full, name) : relativeDocsPathOf(full);
    if (within === undefined) continue;
    try {
      const text = readFileSync(file, 'utf8');
      artifacts.push({ path: within, title: titleOf(text, within.split('/').pop()!), kind });
    } catch {
      // An unreadable file of a kind is not an artifact; the page reader names
      // its own refusal when the reader asks for it. Reading the folder again
      // would only repeat what the walk already said.
    }
  }
  return artifacts;
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

/** The Markdown files directly inside one folder, in code point order of their names. */
function fileNames(folder: string, extension: string): string[] {
  if (!existsSync(folder)) return [];
  const kind = lstatSync(folder);
  if (!kind.isDirectory()) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name)
    .sort(byCodePoint);
}

/**
 * A document's title: its first level-one heading's text without the set's
 * identity id (`FR-001 — The title` reads "The title"), else the file's name.
 * The heading rules are the page titles' own: the first `# ` line, nothing
 * parsed inside fences.
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

/** The tracker export read into task groups; a file that exists but cannot be read is a refusal, never a smaller list. */
function readTasks(exportPath: string): { ok: true; groups: TaskFeature[] } | { ok: false; message: string } {
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
  const issues = new Map<string, { id: string; title: string; issue_type: string; status: string; parents: string[] }>();
  const problems: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!.trim();
    if (line === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      problems.push(`line ${at + 1} of ${exportPath} is not JSON (${(error as Error).message})`);
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      problems.push(`line ${at + 1} of ${exportPath} is not a tracker issue object`);
      continue;
    }
    const record = row as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    if (id === undefined || id === '') {
      problems.push(`line ${at + 1} of ${exportPath} holds an issue with no id`);
      continue;
    }
    const parents: string[] = [];
    const dependencies = record['dependencies'];
    if (Array.isArray(dependencies)) {
      for (const edge of dependencies) {
        if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) continue;
        const named = edge as Record<string, unknown>;
        if (named['type'] !== 'parent-child') continue;
        const parent = named['depends_on_id'];
        if (typeof parent === 'string') parents.push(parent);
      }
    }
    issues.set(id, {
      id,
      title: typeof record['title'] === 'string' ? record['title'] : id,
      issue_type: typeof record['issue_type'] === 'string' ? record['issue_type'] : '',
      status: typeof record['status'] === 'string' ? record['status'] : 'open',
      parents,
    });
  }

  const groups = new Map<string, { title: string; tasks: TaskEntry[] }>();
  for (const issue of issues.values()) {
    if (issue.issue_type === 'epic') continue;
    const status = taskStatus(issue.status);
    if (status === undefined) continue;
    for (const parent of issue.parents) {
      if (issues.get(parent)?.issue_type !== 'epic') continue;
      if (!groups.has(parent)) groups.set(parent, { title: issues.get(parent)!.title, tasks: [] });
      groups.get(parent)!.tasks.push({ id: issue.id, title: issue.title, status });
    }
    if (issue.parents.length === 0 || issue.parents.every((parent) => issues.get(parent)?.issue_type !== 'epic')) {
      if (!groups.has('none')) groups.set('none', { title: '', tasks: [] });
      groups.get('none')!.tasks.push({ id: issue.id, title: issue.title, status });
    }
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
  if (problems.length > 0) {
    return { ok: false, message: problems.join('; ') };
  }
  return { ok: true, groups: ordered };
}
