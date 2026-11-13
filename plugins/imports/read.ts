/// <reference path="./ambient.d.ts" />
/**
 * The imports reader (decision 0035, items 3, 8, 15 and 24; task madarch-o0eq.6): the TypeScript and JavaScript files the
 * graph holds, read with a real parser, become the import edges a reader follows — which file imports which, and which
 * package it names — each edge carrying the place of its import, so a file pair imported twice is two edges.
 *
 * The parser is `@babel/parser` 7.29.13, the one the db-schema plugin already pins (madarch-mwhd.3: no regular expression
 * over source text). It gives every import declaration, re-export, `require()` call, `import()` call and `import()` type
 * with its line and column, and it recovers from a file that is not valid as a whole, so an illustrative source still
 * states the imports it holds. A specifier is then resolved by the repository's own rules (`./resolve.js`) over the file
 * list the graph holds and the tsconfig nearest the importing file.
 */
import { parse as parseTypeScript } from '@babel/parser';
import { readTsconfigs, resolveSpecifier, sourceExtensionOf } from './resolve.js';

/** The forms a file names another module in. */
export type ImportForm = 'static' | 'type' | 'dynamic' | 'require' | 're-export';

/** Where an import leads: a file of the repository, or a package outside it. */
export type ImportTarget = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'package'; readonly name: string };

/** One import a file states, with the place that tells it from the file's other imports. */
export interface ImportRecord {
  /** The repository-relative path of the importing file. */
  readonly from: string;
  readonly to: ImportTarget;
  /** The line and column the import opens at, 1-based; the same pair is the edge's discriminator. */
  readonly line: number;
  readonly column: number;
  /** The last line of the statement or call. */
  readonly lineEnd: number;
  /** The specifier as the file writes it. */
  readonly specifier: string;
  readonly form: ImportForm;
  /** The names the import takes, as the module exports them: `default` for a default import, `*` for a namespace. */
  readonly names?: readonly string[];
  /** Whether every binding the import takes is a type. */
  readonly typeOnly?: boolean;
}

/** One import the reader could not resolve or read, with the place that says where: never a silence. */
export interface ImportProblem {
  readonly repository: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly lineEnd: number;
  readonly specifier: string;
  readonly form: ImportForm;
  readonly names?: readonly string[];
  readonly typeOnly?: boolean;
  /** The file path a relative specifier names, which no vertex of the graph holds: the edge's unresolved end. */
  readonly target?: string;
  readonly message: string;
}

/** One package the repository's files import, at the first place that names it. */
export interface PackageRecord {
  readonly key: { readonly ecosystem: string; readonly name: string };
  readonly evidence: { readonly repository: string; readonly path: string; readonly lineStart: number; readonly lineEnd: number; readonly commitOrDigest?: string };
}

/** The repository as the host answered it: every file path, and the text and blob of the files it read. */
export interface RepositoryTexts {
  readonly repository: string;
  readonly files: readonly string[];
  readonly texts: ReadonlyMap<string, string>;
  readonly blobs: ReadonlyMap<string, string>;
}

/** Everything the reader found in one repository. */
export interface ReadResult {
  readonly records: readonly ImportRecord[];
  readonly packages: readonly PackageRecord[];
  readonly problems: readonly ImportProblem[];
}

/** One node of @babel/parser's answer, read field by field. */
type BabelNode = { readonly type?: unknown; readonly [key: string]: unknown };

/** The fields of a node the walk does not enter: positions and comments, never a child of the syntax. */
const NOT_CHILDREN: ReadonlySet<string> = new Set(['loc', 'start', 'end', 'range', 'tokens', 'comments', 'errors', 'extra', 'leadingComments', 'trailingComments', 'innerComments']);

/** The ecosystem of every package this reader states: the files are TypeScript and JavaScript. */
const ECOSYSTEM = 'node';

/** Whether a value is a node of the syntax. */
function isNode(value: unknown): value is BabelNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';
}

