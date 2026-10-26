import type { GuideContext, GuideDiagnostic, GuideKind, GuideLocale, GuideRepository, GuideValidationHost } from './model.js';
import type { GuideWalkHost } from './receipts.js';

/** Complete receipt read: an unavailable or oversized set is never silently shortened. */
export interface GuideReceiptRead {
  readonly receipts: readonly unknown[];
  readonly diagnostics: readonly GuideDiagnostic[];
  readonly locations?: readonly { readonly file: string; lineAt(path: readonly (string | number)[]): number }[];
}
export interface GuideHost {
  /** The actual source pin whose form is product; never inferred from authored grounds. */
  readonly productRepositoryId?: string;
  readonly validation: Omit<GuideValidationHost, 'file'>;
  readonly execution: GuideWalkHost;
  readReceipts(): Promise<GuideReceiptRead>;
}
export interface GuideHostRequest { readonly kind: GuideKind; readonly locale: GuideLocale; readonly context: GuideContext }
export type GuideHostFor = (request: GuideHostRequest) => Promise<GuideHost>;
/** Resolve opaque known/state from real prepared-input authority, never from the artifact. */
export interface GuideContextRequest {
  readonly kind: GuideKind;
  readonly locale: GuideLocale;
  readonly valid: string;
  readonly repositories: readonly GuideRepository[];
}
export type GuideContextFor = (request: GuideContextRequest) => Promise<GuideContext | undefined>;

/** No signing authority has been approved: this capability can never certify a run. */
export function unavailableGuideExecution(file: string): GuideWalkHost {
  return { file, containsSecret: () => { throw new Error('secret authority is unavailable'); }, verifyExecution: async () => ({ kind: 'unverified', reason: 'independent operator authentication is unavailable' }) };
}
