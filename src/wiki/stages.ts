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
import { createHash } from 'node:crypto';
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
  /**
   * Whether the wiki's page reader serves this path (every Markdown under
   * `docs/` and the root `README.md` — nothing else). A record kept outside
   * those places, an acceptance record above all, is named as text on the
   * stage page, never wrapped in a link that cannot open.
   */
  readonly served: boolean;
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

/**
 * A row the Build stage's reader mended or left out, surfaced at its full
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
  /** The Build stage's mended and dropped rows, each at its full path and line; other stages hold none. */
  readonly notes?: readonly StageNote[];
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

/** The folder the describe-repository skill writes each repository's derived documents under. */
const REPOSITORY_DOCS = 'docs/repositories';

/**
 * Where ship-release's records are read. The notes are the project's
 * changelog — Keep a Changelog's is the common form the skill names — and
 * the FIRST of the two spots that exists is the release notes, never both:
 * a fallback, not an accumulation. The change proposals under docs/changes/
 * are never shown as releases — a proposal is not a release until it lands.
 */
const RELEASE_NOTE_PLACES = ['CHANGELOG.md', 'docs/CHANGELOG.md'];

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
  // stages name them; whether the serving app holds those sections is that
  // app's build, so the index carries `present` and the app decides between
  // a link and the named placeholder.
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
    for (const artifact of documentsOf(full, entry.kind, entry.plural, problems)) builder.artifacts.push(artifact);
  }

  // The described repositories (the describe-repository skill's own layout):
  // what the skill derived from each repository's code stands under
  // docs/repositories/<name>/ in the set's kind folders, and its architecture
  // page beside them. Those are the Requirements and Design stages' material
  // as much as the product's own documents — the stages read them too, named
  // by their full path, which the page reader serves.
  const reposDocs = joinPath(productFolder, ...REPOSITORY_DOCS.split('/'));
  for (const name of fileNames(reposDocs, undefined, problems)) {
    const repoFolder = joinPath(reposDocs, name);
    const architecturePage = joinPath(repoFolder, 'architecture.md');
    if (existsSync(architecturePage)) {
      try {
        stageOf.get('design')!.artifacts.push({
          path: `${REPOSITORY_DOCS}/${name}/architecture.md`,
          title: titleOf(readFileSync(architecturePage, 'utf8'), name),
          kind: 'repository architecture',
          served: true,
        });
      } catch (error) {
        problems.push({ where: architecturePage, message: (error as Error).message });
      }
    }
    for (const entry of KIND_FOLDERS) {
      if (entry.stage !== 'requirements' && entry.stage !== 'design') continue;
      if (!entry.plural) continue;
      const kindFolder = joinPath(repoFolder, ...entry.folder.split('/').slice(1));
      for (const artifact of documentsOf(kindFolder, entry.kind, true, problems)) builderOf(stageOf, entry.stage).push(artifact);
    }
  }

  // The identity sweep: a set-form document is its id, wherever it sits.
  // Every page under docs/ the kind folders did not already claim is read
  // for its identity line, and a known id prefix puts it on its stage — a
  // derived FR the describe-repository skill left in any folder still stands
  // on the Requirements stage, a decision record in any repository's
  // subtrees still stands on Design. Duplicates by path are impossible (the
  // sweep skips every path the folders already claimed); the artifacts are
  // deduplicated by path at the end.
  const claimed = new Set<string>([...stageOf.values()].flatMap((b) => b.artifacts.map((a) => a.path)));
  for (const page of markdownPagesUnder(joinPath(productFolder, 'docs'), problems)) {
    if (claimed.has(page.path)) continue;
    let text: string;
    try {
      text = readFileSync(joinPath(productFolder, ...page.path.split('/')), 'utf8');
    } catch (error) {
      problems.push({ where: joinPath(productFolder, ...page.path.split('/')), message: (error as Error).message });
      continue;
    }
    const identity = /^#\s+([A-Z]+-\d{3,})\b/.exec(text);
    if (identity === null) continue;
    const where = KIND_BY_PREFIX.get(identity[1]!.slice(0, identity[1]!.indexOf('-')));
    if (where === undefined) continue;
    stageOf.get(where.stage)!.artifacts.push({ path: page.path, title: titleOf(text, page.path.split('/').pop()!), kind: where.kind, served: true });
  }
  for (const builder of stageOf.values()) {
    const seen = new Set<string>();
    builder.artifacts = builder.artifacts.filter((a) => (seen.has(a.path) ? false : seen.add(a.path)));
  }

  // The Build stage's tasks: read-only from the same export the tracker writes.
  const build = stageOf.get('build')!;
  let exported = false;
  const trackerFull = joinPath(productFolder, TRACKER_EXPORT);
  if (existsSync(trackerFull)) {
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

  // The Verify stage's acceptance records: files the set's records folder
  // holds. They stand outside the wiki's served pages, so the artifacts are
  // named, never linked.
  const verify = stageOf.get('verify')!;
  const recordsFull = joinPath(productFolder, RECORDS_FOLDER);
  for (const name of fileNames(recordsFull, '.md', problems)) {
    const full = joinPath(recordsFull, name);
    try {
      const text = readFileSync(full, 'utf8');
      const accepted = text.includes(ACCEPTED_MARK) || /Final: [0-9a-f]{7,}/.test(text);
      const implemented = text.includes(IMPLEMENTED_MARK);
      if (accepted || implemented) {
        verify.artifacts.push({ path: `${RECORDS_FOLDER}/${name}`, title: titleOf(text, name), kind: 'acceptance record', served: false });
      }
    } catch (error) {
      problems.push({ where: full, message: (error as Error).message });
    }
  }

  // The Release stage: the project's changelog — the FIRST spot that
  // exists is the release notes, never both. The change records under
  // docs/changes/ are proposals until they land, so they are never shown
  // as releases; where the product keeps no release form at all, the
  // stage's missing line says what fills it.
  const release = stageOf.get('release')!;
  for (const place of RELEASE_NOTE_PLACES) {
    const full = joinPath(productFolder, ...place.split('/'));
    if (!existsSync(full)) continue;
    try {
      release.artifacts.push({
        path: place,
        title: titleOf(readFileSync(full, 'utf8'), place.split('/').pop()!),
        kind: 'release notes',
        served: true,
      });
      break;
    } catch (error) {
      problems.push({ where: full, message: (error as Error).message });
    }
  }

  const stages = STAGE_IDS.map((id) => {
    const builder = stageOf.get(id)!;
    builder.artifacts.sort((a, b) => byCodePoint(a.path, b.path));
    builder.missing = missingOf(id, builder.artifacts, builder.tasks === undefined ? 0 : countTasks(builder.tasks));
    if (builder.wantsArchitecture) {
      builder.missing.push({ kind: 'architecture views', skill: 'write-intended-model' });
    }
    // A product with no export at all carries no tasks table; where an
    // export stands but holds no grouped task, the empty table stays so the
    // app can say the tracker holds none. Either way the missing line names
    // take-task.
    if (builder.tasks !== undefined && builder.tasks.length === 0 && !exported) {
      delete builder.tasks;
    }
    return buildSection(builder);
  });
  return { stages, problems };
}

