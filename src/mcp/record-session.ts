/**
 * One served checkout over this step's record store (madarch-8bdc.2.5, item 1):
 * the graph the five tools answer from, built by the one fill and read by the
 * graph's own reads.
 *
 * The session opens the store under its state folder, fills it through
 * `runFill` when the store does not hold the checkout's HEAD, and answers every
 * call from the store. The working tree is read for one thing only — the paths
 * it changes — so an answer that is true at the as-is commit says which paths
 * the checkout has already moved past. Nothing here reads a file's content or
 * re-extracts an edit: this step's graph is the commit's.
 */
import { resolve } from 'node:path';
import { createRecordSchema, repositoryFacts } from '../graph/index.js';
import { openRecordStore, type OpenRecordStore } from '../graph/record-store.js';
import { runFill } from '../fill/run.js';
import { readRevision, type Revision } from './git.js';
import { recordCall } from './journal.js';
import { LATER_TOOL_STEPS, RECORD_TOOLS, callRecordTool, isRecordTool, laterStepAnswer, type ChangedPath, type RecordContext, type RecordSource, type RecordToolAnswer } from './records.js';
import type { RepoToolAnswer } from './tools.js';

/** What opening one record session is asked for. */
export interface RecordSessionOptions {
  /** The checkout to serve. */
  readonly repository: string;
  /** The state folder the store and the run's trace live in; `graphFolder`'s own when absent. */
  readonly folder: string;
  /** Where the session says what it builds; standard error by default. */
  readonly log?: (line: string) => void;
  /** The number of units the fill holds at once; two repository passes need no more than two. */
  readonly workers?: number;
}

/** One open checkout, serving the five tools of this step. */
export class RepositoryRecordSession {
  private constructor(
    private readonly absolute: string,
    private readonly folder: string,
    private readonly store: OpenRecordStore,
    private readonly log: (line: string) => void,
  ) {}

