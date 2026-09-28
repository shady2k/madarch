import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModel, CLAIMS_COLUMNS, ASSIGNMENT_COLUMNS } from '../src/check/model-check.js';
import { gitEnv } from './git-env.js';

export { checkModel };

export const SCRIPT = fileURLToPath(new URL('../scripts/check-model.ts', import.meta.url));

/** Runs the check's script the way a person does, from a shell. */
export function runScript(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/**
 * The git repository fixture the model check's tests build their
 * repositories with (test/model-check.test.ts and
 * test/model-check-problems.test.ts share it): one fixed identity and
 * moment, so tests never depend on the machine's git config or the clock.
 */
export const GIT_IDENTITY = ['-c', 'user.name=Model Check', '-c', 'user.email=check@example.com', '-c', 'commit.gpgsign=false'];
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Model Check',
  GIT_AUTHOR_EMAIL: 'check@example.com',
  GIT_COMMITTER_NAME: 'Model Check',
  GIT_COMMITTER_EMAIL: 'check@example.com',
  GIT_AUTHOR_DATE: '1756728000 +0000',
  GIT_COMMITTER_DATE: '1756728000 +0000',
};

/** The review report's table columns, the shape the skill writes; re-exported from the check, which parses them strictly. */
export { CLAIMS_COLUMNS, ASSIGNMENT_COLUMNS };

/** A tiny git repository a test builds step by step; removed when the test is over. */
export class Repo {
  readonly path: string;
  private readonly yaml = new Map<string, string>();

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'madarch-model-check-'));
    this.run(['init', '-b', 'main', '--quiet']);
  }

  run(args: string[]): { ok: boolean; stdout: string } {
    const run = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: this.path, encoding: 'utf8', env: gitEnv(GIT_ENV) });
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

  /** Commits at a given moment (`git`'s own date format), so a test can place commits inside and outside a window. */
  commitAt(message: string, when: string): string {
    expect(this.run(['add', '-A']).ok).toBe(true);
    const run = spawnSync('git', [...GIT_IDENTITY, 'commit', '--quiet', '-m', message], {
      cwd: this.path,
      encoding: 'utf8',
      env: gitEnv({ ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }),
    });
    expect(run.status).toBe(0);
    return this.run(['rev-parse', 'HEAD']).stdout.trim();
  }

  /** The blob id `file` has at `commit` (default HEAD). */
  blob(file: string, commit = 'HEAD'): string {
    return this.run(['rev-parse', `${commit}:${file}`]).stdout.trim();
  }

  /** Writes madarch/review.md with the given claims and assignment rows, keeping its text so tests can read line numbers off it. */
  writeReview(claims: string[][], assignment: string[][]): void {
    const table = (columns: string[], rows: string[][]): string => [
      `| ${columns.join(' | ')} |`,
      `|${columns.map(() => '---').join('|')}|`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');
    this.writeModel('review.md', ['## Claims', '', table(CLAIMS_COLUMNS, claims), '', '## Assignment', '', table(ASSIGNMENT_COLUMNS, assignment), ''].join('\n'));
  }
}

/** Assignment rows covering a fixture: each named path to its element, the model folder excluded. */
export function assigned(rows: string[][]): string[][] {
  return [...rows, ['madarch/', 'excluded', 'the model and its review']];
}

export function withRepo(run: (repo: Repo) => void): void {
  const repo = new Repo();
  try {
    run(repo);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
}

/** A file of `count` numbered lines, each ending with a newline. */
export function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('');
}

/** A repository whose model is complete and correct: two elements, an interface and a named relation, all with resolving evidence. */
export function completeRepo(): Repo {
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
  repo.writeReview(
    [
      ['The core is thirty lines of TypeScript', 'src/core.ts', '', commit, coreBlob, 'src/core.ts:1-30', 'confirmed', 'core'],
      ['The web fronts the core', 'src/web.ts', '', commit, webBlob, 'src/web.ts:1', 'contradicted', 'web'],
      ['The web is planned to move', 'src/web.ts', '', commit, webBlob, 'src/web.ts:1', 'planned', 'web'],
      ['The web reads as stale prose', 'src/web.ts', '', commit, webBlob, 'src/web.ts:1', 'stale', 'web'],
      ['The web is unconfirmed talk', 'src/web.ts', '', commit, webBlob, 'src/web.ts:1', 'unconfirmed', 'web'],
    ],
    assigned([
      ['src/web.ts', 'web', ''],
      ['src/core.ts', 'core', ''],
    ]),
  );
  repo.commit('the model');
  return repo;
}
