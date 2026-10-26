/**
 * Walking helpers shared by the contracts extractor's code readers. They only
 * shape tree-sitter's nodes (web-tree-sitter, the grammars of
 * src/fill/stages/syntax-extract.ts) into questions a reader asks: which call
 * expressions stand in a tree, what a callee is named, what a string holds.
 * A node lives no longer than the `readSyntaxTree` call that produced it, so
 * every reader turns what it needs into plain data -- spans included -- before
 * the walk returns.
 */
import type {Node as SyntaxNode} from 'web-tree-sitter';
import {spanFactory} from '../../fill/stages/syntax-extract.js';
import type {SourceSpan} from '../../extract/records.js';

/** Visits every node of a tree, pre-order. */
export function walkTree(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) walkTree(child, visit);
  }
}

const measurements = new WeakMap<object, ReturnType<typeof spanFactory>>();
/** The schema's span of a node, measured while the node is alive. */
export function spanOf(node: SyntaxNode, path: string): SourceSpan {
  const tree = node.tree;
  let measure = measurements.get(tree);
  if (measure === undefined) {measure = spanFactory(tree.rootNode.text); measurements.set(tree, measure);}
  const span = measure(node);
  return {path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine};
}

/**
 * The name a call's callee ends with (`HandleFunc` of `mux.HandleFunc`), or undefined.
 *
 * The grammar answers which name that is: the property of a `member_expression` (TypeScript's
 * `mux.HandleFunc`), the field of a `selector_expression` (Go's), or a plain `identifier`,
 * `field_identifier` or `property_identifier`. The reader used to slice the last dot off the
 * callee's own text, which read a name out of the source rather than out of the tree.
 *
 * What it refuses, and the text read accepted nothing there either: a callee of another kind --
 * a parenthesized or subscripted callee (`(a.b)(x)`, `handlers[name]`), a computed property, a
 * wrapper or an awaiting expression. The one shape the text read did answer and this one does not
 * is a member whose property the grammar could not read: the incomplete `a.` answered the empty
 * name, and an empty name now matches no callee.
 */
export function calleeName(call: SyntaxNode): string | undefined {
  if (call.type !== 'call_expression') return undefined;
  const fn = call.childForFieldName('function');
  if (fn === null) return undefined;
  if (fn.type === 'member_expression' || fn.type === 'selector_expression') {
    const name = fn.childForFieldName('property') ?? fn.childForFieldName('field');
    return name === null ? undefined : name.text;
  }
  return fn.type === 'identifier' || fn.type === 'field_identifier' || fn.type === 'property_identifier' ? fn.text : undefined;
}

/** Every call expression whose callee ends with one of the names. */
export function callsNamed(root: SyntaxNode, names: ReadonlySet<string>): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  walkTree(root, (node) => {
    if (node.type === 'call_expression' && names.has(calleeName(node) ?? '')) out.push(node);
  });
  return out;
}

/** The text of a string literal without its quotes, or undefined. */
export function stringValue(node: SyntaxNode | null): string | undefined {
  if (node === null) return undefined;
  if (node.type === 'interpreted_string_literal' || node.type === 'string' || node.type === 'raw_string_literal') {
    return node.text.slice(1, -1);
  }
  return undefined;
}

/** The name of the function or method a node stands in, if one does. */
export function enclosingFunctionName(node: SyntaxNode): string | undefined {
  let held: SyntaxNode | null = node;
  while (held !== null) {
    if (held.type === 'function_declaration' || held.type === 'method_definition' || held.type === 'method_declaration') {
      const name = held.childForFieldName('name');
      return name?.text;
    }
    held = held.parent;
  }
  return undefined;
}
