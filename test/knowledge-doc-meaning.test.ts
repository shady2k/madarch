/**
 * Documents are read by meaning (madarch-ztyq.3, decision 0032 section 4).
 *
 * The expected values are read off the training repository's own documents and
 * off texts this test writes, never off the engine's output: the unnumbered
 * `## Qualities` section is two requirements, a copy of the requirements
 * document with its numbers taken out is the same entities with the same stable
 * identities, and what no document holds is said with the manifest's file, line
 * and full path. Every read here uses `fakeClassifier()`, the deterministic
 * classifier — no model runs in this file.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { anchorLines, findAnchor } from '../src/knowledge/anchors.js';
import { docEntityId, entityAtAddress, readDocEntities, type DocumentSource } from '../src/knowledge/doc-entities.js';
import { assignIdentities, IDENTITIES_FILE, readDocIdentities, textDigest, writeDocIdentities } from '../src/knowledge/doc-identities.js';
import { readDocTree } from '../src/knowledge/doc-tree.js';
import { parseKinds, type KindsManifest } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { CLASSIFICATIONS_FILE, classificationKey, fakeClassifier, readClassificationStore, relativeReadings, storedClassifier, writeClassificationStore } from '../src/knowledge/semantics.js';
import { ROOT } from './knowledge-fixture.js';

const DOCS = join(ROOT, 'examples/training-repository/template/docs');
const doc = (name: string): string => readFileSync(join(DOCS, name), 'utf8');

const made: string[] = [];
const scratch = (name: string): string => {
  const folder = mkdtempSync(join(tmpdir(), `madarch-doc-meaning-${name}-`));
  made.push(folder);
  return folder;
};
afterAll(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });

/** A product folder holding the one template these manifests name. */
const folder = scratch('product');
mkdirSync(join(folder, 'templates'), { recursive: true });
writeFileSync(join(folder, 'templates', 'x.md'), ':::body\n');
const MANIFEST_FILE = join(folder, 'madarch/kinds.yaml');

/** A manifest of this test's own: the template every kind names is the one the folder holds. */
function parse(lines: readonly string[]): KindsManifest {
  return parseKinds(`${lines.join('\n')}\n`, MANIFEST_FILE, folder);
}

/** The training product's own manifest: the starter set `madarch new` writes. */
const starterFolder = scratch('starter');
for (const file of STARTER_FILES) {
  mkdirSync(dirname(join(starterFolder, file.path)), { recursive: true });
  writeFileSync(join(starterFolder, file.path), file.content);
}
const STARTER = parseKinds(STARTER_FILES.find((file) => file.path === 'madarch/kinds.yaml')!.content, join(starterFolder, 'madarch/kinds.yaml'), starterFolder);

const requirements: DocumentSource = { repo: 'training', path: 'docs/requirements.md', text: doc('requirements.md') };
const training: DocumentSource[] = [requirements, { repo: 'training', path: 'docs/glossary.md', text: doc('glossary.md') }, { repo: 'training', path: 'docs/adr/0001-broker.md', text: doc('adr/0001-broker.md') }, { repo: 'training', path: 'docs/adr/0002-outbox.md', text: doc('adr/0002-outbox.md') }];

