/**
 * The five tools of this step's repository graph (madarch-8bdc.2.5, item 1),
 * served over the normal form (decision 0033, the record tables of
 * `src/graph/records.ts`) and reading nothing else: the store's own answers,
 * never a file of the checkout and never a second reading of git.
 *
 * A tool answers what the as-is commit holds — the commit the tree pass read —
 * so every answer names that commit, and a checkout whose working tree differs
 * from it names the paths that differ. A repository whose tree or history pass
 * has not run is answered with that step named, never with an empty result; a
 * gap the fill recorded is stated in every answer, never dropped.
 *
 * The tools are read-only: nothing here writes a store, a file or a checkout.
 */
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { RecordGap, commitWithPaths, fileFacts, fileHistory, listFiles, repositoryFacts } from '../graph/index.js';
import { withSpan } from '../obs/trace.js';

/** The store the tools read: the graph store's own owner, as the reads name it. */
type RecordOwner = Parameters<typeof listFiles>[0];

/** The bounds one answer is cut by, named here so every answer states its own page. */
export const RECORD_FILE_LIMIT = 200;
const RECORD_HISTORY_LIMIT = 100;

/** One path the working tree changed, as `git status` names it. */
export interface ChangedPath {
  readonly path: string;
  readonly status: string;
}

/** What every answer names: where it was read, at which commit, and what differs from that commit. */
export interface RecordSource {
  /** The repository's full path, as the server was pointed at it. */
  readonly repository: string;
  /** The as-is commit the answer is true at; null when the tree pass has not run. */
  readonly commit: string | null;
  readonly branch: string | null;
  /** The checkout's HEAD, when it is not the as-is commit the answer is true at. */
  readonly head: string | null;
  /** The paths the working tree changed since the as-is commit, in code point order. */
  readonly changed: readonly ChangedPath[];
}

/** What one record answer reads: the store, the repository's name, the revision, and its gaps. */
export interface RecordContext {
  readonly owner: RecordOwner;
  readonly repository: string;
  readonly source: RecordSource;
}

/** One answer in the shape every served tool answers: the body, and whether it is a refusal. */
export interface RecordToolAnswer {
  readonly answer: Record<string, unknown>;
  readonly isError: boolean;
}

/** A refusal of one call, in the envelope every tool of this server shares. */
function fail(code: string, message: string, step?: string): RecordToolAnswer {
  return { answer: { error: { code, message, ...(step === undefined ? {} : { step }) } }, isError: true };
}

/** The refusal of a store that holds no repository yet: the step that would put it there is named. */
function notRun(repository: string, step: string, detail: string): RecordToolAnswer {
  return fail('step-not-run', `${detail}; the step "${step}" has not run for ${repository}, so this answer would be empty (src/mcp/records.ts)`, step);
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', additionalProperties: false, required, properties });

/** The tools of this step, in the order a reader asks them. */
export const RECORD_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'list_files',
    description: `One page of the repository's files at the as-is commit, ${RECORD_FILE_LIMIT} at most, in code point order of their paths. "prefix" is a path prefix (a folder's own path and below), "language" keeps one language's files, and the previous answer's "next" goes on to the next page. Each row states the file's path, mode, blob hash, bytes, lines, text or binary form, and the language with every candidate the dataset gives it.`,
    inputSchema: object({
      prefix: { type: 'string', description: 'A path prefix, such as "src/" or "src/index.ts".' },
      language: { type: 'string', description: 'A language as the dataset names it, such as "TypeScript".' },
      after: { type: 'string', description: 'The "next" of the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: RECORD_FILE_LIMIT },
    }),
  },
  {
    name: 'get_file',
    description: 'One file at the as-is commit: its mode, blob hash, bytes, lines, text or binary form, its language with every candidate, the commits that created it and last modified it, and the authors who changed it.',
    inputSchema: object({ path: { type: 'string', description: 'A repository path, as list_files shows it.' } }, ['path']),
  },
  {
    name: 'get_file_history',
    description: `The commits that touched one path, following renames, newest first, ${RECORD_HISTORY_LIMIT} at most per page: each with what the commit did to the path, the lines it added and removed, and the path it was renamed from. Pass the previous answer's "next" object as "after".`,
    inputSchema: object({
      path: { type: 'string', description: 'A repository path.' },
      after: {
        type: 'object',
        additionalProperties: false,
        properties: { walk: { type: 'integer', minimum: 0 }, commit: { type: 'string' } },
        required: ['walk', 'commit'],
        description: 'The "next" object of the previous answer: the walk and the commit it ended on.',
      },
      limit: { type: 'integer', minimum: 1, maximum: RECORD_HISTORY_LIMIT },
    }, ['path']),
  },
  {
    name: 'get_commit',
    description: 'One commit of the history: its hash, author, author and commit dates with their UTC offsets, subject, parents in order, and the paths it changed with what happened to each.',
    inputSchema: object({ hash: { type: 'string', description: 'A full commit hash, as get_file_history answers it.' } }, ['hash']),
  },
  {
    name: 'get_repository',
    description: 'The repository at the as-is commit: its name, url, default branch, the as-is commit, the counts of files, commits and folders the graph holds, and every gap the fill recorded.',
    inputSchema: object({}),
  },
];

