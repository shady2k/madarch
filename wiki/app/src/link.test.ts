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

  test('an external link opens as it is written', () => {
    expect(classifyTarget('docs/index.md', 'https://example.com/a?b=1')).toEqual({ kind: 'external', href: 'https://example.com/a?b=1' });
    expect(classifyTarget('docs/index.md', 'mailto:a@b.c')).toEqual({ kind: 'plain' });
  });

  test('a same-page anchor names no other page', () => {
    expect(classifyTarget('docs/index.md', '#part')).toEqual({ kind: 'plain' });
  });
});
