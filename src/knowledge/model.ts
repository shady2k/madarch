import type { ProtoDocumentation } from './proto-document.js';
import type { ContractDiagnostic } from './contract-document.js';
/**
 * The page model the server answers and the app draws (decision 0029): a page
 * is a list of blocks, each already read from the graph or the Markdown, so the
 * app holds no knowledge of any kind and draws only these shapes.
 */
import type { RefreshPlan } from '../loop/plan.js';
import type { Finding } from './kinds.js';
import type { Resolution } from './resolve.js';
import type { DiagramsBlockShape } from './views.js';

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

/** A reference to an entity: a link when the manifest gives its kind a page. */
export interface EntityRef {
  id: string;
  kind: string;
  label: string;
  /** The page's address, when the kind has one. */
  href: string | null;
  location?: CodeLocation;
  /** A broken reference (a `relates` key that resolves to nothing) carries its reason. */
  broken?: string;
}

/** A row of a list of references: an entity and, when the list says why it is there, the reason in words. */
export interface RefRow {
  entity: EntityRef;
  /** Why the row is in the list, in English words. */
  note?: string;
  /** The same reason as a key and its values, so the app says it in the reader's language; a row whose note is a quotation has none. */
  noteKey?: 'named' | 'groundedWith' | 'statements' | 'links';
  noteArgs?: Record<string, string | number>;
  /** The note is quoted source text, not the engine's words. */
  quoted?: true;
}

export interface RelatedGroup {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  rows: { entity: EntityRef; count: number; hops?: number }[];
}

export interface CallRow {
  entity: EntityRef;
  /** How many places the call is read at. */
  sites: number;
  /** The first place it is read at. */
  site?: CodeLocation;
}

/** A node of a drawn diagram: a link to the entity's page when the kind has one. */
export interface DiagramNode {
  id: string;
  kind: string;
  label: string;
  href: string | null;
  /** Hops from the entity the neighbourhood is drawn around (0 is that entity). */
  hops?: number;
}

/** An edge of a neighbourhood: `from` to `to` by a relation, `count` edges (call sites, say) behind it. */
export interface DiagramEdge {
  from: string;
  to: string;
  relation: string;
  count: number;
}

/** A group of neighbours the diagram does not show: `hidden` more behind a node's relation and direction, one click away. */
export interface DiagramMore {
  node: string;
  relation: string;
  direction: 'out' | 'in';
  hidden: number;
}

/** The neighbourhood of an entity: what the graph holds around it, with the pieces left out counted. */
export interface Neighborhood {
  center: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  more: DiagramMore[];
  /** The relations present, with the direction (from the centre) and how many edges each holds, for the filter. */
  relations: { relation: string; direction: 'out' | 'in'; count: number }[];
}

export type StepKind = 'enter' | 'route' | 'call' | 'self' | 'read' | 'write' | 'http' | 'grpc' | 'publish' | 'consume';

/** A lifeline of a chain: a file of a service, a table, a topic or the caller. */
export interface ChainLane {
  id: string;
  label: string;
  /** The line under the label: the file's folder, the table's database. */
  sub: string;
  kind: string;
  href: string | null;
  /** The container the lane belongs to (a service, a database, the broker): lanes of one group stand together. */
  group: string;
  /** How the group is named to a reader; the internal `group` stays the key the graph is read by. */
  groupLabel?: string;
}

/** One step: `from` to `to`, a link to what it reaches, the line it is read at. */
export interface ChainStep {
  n: number;
  from: string;
  to: string;
  label: string;
  kind: StepKind;
  href: string | null;
  site?: CodeLocation;
  /** `source`: after the previous step in the source order of one function. `unordered`: the graph holds no order against the steps before. */
  order: 'source' | 'unordered';
  /**
   * The call-nesting layer that produced the step: how many calls the walk descended through from the entry to reach the
   * function whose body the step records. Layer 0 is the entry itself - its route, the handler registered for it, and the
   * tail the graph links with no order. A call step belongs to its caller's layer; a callee's own steps are one deeper.
   */
  layer: number;
  note?: string;
  /** The note names code identifiers rather than speaking prose. */
  technical?: true;
}