  /** Opens the store of one checkout and fills it when it does not hold the checkout's HEAD. */
  static async open(options: RecordSessionOptions): Promise<RepositoryRecordSession> {
    const absolute = resolve(options.repository);
    const log = options.log ?? (() => {});
    const store = openRecordStore(resolve(options.folder));
    try {
      await createRecordSchema(store.owner);
      const session = new RepositoryRecordSession(absolute, resolve(options.folder), store, log);
      await session.catchUp(options.workers);
      return session;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  /** The commit the checkout stands at, and the paths its working tree changed. */
  get current(): Revision {
    return readRevision(this.absolute);
  }

  /** The name the store holds the checkout under: its folder's name, as the repository pass pins it. */
  private get repositoryName(): string {
    return this.absolute.slice(this.absolute.lastIndexOf('/') + 1);
  }

  /**
   * Fills the store when it does not hold the checkout's HEAD — on open, and
   * again when a commit moved HEAD under a running session. A run that does not
   * settle is the session's own refusal, named: a client is never served a store
   * that says it is the graph of a commit it does not hold.
   */
  private async catchUp(workers = 2): Promise<void> {
    const revision = readRevision(this.absolute);
    const held = await repositoryFacts(this.store.owner, this.repositoryName);
    if (held?.asIsCommit === revision.commit) return;
    this.log(`madarch mcp: filling ${this.absolute} at ${revision.commit.slice(0, 12)} in ${this.folder}`);
    const runId = `mcp-${revision.commit.slice(0, 12)}`;
    const answer = await runFill({
      product: this.absolute,
      database: this.store.owner,
      runId,
      store: this.folder,
      home: this.folder,
      workers,
      maxPasses: 100_000,
    });
    if (!answer.ok) throw new Error(`${this.folder}:1: the fill of ${this.absolute} was refused: ${answer.code}: ${answer.reason} (src/mcp/record-session.ts)`);
    const failed = answer.units.filter((unit) => unit.state !== 'published' && unit.state !== 'superseded');
    if (!answer.settled || answer.state !== 'succeeded' || failed.length > 0) {
      const named = failed.map((unit) => `${unit.unitId} (${unit.stageId}, ${unit.state})`).join(', ');
      throw new Error(`${this.folder}:1: the fill of ${this.absolute} ended ${answer.settled ? answer.state : 'without settling'}${named === '' ? '' : `: ${named}`} (src/mcp/record-session.ts)`);
    }
    const filled = await repositoryFacts(this.store.owner, this.repositoryName);
    if (filled?.asIsCommit !== revision.commit) {
      throw new Error(`${this.folder}:1: the fill of ${this.absolute} ended without publishing the tree of ${revision.commit}; the store says ${filled?.asIsCommit ?? 'nothing'} is as-is (src/mcp/record-session.ts)`);
    }
  }

  /** What every answer names: the as-is commit, and the paths the working tree already moved past. */
  private async sourceOf(revision: Revision): Promise<{ source: RecordSource; gaps: readonly { what: string; reason: string }[] }> {
    const facts = await repositoryFacts(this.store.owner, this.repositoryName);
    const changed: ChangedPath[] = revision.dirty.map((one) => ({ path: one.path, status: one.status }));
    return {
      source: {
        repository: this.absolute,
        commit: facts?.asIsCommit ?? null,
        branch: revision.branch,
        head: facts?.asIsCommit !== null && facts?.asIsCommit !== revision.commit ? revision.commit : null,
        changed,
      },
      gaps: facts?.gaps ?? [],
    };
  }

  /**
   * One tool call, answered from the record store. A call whose tool belongs to
   * a step this fill does not run answers that step's name; a call whose store
   * holds no repository answers the tree step's name.
   */
  async call(tool: string, argumentsValue: unknown): Promise<RepoToolAnswer> {
    const started = performance.now();
    const revision = readRevision(this.absolute);
    // A commit that moved HEAD under the session is the store's own reason to move first: an answer
    // about the previous commit would be stale the moment it was made.
    await this.catchUp();
    const { source, gaps } = await this.sourceOf(revision);
    const context: RecordContext = { owner: this.store.owner, repository: this.repositoryName, source };
    let answered: RecordToolAnswer;
    if (isRecordTool(tool)) {
      answered = await callRecordTool(tool, argumentsValue, context);
    } else if (Object.hasOwn(LATER_TOOL_STEPS, tool)) {
      answered = laterStepAnswer(tool, this.repositoryName);
    } else {
      answered = { answer: { error: { code: 'unknown-tool', message: `${JSON.stringify(tool)} is no tool of this server: its tools are ${[...RECORD_TOOLS.map((one) => one.name), ...Object.keys(LATER_TOOL_STEPS)].join(', ')} (src/mcp/record-session.ts)` } }, isError: true };
    }
    const answer = {
      ...(answered.answer as Record<string, unknown>),
      source: (answered.answer as Record<string, unknown>)['source'] ?? source,
      gaps: (answered.answer as Record<string, unknown>)['gaps'] ?? gaps,
    };
    const covered = coveredOf(answer);
    recordCall(this.folder, {
      at: new Date().toISOString(),
      tool,
      arguments: argumentsValue ?? null,
      answerBytes: Buffer.byteLength(JSON.stringify(answer), 'utf8'),
      reextracted: [],
      covered,
      readsAvoided: 0,
      questionsAnswered: 0,
      evidenceFiles: 0,
      durationMs: Math.round(performance.now() - started),
      revision: { commit: revision.commit, branch: revision.branch },
    });
    return { answer, isError: answered.isError, reads: [], covered };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

/** The repository paths an answer names: the files it states, so the journal says what was shown. */
function coveredOf(answer: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  if (typeof answer['path'] === 'string') paths.add(answer['path']);
  const files = answer['files'];
  if (Array.isArray(files)) for (const file of files) if (typeof file === 'object' && file !== null && typeof (file as { path?: unknown }).path === 'string') paths.add((file as { path: string }).path);
  const changed = answer['changed'];
  if (Array.isArray(changed)) for (const one of changed) if (typeof one === 'object' && one !== null && typeof (one as { path?: unknown }).path === 'string') paths.add((one as { path: string }).path);
  return [...paths].sort();
}
