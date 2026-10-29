/**
 * What the Problems page holds (madarch-m38l.19): one shape for the three
 * sections the page shows — the code, the documents and the wiki — and one
 * taxonomy for how serious a problem is. A rule is data (its id, the Sonar
 * kind, the severity it starts with and the threshold it reads); the engine
 * reads that data, so a product changes a threshold in its manifest instead
 * of changing this module.
 */

/** The section of the page a problem belongs to. */
export type ProblemSection = 'code' | 'documents' | 'wiki';

/** The kind of finding, in the words of the SonarQube taxonomy. */
export type SonarKind = 'vulnerability' | 'bug' | 'code-smell' | 'security-hotspot';

/** How serious a finding is. */
export type ProblemSeverity = 'blocker' | 'critical' | 'major' | 'minor' | 'info';

export const SONAR_KINDS: readonly SonarKind[] = ['vulnerability', 'bug', 'code-smell', 'security-hotspot'];
export const PROBLEM_SEVERITIES: readonly ProblemSeverity[] = ['blocker', 'critical', 'major', 'minor', 'info'];

/** A link the page shows: a place or an entity, with the wiki address that opens it when there is one. */
export interface ProblemLink {
  readonly label: string;
  /** The wiki address; null for a place the wiki cannot open (a source file of a product, say). */
  readonly href: string | null;
  /** The graph key or page id the link names, when it names one. */
  readonly key: string | null;
}

/** One problem, before it is given its stable id. */
export interface ProblemDraft {
  readonly section: ProblemSection;
  readonly rule: string;
  readonly kind: string;
  readonly sonar: SonarKind;
  readonly severity: ProblemSeverity;
  readonly fixer: 'agent' | 'person';
  readonly closed: boolean;
  readonly reason: string;
  readonly file: string;
  readonly line: number | null;
  readonly page: string | null;
  readonly pageTitle: string | null;
  readonly statement: string | null;
  readonly sentence: string | null;
  readonly target: string | null;
  readonly place: ProblemLink;
  readonly entity: ProblemLink | null;
  readonly evidence: readonly ProblemLink[];
  readonly by: { name: string; email: string; verified: string } | null;
  readonly at: string | null;
  readonly source?: string;
  /** The key the problem's id is built from: stable while the problem is the same one. */
  readonly identity: string;
  /** What pressing «Создать задачу» opens a task on; absent where the page offers no task. */
  readonly scope?: ProblemScope;
}

/** The place a created task changes, in the task format's own words. */
export type ProblemScope =
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'symbol'; readonly key: string }
  | { readonly type: 'lines'; readonly path: string; readonly start: number; readonly end: number };

/** A rule's data: what it is called, how serious it starts, and what the page offers on a finding. */
export interface RuleSpec {
  readonly id: string;
  readonly kind: string;
  readonly sonar: SonarKind;
  readonly severity: ProblemSeverity;
  readonly section: ProblemSection;
  readonly action: 'task' | 'none';
  readonly label: { readonly en: string; readonly ru: string };
}

/** One rule's override, as a product's manifest writes it. */
export interface RuleSetting {
  readonly enabled?: boolean;
  readonly severity?: ProblemSeverity;
}

/** The thresholds the rules read; a product's manifest may lower or raise them. */
export interface ProblemThresholds {
  readonly largeFileLines: number;
  readonly hotspotLines: number;
  readonly hotspotCommits: number;
  readonly hotspotScore: number;
}

export interface ProblemSettings {
  readonly rules: Readonly<Record<string, RuleSetting>>;
  readonly thresholds: ProblemThresholds;
}

export const DEFAULT_THRESHOLDS: ProblemThresholds = {
  // A file a person cannot hold in their head is a file of its own finding. 600 lines is the starter set's line.
  largeFileLines: 600,
  // A change hotspot is both big and often changed: 200 lines, 10 commits and a size × churn score of 10,000.
  hotspotLines: 200,
  hotspotCommits: 10,
  hotspotScore: 10_000,
};

/** The stable id of a problem: its rule and identity, never its position in a list. */
export const problemId = (rule: string, identity: string): string => `${rule}\u0000${identity}`;

export const defaultSettings = (): ProblemSettings => ({ rules: {}, thresholds: { ...DEFAULT_THRESHOLDS } });
