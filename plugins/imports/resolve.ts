/**
 * The repository's own module resolution, over the graph's file list (decision 0035, item 15; task madarch-o0eq.6): a
 * specifier is resolved against the files the graph holds, with the rules TypeScript and the ESM loader use — a `.js`
 * specifier names the `.ts` source, an extensionless one tries `.ts`, `.tsx`, `.mts`, `.cts`, `.d.ts`, `.js` and the
 * rest, a folder answers with its `index` or the entry its `package.json` names, and the tsconfig nearest the importing
 * file supplies `baseUrl` and `paths`. Nothing here reads a disk: the file list, the texts and the tsconfigs are the
 * graph's.
 */

/** The extensions the reader parses: a file with another extension states no import this plugin reads. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The extensions a specifier without one may name, in the order TypeScript tries them. */
const EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** The TypeScript source a JavaScript extension written in the specifier may stand for. */
const SOURCE_OF: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx', '.d.ts'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/** The fields of a package.json that name the module a folder stands for, in the order Node and TypeScript read them. */
const MAIN_FIELDS: readonly string[] = ['main', 'module', 'types', 'typings'];

/** The tsconfig nearest a file, with its base and path aliases already resolved against the folder that declared them. */
export interface Tsconfig {
  /** The folder the config stands in, repository-relative and without a trailing slash; the repository root is ''. */
  readonly dir: string;
  /** The folder a bare specifier is looked up in, repository-relative; the config's own folder unless it says another. */
  readonly baseUrl: string;
  /** The `paths` aliases: the pattern as written, and the folder patterns its targets name. */
  readonly paths: Readonly<Record<string, readonly string[]>>;
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

/** A repository-relative path with `.` and `..` folded and no leading slash. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
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

/** The files one specifier base may name, in the order the resolution tries them. */
function candidatesOf(base: string): string[] {
  const extension = extensionOf(base);
  const source = SOURCE_OF[extension];
  const candidates: string[] = [];
  if (source !== undefined) for (const replacement of source) candidates.push(base.slice(0, -extension.length) + replacement);
  candidates.push(base);
  for (const tried of EXTENSIONS) candidates.push(base + tried);
  for (const tried of EXTENSIONS) candidates.push(`${base}/index${tried}`);
  return candidates;
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
 * The file a specifier base names: the base itself or a source beside it, a folder's `index`, or the module a folder's
 * `package.json` names — `require('..')` from a package's `bin` answers the package's own entry file.
 */
function resolveBase(base: string, known: ReadonlySet<string>, texts: ReadonlyMap<string, string>): string | undefined {
  const direct = foundIn(candidatesOf(base), known);
  if (direct !== undefined) return direct;
  const folder = normalizePath(base);
  const manifestPath = folder === '' ? 'package.json' : `${folder}/package.json`;
  if (!known.has(manifestPath)) return undefined;
  const text = texts.get(manifestPath);
  if (text === undefined) return undefined;
  let manifest: Record<string, unknown>;
  try {
    const body = JSON.parse(text) as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
    manifest = body as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const field of MAIN_FIELDS) {
    const entry = manifest[field];
    if (typeof entry !== 'string' || entry === '') continue;
    const answer = foundIn(candidatesOf(folder === '' ? entry : `${folder}/${entry}`), known);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

/** The options of one tsconfig's text, with its base and aliases resolved against the folder it stands in. */
function optionsOf(text: string, dir: string): { baseUrl: string; paths: Record<string, readonly string[]> } {
  const body = parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  const options = body.compilerOptions ?? {};
  const baseUrl = normalizePath(typeof options.baseUrl === 'string' ? `${dir}/${options.baseUrl}` : dir);
  const paths: Record<string, readonly string[]> = {};
  if (options.paths !== null && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      paths[pattern] = targets.filter((target): target is string => typeof target === 'string')
        .map((target) => normalizePath(`${baseUrl}/${target}`));
    }
  }
  return { baseUrl, paths };
}

/**
 * Every tsconfig the repository holds, by its path, with the options it inherits through `extends`: a base config's
 * base and aliases are already resolved against the folder that declared them, so an inheriting config keeps them.
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
      const own = optionsOf(text, dir);
      let base: Tsconfig | undefined;
      if (typeof body.extends === 'string' && (body.extends.startsWith('.') || !body.extends.includes('/') || body.extends.startsWith('/'))) {
        const extended = normalizePath(`${dir}/${body.extends}`);
        const candidate = texts.has(extended) ? extended : texts.has(`${extended}.json`) ? `${extended}.json` : undefined;
        if (candidate !== undefined) base = read(candidate);
      }
      const config: Tsconfig = {
        dir,
        baseUrl: base !== undefined && body.compilerOptions?.baseUrl === undefined ? base.baseUrl : own.baseUrl,
        paths: { ...(base?.paths ?? {}), ...own.paths },
      };
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
 * Where one specifier leads, read as the repository's own resolution reads it: a relative path against the importing
 * file's folder, then a tsconfig alias or base, then the package the specifier names. A relative specifier no file
 * answers states the path it names, so the caller can record the unresolved reference where the import stands.
 */
export function resolveSpecifier(fromPath: string, specifier: string, files: ReadonlySet<string>, texts: ReadonlyMap<string, string>, configs: ReadonlyMap<string, Tsconfig>): Resolution {
  if (isRelativeSpecifier(specifier)) {
    const base = specifier.startsWith('/')
      ? specifier.slice(1)
      : normalizePath(`${folderOf(fromPath)}/${specifier}`);
    const path = resolveBase(base, files, texts);
    return path === undefined ? { kind: 'none', path: normalizePath(base) } : { kind: 'file', path };
  }
  const config = tsconfigFor(fromPath, configs);
  if (config !== undefined) {
    // The aliases first, longest pattern first, as TypeScript tries them; then the base a bare name may stand on.
    const patterns = Object.keys(config.paths).sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
    for (const pattern of patterns) {
      const capture = captureOf(pattern, specifier);
      if (capture === undefined) continue;
      for (const target of config.paths[pattern] ?? []) {
        const path = resolveBase(target.replace('*', capture), files, texts);
        if (path !== undefined) return { kind: 'file', path };
      }
    }
    const based = resolveBase(config.baseUrl === '' ? specifier : `${config.baseUrl}/${specifier}`, files, texts);
    if (based !== undefined) return { kind: 'file', path: based };
  }
  return { kind: 'package', name: packageNameOf(specifier) };
}