/** One file row as an answer states it. */
function fileRow(file: { readonly path: string; readonly mode: string; readonly blob: string; readonly bytes: number; readonly form: string; readonly lines: number | null; readonly language: string; readonly candidates: readonly string[] }): Record<string, unknown> {
  return {
    path: file.path, mode: file.mode, blob: file.blob, bytes: file.bytes, lines: file.lines,
    form: file.form, language: file.language, candidates: [...file.candidates],
  };
}

/** The repository's own facts, or the refusal a store without one answers. */
async function factsOf(context: RecordContext): Promise<{ ok: true; facts: NonNullable<Awaited<ReturnType<typeof repositoryFacts>>> } | { ok: false; answer: RecordToolAnswer }> {
  const facts = await repositoryFacts(context.owner, context.repository);
  if (facts === null) return { ok: false, answer: notRun(context.repository, 'repository-tree', 'the store holds no repository node') };
  if (facts.asIsCommit === null) return { ok: false, answer: notRun(context.repository, 'repository-tree', 'the store holds the repository but no as-is commit') };
  return { ok: true, facts };
}

/** The envelope every answer carries: the as-is commit, the changed paths and the recorded gaps. */
function envelope(context: RecordContext, gaps: readonly { readonly what: string; readonly reason: string }[]): Record<string, unknown> {
  return {
    source: {
      repository: context.source.repository,
      commit: context.source.commit,
      branch: context.source.branch,
      ...(context.source.head === null ? {} : { head: context.source.head }),
      changed: context.source.changed.map((one) => ({ path: one.path, status: one.status })),
    },
    gaps: gaps.map((gap) => ({ what: gap.what, reason: gap.reason })),
  };
}

/** One page of files, paged by path, and the page the next answer starts at. */
async function listFilesAnswer(context: RecordContext, args: Record<string, unknown>): Promise<RecordToolAnswer> {
  const prefix = typeof args['prefix'] === 'string' && args['prefix'] !== '' ? args['prefix'] : undefined;
  const language = typeof args['language'] === 'string' && args['language'] !== '' ? args['language'] : undefined;
  const after = typeof args['after'] === 'string' && args['after'] !== '' ? args['after'] : undefined;
  const limit = pageLimit(args['limit'], RECORD_FILE_LIMIT);
  const held = await factsOf(context);
  if (!held.ok) return held.answer;
  try {
    const page = await listFiles(context.owner, { repository: context.repository, limit, ...(prefix === undefined ? {} : { prefix }), ...(language === undefined ? {} : { language }), ...(after === undefined ? {} : { after }) });
    return {
      answer: {
        ...envelope(context, held.facts.gaps),
        repository: held.facts.name,
        files: page.rows.map(fileRow),
        next: page.next,
      },
      isError: false,
    };
  } catch (error) {
    if (error instanceof RecordGap) return notRun(context.repository, 'repository-tree', error.message);
    throw error;
  }
}

