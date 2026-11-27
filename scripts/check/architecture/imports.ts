/**
 * What a module imports, read from its own syntax tree.
 *
 * dependency-cruiser answers the rules that are about a module (which files it
 * imports), and it resolves a specifier to the file it names; it does not say
 * which *names* a module brings in, and the rule that keeps one entry point for a
 * fill is about names — `fillGraph` is a fill runner, `DRIVER_PRODUCER` in the same
 * module is not. So swc, the parser dependency-cruiser itself reads this repository
 * with (.dependency-cruiser.mjs says why it cannot be its TypeScript parser), parses
 * the module and this module reports its import statements: the specifier as
 * written, the 1-based line the statement starts on, the names it brings in, and
 * whether it takes the module as a whole.
 *
 * Nothing here reads source text twice: one parse of one module answers every
 * question about that module, and a span is a byte offset into the UTF-8 source,
 * which is how the line is found.
 */
import { readFileSync } from 'node:fs';
import { parseSync } from '@swc/core';
import { absolutePathOf } from './sources.js';

/** One import statement of a module, as the rule that reads names needs it. */
export interface ImportStatement {
  /** The specifier exactly as the module writes it: `'../graph/publish.js'`. */
  readonly specifier: string;
  /** The 1-based line the statement starts on. */
  readonly line: number;
  /** The names the statement brings in, as the exporting module writes them. */
  readonly names: readonly string[];
  /** Local binding paired with its exported name; re-exports pair the public name with the original. */
  readonly bindings: readonly { readonly local: string; readonly imported: string }[];
  readonly reExport: boolean;
  /** True when every name the statement brings in is a type: `import type`, or every specifier written `type`. */
  readonly typeOnly: boolean;
  /**
   * True when the statement takes the module as a whole — `import * as store`,
   * `export * from`, a side-effect `import 'x'`, or `await import('x')` — so every
   * name the module exports is reachable through it.
   */
  readonly wholeModule: boolean;
}

/** One call whose first argument is a string literal: the module name the call hands over, and its line. */
interface LiteralCall {
  /** The literal exactly as the module writes it. */
  readonly value: string;
  /** The 1-based line the call starts on. */
  readonly line: number;
}

/** One call a module makes to a named function, with the string literals among its arguments. */
interface NamedCall {
  /** The callee's name: the identifier it is called by, or the property a member call names. */
  readonly name: string;
  /** The 1-based line the call starts on. */
  readonly line: number;
  /** Every string literal written among the call's arguments, in the order they are written. */
  readonly literals: readonly string[];
}

/** What one module's syntax says about other modules: its imports, and the literal arguments of its calls. */
export interface ModuleNames {
  readonly imports: readonly ImportStatement[];
  /**
   * Every call whose first argument is a string literal, whatever the call is called — a local `load(path)`
   * helper that imports what the path names is as much a way of naming a module as `import()` is, and the
   * literal is what the parse says, never a pattern read from the text.
   */
  readonly literalCalls: readonly LiteralCall[];
  /**
   * Every call made by name whose arguments carry a string literal: a rule that is about one function's
   * arguments (which producer a binding is taken for) reads them here instead of reading the source text.
   */
  readonly calls: readonly NamedCall[];
}

/**
 * The import statements of one module, in the order they are written: its static
 * imports and re-exports, then every `import()` or `require()` call anywhere in its body.
 *
 * A module that fails to parse is refused by name with the path and the reason, so
 * a rule never silently reads a module as having no imports.
 */
export function importStatementsOf(root: string, file: string): readonly ImportStatement[] {
  return moduleNamesOf(root, file).imports;
}

/** The same parse, with every literal argument a call hands over as well. */
export function moduleNamesOf(root: string, file: string): ModuleNames {
  const path = absolutePathOf(root, file);
  return moduleNamesOfSource(readFileSync(path, 'utf8'), file, path);
}