describe('a document is a tree, and every node carries the place of its own source', () => {
  const tree = readDocTree(requirements);

  test('a heading and a list item have their lines, their character offsets and their byte offsets', () => {
    const heading = tree.nodes[0]!;
    expect(heading).toMatchObject({ type: 'heading', level: 1, raw: '# Requirements', plain: 'Requirements', line: 1, endLine: 1, startOffset: 0, endOffset: 14, startByte: 0, endByte: 14 });
    const useCases = tree.sections.find((section) => section.heading?.plain === 'Use cases')!;
    const pay = useCases.nodes[0]!.children[1]!;
    expect(pay).toMatchObject({ type: 'listItem', line: 8, endLine: 10 });
    expect(pay.raw.startsWith('- **UC-2 Pay.**')).toBe(true);
    expect(requirements.text.slice(pay.startOffset, pay.endOffset)).toBe(pay.raw);
  });

  test('a section is its heading and its own blocks, with the heading ancestry above it; its text is the document\'s own', () => {
    const qualities = tree.sections.find((section) => section.heading?.plain === 'Qualities')!;
    expect(qualities).toMatchObject({ line: 45 });
    expect(qualities.headingPath).toEqual(['Requirements', 'Qualities']);
    expect(qualities.nodes.map((node) => node.type)).toEqual(['list', 'html']);
    expect(qualities.text.startsWith('- The payment provider may be slow:')).toBe(true);
    expect(qualities.text).toContain('(see ADR-0002).');
  });

  test('the byte offsets of a text that is not ASCII are its bytes, not its characters', () => {
    const russian = readDocTree({ repo: null, path: 'docs/ru.md', text: '# Качества\n\n- Пункт один.\n' });
    const heading = russian.nodes[0]!;
    expect(heading.plain).toBe('Качества');
    expect(heading.endOffset - heading.startOffset).toBe('# Качества'.length);
    expect([heading.startByte, heading.endByte]).toEqual([0, Buffer.byteLength('# Качества', 'utf8')]);
    const item = russian.sections[0]!.nodes[0]!.children[0]!;
    expect(item).toMatchObject({ type: 'listItem', line: 3, endLine: 3, raw: '- Пункт один.' });
    expect(item.endByte - item.startByte).toBe(Buffer.byteLength('- Пункт один.', 'utf8'));
  });

  test('the byte offsets are counted against the document as written, not against its masked front matter', () => {
    // The front matter is blanked before the parse so every line keeps its number, and a masked non-ASCII field would
    // count one byte where the source has two (madarch-ztyq.3, the review of finding 9).
    const front = '---\ntitle: Качества\n---\n\n# Качества\n\nBody.\n';
    const heading = readDocTree({ repo: null, path: 'docs/ru.md', text: front }).nodes[0]!;
    expect(heading.plain).toBe('Качества');
    expect(heading.startOffset).toBe(front.indexOf('# Качества'));
    expect(heading.startByte).toBe(Buffer.byteLength(front.slice(0, front.indexOf('# Качества')), 'utf8'));
    expect(heading.endByte - heading.startByte).toBe(Buffer.byteLength('# Качества', 'utf8'));
    expect(heading.endOffset - heading.startOffset).toBe('# Качества'.length);
  });

  test('a finding names both the identity a reader navigates by and the file on this machine', () => {
    // Two places for every diagnostic (madarch-ztyq.3, the review of finding 8): the path a reader navigates by, and the
    // file a person opens. The source's `origin` is what the reader knows of the file on disk.
    const source = { repo: 'shop', path: 'docs/x.md', text: '- **UC-1 One.** a\n- **UC-1 Again.** b\n', origin: '/srv/checkouts/shop/docs/x.md' };
    const read = readDocEntities([source], parse(['kinds:', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC }']));
    expect(read.findings).toHaveLength(1);
    expect(read.findings[0]).toMatchObject({ file: 'repos/shop/docs/x.md', line: 2, source: '/srv/checkouts/shop/docs/x.md' });
    expect(read.findings[0]!.message).toContain('opens a second section of this document');
  });

  test('the front matter is metadata, not a section, and a document before its first heading is its own section', () => {
    const withFront = readDocTree({ repo: null, path: 'docs/x.md', text: '---\nsections:\n  Stories: doc.story\n---\n\nLoose words.\n\n# Title\n\nBody.\n' });
    expect(withFront.meta).toEqual({ sections: { Stories: 'doc.story' } });
    expect(withFront.sections.map((section) => [section.heading?.plain ?? null, section.line])).toEqual([[null, 6], ['Title', 8]]);
    expect(withFront.sections[0]!.text).toBe('Loose words.');
    expect(withFront.findings).toEqual([]);
  });
});

describe('the training product\'s documents, read by meaning', () => {
  const read = readDocEntities(training, STARTER);

  test('the unnumbered Qualities section yields its two requirements, by the structure and not by a number', () => {
    const qualities = read.entities.filter((entity) => entity.kind === 'doc.requirement');
    expect(qualities.map((entity) => entity.title)).toEqual([
      'The payment provider may be slow',
      'Every change of an order reaches Kafka exactly when the change is committed (see ADR-0002)',
    ]);
    expect(qualities.map((entity) => [entity.anchor, entity.line, entity.endLine])).toEqual([['qualities.1', 47, 48], ['qualities.2', 49, 50]]);
    expect(qualities.map((entity) => [entity.pass, entity.semantics, entity.identifier])).toEqual([['structure', 'quality', null], ['structure', 'quality', null]]);
    expect(qualities[0]!.text).toContain('a payment call that does not answer');
    // The page id names the passage's durable identity (a counter name), never the anchor a heading may change.
    expect(qualities[0]!.stableId).toMatch(/^doc-section:[0-9]+$/);
    expect(qualities[0]!.id).toBe(docEntityId('training', 'docs/requirements.md', qualities[0]!.stableId));
    // The anchors are the ones the one anchor reader names, so a ground to either of them opens the entity's page.
    const lines = anchorLines(requirements.text);
    for (const entity of qualities) expect(lines.get(entity.anchor)).toBe(entity.line);
  });

  test('the numbered sections are decided by the metadata pass, and their anchors are the numbers they write', () => {
    const useCases = read.entities.filter((entity) => entity.kind === 'doc.use-case');
    expect(useCases.map((entity) => [entity.identifier, entity.anchor, entity.pass, entity.line])).toEqual([
      ['UC-1', 'uc-1', 'metadata', 5], ['UC-2', 'uc-2', 'metadata', 8], ['UC-3', 'uc-3', 'metadata', 12], ['UC-4', 'uc-4', 'metadata', 14],
    ]);
    expect(useCases.every((entity) => entity.semantics === 'scenario')).toBe(true);
    const rules = read.entities.filter((entity) => entity.kind === 'doc.rule').map((entity) => entity.identifier);
    expect(rules).toEqual(['BR-1', 'BR-2', 'BR-3', 'BR-4', 'BR-5']);
    const terms = read.entities.filter((entity) => entity.kind === 'doc.term').map((entity) => entity.title);
    expect(terms).toEqual(['Order', 'Outbox', 'Idempotency key', 'CardToken', 'PaymentToken', 'Capture', 'Zero-rated']);
  });

  test('an ADR is its whole section, from its heading to the end of the file, and the structure it declares is complete', () => {
    const broker = read.entities.find((entity) => entity.anchor === 'adr-0001')!;
    expect(broker).toMatchObject({ kind: 'doc.decision', title: 'ADR-0001 Kafka is the broker', line: 1, endLine: 28, pass: 'metadata', semantics: 'decision' });
    expect(broker.text).toContain('## Context');
    expect(broker.text).toContain('Consumers must tolerate duplicates');
    // Status, Context, Decision and Consequences all stand in it, so nothing is said to be missing.
    expect(read.findings.filter((finding) => finding.message.includes('which the manifest declares its structure'))).toEqual([]);
  });

  test('nothing the documents hold is silently smaller: the training documents are read with no finding at all', () => {
    expect(read.findings).toEqual([]);
    expect(read.entities.length).toBe(20);
  });

  test('a copy of requirements.md with its UC-/BR- numbers taken out holds the same entities with the same stable identities', () => {
    const renumbered = requirements.text.replace(/\*\*(UC|BR)-\d+ /g, '**');
    expect(renumbered).not.toContain('**UC-1 ');
    expect(renumbered).not.toContain('**BR-1 ');
    expect(renumbered).toContain('**Place order.**');
    const numbered = readDocEntities([requirements], STARTER);
    const without = readDocEntities([{ repo: 'training', path: 'docs/requirements.md', text: renumbered }], STARTER, { identities: numbered.identities });
    const key = (entity: { kind: string; stableId: string }): string => `${entity.kind}\u0000${entity.stableId}`;
    expect([...without.entities.map(key)].sort()).toEqual([...numbered.entities.map(key)].sort());
    expect(without.entities.map((entity) => entity.identifier)).toEqual(without.entities.map(() => null));
    // The anchor follows the words the document writes, the identity does not: the alias is not the identity.
    expect(without.entities.map((entity) => entity.anchor)).not.toEqual(numbered.entities.map((entity) => entity.anchor));
    for (const entity of without.entities) expect(numbered.entities.find((candidate) => candidate.stableId === entity.stableId)!.text).toBe(entity.text);
    const pay = without.entities.find((entity) => entity.stableId === numbered.entities.find((candidate) => candidate.anchor === 'uc-2')!.stableId)!;
    expect(pay).toMatchObject({ kind: 'doc.use-case', anchor: 'pay', line: 8, pass: 'structure', title: 'Pay' });
  });
});

describe('the three passes, each recording which one decided', () => {
  const stories = '# Stories\n\nA shopper pays by card.\n\nSupport refunds a payment.\n';
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.story: { template: templates/x.md, source: document, semantics: scenario }',
    '  doc.rule: { template: templates/x.md, source: document, semantics: rule, headings: [Rules] }',
    '  doc.requirement: { template: templates/x.md, source: document, semantics: quality }',
  ]);

  test('the classifier splits a section into its passages, and the section\'s own text stands as the document writes it', () => {
    const read = readDocEntities([{ repo: null, path: 'docs/stories.md', text: stories }], manifest(), { classifier: fakeClassifier({ Stories: 'scenario' }) });
    expect(read.entities.map((entity) => [entity.kind, entity.pass, entity.anchor, entity.line, entity.endLine, entity.text])).toEqual([
      ['doc.story', 'classifier', 'stories.1', 3, 3, 'A shopper pays by card.'],
      ['doc.story', 'classifier', 'stories.2', 5, 5, 'Support refunds a payment.'],
    ]);
    expect(read.entities.map((entity) => entity.semantics)).toEqual(['scenario', 'scenario']);
    const section = readDocTree({ repo: null, path: 'docs/stories.md', text: stories }).sections[0]!;
    expect(section.text).toBe('A shopper pays by card.\n\nSupport refunds a payment.');
  });

  test('a passage that holds several meanings is split into them, and each keeps the document\'s words', () => {
    const mixed = '# Mixed\n\nA rule that holds.\n\nA quality that is wanted.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/mixed.md', text: mixed }], manifest(), { classifier: fakeClassifier({ Mixed: ['rule', 'quality'] }) });
    expect(read.entities.map((entity) => [entity.kind, entity.semantics, entity.pass, entity.text])).toEqual([
      ['doc.rule', 'rule', 'classifier', 'A rule that holds.'],
      ['doc.requirement', 'quality', 'classifier', 'A quality that is wanted.'],
    ]);
  });

  test('without a classifier the third pass decides nothing and nothing is invented, and a section it could not read is a finding', () => {
    expect(readDocEntities([{ repo: null, path: 'docs/stories.md', text: stories }], manifest()).entities).toEqual([]);
    const unread = readDocEntities([{ repo: null, path: 'docs/stories.md', text: stories }], manifest(), { classifier: fakeClassifier({}) });
    expect(unread.entities).toEqual([]);
    // Every passage the classifier did not read is named, with its own line, rather than the section as a whole.
    expect(unread.findings.map((finding) => [finding.file, finding.line])).toEqual([['docs/stories.md', 3], ['docs/stories.md', 5]]);
    expect(unread.findings[0]!.message).toContain('no classifier has read this passage yet');
  });

  test('a passage of a general kind no kind of the manifest names is a finding at the passage, not a passage that vanishes', () => {
    const read = readDocEntities([{ repo: null, path: 'docs/stories.md', text: stories }], parse(['kinds:', '  doc.rule: { template: templates/x.md, source: document, semantics: rule }']), { classifier: fakeClassifier({ Stories: 'actor' }) });
    expect(read.entities).toEqual([]);
    expect(read.findings.map((finding) => [finding.file, finding.line])).toEqual([['docs/stories.md', 3], ['docs/stories.md', 5]]);
    expect(read.findings[0]!.message).toContain('the manifest declares no kind with "semantics: actor"');
  });

  test('the classifier\'s answers are data the host keeps beside the product: a stored answer is read back and answered with', () => {
    const store = join(scratch('store'), CLASSIFICATIONS_FILE);
    const section = readDocTree({ repo: null, path: 'docs/stories.md', text: stories }).sections[0]!;
    const key = classificationKey({ repo: null, path: 'docs/stories.md', headingPath: section.headingPath, text: section.text });
    // A reading is kept with its lines counted from the body's first line (not the heading's), so an insertion above the
    // section, a heading written another way or a blank line under it moves the reading with the text it was read from.
    const bodyLine = section.nodes[0]!.line;
    writeClassificationStore(store, new Map([[key, relativeReadings([{ kind: 'scenario', text: 'A shopper pays by card.', line: 3, endLine: 3 }], bodyLine)]]));
    const read = readClassificationStore(store);
    expect(read.findings).toEqual([]);
    const held = readDocEntities([{ repo: null, path: 'docs/stories.md', text: stories }], manifest(), { classifier: storedClassifier(read.answers) });
    expect(held.entities.map((entity) => [entity.kind, entity.pass, entity.line])).toEqual([['doc.story', 'classifier', 3]]);
    // A paragraph inserted above the section moves every line of it: the reading is kept relative to the section and is
    // rebased onto the lines the section has now, so it still names the same passage (madarch-ztyq.3, finding 6).
    const moved = `A note before the stories.\n\n${stories}`;
    const shifted = readDocEntities([{ repo: null, path: 'docs/stories.md', text: moved }], manifest(), { classifier: storedClassifier(read.answers) });
    const movedStory = shifted.entities.find((entity) => entity.kind === 'doc.story')!;
    expect([movedStory.line, movedStory.text]).toEqual([5, 'A shopper pays by card.']);
    // The passage no answer covers is said, not dropped: a host that filled half the section cannot shrink the wiki silently.
    expect(held.findings.map((finding) => [finding.file, finding.line])).toEqual([['docs/stories.md', 5]]);
    expect(held.findings[0]!.message).toContain('the classifier read no meaning of this passage');
    // A store that cannot be read is a finding naming the file and the line, never an answer nobody wrote.
    writeFileSync(store, '{ not json\n');
    expect(readClassificationStore(store).findings).toEqual([{ file: store, line: 1, message: expect.stringContaining('not valid JSON') }]);
    expect(readClassificationStore(store).answers.size).toBe(0);
  });
});

