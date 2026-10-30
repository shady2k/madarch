/**
 * One served repository (madarch-ztyq.10): the base graph at HEAD, the
 * working-tree layer over it, and the loop a tool call goes through.
 *
 * Every call re-reads the revision first. That is stricter than "re-extract the
 * file a query touches", and it is the only rule that cannot answer stale: an
 * edit, a deletion, a rename or a new commit between two calls is seen by the
 * second call before it reads anything. The cost is one `git status` per call
 * and an extraction of the changed files only when their bytes changed.
 *
 * Each answer says where it was read — the commit, the branch, the files the
 * working tree changed — and every node that stands in one of those files is
 * marked `uncommitted`, so an agent quoting an answer can say which half of it
 * is not in the commit yet.
 */
import { resolve } from 'node:path';

import { readRevision, type Revision } from './git.js';
import { graphFolder, mcpStateRoot, openRepositoryGraph, type RepositoryGraph } from './graph.js';
import { recordCall } from './journal.js';
import { RepositoryReads, WorkingLayer } from './layer.js';
import { RepositoryPages, repositoryQuestions } from './pages.js';
import { callRepoTool, type RepoToolAnswer } from './tools.js';

/** What a session needs to open. */
export interface SessionOptions {
  /** The checkout to serve. */
  readonly repository: string;
  /** The folder the graph is kept in; the state root's own folder for this repository when absent. */
  readonly folder?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where the session says what it builds and when; standard error by default. */
  readonly log?: (line: string) => void;
}

/** One open repository, serving the seven tools. */
export class RepositorySession {
  private graph: RepositoryGraph;
  private revision: Revision;
  /** The facts of the working tree, kept across calls and re-extracted when their files' bytes change. */
  private readonly walkLayer: WorkingLayer;

  private constructor(
    private readonly absolute: string,
    private readonly folder: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly log: (line: string) => void,
    graph: RepositoryGraph,
    revision: Revision,
  ) {
    this.graph = graph;
    this.revision = revision;
    this.walkLayer = new WorkingLayer(absolute);
  }

  static async open(options: SessionOptions): Promise<RepositorySession> {
    const absolute = resolve(options.repository);
    const env = options.env ?? process.env;
    const folder = resolve(options.folder ?? graphFolder(absolute, mcpStateRoot(env)));
    const log = options.log ?? (() => {});
    const revision = readRevision(absolute);
    const graph = await openRepositoryGraph({ repository: absolute, folder, env, log });
    return new RepositorySession(absolute, folder, env, log, graph, revision);
  }

  /** The folder the journal and the graph live in. */
  get stateFolder(): string {
    return this.folder;
  }

  /** The commit and the working tree the session last saw. */
  get current(): Revision {
    return this.revision;
  }

  private async catchUp(): Promise<{ revision: Revision; reextracted: string[] }> {
    const revision = readRevision(this.absolute);
    if (revision.commit !== this.graph.commit) {
      // A commit moved HEAD under the session: the base graph must be the graph of the new commit, so it is moved
      // the way the driver moves one (it reads the commits since its tip).
      this.log(`madarch mcp: HEAD moved to ${revision.commit.slice(0, 12)}; moving the graph`);
      await this.graph.close();
      this.graph = await openRepositoryGraph({ repository: this.absolute, folder: this.folder, env: this.env, log: this.log });
    }
    this.revision = revision;
    const refreshed = await this.walkLayer.refresh(revision);
    return { revision, reextracted: [...refreshed.reextracted] };
  }

  /** One tool call, answered from the working tree as it is now. */
  async call(tool: string, argumentsValue: unknown): Promise<RepoToolAnswer> {
    const started = performance.now();
    const { revision, reextracted } = await this.catchUp();
    const reads = new RepositoryReads(this.graph.view, this.walkLayer);
    const pages = new RepositoryPages(this.graph.view, this.walkLayer);
    const source = {
      repository: this.absolute,
      commit: revision.commit,
      branch: revision.branch,
      at: this.graph.view.at,
      dirty: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
      reextracted: [...reextracted],
    };
    const answered = await callRepoTool(tool, argumentsValue, {
      reads,
      pages,
      questions: async () => await repositoryQuestions(pages),
      source,
    });
    const answer = markUncommitted(answered.answer, this.walkLayer);
    const bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    recordCall(this.folder, {
      at: new Date().toISOString(),
      tool,
      arguments: argumentsValue ?? null,
      answerBytes: bytes,
      reextracted,
      covered: answered.covered,
      readsSaved: answered.covered.length,
      durationMs: Math.round(performance.now() - started),
      revision: { commit: revision.commit, branch: revision.branch },
    });
    return { ...answered, answer };
  }

  /** The layer of the session, for a caller that reads it directly. */
  get layer(): WorkingLayer {
    return this.walkLayer;
  }

  async close(): Promise<void> {
    await this.graph.close();
  }
}

/**
 * Marks every node of an answer that stands in a file the working tree changed:
 * a reader must be able to tell the commit's facts from the checkout's.
 */
export function markUncommitted(value: unknown, layer: WorkingLayer): unknown {
  const keys = new Set(layer.held.map((node) => node.key));
  const mark = (one: unknown): unknown => {
    if (Array.isArray(one)) return one.map(mark);
    if (typeof one !== 'object' || one === null) return one;
    const held = one as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(held)) out[key] = key === 'source' ? inner : mark(inner);
    const names = typeof held['key'] === 'string' ? held['key'] : undefined;
    const path = typeof held['path'] === 'string' ? held['path'] : undefined;
    if ((names !== undefined && (keys.has(names) || layer.hidesKey(names))) || (path !== undefined && layer.hides(path))) out['uncommitted'] = true;
    return out;
  };
  return mark(value);
}
