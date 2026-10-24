/**
 * The entities that live in Markdown documents (madarch-m38l.6): which sections
 * the manifest's document kinds take, the ids and anchors they get, the manifest
 * fields that name them, and the statements of an agent's page. The expected
 * values are read off the training repository's own documents and off texts this
 * test writes, never off the engine's output.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { anchorLines } from '../src/knowledge/anchors.js';
import { docEntityId, readDocEntities, type DocumentSource } from '../src/knowledge/doc-entities.js';
import { codeMentions } from '../src/knowledge/doc-blocks.js';
import { globToRegExp, matchesAny, parseKinds } from '../src/knowledge/kinds.js';
import { readStatements } from '../src/knowledge/markdown.js';
import { docsLinkedOutside, isKindPage, listedDocument, productDocumentPaths, readProductDocument, readRepoDocuments, repoDocumentPaths } from '../src/knowledge/doc-sources.js';
import { gitEnv } from './git-env.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { ROOT } from './knowledge-fixture.js';

const DOCS = join(ROOT, 'examples/training-repository/template/docs');
const doc = (name: string): string => readFileSync(join(DOCS, name), 'utf8');

const MANIFEST = [
  'groups:',
  '  product: { en: Product, ru: Продукт }',
  'documents:',
  '  exclude: [AGENTS.md, "**/CLAUDE.md"]',
  'kinds:',
  '  doc.use-case: { template: t.md, source: document, identifier: UC, group: product }',
  '  doc.rule: { template: t.md, source: document, identifier: BR }',
  '  doc.decision: { template: t.md, source: document, identifier: ADR, origin: person }',
  '  doc.term: { template: t.md, source: document, terms: ["**/glossary*.md"] }',
  '  page: { template: t.md, source: markdown, folder: docs/domains }',
  '  home: { template: t.md, source: markdown, file: docs/product.md }',
  '',
].join('\n');

/** A product folder holding the one template the test manifests name. */
const folder = mkdtempSync(join(tmpdir(), 'madarch-doc-entities-'));
mkdirSync(join(folder, 'templates'), { recursive: true });
writeFileSync(join(folder, 'templates', 'x.md'), ':::body\n');

function parse(text = MANIFEST) {
  return parseKinds(text.replace(/template: (t\.md|x)\b/g, 'template: templates/x.md'), 'madarch/kinds.yaml', folder);
}

afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('the manifest fields of the entity pages', () => {
  test('groups, the excluded documents, and a document kind with its identifier or terms are read', () => {
    const read = parse();
    expect(read.findings).toEqual([]);
    expect([...read.groups.keys()]).toEqual(['product']);
    expect(read.groups.get('product')!.labels).toEqual({ en: 'Product', ru: 'Продукт' });
    expect(read.excludeDocuments).toEqual(['AGENTS.md', '**/CLAUDE.md']);
    expect(read.kinds.get('doc.use-case')).toMatchObject({ source: 'document', identifier: ['UC'], group: 'product' });
    expect(read.kinds.get('doc.decision')).toMatchObject({ origin: 'person' });
    expect(read.kinds.get('doc.term')!.terms).toEqual(['**/glossary*.md']);
  });

  test('a document kind with neither identifier nor terms, a group nobody declared and a wrong origin are findings at the line they stand on', () => {
    const read = parse(['groups:', '  product: { en: Product }', 'kinds:', '  doc.a: { template: x, source: document }', '  doc.b: { template: x, source: document, identifier: UC, group: nowhere }', '  doc.c: { template: x, source: document, identifier: UC, origin: robot }', ''].join('\n'));
    const messages = read.findings;
    expect(messages.map((finding) => finding.line)).toEqual([4, 5, 6]);
    expect(messages[0]!.message).toContain('names "identifier"');
    expect(messages[1]!.message).toContain('"group" names a group of "groups" (product)');
    expect(messages[2]!.message).toContain('"origin" is agent, person, code, history');
  });

  test('globs: * stays in a folder, ** crosses folders, and an excluded document is matched by its path', () => {
    expect(globToRegExp('AGENTS.md').test('AGENTS.md')).toBe(true);
    expect(globToRegExp('AGENTS.md').test('docs/AGENTS.md')).toBe(false);
    expect(globToRegExp('**/CLAUDE.md').test('CLAUDE.md')).toBe(true);
    expect(globToRegExp('**/CLAUDE.md').test('a/b/CLAUDE.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a.md')).toBe(true);
    expect(globToRegExp('docs/*.md').test('docs/a/b.md')).toBe(false);
    expect(matchesAny(['x.md', 'y.md'], 'y.md')).toBe(true);
  });

  test('the product\'s own pages are not listed as documents, the excluded files are not, and a code repository\'s same-named file is judged by the patterns alone', () => {
    const read = parse();
    expect(isKindPage(read, 'docs/product.md')).toBe(true);
    expect(isKindPage(read, 'docs/domains/payment.md')).toBe(true);
    expect(isKindPage(read, 'docs/domains')).toBe(false);
    expect(isKindPage(read, 'docs/requirements.md')).toBe(false);
    expect(listedDocument(read, null, 'docs/product.md')).toBe(false);
    expect(listedDocument(read, null, 'AGENTS.md')).toBe(false);
    expect(listedDocument(read, null, 'sub/CLAUDE.md')).toBe(false);
    expect(listedDocument(read, null, 'README.md')).toBe(true);
    expect(listedDocument(read, 'shop', 'docs/product.md')).toBe(true);
    expect(listedDocument(read, null, 'docs/sources/doc.term/abc_def.md')).toBe(false);
  });

  test('the starter set declares every group it uses and parses with no finding', () => {
    const product = mkdtempSync(join(tmpdir(), 'madarch-starter-'));
    for (const file of STARTER_FILES) {
      mkdirSync(dirname(join(product, file.path)), { recursive: true });
      writeFileSync(join(product, file.path), file.content);
    }
    const read = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, 'madarch/kinds.yaml', product);
    // Every template the manifest names is one the starter set holds, and the manifest reads with no finding.
    expect(read.findings).toEqual([]);
    expect(read.kinds.size).toBe(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content.split('\n').filter((line) => /^ {2}[a-z][\w.-]*:$/.test(line)).length);
    for (const kind of read.kinds.values()) {
      expect(kind.group).toBeDefined();
      expect(kind.descriptions?.['en']).toBeDefined();
      expect(kind.descriptions?.['ru']).toBeDefined();
      expect(kind.labels?.['ru']).toBeDefined();
    }
  });
});

