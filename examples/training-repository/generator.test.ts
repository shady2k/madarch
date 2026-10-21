import {beforeAll, afterAll, describe, expect, test} from 'bun:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error the plan is plain JavaScript
import {AUTHORS, COMMITS, SNAPSHOTS, TAGGED_FILES} from './history.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const generator = path.join(root, 'generate.mjs');
const key = JSON.parse(await readFile(path.join(root, 'answer-key.json'), 'utf8'));
const EVIDENCE = ['code-fact', 'document-fact', 'history-fact', 'inference'];

type PlanCommit = {id?: string; message: string; author: string; branch?: string; merge?: string; touches?: string[]; committerDate?: string};
const plan = COMMITS as PlanCommit[];

const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}).trim();
const git = (repo: string, ...args: string[]) => sh('git', args, repo);

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name === '.git') continue;
    const file = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if ((await stat(file)).isDirectory()) out.push(...(await walk(file, rel)));
    else out.push(rel);
  }
  return out;
}

let tmp: string;
let a: string;
let b: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'training-'));
  a = path.join(tmp, 'a');
  b = path.join(tmp, 'b');
  sh('node', [generator, a], root);
  sh('node', [generator, b], root);
}, 120_000);
afterAll(async () => {
  await rm(tmp, {recursive: true, force: true});
});

/** The sha of the commit the plan calls `id`, found by its subject in the generated history. */
function shaOf(repo: string, id: string): string {
  const entry = plan.find((c) => c.id === id);
  if (!entry) throw new Error(`history.mjs has no commit ${id}`);
  const hits = git(repo, 'log', '--format=%H%x09%s', 'main').split('\n').filter((l) => l.split('\t')[1] === entry.message.split('\n')[0]);
  if (hits.length !== 1) throw new Error(`${hits.length} commits have the subject of ${id}: ${entry.message}`);
  return hits[0].split('\t')[0];
}

/** Counts from git: non-merge commits reachable from main, by the paths each one changes. */
function gitCounts(repo: string) {
  const log = git(repo, 'log', '--no-merges', '--name-only', '--format=%x00%H', 'main');
  let hotspot = 0, together = 0, pricingOnly = 0, taxOnly = 0;
  for (const block of log.split('\x00').filter(Boolean)) {
    const paths = block.split('\n').slice(1).filter(Boolean);
    if (paths.includes(TAGGED_FILES.hotspot)) hotspot++;
    const p = paths.includes(TAGGED_FILES.pricing), t = paths.includes(TAGGED_FILES.tax);
    if (p && t) together++;
    else if (p) pricingOnly++;
    else if (t) taxOnly++;
  }
  return {hotspot, together, pricingOnly, taxOnly};
}

/** The same counts from the plan's own declarations. */
function planCounts() {
  const real = plan.filter((c) => !c.merge);
  const has = (c: PlanCommit, tag: string) => (c.touches ?? []).includes(tag);
  return {
    hotspot: real.filter((c) => has(c, 'hotspot')).length,
    together: real.filter((c) => has(c, 'pricing') && has(c, 'tax')).length,
    pricingOnly: real.filter((c) => has(c, 'pricing') && !has(c, 'tax')).length,
    taxOnly: real.filter((c) => has(c, 'tax') && !has(c, 'pricing')).length,
  };
}

