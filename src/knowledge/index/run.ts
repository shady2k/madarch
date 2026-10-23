/**
 * The index as the fill worker runs it (madarch-m38l.8): after every fill and
 * after every page the writer writes, over the product's Markdown and the
 * graph the worker holds. The valid time is the fill's last commit; the head
 * is the repository's pinned commit.
 */
import { execFileSync } from 'node:child_process';
import type { DatabaseOwner } from '../../adapters/database-owner.js';
import type { GraphStore } from '../../graph/index.js';
import { GraphView } from '../../writer/view.js';
import { gitReader } from './grounds.js';
import { indexProductMarkdown } from './index.js';
import type { IndexReport } from './publish.js';

export interface WorkerIndexOptions {
  readonly owner: DatabaseOwner;
  readonly store: GraphStore;
  readonly productFolder: string;
  readonly productId: string;
  /** The code repository as the product names it, and where it is. */
  readonly repository: { readonly name: string; readonly path: string };
  /** The revision the graph was filled from; `HEAD` by default. */
  readonly ref?: string;
}

/** Publishes the product's Markdown to the graph, or throws with every finding (file, line, reason). */
export async function indexWorkerProduct(options: WorkerIndexOptions): Promise<IndexReport> {
  const view = await GraphView.open(options.owner, options.store);
  const commit = execFileSync('git', ['rev-parse', '--verify', `${options.ref ?? 'HEAD'}^{commit}`], { cwd: options.repository.path, encoding: 'utf8' }).trim();
  const git = gitReader(options.repository.path);
  return await indexProductMarkdown({
    owner: options.owner, store: options.store, productFolder: options.productFolder, productId: options.productId, at: view.at,
    head: { commit, git }, repositories: (name) => (name === options.repository.name ? git : undefined),
  });
}
