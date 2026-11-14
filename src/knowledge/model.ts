/**
 * What a poll or a run states of a product (decision 0029, and decision 0036, section 8): the fill, its runs and the
 * writer, the status of the product, and where a piece of code is. A page and the data of its sections are not here:
 * the page mechanism reads the graph through `/graphql` (sections 2 to 7), and this module holds no shape of a block.
 */
import type { RefreshPlan } from '../loop/plan.js';
import type { AgentUsageReport } from '../obs/trace-report.js';
import type { ProducerRunOutcome } from '../fill/producer-outcomes.js';

/** Where a piece of code is: the file in a repository and its lines. */
export interface CodeLocation {
  /** The code repository's name in the manifest; null for the product repository. */
  repo: string | null;
  path: string;
  lineStart: number;
  lineEnd: number;
  /** The address of the source view at the first line. */
  href: string;
  /** The same place on the repository's web page (GitHub, GitLab, ...), when the repository's address is known; the host's name is the label. */
  web?: { host: string; url: string };
}

/** One page a refresh changed, as the wiki lists it: the page's id and the title its page shows. */
export interface ChangedPage {
  id: string;
  title: string;
}

/** The counts the repository's page states: the store's own answer, never a second reading of the checkout. */
export interface RepositoryCounts {
  readonly files: number;
  readonly commits: number;
  readonly folders: number;
}

/** One step of the newest run, as its trace states it (madarch-8bdc.2.5, item 4). */
export interface FillStepView {
  readonly step: string;
  readonly wallMs: number;
  readonly peakRssBytes: number;
  readonly startRssBytes: number;
  readonly slowest: readonly { readonly name: string; readonly count: number; readonly selfMs: number }[];
}

/** The newest run of the store's trace: its wall clock, its spans and its steps. */
export interface FillRunView {
  readonly runId: string;
  readonly state: string;
  /** Null denotes a whole fill; kinds are the resolved selection in dependency order. */
  readonly selection?: { readonly kinds: readonly string[]; readonly vertex?: string } | null;
  /** Persisted creation time, and last transition time only once the run ended. */
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly wallMs: number;
  readonly spans: number;
  /** The span names that took the most time of their own, the slowest first. */
  readonly slowest: readonly { readonly name: string; readonly count: number; readonly selfMs: number }[];
  readonly steps: readonly FillStepView[];
  /**
   * What the run's model calls cost, per kind, field and model (madarch-stm0.4, decision 0035, item 22), read from the
   * run's own trace: the model, the tokens in and out, the cost, and the bound a turn stopped at when one did.
   */
  readonly agentUsage: AgentUsageReport;
}

/** What a running fill has done so far, read from its trace (`src/obs/progress.ts`). */
export interface FillProgressView {
  readonly spans: number;
  readonly planned: number;
  readonly published: number;
  readonly failed: number;
  readonly blocked: number;
  readonly stages: Readonly<Record<string, { readonly planned: number; readonly published: number; readonly failed: number; readonly blocked: number }>>;
  readonly last: string | null;
}

/** A failure of a run, named where it stands: the file, the line and the path an engineer needs. */
export interface FillErrorView {
  readonly message: string;
  /** The file the failure was raised in, when the message names one. */
  readonly file?: string;
  /** The line of that file, when the message names one. */
  readonly line?: number;
  /** The path the failure is about: the product folder, a checkout, or the file a pass could not read. */
  readonly path?: string;
}