describe('the generator', () => {
  test('two generations have the same commits and the same tree', () => {
    expect(git(a, 'rev-parse', 'HEAD')).toBe(git(b, 'rev-parse', 'HEAD'));
    expect(git(a, 'rev-parse', 'HEAD^{tree}')).toBe(git(b, 'rev-parse', 'HEAD^{tree}'));
    expect(git(a, 'rev-list', '--all')).toBe(git(b, 'rev-list', '--all'));
  });

  test('the key, the specification, the template and the plan never reach the output', async () => {
    const files = await walk(a);
    for (const banned of ['answer-key.json', 'SPEC.md', 'history.mjs', 'generate.mjs', 'generator.test.ts']) {
      expect(files, `${banned} in the output`).not.toContain(banned);
    }
    expect(files.some((f) => f.startsWith('template/'))).toBe(false);
    for (const f of files) expect((await readFile(path.join(a, f), 'utf8')).includes('@@ since'), `${f} still holds a directive`).toBe(false);
    expect(git(a, 'status', '--porcelain')).toBe('');
  });

  test('the output holds exactly the commits of the plan, by the three authors', () => {
    expect(Number(git(a, 'rev-list', '--count', 'main'))).toBe(plan.length);
    expect([...new Set(git(a, 'log', '--format=%an <%ae>', 'main').split('\n'))].sort()).toEqual(
      Object.values(AUTHORS as Record<string, {name: string; email: string}>).map((x) => `${x.name} <${x.email}>`).sort(),
    );
    const subjects = git(a, 'log', '--format=%s', 'main').split('\n');
    for (const c of plan) {
      const subject = c.message.split('\n')[0];
      expect(subjects, subject).toContain(subject);
      expect(subject, 'a task key at the start').toMatch(/^[A-Z]{3}-\d+ /);
    }
  });

  test('one feature branch is merged into main and main reads first-parent', () => {
    const merges = git(a, 'log', '--merges', '--format=%H', 'main').split('\n').filter(Boolean);
    expect(merges).toHaveLength(1);
    const [first, second] = git(a, 'rev-list', '--parents', '-n', '1', merges[0]).split(' ').slice(1);
    const branchCommits = git(a, 'rev-list', `${first}..${second}`).split('\n').filter(Boolean);
    expect(branchCommits.length).toBe(plan.filter((c) => c.branch).length);
    expect(git(a, 'branch', '--list').replace('*', '').trim()).toBe('main');
    expect(Number(git(a, 'rev-list', '--count', '--first-parent', 'main'))).toBe(plan.length - branchCommits.length);
  });

  test('the order aggregate moves under internal/domain with its content kept', () => {
    const renames = git(a, 'log', '-M', '--diff-filter=R', '--name-status', '--format=', 'main').split('\n').filter(Boolean);
    expect(renames).toEqual(['R100\tservices/orders/src/order.go\tservices/orders/internal/domain/order.go']);
    const follow = git(a, 'log', '--follow', '--format=%s', '--', 'services/orders/internal/domain/order.go').split('\n');
    expect(follow).toContain(plan.find((c) => c.id === 'aggregate')!.message.split('\n')[0]);
  });

  test('exactly one commit has a committer date earlier than its parent', () => {
    const rows = git(a, 'log', '--format=%H %ct %P', 'main').split('\n').map((r) => r.split(' '));
    const times = new Map(rows.map((r) => [r[0], Number(r[1])]));
    const early = rows.filter((r) => r.slice(2).some((p) => times.get(p)! > Number(r[1])));
    const sha = shaOf(a, 'pin-toolchain');
    expect(early.map((r) => r[0])).toEqual([sha]);
    expect(Number(git(a, 'log', '-1', '--format=%at', sha))).toBeGreaterThan(times.get(sha)!);
  });

  test('payments/src/providers is written by one author', () => {
    expect([...new Set(git(a, 'log', '--format=%an', 'main', '--', 'services/payments/src/providers').split('\n'))]).toEqual(['Rin Tanaka']);
  });
});