/** The source text of a string literal or a template with no substitution, or undefined for any other expression. */
function stringOf(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value['type'] === 'StringLiteral' && typeof value['value'] === 'string') return value['value'];
  if (value['type'] === 'TemplateLiteral') {
    const expressions = value['expressions'];
    const quasis = value['quasis'];
    if (!Array.isArray(expressions) || expressions.length !== 0 || !Array.isArray(quasis) || quasis.length !== 1) return undefined;
    const quasi = quasis[0];
    if (!isNode(quasi)) return undefined;
    // A template element's value is `{ raw, cooked }`, not a node of the syntax.
    const parts = quasi['value'];
    if (typeof parts !== 'object' || parts === null) return undefined;
    const held = parts as { readonly cooked?: unknown; readonly raw?: unknown };
    if (typeof held.cooked === 'string') return held.cooked;
    if (typeof held.raw === 'string') return held.raw;
  }
  return undefined;
}

/** The name an identifier or a string literal states. */
function nameOf(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value['type'] === 'Identifier' && typeof value['name'] === 'string') return value['name'];
  if (value['type'] === 'StringLiteral' && typeof value['value'] === 'string') return value['value'];
  return undefined;
}

/** A place in the file: the line and column the node opens at, and the line it ends on, all 1-based. */
interface Place { readonly line: number; readonly column: number; readonly lineEnd: number }

/** The place a node stands at, or undefined for a node the parser gave no position. */
function placeOf(node: BabelNode): Place | undefined {
  const loc = node['loc'];
  if (typeof loc !== 'object' || loc === null) return undefined;
  const start = (loc as { start?: unknown }).start;
  if (typeof start !== 'object' || start === null) return undefined;
  const line = (start as { line?: unknown }).line;
  const column = (start as { column?: unknown }).column;
  const end = (loc as { end?: unknown }).end;
  const endLine = typeof end === 'object' && end !== null ? (end as { line?: unknown }).line : undefined;
  if (typeof line !== 'number' || typeof column !== 'number') return undefined;
  return { line, column: column + 1, lineEnd: typeof endLine === 'number' ? endLine : line };
}

/** The names one import takes, from the specifiers @babel/parser states on the declaration. */
function importedNames(specifiers: unknown): string[] | undefined {
  if (!Array.isArray(specifiers)) return undefined;
  const names: string[] = [];
  for (const specifier of specifiers) {
    if (!isNode(specifier)) continue;
    const type = specifier['type'];
    if (type === 'ImportDefaultSpecifier') names.push('default');
    else if (type === 'ImportNamespaceSpecifier') names.push('*');
    else if (type === 'ImportSpecifier') {
      const imported = nameOf(specifier['imported']);
      if (imported !== undefined) names.push(imported);
    }
  }
  return names.length === 0 ? undefined : [...new Set(names)];
}

/** Whether every binding an import takes is a type. */
function importIsTypeOnly(node: BabelNode): boolean {
  if (node['importKind'] === 'type') return true;
  const specifiers = node['specifiers'];
  if (!Array.isArray(specifiers) || specifiers.length === 0) return false;
  return specifiers.every((specifier) => isNode(specifier) && specifier['importKind'] === 'type');
}

/** The names one re-export takes, as the module it names exports them. */
function reExportedNames(node: BabelNode): string[] | undefined {
  const exported = nameOf(node['exported']);
  if (node['type'] === 'ExportAllDeclaration') return [exported ?? '*'];
  const specifiers = node['specifiers'];
  if (!Array.isArray(specifiers) || specifiers.length === 0) return undefined;
  const names: string[] = [];
  for (const specifier of specifiers) {
    if (!isNode(specifier)) continue;
    const type = specifier['type'];
    if (type === 'ExportNamespaceSpecifier') names.push('*');
    else if (type === 'ExportDefaultSpecifier') names.push('default');
    else names.push(nameOf(specifier['local']) ?? nameOf(specifier['exported']) ?? '');
  }
  return [...new Set(names.filter((name) => name !== ''))];
}

/** Whether every name a re-export takes is a type. */
function reExportIsTypeOnly(node: BabelNode): boolean {
  if (node['exportKind'] === 'type') return true;
  const specifiers = node['specifiers'];
  if (!Array.isArray(specifiers) || specifiers.length === 0) return false;
  return specifiers.every((specifier) => isNode(specifier) && specifier['exportKind'] === 'type');
}