describe('the passages of one section are decided one by one', () => {
  const rules = (lines: readonly string[]): KindsManifest => parse(['kinds:', '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule, headings: [Business rules] }', ...lines]);

  test('an identified rule followed by an unnumbered one keeps both: the metadata pass decides one block, the structure the other', () => {
    const text = '# Rules\n\n## Business rules\n\n- **BR-1 Discount.** A discount is taken off each line.\n- Paying twice with one key charges the card once.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/rules.md', text }], rules([]));
    expect(read.entities.map((entity) => [entity.kind, entity.pass, entity.anchor, entity.identifier, entity.title])).toEqual([
      ['doc.rule', 'metadata', 'br-1', 'BR-1', 'BR-1 Discount'],
      ['doc.rule', 'structure', 'business-rules.1', null, 'Paying twice with one key charges the card once'],
    ]);
    expect(read.findings).toEqual([]);
  });

  test('every passage no pass could decide is a finding of its own, with its own words, when no classifier is wired', () => {
    const text = '# Notes\n\n- **BR-1 Discount.** A discount is taken off each line.\n- **ZZ-9 Loyalty points.** Points are added after a paid order.\n- Rows are read in the order they were written.\n';
    // `ZZ` is no prefix of this manifest, the heading is none the manifest declares, and without a classifier nothing can
    // read the two passages: each is said with its own words rather than left out of a smaller document (madarch-ztyq.3,
    // the review of finding 5).
    const manifest = parse(['kinds:', '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule, headings: [Business rules] }']);
    const read = readDocEntities([{ repo: 'shop', path: 'docs/rules.md', text, origin: '/srv/checkouts/shop/docs/rules.md' }], manifest);
    expect(read.entities.map((entity) => [entity.pass, entity.anchor])).toEqual([['metadata', 'br-1']]);
    expect(read.findings.map((finding) => [finding.kind, finding.line])).toEqual([['unread-passage', 4], ['unread-passage', 5]]);
    expect(read.findings.map((finding) => [finding.file, finding.source])).toEqual([['repos/shop/docs/rules.md', '/srv/checkouts/shop/docs/rules.md'], ['repos/shop/docs/rules.md', '/srv/checkouts/shop/docs/rules.md']]);
    expect(read.findings[0]!.message).toContain('no kind of the manifest and no classifier read this passage');
    expect(read.findings[0]!.message).toContain('«ZZ-9 Loyalty points»');
    expect(read.findings[1]!.message).toContain('«Rows are read in the order they were written»');
  }, 60_000);

  test('two meanings in one paragraph are two entities, each with its own anchor and the words the reading named', () => {
    const text = '# Stories\n\nA shopper pays by card. Support refunds a payment.\n';
    const manifest = parse(['kinds:', '  doc.story: { template: templates/x.md, source: document, semantics: scenario }', '  doc.actor: { template: templates/x.md, source: document, semantics: actor }']);
    // A classifier that splits one paragraph into the two meanings it holds.
    const splitting = { classify: (request: { blocks: readonly { line: number }[] }) => {
      const line = request.blocks[0]!.line;
      return [
        { kind: 'scenario' as const, text: 'A shopper pays by card.', line, endLine: line },
        { kind: 'actor' as const, text: 'Support refunds a payment.', line, endLine: line },
      ];
    } };
    const read = readDocEntities([{ repo: null, path: 'docs/stories.md', text }], manifest, { classifier: splitting });
    expect(read.entities.map((entity) => [entity.kind, entity.semantics, entity.anchor, entity.text])).toEqual([
      ['doc.story', 'scenario', 'stories.1', 'A shopper pays by card.'],
      ['doc.actor', 'actor', 'stories.1.2', 'Support refunds a payment.'],
    ]);
    // Both anchors resolve to the paragraph they were read in, and each address opens its OWN passage: the second reads
    // its anchor as the block's with its place in it (madarch-ztyq.3, the review of C(b)).
    expect(findAnchor(text, 'stories.1.2')).toBe(3);
    expect(findAnchor(text, 'stories.1')).toBe(3);
    const entities = new Map(read.entities.map((entity) => [entity.id, entity]));
    expect(entityAtAddress(entities, 'doc:docs/stories.md#stories.1')).toBe(read.entities[0]!);
    expect(entityAtAddress(entities, 'doc:docs/stories.md#stories.1.2')).toBe(read.entities[1]!);
    expect(entityAtAddress(entities, read.entities[1]!.id)).toBe(read.entities[1]!);
    expect(new Set(read.entities.map((entity) => entity.id)).size).toBe(2);
    expect(read.findings).toEqual([]);
  });
});

