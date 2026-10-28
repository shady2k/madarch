import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { anchorLines, documentAnchors, findAnchor } from '../src/knowledge/anchors.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { entityAtAddress, readDocEntities } from '../src/knowledge/doc-entities.js';
import { parseKinds } from '../src/knowledge/kinds.js';
import { splitFrontMatter } from '../src/knowledge/markdown.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateTrainingRepository } from './knowledge-fixture.js';

function markdownFiles(folder: string, root = folder): string[] {
  return readdirSync(folder).flatMap((name) => {
    if (name === '.git' || name === 'node_modules') return [];
    const path = join(folder, name);
    return statSync(path).isDirectory() ? markdownFiles(path, root) : /\.md$/i.test(name) ? [relative(root, path)] : [];
  });
}

describe('one reading of a document\'s sections for the writer and the wiki', () => {
  test('every ground anchor the writer accepts in the training repository\'s documents resolves in the wiki, at the line that names it', async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-anchors-'));
    try {
      const repository = generateTrainingRepository(join(work, 'training'));
      const documents = markdownFiles(repository);
      expect(documents.length).toBeGreaterThan(0);
      const resolver = new Resolver({
        graph: undefined as never, markdown: new Map(), declared: () => false, locate: () => undefined,
        readDocument: async (repo, path) => (repo === 'shop' && documents.includes(path) ? readFileSync(join(repository, path), 'utf8') : undefined),
        repositories: () => ['shop'],
      });
      let checked = 0;
      for (const path of documents) {
        const text = readFileSync(join(repository, path), 'utf8');
        for (const anchor of documentAnchors(text)) {
          const resolution = await resolver.resolve(`madarch:doc:${path}#${anchor}`);
          expect(resolution.state, `${path}#${anchor}`).toBe('ok');
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  test('a bold list phrase with a full stop, a heading with a dash and a repeated heading are the same anchors for both', () => {
    const text = ['# Journeys', '', '- **Use a promotion.** The shopper enters a code.', '', '## Checkout — payment', '', '## Journeys', ''].join('\n');
    const anchors = documentAnchors(text);
    expect(anchors).toContain('use-a-promotion');
    expect(anchors).toContain('checkout--payment');
    expect(anchors).toContain('journeys-1');
    for (const anchor of anchors) expect(findAnchor(text, anchor), anchor).not.toBeNull();
    expect(findAnchor(text, 'use-a-promotion')).toBe(3);
    expect(anchorLines(text).get('journeys')).toBe(1);
  });
});

describe('the names of a document come from its tree, never from a pattern over its lines', () => {
  test('a Setext heading is named like an ATX one, and a label inside a paragraph names nothing', () => {
    // The parser reads `Qualities` over `=====` as a heading, so it carries an anchor and its block carries the heading's
    // place — where a line-by-line reader saw no heading at all (madarch-ztyq.3, the review of finding 1).
    const setext = ['Qualities', '=========', '', 'The payment provider may be slow.', ''].join('\n');
    expect(documentAnchors(setext)).toEqual(['qualities', 'qualities.1']);
    expect(findAnchor(setext, 'qualities')).toBe(1);
    // A label that a line-based pattern would have named where it merely stands mid-paragraph names nothing: the block is
    // named by the text node it OPENS with, and this one opens with a sentence.
    const midParagraph = ['# Notes', '', 'A first sentence.', 'NFR-7 stands in the middle of this paragraph.', ''].join('\n');
    expect(documentAnchors(midParagraph)).toEqual(['notes', 'notes.1']);
    expect(findAnchor(midParagraph, 'nfr-7')).toBeNull();
    // The reverse: the same label at the start of a block names it.
    const leading = ['# Notes', '', 'NFR-7 opens this paragraph.', ''].join('\n');
    expect(documentAnchors(leading)).toContain('nfr-7');
  });
});

describe('a page id and a ground are two kinds of reference', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-anchors-identity-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates', 'x.md'), ':::body\n');
  const manifest = parseKinds(['kinds:', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC, semantics: scenario }', ''].join('\n'), join(folder, 'madarch/kinds.yaml'), folder);
  const numbered = ['# Requirements', '', '## Use cases', '', '- **UC-1 Place order.** A signed-in shopper submits a cart.', '- **UC-2 Pay.** Checkout asks payments to authorize the card.', ''].join('\n');
  // The two numbers change places: each passage keeps its name and its words, so its identity stays with it.
  const swapped = numbered
    .replace('**UC-1 Place order.**', '**UC-@ Place order.**')
    .replace('**UC-2 Pay.**', '**UC-1 Pay.**')
    .replace('**UC-@ Place order.**', '**UC-2 Place order.**');
  const first = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: numbered }], manifest);
  const second = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: swapped }], manifest, { identities: first.identities });
  const byLine = new Map(second.entities.map((entity) => [entity.line, entity]));
  const byIdentity = new Map(second.entities.map((entity) => [entity.stableId, entity]));
  const resolver = new Resolver({
    graph: undefined as never, markdown: new Map(), declared: () => true, locate: () => undefined,
    readDocument: async (repo, path) => (repo === null && path === 'docs/requirements.md' ? swapped : undefined),
    repositories: () => [],
    documentEntity: (_repo, _path, line) => byLine.get(line),
    documentEntityById: (_repo, _path, stableId) => byIdentity.get(stableId),
  });
  const placeOrder = second.entities.find((entity) => entity.text.includes('A signed-in shopper'))!;
  const pay = second.entities.find((entity) => entity.text.includes('Checkout asks payments'))!;

  test('a ground written as a source anchor opens the passage the document gives that anchor now', () => {
    // `uc-1` is the Pay passage now, because the number moved with its alias and the identity followed the content.
    expect([placeOrder.anchor, pay.anchor]).toEqual(['uc-2', 'uc-1']);
    return expect(resolver.resolve('madarch:doc:docs/requirements.md#uc-1')).resolves.toMatchObject({ state: 'ok', entity: pay.id });
  });

  test('a page id opens the passage its durable identity names, whatever anchor it stands at now', async () => {
    expect(placeOrder.id).toBe('doc:docs/requirements.md#doc-section:1');
    expect(await resolver.resolve(placeOrder.id.replace(/^doc:/, 'madarch:doc:'))).toMatchObject({ state: 'ok', entity: placeOrder.id });
  });

  test('an anchor the document no longer has is a broken section, never a fallback to an old identity', async () => {
    const gone = await resolver.resolve('madarch:doc:docs/requirements.md#uc-9');
    expect(gone).toMatchObject({ state: 'broken', why: { code: 'no-section', anchor: 'uc-9' } });
  });
});

