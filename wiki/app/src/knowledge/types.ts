/**
 * The shapes the knowledge wiki's API answers (`src/knowledge/model.ts` and
 * `src/server/knowledge.ts` in the engine): the app draws these and holds no
 * knowledge of any kind, template or block beyond them.
 */

export type Finding = { file: string; line: number; message: string };

export type CodeLocation = { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string };

export type EntityRef = {
  id: string;
  kind: string;
  label: string;
  href: string | null;
  location?: CodeLocation;
  broken?: string;
};

export type RelatedGroup = {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  rows: { entity: EntityRef; count: number; hops?: number }[];
};

export type CallRow = { entity: EntityRef; sites: number; site?: CodeLocation };

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

export type Resolution =
  | { state: 'ok'; target: string; kind: string; label: string; href: string | null; note?: string; location?: CodeLocation }
  | { state: 'broken'; target: string; reason: string };

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

export type KindSummary = { kind: string; source: 'graph' | 'markdown'; count: number; single: boolean };

export type EntityListing = { kind: string; total: number; rows: EntityRef[]; next: string | null };

export type FillState = {
  state: 'idle' | 'running' | 'done' | 'failed';
  repository?: string;
  commit?: number;
  commits?: number;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  gaps?: number;
};

export type WikiStatus = {
  product: { name: string; id: string };
  manifest: 'ok' | 'no-manifest';
  manifestFile: string;
  findings: Finding[];
  kinds: KindSummary[];
  repositories: { name: string; filled: boolean }[];
  filled: boolean;
  incomplete: boolean;
  fill: FillState;
  home: string | null;
};

export type SourceFile = { repo: string | null; path: string; language: string; commit: string | null; text: string };

export type ProductChoice = { name: string; folder: string };
