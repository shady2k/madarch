/**
 * The shapes the knowledge wiki's API answers (`src/knowledge/model.ts` and
 * `src/server/knowledge.ts` in the engine): the app draws these and holds no
 * knowledge of any kind, template or block beyond them.
 */

export type Finding = { file: string; line: number; message: string };

export type CodeLocation = { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; web?: { host: string; url: string } };

export type EntityRef = {
  id: string;
  kind: string;
  label: string;
  href: string | null;
  location?: CodeLocation;
  broken?: string;
};

export type RefRow = { entity: EntityRef; note?: string; noteKey?: 'named' | 'groundedWith' | 'statements' | 'links'; noteArgs?: Record<string, string | number> };

/** One row of a history block (the engine's `HistoryRow`): when, who and what, with the figures its facts give. */
export type HistoryRow = {
  when?: string;
  who?: string;
  text: string;
  entity?: EntityRef;
  figures: { kind: 'added' | 'removed' | 'symbols' | 'commits' | 'files' | 'module' | 'reachable' | 'firstParent' | 'merges' | 'nonMerge' | 'authors' | 'since' | 'until' | 'both' | 'onlyThis' | 'onlyOther' | 'authoredAt' | 'committedAt' | 'effectiveAt' | 'similarity'; value: string }[];
};

/** One list of a history block: the commits it shows, or the files they touched. */
export type HistorySection = { repository?: string; role: 'commits' | 'files' | 'summary' | 'hotspots' | 'authors' | 'coupling' | 'renames' | 'parents' | 'branches' | 'snapshots'; total: number; rows: HistoryRow[] };

/** One row of a properties block (the engine's `PropertyRow`). */
export type PropertyRow = { name: string; value: string; nameKey?: 'authoredAt' | 'committedAt' | 'subject' | 'merge' | 'language' | 'symbol' | 'method' | 'path'; valueKind?: 'date' };

/** One note under a history block (the engine's `HistoryNote`): a key the app writes in the reader's language. */
export type HistoryNote = { key: 'manyCommits' | 'manyFiles' | 'noCounts' | 'merge' | 'noFiles' | 'partialFiles' | 'symbolsCut' | 'population' | 'observedAuthorship' | 'cochangeNotCause' | 'noImport' | 'importCoverage' | 'membershipCoverage' | 'dateAnomaly' | 'mergeBranch' | 'unchangedMove'; args?: Record<string, string | number> };

/** One member of a contract's definition (the engine's `DefinitionMember`). */
export type DefinitionMember = { anchor: string; label: string; detail?: string; href: string | null; badge?: string; detailTotal?: number };