/** The import one node states, or undefined for a node that names no module. */
function siteOf(node: BabelNode): { specifier: string; form: ImportForm; names?: readonly string[]; typeOnly?: boolean; place: Place } | undefined {
  const place = placeOf(node);
  if (place === undefined) return undefined;
  const type = node['type'];
  if (type === 'ImportDeclaration') {
    const specifier = stringOf(node['source']);
    if (specifier === undefined) return undefined;
    const names = importedNames(node['specifiers']);
    const typeOnly = importIsTypeOnly(node);
    return { specifier, form: typeOnly ? 'type' : 'static', ...(names === undefined ? {} : { names }), ...(typeOnly ? { typeOnly: true } : {}), place };
  }
  if (type === 'ExportNamedDeclaration' || type === 'ExportAllDeclaration') {
    const specifier = stringOf(node['source']);
    if (specifier === undefined) return undefined;
    const names = reExportedNames(node);
    const typeOnly = reExportIsTypeOnly(node);
    return { specifier, form: 're-export', ...(names === undefined ? {} : { names }), ...(typeOnly ? { typeOnly: true } : {}), place };
  }
  if (type === 'TSImportEqualsDeclaration') {
    const reference = node['moduleReference'];
    if (!isNode(reference) || reference['type'] !== 'TSExternalModuleReference') return undefined;
    const specifier = stringOf(reference['expression']);
    if (specifier === undefined) return undefined;
    const typeOnly = node['isTypeOnly'] === true;
    return { specifier, form: 'require', ...(typeOnly ? { typeOnly: true } : {}), place };
  }
  if (type === 'TSImportType') {
    // `type T = import('./x').T`: a type-only dynamic import, and the qualifier names what it takes.
    const specifier = stringOf(node['argument']);
    if (specifier === undefined) return undefined;
    const qualifier = nameOf(node['qualifier']);
    return { specifier, form: 'type', ...(qualifier === undefined ? {} : { names: [qualifier] }), typeOnly: true, place };
  }
  if (type === 'CallExpression') {
    const callee = node['callee'];
    const args = node['arguments'];
    if (!isNode(callee) || !Array.isArray(args)) return undefined;
    const specifier = stringOf(args[0]);
    if (specifier === undefined) return undefined;
    if (callee['type'] === 'Import') return { specifier, form: 'dynamic', place };
    if (callee['type'] === 'Identifier' && callee['name'] === 'require' && args.length === 1) return { specifier, form: 'require', place };
  }
  return undefined;
}

/** Every import site of one parsed file, in the order the walk meets them. */
function sitesOf(program: BabelNode): { specifier: string; form: ImportForm; names?: readonly string[]; typeOnly?: boolean; place: Place }[] {
  const sites: { specifier: string; form: ImportForm; names?: readonly string[]; typeOnly?: boolean; place: Place }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (!isNode(value)) return;
    const site = siteOf(value);
    if (site !== undefined) sites.push(site);
    for (const [key, child] of Object.entries(value)) {
      if (NOT_CHILDREN.has(key)) continue;
      if (child === null || typeof child !== 'object') continue;
      visit(child);
    }
  };
  visit(program);
  return sites;
}

/** The order records are answered in: by file, then by place, then by target. */
function byPlace(left: ImportRecord, right: ImportRecord): number {
  const file = left.from < right.from ? -1 : left.from > right.from ? 1 : 0;
  if (file !== 0) return file;
  if (left.line !== right.line) return left.line - right.line;
  if (left.column !== right.column) return left.column - right.column;
  const leftTarget = left.to.kind === 'file' ? left.to.path : left.to.name;
  const rightTarget = right.to.kind === 'file' ? right.to.path : right.to.name;
  return leftTarget < rightTarget ? -1 : leftTarget > rightTarget ? 1 : 0;
}

