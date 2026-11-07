
/**
 * One code file's facts, read from the graph as one bounded answer per kind
 * (decision 0033, items 5, 14 and 15; madarch-8bdc.2.4).
 *
 * The code-facts stage publishes what one file's walk read: its expressions with
 * their place, their parent and their named children, its bindings with their
 * initializers, its calls, its Go struct fields, its exports and its callables.
 * The operations reading's observability area — the routes a file registers, the
 * metrics it declares and writes, the logger it declares and uses — is read from
 * those facts, one file at a time, exactly as the extract driver reads them from
 * its in-memory `CodeFacts`. This module is that per-file view: the indexes the
 * driver builds once for a whole tree, built here for one file, and the small
 * proofs both readings share (a value a binding holds, the call a node is, the
 * type a parameter is declared with, the field a selector names).
 *
 * **What it is not.** It holds no tree, no reader and no repository-wide object:
 * every array it answers is the answer of a bounded read by one file's property,
 * page by page, and the only names it resolves are the ones this file's own
 * facts write.
 */
import { byCodePoint } from '../../model/order.js';
import { parsedFileOf, STATIC_READ_ROW_LIMIT, type StaticStageContext } from './static-context.js';

/** Where a fact stands: the bytes and the 1-based lines every fact of the fill carries. */
export interface FactSpan {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One expression a file's walk read, as the graph holds it. */
export interface ExpressionNode {
  readonly id: string;
  readonly syntaxKind: string;
  readonly span: FactSpan;
  readonly parent?: string;
  readonly children: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly operator?: string;
  readonly name?: string;
  readonly receiver?: string;
  readonly member?: string;
  readonly callee?: string;
  readonly arguments?: readonly string[];
  readonly bindingId?: string;
  readonly literal?: { readonly kind: string; readonly raw: string; readonly value?: string | number | boolean | null };
}

/** One binding a file's walk read. */
interface BindingNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver' | 'type';
  readonly span: FactSpan;
  readonly scope: FactSpan;
  readonly initializer?: string;
  readonly importId?: string;
  readonly specifier?: string;
  readonly form?: 'default' | 'namespace' | 'named';
  readonly importedName?: string;
  readonly targetPath?: string;
  readonly declarationSpan?: FactSpan;
}

/** One call site a file's walk read. */
interface CallNode {
  readonly id: string;
  readonly expression: string;
  readonly span: FactSpan;
  readonly invocationSpan?: FactSpan;
  readonly callee?: string;
  readonly arguments: readonly string[];
  readonly construct: boolean;
}

/** One Go struct field a file declares. */
interface FieldNode {
  readonly id: string;
  readonly name: string;
  readonly ownerTypeName: string;
  readonly span: FactSpan;
  readonly typeExpression?: string;
}

/** One name a file exports. */
interface ExportNode {
  readonly id: string;
  readonly name: string;
  readonly span: FactSpan;
  readonly localBinding?: string;
}

/** One callable a file declares or writes as an argument, named as the extract readings name it. */
export interface CallableNode {
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: true;
  readonly span: FactSpan;
  readonly bodySpan?: FactSpan;
  readonly bodySyntaxKind?: string;
}

/** Whether one span holds another whole: the driver's own containment, over bytes. */
export function contains(outer: FactSpan, inner: FactSpan): boolean {
  return outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
}

/** Whether two spans are the same place. */
export function same(outer: FactSpan, inner: FactSpan): boolean {
  return contains(outer, inner) && contains(inner, outer);
}

