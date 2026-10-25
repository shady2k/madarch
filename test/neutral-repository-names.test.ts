import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { isScalar, parseDocument } from 'yaml';
import { validateLibraryRegistry } from '../src/extract/library-models/validate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['src', 'test', 'scripts', 'wiki/app/src', 'examples', 'docs/system'];
const ROOT_DOCUMENTS = ['AGENTS.md', 'docs/glossary.md'];
const HOME = String.fromCharCode(47) + 'home' + String.fromCharCode(47);
const USERS = String.fromCharCode(47) + 'Users' + String.fromCharCode(47);
const WINDOWS_USERS = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92);
// The boundary prevents matching a suffix of another address or typed graph key.
const SOURCE_PATTERN = /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?[:/][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const absolute = join(path, entry);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  }).sort(compareCodePoints);
}

const TRAINING_TEMPLATE = 'examples/training-repository/template';

// The module paths the training repository itself declares in its go.mod and go.sum files: a Go
// dependency is named by its module path, which looks like a repository source but is not one.
function declaredGoModules(root: string): string[] {
  const template = join(root, TRAINING_TEMPLATE);
  let files: string[];
  try {
    files = filesUnder(template).filter((file) => /(?:^|\/)go\.(?:mod|sum)$/.test(file));
  } catch {
    return [];
  }
  return modulesDeclaredBy(files);
}

function modulesDeclaredBy(files: readonly string[]): string[] {
  const modules = new Set<string>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const words = line.trim().split(/\s+/);
      const path = words[0] === 'module' || words[0] === 'require' ? words[1] : words[0];
      const isDeclaration = words[0] === 'module' || /^v\d/.test(words[words[0] === 'require' ? 2 : 1] ?? '');
      if (path !== undefined && isDeclaration && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/\S+$/.test(path)) modules.add(path);
    }
  }
  return [...modules];
}

function sourceIsAllowed(source: string, goModules: readonly string[] = []): boolean {
  if (/^(?:code\.[A-Za-z][A-Za-z0-9-]*|doc):/.test(source)) return true;
  const pattern = /^(?<host>(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::\d+)?[:/](?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)/;
  const normalized = source.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '').replace(/^[^@/]+@/, '');
  // A package tarball host of the public npm registry is not a repository source.
  if (normalized.startsWith('registry.npmjs.org/')) return true;
  // The source pattern stops at three path segments, so a declared module such as
  // example.org/x/y/v5 is matched through the segments it begins with.
  if (goModules.some((module) => normalized === module || normalized.startsWith(module + '/') || module.startsWith(normalized + '/'))) return true;
  if (normalized === 'www.rfc-editor.org/rfc/rfc9110' || normalized === 'github.com/settings/profile') return true;
  const parts = pattern.exec(normalized)?.groups;
  if (parts === undefined) return true;
  const host = parts.host;
  const owner = parts.owner;
  const rawRepo = parts.repo;
  if (host === undefined || owner === undefined || rawRepo === undefined) return false;
  const repo = rawRepo.replace(/\.git$/, '');
  const exampleHosts = new Set(['example.com', 'example.org', 'example.net']);
  const rfc2606Hosts = ['.test', '.example', '.invalid', '.localhost'];
  if (exampleHosts.has(host) || rfc2606Hosts.some((suffix) => host.endsWith(suffix))) return true;
  if (owner === 'acme') return true;
  if (host === 'json-schema.org' && owner === 'draft') return true;
  if (host === 'astral.sh' && owner === 'uv' && repo === 'install.sh') return true;
  if (host === 'viewscreen.githubusercontent.com' && owner === 'markdown' && repo === 'mermaid') return true;
  // Madarch's own Homebrew tap is a release channel, not an outside repository.
  return (host === 'github.com' || host === 'raw.githubusercontent.com') && owner === 'shady2k' && ['madarch', 'madarch-product', 'homebrew-tap'].includes(repo);
}

