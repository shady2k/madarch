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
  figures: { kind: 'added' | 'removed' | 'symbols' | 'commits' | 'files' | 'module'; value: string }[];
};

/** One list of a history block: the commits it shows, or the files they touched. */
export type HistorySection = { role: 'commits' | 'files'; total: number; rows: HistoryRow[] };

/** One note under a history block (the engine's `HistoryNote`): a key the app writes in the reader's language. */
export type HistoryNote = { key: 'manyCommits' | 'manyFiles' | 'noCounts' | 'merge' | 'noFiles' | 'partialFiles'; args?: Record<string, string | number> };

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


type BlockShape =
  | { type: 'markdown'; markdown: string }
  | { type: 'term'; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[] }
  | { type: 'graph'; title: string; neighborhood: Neighborhood; depth: number; shown: number; total: number }
  | { type: 'system'; title: string; nodes: SystemNode[]; edges: SystemEdge[]; notes: string[] }
  | { type: 'modules'; title: string; service: string; nodes: ModuleNode[]; edges: ModuleEdge[]; cycles: string[][]; notes: string[] }
  | { type: 'treemap'; title: string; scope: string; files: TreemapFile[]; maxChurn: number; total: number; notes: string[] }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'er'; title: string; mermaid: string; tables: number; shownTables: number; links: EntityRef[] }
  | { type: 'sequence'; title: string; scenario: string; chains: Chain[]; entries: number; notes: string[] }
  | { type: 'refs'; title: string; total: number; rows: RefRow[] }
  | { type: 'properties'; title: string; rows: { name: string; value: string }[] }
  | { type: 'stated'; title: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; commit: string | null } }
  | { type: 'definition'; title: string; format: string; contract: string; location?: CodeLocation; members: DefinitionMember[]; membersTotal: number; membersShown: number; memberCuts: { channel: string; total: number; shown: number }[]; spec: { text: string; lines: number } }
  | { type: 'history'; title: string; sections: HistorySection[]; notes: HistoryNote[] }
  | { type: 'deferred'; block: string; title: string; line: number }
  | { type: 'problem'; block: string; message: string; file: string; line: number };

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

export type PageModel = {
  id: string;
  kind: string;
  title: string;
  trail: EntityRef[];
  blocks: Block[];
  resolutions: Record<string, Resolution>;
  findings: Finding[];
  notes: string[];
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

export type EntityListing = { kind: string; total: number; rows: EntityRef[]; next: string | null };

export type FillState = {
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

export type SourceFile = { repo: string | null; path: string; language: string; commit: string | null; text: string };

export type ProductChoice = { name: string; folder: string; own?: boolean };

export type GlossaryTerm = { id: string; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; repo: string | null; path: string; line: number; endLine: number; anchor: string; href: string };
export type Glossary = { terms: GlossaryTerm[]; resolutions: Record<string, Resolution>; findings: Finding[] };
export type UserSettings = { role: string; asked: boolean; roles: string[] };

export type DocumentRef = { repo: string | null; path: string; title: string };
export type DocumentListing = { documents: DocumentRef[]; truncated: { repo: string | null; total: number; shown: number }[] };
export type DocumentPageModel = { repo: string | null; path: string; title: string; markdown: string; resolutions: Record<string, Resolution>; anchors: Record<string, number>; commit: string | null };

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

export type ProblemKind = 'correction' | 'ground-removed' | 'broken-link' | 'unreadable-file' | 'unplaced';

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
  fresh: { store: string[]; agentPages: string[]; keptPages: string[]; editedStarterFiles: string[]; replacedStarterFiles: string[] };
};

/** The product settings page (madarch-m38l.11): what is set for this product on this machine. */
export type ProductSettings = {
  product: { name: string; id: string };
  folder: string;
  store: string;
  language: string;
  chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
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
  | { kind: 'missing-domain'; domain: string };

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
