import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { anchorLines, documentAnchors, findAnchor } from '../src/knowledge/anchors.js';
import { Resolver } from '../src/knowledge/resolve.js';
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