/** One end-to-end chain from an entry point. */
export interface Chain {
  title: string;
  entry: EntityRef | null;
  lanes: ChainLane[];
  steps: ChainStep[];
  notes: string[];
  /** Steps found, and how many are drawn. */
  total: number;
}

export interface SystemNode {
  id: string;
  kind: 'service' | 'database' | 'topic' | 'external';
  label: string;
  sub: string;
  href: string | null;
}

export interface SystemEdge {
  from: string;
  to: string;
  via: 'http' | 'grpc' | 'sql' | 'publishes' | 'consumes';
  label: string;
  count: number;
}

export interface ModuleNode {
  id: string;
  label: string;
  files: number;
  href: string | null;
  cycle: boolean;
}

export interface ModuleEdge {
  from: string;
  to: string;
  cycle: boolean;
}

export interface TreemapFile {
  id: string;
  path: string;
  href: string | null;
  lines: number;
  /** Commits that changed the file, over the whole history read. */
  churn: number;
}

type BlockShape =
  | { type: 'guide'; data: import('../writer/guides/read.js').GuidePageData }
  | { type: 'markdown'; markdown: string }
  | { type: 'members'; title: string; kindLabel?: string; kindLabelName?: string; rows: MemberRow[]; total: number }
  | { type: 'term'; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[]; localized?: { statement: string; original: string; sourceDocument: string; sourceLine: number; sourceEndLine: number } }
  | { type: 'graph'; title: string; neighborhood: Neighborhood; depth: number; shown: number; total: number }
  | DiagramsBlockShape
  | { type: 'treemap'; title: string; scope: string; files: TreemapFile[]; maxChurn: number; total: number; notes: string[] }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'refs'; title: string; total: number; rows: RefRow[]; hideEmpty?: boolean }
  | { type: 'properties'; title: string; rows: PropertyRow[] }
  | { type: 'stated'; title: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; commit: string | null; single?: boolean } }
  | { type: 'deferred'; block: string; title: string; id: string }
  | { type: 'definition'; title: string; format: string; contract: string; fullPath?: string; location?: CodeLocation; members: DefinitionMember[]; membersTotal: number; membersShown: number; memberCuts: { channel: string; total: number; shown: number }[]; spec: { text: string; lines: number }; document?: Record<string, unknown>; descriptions?: {text: string; path: string; line: number; fullPath: string}[]; selection?: { method: string; path: string; operationId: string }; protobuf?: ProtoDocumentation; diagnostics?: ContractDiagnostic[] }
  | { type: 'history'; title: string; sections: HistorySection[]; notes: HistoryNote[] }
  | { type: 'problem'; block: string; message: string; file: string; line: number; diagnostic?: ContractDiagnostic };


/** One member of a contract's definition: an operation, a channel, or an rpc, with the anchor the page opens at. */
export interface DefinitionMember {
  /** The anchor the member is addressable by: `op-<id>`, `channel-<name>`, `rpc-<service>/<rpc>`. */
  anchor: string;
  /** The member's own words: `GET /payments`, `orders.created`, `Payments.Authorize`. */
  label: string;
  /** What the contract says beside it: a summary, the message a channel carries, the request and response of an rpc. */
  detail?: string;
  /** The page of the member, when the graph holds one. */
  href: string | null;
  /** The badge of the member's protocol face: the HTTP method, `async`, `gRPC`. */
  badge?: string;
  detailTotal?: number;
}

/** One list of a history block: the commits it shows, or the files it shows, with the list's own columns. */
export interface HistorySection {
  /** Repository label when a product page shows more than one history. */
  repository?: string;
  /** What the rows are: the commits themselves, or the files they touched. */
  role: 'commits' | 'files' | 'summary' | 'hotspots' | 'authors' | 'coupling' | 'renames' | 'parents' | 'branches' | 'snapshots';
  /** How many rows the list has in the graph; `rows` holds the first of them. */
  total: number;
  rows: HistoryRow[];
}

