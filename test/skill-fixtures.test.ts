import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModel } from '../src/check/model-check.js';
import { buildSkillFixtures, type SkillFixtures } from './skill-fixtures/build.js';

/**
 * The skill fixture repositories (madarch-utk.2.2): two small git
 * repositories the agent skill is run on next, one whose architecture
 * document went stale when the code replaced its config module with a
 * settings folder, one whose notify package no document mentions. The
 * builder is the thing under test; every test builds its own pair into
 * a fresh temporary folder and reads the result back off the git
 * repositories.
 */

const BUILDER = fileURLToPath(new URL('./skill-fixtures/build.ts', import.meta.url));

/** Builds the fixtures into a fresh temporary folder and removes the folder afterwards. */
function withFixtures(run: (fixtures: SkillFixtures) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-skill-fixtures-'));
  try {
    run(buildSkillFixtures(folder));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Every path the repository's HEAD tracks. */
function tracked(repo: string): string[] {
  const run = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  expect(run.status).toBe(0);
  return (run.stdout ?? '').split('\n').filter((path) => path.length > 0);
}

/** The subjects of every commit, oldest first. */
function history(repo: string): string[] {
  const run = spawnSync('git', ['log', '--format=%s', '--reverse'], { cwd: repo, encoding: 'utf8' });
  expect(run.status).toBe(0);
  return (run.stdout ?? '').split('\n').filter((line) => line.length > 0);
}

/** The repository's HEAD commit. */
function head(repo: string): string {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  expect(run.status).toBe(0);
  return (run.stdout ?? '').trim();
}

/** The repository's README and every document under docs/, read whole. */
function prose(repo: string): string {
  const documents = ['README.md', ...tracked(repo).filter((path) => path.startsWith('docs/') && path.endsWith('.md'))];
  return documents.map((document) => readFileSync(join(repo, document), 'utf8')).join('\n').toLowerCase();
}

describe('the skill fixture repositories', () => {
  test('the same build twice gives the same commit hashes', () => {
    withFixtures((first) => {
      withFixtures((second) => {
        expect(head(first.staleDocument)).toBe(head(second.staleDocument));
        expect(head(first.undocumentedPackage)).toBe(head(second.undocumentedPackage));
        expect(head(first.staleDocument)).not.toBe(head(first.undocumentedPackage));
      });
    });
  });

  test('each repository is a small application with a short history', () => {
    withFixtures((fixtures) => {
      for (const repo of [fixtures.staleDocument, fixtures.undocumentedPackage]) {
        const paths = tracked(repo);
        expect(paths.length).toBeGreaterThanOrEqual(8);
        expect(paths.length).toBeLessThanOrEqual(15);
        expect(paths).toContain('README.md');
        expect(paths).toContain('docs/architecture.md');
        expect(paths.filter((path) => path.startsWith('docs/decisions/') && path.endsWith('.md'))).toHaveLength(1);
        const commits = history(repo);
        expect(commits.length).toBeGreaterThanOrEqual(3);
        expect(commits.length).toBeLessThanOrEqual(5);
      }
    });
  });

  test('the stale document names the config module the code no longer has', () => {
    withFixtures((fixtures) => {
      const document = readFileSync(join(fixtures.staleDocument, 'docs/architecture.md'), 'utf8');
      expect(document).toContain('config module');
      expect(document).toContain('src/config/');
      expect(document).not.toContain('src/settings');
      const paths = tracked(fixtures.staleDocument);
      expect(paths.some((path) => path.startsWith('src/config/'))).toBe(false);
      expect(paths.some((path) => path.startsWith('src/settings/'))).toBe(true);
      // Everything else the document says is true: the modules it names exist.
      for (const module of ['src/core.ts', 'src/router.ts', 'src/store.ts', 'src/handlers/books.ts']) {
        expect(paths).toContain(module);
      }
    });
  });

  test('the notify package is there, core imports it, and no document mentions it', () => {
    withFixtures((fixtures) => {
      const paths = tracked(fixtures.undocumentedPackage);
      expect(paths.some((path) => path.startsWith('src/notify/'))).toBe(true);
      const core = readFileSync(join(fixtures.undocumentedPackage, 'src/core.ts'), 'utf8');
      expect(core).toContain('./notify/');
      const documents = prose(fixtures.undocumentedPackage);
      expect(documents).not.toContain('notify');
      // The documents do describe every other module.
      for (const module of ['src/core.ts', 'src/router.ts', 'src/store.ts', 'src/handlers/entries.ts']) {
        expect(documents).toContain(module);
      }
    });
  });

  test('neither repository has a madarch folder', () => {
    withFixtures((fixtures) => {
      expect(existsSync(join(fixtures.staleDocument, 'madarch'))).toBe(false);
      expect(existsSync(join(fixtures.undocumentedPackage, 'madarch'))).toBe(false);
    });
  });

  test('the model check reports both repositories unreadable for the missing madarch folder', () => {
    withFixtures((fixtures) => {
      for (const repo of [fixtures.staleDocument, fixtures.undocumentedPackage]) {
        const report = checkModel(repo);
        expect(report.outcome).toBe('unreadable');
        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]!.message).toContain('madarch folder');
      }
    });
  });

  test('building into a non-empty folder is refused, naming it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-skill-fixtures-'));
    try {
      writeFileSync(join(folder, 'occupied'), 'x');
      let message = '';
      try {
        buildSkillFixtures(folder);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('not empty');
      expect(message).toContain(folder);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('the builder also runs as a script', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-skill-fixtures-'));
    try {
      const built = spawnSync(process.execPath, [BUILDER, folder], { encoding: 'utf8' });
      expect(built.status).toBe(0);
      expect(built.stdout).toContain(join(folder, 'stale-document'));
      const refused = spawnSync(process.execPath, [BUILDER, folder], { encoding: 'utf8' });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(folder);
      const withoutInput = spawnSync(process.execPath, [BUILDER], { encoding: 'utf8' });
      expect(withoutInput.status).toBe(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('the build ignores the machine\'s git configuration and environment', () => {
    withFixtures((sealed) => {
      const folder = mkdtempSync(join(tmpdir(), 'madarch-skill-fixtures-'));
      try {
        // A global config with another identity and signing on, a foreign
        // GIT_DIR and index: the builder must seal all of it, and build
        // the same commits the sealed default environment builds.
        const config = join(folder, 'poison.gitconfig');
        writeFileSync(config, '[user]\n\tname = Poison\n\temail = poison@example.com\n[commit]\n\tgpgsign = true\n');
        const run = spawnSync(process.execPath, [BUILDER, join(folder, 'built')], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
            GIT_DIR: join(folder, 'elsewhere.git'),
            GIT_INDEX_FILE: join(folder, 'elsewhere.index'),
          },
        });
        expect(run.status, run.stderr).toBe(0);
        expect(head(join(folder, 'built', 'stale-document'))).toBe(head(sealed.staleDocument));
        expect(head(join(folder, 'built', 'undocumented-package'))).toBe(head(sealed.undocumentedPackage));
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  });
});