/** The set's id prefixes and the stage and kind each names. */
const KIND_BY_PREFIX = new Map<string, { stage: StageId; kind: string }>([
  ['S', { stage: 'idea', kind: 'source' }],
  ['H', { stage: 'idea', kind: 'hypothesis' }],
  ['Q', { stage: 'idea', kind: 'open question' }],
  ['P', { stage: 'idea', kind: 'prototype' }],
  ['R', { stage: 'idea', kind: 'result' }],
  ['US', { stage: 'requirements', kind: 'user story' }],
  ['UC', { stage: 'requirements', kind: 'use case' }],
  ['FR', { stage: 'requirements', kind: 'product requirement' }],
]);

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
function builderOf(stageOf: Map<StageId, StageSectionBuilder>, id: StageId): StageArtifact[] {
  return stageOf.get(id)!.artifacts;
}

/** Every task in a Build stage's groups, for the missing-line decision. */
function countTasks(groups: readonly TaskFeature[]): number {
  return groups.reduce((n, group) => n + group.tasks.length, 0);
}

/** A stage section under construction. */
interface StageSectionBuilder {
  id: StageId;
  artifacts: StageArtifact[];
  missing: { kind: string; skill: string }[];
  tasks?: TaskFeature[];
  notes?: StageNote[];
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
    ...(builder.notes !== undefined ? { notes: builder.notes } : {}),
    ...(builder.sections !== undefined ? { sections: builder.sections } : {}),
    empty,
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
 * The set-form documents one folder holds (or the one vision file). The
 * folder walk and the file reads report their failures into `problems` —
 * a folder that exists but cannot be read, a document that cannot be read —
 * never a silently smaller stage.
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

/**
 * The kinds a stage holds nothing of, each with the skill that fills it. The
 * Build stage's own kind is the task: no grouped task at all names take-task.
 */
function missingOf(id: StageId, artifacts: readonly StageArtifact[], taskCount: number): { kind: string; skill: string }[] {
  const held = new Set(artifacts.map((artifact) => artifact.kind));
  const missing: { kind: string; skill: string }[] = [];
  for (const entry of KIND_FOLDERS) {
    if (entry.stage !== id || held.has(entry.kind)) continue;
    if (missing.some((m) => m.kind === entry.kind)) continue;
    missing.push({ kind: entry.kind, skill: STAGE_SKILLS[id] });
  }
  if (id === 'verify' && !held.has('acceptance record')) missing.push({ kind: 'acceptance record', skill: STAGE_SKILLS[id] });
  if (id === 'release' && !held.has('release notes')) missing.push({ kind: 'release record', skill: STAGE_SKILLS[id] });
  if (id === 'build' && taskCount === 0) missing.push({ kind: 'task', skill: STAGE_SKILLS[id] });
  // The Operate stage's material is what handle-incident records — the
  // review's timeline, cost and filed work — and none of it is held here.
  if (id === 'operate') missing.push({ kind: 'incident record', skill: STAGE_SKILLS[id] });
  return missing;
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
 * The digest of everything the stages read beyond the wiki's pages: the
 * tracker export, the records folder, the manifest and the change records'
 * folder. The wiki's revision folds this in (the same rule feature E uses
 * for the model's sources), so a saved task or an acceptance record is a
 * wiki change: the stream reports it and the open stage page asks again.
 * Unreadable places hash as unreadable, so a place coming back is a change.
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
  const folderNames = (folder: string): string[] => {
    if (!existsSync(folder)) return [];
    try {
      return readdirSync(folder).sort(byCodePoint);
    } catch {
      return ['unreadable'];
    }
  };
  file(joinPath(productFolder, TRACKER_EXPORT));
  for (const name of folderNames(joinPath(productFolder, RECORDS_FOLDER))) {
    file(joinPath(productFolder, RECORDS_FOLDER, name));
  }
  file(joinPath(productFolder, 'workspace.yaml'));
  // The release notes are stage inputs: both spellings hash, the read bytes
  // only when the path exists, so an edit of the notes the stage shows moves
  // the wiki revision and the open stage page asks again.
  for (const place of RELEASE_NOTE_PLACES) {
    const full = joinPath(productFolder, ...place.split('/'));
    if (existsSync(full)) file(full);
  }
  return hash.digest('hex');
}
