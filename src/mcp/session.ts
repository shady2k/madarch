/**
 * A read session over the shared graph. A product's changed revision republishes manifest metadata;
 * repository content remains at the commit the last explicit fill published. A bare repository retains
 * the repository-tools fill workflow.
 */
import { resolve } from 'node:path';
import { readRevision, type Revision } from './git.js';
import { openRepositoryGraph, type RepositoryGraph } from './graph.js';
import type { FillProgress } from '../obs/progress.js';
import { recordCall } from './journal.js';
import { callRecordTool, isRecordTool, laterStepAnswer, type RecordContext } from './records.js';
import type { UnitToolAnswer } from './types.js';
import { fillFolderIdentity } from '../product/identity.js';
import { publishValidatedManifests, validateProductManifests } from '../graph/manifest-publication.js';

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

  get filledCommit(): string | null {
    return this.graph.commit;
  }

  private async catchUp(): Promise<Revision> {
    const revision = readRevision(this.absolute);
    if (fillFolderIdentity(this.absolute).product) {
      // Validate before touching the live graph, including uncommitted manifest edits.
      const validated = validateProductManifests(this.absolute);
      if (!validated.ok) throw new Error(validated.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('\n'));
      if (validated.value !== undefined) await publishValidatedManifests(this.graph.owner, validated.value);
    } else if (revision.commit !== this.revision.commit) {
      this.log(`madarch mcp: HEAD moved to ${revision.commit.slice(0, 12)}; refreshing the repository graph`);
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
