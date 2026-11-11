/**
 * The shapes the knowledge wiki's API answers (`src/knowledge/model.ts` and
 * `src/server/knowledge.ts` in the engine): the app draws these and holds no
 * knowledge of any kind, template or block beyond them.
 */

type Finding = { file: string; line: number; message: string };

export type CodeLocation = { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; web?: { host: string; url: string } };

export type EntityRef = {
  id: string;
  kind: string;
  label: string;
  href: string | null;
  location?: CodeLocation;
  broken?: string;
};

type RefRow = { entity: EntityRef; note?: string; noteKey?: 'named' | 'groundedWith' | 'statements' | 'links'; noteArgs?: Record<string, string | number> };

/** One row of a history block (the engine's `HistoryRow`): when, who and what, with the figures its facts give. */
type HistoryRow = {
  when?: string;
  who?: string;
  text: string;
  entity?: EntityRef;
  figures: { kind: 'added' | 'removed' | 'symbols' | 'commits' | 'files' | 'module' | 'reachable' | 'firstParent' | 'merges' | 'nonMerge' | 'authors' | 'since' | 'until' | 'both' | 'onlyThis' | 'onlyOther' | 'authoredAt' | 'committedAt' | 'effectiveAt' | 'similarity'; value: string }[];
};

/** One list of a history block: the commits it shows, or the files they touched. */
type HistorySection = { repository?: string; role: 'commits' | 'files' | 'summary' | 'hotspots' | 'authors' | 'coupling' | 'renames' | 'parents' | 'branches' | 'snapshots'; total: number; rows: HistoryRow[] };

/** One row of a properties block (the engine's `PropertyRow`). */
export type PropertyRow = { name: string; value: string; label?: string; nameKey?: 'authoredAt' | 'committedAt' | 'subject' | 'merge' | 'language' | 'symbol' | 'method' | 'path' | 'marker' | 'text' | 'line' | 'service' | 'secret'; valueKind?: 'date' | 'boolean' | 'code' };
type MemberRow = { entity: EntityRef; name: string; anchor: string; values: PropertyRow[]; readers: EntityRef[]; writers: EntityRef[] };

/** One note under a history block (the engine's `HistoryNote`): a key the app writes in the reader's language. */
export type HistoryNote = { key: 'manyCommits' | 'manyFiles' | 'noCounts' | 'merge' | 'noFiles' | 'partialFiles' | 'symbolsCut' | 'population' | 'observedAuthorship' | 'cochangeNotCause' | 'noImport' | 'importCoverage' | 'membershipCoverage' | 'dateAnomaly' | 'mergeBranch' | 'unchangedMove'; args?: Record<string, string | number> };

/** One member of a contract's definition (the engine's `DefinitionMember`). */
type DefinitionMember = { anchor: string; label: string; detail?: string; href: string | null; badge?: string; detailTotal?: number };

/** Where the rest of a history lives (the engine's `HistoryMore`): the kind's listing, and its words in the reader's language. */
type HistoryMore = { href: string; label: string };

export type RelatedGroup = {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  rows: { entity: EntityRef; count: number; hops?: number; sources?: readonly string[] }[];
};

export type CallRow = { entity: EntityRef; sites: number; site?: CodeLocation };

export type DiagramNode = { id: string; kind: string; label: string; href: string | null; hops?: number };
export type DiagramEdge = { from: string; to: string; relation: string; count: number };
export type DiagramMore = { node: string; relation: string; direction: 'out' | 'in'; hidden: number };
export type Neighborhood = {
  center: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  more: DiagramMore[];
  relations: { relation: string; direction: 'out' | 'in'; count: number }[];
};
/** The Files page's read (madarch-j9ao.1), as the server answers it: the same shape as `src/knowledge/files-map.ts`. */
export type FilesMapArea = 'lines' | 'bytes';
export type FilesMapColour = 'language' | 'heat' | 'age' | 'authors';
export type FilesMapWindow = '30d' | '90d' | '1y' | 'all';
export type FilesMapEngine = 'echarts' | 'mermaid';
export type FilesMapFile = {
  id: string;
  path: string;
  href: string | null;
  lines: number | null;
  bytes: number | null;
  language: string | null;
 /** Every open opinion's language and the producer that stated it. */
  languages: { language: string; saidBy: string }[];
  /** Commits touching the file: 30 days, 90 days, a year, all. */
  heat: [number, number, number, number];
  last: string | null;
  authors: string[];
};
export type FilesMapLanguage = { name: string; files: number; lines: number; bytes: number };
export type FilesMapTotals = { files: number; lines: number; bytes: number; withoutLines: number; languages: FilesMapLanguage[]; other: number };
export type FilesMap = {
  repository: string;
  folder: string;
  files: FilesMapFile[];
  totals: FilesMapTotals;
  windows: { d30: string; d90: string; d365: string };
  graphTotal: number | null;
};

