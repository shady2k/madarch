import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModel } from '../src/check/model-check.js';

/**
 * The model check (docs/changes/agent-model/capabilities/model-check.md):
 * compiles (refused-model, warnings-reported), evidence-complete
 * (missing-evidence), evidence-resolves (line-past-end, squashed-commit,
 * wrong-blob) and result (exit-codes). Every test builds its own small git
 * repository and states only what matters to it; the expected values come
 * from the requirement text.
 */

/** One fixed identity and moment, so tests never depend on the machine's git config or the clock. */
const GIT_IDENTITY = ['-c', 'user.name=Model Check', '-c', 'user.email=check@example.com', '-c', 'commit.gpgsign=false'];
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Model Check',
  GIT_AUTHOR_EMAIL: 'check@example.com',
  GIT_COMMITTER_NAME: 'Model Check',
  GIT_COMMITTER_EMAIL: 'check@example.com',
  GIT_AUTHOR_DATE: '1756728000 +0000',
  GIT_COMMITTER_DATE: '1756728000 +0000',
};

/** A tiny git repository a test builds step by step; removed when the test is over. */
class Repo {
  readonly path: string;
  private readonly yaml = new Map<string, string>();

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'madarch-model-check-'));
    this.run(['init', '-b', 'main', '--quiet']);
  }

  run(args: string[]): { ok: boolean; stdout: string } {
    const run = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: this.path, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    return { ok: run.status === 0, stdout: run.stdout ?? '' };
  }

  write(file: string, content: string): void {
    mkdirSync(dirname(join(this.path, file)), { recursive: true });
    writeFileSync(join(this.path, file), content);
  }

  /** Writes a model file, keeping its text so tests can read expected line numbers off it. */
  writeModel(name: string, yaml: string): void {
    this.write(`madarch/${name}`, yaml);
    this.yaml.set(name, yaml);
  }

  /** The 1-based line of the first line of the named model file containing `needle`. */
  lineOf(name: string, needle: string): number {
    const index = (this.yaml.get(name) ?? '').split('\n').findIndex((line) => line.includes(needle));
    expect(index).toBeGreaterThan(-1);
    return index + 1;
  }

  commit(message: string): string {
    expect(this.run(['add', '-A']).ok).toBe(true);
    expect(this.run(['commit', '--quiet', '-m', message]).ok).toBe(true);
    return this.run(['rev-parse', 'HEAD']).stdout.trim();
  }

  /** The blob id `file` has at `commit` (default HEAD). */
  blob(file: string, commit = 'HEAD'): string {
    return this.run(['rev-parse', `${commit}:${file}`]).stdout.trim();
  }
}

const SCRIPT = fileURLToPath(new URL('../scripts/check-model.ts', import.meta.url));

/** Runs the check's script the way a person does, from a shell. */
function runScript(...args: string[]): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '' };
}

/** A repository whose model is complete and correct: two elements, an interface and a named relation, all with resolving evidence. */
function completeRepo(): Repo {
  const repo = new Repo();
  repo.write('src/web.ts', 'export const web = 1;\n');
  repo.write('src/core.ts', numberedLines(30));
  const commit = repo.commit('the sources');
  const webBlob = repo.blob('src/web.ts', commit);
  const coreBlob = repo.blob('src/core.ts', commit);
  const yaml = [
    'version: 1',
    '',
    'elements:',
    '  - id: web',
    '    kind: service',
    '    name: Web',
    '    evidence:',
    '      - file: src/web.ts',
    `        commit: ${commit}`,
    `        blob: ${webBlob}`,
    '  - id: core',
    '    kind: service',
    '    name: Core',
    '    evidence:',
    '      - file: src/core.ts',
    '        line: 2',
    '        endLine: 4',
    `        commit: ${commit}`,
    `        blob: ${coreBlob}`,
    '',
    'interfaces:',
    '  - id: core-api',
    '    provider: core',
    '    contract: http::GET::/api',
    '    evidence:',
    '      - file: src/core.ts',
    `        commit: ${commit}`,
    `        blob: ${coreBlob}`,
    '',
    'relations:',
    '  - id: web-calls-core',
    '    name: Places orders on the core',
    '    from: web',
    '    to: core',
    '    interface: core-api',
    '    evidence:',
    '      - file: src/web.ts',
    `        commit: ${commit}`,
    `        blob: ${webBlob}`,
    '',
  ].join('\n');
  repo.writeModel('model.yaml', yaml);
  repo.commit('the model');
  return repo;
}

