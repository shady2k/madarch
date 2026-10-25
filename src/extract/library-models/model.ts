/** Closed models-as-data vocabulary. Repository bytes are never executable rules. */
import type { SourceSpan, ExtractionGap } from '../records.js';

export type LibraryRole = 'metric-counter' | 'metric-gauge' | 'metric-histogram'
  | 'metric-counter-vector' | 'metric-gauge-vector' | 'metric-histogram-vector'
  | 'metric-registry' | 'logger' | 'logger-handler' | 'environment'
  | 'kafka-client' | 'message-producer' | 'message-consumer';
export type LibraryEffectKind = 'metric-declare' | 'metric-update' | 'metric-register'
  | 'metric-expose' | 'metric-text-write' | 'logger-declare' | 'logger-use' | 'env-read'
  | 'message-client' | 'message-publish' | 'message-consume';
export type ImportRole = 'named' | 'default' | 'namespace';
export type ModelTarget = {
  readonly kind: 'export';
  readonly importRoles: readonly ImportRole[];
  /** Paths start at the imported module, not at the local binding spelling. */
  readonly exportedPaths: readonly (readonly string[])[];
} | {
  readonly kind: 'member';
  readonly receiverRole: LibraryRole;
  /** '*' means a static property read, never an arbitrary computed expression. */
  readonly member: string;
};
export interface ArgumentSelector {
  readonly name: string;
  readonly index: number;
  readonly path: readonly string[];
  readonly required: boolean;
}
/** Registry semantics are documented library data, not package spelling rules. */
export interface MetricRegistryMetadata {
  /** Shared namespace for a default registry exposed by cooperating packages. */
  readonly defaultNamespace?: string;
  readonly defaultMember?: boolean;
  readonly defaultRegistry?: boolean;
  readonly defaultTarget?: boolean;
  readonly metricsFrom?: number;
}
export interface TextWriteMetadata {
  readonly format: 'plain' | 'printf';
  readonly argumentsFrom: number;
}
export interface LibraryModel {
  readonly id: string;
  readonly ecosystem: 'node' | 'go';
  readonly package: string;
  readonly target: ModelTarget;
  readonly invoke: 'call' | 'construct' | 'read';
  readonly returnRole?: LibraryRole;
  readonly effect?: LibraryEffectKind;
  readonly metricRegistry?: MetricRegistryMetadata;
  readonly textWrite?: TextWriteMetadata;
  readonly arguments: readonly ArgumentSelector[];
  readonly reference: string;
  /** Output metadata documented by this model; never inferred from local names. */
  readonly presentation?: { readonly library: string; readonly json?: boolean; readonly formatArgument?: string };
  readonly checks: { readonly positive: string; readonly negative: string };
}
/** External type shape is data, not a spelling rule in the evaluator. */
export interface LibraryTypeModel {
  readonly id: string;
  readonly ecosystem: 'go';
  readonly package: string;
  readonly exportedPath: readonly string[];
  readonly shape: 'struct';
  readonly reference: string;
  readonly checks: { readonly positive: string; readonly negative: string };
}
export interface LibraryRegistry {
  readonly schemaVersion: 1;
  readonly models: readonly LibraryModel[];
  readonly types?: readonly LibraryTypeModel[];
}
export interface LibraryOrigin {
  readonly importId: string;
  readonly importSpan: SourceSpan;
  readonly exportedPath: readonly string[];
  /** Binding, expression and model IDs, in proven origin-to-use order. */
  readonly chain: readonly string[];
}
export interface SelectedArgument {
  readonly name: string;
  /** Absence is proven separately from an expression whose value is unresolved. */
  readonly status?: 'selected' | 'absent' | 'unresolved';
  readonly expression?: string;
  readonly span?: SourceSpan;
  readonly required: boolean;
}
export interface LibraryEffect {
  readonly kind: LibraryEffectKind;
  readonly metricRegistry?: MetricRegistryMetadata;
  readonly textWrite?: TextWriteMetadata;
  readonly modelId: string;
  readonly package: string;
  readonly expression: string;
  readonly span: SourceSpan;
  readonly invocationSpan?: SourceSpan;
  readonly holder: string;
  readonly origin: LibraryOrigin;
  readonly receiverExpression?: string;
  readonly member?: string;
  readonly returnRole?: LibraryRole;
  readonly presentation?: { readonly library: string; readonly json?: boolean };
  /** Identity of the role-producing expression, retained through role transitions. */
  readonly roleOrigin?: string;
  readonly arguments: readonly SelectedArgument[];
}
export interface LibraryDiagnostic {
  readonly code: 'dangling-fact' | 'ambiguous-fact' | 'cyclic-origin' | 'unknown-origin'
    | 'dynamic-member' | 'ambiguous-model' | 'unsupported-selector' | 'unproven-builtin';
  readonly path: string;
  readonly span: SourceSpan;
  readonly expression: string;
  readonly modelId?: string;
  readonly reason: string;
}
export interface LibraryRoleFact {
  readonly expression: string;
  readonly metricRegistry?: MetricRegistryMetadata;
  readonly role: LibraryRole;
  readonly roleOrigin: string;
  readonly origin: LibraryOrigin;
}
export interface LibraryEvaluation {
  readonly roles: readonly LibraryRoleFact[];
  readonly effects: readonly LibraryEffect[];
  readonly diagnostics: readonly LibraryDiagnostic[];
  /** Includes every incoming unread/parse gap verbatim, plus located evaluation gaps. */
  readonly gaps: readonly ExtractionGap[];
}