export type DiagramRenderer = 'likec4' | 'mermaid' | 'archify' | 'echarts';
type ViewType = 'c4-context' | 'c4-container' | 'c4-component' | 'sequence' | 'er' | 'state' | 'deployment' | 'relations';
type ViewSpec = { type: ViewType; subject: string; scope?: string; entry?: string };
export type ViewElement = {
  id: string;
  label: string;
  /** The name the diagram draws when the entity's own is too wide; the list keeps `label`. */
  short?: string;
  kind: string;
  detail?: string;
  href: string | null;
  location?: CodeLocation;
  dashed: boolean;
  parent?: string;
  drill?: { spec: ViewSpec; title: string };
  columns?: { name: string; type?: string; key?: boolean; fk?: boolean }[];
  standsFor?: number;
};
type ViewEdge = { from: string; to: string; label: string; dashed: boolean; why?: string; step?: number; kind?: string; note?: string; href?: string | null; location?: CodeLocation };
/** One view of a diagrams block: the model, the renderers that draw it (the chosen one first) and the query that asks the server for it again. */
export type DiagramView = {
  spec: ViewSpec;
  title: string;
  label: string;
  elements: ViewElement[];
  edges: ViewEdge[];
  fullElements?: ViewElement[];
  fullEdges?: ViewEdge[];
  notes: string[];
  empty: string | null;
  up?: { spec: ViewSpec; title: string };
  marker: string | null;
  renderers: DiagramRenderer[];
  mermaidSource: string;
  /** The smallest node title the first view keeps, in pixels; left out, eleven on a page and nine in full screen. */
  titleFloor?: number;
  query: string;
};

export type OverviewSection = 'about' | 'how' | 'data' | 'terms' | 'status' | 'reading';
export type OverviewSource = { label: string; href: string };
export type OverviewItem = { label: string; value?: string; href?: string; note?: string; source?: OverviewSource };
export type OverviewParagraph = { text: string; source?: OverviewSource };
export type OverviewBlock = {
  type: 'overview';
  section: OverviewSection;
  title: string;
  paragraphs?: OverviewParagraph[];
  rows?: OverviewItem[];
  links?: OverviewItem[];
  diagrams?: { type: 'diagrams'; title: string; renderer: DiagramRenderer; views: DiagramView[] };
  absent?: { message: string; href: string; label: string };
};

type BlockShape =
  | { type: 'guide'; data: { guide: { id: string; kind: 'administrator-guide' | 'user-guide'; title: string; locale: 'en' | 'ru'; context: { valid: string; known: string; state: string; repositories: { name: string; commit: string }[] }; unitVersion: string; inputDigest: string; prerequisites: string[]; gaps: string[]; procedures: { id: string; title: string; goal: string; role: string; prerequisites: string[]; steps: { id: string; title: string; cwd: string; environment: string; inputs: { name: string; description: string; secret: boolean }[]; instruction: { kind: 'command' | 'http'; content: string }; expected: { status: number; observation: string }; grounds: { repository: string; commit: string; path: string; line: number; endLine: number }[] }[] }[] }; walk: { status: 'passed' | 'failed' | 'not-walked'; diagnostics: { file: string; line: number; path: string; code: string; message: string }[] }; markdown: string; diagnostics: { file: string; line: number; path: string; code: string; message: string }[]; coverage: 'procedures' | 'gap-only'; sourceViewWarning?: string; grounds: { procedure: string; step: string; repository: string; commit: string; path: string; line: number; endLine: number; href: string }[] } }
  | { type: 'markdown'; markdown: string }
  | { type: 'term'; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[]; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'graph'; title: string; neighborhood: Neighborhood; depth: number; shown: number; total: number }
  | { type: 'diagrams'; title: string; renderer: DiagramRenderer; views: DiagramView[] }
  | { type: 'relations'; title: string; renderer: DiagramRenderer; views: DiagramView[]; groups: RelatedGroup[]; linksHere: { entity: EntityRef; relations: string[] }[]; more: { relation: string; direction: 'out' | 'in'; hidden: number }[]; empty?: string }
  | { type: 'treemap'; title: string; data: FilesMap; area: FilesMapArea; colour: FilesMapColour; window: FilesMapWindow; engine: FilesMapEngine; mermaid: string; mermaidDrawn: number; mermaidOmitted: number; notes: string[] }
  | { type: 'files'; title: string; data: FilesMap; area: FilesMapArea; colour: FilesMapColour; window: FilesMapWindow; pageSize: number; notes: string[] }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'refs'; title: string; total: number; rows: RefRow[]; hideEmpty?: boolean }
  | { type: 'properties'; title: string; rows: PropertyRow[] }
  | { type: 'members'; title: string; kindLabel?: string; kindLabelName?: string; rows: MemberRow[]; total: number }
  | { type: 'stated'; title: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; commit: string | null; single?: boolean } }
  | { type: 'definition'; title: string; format: string; contract: string; fullPath?: string; location?: CodeLocation; members: DefinitionMember[]; membersTotal: number; membersShown: number; memberCuts: { channel: string; total: number; shown: number }[]; spec: { text: string; lines: number }; document?: Record<string, unknown>; descriptions?: {text: string; path: string; line: number; fullPath: string}[]; selection?: { method: string; path: string; operationId: string }; protobuf?: ProtoDocumentation; diagnostics?: ContractDiagnostic[] }
  | { type: 'history'; title: string; sections: HistorySection[]; notes: HistoryNote[]; more?: HistoryMore }
  | OverviewBlock
  | { type: 'deferred'; block: string; title: string; id: string }
  | { type: 'repository'; title: string; data: RepositoryBlockData; run?: { finishedAt: string; wallMs: number }; unread?: { repository: string; path: string; reason: string }[] }
  | { type: 'folder'; title: string; data: FolderBlockData }
  | { type: 'file'; title: string; data: FileBlockData }
  | { type: 'problem'; block: string; message: string; file: string; line: number; diagnostic?: ContractDiagnostic };

