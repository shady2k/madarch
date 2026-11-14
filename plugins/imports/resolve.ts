/**
 * The repository's own module resolution, over the graph's file list (decision 0035, item 15; task madarch-o0eq.6): a
 * specifier is resolved against the files the graph holds, with the rules TypeScript and the ESM loader use — a `.js`
 * specifier names the `.ts` source, an extensionless one tries `.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`, `.js` and the
 * rest, a folder answers with its `package.json` entry before its `index`, and the tsconfig nearest the importing file
 * supplies `baseUrl` and `paths`. Nothing here reads a disk: the file list, the texts and the tsconfigs are the graph's.
 */

/** The extensions the reader parses: a file with another extension states no import this plugin reads. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The extensions a specifier without one may name, in the order TypeScript tries them. */
const EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** The TypeScript source a JavaScript extension written in the specifier may stand for. */
const SOURCE_OF: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx', '.ts', '.d.ts'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/**
 * The fields of a package.json that name the module a folder stands for, in the order TypeScript reads them: a folder
 * that states its types answers with those, and only a package without them answers with its runtime entry.
 */
const MAIN_FIELDS: readonly string[] = ['types', 'typings', 'main', 'module'];

/** The tsconfig nearest a file: the options it inherits through `extends`, resolved against the folders that declared them. */
export interface Tsconfig {
  /** The folder the config stands in, repository-relative and without a trailing slash; the repository root is ''. */
  readonly dir: string;
  /** The folder a bare specifier is looked up in, repository-relative; absent when no config on the chain declares one. */
  readonly baseUrl?: string;
  /** The `paths` aliases of the effective config: the pattern as written, and its targets as written. */
  readonly paths: Readonly<Record<string, readonly string[]>>;
  /** The folder the alias targets are relative to when no `baseUrl` is in effect: the config that declared them. */
  readonly pathsDir?: string;
}

/** Where a specifier leads: a file of the repository, a package outside it, or the file path a relative one names and no vertex holds. */
export type Resolution =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'none'; readonly path: string };

/** The folder of a path, with the repository root as ''. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/** A repository-relative path with `.` and `..` folded; a `..` that leaves the repository stays, so it is never hidden. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
    } else parts.push(part);
  }
  return parts.join('/');
}

/** The extension of a path's last segment, or '' when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const cut = name.lastIndexOf('.');
  return cut <= 0 ? '' : name.slice(cut);
}

/** The source extension of a path, or undefined when the path is not a TypeScript or JavaScript source. */
export function sourceExtensionOf(path: string): string | undefined {
  const extension = extensionOf(path);
  return SOURCE_EXTENSIONS.includes(extension) ? extension : undefined;
}

/** The files one specifier base may name as a file: its source substitutes, the base itself, and the base with an extension. */
function fileCandidates(base: string): string[] {
  const extension = extensionOf(base);
  const source = SOURCE_OF[extension];
  const candidates: string[] = [];
  if (source !== undefined) for (const replacement of source) candidates.push(base.slice(0, -extension.length) + replacement);
  candidates.push(base);
  for (const tried of EXTENSIONS) candidates.push(base + tried);
  return candidates;
}

/** The files a folder answers with when it names no entry: its `index` file in each extension. */
function indexCandidates(base: string): string[] {
  return EXTENSIONS.map((tried) => `${base}/index${tried}`);
}

/** The package a specifier names, as its ecosystem writes it: `@scope/pkg` of `@scope/pkg/sub`, `node:fs` of itself. */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

/** Whether a specifier is written as a path of the repository rather than as a package. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

/** The first candidate the repository holds, or undefined. */
function foundIn(candidates: readonly string[], known: ReadonlySet<string>): string | undefined {
  for (const candidate of candidates) {
    const path = normalizePath(candidate);
    if (known.has(path)) return path;
  }
  return undefined;
}