/** One row of a history block: when, who and what, with the figures the row's own facts give. */
export interface HistoryRow {
  /** The day it happened, `YYYY-MM-DD` in UTC, when the row is a commit. */
  when?: string;
  /** The name of the author, when the row is a commit. */
  who?: string;
  /** The row's words: a commit's message, or a file's path. */
  text: string;
  /** The entity the row is about, when the kind has a page. */
  entity?: EntityRef;
  /** The figures the app draws beside the row; each names its kind so the app writes it in the reader's language. */
  figures: HistoryFigure[];
}

/** One note under a history block: why the list is not the whole story, said in the reader's language by the app. */
export interface HistoryNote {
  key: 'manyCommits' | 'manyFiles' | 'noCounts' | 'merge' | 'noFiles' | 'partialFiles' | 'symbolsCut' | 'population' | 'observedAuthorship' | 'cochangeNotCause' | 'noImport' | 'importCoverage' | 'membershipCoverage' | 'dateAnomaly' | 'mergeBranch' | 'unchangedMove';
  args?: Record<string, string | number>;
}

/** One figure of a history row: added or removed lines, symbols, commits, files, or the module a file belongs to. */
export interface HistoryFigure {
  kind: 'added' | 'removed' | 'symbols' | 'commits' | 'files' | 'module' | 'reachable' | 'firstParent' | 'merges' | 'nonMerge' | 'authors' | 'since' | 'until' | 'both' | 'onlyThis' | 'onlyOther' | 'authoredAt' | 'committedAt' | 'effectiveAt' | 'similarity';
  value: string;
}

/** One row of a properties block: the name the extractor gave it, the manifest's label, and the value written for a reader. */
export interface PropertyRow {
  name: string;
  value: string;
  /** The property's label in the language the page was asked in, from the manifest. */
  label?: string;
  /** The name's key under `knowledge.property.`, where a product made before madarch-m38l.21 names it there. */
  nameKey?: 'authoredAt' | 'committedAt' | 'subject' | 'merge' | 'language' | 'symbol' | 'method' | 'path' | 'marker' | 'text' | 'line' | 'service' | 'secret';
  /** A date or a yes/no value the app writes in the reader's language. */
  valueKind?: 'date' | 'boolean' | 'code';
}

/** One member of an entity (a field of a class, a facet of a file): its name, its labelled facts and who reads or writes it. */
export interface MemberRow {
  entity: EntityRef;
  /** The member's own short name: the declaring type is already the page's heading. */
  name: string;
  /** The fragment this member has on its parent's page; an old member address lands here. */
  anchor: string;
  /** Every fact the member's kind declares, in manifest order; the page draws the shared ones once. */
  values: PropertyRow[];
  readers: EntityRef[];
  writers: EntityRef[];
}

/** One block of a page; `name` is the template's block it was made from (`implementedby` and `linkedfrom` both draw as `refs`), which the manifest's roles name. */
export type Block = BlockShape & {
  name?: string;
  /** What a block looked for and did not find, in the reader's language, when absence itself informs the reader. */
  emptyNote?: string;
};

export interface PageModel {
  historyNavigation?: { repo: string; points: { name: string; commit: string; covered: boolean }[]; landmarks?: NonNullable<import('./temporal.js').HistoryContext['landmarks']> }[];
  historicalAbsent?: boolean;
  /** Explicit historical context; no coverage is inferred from a named snapshot alone. */
  history?: import('./temporal.js').HistoryContext;
  id: string;
  kind: string;
  /**
   * The language the page's own words are written in — the reader's interface language, else the product's
   * content language — so a page file writes its figures in the same words the app draws (madarch-u3vw.7).
   */
  language?: string;
  /** The page's name: the attribute the manifest's `title` names. */
  title: string;
  /** Entities above this one: the way up to the product. */
  trail: EntityRef[];
  blocks: Block[];
  /** The resolution of every `madarch:` link the page's text holds, by the link as written. */
  resolutions: Record<string, Resolution>;
  findings: Finding[];
  /** A reader's notes the page carries: an ambiguous key, a source that moved. */
  notes: string[];
  /** An old member address: the parent page to open, at the member's fragment. */
  redirect?: { id: string; anchor: string };
  /**
   * The planned change this entity's page stands in, and the statements of the page that rely on one (madarch-m38l.14).
   * `product.page` adds it after the page is drawn; the page the renderer builds knows nothing of the product's tasks.
   */
  planned?: { entity: PlannedMarkView | null; statements: (PlannedMarkView & { sentence: string })[]; note?: string };
  /** How many problems name this entity (madarch-m38l.19): the page shows a badge when it is above zero. */
  problems?: number;
}