/** The parser's plugins for a path: a `.ts` file is TypeScript (a `<T>value` assertion is not JSX), a `.tsx` or `.jsx` adds JSX. */
function parseOptionsOf(path: string): { sourceType: 'unambiguous'; plugins: string[]; allowReturnOutsideFunction: boolean; allowAwaitOutsideFunction: boolean; errorRecovery: boolean } {
  const extension = sourceExtensionOf(path);
  const shared = { sourceType: 'unambiguous' as const, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, errorRecovery: true };
  if (extension === '.tsx' || extension === '.jsx') return { ...shared, plugins: ['typescript', 'jsx', 'decorators-legacy'] };
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return { ...shared, plugins: ['typescript', 'decorators-legacy'] };
  return { ...shared, plugins: ['jsx', 'decorators-legacy'] };
}

/** The part a site states of a record or a problem. */
function statedBy(site: { names?: readonly string[]; typeOnly?: boolean }): { names?: readonly string[]; typeOnly?: boolean } {
  return { ...(site.names === undefined ? {} : { names: site.names }), ...(site.typeOnly === true ? { typeOnly: true } : {}) };
}

/**
 * Every import the repository's files state, resolved against the repository's own file list and tsconfigs. A relative
 * specifier no file answers is a problem with its place and the path it names; a file the parser refuses is a problem
 * with its place. The other imports are still answered.
 */
export function readRepository(repository: RepositoryTexts): ReadResult {
  const configs = readTsconfigs(repository.files, repository.texts);
  const known = new Set(repository.files);
  const records: ImportRecord[] = [];
  const problems: ImportProblem[] = [];
  const packages = new Map<string, PackageRecord>();
  // Only the files whose text the host answered are read: a source the caller did not ask for is not this reader's
  // input, and a source it asked for and did not receive is the caller's problem, with the place it reports.
  for (const path of [...repository.texts.keys()].filter((one) => sourceExtensionOf(one) !== undefined).sort()) {
    const text = repository.texts.get(path) ?? '';
    let program: BabelNode;
    try {
      program = parseTypeScript(text, parseOptionsOf(path)) as BabelNode;
    } catch (error) {
      const failed = error as { message?: string; loc?: { line?: number; column?: number } };
      const line = failed.loc?.line ?? 1;
      problems.push({
        repository: repository.repository, path, line, column: (failed.loc?.column ?? 0) + 1, lineEnd: line,
        specifier: '', form: 'static',
        message: `the parser refused the file: ${(failed.message ?? 'no cause stated').split('\n')[0] ?? ''}`,
      });
      continue;
    }
    for (const site of sitesOf(program)) {
      const resolution = resolveSpecifier(path, site.specifier, known, repository.texts, configs);
      if (resolution.kind === 'none') {
        problems.push({
          repository: repository.repository, path, line: site.place.line, column: site.place.column, lineEnd: site.place.lineEnd,
          specifier: site.specifier, form: site.form, ...statedBy(site), target: resolution.path,
          message: `the relative specifier ${JSON.stringify(site.specifier)} resolves to no file of the repository`,
        });
        continue;
      }
      records.push({
        from: path,
        to: resolution.kind === 'file' ? { kind: 'file', path: resolution.path } : { kind: 'package', name: resolution.name },
        line: site.place.line, column: site.place.column, lineEnd: site.place.lineEnd,
        specifier: site.specifier, form: site.form, ...statedBy(site),
      });
      if (resolution.kind === 'package') {
        const identity = `${ECOSYSTEM}\u0000${resolution.name}`;
        if (!packages.has(identity)) {
          const blob = repository.blobs.get(path);
          packages.set(identity, {
            key: { ecosystem: ECOSYSTEM, name: resolution.name },
            evidence: { repository: repository.repository, path, lineStart: site.place.line, lineEnd: site.place.lineEnd, ...(blob === undefined ? {} : { commitOrDigest: blob }) },
          });
        }
      }
    }
  }
  records.sort(byPlace);
  return {
    records,
    packages: [...packages.values()].sort((left, right) => (left.key.name < right.key.name ? -1 : left.key.name > right.key.name ? 1 : 0)),
    problems,
  };
}