describe('a number is an alias, never the identity', () => {
  const identitiesOf = (text: string, previous?: ReturnType<typeof readDocEntities>['identities']) => readDocEntities([{ repo: 'training', path: 'docs/requirements.md', text }], STARTER, previous === undefined ? {} : { identities: previous });

  test('a renamed heading keeps the identity of its section, and its anchor follows the new heading', () => {
    const first = identitiesOf(requirements.text);
    const qualifying = first.entities.filter((entity) => entity.kind === 'doc.requirement').map((entity) => entity.stableId);
    // The starter manifest declares both of these headings, so the renamed section is still read as the same kind.
    const renamed = requirements.text.replace('## Qualities', '## Non-functional requirements');
    const second = identitiesOf(renamed, first.identities);
    const held = second.entities.filter((entity) => entity.kind === 'doc.requirement');
    expect(held.map((entity) => entity.stableId)).toEqual(qualifying);
    expect(held.map((entity) => entity.anchor)).toEqual(['non-functional-requirements.1', 'non-functional-requirements.2']);
  });

  test('a new section gets a new identity, and the sections it joins keep theirs', () => {
    const first = identitiesOf(requirements.text);
    const held = first.entities.filter((entity) => entity.kind === 'doc.requirement').map((entity) => entity.stableId);
    const added = requirements.text.replace('- Every change of an order reaches Kafka exactly when the change is committed\n  (see ADR-0002).', '- Every change of an order reaches Kafka exactly when the change is committed\n  (see ADR-0002).\n- A third quality, written after the first read of this document.');
    expect(added).not.toBe(requirements.text);
    const second = identitiesOf(added, first.identities);
    const qualities = second.entities.filter((entity) => entity.kind === 'doc.requirement');
    expect(qualities.length).toBe(3);
    expect(qualities.slice(0, 2).map((entity) => entity.stableId)).toEqual(held);
    expect(held).not.toContain(qualities[2]!.stableId);
  });

  test('two numbers swapped exchange nothing: each passage keeps its page and only its anchor moves', () => {
    // `UC-1` and `UC-2` change places. Reading identities from the anchor would hand each passage the other's page; the
    // content decides first, so each keeps its own (madarch-ztyq.3, the review of finding 3).
    const swapped = requirements.text
      .replace('**UC-1 Place order.**', '**@@**')
      .replace('**UC-2 Pay.**', '**UC-1 Place order.**')
      .replace('**@@**', '**UC-2 Pay.**');
    expect(swapped).not.toBe(requirements.text);
    const first = readDocEntities([requirements], STARTER);
    const second = readDocEntities([{ repo: 'training', path: 'docs/requirements.md', text: swapped }], STARTER, { identities: first.identities });
    const passage = (read: typeof first, words: string) => read.entities.find((entity) => entity.text.includes(words))!;
    const before = passage(first, 'A signed-in shopper submits a cart.');
    const after = passage(second, 'A signed-in shopper submits a cart.');
    // The first read mints the document's counter names, in document order; a swap of two numbers changes no name.
    expect([before.stableId, before.anchor, before.identifier]).toEqual(['doc-section:1', 'uc-1', 'UC-1']);
    expect([after.stableId, after.anchor, after.identifier]).toEqual(['doc-section:1', 'uc-2', 'UC-2']);
    expect(after.id).toBe(before.id);
    // And the other passage keeps its own too, so neither identity was exchanged.
    const payBefore = passage(first, 'Checkout asks payments to authorize the card');
    const payAfter = passage(second, 'Checkout asks payments to authorize the card');
    expect([payBefore.stableId, payBefore.anchor]).toEqual(['doc-section:2', 'uc-2']);
    expect([payAfter.stableId, payAfter.anchor]).toEqual(['doc-section:2', 'uc-1']);
  });

  test('an unnamed passage added before the others shifts no identity, and the passage it joins keeps its page', () => {
    const inserted = requirements.text.replace('- **UC-1 Place order.**', '- A shopper browses the catalogue before signing in.\n- **UC-1 Place order.**');
    expect(inserted).not.toBe(requirements.text);
    const first = readDocEntities([requirements], STARTER);
    const second = readDocEntities([{ repo: 'training', path: 'docs/requirements.md', text: inserted }], STARTER, { identities: first.identities });
    const useCases = (read: typeof first) => read.entities.filter((entity) => entity.kind === 'doc.use-case');
    expect(useCases(second).length).toBe(useCases(first).length + 1);
    for (const entity of useCases(first)) expect(useCases(second).find((other) => other.text === entity.text)!.stableId).toBe(entity.stableId);
    const added = useCases(second).find((entity) => entity.text.startsWith('A shopper browses'))!;
    expect(first.entities.map((entity) => entity.stableId)).not.toContain(added.stableId);
  });

  test('an edited section keeps its identity through its anchor, and a removed one is never given to the section that follows it', () => {
    const key = 'training/docs/requirements.md';
    const first = assignIdentities(key, [{ anchor: 'uc-1', kind: 'doc.use-case', title: 'UC-1 Place order', text: 'The shopper places an order.' }], undefined);
    expect(first.ids).toEqual(['doc-section:1']);
    const edited = assignIdentities(key, [{ anchor: 'uc-1', kind: 'doc.use-case', title: 'UC-1 Place an order', text: 'The shopper places an order, again.' }], first.next);
    expect(edited.ids).toEqual(first.ids);
    const replaced = assignIdentities(key, [{ anchor: 'uc-9', kind: 'doc.use-case', title: 'UC-9 Something else', text: 'Something else entirely.' }], first.next);
    expect(replaced.ids).toEqual(['doc-section:2']);
    expect(replaced.ids).not.toEqual(first.ids);
  });

  test('a passage removed and written again keeps its old page for nobody: the counter never hands a retired name to another', () => {
    // Read UC-1, then read the document without it, then read a document that writes an unrelated UC-1 again. Under a
    // name taken from the anchor, the third read would mint `uc-1` again and every old link would open a stranger
    // (madarch-ztyq.3, the review of finding B).
    const key = 'training/docs/requirements.md';
    const one = assignIdentities(key, [{ anchor: 'uc-1', kind: 'doc.use-case', title: 'UC-1 Place order', text: 'The shopper places an order.' }], undefined);
    const empty = assignIdentities(key, [], one.next);
    expect(empty.ids).toEqual([]);
    expect(empty.next.nextSequence).toBe(one.next.nextSequence);
    const again = assignIdentities(key, [{ anchor: 'uc-1', kind: 'doc.use-case', title: 'UC-1 Something else', text: 'An unrelated passage that now carries the same number.' }], empty.next);
    expect(again.ids).toEqual(['doc-section:2']);
    expect(again.ids[0]).not.toBe(one.ids[0]);
  });

  test('a document read with no identities beside it is read again with new ones, and the same text gives the same digest', () => {
    const first = readDocEntities([requirements], STARTER);
    expect(first.identities.has('@training/docs/requirements.md')).toBe(true);
    expect(first.identities.has('docs/requirements.md')).toBe(false);
    // A document this read does not see keeps the identity it had: a document that drops out for a moment does not lose its links.
    const onlyGlossary = readDocEntities([{ repo: 'training', path: 'docs/glossary.md', text: doc('glossary.md') }], STARTER, { identities: first.identities });
    expect(onlyGlossary.identities.get('@training/docs/requirements.md')).toEqual(first.identities.get('@training/docs/requirements.md'));
    expect(textDigest('A  rule\n holds.')).toBe(textDigest('A rule holds.'));
    const again = readDocEntities([requirements], STARTER, { identities: first.identities });
    expect(again.entities.map((entity) => entity.stableId)).toEqual(first.entities.map((entity) => entity.stableId));
  });
});

