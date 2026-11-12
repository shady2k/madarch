/**
 * What the wiki asks of the Markdown index: the statements grounded on a graph
 * node or a document section, the pages and statements per page kind, and the
 * grounds whose content changed. The one graph holds no index producer yet —
 * no stage writes the statements of a page — so every answer is empty and says
 * so by being empty, never by reading a second graph.
 */
import type { DatabaseOwner } from '../../adapters/database-owner.js';
type DigestMethod = 'section' | 'span' | 'object' | 'none';

export interface RelyingStatement {
  readonly page: string;
  readonly pageTitle: string;
  readonly pageKind: string;
  readonly file: string;
  readonly statement: string;
  readonly text: string;
  readonly line: number;
  readonly how: 'grounds' | 'mentions';
}

/** The statements that rely on a key: no stage writes one yet, so there are none. */
export async function statementsRelyingOn(_owner: DatabaseOwner, _key: string): Promise<RelyingStatement[]> {
  return [];
}

export interface KindCount {
  readonly kind: string;
  readonly pages: number;
  readonly statements: number;
}

/** Pages and statements per page kind: no stage writes one yet, so there are none. */
export async function indexCounts(_owner: DatabaseOwner): Promise<KindCount[]> {
  return [];
}

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
