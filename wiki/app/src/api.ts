/**
 * The wiki's API, as served by the madarch server (docs/changes/draft-product/
 * change.md, "The API"). The app holds no document bytes itself: everything it
 * shows is read from this API, and every refusal reaches the reader as a short
 * message naming what was asked for.
 */

export type Product = {
  id: string;
  name: string;
  /** The product folder's name on this machine (the sidebar footer names it). */
  folder?: string;
};

export type PageMeta = {
  path: string;
  title: string;
  url: string;
};

export type PageList = {
  pages: PageMeta[];
  revision: string;
};

/** The states an open question stands in, the set's own three (computed, never written). */
export type QuestionState = 'open' | 'answered' | 'not-applicable';

/** One open question, as the questions API carries it. */
export type QuestionEntry = {
  /** The path within the product of the question's document. */
  path: string;
  /** The document's id, `Q-004` for example. */
  id: string;
  /** The identity line's title: the question in one line. */
  title: string;
  /** The `## Question` section: what is not known, in full. */
  question: string;
  /** The `Who can answer:` field. */
  who: string;
  /** The `Concerns:` field's ids, split and trimmed. */
  concerns: readonly string[];
  /** The computed state: `open`, `answered` or `not-applicable`. */
  state: QuestionState;
  /** The answer's text when the question is closed. */
  answer?: string;
  /** The file's last modification time, ISO. */
  changedAt?: string;
};

export type QuestionList = {
  questions: QuestionEntry[];
  openCount: number;
};

export type ProductWithAudience = Product & {
  /** The audience the product's vision names; absent while the vision is not written. */
  audience?: string;
};

export type Page = {
  path: string;
  title: string;
  markdown: string;
  changedAt?: string;
  revision?: string;
};

/** An API read that failed, with a message naming what was asked for. */
export class RequestError extends Error {
  constructor(what: string, reason: string) {
    super(`Could not ${what}: ${reason}`);
    this.name = 'RequestError';
  }
}

/** Reads one JSON answer from the API, naming `what a reader was waiting for` on failure. */
export async function readJson<T>(what: string, url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error: unknown) {
    // An aborted read is rethrown as itself, so the caller can tell its own
    // timeout abort from a real failure (finding 2.10).
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the request to ${url} failed (${reason})`);
  }
  if (!response.ok) {
    let reason = `the server answered ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'message' in (body as Record<string, unknown>) &&
        typeof (body as Record<string, unknown>).message === 'string'
      ) {
        reason = String((body as Record<string, unknown>).message);
      }
    } catch (error: unknown) {
      // A body read that the abort interrupted is the timeout, not a
      // refusal: rethrow it as itself so the caller names the timeout
      // instead of "the server answered 503" (finding 2.11).
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // keep the status line as the reason
    }
    throw new RequestError(what, reason);
  }
  try {
    return (await response.json()) as T;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RequestError(what, `the answer from ${url} was not JSON (${reason})`);
  }
}

/** One view of the Architecture section, as /api/architecture names it. */
export type ArchitectureView = {
  scope: string;
  title: string;
  mermaid: string;
  table: { columns: string[]; rows: string[][] };
  opens: string[];
  up?: string;
};

/** One relation row of an element page. */
export type ElementRelation = {
  relationId: string;
  other: string;
  name?: string;
  interface?: string;
  action?: string;
};

/** One element of the model, with its relations and the pages naming it. */
export type ArchitectureElement = {
  id: string;
  name: string;
  kind: string;
  technology?: string;
  parent?: string;
  ancestors: string[];
  outgoing: ElementRelation[];
  incoming: ElementRelation[];
  provides: string[];
  namedBy: string[];
};

/** One compile problem of the model, as the Architecture section shows it. */
export type ArchitectureError = {
  file: string;
  line: number;
  path: string;
  message: string;
};

/** The whole Architecture answer of /api/architecture. */
export type Architecture = {
  /** What the shown model was built from less than the whole input, each named at its place. */
  notes: ArchitectureError[];
  model?: { elements: ArchitectureElement[]; views: ArchitectureView[] };
  errors: ArchitectureError[];
  warnings: ArchitectureError[];
  sources: string[];
};

export const getProduct = (signal?: AbortSignal): Promise<ProductWithAudience> =>
  readJson<ProductWithAudience>('read the product', '/api/product', signal);

export const getQuestions = (signal?: AbortSignal): Promise<QuestionList> =>
  readJson<QuestionList>('read the open questions', '/api/questions', signal);

export const getArchitecture = (signal?: AbortSignal): Promise<Architecture> =>
  readJson<Architecture>('read the architecture', '/api/architecture', signal);

export const getPages = (signal?: AbortSignal): Promise<PageList> =>
  readJson<PageList>('read the page list', '/api/pages', signal);

export const getPage = (path: string, signal?: AbortSignal): Promise<Page> =>
  readJson<Page>(`read the page ${path}`, `/api/page?path=${encodeURIComponent(path)}`, signal);

/** The stage sections and task groups the stage index answers, the server's own shapes. */
export type StageArtifact = {
  path: string;
  title: string;
  kind: string;
  /** Whether the page reader serves this path; false renders the artifact as text, never a dead link. */
  served: boolean;
};

export type TaskEntry = {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'done';
};

export type TaskFeature = {
  id: string;
  title: string;
  open: number;
  inProgress: number;
  done: number;
  tasks: TaskEntry[];
};

export type StageSectionLink = {
  kind: 'architecture' | 'repositories';
  present: boolean;
};

export type StageNote = {
  where: string;
  line: number;
  message: string;
};

export type StageSection = {
  id: string;
  artifacts: StageArtifact[];
  missing: { kind: string; skill: string }[];
  tasks?: TaskFeature[];
  notes?: StageNote[];
  sections?: StageSectionLink[];
  empty: boolean;
};

export type StagesIndex = {
  stages: StageSection[];
  problems: { where: string; message: string }[];
};

export const getStages = (signal?: AbortSignal): Promise<StagesIndex> =>
  readJson<StagesIndex>('read the stages', '/api/stages', signal);

/** The checkout's last commit, as the server's git read reported it. */
export type RepoHead = {
  /** The short sha HEAD answers. */
  sha: string;
  /** The commit's subject line. */
  subject: string;
  /** The commit's time, ISO 8601 with an offset. */
  committedAt: string;
};

/** One declared code repository, as `GET /api/repos` answers it. */
export type RepoEntry = {
  /** The repository's name in the manifest. */
  name: string;
  /** The url the manifest declares. */
  url: string;
  /** The branch the manifest declares, when it declares one. */
  branch?: string;
  /** The checkout's state under `repos/`. */
  state: 'checked-out' | 'not-checked-out' | 'unreadable';
  /** The checkout's HEAD, when a checkout is there and git could read a commit of it. */
  head?: RepoHead;
  /** The README at the checkout's root, when it has one and its bytes could be read. */
  readme?: { file: string; markdown: string };
  /** Why the row is not the ordinary one, naming the path — carried for `unreadable`. */
  problem?: string;
};

export type ReposList = {
  repos: RepoEntry[];
};

export const getRepos = (signal?: AbortSignal): Promise<ReposList> => readJson<ReposList>('read the repositories', '/api/repos', signal);
