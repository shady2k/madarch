/**
 * The reference-graph check (`scripts/check-reference-graph.ts`): the YAML
 * parses, each quote equals the repository file's lines at that path, each
 * edge's ends exist, each kind and relation is one the mapping declares, ids
 * are unique, and every tracked file has a reference file. Every finding names
 * the reference file, the line of the entry and the full path of the file the
 * quote should equal. Fixtures only: a three-file git repository made here.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-reference-graph.ts');
const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'main.go': 'package main\n\nfunc main() {}\n',
  'notes.md': '# Notes\n\nSome notes.\n',
};

/** A git repository of FILES, committed once, and a reference graph over it. */
function fixture(graph: Record<string, string>): { repo: string; graph: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'madarch-reference-graph-'));
  made.push(repo);
  for (const [path, content] of Object.entries(FILES)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.test', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
        TZ: 'UTC', LC_ALL: 'C',
      },
    });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  const sha = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const graphFolder = mkdtempSync(join(tmpdir(), 'madarch-reference-graph-yaml-'));
  made.push(graphFolder);
  for (const [path, content] of Object.entries(graph)) {
    const full = join(graphFolder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { repo, graph: graphFolder, sha };
}

function mainFile(): string {
  return [
    "path: main.go",
    'nodes:',
    '  - id: code.file:main.go',
    '    kind: code.file',
    '    label: main.go',
    '    evidence:',
    '      - path: main.go',
    '        startLine: 1',
    '        endLine: 1',
    "        quote: 'package main'",
    '    reading: parsed',
    '  - id: code.symbol:main.go#main',
    '    kind: code.symbol',
    '    label: main',
    '    evidence:',
    '      - path: main.go',
    '        startLine: 3',
    '        endLine: 3',
    "        quote: 'func main() {}'",
    '    reading: parsed',
    'edges:',
    '  - relation: code.contains',
    '    from: code.file:main.go',
    '    to: code.symbol:main.go#main',
    '    evidence:',
    '      - path: main.go',
    '        startLine: 3',
    '        endLine: 3',
    "        quote: 'func main() {}'",
    '    reading: parsed',
    '',
  ].join('\n');
}

function notesFile(): string {
  return [
    "path: notes.md",
    'notes: a document; the vocabulary holds no kind for a plain note.',
    'nodes:',
    '  - id: code.file:notes.md',
    '    kind: code.file',
    '    label: notes.md',
    '    evidence:',
    '      - path: notes.md',
    '        startLine: 1',
    '        endLine: 1',
    "        quote: '# Notes'",
    '    reading: parsed',
    'edges: []',
    '',
  ].join('\n');
}

function repositoryFile(sha: string): string {
  return [
    'path: repository',
    'nodes:',
    '  - id: code.commit:' + sha,
    '    kind: code.commit',
    '    label: First commit',
    '    evidence:',
    `      - command: "git log -1 --format=%s ${sha}"`,
    "        quote: 'First commit'",
    '    reading: parsed',
    'edges: []',
    '',
  ].join('\n');
}

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function run(repo: string, graph: string): Run {
  const done = Bun.spawnSync(['bun', SCRIPT, repo, '--graph', graph], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
}

/** The baseline graph, with one file's text replaced or dropped. */
function baseline(sha: string): Record<string, string> {
  return { 'main.go.yaml': mainFile(), 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(sha) };
}

describe('check-reference-graph', () => {
  test('a valid graph is green and names its counts', () => {
    const built = fixture({});
    const { graph } = fixture(baseline(built.sha));
    const result = run(built.repo, graph);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('3 reference files, 4 nodes, 1 edges: no findings');
  });

  test('a quote that is not the file\'s line names the reference file, the line and the full path', () => {
    const built = fixture({});
    const text = mainFile().replace("quote: 'func main() {}'", "quote: 'func main() { }'");
    const { graph } = fixture({ 'main.go.yaml': text, 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) });
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain(join(graph, 'main.go.yaml'));
    expect(result.err).toMatch(/main\.go\.yaml:1[0-9]:/);
    expect(result.err).toContain(join(built.repo, 'main.go'));
  });

  test('a kind the mapping does not declare is refused by name', () => {
    const built = fixture({});
    const text = mainFile().replace('kind: code.symbol', 'kind: code.function');
    const graph = fixture({ 'main.go.yaml': text, 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"code.function"');
    expect(result.err).toContain('the mapping declares no such kind');
  });

  test('a relation the mapping does not declare is refused by name', () => {
    const built = fixture({});
    const text = mainFile().replace('relation: code.contains', 'relation: code.has-part');
    const graph = fixture({ 'main.go.yaml': text, 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"code.has-part"');
  });

  test('an edge whose end no file declares is refused, naming the missing id', () => {
    const built = fixture({});
    const text = mainFile().replace('to: code.symbol:main.go#main', 'to: code.symbol:main.go#start');
    const graph = fixture({ 'main.go.yaml': text, 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"code.symbol:main.go#start"');
  });

  test('a tracked file without a reference file is refused, naming both full paths', () => {
    const built = fixture({});
    const graph = fixture({ 'main.go.yaml': mainFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain(join(built.repo, 'notes.md'));
    expect(result.err).toContain(join(graph, 'notes.md.yaml'));
  });

  test('an id declared twice is refused', () => {
    const built = fixture({});
    const notes = notesFile().replace('id: code.file:notes.md', 'id: code.file:main.go');
    const graph = fixture({ 'main.go.yaml': mainFile(), 'notes.md.yaml': notes, 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('is declared again');
  });

  test('a reading outside parsed, declared and judgement is refused', () => {
    const built = fixture({});
    const text = mainFile().replace('reading: parsed', 'reading: guessed');
    const graph = fixture({ 'main.go.yaml': text, 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"guessed"');
  });

  test('Git evidence is checked against the exact command', () => {
    const built = fixture({});
    const text = repositoryFile(built.sha).replace("quote: 'First commit'", "quote: 'Second commit'");
    const graph = fixture({ 'main.go.yaml': mainFile(), 'notes.md.yaml': notesFile(), 'repository.yaml': text }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('is not a line of');
  });

  test('a reference file whose path does not mirror its place is refused', () => {
    const built = fixture({});
    const graph = fixture({ 'main.go.yaml': mainFile(), 'notes.md.yaml': notesFile().replace('path: notes.md', 'path: notes.txt'), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('"notes.md"');
    expect(result.err).toContain('"notes.txt"');
  });

  test('YAML that does not parse is refused with its line', () => {
    const built = fixture({});
    const graph = fixture({ 'main.go.yaml': mainFile() + '\n  bad indent: [\n', 'notes.md.yaml': notesFile(), 'repository.yaml': repositoryFile(built.sha) }).graph;
    const result = run(built.repo, graph);
    expect(result.code).toBe(1);
    expect(result.err).toContain('does not parse');
  });
});
