/**
 * What the wiki reads from the product repository before it draws anything
 * (decision 0029; the vertical's shared formats, sections 1 and 2): the kinds
 * manifest, the page template, a Markdown entity and its body, and the starter
 * set `madarch new` seeds. A refusal names the file and the line; nothing is
 * dropped without being said.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeKind, parseKinds, readKinds } from '../src/knowledge/kinds.js';
import { parseTarget, readBody, readMarkdownEntities, splitFrontMatter } from '../src/knowledge/markdown.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { parseTemplate, substitute } from '../src/knowledge/template.js';
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
    ].join('\n'), 'madarch/kinds.yaml', root);
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
    const manifest = parseKinds(text, 'madarch/kinds.yaml', root);
    expect([...manifest.kinds.keys()]).toEqual(['good']);
    expect(manifest.findings.map((finding) => [finding.line, finding.message])).toEqual([
      [10, '"extra" is not a field of the manifest: the manifest holds "kinds", "groups", "documents", "roles", "language" and "diagram"'],
      [3, 'kind "nosource": "source" is "graph", "markdown" or "document", got undefined'],
      [4, 'kind "missing": the template "templates/none.md" does not exist in the product repository'],
      [5, 'kind "climbing": the template "../outside.md" is not a path inside the product repository'],
      [6, 'kind "both": a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)'],
      [7, 'kind "neither": a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)'],
      [8, 'kind "stray": "colour" is not a field of a kind: the fields are template, source, folder, file, title, attributes, relations, labels, group, origin, description, identifier, terms'],
      [9, 'kind "graphfolder": a graph kind has no "folder" or "file": its entities come from the graph'],
    ]);
    expect(manifest.findings.every((finding) => finding.file === 'madarch/kinds.yaml')).toBe(true);
  });

  test('YAML that does not parse is one finding at its line, and no kind is guessed', () => {
    const manifest = parseKinds('kinds:\n  a: [unclosed\n', 'madarch/kinds.yaml', scratch());
    expect(manifest.kinds.size).toBe(0);
    expect(manifest.findings).toHaveLength(1);
    expect(manifest.findings[0]!.line).toBeGreaterThanOrEqual(2);
  });

  test('a product with no manifest is absent, not broken', () => {
    expect(readKinds(scratch())).toMatchObject({ present: false });
  });
});

describe('the template', () => {
  test('text and blocks keep their lines; parameters read bare and quoted; a fenced code sample is text', () => {
    const parts = parseTemplate([
      'Intro {{label}}.', // 1
      ':::graph{depth=1}', // 2
      ':::related{title="Used by, and more" relation="code.calls" direction=in}', // 3
      '```', // 4
      ':::callers', // 5
      '```', // 6
      ':::body', // 7
    ].join('\n'));
    expect(parts).toEqual([
      { type: 'text', text: 'Intro {{label}}.', line: 1 },
      { type: 'block', name: 'graph', params: { depth: '1' }, line: 2 },
      { type: 'block', name: 'related', params: { title: 'Used by, and more', relation: 'code.calls', direction: 'in' }, line: 3 },
      { type: 'text', text: '```\n:::callers\n```', line: 4 },
      { type: 'block', name: 'body', params: {}, line: 7 },
    ]);
  });

  test('an unknown block, a stray closing line and unreadable parameters are problems at their line', () => {
    const parts = parseTemplate([':::chart', ':::', ':::related{title}', ':::related{a=1 a=2}', ':::source'].join('\n'));
    expect(parts.map((part) => (part.type === 'problem' ? [part.line, part.message] : [part.type]))).toEqual([
      [1, '"chart" is not a block of the library (body, graph, related, callers, callees, source, er, sequence, system, modules, treemap, history, definition, stated, implementedby, linkedfrom, properties, children, term)'],
      [2, 'a ":::" line closes nothing: a block is one line, ":::name{parameters}"'],
      [3, 'the parameters of :::related are unreadable: "title" is not name=value'],
      [4, 'the parameters of :::related are unreadable: "a" is given twice'],
      ['block'],
    ]);
  });

  test('substitution escapes what Markdown would read as markup, and a missing attribute is a dash and a finding', () => {
    const findings: { file: string; line: number; message: string }[] = [];
    const text = substitute('# {{name}} and {{gone}}\nsecond {{name}}', 10, 'templates/x.md', (name) => (name === 'name' ? 'a_b*c [d]' : undefined), findings);
    expect(text).toBe('# a\\_b\\*c \\[d\\] and –\nsecond a\\_b\\*c \\[d\\]');
    expect(findings).toEqual([{ file: 'templates/x.md', line: 10, message: '"{{gone}}" names no attribute of this entity' }]);
  });
});

describe('Markdown entities', () => {
  const kinds = (root: string) => parseKinds('kinds:\n  domain: { template: templates/t.md, source: markdown, folder: docs/domains }\n  product: { template: templates/t.md, source: markdown, file: docs/product.md }\n', 'madarch/kinds.yaml', (put(root, 'templates/t.md', ':::body\n'), root));

  test('a file is an entity when its front matter gives the kind and an id that starts with it', () => {
    const root = scratch();
    put(root, 'docs/domains/pay.md', '---\nid: domain:pay\nkind: domain\ntitle: Pay\nrelates:\n  - code.service:x\nproducer: agent\nsources: [docs/a.md]\n---\nBody.\n');
    const read = readMarkdownEntities(root, kinds(root));
    expect(read.findings).toEqual([]);
    expect(read.entities).toEqual([expect.objectContaining({ id: 'domain:pay', kind: 'domain', title: 'Pay', relates: ['code.service:x'], producer: 'agent', sources: ['docs/a.md'], body: 'Body.\n', bodyLine: 10, file: 'docs/domains/pay.md' })]);
  });

  test('a file that is not an entity is a finding at its file, and is not shown as one', () => {
    const root = scratch();
    put(root, 'docs/domains/none.md', 'No front matter.\n');
    put(root, 'docs/domains/wrong-kind.md', '---\nid: domain:a\nkind: product\n---\n');
    put(root, 'docs/domains/wrong-id.md', '---\nid: service:a\nkind: domain\n---\n');
    put(root, 'docs/domains/one.md', '---\nid: domain:same\nkind: domain\n---\n');
    put(root, 'docs/domains/two.md', '---\nid: domain:same\nkind: domain\n---\n');
    put(root, 'docs/domains/bad-yaml.md', '---\nid: [\n---\n');
    const read = readMarkdownEntities(root, kinds(root));
    expect(read.entities.map((entity) => entity.file)).toEqual(['docs/domains/one.md']);
    const said = read.findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).sort();
    const yaml = said.find((line) => line.startsWith('docs/domains/bad-yaml.md:'))!;
    expect(yaml).toMatch(/^docs\/domains\/bad-yaml\.md:2: the front matter is not YAML: /);
    expect(said.filter((line) => line !== yaml)).toEqual([
      'docs/domains/none.md:1: the file has no front matter: an entity of kind "domain" starts with --- , its id and its kind, ---',
      'docs/domains/two.md:2: the id "domain:same" is also the id of docs/domains/one.md; an id names one entity',
      'docs/domains/wrong-id.md:2: the id "service:a" does not start with "domain:", the kind the manifest gives this place',
      'docs/domains/wrong-kind.md:2: "kind" is "domain" in the manifest and "product" here',
    ]);
  });

  test('the singleton kind is absent until its file is written, and that is no finding', () => {
    const root = scratch();
    expect(readMarkdownEntities(root, kinds(root))).toEqual({ entities: [], findings: [] });
  });

  test('the front matter is split from the body at the line the body starts', () => {
    expect(splitFrontMatter('---\na: 1\n---\ntext\n')).toEqual({ front: 'a: 1', body: 'text\n', bodyLine: 4 });
    expect(splitFrontMatter('text\n')).toEqual({ front: null, body: 'text\n', bodyLine: 1 });
  });
});

describe('a body and its grounds', () => {
  test('the madarch: links are found, with the line and whether they are a ground; a target is a key or a document section', () => {
    const body = ['A statement that is grounded here.[^1] And another one with a [link](madarch:domain:pay) inside it.[^2]', '', '[^1]: [one](madarch:code.symbol:a.ts#x), [two](madarch:doc:docs/a.md#top)', '[^2]: [three](madarch:code.file:a.ts)'].join('\n');
    const reading = readBody(body, 'docs/p.md', 11);
    expect(reading.links).toEqual([
      { url: 'madarch:domain:pay', line: 11, ground: false },
      { url: 'madarch:code.symbol:a.ts#x', line: 13, ground: true },
      { url: 'madarch:doc:docs/a.md#top', line: 13, ground: true },
      { url: 'madarch:code.file:a.ts', line: 14, ground: true },
    ]);
    expect(reading.ungrounded).toEqual([]);
    expect(reading.statements).toBe(2);
    expect(parseTarget('madarch:code.symbol:a.ts#x')).toEqual({ kind: 'key', key: 'code.symbol:a.ts#x' });
    expect(parseTarget('madarch:doc:docs/a.md#top')).toEqual({ kind: 'doc', path: 'docs/a.md', anchor: 'top' });
    expect(parseTarget('madarch:doc:docs/a.md')).toEqual({ kind: 'doc', path: 'docs/a.md', anchor: null });
  });

  test('a statement with no footnote is named; headings, short connecting lines and See also are not statements', () => {
    const reading = readBody(['# Heading of the page', '', 'This statement has nothing behind it at all. This one is grounded.[^1]', '', 'See also the shop and the billing pages.', '', 'Short.', '', '[^1]: [a](madarch:code.file:a.ts)'].join('\n'), 'docs/p.md', 1);
    expect(reading.ungrounded).toEqual([{ text: 'This statement has nothing behind it at all.', line: 3 }]);
    expect(reading.statements).toBe(2);
  });

  test('a footnote used and never defined, and a footnote that lists no ground, are findings at their line', () => {
    const reading = readBody(['One statement with a missing note here.[^2]', '', 'Another statement with an empty note here.[^3]', '', '[^3]: just words, no link'].join('\n'), 'docs/p.md', 5);
    expect(reading.findings).toEqual([
      { file: 'docs/p.md', line: 5, message: 'the footnote [^2] is used and never defined' },
      { file: 'docs/p.md', line: 9, message: 'the footnote [^3] lists no ground: a footnote is a list of madarch: links' },
    ]);
  });
});

describe('the starter set madarch new seeds', () => {
  test('a new product holds the manifest and the starter templates, the manifest reads without a finding and every template parses without a problem', () => {
    const home = scratch();
    const draft = createDraft({ home, name: 'seeded', gitEnv: gitEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' }) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    // The starter set of both changes: the document task page and the history task page are two templates of one name
    // (`task.md` for the document, `history-task.md` for the graph's task), so both stand in the list (madarch-m38l.16).
    expect(STARTER_FILES.map((file) => file.path)).toEqual(['madarch/kinds.yaml', ...[
      'product', 'domain', 'service', 'package', 'module', 'file', 'symbol', 'route', 'item', 'item-plain', 'contract', 'operation',
      'history-task', 'commit', 'author', 'database', 'table', 'entity-text', 'term', 'question', 'correction', 'task',
    ].map((name) => `templates/${name}.md`)]);
    for (const file of STARTER_FILES) expect(readFileSync(join(draft.folder, file.path), 'utf8')).toBe(file.content);
    const read = readKinds(draft.folder);
    if (!read.present) throw new Error('the seeded manifest is absent');
    expect(read.manifest.findings).toEqual([]);
    expect([...read.manifest.kinds.keys()].slice(0, 2)).toEqual(['product', 'domain']);
    expect([...read.manifest.kinds.keys()]).toEqual(expect.arrayContaining(['doc.use-case', 'doc.rule', 'doc.decision', 'doc.term', 'code.service', 'code.module', 'code.file', 'code.symbol', 'code.route', 'code.table', 'code.env-var', 'code.ci-job', 'code.test-case']));
    expect(homeKind(read.manifest)!.name).toBe('product');
    for (const decl of read.manifest.kinds.values()) {
      const parts = parseTemplate(readFileSync(join(draft.folder, decl.template), 'utf8'));
      expect(parts.filter((part) => part.type === 'problem')).toEqual([]);
    }
  });

  test('the starter files carry no engine page: they are the product\'s own text, committed with the draft', () => {
    const home = scratch();
    const draft = createDraft({ home, name: 'committed', gitEnv: gitEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' }) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: draft.folder, env: gitEnv() }).stdout.toString().split('\n');
    for (const file of STARTER_FILES) expect(tracked).toContain(file.path);
  });
});