describe('the sections of the training repository\'s documents', () => {
  const sources: DocumentSource[] = [
    { repo: 'training', path: 'docs/requirements.md', text: doc('requirements.md') },
    { repo: 'training', path: 'docs/glossary.md', text: doc('glossary.md') },
    { repo: 'training', path: 'docs/adr/0001-broker.md', text: doc('adr/0001-broker.md') },
    { repo: 'training', path: 'docs/adr/0002-outbox.md', text: doc('adr/0002-outbox.md') },
    { repo: 'training', path: 'docs/vision.md', text: doc('vision.md') },
  ];
  const read = readDocEntities(sources, parse());
  const byId = new Map(read.entities.map((entity) => [entity.id, entity]));

  test('UC-1 to UC-4 and BR-1 to BR-5 are entities of their kinds, with the id the ground names', () => {
    const uc = read.entities.filter((entity) => entity.kind === 'doc.use-case').map((entity) => entity.identifier);
    const br = read.entities.filter((entity) => entity.kind === 'doc.rule').map((entity) => entity.identifier);
    expect(uc).toEqual(['UC-1', 'UC-2', 'UC-3', 'UC-4']);
    expect(br).toEqual(['BR-1', 'BR-2', 'BR-3', 'BR-4', 'BR-5']);
    const pay = byId.get(docEntityId('training', 'docs/requirements.md', 'uc-2'))!;
    expect(pay.id).toBe('doc:@training/docs/requirements.md#uc-2');
    expect(pay.title).toBe('UC-2 Pay');
    expect(pay.text.replace(/\s+/g, ' ')).toContain('Checkout asks payments to authorize the card for the order\'s total.');
    expect(pay.text).not.toContain('UC-3');
  });

  test('an entity starts at the line its anchor names, so a ground to the section finds it', () => {
    const lines = anchorLines(sources[0]!.text);
    for (const entity of read.entities.filter((candidate) => candidate.path === 'docs/requirements.md')) {
      expect(entity.line).toBe(lines.get(entity.anchor)!);
    }
    const glossary = anchorLines(sources[1]!.text);
    for (const entity of read.entities.filter((candidate) => candidate.kind === 'doc.term')) expect(entity.line).toBe(glossary.get(entity.anchor)!);
  });

  test('a rule\'s section runs over the lines that continue it and stops at the next rule: BR-1 names the code that implements it', () => {
    const rule = byId.get(docEntityId('training', 'docs/requirements.md', 'br-1'))!;
    expect(rule.text).toContain('Implemented in `services/orders/internal/pricing/pricing.go` (`Discount`)');
    expect(rule.text).toContain('checkout previews it in');
    expect(rule.text).not.toContain('BR-2');
    expect(codeMentions(rule.text)).toEqual([
      { path: 'services/orders/internal/pricing/pricing.go', names: ['Discount'] },
      { path: 'services/orders/internal/application/order_service.go', names: ['Place'] },
      { path: 'services/checkout/src/pricing.ts', names: ['discountFor'] },
    ]);
  });

  test('the glossary\'s seven terms are entities by the slug of their bold word', () => {
    const terms = read.entities.filter((entity) => entity.kind === 'doc.term');
    expect(terms.map((entity) => entity.title)).toEqual(['Capture', 'CardToken', 'Idempotency key', 'Order', 'Outbox', 'PaymentToken', 'Zero-rated']);
    expect(terms.find((entity) => entity.title === 'Idempotency key')!.anchor).toBe('idempotency-key');
    expect(terms.find((entity) => entity.title === 'Outbox')!.text).toBe('the table in which orders queues the messages it will publish.');
  });

  test('a decision record is the heading with its identifier, from its first line to the end of the file', () => {
    const adr = byId.get(docEntityId('training', 'docs/adr/0001-broker.md', 'adr-0001'))!;
    expect(adr.kind).toBe('doc.decision');
    expect(adr.title).toBe('ADR-0001 Kafka is the broker');
    expect(adr.line).toBe(1);
    expect(adr.text).toContain('## Context');
    expect(adr.text).toContain('Consumers must tolerate duplicates');
    expect(read.entities.some((entity) => entity.path === 'docs/vision.md')).toBe(false);
  });

  test('the same identifier twice in one document opens one page and a finding names the second line', () => {
    const twice = readDocEntities([{ repo: null, path: 'docs/x.md', text: '- **UC-1 One.** a\n- **UC-1 Again.** b\n' }], parse());
    expect(twice.entities.map((entity) => entity.id)).toEqual(['doc:docs/x.md#uc-1']);
    expect(twice.findings).toEqual([{ file: 'docs/x.md', line: 2, message: expect.stringContaining('opens a second section of this document (the first is at line 1)') }]);
  });

  test('code in a fenced block and an identifier in the middle of a sentence open no section', () => {
    const none = readDocEntities([{ repo: null, path: 'docs/x.md', text: '```\n- **UC-1 In a fence.** a\n```\n\nThe case **UC-9 inside** a sentence.\n' }], parse());
    expect(none.entities).toEqual([]);
  });
});

describe('the statements of an agent\'s page', () => {
  const body = [
    'Payments are charged through one of two providers.[^1] A refund moves the order to refunded.',
    '',
    'Checkout asks payments to authorize the card.[^2][^3]',
    '',
    'See [the shop](madarch:product:shop).',
    '',
    '[^1]: [factory](madarch:code.symbol:a.ts#F), [UC-2](madarch:doc:docs/requirements.md#uc-2)',
    '[^2]: [pay](madarch:code.symbol:a.ts#pay)',
    '[^3]: [rule](madarch:doc:docs/requirements.md#br-3)',
    '',
  ].join('\n');

  test('each sentence carries the footnotes that end it, its paragraph without them, and the line it stands on', () => {
    const reading = readStatements(body, 10);
    expect(reading.statements.map((statement) => [statement.text, statement.notes, statement.line])).toEqual([
      ['Payments are charged through one of two providers.', ['1'], 10],
      ['A refund moves the order to refunded.', [], 10],
      ['Checkout asks payments to authorize the card.', ['2', '3'], 12],
    ]);
    expect(reading.statements[0]!.paragraph).toBe('Payments are charged through one of two providers. A refund moves the order to refunded.');
    expect([...reading.definitions]).toEqual([
      ['1', ['madarch:code.symbol:a.ts#F', 'madarch:doc:docs/requirements.md#uc-2']],
      ['2', ['madarch:code.symbol:a.ts#pay']],
      ['3', ['madarch:doc:docs/requirements.md#br-3']],
    ]);
  });
});

