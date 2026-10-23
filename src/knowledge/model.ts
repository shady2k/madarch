/**
 * The page model the server answers and the app draws (decision 0029): a page
 * is a list of blocks, each already read from the graph or the Markdown, so the
 * app holds no knowledge of any kind and draws only these shapes.
 */
import type { RefreshPlan } from '../loop/plan.js';
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

export type Block =
  | { type: 'markdown'; markdown: string }
  | { type: 'term'; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[] }
  | { type: 'graph'; title: string; mermaid: string; shown: number; total: number }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'er'; title: string; mermaid: string; tables: number; shownTables: number }
  | { type: 'sequence'; title: string; mermaid: string; shown: number; total: number }
  | { type: 'refs'; title: string; total: number; rows: RefRow[] }
  | { type: 'properties'; title: string; rows: { name: string; value: string }[] }
  | { type: 'stated'; title: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string; commit: string | null } }
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
  groups: { group: string; labels: Record<string, string> }[];
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
  /** What each role the manifest declares changes (decision 0031); a role it does not declare reads everything open. */
  roles: Record<string, { open?: string[]; lead: string[] }>;
  /** This is madarch's own wiki (documentation): no fill is offered. Set by the server, not by the product. */
  own?: boolean;
  /** The loop of questions and corrections (madarch-m38l.7), counted from their files. */
  loop: { questionsOpen: number; questionsAnswered: number; correctionsOpen: number };
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

/** What a ground shows of what it points at: the lines of code with the cited ones marked, or the text of the section. */
export type Excerpt =
  | { type: 'code'; location: CodeLocation; language: string; firstLine: number; text: string; marked: { start: number; end: number }; truncated: boolean }
  | { type: 'text'; markdown: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string } };

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
  /** The resolution of every `madarch:` link of the paragraph. */
  resolutions: Record<string, Resolution>;
}