describe('the identities live beside the product, in its store and never in the repository', () => {
  test('they are written to a file of the store and read back as they were written', () => {
    const store = scratch('identities');
    const file = join(store, IDENTITIES_FILE);
    expect(IDENTITIES_FILE).toBe('doc-identities.json');
    const identities = new Map([['training/docs/requirements.md', { nextSequence: 3, sections: [{ id: 'uc-2', anchor: 'uc-2', kind: 'doc.use-case', digest: 'd', title: 'UC-2 Pay' }] }]]);
    writeDocIdentities(file, identities);
    const read = readDocIdentities(file);
    expect(read.findings).toEqual([]);
    expect([...read.identities]).toEqual([...identities]);
  });

  test('a store that is absent is a product that was never read, and one that cannot be read is a finding naming the file and the line', () => {
    expect(readDocIdentities(join(scratch('absent'), IDENTITIES_FILE))).toEqual({ identities: new Map(), findings: [] });
    const file = join(scratch('broken'), IDENTITIES_FILE);
    writeFileSync(file, '{ not json\n');
    expect(readDocIdentities(file).findings).toEqual([{ file, line: 1, message: expect.stringContaining('not valid JSON') }]);
    writeFileSync(file, '{"documents": { "docs/x.md": { "nextSequence": 1, "sections": [ { "id": "s" } ] } }}\n');
    const partial = readDocIdentities(file);
    expect(partial.identities.get('docs/x.md')).toEqual({ nextSequence: 1, sections: [] });
    expect(partial.findings.map((finding) => [finding.file, finding.line])).toEqual([[file, 1]]);
    expect(partial.findings[0]!.message).toContain('so that section is read as new');
  });
});