export type RelatedGroup = {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  rows: { entity: EntityRef; count: number; hops?: number }[];
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
export type StepKind = 'enter' | 'route' | 'call' | 'self' | 'read' | 'write' | 'http' | 'grpc' | 'publish' | 'consume';
export type ChainLane = { id: string; label: string; sub: string; kind: string; href: string | null; group: string };
export type ChainStep = { n: number; from: string; to: string; label: string; kind: StepKind; href: string | null; site?: CodeLocation; order: 'source' | 'unordered'; note?: string };
export type Chain = { title: string; entry: EntityRef | null; lanes: ChainLane[]; steps: ChainStep[]; notes: string[]; total: number };
export type SystemNode = { id: string; kind: 'service' | 'database' | 'topic' | 'external'; label: string; sub: string; href: string | null };
export type SystemEdge = { from: string; to: string; via: 'http' | 'grpc' | 'sql' | 'publishes' | 'consumes'; label: string; count: number };
export type ModuleNode = { id: string; label: string; files: number; href: string | null; cycle: boolean };
export type ModuleEdge = { from: string; to: string; cycle: boolean };
export type TreemapFile = { id: string; path: string; href: string | null; lines: number; churn: number };

export type DiagramRenderer = 'likec4' | 'mermaid' | 'archify';
export type ViewType = 'c4-context' | 'c4-container' | 'c4-component' | 'sequence' | 'er' | 'state' | 'deployment';
export type ViewSpec = { type: ViewType; subject: string; scope?: string; entry?: string };
export type ViewElement = {
  id: string;
  label: string;
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
export type ViewEdge = { from: string; to: string; label: string; dashed: boolean; why?: string; step?: number; kind?: string; note?: string; href?: string | null; location?: CodeLocation };
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
  query: string;
};

type BlockShape =
  | { type: 'guide'; data: { guide: { id: string; kind: 'administrator-guide' | 'user-guide'; title: string; locale: 'en' | 'ru'; context: { valid: string; known: string; state: string; repositories: { name: string; commit: string }[] }; unitVersion: string; inputDigest: string; prerequisites: string[]; gaps: string[]; procedures: { id: string; title: string; goal: string; role: string; prerequisites: string[]; steps: { id: string; title: string; cwd: string; environment: string; inputs: { name: string; description: string; secret: boolean }[]; instruction: { kind: 'command' | 'http'; content: string }; expected: { status: number; observation: string }; grounds: { repository: string; commit: string; path: string; line: number; endLine: number }[] }[] }[] }; walk: { status: 'passed' | 'failed' | 'not-walked'; diagnostics: { file: string; line: number; path: string; code: string; message: string }[] }; markdown: string; diagnostics: { file: string; line: number; path: string; code: string; message: string }[]; coverage: 'procedures' | 'gap-only'; sourceViewWarning?: string; grounds: { procedure: string; step: string; repository: string; commit: string; path: string; line: number; endLine: number; href: string }[] } }
  | { type: 'markdown'; markdown: string }
  | { type: 'term'; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[]; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'graph'; title: string; neighborhood: Neighborhood; depth: number; shown: number; total: number }
  | { type: 'diagrams'; title: string; renderer: DiagramRenderer; views: DiagramView[] }
  | { type: 'treemap'; title: string; scope: string; files: TreemapFile[]; maxChurn: number; total: number; notes: string[] }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'refs'; title: string; total: number; rows: RefRow[] }
  | { type: 'properties'; title: string; rows: PropertyRow[] }
  | { type: 'stated'; title: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; commit: string | null; single?: boolean } }
  | { type: 'definition'; title: string; format: string; contract: string; fullPath?: string; location?: CodeLocation; members: DefinitionMember[]; membersTotal: number; membersShown: number; memberCuts: { channel: string; total: number; shown: number }[]; spec: { text: string; lines: number }; document?: Record<string, unknown>; descriptions?: {text: string; path: string; line: number; fullPath: string}[]; selection?: { method: string; path: string; operationId: string }; protobuf?: ProtoDocumentation; diagnostics?: ContractDiagnostic[] }
  | { type: 'history'; title: string; sections: HistorySection[]; notes: HistoryNote[] }
  | { type: 'deferred'; block: string; title: string; line: number }
  | { type: 'problem'; block: string; message: string; file: string; line: number; diagnostic?: ContractDiagnostic };

/** One block of a page; `name` is the template's block it was made from (`implementedby` and `linkedfrom` both draw as `refs`), which the manifest's roles name. */
export type Block = BlockShape & { name?: string };

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
  /** The planned change this page stands in, and the statements of it a task's grounds reach (madarch-m38l.14). */
  planned?: { entity: PlannedMarkView | null; statements: (PlannedMarkView & { sentence: string })[]; note?: string };
};

export type Origin = 'agent' | 'person' | 'code' | 'history';

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
};

export type GroupSummary = { group: string; labels: Record<string, string> };

export type OperationMetadata = { contracts: {entity: EntityRef; protocol: string; directions?: ('publish' | 'subscribe')[]; directionStatus?: 'known' | 'unavailable'; producedBy?: EntityRef[]; consumedBy?: EntityRef[]}[]; implementedBy: EntityRef[]; calledBy: EntityRef[]; cuts: {relation: string; shown: number; total: number}[] };
export type EntityListing = { kind: string; total: number; rows: EntityRef[]; next: string | null; operations?: Record<string, OperationMetadata> };

