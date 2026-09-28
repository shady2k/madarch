import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assigned, checkModel, Repo, runScript } from './model-check-repo.js';

/**
 * The model check's views requirement (docs/changes/agent-model/
 * capabilities/model-check.md, views-rendered): when the check is asked
 * for views and the model compiles, the folder it is given holds the
 * landscape page, one page per element with children and the LikeC4
 * workspace; the same repository checked twice renders byte-identical
 * files; a page whose view is gone is removed; without the folder nothing
 * is written anywhere; a model that does not compile writes nothing.
 */

/**
 * A repository whose model is one system holding two services, one of
 * which holds two modules, with one relation from the one service to the
 * other: every element and the relation carry resolving evidence, and the
 * review's assignment covers every tracked file.
 */
function shopRepo(): Repo {
  const repo = new Repo();
  repo.write('src/web.ts', 'export const web = 1;\n');
  repo.write('src/core.ts', 'export const core = 1;\n');
  repo.write('src/orders.ts', 'export const orders = 1;\n');
  repo.write('src/billing.ts', 'export const billing = 1;\n');
  const commit = repo.commit('the sources');
  const evidence = (file: string): string[] => [
    '    evidence:',
    `      - file: ${file}`,
    `        commit: ${commit}`,
    `        blob: ${repo.blob(file, commit)}`,
  ];
  const element = (id: string, kind: string, name: string, parent: string | undefined, file: string): string[] => [
    `  - id: ${id}`,
    `    kind: ${kind}`,
    `    name: ${name}`,
    ...(parent === undefined ? [] : [`    parent: ${parent}`]),
    ...evidence(file),
  ];
  const yaml = [
    'version: 1',
    '',
    'elements:',
    ...element('shop', 'system', 'Shop', undefined, 'src/core.ts'),
    ...element('web', 'service', 'Web', 'shop', 'src/web.ts'),
    ...element('core', 'service', 'Core', 'shop', 'src/core.ts'),
    ...element('orders', 'module', 'Orders', 'core', 'src/orders.ts'),
    ...element('billing', 'module', 'Billing', 'core', 'src/billing.ts'),
    '',
    'relations:',
    '  - id: web-calls-core',
    '    name: Places orders on the core',
    '    from: web',
    '    to: core',
    ...evidence('src/web.ts'),
    '',
  ].join('\n');
  repo.writeModel('model.yaml', yaml);
  repo.writeReview(
    [],
    assigned([
      ['src/web.ts', 'web', ''],
      ['src/core.ts', 'core', ''],
      ['src/orders.ts', 'orders', ''],
      ['src/billing.ts', 'billing', ''],
    ]),
  );
  repo.commit('the model');
  return repo;
}

/** Runs the shop fixture's repository, removing it when the test is over. */
function withShopRepo(run: (repo: Repo) => void): void {
  const repo = shopRepo();
  try {
    run(repo);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
}

/** Every file below `folder`, as `relative path -> content` pairs, in code-point order. */
function treeOf(folder: string): [string, string][] {
  const files: [string, string][] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
      else files.push([`${prefix}${entry}`, readFileSync(path, 'utf8')]);
    }
  };
  walk(folder, '');
  return files;
}

/** A fresh views folder that does not exist yet, inside a temporary parent the test removes. */
function viewsFolder(): { base: string; views: string } {
  const base = mkdtempSync(join(tmpdir(), 'madarch-check-views-'));
  return { base, views: join(base, 'views') };
}

describe("the model check's views", () => {
  test('views-rendered: the folder holds the landscape page, one page per element with children and the workspace', () => {
    withShopRepo((repo) => {
      const { base, views } = viewsFolder();
      try {
        const report = checkModel(repo.path, { views });

        expect(report.outcome).toBe('passed');
        expect(readdirSync(join(views, 'mermaid')).sort()).toEqual(['_landscape.md', 'core.md', 'shop.md']);
        const landscape = readFileSync(join(views, 'mermaid', '_landscape.md'), 'utf8');
        expect(landscape).toContain('flowchart LR');
        expect(landscape).toContain('Shop');
        const shop = readFileSync(join(views, 'mermaid', 'shop.md'), 'utf8');
        expect(shop).toContain('Web');
        expect(shop).toContain('Core');
        const core = readFileSync(join(views, 'mermaid', 'core.md'), 'utf8');
        expect(core).toContain('Orders');
        expect(core).toContain('Billing');
        const workspace = readFileSync(join(views, 'likec4', 'model.c4'), 'utf8');
        expect(workspace).toContain('shop = system "Shop"');
        expect(workspace).toContain('orders = module "Orders"');
        expect(report.notes).toHaveLength(1);
        expect(report.notes[0]!.message).toContain('3 view pages');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  test('checking the same repository twice renders byte-identical files, whatever the clock says', () => {
    withShopRepo((repo) => {
      const { base, views } = viewsFolder();
      try {
        checkModel(repo.path, { views });
        const first = treeOf(views);
        expect(first.length).toBeGreaterThan(0);

        checkModel(repo.path, { views });

        expect(treeOf(views)).toEqual(first);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  test("a page whose view is gone is removed by a later run; the caller's own files stay", () => {
    withShopRepo((repo) => {
      const { base, views } = viewsFolder();
      try {
        mkdirSync(join(views, 'mermaid'), { recursive: true });
        writeFileSync(join(views, 'mermaid', 'gone.md'), '# A view that no longer exists\n');
        writeFileSync(join(views, 'mermaid', 'notes.txt'), 'not a page\n');

        checkModel(repo.path, { views });

        expect(existsSync(join(views, 'mermaid', 'gone.md'))).toBe(false);
        expect(existsSync(join(views, 'mermaid', 'notes.txt'))).toBe(true);
        expect(readdirSync(join(views, 'mermaid')).sort()).toEqual(['_landscape.md', 'core.md', 'notes.txt', 'shop.md']);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  test('without views nothing is written anywhere', () => {
    withShopRepo((repo) => {
      const { base } = viewsFolder();

      const report = checkModel(repo.path);

      expect(report.outcome).toBe('passed');
      expect(readdirSync(base)).toEqual([]);
    });
  });

  test('a model that does not compile writes nothing', () => {
    const repo = new Repo();
    try {
      repo.writeModel('model.yaml', ['version: 1', '', 'elements:', '  - id: billing-web', '    kind: service', '    name: Billing web', '    parent: billing', ''].join('\n'));
      repo.commit('the model');
      const { base, views } = viewsFolder();
      try {
        const report = checkModel(repo.path, { views });

        expect(report.outcome).toBe('failed');
        expect(report.errors[0]!.message).toContain('billing');
        expect(existsSync(views)).toBe(false);
        expect(readdirSync(base)).toEqual([]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('the script writes the views when --views names a folder, and exits 0', () => {
    withShopRepo((repo) => {
      const { base, views } = viewsFolder();
      try {
        const run = runScript(repo.path, '--views', views);

        expect(run.status).toBe(0);
        expect(readdirSync(join(views, 'mermaid')).sort()).toEqual(['_landscape.md', 'core.md', 'shop.md']);
        expect(existsSync(join(views, 'likec4', 'model.c4'))).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