export interface KindSummary {
  kind: string;
  source: 'graph' | 'markdown' | 'document';
  count: number;
  /** The statements the pages of this kind make, from the index of the Markdown; absent when the index holds none. */
  statements?: number;
  /** The group the navigation and the catalogue put the kind in, when the manifest names one. */
  group?: string;
  /** How the kind's entities came to be: the manifest's word, else read off the entities (agent or person for Markdown pages). */
  origins: ('agent' | 'person' | 'code' | 'history')[];
  /** What the kind is, per interface language, from the manifest. */
  descriptions?: Record<string, string>;
  /** The kind is one page (it names a `file`): the home page is the first such kind. */
  single: boolean;
  /** The kind's name per interface language, from the manifest; absent when the manifest gives none. */
  labels?: Record<string, { one: string; many: string }>;
}

export interface EntityListing {
  operations?: Record<string, import('./operation-catalogue.js').OperationMetadata>;
  kind: string;
  total: number;
  rows: EntityRef[];
  next: string | null;
}

/** One page a refresh changed, as the wiki lists it: the page's id and the title its page shows. */
export interface ChangedPage {
  id: string;
  title: string;
}

export interface FillState {
  /** The index was rebuilt because its deterministic readers changed. */
  rebuilt?: 'extractors-changed';
  state: 'idle' | 'running' | 'done' | 'failed';
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
}

/** One agent unit of the writer, as the wiki shows it. */
export interface WriterUnit {
  /** The unit's id: `product:<slug>` or `domain:<slug>`. */
  unit: string;
  /** The page it writes, relative to the product repository. */
  path: string;
  state: 'waiting' | 'writing' | 'written' | 'failed' | 'not-written';
  writeAttempts?: number;
  calls?: number;
  /** Why the unit's last write was refused, or why the agent failed: the file's line and rule, in words. */
  refusals?: { line: number; rule: string; message: string }[];
}

/** The agent stage that continues the fill: the chosen agent, the units and where they stand. */
export interface WriterState {
  /** `idle` before any run, `waiting` while the code fill runs ahead of it. */
  state: 'idle' | 'waiting' | 'running' | 'done' | 'failed';
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
}

/** What one agent costs to use and what the stage is bound by, stated for the reader before the press. */
export interface WriterBounds {
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
  /** What installing the adapter fetches, when it is not installed. */
  install: { package: string; version: string; size: string; folder: string } | null;
}

export interface WikiStatus {
  product: { name: string; id: string };
  /** `no-manifest` when `madarch/kinds.yaml` is absent. */
  manifest: 'ok' | 'no-manifest';
  manifestFile: string;
  /** The language the product's pages are written in; English when the manifest names none. */
  language: string;
  /** The starter files this server wrote into the product when it had no kinds manifest. */
  seeded: string[];
  /** Why the starter set could not be written into a product that has no manifest. */
  seedError?: string;
  findings: Finding[];
  kinds: KindSummary[];
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
  /** The agent stage after the code fill. */
  writer: WriterState;
  bounds: WriterBounds;
  /** The agent chosen for this product, when one was. */
  chosenAgent: { id: string; label: string; model?: string; reasoning?: string } | null;
  /** The entity the home page shows, when the manifest names one and its file exists. */
  home: string | null;
  /** What each role the manifest declares changes (decision 0031); a role it does not declare reads everything open. */
  roles: Record<string, { open?: string[]; lead: string[] }>;
  /** This is madarch's own wiki (documentation): no fill is offered. Set by the server, not by the product. */
  own?: boolean;
  /** The loop of questions and corrections (madarch-m38l.7), counted from their files. */
  loop: { questionsOpen: number; questionsAnswered: number; correctionsOpen: number; tasksOpen: number; problemsOpen: number };
  /** How many things the current starter set holds that this product's edited manifest lacks (the Problems page offers them). */
  starterOffers: number;
}