// A held Go fixture licenses its own declared imports, not repository URLs in other files or prose.
function isDeclaredFixtureImport(root: string, file: string, text: string, index: number, source: string): boolean {
  const fixtureRoot = join(root, 'test/fixtures');
  if (!file.startsWith(fixtureRoot + '/')) return false;
  let directory = dirname(file);
  let modules: string[] = [];
  while (directory.startsWith(fixtureRoot)) {
    const manifests = ['go.mod', 'go.sum'].map((name) => join(directory, name)).filter((path) => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
    if (manifests.length > 0) { modules = modulesDeclaredBy(manifests); break; }
    if (directory === fixtureRoot) break;
    directory = dirname(directory);
  }
  if (!modules.some((module) => source === module || source.startsWith(module + '/') || module.startsWith(source + '/'))) return false;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const line = text.slice(lineStart, text.indexOf('\n', index) === -1 ? text.length : text.indexOf('\n', index));
  if (/(?:^|\/)go\.(?:mod|sum)$/.test(file)) {
    return /^(?:\s*(?:module|require)\s+|\s*)[A-Za-z0-9.-]+\/\S+\s+(?:v\d|$)/.test(line);
  }
  if (!file.endsWith('.go')) return false;
  const goCode = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
  for (const declaration of goCode.matchAll(/\bimport\s+(?:\([^)]*\)|(?:[A-Za-z_.][A-Za-z0-9_.]*\s+)?"[^"\n]+")/g)) {
    const start = declaration.index!;
    if (index < start || index >= start + declaration[0].length) continue;
    for (const quoted of declaration[0].matchAll(/"([^"\n]+)"/g)) {
      const valueStart = start + quoted.index! + 1;
      if (index === valueStart && quoted[1]!.startsWith(source)) return true;
    }
  }
  return false;
}

/** Exact public documentation URL for this entry, never a file-wide package pool. */
function packageDocumentation(reference: string, ecosystem: string, packageName: string): boolean {
  let url: URL;
  try { url = new URL(reference); } catch { return false; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '') return false;
  // URL canonicalization removes explicit :443 and dot segments. Check the raw
  // authority and path too; those spellings must not turn into licensed evidence.
  const authorityStart = 'https://';
  if (!reference.startsWith(authorityStart)) return false;
  const afterScheme = reference.slice(authorityStart.length);
  const authorityEnd = afterScheme.indexOf('/');
  if (authorityEnd < 0 || afterScheme.slice(0, authorityEnd) !== url.hostname) return false;
  if ([...reference].some((character) => character === '\\' || character.codePointAt(0)! <= 32 || character.codePointAt(0) === 127)) return false;
  const hash = afterScheme.indexOf('#');
  const rawPath = hash < 0 ? afterScheme.slice(authorityEnd) : afterScheme.slice(authorityEnd, hash);
  if (rawPath !== url.pathname || rawPath.includes('%') || rawPath.split('/').some((part) => part === '.' || part === '..')) return false;
  if (hash >= 0) {
    const anchor = afterScheme.slice(hash + 1);
    if (anchor === '' || anchor.length > 256 || url.hash !== '#' + anchor || anchor.includes('#') || anchor.includes('?') || anchor.includes('/') || anchor.includes(':') || anchor.includes('%')) return false;
  }
  return ecosystem === 'go' && url.hostname === 'pkg.go.dev' && rawPath === `/${packageName}` ||
    ecosystem === 'node' && url.hostname === 'www.npmjs.com' && rawPath === `/package/${packageName}`;
}

