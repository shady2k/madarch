/**
 * What the wiki asks of the Markdown index: the statements grounded on a graph
 * node or a document section, the pages and statements per page kind, and the
 * grounds whose content changed. The one graph holds no index producer yet —
 * no stage writes the statements of a page — so every answer is empty and says
 * so by being empty, never by reading a second graph.
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
type DigestMethod = 'section' | 'span' | 'object' | 'none';

export type GroundStatus = 'changed' | 'unchanged' | 'removed' | 'unknown';

export interface GroundChange {
  readonly page: string;
  readonly statement: string;
  readonly text: string;
  readonly line: number;
  readonly ground: string;
  readonly status: GroundStatus;
  readonly method: DigestMethod;
  readonly writtenCommit: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly reason?: string;
}

export interface NowState {
  readonly commit: string;
}

/** The grounds that changed: no stage writes a statement, so there is no ground to compare. */
export async function changedGrounds(_owner: DatabaseOwner, _now: NowState, _options: { page?: string } = {}): Promise<GroundChange[]> {
  return [];
}
