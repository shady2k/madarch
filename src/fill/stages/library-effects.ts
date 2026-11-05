/**
 * The library effects of one file, read from its code facts and the facts of the
 * files its imports reach (decision 0033, items 5, 14 and 15; madarch-8bdc.2.4).
 *
 * A library effect is what the extract driver's `evaluateLibraryModels` proves
 * from the code facts: a call of a modelled library — pino's logger, express's
 * routes, prom-client's metrics, kafkajs's producer, `process.env` — with the
 * model it answers, the package it comes from, the expression it stands at and
 * the arguments the model selects. The evaluator is pure and reads only facts;
 * what it cannot have in a static unit is the repository-wide fact object, so
 * this module builds the part of it one unit needs:
 *
 * - the unit's own file's expressions, bindings and calls, read page by page
 *   through the static context's bounded read by property;
 * - its import bindings, each carrying the specifier as written and the file it
 *   answers (the code-facts stage's own record);
 * - the facts of the files those imports reach, to a bounded depth and count: an
 *   import is chained *by global name through the graph* — the target file's
 *   binding of the imported name is read by `byGlobalName`, and its initializer
 *   is the expression the chain continues from — so no tree's symbol table is
 *   built and no file is read through a reader of its own.
 *
 * Every effect and diagnostic this returns stands in the unit's own file: the
 * closure's facts are evidence, never another file's answer.
 */
import { byCodePoint } from '../../model/order.js';
import { evaluateLibraryModels } from '../../extract/library-models/evaluate.js';
import type { LibraryDiagnostic, LibraryEffect } from '../../extract/library-models/model.js';
import type { ExtractionGap } from '../../extract/records.js';
import { STATIC_READ_ROW_LIMIT, type StaticGraphNode, type StaticStageContext } from './static-context.js';

/** The most files one unit's closure holds, the unit's own included. */
const LIBRARY_CLOSURE_FILE_LIMIT = 32;

/** The most files deep an import chain is followed: a chain is a value's way back to its declaration. */
const LIBRARY_CLOSURE_DEPTH_LIMIT = 4;

/** One expression a file's facts hold, as the walk published it. */
interface ExpressionFact {
  readonly id: string;
  readonly path: string;
  readonly syntaxKind: string;
  readonly span: Span;
  readonly name?: string;
  readonly bindingId?: string;
  readonly receiver?: string;
  readonly member?: string;
  readonly callee?: string;
  readonly arguments?: readonly string[];
  readonly children: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly literal?: { readonly kind: string; readonly raw: string; readonly value?: string | number | boolean | null };
  readonly operator?: string;
}

/** Where a fact stands: bytes and lines, as every fact of the fill carries them. */
interface Span {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One binding a file's facts hold. */
interface BindingFact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly span: Span;
  readonly scope: Span;
  readonly initializer?: string;
  readonly specifier?: string;
  readonly form?: 'default' | 'namespace' | 'named';
  readonly importedName?: string;
  readonly targetPath?: string;
}

/** One call site a file's facts hold. */
interface CallFact {
  readonly expression: string;
  readonly path: string;
  readonly span: Span;
  readonly callee?: string;
  readonly arguments: readonly string[];
  readonly holder: string;
  readonly construct: boolean;
}

/** One name a file exports: the file declared it under a binding, which is the identity a chain ends at. */
interface ExportFact {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly span: Span;
  readonly localBinding?: string;
}

/** One import as the evaluator reads it: the file wrote it, and a repository file it answers. */
interface ImportFact {
  readonly id: string;
  readonly path: string;
  readonly local: string;
  readonly specifier: string;
  readonly imported: { readonly form: 'default' | 'namespace' | 'named'; readonly name?: string };
  readonly span: Span;
  readonly targetPath?: string;
  readonly targetExpression?: string;
  readonly targetChain?: readonly string[];
}

/** What one unit's library reading answered: its own file's effects, diagnostics and the gaps of the reading. */
export interface FileLibraryEffects {
  readonly effects: readonly LibraryEffect[];
  readonly diagnostics: readonly LibraryDiagnostic[];
  readonly gaps: readonly ExtractionGap[];
  /** How many files of the closure were read, the unit's own included. */
  readonly files: number;
  /** The imports the closure chained, each with the expression it leads to where one was found. */
  readonly imports: readonly ImportFact[];
}

