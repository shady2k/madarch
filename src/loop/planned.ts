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
import { type RepositoryRef } from './closure.js';
import { type TaskScope } from './tasks.js';
import type { ProductFileSource } from '../plugin/product-files.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

/** The task a mark points at: enough for the badge to name it and to link to it. */
export interface PlannedTaskRef {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly file: string;
}

/** A document section or line range with a planned change. */
interface PlannedSection {
  readonly repo: string | null;
  readonly path: string;
  readonly anchor: string | null;
  readonly lines: { readonly start: number; readonly end: number } | null;
  readonly task: PlannedTaskRef;
  readonly how: 'scope' | 'impact';
}

/** A statement that stands on a planned change, or that the task's scope names. */
interface PlannedStatement {
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

export async function plannedMarks(_input: { readonly owner: DatabaseOwner; readonly productFolder: string; readonly files: ProductFileSource; readonly manifest: KindsManifest; readonly repositories: readonly RepositoryRef[]; readonly productFiles: readonly string[]; readonly pageFiles: ReadonlyMap<string, string> }): Promise<PlannedMarks> {
  return { ...NO_MARKS, notes: ['Markdown planned-change tracking is retired; authored entities are stored in the database'] };
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