/** One block of a page; `name` is the template's block it was made from (`implementedby` and `linkedfrom` both draw as `refs`), which the manifest's roles name. */
export type Block = BlockShape & { name?: string; emptyNote?: string };

export type Resolution =
  | { state: 'ok'; target: string; kind: string; label: string; href: string | null; note?: string; location?: CodeLocation; entity?: string }
  | { state: 'broken'; target: string; reason: string; why?: BrokenWhy };

export type BrokenWhy =
  | { code: 'empty' }
  | { code: 'no-entity'; key: string }
  | { code: 'no-path' }
  | { code: 'no-document'; path: string }
  | { code: 'no-section'; path: string; anchor: string; repos: string };

export type HistoryContext = { repo: string; at: string; coverage: 'covered' | 'unfilled' | 'before' | 'unknown'; commit: string | null; effectiveAt: string | null; until: string | null; landmarks?: { offered: number; covered: number; limit: number; overflow: boolean; omitted: number; first: string | null; last: string | null; diagnostics: { ref: string; object: string; reason: string }[] }; points: { name: string; commit: string; covered: boolean }[] };

export type PageModel = {
  /** How many problems name this entity (madarch-m38l.19); absent means none were counted. */
  problems?: number;
  historyNavigation?: { repo: string; points: { name: string; commit: string; covered: boolean }[]; landmarks?: NonNullable<HistoryContext['landmarks']> }[];
  historicalAbsent?: boolean;
  history?: HistoryContext;
  id: string;
  kind: string;
  title: string;
  trail: EntityRef[];
  blocks: Block[];
  resolutions: Record<string, Resolution>;
  findings: Finding[];
  notes: string[];
  redirect?: { id: string; anchor: string };
  /** The planned change this page stands in, and the statements of it a task's grounds reach (madarch-m38l.14). */
  planned?: { entity: PlannedMarkView | null; statements: (PlannedMarkView & { sentence: string })[]; note?: string };
  /** The runs of this machine whose journal holds this page, oldest first; absent when no run wrote it (madarch-m38l.23). */
  journal?: string[];
};

type Origin = 'agent' | 'person' | 'code' | 'history';

/** The form a kind's listing page takes (`listing:` of the manifest); no screen of the app holds a kind of its own. */
type KindListing = 'operations' | 'glossary';
/** Where a kind stands in the navigation (`nav:` of the manifest). */
type KindNav = 'own-page' | 'loop';

/** What produces a kind today, from its declaration (madarch-8bdc.2.5): `person` is not a stage. */
type KindProducer = 'extract' | 'documents' | 'writer' | 'history' | 'person';

/** One kind of the entity catalogue: every declared kind, filled or not. */
export type CatalogKindView = {
  kind: string;
  /** Derived by the app from the catalogue groups when the answer leaves it out. */
  area?: string;
  subgroup: string;
  labels?: Record<string, { one: string; many: string }>;
  descriptions?: Record<string, string>;
  count: number;
  statements?: number;
  page: boolean;
  producer?: KindProducer;
  /** Who fills the kind: its own producer (plugin or built-in pass), a person, or the general agent plugin. */
  fillWith?: 'own' | 'agent' | 'person';
  filled: boolean;
  /** The plugins the manifest binds this kind's fields to: the fillers that need no model. */
  plugins?: string[];
  /** The kinds this one's declaration says must finish first. */
  dependsOn?: string[];
  /** The newest generation of the kind's fill turn (`planned`, `running`, `published`, `failed`, ...); absent when it never ran. */
  turn?: string;
  /** How much of the kind stands: filled, partial (a turn failed or did not finish), or never filled. */
  state: 'filled' | 'partial' | 'never';
  /** What one fill of this kind would cost, when a producer declares a figure; absent means unknown. */
  estimate?: KindEstimate;
};

/** One kind's estimate (madarch-stm0.6): a measured volume times a per-unit figure, or unknown. */
export type KindEstimate = { volume: number | null; unit: 'vertices'; tokensPerUnit: number | null; secondsPerUnit: number | null; tokens: number | null; seconds: number | null };

/** The catalogue's fill selection as the store keeps it (madarch-stm0.6). */
export type FillSelectionView = { selected: string[]; agent: string | null; tokenCap: number | null; savedAt: string };

/** The catalogue's own answer: the groups, every declared kind, and the findings that name a missing translation. */
export type CatalogView = {
  product: { name: string; id: string };
  language: string;
  groups: GroupSummary[];
  kinds: CatalogKindView[];
  findings: Finding[];
};

