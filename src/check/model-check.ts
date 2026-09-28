/**
 * The model check (docs/changes/agent-model/capabilities/model-check.md):
 * reads a repository's intended model and the repository it describes, and
 * reports what is wrong — never writes either. The check's command is
 * `bun scripts/check-model.ts <repository path> [--rev <git revision>]
 * [--json]`; this module holds the check itself so the script only parses
 * arguments, prints and exits, and the tests call it directly.
 *
 * Git is read through the `git` binary, read-only. A missing input (the
 * path is not a git repository, there is no `madarch/` folder, the
 * revision does not name a commit) is `unreadable`, exit 2. A model that
 * does not compile fails the check and nothing else is computed from a
 * compiled model. The report grows by sections as the requirements land:
 * staleness and assignment read the review report (this module); problems
 * and views come later.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path/posix';
import { join, resolve } from 'node:path';
import { loadAndCompileModel } from '../model/load-and-compile.js';
import { byCodePoint } from '../model/order.js';
import type { Evidence } from '../model/schema.js';
import type { PositionedModel } from '../model/validate.js';

export interface ModelCheckFinding {
  /** The model id (element, interface or relation) the finding names, when it has one. */
  id?: string;
  /** The model file that declares the item, or the repository path for a finding about the inputs themselves. */
  file: string;
  /** The 1-based line the item is declared on; 0 for a whole-path finding. */
  line: number;
  message: string;
}

export interface ModelCheckReport {
  /** `unreadable` exits 2, `failed` exits 1, `passed` exits 0. */
  outcome: 'passed' | 'failed' | 'unreadable';
  /** Every finding that fails the check. */
  errors: ModelCheckFinding[];
  /** Evidence items and document claims whose file no longer reads as it did; reported, never failing. */
  stale: ModelCheckFinding[];
  /** Problems that do not fail the check, reported with the model. */
  warnings: ModelCheckFinding[];
  /** Facts worth reading beside the report, such as where a missing commit's blob was found. */
  notes: ModelCheckFinding[];
}

export interface ModelCheckOptions {
  /** The revision the repository is checked at; the default is `HEAD`. */
  rev?: string;
}

/** An element, interface or relation of the model, named as the loader positions it. */
interface Declared {
  kind: 'element' | 'interface' | 'relation';
  id: string;
  /** What the finding names it by: `element "core"`, `relation "ui-calls-core"`. */
  label: string;
  file: string;
  line: number;
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
const CLAIMS_COLUMNS = ['Claim', 'Document', 'Line', 'Commit', 'Blob', 'Checked in code', 'Verdict', 'In the model'];
const ASSIGNMENT_COLUMNS = ['Path', 'Element', 'Reason'];
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

/** The number of lines a blob holds, counting a last line without its newline. */
function blobLineCount(repo: string, blob: string): number | undefined {
  const run = git(repo, ['cat-file', 'blob', blob]);
  if (!run.ok) return undefined;
  const text = run.stdout;
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
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
      const fields = (line.split('\t')[0] ?? '').split(' ');
      if (fields[2] === blob || fields[3] === blob) return current;
    }
  }
  return undefined;
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
      evidenceLines: p.evidenceLines,
      evidence: p.element.evidence,
    })),
    ...positions.interfaces.map((p) => ({
      kind: 'interface' as const,
      id: p.iface.id,
      label: `interface "${p.iface.id}"`,
      file: p.file,
      line: p.line,
      evidenceLines: p.evidenceLines,
      evidence: p.iface.evidence,
    })),
    ...positions.relations.map((p) => ({
      kind: 'relation' as const,
      id: p.relation.id,
      label: `relation "${p.relation.id}"`,
      file: p.file,
      line: p.line,
      evidenceLines: p.evidenceLines,
      evidence: p.relation.evidence,
    })),
  ];
}

/** The finding for one item of one declared entity: named by the entity, at the item's own line. */
function findingOf(declared: Declared, itemLine: number, message: string): ModelCheckFinding {
  return { id: declared.id, file: declared.file, line: itemLine, message };
}

/**
 * The lines an item names must lie within its blob: undefined when they
 * do, the failing finding when they do not, naming the item and saying how
 * many lines the file has. An item without `line` names the whole file and
 * has no lines to bound (the loader refuses an `endLine` without a `line`).
 */
function linesFinding(repo: string, declared: Declared, item: Evidence, itemLine: number): ModelCheckFinding | undefined {
  if (item.line === undefined) return undefined;
  const count = blobLineCount(repo, item.blob!);
  if (count === undefined) {
    return findingOf(declared, itemLine, `${declared.label} names blob ${item.blob}, which git could not read`);
  }
  const last = item.endLine ?? item.line;
  if (item.line <= count && last <= count) return undefined;
  const named = item.endLine === undefined ? `line ${item.line}` : `lines ${item.line} to ${last}`;
  return findingOf(declared, itemLine, `${declared.label} names ${named}, but ${item.file} has ${count} lines`);
}

/**
 * Resolves one evidence item that names a commit and a blob: the file must
 * have that blob at that commit and its lines must lie within it; when the
 * commit is not in the repository, the blob must appear at the path in the
 * checked revision's history, and the acceptance is reported as a note.
 */
