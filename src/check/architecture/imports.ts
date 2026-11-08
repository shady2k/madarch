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

/** What one module's syntax says about other modules: its imports, and the literal arguments of its calls. */
export interface ModuleNames {
  readonly imports: readonly ImportStatement[];
  /**
   * Every call whose first argument is a string literal, whatever the call is called — a local `load(path)`
   * helper that imports what the path names is as much a way of naming a module as `import()` is, and the
   * literal is what the parse says, never a pattern read from the text.
   */
  readonly literalCalls: readonly LiteralCall[];
}

/**
 * The import statements of one module, in the order they are written: its static
 * imports and re-exports, then every `import()` call anywhere in its body.
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
      let wholeModule = false;
      for (const specifier of item.specifiers) {
        if (specifier.type === 'ImportSpecifier') names.push(specifier.imported?.value ?? specifier.local.value);
        else if (specifier.type === 'ImportDefaultSpecifier') names.push('default');
        else wholeModule = true;
      }
      if (item.specifiers.length === 0) wholeModule = true;
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names, wholeModule });
    } else if (item.type === 'ExportNamedDeclaration') {
      if (item.source === null || item.source === undefined) continue;
      const names = item.specifiers.flatMap((specifier) => (specifier.type === 'ExportSpecifier' ? [specifier.orig.value] : []));
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names, wholeModule: false });
    } else if (item.type === 'ExportAllDeclaration') {
      statements.push({ specifier: item.source.value, line: lineAt(bytes, item.span.start), names: [], wholeModule: true });
    }
  }
  for (const dynamic of dynamicImportsOf(module)) {
    statements.push({ specifier: dynamic.specifier, line: lineAt(bytes, dynamic.start), names: [], wholeModule: true });
  }
  const literalCalls = literalCallsOf(module).map((call) => ({ value: call.value, line: lineAt(bytes, call.start) }));
  return { imports: statements, literalCalls };
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
  readonly specifier: string;
  readonly start: number;
}

/**
 * Every `import('…')` call in a module's body, wherever it stands: a module that
 * loads a runner that way starts that runner as surely as one that imports it at
 * the top. A call with a computed specifier is not an import this repository can
 * name, and is left to the reader.
 */
function dynamicImportsOf(node: unknown): DynamicImport[] {
  const found: DynamicImport[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const held = value as Record<string, unknown>;
    const callee = held['callee'] as Record<string, unknown> | undefined;
    if (held['type'] === 'CallExpression' && callee !== null && typeof callee === 'object' && callee['type'] === 'Import') {
      const first = Array.isArray(held['arguments']) ? (held['arguments'][0] as Record<string, unknown> | undefined) : undefined;
      const expression = first?.['expression'] as Record<string, unknown> | undefined;
      const span = held['span'] as { start: number } | undefined;
      if (expression?.['type'] === 'StringLiteral' && typeof expression['value'] === 'string' && span !== undefined) {
        found.push({ specifier: expression['value'], start: span.start });
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

/** One call whose first argument is a string literal. */
interface LiteralArgument {
  readonly value: string;
  readonly start: number;
}

/**
 * Every call in a module whose first argument is a string literal, wherever it stands:
 * `load('src/extract/driver/index.ts')` names that module as plainly as `import()` does,
 * and the parse is the only reader of it. A computed argument is not a name this check
 * can read, and is left to the reader.
 */
function literalCallsOf(node: unknown): LiteralArgument[] {
  const found: LiteralArgument[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const held = value as Record<string, unknown>;
    if (held['type'] === 'CallExpression') {
      const first = Array.isArray(held['arguments']) ? (held['arguments'][0] as Record<string, unknown> | undefined) : undefined;
      const expression = first?.['expression'] as Record<string, unknown> | undefined;
      const span = held['span'] as { start: number } | undefined;
      if (expression?.['type'] === 'StringLiteral' && typeof expression['value'] === 'string' && span !== undefined) {
        found.push({ value: expression['value'], start: span.start });
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
