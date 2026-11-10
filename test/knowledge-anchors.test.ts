import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { anchorLines, documentAnchors, findAnchor } from '../src/knowledge/anchors.js';
import { Resolver } from '../src/knowledge/resolve.js';
import { splitFrontMatter } from '../src/knowledge/markdown.js';
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

describe('the front matter is read without a pattern over the document', () => {
  test('a byte-order mark and CRLF line ends are read as the front matter they are', () => {
    const text = '\uFEFF---\r\nsections:\r\n  Terms: doc.term\r\n---\r\n\r\n# Glossary\r\n\r\n- **Payment token** - The proof a provider returns.\r\n';
    const split = splitFrontMatter(text);
    expect(split.front).toContain('sections:');
    expect(split.body.startsWith('\r\n# Glossary')).toBe(true);
    expect(split.bodyLine).toBe(5);
  });
});
