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

export type Block =
  | { type: 'markdown'; markdown: string }
  | { type: 'body'; markdown: string; file: string; statements: number; ungrounded: { text: string; line: number }[] }
  | { type: 'graph'; title: string; mermaid: string; shown: number; total: number }
  | { type: 'related'; title: string; groups: RelatedGroup[] }
  | { type: 'callers'; title: string; total: number; rows: CallRow[] }
  | { type: 'callees'; title: string; total: number; rows: CallRow[] }
  | { type: 'source'; title: string; location: CodeLocation; language: string; text: string; truncated: boolean }
  | { type: 'er'; title: string; mermaid: string; tables: number; shownTables: number }
  | { type: 'sequence'; title: string; mermaid: string; shown: number; total: number }
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
  startedAt?: string;
  finishedAt?: string;
  /** Why the fill failed or could not start. */
  message?: string;
  gaps?: number;
}

export interface WikiStatus {
  product: { name: string; id: string };
  /** `no-manifest` when `madarch/kinds.yaml` is absent. */
  manifest: 'ok' | 'no-manifest';
  manifestFile: string;
  findings: Finding[];
  kinds: KindSummary[];
  repositories: { name: string; filled: boolean }[];
  /** The graph holds facts. */
  filled: boolean;
  /** A repository's fill stopped before its last commit: the graph holds part of it. */
  incomplete: boolean;
  fill: FillState;
  /** The entity the home page shows, when the manifest names one and its file exists. */
  home: string | null;
}
