/**
 * The wiki's API, as served by the madarch server (docs/changes/draft-product/
 * change.md, "The API"). The app holds no document bytes itself: everything it
 * shows is read from this API, and every refusal reaches the reader as a short
 * message naming what was asked for.
 */

export type Product = {
  /** The manifest id; absent for a manifestless product response. */
  id?: string;
  name: string;
  /** The product folder's name on this machine (the sidebar footer names it). */
  folder?: string;
};

export type DocumentField = {
  name: string;
  value: string;
  line: number;
};

/** Whom a link field names, resolved to the page it opens when it can. */
export type GrownFromEntry = {
  id: string;
  via: string;
  path?: string;
  title?: string;
  kind?: string;
};

export type BacklinkEntry = {
  path: string;
  title: string;
  id?: string;
  /** The declaring kind's backlink label for the field that named this document. */
  label?: string;
};

/** The set's document a page is, as the server read its form. */
export type PageDocument = {
  kind?: string;
  id?: string;
  status?: string;
  fields: DocumentField[];
  grewFrom: GrownFromEntry[];
  backlinks: BacklinkEntry[];
};

/** One structural finding the registry's reads computed: at file, line and path. */
export type PageStructuralFinding = {
  rule: string;
  file: string;
  line: number;
  what: string;
};

/** One finding of the set's product check, at file, line and path. */
export type PageFinding = {
  rule: string;
  file: string;
  line: number;
  what: string;
  why?: string | null;
  note?: boolean;
};

export type PageCheck = { ran: true; version: string } | { ran: false; message: string };

export type PageMeta = {
  path: string;
  title: string;
  url: string;
  /** The kind the page's registry names it, when the product holds a registry that names it. */
  kind?: string;
  /** The status the document's own text computes, when one is derivable. */
  status?: string;
};

/**
 * How the wiki serves the product's kinds registry (the owner's refinement
 * of decision 0021, contract v1): known names the version the wiki reads;
 * unknown carries the notice whose words the wiki shows as a banner, with
 * the pages degraded to plain ones. A product with no registry carries no
 * `contract` at all.
 */
export type PageContract = { known: true; version: number } | { known: false; version?: number; message: string };

export type PageList = {
  pages: PageMeta[];
  revision: string;
  /** The registry's serving state, when the product holds a kinds registry. */
  contract?: PageContract;
};

/** Question states derived from the configured answer sections; they are not written to the document. */
export type QuestionState = 'open' | 'answered' | 'not-applicable';

/** One question, as the questions API carries it. */
export type QuestionEntry = {
  /** The path within the product of the question's document. */
  path: string;
  /** The document's configured identity. */
  id: string;
  /** The identity line's title: the question in one line. */
  title: string;
  /** The `## Question` section: what is not known, in full. */
  question: string;
  /** The value of the configured answerer field. */
  who: string;
  /** Values of the configured references field, split and trimmed. */
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
  kindName?: string;
  answererLabel?: string;
  concernsLabel?: string;
};

export type ProductOverviewProjection = {
  audience?: string;
  problem?: string;
  outcome?: string;
  currentMilestone?: { title?: string; state?: string; nextStep?: string; path?: string };
  errors?: { role: string; document: string; section: string; message: string }[];
};

export type ProductWithAudience = Product & {
  /** The legacy audience alias, equal to overview.audience when both are present. */
  audience?: string;
  /** Optional normalized facts projected from product-declared document sections. */
  overview?: ProductOverviewProjection;
};

