/**
 * What one module's syntax says about its calls and its member expressions.
 *
 * Two rules read what a module *does* rather than what it imports: `test-case-bound`
 * reads the arguments of `bound()` and the third argument of `test()`, and
 * `test-integration-reach` reads the argument `createTestDatabaseOwner` is given.
 * `test-timing-only-in-measure` and the process check read member expressions
 * (`performance.now`, `Bun.spawn`, `process.hrtime`). swc parses the module once, and
 * this module reports those two shapes from that one parse — never a pattern read
 * from the text.
 *
 * Only what a rule needs is read: the callee's name, the 1-based line, and the
 * literal values and object keys among the arguments. Anything computed is reported
 * as what it is (`other`), so a rule can refuse it by name rather than guess.
 */
import { readFileSync } from 'node:fs';
import { parseSync } from '@swc/core';
import { absolutePathOf } from '../architecture/sources.js';

/** A literal a rule can read: a number or a string. */
export type Literal = { readonly kind: 'number'; readonly value: number } | { readonly kind: 'string'; readonly value: string };

/** One property of an object literal, and the literal it is set to when it is one. */
export interface PropertySyntax {
  /** The key as written, for an identifier or a string key; `*` for a computed key. */
  readonly key: string;
  readonly literal: Literal | null;
  /** The 1-based line the property stands on. */
  readonly line: number;
}

/** One element of an array literal. */
export interface ElementSyntax {
  readonly literal: Literal | null;
  /** The 1-based line the element stands on. */
  readonly line: number;
}

/** One call argument: its literal (when it is one), its identifier or callee name, and its object or array shape. */
export interface ArgumentSyntax {
  /** The 1-based line the argument starts on. */
  readonly line: number;
  readonly literal: Literal | null;
  /** The identifier as written, when the argument is one. */
  readonly identifier: string | null;
  /** The callee's name, when the argument is a call. */
  readonly call: string | null;
  readonly properties: readonly PropertySyntax[];
  readonly elements: readonly ElementSyntax[];
}

/** One call: the callee as written (`test`, `bound`, `createTestDatabaseOwner`), and its arguments. */
export interface CallSyntax {
  readonly name: string;
  /** True for the case invocation in test.each(...)(...) rather than the table setup. */
  readonly calleeIsCall: boolean;
  /** The 1-based line the call starts on. */
  readonly line: number;
  readonly arguments: readonly ArgumentSyntax[];
}

/**
 * One member expression, as a path from its root: `process.hrtime.bigint` is
 * `['process', 'hrtime', 'bigint']`. A computed property has no name and ends the
 * path, so the reader gets only the static part.
 */
export interface MemberSyntax {
  readonly segments: readonly string[];
  /** The 1-based line the member expression starts on. */
  readonly line: number;
}

export interface ModuleSyntax {
  readonly calls: readonly CallSyntax[];
  readonly members: readonly MemberSyntax[];
  /** Every array literal in the module: the shape a command line is written in. */
  readonly arrays: readonly (readonly ElementSyntax[])[];
}