/** One page or entity a search found: its name, its address, and the text around the match in a page's body. */
type SearchRow = { id: string; kind: string; title: string; href: string; excerpt?: string };

/** The rows one kind of the wiki's search found, with how many it holds in all. */
type SearchGroup = { kind: string; total: number; rows: SearchRow[] };

/** The wiki's own answer to a search: the rows grouped by kind, and how many were found. */
export type SearchView = { product: { name: string; id: string }; language: string; query: string; groups: SearchGroup[]; total: number };

export type KindSummary = {
  kind: string;
  source: 'graph' | 'markdown' | 'document';
  count: number;
  statements?: number;
  single: boolean;
  group?: string;
  origins: Origin[];
  descriptions?: Record<string, string>;
  labels?: Record<string, { one: string; many: string }>;
  /** The form the kind's listing page takes; absent for the plain table of names and places. */
  listing?: KindListing;
  /** Where the kind stands in the navigation; absent for a kind page among the pages by kind. */
  nav?: KindNav;
};

export type GroupSummary = { group: string; labels: Record<string, string>; /** The navigation's one-or-two-word label per language; the full name when it is absent. */ short?: Record<string, string>; /** The group this is a sub-area of; absent for a top-level group. */ parent?: string; /** The group the menu opens by itself; absent when it stays closed until opened. */ open?: boolean };

export type OperationMetadata = { contracts: {entity: EntityRef; protocol: string; directions?: ('publish' | 'subscribe')[]; directionStatus?: 'known' | 'unavailable'; producedBy?: EntityRef[]; consumedBy?: EntityRef[]}[]; implementedBy: EntityRef[]; calledBy: EntityRef[]; cuts: {relation: string; shown: number; total: number}[] };
export type EntityListing = { kind: string; total: number; rows: EntityRef[]; next: string | null; operations?: Record<string, OperationMetadata> };

/** One page a refresh changed, as the top bar lists it: the page's id and the title its page shows. */
type ChangedPage = { id: string; title: string };

/** The counts the repository page states. */
export type RepositoryCounts = { files: number; commits: number; folders: number };

/** The repository the graph holds, as the wiki's pages state it (madarch-8bdc.2.5, item 3). */
export type RepositoryFactsView = {
  id: string;
  name: string;
  url: string;
  defaultBranch: string | null;
  asIsCommit: string | null;
  counts: RepositoryCounts;
  gaps: { what: string; reason: string }[];
  steps: { tree: boolean; history: boolean };
};

/** One step of the newest run, as its trace states it. */
export type FillStepView = {
  step: string;
  wallMs: number;
  peakRssBytes: number;
  startRssBytes: number;
  slowest: { name: string; count: number; selfMs: number }[];
};

/** The newest run's trace: its wall clock, its spans and its steps. */
export type FillRunView = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  spans: number;
  slowest: { name: string; count: number; selfMs: number }[];
  steps: FillStepView[];
};

/** What a running fill has done so far, read from its trace. */
export type FillProgressView = {
  spans: number;
  planned: number;
  published: number;
  failed: number;
  blocked: number;
  stages: Record<string, { planned: number; published: number; failed: number; blocked: number }>;
  last: string | null;
};

/** A failed run's error, with the file, the line and the path it stands at. */
export type FillErrorView = { message: string; file?: string; line?: number; path?: string };

export type FillState = {
  rebuilt?: 'extractors-changed';
  /** `paused` and `stopped` are a person's press (madarch-m38l.17): a paused run ends at the next page boundary and is
   * taken up where it stopped; a stopped one ends now and the pages it rewrote stand. */
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  repository?: string;
  phase?: 'code' | 'history' | 'points';
  newCommits?: number;
  commit?: number;
  commits?: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  /** What kind of failure it was; the app words it in the reader's language and keeps `message` as the detail. */
  code?: string;
  gaps?: number;
  /** The pages the run changed; absent when it did not say, empty when it changed none (madarch-u3vw2). */
  changed?: ChangedPage[];
  /** What a running fill has done so far, read from its run's trace (madarch-8bdc.2.5, item 2). */
  progress?: FillProgressView;
  /** The counts the run published: the end state's numbers. */
  counts?: RepositoryCounts;
  /** The newest run's trace, once the store holds one: its time and its steps. */
  run?: FillRunView;
  /** Why the run failed, with the file, the line and the path it stands at. */
  error?: FillErrorView;
  /** The declared repositories this run could not read, each with its path and the state it is in. */
  unread?: { repository: string; path: string; reason: string }[];
};

export type WriterUnit = {
  unit: string;
  path: string;
  /** The kind the manifest declares for the page this unit writes, and the page's title: what a reader calls it (madarch-m38l.23). */
  kind?: string;
  title?: string;
  /** The page this unit writes, once its id is known: the address its link opens. */
  page?: string;
  state: 'waiting' | 'writing' | 'written' | 'failed' | 'not-written';
  writeAttempts?: number;
  calls?: number;
  refusals?: { line: number; rule: string; message: string }[];
  /** Whether a journal on this machine holds this page: the row links to one only where it does (madarch-m38l.23). */
  journal?: boolean;
};

