/**
 * One served repository (madarch-ztyq.10; madarch-8bdc.2.5, items 2 and 3): the store
 * the one fill published, the loop a tool call goes through, and the revision every
 * answer names.
 *
 * Every call re-reads the revision first. A commit that moved HEAD under the session
 * moves the store: the fill runs at the new commit through the same runner, and the
 * answers are read from it. A file the working tree changed without a commit is not
 * re-extracted: the answers name it as changed, and their facts stay the filled
 * commit's, which is the whole of what the store holds.
 *
 * Each answer's `source` names the commit the store is the graph of (its records'
 * as-is commit), the branch the checkout stands on, and every path the working tree
 * changed since that commit — so an agent quoting an answer can say which files the
 * facts predate.
 */
import { resolve } from 'node:path';

import { readRevision, type Revision } from './git.js';
import { openRepositoryGraph, type RepositoryGraph } from './graph.js';
import type { FillProgress } from '../obs/progress.js';
import { recordCall } from './journal.js';
import { RepositoryReads } from './layer.js';
import { RepositoryPages, repositoryQuestions } from './pages.js';
import { callRepoTool, type RepoToolAnswer } from './tools.js';
import { callRecordTool, isRecordTool, laterStepAnswer, type RecordContext, type RecordToolAnswer } from './records.js';

/** What a session needs to open. */
export interface SessionOptions {
  /** The checkout to serve. */
  readonly repository: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where the session says what it builds and when; standard error by default. */
  readonly log?: (line: string) => void;
  /** The fill's own progress, read from its trace: what the building answer says while the graph is made. */
  readonly progress?: (() => FillProgress) | undefined;
}

