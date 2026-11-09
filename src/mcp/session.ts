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
 */
import { resolve } from 'node:path';
import { readRevision, type Revision } from './git.js';
import { openRepositoryGraph, type RepositoryGraph } from './graph.js';
import type { FillProgress } from '../obs/progress.js';
import { recordCall } from './journal.js';
import { callRecordTool, isRecordTool, laterStepAnswer, type RecordContext } from './records.js';
import type { UnitToolAnswer } from './types.js';

export interface SessionOptions {
  readonly repository: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (line: string) => void;
  readonly progress?: (() => FillProgress) | undefined;
}

/** One answer and what it cost: the source it showed, and the files a reader no longer has to open. */
export interface RepoToolAnswer extends UnitToolAnswer {
  readonly reads: readonly unknown[];
  readonly covered: readonly string[];
}

/** A record answer in the shape every served tool answers: the body, and what it read. */
async function recordAnswer(answered: { answer: unknown; isError: boolean }): Promise<RepoToolAnswer> {
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

/** One open repository, serving the five record tools; a later step's tool names that step. */
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

  get stateFolder(): string {
    return this.graph.folder;
  }

  get current(): Revision {
    return this.revision;
  }

  get filledCommit(): string {
    return this.graph.commit;
  }

  private async catchUp(): Promise<Revision> {
    const revision = readRevision(this.absolute);
    if (revision.commit !== this.graph.commit) {
      this.log(`madarch mcp: HEAD moved to ${revision.commit.slice(0, 12)}; filling the store at it`);
      await this.graph.close();
      this.graph = await openRepositoryGraph({ repository: this.absolute, env: this.env, log: this.log });
    }
    this.revision = revision;
    return revision;
  }

  /** One tool call, answered from the store as it is now. */
  async call(tool: string, argumentsValue: unknown): Promise<RepoToolAnswer> {
    const started = performance.now();
    let revision = this.revision;
    const source = (): Record<string, unknown> => {
      const fill = this.graph.fill;
      return {
        repository: this.absolute,
        commit: this.graph.commit,
        branch: revision.branch,
        ...(this.graph.commit === revision.commit ? {} : { head: revision.commit }),
        changed: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
        dirty: revision.dirty.map((one) => ({ path: one.path, status: one.status })),
        ...(fill === undefined || fill.failed.length === 0 ? {} : { fill: { state: fill.state, failed: fill.failed } }),
      };
    };
    let answered: RepoToolAnswer;
    try {
      revision = await this.catchUp();
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
      } else {
        answered = await recordAnswer(laterStepAnswer(tool, this.graph.repositoryName));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      answered = { isError: true, answer: { error: { code: 'refresh-failed', message } }, reads: [], covered: [] };
    }
    const answer = { ...(answered.answer as Record<string, unknown>), source: source() };
    const bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    recordCall(this.graph.folder, {
      at: new Date().toISOString(), tool, arguments: argumentsValue ?? null, answerBytes: bytes,
      covered: answered.covered, readsAvoided: answered.reads.length, questionsAnswered: 0,
      evidenceFiles: answered.covered.length, durationMs: Math.round(performance.now() - started),
      revision: { commit: revision.commit, branch: revision.branch },
    });
    return { ...answered, answer };
  }

  async close(): Promise<void> {
    await this.graph.close();
  }
}
