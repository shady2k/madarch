/**
 * The code-structure extractor (madarch-o0eq.6): one `Extraction` over a
 * TreeReader that carries the repository's files, symbols, modules and
 * packages, the imports between them, the calls, references, inheritance and
 * implementations between symbols, the positioned occurrences of every
 * resolved name, the module dependencies and the import cycles among them,
 * which exports nothing in the repository references, and the catalogue of
 * test cases with what each one exercises.
 *
 * Pure: the reader's bytes decide the answer, and nothing else does. Every
 * file this extractor tries to read and cannot is a gap, never a silence. The
 * readers of the fill's syntax and resolution stages are reused by import;
 * what they do not see (a member reached through a value, a name qualified by
 * a Go package, an interface satisfied by its method set) is read here, from
 * the declarations of the repository, and claimed only where those say it.
 */
import { byCodePoint } from '../../model/order.js';
import { isStandardLibrary } from './packages.js';
import { readGoMod } from '../../fill/stages/manifest-format.js';
import { extractFileResolution, type ExtractedFileResolution } from '../../fill/stages/resolution-extract.js';
import { extractFileSyntax, type ExtractedFileSyntax, type SyntaxSpan } from '../../fill/stages/syntax-extract.js';
import { resolveSpecifier } from '../../fill/stages/syntax-facts.js';
import type { ExtractedEdge, ExtractedNode, Extraction, ExtractionGap, PropertyValue, SchemaKey, SourceSpan, TreeReader } from '../records.js';
import { memberSites } from './bodies.js';
import { readDecls, type FileDecls } from './decls.js';
import { cycles } from './graph.js';
import {
  CODE_PRODUCER,
  cycleKey,
  fileKey,
  KIND_CYCLE,
  KIND_FILE,
  KIND_MODULE,
  KIND_PACKAGE,
  KIND_SYMBOL,
  KIND_TEST_CASE,
  moduleKey,
  packageKey,
  REL_CALLS,
  REL_CONTAINS,
  REL_CYCLE_MEMBER,
  REL_DEPENDS_ON,
  REL_IMPLEMENTS,
  REL_IMPORTS,
  REL_INHERITS,
  REL_OCCURRENCE,
  REL_REFERENCES,
  REL_READS,
  REL_WRITES,
  REL_USES_TYPE,
  REL_TESTS,
  symbolKey,
  testCaseKey,
} from './keys.js';
import { goImportFolder, Program, type Binding, type FileCtx } from './program.js';
import { resolveFile } from './resolve.js';
import { codeLanguageOf, folderOf, roleOf, type SourceFile } from './source.js';
import { holderAt, indexSymbols, type FileSymbol } from './symbols.js';
import { readTestDetails } from './tests.js';
import {readTsFile} from '../contracts/ts-code.js';
import {readGoFile} from '../contracts/go-code.js';
import {readSyntaxTree} from '../../fill/stages/syntax-extract.js';
import {callbackName} from './keys.js';
import {spanOf, walkTree} from '../contracts/walk.js';
import { codeFactId, freezeCodeFacts, type CodeBindingFact, type CodeCallFact, type CodeExpressionFact, type CodeExtractionResult, type CodeImportFact, type CodeExportFact } from './facts.js';
export type { CodeFacts, CodeExtractionResult } from './facts.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export { CODE_PRODUCER };


/** The span of a whole file, from the text a reader already holds: a manifest's place is the manifest. */
function fileSpan(path: string, text: string): SourceSpan {
  return {path, byteStart: 0, byteEnd: new TextEncoder().encode(text).length, lineStart: 1, lineEnd: text === '' ? 1 : text.split('\n').length};
}

