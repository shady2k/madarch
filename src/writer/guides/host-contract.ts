import type { GuideDocument, GuideContext, GuideDiagnostic, GuideValidationHost, GuideKind, GuideLocale } from './model.js';

/** Product output identities, not source-repository inference rules. */
export const GUIDE_OUTPUTS = {
  'administrator-guide': { id: 'administrator-guide:main', path: 'docs/guides/administrator.md' },
  'user-guide': { id: 'user-guide:main', path: 'docs/guides/user.md' },
} as const;
export interface GuidePublicationRequest {
  readonly guide: GuideDocument;
  readonly artifact: string;
  readonly expectedContext: GuideContext;
  readonly expectedInputDigest: string;
  readonly expectedUnitVersion: string;
}
export type GuidePublicationResult =
  | { readonly ok: true; readonly path: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly diagnostics: readonly GuideDiagnostic[] };
export interface GuidePreparedUnit {
  readonly prompt: string;
  readonly validation: GuideValidationHost;
  readonly publishChecked: (request: GuidePublicationRequest) => Promise<GuidePublicationResult>;
}
export interface GuideWriterHost {
  prepare(kind: GuideKind, locale: GuideLocale): Promise<GuidePreparedUnit>;
}
