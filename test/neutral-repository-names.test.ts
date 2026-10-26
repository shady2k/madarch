import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { isScalar, parseDocument } from 'yaml';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { readSyntaxTree, syntaxLanguageOf } from '../src/fill/stages/syntax-extract.js';
import { decodeStringToken } from '../src/extract/code/literals.js';
import { validateLibraryRegistry } from '../src/extract/library-models/validate.js';
import { validateHttpModels } from '../src/extract/library-models/http-models.js';
import { validateMetricSemanticModels } from '../src/extract/library-models/metric-semantic-models.js';
import { validateMessagingModels } from '../src/extract/library-models/messaging-models.js';
import { validateShellCommandModels } from '../src/extract/library-models/shell-command-models.js';
import { validateEnvironmentModels } from '../src/extract/library-models/environment-models.js';
import { validateOutboxModels } from '../src/extract/library-models/outbox-models.js';
import { validateGrpcDeadlineModel } from '../src/extract/library-models/grpc-deadline-models.js';

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

interface SourceRange { readonly start: number; readonly end: number }
interface ImportRange extends SourceRange { readonly specifier: string }
interface LiteralRange extends SourceRange { readonly kind: string; readonly raw: string; readonly value: string }

/** Only the validated central registry declares packages for test imports. */
function modeledPackages(root: string): ReadonlySet<string> {
  const file = join(root, 'src/extract/library-models/models.json');
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return new Set(); }
  const document = parseDocument(text, { schema: 'json', uniqueKeys: true, strict: true });
  if (document.errors.length > 0) return new Set();
  try {
    const registry = validateLibraryRegistry(JSON.parse(text));
    return new Set([...registry.models, ...(registry.types ?? [])].map((entry) => entry.package));
  } catch { return new Set(); } // The model-file scan reports its located validation errors.
}

function fixtureModules(root: string, file: string): readonly string[] {
  const fixtureRoot = join(root, 'test/fixtures');
  if (!file.startsWith(fixtureRoot + '/')) return [];
  let directory = dirname(file);
  while (directory === fixtureRoot || directory.startsWith(fixtureRoot + '/')) {
    const manifests = ['go.mod', 'go.sum'].map((name) => join(directory, name)).filter((path) => {
      try { return statSync(path).isFile(); } catch { return false; }
    });
    if (manifests.length > 0) return modulesDeclaredBy(manifests);
    if (directory === fixtureRoot) break;
    directory = dirname(directory);
  }
  return [];
}

/** Keep the held fixture's existing manifest allowance separate from source syntax. */
function isDeclaredFixtureManifest(root: string, file: string, text: string, index: number, source: string): boolean {
  if (!(file.endsWith('/go.mod') || file.endsWith('/go.sum'))) return false;
  const modules = fixtureModules(root, file);
  if (!modules.some((module) => source === module || source.startsWith(module + '/') || module.startsWith(source + '/'))) return false;
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return /^(?:\s*(?:module|require)\s+|\s*)[A-Za-z0-9.-]+\/\S+\s+(?:v\d|$)/.test(line);
}

/** Copy spans while the native tree is alive. Strings and comments never stand in for imports. */
async function importSyntax(path: string, text: string): Promise<{ imports: readonly ImportRange[]; literals: readonly LiteralRange[] }> {
  const read = await readSyntaxTree(path, new TextEncoder().encode(text), (parsed) => {
    const imports: ImportRange[] = [];
    const literals: LiteralRange[] = [];
    if (!parsed.complete || (parsed.language === 'go'
      ? parsed.root.type !== 'source_file' || !parsed.root.namedChildren.some((child) => child?.type === 'package_clause')
      : parsed.root.type !== 'program')) return { imports, literals };
    const addImport = (node: SyntaxNode | null): void => {
      if (node === null) return;
      const specifier = decodeStringToken(node.type, node.text);
      if (specifier !== undefined) imports.push({ start: node.startIndex, end: node.endIndex, specifier });
    };
    const visitImport = (node: SyntaxNode): void => {
      if (node.type === 'import_spec') { addImport(node.childForFieldName('path')); return; }
      for (const child of node.namedChildren) if (child !== null) visitImport(child);
    };
    for (const top of parsed.root.namedChildren) {
      if (top?.type === 'import_declaration' && parsed.language === 'go') visitImport(top);
      if (top?.type === 'import_statement' && parsed.language !== 'go') addImport(top.childForFieldName('source'));
    }
    if (parsed.language !== 'go') {
      const visit = (node: SyntaxNode): void => {
        if (node.type === 'string' || node.type === 'template_string') {
          const value = decodeStringToken(node.type, node.text);
          if (value !== undefined) literals.push({ start: node.startIndex, end: node.endIndex, kind: node.type, raw: node.text, value });
          return;
        }
        for (const child of node.namedChildren) if (child !== null) visit(child);
      };
      visit(parsed.root);
    }
    return { imports, literals };
  });
  if (!read.read) throw new Error(`${path}: syntax parser could not read source: ${JSON.stringify(read.unread)}`);
  return read.value;
}

