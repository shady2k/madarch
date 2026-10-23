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

export type RelatedGroup = {
  relation: string;
  direction: 'out' | 'in';
  total: number;
  rows: { entity: EntityRef; count: number; hops?: number }[];
};

export type CallRow = { entity: EntityRef; sites: number; site?: CodeLocation };

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

export type Resolution =
  | { state: 'ok'; target: string; kind: string; label: string; href: string | null; note?: string; location?: CodeLocation; entity?: string }
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
  chosenAgent: { id: string; label: string } | null;
  home: string | null;
  roles?: Record<string, { open?: string[]; lead: string[] }>;
  own?: boolean;
};

export type SourceFile = { repo: string | null; path: string; language: string; commit: string | null; text: string };

export type ProductChoice = { name: string; folder: string; own?: boolean };

export type GlossaryTerm = { id: string; title: string; definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null; repo: string | null; path: string; line: number; endLine: number; anchor: string; href: string };
export type Glossary = { terms: GlossaryTerm[]; resolutions: Record<string, Resolution>; findings: Finding[] };
export type UserSettings = { role: string; asked: boolean; roles: string[] };

export type DocumentRef = { repo: string | null; path: string };
export type DocumentListing = { documents: DocumentRef[]; truncated: { repo: string | null; total: number; shown: number }[] };
export type DocumentPageModel = { repo: string | null; path: string; title: string; markdown: string; resolutions: Record<string, Resolution>; anchors: Record<string, number>; commit: string | null };

export type Excerpt =
  | { type: 'code'; location: CodeLocation; language: string; firstLine: number; text: string; marked: { start: number; end: number }; truncated: boolean }
  | { type: 'text'; markdown: string; place: { repo: string | null; path: string; lineStart: number; lineEnd: number; href: string } };

export type GroundView = { url: string; resolution: Resolution; excerpt: Excerpt | null };

export type RelyingRef = { page: string; pageTitle: string; text: string; line: number; file: string; how: 'grounds' | 'mentions'; ground: string; sentence?: string; turn?: number };

export type StatementModel = {
  page: EntityRef;
  sentence: string;
  paragraph: string;
  file: string;
  line: number;
  grounded: boolean;
  grounds: GroundView[];
  relying: RelyingRef[];
  resolutions: Record<string, Resolution>;
};
