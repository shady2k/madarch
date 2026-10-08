/**
 * The model check (docs/changes/agent-model/capabilities/model-check.md):
 * reads a repository's intended model and the repository it describes, and
 * reports what is wrong — never writes either. The check's command is
 * `bun scripts/check-model.ts <repository path> [--rev <git revision>]
 * [--json]`; this module holds the check itself so the script only parses
 * arguments, prints and exits, and the tests call it directly.
 *
 * Git is read through the `git` binary, read-only. A missing input (the
 * path is not a git repository, there is no `madarch/` folder, the folder
 * holds no `*.yaml` file, the revision does not name a commit) is
 * `unreadable`, exit 2. A model that does not compile fails the check and
 * nothing else is computed from a compiled model. The report grows by
 * sections as the requirements land:
 * staleness and assignment read the review report (this module); the
 * problems read the compiled model, the view set and the history (this
 * module and `model-problems.ts`); the views, when the caller asks for
 * them, are rendered at the checked revision's commit time and written
 * into the folder its `--views` option names — the only place the check
 * writes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path/posix';
import { join, resolve } from 'node:path';
import type { CompiledModel } from '../model/compile.js';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import { byCodePoint, sortedByCodePoint } from '../model/order.js';
import type { Evidence } from '../model/schema.js';
import type { PositionedModel, PositionedScenario } from '../model/validate.js';
import { prepareModel, renderModel } from '../render/prepare.js';
import { buildViewSet } from '../render/view-set.js';
import { writeViews, type WrittenViews } from '../render/write.js';
import {
  BULK_COMMIT_FILES,
  HIDDEN_COUPLING_WINDOW_DAYS,
  compareProblems,
  cycleProblems,
  hiddenCouplingProblems,
  hubProblems,
  levelsOf,
  magicSourceOrSinkProblems,
  trustBoundaryProblems,
  unstableDependencyProblems,
  type ProblemFinding,
  type TouchedCommit,
} from './model-problems.js';

export interface ModelCheckFinding {
  /** The model id (element, interface, relation, data entity or scenario) the finding names, when it has one. */
  id?: string;
  /** The model file that declares the item, or the repository path for a finding about the inputs themselves. */
  file: string;
  /** The 1-based line the item is declared on; 0 for a whole-path finding. */
  line: number;
  /**
   * The item's full path from the model's top (`elements[3].parent`,
   * `scenarios[0].requirements[1]`), for every finding whose source is the
   * model — the loader's own errors and warnings carry one, and so does
   * every finding about an evidence item or a scenario's requirement. Left
   * out for a finding about the review report, the repository's files or
   * the history, which have no place in the model.
   */
  path?: string;
  message: string;
}

export interface ModelCheckReport {
  /** `unreadable` exits 2, `failed` exits 1, `passed` exits 0. */
  outcome: 'passed' | 'failed' | 'unreadable';
  /** Every finding that fails the check. */
  errors: ModelCheckFinding[];
  /** Evidence items and document claims whose file no longer reads as it did; reported, never failing. */
  stale: ModelCheckFinding[];
  /** Problems recognised methods define, reported with the model: they never fail the check. */
  problems: ProblemFinding[];
  /** Problems that do not fail the check, reported with the model. */
  warnings: ModelCheckFinding[];
  /** Facts worth reading beside the report, such as where a missing commit's blob was found. */
  notes: ModelCheckFinding[];
}

export interface ModelCheckOptions {
  /** The revision the repository is checked at; the default is `HEAD`. */
  rev?: string;
  /**
   * The folder every view of the model is rendered into — the Mermaid
   * pages and the LikeC4 workspace, created when missing. Left out, or
   * the model does not compile: nothing is written anywhere.
   */
  views?: string;
}

/** An element, interface, relation or data entity of the model, named as the loader positions it. */
interface Declared {
  kind: 'element' | 'interface' | 'relation' | 'entity';
  id: string;
  /** What the finding names it by: `element "core"`, `relation "ui-calls-core"`. */
  label: string;
  file: string;
  line: number;
  /** The item's own path from the model's top: `elements[3]`, `entities[0]`. */
  path: string;
  /** The line each of the entity's evidence items is declared on, parallel to `evidence`. */
  evidenceLines: readonly number[];
  evidence: readonly Evidence[] | undefined;
}

/** Findings are named the same way every time: by file, then line, then id, in code-point order. */
function byFileLineId(a: ModelCheckFinding, b: ModelCheckFinding): number {
  const file = byCodePoint(a.file, b.file);
  if (file !== 0) return file;
  if (a.line !== b.line) return a.line - b.line;
  return byCodePoint(a.id ?? '', b.id ?? '');
}

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

/**
 * The review report, beside the model (model-authoring, requirement
 * review). The loader reads only `*.yaml`, so the report is not part of
 * the model; the check reads its two tables by their level-2 headings.
 */
