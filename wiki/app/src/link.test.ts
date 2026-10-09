/**
 * The link rules of requirement `pages`, on the classifier that fuels the
 * renderer: a link between pages, one to an outside address, a link to an
 * anchor on the page, and one resolved against the page it was written on.
 */
import { describe, expect, test } from 'bun:test';
import { classifyTarget, resolveLink } from './link.js';

const held = new Set(['docs/vision.md', 'docs/notes.md']);

describe('a Markdown link target', () => {
  test('a link to a page the wiki holds opens that page', () => {
    expect(classifyTarget('docs/index.md', 'vision.md')).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
    expect(resolveLink('docs/index.md', 'vision.md', held)).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
  });

  test('a link resolves against the page it was written on, including up', () => {
    expect(classifyTarget('docs/deep/x.md', '../vision.md')).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
  });

  test('a link whose target the wiki does not hold is shown as its text', () => {
    expect(resolveLink('docs/index.md', '../AGENTS.md', held)).toEqual({ kind: 'plain' });
  });

  test('a link to an outside address is shown as its text', () => {
    expect(classifyTarget('docs/index.md', 'https://example.com/a?b=1')).toEqual({ kind: 'plain' });
    expect(classifyTarget('docs/index.md', '//example.com/a')).toEqual({ kind: 'plain' });
    expect(classifyTarget('docs/index.md', 'mailto:a@b.c')).toEqual({ kind: 'plain' });
  });

  test('a same-page anchor names no other page', () => {
    expect(classifyTarget('docs/index.md', '#part')).toEqual({ kind: 'plain' });
  });

  test('a relative target with percent escapes is decoded before it is resolved (finding 2.10)', () => {
    expect(resolveLink('docs/index.md', 'a%20b.md', new Set(['docs/a b.md']))).toEqual({ kind: 'wiki', path: 'docs/a b.md' });
    // An escape the wiki cannot read stays plain.
    expect(resolveLink('docs/index.md', 'a%zz.md', held)).toEqual({ kind: 'plain' });
  });

  test('a product-root destination naming a held page opens it (finding 2.10)', () => {
    expect(resolveLink('docs/index.md', '/docs/vision.md', held)).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
    expect(resolveLink('docs/deep/x.md', '/docs/vision.md', held)).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
    // A rooted target naming no held page stays plain.
    expect(resolveLink('docs/index.md', '/docs/other.md', held)).toEqual({ kind: 'plain' });
  });

  test('a link written as the wiki\'s own address opens that page (finding 5)', () => {
    expect(resolveLink('docs/index.md', '/p/docs/vision.md', held)).toEqual({ kind: 'wiki', path: 'docs/vision.md' });
    expect(resolveLink('docs/index.md', '/p/docs/a%20b.md', new Set(['docs/a b.md']))).toEqual({ kind: 'wiki', path: 'docs/a b.md' });
    // An address the wiki's route shape names, for a page the wiki does not hold, stays plain.
    expect(resolveLink('docs/index.md', '/p/AGENTS.md', held)).toEqual({ kind: 'plain' });
    // A rooted address that is not a page address stays plain too.
    expect(resolveLink('docs/index.md', '/assets/app.js', held)).toEqual({ kind: 'plain' });
  });
});