describe('the wiki says what the documents lack', () => {
  const lines = [
    'documents:',
    '  expect: [doc.use-case, doc.user-story]',
    'kinds:',
    '  doc.use-case: { template: templates/x.md, source: document, identifier: UC }',
    '  doc.user-story: { template: templates/x.md, source: document, identifier: US, semantics: scenario }',
  ];

  // A document of use cases alone: a manifest that declares use cases and expects more says what it lacks, and nothing
  // else of the document is left unread.
  const useCasesOnly: DocumentSource = { repo: 'training', path: 'docs/use-cases.md', text: '# Requirements\n\n## Use cases\n\n- **UC-1 Place order.** A signed-in shopper submits a cart.\n- **UC-2 Pay.** Checkout asks payments to authorize the card.\n' };

  test('a kind the product expects and no document holds is a finding with the manifest\'s file, line and full path', () => {
    const read = readDocEntities([useCasesOnly], parse(lines));
    expect(read.findings).toEqual([{ file: MANIFEST_FILE, line: 2, message: expect.stringContaining('the documents hold no entity of kind "doc.user-story" (a scenario)') }]);
    // The kind the documents do hold is not said to be missing.
    expect(read.entities.some((entity) => entity.kind === 'doc.use-case')).toBe(true);
  });

  test('a kind the documents hold is not reported, and an expectation that names no kind is a finding of the manifest at its own line', () => {
    expect(readDocEntities([useCasesOnly], parse(['documents:', '  expect: [doc.use-case]', 'kinds:', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC }'])).findings).toEqual([]);
    const wrong = parse(['documents:', '  expect: [doc.gone]', 'kinds:', '  doc.use-case: { template: templates/x.md, source: document, identifier: UC }']);
    expect(wrong.expect).toEqual([]);
    expect(wrong.findings).toEqual([{ file: MANIFEST_FILE, line: 2, message: expect.stringContaining('"documents.expect" names the kind "doc.gone"') }]);
  });

  test('a document kind with a passage only a classifier reads is declared by its general kind, and a wrong one is a finding at its line', () => {
    expect(parse(['kinds:', '  doc.story: { template: templates/x.md, source: document, semantics: scenario }']).findings).toEqual([]);
    const wrong = parse(['kinds:', '  doc.story: { template: templates/x.md, source: document, semantics: legend }']);
    expect(wrong.findings).toEqual([{ file: MANIFEST_FILE, line: 2, message: expect.stringContaining('"semantics" is the general kind of the sections: scenario, actor, rule, quality, decision, procedure, term, other') }]);
    const headings = parse(['kinds:', '  doc.story: { template: templates/x.md, source: document, headings: [] }']);
    expect(headings.findings.map((finding) => finding.line)).toEqual([2]);
    expect(headings.findings[0]!.message).toContain('"headings" is a list of the headings whose sections are entities of the kind');
  });
});

describe('the structure a kind declares is checked on the section', () => {
  const manifest = (): KindsManifest => parse(['kinds:', '  doc.decision: { template: templates/x.md, source: document, identifier: ADR, semantics: decision, structure: [Status, Context, Decision, Consequences] }']);

  test('a decision record that holds every section it declares is read with no finding', () => {
    const read = readDocEntities([{ repo: 'training', path: 'docs/adr/0001-broker.md', text: doc('adr/0001-broker.md') }], manifest());
    expect(read.findings).toEqual([]);
    expect(read.entities.map((entity) => [entity.kind, entity.anchor])).toEqual([['doc.decision', 'adr-0001']]);
  });

  test('the sections it lacks are named in a finding at its line, and the document\'s own text is still shown', () => {
    const text = '# ADR-0003: Use a queue\n\n## Context\nOrders must publish.\n\n## Decision\nUse a queue.\n';
    const read = readDocEntities([{ repo: 'training', path: 'docs/adr/0003-queue.md', text }], manifest());
    expect(read.entities.map((entity) => entity.text)).toEqual([text.slice(text.indexOf('\n') + 1).trim()]);
    expect(read.findings.map((finding) => [finding.file, finding.line])).toEqual([['repos/training/docs/adr/0003-queue.md', 1]]);
    expect(read.findings[0]!.message).toContain('holds no Status, no Consequences');
  });
});

describe('the front matter says what the document\'s sections are', () => {
  const manifest = (): KindsManifest => parse(['kinds:', '  doc.story: { template: templates/x.md, source: document, semantics: scenario }']);

  test('a section the front matter names is decided by the metadata pass', () => {
    const text = ['---', 'sections:', '  Stories: doc.story', '---', '', '# Product', '', '## Stories', '', '- A shopper pays by card.', '- Support refunds a payment.', ''].join('\n');
    const read = readDocEntities([{ repo: null, path: 'docs/product.md', text }], manifest());
    expect(read.entities.map((entity) => [entity.kind, entity.pass, entity.anchor, entity.line, entity.text])).toEqual([
      ['doc.story', 'metadata', 'stories.1', 10, 'A shopper pays by card.'],
      ['doc.story', 'metadata', 'stories.2', 11, 'Support refunds a payment.'],
    ]);
    expect(read.findings).toEqual([]);
  });

  test('a front matter that names no kind of the manifest is a finding at its own line', () => {
    const text = ['---', 'sections:', '  Stories: doc.gone', '---', '', '# Product', '', '## Stories', '', '- A shopper pays by card.', ''].join('\n');
    const read = readDocEntities([{ repo: null, path: 'docs/product.md', text }], manifest());
    expect(read.entities).toEqual([]);
    // The front matter names a kind the manifest does not declare, and the one block it would have decided is
    // reported as unread rather than vanishing (the review of finding 5).
    expect(read.findings.map((finding) => [finding.file, finding.line])).toEqual([['docs/product.md', 3], ['docs/product.md', 10]]);
    expect(read.findings[0]!.message).toContain('the manifest declares no kind or general kind of that name');
  });
});

const firstDocSectionText = (text: string): string => readDocTree({ repo: null, path: 'docs/stories.md', text }).sections[0]!.text;
describe('what the fifth review found', () => {
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.story: { template: templates/x.md, source: document, semantics: scenario }',
    '  doc.requirement: { template: templates/x.md, source: document, semantics: quality, headings: [Qualities] }',
  ]);

  test('a negative number in an unbolded list item keeps its sign', () => {
    const text = '# Qualities\n\n- -5 °C is the minimum temperature.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities.map((entity) => entity.text)).toEqual(['-5 °C is the minimum temperature.']);
  });

  test('the first classified passage keeps every anchor the tree gives its block', () => {
    const text = '# Transport\n\nThe bus runs every ten minutes.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/stories.md', text }], manifest(), { classifier: fakeClassifier({ Transport: 'scenario' }) });
    const [first] = read.entities;
    expect(first!.anchor).toBe('transport.1');
    // The block's own alias is the one that answered 404 before: the reading's place and the block's place are kept
    // together on its first passage (the review of the fifth pass, finding 1).
    expect([...first!.aliases]).toContain('transport.1');
  });

  test('a stored reading survives a heading written another way, and a blank line under it', () => {
    const atx = '# Stories\n\nA shopper pays by card.\n';
    const first = readDocEntities([{ repo: null, path: 'docs/stories.md', text: atx }], manifest(), { classifier: fakeClassifier({ Stories: 'scenario' }) });
    const readings = relativeReadings(first.entities.map((entity) => ({ kind: 'scenario' as const, text: entity.text, line: entity.line, endLine: entity.endLine })), first.entities[0]!.line);
    const answers = new Map([[classificationKey({ repo: null, path: 'docs/stories.md', headingPath: ['Stories'], text: firstDocSectionText(atx) }), readings]]);
    const setext = 'Stories\n=======\n\nA shopper pays by card.\n';
    const after = readDocEntities([{ repo: null, path: 'docs/stories.md', text: setext }], manifest(), { classifier: storedClassifier(answers) });
    expect(after.entities.map((entity) => entity.text)).toEqual(['A shopper pays by card.']);
  });
});

