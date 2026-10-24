/**
 * Where a planned change shows (madarch-m38l.14; the owner, 2026-10-23: "у всех
 * документов и кода которого это касается это должны быть видно, что
 * планируются изменения"). Only the scope a person confirmed is marked, and
 * only what the graph says that scope reaches:
 *
 * - the document sections the task's scope names;
 * - the code or document nodes its grounds name, so their pages say a change is
 *   planned;
 * - the statements that rely on those grounds («основание будет изменено»), and
 *   the statements its scope names itself.
 *
 * A page nobody's task touches is marked nothing. A task a commit has closed
 * marks nothing: its change already happened.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { closingCommit, type RepositoryRef } from './closure.js';
import { impactOf, pathOfGround, type ImpactedStatement } from './impact.js';
import { readTasks, scopePath, type PlannedTask, type TaskScope } from './tasks.js';

/** The task a mark points at: enough for the badge to name it and to link to it. */
export interface PlannedTaskRef {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly file: string;
}

/** A document section or line range with a planned change. */
export interface PlannedSection {
  readonly repo: string | null;
  readonly path: string;
  readonly anchor: string | null;
  readonly lines: { readonly start: number; readonly end: number } | null;
  readonly task: PlannedTaskRef;
  readonly how: 'scope' | 'impact';
}

/** A statement that stands on a planned change, or that the task's scope names. */
export interface PlannedStatement {
  readonly page: string;
  readonly statement: string;
  readonly task: PlannedTaskRef;
  readonly how: 'scope' | 'impact';
}

/** A code or document node a planned change touches: its page says so. */
export interface PlannedEntity {
  readonly id: string;
  readonly task: PlannedTaskRef;
  readonly how: 'scope' | 'impact';
}

export interface PlannedMarks {
  readonly sections: readonly PlannedSection[];
  readonly statements: readonly PlannedStatement[];
  readonly entities: readonly PlannedEntity[];
  /** The tasks that are open now, in id order. */
  readonly tasks: readonly PlannedTaskRef[];
  /** Why a part of the marks could not be read (a task file, an impact): said, never dropped. */
  readonly notes: readonly string[];
}

export const NO_MARKS: PlannedMarks = { sections: [], statements: [], entities: [], tasks: [], notes: [] };

const refOf = (task: PlannedTask): PlannedTaskRef => ({ id: task.id, slug: task.slug, title: task.title, file: task.file });

/**
 * The marks of a product's open tasks. `repositories` are read to see which
 * tasks a commit has closed; `productFiles` are the product's own documents,
 * which belong to no code repository.
 */
export async function plannedMarks(input: { readonly owner: DatabaseOwner; readonly productFolder: string; readonly repositories: readonly RepositoryRef[]; readonly productFiles: readonly string[]; readonly pageFiles: ReadonlyMap<string, string> }): Promise<PlannedMarks> {
  const read = readTasks(input.productFolder);
  const notes: string[] = read.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`);
  const repositoriesOf = (path: string): string | null => (input.productFiles.includes(path) ? null : input.repositories.length === 1 ? input.repositories[0]!.name : null);
  const sections = new Map<string, PlannedSection>();
  const statements = new Map<string, PlannedStatement>();
  const entities = new Map<string, PlannedEntity>();
  const tasks: PlannedTaskRef[] = [];
  for (const task of read.tasks) {
    if (task.status === 'closed') continue;
    try {
      if (closingCommit(task, input.repositories, { pageFiles: input.pageFiles }) !== undefined) continue;
    } catch (error) {
      notes.push((error as Error).message);
      continue;
    }
    tasks.push(refOf(task));
    const how = 'scope' as const;
    for (const scope of task.scope) {
      const path = scopePath(scope);
      if (path !== undefined) {
        if (scope.type === 'section') sections.set(`${scope.path}#${scope.anchor}`, { repo: repositoriesOf(scope.path), path: scope.path, anchor: scope.anchor.toLowerCase(), lines: null, task: refOf(task), how });
        else if (scope.type === 'lines') sections.set(`${scope.path}:${scope.start}-${scope.end}`, { repo: repositoriesOf(scope.path), path: scope.path, anchor: null, lines: { start: scope.start, end: scope.end }, task: refOf(task), how });
        else if (scope.type === 'file') sections.set(`${scope.path}`, { repo: repositoriesOf(scope.path), path: scope.path, anchor: null, lines: null, task: refOf(task), how });
      }
      if (scope.type === 'symbol') entities.set(scope.key, { id: scope.key, task: refOf(task), how });
      if (scope.type === 'statement') {
        const page = scope.key.slice(0, scope.key.indexOf('#'));
        statements.set(scope.key, { page, statement: scope.key.slice(scope.key.indexOf('#') + 1), task: refOf(task), how });
      }
      // A place the scope names is also an entity of the graph: its page says a change is planned.
      for (const key of groundsOfScope(scope)) entities.set(key, { id: key, task: refOf(task), how });
    }
    // What the task's own scope reaches through the graph: a section the reader removed marks nothing, and one added marks what it reaches.
    const impact = await impactOf(input.owner, input.productFolder, impactGroundsOf(task));
    for (const statement of impact.statements) markStatement(statements, statement, refOf(task));
    for (const key of impact.entities) if (!entities.has(key)) entities.set(key, { id: key, task: refOf(task), how });
    for (const page of impact.pages) if (!entities.has(page.id)) entities.set(page.id, { id: page.id, task: refOf(task), how: 'impact' });
  }
  return {
    sections: [...sections.values()].sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.anchor ?? '', b.anchor ?? '') || (a.lines?.start ?? 0) - (b.lines?.start ?? 0)),
    statements: [...statements.values()].sort((a, b) => byCodePoint(a.page, b.page) || byCodePoint(a.statement, b.statement)),
    entities: [...entities.values()].sort((a, b) => byCodePoint(a.id, b.id)),
    tasks: tasks.sort((a, b) => byCodePoint(a.id, b.id)),
    notes,
  };
}