/** The same, for a source already in hand, named by the path a reader opens. */
function moduleNamesOfSource(source: string, file: string, path: string): ModuleNames {
  let module;
  try {
    module = parseSync(source, parseOptionsOf(file));
  } catch (error) {
    throw new Error(`${path}:1: the module could not be parsed by swc as ${syntaxOf(file)}: ${(error as Error).message}`);
  }
  const bytes = new TextEncoder().encode(source);
  const statements: ImportStatement[] = [];
  for (const item of module.body) {
    if (item.type === 'ImportDeclaration') {
      const names: string[] = [];
      const bindings: { local: string; imported: string }[] = [];
      let wholeModule = false;
      for (const specifier of item.specifiers) {
        const imported = specifier.type === 'ImportSpecifier'
          ? specifier.imported?.value ?? specifier.local.value
          : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*';
        if (imported === '*') wholeModule = true;
        else names.push(imported);
        if (specifier.type !== 'ImportSpecifier' || !specifier.isTypeOnly) {
          bindings.push({ local: specifier.local.value, imported });
        }
      }
      if (item.specifiers.length === 0) wholeModule = true;
      const typeOnly = item.typeOnly || (item.specifiers.length > 0 && item.specifiers.every((specifier) => specifier.type === 'ImportSpecifier' && specifier.isTypeOnly));
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names, bindings, reExport: false, typeOnly, wholeModule });
    } else if (item.type === 'ExportNamedDeclaration') {
      if (item.source === null || item.source === undefined) continue;
      const names = item.specifiers.flatMap((specifier) => (specifier.type === 'ExportSpecifier' ? [specifier.orig.value] : []));
      const typeOnly = item.typeOnly || (item.specifiers.length > 0 && item.specifiers.every((specifier) => specifier.type === 'ExportSpecifier' && specifier.isTypeOnly));
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names, bindings: item.specifiers.flatMap((specifier) =>
        specifier.type === 'ExportSpecifier' && !specifier.isTypeOnly
          ? [{ local: specifier.exported?.value ?? specifier.orig.value, imported: specifier.orig.value }]
          : []), reExport: true, typeOnly, wholeModule: false });
    } else if (item.type === 'ExportAllDeclaration') {
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names: [], bindings: [], reExport: true, typeOnly: 'typeOnly' in item && item.typeOnly === true, wholeModule: true });
    }
  }
  for (const dynamic of moduleLoadsOf(module)) {
    statements.push({ specifier: dynamic.specifier, line: lineAt(bytes, dynamic.start), names: [], bindings: dynamic.bindings, reExport: false, typeOnly: false, wholeModule: true });
  }
  const calls = callsOf(module);
  const literalCalls = literalCallsOf(calls, bytes);
  const namedCalls = namedCallsOf(calls, bytes);
  return { imports: statements, literalCalls, calls: namedCalls };
}