const REVIEW = 'madarch/review.md';
/** The folder a repository's capability specs live in (model-check, requirements-resolve). */
const CAPABILITIES = 'docs/system/capabilities/';
export const CLAIMS_COLUMNS = ['Claim', 'Document', 'Line', 'Commit', 'Blob', 'Checked in code', 'Verdict', 'In the model'];
export const ASSIGNMENT_COLUMNS = ['Path', 'Element', 'Reason'];
const VERDICTS = ['confirmed', 'contradicted', 'stale', 'planned', 'unconfirmed'];
const HEX40 = /^[0-9a-f]{40}$/;

/** Whether `path` is a folder that exists; anything else, including a file or nothing, is not. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** One read-only `git` invocation in the checked repository. */
function git(repo: string, args: string[]): { ok: boolean; stdout: string } {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER });
  if (run.error !== undefined || run.status !== 0) return { ok: false, stdout: '' };
  return { ok: true, stdout: run.stdout ?? '' };
}

/** Every path the revision tracks, with the object id each holds: one `git ls-tree -r -z`. */
function trackedAt(repo: string, revCommit: string): Map<string, string> | undefined {
  const run = git(repo, ['ls-tree', '-r', '-z', revCommit]);
  if (!run.ok) return undefined;
  const blobs = new Map<string, string>();
  for (const entry of run.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) continue;
    const meta = entry.slice(0, tab).split(' ');
    blobs.set(entry.slice(tab + 1), meta[2] ?? '');
  }
  return blobs;
}

/** The type of the object git holds at `<rev>:<path>`: `blob`, `tree`, or nothing — `cat-file -t` names it. */
function objectTypeAt(repo: string, rev: string, path: string): 'blob' | 'tree' | undefined {
  const run = git(repo, ['cat-file', '-t', `${rev}:${path}`]);
  if (!run.ok) return undefined;
  const type = run.stdout.trim();
  return type === 'blob' || type === 'tree' ? type : undefined;
}

/**
 * Searches the checked revision's history for a path's blob, returning the
 * commit that had it — the way an evidence item survives a squash or a
 * rebase that removed the commit its item names.
 */
function findBlobInHistory(repo: string, revCommit: string, file: string, blob: string): string | undefined {
  const run = git(repo, ['log', revCommit, '--format=%H', '--raw', '--no-abbrev', '--', file]);
  if (!run.ok) return undefined;
  let current: string | undefined;
  for (const line of run.stdout.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      current = line;
    } else if (line.startsWith(':')) {
      // A raw line's shape is `:100644 100644 <old blob> <new blob> R100\tpath`;
      // the status and the path may hold anything, the two blob ids cannot.
      // Only a blob entry can carry the item's text: a folder's entry is a
      // tree (mode 040000) and a submodule's a commit (160000), and each
      // side is read only under a blob mode of its own — the old side's
      // mode keeps the line's leading colon.
      const fields = (line.split('\t')[0] ?? '').split(' ');
      if (fields[2] === blob && /^:?(?:100644|100755|120000)$/.test(fields[0] ?? '')) return current;
      if (fields[3] === blob && /^:?(?:100644|100755|120000)$/.test(fields[1] ?? '')) return current;
    }
  }
  return undefined;
}

/** The number of lines a blob holds, counting a last line without its newline. */
function blobLineCount(repo: string, blob: string): number | undefined {
  const run = git(repo, ['cat-file', 'blob', blob]);
  if (!run.ok) return undefined;
  const text = run.stdout;
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/**
 * The text of one file of the checked revision, read from git only: the
 * requirement check reads the capability specs the way the rest of the
 * check reads the repository — at the revision, never the working tree.
 * Undefined when the revision holds no file at that path (a path that
 * names a folder is no file either: its object is a tree, not a blob).
 */
function fileTextAt(repo: string, revCommit: string, file: string): string | undefined {
  const run = git(repo, ['cat-file', 'blob', `${revCommit}:${file}`]);
  return run.ok ? run.stdout : undefined;
}

/**
 * Whether a capability spec holds a heading for one requirement id: a line
 * `## Requirement: <id>` followed by the end of the line, a space or
 * ` — ` (the specs write `## Requirement: shape — The compiled model…`).
 * A heading for an id that merely starts the same way (`store-version`
 * for `store`) does not match: what follows the id is neither.
 */
function hasRequirementHeading(spec: string, requirementId: string): boolean {
  const heading = `## Requirement: ${requirementId}`;
  // A heading inside a fenced code block is an example, not a requirement,
  // so the fence's own lines and everything between them are skipped; a
  // trailing carriage return is part of the line ending, not of what
  // follows the id, so a spec with CRLF endings resolves its requirements
  // the same as one with LF.
  let fenced = false;
  for (const raw of spec.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.startsWith(heading)) continue;
    const rest = line.slice(heading.length);
    if (rest === '' || rest.startsWith(' ')) return true;
  }
  return false;
}

/**
 * The requirements-resolve section: every requirement every scenario
 * names, `capability/requirement`, must resolve against the checked
 * revision's capability specs — the file named after the capability under
 * `docs/system/capabilities/`, and in it a heading `## Requirement: <id>`.
 * Each that does not resolve fails the check, naming the scenario, the
 * requirement, the model file and line it is named on, and which of the
 * two is missing. Nothing is read for a scenario that names none.
 */