/** Writes src/feature.ts on a branch, squash-merges it onto main, deletes the branch and prunes the original commit away. */
function squashFeature(repo: Repo): { lostCommit: string; lostBlob: string; squashCommit: string } {
  repo.write('README.md', 'base\n');
  repo.commit('base');
  expect(repo.run(['checkout', '-b', 'feature']).ok).toBe(true);
  repo.write('src/feature.ts', 'export const feature = 1;\n');
  const lostCommit = repo.commit('the feature');
  const lostBlob = repo.blob('src/feature.ts', lostCommit);
  expect(repo.run(['checkout', '-q', 'main']).ok).toBe(true);
  expect(repo.run(['merge', '--squash', 'feature']).ok).toBe(true);
  const squashCommit = repo.commit('the feature, squashed');
  expect(repo.run(['branch', '--delete', '--force', 'feature']).ok).toBe(true);
  expect(repo.run(['reflog', 'expire', '--expire=now', '--all']).ok).toBe(true);
  expect(repo.run(['gc', '--prune=now', '--quiet']).ok).toBe(true);
  expect(repo.run(['cat-file', '-e', `${lostCommit}^{commit}`]).ok).toBe(false);
  return { lostCommit, lostBlob, squashCommit };
}

function withRepo(run: (repo: Repo) => void): void {
  const repo = new Repo();
  try {
    run(repo);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
}

/** A file of `count` numbered lines, each ending with a newline. */
function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('');
}

