/**
 * The predicates the engine implements, and the only rules data it keeps
 * (madarch-m38l.19, the review's first finding): the rule set itself — id,
 * kind, Sonar kind, severity, section, action, label and parameters — is the
 * product's, read from `problems.rules` in the manifest. This module names
 * the implementations; a manifest that declares a rule keys it to one of
 * these, and a rule the manifest does not declare is not run.
 */
import { byCodePoint } from '../model/order.js';
import type { ProblemSettings, RuleSpec } from './types.js';

/** The implementations of the code section, by the name a manifest's rule uses. */
export const CODE_PREDICATES = [
  'dependency-cycle',
  'sql-input',
  'route-outside-auth',
  'large-file',
  'change-hotspot',
  'dead-export',
  'debt',
  'config-development-value',
  'dependency-declared-unused',
  'dependency-used-undeclared',
  'operation-without-route',
  'route-without-operation',
] as const;

/** The implementations of the documents section. */
export const DOCUMENT_PREDICATES = [
  'document-contradiction',
  'document-stale',
  'document-undocumented',
  'document-ambiguous',
] as const;

/** The wiki section reads its findings from the loop's own files; every wiki rule names this predicate. */
export const WIKI_PREDICATE = 'wiki';

export const PREDICATES: readonly string[] = [...CODE_PREDICATES, ...DOCUMENT_PREDICATES, WIKI_PREDICATE];

/** Every rule the product declares, with its id, in the manifest's order of ids. */
export function ruleSpecs(settings: ProblemSettings): RuleSpec[] {
  return Object.entries(settings.rules)
    .map(([id, setting]) => ({ id, ...setting }))
    .sort((a, b) => byCodePoint(a.id, b.id));
}

/** The rules one predicate finds with, in id order; a disabled rule is not among them. */
export function rulesOf(settings: ProblemSettings, predicate: string): RuleSpec[] {
  return ruleSpecs(settings).filter((rule) => rule.predicate === predicate && rule.enabled !== false);
}

/**
 * The wiki rule of a finding kind. The kind is the engine's name for what it found; the rule is the
 * product's, so a manifest that declares no rule for the kind says nothing about it (undefined).
 */
export function ruleForKind(settings: ProblemSettings, kind: string): RuleSpec | undefined {
  return ruleSpecs(settings).find((rule) => rule.section === 'wiki' && rule.kind === kind);
}
