/**
 * What the wiki reads from the product repository before it draws anything
 * (decision 0029; the vertical's shared formats, sections 1 and 2): the kinds
 * manifest, the page template, a Markdown entity and its body, and the starter
 * set `madarch init` seeds. A refusal names the file and the line; nothing is
 * dropped without being said.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeKind, parseKinds, readKinds } from '../src/product/manifest/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { CATALOG_KIND_FILES } from '../src/knowledge/catalog-starter.js';
import { BUNDLED_PLUGINS } from '../src/plugin/bundled.js';
import { byCodePoint } from '../src/model/order.js';
import { createDraft } from '../src/product/draft.js';
import { gitEnv } from './git-env.js';

const folders: string[] = [];
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-knowledge-parse-'));
  folders.push(folder);
  return folder;
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function put(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('the kinds manifest', () => {
  test('a manifest is read into its kinds, with the home the first kind that is one file', () => {
    const root = scratch();
    put(root, 'templates/a.md', ':::body\n');
    put(root, 'templates/b.md', 'text\n');
    const manifest = parseKinds([
      'kinds:',
      '  domain: { template: templates/a.md, source: markdown, folder: docs/domains }',
      '  product: { template: templates/a.md, source: markdown, file: docs/product.md }',
      '  code.thing:',
      '    template: templates/b.md',
      '    source: graph',
      '    title: name',
      '    attributes: [name, language]',
      '    relations:',
      '      - { type: code.contains, to: "code.package:{span.path|dirname}" }',
      '',
    ].join('\n'), 'madarch/catalog.yaml', root);
    expect(manifest.findings).toEqual([]);
    expect([...manifest.kinds.keys()]).toEqual(['domain', 'product', 'code.thing']);
    expect(manifest.kinds.get('code.thing')).toMatchObject({ source: 'graph', title: 'name', attributes: ['name', 'language'], relations: [{ type: 'code.contains', to: 'code.package:{span.path|dirname}' }] });
    expect(manifest.kinds.get('domain')!.title).toBe('label');
    expect(homeKind(manifest)!.name).toBe('product');
  });

  test('every mistake is a finding with the file and the line, and the other kinds still stand', () => {
    const root = scratch();
    put(root, 'templates/a.md', 'x\n');
    const text = [
      'kinds:', // 1
      '  good: { template: templates/a.md, source: graph }', // 2
      '  nosource: { template: templates/a.md }', // 3
      '  missing: { template: templates/none.md, source: graph }', // 4
      '  climbing: { template: ../outside.md, source: graph }', // 5
      '  both: { template: templates/a.md, source: markdown, file: a.md, folder: b }', // 6
      '  neither: { template: templates/a.md, source: markdown }', // 7
      '  stray: { template: templates/a.md, source: graph, colour: red }', // 8
      '  graphfolder: { template: templates/a.md, source: graph, folder: docs }', // 9
      'extra: 1', // 10
    ].join('\n');
    const manifest = parseKinds(text, 'madarch/catalog.yaml', root);
    expect([...manifest.kinds.keys()]).toEqual(['good']);
    expect(manifest.findings.map((finding) => [finding.line, finding.message])).toEqual([
      [10, '"extra" is not a field of the manifest: the manifest holds "kinds", "edges", "plugins", "groups", "purposes", "documents", "roles", "problems", "properties", "catalog", "mapping", "language", "diagram" and "journal"'],
      [3, 'kind "nosource": "source" is "graph", "markdown" or "document", got undefined'],
      [4, 'kind "missing": the template "templates/none.md" does not exist in the product repository'],
      [5, 'kind "climbing": the template "../outside.md" is not a path inside the product repository'],
      [6, 'kind "both": a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)'],
      [7, 'kind "neither": a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)'],
      [8, 'kind "stray": "colour" is not a field of a kind: the fields are purpose, audience, facts, template, source, folder, file, import-folder, import-file, title, attributes, relations, labels, group, origin, description, identifier, terms, headings, semantics, structure, details, member, card, history, findings, views, er, sequence, system, definition-block, listing, nav, fields, key, capability, depends-on, id, definition, sources, acquisition, status, relation-constraints, template-policy'],
      [9, 'kind "graphfolder": a graph kind has no "folder" or "file": its entities come from the graph'],
    ]);
    expect(manifest.findings.every((finding) => finding.file === 'madarch/catalog.yaml')).toBe(true);
  });

  test('YAML that does not parse is one finding at its line, and no kind is guessed', () => {
    const manifest = parseKinds('kinds:\n  a: [unclosed\n', 'madarch/catalog.yaml', scratch());
    expect(manifest.kinds.size).toBe(0);
    expect(manifest.findings).toHaveLength(1);
    expect(manifest.findings[0]!.line).toBeGreaterThanOrEqual(2);
  });

  test('a product with no manifest is absent, not broken', () => {
    expect(readKinds(scratch())).toMatchObject({ present: false });
  });
});

describe('the starter set madarch init seeds', () => {
  test('a new product holds the manifest and the starter templates, the manifest reads without a finding and the authored starter files match their packaged content', async () => {
    const home = scratch();
    const draft = createDraft({ home, name: 'seeded', gitEnv: gitEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' }) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    // The starter set of both changes: the document task page and the history task page are two templates of one name
    // (`task.liquid` for the document, `history-task.liquid` for the graph's task), so both stand in the list
    // (madarch-m38l.16). The base page and the partials come first: every kind extends the base (decision 0032).
    expect(STARTER_FILES.map((file) => file.path).sort(byCodePoint)).toEqual(['madarch/catalog.yaml', ...Object.values(CATALOG_KIND_FILES).map((path) => `madarch/kinds/${path}`), 'madarch/plugins.lock', 'madarch/workflows.yaml',
      ...BUNDLED_PLUGINS.flatMap((plugin) => plugin.files.map((file) => `${plugin.folder}/${file.path}`)),
      'templates/entity.liquid',
      'templates/partials/around.liquid', 'templates/partials/pages-about.liquid', 'templates/partials/source.liquid',
      'templates/partials/relations.liquid', 'templates/partials/history.liquid',
      ...[
        'product', 'domain', 'dismissal', 'guide', 'service', 'package', 'module', 'file', 'repository', 'directory', 'symbol', 'route', 'item', 'item-plain', 'contract', 'operation',
        'history-task', 'commit', 'author', 'database', 'table', 'entity-text', 'enrichment', 'term', 'question', 'correction', 'task', 'test-quarantine',
      ].map((name) => `templates/${name}.liquid`)].sort(byCodePoint));
    for (const file of STARTER_FILES) {
      if (file.bytes !== undefined) expect(readFileSync(join(draft.folder, file.path))).toEqual(Buffer.from(file.bytes));
      else expect(readFileSync(join(draft.folder, file.path), 'utf8')).toBe(file.content);
    }
    const read = readKinds(draft.folder);
    if (!read.present) throw new Error('the seeded manifest is absent');
    expect(read.manifest.findings).toEqual([]);
    expect([...read.manifest.kinds.keys()]).toEqual(expect.arrayContaining(['product', 'domain']));
    expect([...read.manifest.kinds.keys()]).toEqual(expect.arrayContaining(['doc.use-case', 'doc.rule', 'doc.decision', 'doc.term', 'code.service', 'code.module', 'code.file', 'code.symbol', 'code.route', 'code.table', 'code.env-var', 'code.ci-job', 'code.test-case']));
    expect(homeKind(read.manifest)?.name).toBe('product');
    expect(read.manifest.kinds.get('product')?.source).toBe('graph');

  });

  test('the starter files carry no engine page: they are the product\'s own text, committed with the draft', () => {
    const home = scratch();
    const draft = createDraft({ home, name: 'committed', gitEnv: gitEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' }) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: draft.folder, env: gitEnv() }).stdout.toString().split('\n');
    for (const file of STARTER_FILES) expect(tracked).toContain(file.path);
  });
});
