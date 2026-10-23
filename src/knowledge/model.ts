/**
 * The page model the server answers and the app draws (decision 0029): a page
 * is a list of blocks, each already read from the graph or the Markdown, so the
 * app holds no knowledge of any kind and draws only these shapes.
 */
import type { Finding } from './kinds.js';
import type { Resolution } from './resolve.js';

/** Where a piece of code is: the file in a repository and its lines. */
export interface CodeLocation {
  /** The code repository's name in the manifest; null for the product repository. */
  repo: string | null;
  path: string;
  lineStart: number;
  lineEnd: number;
  /** The address of the source view at the first line. */
  href: string;
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
  note?: string;
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

export type Block =
  | { type: 'markdown'; markdown: string }
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
  | { type: 'problem'; block: string; message: string; file: string; line: number };

export interface PageModel {
  id: string;
  kind: string;
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
}

export interface KindSummary {
  kind: string;
  source: 'graph' | 'markdown';
  count: number;
  /** The kind is one page (it names a `file`): the home page is the first such kind. */
  single: boolean;
  /** The kind's name per interface language, from the manifest; absent when the manifest gives none. */
  labels?: Record<string, { one: string; many: string }>;
}

export interface EntityListing {
  kind: string;
  total: number;
  rows: EntityRef[];
  next: string | null;
}

export interface FillState {
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
  /** Why the fill failed or could not start. */
  message?: string;
  gaps?: number;
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
  chosenAgent: { id: string; label: string } | null;
  /** The entity the home page shows, when the manifest names one and its file exists. */
  home: string | null;
}

/** A Markdown document the wiki shows as a page: of the product repository (`repo` null) or of a connected code repository. */
export interface DocumentRef {
  repo: string | null;
  path: string;
}

export interface DocumentListing {
  documents: DocumentRef[];
  /** A repository that holds more documents than are listed: its name, how many it holds and how many are listed. */
  truncated: { repo: string | null; total: number; shown: number }[];
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
}