export type FillState = {
  rebuilt?: 'extractors-changed';
  state: 'idle' | 'running' | 'done' | 'failed';
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
};

export type WriterUnit = {
  unit: string;
  path: string;
  state: 'waiting' | 'writing' | 'written' | 'failed' | 'not-written';
  writeAttempts?: number;
  calls?: number;
  refusals?: { line: number; rule: string; message: string }[];
};

export type WriterState = {
  state: 'idle' | 'waiting' | 'running' | 'done' | 'failed';
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
};

export type WriterBounds = { turns: number; minutes: number; toolCalls: number; writeAttempts: number; maxDomains: number };

export type AgentOffer = {
  id: string;
  label: string;
  installed: boolean;
  login: 'signed-in' | 'not-signed-in' | 'unknown';
  loginDetail: string;
  install: { package: string; version: string; size: string; folder: string } | null;
};

export type WikiStatus = {
  product: { name: string; id: string };
  manifest: 'ok' | 'no-manifest';
  manifestFile: string;
  language: string;
  seeded: string[];
  seedError?: string;
  findings: Finding[];
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
  loop?: { questionsOpen: number; questionsAnswered: number; correctionsOpen: number };
  /** What the current starter set holds that this product's edited manifest lacks (the Problems page offers it). */
  starterOffers?: number;
};

export type SourceFile = { history?: HistoryContext; repo: string | null; path: string; language: string; commit: string | null; text: string };

export type ProductChoice = { name: string; folder: string; own?: boolean };

export type GlossaryTerm = { id: string; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; source?: { original: string; document: string; line: number; endLine: number }; repo: string | null; path: string; line: number; endLine: number; anchor: string; single: boolean; href: string };
export type Glossary = { terms: GlossaryTerm[]; resolutions: Record<string, Resolution>; findings: Finding[] };
export type UserSettings = { role: string; asked: boolean; roles: string[] };

export type DocumentRef = { repo: string | null; path: string; title: string };
export type DocumentListing = { documents: DocumentRef[]; truncated: { repo: string | null; total: number; shown: number }[] };
/** A planned change as a page shows it: the task it belongs to, and how the page is reached. */
export type PlannedMarkView = { task: { id: string; slug: string; title: string; file: string }; how: 'scope' | 'impact' };

export type PlannedSectionView = PlannedMarkView & { anchor: string | null; lines: { start: number; end: number } | null };

export type DocumentPageModel = { repo: string | null; path: string; title: string; markdown: string; resolutions: Record<string, Resolution>; anchors: Record<string, number>; commit: string | null; planned?: PlannedSectionView[]; plannedNote?: string };

export type Excerpt =
  | { type: 'code'; location: CodeLocation; language: string; firstLine: number; text: string; marked: { start: number; end: number }; truncated: boolean }
  | { type: 'text'; markdown: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string } }
  | { type: 'entity'; entity: EntityRef; facts: { name: string; value: string }[]; related: RelatedGroup[] };

export type GroundView = { url: string; resolution: Resolution; excerpt: Excerpt | null };

export type RelyingRef = { page: string; pageTitle: string; text: string; line: number; file: string; how: 'grounds' | 'mentions'; ground: string; sentence?: string; turn?: number };

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

export type QuestionType = 'contradiction' | 'ambiguous-term' | 'undocumented' | 'gap';
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

export type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unread-passage' | 'unplaced';

export type Problem = {
  kind: ProblemKind;
  fixer: 'agent' | 'person';
  closed: boolean;
  page: string | null;
  pageTitle: string | null;
  statement: string | null;
  sentence: string | null;
  target: string | null;
  reason: string;
  file: string;
  line: number | null;
  /** The file's place on this machine, when the server knows it. */
  source?: string;
  by: Author | null;
  at: string | null;
};