export type WriterState = {
  /** A person's press (madarch-m38l.17): `paused` ends the run before the next page, `stopped` ends it now. */
  state: 'idle' | 'waiting' | 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  agent: { id: string; label: string } | null;
  units: WriterUnit[];
  current?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  code?: string;
  asked?: number;
  /** Which pages this run touches and why; known once the code is read, before the agent starts. */
  plan?: RefreshPlan;
  /** How many pages this run means to write in total; absent until the writer counts them. */
  total?: number;
};

export type WriterBounds = { turns: number; minutes: number; toolCalls: number; writeAttempts: number; maxDomains: number; editorialRequestsPerPage: number };

export type AgentOffer = {
  id: string;
  label: string;
  installed: boolean;
  login: 'signed-in' | 'not-signed-in' | 'unknown';
  loginDetail: string;
  /** Where the adapter's program was found when it is installed; null when it is not or is not known. */
  where: string | null;
  /** The version madarch can read from the installed adapter; null when it cannot read one. */
  version: string | null;
  install:
    | { kind: 'npm'; package: string; version: string; size: string; folder: string }
    | { kind: 'bundled'; program: string; note: string }
    | null;
};

export type WikiStatus = {
  product: { name: string; id: string };
  manifest: 'ok' | 'not-filled' | 'no-manifest';
  manifestFile: string;
  language: string;
  /** How many findings the documents hold: a count, never the list (madarch-8bdc.2.5). */
  findingCount: number;
  kinds: KindSummary[];
  groups: GroupSummary[];
  repositories: { name: string; filled: boolean }[];
  filled: boolean;
  incomplete: boolean;
  fill: FillState;
  writer: WriterState;
  bounds: WriterBounds;
  chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
  home: string | null;
  roles?: Record<string, { open?: string[]; lead: string[] }>;
  own?: boolean;
  /** Questions and corrections waiting, counted from their files. */
  loop?: { questionsOpen: number; questionsAnswered: number; correctionsOpen: number; tasksOpen?: number; problemsOpen?: number };
  /** The repository this step's graph holds: the home page is this repository's page while it stands. */
  repository?: RepositoryFactsView;
};

/** The repository as its entity-page block states it: the graph's facts, its as-is commit and its gaps. */
export type RepositoryBlockData = {
  nodeId: string;
  id: string;
  name: string;
  url: string;
  defaultBranch: string | null;
  asIsCommit: string | null;
  asIsHref: string | null;
  counts: RepositoryCounts;
  gaps: { what: string; reason: string }[];
  steps: { tree: boolean; history: boolean };
};

/** One file of a folder's table: the fields the table shows, not the facts of its own page. */
export type FolderFileData = {
  path: string;
  id: string;
  href: string;
  mode: string | null;
  blob: string | null;
  bytes: number | null;
  lines: number | null;
  form: 'text' | 'binary' | null;
  language: string | null;
  candidates: string[];
};

/** One file as its own block states it: the table's fields and its dates and authors. */
export type FileBlockData = FolderFileData & {
  repository: string;
  created: { date: string; offsetMin: number; commit: string; author: string; href: string } | null;
  modified: { date: string; offsetMin: number; commit: string; author: string; href: string } | null;
  commitCount: number;
  authors: string[];
};

/** One folder's block: its own subfolders and one page of its files, each with its graph address. */
export type FolderBlockData = {
  repository: string;
  id: string;
  folder: string;
  parent: { path: string; href: string } | null;
  folders: { path: string; href: string }[];
  files: FolderFileData[];
  nextHref: string | null;
};

export type SourceFile = { history?: HistoryContext; repo: string | null; path: string; language: string; commit: string | null; text: string };

export type ProductChoice = { name: string; folder: string; own?: boolean };

export type GlossaryTerm = { id: string; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; source?: { original: string; document: string; line: number; endLine: number }; repo: string | null; path: string; line: number; endLine: number; anchor: string; single: boolean; href: string };
export type Glossary = { terms: GlossaryTerm[]; resolutions: Record<string, Resolution>; findingCount: number };
export type UserSettings = { role: string; asked: boolean; roles: string[] };

type DocumentRef = { repo: string | null; path: string; title: string };
export type DocumentListing = { documents: DocumentRef[]; truncated: { repo: string | null; total: number; shown: number }[] };
/** A planned change as a page shows it: the task it belongs to, and how the page is reached. */
export type PlannedMarkView = { task: { id: string; slug: string; title: string; file: string }; how: 'scope' | 'impact' };

type PlannedSectionView = PlannedMarkView & { anchor: string | null; lines: { start: number; end: number } | null };

export type DocumentPageModel = { repo: string | null; path: string; title: string; markdown: string; resolutions: Record<string, Resolution>; anchors: Record<string, number>; commit: string | null; planned?: PlannedSectionView[]; plannedNote?: string };

export type Excerpt =
  | { type: 'code'; location: CodeLocation; language: string; firstLine: number; text: string; marked: { start: number; end: number }; truncated: boolean }
  | { type: 'text'; markdown: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string } }
  | { type: 'entity'; entity: EntityRef; facts: { name: string; value: string }[]; related: RelatedGroup[] };