export type Page = {
  path: string;
  title: string;
  markdown: string;
  changedAt?: string;
  revision?: string;
  document?: PageDocument;
  /** This page's findings of the set's product check; absent where an older server sent none. */
  findings?: PageFinding[];
  /** This page's structural findings the registry's reads computed; absent where an older server sent none. */
  structural?: PageStructuralFinding[];
  check?: PageCheck;
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
  readJson<QuestionList>('read the questions', '/api/questions', signal);

export const getArchitecture = (signal?: AbortSignal): Promise<Architecture> =>
  readJson<Architecture>('read the architecture', '/api/architecture', signal);

export const getPages = (signal?: AbortSignal): Promise<PageList> =>
  readJson<PageList>('read the page list', '/api/pages', signal);

export const getPage = (path: string, signal?: AbortSignal): Promise<Page> =>
  readJson<Page>(`read the page ${path}`, `/api/page?path=${encodeURIComponent(path)}`, signal);

export type DiscussionRange = { start: number; end: number; quote: string; before: string; after: string; paragraph: number; from: number; to: number };
export type DiscussionMessageEntry = { message: string; author: string; time: string; body: string };
export type DiscussionEntry = { thread: string; message: string; document: string; anchor: Record<string, unknown>; author: string; time: string; status: string; body: string; messages?: DiscussionMessageEntry[] };
export const getDiscussions = (path: string, signal?: AbortSignal): Promise<{ discussions: DiscussionEntry[] }> =>
  readJson<{ discussions: DiscussionEntry[] }>(`read discussions on ${path}`, `/api/discussions?path=${encodeURIComponent(path)}`, signal);
export type DiscussionWriteRequest = { document: string; range: DiscussionRange; body: string } | { document: string; action: 'page'; body: string } | { document: string; action: 'reply' | 'resolve'; thread: string; body?: string } | { document: string; action: 'recover'; thread: string; range: DiscussionRange };
export async function postDiscussion(input: DiscussionWriteRequest): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/discussions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  } catch (error) {
    throw new RequestError('send the discussion', error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    let message = `the server answered ${response.status}`;
    try { const body = await response.json() as { message?: unknown }; if (typeof body.message === 'string') message = body.message; } catch { /* status is enough */ }
    throw new RequestError('send the discussion', message);
  }
}


/** The manifest stage sections and task groups the server read. */
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
  /** What the stage holds nothing of yet: a kind the registry names carries its own next-step hint, the mechanism's material carries its kind alone. */
  findings?: string[];
  tasks?: TaskFeature[];
  notes?: StageNote[];
  sections?: StageSectionLink[];
  /** The stage's name as the product's registry gives it, when one stands. */
  name?: string;
};

export type StagesIndex = {
  stages: StageSection[];
  completeness?: { computedAt: string; sourceRevision: string };
  problems: { where: string; message: string }[];
};

export const getStages = (signal?: AbortSignal): Promise<StagesIndex> =>
  readJson<StagesIndex>('read the stages', '/api/stages', signal);

/** One link field a kind's documents may carry, as the registry declares it. */
export type RegistryKindLink = {
  /** The form field's name the documents of the kind write the link under. */
  field: string;
  /** The kinds the field's link may name. */
  targets: string[];
  /** The label the linked page shows its backlinks under; left out, the wiki words them. */
  backlink?: string;
  /** Whether the field names one document or many. */
  cardinality?: 'one' | 'many';
  /** Whether a document of the kind must carry the link at all. */
  required?: boolean;
};

/** The product's supported reader-facing registry labels; older contract-1 registries omit this pair. */
export type RegistryLabels = {
  en: string;
  ru: string;
};

/** One kind as the product's registry names it. */
export type RegistryKindEntry = {
  name: string;
  /** When absent, the shell uses `name` unchanged. */
  labels?: RegistryLabels;
  prefix: string;
  folder: string;
  stage: string;
  hint: string;
  /** The statuses a document of the kind may carry in its `Status` field. */
  statuses?: string[];
  /** The link fields the kind's documents may carry. */
  links?: RegistryKindLink[];
};

/** One stage of the registry's life cycle, in its own order. */
export type RegistryStageEntry = {
  id: string;
  /** The stage's manifest name; the id stands in where it is left out. */
  name?: string;
  /** When absent, the shell uses `name`, or `id` if the manifest has no name. */
  labels?: RegistryLabels;
};

export type RegistryRefusal = {
  file: string;
  line: number;
  path: string;
  message: string;
};

/** The kinds registry as the server answers it: whole, refused, or absent. */
export type RegistryOffer =
  | { present: false }
  | { present: true; stages: RegistryStageEntry[]; kinds: RegistryKindEntry[] }
  | { present: true; refused: RegistryRefusal[] };

export const getRegistry = (signal?: AbortSignal): Promise<RegistryOffer> =>
  readJson<RegistryOffer>('read the product kinds registry', '/api/registry', signal);

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
  url?: string;
  /** The branch the manifest declares, when it declares one. */
  branch?: string;
  /** The checkout's state under `repos/`. */
  path: string;
  state: 'checked-out' | 'not-checked-out' | 'unreadable';
  /** The checkout's HEAD, when a checkout is there and git could read a commit of it. */
  head?: RepoHead;
  /** The README at the checkout's root, when it has one and its bytes could be read. */
  files?: string[];
  readme?: { file: string; markdown: string };
  /** Why the row is not the ordinary one, naming the path — carried for `unreadable`. */
  problem?: string;
};

export type ReposList = {
  repos: RepoEntry[];
};

export const getRepos = (signal?: AbortSignal): Promise<ReposList> => readJson<ReposList>('read the repositories', '/api/repos', signal);