describe('an address names its passage by an anchor or by an identity, and both open the page', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-anchors-address-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates', 'x.md'), ':::body\n');
  const manifest = parseKinds(['kinds:', '  doc.term: { template: templates/x.md, source: document, terms: ["**/glossary*.md"] }', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC, semantics: scenario }', ''].join('\n'), join(folder, 'madarch/kinds.yaml'), folder);
  const glossary = ['# Glossary', '', '- **Payment token** - The proof a provider returns when it captured money.', '- **Capture** - The moment the money is taken from the card.', ''].join('\n');
  const read = readDocEntities([{ repo: null, path: 'docs/glossary.md', text: glossary }], manifest);
  const entities = new Map(read.entities.map((entity) => [entity.id, entity]));
  const token = read.entities.find((entity) => entity.title === 'Payment token')!;

  test('an address written with the source anchor a passage stands at opens that passage', () => {
    // Pages and links written before identities existed address a section by its anchor (`payment-token`); they must keep
    // opening it (madarch-ztyq.3, the review of A).
    expect(entityAtAddress(entities, 'doc:docs/glossary.md#payment-token')).toBe(token);
    expect(token.id).toBe(`doc:docs/glossary.md#${token.stableId}`);
  });

  test('a heading that names itself two ways opens one page from either address', () => {
    // `## UC-1 Pay for an order` writes two anchors — its number and its words — and both address the same passage, so a
    // page written as either one opens it (the review of the fourth pass, finding 1).
    const useCases = ['# Requirements', '', '## UC-1 Pay for an order', '', 'A shopper pays.', ''].join('\n');
    const one = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: useCases }], manifest);
    const pages = new Map(one.entities.map((entity) => [entity.id, entity]));
    const byNumber = entityAtAddress(pages, 'doc:docs/requirements.md#uc-1');
    const byWords = entityAtAddress(pages, 'doc:docs/requirements.md#uc-1-pay-for-an-order');
    expect(byNumber).toBeDefined();
    expect(byWords).toBe(byNumber);
    expect([...byNumber!.aliases].sort()).toEqual(['uc-1', 'uc-1-pay-for-an-order']);
  });

  test('an identity keeps opening its passage after the heading is renamed, and the anchor it left names nothing', () => {
    const renamed = readDocEntities([{ repo: null, path: 'docs/glossary.md', text: glossary.replace('**Payment token**', '**Provider token**') }], manifest, { identities: read.identities });
    const after = new Map(renamed.entities.map((entity) => [entity.id, entity]));
    const held = renamed.entities.find((entity) => entity.stableId === token.stableId)!;
    expect(entityAtAddress(after, `doc:docs/glossary.md#${token.stableId}`)).toBe(held);
    // The anchor the old heading wrote is the old passage's display name, and a document that no longer writes it names
    // nothing: a stale anchor is a problem, never a fallback to the identity that used to stand there.
    expect(entityAtAddress(after, 'doc:docs/glossary.md#payment-token')).toBeUndefined();
    expect(held.anchor).toBe('provider-token');
  });
});