interface ProvenanceRange { readonly start: number; readonly end: number }
function provenanceRanges(root: string, file: string, text: string, errors: string[]): readonly ProvenanceRange[] {
  const path = relative(root, file).split('/');
  if (path.length < 4 || path[0] !== 'src' || path[1] !== 'extract' || path[2] !== 'library-models' || !file.endsWith('.json')) return [];
  const located = (offset: number, reason: string): void => {
    const line = text.slice(0, offset).split('\n').length;
    errors.push(`${relative(root, file)}:${line} (${file}): library provenance is not licensed: ${reason}`);
  };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { located(0, `invalid JSON: ${String(error)}`); return []; }
  const document = parseDocument(text, { schema: 'json', uniqueKeys: true, strict: true, keepSourceTokens: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) located(error.pos[0], error.message);
    return [];
  }
  try { validateLibraryRegistry(parsed); } catch (error) { located(0, `invalid model registry: ${String(error)}`); return []; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const registry = parsed as Record<string, unknown>;
  const ranges: ProvenanceRange[] = [];
  for (const section of ['models', 'types']) {
    const entries = registry[section]; if (entries === undefined) continue;
    if (!Array.isArray(entries)) return [];
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const fields = entry as Record<string, unknown>;
      const reference = document.getIn([section, index, 'reference'], true);
      if (!isScalar(reference) || reference.range === undefined || reference.range === null || reference.type !== 'QUOTE_DOUBLE' ||
        typeof reference.value !== 'string' || reference.value !== fields.reference) {
        located(0, `${section}[${index}].reference has no exact JSON scalar location`); return [];
      }
      const [start, end] = reference.range;
      let raw: unknown;
      try { raw = JSON.parse(text.slice(start, end)); } catch { located(start, 'reference scalar bytes are not JSON'); return []; }
      if (raw !== reference.value || typeof fields.ecosystem !== 'string' || typeof fields.package !== 'string') {
        located(start, 'reference scalar disagrees with its entry'); return [];
      }
      if (packageDocumentation(reference.value, fields.ecosystem, fields.package)) ranges.push({ start, end });
    }
  }
  return ranges;
}

function findings(root = ROOT): string[] {
  const errors: string[] = [];
  const goModules = declaredGoModules(root);
  const files = SCAN_ROOTS.flatMap((path) => filesUnder(join(root, path)))
    .concat(ROOT_DOCUMENTS.map((file) => join(root, file)))
    .sort(compareCodePoints);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const provenance = provenanceRanges(root, file, text, errors);
    for (const match of text.matchAll(SOURCE_PATTERN)) {
      const source = match[0];
      // A bare typed key is not an address. URL/SSH typed hosts are never licensed by another allowance.
      const prefix = text.slice(Math.max(0, match.index - 128), match.index);
      const typedKey = /^(?:code\.[A-Za-z][A-Za-z0-9-]*|doc):/.test(source);
      const urlOrSsh = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^\s'"`]+@)$/.test(prefix);
      if (typedKey && !urlOrSsh) continue;
      if (!(typedKey && urlOrSsh) && provenance.some((range) => range.start <= match.index && match.index + source.length <= range.end)) continue;
      if (!(typedKey && urlOrSsh) && (sourceIsAllowed(source, goModules) || isDeclaredFixtureImport(root, file, text, match.index, source))) continue;
      const line = text.slice(0, match.index).split('\n').length;
      errors.push(`${relative(root, file)}:${line} (${file}): repository source is not an example or madarch repository: ${source}`);
    }
    for (const forbidden of [HOME, USERS, WINDOWS_USERS]) {
      let index = text.indexOf(forbidden);
      while (index !== -1) {
        const line = text.slice(0, index).split('\n').length;
        errors.push(`${relative(root, file)}:${line} (${file}): absolute home path found`);
        index = text.indexOf(forbidden, index + forbidden.length);
      }
    }
  }
  return errors;
}