export interface FillState {
  /** Canonical fill_run identity, available before the first trace span. */
  runId?: string;
  /** The index was rebuilt because its deterministic readers changed. */
  rebuilt?: 'extractors-changed';
  /**
   * `paused` is a person's pause: the fill ended at its next commit and the run is taken up by the next fill.
   * `stopped` is a person's stop: the run ended now, and the pages it had rewritten stay as they are.
   */
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  /** The repository being read. */
  repository?: string;
  /** Commits read of the commits to read, in the repository being read. */
  commit?: number;
  commits?: number;
  /** The phase being read: the last commit's code first, then the history of every commit. */
  phase?: 'code' | 'history' | 'points';
  /** Commits the history covers, and how many of them are new since the last fill. */
  newCommits?: number;
  startedAt?: string;
  finishedAt?: string;
  /** Why the fill failed or could not start: the engineer's detail, in English, shown once behind a link. */
  message?: string;
  /** What kind of failure it was (`store`, `worker-start`, `worker-exit`, `fill`): the app words it in the reader's language. */
  code?: string;
  gaps?: number;
  /**
   * The pages this run changed: the pages of the facts it recorded or ended and the Markdown pages whose file it wrote.
   * Absent when the run did not say (it failed, or its boundary could not be read); empty when it changed no page
   * (madarch-u3vw2).
   */
  changed?: ChangedPage[];
  /** What a running fill has done so far, read from its run's trace (madarch-8bdc.2.5, item 2). */
  progress?: FillProgressView;
  /** The counts the run published: the end state's numbers. */
  counts?: RepositoryCounts;
  /** The current run's published producer results and failed attempts, including successful zero-result checks. */
  outcomes?: readonly ProducerRunOutcome[];
  /** The newest run's trace, once the store holds one: its time and its steps (items 2 and 4). */
  run?: FillRunView;
  /** Why the run failed, with the file, the line and the path it stands at. */
  error?: FillErrorView;
  /**
   * The declared repositories this run could not read, each with its path and the state it is in
   * (a checkout that holds no commit yet). A run reads the repositories it can, and says what it
   * did for these rather than refusing the product.
   */
  unread?: { repository: string; path: string; reason: string }[];
}

/** One agent unit of the writer, as the writer keeps it. */
export interface WriterUnit {
  /** The unit's id: `product:<slug>`, `domain:<slug>`, a document's page id behind `localized-source:`, `enrichment:<id>`. */
  unit: string;
  /**
   * The kind of page it writes, as the manifest declares it (`product`, `domain`, `doc.term`): the reader's own name for
   * the thing, never the writer's word for its work. Absent where the page is neither declared nor standing yet.
   */
  kind?: string;
  /** What a reader calls the page: its title once the page stands, the declaration's title before. Absent where neither exists. */
  title?: string;
  /** The id of the page it writes, as the wiki addresses it: the row's link, and the way to its journal. */
  page?: string;
  /** The page it writes, relative to the product repository: for the engineer, not the reader. */
  path: string;
  state: 'waiting' | 'writing' | 'written' | 'failed' | 'not-written';
  writeAttempts?: number;
  calls?: number;
  /** Why the unit's last write was refused, or why the agent failed: the file's line and rule, in words. */
  refusals?: { line: number; rule: string; message: string }[];
  /** Whether a journal of this machine holds this page: the fill page links to one only where it does (madarch-m38l.23). */
  journal?: boolean;
}

/** The agent stage that continues the fill: the chosen agent, the units and where they stand. */
export interface WriterState {
  /**
   * `idle` before any run, `waiting` while the code fill runs ahead of it. `paused` is a person's pause: the page being
   * written was finished and the run stands before the next one, and a server that starts again reads it from disk.
   * `stopped` is a person's stop: the run ended now and the page in progress stays as it was before the run.
   */
  state: 'idle' | 'waiting' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  agent: { id: string; label: string } | null;
  units: WriterUnit[];
  /** The unit writing now. */
  current?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  /** What kind of failure it was (`units`, `index`, `stopped`, `plan`, `agent`, `worker-exit`, `repositories`): the app words it in the reader's language. */
  code?: string;
  /** How many questions the agent asked in this run; the app says so in the reader's language. */
  asked?: number;
  /** Which pages this run touches and why; known once the code is read, before the agent starts. */
  plan?: RefreshPlan;
  /**
   * How many pages this run means to write in total (madarch-m38l.23): the product page, the domain pages it
   * declares, one page per document passage shown in the wiki's language, the guides and the pages of the other
   * kinds the manifest declares. The writer counts them before its first unit and counts them again when the
   * product page declares its domains, so the reader sees how much is left rather than how much was taken up.
   */
  total?: number;
}