/** One page of a bounded read by property, followed to the cursor the graph answers. */
async function pagesOf(context: StaticStageContext, kind: string, field: string, value: string): Promise<readonly StaticGraphNode[]> {
  const rows: StaticGraphNode[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await context.byProperty(kind, field, value, { limit: STATIC_READ_ROW_LIMIT, ...(after === undefined ? {} : { after }) });
    rows.push(...page.rows);
    if (page.next === null) return rows;
    after = page.next;
  }
}

/** One file's own facts, read from the graph by the file they stand in. */
async function factsOf(context: StaticStageContext, repository: string, path: string): Promise<{
  readonly expressions: readonly ExpressionFact[];
  readonly bindings: readonly BindingFact[];
  readonly calls: readonly CallFact[];
  readonly exports: readonly ExportFact[];
  /** The file's callables, so an effect is owned by the callable it stands in and not by the file. */
  readonly symbols: readonly CallableFact[];
}> {
  const [expressions, bindings, calls, exports, callables] = await Promise.all([
    pagesOf(context, 'code.expression', 'file', path),
    pagesOf(context, 'code.binding', 'file', path),
    pagesOf(context, 'code.call', 'file', path),
    pagesOf(context, 'code.export', 'file', path),
    pagesOf(context, 'code.callable', 'file', path),
  ]);
  const held = (node: StaticGraphNode): boolean => node.properties['repository'] === repository;
  return {
    expressions: expressions.filter(held).map((node) => node.properties as unknown as ExpressionFact),
    bindings: bindings.filter(held).map((node) => node.properties as unknown as BindingFact),
    calls: calls.filter(held).map((node) => node.properties as unknown as CallFact),
    exports: exports.filter(held).map((node) => node.properties as unknown as ExportFact),
    symbols: callables.filter(held).filter((node) => node.properties['callable'] === true).map((node) => node.properties as unknown as CallableFact),
  };
}

/** One symbol as the library evaluator reads it: the declaration a callable's effects are owned by. */
interface CodeSymbolFactShape {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly callable: boolean;
  readonly span: Span;
  readonly bodySpan?: Span;
  readonly bodySyntaxKind?: string;
}

/** One callable a file declares, as the library evaluator names the owner of an effect. */
interface CallableFact {
  readonly symbolKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly symbolKind: string;
  readonly language?: string;
  readonly span: Span;
  readonly bodySpan?: Span;
  readonly bodySyntaxKind?: string;
}

/**
 * The library effects of one file, as its facts and the facts its imports reach
 * prove them. The unit's own file is read first; each import that answers a file
 * of the repository draws that file into the closure, to
 * `LIBRARY_CLOSURE_DEPTH_LIMIT` levels and `LIBRARY_CLOSURE_FILE_LIMIT` files,
 * and the imported name is chained to the target's binding by global name.
 */