describe('neutral repository names', () => {
  test('the allow-list rejects an unrelated owner without naming a real repository', () => {
    const candidate = ['github.com', ['not', 'acme'].join('-'), 'install.sh'].join('/');
    expect(sourceIsAllowed(candidate)).toBe(false);
  });

  test('the scan catches a disallowed source in the current server capability', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-repository-names-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) {
        const document = join(fixtureRoot, path);
        mkdirSync(dirname(document), { recursive: true });
        writeFileSync(document, '');
      }
      const spec = join(fixtureRoot, 'docs/system/capabilities/server.md');
      mkdirSync(dirname(spec), { recursive: true });
      const source = ['github.com', ['not', 'acme'].join('-'), 'catalog'].join('/');
      writeFileSync(spec, `Source: ${source}\n`);
      expect(findings(fixtureRoot).some((error) =>
        error.includes('docs/system/capabilities/server.md:1') && error.includes(source),
      )).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('typed graph keys are not repository addresses, but real addresses on the same lines are checked', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-repository-names-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) {
        const document = join(fixtureRoot, path);
        mkdirSync(dirname(document), { recursive: true });
        writeFileSync(document, '');
      }
      const file = join(fixtureRoot, 'test/graph-identities.ts');
      const external = ['github.com', ['not', 'acme'].join('-'), 'catalog'].join('/');
      const domain = ['code.symbol', 'not-acme', 'catalog'].join('/');
      const sshAddress = ['github.com', 'not-acme/catalog.git'].join(':');
      const ssh = 'git@' + sshAddress;
      const colonDomain = ['code.symbol', 'not-acme/catalog'].join(':');
      writeFileSync(file, [
        "'code.symbol:services/api/main.ts#run'", "'code.file:scripts/seed.sql'",
        "'code.package:import/go'", "'code.dependency:nested/package.json'",
        `Source: https://${external}`, `Source: https://${domain}`, `Source: ${ssh}`,
        `Source: https://${colonDomain}`, `Source: git@${colonDomain}`,
      ].join('\n'));
      expect(findings(fixtureRoot)).toEqual([
        `test/graph-identities.ts:5 (${file}): repository source is not an example or madarch repository: ${external}`,
        `test/graph-identities.ts:6 (${file}): repository source is not an example or madarch repository: ${domain}`,
        `test/graph-identities.ts:7 (${file}): repository source is not an example or madarch repository: ${sshAddress}`,
        `test/graph-identities.ts:8 (${file}): repository source is not an example or madarch repository: ${colonDomain}`,
        `test/graph-identities.ts:9 (${file}): repository source is not an example or madarch repository: ${colonDomain}`,
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('a Go module path is allowed only when the training template declares it', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-repository-names-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) {
        const document = join(fixtureRoot, path);
        mkdirSync(dirname(document), { recursive: true });
        writeFileSync(document, '');
      }
      const template = join(fixtureRoot, TRAINING_TEMPLATE, 'services/orders');
      mkdirSync(template, { recursive: true });
      const declared = ['github.com', ['not', 'acme'].join('-'), 'declared'].join('/');
      const undeclared = ['github.com', ['not', 'acme'].join('-'), 'undeclared'].join('/');
      writeFileSync(join(template, 'go.mod'), `module example.test/orders\n\nrequire ${declared} v1.2.3\n`);
      writeFileSync(join(template, 'go.sum'), `${declared} v1.2.3 h1:abc=\n`);
      writeFileSync(join(template, 'main.go'), `import (\n\t"${declared}"\n\t"${undeclared}"\n)\n`);
      writeFileSync(join(template, 'package-lock.json'), '{"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"}\n');
      const errors = findings(fixtureRoot);
      expect(errors.some((error) => error.includes(undeclared))).toBe(true);
      expect(errors.some((error) => error.includes(declared + '"') || error.endsWith(declared))).toBe(false);
      expect(errors.some((error) => error.includes('registry.npmjs.org'))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('a held Go fixture declaration licenses only its own actual imports', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-repository-names-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) {
        const document = join(fixtureRoot, path);
        mkdirSync(dirname(document), { recursive: true }); writeFileSync(document, '');
      }
      const held = join(fixtureRoot, 'test/fixtures/held-go'); mkdirSync(held, {recursive: true});
      const source = ['github.com', ['not', 'acme'].join('-'), 'declared'].join('/');
      const lookalike = source + '-lookalike';
      writeFileSync(join(held, 'go.mod'), `module example.test/held\nrequire ${source} v1.2.3\n`);
      const go = join(held, 'main.go');
      writeFileSync(go, `package held\nimport alias "${source}/sub"\nimport "${lookalike}"\n// Source: https://${source}\n`);
      const sibling = join(fixtureRoot, 'test/fixtures/sibling/main.go');
      mkdirSync(dirname(sibling), {recursive: true}); writeFileSync(sibling, `package sibling\nimport "${source}"\n`);
      const errors = findings(fixtureRoot);
      expect(errors).toEqual([
        `test/fixtures/held-go/main.go:3 (${go}): repository source is not an example or madarch repository: ${lookalike}`,
        `test/fixtures/held-go/main.go:4 (${go}): repository source is not an example or madarch repository: ${source}`,
        `test/fixtures/sibling/main.go:2 (${sibling}): repository source is not an example or madarch repository: ${source}`,
      ]);
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });

  test('bare graph keys are not repositories, but adjacent sources and URL or SSH hosts still are', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-graph-keys-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const real = ['github.com', 'someone', 'somerepo'].join('/');
      const typed = ['code.table', 'shop/public.orders'].join(':');
      const document = ['doc', 'shop/docs/order.md'].join(':');
      const url = ['https://', typed].join('');
      const ssh = ['git@', typed].join('');
      const file = join(fixtureRoot, 'src', 'example.ts');
      writeFileSync(file, `${typed} ${document} ${real}\n${url}\n${ssh}\n`);
      expect(findings(fixtureRoot)).toEqual([
        `src/example.ts:1 (${file}): repository source is not an example or madarch repository: ${real}`,
        `src/example.ts:2 (${file}): repository source is not an example or madarch repository: ${typed}`,
        `src/example.ts:3 (${file}): repository source is not an example or madarch repository: ${typed}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('library provenance licenses only the exact structured reference under its declared folder', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-provenance-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const packageName = ['example.org', 'unit'].join('/');
      const reference = ['https:/', 'pkg.go.dev', packageName].join('/');
      const model = { id: 'unit.model', ecosystem: 'go', package: packageName,
        target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Make']] },
        invoke: 'call', returnRole: 'logger', arguments: [], reference,
        checks: { positive: 'model.positive', negative: 'model.negative' } };
      const type = { id: 'unit.type', ecosystem: 'go', package: packageName, exportedPath: ['Options'], shape: 'struct',
        reference: reference + '#Options', checks: { positive: 'type.positive', negative: 'type.negative' } };
      const registry = { schemaVersion: 1, models: [model], types: [type] };
      const allowed = join(fixtureRoot, 'src/extract/library-models/nested/models.json');
      mkdirSync(dirname(allowed), { recursive: true }); writeFileSync(allowed, JSON.stringify(registry, null, 2));
      expect(findings(fixtureRoot)).toEqual([]);
      const source = reference.slice('https://'.length);
      const elsewhere = join(fixtureRoot, 'docs/system/elsewhere.md');
      const sibling = join(fixtureRoot, 'src/extract/library-models-other/models.json');
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(elsewhere, reference + '\n'); writeFileSync(sibling, JSON.stringify(registry));
      expect(findings(fixtureRoot)).toEqual([
        `docs/system/elsewhere.md:1 (${elsewhere}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models-other/models.json:1 (${sibling}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models-other/models.json:1 (${sibling}): repository source is not an example or madarch repository: ${source}`,
      ]);
      rmSync(elsewhere); rmSync(sibling);
      // Another valid entry with the same host/package cannot license this entry.
      writeFileSync(allowed, JSON.stringify({ ...registry, models: [
        { ...model, id: 'wrong', package: packageName + '-other', checks: { positive: 'wrong.positive', negative: 'wrong.negative' } }, model,
      ] }));
      expect(findings(fixtureRoot)).toEqual([
        `src/extract/library-models/nested/models.json:1 (${allowed}): repository source is not an example or madarch repository: ${source}`,
      ]);
      // Bare package fields remain errors even when their reference is legitimate.
      const outsidePackage = ['github.com', 'not-acme', 'unit'].join('/');
      writeFileSync(allowed, JSON.stringify({ schemaVersion: 1, models: [{ ...model, package: outsidePackage,
        reference: ['https:/', 'pkg.go.dev', outsidePackage].join('/') }] }));
      expect(findings(fixtureRoot)).toEqual([
        `src/extract/library-models/nested/models.json:1 (${allowed}): repository source is not an example or madarch repository: ${outsidePackage}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('package documentation uses the whole exact URL and the current ecosystem only', () => {
    const goHost = ['pkg', 'go', 'dev'].join('.');
    const nodeHost = ['www', 'npmjs', 'com'].join('.');
    const goPackage = ['example.org', 'unit', 'sub'].join('/');
    const nodePackage = '@scope/unit';
    const go = `https://${goHost}/${goPackage}`;
    const node = `https://${nodeHost}/package/${nodePackage}`;
    expect(packageDocumentation(go, 'go', goPackage)).toBe(true);
    expect(packageDocumentation(go + '#Options', 'go', goPackage)).toBe(true);
    expect(packageDocumentation(node, 'node', nodePackage)).toBe(true);
    expect(packageDocumentation(`https://${nodeHost}/package/node:process`, 'node', 'node:process')).toBe(true);
    const invalid = [
      go.replace('https:', 'http:'), go.replace(goHost, goHost + '.invalid'),
      go.replace(goHost, `user@${goHost}`), go.replace(goHost, `user:secret@${goHost}`),
      go.replace(goHost, goHost + ':443'), go.replace(goHost, goHost + ':8443'),
      go + '-lookalike', go + '/child', go + '?source=other', go + '#', go + '#https://other.invalid/x',
      go.replace('/unit/', '/x/../unit/'), go.replace('/unit/', '/%75nit/'),
      go.replace(goHost, goHost.toUpperCase()), go.replace(goHost + '/', goHost + '\\'),
      go + '#two#anchors', go + '#' + 'x'.repeat(257),
    ];
    for (const reference of invalid) expect(packageDocumentation(reference, 'go', goPackage)).toBe(false);
    expect(packageDocumentation(go, 'go', goPackage + '-other')).toBe(false);
    expect(packageDocumentation(go, 'go', goPackage.slice(0, goPackage.lastIndexOf('/')))).toBe(false);
    expect(packageDocumentation(go, 'node', goPackage)).toBe(false);
    expect(packageDocumentation(node, 'node', '@scope/unit-other')).toBe(false);
    expect(packageDocumentation(node, 'go', nodePackage)).toBe(false);
    expect(packageDocumentation(['https:/', 'pypi.org', 'project', 'unit'].join('/'), 'python', 'unit')).toBe(false);
    expect(packageDocumentation(['https:/', 'crates.io', 'crates', 'unit'].join('/'), 'rust', 'unit')).toBe(false);
  });

  test('invalid registry structure and duplicate keys retain located errors and every unlicensed occurrence', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-invalid-provenance-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const reference = ['https:/', 'www.npmjs.com', 'package', 'unit'].join('/');
      const source = reference.slice('https://'.length);
      const model = { id: 'unit', ecosystem: 'node', package: 'unit',
        target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Make']] },
        invoke: 'call', returnRole: 'logger', arguments: [], reference,
        checks: { positive: 'unit.positive', negative: 'unit.negative' } };
      const file = join(fixtureRoot, 'src/extract/library-models/models.json');
      mkdirSync(dirname(file), { recursive: true });
      const registry = { schemaVersion: 1, models: [model] };
      writeFileSync(file, JSON.stringify(registry)); expect(findings(fixtureRoot)).toEqual([]);
      const documents = [
        JSON.stringify({ ...registry, unrelated: reference }),
        JSON.stringify({ schemaVersion: 1, models: [{ ...model, description: reference }] }),
        JSON.stringify({ schemaVersion: 1, models: [model, model] }),
        JSON.stringify({ schemaVersion: 1, models: [model, { ...model, id: 'other',
          target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Other']] } }] }),
        `{"schemaVersion":1,"models":[${JSON.stringify(model)}],"models":[${JSON.stringify(model)}]}`,
        `{"schemaVersion":1,"models":[${JSON.stringify(model)}],` ,
        JSON.stringify({ note: reference }),
      ];
      for (const document of documents) {
        writeFileSync(file, document);
        const errors = findings(fixtureRoot);
        expect(errors.some((error) => error.startsWith(`src/extract/library-models/models.json:1 (${file}): library provenance is not licensed:`))).toBe(true);
        const expectedOccurrences = document.split(reference).length - 1;
        expect(errors.filter((error) => error === `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: ${source}`)).toHaveLength(expectedOccurrences);
      }
      writeFileSync(file, JSON.stringify(registry));
      const ts = join(fixtureRoot, 'src/extract/library-models/note.ts');
      writeFileSync(ts, reference + '\n' + reference + '\n');
      expect(findings(fixtureRoot)).toEqual([
        `src/extract/library-models/note.ts:1 (${ts}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models/note.ts:2 (${ts}): repository source is not an example or madarch repository: ${source}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('only example and madarch repositories appear in product code and current documents', () => {
    expect(findings()).toEqual([]);
  });
});