function toSpan(path: string, span: SyntaxSpan): SourceSpan {
  return { path, byteStart: span.startByte, byteEnd: span.endByte, lineStart: span.startLine, lineEnd: span.endLine };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Manifest {
  readonly folder: string;
  readonly ecosystem: 'go' | 'node';
  readonly name: string;
  readonly frameworks: readonly string[];
  readonly dependencies: ReadonlyMap<string, string | null>;
  readonly span: SourceSpan;
}

interface FileFacts {
  readonly source: SourceFile;
  readonly syntax: ExtractedFileSyntax;
  readonly resolution: ExtractedFileResolution;
  readonly decls: FileDecls;
  readonly symbols: FileSymbol[];
  readonly callbackValues: readonly SourceSpan[];
}

/** A resolved name: where it stands, what it names, and how. */
interface Site {
  readonly span: SyntaxSpan;
  /** The symbol key the name reaches, already folded to a kept symbol. */
  readonly to: string;
  readonly use: 'call' | 'reference' | 'type' | 'extends' | 'implements';
  readonly roles: readonly string[];
  readonly fanOut: readonly string[];
}

export async function extractCode(reader: TreeReader): Promise<Extraction> {
  return (await extractCodeWithFacts(reader)).extraction;
}

/** The existing code pass, with its immutable semantic view retained for consumers. */
export async function extractCodeWithFacts(reader: TreeReader): Promise<CodeExtractionResult> {
  const gaps: ExtractionGap[] = [];
  const gap = (path: string, reason: string): void => {
    gaps.push({ path, reason });
  };

  // ---- the manifests ------------------------------------------------------------
  const moduleFirstFile = new Map<string, string>();
  const manifests: Manifest[] = [];
  const goModules: { folder: string; module: string }[] = [];
  for (const path of reader.paths) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (base !== 'go.mod' && base !== 'package.json') continue;
    let text: string;
    try {
      text = decoder.decode(reader.read(path));
    } catch (error) {
      gap(path, `the manifest cannot be read: ${describeError(error)}`);
      continue;
    }
    if (base === 'go.mod') {
      const parsed = readGoMod(text);
      if (!parsed.ok) {
        gap(path, `line ${parsed.gap.line}: ${parsed.gap.detail}`);
        continue;
      }
      const module = parsed.value.module;
      goModules.push({ folder: folderOf(path), module });
      // The existing manifest reader proves package identity, not a version.
      // Do not rescan its source line to invent missing structured metadata.
      const dependencies = new Map<string, string | null>(parsed.value.requires.map((entry) => [entry.path, null]));
      for (const note of parsed.gaps) gap(path, `line ${note.line}: ${note.detail}`);
      manifests.push({ folder: folderOf(path), ecosystem: 'go', name: module, frameworks: ['go-test'], dependencies, span: fileSpan(path, text) });
    } else {
      try {
        const parsed = JSON.parse(text) as { name?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        const names = new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]);
        const frameworks = ['jest', 'vitest', 'mocha'].filter((name) => names.has(name));
        const dependencies = new Map<string, string | null>();
        for (const block of [parsed.dependencies, parsed.devDependencies]) for (const [name, version] of Object.entries(block ?? {})) {
          if (typeof version === 'string') dependencies.set(name, version);
        }
        manifests.push({ folder: folderOf(path), ecosystem: 'node', name: typeof parsed.name === 'string' ? parsed.name : folderOf(path), frameworks, dependencies, span: fileSpan(path, text) });
      } catch (error) {
        gap(path, `the package.json is not JSON: ${describeError(error)}`);
      }
    }
  }
  const rootOf = (folder: string, ecosystem?: Manifest['ecosystem']): Manifest | undefined => {
    let best: Manifest | undefined;
    for (const manifest of manifests) {
      if (ecosystem !== undefined && manifest.ecosystem !== ecosystem) continue;
      if (manifest.folder !== '' && folder !== manifest.folder && !folder.startsWith(`${manifest.folder}/`)) continue;
      if (best === undefined || manifest.folder.length > best.folder.length) best = manifest;
    }
    return best;
  };
  const goRootOf = (folder: string): string | undefined => {
    let best: string | undefined;
    for (const module of goModules) {
      if (module.folder !== '' && folder !== module.folder && !folder.startsWith(`${module.folder}/`)) continue;
      if (best === undefined || module.folder.length > best.length) best = module.folder;
    }
    return best;
  };

  // ---- the files ------------------------------------------------------------------
  const sources: SourceFile[] = [];
  for (const path of reader.paths) {
    const language = codeLanguageOf(path);
    if (language === undefined) continue;
    let bytes: Uint8Array;
    try {
      bytes = reader.read(path);
    } catch (error) {
      gap(path, `the file cannot be read: ${describeError(error)}`);
      continue;
    }
    sources.push({ path, bytes, grammar: path.endsWith('.go') ? 'go' : 'typescript', language, role: roleOf(path) });
  }
  const files: FileFacts[] = [];
  for (const source of sources) {
    const syntax = await extractFileSyntax(source.path, source.bytes);
    const resolution = await extractFileResolution(source.path, source.bytes);
    if (!syntax.parsed) {
      for (const unread of syntax.unread) gap(source.path, `the file is not parsed (${unread.reason}): ${unread.what}`);
      if (syntax.unread.length === 0) gap(source.path, 'the file is not parsed');
    } else if (syntax.unread.length > 0) {
      for (const unread of syntax.unread) gap(source.path, `the file is read as far as the parser went (${unread.reason}): ${unread.what}`);
    }
    const declarations = await readDecls(source);
    const { decls } = declarations;
    if (!declarations.read) gap(source.path, `line 1: declarations could not be read from repository path ${source.path}`);
    const topNames = syntax.parsed && source.language === 'typescript' ? new Set(decls.tops.map((top) => top.name)) : undefined;
    const symbols = indexSymbols(source.path, syntax.symbols, topNames);
    const callbackValues: SourceSpan[] = [];
    if (syntax.parsed) {
      const registrations = await readSyntaxTree<readonly {method: string; path: string; handler?: {inline: boolean; span: SourceSpan}}[]>(source.path, source.bytes, ({root}) => {
        if (source.language !== 'typescript') return readGoFile(source.path, root).routes.map((route) => ({method: route.method, path: route.path, handler: {inline: route.inline, span: route.handlerSpan}}));
        const facts = readTsFile(source.path, root);
        return [...facts.routes, ...facts.grpcSites.flatMap((site) => site.kind === 'serve' && site.handlerSpan !== undefined
          ? [{method: 'grpc', path: site.rpc, handler: {inline: true, span: site.handlerSpan}}] : [])];
      });
      if (registrations.read) for (const route of [...registrations.value].sort((a, b) => (b.handler?.span.byteEnd ?? 0) - (b.handler?.span.byteStart ?? 0) - ((a.handler?.span.byteEnd ?? 0) - (a.handler?.span.byteStart ?? 0)))) {
        const handler = route.handler;
        if (handler === undefined || !handler.inline) continue;
        const existing = symbols.findIndex((symbol) => symbol.functionLike && symbol.span.startByte === handler.span.byteStart && symbol.span.endByte === handler.span.byteEnd);
        if (existing >= 0) {const symbol = symbols[existing]!; symbols[existing] = {...symbol, local: false, keptKey: symbol.key}; continue;}
        const enclosing = holderAt(symbols, handler.span.byteStart);
        const name = callbackName(enclosing?.qualifiedName, `${route.method}:${route.path}`, handler.span.lineStart, handler.span.byteStart);
        const key = symbolKey(source.path, name);
        const prefix = decoder.decode(source.bytes.subarray(0, handler.span.byteStart));
        const through = decoder.decode(source.bytes.subarray(0, handler.span.byteEnd));
        const span: SyntaxSpan = {startByte: handler.span.byteStart, endByte: handler.span.byteEnd,
          startLine: handler.span.lineStart, endLine: handler.span.lineEnd,
          startColumn: prefix.length - prefix.lastIndexOf('\n') - 1, endColumn: through.length - through.lastIndexOf('\n') - 1};
        symbols.push({key, qualifiedName: name, name, symbolKind: 'function', span, definitionSpan: span, local: false, keptKey: key, functionLike: true});
      }
    }
    if (syntax.parsed) {
      // Keep actual function boundaries even when no framework registration names them.
      // The position is an identity, not a claim about when a callback runs.
      const boundaries = await readSyntaxTree(source.path, source.bytes, ({root}) => {
        const found: SourceSpan[] = [];
        walkTree(root, (node) => {
          if (['arrow_function', 'function_expression', 'generator_function', 'func_literal'].includes(node.type)) {
            const span = spanOf(node, source.path);
            found.push(span);
            if (node.parent !== null && ['arguments', 'argument_list'].includes(node.parent.type)) callbackValues.push(span);
          }
        });
        return found;
      });
      if (boundaries.read) for (const boundary of boundaries.value.sort((a, b) => (b.byteEnd - b.byteStart) - (a.byteEnd - a.byteStart))) {
        const existing = symbols.findIndex((symbol) => symbol.functionLike && symbol.span.startByte <= boundary.byteStart && symbol.span.endByte === boundary.byteEnd);
        if (existing >= 0) {const symbol = symbols[existing]!; symbols[existing] = {...symbol, local: false, keptKey: symbol.key}; continue;}
        const enclosing = holderAt(symbols, boundary.byteStart);
        const name = callbackName(enclosing?.qualifiedName, 'anonymous', boundary.lineStart, boundary.byteStart);
        const key = symbolKey(source.path, name);
        const prefix = decoder.decode(source.bytes.subarray(0, boundary.byteStart));
        const through = decoder.decode(source.bytes.subarray(0, boundary.byteEnd));
        const span: SyntaxSpan = {startByte: boundary.byteStart, endByte: boundary.byteEnd, startLine: boundary.lineStart, endLine: boundary.lineEnd,
          startColumn: prefix.length - prefix.lastIndexOf('\n') - 1, endColumn: through.length - through.lastIndexOf('\n') - 1};
        symbols.push({key, qualifiedName: name, name, symbolKind: 'function', span, definitionSpan: span, local: false, keptKey: key, functionLike: true});
      }
      for (const [index, symbol] of symbols.entries()) if (symbol.functionLike && symbol.local) symbols[index] = {...symbol, local: false, keptKey: symbol.key};
    }
    for (const [index, symbol] of symbols.entries()) {
      if (!symbol.local) continue;
      const holder = holderAt(symbols, symbol.span.startByte);
      if (holder !== undefined) symbols[index] = {...symbol, keptKey: holder.key};
    }
    files.push({ source, syntax, resolution, decls, symbols, callbackValues });
  }
  const parsedFiles = files.filter((file) => file.syntax.parsed);
  const fileFacts = new Map(files.map((file) => [file.source.path, file]));
  const known = new Set(sources.map((source) => source.path));
  const goFolders = new Set(sources.filter((source) => source.language === 'go').map((source) => folderOf(source.path)));

  // ---- the program ----------------------------------------------------------------
  const contexts: FileCtx[] = [];
  for (const file of parsedFiles) {
    const { decls } = file;
    const imports = new Map<string, Binding>();
    for (const entry of file.resolution.imports) {
      if (file.source.language === 'go') {
        const folder = goImportFolder(entry.specifier, goModules, goFolders);
        if (folder !== undefined) imports.set(entry.local, { kind: 'package', scope: folder });
        continue;
      }
      const target = resolveSpecifier(file.source.path, entry.specifier, known);
      if (target === undefined) continue;
      if (entry.imported.form === 'named') imports.set(entry.local, { kind: 'named', file: target, name: entry.imported.name });
      else if (entry.imported.form === 'default') imports.set(entry.local, { kind: 'default', file: target });
      else imports.set(entry.local, { kind: 'namespace', file: target });
    }
    contexts.push({
      path: file.source.path,
      language: file.source.language,
      role: file.source.role,
      scope: file.source.language === 'go' ? folderOf(file.source.path) : file.source.path,
      goRoot: file.source.language === 'go' ? goRootOf(folderOf(file.source.path)) : undefined,
      imports,
      decls,
    });
  }
  const program = new Program(contexts);

  // ---- the symbols -------------------------------------------------------------------
  const symbolsByFile = new Map<string, readonly FileSymbol[]>();
  for (const file of files) symbolsByFile.set(file.source.path, file.symbols);
  const symbolByKey = new Map<string, FileSymbol>();
  for (const file of files) for (const symbol of file.symbols) if (!symbolByKey.has(symbol.key)) symbolByKey.set(symbol.key, symbol);
  const fileOfSymbol = (key: string): string => key.slice(key.indexOf(':') + 1, key.indexOf('#'));
  /** A target folded to the kept symbol that holds it, or undefined where it is not a symbol of the tree. */
  const keptTarget = (key: string): string | undefined => symbolByKey.get(key)?.keptKey;

  // ---- the sites -----------------------------------------------------------------------
  const sitesByFile = new Map<string, Site[]>();
  const imports: CodeImportFact[] = [];
  const bindings: CodeBindingFact[] = [];
  const exports: CodeExportFact[] = [];
  const expressions: CodeExpressionFact[] = [];
  const calls: CodeCallFact[] = [];
  const callables = new Map<string, { readonly bodySpan: SourceSpan; readonly bodySyntaxKind: string; readonly receiver?: { readonly bindingId: string; readonly name: string; readonly typeName?: string } }>();
  const ambiguousCallables = new Set<string>();
  const allPaths = sources.map((source) => source.path);
  for (const file of parsedFiles) {
    const path = file.source.path;
    const sites: Site[] = [];
    const mentionAt = new Map<string, (typeof file.resolution.mentions)[number]>();
    for (const mention of file.resolution.mentions) mentionAt.set(`${mention.span.startLine}:${mention.span.startColumn}`, mention);
    const covered = new Set<string>();
    try {
      const resolved = resolveFile(path, file.resolution, allPaths, symbolsByFile, lineCountOf(file.source.bytes));
      for (const occurrence of resolved.occurrences) {
        const at = `${occurrence.span.startLine}:${occurrence.span.startColumn}`;
        covered.add(at);
        const mention = mentionAt.get(at);
        const use = mention === undefined || mention.use === 'mention' ? 'reference' : mention.use;
        sites.push({ span: occurrence.span, to: occurrence.to, use, roles: occurrence.roles, fanOut: [] });
      }
      for (const unresolved of resolved.unresolved) gap(path, `a name is not tied to a symbol: ${unresolved}`);
    } catch (error) {
      gap(path, `the names of the file are not resolved: ${describeError(error)}`);
    }
    if (file.source.language === 'go') {
      // A Go package shares its names across its files; the plain-name resolver sees one file.
      const own = new Set(file.symbols.map((symbol) => symbol.qualifiedName));
      for (const mention of file.resolution.mentions) {
        if (mention.through !== undefined || mention.parameterBound || covered.has(`${mention.span.startLine}:${mention.span.startColumn}`)) continue;
        if (own.has(mention.name)) continue;
        const top = program.top(folderOf(path), mention.name);
        if (top === undefined || top.file === path) continue;
        sites.push({ span: mention.span, to: symbolKey(top.file, top.name), use: mention.use === 'call' ? 'call' : 'reference', roles: [mention.access], fanOut: [] });
      }
    }
    const fileImports: CodeImportFact[] = file.resolution.imports.map((entry) => {
      const span = toSpan(path, entry.span);
      const targetPath = file.source.language === 'go' ? undefined : resolveSpecifier(path, entry.specifier, known);
      const manifest = rootOf(folderOf(path), file.source.language === 'go' ? 'go' : 'node');
      const declared = manifest === undefined ? undefined : [...manifest.dependencies].filter(([name]) => entry.specifier === name || entry.specifier.startsWith(`${name}/`)).sort(([left], [right]) => right.length - left.length || byCodePoint(left, right))[0];
      return { id: codeFactId(span, 'import'), path, local: entry.local, specifier: entry.specifier,
        imported: { ...entry.imported }, span, ...(targetPath === undefined ? {} : { targetPath }),
        ...(declared === undefined || manifest === undefined ? {} : { package: { ecosystem: manifest.ecosystem, name: declared[0], manifestPath: manifest.span.path, declaredVersion: declared[1] } }) };
    });
    const members = await memberSites(file.source, program, fileImports, file.symbols);
    imports.push(...fileImports.map((imported) => members.typeOnlyImports.includes(imported.id) ? { ...imported, typeOnly: true } : imported));
    bindings.push(...members.bindings);
    expressions.push(...members.expressions);
    calls.push(...members.calls);
    for (const callable of members.callables) {
      if (callables.has(callable.key) || ambiguousCallables.has(callable.key)) { ambiguousCallables.add(callable.key); callables.delete(callable.key); gap(path, `line ${callable.bodySpan.lineStart}: duplicate canonical callable metadata for ${callable.key}`); continue; }
      callables.set(callable.key, {bodySpan: callable.bodySpan, bodySyntaxKind: callable.bodySyntaxKind, ...(callable.receiver === undefined ? {} : {receiver: callable.receiver})});
    }
    exports.push(...members.exports.map((entry) => entry.reexport === undefined ? entry : { ...entry, reexport: { ...entry.reexport, ...(resolveSpecifier(path, entry.reexport.specifier, known) === undefined ? {} : { targetPath: resolveSpecifier(path, entry.reexport.specifier, known) }) } }));
    for (const unread of members.gaps) gap(unread.path, unread.reason);
    if (!members.read) gap(path, `line 1: the member/use walk could not read repository path ${path}`);
    for (let i = sites.length - 1; i >= 0; i--) if (members.suppressed.has(sites[i]!.span.startByte)) sites.splice(i, 1);
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i]!;
      const roles = members.accesses.get(site.span.startByte);
      if (roles !== undefined) sites[i] = { ...site, roles };
    }
    // Replace only plain-name readings. A typed token may truthfully name both
    // a constructor call and its class reference; neither erases the other.
    for (let i = sites.length - 1; i >= 0; i--) {
      const plain = sites[i]!;
      if (members.sites.some((site) => site.span.startByte <= plain.span.startByte && plain.span.endByte <= site.span.endByte)) sites.splice(i, 1);
    }
    for (const site of members.sites) {
      sites.push({ span: site.span, to: site.to, use: site.use, roles: site.roles ?? ['read-access'], fanOut: site.fanOut });
    }
    sitesByFile.set(path, sites);
  }

  // Join exported values here, beside the existing program resolver. Consumers
  // follow only these identities; they never resolve source module names again.
  const expressionIndex = new Map(expressions.map((entry) => [entry.id, entry]));
  const bindingIndex = new Map(bindings.map((entry) => [entry.id, entry]));
  const exportedValues = new Map<string, CodeExportFact[]>();
  for (const entry of exports) {
    const key = JSON.stringify([entry.path, entry.name]);
    exportedValues.set(key, [...(exportedValues.get(key) ?? []), entry]);
  }
  const exportedValue = (path: string, name: string, active: Set<string>): { expression: string; chain: string[] } | undefined => {
    const key = JSON.stringify([path, name]);
    if (active.has(key)) return undefined;
    active.add(key);
    const candidates = exportedValues.get(key) ?? [];
    if (candidates.length !== 1) return undefined;
    const entry = candidates[0]!;
    if (entry.expression !== undefined && expressionIndex.has(entry.expression)) return { expression: entry.expression, chain: [entry.id] };
    if (entry.localBinding !== undefined) {
      const binding = bindingIndex.get(entry.localBinding);
      // The declaration's own identifier retains reassignment and alias guards.
      const identifiers = expressions.filter((expression) => expression.bindingId === entry.localBinding && expression.span.byteStart === binding?.span.byteStart && expression.span.byteEnd === binding.span.byteEnd);
      if (identifiers.length === 1) return { expression: identifiers[0]!.id, chain: [entry.id] };
    }
    if (entry.reexport?.targetPath !== undefined) {
      const target = exportedValue(entry.reexport.targetPath, entry.reexport.name, active);
      if (target !== undefined) return { expression: target.expression, chain: [entry.id, ...target.chain] };
    }
    return undefined;
  };
  for (let index = 0; index < imports.length; index++) {
    const imported = imports[index]!;
    if (imported.targetPath === undefined || imported.typeOnly) continue;
    if (imported.imported.form === 'namespace') {
      gap(imported.path, `line ${imported.span.lineStart}: namespace import needs exact exported-member identities at bytes ${imported.span.byteStart}-${imported.span.byteEnd}`);
      continue;
    }
    const target = exportedValue(imported.targetPath, imported.imported.form === 'default' ? 'default' : imported.imported.name, new Set());
    if (target === undefined) gap(imported.path, `line ${imported.span.lineStart}: internal import has no unique exported value at bytes ${imported.span.byteStart}-${imported.span.byteEnd}`);
    else imports[index] = { ...imported, targetExpression: target.expression, targetChain: target.chain };
  }

  // ---- nodes -----------------------------------------------------------------------------
  const nodes = new Map<string, ExtractedNode>();
  const addNode = (node: ExtractedNode): void => {
    if (!nodes.has(node.key)) nodes.set(node.key, node);
  };
  const edgeMap = new Map<string, ExtractedEdge>();
  const addEdge = (edge: ExtractedEdge): void => {
    const id = `${edge.type}\u0000${edge.from}\u0000${edge.to}\u0000${edge.discriminator}`;
    if (!edgeMap.has(id)) edgeMap.set(id, edge);
  };

  // Which top-level symbols each file exports, and the entry points each symbol starts.
  const referencedFrom = new Map<string, number>();
  for (const [path, sites] of sitesByFile) {
    const symbols = symbolsByFile.get(path) ?? [];
    for (const site of sites) {
      const target = symbolByKey.get(site.to);
      if (target === undefined) continue;
      const holder = holderAt(symbols, site.span.startByte);
      // A name inside the symbol's own span (a recursive call) does not keep it alive.
      const inside = target.span.startByte <= site.span.startByte && site.span.endByte <= target.span.endByte && fileOfSymbol(target.key) === path;
      if (inside && (holder === undefined || holder.key === target.key || holder.keptKey === target.keptKey)) continue;
      referencedFrom.set(target.keptKey, (referencedFrom.get(target.keptKey) ?? 0) + 1);
    }
  }

  const moduleFiles = new Map<string, string[]>();
  for (const file of files) {
    const path = file.source.path;
    const folder = folderOf(path);
    moduleFiles.set(folder, [...(moduleFiles.get(folder) ?? []), path]);
    addNode({
      key: fileKey(path),
      kind: KIND_FILE,
      label: path.slice(path.lastIndexOf('/') + 1),
      properties: { role: file.source.role, language: file.source.language, parsed: file.syntax.parsed },
    });
  }

  for (const file of parsedFiles) {
    const path = file.source.path;
    const exported = new Set<string>();
    const starts = new Map<string, string[]>();
    let mainName: string | undefined;
    for (const entry of file.syntax.entryPoints) {
      if (entry.form === 'library-export') exported.add(entry.name);
      else if (entry.form === 'main') mainName = entry.name;
      else {
        const holder = holderAt(file.symbols, entry.span.startByte);
        if (holder !== undefined) starts.set(holder.key, [...(starts.get(holder.key) ?? []), `${entry.form}:${entry.name}`]);
      }
    }
    const ctx = program.files.get(path);
    const abstractNames = ctx?.decls.abstractNames ?? new Set<string>();
    const typeText = ctx?.decls.typeText ?? new Map<string, string>();
    const sorted = [...file.symbols].filter((symbol) => !symbol.local).sort((left, right) => left.span.startByte - right.span.startByte || byCodePoint(left.key, right.key));
    for (const symbol of sorted) {
      const topLevel = !symbol.qualifiedName.includes('.');
      const isExported = topLevel && exported.has(symbol.qualifiedName);
      const properties: { [key: string]: PropertyValue } = {
        name: symbol.name,
        qualifiedName: symbol.qualifiedName,
        symbolKind: symbol.symbolKind,
        language: file.source.language,
        path,
        exported: isExported,
        test: file.source.role !== 'code',
      };
      if (symbol.qualifiedName.includes('.callback@')) properties['inline'] = true;
      if (['class', 'method', 'interface'].includes(symbol.symbolKind)) properties['abstract'] = abstractNames.has(symbol.qualifiedName);
      const written = typeText.get(symbol.qualifiedName);
      if (written !== undefined && ['variable', 'constant', 'field', 'property'].includes(symbol.symbolKind)) properties['typeText'] = written;
      if (topLevel && mainName === symbol.qualifiedName) properties['entryPoint'] = 'main';
      const entryPoints = starts.get(symbol.key);
      if (entryPoints !== undefined) properties['entryPoints'] = [...new Set(entryPoints)].sort(byCodePoint);
      if (isExported && file.source.role === 'code') {
        properties['deadExport'] = (referencedFrom.get(symbol.key) ?? 0) === 0 && properties['entryPoint'] === undefined;
      }
      const label = properties['inline'] === true ? symbol.qualifiedName.replace(/\.callback@(\d+):\d+$/, ' callback (line $1)') : symbol.qualifiedName;
      addNode({ key: symbol.key, kind: KIND_SYMBOL, label, properties, span: toSpan(path, symbol.span) });
      addEdge({ type: REL_CONTAINS, from: fileKey(path), to: symbol.key, discriminator: '', properties: {} });
    }
  }

  // Passing an anonymous function as an argument references its actual value.
  // It does not prove invocation or scheduling by the enclosing function.
  for (const file of parsedFiles) for (const span of file.callbackValues) {
    const callback = file.symbols.find((symbol) => !symbol.local && symbol.functionLike && symbol.span.startByte === span.byteStart && symbol.span.endByte === span.byteEnd);
    if (callback === undefined) continue;
    const parent = holderAt(file.symbols.filter((symbol) => symbol.key !== callback.key), span.byteStart);
    addEdge({type: REL_REFERENCES, from: parent?.key ?? fileKey(file.source.path), to: callback.key, discriminator: String(span.byteStart), properties: {role: 'callback-value'}, span});
  }

  // Types own their actual declared members, including Go methods declared
  // in another file of the same package. No same-name fallback is allowed.
  for (const type of program.types.values()) {
    const owner = symbolKey(type.file, type.name);
    if (!symbolByKey.has(owner)) continue;
    for (const member of type.members.values()) {
      const target = symbolByKey.get(symbolKey(member.file, member.qualifiedName));
      if (target === undefined || target.local) continue;
      addEdge({ type: REL_CONTAINS, from: owner, to: target.key, discriminator: '', properties: {}, span: toSpan(member.file, target.definitionSpan) });
    }
  }

  // ---- the sites as edges ----------------------------------------------------------------
  interface Fold {
    type: SchemaKey;
    from: string;
    to: string;
    count: number;
    span: SyntaxSpan;
    path: string;
    direct: number;
    fan: number;
  }
  const folds = new Map<string, Fold>();
  const fold = (type: SchemaKey, from: string, to: string, span: SyntaxSpan, path: string, fanOut: boolean): void => {
    const id = `${type}\u0000${from}\u0000${to}`;
    const held = folds.get(id);
    if (held === undefined) {
      folds.set(id, { type, from, to, count: 1, span, path, direct: fanOut ? 0 : 1, fan: fanOut ? 1 : 0 });
      return;
    }
    held.count += 1;
    if (fanOut) held.fan += 1;
    else held.direct += 1;
    if (span.startByte < held.span.startByte) held.span = span;
  };
  const siteTargets = new Map<string, { from: string; to: string; span: SyntaxSpan; path: string }[]>();
  for (const [path, sites] of sitesByFile) {
    const symbols = symbolsByFile.get(path) ?? [];
    for (const site of [...sites].sort((left, right) => left.span.startByte - right.span.startByte || byCodePoint(left.to, right.to))) {
      const holder = holderAt(symbols, site.span.startByte);
      const access = site.roles.includes('write-access') || site.roles.includes('read-access');
      const fieldTarget = symbolByKey.get(site.to);
      const isValue = fieldTarget !== undefined && ['field', 'property', 'variable', 'constant', 'enum-member'].includes(fieldTarget.symbolKind);
      const from = holder === undefined || (isValue && access && !holder.functionLike) ? fileKey(path) : holder.key;
      const target = fieldTarget;
      if (target === undefined) continue;
      const to = target.keptKey;
      if (target.local && (to === from || to.startsWith('code.file:'))) continue;
      addEdge({
        type: REL_OCCURRENCE,
        from,
        to,
        discriminator: `${site.span.startByte}-${site.span.endByte}`,
        properties: { use: site.use, roles: [...site.roles] },
        span: toSpan(path, site.span),
      });
      siteTargets.set(path, [...(siteTargets.get(path) ?? []), { from, to, span: site.span, path }]);
      if (site.use === 'call') fold(REL_CALLS, from, to, site.span, path, false);
      else if (site.use === 'reference') fold(REL_REFERENCES, from, to, site.span, path, false);
      else if (site.use === 'extends') fold(REL_INHERITS, from, to, site.span, path, false);
      else if (site.use === 'type') {
        fold(REL_USES_TYPE, from, to, site.span, path, false);
        // Type uses remain references for existing navigation. The occurrence
        // retains its precise `type` use, never a value read or a call.
        fold(REL_REFERENCES, from, to, site.span, path, false);
      }
      if (isValue && site.use === 'reference') {
        if (site.roles.includes('read-access')) fold(REL_READS, from, to, site.span, path, false);
        if (site.roles.includes('write-access')) fold(REL_WRITES, from, to, site.span, path, false);
      }
      for (const implementation of site.fanOut) {
        const implTarget = symbolByKey.get(implementation);
        if (implTarget !== undefined && implTarget.keptKey !== from) fold(site.use === 'call' ? REL_CALLS : REL_REFERENCES, from, implTarget.keptKey, site.span, path, true);
      }
    }
  }
  for (const entry of folds.values()) {
    const properties: { [key: string]: PropertyValue } = { count: entry.count };
    if (entry.type !== REL_INHERITS && entry.direct === 0 && entry.fan > 0) properties['via'] = 'interface';
    addEdge({ type: entry.type, from: entry.from, to: entry.to, discriminator: '', properties, span: toSpan(entry.path, entry.span) });
  }

  // ---- implementations -----------------------------------------------------------------------
  for (const entry of program.implementations()) {
    const from = symbolKey(entry.impl.file, entry.impl.name);
    const to = symbolKey(entry.iface.file, entry.iface.name);
    if (!symbolByKey.has(from) || !symbolByKey.has(to)) continue;
    const written = entry.form === 'declared' ? [...(sitesByFile.get(entry.impl.file) ?? [])].find((site) => site.use === 'implements' && site.to === to) : undefined;
    addEdge({
      type: REL_IMPLEMENTS,
      from,
      to,
      discriminator: '',
      properties: { form: entry.form, inferred: entry.form === 'structural' },
      ...(written === undefined ? {} : { span: toSpan(entry.impl.file, written.span) }),
    });
  }

  // ---- modules, packages and imports ------------------------------------------------------------
  interface ImportReading {specifier:string;span:SourceSpan;properties:Record<string,PropertyValue>}
  const importCounts = new Map<string, {from:string;to:string;readings:Map<string,ImportReading>}>();
  const recordImport=(path:string,target:string,imported:ExtractedFileSyntax['imports'][number],properties:Record<string,PropertyValue>):void=>{
    const id=`${path}\u0000${target}`;const held=importCounts.get(id)??{from:fileKey(path),to:target,readings:new Map<string,ImportReading>()};
    // Syntax emits one specifier per actual import site, not one per bound name. Defend against duplicate copies only.
    const reading:ImportReading={specifier:imported.specifier,span:toSpan(path,imported.span),properties};
    held.readings.set(JSON.stringify([imported.specifier,imported.span.startByte,imported.span.endByte]),reading);
    importCounts.set(id,held);
  };
  const moduleEdges = new Map<string, { from: string; to: string; count: number; imports: string[]; span: SyntaxSpan; path: string }>();
  const fileGraph = new Map<string, Set<string>>();
  const moduleGraph = new Map<string, Set<string>>();
  const externalImport = (file: FileFacts, imported: ExtractedFileSyntax['imports'][number]): void => {
    const path = file.source.path;
    const ecosystem = file.source.language === 'go' ? 'go' : 'node';
    const manifest = rootOf(folderOf(path), ecosystem);
    const standardLibrary = isStandardLibrary(ecosystem, imported.specifier);
    const dependency = standardLibrary ? undefined : [...(manifest?.dependencies.keys() ?? [])]
      .filter((name) => imported.specifier === name || imported.specifier.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length || byCodePoint(left, right))[0];
    // Dependency declarations belong to operations. An import points to that
    // identity, not to a duplicate declaration emitted by this producer.
    const target = dependency !== undefined && manifest !== undefined
      ? `code.dependency:${manifest.span.path}#${dependency}`
      : `${KIND_PACKAGE}:import/${ecosystem}/${imported.specifier}`;
    if (dependency === undefined) addNode({
      key: target, kind: KIND_PACKAGE, label: imported.specifier,
      properties: { ecosystem, name: imported.specifier, standardLibrary, versionStatus: standardLibrary ? 'not-applicable' : 'not-declared', external: true },
      span: toSpan(path, imported.span),
    });
    recordImport(path,target,imported,{standardLibrary,versionStatus:dependency===undefined?standardLibrary?'not-applicable':'not-declared':'declared',...(dependency===undefined?{}:{version:manifest!.dependencies.get(dependency)??null})});
  };
  for (const file of parsedFiles) {
    const path = file.source.path;
    for (const imported of file.syntax.imports) {
      let toFolder: string;
      let toKey: string;
      let label: string;
      let toFile: string | undefined;
      if (file.source.language === 'go') {
        const folder = goImportFolder(imported.specifier, goModules, goFolders);
        if (folder === undefined) {
          if (goModules.some((module) => imported.specifier === module.module || imported.specifier.startsWith(`${module.module}/`))) {
            gap(path, `line ${imported.span.startLine}: internal import ${JSON.stringify(imported.specifier)} in repository path ${path} names no package folder`);
          } else externalImport(file, imported);
          continue;
        }
        toFolder = folder;
        toKey = moduleKey(folder);
        label = folder;
      } else {
        toFile = resolveSpecifier(path, imported.specifier, known);
        if (toFile === undefined) {
          if (/^\.{1,2}(?:\/|$)/u.test(imported.specifier)) gap(path, `line ${imported.span.startLine}: internal import ${JSON.stringify(imported.specifier)} in repository path ${path} names no source file`);
          else externalImport(file, imported);
          continue;
        }
        toFolder = folderOf(toFile);
        toKey = fileKey(toFile);
        label = toFile;
      }
      recordImport(path,toKey,imported,{});
      if (file.source.role !== 'code') continue;
      if (toFile !== undefined) {
        const fileTargets = fileGraph.get(fileKey(path)) ?? new Set<string>();
        fileTargets.add(toKey);
        fileGraph.set(fileKey(path), fileTargets);
      }
      const fromFolder = folderOf(path);
      if (fromFolder === toFolder) continue;
      const moduleId = `${fromFolder}\u0000${toFolder}`;
      const entry = moduleEdges.get(moduleId) ?? { from: moduleKey(fromFolder), to: moduleKey(toFolder), count: 0, imports: [], span: imported.span, path };
      entry.count += 1;
      entry.imports.push(`${path} -> ${label}`);
      if (imported.span.startByte < entry.span.startByte && entry.path === path) entry.span = imported.span;
      moduleEdges.set(moduleId, entry);
      const targets = moduleGraph.get(entry.from) ?? new Set<string>();
      targets.add(entry.to);
      moduleGraph.set(entry.from, targets);
    }
  }
  for (const entry of importCounts.values()) {
    const readings=[...entry.readings.values()].sort((a,b)=>a.span.byteStart-b.span.byteStart||a.span.byteEnd-b.span.byteEnd||byCodePoint(a.specifier,b.specifier));
    const first=readings[0]!;
    const common=Object.fromEntries(Object.entries(first.properties).filter(([name,value])=>readings.every((reading)=>JSON.stringify(reading.properties[name])===JSON.stringify(value))));
    addEdge({type:REL_IMPORTS,from:entry.from,to:entry.to,discriminator:'',properties:{...common,specifier:first.specifier,specifiers:[...new Set(readings.map((reading)=>reading.specifier))].sort(byCodePoint),count:readings.length,importReadings:readings.map((reading)=>({...reading,span:{...reading.span}}))},span:first.span});
  }
  for (const entry of moduleEdges.values()) {
    addEdge({
      type: REL_DEPENDS_ON,
      from: entry.from,
      to: entry.to,
      discriminator: '',
      properties: { count: entry.count, imports: [...new Set(entry.imports)].sort(byCodePoint) },
      span: toSpan(entry.path, entry.span),
    });
  }

  const rootCounts = new Map<string, { source: number; test: number }>();
  for (const [folder, paths] of moduleFiles) {
    const members = paths.map((path) => fileFacts.get(path)!);
    const parsed = members.filter((file) => file.syntax.parsed);
    const go = members.find((file) => file.source.language === 'go');
    const goCode = members.find((file) => file.source.language === 'go' && file.source.role === 'code') ?? go;
    const packageName = goCode === undefined ? undefined : goCode.decls.packageName;
    const allTests = members.every((file) => file.source.role !== 'code');
    // A module's place is its first member's file, in code point order: a folder has no line of its own.
    const declaredIn = [...paths].sort(byCodePoint)[0];
    if (declaredIn !== undefined) moduleFirstFile.set(moduleKey(folder), declaredIn);
    addNode({
      key: moduleKey(folder),
      kind: KIND_MODULE,
      label: folder === '' ? '.' : folder,
      ...(declaredIn === undefined ? {} : {span: {path: declaredIn, byteStart: 0, byteEnd: 0, lineStart: 1, lineEnd: 1}}),
      properties: {
        language: go === undefined ? 'typescript' : 'go',
        kind: go === undefined ? 'folder' : 'package',
        ...(packageName === undefined ? {} : { packageName }),
        role: allTests ? 'test' : 'code',
        files: members.length,
        parsedFiles: parsed.length,
      },
    });
    for (const path of paths) addEdge({ type: REL_CONTAINS, from: moduleKey(folder), to: fileKey(path), discriminator: '', properties: {} });
    const root = rootOf(folder);
    if (root !== undefined) {
      addEdge({ type: REL_CONTAINS, from: packageKey(root.folder), to: moduleKey(folder), discriminator: '', properties: {} });
      const held = rootCounts.get(root.folder) ?? { source: 0, test: 0 };
      held.source += members.filter((file) => file.source.role === 'code').length;
      held.test += members.filter((file) => file.source.role === 'test').length;
      rootCounts.set(root.folder, held);
    }
  }
  for (const manifest of manifests) {
    const counts = rootCounts.get(manifest.folder) ?? { source: 0, test: 0 };
    addNode({
      key: packageKey(manifest.folder),
      kind: KIND_PACKAGE,
      label: manifest.name,
      ...(manifest.span === undefined ? {} : {span: manifest.span}),
      properties: {
        ecosystem: manifest.ecosystem,
        name: manifest.name,
        sourceFiles: counts.source,
        testFiles: counts.test,
        hasTests: counts.test > 0,
        tests: counts.test > 0 ? 'present' : 'none',
        frameworks: [...manifest.frameworks],
      },
    });
  }

  // ---- cycles ----------------------------------------------------------------------------------------
  const fileCycleFolders: Set<string>[] = [];
  const emitCycles = (level: 'module' | 'file', graph: Map<string, Set<string>>): void => {
    const members = new Set<string>(graph.keys());
    for (const targets of graph.values()) for (const target of targets) members.add(target);
    const components = cycles([...members], graph);
    // A component can be wide (one root folder and every folder under it import each other); the pairs
    // that import each other directly are the cycles a reader can act on, so each pair is a record too.
    const pairs: string[][] = [];
    for (const [from, targets] of graph) {
      for (const to of targets) {
        if (from < to && graph.get(to)?.has(from) === true) pairs.push([from, to]);
      }
    }
    // A folder is a module, so a root folder and its subfolders "cycle" through plain layering; a module cycle is
    // stored only where a cycle of files crosses exactly those folders.
    const backed = (component: string[]): boolean =>
      level === 'file' ||
      fileCycleFolders.some((folders) => component.every((member) => folders.has(member)));
    const seen = new Set<string>();
    for (const component of [...components, ...pairs].filter(backed).sort((left, right) => byCodePoint(left.join('+'), right.join('+')))) {
      const id = component.join('+');
      if (seen.has(id)) continue;
      seen.add(id);
      const inside = new Set(component);
      const internal: string[] = [];
      for (const from of component) for (const to of [...(graph.get(from) ?? [])].sort(byCodePoint)) if (inside.has(to)) internal.push(`${from} -> ${to}`);
      if (level === 'file') fileCycleFolders.push(new Set(component.map((member) => moduleKey(folderOf(member.slice(member.indexOf(':') + 1))))));
      const key = cycleKey(level, component);
      // A file cycle names its first file; a module cycle names the first file of its first module, because a folder is no
      // file to open (madarch-m38l.16).
      const member = [...component].sort(byCodePoint)[0];
      const path = level === 'file' ? member?.slice(member.indexOf(':') + 1) : member === undefined ? undefined : moduleFirstFile.get(member);
      addNode({ key, kind: KIND_CYCLE, label: component.map((member) => member.slice(member.indexOf(':') + 1)).join(' <-> '), ...(path === undefined ? {} : {span: {path, byteStart: 0, byteEnd: 0, lineStart: 1, lineEnd: 1}}), properties: { level, size: component.length, members: component, edges: internal } });
      for (const member of component) addEdge({ type: REL_CYCLE_MEMBER, from: key, to: member, discriminator: '', properties: {} });
    }
  };
  emitCycles('file', fileGraph);
  emitCycles('module', moduleGraph);

  // ---- the test catalogue --------------------------------------------------------------------------------
  for (const file of parsedFiles) {
    if (file.source.role !== 'test' || file.syntax.tests.length === 0) continue;
    const path = file.source.path;
    const details = await readTestDetails(file.source, file.syntax.tests);
    const root = rootOf(folderOf(path));
    const ordinals = new Map<string, number>();
    for (const test of [...file.syntax.tests].sort((left, right) => left.span.startByte - right.span.startByte)) {
      const detail = details.get(test.span.startByte);
      const suite = detail?.suite ?? [];
      const full = [...suite, test.name].join(' > ');
      const ordinal = ordinals.get(full) ?? 0;
      ordinals.set(full, ordinal + 1);
      const key = testCaseKey(path, full, ordinal);
      const framework = test.framework ?? (file.source.language === 'go' ? 'go-test' : root?.frameworks[0]);
      const properties: { [key: string]: PropertyValue } = {
        name: test.name,
        suite: [...suite],
        path,
        language: file.source.language,
        testKind: detail?.testKind ?? 'unit',
        skipped: detail?.skipped ?? false,
      };
      if (framework !== undefined) properties['framework'] = framework;
      if (detail?.skipReason !== undefined) properties['skipReason'] = detail.skipReason;
      if (detail?.cases !== undefined) properties['cases'] = detail.cases;
      addNode({ key, kind: KIND_TEST_CASE, label: full, properties, span: toSpan(path, test.span) });
      addEdge({ type: REL_CONTAINS, from: fileKey(path), to: key, discriminator: '', properties: {} });
      const subjects = new Map<string, number>();
      const within = (site: { span: SyntaxSpan }, from: number, to: number): boolean => site.span.startByte >= from && site.span.endByte <= to;
      const caseSpans = file.syntax.tests.map((other) => other.span);
      const reached = (site: { to: string }): void => {
        const found = symbolByKey.get(site.to);
        if (found === undefined) return;
        const foundFile = fileFacts.get(fileOfSymbol(found.key));
        if (foundFile !== undefined && foundFile.source.role === 'code') subjects.set(found.keptKey, (subjects.get(found.keptKey) ?? 0) + 1);
      };
      const visitedHelpers = new Set<string>();
      const follow = (site: { span: SyntaxSpan; to: string }): void => {
        reached(site);
        // A helper that stands in a test file (a builder, a `listen` function) is part of what the case does.
        const helper = symbolByKey.get(site.to);
        if (helper === undefined || visitedHelpers.has(helper.keptKey)) return;
        const helperPath = fileOfSymbol(helper.key);
        const helperFile = fileFacts.get(helperPath);
        if (helperFile === undefined || helperFile.source.role === 'code') return;
        visitedHelpers.add(helper.keptKey);
        const kept = symbolByKey.get(helper.keptKey) ?? helper;
        for (const inner of siteTargets.get(helperPath) ?? []) {
          if (within(inner, kept.span.startByte, kept.span.endByte)) follow({ span: inner.span, to: inner.to });
        }
      };
      for (const site of siteTargets.get(path) ?? []) {
        const direct = within(site, test.span.startByte, test.span.endByte);
        // Setup and helpers written beside the cases of the suite (a `beforeEach`) belong to every case of it.
        const setup =
          detail?.suiteRange !== undefined &&
          within(site, detail.suiteRange.startByte, detail.suiteRange.endByte) &&
          !caseSpans.some((span) => within(site, span.startByte, span.endByte));
        if (direct || setup) follow({ span: site.span, to: site.to });
      }
      for (const [subject, count] of subjects) addEdge({ type: REL_TESTS, from: key, to: subject, discriminator: '', properties: { count } });
    }
  }

  const sortedNodes = [...nodes.values()].sort((left, right) => byCodePoint(left.key, right.key));
  const sortedEdges = [...edgeMap.values()].sort(
    (left, right) => byCodePoint(left.type, right.type) || byCodePoint(left.from, right.from) || byCodePoint(left.to, right.to) || byCodePoint(left.discriminator, right.discriminator),
  );
  const sortedGaps = [...gaps].sort((left, right) => byCodePoint(left.path, right.path) || byCodePoint(left.reason, right.reason));
  const extraction: Extraction = { producer: CODE_PRODUCER, nodes: sortedNodes, edges: sortedEdges, gaps: sortedGaps };
  const byId = <T extends { readonly id: string }>(left: T, right: T): number => byCodePoint(left.id, right.id);
  const facts = freezeCodeFacts({
    files: files.map((file) => {
      const manifest = rootOf(folderOf(file.source.path), file.source.language === 'go' ? 'go' : 'node');
      return { path: file.source.path, language: file.syntax.language ?? file.source.grammar, parsed: file.syntax.parsed,
        ...(manifest === undefined ? {} : { manifest: { path: manifest.span.path, ecosystem: manifest.ecosystem, name: manifest.name } }) };
    }).sort((left, right) => byCodePoint(left.path, right.path)),
    symbols: files.flatMap((file) => file.symbols.filter((symbol) => !symbol.local).map((symbol) => ({ key: symbol.key, path: file.source.path, name: symbol.name, qualifiedName: symbol.qualifiedName, symbolKind: symbol.symbolKind, callable: symbol.functionLike, span: toSpan(file.source.path, symbol.span), ...callables.get(symbol.key) }))).sort((left, right) => byCodePoint(left.key, right.key)),
    imports: imports.sort(byId), exports: exports.sort(byId), bindings: bindings.sort(byId), expressions: expressions.sort(byId),
    calls: calls.sort((left, right) => byCodePoint(left.expression, right.expression)),
    sites: [...sitesByFile].flatMap(([path, sites]) => sites.map((site) => ({ path, span: toSpan(path, site.span), to: site.to, use: site.use, roles: [...site.roles], fanOut: [...site.fanOut], holder: holderAt(symbolsByFile.get(path) ?? [], site.span.startByte)?.keptKey ?? fileKey(path) }))).sort((left, right) => byCodePoint(left.path, right.path) || left.span.byteStart - right.span.byteStart || byCodePoint(left.to, right.to)),
    gaps: sortedGaps.map((gap) => ({ ...gap })),
  });
  return { extraction, facts };
}

function lineCountOf(bytes: Uint8Array): number {
  let lines = 1;
  for (const byte of bytes) if (byte === 10) lines += 1;
  return lines;
}

function decoderSafe(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return '';
  }
}