/** One JSON object a tsconfig's text states, with comments and a trailing comma allowed, as TypeScript reads it. */
function parseJsonc(text: string): unknown {
  const api = (Bun as unknown as { JSONC?: { parse(input: string): unknown } }).JSONC;
  return api === undefined ? JSON.parse(text) : api.parse(text);
}

/**
 * The file a specifier base names, as TypeScript reads it: a file beside the base first, then a folder's `package.json`
 * entry, then its `index`. A base that leaves the repository names nothing here.
 */
function resolveBase(base: string, known: ReadonlySet<string>, texts: ReadonlyMap<string, string>): string | undefined {
  const path = normalizePath(base);
  if (path === '..' || path.startsWith('../')) return undefined;
  const direct = foundIn(fileCandidates(path), known);
  if (direct !== undefined) return direct;
  const manifestPath = path === '' ? 'package.json' : `${path}/package.json`;
  if (known.has(manifestPath)) {
    const text = texts.get(manifestPath);
    if (text !== undefined) {
      let manifest: Record<string, unknown> | undefined;
      try {
        const body = JSON.parse(text) as unknown;
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) manifest = body as Record<string, unknown>;
      } catch { manifest = undefined; }
      for (const field of MAIN_FIELDS) {
        const entry = manifest?.[field];
        if (typeof entry !== 'string' || entry === '') continue;
        const entryBase = path === '' ? entry : `${path}/${entry}`;
        const answer = foundIn(fileCandidates(entryBase), known) ?? foundIn(indexCandidates(entryBase), known);
        if (answer !== undefined) return answer;
      }
    }
  }
  return foundIn(indexCandidates(path), known);
}

/**
 * The one `paths` pattern a specifier answers: the exact pattern, or the one with the longest prefix before its `*`.
 * A pattern whose targets all fail is not replaced by a less specific pattern, as TypeScript reads them.
 */
function bestPathMatch(paths: Readonly<Record<string, readonly string[]>>, specifier: string): { pattern: string; capture: string } | undefined {
  if (Object.prototype.hasOwnProperty.call(paths, specifier)) return { pattern: specifier, capture: '' };
  let best: { pattern: string; capture: string; prefix: number } | undefined;
  for (const pattern of Object.keys(paths)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const capture = captureOf(pattern, specifier);
    if (capture === undefined) continue;
    if (best === undefined || star > best.prefix) best = { pattern, capture, prefix: star };
  }
  return best === undefined ? undefined : { pattern: best.pattern, capture: best.capture };
}

