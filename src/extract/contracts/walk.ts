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
import type {SourceSpan} from '../../extract/records.js';

/** Visits every node of a tree, pre-order. */
export function walkTree(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child !== null) walkTree(child, visit);
  }
}

/** The schema's span of a node, measured while the node is alive. */
export function spanOf(node: SyntaxNode, path: string): SourceSpan {
  return {
    path,
    byteStart: node.startIndex,
    byteEnd: node.endIndex,
    lineStart: node.startPosition.row + 1,
    lineEnd: node.endPosition.row + 1,
  };
}

/** The name a call's callee ends with (`HandleFunc` of `mux.HandleFunc`), or undefined. */
export function calleeName(call: SyntaxNode): string | undefined {
  if (call.type !== 'call_expression') return undefined;
  const fn = call.childForFieldName('function');
  if (fn === null) return undefined;
  const name = fn.type === 'identifier' || fn.type === 'field_identifier' || fn.type === 'property_identifier' || fn.type === 'member_expression' || fn.type === 'selector_expression' ? fn.text : undefined;
  if (name === undefined) return undefined;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
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
