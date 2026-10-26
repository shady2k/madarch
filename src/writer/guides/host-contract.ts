import { readFileSync } from 'node:fs';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath } from '../../model/yaml-position.js';
import { readKinds } from '../../knowledge/kinds.js';
import type { GuideDocument, GuideContext, GuideDiagnostic, GuideValidationHost, GuideKind, GuideLocale } from './model.js';

/** Starter defaults and stable protocol identities. Runtime paths MUST come from registeredGuideOutput. */
export const GUIDE_OUTPUTS = {
  'administrator-guide': { id: 'administrator-guide:main', path: 'docs/guides/administrator.md' },
  'user-guide': { id: 'user-guide:main', path: 'docs/guides/user.md' },
} as const;
export interface RegisteredGuideOutput { readonly id: string; readonly path: string }
/** The product registry alone selects a guide's file. Invalid declarations never fall back to starter defaults. */
export function registeredGuideOutput(productFolder: string, kind: GuideKind): RegisteredGuideOutput {
  const read = readKinds(productFolder);
  const declaration = read.present ? read.manifest.kinds.get(kind) : undefined;
  if (declaration?.source !== 'markdown' || declaration.file === undefined) {
    const file = read.present ? read.manifest.file : read.file;
    let line = 1;
    try { const lines = new LineCounter(); const document = parseDocument(readFileSync(file, 'utf8'), { lineCounter: lines }); line = lineForPath(document, lines, ['kinds', kind, 'file']); } catch { /* Unreadable registry is a whole-file problem. */ }
    throw new Error(`${file}:${line}: kinds.${kind}.file: a valid single-file Markdown guide declaration is required`);
  }
  return { id: GUIDE_OUTPUTS[kind].id, path: declaration.file };
}
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