/** A record answer in the shape every served tool answers: the body, and what it read. */
async function recordAnswer(answered: RecordToolAnswer): Promise<RepoToolAnswer> {
  const body = answered.answer as Record<string, unknown>;
  const covered: string[] = [];
  if (typeof body['path'] === 'string') covered.push(body['path']);
  for (const key of ['files', 'changed', 'commits'] as const) {
    const rows = body[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (typeof row === 'object' && row !== null && typeof (row as { path?: unknown }).path === 'string') covered.push((row as { path: string }).path);
  }
  return { answer: body, isError: answered.isError, reads: [], covered: [...new Set(covered)].sort() };
}

/** One open repository, serving the five tools of this step and the seven of decision 0032. */
export class RepositorySession {
  private graph: RepositoryGraph;
  private revision: Revision;

  private constructor(
    private readonly absolute: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly log: (line: string) => void,
    graph: RepositoryGraph,
    revision: Revision,
  ) {
    this.graph = graph;
    this.revision = revision;
  }

  static async open(options: SessionOptions): Promise<RepositorySession> {
    const absolute = resolve(options.repository);
    const env = options.env ?? process.env;
    const log = options.log ?? (() => {});
    const revision = readRevision(absolute);
    const graph = await openRepositoryGraph({ repository: absolute, env, log, progress: options.progress });
    return new RepositorySession(absolute, env, log, graph, revision);
  }

  /** The store folder the journal and the graph live in. */
  get stateFolder(): string {
    return this.graph.folder;
  }

  /** The commit and the working tree the session last saw. */
  get current(): Revision {
    return this.revision;
  }

  /** The commit the store is the graph of. */
  get filledCommit(): string {
    return this.graph.commit;
  }

  private async catchUp(): Promise<Revision> {
    const revision = readRevision(this.absolute);
    if (revision.commit !== this.graph.commit) {
      // A commit moved HEAD under the session: the store is filled at the new commit through the one fill, so the
      // answers are the new commit's facts. A fill that cannot move the store throws, and the call says so.
      this.log(`madarch mcp: HEAD moved to ${revision.commit.slice(0, 12)}; filling the store at it`);
      await this.graph.close();
      this.graph = await openRepositoryGraph({ repository: this.absolute, env: this.env, log: this.log });
    }
    this.revision = revision;
    return revision;
  }

  /**
   * One tool call, answered from the store as it is now.
   *
   * The five tools of this step read the record tables (`callRecordTool`), the seven of decision
   * 0032 read the temporal graph when the store holds one, and a tool whose step this fill does not
   * run answers that the step has not run, naming it (madarch-8bdc.2.5, item 1).
   *
   * Every answer names the revision it was read at, refusals and failures included, and it gets that `source`
   * here, in one place: the answering functions show the source they were handed, and a call that never reached
   * them still says which commit it was asked about (madarch-ztyq.10 review).
   *
   * A catch-up that fails answers *this* request and keeps serving: the failure is the call's own answer, and the
   * next call reads the revision again.
   */
  async call(tool: string, argumentsValue: unknown): Promise<RepoToolAnswer> {
    const started = performance.now();
    let revision = this.revision;
    const source = (): Record<string, unknown> => {
      const fill = this.graph.fill;
      const view = this.graph.view;
      return {
        repository: this.absolute,
        // The as-is commit: the one the store's records name, never the checkout's HEAD guessed from the other side.
        commit: this.graph.commit,
        branch: revision.branch,
        // The instant the temporal view reads at, when the store holds one: a store this step's fill wrote
        // holds none, and its answers are the records' own.
        ...(view === null ? {} : { at: view.at }),
        // The checkout's HEAD, when it is not the commit the store holds; every path the working tree
        // changed since it, under both names the two families of tools have used (`changed`, `dirty`).
        ...(this.graph.commit === revision.commit ? {} : { head: revision.commit }),
        changed: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
        dirty: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
        // What the fill that built this graph left out is named on every answer: a reader must never take a
        // partial graph for the whole one (decision 0033, items 18 and 19).
        ...(fill === undefined || fill.failed.length === 0 ? {} : { fill: { state: fill.state, failed: fill.failed } }),
      };
    };
    let answered: RepoToolAnswer;
    let questionsAnswered = 0;
    try {
      revision = await this.catchUp();
      const view = this.graph.view;
      if (isRecordTool(tool)) {
        const context: RecordContext = {
          owner: this.graph.owner,
          repository: this.graph.repositoryName,
          source: {
            repository: this.absolute,
            commit: this.graph.commit,
            branch: revision.branch,
            head: this.graph.commit === revision.commit ? null : revision.commit,
            changed: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
          },
        };
        answered = await recordAnswer(await callRecordTool(tool, argumentsValue, context));
      } else if (view === null) {
        // No temporal graph stands in this store: the tool of a later step names that step rather
        // than answering an empty page from a graph this fill never published.
        answered = await recordAnswer(laterStepAnswer(tool, this.graph.repositoryName));
      } else {
        const reads = new RepositoryReads(view, this.absolute, this.graph.commit);
        const pages = new RepositoryPages(view, this.absolute, this.graph.commit);
        answered = await callRepoTool(tool, argumentsValue, {
          reads,
          pages,
          questions: async () => await repositoryQuestions(pages),
          source: source(),
        });
      }
      if (!answered.isError) {
        const body = answered.answer as Record<string, unknown>;
        // An ambiguous name is a question asked and not answered: the caller must ask again, by another name.
        questionsAnswered = body['candidates'] !== undefined && body['selected'] == null ? 0 : 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      answered = { isError: true, answer: { error: { code: 'refresh-failed', message } }, reads: [], covered: [] } as RepoToolAnswer;
    }
    const answer = { ...(answered.answer as Record<string, unknown>), source: source() };
    const bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    recordCall(this.graph.folder, {
      at: new Date().toISOString(),
      tool,
      arguments: argumentsValue ?? null,
      answerBytes: bytes,
      covered: answered.covered,
      readsAvoided: answered.reads.length,
      questionsAnswered,
      evidenceFiles: answered.covered.length,
      durationMs: Math.round(performance.now() - started),
      revision: { commit: revision.commit, branch: revision.branch },
    });
    return { ...answered, answer };
  }

  async close(): Promise<void> {
    await this.graph.close();
  }
}
