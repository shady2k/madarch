/** Plain guide artifacts. Scheduling and execution belong to their existing owners. */
export const GUIDE_SCHEMA = 'madarch.product-guide@1';
export const GUIDE_RECEIPT_SCHEMA = 'madarch.guide-walk@1';
export type GuideKind = 'administrator-guide' | 'user-guide';
export type GuideLocale = 'en' | 'ru';
export interface GuideRepository { readonly name: string; readonly commit: string }
export interface GuideContext {
  readonly valid: string;
  readonly known: string;
  readonly state: string;
  readonly repositories: readonly GuideRepository[];
}
export interface GuideGround {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly line: number;
  readonly endLine: number;
}
/** Secret values never belong to this artifact: only names and reader-facing instructions. */
export interface GuideInput { readonly name: string; readonly description: string; readonly secret: boolean }
export interface GuideStep {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly environment: string;
  readonly inputs: readonly GuideInput[];
  readonly instruction: { readonly kind: 'command' | 'http'; readonly content: string };
  readonly expected: { readonly status: number; readonly observation: string };
  readonly grounds: readonly GuideGround[];
}
export interface GuideProcedure {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly role: string;
  readonly prerequisites: readonly string[];
  readonly steps: readonly GuideStep[];
}
export interface GuideDocument {
  readonly schema: typeof GUIDE_SCHEMA;
  readonly id: string;
  readonly kind: GuideKind;
  readonly locale: GuideLocale;
  readonly title: string;
  readonly context: GuideContext;
  readonly unitVersion: string;
  readonly inputDigest: string;
  readonly prerequisites: readonly string[];
  readonly gaps: readonly string[];
  readonly procedures: readonly GuideProcedure[];
}
export interface GuideDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
/** The verifier is supplied by the host, never by the agent's artifact. */
export interface GuideValidationHost {
  readonly file: string;
  readonly expectedContext: GuideContext;
  readonly expectedInputDigest: string;
  readonly expectedUnitVersion: string;
  /** Host must check instruction AND expected result against the named pinned spans. */
  verifyStep(step: GuideStep, procedure: GuideProcedure, guide: GuideDocument): Promise<readonly string[]>;
  /** The host checks sensitive values without returning those values in diagnostics. */
  containsSecret(text: string): boolean;
}
export interface GuideReceipt {
  readonly schema: typeof GUIDE_RECEIPT_SCHEMA;
  readonly guide: string;
  readonly procedure: string;
  readonly step: string;
  readonly context: GuideContext;
  readonly unitVersion: string;
  readonly inputDigest: string;
  readonly commandDigest: string;
  readonly environment: string;
  readonly prerequisitesDigest: string;
  readonly cwd: string;
  readonly at: string;
  readonly evidence: string;
  readonly actualStatus: number;
  readonly observed: string;
}
export type GuideWalkStatus = 'passed' | 'failed' | 'not-walked';