/** Map decoded snippet offsets back to the host token, including escaped newlines and quotes. */
function literalBoundaries(literal: LiteralRange): readonly number[] | undefined {
  const { raw, kind } = literal;
  const quote = raw[0]!;
  const boundaries: number[] = [literal.start + 1];
  let decoded = '';
  for (let at = 1; at < raw.length - 1;) {
    const start = at++;
    if (raw[start] === '\\') {
      const escape = raw[at++];
      if (escape === 'x') at += 2;
      else if (escape === 'u') {
        if (raw[at] === '{') { const close = raw.indexOf('}', at + 1); if (close < 0) return undefined; at = close + 1; }
        else at += 4;
      } else if (escape === '\r' && raw[at] === '\n') at++;
    }
    const part = decodeStringToken(kind, quote + raw.slice(start, at) + quote);
    if (part === undefined) return undefined;
    decoded += part;
    if (part.length === 0) boundaries[boundaries.length - 1] = literal.start + at;
    else for (let index = 0; index < part.length; index++) boundaries.push(literal.start + at);
  }
  return decoded === literal.value ? boundaries : undefined;
}

/** Test/fixture imports are licensed by exact package identity, not by a source-text resemblance. */
async function testImportRanges(root: string, file: string, text: string, packages: ReadonlySet<string>): Promise<readonly SourceRange[]> {
  const path = relative(root, file);
  if (!path.startsWith('test/') || syntaxLanguageOf(path) === undefined) return [];
  const syntax = await importSyntax(path, text);
  const modules = fixtureModules(root, file);
  const allowed = (specifier: string): boolean => packages.has(specifier) ||
    modules.some((module) => specifier === module || specifier.startsWith(module + '/'));
  const ranges: SourceRange[] = syntax.imports.filter((entry) => allowed(entry.specifier));
  for (const literal of syntax.literals) {
    // Decode only actual host-language string nodes; then ask each grammar, not a regex,
    // whether the value is a complete source file with actual top-level imports.
    if (!literal.value.includes('/') || !literal.value.includes('import')) continue;
    const boundaries = literalBoundaries(literal);
    if (boundaries === undefined) continue;
    for (const extension of ['go', 'ts']) {
      const snippet = await importSyntax(`inline.${extension}`, literal.value);
      for (const entry of snippet.imports) {
        if (!packages.has(entry.specifier)) continue;
        const start = boundaries[entry.start]; const end = boundaries[entry.end];
        if (start !== undefined && end !== undefined) ranges.push({ start, end });
      }
    }
  }
  return ranges;
}

/** Canonical HTTPS documentation syntax, not an allowance for a host or a file. */
function documentationUrl(reference: string): URL | undefined {
  let url: URL;
  try { url = new URL(reference); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '') return undefined;
  // URL canonicalization removes explicit :443 and dot segments. Check the raw
  // authority and path too; those spellings must not turn into licensed evidence.
  const authorityStart = 'https://';
  if (!reference.startsWith(authorityStart)) return undefined;
  const afterScheme = reference.slice(authorityStart.length);
  const authorityEnd = afterScheme.indexOf('/');
  if (authorityEnd < 0 || afterScheme.slice(0, authorityEnd) !== url.hostname) return undefined;
  if ([...reference].some((character) => character === '\\' || character.codePointAt(0)! <= 32 || character.codePointAt(0) === 127)) return undefined;
  const hash = afterScheme.indexOf('#');
  const rawPath = hash < 0 ? afterScheme.slice(authorityEnd) : afterScheme.slice(authorityEnd, hash);
  if (rawPath !== url.pathname || rawPath.includes('%') || rawPath.split('/').some((part) => part === '.' || part === '..')) return undefined;
  if (hash >= 0) {
    const anchor = afterScheme.slice(hash + 1);
    if (anchor === '' || anchor.length > 256 || url.hash !== '#' + anchor || anchor.includes('#') || anchor.includes('?') || anchor.includes('/') || anchor.includes(':') || anchor.includes('%')) return undefined;
  }
  return url;
}

/** Registry documentation still has to name this entry's exact package. */
function packageDocumentation(reference: string, ecosystem: string, packageName: string): boolean {
  const url = documentationUrl(reference);
  return url !== undefined && (ecosystem === 'go' && url.hostname === 'pkg.go.dev' && url.pathname === `/${packageName}` ||
    ecosystem === 'node' && url.hostname === 'www.npmjs.com' && url.pathname === `/package/${packageName}`);
}