describe('a repository-qualified address resolves in its repository', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-anchors-repo-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates', 'x.md'), ':::body\n');
  const manifest = parseKinds(['kinds:', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC, semantics: scenario }', ''].join('\n'), join(folder, 'madarch/kinds.yaml'), folder);
  const text = '# Requirements\n\n## Use cases\n\n- **UC-1 Place order.** A signed-in shopper submits a cart.\n';
  const read = readDocEntities([{ repo: 'training', path: 'docs/requirements.md', text }], manifest);
  const entity = read.entities[0]!;
  const entities = new Map(read.entities.map((entry) => [entry.id, entry]));

  test('the page id of a connected repository names its repository, and the address opens the page', () => {
    expect(entity.id).toBe(`doc:@training/docs/requirements.md#${entity.stableId}`);
    expect(entityAtAddress(entities, entity.id)).toBe(entity);
    expect(entityAtAddress(entities, `doc:@training/docs/requirements.md#${entity.anchor}`)).toBe(entity);
  });

  test('the resolver strips the qualifier and reads the document in that repository', async () => {
    const resolver = new Resolver({
      graph: undefined as never, markdown: new Map(), declared: () => true, locate: () => undefined,
      readDocument: async (repo, path) => (repo === 'training' && path === 'docs/requirements.md' ? text : undefined),
      repositories: () => ['training'],
      documentEntityByAnchor: (repo, path, anchor) => (repo === 'training' && path === 'docs/requirements.md' && entity.anchor === anchor ? entity : undefined),
      documentEntityById: (repo, path, stableId) => (repo === 'training' && path === 'docs/requirements.md' && entity.stableId === stableId ? entity : undefined),
    });
    expect(await resolver.resolve(`madarch:${entity.id}`)).toMatchObject({ state: 'ok', entity: entity.id });
    expect(await resolver.resolve('madarch:doc:@training/docs/requirements.md#uc-1')).toMatchObject({ state: 'ok', entity: entity.id });
    // A repository that holds no such document is named as the reason, not silently searched elsewhere.
    expect(await resolver.resolve('madarch:doc:@nowhere/docs/requirements.md#uc-1')).toMatchObject({ state: 'broken', why: { code: 'no-document' } });
  });
});

describe('the front matter is read without a pattern over the document', () => {
  test('a byte-order mark and CRLF line ends are read as the front matter they are', () => {
    const text = '\uFEFF---\r\nsections:\r\n  Terms: doc.term\r\n---\r\n\r\n# Glossary\r\n\r\n- **Payment token** - The proof a provider returns.\r\n';
    const split = splitFrontMatter(text);
    expect(split.front).toContain('sections:');
    expect(split.body.startsWith('\r\n# Glossary')).toBe(true);
    expect(split.bodyLine).toBe(5);
  });
});