function markStatement(marks: Map<string, PlannedStatement>, statement: ImpactedStatement, task: PlannedTaskRef): void {
  // Only a statement that stands on the ground has a basis that will change; one that merely names it is not marked.
  if (statement.how !== 'grounds') return;
  const key = `${statement.page}#${statement.statement}`;
  const held = marks.get(key);
  // A statement the task's own scope names stays worded as the scope's; the graph's ground mark never overrides it.
  if (held !== undefined && held.how === 'scope') return;
  marks.set(key, { page: statement.page, statement: statement.statement, task, how: 'impact' });
}

/**
 * The grounds a task's impact is computed from: the places its scope names, and its own grounds when they name no place.
 * A person edits the scope before confirming, and the impact follows it, not the answer it came from.
 */
export function impactGroundsOf(task: PlannedTask): string[] {
  const keys = new Set<string>();
  for (const scope of task.scope) for (const key of groundsOfScope(scope)) keys.add(key);
  return keys.size === 0 ? [...task.grounds] : [...keys].sort(byCodePoint);
}

/** The graph keys a scope names, as the entity page of each is addressed. */
export function groundsOfScope(scope: TaskScope): string[] {
  switch (scope.type) {
    case 'section': return [`doc:${scope.path}#${scope.anchor}`];
    // A document's path is a document's key; a code path is a file of the graph, never a document.
    case 'file': return [scope.path.endsWith('.md') ? `doc:${scope.path}` : `code.file:${scope.path}`];
    case 'symbol': return [scope.key.startsWith('code.symbol:') ? scope.key : `code.symbol:${scope.key}`];
    case 'lines': return [`code.file:${scope.path}`];
    case 'statement': return [];
  }
}

/** The section marks of one document: what its headings carry. */
export function marksForDocument(marks: PlannedMarks, repo: string | null, path: string): { anchor: string | null; lines: { start: number; end: number } | null; task: PlannedTaskRef; how: 'scope' | 'impact' }[] {
  return marks.sections.filter((section) => section.path === path && (section.repo === null || section.repo === repo)).map((section) => ({ anchor: section.anchor, lines: section.lines, task: section.task, how: section.how }));
}

/** The statement marks of one page, by the statement's name on it. */
export function marksForPage(marks: PlannedMarks, page: string): Map<string, { task: PlannedTaskRef; how: 'scope' | 'impact' }> {
  const found = new Map<string, { task: PlannedTaskRef; how: 'scope' | 'impact' }>();
  for (const statement of marks.statements) if (statement.page === page) found.set(statement.statement, { task: statement.task, how: statement.how });
  return found;
}

/** The mark of one entity's page, when a planned change touches it. */
export function markForEntity(marks: PlannedMarks, id: string): PlannedEntity | undefined {
  return marks.entities.find((entity) => entity.id === id);
}

/** Whether a ground names a place at all: used where a caller wants the paths of a set of grounds. */
export const pathsOf = (grounds: readonly string[]): string[] => [...new Set(grounds.map(pathOfGround).filter((path): path is string => path !== undefined))].sort(byCodePoint);