/** The 1-based line a byte offset falls on: one more than the newlines before it. */
function lineAt(bytes: Uint8Array, byteOffset: number): number {
  let line = 1;
  const end = Math.min(Math.max(byteOffset - 1, 0), bytes.length);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function syntaxOf(file: string): string {
  return file.endsWith('.tsx') || file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts') ? 'TypeScript' : 'JavaScript';
}

function parseOptionsOf(file: string): Parameters<typeof parseSync>[1] {
  if (syntaxOf(file) === 'TypeScript') {
    return { syntax: 'typescript', tsx: file.endsWith('.tsx'), decorators: true, dynamicImport: true };
  }
  return { syntax: 'ecmascript', jsx: file.endsWith('.jsx'), decorators: true, dynamicImport: true };
}

interface DynamicImport {
  readonly bindings: readonly { readonly local: string; readonly imported: string }[];
  readonly specifier: string;
  readonly start: number;
}

/** Whether an SWC call loads a module via dynamic import() or CommonJS require(). */
function isModuleLoadCallee(callee: Record<string, unknown> | undefined): boolean {
  return callee !== null && typeof callee === 'object' &&
    (callee['type'] === 'Import' || (callee['type'] === 'Identifier' && callee['value'] === 'require'));
}

/**
 * Every literal `import('…')` or `require('…')` call in a module's body.
 * A require declaration also carries its local bindings. A computed specifier
 * cannot name a module here and is left to the reader.
 */
function moduleLoadsOf(node: unknown): DynamicImport[] {
  const found: DynamicImport[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const held = value as Record<string, unknown>;
    const callee = held['callee'] as Record<string, unknown> | undefined;
    if (held['type'] === 'VariableDeclarator') {
      const init = held['init'] as Record<string, unknown> | undefined;
      const invoked = init?.['callee'] as Record<string, unknown> | undefined;
      const args = init?.['arguments'] as { expression?: Record<string, unknown> }[] | undefined;
      const first = args?.[0]?.expression;
      if (init?.['type'] === 'CallExpression' && invoked?.['type'] === 'Identifier' && invoked['value'] === 'require' && first?.['type'] === 'StringLiteral') {
        const id = held['id'] as Record<string, unknown>;
        const bindings = id['type'] === 'Identifier'
          ? [{ local: String(id['value']), imported: '*' }]
          : id['type'] === 'ObjectPattern'
            ? (id['properties'] as Record<string, unknown>[]).flatMap((property) => {
              const key = property['key'] as Record<string, unknown> | undefined;
              const value = property['value'] as Record<string, unknown> | undefined;
              if (property['type'] === 'AssignmentPatternProperty' && key?.['type'] === 'Identifier') return [{ local: String(key['value']), imported: String(key['value']) }];
              if (property['type'] === 'KeyValuePatternProperty' && key?.['type'] === 'Identifier' && value?.['type'] === 'Identifier') return [{ local: String(value['value']), imported: String(key['value']) }];
              return [];
            }) : [];
        found.push({ specifier: String(first['value']), start: (init['span'] as { start: number }).start, bindings });
      }
    }
    if (held['type'] === 'CallExpression' && isModuleLoadCallee(callee)) {
      const first = Array.isArray(held['arguments']) ? (held['arguments'][0] as Record<string, unknown> | undefined) : undefined;
      const expression = first?.['expression'] as Record<string, unknown> | undefined;
      const span = held['span'] as { start: number } | undefined;
      if (expression?.['type'] === 'StringLiteral' && typeof expression['value'] === 'string' && span !== undefined) {
        if (!found.some((entry) => entry.start === span.start)) found.push({ specifier: expression['value'], start: span.start, bindings: [] });
      }
    }
    for (const [key, entry] of Object.entries(held)) {
      if (key === 'span' || key === 'ctxt') continue;
      walk(entry);
    }
  };
  walk(node);
  return found;
}

/** One call in a module's body, as a rule about its name or about the string literals among its arguments reads it. */
interface CallSyntax {
  /** The callee's name: the identifier it is called by, or the property a member call names; null when it is computed. */
  readonly name: string | null;
  /** The byte offset the call starts at. */
  readonly start: number;
  /** The first argument's value, when that argument is a string literal or a template with no substitution. */
  readonly firstArgument: string | null;
  /** Every string literal written among the arguments, in the order they are written. */
  readonly literals: readonly string[];
}

/**
 * The string a literal expression writes: `'x'`, or a template with no substitution (`` `x` ``). A computed string is
 * not a name this check can read, and is left to the reader.
 */
function stringOf(expression: Record<string, unknown> | undefined): string | null {
  if (expression === undefined) return null;
  if (expression['type'] === 'StringLiteral' && typeof expression['value'] === 'string') return expression['value'];
  if (expression['type'] === 'TemplateLiteral') {
    const expressions = expression['expressions'] as unknown[] | undefined;
    const quasis = expression['quasis'] as { readonly cooked?: string | null; readonly raw?: string }[] | undefined;
    const cooked = quasis?.[0]?.cooked ?? quasis?.[0]?.raw;
    if (expressions?.length === 0 && typeof cooked === 'string') return cooked;
  }
  return null;
}

/** The name a call expression is made by: an identifier, or the property of a member call whose name is written. */
function calleeNameOf(callee: Record<string, unknown> | undefined): string | null {
  if (callee === null || callee === undefined) return null;
  if (callee['type'] === 'Identifier' && typeof callee['value'] === 'string') return callee['value'];
  const property = callee['property'] as Record<string, unknown> | undefined;
  if (callee['type'] === 'MemberExpression' && callee['computed'] !== true && property?.['type'] === 'Identifier' && typeof property['value'] === 'string') return property['value'];
  return null;
}

/**
 * Every call in a module's body, wherever it stands, read in one walk of its tree: a rule that reads a call's name
 * (`startupBinding(tx, contract, 'manifest')`) and one that reads a module named by a literal
 * (`load('src/extract/driver/index.ts')`) ask the same parse, and neither reads the tree again.
 */
function callsOf(node: unknown): CallSyntax[] {
  const found: CallSyntax[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const held = value as Record<string, unknown>;
    if (held['type'] === 'CallExpression') {
      const span = held['span'] as { start: number } | undefined;
      const args = Array.isArray(held['arguments']) ? (held['arguments'] as Record<string, unknown>[]) : [];
      if (span !== undefined) {
        const values = args.map((argument) => stringOf(argument['expression'] as Record<string, unknown> | undefined));
        found.push({
          name: calleeNameOf(held['callee'] as Record<string, unknown> | undefined), start: span.start,
          firstArgument: values[0] ?? null, literals: values.flatMap((value) => value === null ? [] : [value]),
        });
      }
    }
    for (const [key, entry] of Object.entries(held)) {
      if (key === 'span' || key === 'ctxt') continue;
      walk(entry);
    }
  };
  walk(node);
  return found;
}

/**
 * Every call whose first argument is a string literal, whatever the call is called — a local `load(path)`
 * helper that imports what the path names is as much a way of naming a module as `import()` is, and the
 * literal is what the parse says, never a pattern read from the text.
 */
function literalCallsOf(calls: readonly CallSyntax[], bytes: Uint8Array): LiteralCall[] {
  return calls.flatMap((call) => call.firstArgument === null ? [] : [{ value: call.firstArgument, line: lineAt(bytes, call.start) }]);
}

/**
 * Every call a module makes by name whose arguments carry a string literal, wherever it stands: a rule about a
 * function's arguments reads them from the parse, and a name built at run time is not a name this check can read
 * and is left to the reader.
 */
function namedCallsOf(calls: readonly CallSyntax[], bytes: Uint8Array): NamedCall[] {
  return calls.flatMap((call) => call.name === null || call.literals.length === 0 ? [] : [{ name: call.name, line: lineAt(bytes, call.start), literals: call.literals }]);
}