/** What one agent costs to use and what the stage is bound by, stated for the reader before the press. */
export interface WriterBounds {
  /** The most revision requests the editorial pass may send one page (madarch-ztyq.9). */
  readonly editorialRequestsPerPage: number;
  /** Agent turns one unit may take. */
  turns: number;
  /** Minutes one unit may run. */
  minutes: number;
  /** Tool calls one unit may make. */
  toolCalls: number;
  /** Refused writes one unit may make before it fails. */
  writeAttempts: number;
  /** The most domains the product page may declare (the units after the product's). */
  maxDomains: number;
}

export interface AgentOffer {
  id: string;
  label: string;
  installed: boolean;
  /** `signed-in`, `not-signed-in` or `unknown`: the agent's own sign-in on this machine. */
  login: 'signed-in' | 'not-signed-in' | 'unknown';
  loginDetail: string;
  /** Where the adapter's program was found when it is installed; null when it is not installed or cannot be resolved. */
  where: string | null;
  /** The version madarch can read from the installed adapter; null when it cannot read one. */
  version: string | null;
  /** What installing the adapter fetches, when it is not installed; null when installed or nothing is offered. */
  install:
    | { kind: 'npm'; package: string; version: string; size: string; folder: string }
    | { kind: 'bundled'; program: string; note: string }
    | null;
}

/**
 * The product's state as one poll reads it (decision 0036, section 8): what the manifest declares and the graph holds.
 * A page and the data of its sections are not in it — they come from `/graphql` — and no count here is collected from
 * pages: `kinds` is the manifest's own list, each kind with the count one graph query answers.
 */
export interface WikiStatus {
  product: { name: string; id: string };
  /** `no-manifest` when `madarch/catalog.yaml` is absent. */
  manifest: 'ok' | 'not-filled' | 'no-manifest';
  /** Startup catalogue publication is separate from a fill and never opens a store for a poll. */
  publication?: 'pending' | 'done' | 'failed';
  publicationMessage?: string;
  manifestFile: string;
  /** The language the product's pages are written in; English when the manifest names none. */
  language: string;
  /** Each kind the manifest declares and how many entities of it the graph holds. */
  kinds: StatusKind[];
  purposes?: { id: string; labels: Record<string, string>; order: number; kinds: string[] }[];
  /** The groups of kinds, in the manifest's order. */
  groups: {
    group: string;
    labels: Record<string, string>;
    /** The group this one is a sub-area of; absent for a top-level group. */
    parent?: string;
    /** Whether the menu opens this group by itself (`open: true` in the manifest); absent when it stays closed. */
    open?: boolean;
  }[];
  repositories: { name: string; filled: boolean }[];
  /** The graph holds facts. */
  filled: boolean;
  /** A repository's fill stopped before its last commit: the graph holds part of it. */
  incomplete: boolean;
  fill: FillState;
  /** The agent stage after the code fill: what it does and the plan it holds, never the units it has done. */
  writer: Omit<WriterState, 'units'>;
  bounds: WriterBounds;
  /** The agent chosen for this product, when one was. */
  chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
  /** What each role the manifest declares changes (decision 0031); a role it does not declare reads everything open. */
  roles: Record<string, { open?: string[]; lead: string[] }>;
  /** This is madarch's own wiki (documentation): no fill is offered. Set by the server, not by the product. */
  own?: boolean;
}

/** One kind the manifest declares, with how many entities of it the graph holds. */
export interface StatusKind {
  kind: string;
  count: number;
}