/** One thing the starter set holds and the product's manifest lacks. */
export type StarterOffer = {
  id: string;
  type: 'group' | 'roles' | 'role' | 'documents' | 'kind' | 'fields';
  name: string;
  labels?: { en: string; ru: string };
  description?: { en: string; ru: string };
  group?: string;
  fields?: string[];
};

export type ProblemListing = { problems: Problem[]; open: number; closed: number; notes: string[]; starter?: StarterOffer[] };

/** A value an agent offers for the model or the reasoning level. */
export type ChoiceValue = { value: string; name: string; description?: string };
export type Choice = { configId: string | null; name: string; current: string | null; values: ChoiceValue[] };
export type AgentChoices = { agent: { id: string; label: string }; choices: { model: Choice | null; reasoning: Choice | null } };

export type DangerPlan = {
  rewrite: { agentPages: string[]; keptPages: string[] };
  fresh: { store: string[]; agentPages: string[]; keptPages: string[]; unansweredQuestions: string[]; keptAnswers: string[]; editedStarterFiles: string[]; replacedStarterFiles: string[] };
};

/** The model roles a feature may ask for (madarch-j6ho.2). */
export type ModelRoleId = 'writing' | 'classification' | 'analysis';
export type ModelPair = { agent: string; model?: string; reasoning?: string };
export type ResolvedModelRole = {
  role: ModelRoleId;
  pair: ModelPair | null;
  source: 'assigned' | 'fallback' | 'none';
  fallbackFrom?: 'writing';
  note?: string;
};
export type ModelRoleView = { defaultRole: 'writing'; defaultPair: ModelPair | null; roles: ResolvedModelRole[] };


/** One graph node or edge and its verdict (madarch-mwhd.1). */
export type GraphVerdict = 'valid' | 'invalid' | 'unreviewed';
export type GraphVerdictRole = 'node' | 'edge';
export type GraphVerdictRow = {
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
export type GraphVerdictKindReport = { role: GraphVerdictRole; kind: string; total: number; valid: number; invalid: number; unreviewed: number };
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
  bounds: WriterBounds;
  danger: DangerPlan;
  dangerError?: string;
  busy: boolean;
  own?: boolean;
};

export type PlanReason =
  | { kind: 'missing' }
  | { kind: 'language'; from: string | null; to: string }
  | { kind: 'ground-changed' | 'ground-removed'; statement: string; ground: string }
  | { kind: 'answer'; question: string; title: string }
  | { kind: 'correction'; correction: string; statement: string }
  | { kind: 'new-service'; services: string[] }
  | { kind: 'missing-domain'; domain: string }
  | { kind: 'task'; task: string; title: string };

export type PlannedPage = { id: string; path: string; reasons: PlanReason[] };
export type Unplaced = { kind: 'question' | 'correction'; slug: string; title: string; reason: string };

export type RefreshPlan = { languageChanged: boolean; pages: PlannedPage[]; unchanged: string[]; unplaced: Unplaced[]; problems: string[] };

export type RefreshPreview =
  | { available: true; plan: RefreshPlan; language: { from: string | null; to: string; changed: boolean }; commitsNotRead: number | null }
  | { available: false; reason: string };

// ---- the agent's journal (madarch-m38l.13) ----------------------------------------------------

export type JournalOutcome = 'ok' | 'refused' | 'failed' | 'rejected';

export type JournalRecord = {
  time: string;
  durationMs: number;
  run: string;
  unit: string;
  agent: string;
  model: string | null;
  session: string | null;
  kind: 'tool-call' | 'refusal';
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
export type ProtoDocumentation = { services: {name: string; methods: {name: string; request: string; response: string; requestStream: boolean; responseStream: boolean}[]}[]; messages: {name: string; fields: {name: string; type: string; id: number; rule: string; oneof?: string}[]; values?: {name: string; id: number}[]}[] };