function requirementFindings(repo: string, revCommit: string, scenarios: readonly PositionedScenario[]): ModelCheckFinding[] {
  const errors: ModelCheckFinding[] = [];
  for (const entry of scenarios) {
    (entry.scenario.requirements ?? []).forEach((requirementId, index) => {
      // The loader has already refused anything not of the form
      // `capability/requirement`, so a model that compiled gives both
      // parts; the split below reads them out.
      const slash = requirementId.indexOf('/');
      const capability = requirementId.slice(0, slash);
      const requirementPart = requirementId.slice(slash + 1);
      const specFile = `${CAPABILITIES}${capability}.md`;
      const spec = fileTextAt(repo, revCommit, specFile);
      const at = entry.requirementsLines[index] ?? entry.line;
      const path = `scenarios[${entry.index}].requirements[${index}]`;
      if (spec === undefined) {
        errors.push({
          id: requirementId,
          file: entry.file,
          line: at,
          path,
          message: `scenario "${entry.scenario.id}" names requirement "${requirementId}", but there is no capability spec "${capability}": ${specFile} is not a file at the checked revision`,
        });
        return;
      }
      if (!hasRequirementHeading(spec, requirementPart)) {
        errors.push({
          id: requirementId,
          file: entry.file,
          line: at,
          path,
          message: `scenario "${entry.scenario.id}" names requirement "${requirementId}", but ${specFile} has no requirement "${requirementPart}"`,
        });
      }
    });
  }
  return errors;
}

/** Every element, interface and relation of the model, with where each was written. */
function declaredItems(positions: PositionedModel): Declared[] {
  return [
    ...positions.elements.map((p) => ({
      kind: 'element' as const,
      id: p.element.id,
      label: `element "${p.element.id}"`,
      file: p.file,
      line: p.line,
      path: `elements[${p.index}]`,
      evidenceLines: p.evidenceLines,
      evidence: p.element.evidence,
    })),
    ...positions.interfaces.map((p) => ({
      kind: 'interface' as const,
      id: p.iface.id,
      label: `interface "${p.iface.id}"`,
      file: p.file,
      line: p.line,
      path: `interfaces[${p.index}]`,
      evidenceLines: p.evidenceLines,
      evidence: p.iface.evidence,
    })),
    ...positions.relations.map((p) => ({
      kind: 'relation' as const,
      id: p.relation.id,
      label: `relation "${p.relation.id}"`,
      file: p.file,
      line: p.line,
      path: `relations[${p.index}]`,
      evidenceLines: p.evidenceLines,
      evidence: p.relation.evidence,
    })),
    // A data entity needs no evidence of its own (evidence-complete asks it
    // of elements, interfaces and relations only), but every item it does
    // give is resolved and reported stale like any other (evidence-resolves,
    // staleness).
    ...positions.entities.map((p) => ({
      kind: 'entity' as const,
      id: p.entity.id,
      label: `data entity "${p.entity.id}"`,
      file: p.file,
      line: p.line,
      path: `entities[${p.index}]`,
      evidenceLines: p.evidenceLines,
      evidence: p.entity.evidence,
    })),
  ];
}

/**
 * The finding for one item of one declared entity: named by the entity, at
 * the item's own line, and carrying its full path from the model's top —
 * the item's own (`elements[3]`) or, for a finding about one of its
 * evidence items, that item's (`elements[3].evidence[0]`).
 */
function findingOf(declared: Declared, itemLine: number, message: string, path: string = declared.path): ModelCheckFinding {
  return { id: declared.id, file: declared.file, line: itemLine, path, message };
}

/**
 * The lines an item names must lie within its blob: undefined when they
 * do, the failing finding when they do not, naming the item and saying how
 * many lines the file has. An item without `line` names the whole file and
 * has no lines to bound (the loader refuses an `endLine` without a `line`).
 */
function linesFinding(repo: string, declared: Declared, item: Evidence, itemLine: number, itemPath: string): ModelCheckFinding | undefined {
  if (item.line === undefined) return undefined;
  const count = blobLineCount(repo, item.blob!);
  if (count === undefined) {
    return findingOf(declared, itemLine, `${declared.label} names blob ${item.blob}, which git could not read`, itemPath);
  }
  const last = item.endLine ?? item.line;
  if (item.line <= count && last <= count) return undefined;
  const named = item.endLine === undefined ? `line ${item.line}` : `lines ${item.line} to ${last}`;
  return findingOf(declared, itemLine, `${declared.label} names ${named}, but ${item.file} has ${count} lines`, itemPath);
}

/**
 * Resolves one evidence item that names a commit and a blob: the file must
 * have that blob at that commit and its lines must lie within it; when the
 * commit is not in the repository, the blob must appear at the path in the
 * checked revision's history, and the acceptance is reported as a note.
 */