/** Only a validated entry's provenance scalar can cite its own documentation. */
function provenanceDocumentation(reference: string, ecosystem?: string, packageName?: string): boolean {
  const url = documentationUrl(reference);
  if (url === undefined) return false;
  // A registry URL must not borrow a different entry's package identity.
  if (url.hostname === 'pkg.go.dev' || url.hostname === 'www.npmjs.com') {
    return ecosystem !== undefined && packageName !== undefined && packageDocumentation(reference, ecosystem, packageName);
  }
  return true;
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
  const validators = [validateLibraryRegistry, validateHttpModels, validateMetricSemanticModels, validateMessagingModels, validateShellCommandModels, validateEnvironmentModels, validateOutboxModels, validateGrpcDeadlineModel];
  const validationErrors: string[] = [];
  let validated = false;
  for (const validate of validators) {
    try { validate(parsed); validated = true; break; } catch (error) { validationErrors.push(String(error)); }
  }
  if (!validated) { located(0, `invalid model registry: ${validationErrors.join('; ')}`); return []; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const registry = parsed as Record<string, unknown>;
  const ranges: ProvenanceRange[] = [];
  if ('deadlineProperty' in registry && 'optionsArgument' in registry) {
    const model = validateGrpcDeadlineModel(registry);
    for (const [key, expected] of [['package', model.package], ['reference', model.reference]] as const) {
      const scalar = document.getIn([key], true);
      if (!isScalar(scalar) || scalar.type !== 'QUOTE_DOUBLE' || scalar.range == null || scalar.value !== expected) {
        located(0, `${key}: no exact JSON scalar location`); return [];
      }
      const [start, end] = scalar.range;
      try { if (JSON.parse(text.slice(start, end)) !== expected) { located(start, 'scalar bytes disagree'); return []; } }
      catch { located(start, 'scalar bytes are not JSON'); return []; }
      if (key === 'package' || provenanceDocumentation(expected, 'node', model.package)) ranges.push({start, end});
    }
    return ranges;
  }
  if ('receivers' in registry && 'outbox' in registry) {
    // Receiver-linked operation evidence names that exact modeled package.
    // It does not license another scalar, host, or documentation path.
    const model = validateOutboxModels(registry);
    const license = (path: readonly (string | number)[], expected: string): void => {
      const scalar = document.getIn(path, true);
      if (!isScalar(scalar) || scalar.type !== 'QUOTE_DOUBLE' || scalar.range == null || scalar.value !== expected) {
        located(0, `${path.join('.')}: no exact JSON scalar location`); return;
      }
      const [start, end] = scalar.range;
      try {
        if (JSON.parse(text.slice(start, end)) !== expected) { located(start, 'scalar bytes disagree'); return; }
      } catch { located(start, 'scalar bytes are not JSON'); return; }
      ranges.push({start, end});
    };
    for (const [index, receiver] of model.receivers.entries()) {
      license(['receivers', index, 'package'], receiver.package);
      if (provenanceDocumentation(receiver.reference, receiver.ecosystem, receiver.package)) license(['receivers', index, 'reference'], receiver.reference);
    }
    for (const section of ['operations', 'factories'] as const) {
      for (const [index, operation] of model[section].entries()) {
        const receivers = operation.receiverIds.map(id => model.receivers.find(receiver => receiver.id === id));
        const first = receivers[0];
        if (first !== undefined && receivers.every(receiver => receiver?.ecosystem === first.ecosystem && receiver.package === first.package)
          && provenanceDocumentation(operation.reference, first.ecosystem, first.package)) license([section, index, 'reference'], operation.reference);
      }
    }
    return ranges;
  }
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
      if (raw !== reference.value) {
        located(start, 'reference scalar disagrees with its entry'); return [];
      }
      // The validated schema marks this scalar as provenance, including entries
      // (such as environment semantics) that do not model a package identifier.
      if (provenanceDocumentation(reference.value,
        typeof fields.ecosystem === 'string' ? fields.ecosystem : undefined,
        typeof fields.package === 'string' ? fields.package : undefined)) ranges.push({start, end});
      if (typeof fields.ecosystem !== 'string' || typeof fields.package !== 'string') continue;
      const packageScalar = document.getIn([section, index, 'package'], true);
      if (!isScalar(packageScalar) || packageScalar.type !== 'QUOTE_DOUBLE' || packageScalar.range == null || packageScalar.value !== fields.package) {
        located(start, `${section}[${index}].package has no exact JSON scalar location`); return [];
      }
      const [packageStart, packageEnd] = packageScalar.range;
      let rawPackage: unknown;
      try { rawPackage = JSON.parse(text.slice(packageStart, packageEnd)); } catch { located(packageStart, 'package scalar bytes are not JSON'); return []; }
      if (rawPackage !== fields.package) { located(packageStart, 'package scalar disagrees with its entry'); return []; }
      ranges.push({ start: packageStart, end: packageEnd });
    }
  }
  return ranges;
}