export type GroundView = { url: string; resolution: Resolution; excerpt: Excerpt | null };

type RelyingRef = { page: string; pageTitle: string; text: string; line: number; file: string; how: 'grounds' | 'mentions'; ground: string; sentence?: string; turn?: number };

export type StatementModel = {
  page: EntityRef;
  /** The statement's name on its page: what a correction names it by. */
  name: string | null;
  sentence: string;
  paragraph: string;
  file: string;
  line: number;
  grounded: boolean;
  grounds: GroundView[];
  relying: RelyingRef[];
  resolutions: Record<string, Resolution>;
  /** The planned change this statement stands in, or null (madarch-m38l.14). */
  planned?: PlannedMarkView | null;
  plannedNote?: string;
};

// ---- the loop of questions and corrections (madarch-m38l.7) ----------------------------------

export type Author = { name: string; email: string; verified: string };

type QuestionType = 'contradiction' | 'ambiguous-term' | 'undocumented' | 'gap';
export type QuestionState = 'open' | 'answered' | 'closed';

export type QuestionRow = {
  slug: string;
  id: string;
  title: string;
  type: QuestionType;
  state: QuestionState;
  askedIn: string | null;
  askedAt: string | null;
  about: string[];
  answeredBy: Author | null;
  answeredAt: string | null;
  closedBy: string[];
};

export type QuestionListing = { rows: QuestionRow[]; open: number; answered: number; closed: number; problems: string[] };

export type QuestionDetail = QuestionRow & {
  file: string;
  question: string;
  why: string;
  sides: { claim: string; grounds: string[] }[];
  answer: { text: string; by: Author; at: string } | null;
  resolutions: Record<string, Resolution>;
  resolvedAt: string | null;
};

export type AnswerResult = { question: string; state: 'answered'; committed: boolean; commit?: string; note?: string; by: Author; at: string };
export type CorrectionResult = { correction: string; id: string; file: string; committed: boolean; commit?: string; note?: string; by: Author; at: string };

type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unplaced' | 'manifest' | string;
export type ProblemSection = 'code' | 'documents' | 'wiki';
type SonarKind = 'vulnerability' | 'bug' | 'code-smell' | 'security-hotspot';
type ProblemSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'info';
type ProblemLink = { label: string; href: string | null; key: string | null };

export type Problem = {
  /** The stable id; server listings carry it, a row built by hand need not. */
  id?: string;
  section?: ProblemSection;
  rule?: string;
  sonar?: SonarKind;
  severity?: ProblemSeverity;
  place?: ProblemLink;
  entity?: ProblemLink | null;
  evidence?: ProblemLink[];
  /** What «Создать задачу» opens a task on; absent where the page offers no task. */
  scope?: { type: 'file'; path: string } | { type: 'symbol'; key: string } | { type: 'lines'; path: string; start: number; end: number };
  kind: ProblemKind;
  fixer: 'agent' | 'person';
  closed: boolean;
  page: string | null;
  pageTitle: string | null;
  statement: string | null;
  sentence: string | null;
  target: string | null;
  reason: string;
  /** The reason as a locale key and its values; `reason` is the fallback (madarch-8bdc.2.5). */
  textKey?: string;
  textArgs?: Record<string, string | number>;
  file: string;
  line: number | null;
  /** The file's place on this machine, when the server knows it. */
  source?: string;
  by: Author | null;
  at: string | null;
};

/** A note beside a listing, worded by the app when `textKey` is known (madarch-8bdc.2.5). */
type ProblemNote = { message: string; textKey?: string; textArgs?: Record<string, string | number> };

/** The first level: one row per rule. */
export type ProblemCategory = {
  rule: string;
  kind: ProblemKind;
  section: ProblemSection;
  sonar: SonarKind;
  severity: ProblemSeverity;
  fixer: 'agent' | 'person';
  count: number;
  open: number;
  closed: number;
  label?: Record<string, string>;
};
export type ProblemCategories = {
  categories: ProblemCategory[];
  total: number;
  open: number;
  closed: number;
  dismissed: number;
  sections: Record<ProblemSection, number>;
  severities: Record<ProblemSeverity, number>;
  notes: ProblemNote[];
};

/** The second level: the sources of one category, one bounded page at a time. */
export type ProblemSource = { key: string; label: string; page: string | null; pageTitle: string | null; file: string | null; count: number; open: number };
export type ProblemSources = {
  rule: string;
  kind: ProblemKind;
  section: ProblemSection;
  sonar: SonarKind;
  severity: ProblemSeverity;
  count: number;
  open: number;
  closed: number;
  totalSources: number;
  sources: ProblemSource[];
  next: string | null;
};

/** The third level: the items of one source, one bounded page at a time. */
export type ProblemItems = {
  rule: string;
  source: string;
  count: number;
  open: number;
  closed: number;
  problems: Problem[];
  next: string | null;
};