describe('the statements and the sections the reader and the app must agree on', () => {
  test('a bold run with two sentences is one statement, and the same sentence twice is told by its turn', () => {
    const reading = readStatements('**Payments are charged by card. A refund moves money back.**[^1] Plain text follows the bold run here.\n\nRequests are retried three times.[^a] Other words come in between here.\n\nRequests are retried three times.[^b]\n\n[^1]: [x](madarch:code.file:x)\n[^a]: [y](madarch:code.file:y)\n[^b]: [z](madarch:code.file:z)\n', 1);
    expect(reading.statements.map((statement) => [statement.text, statement.notes])).toEqual([
      ['Payments are charged by card. A refund moves money back.', ['1']],
      ['Plain text follows the bold run here.', []],
      ['Requests are retried three times.', ['a']],
      ['Other words come in between here.', []],
      ['Requests are retried three times.', ['b']],
    ]);
  });

  test('a use case whose steps are an indented list after a blank line keeps the steps, and the next use case still stops it', () => {
    const read = readDocEntities([{ repo: null, path: 'docs/x.md', text: '- **UC-1 Place order.** Introduction.\n\n  1. Enter the delivery address.\n  2. Pay.\n\n- **UC-2 Pay.** Next.\n' }], parse());
    const one = read.entities.find((entity) => entity.identifier === 'UC-1')!;
    expect(one.text).toContain('1. Enter the delivery address.');
    expect(one.text).toContain('2. Pay.');
    expect(one.text).not.toContain('UC-2');
    expect(one.endLine).toBe(4);
  });
});

describe('the documents are read inside the repository they belong to', () => {
  const made: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'madarch-doc-sources-'));
    made.push(dir);
    return dir;
  };
  afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

  test('a docs folder that is a link out of the product is not walked and not read, and a document that links out is not read', () => {
    const outside = scratch();
    writeFileSync(join(outside, 'secret.md'), '## UC-1 Confidential\n');
    const product = scratch();
    symlinkSync(outside, join(product, 'docs'));
    expect(docsLinkedOutside(product)).toBe(outside);
    expect(productDocumentPaths(product)).toEqual([]);
    expect(readProductDocument(product, 'docs/secret.md')).toBeUndefined();
    const inside = scratch();
    mkdirSync(join(inside, 'docs'));
    writeFileSync(join(inside, 'docs', 'a.md'), '# A\n');
    symlinkSync(join(outside, 'secret.md'), join(inside, 'docs', 'link.md'));
    expect(docsLinkedOutside(inside)).toBeUndefined();
    expect(readProductDocument(inside, 'docs/a.md')).toBe('# A\n');
    expect(readProductDocument(inside, 'docs/link.md')).toBeUndefined();
  });

  test('a repository\'s documents come at the commit in one pass: a document over the size limit and one whose name holds a line break are answered as unreadable, the rest as text', async () => {
    const repo = scratch();
    const run = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...gitEnv({ GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.test' }) } });
    run('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'small.md'), '# Small\n');
    writeFileSync(join(repo, 'docs', 'with space.md'), '# Spaced\n');
    writeFileSync(join(repo, 'docs', 'huge.md'), `# Huge\n${'x'.repeat(1024 * 1024 + 1)}`);
    writeFileSync(join(repo, 'docs', 'line\nbreak.md'), '# Broken name\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'docs');
    const names = await repoDocumentPaths('r', repo, undefined);
    expect(names).toEqual(['docs/huge.md', 'docs/line\nbreak.md', 'docs/small.md', 'docs/with space.md']);
    const read = await readRepoDocuments('r', repo, 'HEAD', [...names, 'docs/missing.md']);
    expect([...read.entries()].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      ['docs/huge.md', null],
      ['docs/line\nbreak.md', null],
      ['docs/small.md', '# Small\n'],
      ['docs/with space.md', '# Spaced\n'],
    ]);
  });
});