async function findings(root = ROOT): Promise<string[]> {
  const errors: string[] = [];
  const goModules = declaredGoModules(root);
  const packages = modeledPackages(root);
  const files = SCAN_ROOTS.flatMap((path) => filesUnder(join(root, path)))
    .concat(ROOT_DOCUMENTS.map((file) => join(root, file)))
    .sort(compareCodePoints);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const provenance = provenanceRanges(root, file, text, errors);
    const sources = [...text.matchAll(SOURCE_PATTERN)];
    const imports = sources.length === 0 ? [] : await testImportRanges(root, file, text, packages);
    for (const match of sources) {
      const source = match[0];
      // A bare typed key is not an address. URL/SSH typed hosts are never licensed by another allowance.
      const prefix = text.slice(Math.max(0, match.index - 128), match.index);
      const typedKey = /^(?:code\.[A-Za-z][A-Za-z0-9-]*|doc):/.test(source);
      const urlOrSsh = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^\s'"`]+@)$/.test(prefix);
      if (typedKey && !urlOrSsh) continue;
      if (!(typedKey && urlOrSsh) && provenance.some((range) => range.start <= match.index && match.index + source.length <= range.end)) continue;
      if (!(typedKey && urlOrSsh) && (sourceIsAllowed(source, goModules) || isDeclaredFixtureManifest(root, file, text, match.index, source) ||
        imports.some((range) => range.start <= match.index && match.index + source.length <= range.end))) continue;
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
  test('the allow-list rejects an unrelated owner without naming a real repository', async () => {
    const candidate = ['github.com', ['not', 'acme'].join('-'), 'install.sh'].join('/');
    expect(sourceIsAllowed(candidate)).toBe(false);
  });

  test('the scan catches a disallowed source in the current server capability', async () => {
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
      expect((await findings(fixtureRoot)).some((error) =>
        error.includes('docs/system/capabilities/server.md:1') && error.includes(source),
      )).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('typed graph keys are not repository addresses, but real addresses on the same lines are checked', async () => {
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
      expect(await findings(fixtureRoot)).toEqual([
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

  test('a Go module path is allowed only when the training template declares it', async () => {
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
      const errors = await findings(fixtureRoot);
      expect(errors.some((error) => error.includes(undeclared))).toBe(true);
      expect(errors.some((error) => error.includes(declared + '"') || error.endsWith(declared))).toBe(false);
      expect(errors.some((error) => error.includes('registry.npmjs.org'))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('a held Go fixture declaration licenses only its own actual imports', async () => {
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
      const errors = await findings(fixtureRoot);
      expect(errors).toEqual([
        `test/fixtures/held-go/main.go:3 (${go}): repository source is not an example or madarch repository: ${lookalike}`,
        `test/fixtures/held-go/main.go:4 (${go}): repository source is not an example or madarch repository: ${source}`,
        `test/fixtures/sibling/main.go:2 (${sibling}): repository source is not an example or madarch repository: ${source}`,
      ]);
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });

  test('bare graph keys are not repositories, but adjacent sources and URL or SSH hosts still are', async () => {
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
      expect(await findings(fixtureRoot)).toEqual([
        `src/example.ts:1 (${file}): repository source is not an example or madarch repository: ${real}`,
        `src/example.ts:2 (${file}): repository source is not an example or madarch repository: ${typed}`,
        `src/example.ts:3 (${file}): repository source is not an example or madarch repository: ${typed}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('library provenance licenses only the exact structured reference under its declared folder', async () => {
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
      expect(await findings(fixtureRoot)).toEqual([]);
      const source = reference.slice('https://'.length);
      const elsewhere = join(fixtureRoot, 'docs/system/elsewhere.md');
      const sibling = join(fixtureRoot, 'src/extract/library-models-other/models.json');
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(elsewhere, reference + '\n'); writeFileSync(sibling, JSON.stringify(registry));
      expect(await findings(fixtureRoot)).toEqual([
        `docs/system/elsewhere.md:1 (${elsewhere}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models-other/models.json:1 (${sibling}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models-other/models.json:1 (${sibling}): repository source is not an example or madarch repository: ${source}`,
      ]);
      rmSync(elsewhere); rmSync(sibling);
      // Another valid entry with the same host/package cannot license this entry.
      writeFileSync(allowed, JSON.stringify({ ...registry, models: [
        { ...model, id: 'wrong', package: packageName + '-other', checks: { positive: 'wrong.positive', negative: 'wrong.negative' } }, model,
      ] }));
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models/nested/models.json:1 (${allowed}): repository source is not an example or madarch repository: ${source}`,
      ]);
      // The validated entry licenses its exact package scalar, not other fields.
      const outsidePackage = ['github.com', 'not-acme', 'unit'].join('/');
      writeFileSync(allowed, JSON.stringify({ schemaVersion: 1, models: [{ ...model, package: outsidePackage,
        reference: ['https:/', 'pkg.go.dev', outsidePackage].join('/') }] }));
      expect(await findings(fixtureRoot)).toEqual([]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('documentation URLs license only parsed provenance fields of validated model entries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-documentation-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), {recursive: true});
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, ''); }
      for (const name of ['environment-models.json', 'shell-command-models.json']) {
        const original = readFileSync(join(ROOT, 'src/extract/library-models', name), 'utf8');
        const registry = JSON.parse(original) as {schemaVersion: number; models: Array<{id: string; reference: string}>};
        const file = join(fixtureRoot, 'src/extract/library-models/nested', name);
        mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, original);
        // All six original citations stay verbatim, without a domain or filename allow-list.
        expect(await findings(fixtureRoot)).toEqual([]);
        for (const [index, model] of registry.models.entries()) {
          const source = SOURCE_PATTERN.exec(model.reference)?.[0];
          SOURCE_PATTERN.lastIndex = 0;
          expect(source).toBeDefined();
          // id is another valid string field. Reusing a provenance URL there
          // must not borrow the reference scalar's allowance on the same line.
          const changed = {...registry, models: registry.models.map((entry, at) => at === index ? {...entry, id: model.reference} : entry)};
          writeFileSync(file, JSON.stringify(changed));
          expect(await findings(fixtureRoot)).toEqual([
            `${relative(fixtureRoot, file)}:1 (${file}): repository source is not an example or madarch repository: ${source}`,
          ]);
          writeFileSync(file, original);
          const outside = join(fixtureRoot, 'docs/system/provenance.json');
          writeFileSync(outside, JSON.stringify({reference: model.reference}));
          expect(await findings(fixtureRoot)).toEqual([
            `docs/system/provenance.json:1 (${outside}): repository source is not an example or madarch repository: ${source}`,
          ]);
          rmSync(outside);
        }
        // JSON structure and the closed schema, not a textual reference label,
        // establish provenance. Invalid data still reports every raw occurrence.
        const first = registry.models[0]!;
        writeFileSync(file, JSON.stringify({...registry, models: [{...first, unrelated: first.reference}]}));
        const invalid = await findings(fixtureRoot);
        expect(invalid.some(error => error.includes('library provenance is not licensed: invalid model registry:'))).toBe(true);
        expect(invalid.filter(error => error.includes('repository source is not an example or madarch repository:'))).toHaveLength(2);
        rmSync(file);
      }
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });

  test('package documentation uses the whole exact URL and the current ecosystem only', async () => {
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

  test('invalid registry structure and duplicate keys retain located errors and every unlicensed occurrence', async () => {
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
      writeFileSync(file, JSON.stringify(registry)); expect(await findings(fixtureRoot)).toEqual([]);
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
        const errors = await findings(fixtureRoot);
        expect(errors.some((error) => error.startsWith(`src/extract/library-models/models.json:1 (${file}): library provenance is not licensed:`))).toBe(true);
        const expectedOccurrences = document.split(reference).length - 1;
        expect(errors.filter((error) => error === `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: ${source}`)).toHaveLength(expectedOccurrences);
      }
      writeFileSync(file, JSON.stringify(registry));
      const ts = join(fixtureRoot, 'src/extract/library-models/note.ts');
      writeFileSync(ts, reference + '\n' + reference + '\n');
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models/note.ts:1 (${ts}): repository source is not an example or madarch repository: ${source}`,
        `src/extract/library-models/note.ts:2 (${ts}): repository source is not an example or madarch repository: ${source}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('HTTP models license only their exact package and provenance scalar boundaries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-http-provenance-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), {recursive: true});
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, ''); }
      const packageName = ['example.org', 'http-unit'].join('/');
      const reference = ['https:/', 'pkg.go.dev', packageName].join('/');
      const model = {id: 'unit.http', ecosystem: 'go', package: packageName, target: {kind: 'export', paths: [['Make']]}, effect: {kind: 'factory', role: 'mux'}, reference};
      const file = join(fixtureRoot, 'src/extract/library-models/http-models.json');
      mkdirSync(dirname(file), {recursive: true});
      writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [model]}));
      expect(await findings(fixtureRoot)).toEqual([]);
      const source = reference.slice('https://'.length);
      const elsewhere = join(fixtureRoot, 'docs/system/http-evidence.md'); writeFileSync(elsewhere, reference);
      expect(await findings(fixtureRoot)).toEqual([
        `docs/system/http-evidence.md:1 (${elsewhere}): repository source is not an example or madarch repository: ${source}`,
      ]);
      rmSync(elsewhere);
      writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [{...model, arbitrary: reference}]}));
      const invalid = await findings(fixtureRoot);
      expect(invalid.some((entry) => entry.startsWith(`src/extract/library-models/http-models.json:1 (${file}): library provenance is not licensed:`))).toBe(true);
      expect(invalid.filter((entry) => entry.endsWith(`repository source is not an example or madarch repository: ${source}`))).toHaveLength(2);
      const outsidePackage = ['github.com', 'not-acme', 'http-unit'].join('/');
      writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [{...model, package: outsidePackage, reference: ['https:/', 'pkg.go.dev', outsidePackage].join('/')}]}));
      expect(await findings(fixtureRoot)).toEqual([]);
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });

  test('metric semantic provenance keeps exact package and reference boundaries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-metric-semantics-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), {recursive: true});
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, ''); }
      const packageName = ['example.org', 'metric-unit'].join('/');
      const reference = ['https:/', 'pkg.go.dev', packageName].join('/');
      const model = {id: 'unit.writer', ecosystem: 'go', package: packageName, exportedPath: ['Writer'], role: 'http-response-writer', reference};
      const file = join(fixtureRoot, 'src/extract/library-models/metric-semantic-models.json');
      mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [model]}));
      expect(await findings(fixtureRoot)).toEqual([]);
      const elsewhere = join(fixtureRoot, 'docs/system/metric-evidence.md'); writeFileSync(elsewhere, reference);
      expect(await findings(fixtureRoot)).toEqual([
        `docs/system/metric-evidence.md:1 (${elsewhere}): repository source is not an example or madarch repository: ${reference.slice('https://'.length)}`,
      ]);
      rmSync(elsewhere);
      writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [{...model, arbitrary: reference}]}));
      expect((await findings(fixtureRoot)).some((entry) => entry.startsWith(`src/extract/library-models/metric-semantic-models.json:1 (${file}): library provenance is not licensed:`))).toBe(true);
      const outsidePackage = ['github.com', 'not-acme', 'metric-unit'].join('/');
      writeFileSync(file, JSON.stringify({schemaVersion: 1, models: [{...model, package: outsidePackage, reference: ['https:/', 'pkg.go.dev', outsidePackage].join('/')}]}));
      expect(await findings(fixtureRoot)).toEqual([]);
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });


  test('validated package fields never license another scalar, a sibling folder, or invalid model data', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-package-scalars-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const packageName = ['github.com', 'not-acme', 'modeled'].join('/');
      const model = { id: 'unit', ecosystem: 'go', package: packageName,
        target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Make']] },
        invoke: 'call', returnRole: 'logger', arguments: [],
        reference: ['https:/', 'pkg.go.dev', packageName].join('/'),
        checks: { positive: 'unit.positive', negative: 'unit.negative' } };
      const registry = { schemaVersion: 1, models: [model] };
      const file = join(fixtureRoot, 'src/extract/library-models/models.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(registry));
      expect(await findings(fixtureRoot)).toEqual([]);
      // A valid string field next to package is not a package identifier.
      writeFileSync(file, JSON.stringify({ ...registry, models: [{ ...model, presentation: { library: packageName } }] }));
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: ${packageName}`,
      ]);
      // An invalid registry cannot license either its package or provenance.
      writeFileSync(file, JSON.stringify({ ...registry, arbitrary: packageName }));
      const errors = await findings(fixtureRoot);
      expect(errors[0]).toStartWith(`src/extract/library-models/models.json:1 (${file}): library provenance is not licensed: invalid model registry:`);
      expect(errors.slice(1)).toEqual([
        `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: ${packageName}`,
        `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: pkg.go.dev/${packageName.split('/').slice(0, 2).join('/')}`,
        `src/extract/library-models/models.json:1 (${file}): repository source is not an example or madarch repository: ${packageName}`,
      ]);
      writeFileSync(file, JSON.stringify(registry));
      const other = join(fixtureRoot, 'src/extract/library-models-other/note.json');
      mkdirSync(dirname(other), { recursive: true }); writeFileSync(other, JSON.stringify({ package: packageName }));
      const note = join(fixtureRoot, 'src/extract/library-models/note.ts');
      writeFileSync(note, `// ${packageName}\nconst packageName = '${packageName}';\n`);
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models-other/note.json:1 (${other}): repository source is not an example or madarch repository: ${packageName}`,
        `src/extract/library-models/note.ts:1 (${note}): repository source is not an example or madarch repository: ${packageName}`,
        `src/extract/library-models/note.ts:2 (${note}): repository source is not an example or madarch repository: ${packageName}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('test and fixture imports use validated model packages and actual Go and TypeScript syntax', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-modeled-imports-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const goPackage = ['github.com', 'not-acme', 'go-library'].join('/');
      const tsPackage = ['github.com', 'not-acme', 'node-library'].join('/');
      const unknown = ['github.com', 'not-acme', 'unknown'].join('/');
      const makeModel = (packageName: string, ecosystem: string, id: string) => ({ id, ecosystem, package: packageName,
        target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Make']] },
        invoke: 'call', returnRole: 'logger', arguments: [],
        reference: ecosystem === 'go' ? ['https:/', 'pkg.go.dev', packageName].join('/') : ['https:/', 'www.npmjs.com/package', packageName].join('/'),
        checks: { positive: `${id}.positive`, negative: `${id}.negative` } });
      const file = join(fixtureRoot, 'src/extract/library-models/models.json');
      mkdirSync(dirname(file), { recursive: true });
      const registry = { schemaVersion: 1, models: [makeModel(goPackage, 'go', 'go'), makeModel(tsPackage, 'node', 'node')] };
      writeFileSync(file, JSON.stringify(registry));
      const go = join(fixtureRoot, 'test/fixtures/imports/main.go');
      mkdirSync(dirname(go), { recursive: true });
      writeFileSync(go, [
        'package unit', `import alias "${goPackage}"`, `import . \`${goPackage}\``,
        `import "${unknown}"`, `import "${goPackage}/child"`, `// import "${goPackage}"`,
        `/* import "${goPackage}" */`, `var note = \`import "${goPackage}"\``,
      ].join('\n'));
      const ts = join(fixtureRoot, 'test/imports.ts');
      writeFileSync(ts, [
        `import { Make } from '${tsPackage}';`, `import '${tsPackage}';`,
        `import { Make as Other } from '${unknown}';`, `// import '${tsPackage}';`,
        `const note = '${tsPackage}';`, `const lookalike = 'imported ${tsPackage}';`,
      ].join('\n'));
      const inline = join(fixtureRoot, 'test/inline.ts');
      const goSnippet = ['package unit', `import p "${goPackage}"`, `// import "${goPackage}"`, `var note = "${goPackage}"`].join('\n');
      const tsSnippet = [`import { Make } from '${tsPackage}';`, `// import '${tsPackage}';`, `const note = '${tsPackage}';`].join('\n');
      const unknownSnippet = ['package unit', `import "${unknown}"`].join('\n');
      writeFileSync(inline, [
        `const escaped = ${JSON.stringify(goSnippet)};`,
        `const typescript = \`${tsSnippet}\`;`,
        `const unknown = ${JSON.stringify(unknownSnippet)};`,
        `// import "${goPackage}"`,
        `const prose = ${JSON.stringify('An import "' + goPackage + '" is not a program.')};`,
      ].join('\n'));
      const outside = join(fixtureRoot, 'src/imports.ts');
      writeFileSync(outside, `import { Make } from '${tsPackage}';\n`);
      const expected = (path: string, line: number, packageName: string): string =>
        `${relative(fixtureRoot, path)}:${line} (${path}): repository source is not an example or madarch repository: ${packageName}`;
      expect(await findings(fixtureRoot)).toEqual([
        expected(outside, 1, tsPackage),
        expected(go, 4, unknown), expected(go, 5, goPackage), expected(go, 6, goPackage), expected(go, 7, goPackage), expected(go, 8, goPackage),
        expected(ts, 3, unknown), expected(ts, 4, tsPackage), expected(ts, 5, tsPackage), expected(ts, 6, tsPackage),
        expected(inline, 1, goPackage), expected(inline, 1, goPackage),
        expected(inline, 3, tsPackage), expected(inline, 4, tsPackage), expected(inline, 5, unknown),
        expected(inline, 6, goPackage), expected(inline, 7, goPackage),
      ]);
      // Neither an invalid registry nor another model file declares test-import packages.
      rmSync(go); rmSync(ts); rmSync(inline); rmSync(outside);
      writeFileSync(file, JSON.stringify({ ...registry, unrelated: true }));
      writeFileSync(ts, `import { Make } from '${tsPackage}';`);
      const invalid = await findings(fixtureRoot);
      expect(invalid).toContain(expected(ts, 1, tsPackage));
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, models: [] }));
      const otherModel = join(fixtureRoot, 'src/extract/library-models/other-models.json');
      writeFileSync(otherModel, JSON.stringify(registry));
      expect(await findings(fixtureRoot)).toEqual([expected(ts, 1, tsPackage)]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('literal defaultNamespace values stay findings while package-free provenance is licensed', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-namespaces-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), { recursive: true });
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ''); }
      const namespace = ['https:/', 'www.w3.org', '2000', 'svg'].join('/');
      const ts = join(fixtureRoot, 'test/namespaces.ts');
      writeFileSync(ts, `const options = { defaultNamespace: '${namespace}' };\n`);
      const registry = join(fixtureRoot, 'src/extract/library-models/models.json');
      mkdirSync(dirname(registry), { recursive: true });
      writeFileSync(registry, JSON.stringify({ schemaVersion: 1, models: [{
        id: 'unit', ecosystem: 'node', package: 'unit',
        target: { kind: 'export', importRoles: ['named'], exportedPaths: [['Make']] },
        invoke: 'call', returnRole: 'logger', arguments: [],
        metricRegistry: { defaultNamespace: namespace },
        reference: ['https:/', 'www.npmjs.com', 'package', 'unit'].join('/'),
        checks: { positive: 'unit.positive', negative: 'unit.negative' },
      }] }));
      const evidence = ['https:/', 'www.postgresql.org', 'docs', 'current'].join('/');
      const environment = join(fixtureRoot, 'src/extract/library-models/environment-models.json');
      mkdirSync(dirname(environment), { recursive: true });
      writeFileSync(environment, JSON.stringify({ schemaVersion: 1, models: [
        { id: 'unit', variable: 'UNIT_CONNECTION', effect: 'database-connection', reference: evidence },
      ] }));
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models/models.json:1 (${registry}): repository source is not an example or madarch repository: ${namespace.slice('https://'.length)}`,
        `test/namespaces.ts:1 (${ts}): repository source is not an example or madarch repository: ${namespace.slice('https://'.length)}`,
      ]);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  test('outbox operation evidence licenses only its exact validated receiver package', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'madarch-neutral-outbox-provenance-'));
    try {
      for (const path of SCAN_ROOTS) mkdirSync(join(fixtureRoot, path), {recursive: true});
      for (const path of ROOT_DOCUMENTS) { const file = join(fixtureRoot, path); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, ''); }
      const packageName = ['database', 'sql'].join('/');
      const reference = ['https:/', 'pkg.go.dev', packageName].join('/');
      const registry = {schemaVersion: 1, outbox: {table: 'outbox', topicColumn: 'topic'},
        receivers: [
          {id: 'db', ecosystem: 'go', package: packageName, packageName: 'sql', exportedPath: ['DB'], pointer: true, reference: reference + '#DB'},
          {id: 'tx', ecosystem: 'go', package: packageName, packageName: 'sql', exportedPath: ['Tx'], pointer: true, reference: reference + '#Tx'},
        ],
        operations: [{id: 'query', receiverIds: ['db'], member: 'Query', sql: 0, values: 1, reference: reference + '#DB.Query'}],
        scan: {member: 'Scan', receiver: 'query-result', arguments: 'destinations'},
        append: {ecosystem: 'go', builtin: 'append', collection: 0, element: 1},
        factories: [{member: 'BeginTx', receiverIds: ['db'], returns: 'tx', reference: reference + '#DB.BeginTx'}]};
      const file = join(fixtureRoot, 'src/extract/library-models/outbox-models.json');
      mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, JSON.stringify(registry));
      expect(await findings(fixtureRoot)).toEqual([]);
      const outside = join(fixtureRoot, 'docs/system/sql-evidence.md'); writeFileSync(outside, reference);
      expect(await findings(fixtureRoot)).toEqual([
        `docs/system/sql-evidence.md:1 (${outside}): repository source is not an example or madarch repository: ${reference.slice('https://'.length)}`,
      ]);
      rmSync(outside);
      const other = ['https:/', 'pkg.go.dev', 'database', 'other'].join('/');
      writeFileSync(file, JSON.stringify({...registry, operations: [{...registry.operations[0], reference: other}]}));
      expect(await findings(fixtureRoot)).toEqual([
        `src/extract/library-models/outbox-models.json:1 (${file}): repository source is not an example or madarch repository: ${other.slice('https://'.length)}`,
      ]);
      writeFileSync(file, JSON.stringify({...registry, operations: [{...registry.operations[0], receiverIds: ['unknown']}]}));
      const errors = await findings(fixtureRoot);
      expect(errors.some(error => error.includes('invalid model registry'))).toBe(true);
      expect(errors.filter(error => error.includes('repository source is not an example'))).toHaveLength(4);
    } finally { rmSync(fixtureRoot, {recursive: true, force: true}); }
  });

  test('only example and madarch repositories appear in product code and current documents', async () => {
    expect(await findings()).toEqual([]);
  });
});