/** A value an agent offers for the model or the reasoning level. */
type ChoiceValue = { value: string; name: string; description?: string };
export type Choice = { configId: string | null; name: string; current: string | null; values: ChoiceValue[] };
export type AgentChoices = { agent: { id: string; label: string }; choices: { model: Choice | null; reasoning: Choice | null } };

type DangerPlan = {
  rewrite: { agentPages: string[]; keptPages: string[] };
  fresh: { store: string[]; agentPages: string[]; keptPages: string[]; unansweredQuestions: string[]; keptAnswers: string[] };
};

/** The model roles a feature may ask for (madarch-j6ho.2). */
export type ModelRoleId = 'writing' | 'classification' | 'analysis' | 'editing';
type ModelPair = { agent: string; model?: string; reasoning?: string };
type ResolvedModelRole = {
  role: ModelRoleId;
  pair: ModelPair | null;
  source: 'assigned' | 'fallback' | 'none';
  fallbackFrom?: 'writing';
  note?: string;
};
export type ModelRoleView = { defaultRole: 'writing'; defaultPair: ModelPair | null; roles: ResolvedModelRole[] };


/** One graph node or edge and its verdict (madarch-mwhd.1). */
type GraphVerdict = 'valid' | 'invalid' | 'unreviewed';
/** Every verdict a person still has to look at: the settings table asks for these, valid rows excluded. */
export type GraphVerdictFilter = GraphVerdict | 'non-valid';
export type GraphVerdictRole = 'node' | 'edge';
type GraphVerdictRow = {
  role: GraphVerdictRole;
  id: string;
  kind: string;
  label: string;
  verdict: GraphVerdict;
  reason: string;
  rule: string;
  source: 'rule' | 'jev' | 'classification' | 'analysis' | 'person' | 'none' | 'budget' | 'judge-failed';
  tier?: string;
};
type GraphVerdictKindReport = { role: GraphVerdictRole; kind: string; total: number; valid: number; invalid: number; unreviewed: number };
export type GraphVerdictReport = {
  generatedAt: string;
  validatorVersion: string;
  budgets: GraphVerdictBudgets;
  totals: { items: number; nodes: number; edges: number; valid: number; invalid: number; unreviewed: number };
  byKind: GraphVerdictKindReport[];
  sources: { source: GraphVerdictRow['source']; count: number }[];
  reasons: { reason: string; count: number }[];
};
export type GraphVerdictBudgets = { itemsPerRun: number; modelCallsPerRun: number };
export type GraphVerdictView = {
  file: string;
  budgets: GraphVerdictBudgets;
  cached: boolean;
  metrics: { checked: number; reused: number; judgeItems: number; modelCalls: number };
  report?: GraphVerdictReport;
  total: number;
  offset: number;
  limit: number;
  rows: GraphVerdictRow[];
};

/** The product settings page (madarch-m38l.11): what is set for this product on this machine. */
export type ProductSettings = {
  product: { name: string; id: string };
  folder: string;
  store: string;
  language: string;
  chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
  roles: ModelRoleView;
  /** The name every agent madarch offers is known by (madarch-j6ho.2), so a row names its agent at once. */
  agentNames: Record<string, string>;
  bounds: WriterBounds;
  danger: DangerPlan;
  dangerError?: string;
  busy: boolean;
  own?: boolean;
};

type PlanReason =
  | { kind: 'missing' }
  | { kind: 'language'; from: string | null; to: string }
  | { kind: 'ground-changed' | 'ground-removed'; statement: string; ground: string }
  | { kind: 'answer'; question: string; title: string }
  | { kind: 'correction'; correction: string; statement: string }
  | { kind: 'new-service'; services: string[] }
  | { kind: 'missing-domain'; domain: string }
  | { kind: 'task'; task: string; title: string };

type PlannedPage = { id: string; path: string; reasons: PlanReason[] };
type Unplaced = { kind: 'question' | 'correction'; slug: string; title: string; reason: string };

export type RefreshPlan = { languageChanged: boolean; pages: PlannedPage[]; unchanged: string[]; unplaced: Unplaced[]; problems: string[] };

// ---- the agent's journal (madarch-m38l.13) ----------------------------------------------------

type JournalOutcome = 'ok' | 'refused' | 'failed' | 'rejected';

export type JournalRecord = {
  time: string;
  durationMs: number;
  run: string;
  unit: string;
  agent: string;
  model: string | null;
  session: string | null;
  kind: 'tool-call' | 'refusal' | 'editorial-finding' | 'revision-request' | 'editorial-skip' | 'editorial-warning';
  tool: string;
  arguments: unknown;
  response: string | null;
  responseBytes: number;
  truncated: boolean;
  isError: boolean;
  outcome: JournalOutcome;
  reason: string | null;
};

export type PageJournal = { run: string | null; runs: string[]; records: JournalRecord[]; problems: string[] };
// ---- the scoped tasks of answers (madarch-m38l.14) -------------------------------------------

/** What a task changes: a document section, a line range, a symbol, a statement, or a whole path. */
export type TaskScope =
  | { type: 'section'; path: string; anchor: string }
  | { type: 'lines'; path: string; start: number; end: number }
  | { type: 'symbol'; key: string }
  | { type: 'statement'; key: string }
  | { type: 'file'; path: string };