function resolveItem(repo: string, revCommit: string, declared: Declared, item: Evidence, itemLine: number, itemPath: string): { errors: ModelCheckFinding[]; notes: ModelCheckFinding[] } {
  const failed = (message: string): { errors: ModelCheckFinding[]; notes: ModelCheckFinding[] } => ({ errors: [findingOf(declared, itemLine, message, itemPath)], notes: [] });

  if (!git(repo, ['cat-file', '-e', `${item.commit}^{commit}`]).ok) {
    const found = findBlobInHistory(repo, revCommit, item.file, item.blob!);
    if (found === undefined) {
      return failed(`${declared.label} names commit ${item.commit}, which is not in the repository, and its blob ${item.blob} is nowhere in the history for ${item.file}`);
    }
    const lines = linesFinding(repo, declared, item, itemLine, itemPath);
    if (lines !== undefined) return { errors: [lines], notes: [] };
    return { errors: [], notes: [findingOf(declared, itemLine, `commit missing, blob found at ${found}`, itemPath)] };
  }

  const atCommit = git(repo, ['rev-parse', '--verify', `${item.commit}:${item.file}`]);
  if (!atCommit.ok) return failed(`${declared.label} names ${item.file}, which does not exist at ${item.commit}`);
  // evidence-resolves says the item's *file* has the item's blob: the object
  // at the path must be a blob, not the tree of a folder the path names.
  const typeAtCommit = objectTypeAt(repo, item.commit!, item.file);
  if (typeAtCommit === 'tree') return failed(`${declared.label} names ${item.file}, which is a folder at ${item.commit}, not a file`);
  if (typeAtCommit === undefined) return failed(`${declared.label} names ${item.file}, which does not exist at ${item.commit}`);
  const actual = atCommit.stdout.trim();
  if (actual !== item.blob) {
    return failed(`${declared.label} names blob ${item.blob}, but ${item.file} has ${actual} at ${item.commit}`);
  }
  const lines = linesFinding(repo, declared, item, itemLine, itemPath);
  return lines === undefined ? { errors: [], notes: [] } : { errors: [lines], notes: [] };
}

/** One data row of a review report table, with the 1-based line it was written on. */
interface ReviewRow {
  cells: string[];
  line: number;
}

/** The cells of one table row: whitespace trimmed, `\|` read as a pipe. */
function cellsOf(row: string): string[] {
  return row.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.replaceAll('\\|', '|').trim());
}

/** A path cell may be written in backticks; the ticks are not part of the path. */
function unquoted(cell: string): string {
  return cell.length >= 2 && cell.startsWith('`') && cell.endsWith('`') ? cell.slice(1, -1) : cell;
}

/**
 * Reads the one pipe table a review report section holds: the header row,
 * the separator row, then the data rows, ending at the first line that is
 * not a row. The tables' shape is decided (the skill writes exactly this),
 * so a header or separator that differs from `columns`, and any row of
 * another width, is a finding naming the line at fault; only well-shaped
 * rows are kept.
 */
function tableUnder(lines: readonly string[], headingLine: number, heading: string, columns: readonly string[]): { rows: ReviewRow[] | undefined; findings: ModelCheckFinding[] } {
  const findings: ModelCheckFinding[] = [];
  const at = (line: number, message: string): ModelCheckFinding => ({ file: REVIEW, line, message });
  const isRow = (text: string): boolean => text.startsWith('|') && text.endsWith('|');
  let i = headingLine + 1;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i >= lines.length || !lines[i]!.trim().startsWith('|')) {
    findings.push(at(Math.min(i + 1, lines.length), `the "## ${heading}" section is not followed by a table`));
    return { rows: undefined, findings };
  }
  const header = isRow(lines[i]!.trim()) ? cellsOf(lines[i]!.trim()) : [];
  if (header.length !== columns.length || columns.some((column, index) => header[index] !== column)) {
    findings.push(at(i + 1, `the "## ${heading}" table's header is not "| ${columns.join(' | ')} |"`));
    return { rows: undefined, findings };
  }
  i++;
  const separator = i < lines.length && isRow(lines[i]!.trim()) ? cellsOf(lines[i]!.trim()) : [];
  if (separator.length !== columns.length || !separator.every((cell) => /^:?-+:?$/.test(cell))) {
    findings.push(at(Math.min(i + 1, lines.length), `the "## ${heading}" table has no separator row under its header`));
    return { rows: undefined, findings };
  }
  i++;
  const rows: ReviewRow[] = [];
  while (i < lines.length && lines[i]!.trim().startsWith('|')) {
    const text = lines[i]!.trim();
    const cells = isRow(text) ? cellsOf(text) : [];
    if (cells.length !== columns.length) {
      findings.push(at(i + 1, `the "## ${heading}" table has a row of ${cells.length} cells where its header has ${columns.length}`));
    } else {
      rows.push({ cells, line: i + 1 });
    }
    i++;
  }
  return { rows, findings };
}