/** A Markdown document the wiki shows as a page: of the product repository (`repo` null) or of a connected code repository. */
export interface DocumentRef {
  repo: string | null;
  path: string;
  /** The first heading of the document, else its file name without the extension. */
  title: string;
}

export interface DocumentListing {
  documents: DocumentRef[];
  /** A repository that holds more documents than are listed: its name, how many it holds and how many are listed. */
  truncated: { repo: string | null; total: number; shown: number }[];
}

/** A planned change as a page shows it: the task it belongs to and how the page is reached (its scope, or the graph's impact). */
export interface PlannedMarkView {
  readonly task: { readonly id: string; readonly slug: string; readonly title: string; readonly file: string };
  readonly how: 'scope' | 'impact';
}

/** A section of a document a task plans to change. */
export interface PlannedSectionView extends PlannedMarkView {
  readonly anchor: string | null;
  readonly lines: { readonly start: number; readonly end: number } | null;
}

/** One document drawn as a page: its text, the resolution of every `madarch:` link in it, and where each section anchor is. */
export interface DocumentPage {
  repo: string | null;
  path: string;
  title: string;
  markdown: string;
  resolutions: Record<string, Resolution>;
  /** Anchor (lower case) to the 1-based line that names it. */
  anchors: Record<string, number>;
  /** The commit the text was read at in a code repository; null for the product repository. */
  commit: string | null;
  /** The planned changes on this document's sections (madarch-m38l.14). */
  planned: PlannedSectionView[];
  /** Why the planned changes could not be read: said in place, never shown as "nothing is planned". */
  plannedNote?: string;
}

/** What a ground shows of what it points at: the lines of code with the cited ones marked, or the text of the section. */
export type Excerpt =
  | { type: 'code'; location: CodeLocation; language: string; firstLine: number; text: string; marked: { start: number; end: number }; truncated: boolean }
  | { type: 'text'; markdown: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string } }
  /** A thing of the system (a service, a database, a channel, a contract): its card, not the file it was read from. */
  | { type: 'entity'; entity: EntityRef; facts: { name: string; value: string }[]; related: RelatedGroup[] };

/** One ground of a statement with its excerpt. */
export interface GroundView {
  url: string;
  resolution: Resolution;
  excerpt: Excerpt | null;
}

/** A statement of a page that relies on the same ground, from the index of the Markdown. */
export interface RelyingRef {
  page: string;
  pageTitle: string;
  text: string;
  line: number;
  file: string;
  how: 'grounds' | 'mentions';
  /** The ground it shares. */
  ground: string;
  /** The sentence as the statement view finds it and its turn among equal sentences of the page; absent when the page no longer holds it. */
  sentence?: string;
  turn?: number;
}

/** A statement of an agent's page: the sentence, its paragraph and each ground with its excerpt (the statement view). */
export interface StatementModel {
  page: EntityRef;
  /** The statement's name on its page (its first footnote's name, `~2` from the second use): what a correction names it by; null when unnamed. */
  name: string | null;
  sentence: string;
  /** The paragraph the sentence stands in, as Markdown with its footnote references removed. */
  paragraph: string;
  /** Where the paragraph is in the file. */
  file: string;
  line: number;
  grounded: boolean;
  grounds: GroundView[];
  /** Other statements that rely on the same grounds. */
  relying: RelyingRef[];
  /** The planned change this statement stands in: its own scope, or a ground a task will change (madarch-m38l.14). */
  planned?: PlannedMarkView | null;
  /** Why the planned change could not be read: said in place, never shown as "nothing is planned". */
  plannedNote?: string;
  /** The resolution of every `madarch:` link of the paragraph. */
  resolutions: Record<string, Resolution>;
}
