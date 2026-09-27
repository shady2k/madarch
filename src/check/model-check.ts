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
 * compiled model. Later requirements grow the report by sections:
 * staleness, assignment, problems and views.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
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

export function checkModel(repoPath: string, options: ModelCheckOptions = {}): ModelCheckReport {
  const repo = resolve(repoPath);
  const rev = options.rev ?? 'HEAD';
  const unreadable = (message: string): ModelCheckReport => ({
    outcome: 'unreadable',
    errors: [{ file: repo, line: 0, message }],
    warnings: [],
    notes: [],
  });

  if (!git(repo, ['rev-parse', '--git-dir']).ok) return unreadable(`${repo} is not a git repository`);
  if (!isDirectory(join(repo, 'madarch'))) return unreadable(`${repo} has no madarch folder`);
  const checkedRev = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`]);
  if (!checkedRev.ok) return unreadable(`unknown revision "${rev}"`);
  const revCommit = checkedRev.stdout.trim();

  const { model, errors, warnings, positions } = loadAndCompileModel(repo);
  const report: ModelCheckReport = {
    outcome: 'failed',
    errors: errors.map((e) => ({ file: e.file, line: e.line, message: e.message })),
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
    }
  }

  // Warnings arrive ordered from the loader (file order, then the order
  // written); errors and notes are sorted here whatever order the walk
  // above found them in.
  report.errors.sort(byFileLineId);
  report.notes.sort(byFileLineId);
  return { ...report, outcome: report.errors.length > 0 ? 'failed' : 'passed' };
}