/** One file with its dates and authors. */
async function getFileAnswer(context: RecordContext, args: Record<string, unknown>): Promise<RecordToolAnswer> {
  const path = textArgument(args['path'], 'path');
  if (typeof path !== 'string') return path;
  const held = await factsOf(context);
  if (!held.ok) return held.answer;
  const file = await fileFacts(context.owner, context.repository, path);
  if (file === null) return fail('no-such-file', `the as-is commit ${held.facts.asIsCommit} holds no file ${JSON.stringify(path)}; list_files names the paths it holds (src/mcp/records.ts)`);
  return {
    answer: {
      ...envelope(context, held.facts.gaps),
      repository: held.facts.name,
      ...fileRow(file),
      created: file.created,
      modified: file.modified,
      commitCount: file.commitCount,
      authors: [...file.authors],
    },
    isError: false,
  };
}

/** One page of the commits that touched a path. */
async function getFileHistoryAnswer(context: RecordContext, args: Record<string, unknown>): Promise<RecordToolAnswer> {
  const path = textArgument(args['path'], 'path');
  if (typeof path !== 'string') return path;
  const after = afterArgument(args['after']);
  if (after !== undefined && 'error' in after) return after.error;
  const limit = pageLimit(args['limit'], RECORD_HISTORY_LIMIT);
  const held = await factsOf(context);
  if (!held.ok) return held.answer;
  if (held.facts.commitCount === 0) {
    const isFile = await fileFacts(context.owner, context.repository, path);
    if (isFile !== null) return notRun(context.repository, 'repository-history', `the store holds the file ${JSON.stringify(path)} but no commit touched it`);
  }
  const page = await fileHistory(context.owner, { repository: context.repository, path, limit, ...(after === undefined ? {} : { after: after.value }) });
  return {
    answer: {
      ...envelope(context, held.facts.gaps),
      repository: held.facts.name,
      path,
      commits: page.rows.map((row) => ({
        commit: row.commit, change: row.change, added: row.added, removed: row.removed,
        previousPath: row.previousPath, date: row.date, subject: row.subject, walk: row.walk,
      })),
      next: page.next,
    },
    isError: false,
  };
}

/** One commit with the paths it changed. */
async function getCommitAnswer(context: RecordContext, args: Record<string, unknown>): Promise<RecordToolAnswer> {
  const hash = textArgument(args['hash'], 'hash');
  if (typeof hash !== 'string') return hash;
  const held = await factsOf(context);
  if (!held.ok) return held.answer;
  if (held.facts.commitCount === 0) return notRun(context.repository, 'repository-history', 'the store holds no commit');
  const commit = await commitWithPaths(context.owner, context.repository, hash);
  if (commit === null) return fail('no-such-commit', `the store holds no commit ${JSON.stringify(hash)} of ${context.repository}; get_file_history answers the hashes it holds (src/mcp/records.ts)`);
  return {
    answer: {
      ...envelope(context, held.facts.gaps),
      repository: held.facts.name,
      hash: commit.hash,
      author: { name: commit.author.name, email: commit.author.email },
      authorDate: commit.authorDate,
      authorOffsetMin: commit.authorOffsetMin,
      commitDate: commit.commitDate,
      commitOffsetMin: commit.commitOffsetMin,
      subject: commit.subject,
      parents: [...commit.parents],
      changed: commit.touched.map((one) => ({
        path: one.path, change: one.change, added: one.added, removed: one.removed,
        ...(one.previousPath === null ? {} : { previousPath: one.previousPath }),
      })),
    },
    isError: false,
  };
}

/** One repository and what the graph holds for it. */
async function getRepositoryAnswer(context: RecordContext): Promise<RecordToolAnswer> {
  const facts = await repositoryFacts(context.owner, context.repository);
  if (facts === null) return notRun(context.repository, 'repository-tree', 'the store holds no repository node');
  return {
    answer: {
      ...envelope(context, facts.gaps),
      repository: facts.name,
      url: facts.url,
      defaultBranch: facts.defaultBranch,
      asIsCommit: facts.asIsCommit,
      counts: { files: facts.fileCount, commits: facts.commitCount, folders: facts.directoryCount },
      steps: {
        'repository-tree': facts.asIsCommit !== null,
        'repository-history': facts.commitCount > 0,
      },
    },
    isError: false,
  };
}