function resolveItem(repo: string, revCommit: string, declared: Declared, item: Evidence, itemLine: number): { errors: ModelCheckFinding[]; notes: ModelCheckFinding[] } {
  const failed = (message: string): { errors: ModelCheckFinding[]; notes: ModelCheckFinding[] } => ({ errors: [findingOf(declared, itemLine, message)], notes: [] });

  if (!git(repo, ['cat-file', '-e', `${item.commit}^{commit}`]).ok) {
    const found = findBlobInHistory(repo, revCommit, item.file, item.blob!);
    if (found === undefined) {
      return failed(`${declared.label} names commit ${item.commit}, which is not in the repository, and its blob ${item.blob} is nowhere in the history for ${item.file}`);
    }
    const lines = linesFinding(repo, declared, item, itemLine);
    if (lines !== undefined) return { errors: [lines], notes: [] };
    return { errors: [], notes: [findingOf(declared, itemLine, `commit missing, blob found at ${found}`)] };
  }

  const atCommit = git(repo, ['rev-parse', '--verify', `${item.commit}:${item.file}`]);
  if (!atCommit.ok) return failed(`${declared.label} names ${item.file}, which does not exist at ${item.commit}`);
  const actual = atCommit.stdout.trim();
  if (actual !== item.blob) {
    return failed(`${declared.label} names blob ${item.blob}, but ${item.file} has ${actual} at ${item.commit}`);
  }
  const lines = linesFinding(repo, declared, item, itemLine);
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
function reviewFindings(review: string, blobsAtRev: ReadonlyMap<string, string>, elementIds: ReadonlySet<string>): { errors: ModelCheckFinding[]; stale: ModelCheckFinding[]; notes: ModelCheckFinding[] } {
  const errors: ModelCheckFinding[] = [];
  const stale: ModelCheckFinding[] = [];
  const notes: ModelCheckFinding[] = [];
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
        stale.push(at(row.line, `the claim "${claim}" is stale, file gone: ${document} does not exist at the checked revision; the row names blob ${blob}`));
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
    const covering: string[] = [];
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
      covering.push(path);
    }
    // A folder row covers everything under it, a file row that file; the
    // deepest row covering a file decides it. Files no row covers are
    // reported once per folder, in the order `git ls-tree` lists them —
    // byte order, which for UTF-8 paths is code-point order.
    const deepestFirst = [...covering].sort((a, b) => b.length - a.length);
    const unassigned = new Map<string, string[]>();
    for (const path of blobsAtRev.keys()) {
      const cover = deepestFirst.find((rowPath) => (rowPath.endsWith('/') ? path.startsWith(rowPath) : path === rowPath));
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
  return { errors, stale, notes };
}

export function checkModel(repoPath: string, options: ModelCheckOptions = {}): ModelCheckReport {
  const repo = resolve(repoPath);
  const rev = options.rev ?? 'HEAD';
  const unreadable = (message: string): ModelCheckReport => ({
    outcome: 'unreadable',
    errors: [{ file: repo, line: 0, message }],
    stale: [],
    warnings: [],
    notes: [],
  });

  if (!git(repo, ['rev-parse', '--git-dir']).ok) return unreadable(`${repo} is not a git repository`);
  if (!isDirectory(join(repo, 'madarch'))) return unreadable(`${repo} has no madarch folder`);
  const checkedRev = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
  if (!checkedRev.ok) return unreadable(`unknown revision "${rev}"`);
  const revCommit = checkedRev.stdout.trim();
  const blobs = trackedAt(repo, revCommit);
  if (blobs === undefined) return unreadable(`the files ${rev} tracks could not be listed`);

  const { model, errors, warnings, positions } = loadAndCompileModel(repo);
  const report: ModelCheckReport = {
    outcome: 'failed',
    errors: errors.map((e) => ({ file: e.file, line: e.line, message: e.message })),
    stale: [],
    warnings: warnings.map((w) => ({ file: w.file, line: w.line, message: w.message })),
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
      report.errors.push(findingOf(declared, declared.line, `${declared.label} has no evidence`));
      continue;
    }
    for (const [index, item] of declared.evidence.entries()) {
      const itemLine = declared.evidenceLines[index] ?? declared.line;
      if (item.commit === undefined || item.blob === undefined) {
        report.errors.push(findingOf(declared, itemLine, `${declared.label} has an evidence item without a commit and a blob`));
        continue;
      }
      const resolved = resolveItem(repo, revCommit, declared, item, itemLine);
      report.errors.push(...resolved.errors);
      report.notes.push(...resolved.notes);
      // Staleness never fails the check: the file at the checked revision
      // simply no longer reads as the item says it did.
      const atRev = blobs.get(item.file);
      if (atRev === undefined) {
        report.stale.push(findingOf(declared, itemLine, `${declared.label} is stale, file gone: ${item.file} does not exist at the checked revision; the item names blob ${item.blob}`));
      } else if (atRev !== item.blob) {
        report.stale.push(findingOf(declared, itemLine, `${declared.label} is stale: ${item.file} has ${atRev} at the checked revision, not the item's blob ${item.blob}`));
      }
    }
  }

  // The review report: its claims are compared with the checked revision
  // like evidence; its assignment table must cover every tracked file.
  const elementIds = new Set(positions!.elements.map((p) => p.element.id));
  let review: { errors: ModelCheckFinding[]; stale: ModelCheckFinding[]; notes: ModelCheckFinding[] };
  try {
    review = reviewFindings(readFileSync(join(repo, REVIEW), 'utf8'), blobs, elementIds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unreadable(`${REVIEW} could not be read`);
    review = {
      errors: [{ file: REVIEW, line: 0, message: `the review report ${REVIEW} is missing; a model without its review is incomplete` }],
      stale: [],
      notes: [],
    };
  }
  report.errors.push(...review.errors);
  report.stale.push(...review.stale);
  report.notes.push(...review.notes);

  // Warnings arrive ordered from the loader (file order, then the order
  // written); errors, stale items and notes are sorted here whatever order
  // the walk above found them in.
  report.errors.sort(byFileLineId);
  report.stale.sort(byFileLineId);
  report.notes.sort(byFileLineId);
  return { ...report, outcome: report.errors.length > 0 ? 'failed' : 'passed' };
}