describe('the answer key', () => {
  test('its snapshots are the commits the plan names', () => {
    expect(Object.keys(key.snapshots).sort()).toEqual(Object.keys(SNAPSHOTS).sort());
    for (const [name, id] of Object.entries(SNAPSHOTS as Record<string, string>)) {
      expect(key.snapshots[name], name).toBe(shaOf(a, id));
    }
    expect(key.snapshots['snapshot-final']).toBe(git(a, 'rev-parse', 'main'));
  });

  test('planted counts match the plan and git', async () => {
    const fromGit = gitCounts(a);
    expect(fromGit).toEqual(planCounts());
    expect(key.plantedCounts.hotspotCommits).toBe(fromGit.hotspot);
    expect(key.plantedCounts.pricingTogether).toBe(fromGit.together);
    expect(key.plantedCounts.pricingOnly).toBe(fromGit.pricingOnly);
    expect(key.plantedCounts.taxOnly).toBe(fromGit.taxOnly);
    expect(key.plantedCounts.commits).toBe(plan.length);
    expect(key.plantedCounts.firstParentCommits).toBe(Number(git(a, 'rev-list', '--count', '--first-parent', 'main')));
    expect(key.plantedCounts.mergeCommits).toBe(1);
    const large = await readFile(path.join(a, 'services/payments/src/api/legacy-report.ts'), 'utf8');
    expect(key.plantedCounts.largeFileLines).toBe(large.split('\n').length - 1);
    expect(key.plantedCounts.largeFileLines).toBeGreaterThanOrEqual(700);
  });

  test('every item is complete and every location resolves at its snapshot', () => {
    const ids = new Set<string>();
    expect(key.items.length).toBeGreaterThan(120);
    for (const item of key.items) {
      expect(ids.has(item.id), `duplicate id ${item.id}`).toBe(false);
      ids.add(item.id);
      expect(EVIDENCE, item.id).toContain(item.evidenceClass);
      expect(typeof item.requiredNow, item.id).toBe('boolean');
      expect(item.viewpoints.length, item.id).toBeGreaterThan(0);
      expect(item.expectedWikiStatement.length, item.id).toBeGreaterThan(10);
      for (const field of ['readerTask', 'mustShow', 'mustLink', 'mustNotClaim']) expect(item.judge[field], `${item.id} judge.${field}`).toBeDefined();
      expect(item.judge.mustShow.length, `${item.id} mustShow`).toBeGreaterThan(0);
      const locations = item.locations ?? [item.location];
      expect(locations.length, item.id).toBeGreaterThan(0);
      for (const loc of locations) {
        const sha = key.snapshots[loc.snapshot];
        expect(sha, `${item.id}: snapshot ${loc.snapshot}`).toBeDefined();
        let text: string;
        try {
          text = git(a, 'show', `${sha}:${loc.path}`);
        } catch {
          throw new Error(`${item.id}: ${loc.path} does not exist at ${loc.snapshot}`);
        }
        for (const needle of [loc.symbol, loc.anchor].filter(Boolean)) {
          expect(text.includes(needle), `${item.id}: "${needle}" not found in ${loc.path} at ${loc.snapshot}`).toBe(true);
        }
      }
    }
  });

  test('items that name an absence or a change hold at their snapshot', () => {
    let checked = 0;
    const exists = (sha: string, p: string) => {
      try {
        git(a, 'cat-file', '-e', `${sha}:${p}`);
        return true;
      } catch {
        return false;
      }
    };
    for (const item of key.items) {
      for (const check of item.checks ?? []) {
        checked++;
        const sha = key.snapshots[check.snapshot];
        if (check.absent) expect(exists(sha, check.path), `${item.id}: ${check.path} should not exist at ${check.snapshot}`).toBe(false);
        if (check.differsFromFinal) {
          expect(exists(sha, check.path), `${item.id}: ${check.path} should exist at ${check.snapshot}`).toBe(true);
          expect(git(a, 'show', `${sha}:${check.path}`), `${item.id}: ${check.path} reads the same at ${check.snapshot} and at the end`).not.toBe(
            git(a, 'show', `${key.snapshots['snapshot-final']}:${check.path}`),
          );
        }
        if (check.notContains) expect(git(a, 'show', `${sha}:${check.path}`).includes(check.notContains), `${item.id}: ${check.path} should not contain ${check.notContains}`).toBe(false);
        if (check.contains) expect(git(a, 'show', `${sha}:${check.path}`).includes(check.contains), `${item.id}: ${check.contains}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('the generated repository', () => {
  test('TypeScript files parse, JSON files are JSON, locks are lockfile v3 and go.sum lines are well formed', async () => {
    const files = await walk(a);
    const transpiler = new Bun.Transpiler({loader: 'ts'});
    for (const f of files.filter((f) => f.endsWith('.ts'))) transpiler.transformSync(await readFile(path.join(a, f), 'utf8'));
    for (const f of files.filter((f) => f.endsWith('package.json') || f.endsWith('package-lock.json'))) JSON.parse(await readFile(path.join(a, f), 'utf8'));
    for (const f of files.filter((f) => f.endsWith('package-lock.json'))) {
      const lock = JSON.parse(await readFile(path.join(a, f), 'utf8'));
      expect(lock.lockfileVersion, f).toBe(3);
      expect(Object.keys(lock.packages).length, f).toBeGreaterThan(50);
    }
    for (const f of files.filter((f) => f.endsWith('go.sum'))) {
      for (const line of (await readFile(path.join(a, f), 'utf8')).split('\n').filter(Boolean)) {
        expect(line, `${f}: ${line}`).toMatch(/^\S+ v\S+(\/go\.mod)? h1:[A-Za-z0-9+/]{43}=$/);
      }
    }
  });

  test('formatInvoiceLegacy is defined once and referenced nowhere else', async () => {
    const hits: string[] = [];
    for (const f of await walk(a)) if ((await readFile(path.join(a, f), 'utf8')).includes('formatInvoiceLegacy')) hits.push(f);
    expect(hits).toEqual(['services/payments/src/format.ts']);
  });

  test('the dependency counts of the key match the lock files', async () => {
    const expected = key.plantedCounts.dependencies as Record<string, {direct: number; dev: number; packages: number; devOnlyPackages: number}>;
    for (const [service, want] of Object.entries(expected)) {
      const pkg = JSON.parse(await readFile(path.join(a, 'services', service, 'package.json'), 'utf8'));
      const lock = JSON.parse(await readFile(path.join(a, 'services', service, 'package-lock.json'), 'utf8'));
      const packages = Object.entries(lock.packages as Record<string, {dev?: boolean}>).filter(([k]) => k !== '');
      expect(Object.keys(pkg.dependencies).length, `${service} direct`).toBe(want.direct);
      expect(Object.keys(pkg.devDependencies).length, `${service} dev`).toBe(want.dev);
      expect(packages.length, `${service} packages`).toBe(want.packages);
      expect(packages.filter(([, p]) => p.dev).length, `${service} dev-only packages`).toBe(want.devOnlyPackages);
    }
  });
});