/** The capture a path pattern gives a specifier, or undefined when the pattern does not name it. */
function captureOf(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === specifier ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  if (specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * The options one config states, with the `baseUrl` it inherits and the `paths` in effect: a child that declares
 * `paths` replaces the inherited aliases. The targets stay as written, because the folder they resolve against is the
 * final effective `baseUrl` — not the one of the config that first declared them.
 */
function optionsOf(text: string, dir: string, inherited: Tsconfig | undefined): Tsconfig {
  const body = parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  const options = body.compilerOptions ?? {};
  const declaredBase = typeof options.baseUrl === 'string' ? options.baseUrl : undefined;
  const baseUrl = declaredBase === undefined ? inherited?.baseUrl : normalizePath(`${dir}/${declaredBase}`);
  let paths: Readonly<Record<string, readonly string[]>>;
  let pathsDir: string | undefined;
  if (options.paths !== undefined) {
    const own: Record<string, readonly string[]> = {};
    if (options.paths !== null && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
      for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        own[pattern] = targets.filter((target): target is string => typeof target === 'string');
      }
    }
    paths = own;
    pathsDir = dir;
  } else {
    paths = inherited?.paths ?? {};
    pathsDir = inherited?.pathsDir;
  }
  return { dir, ...(baseUrl === undefined ? {} : { baseUrl }), paths, ...(pathsDir === undefined ? {} : { pathsDir }) };
}

/**
 * Every tsconfig the repository holds, by its path, with the options it inherits through `extends`: a base config's
 * base and aliases are already resolved against the folders that declared them, so an inheriting config keeps them.
 */
export function readTsconfigs(files: readonly string[], texts: ReadonlyMap<string, string>): Map<string, Tsconfig> {
  const configs = new Map<string, Tsconfig>();
  const reading = new Set<string>();
  const read = (path: string): Tsconfig | undefined => {
    const known = configs.get(path);
    if (known !== undefined) return known;
    if (reading.has(path)) return undefined;
    const text = texts.get(path);
    if (text === undefined) return undefined;
    reading.add(path);
    try {
      let body: { extends?: unknown; compilerOptions?: { baseUrl?: unknown } };
      try {
        body = parseJsonc(text) as typeof body;
      } catch {
        // A config the reader cannot parse states no alias: the relative rules still answer, and nothing is guessed.
        return undefined;
      }
      const dir = folderOf(path);
      let base: Tsconfig | undefined;
      if (typeof body.extends === 'string' && (body.extends.startsWith('.') || !body.extends.includes('/') || body.extends.startsWith('/'))) {
        const extended = normalizePath(`${dir}/${body.extends}`);
        const candidate = texts.has(extended) ? extended : texts.has(`${extended}.json`) ? `${extended}.json` : undefined;
        if (candidate !== undefined) base = read(candidate);
      }
      const config = optionsOf(text, dir, base);
      configs.set(path, config);
      return config;
    } finally {
      reading.delete(path);
    }
  };
  for (const path of [...files].filter((one) => one === 'tsconfig.json' || one.endsWith('/tsconfig.json')).sort()) read(path);
  return configs;
}

/** The tsconfig nearest a file: the config in its folder or the closest one above it. */
export function tsconfigFor(path: string, configs: ReadonlyMap<string, Tsconfig>): Tsconfig | undefined {
  let dir = folderOf(path);
  for (;;) {
    const config = configs.get(dir === '' ? 'tsconfig.json' : `${dir}/tsconfig.json`);
    if (config !== undefined) return config;
    if (dir === '') return undefined;
    dir = folderOf(dir);
  }
}

/**
 * Where one specifier leads, read as the repository's own resolution reads it: a relative path against the importing
 * file's folder, then a tsconfig alias or base, then the package the specifier names. A relative specifier no file
 * answers states the path it names, so the caller can record the unresolved reference where the import stands.
 */
export function resolveSpecifier(fromPath: string, specifier: string, files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, configs: ReadonlyMap<string, Tsconfig>): Resolution {
  if (isRelativeSpecifier(specifier)) {
    const base = specifier.startsWith('/')
      ? specifier.slice(1)
      : `${folderOf(fromPath)}/${specifier}`;
    const path = normalizePath(base);
    if (path === '..' || path.startsWith('../')) return { kind: 'none', path };
    const resolved = resolveBase(path, files, texts);
    return resolved === undefined ? { kind: 'none', path } : { kind: 'file', path: resolved };
  }
  const config = tsconfigFor(fromPath, configs);
  if (config !== undefined) {
    const match = bestPathMatch(config.paths, specifier);
    if (match !== undefined) {
      // TypeScript anchors alias targets at the effective baseUrl — a child's own, or the one it inherits — and only at
      // the declaring config's folder when no config states a base (utilities.ts `getPathsBasePath`, v5.9.3).
      const anchor = config.baseUrl ?? config.pathsDir ?? config.dir;
      for (const target of config.paths[match.pattern] ?? []) {
        const resolved = resolveBase(normalizePath(`${anchor}/${target.replace('*', match.capture)}`), files, texts);
        if (resolved !== undefined) return { kind: 'file', path: resolved };
      }
    }
    // A config that declares no baseUrl does not resolve a bare name against the repository root.
    if (config.baseUrl !== undefined) {
      const resolved = resolveBase(config.baseUrl === '' ? specifier : `${config.baseUrl}/${specifier}`, files, texts);
      if (resolved !== undefined) return { kind: 'file', path: resolved };
    }
  }
  return { kind: 'package', name: packageNameOf(specifier) };
}