describe('the model check', () => {
  describe('compiles', () => {
    test('refused-model: an element naming a parent no element has fails the check, naming the element, its file and line, and reports nothing else', () => {
      withRepo((repo) => {
        const yaml = ['version: 1', '', 'elements:', '  - id: billing-web', '    kind: service', '    name: Billing web', '    parent: billing', ''].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/model.yaml');
        expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', 'parent: billing'));
        expect(report.errors[0]!.message).toContain('billing-web');
        expect(report.errors[0]!.message).toContain('billing');
        expect(report.warnings).toEqual([]);
        expect(report.notes).toEqual([]);
      });
    });
  });

  describe('inputs that cannot be read', () => {
    test('a path that is not a git repository is refused, saying which input is missing', () => {
      const path = mkdtempSync(join(tmpdir(), 'madarch-model-check-notgit-'));
      try {
        const report = checkModel(path);

        expect(report.outcome).toBe('unreadable');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.message).toContain('not a git repository');
        expect(report.warnings).toEqual([]);
        expect(report.notes).toEqual([]);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    test('a git repository without a madarch folder is refused, saying which input is missing', () => {
      withRepo((repo) => {
        repo.write('README.md', 'nothing but a readme\n');
        repo.commit('a repository with no model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('unreadable');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.message).toContain('madarch');
      });
    });

    test('an unknown revision is refused, saying which input is missing', () => {
      withRepo((repo) => {
        repo.writeModel('model.yaml', 'version: 1\n\nelements: []\n');
        repo.commit('the model');

        const report = checkModel(repo.path, { rev: 'no-such-revision' });

        expect(report.outcome).toBe('unreadable');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.message).toContain('no-such-revision');
      });
    });
  });

  describe('evidence-resolves', () => {
    test('wrong-blob: an item whose blob is not the file\'s blob at its commit fails, naming the item, the blob it names and the blob the file has', () => {
      withRepo((repo) => {
        repo.write('src/web.ts', 'export const web = 1;\n');
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const namedBlob = repo.blob('src/web.ts', commit);
        const actualBlob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${namedBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.file).toBe('madarch/model.yaml');
        expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', '- file: src/core.ts'));
        expect(report.errors[0]!.message).toContain(namedBlob);
        expect(report.errors[0]!.message).toContain(actualBlob);
        expect(report.notes).toEqual([]);
      });
    });

    test('line-past-end: an item naming lines past the blob\'s end fails, saying how many lines the file has', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          '        line: 40',
          '        endLine: 45',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('30 lines');
        expect(report.errors[0]!.message).toContain('40');
        expect(report.errors[0]!.message).toContain('45');
        expect(report.notes).toEqual([]);
      });
    });

    test('line-past-end: a single line past the blob\'s end fails the same way', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          '        line: 31',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('30 lines');
        expect(report.errors[0]!.message).toContain('31');
      });
    });

    test('a file the named commit does not have fails, naming the item', () => {
      withRepo((repo) => {
        repo.write('src/web.ts', 'export const web = 1;\n');
        const commitWithoutCore = repo.commit('web only');
        repo.write('src/core.ts', numberedLines(30));
        repo.commit('core joins');
        const coreBlob = repo.blob('src/core.ts');
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commitWithoutCore}`,
          `        blob: ${coreBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('src/core.ts');
        expect(report.errors[0]!.message).toContain('does not exist');
      });
    });

    test('squashed-commit: an item whose commit a squash merge removed is accepted, with a note saying where its blob was found', () => {
      withRepo((repo) => {
        const { lostCommit: featureCommit, lostBlob: featureBlob, squashCommit } = squashFeature(repo);

        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/feature.ts',
          `        commit: ${featureCommit}`,
          `        blob: ${featureBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.notes).toHaveLength(1);
        expect(report.notes[0]!.id).toBe('core');
        expect(report.notes[0]!.file).toBe('madarch/model.yaml');
        expect(report.notes[0]!.line).toBe(repo.lineOf('model.yaml', '- file: src/feature.ts'));
        expect(report.notes[0]!.message).toBe(`commit missing, blob found at ${squashCommit}`);
      });
    });
    test('a commit that is not in the repository and a blob nowhere in its history fails, naming the item', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        repo.commit('the sources');
        const lostCommit = '0123456789abcdef0123456789abcdef01234567';
        const lostBlob = 'fedcba9876543210fedcba9876543210fedcba98';
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${lostCommit}`,
          `        blob: ${lostBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain(lostCommit);
        expect(report.errors[0]!.message).toContain(lostBlob);
      });
    });
  });
  describe('evidence-complete', () => {
    test('missing-evidence: a relation with no evidence and an item with no commit and blob are both reported, each with its file and line', () => {
      withRepo((repo) => {
        repo.write('src/web.ts', 'export const web = 1;\n');
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const webBlob = repo.blob('src/web.ts', commit);
        const coreBlob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: web',
          '    kind: service',
          '    name: Web',
          '    evidence:',
          '      - file: src/web.ts',
          `        commit: ${commit}`,
          `        blob: ${webBlob}`,
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          '',
          'interfaces:',
          '  - id: core-api',
          '    provider: core',
          '    contract: http::GET::/api',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${coreBlob}`,
          '',
          'relations:',
          '  - id: ui-calls-core',
          '    from: web',
          '    to: core',
          '    interface: core-api',
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(2);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.file).toBe('madarch/model.yaml');
        expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', '- file: src/core.ts'));
        expect(report.errors[0]!.message).toContain('without a commit and a blob');
        expect(report.errors[1]!.id).toBe('ui-calls-core');
        expect(report.errors[1]!.line).toBe(repo.lineOf('model.yaml', '- id: ui-calls-core'));
        expect(report.errors[1]!.message).toContain('relation "ui-calls-core"');
        expect(report.errors[1]!.message).toContain('has no evidence');
      });
    });

    test('a complete and correct model passes with no errors, no warnings and no notes', () => {
      withRepo((_) => {
        const repo = completeRepo();

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.warnings).toEqual([]);
        expect(report.notes).toEqual([]);
      });
    });
  });

  describe('compiles, warnings', () => {
    test('warnings-reported: a model that compiles with one unnamed relation reports the warning with the relation, its file and line, and does not fail', () => {
      withRepo((repo) => {
        repo.write('src/web.ts', 'export const web = 1;\n');
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const webBlob = repo.blob('src/web.ts', commit);
        const coreBlob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: web',
          '    kind: service',
          '    name: Web',
          '    evidence:',
          '      - file: src/web.ts',
          `        commit: ${commit}`,
          `        blob: ${webBlob}`,
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${coreBlob}`,
          '',
          'relations:',
          '  - id: ui-calls-core',
          '    from: web',
          '    to: core',
          '    evidence:',
          '      - file: src/web.ts',
          `        commit: ${commit}`,
          `        blob: ${webBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.warnings).toHaveLength(1);
        expect(report.warnings[0]!.file).toBe('madarch/model.yaml');
        expect(report.warnings[0]!.line).toBe(repo.lineOf('model.yaml', '- id: ui-calls-core'));
        expect(report.warnings[0]!.message).toContain('ui-calls-core');
        expect(report.notes).toEqual([]);
      });
    });
  });

  describe('result', () => {
    test('exit-codes: the script exits 0 for a correct repository, printing no error lines', () => {
      const repo = completeRepo();
      try {
        const run = runScript(repo.path);

        expect(run.status).toBe(0);
        expect(run.stdout).not.toContain('error:');
      } finally {
        rmSync(repo.path, { recursive: true, force: true });
      }
    });

    test('exit-codes: the script exits 1 when something fails, listing the errors', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        repo.commit('the sources');
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const run = runScript(repo.path);

        expect(run.status).toBe(1);
        expect(run.stdout).toContain('error:');
        expect(run.stdout).toContain('core');
      });
    });

    test('exit-codes: the script exits 2 for a path that is not a git repository and for a repository without madarch', () => {
      const notGit = mkdtempSync(join(tmpdir(), 'madarch-model-check-notgit-'));
      try {
        expect(runScript(notGit).status).toBe(2);
      } finally {
        rmSync(notGit, { recursive: true, force: true });
      }

      withRepo((repo) => {
        repo.write('README.md', 'no model here\n');
        repo.commit('a repository with no model');

        expect(runScript(repo.path).status).toBe(2);
      });
    });

    test('--json prints the same report as one JSON object', () => {
      const repo = completeRepo();
      try {
        const run = runScript(repo.path, '--json');

        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(checkModel(repo.path));
      } finally {
        rmSync(repo.path, { recursive: true, force: true });
      }
    });
  });

  describe('ordering and edge shapes', () => {
    test('findings are sorted by file, then line, then id, whatever order the sections are written in', () => {
      withRepo((repo) => {
        const { lostCommit, lostBlob, squashCommit } = squashFeature(repo);
        // The relations section is written before the elements section, so
        // the order the check walks the model in is not the order a reader
        // sees; both a relation and an element miss their evidence, and
        // both a relation and an element name the squashed-away commit.
        const yaml = [
          'version: 1',
          '',
          'relations:',
          '  - id: r1',
          '    from: e1',
          '    to: e2',
          '    interface: core-api',
          '    evidence:',
          '      - file: src/feature.ts',
          `        commit: ${lostCommit}`,
          `        blob: ${lostBlob}`,
          '  - id: r2',
          '    from: e1',
          '    to: e2',
          '',
          'elements:',
          '  - id: e1',
          '    kind: service',
          '    name: E1',
          '  - id: e2',
          '    kind: service',
          '    name: E2',
          '    evidence:',
          '      - file: src/feature.ts',
          `        commit: ${lostCommit}`,
          `        blob: ${lostBlob}`,
          '',
          'interfaces:',
          '  - id: core-api',
          '    provider: e1',
          '    contract: http::GET::/api',
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors.map((error) => error.id)).toEqual(['r2', 'e1', 'core-api']);
        expect(report.errors[0]!.line).toBe(repo.lineOf('model.yaml', '- id: r2'));
        expect(report.errors[1]!.line).toBe(repo.lineOf('model.yaml', '- id: e1'));
        expect(report.errors[2]!.line).toBe(repo.lineOf('model.yaml', '- id: core-api'));
        expect(report.errors[2]!.message).toContain('interface "core-api"');
        expect(report.notes.map((note) => note.id)).toEqual(['r1', 'e2']);
        expect(report.notes[0]!.line).toBe(repo.lineOf('model.yaml', '- file: src/feature.ts'));
        expect(report.notes[0]!.message).toBe(`commit missing, blob found at ${squashCommit}`);
      });
    });

    test('compile problems are listed in file and line order, not in the order loading found them', () => {
      withRepo((repo) => {
        // a.yaml sorts first and holds a reference problem, which loading
        // only finds after every file's schema has been checked; b.yaml
        // sorts second and holds a schema problem, which loading finds
        // first. The report orders by file and line all the same.
        repo.writeModel('a.yaml', ['version: 1', '', 'elements:', '  - id: web', '    kind: service', '    name: Web', '    parent: ghost', ''].join('\n'));
        repo.writeModel('b.yaml', ['version: 1', '', 'elements:', '  - id: core', '    kind: service', '    name: Core', '    typoField: yes', ''].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors.map((error) => [error.file, error.line])).toEqual([
          ['madarch/a.yaml', repo.lineOf('a.yaml', 'parent: ghost')],
          ['madarch/b.yaml', repo.lineOf('b.yaml', 'typoField: yes')],
        ]);
      });
    });

    test('an evidence item that is an empty list counts as no evidence', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        repo.commit('the sources');
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence: []',
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('has no evidence');
      });
    });

    test('an empty file has zero lines, and an item without lines names line 1 of it', () => {
      withRepo((repo) => {
        repo.write('src/empty.ts', '');
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/empty.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/empty.ts',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('line 1');
        expect(report.errors[0]!.message).toContain('0 lines');
      });
    });

    test('a blob the history holds as the older side of a change is found there too', () => {
      withRepo((repo) => {
        const { lostCommit, lostBlob } = squashFeature(repo);
        repo.write('src/feature.ts', 'export const feature = 1;\nexport const feature2 = 2;\n');
        const growCommit = repo.commit('the feature grows');

        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/feature.ts',
          `        commit: ${lostCommit}`,
          `        blob: ${lostBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.notes).toHaveLength(1);
        expect(report.notes[0]!.id).toBe('core');
        expect(report.notes[0]!.message).toBe(`commit missing, blob found at ${growCommit}`);
      });
    });

    test('a range that starts within the blob but ends past it fails too', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/core.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/core.ts',
          '        line: 29',
          '        endLine: 31',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('lines 29 to 31');
        expect(report.errors[0]!.message).toContain('30 lines');
      });
    });

    test('an item whose lines run past a blob that the history only holds because of the squash is still an error', () => {
      withRepo((repo) => {
        const { lostCommit, lostBlob } = squashFeature(repo);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/feature.ts',
          '        line: 5',
          '        endLine: 6',
          `        commit: ${lostCommit}`,
          `        blob: ${lostBlob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('lines 5 to 6');
        expect(report.errors[0]!.message).toContain('1 lines');
        expect(report.notes).toEqual([]);
      });
    });

    test('a file whose last line has no newline counts by its lines, not by its newlines', () => {
      withRepo((repo) => {
        repo.write('src/hand.ts', 'export const a = 1;\nexport const b = 2;');
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/hand.ts', commit);
        const yaml = [
          'version: 1',
          '',
          'elements:',
          '  - id: core',
          '    kind: service',
          '    name: Core',
          '    evidence:',
          '      - file: src/hand.ts',
          '        line: 1',
          '        endLine: 2',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
      });
    });
  });
});
