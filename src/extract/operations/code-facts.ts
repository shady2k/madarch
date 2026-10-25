/** Read static values and identities from copied code facts, never source text. */
import type { CodeExpressionFact, CodeFacts } from '../code/facts.js';
import type { LibraryEffect } from '../library-models/model.js';
import type { Records } from './accumulate.js';
import type { TreeText } from './source.js';
import { functionNode, functionsOf } from './symbol-sites.js';

/** Materialize only a unique validated canonical owner from the shared pass. */
export function effectOwner(t: TreeText, records: Records, effect: LibraryEffect): string | undefined {
  if (effect.holder === `code.file:${effect.span.path}`) return records.file(effect.span.path);
  const sites = functionsOf(t, effect.span.path).filter((site) => site.key === effect.holder &&
    site.span.byteStart <= effect.span.byteStart && effect.span.byteEnd <= site.span.byteEnd);
  if (sites.length !== 1) {
    records.gap(effect.span.path, `line ${effect.span.lineStart}: library effect has no unique canonical callable owner ${effect.holder}`);
    return undefined;
  }
  return functionNode(records, sites[0]!);
}

/** Keep full invocation evidence while selecting the independently proved prefix. */
export function effectSpan(effect: LibraryEffect) {
  const prefix = effect.invocationSpan;
  return prefix !== undefined && prefix.path === effect.span.path && prefix.byteStart === effect.span.byteStart &&
    prefix.byteEnd > prefix.byteStart && prefix.byteEnd <= effect.span.byteEnd && prefix.lineStart === effect.span.lineStart &&
    prefix.lineEnd >= prefix.lineStart && prefix.lineEnd <= effect.span.lineEnd ? prefix : effect.span;
}

export class CodeFactView {
  readonly expressions: ReadonlyMap<string, CodeExpressionFact>;
  private readonly written = new Set<string>();
  constructor(readonly facts: CodeFacts) {
    this.expressions = new Map(facts.expressions.map((expression) => [expression.id, expression]));
    const mark = (id: string, seen = new Set<string>()): void => {
      if (seen.has(id)) return; seen.add(id);
      const expression = this.expressions.get(id); if (expression === undefined) return;
      if (expression.bindingId !== undefined) this.written.add(expression.bindingId);
      for (const child of expression.children) mark(child, seen);
    };
    for (const expression of facts.expressions) {
      if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(expression.syntaxKind)) for (const id of expression.fields.left ?? []) mark(id);
      if (['update_expression', 'inc_statement', 'dec_statement'].includes(expression.syntaxKind)) for (const id of expression.children) mark(id);
    }
  }

  value(id: string, seen: Set<string> = new Set()): unknown {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const expression = this.expressions.get(id);
    if (expression === undefined) return undefined;
    if (expression.literal !== undefined) return expression.literal.value;
    if (expression.bindingId !== undefined) {
      if (this.written.has(expression.bindingId)) return undefined;
      const binding = this.facts.bindings.find((binding) => binding.id === expression.bindingId);
      return binding?.kind === 'local' && binding.initializer !== undefined ? this.value(binding.initializer, seen) : undefined;
    }
    if (['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'literal_element'].includes(expression.syntaxKind)) {
      return expression.children.length === 1 ? this.value(expression.children[0]!, seen) : undefined;
    }
    if (expression.syntaxKind === 'composite_literal') {
      const body = expression.fields.body;
      return body?.length === 1 ? this.value(body[0]!, seen) : undefined;
    }
    if (expression.syntaxKind === 'array' || expression.syntaxKind === 'literal_value') {
      const children = expression.children.map((child) => this.expressions.get(child)).filter((child) => child?.syntaxKind !== 'comment');
      if (children.some((child) => child?.syntaxKind === 'keyed_element')) return undefined;
      const values = children.map((child) => child === undefined ? undefined : this.value(child.id, new Set(seen)));
      return values.some((value) => value === undefined) ? undefined : values;
    }
    return undefined;
  }

  bindingForInitializer(id: string) {
    return this.facts.bindings.filter((binding) => binding.initializer === id);
  }
}

/** Copied library-model origin retained with each semantic record. */
export function libraryEvidence(effect: import('../library-models/model.js').LibraryEffect) {
  return { model: effect.modelId, library: effect.package, invocationSpan: { ...effect.span }, origin: {
    importId: effect.origin.importId, importSpan: { ...effect.origin.importSpan },
    exportedPath: [...effect.origin.exportedPath], chain: [...effect.origin.chain],
    ...(effect.roleOrigin === undefined ? {} : { roleOrigin: effect.roleOrigin }),
  } };
}