/** The one item of a list, or none where the list holds zero or several. */
export function unique<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** One page of a bounded read by property, followed to the cursor the graph answers. */
export async function pagesOfProperty(stage: StaticStageContext, kind: string, field: string, value: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows: Readonly<Record<string, unknown>>[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stage.byProperty(kind, field, value, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) rows.push(row.properties);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** One expression's text held by a binding, unwrapped the driver's own way: the literal value a node names. */
export interface CodeFactIndex {
  readonly path: string;
  readonly expressions: ReadonlyMap<string, ExpressionNode>;
  readonly bindings: ReadonlyMap<string, BindingNode>;
  /** The expressions the file holds, in the walk's order: one per node, duplicates dropped as a repeated id is. */
  readonly ordered: readonly ExpressionNode[];
  readonly calls: ReadonlyMap<string, CallNode>;
  readonly fields: readonly FieldNode[];
  readonly exports: readonly ExportNode[];
  readonly callables: readonly CallableNode[];
  readonly imports: readonly BindingNode[];
  /** The expression a value stands at, or none: an id that arrived twice names no expression. */
  expression(id: string): ExpressionNode | undefined;
  /** The children of an expression, in its own order, comments aside. */
  childrenOf(node: ExpressionNode): readonly ExpressionNode[] | undefined;
  /** The child an expression names under one of the grammar's fields, where it holds exactly one. */
  childIn(node: ExpressionNode, field: string): ExpressionNode | undefined;
  /** The binding an expression's identifier resolves to, where the walk resolved it and nothing wrote it since. */
  bindingOf(node: ExpressionNode): BindingNode | undefined;
  /** The value a node names: a literal, the literal a local binding holds, or a one-child wrapper's value. */
  value(id: string, seen?: ReadonlySet<string>): unknown;
  /** The node a chain of wrappers and local bindings ends at. */
  unwrap(id: string, seen?: ReadonlySet<string>): ExpressionNode | undefined;
  /** The call an expression is, where the two facts agree. */
  callOf(id: string): CallNode | undefined;
  /** The innermost callable of the file whose span holds a place. */
  callableAt(span: FactSpan): CallableNode | undefined;
  /** The type name a parameter or receiver binding is declared with, where the declaration states one. */
  declaredTypeName(binding: BindingNode): string | undefined;
  /** The field a selector names, where the receiver's declared type is this file's own declaration of it. */
  fieldNamed(node: ExpressionNode): FieldNode | undefined;
}

/** One code file's facts, as the observability reading asks them. */
export async function readCodeFacts(stage: StaticStageContext, repository: string, path: string): Promise<CodeFactIndex> {
  // One parse of the file's bytes, through the run's memory (madarch-8bdc.2.5): the facts
  // this reading asks for used to be graph nodes written by the code-facts stage, and are
  // now what the file's own bytes say. A second reader of the same file in the same run
  // answers from the memory instead of parsing again.
  const parsed = await parsedFileOf(stage, repository, path);
  const expressions = new Map<string, ExpressionNode>();
  const ordered: ExpressionNode[] = [];
  const duplicates = new Set<string>();
  for (const held of parsed.facts.expressions as unknown as readonly ExpressionNode[]) {
    if (expressions.has(held.id) || duplicates.has(held.id)) { expressions.delete(held.id); duplicates.add(held.id); continue; }
    expressions.set(held.id, held);
    ordered.push(held);
  }
  const bindings = new Map<string, BindingNode>();
  for (const row of parsed.facts.bindings as unknown as readonly BindingNode[]) bindings.set(String(row.id), row);
  const calls = new Map<string, CallNode>();
  for (const row of parsed.facts.calls as unknown as readonly CallNode[]) calls.set(String(row.expression), row);
  const fields = (parsed.facts.fields as unknown as readonly FieldNode[]).slice().sort((left, right) => left.span.byteStart - right.span.byteStart || byCodePoint(left.name, right.name));
  const exports = parsed.facts.exports as unknown as readonly ExportNode[];
  const callables = (parsed.callables as unknown as readonly CallableNode[]).filter((row) => row.callable === true).slice().sort((left, right) => byCodePoint(left.key, right.key));
  const imports = [...bindings.values()].filter((binding) => binding.kind === 'import');

  /** The expressions whose own place is the file's: the driver refuses a fact whose two places disagree. */
  const expression = (id: string): ExpressionNode | undefined => {
    const held = expressions.get(id);
    return held !== undefined && held.span.path === path ? held : undefined;
  };
  const childrenOf = (node: ExpressionNode): readonly ExpressionNode[] | undefined => {
    const children = node.children.map((id) => expression(id));
    if (children.some((child) => child === undefined || !contains(node.span, child.span))) return undefined;
    return (children as ExpressionNode[]).filter((child) => child.syntaxKind !== 'comment');
  };
  const childIn = (node: ExpressionNode, name: string): ExpressionNode | undefined => {
    const id = unique(node.fields[name] ?? []);
    const child = id === undefined ? undefined : expression(id);
    return child !== undefined && node.children.includes(child.id) && contains(node.span, child.span) ? child : undefined;
  };
  /** A binding the walk resolved, in the scope that holds the identifier and before it was written. */
  const checkBinding = (node: ExpressionNode, binding: BindingNode | undefined): BindingNode | undefined => {
    if (binding === undefined || binding.span.path !== node.span.path) return undefined;
    if (!contains(binding.scope, node.span)) return undefined;
    if (binding.kind === 'local' && binding.span.byteStart > node.span.byteStart) return undefined;
    return binding;
  };
  const bindingOf = (node: ExpressionNode): BindingNode | undefined => checkBinding(node, node.bindingId === undefined ? undefined : bindings.get(node.bindingId));
  const value = (id: string, seen: ReadonlySet<string> = new Set()): unknown => {
    if (seen.has(id)) return undefined;
    const next = new Set(seen); next.add(id);
    const node = expression(id);
    if (node === undefined) return undefined;
    if (node.literal !== undefined) return node.literal.value;
    if (node.bindingId !== undefined) {
      const binding = bindings.get(node.bindingId);
      return binding?.kind === 'local' && binding.initializer !== undefined ? value(binding.initializer, next) : undefined;
    }
    if (['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'literal_element'].includes(node.syntaxKind)) {
      return node.children.length === 1 ? value(node.children[0]!, next) : undefined;
    }
    if (node.syntaxKind === 'composite_literal') {
      const body = node.fields['body'];
      return body?.length === 1 ? value(body[0]!, next) : undefined;
    }
    if (node.syntaxKind === 'array' || node.syntaxKind === 'literal_value') {
      const children = node.children.map((child) => expression(child)).filter((child) => child?.syntaxKind !== 'comment');
      if (children.some((child) => child?.syntaxKind === 'keyed_element')) return undefined;
      const values = children.map((child) => (child === undefined ? undefined : value(child.id, next)));
      return values.some((held) => held === undefined) ? undefined : values;
    }
    return undefined;
  };
  const unwrap = (id: string, seen: ReadonlySet<string> = new Set()): ExpressionNode | undefined => {
    if (seen.has(id) || seen.size > 80) return undefined;
    const next = new Set(seen); next.add(id);
    const node = expression(id);
    if (node === undefined) return undefined;
    if (node.bindingId !== undefined) {
      const binding = checkBinding(node, bindings.get(node.bindingId));
      if (binding?.kind === 'local' && binding.initializer !== undefined) return unwrap(binding.initializer, next);
    }
    if (['parenthesized_expression', 'literal_element', 'expression_list'].includes(node.syntaxKind)) {
      const child = unique(childrenOf(node) ?? []);
      return child === undefined ? undefined : unwrap(child.id, next);
    }
    return node;
  };
  const callOf = (id: string): CallNode | undefined => {
    const node = expression(id);
    const call = calls.get(id);
    if (node === undefined || call === undefined || !same(call.span, node.span) || node.callee !== call.callee) return undefined;
    if (JSON.stringify(node.arguments ?? []) !== JSON.stringify(call.arguments) || !node.children.includes(call.callee ?? '')) return undefined;
    return call.arguments.some((argument) => {
      const held = expression(argument);
      return held === undefined || !contains(call.span, held.span);
    }) ? undefined : call;
  };
  const callableAt = (span: FactSpan): CallableNode | undefined => {
    const held = callables.filter((callable) => callable.span.byteStart <= span.byteStart && span.byteStart < callable.span.byteEnd);
    const nearest = held.sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart))[0];
    if (nearest === undefined) return undefined;
    return nearest.bodySpan !== undefined && contains(nearest.bodySpan, span) ? nearest : undefined;
  };
  const declaredTypeName = (binding: BindingNode): string | undefined => {
    const declaration = ordered.find((node) => ['parameter_declaration', 'variadic_parameter_declaration'].includes(node.syntaxKind) && contains(node.span, binding.span) &&
      (node.fields['name'] ?? []).some((id) => { const name = expression(id); return name?.bindingId === binding.id && same(name.span, binding.span); }));
    const type = declaration === undefined ? undefined : childIn(declaration, 'type');
    if (type === undefined) return undefined;
    const plain = type.syntaxKind === 'pointer_type' ? unique(childrenOf(type) ?? []) : type;
    return plain?.syntaxKind === 'type_identifier' ? plain.name : undefined;
  };
  const fieldNamed = (node: ExpressionNode): FieldNode | undefined => {
    if (node.member === undefined || node.receiver === undefined) return undefined;
    const receiver = expression(node.receiver);
    if (receiver === undefined) return undefined;
    const receiverBinding = bindingOf(receiver);
    const typeName = receiverBinding === undefined ? undefined : declaredTypeName(receiverBinding);
    if (typeName === undefined) return undefined;
    return unique(fields.filter((field) => field.ownerTypeName === typeName && field.name === node.member));
  };
  return { path, expressions, bindings, ordered, calls, fields, exports, callables, imports, expression, childrenOf, childIn, bindingOf, value, unwrap, callOf, callableAt, declaredTypeName, fieldNamed };
}

/** The field symbol key the extract readings give one field of one declared type. */
export function fieldSymbolKeyOf(path: string, ownerTypeName: string, name: string): string {
  return `code.symbol:${path}#${ownerTypeName}.${name}`;
}

/** The symbol key of one callable the fill publishes: the key the extract readings give it. */
export function callableSymbolKeyOf(path: string, qualifiedName: string): string {
  return `code.symbol:${path}#${qualifiedName}`;
}