/** The calls and member expressions of one module of the repository or of a fixture. */
export function moduleSyntaxOf(root: string, file: string): ModuleSyntax {
  const path = absolutePathOf(root, file);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${path}:1: the module could not be read: ${(error as Error).message}`);
  }
  return moduleSyntaxOfSource(source, file, path);
}

/** The same, for a source already in hand. A source that does not parse is refused by name. */
export function moduleSyntaxOfSource(source: string, file: string, path: string): ModuleSyntax {
  let module;
  try {
    module = parseSync(source, parseOptionsOf(file));
  } catch (error) {
    throw new Error(`${path}:1: the module could not be parsed by swc as TypeScript: ${(error as Error).message}`);
  }
  const bytes = new TextEncoder().encode(source);
  const calls: CallSyntax[] = [];
  const members: MemberSyntax[] = [];
  const arrays: ElementSyntax[][] = [];
  walk(module, (value) => {
    const node = value as Record<string, unknown>;
    if (node['type'] === 'CallExpression') {
      const callee = nameOf(node['callee']);
      const span = node['span'] as { start: number } | undefined;
      if (callee !== null && span !== undefined) {
        const args = Array.isArray(node['arguments']) ? (node['arguments'] as Record<string, unknown>[]) : [];
        calls.push({ name: callee, calleeIsCall: (node['callee'] as Record<string, unknown>)['type'] === 'CallExpression', line: lineAt(bytes, span.start), arguments: args.map((argument) => argumentOf(argument, bytes)) });
      }
    } else if (node['type'] === 'MemberExpression') {
      const segments = segmentsOf(node);
      const span = node['span'] as { start: number } | undefined;
      if (segments !== null && segments.length > 1 && span !== undefined) {
        members.push({ segments, line: lineAt(bytes, span.start) });
      }
    } else if (node['type'] === 'ArrayExpression' && Array.isArray(node['elements'])) {
      const elements = (node['elements'] as (Record<string, unknown> | null)[]).flatMap((element) => elementOf(element, bytes));
      arrays.push(elements);
    }
  });
  return { calls, members, arrays };
}

function argumentOf(argument: Record<string, unknown>, bytes: Uint8Array): ArgumentSyntax {
  const expression = (argument['expression'] ?? {}) as Record<string, unknown>;
  const span = (expression['span'] ?? argument['span']) as { start: number } | undefined;
  const line = span === undefined ? 1 : lineAt(bytes, span.start);
  const literal = literalOf(expression);
  const properties = expression['type'] === 'ObjectExpression' && Array.isArray(expression['properties'])
    ? (expression['properties'] as Record<string, unknown>[]).flatMap((property) => propertyOf(property, bytes))
    : [];
  const identifier = expression['type'] === 'Identifier' ? String((expression as Record<string, unknown>)['value']) : null;
  const call = expression['type'] === 'CallExpression' ? nameOf(expression['callee']) : null;
  const elements = expression['type'] === 'ArrayExpression' && Array.isArray(expression['elements'])
    ? (expression['elements'] as (Record<string, unknown> | null)[]).flatMap((element) => elementOf(element, bytes))
    : [];
  return { line, literal, identifier, call, properties, elements };
}

function propertyOf(property: Record<string, unknown>, bytes: Uint8Array): PropertySyntax[] {
  if (property['type'] === 'Identifier') {
    const span = property['span'] as { start: number };
    return [{ key: String(property['value']), literal: null, line: lineAt(bytes, span.start) }];
  }
  if (property['type'] !== 'KeyValueProperty') return [];
  const key = keyOf(property['key']);
  if (key === null) return [];
  const value = (property['value'] ?? {}) as Record<string, unknown>;
  const span = (property['span'] ?? value['span']) as { start: number } | undefined;
  return [{ key, literal: literalOf(value), line: span === undefined ? 1 : lineAt(bytes, span.start) }];
}

function elementOf(element: Record<string, unknown> | null, bytes: Uint8Array): ElementSyntax[] {
  if (element === null) return [];
  const expression = (element['expression'] ?? element) as Record<string, unknown>;
  const span = (expression['span'] ?? element['span']) as { start: number } | undefined;
  return [{ literal: literalOf(expression), line: span === undefined ? 1 : lineAt(bytes, span.start) }];
}

function literalOf(expression: Record<string, unknown>): Literal | null {
  if (expression['type'] === 'NumericLiteral') return { kind: 'number', value: Number(expression['value']) };
  if (expression['type'] === 'StringLiteral') return { kind: 'string', value: String(expression['value']) };
  return null;
}

function keyOf(key: unknown): string | null {
  if (key === null || typeof key !== 'object') return null;
  const held = key as Record<string, unknown>;
  if (held['type'] === 'Identifier' || held['type'] === 'StringLiteral') return String(held['value']);
  return '*';
}

/** The callee's name: an identifier as written, or a static member path joined with dots. */
function nameOf(callee: unknown): string | null {
  if (callee === null || typeof callee !== 'object') return null;
  const held = callee as Record<string, unknown>;
  if (held['type'] === 'Identifier') return String(held['value']);
  if (held['type'] === 'CallExpression') return nameOf(held['callee']);
  const segments = segmentsOf(held);
  return segments === null ? null : segments.join('.');
}

/** A member expression's static path from its root, or `null` when the root or a property is not a name. */
function segmentsOf(member: Record<string, unknown>): string[] | null {
  if (member['type'] !== 'MemberExpression') return null;
  const object = member['object'] as Record<string, unknown> | undefined;
  const property = member['property'] as Record<string, unknown> | undefined;
  if (object === undefined || property === undefined || property['type'] !== 'Identifier') return null;
  const name = String(property['value']);
  if (object['type'] === 'Identifier') return [String(object['value']), name];
  const inner = segmentsOf(object);
  return inner === null ? null : [...inner, name];
}

/** Walks every node of the tree once, calling `visit` on every object that carries a `type`. */
function walk(value: unknown, visit: (node: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const held = value as Record<string, unknown>;
  if (typeof held['type'] === 'string') visit(held);
  for (const [key, entry] of Object.entries(held)) {
    if (key === 'span' || key === 'ctxt') continue;
    walk(entry, visit);
  }
}

function lineAt(bytes: Uint8Array, byteOffset: number): number {
  let line = 1;
  const end = Math.min(Math.max(byteOffset - 1, 0), bytes.length);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function parseOptionsOf(file: string): Parameters<typeof parseSync>[1] {
  return { syntax: 'typescript', tsx: file.endsWith('.tsx'), decorators: true, dynamicImport: true };
}
