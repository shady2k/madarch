import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['src', 'test', 'scripts', 'wiki/app/src', 'examples', 'docs/system'];
const ROOT_DOCUMENTS = ['AGENTS.md', 'docs/glossary.md'];
const CANDIDATE_SERVER_SPEC = 'docs/changes/madarch-l2f/capabilities/server.md';
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

function sourceIsAllowed(source: string): boolean {
  const pattern = /^(?<host>(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?::\d+)?[:/](?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)/;
  const normalized = source.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '').replace(/^[^@/]+@/, '');
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
  return (host === 'github.com' || host === 'raw.githubusercontent.com') && owner === 'shady2k' && ['madarch', 'madarch-product'].includes(repo);
}

function findings(): string[] {
  const errors: string[] = [];
  const currentServerSpec = join(ROOT, 'docs/system/capabilities/server.md');
  const files = SCAN_ROOTS.flatMap((root) => filesUnder(join(ROOT, root)))
    .concat(ROOT_DOCUMENTS.map((file) => join(ROOT, file)))
    .filter((file) => file !== currentServerSpec)
    // Until close-out replays the proposal into current specifications, scan
    // the exact candidate that will become the current server capability.
    .concat(join(ROOT, CANDIDATE_SERVER_SPEC))
    .sort(compareCodePoints);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(SOURCE_PATTERN)) {
      const source = match[0];
      if (sourceIsAllowed(source)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      errors.push(`${relative(ROOT, file)}:${line} (${file}): repository source is not an example or madarch repository: ${source}`);
    }
    for (const forbidden of [HOME, USERS, WINDOWS_USERS]) {
      let index = text.indexOf(forbidden);
      while (index !== -1) {
        const line = text.slice(0, index).split('\n').length;
        errors.push(`${relative(ROOT, file)}:${line} (${file}): absolute home path found`);
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

  test('only example and madarch repositories appear in product code and current documents', () => {
    expect(findings()).toEqual([]);
  });
});