export async function libraryEffectsOf(context: StaticStageContext, repository: string, path: string): Promise<FileLibraryEffects> {
  const files: { path: string; language: 'typescript' | 'go'; parsed: boolean }[] = [];
  const expressions: ExpressionFact[] = [];
  const bindings: BindingFact[] = [];
  const calls: CallFact[] = [];
  const imports: ImportFact[] = [];
  const exported: ExportFact[] = [];
  const symbols: CodeSymbolFactShape[] = [];
  const gaps: ExtractionGap[] = [];
  const read = new Set<string>();
  /**
   * The expression an import chains to in the file it comes from: the name the
   * imported binding holds, followed through its initializer to the expression
   * that *produces* the value — the identifier a library import binds (`pino`),
   * the member a role is reached through, or the initializer itself where it is
   * the producer. It is read by the global name a binding carries, one bounded
   * graph read, and resolved inside the facts the closure already holds.
   */
  const chainOf = async (targetPath: string, name: string | undefined): Promise<{ targetExpression?: string; targetChain?: readonly string[] }> => {
    if (name === undefined) return {};
    const chain = exported.filter((entry) => entry.path === targetPath && entry.name === name);
    if (chain.length !== 1) return {};
    const entry = chain[0]!;
    const binding = entry.localBinding === undefined ? undefined : bindings.find((held) => held.id === entry.localBinding && held.path === entry.path);
    if (binding === undefined) return { targetChain: [entry.id] };
    // The chain ends at the identifier that names the binding: an expression the evaluator
    // proves the export by, which it finds in the target file's own facts.
    const naming = expressions.find((expression) => expression.bindingId === binding.id && expression.span.byteStart === binding.span.byteStart && expression.span.byteEnd === binding.span.byteEnd);
    return { targetChain: [entry.id], ...(naming === undefined ? {} : { targetExpression: naming.id }) };
  };
  const importsOf: { path: string; local: string; specifier: string; form: 'default' | 'namespace' | 'named'; importedName?: string; span: Span; targetPath?: string; id: string }[] = [];
  const visit = async (file: string, depth: number): Promise<void> => {
    if (read.has(file) || read.size >= LIBRARY_CLOSURE_FILE_LIMIT) return;
    read.add(file);
    const own = await factsOf(context, repository, file);
    files.push({ path: file, language: file.endsWith('.go') ? 'go' : 'typescript', parsed: true });
    expressions.push(...own.expressions);
    bindings.push(...own.bindings);
    calls.push(...own.calls);
    exported.push(...own.exports);
    for (const callable of own.symbols) {
      symbols.push({
        key: callable.symbolKey, path: file, name: callable.name, qualifiedName: callable.qualifiedName,
        symbolKind: callable.symbolKind, callable: true, span: callable.span,
        ...(callable.bodySpan === undefined ? {} : { bodySpan: callable.bodySpan }),
        ...(callable.bodySyntaxKind === undefined ? {} : { bodySyntaxKind: callable.bodySyntaxKind }),
      });
    }
    if (depth >= LIBRARY_CLOSURE_DEPTH_LIMIT) return;
    for (const binding of own.bindings) {
      if (binding.kind !== 'import' || binding.specifier === undefined || binding.form === undefined) continue;
      importsOf.push({ id: binding.id, path: file, local: binding.name, specifier: binding.specifier, form: binding.form, ...(binding.importedName === undefined ? {} : { importedName: binding.importedName }), span: binding.span, ...(binding.targetPath === undefined ? {} : { targetPath: binding.targetPath }) });
      if (binding.targetPath !== undefined) await visit(binding.targetPath, depth + 1);
    }
  };
  await visit(path, 0);
  for (const imported of importsOf) {
    const chain = imported.targetPath === undefined ? {} : await chainOf(imported.targetPath, imported.importedName);
    imports.push({
      id: imported.id,
      path: imported.path,
      local: imported.local,
      specifier: imported.specifier,
      imported: { form: imported.form, ...(imported.importedName === undefined ? {} : { name: imported.importedName }) },
      span: imported.span,
      ...(imported.targetPath === undefined ? {} : { targetPath: imported.targetPath }),
      ...chain,
    });
  }
  // The evaluator's own input shape, built from the closure: the facts of the files the unit's
  // imports reach, and nothing of a repository-wide object.
  const evaluation = evaluateLibraryModels({
    files,
    symbols,
    imports,
    exports: exported,
    bindings,
    expressions,
    calls,
    sites: [],
    fields: [],
    gaps,
  } as unknown as Parameters<typeof evaluateLibraryModels>[0]);
  return {
    effects: evaluation.effects.filter((effect) => effect.span.path === path).sort((left, right) =>
      byCodePoint(left.span.path, right.span.path) || left.span.byteStart - right.span.byteStart || byCodePoint(left.modelId, right.modelId)),
    diagnostics: evaluation.diagnostics.filter((diagnostic) => diagnostic.span.path === path).sort((left, right) =>
      left.span.byteStart - right.span.byteStart || byCodePoint(left.code, right.code)),
    gaps: [ ...evaluation.gaps.filter((gap) => gap.path === path), ...gaps ],
    files: read.size,
    imports,
  };
}