/** A whole number of 1 or more, at most the tool's own bound; the bound stands when nothing is asked. */
function pageLimit(value: unknown, bound: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return bound;
  return Math.min(value, bound);
}

/** One text argument, or the refusal of a call that named none. */
function textArgument(value: unknown, name: string): string | RecordToolAnswer {
  return typeof value === 'string' && value !== '' ? value : fail('bad-argument', `"${name}" is a non-empty text (src/mcp/records.ts)`);
}

/** The `after` of a page: the store's own pair, or the refusal of a value that is not one. */
function afterArgument(value: unknown): { value: { walk: number; commit: string } } | { error: RecordToolAnswer } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return { error: fail('bad-argument', '"after" is the "next" object of the previous answer (src/mcp/records.ts)') };
  const walk = (value as Record<string, unknown>)['walk'];
  const commit = (value as Record<string, unknown>)['commit'];
  if (typeof walk !== 'number' || !Number.isInteger(walk) || walk < 0 || typeof commit !== 'string' || commit === '') {
    return { error: fail('bad-argument', '"after" names its "walk" as a whole number of 0 or more and its "commit" as a text (src/mcp/records.ts)') };
  }
  return { value: { walk, commit } };
}

/**
 * The step each tool of decision 0032 reads last: the step that publishes what
 * it answers. This fill runs the repository's tree and history, so a tool whose
 * step is one of these answers that the step has not run, naming it, rather
 * than an empty answer a client would take for "nothing there".
 */
export const LATER_TOOL_STEPS: Readonly<Record<string, string>> = {
  get_symbol: 'syntax',
  get_context: 'syntax',
  trace_flow: 'semantic-resolution',
  get_document_sections: 'document-index',
  search_pages: 'document-index',
  get_page: 'document-index',
  search_questions: 'document-index',
};

/** Whether a tool is one this step serves. */
export function isRecordTool(tool: string): boolean {
  return RECORD_TOOLS.some((definition) => definition.name === tool);
}

/** The answer of a tool whose step this fill does not run, naming the step. */
export function laterStepAnswer(tool: string, repository: string): RecordToolAnswer {
  const step = LATER_TOOL_STEPS[tool] ?? 'unknown';
  return fail(
    'step-not-run',
    `the step "${step}" has not run: this fill runs repository-tree and repository-history, and ${JSON.stringify(tool)} answers what "${step}" publishes; nothing is answered for ${repository} until that step runs (src/mcp/records.ts)`,
    step,
  );
}

/** One call of one tool: every answer is one span, so a trace names what a client asked and what it cost. */
export async function callRecordTool(tool: string, argumentsValue: unknown, context: RecordContext): Promise<RecordToolAnswer> {
  const args = typeof argumentsValue === 'object' && argumentsValue !== null && !Array.isArray(argumentsValue) ? argumentsValue as Record<string, unknown> : {};
  return await withSpan('mcp.record', { 'mcp.tool': tool, 'mcp.repository': context.repository }, async (span) => {
    const answered = await dispatch(tool, args, context);
    span.setAttribute('mcp.isError', answered.isError);
    return answered;
  });
}

async function dispatch(tool: string, args: Record<string, unknown>, context: RecordContext): Promise<RecordToolAnswer> {
  switch (tool) {
    case 'list_files': return await listFilesAnswer(context, args);
    case 'get_file': return await getFileAnswer(context, args);
    case 'get_file_history': return await getFileHistoryAnswer(context, args);
    case 'get_commit': return await getCommitAnswer(context, args);
    case 'get_repository': return await getRepositoryAnswer(context);
    default:
      return fail('unknown-tool', `${JSON.stringify(tool)} is no tool of this server: its tools are ${RECORD_TOOLS.map((one) => one.name).concat(['get_symbol', 'get_context', 'trace_flow', 'get_document_sections', 'search_pages', 'get_page', 'search_questions']).join(', ')} (src/mcp/records.ts)`);
  }
}