/** A task as the wiki lists it, with what its change reaches through the graph counted. */
export type TaskRow = {
  id: string;
  slug: string;
  title: string;
  status: 'open' | 'closed';
  file: string;
  question: string;
  answer: string;
  at: string;
  by: Author;
  grounds: string[];
  scope: { scope: TaskScope; words: string; place: PlaceView }[];
  closedBy: { repository: string; commit: string; at: string; subject: string } | { person: true; at: string | null } | null;
  impact: { pages: number; statements: number } | null;
  problem?: string;
  /** The problem this task was opened from (madarch-m38l.19). */
  problemId?: string;
};

export type TaskListing = { tasks: TaskRow[]; open: number; closed: number; problems: string[]; notes: string[] };

/** What a change reaches, computed through the graph. */
export type TaskImpact = {
  grounds: string[];
  /** The grounds the graph answers nothing for: the index may not have been published for them yet. */
  unindexed: string[];
  pages: { id: string; title: string; file: string; kind: string; because: 'statement' | 'link' }[];
  writable: string[];
  entities: string[];
  statements: { page: string; pageTitle: string; pageKind: string; file: string; line: number; statement: string; text: string; ground: string; grounds: string[]; how: 'grounds' | 'mentions' }[];
  counts: { pages: number; statements: number };
};

export type TaskDetail = Omit<TaskRow, 'impact'> & {
  impact: TaskImpact | null;
  writable: string[];
  marks: { sections: number; statements: number; entities: number };
};

/** A place a task changes as a reader says it: a section's heading and its document's title, each a link (madarch-m38l.14). */
export type PlaceView = {
  kind: 'section' | 'file' | 'lines' | 'symbol' | 'statement';
  label: string;
  where: string | null;
  href: string | null;
  path: string | null;
  words: string;
};

/** The task an answer proposes: the scope its grounds name, and what it reaches. */
export type TaskProposal = {
  choice: 'code' | 'docs';
  title: string;
  grounds: string[];
  scope: TaskScope[];
  places?: PlaceView[];
  impact: TaskImpact;
  question: { slug: string; title: string; file: string };
  answer: { text: string; by: string; at: string };
};

export type CreatedTask = { task: { slug: string; id: string; file: string; title: string; status: 'open' | 'closed' }; state: 'created'; committed: boolean; note?: string; commit?: string };
export type ContractReason =
  | {code: 'definitionMissing'}
  | {code: 'contractReadBudget'; params: {maxFiles: number; maxBytes: number}}
  | {code: 'yamlParse'}
  | {code: 'yamlConversion'}
  | {code: 'definitionObjectRequired'}
  | {code: 'yamlAliasCycle'}
  | {code: 'definitionNesting'; params: {maxLevels: number}}
  | {code: 'definitionRepresentationBudget'; params: {maxBytes: number}}
  | {code: 'referenceAnchorUnsupported'; params: {ref: string}}
  | {code: 'referenceRemoteOrAbsolute'; params: {ref: string}}
  | {code: 'referenceEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceEscapesRepository'; params: {ref: string}}
  | {code: 'pointerEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceUnresolved'; params: {ref: string}}
  | {code: 'externalExample'; params: {ref: string}}
  | {code: 'externalLogo'; params: {ref: string}}
  | {code: 'descriptionImage'}
  | {code: 'descriptionMarkupBudget'; params: {maxNodes: number}}
  | {code: 'reservedBundleField'; params: {field: string}}
  | {code: 'operationReferenceBudgetOrCycle'; params: {maxReferences: number}}
  | {code: 'operationReferenceUnresolved'; params: {ref: string}}
  | {code: 'protoImportBudget'; params: {maxFiles: number; maxDepth: number}}
  | {code: 'protoImportMissing'}
  | {code: 'protoByteBudget'; params: {maxBytes: number}}
  | {code: 'protoParse'}
  | {code: 'protoImportInvalid'; params: {ref: string}}
  | {code: 'protoImportEscapesRepository'; params: {ref: string}}
  | {code: 'protoResolve'}
  | {code: 'definitionSubjectUnsupported'}
  | {code: 'declaringContractCount'; params: {count: number}}
  | {code: 'contractFormatUnsupported'; params: {format: string}}
  | {code: 'contractVersionMissing'; params: {format: string}}
  | {code: 'operationSelectionMissing'; params: {method: string; path: string}}
  | {code: 'operationIdAmbiguous'; params: {operationId: string; count: number}}
  | {code: 'unknownDefinitionFailure'}
  | {code: 'rendererFailure'}
  | {code: 'rendererValidationFailure'}
  | {code: 'selectionNotRendered'};
export type ContractDiagnostic = { path: string; line: number; fullPath: string; code: string; detail: string; reason?: ContractReason; technicalDetail?: string };
type ProtoDocumentation = { services: {name: string; methods: {name: string; request: string; response: string; requestStream: boolean; responseStream: boolean}[]}[]; messages: {name: string; fields: {name: string; type: string; id: number; rule: string; oneof?: string}[]; values?: {name: string; id: number}[]}[] };
