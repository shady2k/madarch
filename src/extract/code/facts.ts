/** Immutable semantic source facts shared by deterministic extractor consumers. */
import type { ImportedName } from '../../fill/stages/resolution-extract.js';
import type { SyntaxLanguage } from '../../fill/stages/syntax-extract.js';
import type { Extraction, ExtractionGap, SourceSpan } from '../records.js';

/** Source positions, not local spellings, identify expressions and bindings. */
export type CodeFactId = string;

export interface CodeImportFact {
  readonly id: CodeFactId;
  readonly path: string;
  readonly local: string;
  readonly specifier: string;
  readonly imported: ImportedName;
  readonly typeOnly?: boolean;
  readonly span: SourceSpan;
  /** Internal target where resolution proves one; absent for external imports. */
  readonly targetPath?: string;
  /** Exact exported value proved by the shared program join; never resolved by consumers. */
  readonly targetExpression?: CodeFactId;
  /** Export fact IDs only; terminal binding identity remains on the export. */
  readonly targetChain?: readonly CodeFactId[];
  /** Declared manifest identity, never guessed from a same-name receiver. */
  readonly package?: { readonly ecosystem: 'go' | 'node'; readonly name: string; readonly manifestPath: string; readonly declaredVersion: string | null };
}

export interface CodeExportFact {
  readonly id: CodeFactId;
  readonly typeOnly?: boolean;
  readonly path: string;
  readonly name: string;
  readonly span: SourceSpan;
  readonly expression?: CodeFactId;
  readonly localBinding?: CodeFactId;
  readonly reexport?: { readonly specifier: string; readonly name: string; readonly targetPath?: string };
}

export interface CodeBindingFact {
  readonly id: CodeFactId;
  readonly path: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver';
  readonly span: SourceSpan;
  readonly scope: SourceSpan;
  readonly importId?: CodeFactId;
  readonly initializer?: CodeFactId;
  /** Exact declaration through initializer, excluding export prefix/trailing separator. */
  readonly declarationSpan?: SourceSpan;
}

/** A grammar expression copied while its syntax tree is alive. No AST node escapes. */
export interface CodeExpressionFact {
  readonly id: CodeFactId;
  readonly path: string;
  readonly syntaxKind: string;
  readonly span: SourceSpan;
  readonly name?: string;
  readonly bindingId?: CodeFactId;
  /** Full receiver expression identity, never a suffix-name approximation. */
  readonly receiver?: CodeFactId;
  readonly member?: string;
  readonly callee?: CodeFactId;
  readonly arguments?: readonly CodeFactId[];
  readonly children: readonly CodeFactId[];
  readonly fields: { readonly [field: string]: readonly CodeFactId[] };
  /** Raw token is retained for evidence; value is absent when decoding is unsupported. */
  readonly literal?: { readonly kind: 'string' | 'number' | 'boolean' | 'null'; readonly raw: string; readonly value?: string | number | boolean | null };
}

export interface CodeSiteFact {
  readonly path: string;
  readonly span: SourceSpan;
  readonly to: string;
  readonly use: 'call' | 'reference' | 'type' | 'extends' | 'implements';
  readonly roles: readonly string[];
  readonly fanOut: readonly string[];
  /** Canonical callable key, or file key for top-level code. */
  readonly holder: string;
}

export interface CodeCallFact {
  readonly expression: CodeFactId;
  readonly path: string;
  readonly span: SourceSpan;
  readonly callee: CodeFactId;
  readonly arguments: readonly CodeFactId[];
  readonly holder: string;
  readonly construct: boolean;
}

export interface CodeSymbolFact {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: boolean;
  readonly span: SourceSpan;
}

export interface CodeFileFact {
  readonly path: string;
  readonly language: SyntaxLanguage;
  readonly parsed: boolean;
  readonly manifest?: { readonly path: string; readonly ecosystem: 'go' | 'node'; readonly name: string };
}

/** Arrays and every nested record are frozen; no mutable maps or live syntax nodes. */
export interface CodeFacts {
  readonly files: readonly CodeFileFact[];
  readonly symbols: readonly CodeSymbolFact[];
  readonly imports: readonly CodeImportFact[];
  readonly exports?: readonly CodeExportFact[];
  readonly bindings: readonly CodeBindingFact[];
  readonly expressions: readonly CodeExpressionFact[];
  readonly calls: readonly CodeCallFact[];
  readonly sites: readonly CodeSiteFact[];
  readonly gaps: readonly ExtractionGap[];
}

export interface CodeExtractionResult {
  readonly extraction: Extraction;
  readonly facts: CodeFacts;
}

export function codeFactId(span: SourceSpan, kind: string): CodeFactId {
  return `${span.path}:${span.byteStart}:${span.byteEnd}:${kind}`;
}

/** Only copied plain records enter this boundary. */
export function freezeCodeFacts(facts: CodeFacts): CodeFacts {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  };
  freeze(facts);
  return facts;
}