describe('what the sixth review found', () => {
  // The transport requirement is decided by its meaning alone, so the classifier reads the paragraph; a heading
  // convention would decide the whole block before the classifier saw it.
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.requirement: { template: templates/x.md, source: document, semantics: quality }',
    '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule }',
  ]);

  test('a ground to a paragraph\'s own anchor opens its first meaning, not the second', () => {
    const text = '# Transport\n\nHTTP2 support is required. Latency must stay below 1 s.\n';
    // A classifier that splits the one paragraph into the two requirements it holds.
    const splitting = { classify: (request: { blocks: readonly { line: number }[] }) => {
      const line = request.blocks[0]!.line;
      return [
        { kind: 'quality' as const, text: 'HTTP2 support is required.', line, endLine: line },
        { kind: 'quality' as const, text: 'Latency must stay below 1 s.', line, endLine: line },
      ];
    } };
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest(), { classifier: splitting });
    const pages = new Map(read.entities.map((entity) => [entity.id, entity]));
    const byFirst = entityAtAddress(pages, 'doc:docs/requirements.md#transport.1');
    expect(read.entities).toHaveLength(2);
    expect(byFirst).toBe(read.entities[0]);
    expect(byFirst!.text).toBe('HTTP2 support is required.');
  });

  test('a rule a person wrote as a quote is read, not silently skipped', () => {
    const text = '# Rules\n\n> BR-1 Never charge twice.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities.map((entity) => [entity.kind, entity.identifier, entity.text])).toEqual([['doc.rule', 'BR-1', 'Never charge twice.']]);
  });
});

