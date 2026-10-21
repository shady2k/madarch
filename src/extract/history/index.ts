/**
 * The history extractor (madarch-o0eq.4): one default branch's history read
 * into records keyed by their logical identity — the commits with their raw
 * times and decision 0028's effective times, the merge and the branch commits
 * it made valid at the merge, the files a rename joined into one identity,
 * their churn, authors and change coupling, and what every pinned snapshot
 * holds. Pure over the repository's own Git: no database, no network, no
 * clock; the same history gives the same records anywhere.
 */
import {byCodePoint} from '../../model/order.js';
import type {Extraction, ExtractedEdge, ExtractedNode} from '../records.js';
import {commitRecords} from './commits.js';
import {fileRecords} from './files.js';
import {defaultBranch, readLog} from './git.js';

/** The producer the extraction names. */
export const HISTORY_PRODUCER = 'code.extract.history';

/** What the history extractor is asked to read. */
export interface HistoryExtractionRequest {
  /** The repository's folder, read by its own Git. */
  readonly repository: string;
  /** The snapshots the caller pins, each name to the revision it pins; each becomes a `code.snapshot` node holding what it holds. */
  readonly snapshots: Readonly<Record<string, string>>;
}

/**
 * Reads one repository's default branch into an `Extraction`. Two walks give
 * the raw facts — the whole branch (`git log --name-status -M`) and its
 * first-parent line (`git log --first-parent --name-status -M`) — and every
 * dated fact is computed from them: the effective times, the branch commits'
 * validity at their merge, the rename identities, the churn, the authors and
 * the change coupling.
 */
export async function extractHistory(request: HistoryExtractionRequest): Promise<Extraction> {
  const {repository, snapshots} = request;
  const what = 'the history extractor reads the default branch';
  const branch = defaultBranch(repository);
  const line = readLog(what, repository, branch, true);
  const all = readLog(what, repository, branch, false);
  if (line.length === 0 || all.length === 0) {
    throw new Error(`${what}: the branch ${branch} of ${repository} holds no commit the walk could read`);
  }

  const commits = commitRecords(line, all);
  const files = fileRecords(repository, branch, all, commits.commits, snapshots);

  const nodes: ExtractedNode[] = [...commits.nodes, ...files.nodes].sort((left, right) => byCodePoint(left.key, right.key));
  const edges: ExtractedEdge[] = [...commits.edges, ...files.edges].sort(edgeOrder);
  return {producer: HISTORY_PRODUCER, nodes, edges, gaps: files.gaps};
}

/** The order of the extraction's edges: type, both ends, then the discriminator. */
function edgeOrder(left: ExtractedEdge, right: ExtractedEdge): number {
  return byCodePoint(left.type, right.type) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.discriminator, right.discriminator);
}
