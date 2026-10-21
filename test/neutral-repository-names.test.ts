import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['src', 'test', 'scripts', 'wiki/app/src', 'examples', 'docs/system'];
const ROOT_DOCUMENTS = ['AGENTS.md', 'docs/glossary.md'];
const HOME = String.fromCharCode(47) + 'home' + String.fromCharCode(47);
const USERS = String.fromCharCode(47) + 'Users' + String.fromCharCode(47);
const WINDOWS_USERS = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92);
const SOURCE_PATTERN = /(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?[:/][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g;
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

function findings(root = ROOT): string[] {
  const errors: string[] = [];
  const goModules = declaredGoModules(root);
  const files = SCAN_ROOTS.flatMap((path) => filesUnder(join(root, path)))
    .concat(ROOT_DOCUMENTS.map((file) => join(root, file)))
    .sort(compareCodePoints);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SOURCE_PATTERN)) {
      const source = match[0];
      if (sourceIsAllowed(source, goModules)) continue;
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

  test('only example and madarch repositories appear in product code and current documents', () => {
    expect(findings()).toEqual([]);
  });
});