/**
 * The review report's two sections: the claims table, whose documents are
 * compared with the checked revision like evidence (staleness, which never
 * fails), and the assignment table, which must give every tracked file a
 * row (unassigned files, unknown elements, reasonless exclusions and
 * duplicate rows fail the check). A missing claims section is a note: a
 * repository may have no documents.
 */
function reviewFindings(review: string, repo: string, revCommit: string, blobsAtRev: ReadonlyMap<string, string>, elementIds: ReadonlySet<string>): { errors: ModelCheckFinding[]; stale: ModelCheckFinding[]; notes: ModelCheckFinding[]; assignment: { path: string; element: string }[] } {
  const errors: ModelCheckFinding[] = [];
  const stale: ModelCheckFinding[] = [];
  const notes: ModelCheckFinding[] = [];
  // The assignment rows the report holds, kept for the hidden-coupling
  // problem: which path belongs to which element (or is excluded).
  const assignment: { path: string; element: string }[] = [];
  const at = (line: number, message: string): ModelCheckFinding => ({ file: REVIEW, line, message });
  const lines = review.split('\n');
  const headingOf = (name: string): number => lines.findIndex((line) => line.trim() === `## ${name}`);

  const claimsLine = headingOf('Claims');
  if (claimsLine === -1) {
    notes.push(at(0, 'the review report has no "## Claims" section; a repository with no documents needs none'));
  } else {
    const { rows, findings } = tableUnder(lines, claimsLine, 'Claims', CLAIMS_COLUMNS);
    errors.push(...findings);
    for (const row of rows ?? []) {
      const claim = row.cells[0]!;
      const document = unquoted(row.cells[1]!);
      const namedLines = row.cells[2]!;
      const commit = row.cells[3]!;
      const blob = row.cells[4]!;
      const verdict = row.cells[6]!;
      let usable = true;
      const refuse = (message: string): void => {
        errors.push(at(row.line, message));
        usable = false;
      };
      if (document === '') refuse('the claim row does not name a Document');
      if (commit === '') refuse('the claim row does not name a Commit');
      else if (!HEX40.test(commit)) refuse(`the claim row names a commit "${commit}", which is not a 40-hex-digit object id`);
      if (blob === '') refuse('the claim row does not name a Blob');
      else if (!HEX40.test(blob)) refuse(`the claim row names a blob "${blob}", which is not a 40-hex-digit object id`);
      if (!VERDICTS.includes(verdict)) refuse(`the claim row names a verdict "${verdict}", which is none of confirmed, contradicted, stale, planned, unconfirmed`);
      if (namedLines !== '' && !/^\d+(?:-\d+)?$/.test(namedLines)) refuse(`the claim row names lines "${namedLines}", which is neither a line number nor a "from-to" range`);
      if (!usable) continue;
      const atRev = blobsAtRev.get(document);
      if (atRev === undefined) {
        const gone = objectTypeAt(repo, revCommit, document) === 'tree'
          ? `the claim "${claim}" is stale: ${document} is a folder at the checked revision, not a file; the row names blob ${blob}`
          : `the claim "${claim}" is stale, file gone: ${document} does not exist at the checked revision; the row names blob ${blob}`;
        stale.push(at(row.line, gone));
      } else if (atRev !== blob) {
        stale.push(at(row.line, `the claim "${claim}" is stale: ${document} has ${atRev} at the checked revision, not ${blob}`));
      }
    }
  }

  const assignmentLine = headingOf('Assignment');
  if (assignmentLine === -1) {
    errors.push(at(0, 'the review report has no "## Assignment" section; every tracked file must be under a row of it'));
  } else {
    const { rows, findings } = tableUnder(lines, assignmentLine, 'Assignment', ASSIGNMENT_COLUMNS);
    errors.push(...findings);
    const seen = new Map<string, number>();
    for (const row of rows ?? []) {
      const path = unquoted(row.cells[0]!);
      const element = row.cells[1]!;
      const reason = row.cells[2]!;
      if (path === '') {
        errors.push(at(row.line, 'the assignment row does not name a path'));
        continue;
      }
      const first = seen.get(path);
      if (first !== undefined) {
        errors.push(at(row.line, `duplicate assignment row for ${path}; line ${first} already covers it`));
        continue;
      }
      seen.set(path, row.line);
      // A row whose element is wrong, or whose exclusion gives no reason,
      // still covers its path: its own problem is the finding.
      if (element === 'excluded') {
        if (reason === '') errors.push(at(row.line, `the excluded row for ${path} gives no reason`));
      } else if (!elementIds.has(element)) {
        errors.push(at(row.line, `the assignment row for ${path} names element "${element}", which the model does not have`));
      }
      assignment.push({ path, element });
    }
    // A folder row covers everything under it, a file row that file; the
    // deepest row covering a file decides it. Files no row covers are
    // reported once per folder, in the order `git ls-tree` lists them —
    // byte order, which for UTF-8 paths is code-point order.
    const deepestFirst = [...assignment].sort((a, b) => b.path.length - a.path.length);
    const unassigned = new Map<string, string[]>();
    for (const path of blobsAtRev.keys()) {
      const cover = deepestFirst.find((row) => (row.path.endsWith('/') ? path.startsWith(row.path) : path === row.path));
      if (cover !== undefined) continue;
      const folder = dirname(path);
      const files = unassigned.get(folder) ?? [];
      files.push(path);
      unassigned.set(folder, files);
    }
    for (const [folder, files] of unassigned) {
      errors.push({ file: folder, line: 0, message: `no assignment row covers ${files.join(', ')}` });
    }
  }
  return { errors, stale, notes, assignment };
}

