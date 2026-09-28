import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assigned, checkModel, completeRepo, numberedLines, Repo, runScript, withRepo } from './model-check-repo.js';

/**
 * The model check (docs/changes/agent-model/capabilities/model-check.md):
 * compiles (refused-model, warnings-reported), evidence-complete
 * (missing-evidence), evidence-resolves (line-past-end, squashed-commit,
 * wrong-blob) and result (exit-codes). Every test builds its own small git
 * repository and states only what matters to it; the expected values come
 * from the requirement text. The repository fixture itself lives in
 * test/model-check-repo.ts, shared with the problems' tests.
 */

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

/** A repository where src/core.ts changed after the model pinned it: the one stale item staleness reports. */
function staleRepo(): { repo: Repo; oldBlob: string } {
  const repo = new Repo();
  repo.write('src/core.ts', 'line 1\n');
  const sourceCommit = repo.commit('the sources');
  const oldBlob = repo.blob('src/core.ts', sourceCommit);
  const yaml = [
    'version: 1',
    '',
    'elements:',
    '  - id: core',
    '    kind: service',
    '    name: Core',
    '    evidence:',
    '      - file: src/core.ts',
    `        commit: ${sourceCommit}`,
    `        blob: ${oldBlob}`,
    '',
  ].join('\n');
  repo.writeModel('model.yaml', yaml);
  repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
  repo.commit('the model');
  repo.write('src/core.ts', 'line 1 changed\n');
  repo.commit('the file changes');
  return { repo, oldBlob };
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
        repo.writeReview([], assigned([['src/core.ts', 'core', ''], ['src/web.ts', 'excluded', 'not modelled']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', ''], ['src/web.ts', 'excluded', 'not modelled']]));
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
        repo.writeReview([], assigned([['src/feature.ts', 'core', ''], ['README.md', 'excluded', 'the readme']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
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
        repo.writeReview([], assigned([['src/web.ts', 'web', ''], ['src/core.ts', 'core', '']]));
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
        expect(report.stale).toEqual([]);
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
        repo.writeReview([], assigned([['src/web.ts', 'web', ''], ['src/core.ts', 'core', '']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
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

    test('exit-codes: the script exits 0 for a repository with a stale item, printing it under stale', () => {
      const { repo, oldBlob } = staleRepo();
      try {
        const run = runScript(repo.path);

        expect(run.status).toBe(0);
        expect(run.stdout).toContain('stale:');
        expect(run.stdout).toContain('src/core.ts');
        expect(run.stdout).toContain(oldBlob);
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
        repo.writeReview([], assigned([['src/feature.ts', 'e2', ''], ['README.md', 'excluded', 'the readme']]));
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('has no evidence');
      });
    });

    test('an empty file has zero lines, and an item naming line 1 of it fails', () => {
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
          '        line: 1',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/empty.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.id).toBe('core');
        expect(report.errors[0]!.message).toContain('line 1');
        expect(report.errors[0]!.message).toContain('0 lines');
      });
    });

    test('an item without lines names the whole file, and an empty file has a whole to name', () => {
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
        repo.writeReview([], assigned([['src/empty.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.notes).toEqual([]);
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
        repo.writeReview([], assigned([['src/feature.ts', 'core', ''], ['README.md', 'excluded', 'the readme']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.notes).toHaveLength(1);
        expect(report.notes[0]!.id).toBe('core');
        expect(report.notes[0]!.message).toBe(`commit missing, blob found at ${growCommit}`);
      });
    });

    test('an item naming the blob\'s exact last line resolves', () => {
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
          '        line: 30',
          '        endLine: 30',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
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
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
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
        repo.writeReview([], assigned([['src/feature.ts', 'core', ''], ['README.md', 'excluded', 'the readme']]));
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
        repo.writeReview([], assigned([['src/hand.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
      });
    });
  });

  describe('staleness', () => {
    test("file-changed-since: an item on core whose file changed after the item's commit is reported stale with both blobs, and the check passes", () => {
      const { repo, oldBlob } = staleRepo();
      try {
        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toHaveLength(1);
        expect(report.stale[0]!.id).toBe('core');
        expect(report.stale[0]!.file).toBe('madarch/model.yaml');
        expect(report.stale[0]!.line).toBe(repo.lineOf('model.yaml', '- file: src/core.ts'));
        expect(report.stale[0]!.message).toContain('src/core.ts');
        expect(report.stale[0]!.message).toContain(oldBlob);
        expect(report.stale[0]!.message).toContain(repo.blob('src/core.ts'));
        expect(report.notes).toEqual([]);

        const atTheModelCommit = checkModel(repo.path, { rev: repo.run(['rev-parse', 'HEAD^']).stdout.trim() });
        expect(atTheModelCommit.stale).toEqual([]);
      } finally {
        rmSync(repo.path, { recursive: true, force: true });
      }
    });

    test("a claim whose document changed after the report was written is reported stale, with the claim's text and the report's line", () => {
      withRepo((repo) => {
        repo.write('docs/architecture.md', 'The backend is one process behind a WebSocket.\n');
        repo.write('src/core.ts', numberedLines(30));
        const commit = repo.commit('the sources and the document');
        const documentBlob = repo.blob('docs/architecture.md', commit);
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview(
          [
            ['The backend is one process behind a WebSocket \\| mostly', 'docs/architecture.md', '', commit, documentBlob, 'docs/architecture.md:1', 'confirmed', 'core'],
            ['The notification folder is gone', 'docs/gone.md', '', commit, blob, '', 'confirmed', 'core'],
          ],
          assigned([['src/core.ts', 'core', ''], ['docs/', 'excluded', 'documentation, read for claims']]),
        );
        repo.commit('the model and its review');
        repo.write('docs/architecture.md', 'The backend is two processes behind a WebSocket.\n');
        repo.commit('the document changes');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toHaveLength(2);
        expect(report.stale[0]!.file).toBe('madarch/review.md');
        expect(report.stale[0]!.line).toBe(repo.lineOf('review.md', '| The backend is one process'));
        expect(report.stale[0]!.message).toContain('The backend is one process behind a WebSocket | mostly');
        expect(report.stale[0]!.message).toContain('docs/architecture.md');
        expect(report.stale[0]!.message).toContain(documentBlob);
        expect(report.stale[0]!.message).toContain(repo.blob('docs/architecture.md'));
        expect(report.stale[1]!.line).toBe(repo.lineOf('review.md', '| The notification folder is gone'));
        expect(report.stale[1]!.message).toContain('file gone');
        expect(report.stale[1]!.message).toContain('docs/gone.md');
      });
    });

    test('a file the checked revision no longer has makes its item stale, reported as file gone', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/core.ts', 'core', '']]));
        repo.commit('the model');
        expect(repo.run(['rm', 'src/core.ts']).ok).toBe(true);
        repo.commit('the file goes');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toHaveLength(1);
        expect(report.stale[0]!.id).toBe('core');
        expect(report.stale[0]!.message).toContain('gone');
        expect(report.stale[0]!.message).toContain(blob);
      });
    });

    test('stale items are sorted by file, then line, then id, whatever order the sections are written in', () => {
      withRepo((repo) => {
        repo.write('src/core.ts', 'export const core = 1;\n');
        const commit = repo.commit('the sources');
        const blob = repo.blob('src/core.ts', commit);
        // relations first, elements last: the walk finds the elements
        // first, the sorted report names the relation's item first
        const yaml = [
          'version: 1',
          '',
          'relations:',
          '  - id: r',
          '    from: e',
          '    to: e2',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
          'elements:',
          '  - id: e',
          '    kind: service',
          '    name: E',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '  - id: e2',
          '    kind: service',
          '    name: E2',
          '    evidence:',
          '      - file: src/core.ts',
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/', 'excluded', 'the sources']]));
        repo.commit('the model');
        repo.write('src/core.ts', 'export const core = 2;\n');
        repo.commit('the file changes');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.stale.map((item) => item.id)).toEqual(['r', 'e', 'e2']);
      });
    });
  });

  describe('assignment', () => {
    test('unassigned-package: files under a folder no row covers fail the check, grouped by folder and named in code-point order', () => {
      withRepo((repo) => {
        repo.write('src/web.ts', 'export const web = 1;\n');
        repo.write('src/core.ts', numberedLines(30));
        repo.write('internal/notify/ping.ts', 'export const ping = 1;\n');
        repo.write('internal/notify/sms.ts', 'export const sms = 1;\n');
        repo.write('src/web.ts.bak', 'backup\n');
        const commit = repo.commit('the sources');
        const webBlob = repo.blob('src/web.ts', commit);
        const blob = repo.blob('src/core.ts', commit);
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
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/web.ts', 'web', ''], ['src/core.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(2);
        expect(report.errors[0]!.file).toBe('internal/notify');
        expect(report.errors[0]!.line).toBe(0);
        expect(report.errors[0]!.message).toBe('no assignment row covers internal/notify/ping.ts, internal/notify/sms.ts');
        expect(report.errors[1]!.file).toBe('src');
        expect(report.errors[1]!.message).toBe('no assignment row covers src/web.ts.bak');
      });
    });

    test('excluded-with-reason: a `docs/` row excluded with a reason keeps every file under docs/ unreported', () => {
      withRepo((repo) => {
        repo.write('docs/architecture.md', 'The backend is one process.\n');
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview(
          [['The backend is one process', 'docs/architecture.md', '', commit, repo.blob('docs/architecture.md', commit), 'docs/architecture.md:1', 'confirmed', 'core']],
          assigned([['src/core.ts', 'core', ''], ['docs/', 'excluded', 'documentation, read for claims']]),
        );
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toEqual([]);
      });
    });

    test("a row naming an element the model does not have fails, naming the row's line in the report", () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/core.ts', 'ghost', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| src/core.ts | ghost |'));
        expect(report.errors[0]!.message).toContain('ghost');
      });
    });

    test("an excluded row without a reason fails, naming the row's line", () => {
      withRepo((repo) => {
        repo.write('docs/readme.md', 'docs\n');
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/core.ts', 'core', ''], ['docs/', 'excluded', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| docs/ | excluded |'));
        expect(report.errors[0]!.message).toContain('docs/');
        expect(report.errors[0]!.message).toContain('reason');
      });
    });

    test("duplicate rows for one path fail, naming the later row's line", () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['src/core.ts', 'core', ''], ['src/core.ts', 'excluded', 'not ours']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| src/core.ts | excluded |'));
        expect(report.errors[0]!.message).toContain('duplicate');
        expect(report.errors[0]!.message).toContain('src/core.ts');
      });
    });

    test('deepest row decides: a folder row internal/ excluded and a deeper internal/core/ to an element cover their files without error', () => {
      withRepo((repo) => {
        repo.write('internal/core/engine.ts', 'export const engine = 1;\n');
        repo.write('internal/legacy.txt', 'legacy\n');
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], assigned([['internal/', 'excluded', 'generated'], ['internal/core/', 'core', ''], ['src/core.ts', 'core', '']]));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toEqual([]);
      });
    });
  });

  describe('the review report', () => {
    test('a compiling model without a review report fails, saying the review is missing', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(0);
        expect(report.errors[0]!.message).toContain('missing');
        expect(report.stale).toEqual([]);
        expect(report.notes).toEqual([]);
      });
    });

    test('a review report that cannot be read is refused as unreadable', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.commit('the model');
        mkdirSync(join(repo.path, 'madarch', 'review.md'));

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('unreadable');
        expect(report.errors[0]!.message).toContain('could not be read');
      });
    });

    test('an assignment row without a path fails, naming the row\'s line', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview([], [['', 'core', ''], ['madarch/', 'excluded', 'the model and its review']]);
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.line).toBe(repo.lineOf('review.md', '|  | core |'));
        expect(refusals[0]!.message).toContain('path');
      });
    });

    test('a section heading followed by prose instead of a table fails, naming the prose line', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          'Whatever prose the report carries here.',
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.line).toBe(repo.lineOf('review.md', 'Whatever prose'));
        expect(refusals[0]!.message).toContain('not followed by a table');
      });
    });

    test('a claims row of another width than its header fails, naming the row line', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |',
          '|---|---|---|---|---|---|---|---|',
          '| only three | cells | here |',
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.line).toBe(repo.lineOf('review.md', '| only three | cells | here |'));
        expect(refusals[0]!.message).toContain('row of 3 cells where its header has 8');
      });
    });

    test('a header row without its trailing pipe is not the decided header', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model',
          '|---|---|---|---|---|---|---|---|',
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.line).toBe(repo.lineOf('review.md', '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model'));
        expect(refusals[0]!.message).toContain('header');
      });
    });

    test('a separator row with a cell that is not dashes is no separator', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |',
          '| --- | --- | --- | --x | --- | --- | --- | --- |',
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.line).toBe(repo.lineOf('review.md', '| --- | --- | --- | --x |'));
        expect(refusals[0]!.message).toContain('separator');
      });
    });

    test('a review without an assignment section fails', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |',
          '|---|---|---|---|---|---|---|---|',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        const refusals = report.errors.filter((error) => error.file === 'madarch/review.md');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.message).toContain('no "## Assignment" section');
      });
    });

    test('a review without a claims section is a note, not an error', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          'Review of the repository.',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.notes).toHaveLength(1);
        expect(report.notes[0]!.message).toContain('Claims');
      });
    });

    test("a claims row with an unknown verdict, and one without a blob, each fail naming the row's line", () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview(
          [
            ['A claim', 'docs/a.md', '', commit, blob, '', 'maybe', 'core'],
            ['Another', 'docs/b.md', '', commit, '', '', 'confirmed', 'core'],
            ['A third', 'docs/c.md', 'x', commit, blob, '', 'confirmed', 'core'],
            ['A fourth', 'docs/d.md', '', 'z' + commit, blob, '', 'confirmed', 'core'],
            ['A fifth', 'docs/e.md', '', commit, blob + 'z', '', 'confirmed', 'core'],
            ['A sixth', 'docs/f.md', '1x2', commit, blob, '', 'confirmed', 'core'],
            ['A seventh', 'docs/g.md', '3-a', commit, blob, '', 'confirmed', 'core'],
            ['An eighth', 'src/core.ts', '5', commit, blob, '', 'confirmed', 'core'],
            ['A ninth', '', '', commit, blob, '', 'confirmed', 'core'],
          ],
          assigned([['src/core.ts', 'core', '']]),
        );
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(8);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| A claim |'));
        expect(report.errors[0]!.message).toContain('verdict');
        expect(report.errors[0]!.message).toContain('maybe');
        expect(report.errors[1]!.line).toBe(repo.lineOf('review.md', '| Another |'));
        expect(report.errors[1]!.message).toContain('Blob');
        expect(report.errors[2]!.line).toBe(repo.lineOf('review.md', '| A third |'));
        expect(report.errors[2]!.message).toContain('lines');
        expect(report.errors[2]!.message).toContain('x');
        expect(report.errors[3]!.line).toBe(repo.lineOf('review.md', '| A fourth |'));
        expect(report.errors[3]!.message).toContain('commit');
        expect(report.errors[4]!.line).toBe(repo.lineOf('review.md', '| A fifth |'));
        expect(report.errors[4]!.message).toContain('blob');
        expect(report.errors[5]!.line).toBe(repo.lineOf('review.md', '| A sixth |'));
        expect(report.errors[5]!.message).toContain('1x2');
        expect(report.errors[6]!.line).toBe(repo.lineOf('review.md', '| A seventh |'));
        expect(report.errors[6]!.message).toContain('3-a');
        expect(report.errors[7]!.line).toBe(repo.lineOf('review.md', '| A ninth |'));
        expect(report.errors[7]!.message).toContain('Document');
        expect(report.stale).toEqual([]);
      });
    });

    test("a table whose header is not the decided columns fails, naming the header's line", () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Doc | Line | Commit | Blob | Checked in code | Verdict | In the model |',
          '|---|---|---|---|---|---|---|---|',
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| Claim | Doc |'));
        expect(report.errors[0]!.message).toContain('header');
      });
    });

    test('a table without a separator row under its header fails, naming the line', () => {
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeModel('review.md', [
          '## Claims',
          '| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |',
          `| a claim | docs/a.md |  | ${commit} | ${blob} |  | confirmed | core |`,
          '',
          '## Assignment',
          '| Path | Element | Reason |',
          '|---|---|---|',
          '| src/core.ts | core | |',
          '| madarch/ | excluded | the model and its review |',
          '',
        ].join('\n'));
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('failed');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.file).toBe('madarch/review.md');
        expect(report.errors[0]!.line).toBe(repo.lineOf('review.md', '| a claim |'));
        expect(report.errors[0]!.message).toContain('separator');
      });
    });

    test('backticks around a path and an escaped pipe inside a cell are read as written', () => {
      withRepo((repo) => {
        repo.write('docs/readme.md', 'readme\n');
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
          `        commit: ${commit}`,
          `        blob: ${blob}`,
          '',
        ].join('\n');
        repo.writeModel('model.yaml', yaml);
        repo.writeReview(
          [['The core is thirty lines', '`docs/readme.md`', '', commit, repo.blob('docs/readme.md', commit), '', 'confirmed', 'core']],
          assigned([['`src/core.ts`', 'core', ''], ['docs/', 'excluded', 'read for claims \\| architecture']]),
        );
        repo.commit('the model');

        const report = checkModel(repo.path);

        expect(report.outcome).toBe('passed');
        expect(report.errors).toEqual([]);
        expect(report.stale).toEqual([]);
      });
    });
  });
});