describe('what the seventh review found', () => {
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule }',
  ]);

  test('a rule written with its identifier in bold keeps only its words as the body', () => {
    const text = '# Rules\n\n**BR-1** Never charge twice.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities.map((entity) => [entity.identifier, entity.text])).toEqual([['BR-1', 'Never charge twice.']]);
  });

  test('a rule written in a table cell is reported, never lost', () => {
    // A table's cells hold phrasing, not paragraphs, so the row is no passage a kind decides; the reader says it could
    // not decide it, with the table's line, instead of dropping it (the review of the seventh pass, finding 2).
    const text = '# Rules\n\n| Rule | Text |\n| --- | --- |\n| BR-1 | Never charge twice. |\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities).toEqual([]);
    expect(read.findings.map((finding) => [finding.kind, finding.line])).toEqual([['unread-passage', 3]]);
  });

  test('every block type a document can hold is reached: none vanishes without a finding', () => {
    const blocks = ['# Rules', '', 'A plain paragraph.', '', '- A list item.', '', '> A quoted line.', '', '```', 'BR-9 code', '```', '', '<p>BR-8 html</p>', '', 'Footnote:[^1]', '', '[^1]: A footnote paragraph.', ''].join('\n');
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: blocks }], manifest());
    const read_ = new Set(read.entities.map((entity) => entity.text));
    const unread = read.findings.filter((finding) => finding.kind === 'unread-passage').map((finding) => finding.line);
    // Every block is either an entity or a finding, and the quoted rule is an entity.
    // Every block of the document is answered: an entity where a kind reads it, a finding where none does.
    expect(unread.length + read.entities.length).toBeGreaterThanOrEqual(6);
    // Every block has one disposition: read as a passage, reported as a finding, or ignored by a rule the product names.
    // This manifest names no ignore rule, so nothing is ignored here: each block is either an entity or a finding.
    const answered = new Set([...read.entities.map((entity) => entity.line), ...read.findings.map((finding) => finding.line)]);
    for (const line of [3, 5, 7, 9, 13, 15, 17]) expect([...answered]).toContain(line);
    expect(read.findings.every((finding) => finding.line > 0)).toBe(true);
    expect(read.findings.every((finding) => typeof finding.line === 'number')).toBe(true);
  });
});

describe('what the eighth review found', () => {
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule }',
    'documents:',
    '  ignore: [code, html, thematicBreak, definition]',
  ]);

  test('an escaped identifier is cut at its source end, not at its decoded length', () => {
    const text = '# Rules\n\nBR\\-1 Never charge twice.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities.map((entity) => [entity.identifier, entity.text])).toEqual([['BR-1', 'Never charge twice.']]);
  });

  test('a character reference in the identifier is cut the same way', () => {
    const text = '# Rules\n\nBR&#45;2 Never refund twice.\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.entities.map((entity) => [entity.identifier, entity.text])).toEqual([['BR-2', 'Never refund twice.']]);
  });

  test('a table is answered even when its row names no identifier', () => {
    const text = '# Rules\n\n| Never charge twice. |\n| --- |\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
    expect(read.findings.map((finding) => [finding.kind, finding.line])).toEqual([['unread-passage', 3]]);
  });
});

describe('what the ninth review found', () => {
  const manifest = (): KindsManifest => parse([
    'kinds:',
    '  doc.rule: { template: templates/x.md, source: document, identifier: BR, semantics: rule }',
    'documents:',
    '  ignore: [code, html, thematicBreak, definition]',
  ]);

  const renumber = (text: string): string => text.replace('BR-1', 'BR-2');

  test('a renumbered list rule keeps its identity, because its body excludes the identifier', () => {
    const before = '# Rules\n\n- BR-1 Never charge twice.\n';
    const first = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: before }], manifest());
    const after = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: renumber(before) }], manifest(), { identities: first.identities });
    expect(first.entities[0]!.text).toBe('Never charge twice.');
    expect(after.entities[0]!.stableId).toBe(first.entities[0]!.stableId);
    expect(after.entities[0]!.identifier).toBe('BR-2');
  });

  test('a renumbered paragraph rule keeps its identity too', () => {
    const before = '# Rules\n\nBR-1 Never charge twice.\n';
    const first = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: before }], manifest());
    const after = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: renumber(before) }], manifest(), { identities: first.identities });
    expect(after.entities[0]!.stableId).toBe(first.entities[0]!.stableId);
  });

  test('a renumbered heading rule keeps its identity, its body being the section it opens', () => {
    const before = '# BR-1 Never charge twice.\n\nThe rule holds.\n';
    const first = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: before }], manifest());
    const after = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: renumber(before) }], manifest(), { identities: first.identities });
    expect(first.entities.map((entity) => [entity.identifier, entity.anchor])).toEqual([['BR-1', 'br-1']]);
    expect(after.entities[0]!.stableId).toBe(first.entities[0]!.stableId);
    expect(after.entities[0]!.anchor).toBe('br-2');
  });

  test('a table row is no passage in either numbering: renumbering it mints no identity and leaves the same finding', () => {
    // A table's cells hold phrasing, so no kind decides a row (the seventh review). Renumbering one therefore changes
    // nothing that could carry an identity, and the reader says the same thing about it.
    const before = '# Rules\n\n| BR-1 | Never charge twice. |\n| --- | --- |\n';
    const first = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: before }], manifest());
    const after = readDocEntities([{ repo: null, path: 'docs/requirements.md', text: before.replace('BR-1', 'BR-2') }], manifest(), { identities: first.identities });
    expect([first.entities, after.entities]).toEqual([[], []]);
    expect(after.findings.map((finding) => [finding.kind, finding.line])).toEqual(first.findings.map((finding) => [finding.kind, finding.line]));
  });

  test('an emphasized or escaped lowercase identifier names its rule', () => {
    for (const text of ['# Rules\n\n*BR-1* Never charge twice.\n', '# Rules\n\nbr\\-1 Never charge twice.\n']) {
      const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], manifest());
      expect(read.entities.map((entity) => [entity.identifier, entity.text])).toEqual([['BR-1', 'Never charge twice.']]);
    }
  });

  test('a block no classifier read is reported, not dropped by the early answer', () => {
    const text = '# Rules\n\nBackground.\n\n| Never charge twice. |\n| --- |\n';
    const read = readDocEntities([{ repo: null, path: 'docs/requirements.md', text }], parse(['kinds:', '  doc.rule: { template: templates/x.md, source: document, semantics: rule }', 'documents:', '  ignore: [code, html, thematicBreak, definition]']), { classifier: fakeClassifier({}) });
    const unread = read.findings.filter((finding) => finding.kind === 'unread-passage').map((finding) => finding.line);
    expect(unread).toEqual([3, 5]);
  });
});