/** The checked revision's committer date, in epoch milliseconds. */
function committedTime(repo: string, revCommit: string): number | undefined {
  const run = git(repo, ['show', '-s', '--format=%ct', revCommit]);
  if (!run.ok) return undefined;
  const seconds = Number(run.stdout.trim());
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * The time the available history of a shallow clone reaches back to: the
 * newest committer time among the shallow commits — the ones the file
 * `git rev-parse --git-path shallow` lists — that are still reachable
 * from the checked revision. A genuine root merged into the history is
 * no shallow commit, so it cannot hide the real boundary. Undefined
 * when git cannot say.
 */
function shallowBoundaryTime(repo: string, revCommit: string): number | undefined {
  const shallowPath = git(repo, ['rev-parse', '--git-path', 'shallow']);
  if (!shallowPath.ok) return undefined;
  let listed: string;
  try {
    listed = readFileSync(resolve(repo, shallowPath.stdout.trim()), 'utf8');
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  for (const line of listed.split('\n')) {
    const hash = line.trim();
    if (!/^[0-9a-f]+$/.test(hash)) continue;
    if (!git(repo, ['merge-base', '--is-ancestor', hash, revCommit]).ok) continue;
    const committedAt = committedTime(repo, hash);
    if (committedAt !== undefined && (newest === undefined || committedAt > newest)) newest = committedAt;
  }
  return newest;
}

/**
 * The non-merge commits the hidden-coupling window keeps, newest first:
 * those whose committer date lies within the window before the checked
 * revision's, skipping the bulk changes that carry no signal about single
 * elements. Each carries the distinct model elements its files belong to
 * under the review's assignment table.
 */
function touchedCommits(repo: string, revCommit: string, committedAt: number, fileElement: (file: string) => string | undefined, elementIds: ReadonlySet<string>): TouchedCommit[] | undefined {
  const run = git(repo, ['log', '--no-merges', '--format=%x01%H%x09%ct', '--name-only', '-z', revCommit]);
  if (!run.ok) return undefined;
  const windowMs = HIDDEN_COUPLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const commits: TouchedCommit[] = [];
  // One record per commit: `<SOH>hash<TAB>time` then the NUL-separated
  // files (the first preceded by a newline), the record itself NUL-ended.
  for (const chunk of run.stdout.split('\x01')) {
    if (chunk === '') continue;
    const pieces = chunk.split('\0');
    const meta = pieces[0] ?? '';
    const tab = meta.indexOf('\t');
    if (tab === -1) continue;
    const at = Number(meta.slice(tab + 1)) * 1000;
    const age = committedAt - at;
    if (!Number.isFinite(at) || age < 0 || age > windowMs) continue;
    const files = pieces
      .slice(1)
      .filter((piece) => piece !== '')
      .map((piece, index) => (index === 0 && piece.startsWith('\n') ? piece.slice(1) : piece));
    if (files.length > BULK_COMMIT_FILES) continue;
    const elements = new Set<string>();
    for (const file of files) {
      const element = fileElement(file);
      if (element !== undefined && elementIds.has(element)) elements.add(element);
    }
    commits.push({ hash: meta.slice(0, tab), elements: sortedByCodePoint([...elements]) });
  }
  return commits;
}

/**
 * Every problem the compiled model and its history hold: the six kinds of
 * `model-problems.ts`, the level ones read off the view set the views are
 * drawn from. When a part could not be computed (the revision's time or
 * the history unreadable, the model unstorable, the view set unbuildable)
 * the rest is still reported and a note says what was skipped.
 */
function problemFindings(repo: string, revCommit: string, model: CompiledModel, assignment: readonly { path: string; element: string }[], elementIds: ReadonlySet<string>, notes: ModelCheckFinding[]): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  findings.push(...magicSourceOrSinkProblems(model), ...trustBoundaryProblems(model));

  const committedAt = committedTime(repo, revCommit);
  if (committedAt === undefined) {
    notes.push({ file: repo, line: 0, message: `the checked revision ${revCommit} has no readable commit time; the problems that read the levels or the history were skipped` });
    return findings;
  }
  const prepared = prepareModel(model, { source: 'model-check', commit: revCommit, at: committedAt });
  try {
    if (prepared.errors.length > 0) {
      notes.push({ file: repo, line: 0, message: `${prepared.errors[0]}; the problems that read the levels were skipped` });
    } else {
      const viewSet = buildViewSet(prepared.engine, model, prepared.at);
      if (viewSet.views === undefined) {
        notes.push({ file: repo, line: 0, message: `the view set could not be built: ${viewSet.errors[0]?.message ?? 'no error named'}; the problems that read the levels were skipped` });
      } else {
        const levels = levelsOf(viewSet.views);
        findings.push(...cycleProblems(levels), ...unstableDependencyProblems(levels), ...hubProblems(levels));
      }
    }
  } finally {
    prepared.close();
  }

  // A file belongs to the element of the deepest assignment row covering
  // it; an excluded file belongs to no element.
  const deepestFirst = [...assignment].sort((a, b) => b.path.length - a.path.length);
  const fileElement = (file: string): string | undefined => {
    const row = deepestFirst.find((candidate) => (candidate.path.endsWith('/') ? file.startsWith(candidate.path) : file === candidate.path));
    return row === undefined || row.element === 'excluded' ? undefined : row.element;
  };
  const commits = touchedCommits(repo, revCommit, committedAt, fileElement, elementIds);
  if (commits === undefined) {
    notes.push({ file: repo, line: 0, message: 'the commit history could not be read; hidden coupling was skipped' });
    return findings;
  }
  // A shallow clone holds less history than the window asks for: say so,
  // with the date the available history reaches back to, never quietly
  // over less.
  const shallow = git(repo, ['rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.stdout.trim() === 'true') {
    const boundary = shallowBoundaryTime(repo, revCommit);
    if (boundary !== undefined && committedAt - boundary < HIDDEN_COUPLING_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      notes.push({ file: repo, line: 0, message: `the repository is a shallow clone: the history reaches back only to ${new Date(boundary).toISOString()}; hidden coupling was computed over the available history only` });
    }
  }
  findings.push(...hiddenCouplingProblems(model, commits));
  return findings;
}

/**
 * The views requirement (views-rendered): renders the model the check
 * already compiled — the same render the reference script's
 * load-compile-render ends in, at the checked revision's commit time,
 * never the clock, so the pages change only with the model — and writes
 * it into the folder the caller named. A rendering or a write that fails
 * is an error of the report, naming the folder and the cause: the views
 * were asked for, so their absence fails the check. The folder stays the
 * only place the check writes.
 */
function writeViewFolder(repo: string, revCommit: string, model: CompiledModel, folder: string, errors: ModelCheckFinding[], notes: ModelCheckFinding[]): void {
  const committedAt = committedTime(repo, revCommit);
  if (committedAt === undefined) {
    errors.push({ file: repo, line: 0, message: `the views for ${folder} were not rendered: the checked revision ${revCommit} has no readable commit time` });
    return;
  }
  try {
    const rendered = renderModel(model, { source: 'model-check', commit: revCommit, at: committedAt });
    if (rendered.pages === undefined || rendered.workspace === undefined) {
      errors.push({ file: repo, line: 0, message: `the views for ${folder} could not be rendered: ${rendered.errors[0] ?? 'no error named'}` });
      return;
    }
    let written: WrittenViews;
    try {
      written = writeViews(folder, rendered.pages, rendered.workspace);
    } catch (error) {
      errors.push({ file: repo, line: 0, message: `the views could not be written into ${folder}: ${(error as Error).message}` });
      return;
    }
    notes.push({ file: repo, line: 0, message: `wrote ${written.pageCount} view pages into ${written.mermaidFolder} and the LikeC4 workspace ${written.likec4File}` });
  } catch (error) {
    // A renderer that throws, rather than reporting its errors, fails the
    // views the same way: an error of the report, never an uncaught one.
    errors.push({ file: repo, line: 0, message: `the views for ${folder} could not be rendered: ${(error as Error).message}` });
  }
}

export function checkModel(repoPath: string, options: ModelCheckOptions = {}): ModelCheckReport {
  const repo = resolve(repoPath);
  const rev = options.rev ?? 'HEAD';
  const unreadable = (message: string): ModelCheckReport => ({
    outcome: 'unreadable',
    errors: [{ file: repo, line: 0, message }],
    stale: [],
    problems: [],
    warnings: [],
    notes: [],
  });

  if (!git(repo, ['rev-parse', '--git-dir']).ok) return unreadable(`${repo} is not a git repository`);
  if (!isDirectory(join(repo, 'madarch'))) return unreadable(`${repo} has no madarch folder`);
  // No model files is no model to read: unreadable, not a failed check.
  // A folder named *.yaml is not a model file: only regular files count.
  let modelYaml: string[];
  try {
    modelYaml = readdirSync(join(repo, 'madarch')).filter((name) => {
      if (!name.endsWith('.yaml')) return false;
      try {
        return statSync(join(repo, 'madarch', name)).isFile();
      } catch {
        return false;
      }
    });
  } catch (error) {
    return unreadable(`${join(repo, 'madarch')} could not be read: ${(error as Error).message}`);
  }
  if (modelYaml.length === 0) return unreadable(`${join(repo, 'madarch')} holds no *.yaml file: a model needs at least one`);
  const checkedRev = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
  if (!checkedRev.ok) return unreadable(`unknown revision "${rev}"`);
  const revCommit = checkedRev.stdout.trim();
  const blobs = trackedAt(repo, revCommit);
  if (blobs === undefined) return unreadable(`the files ${rev} tracks could not be listed`);

  const { model, errors, warnings, positions } = loadAndCompileModel(repo);
  const report: ModelCheckReport = {
    outcome: 'failed',
    // The loader's own errors and warnings carry the item's full path from
    // the model's top (`elements[2].owner`); the report keeps it, so the
    // JSON carries the same fields the loader reports, and leaves it out
    // only where the loader has none (a whole-file problem).
    errors: errors.map((e) => ({ file: e.file, line: e.line, ...(e.path === '' ? {} : { path: e.path }), message: e.message })),
    stale: [],
    problems: [],
    warnings: warnings.map((w) => ({ file: w.file, line: w.line, ...(w.path === '' ? {} : { path: w.path }), message: w.message })),
    notes: [],
  };
  // A model that does not compile is reported on its own: everything else
  // the check could say needs a compiled model first.
  if (model === undefined) {
    report.errors.sort(byFileLineId);
    return report;
  }

  // `loadAndCompileModel` returns the positions exactly when it returns a model.
  for (const declared of declaredItems(positions!)) {
    if (declared.evidence === undefined || declared.evidence.length === 0) {
      // Naming no evidence is no failure on a data entity: only elements,
      // interfaces and relations are asked for evidence (evidence-complete).
      if (declared.kind !== 'entity') {
        report.errors.push(findingOf(declared, declared.line, `${declared.label} has no evidence`));
      }
      continue;
    }
    for (const [index, item] of declared.evidence.entries()) {
      const itemLine = declared.evidenceLines[index] ?? declared.line;
      const itemPath = `${declared.path}.evidence[${index}]`;
      if (item.commit === undefined || item.blob === undefined) {
        report.errors.push(findingOf(declared, itemLine, `${declared.label} has an evidence item without a commit and a blob`, itemPath));
        continue;
      }
      const resolved = resolveItem(repo, revCommit, declared, item, itemLine, itemPath);
      report.errors.push(...resolved.errors);
      report.notes.push(...resolved.notes);
      // Staleness never fails the check: the file at the checked revision
      // simply no longer reads as the item says it did.
      const atRev = blobs.get(item.file);
      if (atRev === undefined) {
        const gone = objectTypeAt(repo, revCommit, item.file) === 'tree'
          ? `${declared.label} is stale: ${item.file} is a folder at the checked revision, not a file; the item names blob ${item.blob}`
          : `${declared.label} is stale, file gone: ${item.file} does not exist at the checked revision; the item names blob ${item.blob}`;
        report.stale.push(findingOf(declared, itemLine, gone, itemPath));
      } else if (atRev !== item.blob) {
        report.stale.push(findingOf(declared, itemLine, `${declared.label} is stale: ${item.file} has ${atRev} at the checked revision, not the item's blob ${item.blob}`, itemPath));
      }
    }
  }

  // Every requirement a scenario names must resolve against the checked
  // revision's capability specs (requirements-resolve): a missing spec or
  // heading fails the check naming the scenario, the requirement, where it
  // is named and which of the two is missing.
  report.errors.push(...requirementFindings(repo, revCommit, positions!.scenarios));

  // The review report: its claims are compared with the checked revision
  // like evidence; its assignment table must cover every tracked file.
  const elementIds = new Set(positions!.elements.map((p) => p.element.id));
  let review: { errors: ModelCheckFinding[]; stale: ModelCheckFinding[]; notes: ModelCheckFinding[]; assignment: { path: string; element: string }[] };
  try {
    review = reviewFindings(readFileSync(join(repo, REVIEW), 'utf8'), repo, revCommit, blobs, elementIds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable(`${REVIEW} could not be read`);
    review = {
      errors: [{ file: REVIEW, line: 0, message: `the review report ${REVIEW} is missing; a model without its review is incomplete` }],
      stale: [],
      notes: [],
      assignment: [],
    };
  }
  report.errors.push(...review.errors);
  report.stale.push(...review.stale);
  report.notes.push(...review.notes);

  // Problems never fail the check: they are computed from the compiled
  // model and the history whenever both could be read.
  report.problems = problemFindings(repo, revCommit, model!, review.assignment, elementIds, report.notes).sort(compareProblems);

  // The views, when the caller asked for them: the model compiled, so
  // every view of it is rendered and written into the folder they named.
  if (options.views !== undefined) writeViewFolder(repo, revCommit, model!, options.views, report.errors, report.notes);

  // Warnings arrive ordered from the loader (file order, then the order
  // written); errors, stale items and notes are sorted here whatever order
  // the walk above found them in.
  report.errors.sort(byFileLineId);
  report.stale.sort(byFileLineId);
  report.notes.sort(byFileLineId);
  return { ...report, outcome: report.errors.length > 0 ? 'failed' : 'passed' };
}
